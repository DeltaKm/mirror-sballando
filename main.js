const { app, BrowserWindow, session, ipcMain, screen, webFrameMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const Client = require('ssh2-sftp-client');

const BROKER_URL = process.env.PRINT_BROKER_URL || 'http://127.0.0.1:5177';
const BROKER_TOKEN_HEADER = process.env.PRINT_BROKER_TOKEN_HEADER || 'X-Local-Token';
const TV_WIDTH = 1200;
const TV_HEIGHT = 1920;
let mainWindow;
let isApplyingBounds = false;
let msSessionModeActive = false;
let currentEventFolderName = '';
function _setSessionFlag(val, ctx) {
  const prev = msSessionModeActive;
  msSessionModeActive = !!val;
  try { msBackLog('sessionFlag set ctx=' + ctx + ' ' + prev + ' -> ' + msSessionModeActive); } catch (_) {}
}
let hasLoggedPrinterBrokerOffline = false;

// Logger su file dedicato per debug del bottone "Torna al pannello".
// Scrive su <userData>/ms-back-debug.log per facile recupero.
const _msBackLogPath = path.join(__dirname, 'ms-back-debug.log');
function msBackLog(msg) {
  try {
    const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
    fsSync.appendFileSync(_msBackLogPath, line);
  } catch (_) {}
}
try { fsSync.writeFileSync(_msBackLogPath, '=== ms-back-debug start ' + new Date().toISOString() + ' ===\n'); } catch (_) {}

// Decide se il bottone "Torna al pannello" deve essere visibile.
// Vero se siamo in modalità sessione attiva, oppure se l'URL corrente
// indica una pagina di sessione (/mirror/index<numero>.php). Falso su
// home/pannello (/mirror/index.php) o quando msSessionModeActive=false.
function shouldShowBackButton(win) {
  try {
    if (msSessionModeActive) return true;
    if (!win || win.isDestroyed()) return false;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return false;
    const url = wc.getURL() || '';
    let pathname = '';
    try { pathname = new URL(url).pathname || ''; } catch (_) { pathname = url; }
    // Home esatta -> non mostrare
    if (/\/mirror\/index\.php(?:$|[?#])/i.test(pathname)) return false;
    // Session page -> mostra
    if (/\/mirror\/index\d+\.php(?:$|[?#])/i.test(pathname)) return true;
    // URL sconosciuto -> non mostrare (default sicuro per pannello)
    return false;
  } catch (_) { return false; }
}

function shouldShowBackButtonLogged(win, ctx) {
  let url = '';
  try { url = win && win.webContents && !win.webContents.isDestroyed() ? win.webContents.getURL() : ''; } catch (_) {}
  const decision = shouldShowBackButton(win);
  msBackLog('decide ctx=' + ctx + ' show=' + decision + ' sessionFlag=' + msSessionModeActive + ' url=' + url);
  return decision;
}

function broadcastFullscreenState(forcedState) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    const isFs = typeof forcedState === 'boolean' ? forcedState : mainWindow.isFullScreen();
    console.log('[fs] broadcast isFullScreen=' + isFs);
    mainWindow.webContents.send('window-fullscreen-changed', isFs);
  } catch (_) {}
}

function getAppBasePath() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getLegacySettingsPath() {
  return path.join(getAppBasePath(), 'settings.json');
}

let _settings = null;
const DEFAULT_PHOTO_DIR_NAME = 'Foto';

function sanitizePathSegment(value, fallback = 'evento') {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const safe = normalized
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/_+/g, '_')
    .trim();
  if (!safe) return fallback;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  return reserved.test(safe) ? '_' + safe : safe;
}

function getSafeEventFolderName(rawName) {
  return sanitizePathSegment(rawName, 'evento_senza_nome');
}

function getDefaultPhotoRootPath() {
  return path.join(getAppBasePath(), DEFAULT_PHOTO_DIR_NAME);
}

function isLikelyOpaqueFolderName(value) {
  const v = String(value || '').trim();
  return /^[a-f0-9]{24,}$/i.test(v);
}

function normalizePhotoRootPath(folderPath) {
  const base = String(folderPath || '').trim();
  if (!base) return getDefaultPhotoRootPath();
  const normalized = path.normalize(base);

  const parsed = path.parse(normalized);
  const rel = String(normalized.slice(parsed.root.length) || '');
  const segments = rel.split(path.sep).filter(Boolean);
  const fotoIdx = segments.findIndex((seg) => String(seg || '').toLowerCase() === DEFAULT_PHOTO_DIR_NAME.toLowerCase());
  if (fotoIdx >= 0) {
    return path.join(parsed.root, ...segments.slice(0, fotoIdx + 1));
  }

  const lastName = path.basename(normalized);
  if (String(lastName || '').toLowerCase() === DEFAULT_PHOTO_DIR_NAME.toLowerCase()) return normalized;
  return path.join(normalized, DEFAULT_PHOTO_DIR_NAME);
}

function resolveEventFolderName(rawFolder) {
  const current = getCurrentEventFolderName();
  if (current && current !== 'evento_senza_nome') return current;

  const safeRaw = getSafeEventFolderName(rawFolder || '');
  if (rawFolder && !isLikelyOpaqueFolderName(rawFolder) && safeRaw.toLowerCase() !== DEFAULT_PHOTO_DIR_NAME.toLowerCase()) {
    return safeRaw;
  }

  return current || 'evento_senza_nome';
}

function buildPhotoPathCandidates(rawFolder, rawFileName) {
  const safeFilename = path.basename(String(rawFileName || '').trim()) || ('foto_' + Date.now() + '.jpg');
  const preferredFolder = resolveEventFolderName(rawFolder);
  const rootPath = getPhotoRootPath();

  const candidates = [];
  const pushUnique = (p) => {
    if (!p) return;
    if (candidates.indexOf(p) < 0) candidates.push(p);
  };

  pushUnique(path.join(rootPath, preferredFolder, safeFilename));

  const safeRawFolder = getSafeEventFolderName(rawFolder || '');
  if (rawFolder && safeRawFolder && safeRawFolder !== preferredFolder && safeRawFolder.toLowerCase() !== DEFAULT_PHOTO_DIR_NAME.toLowerCase()) {
    pushUnique(path.join(rootPath, safeRawFolder, safeFilename));
  }

  pushUnique(path.join(rootPath, safeFilename));

  return {
    safeFilename,
    preferredFolder,
    candidates,
  };
}

function setCurrentEventFolderName(rawName) {
  let safe = getSafeEventFolderName(rawName);
  if (isLikelyOpaqueFolderName(safe)) {
    const existing = String(currentEventFolderName || '').trim();
    safe = (existing && !isLikelyOpaqueFolderName(existing)) ? existing : 'evento_senza_nome';
  }
  currentEventFolderName = safe;
  saveSettings({ lastEventFolderName: safe });
  return safe;
}

function getCurrentEventFolderName() {
  if (currentEventFolderName && !isLikelyOpaqueFolderName(currentEventFolderName)) return currentEventFolderName;
  const s = loadSettings();
  if (s.lastEventFolderName && String(s.lastEventFolderName).trim()) {
    currentEventFolderName = getSafeEventFolderName(s.lastEventFolderName);
    if (isLikelyOpaqueFolderName(currentEventFolderName)) {
      currentEventFolderName = 'evento_senza_nome';
    }
    return currentEventFolderName;
  }
  return 'evento_senza_nome';
}

function loadSettings() {
  if (_settings) return _settings;
  try {
    const raw = fsSync.readFileSync(getSettingsPath(), 'utf8');
    _settings = JSON.parse(raw);
  } catch {
    try {
      const legacyRaw = fsSync.readFileSync(getLegacySettingsPath(), 'utf8');
      _settings = JSON.parse(legacyRaw);
    } catch {
      _settings = {};
    }
  }
  return _settings;
}

function saveSettings(data) {
  _settings = Object.assign(loadSettings(), data);
  const settingsPath = getSettingsPath();
  const settingsDir = path.dirname(settingsPath);
  if (!fsSync.existsSync(settingsDir)) {
    fsSync.mkdirSync(settingsDir, { recursive: true });
  }
  fsSync.writeFileSync(settingsPath, JSON.stringify(_settings, null, 2), 'utf8');
}

function getPhotoRootPath() {
  const s = loadSettings();
  if (s.photoSavePath && s.photoSavePath.trim()) {
    return normalizePhotoRootPath(s.photoSavePath.trim());
  }
  return getDefaultPhotoRootPath();
}

function getBrokerDataDirectory() {
  if (process.env.PRINT_BROKER_DATA_DIR) {
    return process.env.PRINT_BROKER_DATA_DIR;
  }

  const localAppData = process.env.LOCALAPPDATA || app.getPath('userData');
  return path.join(localAppData, 'MirrorSballando', 'PrintBroker');
}

async function readBrokerToken() {
  if (process.env.PRINT_BROKER_TOKEN) {
    return process.env.PRINT_BROKER_TOKEN.trim();
  }

  const tokenFile = path.join(getBrokerDataDirectory(), 'broker.token');
  try {
    const token = await fs.readFile(tokenFile, 'utf8');
    return token.trim();
  } catch (error) {
    throw new Error(`Token broker non trovato: ${tokenFile}. Avvia prima il Print Broker.`);
  }
}

async function callPrintBroker(endpoint, options = {}) {
  const token = await readBrokerToken();
  const headers = {
    'Content-Type': 'application/json',
    [BROKER_TOKEN_HEADER]: token,
    ...(options.headers || {})
  };

  const response = await fetch(`${BROKER_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const detail = payload && payload.detail ? payload.detail : text;
    throw new Error(`Print Broker ${response.status}: ${detail || 'errore sconosciuto'}`);
  }

  return payload;
}

function resolveImagePath(filename) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('filename non valido');
  }

  if (path.isAbsolute(filename)) {
    return filename;
  }

  const sep = filename.includes('§') ? '§' : (filename.includes('Â§') ? 'Â§' : null);
  if (sep) {
    const folder = filename.split(sep)[0];
    const imageName = filename.split(sep).slice(1).join(sep);
    const mapped = buildPhotoPathCandidates(folder, imageName);
    for (let i = 0; i < mapped.candidates.length; i++) {
      const candidate = mapped.candidates[i];
      try {
        if (fsSync.existsSync(candidate)) return candidate;
      } catch (_) {}
    }
    return mapped.candidates[0];
  }

  const safeFileName = path.basename(String(filename || '').trim()) || ('foto_' + Date.now() + '.jpg');
  const mapped = buildPhotoPathCandidates('', safeFileName);
  for (let i = 0; i < mapped.candidates.length; i++) {
    const candidate = mapped.candidates[i];
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return mapped.candidates[0];
}

// Iniezione DEDICATA, idempotente e SENZA guardia di flag: garantisce che
// il bottone "Torna al pannello" e lo shield invisibile bottom-left siano
// sempre presenti e funzionanti su QUALSIASI pagina (home + sessione),
// indipendentemente dallo stato delle altre injection.
function injectBackButtonOverlay(win, targetFrame, opts) {
  const execute = (code) => {
    if (targetFrame && typeof targetFrame.executeJavaScript === 'function') {
      return targetFrame.executeJavaScript(code);
    }
    try {
      if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
        return Promise.resolve();
      }
      // Evita executeJavaScript mentre la main frame sta ancora caricando:
      // in alcuni cicli crea accumulo di listener did-stop-loading.
      if (typeof win.webContents.isLoadingMainFrame === 'function' && win.webContents.isLoadingMainFrame()) {
        return Promise.resolve();
      }
    } catch (_) {
      return Promise.resolve();
    }
    return win.webContents.executeJavaScript(code);
  };

  // show=true: crea/mantieni il bottone. show=false: rimuovi e disattiva tick.
  const show = !opts || opts.show !== false;
  const showLit = show ? 'true' : 'false';

  const script = `(() => { try {
    try {
      if (!window.__msBackLastShow || window.__msBackLastShow !== ${showLit}) {
        console.log('[ms-back] script-run show=' + ${showLit} + ' path=' + (location && location.pathname) + ' href=' + (location && location.href));
        window.__msBackLastShow = ${showLit};
      }
    } catch(_) {}
    var __msShowBack = ${showLit};
    // CSS (idempotente: id univoco, evita duplicati)
    if (!document.getElementById('ms-pb-back-css-v2')) {
      var st = document.createElement('style');
      st.id = 'ms-pb-back-css-v2';
      st.textContent =
        '#ms-pb-back{position:fixed!important;top:32px!important;left:32px!important;z-index:2147483647!important;' +
          'pointer-events:auto!important;display:inline-flex!important;align-items:center!important;gap:10px!important;' +
          'padding:0 22px!important;height:60px!important;border-radius:34px!important;border:1px solid rgba(255,255,255,0.13)!important;' +
          'background:linear-gradient(180deg,rgba(22,22,28,0.50) 0%,rgba(14,14,18,0.58) 100%)!important;' +
          'backdrop-filter:blur(38px) saturate(160%) brightness(1.04)!important;' +
          '-webkit-backdrop-filter:blur(38px) saturate(160%) brightness(1.04)!important;' +
          'box-shadow:0 12px 30px rgba(0,0,0,0.50),0 3px 8px rgba(0,0,0,0.32),inset 0 1px 0 rgba(255,255,255,0.07)!important;' +
          'color:rgba(255,255,255,0.86)!important;' +
          'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;' +
          'font-size:16px!important;font-weight:500!important;letter-spacing:1.2px!important;text-transform:uppercase!important;' +
          'cursor:pointer!important;-webkit-user-select:none!important;user-select:none!important;line-height:1!important;white-space:nowrap!important;' +
          'transition:transform 0.20s cubic-bezier(.22,1.2,.36,1),background 0.20s ease,opacity 0.20s ease!important;}' +
        '#ms-pb-back svg{width:18px!important;height:18px!important;flex:0 0 auto!important;}' +
        '#ms-pb-back:active{transform:scale(0.94)!important;background:linear-gradient(180deg,rgba(34,34,40,0.62) 0%,rgba(22,22,28,0.68) 100%)!important;}';
      (document.head || document.documentElement).appendChild(st);
    }

    function isHomePage() {
      // Decisione presa dal main process via __msShowBack.
      return !__msShowBack;
    }

    function ensure() {
      try {
        var root = document.documentElement || document.body;
        if (!root) { try { console.log('[ms-back] no root'); } catch(_){} return; }
        var hideHere = isHomePage();
        if (hideHere) {
          try {
            if (!window.__msBackLoggedHome) {
              window.__msBackLoggedHome = true;
              console.log('[ms-back] HOME detected path=' + location.pathname + ' -> hide button');
            }
          } catch(_) {}
          var oldBk = document.getElementById('ms-pb-back');
          if (oldBk && oldBk.parentNode) { try { oldBk.parentNode.removeChild(oldBk); } catch(_) {} }
          var oldSh = document.getElementById('ms-bl-shield');
          if (oldSh && oldSh.parentNode) { try { oldSh.parentNode.removeChild(oldSh); } catch(_) {} }
          return;
        }
        // Bottone "Torna al pannello"
        var bk = document.getElementById('ms-pb-back');
        var existed = !!bk;
        if (!bk) {
          bk = document.createElement('button');
          bk.id = 'ms-pb-back';
          bk.type = 'button';
          bk.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>Torna al pannello</span>';
          bk.addEventListener('click', function(ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch(_) {}
            try {
              if (window.electronAPI && typeof window.electronAPI.navigateHome === 'function') {
                window.electronAPI.navigateHome();
              }
            } catch(_) {}
          }, true);
          root.appendChild(bk);
          try { console.log('[ms-back] CREATED bk url=' + location.pathname); } catch(_){}
        } else if (bk.parentNode !== root) {
          root.appendChild(bk);
        }
        // Forza SEMPRE visibilità (override di altri sistemi che potrebbero nasconderlo)
        bk.style.setProperty('display', 'inline-flex', 'important');
        bk.style.setProperty('visibility', 'visible', 'important');
        bk.style.setProperty('opacity', '1', 'important');
        // Diagnostica: se il computed style risulta nascosto, logga
        try {
          var cs = getComputedStyle(bk);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) {
            console.log('[ms-back] HIDDEN-BY-CSS existed=' + existed + ' display=' + cs.display + ' vis=' + cs.visibility + ' op=' + cs.opacity + ' parent=' + (bk.parentNode && bk.parentNode.tagName));
          }
          var rect = bk.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) {
            console.log('[ms-back] ZERO-SIZE w=' + rect.width + ' h=' + rect.height + ' top=' + rect.top + ' left=' + rect.left);
          }
        } catch(_) {}
        // Shield invisibile bottom-left (blocca tap del bottone della pagina remota)
        var sh = document.getElementById('ms-bl-shield');
        if (!sh) {
          sh = document.createElement('div');
          sh.id = 'ms-bl-shield';
          sh.style.cssText = 'position:fixed!important;left:0!important;bottom:0!important;width:240px!important;height:240px!important;z-index:2147483646!important;background:transparent!important;pointer-events:auto!important;';
          var swallow = function(ev) { try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation && ev.stopImmediatePropagation(); } catch(_) {} };
          ['pointerdown','pointerup','mousedown','mouseup','click','touchstart','touchend','contextmenu'].forEach(function(t) {
            sh.addEventListener(t, swallow, true);
          });
          root.appendChild(sh);
        } else if (sh.parentNode !== root) {
          root.appendChild(sh);
        }
        // Forza visibilità dello shield
        sh.style.setProperty('display', 'block', 'important');
        sh.style.setProperty('visibility', 'visible', 'important');
        sh.style.setProperty('pointer-events', 'auto', 'important');
      } catch(_) {}
    }

    // Esegui subito + ad ogni evento di vita pagina + interval permanente
    ensure();
    if (!document.body) {
      try { document.addEventListener('DOMContentLoaded', ensure, { once: true }); } catch(_) {}
    }
    try { window.addEventListener('load', ensure); } catch(_) {}

    // Reset eventuale interval precedente (in caso di re-injection nella stessa window)
    try { if (window.__msBackOverlayTick) clearInterval(window.__msBackOverlayTick); } catch(_) {}
    try { window.__msBackOverlayTick = setInterval(ensure, 250); } catch(_) {}

    // MutationObserver rimosso: causava ping-pong con ensureFullscreenBtn.
    // Il setInterval da 250ms è sufficiente a mantenere il bottone.
  } catch(e) { try { console.warn('[ms] backOverlay error:', e); } catch(_) {} } })();`;

  execute(script).catch((err) => {
    console.warn('[ms] injectBackButtonOverlay failed:', err && err.message ? err.message : err);
  });
}

// Iniettato nel main world della pagina remota: intercetta i tentativi di
// caricare "sballando_cornice_*.png" (file inesistente sul server) e li
// sostituisce con la data URL della cornice locale selezionata. Riscrive
// anche `alert` solo per ignorare il falso messaggio "Verifica che ... sia
// nella directory corretta" che la pagina remota mostra in alcuni edge case.
function injectFrameUrlInterceptor(win, targetFrame) {
  const execute = (code) => {
    if (targetFrame && typeof targetFrame.executeJavaScript === 'function') {
      return targetFrame.executeJavaScript(code);
    }
    return win.webContents.executeJavaScript(code);
  };
  const script = `(() => {
    if (window.__msFrameInterceptorV1) return;
    window.__msFrameInterceptorV1 = true;
    try {
      var MS_LOCAL_FRAMES_KEY = 'msLocalFramesV1';
      var MS_SELECTED_FRAME_KEY = 'msSelectedFrameV1';
      var FRAME_URL_RE = /sballando_cornice[^\\\\\/?#]*\\.(png|jpg|jpeg|webp)/i;

      function resolveLocalFrameDataUrl() {
        try {
          var raw = localStorage.getItem(MS_LOCAL_FRAMES_KEY);
          if (!raw) return null;
          var frames = JSON.parse(raw);
          if (!Array.isArray(frames) || !frames.length) return null;
          var selected = '';
          try { selected = localStorage.getItem(MS_SELECTED_FRAME_KEY) || ''; } catch (e) {}
          var match = null;
          if (selected) {
            for (var i = 0; i < frames.length; i++) {
              if (frames[i] && frames[i].name === selected && frames[i].url) { match = frames[i]; break; }
            }
          }
          if (!match) {
            for (var j = 0; j < frames.length; j++) {
              if (frames[j] && frames[j].url) { match = frames[j]; break; }
            }
          }
          return match ? match.url : null;
        } catch (e) { return null; }
      }
      window.__msResolveFrameUrl = resolveLocalFrameDataUrl;

      var imgProto = HTMLImageElement.prototype;
      var srcDesc = Object.getOwnPropertyDescriptor(imgProto, 'src') ||
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(imgProto), 'src');
      if (srcDesc && srcDesc.set) {
        var origSet = srcDesc.set;
        var origGet = srcDesc.get;
        Object.defineProperty(imgProto, 'src', {
          configurable: true,
          enumerable: true,
          get: function() { return origGet.call(this); },
          set: function(value) {
            try {
              if (typeof value === 'string' && FRAME_URL_RE.test(value)) {
                var local = resolveLocalFrameDataUrl();
                if (local) { origSet.call(this, local); return; }
              }
            } catch (e) {}
            origSet.call(this, value);
          }
        });
      }

      var origSetAttribute = imgProto.setAttribute;
      imgProto.setAttribute = function(name, value) {
        try {
          if (name && String(name).toLowerCase() === 'src' &&
              typeof value === 'string' && FRAME_URL_RE.test(value)) {
            var local = resolveLocalFrameDataUrl();
            if (local) return origSetAttribute.call(this, name, local);
          }
        } catch (e) {}
        return origSetAttribute.call(this, name, value);
      };

      // Sostituisce anche il costruttore Image per casi in cui la pagina
      // crei l'oggetto e poi assegni src in modo che bypassi il setter
      // (es. assegnazione tramite property descriptor proprio).
      var OrigImage = window.Image;
      try {
        window.Image = function(w, h) {
          var img = new OrigImage(w, h);
          return img;
        };
        window.Image.prototype = OrigImage.prototype;
      } catch (e) {}

      // Filtra l'alert "Verifica che sballando_cornice..." che la pagina
      // mostra quando l'onerror scatta prima del nostro override.
      var origAlert = window.alert;
      window.alert = function(msg) {
        try {
          if (typeof msg === 'string' && /sballando_cornice/i.test(msg)) {
            console.warn('[ms] Soppresso alert cornice mancante:', msg);
            return;
          }
        } catch (e) {}
        return origAlert.apply(this, arguments);
      };
    } catch (e) {
      console.warn('[ms] Frame interceptor init failed', e);
    }
  })();`;
  execute(script).catch((err) => {
    console.warn('[ms] injectFrameUrlInterceptor failed:', err && err.message ? err.message : err);
  });
}

function injectWindowControls(win, targetFrame) {
  const execute = (code) => {
    if (targetFrame && typeof targetFrame.executeJavaScript === 'function') {
      return targetFrame.executeJavaScript(code);
    }
    return win.webContents.executeJavaScript(code);
  };
  const script = `(() => {
    try {
      var root = document.documentElement || document.body;
      if (!root) return;

      var invokeToggle = async function() {
        try {
          if (window.electronAPI && window.electronAPI.toggleWindowFullscreen) {
            return await window.electronAPI.toggleWindowFullscreen();
          }
        } catch (e) {}
        return false;
      };

      // Rimuove versioni precedenti (mini bottone in basso a destra)
      var oldMini = document.getElementById('ms-window-controls-mini');
      if (oldMini && oldMini.parentNode) oldMini.parentNode.removeChild(oldMini);

      var BTN_CSS = 'all:initial;position:fixed;top:14px;right:14px;width:56px;height:56px;border-radius:14px;border:2px solid rgba(255,255,255,0.92);background:rgba(230,57,70,0.96);color:#fff;font-family:Inter,system-ui,sans-serif;font-size:26px;font-weight:700;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 28px rgba(230,57,70,0.48),0 0 0 3px rgba(255,255,255,0.18);';

      var isSessionActive = function() {
        try {
          var rt = document.documentElement;
          if (rt && rt.getAttribute('data-ms-session') === '1') return true;
          var path = (window.location && window.location.pathname) || '';
          if (/\\/mirror\\/index\\d+\\.php$/i.test(path)) return true;
        } catch (e) {}
        return false;
      };

      var ensureBtn = function() {
        var sessionOn = isSessionActive();
        var btn = document.getElementById('ms-window-controls');
        if (!sessionOn) {
          if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          return;
        }
        if (!btn) {
          btn = document.createElement('button');
          btn.id = 'ms-window-controls';
          btn.type = 'button';
          btn.textContent = '⤢';
          btn.title = 'Schermo intero';
          btn.style.cssText = BTN_CSS;
          btn.addEventListener('click', async function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var isFs = await invokeToggle();
            btn.title = isFs ? 'Esci da schermo intero' : 'Schermo intero';
            btn.textContent = isFs ? '⤡' : '⤢';
          }, true);
        }
        btn.style.display = 'flex';
        btn.style.visibility = 'visible';
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        btn.style.zIndex = '2147483647';
        if (btn.parentNode !== root) root.appendChild(btn);
      };

      window._msSetWindowControlsVisible = ensureBtn;
      ensureBtn();
      setInterval(ensureBtn, 500);
    } catch (e) {
      try { console.warn('[ms] window controls runtime error:', e); } catch (_) {}
    }
  })();`;

  execute(script).catch((err) => {
    console.warn('[ms] injectWindowControls failed:', err && err.message ? err.message : err);
  });
}

function injectSessionFrameOverlay(win, targetFrame) {
  const execute = (code) => {
    if (targetFrame && typeof targetFrame.executeJavaScript === 'function') {
      return targetFrame.executeJavaScript(code);
    }
    return win.webContents.executeJavaScript(code);
  };

  const script = `(() => {
    try {
      if (window.__msSessionFrameLiteV1) return;
      window.__msSessionFrameLiteV1 = true;

      var FRAMES_KEY = 'msLocalFramesV1';
      var SELECTED_KEY = 'msSelectedFrameV1';

      function getSource() {
        try {
          var raw = localStorage.getItem(FRAMES_KEY);
          if (!raw) return '';
          var frames = JSON.parse(raw);
          if (!Array.isArray(frames) || !frames.length) return '';
          var selected = localStorage.getItem(SELECTED_KEY) || '';
          var found = null;
          if (selected) {
            found = frames.find(function(f) { return f && f.name === selected && f.url; }) || null;
          }
          if (!found) {
            found = frames.find(function(f) { return f && f.url; }) || null;
          }
          return found ? found.url : '';
        } catch (e) {
          return '';
        }
      }

      var __msPreviewFrameProbeCache = Object.create(null);

      function __msClamp01(v) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > 1) return 1;
        return n;
      }

      function __msApplyPreviewRectVars(ft, rect) {
        if (!ft || !rect) return;
        var left = __msClamp01(rect.left);
        var top = __msClamp01(rect.top);
        var width = __msClamp01(rect.width);
        var height = __msClamp01(rect.height);
        ft.style.setProperty('--ms-photo-left', String(left), 'important');
        ft.style.setProperty('--ms-photo-top', String(top), 'important');
        ft.style.setProperty('--ms-photo-w', String(width), 'important');
        ft.style.setProperty('--ms-photo-h', String(height), 'important');
      }

      function __msResetPreviewRectVars(ft) {
        if (!ft) return;
        try { ft.style.removeProperty('--ms-photo-left'); } catch (_) {}
        try { ft.style.removeProperty('--ms-photo-top'); } catch (_) {}
        try { ft.style.removeProperty('--ms-photo-w'); } catch (_) {}
        try { ft.style.removeProperty('--ms-photo-h'); } catch (_) {}
      }

      function __msComputeTransparentRectFromImage(img) {
        try {
          var nw = img && (img.naturalWidth || img.width) || 0;
          var nh = img && (img.naturalHeight || img.height) || 0;
          if (!nw || !nh) return null;

          var maxSide = 900;
          var scale = Math.min(1, maxSide / Math.max(nw, nh));
          var w = Math.max(1, Math.round(nw * scale));
          var h = Math.max(1, Math.round(nh * scale));

          var cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          var gx = cv.getContext('2d', { willReadFrequently: true }) || cv.getContext('2d');
          if (!gx) return null;
          gx.drawImage(img, 0, 0, w, h);
          var data = gx.getImageData(0, 0, w, h).data;

          function scan(alphaMax) {
            var rowCounts = new Array(h);
            var colCounts = new Array(w);
            for (var x = 0; x < w; x++) colCounts[x] = 0;

            for (var y = 0; y < h; y++) {
              var rowHit = 0;
              var base = y * w * 4;
              for (var xx = 0; xx < w; xx++) {
                var a = data[base + xx * 4 + 3];
                if (a <= alphaMax) {
                  rowHit++;
                  colCounts[xx]++;
                }
              }
              rowCounts[y] = rowHit;
            }

            var minRowCoverage = Math.max(6, Math.round(w * 0.05));
            var minColCoverage = Math.max(6, Math.round(h * 0.05));

            var minY = -1;
            var maxY = -1;
            for (var yy = 0; yy < h; yy++) {
              if (rowCounts[yy] >= minRowCoverage) {
                minY = yy;
                break;
              }
            }
            for (var yy2 = h - 1; yy2 >= 0; yy2--) {
              if (rowCounts[yy2] >= minRowCoverage) {
                maxY = yy2;
                break;
              }
            }

            var minX = -1;
            var maxX = -1;
            for (var xx2 = 0; xx2 < w; xx2++) {
              if (colCounts[xx2] >= minColCoverage) {
                minX = xx2;
                break;
              }
            }
            for (var xx3 = w - 1; xx3 >= 0; xx3--) {
              if (colCounts[xx3] >= minColCoverage) {
                maxX = xx3;
                break;
              }
            }

            if (minX < 0 || maxX <= minX || minY < 0 || maxY <= minY) return null;

            var left = minX / w;
            var top = minY / h;
            var width = (maxX - minX + 1) / w;
            var height = (maxY - minY + 1) / h;

            if (width < 0.35 || height < 0.35 || width > 0.98 || height > 0.98) return null;

            var padX = 1 / w;
            var padY = 1 / h;
            left = __msClamp01(left + padX);
            top = __msClamp01(top + padY);
            width = __msClamp01(Math.max(0, width - padX * 2));
            height = __msClamp01(Math.max(0, height - padY * 2));

            if (width < 0.30 || height < 0.30) return null;
            return { left: left, top: top, width: width, height: height };
          }

          return scan(8) || scan(20) || scan(36) || null;
        } catch (_) {
          return null;
        }
      }

      function __msEnsurePreviewRect(ft, frameSrc) {
        if (!ft) return;
        var src = String(frameSrc || '').trim();
        if (!src) {
          __msResetPreviewRectVars(ft);
          try { ft.__msPreviewRectSrc = ''; } catch (_) {}
          return;
        }

        var cached = __msPreviewFrameProbeCache[src];
        if (cached && cached.done) {
          if (cached.rect) __msApplyPreviewRectVars(ft, cached.rect);
          else __msResetPreviewRectVars(ft);
          return;
        }
        if (cached && !cached.done) return;

        __msPreviewFrameProbeCache[src] = { done: false, rect: null };

        var probe = new Image();
        try { probe.crossOrigin = 'anonymous'; } catch (_) {}
        probe.onload = function() {
          var rect = __msComputeTransparentRectFromImage(probe);
          __msPreviewFrameProbeCache[src] = { done: true, rect: rect };
          if (!ft || !ft.isConnected) return;
          if (String(ft.__msPreviewRectSrc || '') !== src) return;
          if (rect) __msApplyPreviewRectVars(ft, rect);
          else __msResetPreviewRectVars(ft);
        };
        probe.onerror = function() {
          __msPreviewFrameProbeCache[src] = { done: true, rect: null };
          if (!ft || !ft.isConnected) return;
          if (String(ft.__msPreviewRectSrc || '') !== src) return;
          __msResetPreviewRectVars(ft);
        };
        probe.src = src;
      }

      function isSession() {
        try {
          var root = document.documentElement;
          if (root && root.getAttribute('data-ms-session') === '1') return true;
          var path = (window.location && window.location.pathname) || '';
          return /\\/mirror\\/index\\d+\\.php$/i.test(path);
        } catch (e) {
          return false;
        }
      }

      function isReviewVisible() {
        try {
          var ft = document.getElementById('foto_temp');
          if (ft) {
            var st = ft.style && ft.style.display;
            var cs = (st && st !== '') ? st : (window.getComputedStyle ? getComputedStyle(ft).display : '');
            if (cs && cs !== 'none') return true;
          }
        } catch (e) {}
        return false;
      }

      // Dump diagnostico una tantum: chiamabile da console come window.__msDumpDom().
      // Cerca tutti gli elementi con z-index alto / posizione fixed e li logga,
      // utile per identificare il modal della preview sul sito remoto.
      window.__msDumpDom = function() {
        try {
          var vw = window.innerWidth, vh = window.innerHeight;
          var all = document.querySelectorAll('body *');
          var hits = [];
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var cs = getComputedStyle(el);
            if (!cs) continue;
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            var z = parseInt(cs.zIndex, 10);
            var r = el.getBoundingClientRect();
            var big = (r.width / vw) >= 0.5 && (r.height / vh) >= 0.5;
            if ((z && z >= 100) || cs.position === 'fixed' || big) {
              hits.push((el.tagName) + (el.id ? '#' + el.id : '') +
                (el.className ? '.' + String(el.className).split(/\s+/).slice(0,3).join('.') : '') +
                ' pos=' + cs.position + ' z=' + cs.zIndex + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height));
            }
            if (hits.length > 60) break;
          }
          console.log('[ms] DOM dump (' + hits.length + ' nodes):');
          hits.forEach(function(h, idx) { console.log('[ms]   #' + idx + ' ' + h); });
        } catch (e) { console.warn('[ms] dump err', e); }
      };

      function getPreferredParent() {
        // Cerca il <video> della pagina: il modo piu' affidabile per stare sopra
        // e' essere un suo fratello successivo nello stesso stacking context.
        try {
          var v = document.getElementById('video') || document.querySelector('video');
          if (v && v.parentNode) return v.parentNode;
        } catch (_) {}
        return document.body || document.documentElement;
      }

      function ensureOverlay() {
        var ov = document.getElementById('ms-session-frame-ov-lite');
        if (ov && !ov.isConnected) {
          try { ov.parentNode && ov.parentNode.removeChild(ov); } catch (_) {}
          ov = null;
        }
        if (!ov) {
          ov = document.createElement('img');
          ov.id = 'ms-session-frame-ov-lite';
          ov.alt = '';
          ov.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;object-fit:fill;pointer-events:none;display:none;margin:0;padding:0;border:0;';
          ov.style.setProperty('z-index', '2147483646', 'important');
          ov.style.setProperty('display', 'none', 'important');
          getPreferredParent().appendChild(ov);
          try { console.log('[ms] cornice creata parent=' + (ov.parentNode && ov.parentNode.tagName) + (ov.parentNode && ov.parentNode.id ? '#' + ov.parentNode.id : '')); } catch (_) {}
        }
        return ov;
      }

      function setFsBtnIcon(btn, isFs) {
        if (!btn) return;
        btn.innerHTML = isFs
          ? '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M8 3H3v5h2V5h3V3zm13 0h-5v2h3v3h2V3zM5 16H3v5h5v-2H5v-3zm16 0h-2v3h-3v2h5v-5z" fill="currentColor"/></svg>'
          : '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M14 3v2h3v3h2V3h-5zM5 5h3V3H3v5h2V5zm12 14h-3v2h5v-5h-2v3zM5 16H3v5h5v-2H5v-3z" fill="currentColor"/></svg>';
        btn.title = isFs ? 'Esci da schermo intero' : 'Schermo intero';
        btn.setAttribute('data-fs', isFs ? '1' : '0');
      }

      function hardenFsBtnStyle(btn) {
        if (!btn) return;
        btn.style.setProperty('all', 'initial', 'important');
        btn.style.setProperty('position', 'fixed', 'important');
        btn.style.setProperty('top', '14px', 'important');
        btn.style.setProperty('right', '14px', 'important');
        btn.style.setProperty('width', '56px', 'important');
        btn.style.setProperty('height', '56px', 'important');
        btn.style.setProperty('border-radius', '14px', 'important');
        btn.style.setProperty('border', '2px solid rgba(255,255,255,0.92)', 'important');
        btn.style.setProperty('background', 'rgba(230,57,70,0.96)', 'important');
        btn.style.setProperty('color', '#fff', 'important');
        btn.style.setProperty('font-family', 'system-ui,sans-serif', 'important');
        btn.style.setProperty('font-size', '26px', 'important');
        btn.style.setProperty('font-weight', '700', 'important');
        btn.style.setProperty('line-height', '1', 'important');
        btn.style.setProperty('cursor', 'pointer', 'important');
        btn.style.setProperty('display', 'flex', 'important');
        btn.style.setProperty('align-items', 'center', 'important');
        btn.style.setProperty('justify-content', 'center', 'important');
        btn.style.setProperty('visibility', 'visible', 'important');
        btn.style.setProperty('opacity', '1', 'important');
        btn.style.setProperty('pointer-events', 'auto', 'important');
        btn.style.setProperty('z-index', '2147483647', 'important');
        btn.style.setProperty('box-shadow', '0 10px 28px rgba(230,57,70,0.48),0 0 0 3px rgba(255,255,255,0.18)', 'important');
      }

      function refreshFsBtnState(btn) {
        // No-op: lo stato icona e' deterministico (sempre "riduci" in pagina sessione).
        // Vedi ensureFullscreenBtn(). Evita flicker da broadcast IPC transitori.
      }

      function wireFsStateListener(btn) {
        // No-op: vedi refreshFsBtnState().
      }

      function ensureFullscreenBtn(show) {
        var btn = document.getElementById('ms-session-fs-btn-lite');
        if (!show) {
          if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          return;
        }
        if (!btn) {
          btn = document.createElement('button');
          btn.id = 'ms-session-fs-btn-lite';
          btn.type = 'button';
          setFsBtnIcon(btn, true);
          hardenFsBtnStyle(btn);
          btn.addEventListener('click', async function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            try {
              if (window.electronAPI && window.electronAPI.toggleWindowFullscreen) {
                var isFs = await window.electronAPI.toggleWindowFullscreen();
                setFsBtnIcon(btn, !!isFs);
              }
            } catch (e) {}
          }, true);
        }
        // In pagina sessione siamo SEMPRE in fullscreen (auto-enter da main).
        // Forziamo SEMPRE l'icona "riduci" e i suoi stili ad ogni sync, ignorando
        // i broadcast transitori che possono creare flickering.
        setFsBtnIcon(btn, true);
        hardenFsBtnStyle(btn);
        // CRITICAL: se la pagina remota ha messo un elemento in HTML fullscreen
        // (es. <video>), tutti gli elementi NON discendenti diventano invisibili.
        // Quindi dobbiamo ATTACCARE il bottone all'elemento in fullscreen.
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
        var root = fsEl || document.documentElement;
        if (root && btn.parentNode !== root) {
          root.appendChild(btn);
        }
      }

      function ensureLiveActionBar(show) {
        try {
          // Durante il countdown l'UI iniziale (hint "Pronti?", live bar SCATTA,
          // scrim, vignetta) deve sparire del tutto: vogliamo solo la schermata
          // del countdown, come un classico photobooth.
          if (show && window.__msCountdownActive) {
            show = false;
          }
          // Nasconde i controlli originali della pagina remota durante la sessione live.
          // IMPORTANTE: NON usiamo visibility:hidden né display:none su #captureBtn
          // perché potrebbero impedire a count_down_start di partire.
          // Usiamo opacity:0 + sposto off-screen così rimane "presente" funzionalmente
          // ma invisibile visivamente.
          try {
            // Nasconde TUTTI i controlli originali della pagina remota durante la sessione live,
            // inclusi #controls_user / #controls_user_temp (e i loro figli) che altrimenti
            // restano visibili sotto la nostra barra premium.
            var __toHide = document.querySelectorAll(
              '#captureBtn,#controls_main,#controls_buttons,.controls_main,' +
              '#controls_user,#controls_user_temp,#controls_user *,#controls_user_temp *,' +
              // Vecchio checkbox "Stampa Foto" della pagina remota: lo rimuoviamo
              // completamente dalla UI. La logica di stampa e' gestita dal NOSTRO
              // pulsante #ms-btn-stampa.
              '#print,#print_foto,label#print,label[for=print_foto]'
            );
            for (var __h = 0; __h < __toHide.length; __h++) {
              var __el = __toHide[__h];
              if (!__el || __el.id === 'ms-live-bar') continue;
              // Salta elementi della NOSTRA UI (live bar, countdown, preview, ecc.)
              if (__el.id && __el.id.indexOf('ms-') === 0) continue;
              if (__el.className && typeof __el.className === 'string' && __el.className.indexOf('ms-') === 0) continue;
              if (show) {
                __el.style.setProperty('opacity', '0', 'important');
                __el.style.setProperty('pointer-events', 'none', 'important');
                __el.style.setProperty('visibility', 'hidden', 'important');
              } else {
                __el.style.removeProperty('opacity');
                __el.style.removeProperty('pointer-events');
                __el.style.removeProperty('visibility');
              }
            }
          } catch (_) {}
          if (!show) {
            var __old = document.getElementById('ms-live-bar');
            if (__old && __old.parentNode) __old.parentNode.removeChild(__old);
            var __oldHint = document.getElementById('ms-lv-hint');
            if (__oldHint && __oldHint.parentNode) __oldHint.parentNode.removeChild(__oldHint);
            var __oldScrim = document.getElementById('ms-lv-scrim');
            if (__oldScrim && __oldScrim.parentNode) __oldScrim.parentNode.removeChild(__oldScrim);
            var __oldCam = document.getElementById('ms-lv-cam-cue');
            if (__oldCam && __oldCam.parentNode) __oldCam.parentNode.removeChild(__oldCam);
            var __oldVig = document.getElementById('ms-lv-vignette');
            if (__oldVig && __oldVig.parentNode) __oldVig.parentNode.removeChild(__oldVig);
            // NON rimuoviamo mai #ms-countdown-overlay qui: il countdown ha
            // un ciclo di vita autonomo (auto-remove al termine). Se la live
            // action bar viene nascosta mentre il countdown e' in corso,
            // l'overlay deve restare visibile.
            return;
          }
          if (!document.getElementById('ms-live-bar-css')) {
            var __css = document.createElement('style');
            __css.id = 'ms-live-bar-css';
            __css.textContent =
              // ── ORIENTAMENTO CAMERA — mirror selfie (testa a destra → immagine a destra) ──
              'video,#video,video#video{transform:scaleX(-1)!important;-webkit-transform:scaleX(-1)!important;}' +
              // ── VIGNETTA leggerissima solo agli angoli estremi ──
              '#ms-lv-vignette{position:fixed;inset:0;z-index:2147483640;pointer-events:none;' +
              'background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,0.08) 85%,rgba(0,0,0,0.18) 100%);' +
              'animation:msVigIn 1s ease-out;}' +
              '@keyframes msVigIn{0%{opacity:0;}100%{opacity:1;}}' +

              // ── NESSUNO SCRIM — trasparenza totale, leggibilità via text-shadow/stroke ──
              '#ms-lv-scrim{display:none!important;}' +

              // ── INDICATORE CAMERA IN ALTO — visibile su qualunque cornice colorata ──
              '#ms-lv-cam-cue{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
              'pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:8px;' +
              'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;' +
              'animation:msCamCueIn 0.8s cubic-bezier(.22,1,.36,1) 0.5s both;}' +
              '@keyframes msCamCueIn{0%{opacity:0;}100%{opacity:1;}}' +
              // Freccia bianca grande con stroke nero per contrasto su sfondo chiaro
              '#ms-lv-cam-arrow{width:46px;height:46px;display:flex;align-items:center;justify-content:center;' +
              'color:#fff;' +
              'filter:drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000) drop-shadow(0 3px 10px rgba(0,0,0,0.95));' +
              'animation:msCamArrowBounce 1.5s ease-in-out infinite;}' +
              '@keyframes msCamArrowBounce{0%,100%{transform:translateY(0);}50%{transform:translateY(-10px);}}' +
              '#ms-lv-cam-arrow svg{width:100%;height:100%;}' +
              // Pillola DARK semi-trasparente — si staglia su qualunque cornice colorata
              '#ms-lv-cam-pill{display:inline-flex;align-items:center;gap:11px;' +
              'padding:12px 24px;border-radius:50px;' +
              'background:rgba(0,0,0,0.62);' +
              'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
              'border:1.5px solid rgba(255,255,255,0.55);' +
              'box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 8px 28px rgba(0,0,0,0.6),0 0 24px rgba(255,255,255,0.18);}' +
              '#ms-lv-cam-pill svg{width:20px;height:20px;color:#fff;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8));}' +
              '#ms-lv-cam-pill span{font-size:15px;font-weight:800;letter-spacing:3.5px;text-transform:uppercase;' +
              'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.95);}' +
              // REC dot più visibile, glow rosso più intenso
              '#ms-lv-cam-rec{width:10px;height:10px;border-radius:50%;background:#ff2d2d;' +
              'box-shadow:0 0 10px rgba(255,45,45,1),0 0 22px rgba(255,45,45,0.7),0 0 0 1.5px rgba(0,0,0,0.5);' +
              'animation:msRecBlink 1.4s ease-in-out infinite;}' +
              '@keyframes msRecBlink{0%,100%{opacity:1;}50%{opacity:0.3;}}' +

              // ── DOCK FLOATING — minimal e moderno sul fondo dello scrim ──
              '#ms-live-bar{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483647;' +
              'display:flex;gap:40px;align-items:center;justify-content:center;pointer-events:none;' +
              'padding:18px 34px;border-radius:120px;' +
              'background:rgba(8,8,14,0.34);' +
              'backdrop-filter:blur(44px) saturate(160%);-webkit-backdrop-filter:blur(44px) saturate(160%);' +
              'border:1px solid rgba(255,255,255,0.07);' +
              'box-shadow:0 12px 40px rgba(0,0,0,0.48),0 4px 12px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.07);' +
              'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;' +
              'animation:msBarSlideUp 0.6s cubic-bezier(.22,1.2,.36,1);}' +
              '@keyframes msBarSlideUp{0%{opacity:0;transform:translate(-50%,44px) scale(0.88);}100%{opacity:1;transform:translate(-50%,0) scale(1);}}' +

              // ── Frecce navigazione ──
              '.ms-lv-arrow-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;}' +
              '.ms-lv-arrow{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;' +
              'width:78px;height:78px;border-radius:50%;' +
              'border:1px solid rgba(255,255,255,0.22);' +
              'background:rgba(255,255,255,0.08);' +
              'backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);' +
              'color:#fff;cursor:pointer;' +
              'box-shadow:0 8px 24px rgba(0,0,0,0.45),inset 0 1px 0 rgba(255,255,255,0.16);' +
              'transition:transform 0.22s cubic-bezier(.22,1.2,.36,1),background 0.18s ease,box-shadow 0.18s ease;' +
              '-webkit-user-select:none;user-select:none;outline:none;}' +
              '.ms-lv-arrow:hover{background:rgba(255,255,255,0.15);border-color:rgba(255,255,255,0.4);transform:translateY(-3px);' +
              'box-shadow:0 16px 36px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.24);}' +
              '.ms-lv-arrow:active{transform:scale(0.82);background:rgba(255,255,255,0.26);}' +
              '.ms-lv-arrow svg{width:32px;height:32px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.55));}' +
              '.ms-lv-arrow-label{display:none;}' +

              // ── Wrap pulsante scatto ──
              '.ms-lv-shoot-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;margin:0 8px;}' +
              '.ms-lv-label{display:none;}' +
              '@keyframes msLabelGlow{0%,100%{opacity:0.68;}50%{opacity:1;}}' +

              // ── Pulsante scatto — CTA assoluta ──
              '.ms-lv-shoot{pointer-events:auto;position:relative;display:inline-flex;align-items:center;justify-content:center;' +
              'width:120px;height:120px;border-radius:50%;border:none;cursor:pointer;outline:none;' +
              'background:radial-gradient(circle at 32% 26%,#ff8e8e 0%,#e63946 42%,#8b0000 100%);' +
              'box-shadow:0 0 0 5px rgba(255,255,255,0.94),0 0 0 9px rgba(230,57,70,0.22),' +
              '0 20px 52px rgba(230,57,70,0.62),0 6px 18px rgba(0,0,0,0.5),' +
              'inset 0 -7px 16px rgba(0,0,0,0.42),inset 0 4px 10px rgba(255,255,255,0.3);' +
              'animation:msShootPulse 2.6s ease-in-out infinite;-webkit-user-select:none;user-select:none;' +
              'transition:transform 0.2s cubic-bezier(.22,1.2,.36,1);}' +
              '.ms-lv-shoot::before{content:"";position:absolute;inset:-14px;border-radius:50%;' +
              'border:1.5px solid rgba(255,255,255,0.35);' +
              'animation:msShootRing 3s ease-out infinite;pointer-events:none;}' +
              '.ms-lv-shoot::after{content:"";position:absolute;inset:-26px;border-radius:50%;' +
              'border:1px solid rgba(255,255,255,0.16);' +
              'animation:msShootRing 3s ease-out 1s infinite;pointer-events:none;}' +
              '@keyframes msShootRing{0%{transform:scale(0.84);opacity:0.85;}100%{transform:scale(1.2);opacity:0;}}' +
              '.ms-lv-shoot:hover{transform:scale(1.06);}' +
              '.ms-lv-shoot:active{transform:scale(0.85);animation:none;' +
              'box-shadow:0 0 0 5px rgba(255,255,255,0.94),0 0 0 16px rgba(230,57,70,0.4),0 10px 24px rgba(230,57,70,0.5),inset 0 -4px 12px rgba(0,0,0,0.5);}' +
              '.ms-lv-shoot.ms-lv-flash{animation:msShootFlash 0.5s ease-out;}' +
              '.ms-lv-shoot svg{width:50px;height:50px;color:#fff;filter:drop-shadow(0 3px 8px rgba(0,0,0,0.6));}' +
              '@keyframes msShootPulse{' +
              '0%,100%{box-shadow:0 0 0 5px rgba(255,255,255,0.94),0 0 0 9px rgba(230,57,70,0.22),0 20px 52px rgba(230,57,70,0.62),0 6px 18px rgba(0,0,0,0.5),inset 0 -7px 16px rgba(0,0,0,0.42),inset 0 4px 10px rgba(255,255,255,0.3);}' +
              '50%{box-shadow:0 0 0 5px rgba(255,255,255,0.94),0 0 0 18px rgba(230,57,70,0.05),0 26px 65px rgba(230,57,70,0.82),0 6px 18px rgba(0,0,0,0.5),inset 0 -7px 16px rgba(0,0,0,0.42),inset 0 4px 10px rgba(255,255,255,0.3);}}' +
              '@keyframes msShootFlash{0%{transform:scale(0.85);box-shadow:0 0 0 5px rgba(255,255,255,1),0 0 0 32px rgba(255,255,255,0.62),0 0 88px rgba(255,255,255,0.88);}' +
              '100%{transform:scale(1);box-shadow:0 0 0 5px rgba(255,255,255,0.94),0 0 0 9px rgba(230,57,70,0.22),0 20px 52px rgba(230,57,70,0.62);}}' +

              // ── HINT INFERIORE — fluido, no stutter (opacity-only breathe) ──
              '#ms-lv-hint{position:fixed;left:50%;bottom:248px;transform:translateX(-50%);z-index:2147483647;' +
              'pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;' +
              'padding:16px 32px;border-radius:80px;' +
              'background:rgba(0,0,0,0.42);' +
              'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);' +
              'border:1px solid rgba(255,255,255,0.22);' +
              'box-shadow:0 10px 32px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.16);' +
              // Una sola animazione: fade-in semplice, NO transform changes durante il loop
              'animation:msHintFadeIn 0.8s ease-out 0.4s both;' +
              'will-change:opacity;' +
              'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;}' +
              '@keyframes msHintFadeIn{0%{opacity:0;}100%{opacity:1;}}' +
              '#ms-lv-hint-dot{display:none;}' +
              '#ms-lv-hint-icon{display:none;}' +
              '#ms-lv-hint-text{display:flex;flex-direction:column;align-items:center;gap:5px;}' +
              // Titolo: opacity breathe (no transform, GPU fluido)
              '#ms-lv-hint-line1{font-size:30px;font-weight:700;letter-spacing:5px;text-transform:uppercase;' +
              'color:#fff;text-shadow:0 2px 14px rgba(0,0,0,0.85),0 0 4px rgba(0,0,0,0.7);line-height:1;' +
              'animation:msHintBreathe 3.2s ease-in-out 1.4s infinite;will-change:opacity;}' +
              '@keyframes msHintBreathe{0%,100%{opacity:0.92;}50%{opacity:1;}}' +
              '#ms-lv-hint-sep{display:none;}' +
              '#ms-lv-hint-line2{font-size:14px;font-weight:500;letter-spacing:2.5px;text-transform:uppercase;' +
              'color:rgba(255,255,255,0.82);text-shadow:0 1px 8px rgba(0,0,0,0.85);}' +

              // ── COUNTDOWN OVERLAY ──
              '#ms-countdown-overlay.ms-cd-flash{background:rgba(255,255,255,0.98)!important;' +
              'animation:msCdFlash 0.4s ease-out forwards;}' +
              '@keyframes msCdFlash{0%{background:rgba(255,255,255,0.98);}100%{background:rgba(255,255,255,0);opacity:0;}}';
            (document.head || document.documentElement).appendChild(__css);
          }
          // Vignetta cinematica
          if (!document.getElementById('ms-lv-vignette')) {
            var vig = document.createElement('div');
            vig.id = 'ms-lv-vignette';
            (document.body || document.documentElement).appendChild(vig);
          }
          // Scrim inferiore (gradiente dark per leggibilità testo + dock)
          if (!document.getElementById('ms-lv-scrim')) {
            var scrim = document.createElement('div');
            scrim.id = 'ms-lv-scrim';
            (document.body || document.documentElement).appendChild(scrim);
          }
          // "Guarda qui" rimosso dalla fase iniziale: appare solo durante il
          // countdown (vedi __msShowCountdown → "Guarda la camera e sorridi").
          // Se un cam-cue era stato creato in precedenza (versione vecchia),
          // lo rimuoviamo per ripulire la UI iniziale.
          try {
            var __oldCam = document.getElementById('ms-lv-cam-cue');
            if (__oldCam && __oldCam.parentNode) __oldCam.parentNode.removeChild(__oldCam);
          } catch (_) {}
          // Testo cinematico pre-scatto (nessun box, nessuna card)
          if (!document.getElementById('ms-lv-hint')) {
            var hint = document.createElement('div');
            hint.id = 'ms-lv-hint';
            hint.innerHTML =
              '<div id="ms-lv-hint-dot"></div>' +
              '<div id="ms-lv-hint-text">' +
                '<div id="ms-lv-hint-line1">Pronti?</div>' +
                '<div id="ms-lv-hint-line2">Tocca per il countdown 3 · 2 · 1</div>' +
              '</div>';
            (document.body || document.documentElement).appendChild(hint);
          }
          var bar = document.getElementById('ms-live-bar');
          if (!bar) {
            bar = document.createElement('div');
            bar.id = 'ms-live-bar';
            var svgL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
            var svgR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
            var svgC = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2L7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9zm3 15.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM12 9a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/></svg>';
            bar.innerHTML =
              '<div class="ms-lv-arrow-wrap">' +
                '<button id="ms-lv-prev" class="ms-lv-arrow" title="Cornice precedente">' + svgL + '</button>' +
                '<div class="ms-lv-arrow-label">Precedente</div>' +
              '</div>' +
              '<div class="ms-lv-shoot-wrap">' +
                '<button id="ms-lv-shoot" class="ms-lv-shoot" title="Scatta">' + svgC + '</button>' +
                '<div class="ms-lv-label">SCATTA ORA</div>' +
              '</div>' +
              '<div class="ms-lv-arrow-wrap">' +
                '<button id="ms-lv-next" class="ms-lv-arrow" title="Cornice successiva">' + svgR + '</button>' +
                '<div class="ms-lv-arrow-label">Successiva</div>' +
              '</div>';
            (document.body || document.documentElement).appendChild(bar);
            // Sfoglio cornici locali
            var cycleLocal = function(dir) {
              try {
                var raw = localStorage.getItem(FRAMES_KEY);
                if (!raw) return;
                var frames = JSON.parse(raw);
                if (!Array.isArray(frames) || !frames.length) return;
                var sel = localStorage.getItem(SELECTED_KEY) || '';
                var idx = -1;
                for (var i = 0; i < frames.length; i++) {
                  if ((frames[i].name || '') === sel) { idx = i; break; }
                }
                var n = idx < 0 ? 0 : (idx + dir + frames.length) % frames.length;
                var f = frames[n];
                if (f && f.name) localStorage.setItem(SELECTED_KEY, f.name);
                window.__msFrameOnLogged = false;
                sync();
              } catch (_) {}
            };
            document.getElementById('ms-lv-prev').addEventListener('click', function(ev) { ev.preventDefault(); ev.stopPropagation(); cycleLocal(-1); });
            document.getElementById('ms-lv-next').addEventListener('click', function(ev) { ev.preventDefault(); ev.stopPropagation(); cycleLocal(1); });
            // Click "scatta" → eseguiamo NOI il countdown visivo, poi al termine
            // clicchiamo captureBtn. Non usiamo count_down_start() della pagina remota
            // perché in sessione fa partire captureBtn immediatamente (select non caricato).
            document.getElementById('ms-lv-shoot').addEventListener('click', function(ev) {
              ev.preventDefault(); ev.stopPropagation();
              try {
                // Evita doppi click
                if (window.__msShootInFlight) return;
                window.__msShootInFlight = true;
                var __sb = this;
                __sb.classList.add('ms-lv-flash');
                setTimeout(function() { try { __sb.classList.remove('ms-lv-flash'); } catch (_) {} }, 500);

                // Avvia il NOSTRO countdown e al termine clicca captureBtn
                try {
                  window.__msShowCountdown(function() {
                    try {
                      var cb = document.getElementById('captureBtn');
                      if (cb) {
                        // Reset flag PRIMA del click così la pipeline cattura/preview funziona
                        window.__msShootInFlight = false;
                        if (typeof cb.click === 'function') cb.click();
                        else if (typeof cb.onclick === 'function') cb.onclick();
                        console.log('[ms] countdown done -> captureBtn.click()');
                      } else {
                        console.log('[ms] countdown done ma captureBtn non trovato');
                        window.__msShootInFlight = false;
                      }
                    } catch (e) {
                      console.log('[ms] capture click err: ' + e.message);
                      window.__msShootInFlight = false;
                    }
                  });
                } catch (e) {
                  console.log('[ms] countdown err: ' + e.message);
                  window.__msShootInFlight = false;
                }
              } catch (_) { window.__msShootInFlight = false; }
            });
          }
          // Mantienila sempre come ultimo figlio (per evitare che un fullscreen la copra)
          var fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
          var root = fsEl || document.body || document.documentElement;
          if (root && bar.parentNode !== root) {
            root.appendChild(bar);
          }
          var hintEl = document.getElementById('ms-lv-hint');
          if (hintEl && root && hintEl.parentNode !== root) root.appendChild(hintEl);
          var scrimEl = document.getElementById('ms-lv-scrim');
          if (scrimEl && root && scrimEl.parentNode !== root) root.appendChild(scrimEl);
          var vigEl = document.getElementById('ms-lv-vignette');
          if (vigEl && root && vigEl.parentNode !== root) root.appendChild(vigEl);
        } catch (_) {}
      }

      // ── COUNTDOWN OVERLAY API ──
      // Mostra un overlay cinematografico N-...-1 e invoca onDone() al termine (dopo flash).
      // Helper: riproduce gli audio pre-registrati della pagina remota (1.mp3..5.mp3, shot.mp3)
      // bypassando il flag 'sounds' e il volume del browser. Restituisce true se ha suonato.
      window.__msPlayPageSound = function(name) {
        try {
          var els = document.getElementsByName(name);
          var el = els && els[0];
          if (!el) return false;
          try { el.currentTime = 0; } catch (_) {}
          try { el.muted = false; el.volume = 1.0; } catch (_) {}
          var p = el.play();
          if (p && typeof p.catch === 'function') p.catch(function() {});
          return true;
        } catch (_) { return false; }
      };
      // Helper beep WebAudio (fallback se gli audio non sono ancora pronti)
      window.__msBeep = function(freq, dur, vol, type) {
        try {
          if (!window.__msAudioCtx) {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) window.__msAudioCtx = new Ctx();
          }
          var ctx = window.__msAudioCtx;
          if (!ctx) return;
          if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = type || 'sine';
          osc.frequency.value = freq || 800;
          var v = (typeof vol === 'number') ? vol : 0.25;
          var d = (typeof dur === 'number') ? dur : 0.12;
          gain.gain.setValueAtTime(0, ctx.currentTime);
          gain.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d);
          osc.connect(gain).connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + d + 0.02);
        } catch (_) {}
      };
      window.__msShowCountdown = function(onDone) {
        try {
          // Reset difensivo: rimuovo eventuali overlay countdown precedenti
          // rimasti orfani (es. da uno scatto precedente non concluso) sia
          // nel doc corrente sia nel top doc.
          try {
            var __cleanups = [];
            try { __cleanups.push(document); } catch (_) {}
            try { if (window.top && window.top.document && window.top.document !== document) __cleanups.push(window.top.document); } catch (_) {}
            for (var __ci = 0; __ci < __cleanups.length; __ci++) {
              var __old = __cleanups[__ci].getElementById('ms-countdown-overlay');
              if (__old && __old.parentNode) __old.parentNode.removeChild(__old);
            }
          } catch (_) {}
          // Reset stato hide cornice precedente
          try { window.__msHideOverlayUntil = 0; } catch (_) {}
          // Evita doppi countdown se uno è già attivo
          if (document.getElementById('ms-countdown-overlay')) {
            try { if (typeof onDone === 'function') onDone(); } catch (_) {}
            return;
          }
          // Marca countdown attivo e rimuovi immediatamente la UI iniziale
          // (hint "Pronti?", barra SCATTA, scrim, vignetta) — durante il
          // countdown si vede SOLO la schermata countdown, come photobooth classico.
          try {
            window.__msCountdownActive = true;
            var __initialIds = ['ms-lv-hint','ms-live-bar','ms-lv-scrim','ms-lv-vignette','ms-lv-cam-cue'];
            for (var __ii = 0; __ii < __initialIds.length; __ii++) {
              var __ie = document.getElementById(__initialIds[__ii]);
              if (__ie && __ie.parentNode) __ie.parentNode.removeChild(__ie);
            }
          } catch (_) {}
          var seconds = 3;
          // 1) localStorage (impostato dal pannello)
          try {
            var ls = parseInt(localStorage.getItem('msCountdownSec') || '', 10);
            if (!isNaN(ls) && ls > 0 && ls <= 30) seconds = ls;
          } catch (_) {}
          // 2) variabile globale della pagina remota
          try {
            var globalKeys = ['count_down_value','count_down','count_down_time','countDown','countdown'];
            for (var gk = 0; gk < globalKeys.length; gk++) {
              var v = window[globalKeys[gk]];
              if (typeof v === 'number' && v > 0 && v <= 30) { seconds = v; break; }
              if (typeof v === 'string') {
                var pv = parseInt(v, 10);
                if (!isNaN(pv) && pv > 0 && pv <= 30) { seconds = pv; break; }
              }
            }
          } catch (_) {}
          // 3) select sulla pagina (se presente)
          try {
            var sel = document.querySelector('select[name=count_down_selected]');
            if (sel && sel.value) {
              var v2 = parseInt(sel.value, 10);
              if (!isNaN(v2) && v2 > 0 && v2 <= 30) seconds = v2;
            }
          } catch (_) {}
          // ── OVERLAY COUNTDOWN PREMIUM CINEMATOGRAFICO ──
          // Glassmorphism + glow soft + progress ring + gerarchia visiva.
          // Sfondo semi-trasparente con vignettatura cinematica per mantenere
          // visibile la persona ma rendere dominante la UI countdown.

          // Inietta animazioni una sola volta
          try {
            if (!document.getElementById('ms-cd-anim-css')) {
              var __cdCss = document.createElement('style');
              __cdCss.id = 'ms-cd-anim-css';
              __cdCss.textContent =
                '@keyframes msCdNumIn{0%{opacity:0;transform:translate(-50%,-50%) scale(1.55);filter:blur(14px);}55%{opacity:1;filter:blur(0);}100%{opacity:1;transform:translate(-50%,-50%) scale(1);filter:blur(0);}}' +
                '@keyframes msCdNumPulse{0%,100%{text-shadow:0 0 60px rgba(255,72,108,0.85),0 0 120px rgba(255,72,108,0.5),0 0 220px rgba(255,72,108,0.28),0 10px 40px rgba(0,0,0,0.95);}50%{text-shadow:0 0 80px rgba(255,72,108,1),0 0 160px rgba(255,72,108,0.65),0 0 280px rgba(255,72,108,0.38),0 10px 40px rgba(0,0,0,0.95);}}' +
                '@keyframes msCdRing{0%{stroke-dashoffset:1885;}100%{stroke-dashoffset:0;}}' +
                '@keyframes msCdRingGlow{0%,100%{filter:drop-shadow(0 0 14px rgba(255,72,108,0.5)) drop-shadow(0 0 28px rgba(255,72,108,0.3));}50%{filter:drop-shadow(0 0 22px rgba(255,72,108,0.75)) drop-shadow(0 0 44px rgba(255,72,108,0.45));}}' +
                '@keyframes msCdHeadIn{0%{opacity:0;transform:translateY(-26px);letter-spacing:24px;}100%{opacity:1;transform:translateY(0);letter-spacing:14px;}}' +
                '@keyframes msCdSubIn{0%{opacity:0;transform:translateY(14px);}100%{opacity:0.9;transform:translateY(0);}}' +
                '@keyframes msCdHintIn{0%{opacity:0;transform:translateY(30px) scale(0.94);}100%{opacity:1;transform:translateY(0) scale(1);}}' +
                '@keyframes msCdHintBreathe{0%,100%{box-shadow:0 16px 50px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.08) inset;}50%{box-shadow:0 20px 60px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.14) inset,0 0 40px rgba(255,72,108,0.18);}}' +
                '@keyframes msCdSmileBounce{0%,100%{transform:scale(1);}50%{transform:scale(1.08);}}' +
                '@keyframes msCdArrowBounce{0%,100%{transform:translateY(0);}50%{transform:translateY(-12px);}}' +
                '@keyframes msCdVignetteIn{0%{opacity:0;}100%{opacity:1;}}' +
                '#ms-countdown-overlay.ms-cd-flash{background:rgba(255,255,255,0.98)!important;}' +
                '';
              (document.head || document.documentElement).appendChild(__cdCss);
            }
          } catch (_) {}

          var ov = document.createElement('div');
          ov.id = 'ms-countdown-overlay';
          ov.setAttribute('style',
            'position:fixed!important;' +
            'top:0!important;left:0!important;right:0!important;bottom:0!important;' +
            'width:100vw!important;height:100vh!important;' +
            'z-index:2147483647!important;' +
            // Vignettatura cinematica: scuro ai bordi, trasparente al centro per non coprire la persona
            'background:radial-gradient(ellipse at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0.18) 35%, rgba(0,0,0,0.55) 75%, rgba(0,0,0,0.78) 100%)!important;' +
            'pointer-events:none!important;' +
            'opacity:1!important;visibility:visible!important;display:block!important;' +
            'margin:0!important;padding:0!important;border:0!important;' +
            'animation:msCdVignetteIn 0.5s ease-out!important;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif!important;'
          );

          // PROGRESS RING (doppio anello SVG con glow dinamico)
          var ringWrap = document.createElement('div');
          ringWrap.id = 'ms-countdown-ring-wrap';
          ringWrap.setAttribute('style',
            'position:absolute!important;top:50%!important;left:50%!important;' +
            'width:760px!important;height:760px!important;' +
            'transform:translate(-50%,-50%)!important;' +
            'pointer-events:none!important;display:block!important;visibility:visible!important;opacity:1!important;' +
            'animation:msCdRingGlow 2s ease-in-out infinite!important;'
          );
          // SVG cerchio: r=300 → circumference ≈ 1885
          var ringTotal = Math.max(0.6, parseFloat(seconds) || 3);
          ringWrap.innerHTML =
            '<svg viewBox="0 0 760 760" width="760" height="760" style="display:block;overflow:visible;">' +
              // Anello esterno sottile (traccia)
              '<circle cx="380" cy="380" r="300" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>' +
              // Anello principale (traccia)
              '<circle cx="380" cy="380" r="300" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="6"/>' +
              // Anello progress animato
              '<circle id="ms-cd-ring-prog" cx="380" cy="380" r="300" fill="none" ' +
                'stroke="url(#ms-cd-ring-grad)" stroke-width="6" stroke-linecap="round" ' +
                'stroke-dasharray="1885" stroke-dashoffset="0" ' +
                'transform="rotate(-90 380 380)" ' +
                'style="animation:msCdRing ' + ringTotal + 's linear forwards;"/>' +
              // Anello interno decorativo
              '<circle cx="380" cy="380" r="288" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>' +
              '<defs>' +
                '<linearGradient id="ms-cd-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">' +
                  '<stop offset="0%" stop-color="#ff486c"/>' +
                  '<stop offset="50%" stop-color="#ff7ea8"/>' +
                  '<stop offset="100%" stop-color="#ffb3c8"/>' +
                '</linearGradient>' +
              '</defs>' +
            '</svg>';

          // HALO morbido dietro al numero
          var halo = document.createElement('div');
          halo.id = 'ms-countdown-halo';
          halo.setAttribute('style',
            'position:absolute!important;top:50%!important;left:50%!important;' +
            'width:560px!important;height:560px!important;' +
            'transform:translate(-50%,-50%)!important;' +
            'border-radius:50%!important;' +
            'background:radial-gradient(circle, rgba(255,72,108,0.22) 0%, rgba(0,0,0,0.55) 35%, rgba(0,0,0,0.25) 65%, rgba(0,0,0,0) 80%)!important;' +
            'filter:blur(8px)!important;' +
            'pointer-events:none!important;display:block!important;visibility:visible!important;opacity:1!important;'
          );

          // NUMERO CENTRALE PREMIUM
          var numEl2 = document.createElement('div');
          numEl2.id = 'ms-countdown-num';
          numEl2.textContent = String(seconds);
          numEl2.setAttribute('style',
            'position:absolute!important;' +
            'top:50%!important;left:50%!important;' +
            'transform:translate(-50%,-50%)!important;' +
            'font-size:520px!important;' +
            'font-weight:200!important;' +
            'color:#ffffff!important;' +
            'line-height:1!important;' +
            'text-align:center!important;' +
            'text-shadow:0 0 60px rgba(255,72,108,0.85),0 0 120px rgba(255,72,108,0.5),0 0 220px rgba(255,72,108,0.28),0 10px 40px rgba(0,0,0,0.95)!important;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif!important;' +
            'letter-spacing:-18px!important;' +
            'opacity:1!important;visibility:visible!important;display:block!important;' +
            'margin:0!important;padding:0!important;border:0!important;' +
            'pointer-events:none!important;width:auto!important;height:auto!important;' +
            'background:transparent!important;' +
            'animation:msCdNumIn 0.42s cubic-bezier(.22,1.2,.36,1) both,msCdNumPulse 1s ease-in-out 0.42s infinite!important;'
          );

          // HEADLINE "PREPARATI!"
          var topEl = document.createElement('div');
          topEl.id = 'ms-countdown-top';
          topEl.innerHTML = '<div id="ms-cd-head" style="font-size:78px;font-weight:800;letter-spacing:14px;color:#fff;text-transform:uppercase;line-height:1;text-shadow:0 6px 30px rgba(0,0,0,0.95),0 0 40px rgba(255,72,108,0.35);animation:msCdHeadIn 0.6s cubic-bezier(.22,1.2,.36,1) both;">Preparati!</div>' +
            '<div id="ms-cd-sub" style="margin-top:18px;font-size:26px;font-weight:400;letter-spacing:5px;color:rgba(255,255,255,0.78);text-transform:uppercase;text-shadow:0 4px 18px rgba(0,0,0,0.9);animation:msCdSubIn 0.6s ease-out 0.18s both;">Lo scatto sta per partire</div>';
          topEl.setAttribute('style',
            'position:absolute!important;top:11%!important;left:0!important;right:0!important;text-align:center!important;' +
            'display:block!important;visibility:visible!important;pointer-events:none!important;' +
            'margin:0!important;padding:0!important;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif!important;'
          );

          // HINT IN ALTO "GUARDA LA CAMERA E SORRIDI!" con freccia che punta
          // verso la fotocamera fisica (in alto). Centrato su tutta la schermata.
          var bottomEl = document.createElement('div');
          bottomEl.id = 'ms-countdown-bottom';
          bottomEl.innerHTML =
            // Freccia in alto (verso la camera)
            '<div id="ms-cd-uparrow" style="width:100%;display:block;text-align:center;margin-bottom:14px;' +
              'animation:msCdArrowBounce 1.4s ease-in-out infinite;">' +
              '<svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ' +
                'style="filter:drop-shadow(0 0 18px rgba(255,72,108,0.85)) drop-shadow(0 4px 14px rgba(0,0,0,0.85));">' +
                '<polyline points="6 14 12 8 18 14"/>' +
                '<polyline points="6 20 12 14 18 20" opacity="0.55"/>' +
              '</svg>' +
            '</div>' +
            '<div style="width:100%;display:block;text-align:center;">' +
              '<div id="ms-cd-hint" style="display:inline-flex;align-items:center;justify-content:center;gap:22px;padding:24px 44px;border-radius:80px;' +
                'background:rgba(20,20,28,0.55);backdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);' +
                'border:1px solid rgba(255,255,255,0.14);box-shadow:0 16px 50px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.08) inset;' +
                'animation:msCdHintIn 0.55s cubic-bezier(.22,1.2,.36,1) 0.25s both,msCdHintBreathe 3s ease-in-out 0.8s infinite;">' +
                '<div style="display:inline-flex;align-items:center;justify-content:center;width:62px;height:62px;border-radius:50%;' +
                  'background:linear-gradient(135deg,#ff486c 0%,#ff7ea8 100%);box-shadow:0 8px 24px rgba(255,72,108,0.45);flex-shrink:0;' +
                  'animation:msCdSmileBounce 1.6s ease-in-out infinite;">' +
                  '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M3 8.5h3l1.5-2h9L18 8.5h3v11H3z"/>' +
                    '<circle cx="12" cy="13.5" r="3.2"/>' +
                    '<circle cx="18" cy="11" r="0.6" fill="#fff"/>' +
                  '</svg>' +
                '</div>' +
                '<div style="text-align:center;line-height:1.05;">' +
                  '<div style="font-size:32px;font-weight:600;letter-spacing:2.5px;color:rgba(255,255,255,0.92);text-transform:uppercase;">Guarda la camera</div>' +
                  '<div style="margin-top:6px;font-size:48px;font-weight:800;letter-spacing:3px;color:#fff;text-transform:uppercase;text-shadow:0 0 30px rgba(255,72,108,0.55);background:linear-gradient(180deg,#fff 0%,#ffd9e3 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">e sorridi!</div>' +
                '</div>' +
              '</div>' +
            '</div>';
          bottomEl.setAttribute('style',
            'position:absolute!important;top:4%!important;left:0!important;right:0!important;' +
            'width:100vw!important;box-sizing:border-box!important;' +
            'display:block!important;' +
            'visibility:visible!important;pointer-events:none!important;' +
            'margin:0!important;padding:0!important;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif!important;'
          );

          ov.appendChild(ringWrap);
          ov.appendChild(halo);
          ov.appendChild(numEl2);
          // topEl ("PREPARATI!") rimosso: l'hint con freccia in alto ha la priorità
          // visiva, evitiamo doppi titoli sovrapposti.
          ov.appendChild(bottomEl);
          // CRITICAL: la pagina remota usa HTML5 Fullscreen API sul <video>.
          // In quella modalita' SOLO i discendenti dell'elemento in fullscreen
          // sono visibili. Un <video> non puo' avere figli HTML, quindi
          // l'unica soluzione e' USCIRE dal fullscreen API durante il
          // countdown (la finestra Electron resta comunque fullscreen di sua,
          // quindi visivamente non cambia nulla).
          try {
            var __fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (__fsEl) {
              ov.__msWasFs = __fsEl;
              if (document.exitFullscreen) document.exitFullscreen().catch(function(){});
              else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
              console.log('[ms] countdown: uscito da HTML fullscreen per visibilita');
            }
          } catch (_) {}
          (document.body || document.documentElement).appendChild(ov);
          try { console.log('[ms] countdown overlay PREMIUM creato seconds=' + seconds); } catch (_) {}
          // Diagnostica: log dimensioni reali del numero subito dopo append
          try {
            requestAnimationFrame(function() {
              try {
                var r = numEl2.getBoundingClientRect();
                var ovR = ov.getBoundingClientRect();
                var cs = getComputedStyle(numEl2);
                console.log('[ms] countdown sizes num=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' @(' + Math.round(r.left) + ',' + Math.round(r.top) + ') ov=' + Math.round(ovR.width) + 'x' + Math.round(ovR.height) + ' fontSize=' + cs.fontSize + ' display=' + cs.display + ' opacity=' + cs.opacity + ' visibility=' + cs.visibility);
              } catch (_) {}
            });
          } catch (_) {}
          var numEl = numEl2;
          var current = seconds;
          // Watchdog: riasserisce visibilita' del numero ogni 60ms contro
          // qualunque codice della pagina che provasse a nasconderlo.
          var __cdWd = setInterval(function() {
            try {
              if (!numEl || !numEl.isConnected) return;
              var cs = numEl.style;
              if (cs.opacity !== '1' && cs.transition && cs.transition.indexOf('opacity') >= 0) {
                // sta animando, lascia stare
              } else {
                cs.setProperty('opacity', '1', 'important');
                cs.setProperty('visibility', 'visible', 'important');
                cs.setProperty('display', 'block', 'important');
              }
              // riassicura overlay sempre in cima al body
              if (document.body && ov.parentNode !== document.body) document.body.appendChild(ov);
            } catch (_) {}
          }, 60);
          var tick = function() {
            current--;
            try { console.log('[ms] countdown tick current=' + current); } catch (_) {}
            if (current <= 0) {
              try { clearInterval(__cdWd); } catch (_) {}
              // Audio di scatto pre-registrato della pagina (shot.mp3)
              if (!window.__msPlayPageSound('sound_shot')) {
                try { window.__msBeep(1200, 0.32, 0.45, 'triangle'); } catch (_) {}
              }
              // Flash bianco di scatto + invoca onDone DOPO il flash
              try { ov.classList.add('ms-cd-flash'); } catch (_) {}
              setTimeout(function() {
                try { if (ov.parentNode) ov.parentNode.removeChild(ov); } catch (_) {}
                try { window.__msCountdownActive = false; } catch (_) {}
                try { if (typeof onDone === 'function') onDone(); } catch (_) {}
              }, 350);
              return;
            }
            // Audio del numero corrente (1.mp3..5.mp3) con fallback beep
            if (!window.__msPlayPageSound('sound_' + current)) {
              try { window.__msBeep(700, 0.12, 0.32, 'sine'); } catch (_) {}
            }
            try {
              if (numEl) {
                // Cambio testo + pop SENZA mai portare opacity a 0
                // (evita il "lampo" di invisibilita').
                numEl.textContent = current;
                numEl.style.transition = 'none';
                numEl.style.transform = 'translate(-50%,-50%) scale(1.35)';
                // forza reflow
                void numEl.offsetWidth;
                numEl.style.transition = 'transform 0.42s cubic-bezier(.34,1.56,.64,1)';
                numEl.style.transform = 'translate(-50%,-50%) scale(1)';
              }
            } catch (_) {}
            // Riassicura overlay in cima al body
            try {
              if (document.body) {
                if (ov.parentNode !== document.body) document.body.appendChild(ov);
                else if (document.body.lastElementChild !== ov) document.body.appendChild(ov);
              }
            } catch (_) {}
            setTimeout(tick, 1000);
          };
          // Audio iniziale per il primo numero gia' visibile (sound_<seconds>.mp3)
          if (!window.__msPlayPageSound('sound_' + seconds)) {
            try { window.__msBeep(700, 0.12, 0.32, 'sine'); } catch (_) {}
          }
          setTimeout(tick, 1000);
        } catch (_) {
          try { window.__msCountdownActive = false; } catch (_) {}
          try { if (typeof onDone === 'function') onDone(); } catch (_) {}
        }
      };

      function __msEnsureBackBtn(visible) {
        // IMPORTANTE: il <video> di Chromium sale a "video overlay plane"
        // hardware-accelerated che bypassa lo stacking context CSS globale.
        // L'unico modo affidabile per stare visivamente SOPRA il video e'
        // essere un fratello successivo del <video> nello stesso parent
        // (stesso stacking context locale). Stessa strategia gia' usata
        // dalla cornice. Se il video non esiste (es. home), fallback a body.
        var root;
        try {
          root = (typeof getPreferredParent === 'function')
            ? getPreferredParent()
            : (document.body || document.documentElement);
        } catch (_) { root = document.body || document.documentElement; }
        if (!root) return;
        // CSS premium per il bottone (idempotente).
        try {
          if (visible && !document.getElementById('ms-pb-back-css-global')) {
            var __bcss = document.createElement('style');
            __bcss.id = 'ms-pb-back-css-global';
            __bcss.textContent =
              '#ms-pb-back{position:fixed!important;top:32px!important;left:32px!important;z-index:2147483647!important;' +
                'pointer-events:auto!important;display:inline-flex!important;align-items:center!important;gap:10px!important;' +
                'padding:0 22px!important;height:60px!important;border-radius:34px!important;border:1px solid rgba(255,255,255,0.13)!important;' +
                'background:linear-gradient(180deg,rgba(22,22,28,0.50) 0%,rgba(14,14,18,0.58) 100%)!important;' +
                'backdrop-filter:blur(38px) saturate(160%) brightness(1.04)!important;' +
                '-webkit-backdrop-filter:blur(38px) saturate(160%) brightness(1.04)!important;' +
                'box-shadow:0 12px 30px rgba(0,0,0,0.50),0 3px 8px rgba(0,0,0,0.32),inset 0 1px 0 rgba(255,255,255,0.07)!important;' +
                'color:rgba(255,255,255,0.86)!important;' +
                'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;' +
                'font-size:16px!important;font-weight:500!important;letter-spacing:1.2px!important;text-transform:uppercase!important;' +
                'cursor:pointer!important;-webkit-user-select:none!important;user-select:none!important;line-height:1!important;white-space:nowrap!important;' +
                // Forza promozione a layer di compositing dedicato per
                // sovrastare il video overlay hardware-accelerated.
                'transform:translateZ(0)!important;will-change:transform!important;isolation:isolate!important;' +
                'transition:background 0.20s ease,opacity 0.20s ease!important;}' +
              '#ms-pb-back svg{width:18px!important;height:18px!important;flex:0 0 auto!important;}' +
              '#ms-pb-back:active{transform:translateZ(0) scale(0.94)!important;background:linear-gradient(180deg,rgba(34,34,40,0.62) 0%,rgba(22,22,28,0.68) 100%)!important;}' +
              // Anche lo shield deve essere su layer separato per stare
              // sopra il video element.
              '#ms-bl-shield{transform:translateZ(0)!important;will-change:transform!important;isolation:isolate!important;}';
            (document.head || document.documentElement).appendChild(__bcss);
          }
        } catch (_) {}
        try {
          var bk = document.getElementById('ms-pb-back');
          var _wasCreated = false, _wasReattached = false;
          if (visible) {
            if (!bk) {
              bk = document.createElement('button');
              bk.id = 'ms-pb-back';
              bk.type = 'button';
              bk.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>Torna al pannello</span>';
              bk.addEventListener('click', function(ev) {
                try { ev.preventDefault(); ev.stopPropagation(); } catch(_) {}
                try {
                  if (window.electronAPI && typeof window.electronAPI.navigateHome === 'function') {
                    window.electronAPI.navigateHome();
                  }
                } catch(_) {}
              }, true);
              root.appendChild(bk);
              _wasCreated = true;
            } else if (bk.parentNode !== root) {
              root.appendChild(bk);
              _wasReattached = true;
            }
            bk.style.setProperty('display', 'inline-flex', 'important');
            bk.style.setProperty('visibility', 'visible', 'important');
            bk.style.setProperty('opacity', '1', 'important');
            // Diagnostica: log periodico (ogni ~3s) dello stato visivo reale del bottone.
            try {
              var nowD = Date.now();
              if (_wasCreated || _wasReattached || !window.__msBackDiagLast || (nowD - window.__msBackDiagLast) > 3000) {
                window.__msBackDiagLast = nowD;
                var rect = bk.getBoundingClientRect();
                var cs = getComputedStyle(bk);
                var coverEl = null, coverDesc = '';
                try {
                  var cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
                  coverEl = document.elementFromPoint(cx, cy);
                  if (coverEl && coverEl !== bk && !bk.contains(coverEl)) {
                    coverDesc = ' COVERED_BY=' + (coverEl.tagName||'?') + (coverEl.id?'#'+coverEl.id:'') + (coverEl.className && typeof coverEl.className === 'string'?'.'+coverEl.className.split(/\s+/).slice(0,2).join('.'):'');
                  }
                } catch(_) {}
                console.log('MS-DEBUG back rect=' + Math.round(rect.left)+','+Math.round(rect.top)+' '+Math.round(rect.width)+'x'+Math.round(rect.height) + ' disp=' + cs.display + ' vis=' + cs.visibility + ' op=' + cs.opacity + ' z=' + cs.zIndex + ' parent=' + (bk.parentNode && bk.parentNode.tagName) + ' created=' + _wasCreated + ' reatt=' + _wasReattached + coverDesc);
              }
            } catch(_) {}
          } else if (bk) {
            bk.style.setProperty('display', 'none', 'important');
          }
        } catch(_) {}
        // Shield invisibile: blocca i tap nell'angolo basso-sinistro (impedisce
        // il tasto della pagina remota che torna al pannello durante il pre-scatto)
        try {
          var sh = document.getElementById('ms-bl-shield');
          if (visible) {
            if (!sh) {
              sh = document.createElement('div');
              sh.id = 'ms-bl-shield';
              sh.style.cssText = 'position:fixed!important;left:0!important;bottom:0!important;width:220px!important;height:220px!important;z-index:2147483646!important;background:transparent!important;pointer-events:auto!important;';
              var swallow = function(ev) { try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation && ev.stopImmediatePropagation(); } catch(_) {} };
              ['pointerdown','pointerup','mousedown','mouseup','click','touchstart','touchend','contextmenu'].forEach(function(t) {
                sh.addEventListener(t, swallow, true);
              });
              root.appendChild(sh);
            } else if (sh.parentNode !== root) {
              root.appendChild(sh);
            }
            sh.style.setProperty('display', 'block', 'important');
          } else if (sh) {
            sh.style.setProperty('display', 'none', 'important');
          }
        } catch(_) {}
      }
      // Esposizione globale: invocabile manualmente da DevTools per debug.
      // Il tick automatico è gestito da sync() in injectSessionFrameOverlay.
      try { window.__msEnsureBackBtn = __msEnsureBackBtn; } catch(_) {}

      function sync() {
        var ov = ensureOverlay();
        var sess = isSession();
        var rev = isReviewVisible();
        var hideAfterCapture = !!(window.__msHideOverlayUntil && Date.now() < window.__msHideOverlayUntil);
        var show = sess && !rev && !hideAfterCapture;
        var src = getSource();
        ensureFullscreenBtn(sess);
        ensureLiveActionBar(sess && !rev);
        // Bottone "Torna al pannello" + shield bottom-left: visibili SOLO in
        // pagina sessione (pre-scatto / post-scatto), mai in home.
        try { __msEnsureBackBtn(sess); } catch (_) {}
        var preferredParent = getPreferredParent();
        if (show && src) {
          if (ov.src !== src) ov.src = src;
          ov.style.setProperty('display', 'block', 'important');
          ov.style.setProperty('visibility', 'visible', 'important');
          ov.style.setProperty('opacity', '1', 'important');
          ov.style.setProperty('z-index', '2147483646', 'important');
          // SEMPRE rispostare come ultimo figlio del parent del video, ad ogni tick
          try {
            if (preferredParent && (ov.parentNode !== preferredParent || preferredParent.lastElementChild !== ov)) {
              preferredParent.appendChild(ov);
            }
          } catch (_) {}
          if (!window.__msFrameOnLogged) {
            window.__msFrameOnLogged = true;
            try {
              var w = window.innerWidth, h = window.innerHeight;
              var pts = [['TL', 30, 30], ['TR', w - 30, 30], ['BL', 30, h - 30], ['BR', w - 30, h - 30], ['CTR', w / 2, h / 2]];
              var info = pts.map(function(p) {
                var el = document.elementFromPoint(p[1], p[2]);
                var tag = el ? (el.tagName + (el.id ? '#' + el.id : '')) : 'null';
                return p[0] + '=' + tag;
              }).join(' ');
              console.log('[ms] cornice ON parent=' + (ov.parentNode && ov.parentNode.tagName) + (ov.parentNode && ov.parentNode.id ? '#' + ov.parentNode.id : '') + ' top@: ' + info);
            } catch (_) {}
          }
        } else {
          if (!window.__msFrameHideLogged && sess && (rev || !src || hideAfterCapture)) {
            window.__msFrameHideLogged = true;
            try { console.log('[ms] cornice OFF sess=' + sess + ' review=' + rev + ' captureHide=' + hideAfterCapture + ' hasSrc=' + (src ? 'yes' : 'no')); } catch (_) {}
            setTimeout(function() { window.__msFrameHideLogged = false; }, 2000);
          }
          ov.style.setProperty('display', 'none', 'important');
          if (ov.src) ov.src = '';
          window.__msFrameOnLogged = false;
        }
      }

      function armAutoPreviewDiagnostics() {
        if (window.__msAutoDiagWired) return;
        window.__msAutoDiagWired = true;
        try { console.log('[ms] auto diagnostics armed'); } catch (_) {}

        try {
          document.addEventListener('click', function(ev) {
            try {
              var node = ev && ev.target;
              var el = node && node.closest ? node.closest('button,input[type="button"],input[type="submit"],a,[role="button"],div,span') : null;
              if (!el) return;
              var txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
              var cls = (el.className && String(el.className).trim()) ? String(el.className).trim().split(/\s+/).slice(0, 4).join('.') : '-';
              console.log('[ms] click tag=' + el.tagName + ' id=' + (el.id || '-') + ' cls=' + cls + ' txt=' + txt);
              if (el.id === 'captureBtn') {
                // Reset flag dismiss precedente: se l'utente fa un altro scatto
                // entro 5s dal dismiss della preview precedente, il flag
                // __msPreviewDismissed e' ancora true e farebbe abortire
                // immediatamente il watchdog facendo "scomparire" l'anteprima.
                try { window.__msPreviewDismissed = false; window.__msPreviewActive = false; } catch (_) {}
                // Dopo lo scatto la pagina mostra anteprima/review: teniamo la
                // cornice nascosta SOLO il tempo del flash (300ms). La preview
                // ha gia' la sua cornice (#ms-preview-frame-ov), quindi non
                // serve oscurarla a lungo.
                window.__msHideOverlayUntil = Date.now() + 300;
                console.log('[ms] capture detected -> hide cornice 300ms (dismissed flag cleared)');
                // Watchdog: se foto_temp non diventa visibile entro 600ms, ripristina cornice subito
                try { if (window.__msCaptureRecovery) clearTimeout(window.__msCaptureRecovery); } catch (_) {}
                window.__msCaptureRecovery = setTimeout(function() {
                  try {
                    var __ft = document.getElementById('foto_temp');
                    var __vis = __ft && __ft.offsetWidth > 100 && __ft.offsetHeight > 100 && getComputedStyle(__ft).display !== 'none';
                    if (!__vis) {
                      console.log('[ms] capture recovery: nessun preview, riapro cornice');
                      window.__msHideOverlayUntil = 0;
                      try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {}
                    }
                  } catch (_) {}
                }, 600);
                try {
                  var __v = document.getElementById('video');
                  if (__v && __v.videoWidth > 0 && __v.videoHeight > 0) {
                    var __c = document.createElement('canvas');
                    __c.width = __v.videoWidth;
                    __c.height = __v.videoHeight;
                    var __ctx = __c.getContext('2d');
                    if (__ctx) {
                      __ctx.drawImage(__v, 0, 0, __c.width, __c.height);
                      window.__msPreviewFallbackUrl = __c.toDataURL('image/jpeg', 0.92);
                      console.log('[ms] capture fallback frame ready');
                    }
                  }
                } catch (_) {}

                function __msEnsurePreview(ft, forcedSrc) {
                  if (!ft) return false;
                  try {
                    if (document.body) document.body.setAttribute('data-ms-preview', 'on');
                    // Host fullscreen che fa da "stage cinematica" per la card flottante.
                    // Sfondo deep-dark premium (la foto blurred dietro la card riempie il vuoto).
                    ft.setAttribute('data-ms-preview-host', '1');
                    ft.style.setProperty('position', 'fixed', 'important');
                    ft.style.setProperty('top', '0', 'important');
                    ft.style.setProperty('left', '0', 'important');
                    ft.style.setProperty('right', '0', 'important');
                    ft.style.setProperty('bottom', '0', 'important');
                    ft.style.setProperty('width', '100vw', 'important');
                    ft.style.setProperty('height', '100vh', 'important');
                    ft.style.setProperty('margin', '0', 'important');
                    ft.style.setProperty('padding', '0', 'important');
                    ft.style.setProperty('background', 'transparent', 'important');
                    ft.style.setProperty('overflow', 'hidden', 'important');
                    ft.style.setProperty('display', 'block', 'important');
                    ft.style.setProperty('visibility', 'visible', 'important');
                    ft.style.setProperty('opacity', '1', 'important');
                    ft.style.setProperty('z-index', '2147483647', 'important');
                    ft.style.setProperty('pointer-events', 'none', 'important');
                  } catch (_) {}

                  var imgs = ft.getElementsByTagName('img');
                  var img = imgs && imgs.length ? imgs[0] : null;
                  if (!img) return false;

                  try {
                    var main = ft.querySelector(':scope > img#ms-preview-main');
                    var currentMainSrc = String(main && main.src || '').trim();
                    var forced = String(forcedSrc || '').trim();
                    var fallback = String(window.__msPreviewFallbackUrl || '').trim();
                    var rawImgSrc = String(img.currentSrc || img.src || '').trim();
                    var isUsablePreviewSrc = function(value) {
                      var lower = String(value || '').toLowerCase();
                      return !!lower && lower.indexOf('blob:') !== 0 && lower.indexOf('cursor_cancel.png') === -1 && lower.indexOf('cursor_ok.png') === -1 && lower.indexOf('/mirror/index') === -1;
                    };
                    var previewSrc = isUsablePreviewSrc(forced)
                      ? forced
                      : (isUsablePreviewSrc(currentMainSrc)
                        ? currentMainSrc
                        : (isUsablePreviewSrc(fallback)
                          ? fallback
                          : (isUsablePreviewSrc(rawImgSrc) ? rawImgSrc : fallback)));

                    // Background blurred cinematico: copre TUTTO il viewport,
                    // forte blur + dark overlay -> percezione "foto sospesa davanti"
                    var bg = ft.querySelector(':scope > img#ms-preview-bg');
                    if (!bg) {
                      bg = document.createElement('img');
                      bg.id = 'ms-preview-bg';
                      ft.insertBefore(bg, ft.firstChild || null);
                    }
                    if (previewSrc && bg.src !== previewSrc) bg.src = previewSrc;
                    bg.removeAttribute('style');

                    // Foto principale: posizionata SOLO via CSS (vars su #foto_temp)
                    if (!main) {
                      main = document.createElement('img');
                      main.id = 'ms-preview-main';
                      ft.appendChild(main);
                    }
                    if (previewSrc && main.src !== previewSrc) main.src = previewSrc;
                    main.removeAttribute('style');

                    if (img !== main) {
                      img.style.setProperty('display', 'none', 'important');
                      img.style.setProperty('visibility', 'hidden', 'important');
                      img.style.setProperty('opacity', '0', 'important');
                    }
                  } catch (_) {}

                  // Cornice grafica sopra la foto: stesso bbox della card flottante
                  try {
                    var __frameSrc = (typeof getSource === 'function') ? getSource() : '';
                    if (__frameSrc) {
                      var fov = ft.querySelector(':scope > img#ms-preview-frame-ov');
                      if (!fov) {
                        fov = document.createElement('img');
                        fov.id = 'ms-preview-frame-ov';
                        ft.appendChild(fov);
                      }
                      if (fov.src !== __frameSrc) fov.src = __frameSrc;
                      fov.removeAttribute('style');
                      try {
                        if (String(ft.__msPreviewRectSrc || '') !== __frameSrc) {
                          ft.__msPreviewRectSrc = __frameSrc;
                        }
                        __msEnsurePreviewRect(ft, __frameSrc);
                      } catch (_) {}
                    } else {
                      __msResetPreviewRectVars(ft);
                      try { ft.__msPreviewRectSrc = ''; } catch (_) {}
                    }
                  } catch (_) {}

                  // (Rimossi #ms-preview-bar e #ms-preview-vignette: la card
                  // flottante non occupa più il fullscreen quindi non servono
                  // gradient di leggibilità sopra la foto.)
                  try {
                    var __oldBar = document.getElementById('ms-preview-bar');
                    if (__oldBar && __oldBar.parentNode) __oldBar.parentNode.removeChild(__oldBar);
                    var __oldVig = document.getElementById('ms-preview-vignette');
                    if (__oldVig && __oldVig.parentNode) __oldVig.parentNode.removeChild(__oldVig);
                  } catch (_) {}

                  // Nascondi i controlli originali del remote page (off-screen ma funzionali per dispatch sintetici)
                  try {
                    var __ctrls = document.querySelectorAll('#controls_user_temp,#controls_user');
                    for (var __ci = 0; __ci < __ctrls.length; __ci++) {
                      var __ctrl = __ctrls[__ci];
                      if (!__ctrl) continue;
                      __ctrl.style.setProperty('position', 'fixed', 'important');
                      __ctrl.style.setProperty('left', '-9999px', 'important');
                      __ctrl.style.setProperty('top', '0', 'important');
                      __ctrl.style.setProperty('opacity', '0', 'important');
                      __ctrl.style.setProperty('pointer-events', 'none', 'important');
                      __ctrl.style.setProperty('z-index', '1', 'important');
                      __ctrl.style.setProperty('width', '1px', 'important');
                      __ctrl.style.setProperty('height', '1px', 'important');
                    }
                  } catch (_) {}

                  var __msGetPrintCheckbox = function() {
                    try {
                      return document.querySelector('#controls_user input[type="checkbox"],#controls_user_temp input[type="checkbox"],input#print,input#print_foto,input[type="checkbox"][name="print"]');
                    } catch (_) {
                      return null;
                    }
                  };

                  var __msSyncPreviewPrintButton = function() {
                    try {
                      var __stBtn = document.getElementById('ms-btn-stampa');
                      if (!__stBtn) return;

                      var __panelPrint = document.getElementById('ms-t-print');
                      var __panelEnabled = __panelPrint ? !!__panelPrint.checked : true;
                      var __cb = __msGetPrintCheckbox();
                      var __allowed = __panelEnabled;
                      if (__cb && __cb.disabled) __allowed = false;

                      var __checked = (__stBtn.getAttribute('data-checked') === '1');
                      if (__cb) __checked = !!__cb.checked;
                      if (!__allowed) __checked = false;

                      __stBtn.setAttribute('data-checked', __checked ? '1' : '0');
                      __stBtn.setAttribute('data-disabled', __allowed ? '0' : '1');
                      if (__allowed) {
                        __stBtn.removeAttribute('disabled');
                        __stBtn.removeAttribute('aria-disabled');
                      } else {
                        __stBtn.setAttribute('disabled', 'disabled');
                        __stBtn.setAttribute('aria-disabled', 'true');
                      }
                    } catch (_) {}
                  };

                  // Action bar moderna stile photobooth professionale (DENTRO foto_temp per condividere il sistema 1200x1920)
                  try {
                    if (!document.getElementById('ms-action-bar-css')) {
                      var __abCss = document.createElement('style');
                      __abCss.id = 'ms-action-bar-css';
                      __abCss.textContent =
                        // Hard-hide del vecchio checkbox "Stampa Foto" remoto
                        '#print,label#print,#print_foto,label[for=print_foto]{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;width:0!important;height:0!important;overflow:hidden!important;position:absolute!important;left:-99999px!important;}' +

                        // ── KEYFRAMES ──
                        // msPvBgIn: usato per il bg image (0 → 0.68 = valore CSS finale)
                        '@keyframes msPvBgIn{0%{opacity:0;}100%{opacity:0.68;}}' +
                        // msPvAtmoIn: fade semplice 0→1 per layer atmosferici
                        '@keyframes msPvAtmoIn{0%{opacity:0;}100%{opacity:1;}}' +
                        // Entrata card: rise morbido con scala leggera
                        '@keyframes msPvCardIn{0%{opacity:0;transform:translateY(22px) scale(0.972);}60%{opacity:1;}100%{opacity:1;transform:translateY(0) scale(1);}}' +
                        '@keyframes msPvCardInMirror{0%{opacity:0;transform:translateY(22px) scale(0.972) scaleX(-1);}60%{opacity:1;}100%{opacity:1;transform:translateY(0) scale(1) scaleX(-1);}}' +
                        // Float premium: respiro lentissimo con micro-rotazione (stampa fisica sospesa)
                        '@keyframes msPvFloat{0%,100%{transform:translateY(0) rotate(0deg);}38%{transform:translateY(-5px) rotate(-0.07deg);}62%{transform:translateY(-4px) rotate(-0.05deg);}}' +
                        // Headline fade-in
                        '@keyframes msPvHeadIn{0%{opacity:0;transform:translateY(9px);}100%{opacity:1;transform:translateY(0);}}' +
                        // Dock entrata
                        '@keyframes msPvDockIn{0%{opacity:0;transform:translate(-50%,26px) scale(0.972);}100%{opacity:1;transform:translate(-50%,0) scale(1);}}' +
                        // OK button respiro sottile
                        '@keyframes msPvOkBreathe{0%,100%{box-shadow:0 10px 30px rgba(24,165,90,0.34),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.18);}50%{box-shadow:0 12px 40px rgba(24,165,90,0.52),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.22);}}' +

                        // ── VARS GEOMETRICHE: card flottante CENTRATA nel viewport ──
                        // Aspect-ratio dello stage 1200x1920. Card centrata "al centro
                        // dell'area utile" (= sopra la dock+headline che galleggiano sotto).
                        // --ms-dock-block = altezza totale che la dock + headline occupano in basso.
                        // La card si centra in (100vh - dock-block) anziché 100vh → visualmente al
                        // centro dell'area visibile sopra i tasti.
                        '#foto_temp[data-ms-preview-host="1"]{' +
                          '--ms-dock-h:116px;' +
                          '--ms-dock-bottom:48px;' +
                          '--ms-headline-h:46px;' +
                          '--ms-dock-block:calc(var(--ms-dock-h) + var(--ms-dock-bottom) + var(--ms-headline-h) + 28px);' +
                          '--ms-card-margin-y:36px;' +
                          '--ms-card-margin-x:36px;' +
                          '--ms-card-h-from-vh:calc(100vh - var(--ms-dock-block) - var(--ms-card-margin-y) * 2);' +
                          '--ms-card-w-from-h:calc(var(--ms-card-h-from-vh) * 1024 / 1536);' +
                          '--ms-card-w-from-vw:calc(100vw - var(--ms-card-margin-x) * 2);' +
                          '--ms-card-w:min(var(--ms-card-w-from-h),var(--ms-card-w-from-vw));' +
                          '--ms-card-h:calc(var(--ms-card-w) * 1536 / 1024);' +
                          '--ms-photo-left:0.0767;' +
                          '--ms-photo-top:0.0615;' +
                          '--ms-photo-w:0.8466;' +
                          '--ms-photo-h:0.7812;' +
                        '}' +

                        // ── BACKDROP BLUR DELLA CAMERA LIVE (dietro #foto_temp) ──
                        // ft è trasparente → backdrop-filter sfoca quanto sta dietro
                        // (= la pagina remota con il video camera). Niente immagine bg sopra.
                        '#ms-preview-bg{position:absolute!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;' +
                          // l'<img> resta come fallback (caricata dal JS) ma viene
                          // visivamente nascosta a favore del backdrop-filter sul ::before del host
                          'opacity:0!important;visibility:hidden!important;display:none!important;' +
                          'pointer-events:none!important;z-index:0!important;}' +

                        // ── ::before — BACKDROP BLUR sulla camera live + cinematic dim ──
                        // backdrop-filter sfoca quanto sta DIETRO #foto_temp (= camera).
                        // Tinta dark sopra per evitare distrazioni e dare profondità.
                        '#foto_temp[data-ms-preview-host="1"]::before{' +
                          'content:"";position:absolute;inset:0;z-index:1;pointer-events:none;' +
                          'backdrop-filter:blur(48px) brightness(0.55) saturate(1.30);' +
                          '-webkit-backdrop-filter:blur(48px) brightness(0.55) saturate(1.30);' +
                          'background:' +
                            'linear-gradient(to top,rgba(0,0,0,0.62) 0%,rgba(0,0,0,0.18) 24%,rgba(0,0,0,0) 44%),' +
                            'linear-gradient(to bottom,rgba(0,0,0,0.42) 0%,rgba(0,0,0,0) 24%),' +
                            'radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 22%,rgba(0,0,0,0.20) 56%,rgba(0,0,0,0.50) 100%);' +
                          'animation:msPvAtmoIn 0.9s ease-out;}' +

                        // ── ::after — luce ambientale studio soft (quasi impercettibile) ──
                        // Simula il riflesso di una luce calda dietro la foto, come in uno studio fotografico.
                        // L'ellipse è centrata leggermente sopra il centro del viewport (dove sta la card).
                        '#foto_temp[data-ms-preview-host="1"]::after{' +
                          'content:"";position:absolute;inset:0;z-index:2;pointer-events:none;' +
                          'background:radial-gradient(ellipse 60% 50% at 50% 43%,rgba(255,250,248,0.032) 0%,rgba(200,178,240,0.014) 40%,transparent 68%);' +
                          'animation:msPvAtmoIn 1.4s ease-out;}' +

                        // ── FOTO PRINCIPALE (bbox dinamica in base alla trasparenza della cornice) ──
                        // Fallback: usa i default --ms-photo-* qui sopra se la cornice non è analizzabile.
                        // Compensazione verticale: card centrata nell'area sopra la dock
                        //   shift-y = -(dock-block / 2) per spostare la card su rispetto al viewport
                        '#ms-preview-main{position:absolute!important;' +
                          'top:50%!important;left:50%!important;' +
                          'width:calc(var(--ms-card-w) * var(--ms-photo-w))!important;' +
                          'height:calc(var(--ms-card-h) * var(--ms-photo-h))!important;' +
                          'margin-left:calc(var(--ms-card-w) * (var(--ms-photo-left) - 0.5))!important;' +
                          'margin-top:calc(var(--ms-card-h) * (var(--ms-photo-top) - 0.5) - var(--ms-dock-block) / 2)!important;' +
                          'object-fit:cover!important;object-position:center center!important;' +
                          'background:transparent!important;image-rendering:auto!important;' +
                          'pointer-events:none!important;z-index:3!important;' +
                          'display:block!important;visibility:visible!important;' +
                          'border-radius:4px!important;padding:0!important;border:0!important;' +
                          'animation:msPvCardInMirror 0.85s cubic-bezier(.22,1.12,.36,1) both!important;}' +

                        // ── CORNICE GRAFICA (stessa centratura, dimensione card piena) ──
                        '#ms-preview-frame-ov{position:absolute!important;' +
                          'top:50%!important;left:50%!important;' +
                          'width:var(--ms-card-w)!important;' +
                          'height:var(--ms-card-h)!important;' +
                          'margin-left:calc(var(--ms-card-w) / -2)!important;' +
                          'margin-top:calc(var(--ms-card-h) / -2 - var(--ms-dock-block) / 2)!important;' +
                          'object-fit:fill!important;' +
                          'pointer-events:none!important;z-index:5!important;' +
                          'display:block!important;visibility:visible!important;opacity:1!important;' +
                          'padding:0!important;border:0!important;' +
                          'filter:drop-shadow(0 52px 100px rgba(0,0,0,0.68)) drop-shadow(0 16px 32px rgba(0,0,0,0.60)) drop-shadow(0 3px 8px rgba(0,0,0,0.90))!important;' +
                          '-webkit-filter:drop-shadow(0 52px 100px rgba(0,0,0,0.68)) drop-shadow(0 16px 32px rgba(0,0,0,0.60))!important;' +
                          'animation:msPvCardIn 0.85s cubic-bezier(.22,1.12,.36,1) 0.05s both,msPvFloat 9s ease-in-out 1.6s infinite!important;}' +

                        // ── HEADLINE — SOPRA la dock (offset robusto > altezza dock) ──
                        '#ms-action-headline{position:absolute;left:0;right:0;' +
                          'bottom:calc(var(--ms-dock-h) + var(--ms-dock-bottom) + 26px);' +
                          'z-index:2147483646;text-align:center;pointer-events:none;}' +
                        '#ms-action-headline .ms-ah-pill{display:inline-block;padding:0;' +
                          'background:transparent;border:none;box-shadow:none;' +
                          'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
                          'color:rgba(255,255,255,0.72);' +
                          'font-size:24px;font-weight:200;letter-spacing:9px;text-transform:uppercase;' +
                          // dark shadow per leggibilità, sottilissimo warm glow quasi impercettibile
                          'text-shadow:0 2px 28px rgba(0,0,0,0.96),0 0 80px rgba(255,248,240,0.05);' +
                          'animation:msPvHeadIn 0.9s cubic-bezier(.22,1,.36,1) 0.38s both;}' +
                        '#ms-action-headline .ms-ah-pill::after{content:"";display:block;width:40px;height:1px;' +
                          'margin:11px auto 0;opacity:0.50;' +
                          'background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,0.48) 50%,transparent 100%);}' +

                        // ── FLOATING DOCK glassmorphism ──
                        '#ms-action-bar{position:absolute;bottom:var(--ms-dock-bottom);left:50%;transform:translateX(-50%);' +
                          'z-index:2147483645;display:flex;gap:14px;align-items:center;justify-content:center;' +
                          'padding:12px 14px;border-radius:140px;' +
                          // background leggermente più chiaro del bg per creare senso di profondità e separazione dall'area inferiore
                          'background:linear-gradient(180deg,rgba(22,22,28,0.48) 0%,rgba(14,14,18,0.54) 100%);' +
                          'backdrop-filter:blur(50px) saturate(160%) brightness(1.06);' +
                          '-webkit-backdrop-filter:blur(50px) saturate(160%) brightness(1.06);' +
                          'border:1px solid rgba(255,255,255,0.08);' +
                          'box-shadow:0 20px 56px rgba(0,0,0,0.58),0 4px 14px rgba(0,0,0,0.36),inset 0 1px 0 rgba(255,255,255,0.07);' +
                          'pointer-events:none;' +
                          'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
                          'animation:msPvDockIn 0.72s cubic-bezier(.22,1.12,.36,1) 0.18s both;}' +

                        // ── PULSANTI luxury minimal ──
                        '.ms-pb-btn{pointer-events:auto;position:relative;display:inline-flex;align-items:center;justify-content:center;gap:10px;' +
                          'padding:0 26px;height:88px;width:188px;min-width:188px;max-width:188px;border-radius:52px;border:none;box-sizing:border-box;' +
                          'cursor:pointer;font-size:20px;font-weight:500;letter-spacing:1.6px;' +
                          '-webkit-user-select:none;user-select:none;line-height:1;white-space:nowrap;' +
                          'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
                          'transition:transform 0.20s cubic-bezier(.22,1.2,.36,1),box-shadow 0.20s ease,background 0.20s ease,opacity 0.20s ease;' +
                          'overflow:hidden;}' +
                        '.ms-pb-btn:active{transform:scale(0.94)!important;opacity:0.82!important;}' +
                        '.ms-pb-btn svg{width:22px;height:22px;flex:0 0 auto;}' +
                        '.ms-pb-btn .ms-pb-lbl{position:relative;z-index:1;}' +

                        // Riprova — ghost puro: quasi invisibile, evita di distrarre dal CTA primario
                        '.ms-pb-cancel{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.78);' +
                          'border:1px solid rgba(255,255,255,0.15);' +
                          'box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);}' +
                        '.ms-pb-cancel:active{background:rgba(255,255,255,0.09)!important;}' +

                        // Stampa — frosted glass toggle
                        '.ms-pb-stampa{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.88);' +
                          'border:1px solid rgba(255,255,255,0.13);' +
                          'box-shadow:inset 0 1px 0 rgba(255,255,255,0.07);}' +
                        '.ms-pb-stampa[data-checked="1"]{background:linear-gradient(180deg,rgba(76,126,255,0.30) 0%,rgba(52,96,232,0.18) 100%);' +
                          'border:1px solid rgba(128,158,255,0.40);color:#fff;' +
                          'box-shadow:0 6px 24px rgba(55,105,255,0.28),inset 0 1px 0 rgba(255,255,255,0.14);}' +
                        '.ms-pb-stampa .ms-pb-check{position:absolute;top:12px;right:14px;width:11px;height:11px;border-radius:50%;' +
                          'background:rgba(255,255,255,0.16);border:1px solid rgba(255,255,255,0.30);transition:all 0.20s ease;}' +
                        '.ms-pb-stampa[data-checked="1"] .ms-pb-check{background:#fff;border-color:#fff;box-shadow:0 0 8px rgba(255,255,255,0.48);}' +
                        '.ms-pb-stampa[data-disabled="1"],.ms-pb-stampa:disabled{background:rgba(255,255,255,0.03)!important;color:rgba(255,255,255,0.42)!important;' +
                          'border:1px solid rgba(255,255,255,0.08)!important;box-shadow:none!important;opacity:0.56!important;cursor:not-allowed!important;pointer-events:none!important;}' +
                        '.ms-pb-stampa[data-disabled="1"] .ms-pb-check,.ms-pb-stampa:disabled .ms-pb-check{background:rgba(255,255,255,0.08)!important;' +
                          'border-color:rgba(255,255,255,0.16)!important;box-shadow:none!important;}' +

                        // Salva — matte green premium, glow soft e rispettoso
                        '.ms-pb-ok{background:linear-gradient(180deg,rgba(46,196,118,0.93) 0%,rgba(22,160,87,0.93) 100%);' +
                          'color:#fff;font-weight:600;' +
                          'border:1px solid rgba(255,255,255,0.17);' +
                          'box-shadow:0 10px 30px rgba(24,165,90,0.34),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.18);' +
                          'animation:msPvOkBreathe 4.2s ease-in-out infinite;}' +
                        '.ms-pb-ok:active{animation:none!important;box-shadow:0 5px 16px rgba(24,165,90,0.36)!important;}' +

                        // ── BACK BUTTON "Torna al pannello" — top-left glass pill (fixed, sempre visibile) ──
                        '#ms-pb-back{position:fixed!important;top:32px;left:32px;z-index:2147483647;' +
                          'pointer-events:auto;display:inline-flex;align-items:center;gap:10px;' +
                          'padding:0 22px;height:60px;border-radius:34px;border:1px solid rgba(255,255,255,0.13);' +
                          'background:linear-gradient(180deg,rgba(22,22,28,0.50) 0%,rgba(14,14,18,0.58) 100%);' +
                          'backdrop-filter:blur(38px) saturate(160%) brightness(1.04);' +
                          '-webkit-backdrop-filter:blur(38px) saturate(160%) brightness(1.04);' +
                          'box-shadow:0 12px 30px rgba(0,0,0,0.50),0 3px 8px rgba(0,0,0,0.32),inset 0 1px 0 rgba(255,255,255,0.07);' +
                          'color:rgba(255,255,255,0.86);' +
                          'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
                          'font-size:16px;font-weight:500;letter-spacing:1.2px;text-transform:uppercase;' +
                          'cursor:pointer;-webkit-user-select:none;user-select:none;line-height:1;white-space:nowrap;' +
                          'transition:transform 0.20s cubic-bezier(.22,1.2,.36,1),background 0.20s ease,opacity 0.20s ease;' +
                          'animation:msPvHeadIn 0.7s cubic-bezier(.22,1,.36,1) 0.45s both;}' +
                        '#ms-pb-back svg{width:18px;height:18px;flex:0 0 auto;}' +
                        '#ms-pb-back:active{transform:scale(0.94);background:linear-gradient(180deg,rgba(34,34,40,0.62) 0%,rgba(22,22,28,0.68) 100%);}';
                      (document.head || document.documentElement).appendChild(__abCss);
                    }
                    // Headline sopra i pulsanti
                    var __hd = document.getElementById('ms-action-headline');
                    if (!__hd) {
                      __hd = document.createElement('div');
                      __hd.id = 'ms-action-headline';
                      __hd.innerHTML = '<span class="ms-ah-pill">Cosa vuoi fare con questa foto?</span>';
                      ft.appendChild(__hd);
                    } else if (__hd.children.length === 0 || !__hd.querySelector('.ms-ah-pill')) {
                      __hd.innerHTML = '<span class="ms-ah-pill">Cosa vuoi fare con questa foto?</span>';
                    }
                    // "Torna al pannello" — gestito dalla funzione globale __msEnsureBackBtn (vedi sync())
                    // Chiamata duplicata rimossa: sync() la invoca gi\u00e0 ogni 250ms con isSession().
                    // Floating X close: RIMOSSO per UX premium (la pillola "Riprova"
                    // già copre la funzione di dismiss). Se presente, la rimuoviamo.
                    try {
                      var __oldCl = document.getElementById('ms-pb-close');
                      if (__oldCl && __oldCl.parentNode) __oldCl.parentNode.removeChild(__oldCl);
                    } catch (_) {}
                    var __ab = document.getElementById('ms-action-bar');
                    if (!__ab) {
                      __ab = document.createElement('div');
                      __ab.id = 'ms-action-bar';
                      var __svgX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
                      var __svgOk = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
                      var __svgPr = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
                      __ab.innerHTML =
                        '<button id="ms-btn-cancel" class="ms-pb-btn ms-pb-cancel">' + __svgX + '<span class="ms-pb-lbl">Riprova</span></button>' +
                        '<button id="ms-btn-stampa" class="ms-pb-btn ms-pb-stampa" data-checked="1"><span class="ms-pb-check"></span>' + __svgPr + '<span class="ms-pb-lbl">Stampa</span></button>' +
                        '<button id="ms-btn-ok" class="ms-pb-btn ms-pb-ok">' + __svgOk + '<span class="ms-pb-lbl">Salva</span></button>';
                      ft.appendChild(__ab);
                      __msSyncPreviewPrintButton();
                      // Helper: rimuove tutti gli stili !important che abbiamo imposto,
                      // così la pagina remota può ripristinare liberamente foto_temp e i controlli.
                      function __msCleanupPreviewStyles() {
                        try {
                          var __props = ['display','position','inset','top','left','right','bottom','width','height','background','overflow','visibility','opacity','z-index','pointer-events'];
                          var __ft = document.getElementById('foto_temp');
                          if (__ft) {
                            __props.forEach(function(p) { try { __ft.style.removeProperty(p); } catch (_) {} });
                            ['--ms-photo-left','--ms-photo-top','--ms-photo-w','--ms-photo-h'].forEach(function(p) {
                              try { __ft.style.removeProperty(p); } catch (_) {}
                            });
                            try { __ft.__msPreviewRectSrc = ''; } catch (_) {}
                            try { __ft.removeAttribute('data-ms-preview-host'); } catch (_) {}
                            // Forza display:none così isReviewVisible() ritorna false IMMEDIATAMENTE
                            // (la cornice riapparirà al prossimo tick di sync senza attendere
                            // che la pagina remota nasconda il modale).
                            __ft.style.display = 'none';
                          }
                          var __ctrlProps = ['position','left','top','opacity','pointer-events','z-index','width','height'];
                          var __ctrlEls = document.querySelectorAll('#controls_user_temp,#controls_user');
                          for (var __ri = 0; __ri < __ctrlEls.length; __ri++) {
                            __ctrlProps.forEach(function(p) { try { __ctrlEls[__ri].style.removeProperty(p); } catch (_) {} });
                          }
                          // Rimuovi sotto-elementi creati per l'anteprima
                          // NB: ms-pb-back NON va rimosso: deve restare visibile anche nel live (pre-scatto)
                          var __ovIds = ['ms-preview-bg','ms-preview-main','ms-preview-frame-ov','ms-preview-bar','ms-preview-vignette','ms-action-bar','ms-action-headline','ms-pb-close'];
                          __ovIds.forEach(function(id) {
                            var n = document.getElementById(id);
                            if (n && n.parentNode) n.parentNode.removeChild(n);
                          });
                          // Reset flag e forza sync immediato per riapparire la cornice ora
                          window.__msHideOverlayUntil = 0;
                          window.__msPreviewActive = false;
                          window.__msFrameOnLogged = false;
                          if (document.body) document.body.removeAttribute('data-ms-preview');
                          try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {}
                        } catch (_) {}
                      }
                      // Riprova → dispatch click su cursor_cancel
                      document.getElementById('ms-btn-cancel').addEventListener('click', function() {
                        try {
                          __msCleanupPreviewStyles();
                          var __ci = document.querySelector('img[src*="cursor_cancel"]');
                          if (__ci) __ci.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                        } catch (_) {}
                      });
                      // Close X (in alto a destra) → stesso flusso di Riprova
                      try {
                        var __clBtn = document.getElementById('ms-pb-close');
                        if (__clBtn) {
                          __clBtn.addEventListener('click', function() {
                            try {
                              __msCleanupPreviewStyles();
                              var __ci2 = document.querySelector('img[src*="cursor_cancel"]');
                              if (__ci2) __ci2.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                            } catch (_) {}
                          });
                        }
                      } catch (_) {}
                      // Stampa → toggle checkbox
                      document.getElementById('ms-btn-stampa').addEventListener('click', function() {
                        try {
                          if (this.disabled || this.getAttribute('data-disabled') === '1') return;
                          var __cb = __msGetPrintCheckbox();
                          if (__cb && !__cb.disabled) __cb.click();
                          __msSyncPreviewPrintButton();
                        } catch (_) {}
                      });
                      // Salva → dispatch click su cursor_ok
                      document.getElementById('ms-btn-ok').addEventListener('click', function() {
                        try {
                          __msCleanupPreviewStyles();
                          var __lp = '';
                          var __ln = '';
                          try {
                            __lp = String(localStorage.getItem('last_picture_url') || '').trim();
                            __ln = String(localStorage.getItem('last_picture_name') || '').trim();
                          } catch (_) {}

                          var __evtRaw = 'evento_senza_nome';
                          try {
                            var __es = document.getElementById('ms-evt-sel');
                            if (__es && __es.selectedIndex >= 0 && __es.options && __es.options[__es.selectedIndex]) {
                              __evtRaw = String(__es.options[__es.selectedIndex].textContent || '').trim() || __evtRaw;
                            }
                          } catch (_) {}

                          if (!__ln || __ln.indexOf('§') < 0) {
                            var __evtSafe = __evtRaw
                              .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
                              .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                              .replace(/\s+/g, '_')
                              .replace(/[. ]+$/g, '')
                              .replace(/_+/g, '_')
                              .trim() || 'evento_senza_nome';
                            __ln = __evtSafe + '§' + (new Date().toISOString().slice(0, 19).replace(/:/g, '-')) + '.jpg';
                          }

                          var __savedViaIpc = false;
                          if (__lp && window.electronAPI && typeof window.electronAPI.saveCapturedPhoto === 'function') {
                            try {
                              window.electronAPI.saveCapturedPhoto({
                                dataUrl: __lp,
                                fileName: __ln,
                                eventName: __evtRaw
                              }).then(function(res) {
                                try {
                                  if (res && res.success) {
                                    console.log('[ms] saveCapturedPhoto OK path=' + (res.path || ''));
                                  } else {
                                    console.log('[ms] saveCapturedPhoto FAIL', res && res.message ? res.message : 'unknown');
                                  }
                                } catch (_) {}
                              }).catch(function() {});
                              __savedViaIpc = true;
                            } catch (_) {}
                          }

                          if (!__savedViaIpc) {
                            var __nativeTriggered = false;
                            var __oi = document.querySelector('img[src*="cursor_ok"],img[src*="cursor%5Fok"],#cursor_ok');
                            if (__oi) {
                              try {
                                if (typeof __oi.click === 'function') __oi.click();
                                else __oi.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                                __nativeTriggered = true;
                              } catch (_) {}
                            }

                            if (!__nativeTriggered && __lp) {
                              var __a = document.createElement('a');
                              __a.style.display = 'none';
                              __a.href = __lp;
                              __a.download = __ln;
                              (document.body || document.documentElement).appendChild(__a);
                              __a.click();
                              if (__a.parentNode) __a.parentNode.removeChild(__a);
                            }
                          }
                        } catch (_) {}
                      });
                    }
                    __msSyncPreviewPrintButton();
                  } catch (_) {}

                  var wiredImg = ft.querySelector(':scope > img#ms-preview-main') || img;
                  if (!wiredImg.__msPreviewWired) {
                    wiredImg.__msPreviewWired = true;
                    try {
                      wiredImg.addEventListener('load', function() {
                        try { console.log('[ms] preview img load ok nw=' + wiredImg.naturalWidth + ' nh=' + wiredImg.naturalHeight); } catch (_) {}
                      });
                      wiredImg.addEventListener('error', function() {
                        try { console.log('[ms] preview img load ERROR src=' + String(wiredImg.currentSrc || wiredImg.src || '').slice(0, 120)); } catch (_) {}
                        try {
                          var fb = window.__msPreviewFallbackUrl || '';
                          if (fb && wiredImg.src !== fb) {
                            wiredImg.src = fb;
                            console.log('[ms] preview img switched to fallback frame');
                          }
                        } catch (_) {}
                      });
                    } catch (_) {}
                  }

                  var cur = String(wiredImg.src || '');
                  var bad = !cur || /cursor_(cancel|ok)\.png/i.test(cur);
                  var prefer = previewSrc;
                  if (prefer && !/cursor_(cancel|ok)\.png/i.test(prefer)) {
                    if (cur !== prefer) {
                      try { wiredImg.src = prefer; } catch (_) {}
                    }
                  } else if (bad) {
                    var fb2 = String(window.__msPreviewFallbackUrl || '').trim();
                    if (fb2 && cur !== fb2) {
                      try {
                        wiredImg.src = fb2;
                        console.log('[ms] preview img seeded from fallback frame');
                      } catch (_) {}
                    }
                  }

                  return !!(wiredImg.complete && wiredImg.naturalWidth > 16 && wiredImg.naturalHeight > 16);
                }

                // Watchdog: se entro 6s la pagina non mostra #foto_temp,
                // tentiamo noi a mostrarlo usando last_picture_url da localStorage.
                // IMPORTANTE: una volta mostrata l'anteprima, se la pagina la
                // rimuove (utente ha premuto X o OK) NON dobbiamo riforzarla,
                // altrimenti loop infinito su scarta/salva.
                var __tries = 0;
                var __wasShown = false;
                window.__msPreviewActive = true;
                var __wd = setInterval(function() {
                  __tries++;
                  try {
                    if (window.__msPreviewDismissed) {
                      clearInterval(__wd);
                      window.__msPreviewActive = false;
                      return;
                    }
                    var ft = document.getElementById('foto_temp');
                    var lp = '';
                    try { lp = localStorage.getItem('last_picture_url') || ''; } catch (_) {}
                    if (!ft) {
                      if (__wasShown) {
                        clearInterval(__wd);
                        window.__msPreviewActive = false;
                        console.log('[ms] watchdog stop: foto_temp removed after preview');
                        return;
                      }
                      console.log('[ms] watchdog t=' + __tries + ' foto_temp NOT FOUND lp=' + (lp ? 'yes' : 'no'));
                    } else {
                      var cs = getComputedStyle(ft);
                      var rect = ft.getBoundingClientRect();
                      if (__wasShown && cs.display === 'none') {
                        clearInterval(__wd);
                        window.__msPreviewActive = false;
                        try { if (document.body) document.body.removeAttribute('data-ms-preview'); } catch (_) {}
                        var fov0 = ft.querySelector(':scope > img#ms-preview-frame-ov');
                        if (fov0 && fov0.parentNode) fov0.parentNode.removeChild(fov0);
                        console.log('[ms] watchdog stop: preview dismissed by user');
                        return;
                      }
                      console.log('[ms] watchdog t=' + __tries + ' foto_temp display=' + cs.display + ' lp=' + (lp ? 'yes' : 'no'));
                      var __ok = __msEnsurePreview(ft, lp || window.__msPreviewFallbackUrl || '');
                      if (__ok && cs.display !== 'none' && rect.width > 0) {
                        __wasShown = true;
                        clearInterval(__wd);
                        window.__msPreviewActive = false;
                        console.log('[ms] watchdog stop: preview stabilized');
                        return;
                      }
                      // Tenta foto_temp_show ufficiale
                      if ((cs.display === 'none' || rect.width <= 0 || rect.height <= 0) && typeof window.foto_temp_show === 'function' && __tries <= 12) {
                        try { window.foto_temp_show(); console.log('[ms] watchdog called foto_temp_show()'); } catch (e) {}
                      }
                      if (__tries >= 16 && cs.display !== 'none' && rect.width > 0 && rect.height > 0) {
                        clearInterval(__wd);
                        window.__msPreviewActive = false;
                        console.log('[ms] watchdog stop: preview visible without further forcing');
                      }
                    }
                  } catch (_) {}
                  if (__tries >= 60) { clearInterval(__wd); window.__msPreviewActive = false; }
                }, 250);
              }

              // Se l'utente clicca su uno dei controlli di review (X / OK /
              // checkbox Stampa Foto) consideriamo l'anteprima conclusa: il
              // watchdog deve smettere di forzarla, altrimenti loop.
              try {
                var __ctrlAncestor = node && node.closest ? node.closest('#controls_user_temp,#controls_user,#foto_temp') : null;
                if (__ctrlAncestor) {
                  // Solo per click su X / OK (img cursor_*) o su input checkbox.
                  var __isCancel = false, __isOk = false, __isCheck = false;
                  try {
                    var __img = node && node.tagName === 'IMG' ? node : (node && node.querySelector ? node.querySelector('img') : null);
                    var __src = __img ? String(__img.src || '') : '';
                    __isCancel = /cursor_cancel\.png/i.test(__src);
                    __isOk = /cursor_ok\.png/i.test(__src);
                  } catch (_) {}
                  try { __isCheck = node && node.tagName === 'INPUT' && (node.type === 'checkbox'); } catch (_) {}
                  if (__isCancel || __isOk) {
                    window.__msPreviewDismissed = true;
                    window.__msPreviewActive = false;
                    window.__msHideOverlayUntil = 0;
                    try { if (document.body) document.body.removeAttribute('data-ms-preview'); } catch (_) {}
                    console.log('[ms] preview dismissed by user click (' + (__isCancel ? 'cancel' : 'ok') + ')');
                    // Forza il re-render immediato della cornice (più tentativi ravvicinati)
                    try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {}
                    [50, 150, 350, 700, 1200].forEach(function(__d) {
                      setTimeout(function() { try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {} }, __d);
                    });
                    setTimeout(function() { try { window.__msPreviewDismissed = false; } catch (_) {} }, 5000);
                  }
                }
              } catch (_) {}

              // Rilevamento dismiss da pulsanti action bar moderna
              try {
                if (el && (el.id === 'ms-btn-cancel' || el.id === 'ms-btn-ok' || el.id === 'ms-pb-close')) {
                  window.__msPreviewDismissed = true;
                  window.__msPreviewActive = false;
                  window.__msHideOverlayUntil = 0;
                  try { if (document.body) document.body.removeAttribute('data-ms-preview'); } catch (_) {}
                  console.log('[ms] preview dismissed via action-bar (' + el.id + ')');
                  try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {}
                  [50, 150, 350, 700, 1200].forEach(function(__d) {
                    setTimeout(function() { try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {} }, __d);
                  });
                  setTimeout(function() { try { window.__msPreviewDismissed = false; } catch (_) {} }, 5000);
                }
              } catch (_) {}

              // Quando l'utente preme il vero pulsante scatto, arma una serie
              // di dump per individuare il modal di anteprima.
              if (el.id === 'captureBtn' || /scatta|capture/i.test(txt)) {
                [600, 1200, 2000, 3000, 5000, 8000].forEach(function(t) {
                  setTimeout(function() {
                    try {
                      console.log('[ms] CAPTURE DUMP @' + t + 'ms ---');
                      if (typeof window.__msDumpDom === 'function') window.__msDumpDom();
                      var ft = document.getElementById('foto_temp');
                      if (ft) {
                        var cs = getComputedStyle(ft);
                        var r = ft.getBoundingClientRect();
                        console.log('[ms] foto_temp display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ' z=' + cs.zIndex + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height));
                        var imgs = ft.getElementsByTagName('img');
                        for (var k = 0; k < imgs.length; k++) {
                          console.log('[ms] foto_temp img[' + k + '] src=' + String(imgs[k].src || '').slice(0, 100));
                        }
                      } else {
                        console.log('[ms] foto_temp NOT FOUND');
                      }
                    } catch (_) {}
                  }, t);
                });
              }
            } catch (_) {}
          }, true);
        } catch (_) {}

        try {
          var obs = new MutationObserver(function(list) {
            try {
              var vw = window.innerWidth || 1;
              var vh = window.innerHeight || 1;
              var logged = 0;
              for (var i = 0; i < list.length; i++) {
                var m = list[i];
                if (!m) continue;
                var nodes = [];
                if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
                  for (var a = 0; a < m.addedNodes.length; a++) nodes.push(m.addedNodes[a]);
                }
                if (m.type === 'attributes' && m.target) {
                  nodes.push(m.target);
                }
                for (var n = 0; n < nodes.length; n++) {
                  var el = nodes[n];
                  if (!el || el.nodeType !== 1) continue;
                  if (el.id === 'ms-session-frame-ov-lite' || el.id === 'ms-session-fs-btn-lite') continue;
                  var cs = getComputedStyle(el);
                  if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
                  var r = el.getBoundingClientRect();
                  var big = (r.width / vw >= 0.25 && r.height / vh >= 0.25);
                  var z = parseInt(cs.zIndex, 10);
                  var name = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
                  var interesting = big || (z && z >= 100) || /foto|preview|snap|shot|temp|modal|popup|overlay|dialog|user|control/.test(name);
                  if (!interesting) continue;
                  var tag = el.tagName + (el.id ? '#' + el.id : '');
                  console.log('[ms] mut ' + m.type + ' ' + tag + ' pos=' + cs.position + ' z=' + cs.zIndex + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height));
                  logged++;
                  if (logged >= 8) return;
                }
              }
            } catch (_) {}
          });
          obs.observe(document.documentElement || document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'src', 'hidden']
          });
        } catch (_) {}
      }

      window._msSessionFrameLiteSync = sync;
      try { console.log('[ms] session-lite init path=' + (window.location && window.location.pathname) + ' isSession=' + isSession() + ' src=' + (getSource() ? 'yes' : 'no')); } catch (_) {}

      // Hook diagnostico: quando la pagina remota avvia il countdown,
      // pianifica dei dump del DOM per capire il vero modal di anteprima.
      function armDumpAfterShot(reason) {
        try { console.log('[ms] arm dump reason=' + reason); } catch (_) {}
        [1500, 3000, 5000, 7500, 10000, 14000].forEach(function(t) {
          setTimeout(function() {
            try {
              console.log('[ms] DUMP @' + t + 'ms ---');
              if (typeof window.__msDumpDom === 'function') window.__msDumpDom();
            } catch (_) {}
          }, t);
        });
      }
      function tryWrapShot() {
        try {
          var orig = window.count_down_start;
          if (typeof orig === 'function' && !orig.__msDumpWrapped) {
            var wrapped = function() {
              armDumpAfterShot('count_down_start');
              // NOTA: NON lanciamo qui l'overlay countdown — lo gestisce direttamente
              // il click handler di #ms-lv-shoot (che chiama __msShowCountdown con callback
              // verso captureBtn). count_down_start della pagina remota in sessione
              // scatta immediatamente perché il select non è caricato.
              return orig.apply(this, arguments);
            };
            wrapped.__msDumpWrapped = true;
            window.count_down_start = wrapped;
            console.log('[ms] count_down_start wrapped for dump+countdown');
            return true;
          }
        } catch (_) {}
        return false;
      }
      // Tenta lo wrap subito e poi a intervalli, perch\u00e9 lo script remoto
      // potrebbe definire count_down_start dopo il nostro init.
      tryWrapShot();
      var __wrapTries = 0;
      var __wrapTimer = setInterval(function() {
        __wrapTries++;
        if (tryWrapShot() || __wrapTries > 60) clearInterval(__wrapTimer);
      }, 250);
      armAutoPreviewDiagnostics();
      sync();
      // Burst di re-sync nei primi secondi per battere la pagina remota che potrebbe rimpiazzare il body
      [50, 150, 300, 500, 800, 1200, 1800, 2500, 3500].forEach(function(t) { setTimeout(sync, t); });
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', function() { sync(); setTimeout(sync, 80); }, { once: true });
      }
      try { window.addEventListener('load', function() { sync(); setTimeout(sync, 100); }); } catch (_) {}
      setInterval(sync, 250);
      try {
        new MutationObserver(function() { sync(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ms-session'] });
      } catch (e) {}
      // Reagisce immediatamente quando il sito remoto entra/esce dall'HTML
      // fullscreen (es. requestFullscreen sul <video>): in quel caso il bottone
      // deve essere ricollocato dentro l'elemento in fullscreen, altrimenti
      // diventa invisibile.
      try {
        document.addEventListener('fullscreenchange', function() { sync(); setTimeout(sync, 30); setTimeout(sync, 200); });
        document.addEventListener('webkitfullscreenchange', function() { sync(); setTimeout(sync, 30); setTimeout(sync, 200); });
      } catch (e) {}
    } catch (e) {
      try { console.warn('[ms] session frame lite error:', e); } catch (_) {}
    }
  })();`;

  execute(script).catch((err) => {
    console.warn('[ms] injectSessionFrameOverlay failed:', err && err.message ? err.message : err);
  });
}

function blockContentFullscreen(win) {
  const script = `(() => {
    if (window.__msFullscreenBlocked) {
      return;
    }

    window.__msFullscreenBlocked = true;
    const deny = () => Promise.resolve();

    const proto = Element.prototype;
    if (proto.requestFullscreen) proto.requestFullscreen = deny;
    if (proto.webkitRequestFullscreen) proto.webkitRequestFullscreen = deny;
    if (proto.mozRequestFullScreen) proto.mozRequestFullScreen = deny;
    if (proto.msRequestFullscreen) proto.msRequestFullscreen = deny;

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    });
  })();`;

  win.webContents.executeJavaScript(script).catch(() => {});
}

function injectRemoteUiRedesign(win, targetFrame) {
  const execute = (code) => {
    if (targetFrame && typeof targetFrame.executeJavaScript === 'function') {
      return targetFrame.executeJavaScript(code);
    }
    return win.webContents.executeJavaScript(code);
  };

  const script = `(() => { try {
    // Check triplo: flag + DOM element + data attribute
    if (window.__msSballandoPremiumV1) return;
    if (document.getElementById('ms-app')) return;
    if (document.documentElement.getAttribute('data-ms-premium')) return;
    
    window.__msSballandoPremiumV1 = true;
    document.documentElement.setAttribute('data-ms-premium', 'true');

    var _msSessionPersistedAtBoot = ${msSessionModeActive};
    if (_msSessionPersistedAtBoot) document.documentElement.setAttribute('data-ms-session', '1');

    // â”€â”€ FONT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!document.getElementById('ms-if')) {
      var lnk = document.createElement('link');
      lnk.id = 'ms-if'; lnk.rel = 'stylesheet';
      lnk.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap';
      document.head.appendChild(lnk);
    }

    // â”€â”€ CSS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var __s = document.getElementById('ms-pcs');
    if (!__s) { __s = document.createElement('style'); __s.id = 'ms-pcs'; document.head.appendChild(__s); }
    __s.textContent = \`
      *, *::before, *::after { box-sizing: border-box; }
      body { overflow: hidden !important; margin: 0 !important; }
      #ms-app {
        position: fixed; inset: 0;
        background: #0a0a0f;
        display: flex; flex-direction: column;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        color: #f8f9fa; z-index: 2147480000; overflow: hidden; user-select: none;
        transition: none;
      }
      html[data-ms-session="1"] #ms-app { display: none !important; pointer-events: none !important; z-index: -1 !important; }
      #ms-app.ms-app-out { opacity: 0 !important; pointer-events: none !important; }
      #ms-topbar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 24px; height: 56px; flex-shrink: 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: rgba(10,10,15,0.95);
        backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      }
      .ms-logo { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #fff; }
      .ms-logo em { color: #E63946; font-style: normal; }
      .ms-status { display: flex; align-items: center; gap: 20px; }
      .ms-si { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.4); transition: color 0.25s; }
      .ms-si.active { color: rgba(255,255,255,0.85); }
      .ms-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.15); flex-shrink: 0; transition: background 0.3s, box-shadow 0.3s; }
      .ms-dot.online  { background: #22c55e; box-shadow: 0 0 7px rgba(34,197,94,0.6); }
      .ms-dot.offline { background: #ef4444; }
      .ms-dot.warning { background: #f59e0b; }
      #ms-preview-wrap { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 14px 20px 8px; }
      #ms-preview-inner { position: relative; aspect-ratio: 2/3; height: 100%; max-height: 100%; max-width: 100%; border-radius: 20px; overflow: hidden; background: #000; box-shadow: 0 20px 70px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.07); }
      #ms-cam-video { width: 100%; height: 100%; object-fit: cover; display: block; transform: scaleX(-1); -webkit-transform: scaleX(-1); }
      #ms-selphy-badge { position: absolute; bottom: 52px; left: 14px; z-index: 5; background: rgba(230,57,70,0.85); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.25); border-radius: 8px; padding: 6px 12px; font-size: 11px; font-weight: 700; color: #fff; letter-spacing: 0.07em; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.5); box-shadow: 0 2px 10px rgba(230,57,70,0.4); }
      #ms-safe-area { position: absolute; inset: 3.5%; z-index: 4; pointer-events: none; border: 2px dashed rgba(255,255,255,0.7); border-radius: 4px; box-shadow: 0 0 0 9999px rgba(0,0,0,0.35); }
      #ms-safe-area::before, #ms-safe-area::after { content: ''; position: absolute; width: 20px; height: 20px; border-color: #fff; border-style: solid; }
      #ms-safe-area::before { top: -2px; left: -2px; border-width: 3px 0 0 3px; border-radius: 3px 0 0 0; }
      #ms-safe-area::after { bottom: -2px; right: -2px; border-width: 0 3px 3px 0; border-radius: 0 0 3px 0; }
      #ms-safe-area-br { position: absolute; bottom: -2px; left: -2px; width: 20px; height: 20px; border: 3px solid #fff; border-width: 0 0 3px 3px; border-radius: 0 0 0 3px; z-index: 4; pointer-events: none; }
      #ms-safe-area-tr { position: absolute; top: -2px; right: -2px; width: 20px; height: 20px; border: 3px solid #fff; border-width: 3px 3px 0 0; border-radius: 0 3px 0 0; z-index: 4; pointer-events: none; }
      #ms-safe-label { position: absolute; top: calc(3.5% + 8px); left: 50%; transform: translateX(-50%); z-index: 5; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; color: rgba(255,255,255,0.75); text-transform: uppercase; pointer-events: none; white-space: nowrap; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
      #ms-frame-ov { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; z-index: 2; pointer-events: none; display: none; }
      #ms-preview-grad { position: absolute; bottom: 0; left: 0; right: 0; height: 90px; background: linear-gradient(transparent, rgba(0,0,0,0.55)); z-index: 3; pointer-events: none; }
      #ms-start-btn {
        position: absolute; top: 14px; right: 14px; z-index: 10;
        background: #E63946; color: #fff; border: none; border-radius: 12px;
        padding: 11px 22px; font-size: 14px; font-weight: 600; letter-spacing: 0.04em;
        cursor: pointer; display: flex; align-items: center; gap: 8px;
        box-shadow: 0 4px 20px rgba(230,57,70,0.45);
        transition: background 0.2s, transform 0.15s, box-shadow 0.2s; font-family: inherit;
      }
      #ms-start-btn:hover { background: #c62828; transform: scale(1.04); box-shadow: 0 6px 28px rgba(230,57,70,0.6); }
      #ms-start-btn:active { transform: scale(0.97); }
      #ms-panel {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
        padding: 8px 20px 18px; flex-shrink: 0; overflow-y: auto; max-height: 42%;
      }
      #ms-panel::-webkit-scrollbar { width: 4px; }
      #ms-panel::-webkit-scrollbar-track { background: transparent; }
      #ms-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
      .ms-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 14px 16px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: border-color 0.2s; }
      .ms-card:hover { border-color: rgba(255,255,255,0.14); }
      .ms-card-full { grid-column: 1 / -1; }
      .ms-ct { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: rgba(255,255,255,0.35); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
      .ms-sel {
        width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
        color: #f8f9fa; font-size: 13px; font-weight: 500; padding: 9px 32px 9px 12px;
        cursor: pointer; outline: none; appearance: none; -webkit-appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 10px center;
        transition: border-color 0.2s, background-color 0.2s; font-family: inherit;
      }
      .ms-sel:hover { border-color: rgba(255,255,255,0.25); background-color: rgba(255,255,255,0.1); }
      .ms-sel:focus { border-color: #E63946; outline: none; }
      .ms-sel option { background: #1a1a2e; color: #f8f9fa; }
      .ms-tr { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
      .ms-tr:last-child { border-bottom: none; padding-bottom: 0; }
      .ms-tr:first-of-type { padding-top: 0; }
      .ms-tl { font-size: 14px; font-weight: 500; color: rgba(255,255,255,0.85); }
      .ms-tog { position: relative; width: 44px; height: 24px; cursor: pointer; display: inline-block; flex-shrink: 0; }
      .ms-tog input { position: absolute; opacity: 0; width: 0; height: 0; }
      .ms-slider { position: absolute; inset: 0; background: rgba(255,255,255,0.15); border-radius: 12px; transition: background 0.25s; }
      .ms-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform 0.25s; box-shadow: 0 1px 4px rgba(0,0,0,0.35); }
      .ms-tog input:checked + .ms-slider { background: #E63946; }
      .ms-tog input:checked + .ms-slider::before { transform: translateX(20px); }
      .ms-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
      .ms-field:last-child { margin-bottom: 0; }
      .ms-fl { font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.07em; }
      #ms-frames-grid { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; align-items: flex-start; }
      .ms-fi { position: relative; width: 48px; height: 72px; border-radius: 8px; overflow: hidden; border: 2px solid rgba(255,255,255,0.1); cursor: pointer; flex-shrink: 0; transition: border-color 0.2s, transform 0.2s; }
      .ms-fi:hover { transform: scale(1.06); border-color: rgba(255,255,255,0.3); }
      .ms-fi.sel { border-color: #E63946; box-shadow: 0 0 14px rgba(230,57,70,0.45); }
      .ms-fi-del { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; background: #E63946; border: none; border-radius: 50%; color: #fff; font-size: 13px; line-height: 1; cursor: pointer; display: none; align-items: center; justify-content: center; z-index: 2; padding: 0; font-family: inherit; }
      .ms-fi:hover .ms-fi-del { display: flex; }
      #ms-add-frame-lbl { background: transparent; border: 2px dashed rgba(255,255,255,0.2); border-radius: 10px; color: rgba(255,255,255,0.4); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; cursor: pointer; padding: 4px 12px; height: 30px; display: flex; align-items: center; gap: 4px; transition: border-color 0.2s, color 0.2s; font-family: inherit; user-select: none; }
      #ms-add-frame-lbl:hover { border-color: rgba(255,255,255,0.45); color: rgba(255,255,255,0.7); }
      .ms-path-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
      .ms-path-display { flex: 1; min-width: 0; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; color: rgba(255,255,255,0.75); font-size: 12px; padding: 8px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; }
      #ms-btn-choose-folder { background: rgba(230,57,70,0.18); border: 1px solid rgba(230,57,70,0.4); border-radius: 10px; color: #E63946; font-size: 12px; font-weight: 600; padding: 8px 14px; cursor: pointer; white-space: nowrap; transition: background 0.2s, border-color 0.2s; font-family: inherit; flex-shrink: 0; }
      #ms-btn-choose-folder:hover { background: rgba(230,57,70,0.3); border-color: rgba(230,57,70,0.7); }
      #ms-session-blocker { position: fixed; inset: 0; z-index: 99990; background: transparent; display: none; cursor: default; pointer-events: none; }
      #ms-nav-mask { position: fixed; inset: 0; z-index: 2147483001; background: #000; display: none; opacity: 0; pointer-events: none; }
      html[data-ms-session="1"] #ms-session-blocker { display: none !important; pointer-events: none !important; }
      html[data-ms-nav="1"] #ms-nav-mask { display: none; opacity: 0; }
      #ms-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #E63946; color: #fff; font-size: 13px; font-weight: 600; padding: 12px 20px; border-radius: 10px; z-index: 9999999; pointer-events: none; opacity: 0; transition: opacity 0.25s; white-space: nowrap; font-family: inherit; max-width: 90vw; text-align: center; word-break: break-word; white-space: normal; }
      #ms-toast.show { opacity: 1; }
    \`;

    // â”€â”€ HTML OVERLAY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!document.getElementById('ms-app')) {
      var appDiv = document.createElement('div');
      appDiv.id = 'ms-app';
      appDiv.innerHTML =
        '<div id="ms-topbar">' +
          '<div class="ms-logo">s<em>b</em>allando</div>' +
          '<div class="ms-status">' +
            '<div class="ms-si" id="ms-si-cam"><span class="ms-dot" id="ms-d-cam"></span><span>Camera</span></div>' +
            '<div class="ms-si" id="ms-si-prt"><span class="ms-dot" id="ms-d-prt"></span><span>Stampante</span></div>' +
            '<div class="ms-si" id="ms-si-evt"><span class="ms-dot" id="ms-d-evt"></span><span>Evento</span></div>' +
          '</div>' +
        '</div>' +
        '<div id="ms-preview-wrap">' +
          '<div id="ms-preview-inner">' +
            '<video id="ms-cam-video" autoplay muted playsinline></video>' +
            '<div id="ms-safe-area"><div id="ms-safe-area-br"></div><div id="ms-safe-area-tr"></div></div>' +
            '<div id="ms-safe-label">Area di stampa</div>' +
            '<div id="ms-selphy-badge">SELPHY 10×15 · 1200×1800px</div>' +
            '<img id="ms-frame-ov" alt="" />' +
            '<div id="ms-preview-grad"></div>' +
            '<button id="ms-start-btn" type="button">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
              'START MIRROR' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div id="ms-panel">' +
          '<div class="ms-card" id="ms-c-dev">' +
            '<div class="ms-ct">Camera</div>' +
            '<select class="ms-sel" id="ms-cam-sel"><option value="">Ricerca camera\u2026</option></select>' +
          '</div>' +
          '<div class="ms-card" id="ms-c-evt">' +
            '<div class="ms-ct">Evento</div>' +
            '<select class="ms-sel" id="ms-evt-sel"><option value="">Caricamento\u2026</option></select>' +
          '</div>' +
          '<div class="ms-card ms-card-full" id="ms-c-save">' +
            '<div class="ms-ct">Cartella salvataggio foto</div>' +
            '<div class="ms-path-row">' +
              '<div class="ms-path-display" id="ms-save-path-display">Caricamento\u2026</div>' +
              '<button id="ms-btn-choose-folder" type="button">\uD83D\uDCC2 Sfoglia</button>' +
            '</div>' +
          '</div>' +
          '<div class="ms-card" id="ms-c-opts">' +
            '<div class="ms-ct">Opzioni</div>' +
            '<div class="ms-tr"><span class="ms-tl">Suoni</span><label class="ms-tog"><input type="checkbox" id="ms-t-sound"><span class="ms-slider"></span></label></div>' +
            '<div class="ms-tr"><span class="ms-tl">Stampa</span><label class="ms-tog"><input type="checkbox" id="ms-t-print"><span class="ms-slider"></span></label></div>' +
          '</div>' +
          '<div class="ms-card" id="ms-c-timing">' +
            '<div class="ms-ct">Tempi</div>' +
            '<div class="ms-field"><span class="ms-fl">Scatto (secondi)</span><select class="ms-sel" id="ms-s-countdown"></select></div>' +
            '<div class="ms-field"><span class="ms-fl">Inattivit\u00e0 (minuti)</span><select class="ms-sel" id="ms-s-inactivity"></select></div>' +
          '</div>' +
          '<div class="ms-card ms-card-full" id="ms-c-frames">' +
            '<div class="ms-ct"><span>Cornici</span><label id="ms-add-frame-lbl" for="ms-frame-file-input">+ Aggiungi<input type="file" id="ms-frame-file-input" accept=".png,.jpg,.jpeg,.webp,.gif" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;"></label></div>' +
            '<div id="ms-frames-grid"></div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(appDiv);

      var sessionBlocker = document.createElement('div');
      sessionBlocker.id = 'ms-session-blocker';
      document.body.appendChild(sessionBlocker);

      var navMask = document.createElement('div');
      navMask.id = 'ms-nav-mask';
      document.body.appendChild(navMask);

      var toastEl = document.createElement('div');
      toastEl.id = 'ms-toast';
      document.body.appendChild(toastEl);

      var sessionFrameOv = document.getElementById('ms-session-frame-ov');
      if (!sessionFrameOv) {
        sessionFrameOv = document.createElement('img');
        sessionFrameOv.id = 'ms-session-frame-ov';
        sessionFrameOv.alt = '';
        // Appende a <html> (non a body) per evitare stacking context creati dalla pagina remota
        sessionFrameOv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:fill;z-index:2147483000;pointer-events:none;display:none;';
        (document.documentElement || document.body).appendChild(sessionFrameOv);
      }
    }

    // â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var getCtrl = function() { return document.body; }; // #controls non esiste nella pagina remota

    var findOrigSelects = function() {
      return Array.from(document.querySelectorAll('select')).filter(function(s) {
        return !s.id || s.id.indexOf('ms-') !== 0;
      });
    };

    var findOrigEventSelect = function() {
      var byName = document.querySelector('select[name=event_selected]');
      if (byName) return byName;
      var sels = findOrigSelects();
      var best = null, bestCount = 0;
      sels.forEach(function(s) {
        var hasDate = Array.from(s.options).some(function(o) { return /\d{4}/.test(o.textContent); });
        if (hasDate && s.options.length > bestCount) { bestCount = s.options.length; best = s; }
      });
      return best || (sels.length > 0 ? sels[0] : null);
    };

    var findOrigCheckbox = function(hint) {
      var nameMap = { 'suon': 'sounds', 'stamp': 'print' };
      var n = nameMap[hint] || hint;

      if (n === 'print' || hint === 'stamp') {
        var printSelectors = [
          '#controls_user input[type=checkbox]',
          '#controls_user_temp input[type=checkbox]',
          'input#print',
          'input#print_foto',
          'input[type=checkbox][name=print]'
        ];
        for (var ps = 0; ps < printSelectors.length; ps++) {
          var cand = document.querySelector(printSelectors[ps]);
          if (cand && (!cand.id || cand.id.indexOf('ms-') !== 0)) return cand;
        }
      }

      var byName = document.querySelector('input[type=checkbox][name=' + n + ']');
      if (byName) return byName;
      var cbs = document.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) {
        var cb = cbs[i]; if (cb.id && cb.id.indexOf('ms-') === 0) continue;
        var text = (cb.name||'') + (cb.id||'');
        if (text.toLowerCase().indexOf(hint) >= 0) return cb;
      }
      return null;
    };

    var findOrigTimingEl = function(hint) {
      if (hint.indexOf('scatt') >= 0) {
        var s = document.querySelector('select[name=count_down_selected]');
        if (s) return s;
      }
      if (hint.indexOf('inattiv') >= 0) {
        var remaining = findOrigSelects().filter(function(s) {
          return s.name !== 'event_selected' && s.name !== 'count_down_selected';
        });
        if (remaining.length > 0) return remaining[0];
      }
      var sels = findOrigSelects();
      for (var i = 0; i < sels.length; i++) {
        var s2 = sels[i];
        var hasDate = Array.from(s2.options).some(function(o) { return /\d{4}/.test(o.textContent); });
        if (hasDate) continue;
        var text = (s2.name||'') + (s2.id||'');
        if (text.toLowerCase().indexOf(hint) >= 0) return s2;
      }
      return null;
    };
    var findStartBtn = function() {
      var all = document.querySelectorAll('button,input[type=button],input[type=submit],a');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el) continue;
        if ((el.id && el.id.indexOf('ms-') === 0) || (el.closest && el.closest('#ms-app'))) continue;
        var t = (el.textContent + (el.value || '')).toUpperCase();
        if (t.indexOf('START') >= 0 && t.indexOf('MIRROR') >= 0) return el;
      }
      return null;
    };

    var findAddFrameBtn = function() {
      var all = document.querySelectorAll('button,input[type=button],input[type=submit],a,label,span');
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].textContent + (all[i].value || '')).toLowerCase();
        if (t.indexOf('aggiungi') >= 0 || t.indexOf('cornic') >= 0) return all[i];
      }
      return null;
    };

    var findFrameItems = function() {
      // Cerca SOLO immagini in container con id/class legati alle cornici
      var frameContainers = Array.from(document.querySelectorAll(
        '[id*="frame"],[id*="cornic"],[class*="frame"],[class*="cornic"]'
      )).filter(function(el) { return !el.closest('#ms-app'); });

      var imgs = [];
      if (frameContainers.length) {
        frameContainers.forEach(function(c) {
          Array.from(c.querySelectorAll('img')).forEach(function(img) {
            if (img.src && /\.(jpg|jpeg|png|gif|webp)/i.test(img.src) && !img.closest('#ms-app')) {
              imgs.push(img);
            }
          });
        });
      }
      // Fallback: immagini in <li> (gallery list)
      if (!imgs.length) {
        imgs = Array.from(document.querySelectorAll('ul li img, ol li img')).filter(function(img) {
          return img.src && /\.(jpg|jpeg|png|gif|webp)/i.test(img.src) && !img.closest('#ms-app');
        });
      }
      return imgs;
    };

    var findFrameDeleteBtn = function(img) {
      var container = img.closest ? img.closest('div,td,tr,li') : img.parentElement;
      if (!container) return null;
      var btns = container.querySelectorAll('button,a,span,input[type=button]');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent + (btns[i].value || '') + (btns[i].title || '') + (btns[i].className || '')).toLowerCase();
        if (t.indexOf('elimin') >= 0 || t.indexOf('delet') >= 0 || t.indexOf('remov') >= 0 || t.indexOf('\u00d7') >= 0) return btns[i];
      }
      return container.querySelector('[onclick]') || null;
    };

    // â”€â”€ CAMERA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var startCamera = function(deviceId) {
      var video = document.getElementById('ms-cam-video');
      if (!video) return;
      if (video.srcObject) { video.srcObject.getTracks().forEach(function(t) { t.stop(); }); video.srcObject = null; }
      if (!deviceId) return;
      navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false })
        .then(function(stream) {
          video.srcObject = stream;
          var d = document.getElementById('ms-d-cam'); if (d) d.className = 'ms-dot online';
          var si = document.getElementById('ms-si-cam'); if (si) si.classList.add('active');
        })
        .catch(function() {
          navigator.mediaDevices.getUserMedia({ video: true, audio: false })
            .then(function(stream) { video.srcObject = stream; })
            .catch(function() {});
        });
    };

    var loadCameras = function() {
      var sel = document.getElementById('ms-cam-sel');
      if (!sel) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        sel.innerHTML = '<option>Non disponibile</option>'; return;
      }
      var prevId = '';
      try { prevId = localStorage.getItem('msPreferredCameraDeviceId') || ''; } catch(e) {}
      navigator.mediaDevices.enumerateDevices().then(function(devs) {
        var cams = devs.filter(function(d) { return d.kind === 'videoinput'; });
        if (!cams.length || cams.every(function(d) { return !d.label; })) {
          return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
            .then(function(s) { s.getTracks().forEach(function(t) { t.stop(); }); return navigator.mediaDevices.enumerateDevices(); })
            .then(function(devs2) { return devs2.filter(function(d) { return d.kind === 'videoinput'; }); })
            .catch(function() { return cams; });
        }
        return Promise.resolve(cams);
      }).then(function(cams) {
        if (!cams || !cams.length) { sel.innerHTML = '<option value="">Nessuna camera</option>'; return; }
        sel.innerHTML = '';
        cams.forEach(function(cam, i) {
          var o = document.createElement('option');
          o.value = cam.deviceId || ''; o.textContent = cam.label || ('Camera ' + (i + 1));
          if (prevId && o.value === prevId) o.selected = true;
          sel.appendChild(o);
        });
        if (!sel.value && sel.options.length) sel.selectedIndex = 0;
        if (!sel.dataset.msb) {
          sel.dataset.msb = '1';
          sel.addEventListener('change', function() {
            try { localStorage.setItem('msPreferredCameraDeviceId', sel.value); } catch(e) {}
            startCamera(sel.value);
          });
        }
        if (cams.length) { var d = document.getElementById('ms-d-cam'); if (d) d.className = 'ms-dot online'; }
        if (sel.value) startCamera(sel.value);
      }).catch(function() { sel.innerHTML = '<option>Errore</option>'; });
    };

    // â”€â”€ EVENT SELECT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var syncEvtSel = function() {
      var ui = document.getElementById('ms-evt-sel');
      var orig = findOrigEventSelect();
      if (!ui || !orig) return;

      var syncCurrentEventFolder = function() {
        try {
          if (!window.electronAPI || typeof window.electronAPI.setCurrentEventFolder !== 'function') return;
          var txt = '';
          if (ui && ui.selectedIndex >= 0 && ui.options && ui.options[ui.selectedIndex]) {
            txt = String(ui.options[ui.selectedIndex].textContent || '').trim();
          }
          window.electronAPI.setCurrentEventFolder(txt).catch(function() {});
        } catch (_) {}
      };

      ui.innerHTML = '';
      Array.from(orig.options).forEach(function(opt) {
        var o = document.createElement('option'); o.value = opt.value; o.textContent = opt.textContent;
        if (opt.selected) o.selected = true; ui.appendChild(o);
      });
      if (ui.value) {
        var d = document.getElementById('ms-d-evt'); if (d) d.className = 'ms-dot online';
        var si = document.getElementById('ms-si-evt'); if (si) si.classList.add('active');
      }
      if (!ui.dataset.msb) {
        ui.dataset.msb = '1';
        ui.addEventListener('change', function() {
          if (orig) { orig.value = ui.value; orig.dispatchEvent(new Event('change', { bubbles: true })); }
          syncCurrentEventFolder();
          var hasEvt = !!ui.value;
          var dot = document.getElementById('ms-d-evt'); if (dot) dot.className = 'ms-dot' + (hasEvt ? ' online' : '');
          var si2 = document.getElementById('ms-si-evt'); if (si2) si2.classList.toggle('active', hasEvt);
        });
      }

      syncCurrentEventFolder();
    };

    // â”€â”€ TOGGLES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var MS_PANEL_PRINT_PREF_KEY = 'msPanelPrintEnabled';

    var readPanelPrintPref = function() {
      try {
        var v = localStorage.getItem(MS_PANEL_PRINT_PREF_KEY);
        if (v === '1') return true;
        if (v === '0') return false;
      } catch (_) {}
      return null;
    };

    var writePanelPrintPref = function(value) {
      try { localStorage.setItem(MS_PANEL_PRINT_PREF_KEY, value ? '1' : '0'); } catch (_) {}
    };

    var bindToggle = function(id, origCb) {
      var t = document.getElementById(id);
      if (!t || !origCb) return;
      t.__msOrigCb = origCb;
      var isPrintToggle = id === 'ms-t-print';

      var syncUiFromOrig = function() {
        var cb = t.__msOrigCb;
        if (!cb) return;

        var isDisabled = !!cb.disabled;
        t.disabled = isDisabled;
        t.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');

        if (isPrintToggle) {
          var pref = readPanelPrintPref();
          if (pref !== null && !cb.disabled) {
            if (!!cb.checked !== !!pref) {
              cb.checked = !!pref;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
            t.checked = !!pref;
            return;
          }
        }

        t.checked = isDisabled ? false : !!cb.checked;
      };

      if (isPrintToggle && readPanelPrintPref() === null && !origCb.disabled) {
        writePanelPrintPref(!!origCb.checked);
      }

      syncUiFromOrig();

      if (!t.dataset.msb) {
        t.dataset.msb = '1';
        t.addEventListener('change', function() {
          var cb = t.__msOrigCb;
          if (!cb) return;
          if (t.disabled || cb.disabled) {
            syncUiFromOrig();
            return;
          }
          cb.checked = t.checked;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          if (isPrintToggle) writePanelPrintPref(!!t.checked);
          syncUiFromOrig();
        });
      }
    };

    // â”€â”€ TIMING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var bindTiming = function(selectId, origEl) {
      var ui = document.getElementById(selectId);
      if (!ui || !origEl) return;
      if (origEl.tagName === 'SELECT' && origEl.options.length === 0) return;
      ui.innerHTML = '';
      if (origEl.tagName === 'SELECT') {
        Array.from(origEl.options).forEach(function(opt) {
          var o = document.createElement('option'); o.value = opt.value; o.textContent = opt.textContent;
          if (opt.selected) o.selected = true; ui.appendChild(o);
        });
      } else {
        var cur = parseInt(origEl.value) || 0;
        for (var v = 0; v <= Math.max(cur, 30); v++) {
          var o = document.createElement('option'); o.value = v; o.textContent = v;
          if (v === cur) o.selected = true; ui.appendChild(o);
        }
      }
      if (!ui.dataset.msb) {
        ui.dataset.msb = '1';
        ui.addEventListener('change', function() {
          if (origEl.tagName === 'SELECT') { origEl.value = ui.value; origEl.dispatchEvent(new Event('change', { bubbles: true })); }
          else { origEl.value = ui.value; origEl.dispatchEvent(new Event('input', { bubbles: true })); origEl.dispatchEvent(new Event('change', { bubbles: true })); }
          // Salva il countdown in localStorage così la pagina sessione lo legge
          if (selectId === 'ms-s-countdown') {
            try { localStorage.setItem('msCountdownSec', String(parseInt(ui.value, 10) || 3)); } catch (_) {}
          }
        });
        // Salva subito il valore corrente al binding
        if (selectId === 'ms-s-countdown') {
          try { localStorage.setItem('msCountdownSec', String(parseInt(ui.value, 10) || 3)); } catch (_) {}
        }
      }
    };

    // â”€â”€ BUTTONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var bindBtn = function(id, fn) {
      var btn = document.getElementById(id); if (!btn || btn.dataset.msb) return;
      btn.dataset.msb = '1'; btn.addEventListener('click', fn);
    };

    // â”€â”€ FRAMES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var MS_LOCAL_FRAMES_KEY = 'msLocalFramesV1';
    var MS_SELECTED_FRAME_KEY = 'msSelectedFrameV1';
    window._msLocalFrames = window._msLocalFrames || [];

    var loadPersistedLocalFrames = function() {
      try {
        var raw = localStorage.getItem(MS_LOCAL_FRAMES_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(function(frame) {
          return frame && typeof frame.url === 'string' && frame.url && typeof frame.name === 'string';
        });
      } catch (e) {
        return [];
      }
    };

    // Carica subito le cornici persistite, prima del polling init(), cosi' syncSessionFrameOverlay
    // le trova gia' disponibili al primo ciclo dopo la navigazione START.
    if (!window._msLocalFrames.length) {
      window._msLocalFrames = loadPersistedLocalFrames();
    }

    var savePersistedLocalFrames = function() {
      try {
        localStorage.setItem(MS_LOCAL_FRAMES_KEY, JSON.stringify(window._msLocalFrames.map(function(frame) {
          return { url: frame.url, name: frame.name || '' };
        })));
      } catch (e) {}
    };

    var getSelectedFrameName = function() {
      try {
        return localStorage.getItem(MS_SELECTED_FRAME_KEY) || '';
      } catch (e) {
        return '';
      }
    };

    var setSelectedFrameName = function(name) {
      try {
        if (name) localStorage.setItem(MS_SELECTED_FRAME_KEY, name);
        else localStorage.removeItem(MS_SELECTED_FRAME_KEY);
      } catch (e) {}
    };

    var syncSessionFrameOverlay = function() {
      var sessFrameOv = document.getElementById('ms-session-frame-ov');
      if (!sessFrameOv) {
        // Ricrea se scomparso (navigazione interna senza ricarica)
        sessFrameOv = document.createElement('img');
        sessFrameOv.id = 'ms-session-frame-ov';
        sessFrameOv.alt = '';
        sessFrameOv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:fill;z-index:2147483000;pointer-events:none;display:none;';
        (document.documentElement || document.body).appendChild(sessFrameOv);
      }
      var selectedName = getSelectedFrameName();
      var selectedFrame = null;
      if (selectedName) {
        selectedFrame = (window._msLocalFrames || []).find(function(frame) {
          return (frame.name || '') === selectedName;
        }) || null;
      }
      // Fallback: se non c'è selezione esplicita ma esiste almeno una cornice locale, usa la prima
      if (!selectedFrame && (window._msLocalFrames || []).length) {
        selectedFrame = window._msLocalFrames[0];
      }
      var previewOv = document.getElementById('ms-frame-ov');
      var previewSrc = previewOv && previewOv.src ? previewOv.src : '';
      var source = selectedFrame ? selectedFrame.url : previewSrc;
      if (!source) {
        try {
          if (typeof window.__msResolveFrameUrl === 'function') {
            source = window.__msResolveFrameUrl() || '';
          }
        } catch (e) {}
      }
      var root = document.documentElement;
      var sessionAttr = root && root.getAttribute('data-ms-session') === '1';
      var path = (window.location && window.location.pathname) || '';
      var pathSession = /\\/mirror\\/index\\d+\\.php$/i.test(path);
      var app = document.getElementById('ms-app');
      var appHidden = false;
      if (app) {
        var appSt = window.getComputedStyle(app);
        appHidden = appSt.display === 'none' || app.style.zIndex === '-1' || parseFloat(appSt.opacity || '1') < 0.05;
      }
      var reviewVisible = false;
      try {
        var reviewSelectors = [
          'button',
          'input[type="button"]',
          'input[type="submit"]',
          'a'
        ];
        var reviewEls = Array.from(document.querySelectorAll(reviewSelectors.join(',')));
        reviewVisible = reviewEls.some(function(el) {
          if (!el || !el.getBoundingClientRect) return false;
          var txt = ((el.textContent || '') + ' ' + (el.value || '') + ' ' + (el.title || '')).toLowerCase();
          if (!/(salv|scart|stamp|print|riprova|retry)/i.test(txt)) return false;
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      } catch (e) {}

      var sessionLikelyActive = _msReviewActive || sessionAttr || pathSession || appHidden;
      if (reviewVisible) {
        sessionLikelyActive = false;
      }
      if (sessionLikelyActive && source) {
        if (sessFrameOv.src !== source) sessFrameOv.src = source;
        if (sessFrameOv.style.display !== 'block') {
          sessFrameOv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:fill;z-index:2147483000;pointer-events:none;display:block;';
        }
        // Riappende solo se non e' gia' figlio della root, per evitare loop con MutationObserver.
        var rootEl = document.documentElement || document.body;
        if (rootEl && sessFrameOv.parentNode !== rootEl) {
          rootEl.appendChild(sessFrameOv);
        }
      } else {
        if (sessFrameOv.style.display !== 'none') sessFrameOv.style.display = 'none';
        if (sessFrameOv.src) sessFrameOv.src = '';
      }
    };

    // Guard observer: se la pagina remota tenta di rimuovere/nascondere l'overlay durante la sessione,
    // lo riappende e ripristina lo stile. Questo elimina il comportamento "compare e sparisce dopo 1s".
    if (!window.__msSessionFrameOvGuard) {
      window.__msSessionFrameOvGuard = true;
      try {
        // Osserva solo gli attributi della root, niente childList per evitare loop.
        new MutationObserver(function() {
          syncSessionFrameOverlay();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ms-session', 'data-ms-nav'] });
      } catch (e) {}
      // Retry continuo a bassa frequenza per resilienza
      setInterval(function() { syncSessionFrameOverlay(); }, 1000);
    }

    var renderLocalFrames = function() {
      var grid = document.getElementById('ms-frames-grid');
      if (!grid) return;
      // Idempotente: ricostruisce solo se la lista è cambiata, evita loop con il MutationObserver
      var current = Array.from(grid.querySelectorAll('.ms-fi[data-local="1"]')).map(function(el) { return el.dataset.s + '|' + (el.dataset.name || ''); }).join(',');
      var desired = window._msLocalFrames.map(function(f, i) { return i + '|' + (f.name || ''); }).join(',');
      if (current === desired && current !== '') return;
      Array.from(grid.querySelectorAll('.ms-fi[data-local="1"]')).forEach(function(el) { el.remove(); });
      var selectedName = getSelectedFrameName();
      window._msLocalFrames.forEach(function(frame, idx) {
        var fileUrl = typeof frame === 'string' ? frame : frame.url;
        var fileName = typeof frame === 'string' ? '' : (frame.name || '');
        var item = document.createElement('div');
        item.className = 'ms-fi'; item.dataset.s = idx; item.dataset.local = '1'; item.dataset.name = fileName;
        var thumb = document.createElement('img');
        thumb.src = fileUrl; thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        if (fileName) thumb.title = fileName;
        var del = document.createElement('button');
        del.className = 'ms-fi-del'; del.type = 'button'; del.title = 'Rimuovi'; del.textContent = '\u00d7';
        item.appendChild(thumb); item.appendChild(del); grid.appendChild(item);
        validateFrameAspectRatio(fileUrl, function(actualSize) {
          item.style.outline = '2px solid #f59e0b';
          item.title = 'Formato non corretto (' + actualSize + ')';
          showToast('\u26a0\ufe0f Cornice non compatibile SELPHY (' + actualSize + ') \u2014 richiesto 2:3 (es. 1200\u00d71800px)', 4500, '#f59e0b');
        });
        item.addEventListener('click', function(e) {
          if (e.target === del) return;
          Array.from(document.querySelectorAll('.ms-fi')).forEach(function(el2) { el2.classList.remove('sel'); });
          item.classList.add('sel');
          setSelectedFrameName(fileName);
          var ov = document.getElementById('ms-frame-ov');
          if (ov) { ov.src = fileUrl; ov.style.display = 'block'; }
          syncSessionFrameOverlay();
        });
        del.addEventListener('click', function(e) {
          e.stopPropagation();
          var wasSelected = getSelectedFrameName() === fileName;
          window._msLocalFrames.splice(idx, 1);
          savePersistedLocalFrames();
          if (wasSelected) {
            var nextFrame = window._msLocalFrames[0] || null;
            setSelectedFrameName(nextFrame ? (nextFrame.name || '') : '');
          }
          var ov = document.getElementById('ms-frame-ov');
          if (ov && !window._msLocalFrames.length) {
            ov.style.display = 'none';
            ov.src = '';
          }
          renderLocalFrames();
          syncSessionFrameOverlay();
        });
        if ((selectedName && fileName === selectedName) || (!selectedName && idx === 0 && !grid.querySelector('.ms-fi.sel'))) {
          item.classList.add('sel');
          var ov0 = document.getElementById('ms-frame-ov');
          if (ov0) { ov0.src = fileUrl; ov0.style.display = 'block'; }
        }
      });
      if (!window._msLocalFrames.length) {
        setSelectedFrameName('');
      }
      syncSessionFrameOverlay();
    };

    var showToast = function(msg, duration, color) {
      var t = document.getElementById('ms-toast');
      if (!t) return;
      t.textContent = msg;
      t.style.background = color || '#E63946';
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, duration || 3000);
    };

    var validateFrameAspectRatio = function(imgSrc, onInvalid) {
      var probe = new Image();
      probe.onload = function() {
        var w = probe.naturalWidth;
        var h = probe.naturalHeight;
        if (!w || !h) return;
        var ratio = w / h;
        // SELPHY 2:3 = 0.6667 — tolleranza ±8%
        var target = 2 / 3;
        var tolerance = 0.08;
        if (Math.abs(ratio - target) > tolerance) {
          var actual = w + '\u00d7' + h;
          onInvalid(actual, w, h);
        }
      };
      probe.src = imgSrc;
    };

    // Adatta la cornice al formato stampa Canon SELPHY 10x15 (1200x1800px)
    var adaptFrameToSelphy = function(file, callback) {
      var SELPHY_W = 1200, SELPHY_H = 1800;
      var tempUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function() {
        URL.revokeObjectURL(tempUrl);
        var canvas = document.createElement('canvas');
        canvas.width = SELPHY_W; canvas.height = SELPHY_H;
        var ctx2 = canvas.getContext('2d');
        // Cover fit: scala mantenendo le proporzioni e taglia al centro
        var srcR = img.naturalWidth / img.naturalHeight;
        var dstR = SELPHY_W / SELPHY_H;
        var sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (srcR > dstR) { sw = img.naturalHeight * dstR; sx = (img.naturalWidth - sw) / 2; }
        else if (srcR < dstR) { sh = img.naturalWidth / dstR; sy = (img.naturalHeight - sh) / 2; }
        ctx2.drawImage(img, sx, sy, sw, sh, 0, 0, SELPHY_W, SELPHY_H);
        canvas.toBlob(function(blob) {
          if (!blob) {
            callback(null, true);
            return;
          }
          var reader = new FileReader();
          reader.onloadend = function() {
            callback(typeof reader.result === 'string' ? reader.result : null, false);
          };
          reader.onerror = function() { callback(null, true); };
          reader.readAsDataURL(blob);
        }, 'image/png');
      };
      img.onerror = function() { URL.revokeObjectURL(tempUrl); callback(null, true); };
      img.src = tempUrl;
    };

    var refreshFrames = function() {
      var grid = document.getElementById('ms-frames-grid'); if (!grid) return;
      var items = findFrameItems();
      Array.from(grid.querySelectorAll('.ms-fi')).forEach(function(el) {
        // Non toccare le cornici locali aggiunte via picker Electron.
        if (el.dataset && el.dataset.local === '1') return;
        if (!items.find(function(img) { return img.src === el.dataset.s; })) el.remove();
      });
      items.forEach(function(img) {
        if (grid.querySelector('[data-s="' + img.src.replace(/"/g, '\\"') + '"]')) return;
        var item = document.createElement('div');
        item.className = 'ms-fi'; item.dataset.s = img.src;
        var thumb = document.createElement('img');
        thumb.src = img.src; thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        var del = document.createElement('button');
        del.className = 'ms-fi-del'; del.type = 'button'; del.title = 'Elimina'; del.textContent = '\u00d7';
        item.appendChild(thumb); item.appendChild(del); grid.appendChild(item);

        // Valida proporzioni SELPHY 2:3
        validateFrameAspectRatio(img.src, function(actualSize) {
          item.style.outline = '2px solid #f59e0b';
          item.title = 'Formato non corretto (' + actualSize + ')';
          showToast(
            '\u26a0\ufe0f Cornice non compatibile SELPHY (' + actualSize + ')\u2014 richiesto 2:3 (es. 1200\u00d71800px)',
            4500,
            '#f59e0b'
          );
        });

        item.addEventListener('click', function(e) {
          if (e.target === del) return;
          Array.from(document.querySelectorAll('.ms-fi')).forEach(function(el2) { el2.classList.remove('sel'); });
          item.classList.add('sel'); img.click();
          var ov = document.getElementById('ms-frame-ov');
          if (ov) { ov.src = img.src; ov.style.display = 'block'; }
        });
        del.addEventListener('click', function(e) {
          e.stopPropagation();
          var dBtn = findFrameDeleteBtn(img); if (dBtn) dBtn.click();
          setTimeout(refreshFrames, 400);
        });
      });
      if (items.length && !grid.querySelector('.ms-fi.sel')) {
        var first = grid.querySelector('.ms-fi');
        if (first) { first.classList.add('sel'); var ov2 = document.getElementById('ms-frame-ov'); if (ov2) { ov2.src = first.dataset.s; ov2.style.display = 'block'; } }
      }
      if (!items.length && !(window._msLocalFrames && window._msLocalFrames.length)) {
        var ov3 = document.getElementById('ms-frame-ov');
        if (ov3) ov3.style.display = 'none';
      }
      if (window._msLocalFrames && window._msLocalFrames.length) {
        renderLocalFrames();
      }
    };

    // â”€â”€ STATUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var refreshStatus = function() {
      try {
        if (window.electronAPI && window.electronAPI.getPrinters) {
          window.electronAPI.getPrinters().then(function(printers) {
            var on = Array.isArray(printers) && printers.length > 0;
            var dot = document.getElementById('ms-d-prt'); if (dot) dot.className = 'ms-dot ' + (on ? 'online' : 'warning');
            var si = document.getElementById('ms-si-prt'); if (si) si.classList.toggle('active', on);
          }).catch(function() {});
        }
      } catch(e) {}
    };

    // â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var init = function() {
      var dbg = {
        ctrl: !!getCtrl(),
        sels: findOrigSelects().map(function(s){ return (s.id||'?')+':opts='+s.options.length; }),
        evt: findOrigEventSelect() ? 'opts='+findOrigEventSelect().options.length : 'NULL',
        scatt: findOrigTimingEl('scatt') ? findOrigTimingEl('scatt').tagName+':opts='+findOrigTimingEl('scatt').options.length : 'NULL',
        inattiv: findOrigTimingEl('inattiv') ? findOrigTimingEl('inattiv').tagName+':opts='+findOrigTimingEl('inattiv').options.length : 'NULL',
        suon: findOrigCheckbox('suon') ? 'FOUND' : 'NULL',
        stamp: findOrigCheckbox('stamp') ? 'FOUND' : 'NULL'
      };
      console.log('[MS-DEBUG init]', JSON.stringify(dbg));
      syncEvtSel();
      bindToggle('ms-t-sound', findOrigCheckbox('suon'));
      bindToggle('ms-t-print', findOrigCheckbox('stamp'));
      bindTiming('ms-s-countdown', findOrigTimingEl('scatt'));
      bindTiming('ms-s-inactivity', findOrigTimingEl('inattiv'));
      bindBtn('ms-start-btn', function() {
        console.log('[start] click handler entered');
        try { showToast('START click', 1500, '#22c55e'); } catch(e) {}
        var evtSel = document.getElementById('ms-evt-sel');
        var evtVal = evtSel ? evtSel.value : null;
        var evtOpts = evtSel ? evtSel.options.length : 0;
        console.log('[start] evt val=' + evtVal + ' opts=' + evtOpts);
        if (!evtSel || !evtSel.value) {
          try { showToast('NO EVENTO (val=' + evtVal + ' opts=' + evtOpts + ')', 4000, '#ef4444'); } catch(e) {}
          showToast('Seleziona un evento prima di avviare', 2500);
          // Evidenzia la card evento
          var card = document.getElementById('ms-c-evt');
          if (card) {
            card.style.borderColor = '#E63946';
            card.style.boxShadow = '0 0 0 2px rgba(230,57,70,0.4)';
            setTimeout(function() { card.style.borderColor = ''; card.style.boxShadow = ''; }, 2500);
          }
          return;
        }
        var ob = findStartBtn();
        var cdsType = typeof window.count_down_start;
        console.log('[start] remoteBtn=' + (!!ob) + ' cds=' + cdsType);
        try { showToast('remoteBtn=' + (!!ob) + ' cds=' + cdsType, 2500, '#6366f1'); } catch(e) {}
        if (!getSelectedFrameName() && (window._msLocalFrames || []).length) {
          setSelectedFrameName((window._msLocalFrames[0].name || ''));
        }
        try {
          if (typeof window._msSetWindowControlsVisible === 'function') {
            window._msSetWindowControlsVisible(true);
          }
        } catch (e) {}
        hideOverlayForSession(true);
        syncSessionFrameOverlay();
        setTimeout(function() { syncSessionFrameOverlay(); }, 120);
        setTimeout(function() { syncSessionFrameOverlay(); }, 420);
        setTimeout(function() { syncSessionFrameOverlay(); }, 950);
        setTimeout(function() { syncSessionFrameOverlay(); }, 1600);
        if (ob) {
          console.log('[start] clicking remote btn');
          console.log('[start] btn info: tag=' + ob.tagName + ' id=' + (ob.id||'-') + ' name=' + (ob.name||'-') + ' type=' + (ob.type||'-') + ' onclick=' + (typeof ob.onclick));
          try { ob.click(); } catch(e) { console.log('[start] click err: ' + e.message); }
        } else {
          try {
            if (typeof window.count_down_start === 'function') {
              console.log('[start] calling count_down_start()');
              window.count_down_start();
            }
          } catch (e) {}
        }
      });
      // File picker tramite label+input — il click utente va diretto all'input senza JS intermedio
      var msFrameInput = document.getElementById('ms-frame-file-input');
      if (msFrameInput && !msFrameInput.dataset.msb) {
        msFrameInput.dataset.msb = '1';
        msFrameInput.addEventListener('change', function() {
          var file = msFrameInput.files && msFrameInput.files[0];
          if (!file) return;
          try { msFrameInput.value = ''; } catch(e) {}
          var already = window._msLocalFrames.some(function(f) { return (f.name || '') === file.name; });
          if (already) { showToast('Cornice già presente: ' + file.name, 2500, '#6366f1'); return; }
          adaptFrameToSelphy(file, function(adaptedUrl, failed) {
            var finalUrl = adaptedUrl;
            if (!finalUrl && !failed) {
              failed = true;
            }
            if (!finalUrl) {
              var reader = new FileReader();
              reader.onloadend = function() {
                var fallbackUrl = typeof reader.result === 'string' ? reader.result : '';
                if (!fallbackUrl) {
                  showToast('Impossibile caricare la cornice: ' + file.name, 2500);
                  return;
                }
                window._msLocalFrames.push({ url: fallbackUrl, name: file.name });
                savePersistedLocalFrames();
                setSelectedFrameName(file.name);
                renderLocalFrames();
                syncSessionFrameOverlay();
                showToast('\u2713 Cornice aggiunta: ' + file.name, 2500, '#22c55e');
              };
              reader.onerror = function() {
                showToast('Impossibile caricare la cornice: ' + file.name, 2500);
              };
              reader.readAsDataURL(file);
              return;
            }
            window._msLocalFrames.push({ url: finalUrl, name: file.name });
            savePersistedLocalFrames();
            setSelectedFrameName(file.name);
            renderLocalFrames();
            syncSessionFrameOverlay();
            showToast(failed ? ('\u2713 Cornice aggiunta: ' + file.name) : ('\u2713 Cornice adattata SELPHY 1200\u00d71800: ' + file.name), 2500, '#22c55e');
          });
        });
      }

      var blocker = document.getElementById('ms-session-blocker');
      if (blocker && !blocker.dataset.msb) {
        blocker.dataset.msb = '1';
        var onBlockerInteraction = function(ev) {
          try {
            if (!_msReviewActive) return;
            var x = ev.clientX;
            var y = ev.clientY;

            // Legge l'elemento sottostante disattivando temporaneamente il blocker.
            var prevPe = blocker.style.pointerEvents;
            blocker.style.pointerEvents = 'none';
            var under = document.elementsFromPoint
              ? document.elementsFromPoint(x, y)
              : [document.elementFromPoint(x, y)];
            blocker.style.pointerEvents = prevPe;

            var isConfig = false;
            for (var i = 0; i < under.length; i++) {
              var el = under[i];
              if (!el) continue;
              if (el.closest && el.closest('#ms-app')) continue;
              if (el.id && el.id.indexOf('ms-') === 0) continue;
              var txt = [
                el.textContent,
                el.value,
                el.title,
                el.getAttribute ? el.getAttribute('aria-label') : ''
              ].filter(Boolean).join(' ').trim();
              if (/^configurazion/i.test(txt)) {
                isConfig = true;
                break;
              }
            }

            ev.preventDefault();
            ev.stopPropagation();
            if (isConfig) {
              restoreOverlay(true);
              try {
                if (window.electronAPI && window.electronAPI.navigateHome) {
                  window.electronAPI.navigateHome();
                }
              } catch(e) {}
            }
          } catch (e) {}
        };
        blocker.addEventListener('pointerdown', onBlockerInteraction, true);
        blocker.addEventListener('click', onBlockerInteraction, true);
      }

      if (!window._msLocalFrames.length) {
        window._msLocalFrames = loadPersistedLocalFrames();
      }
      renderLocalFrames();
      refreshFrames();
      loadCameras();
      refreshStatus();
      initSaveFolder();
      syncSessionFrameOverlay();

      // Navigazione intercettata nel main process via 'will-navigate'.
    };

    // ── SESSIONE / REVIEW ─────────────────────────────────────────────────
    var _msReviewActive = !!_msSessionPersistedAtBoot;

    var readSessionState = function() { return _msReviewActive; };

    var writeSessionState = function(active) {
      try {
        if (window.electronAPI && window.electronAPI.setSessionMode) {
          window.electronAPI.setSessionMode(active);
        }
      } catch (e) {}
    };

    var isElVisible = function(el) {
      if (!el) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.01) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    var restoreOverlay = function(force) {
      if (!_msReviewActive && !force) return;
      _msReviewActive = false;
      writeSessionState(false);
      document.documentElement.removeAttribute('data-ms-nav');
      document.documentElement.removeAttribute('data-ms-session');
      var app = document.getElementById('ms-app');
      if (app) {
        app.classList.remove('ms-app-out');
        app.style.display = '';
        app.style.opacity = '1';
        app.style.pointerEvents = '';
        app.style.zIndex = '999998';
      }
      var controls = document.getElementById('ms-window-controls');
      if (controls) {
        controls.style.display = 'none';
        controls.style.pointerEvents = 'none';
        controls.style.opacity = '0';
        controls.style.visibility = 'hidden';
      }
      try {
        if (typeof window._msSetWindowControlsVisible === 'function') {
          window._msSetWindowControlsVisible();
        }
      } catch (e) {}
      var blocker = document.getElementById('ms-session-blocker');
      if (blocker) blocker.style.display = 'none';
      // Nasconde la cornice di sessione quando si torna al pannello admin
      var sessFrameOvR = document.getElementById('ms-session-frame-ov');
      if (sessFrameOvR) { sessFrameOvR.style.display = 'none'; sessFrameOvR.src = ''; }
      renderLocalFrames();
      setTimeout(function() { syncEvtSel(); refreshStatus(); }, 400);
    };
    window._msRestoreOverlay = restoreOverlay;

    var hideOverlayForSession = function(force) {
      if (_msReviewActive && !force) return;
      _msReviewActive = true;
      writeSessionState(true);
      document.documentElement.setAttribute('data-ms-session', '1');
      var app = document.getElementById('ms-app');
      if (app) {
        app.style.display = 'none';
        app.style.opacity = '';
        app.style.pointerEvents = 'none';
        app.style.zIndex = '-1';
      }
      var blocker = document.getElementById('ms-session-blocker');
      if (blocker) {
        blocker.style.display = 'none';
        blocker.style.pointerEvents = 'none';
        blocker.style.zIndex = '99990';
      }
      var controls = document.getElementById('ms-window-controls');
      if (controls) {
        controls.style.display = 'flex';
        controls.style.pointerEvents = 'auto';
      }
      try {
        if (typeof window._msSetWindowControlsVisible === 'function') {
          window._msSetWindowControlsVisible(true);
        }
      } catch (e) {}
      syncSessionFrameOverlay();
      requestAnimationFrame(function() { syncSessionFrameOverlay(); });
      setTimeout(function() { syncSessionFrameOverlay(); }, 120);
      setTimeout(function() { syncSessionFrameOverlay(); }, 450);
    };
    window._msReenterSession = function() {
      hideOverlayForSession(true);
    };
    window._msRestoreSessionFrame = function() {
      syncSessionFrameOverlay();
    };

    // Sfoglia cornici con frecce tastiera (ovunque tu sia: setup o sessione)
    var cycleSelectedFrame = function(direction) {
      var frames = window._msLocalFrames || [];
      if (!frames.length) return;
      var currentName = getSelectedFrameName();
      var currentIdx = -1;
      for (var i = 0; i < frames.length; i++) {
        if ((frames[i].name || '') === currentName) { currentIdx = i; break; }
      }
      var nextIdx = currentIdx < 0 ? 0 : (currentIdx + direction + frames.length) % frames.length;
      var nextFrame = frames[nextIdx];
      if (!nextFrame) return;
      setSelectedFrameName(nextFrame.name || '');
      // Aggiorna preview e selezione visiva
      Array.from(document.querySelectorAll('.ms-fi')).forEach(function(el2) { el2.classList.remove('sel'); });
      var grid = document.getElementById('ms-frames-grid');
      if (grid) {
        var match = grid.querySelector('.ms-fi[data-name="' + (nextFrame.name || '').replace(/"/g, '\\"') + '"]');
        if (match) match.classList.add('sel');
      }
      var ov = document.getElementById('ms-frame-ov');
      if (ov) { ov.src = nextFrame.url; ov.style.display = 'block'; }
      syncSessionFrameOverlay();
      showToast('◀ ' + (nextFrame.name || 'Cornice ' + (nextIdx + 1)) + ' ▶  (' + (nextIdx + 1) + '/' + frames.length + ')', 1500, '#6366f1');
    };

    if (!window.__msArrowKeysBound) {
      window.__msArrowKeysBound = true;
      window.addEventListener('keydown', function(ev) {
        // Ignora se l'utente sta scrivendo in un input/select
        var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          cycleSelectedFrame(1);
        } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          cycleSelectedFrame(-1);
        }
      }, true);
    }

    // ── CARTELLA SALVATAGGIO ───────────────────────────────────────────────
    var initSaveFolder = function() {
      var display = document.getElementById('ms-save-path-display');
      var btn = document.getElementById('ms-btn-choose-folder');
      if (!display || !btn) return;

      // Mostra il percorso attuale
      if (window.electronAPI && window.electronAPI.getSaveFolder) {
        window.electronAPI.getSaveFolder().then(function(p) {
          if (display) display.textContent = p || '—';
          if (display) display.title = p || '';
        }).catch(function() {});
      }

      if (!btn.dataset.msb) {
        btn.dataset.msb = '1';
        btn.addEventListener('click', function() {
          if (!window.electronAPI || !window.electronAPI.chooseSaveFolder) return;
          btn.disabled = true;
          btn.textContent = 'Attendere…';
          window.electronAPI.chooseSaveFolder().then(function(result) {
            btn.disabled = false;
            btn.innerHTML = '\\uD83D\\uDCC2 Sfoglia';
            if (result && result.success && result.path) {
              display.textContent = result.path;
              display.title = result.path;
              // Feedback visivo breve
              display.style.borderColor = '#4caf50';
              setTimeout(function() { display.style.borderColor = ''; }, 1800);
            }
          }).catch(function() {
            btn.disabled = false;
            btn.innerHTML = '\\uD83D\\uDCC2 Sfoglia';
          });
        });
      }
    };

    var _ia = 0;
    var _poll = setInterval(function() {
      _ia++; if (getCtrl() || _ia >= 30) { clearInterval(_poll); init(); }
    }, 200);

    // Ripristina la modalità sessione dopo eventuali reload/navigazioni remote.
    if (readSessionState()) {
      setTimeout(function() {
        hideOverlayForSession(true);
        syncSessionFrameOverlay();
      }, 250);
    }

    setTimeout(function() {
      var c = getCtrl();
      if (!c) return;
      var _refreshTimer = null;
      new MutationObserver(function(mutations) {
        // Ignora mutazioni causate dalla nostra UI per evitare loop
        for (var i = 0; i < mutations.length; i++) {
          var t = mutations[i].target;
          if (t && t.closest && t.closest('#ms-app')) return;
        }
        if (_refreshTimer) return;
        _refreshTimer = setTimeout(function() { _refreshTimer = null; refreshFrames(); }, 300);
      }).observe(c, { childList: true, subtree: true });
    }, 3000);

    setInterval(refreshStatus, 15000);
    setTimeout(function() { syncEvtSel(); }, 1200);
    setTimeout(function() { refreshFrames(); }, 1500);

    // Retry: la pagina carica i dati via AJAX, riprova tutti i controlli ogni 500ms per 15s
    var _retry = 0;
    var _retryPoll = setInterval(function() {
      _retry++;
      // Evento
      var evtUi = document.getElementById('ms-evt-sel');
      var evtOk = evtUi && evtUi.options.length > 1 && !(evtUi.options[0] && evtUi.options[0].textContent.indexOf('Caricamento') >= 0);
      if (!evtOk) syncEvtSel();
      // Scatto
      var cdUi = document.getElementById('ms-s-countdown');
      if (!cdUi || cdUi.options.length === 0) bindTiming('ms-s-countdown', findOrigTimingEl('scatt'));
      // Inattività
      var iaUi = document.getElementById('ms-s-inactivity');
      if (!iaUi || iaUi.options.length === 0) bindTiming('ms-s-inactivity', findOrigTimingEl('inattiv'));
      // Toggles
      var sndEl = document.getElementById('ms-t-sound');
      bindToggle('ms-t-sound', findOrigCheckbox('suon'));
      var prtEl = document.getElementById('ms-t-print');
      bindToggle('ms-t-print', findOrigCheckbox('stamp'));
      // Se siamo in sessione nascosta e i controlli si sono riconciliati, nascondi di nuovo il pannello
      if (_msReviewActive && (evtOk && cdUi && cdUi.options.length > 0 && iaUi && iaUi.options.length > 0)) {
        var app = document.getElementById('ms-app');
        if (app) { app.style.opacity = '0'; app.style.pointerEvents = 'none'; app.style.zIndex = '-1'; }
        var blocker = document.getElementById('ms-session-blocker');
        if (blocker) { blocker.style.display = 'none'; blocker.style.pointerEvents = 'none'; blocker.style.zIndex = '99990'; }
      }
      // Mantieni l'overlay cornice in sessione ad ogni ciclo
      if (_msReviewActive) { syncSessionFrameOverlay(); }
      // Stop quando tutto pronto
      if ((_retry >= 30) || (evtOk && cdUi && cdUi.options.length > 0 && iaUi && iaUi.options.length > 0)) clearInterval(_retryPoll);
    }, 500);
  } catch(e) { try { console.warn('[ms] redesign runtime error:', e && e.message ? e.message : String(e)); } catch(_) {} }
  })();`;

  execute(script).catch((err) => {
    console.warn('[ms] injectRemoteUiRedesign failed:', err && err.message ? err.message : err);
    if (err && err.stack) console.warn('[ms] stack:', err.stack);
  });
}

function getTvSimulationBounds() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  // Se lo schermo Ã¨ grande quanto la TV (o piÃ¹), usa scala 1:1 (nessuna riduzione).
  // Se lo schermo Ã¨ piÃ¹ piccolo (monitor di sviluppo), scala per farlo stare nella workArea.
  const naturalFit = Math.min(workArea.width / TV_WIDTH, workArea.height / TV_HEIGHT);
  const fitScale = Math.min(naturalFit, 1.0);
  const defaultWidth = Math.max(1, Math.floor(TV_WIDTH * fitScale));
  const defaultHeight = Math.max(1, Math.floor(TV_HEIGHT * fitScale));

  // Consenti ingrandimento fino alla dimensione logica TV reale (1200x1920).
  const maxWidth = TV_WIDTH;
  const maxHeight = TV_HEIGHT;
  const minWidth = defaultWidth;
  const minHeight = defaultHeight;

  const x = workArea.x + Math.floor((workArea.width - defaultWidth) / 2);
  const y = workArea.y + Math.floor((workArea.height - defaultHeight) / 2);

  return {
    x,
    y,
    width: defaultWidth,
    height: defaultHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight
  };
}

function enforceTvSize(win, opts) {
  if (!win || win.isDestroyed() || isApplyingBounds) {
    return;
  }

  // Se l'utente ha esplicitamente chiesto il fullscreen, NON forzare l'exit.
  // Ignoriamo richieste di enforce mentre il window e' fullscreen volontario,
  // tranne quando il chiamante passa allowExitFullscreen:true (es. handler di toggle).
  var allowExit = !!(opts && opts.allowExitFullscreen);
  if (win.isFullScreen() && !allowExit) {
    return;
  }

  isApplyingBounds = true;

  try {
    const bounds = getTvSimulationBounds();

    if (win.isFullScreen()) {
      win.setFullScreen(false);
    }

    win.setResizable(false);
    win.setMinimumSize(bounds.minWidth, bounds.minHeight);
    win.setMaximumSize(bounds.maxWidth, bounds.maxHeight);
    win.setAspectRatio(TV_WIDTH / TV_HEIGHT);
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  } finally {
    isApplyingBounds = false;
  }
}

function createWindow() {
    const bounds = getTvSimulationBounds();

    mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    maxWidth: bounds.maxWidth,
    maxHeight: bounds.maxHeight,
    fullscreen: false,
    resizable: false,
    maximizable: false,
    backgroundColor: '#0a0a0f',
        icon: path.join(__dirname, 'favicon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadURL('https://webservice.sballando.it/mirror/index.php');
    mainWindow.setMenu(null);
    enforceTvSize(mainWindow);

    // Bottone "Torna al pannello" + shield: gestiti dal sync() di
    // injectSessionFrameOverlay (già stabile, gira ogni 250ms con check
    // isSession()). Nessun tick globale qui.

    mainWindow.on('enter-full-screen', () => { console.log('[fs] event enter-full-screen'); broadcastFullscreenState(true); });
    mainWindow.on('leave-full-screen', () => { console.log('[fs] event leave-full-screen'); broadcastFullscreenState(false); });

    mainWindow.on('enter-html-full-screen', () => enforceTvSize(mainWindow));
    mainWindow.on('maximize', () => {
      mainWindow.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-ms-nav','1');`
      ).catch(() => {});
      mainWindow.unmaximize();
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(
          `document.documentElement.removeAttribute('data-ms-nav');`
        ).catch(() => {});
      }, 350);
      enforceTvSize(mainWindow);
    });
    mainWindow.on('restore', () => enforceTvSize(mainWindow));
    screen.on('display-metrics-changed', () => enforceTvSize(mainWindow));

    // Cattura errori dal renderer — compatibile con Electron 38 (event object API)
    mainWindow.webContents.on('console-message', (event) => {
      const level = event.level ?? event[1] ?? 0;
      const message = event.message ?? event[2] ?? '';
      const line = event.lineNumber ?? event[3] ?? 0;
      const sourceId = event.sourceId ?? event[4] ?? '';
      if (level >= 3 || message.includes('[ms]') || message.includes('redesign') || message.includes('[start]') || message.includes('MS-DEBUG')) {
        console.log(`[renderer] ${message} (${sourceId}:${line})`);
      }
    });

    // Inietta l'intercettore cornice il piu' presto possibile, prima che gli
    // script della pagina remota possano caricare un'Image() con URL mancante.
    mainWindow.webContents.on('dom-ready', () => {
      console.log('[nav] dom-ready url=' + mainWindow.webContents.getURL());
      // CSS preventivo: nasconde i vecchi controlli/checkbox della pagina
      // remota PRIMA che il nostro overlay JS abbia tempo di girare. Cosi'
      // l'utente non vede mai un flash del vecchio pannello al boot.
      try {
        mainWindow.webContents.insertCSS([
          '#captureBtn,#controls_main,#controls_buttons,.controls_main,',
          '#controls_user,#controls_user_temp,#controls_user *,#controls_user_temp *,',
          '#print,label#print,#print_foto,label[for=print_foto]',
          '{opacity:0!important;visibility:hidden!important;pointer-events:none!important;}',
          '#print,label#print,#print_foto,label[for=print_foto]',
          '{display:none!important;width:0!important;height:0!important;position:absolute!important;left:-99999px!important;}'
        ].join(''));
      } catch (e) { console.log('[nav] insertCSS err: ' + e.message); }
      injectFrameUrlInterceptor(mainWindow);
      injectSessionFrameOverlay(mainWindow);
    });

    mainWindow.webContents.on('did-start-loading', () => {
      console.log('[nav] did-start-loading');
    });
    mainWindow.webContents.on('did-stop-loading', () => {
      console.log('[nav] did-stop-loading url=' + mainWindow.webContents.getURL());
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log('[nav] did-fail-load code=' + code + ' desc=' + desc + ' url=' + url);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log('[nav] render-process-gone reason=' + details.reason);
    });
    mainWindow.webContents.on('unresponsive', () => {
      console.log('[nav] webContents UNRESPONSIVE');
    });

    mainWindow.webContents.on('did-finish-load', () => {
      const currentUrl = mainWindow.webContents.getURL();
      console.log('[nav] did-finish-load url=' + currentUrl);
      const zoomFactor = bounds.width / TV_WIDTH;      mainWindow.webContents.setZoomFactor(zoomFactor);
      injectFrameUrlInterceptor(mainWindow);
      injectSessionFrameOverlay(mainWindow);
      injectRemoteUiRedesign(mainWindow);

      // Safety: alcune macchine possono uscire da fullscreen durante il cambio pagina.
      // Re-applica fullscreen quando la session page ha finito di caricarsi.
      try {
        const pathname = new URL(currentUrl).pathname;
        const isMirrorSessionPage = /\/mirror\/index\d+\.php$/i.test(pathname);
        const isMirrorHomePage = /\/mirror\/index\.php$/i.test(pathname);
        if (isMirrorSessionPage && mainWindow && !mainWindow.isDestroyed()) {
          msSessionModeActive = true;
          mainWindow.setFullScreen(true);
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
              mainWindow.setFullScreen(true);
            }
            broadcastFullscreenState();
          }, 180);
        } else if (isMirrorHomePage && mainWindow && !mainWindow.isDestroyed()) {
          msSessionModeActive = false;
          if (mainWindow.isFullScreen()) {
            console.log('[fs] home did-finish-load leaveFullScreen');
            mainWindow.setFullScreen(false);
            enforceTvSize(mainWindow, { allowExitFullscreen: true });
          }
          broadcastFullscreenState(false);
        }
      } catch (_) {}

      // Forza il sync dell'overlay cornice piu' volte dopo il load per battere
      // eventuali sostituzioni del body fatte dalla pagina remota.
      [60, 200, 450, 900, 1500, 2500].forEach((delay) => {
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
            return;
          }
          mainWindow.webContents.executeJavaScript(
            "(function(){try{ if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); }catch(e){}})()"
          ).catch(() => {});
        }, delay);
      });

      // Chiude la nav-mask dopo ogni navigazione completata.
      mainWindow.webContents.executeJavaScript(`
        (() => {
          try {
            setTimeout(function() { document.documentElement.removeAttribute('data-ms-nav'); }, 380);
          } catch (e) {}
        })()
      `).catch(() => {});

      // Safety reset: se non siamo in sessione, nascondi sempre i controlli sessione.
      if (!msSessionModeActive) {
        mainWindow.webContents.executeJavaScript(`
          (() => {
            try {
              if (typeof window._msRestoreOverlay === 'function') {
                window._msRestoreOverlay(true);
              } else {
                document.documentElement.removeAttribute('data-ms-session');
                var bl = document.getElementById('ms-session-blocker'); if (bl) bl.style.display = 'none';
                var app = document.getElementById('ms-app'); if (app) { app.style.display = ''; app.style.pointerEvents = ''; app.style.zIndex = '999998'; }
              }
            } catch (e) {}
          })()
        `).catch(() => {});
      } else {
        mainWindow.webContents.executeJavaScript(`
          (() => {
            try {
              var reapply = function() {
                try {
                  if (typeof window._msReenterSession === 'function') {
                    window._msReenterSession();
                  } else if (typeof window._msRestoreSessionFrame === 'function') {
                    window._msRestoreSessionFrame();
                  } else {
                    document.documentElement.setAttribute('data-ms-session', '1');
                    var app = document.getElementById('ms-app');
                    if (app) { app.style.display = 'none'; app.style.pointerEvents = 'none'; app.style.zIndex = '-1'; }
                  }
                } catch (e) {}
                try {
                  if (typeof window._msSetWindowControlsVisible === 'function') {
                    window._msSetWindowControlsVisible(true);
                  }
                } catch (e) {}
              };
              setTimeout(reapply, 50);
              setTimeout(reapply, 220);
              setTimeout(reapply, 700);
            } catch (e) {}
          })()
        `).catch(() => {});
      }
    });

    // Intercetta navigazioni: sincronizza msSessionModeActive e blocca path non-mirror.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      console.log('[nav] will-navigate -> ' + url);
      try {
        const targetPathname = new URL(url).pathname;
        const isMirrorSessionPage = /\/mirror\/index\d+\.php$/i.test(targetPathname);
        const isMirrorHomePage = /\/mirror\/index\.php$/i.test(targetPathname);
        const isMirrorIndexPage = /\/mirror\/index\d*\.php$/i.test(targetPathname);

        if (isMirrorSessionPage) {
          // Navigazione verso pagina sessione: imposta flag PRIMA che la pagina carichi.
          msSessionModeActive = true;
          // Auto-enter fullscreen ad ogni avvio sessione, sempre.
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const before = mainWindow.isFullScreen();
              console.log('[fs] session-page beforeFs=' + before);
              mainWindow.setFullScreen(true);
              setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  const after = mainWindow.isFullScreen();
                  console.log('[fs] session-page afterFs(120ms)=' + after);
                  if (!after) {
                    console.log('[fs] retry setFullScreen(true)');
                    mainWindow.setFullScreen(true);
                  }
                  broadcastFullscreenState();
                }
              }, 120);
            }
          } catch (e) {}
          return;
        }

        if (isMirrorHomePage) {
          // Fine sessione naturale o redirect: resetta e esci da fullscreen.
          msSessionModeActive = false;
          try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
              console.log('[fs] home-page leaveFullScreen');
              mainWindow.setFullScreen(false);
              enforceTvSize(mainWindow, { allowExitFullscreen: true });
            }
          } catch (_) {}
          return;
        }

        // Non bloccare le altre pagine mirror: alcune fasi (preview/scelta stampa)
        // possono usare path diversi da index*.php.
      } catch (e) {}
    });

    mainWindow.webContents.on('did-frame-finish-load', (event, isMainFrame, processId, routingId) => {
      if (isMainFrame) {
        return;
      }

      try {
        const frame = webFrameMain.fromId(processId, routingId);
        if (!frame) {
          return;
        }

        // Nei frame secondari iniettiamo solo intercettore cornici + overlay sessione leggero.
        // La UI custom premium resta nel frame principale per non interferire con preview/scatto.
        injectFrameUrlInterceptor(mainWindow, frame);
        injectSessionFrameOverlay(mainWindow, frame);
      } catch {}
    });

    session.defaultSession.on('will-download', (event, item, webContents) => {
        try {
          const fileNameFull = String(item.getFilename() || '').trim();
          const sep = fileNameFull.includes('§') ? '§' : (fileNameFull.includes('Â§') ? 'Â§' : null);
          const rawFolder = sep ? fileNameFull.split(sep)[0] : '';
          const rawFileName = sep ? fileNameFull.split(sep).slice(1).join(sep) : fileNameFull;

          const mapped = buildPhotoPathCandidates(rawFolder, rawFileName);
          const eventFolder = mapped.preferredFolder;
          const fileName = mapped.safeFilename;
          const downloadPath = path.dirname(mapped.candidates[0]);

          if (!fsSync.existsSync(downloadPath)) {
              fsSync.mkdirSync(downloadPath, { recursive: true });
          }

          item.setSavePath(path.join(downloadPath, fileName));
          console.log(`Percorso salvataggio attivo: ${downloadPath} | evento: ${eventFolder}`);
        } catch (error) {
          console.error('[ms] Errore preparazione percorso download:', error && error.message ? error.message : error);
          try {
            const fallbackRoot = getDefaultPhotoRootPath();
            const fallbackFolder = getCurrentEventFolderName();
            const fallbackPath = path.join(fallbackRoot, fallbackFolder);
            if (!fsSync.existsSync(fallbackPath)) {
              fsSync.mkdirSync(fallbackPath, { recursive: true });
            }
            const fallbackName = path.basename(String(item.getFilename() || '').trim()) || ('foto_' + Date.now() + '.jpg');
            item.setSavePath(path.join(fallbackPath, fallbackName));
            console.log(`Percorso fallback download: ${fallbackPath}`);
          } catch (fallbackError) {
            console.error('[ms] Errore fallback percorso download:', fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
          }
        }

        item.on('updated', (event, state) => {
            if (state === 'interrupted') {
                console.log('Download interrotto');
            } else if (state === 'progressing') {
                if (item.isPaused()) {
                    console.log('Download in pausa');
                } else {
                    console.log(`Download in corso: ${item.getReceivedBytes()} di ${item.getTotalBytes()}`);
                }
            }
        });

        item.on('done', (event, state) => {
            if (state === 'completed') {
                console.log(`Foto salvata in: ${item.getSavePath()}`);
            } else {
                console.error(`Download fallito: ${state}`);
            }
        });
    });
}

ipcMain.handle('set-session-mode', async (event, active) => {
  msSessionModeActive = !!active;
  return true;
});

ipcMain.handle('navigate-home', async () => {
  msSessionModeActive = false;
  const homeUrl = 'https://webservice.sballando.it/mirror/index.php';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.loadURL(homeUrl).catch(() => {});
  }
  return true;
});

ipcMain.handle('window-minimize', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
  return true;
});

ipcMain.handle('window-toggle-fullscreen', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const nextState = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(nextState);
    broadcastFullscreenState(nextState);

    if (!nextState) {
      enforceTvSize(mainWindow, { allowExitFullscreen: true });
    }

    return nextState;
  }

  return false;
});

ipcMain.handle('window-is-fullscreen', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.isFullScreen();
  }
  return false;
});
ipcMain.handle('get-printers', async () => {
    try {
      const printers = await callPrintBroker('/printers');
      hasLoggedPrinterBrokerOffline = false;
      return printers;
    } catch (error) {
      // Se il broker locale non e' attivo, evita spam continuo e segnala stampante offline alla UI.
      if (!hasLoggedPrinterBrokerOffline) {
        console.warn('Print Broker non disponibile per get-printers:', error.message);
        hasLoggedPrinterBrokerOffline = true;
      }
      return [];
    }
});

ipcMain.handle('print-image', async (event, filename, printerName, options = {}) => {
    try {
        const imagePath = resolveImagePath(filename);

        await fs.access(imagePath);

        const payload = {
            imagePath,
            printerName,
            copies: options.copies || 1,
            paperSize: options.paperSize || 'Paper10x15',
            orientation: options.orientation || 'Portrait',
            metadata: options.metadata || {}
        };

        const response = await callPrintBroker('/jobs', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        return { success: true, ...response };
    } catch (error) {
        console.error('Errore submit job stampa:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('get-print-job', async (event, jobId) => {
    return await callPrintBroker(`/jobs/${jobId}`);
});

ipcMain.handle('cancel-print-job', async (event, jobId) => {
    return await callPrintBroker(`/jobs/${jobId}/cancel`, { method: 'POST' });
});

ipcMain.handle('delete-photo', async (event, filename_) => {
    console.log(`delete-photo: ${filename_}`);
    try {
        const sep = filename_.includes('§') ? '§' : (filename_.includes('Â§') ? 'Â§' : null);
        if (!sep || !filename_.includes(sep)) {
            return { success: false, message: 'Formato filename non valido (separatore mancante)' };
        }
        const folder = filename_.split(sep)[0];
        const filename = filename_.split(sep).slice(1).join(sep);
        if (!folder || !filename) {
            return { success: false, message: 'Cartella o filename mancanti' };
        }

        const mapped = buildPhotoPathCandidates(folder, filename);
        let filePath = null;
        for (let i = 0; i < mapped.candidates.length; i++) {
          try {
            await fs.access(mapped.candidates[i]);
            filePath = mapped.candidates[i];
            break;
          } catch (_) {}
        }

        if (!filePath) {
          const error = { code: 'ENOENT' };
          if (error && error.code === 'ENOENT') {
            console.warn(`Foto gia' assente, considero la cancellazione completata: ${mapped.candidates[0]}`);
            return { success: true, message: `Foto ${filename} gia' assente` };
          }
        }

        await fs.unlink(filePath);
        console.log(`Foto cancellata: ${filePath}`);
        return { success: true, message: `Foto ${filename} cancellata con successo` };
    } catch (error) {
        console.error(`Errore durante la cancellazione:`, error);
        return { success: false, message: `Errore: ${error.message}` };
    }
});

ipcMain.handle('upload-photo', async (event, filename_) => {
  console.log(`upload-photo: ${filename_}`);

  let folder, filename;
  try {
    const sep = filename_.includes('§') ? '§' : (filename_.includes('Â§') ? 'Â§' : null);
    if (!sep) return { success: false, message: 'Formato filename non valido (separatore mancante)' };
    folder = filename_.split(sep)[0];
    filename = filename_.split(sep).slice(1).join(sep);
    if (!folder || !filename) return { success: false, message: 'Cartella o filename mancanti' };

    const mapped = buildPhotoPathCandidates(folder, filename);
    const safeFolder = mapped.preferredFolder;
    const safeFilename = mapped.safeFilename;
    let filePath = null;
    for (let i = 0; i < mapped.candidates.length; i++) {
      try {
        await fs.access(mapped.candidates[i]);
        filePath = mapped.candidates[i];
        break;
      } catch (_) {}
    }
    if (!filePath) {
      filePath = mapped.candidates[0];
      await fs.access(filePath);
    }

    const host = process.env.SFTP_HOST;
    const username = process.env.SFTP_USERNAME;
    const password = process.env.SFTP_PASSWORD;
    const privateKeyPath = process.env.SFTP_PRIVATE_KEY_PATH;
    const port = Number(process.env.SFTP_PORT || '22');
    const remoteBasePath = process.env.SFTP_REMOTE_BASE_PATH;

    if (!host || !username || (!password && !privateKeyPath) || !remoteBasePath) {
      return {
        success: false,
        message: 'Config SFTP mancante. Imposta SFTP_HOST, SFTP_USERNAME, SFTP_PASSWORD o SFTP_PRIVATE_KEY_PATH, SFTP_REMOTE_BASE_PATH.'
      };
    }

    const sftp = new Client();
    const config = { host, port, username };

    if (password) config.password = password;
    if (privateKeyPath) config.privateKey = await fs.readFile(privateKeyPath);

    await sftp.connect(config);
    const remotePath = path.posix.join(remoteBasePath, safeFolder, 'gallery', safeFilename);
    await sftp.put(filePath, remotePath);
    await sftp.end();

    return { success: true, message: `Foto ${filename} caricata su ${remotePath}` };
  } catch (error) {
    console.error(`Errore durante l'upload di ${filename_ || filename}:`, error);
    return { success: false, message: `Errore: ${error.message}` };
  }
});

process.on('uncaughtException', (err) => {
  console.error('[MS] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[MS] unhandledRejection:', reason);
});

// ── SETTINGS IPC ────────────────────────────────────────────────────────────
ipcMain.handle('get-save-folder', async () => {
  const p = getPhotoRootPath();
  await fs.mkdir(p, { recursive: true });
  return p;
});

ipcMain.handle('set-current-event-folder', async (_event, eventName) => {
  try {
    const folder = setCurrentEventFolderName(eventName || '');
    return { success: true, folder };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('save-captured-photo', async (_event, payload) => {
  try {
    const dataUrl = String(payload && payload.dataUrl ? payload.dataUrl : '').trim();
    const rawFileName = String(payload && payload.fileName ? payload.fileName : '').trim();
    const rawEventName = String(payload && payload.eventName ? payload.eventName : '').trim();

    if (!dataUrl) {
      return { success: false, message: 'Dati immagine mancanti' };
    }

    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) {
      return { success: false, message: 'Formato dataUrl non valido' };
    }

    const mime = m[1].toLowerCase();
    const b64 = m[2];
    let ext = '.jpg';
    if (mime.indexOf('png') >= 0) ext = '.png';
    else if (mime.indexOf('webp') >= 0) ext = '.webp';

    let eventFolder = getCurrentEventFolderName();
    if (rawEventName) {
      eventFolder = setCurrentEventFolderName(rawEventName);
    }

    let fileName = path.basename(rawFileName || '').trim();
    if (fileName.includes('§')) {
      const sep = fileName.includes('§') ? '§' : 'Â§';
      const p = fileName.split(sep);
      if (p.length > 1) {
        eventFolder = resolveEventFolderName(p[0]);
        fileName = path.basename(p.slice(1).join(sep)).trim();
      }
    }

    if (!fileName) {
      fileName = 'foto_' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + ext;
    }
    if (!/\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
      fileName += ext;
    }

    const rootPath = getPhotoRootPath();
    const folderPath = path.join(rootPath, eventFolder);
    await fs.mkdir(folderPath, { recursive: true });
    const targetPath = path.join(folderPath, fileName);

    const bytes = Buffer.from(b64, 'base64');
    await fs.writeFile(targetPath, bytes);

    return {
      success: true,
      path: targetPath,
      folder: eventFolder,
      fileName,
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('set-save-folder', async (event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') {
    return { success: false, message: 'Percorso non valido' };
  }
  try {
    const finalPath = normalizePhotoRootPath(folderPath);
    await fs.mkdir(finalPath, { recursive: true });
    saveSettings({ photoSavePath: finalPath });
    return { success: true, path: finalPath };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('choose-save-folder', async () => {
  if (!mainWindow) return { success: false };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Scegli cartella di salvataggio foto',
    defaultPath: getPhotoRootPath(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) {
    return { success: false, canceled: true };
  }
  const folderPath = result.filePaths[0];
  try {
    const finalPath = normalizePhotoRootPath(folderPath);
    await fs.mkdir(finalPath, { recursive: true });
    saveSettings({ photoSavePath: finalPath });
    return { success: true, path: finalPath };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('choose-frame-file', async () => {
  if (!mainWindow) return { success: false };
  const result = await dialog.showOpenDialog({
    title: 'Scegli cornice (formato 2:3 per SELPHY)',
    properties: ['openFile'],
    filters: [
      { name: 'Immagini', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'PNG trasparente (consigliato)', extensions: ['png'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) {
    return { success: false, canceled: true };
  }
  const filePath = result.filePaths[0];
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    const mime = mimeMap[ext] || 'image/png';
    return { success: true, b64: data.toString('base64'), mime, name: path.basename(filePath) };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

app.whenReady().then(() => {
  // Protocollo mslocal:// per servire file locali (cornici) alla pagina https://
  protocol.handle('mslocal', (request) => {
    const url = new URL(request.url);
    // mslocal://localhost/<encoded-absolute-path>
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return net.fetch('file:///' + filePath);
  });
  createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
