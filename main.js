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
  return path.normalize(base);
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

function extractPhotoSeqId(fileName) {
  const name = String(fileName || '').trim();
  if (!name) return null;
  const m = name.match(/_(\d{1,8})\.(?:jpg|jpeg|png|webp)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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

function resolvePhotoPathByEventAndId(rawFolder, rawId) {
  const idDigits = String(rawId || '').replace(/\D+/g, '');
  const seq = parseInt(idDigits, 10);
  if (!Number.isFinite(seq) || seq <= 0) return null;

  const folders = [];
  const pushFolder = (name) => {
    const v = String(name || '').trim();
    if (!v) return;
    if (folders.indexOf(v) < 0) folders.push(v);
  };

  const safeRaw = getSafeEventFolderName(rawFolder || '');
  if (safeRaw && safeRaw !== 'evento_senza_nome') pushFolder(safeRaw);
  pushFolder(getCurrentEventFolderName());
  pushFolder(resolveEventFolderName(rawFolder));

  const root = getPhotoRootPath();
  for (let fi = 0; fi < folders.length; fi++) {
    const folderPath = path.join(root, folders[fi]);
    let names = [];
    try {
      names = fsSync.readdirSync(folderPath);
    } catch (_) {
      names = [];
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!/\.(jpg|jpeg|png|webp)$/i.test(name)) continue;
      if (extractPhotoSeqId(name) === seq) {
        return path.join(folderPath, name);
      }
    }
  }
  return null;
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
    const idMatch = String(imageName || '').trim().match(/^id\s*[:#-]?\s*(\d{1,8})$/i);
    if (idMatch) {
      const byIdPath = resolvePhotoPathByEventAndId(folder, idMatch[1]);
      if (byIdPath) {
        try { console.log('[print] gallery-id resolve', { folder, id: idMatch[1], path: byIdPath }); } catch (_) {}
        return byIdPath;
      }
    }
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

// ────────────────────────────────────────────────────────────────────────
// Printer state module
// Una sola stampa alla volta. La coda di Windows e' usata SOLO come
// fonte di stato reale (Get-PrintJob/Get-Printer). Nessuna accodazione.
// ────────────────────────────────────────────────────────────────────────
const { execFile } = require('child_process');
const MS_PRINTER_CONFIG_PATH = path.join(__dirname, 'ms-printer-config.json');
let selectedPrinterName = '';
let activePrintJob = null; // { brokerJobId, fileName, startedAt }
let lastPrinterState = null;
let lastPrinterStateTs = 0;
let lastPrinterDiagSig = '';
let printerStatePollTimer = null;
const PRINTER_STATE_CACHE_MS = 1500;
const ACTIVE_PRINT_JOB_GRACE_MS = 8000;

let printCalibration = { offsetXmm: 0, offsetYmm: 0, zoomPct: 100 };

function msClampCalibration(c) {
  const ox = Math.max(-20, Math.min(20, Number(c && c.offsetXmm) || 0));
  const oy = Math.max(-20, Math.min(20, Number(c && c.offsetYmm) || 0));
  const z  = Math.max(80,  Math.min(120, Number(c && c.zoomPct)   || 100));
  return { offsetXmm: Math.round(ox * 10) / 10, offsetYmm: Math.round(oy * 10) / 10, zoomPct: Math.round(z * 10) / 10 };
}

function msLoadPersistedPrinter() {
  try {
    const raw = fsSync.readFileSync(MS_PRINTER_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.name === 'string') {
      selectedPrinterName = parsed.name.trim();
    }
    if (parsed && parsed.calibration && typeof parsed.calibration === 'object') {
      printCalibration = msClampCalibration(parsed.calibration);
    }
  } catch (_) {}
}
function msSavePersistedPrinter() {
  try {
    fsSync.writeFileSync(MS_PRINTER_CONFIG_PATH, JSON.stringify({ name: selectedPrinterName, calibration: printCalibration }), 'utf8');
  } catch (_) {}
}
msLoadPersistedPrinter();

function msEscapePsName(name) {
  return String(name || '').replace(/'/g, "''");
}

function msIsBrokerUnavailableError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return (
    msg.includes('broker.token') ||
    msg.includes('token broker non trovato') ||
    msg.includes('print broker non disponibile') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('networkerror')
  );
}

function msSubmitDirectWindowsPrint(imagePath, printerName, opts) {
  return new Promise((resolve, reject) => {
    try {
      const scriptPath = path.join(__dirname, 'ms-direct-print.ps1');
      const cal = msClampCalibration(opts && opts.calibration ? opts.calibration : printCalibration);
      const isTest = !!(opts && opts.testPattern);
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-PrinterName', printerName,
        '-OffsetXmm', String(cal.offsetXmm),
        '-OffsetYmm', String(cal.offsetYmm),
        '-ZoomPct',  String(cal.zoomPct),
      ];
      if (isTest) {
        args.push('-TestPattern');
      } else {
        args.push('-ImagePath', imagePath);
      }
      execFile(
        'powershell.exe',
        args,
        { windowsHide: true, timeout: 60000 },
        (err, stdout, stderr) => {
          try {
            if (stdout) console.log('[ms-direct-print stdout]', String(stdout).trim());
            if (stderr) console.warn('[ms-direct-print stderr]', String(stderr).trim());
          } catch (_) {}
          if (err) {
            reject(new Error('DirectPrintFailed: ' + (err.message || 'powershell ms-direct-print failed')));
            return;
          }
          resolve({
            id: 'direct-' + Date.now(),
            mode: 'direct',
          });
        }
      );
    } catch (e) {
      reject(new Error('DirectPrintException: ' + (e && e.message ? e.message : String(e))));
    }
  });
}

function msReadWindowsPrintQueue(printerName) {
  return new Promise((resolve) => {
    if (!printerName) {
      resolve({ ok: false, jobs: [], printerStatus: '', message: 'Stampante non selezionata' });
      return;
    }
    const escaped = msEscapePsName(printerName);
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$p=Get-Printer -Name '" + escaped + "' 2>$null | Select-Object -First 1 Name,PrinterStatus,JobCount,WorkOffline,PrinterState,ExtendedPrinterStatus;" +
      "$j=@(Get-PrintJob -PrinterName '" + escaped + "' 2>$null | Select-Object Id,JobStatus,DocumentName,Position,TotalPages,PagesPrinted,Size);" +
      "$wmiFilter = \"Name='\" + ('" + escaped + "' -replace \"'\",\"''\") + \"'\";" +
      "$w=Get-CimInstance -ClassName Win32_Printer -Filter $wmiFilter 2>$null | Select-Object -First 1 PrinterStatus,PrinterState,DetectedErrorState,WorkOffline,Status,Availability;" +
      "$kw='SELPHY';" +
      "if ($p -and $p.Name) { $tok = ($p.Name -split ' ' | Where-Object { $_.Length -ge 4 } | Select-Object -First 1); if ($tok) { $kw=$tok } };" +
      "$pnp=@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like ('*'+$kw+'*') } | Select-Object FriendlyName,Status,Class);" +
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "(@{ printer=$p; jobs=$j; wmi=$w; pnp=$pnp; kw=$kw } | ConvertTo-Json -Depth 5 -Compress)";
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4500, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) {
          resolve({ ok: false, jobs: [], printerStatus: '', message: err.message || 'PowerShell error' });
          return;
        }
        try {
          const txt = String(stdout || '').trim();
          if (!txt) {
            resolve({ ok: true, jobs: [], printerStatus: '', message: '' });
            return;
          }
          const parsed = JSON.parse(txt);
          const rawJobs = (parsed && parsed.jobs) ? parsed.jobs : null;
          const jobsArr = Array.isArray(rawJobs) ? rawJobs : (rawJobs ? [rawJobs] : []);
          const printer = parsed && parsed.printer ? parsed.printer : null;
          const wmi = parsed && parsed.wmi ? parsed.wmi : null;
          const pnpRaw = parsed && parsed.pnp ? parsed.pnp : null;
          const pnpArr = Array.isArray(pnpRaw) ? pnpRaw : (pnpRaw ? [pnpRaw] : []);
          const pnpPresent = pnpArr.length > 0;
          const pnpOk = pnpArr.some((d) => String(d && d.Status || '').toUpperCase() === 'OK');
          const kw = String((parsed && parsed.kw) || '').trim();
          resolve({
            ok: true,
            printerFound: !!printer,
            wmiFound: !!wmi,
            wmiPrinterStatus: Number((wmi && wmi.PrinterStatus) || 0),
            wmiPrinterState: Number((wmi && wmi.PrinterState) || 0),
            wmiDetectedErrorState: Number((wmi && wmi.DetectedErrorState) || 0),
            wmiWorkOffline: !!(wmi && wmi.WorkOffline),
            wmiAvailability: Number((wmi && wmi.Availability) || 0),
            pnpPresent: !!pnpPresent,
            pnpOk: !!pnpOk,
            pnpDevices: pnpArr.map((d) => ({ name: String((d && d.FriendlyName) || ''), status: String((d && d.Status) || '') })),
            pnpKeyword: kw,
            jobs: jobsArr.map((j) => ({
              id: (j && (j.Id != null ? j.Id : 0)) || 0,
              status: String((j && j.JobStatus) || ''),
              name: String((j && j.DocumentName) || ''),
              position: Number((j && j.Position) || 0),
              totalPages: Number((j && j.TotalPages) || 0),
              pagesPrinted: Number((j && j.PagesPrinted) || 0),
              size: Number((j && j.Size) || 0),
            })),
            printerStatus: String((printer && printer.PrinterStatus) || ''),
            jobCount: Number((printer && printer.JobCount) || 0),
            workOffline: !!(printer && printer.WorkOffline),
            printerState: String((printer && printer.PrinterState) || ''),
            extendedPrinterStatus: String((printer && printer.ExtendedPrinterStatus) || ''),
            message: '',
          });
        } catch (e) {
          resolve({ ok: false, jobs: [], printerStatus: '', message: 'ParseError: ' + e.message });
        }
      });
    } catch (e) {
      resolve({ ok: false, jobs: [], printerStatus: '', message: e.message });
    }
  });
}

function msClassifyPrinterStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return { kind: 'unknown', label: '' };

  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n === 7) return { kind: 'offline', label: 'Stampante offline' };
    if (n === 4 || n === 5) return { kind: 'busy', label: 'Stampa in corso' };
    if (n === 3) return { kind: 'ready', label: 'Pronta' };
    if (n === 6) return { kind: 'error', label: 'Stampante in pausa' };
  }

  if (s.includes('offline')) return { kind: 'offline', label: 'Stampante offline' };
  if (s.includes('papererror') || s.includes('paperout') || s.includes('paper out') || s.includes('paperjam') || s.includes('paper jam') || s.includes('jam')) {
    return { kind: 'error', label: 'Carta esaurita / inceppamento' };
  }
  if (s.includes('dooropen') || s.includes('door open') || s.includes('coveropen')) {
    return { kind: 'error', label: 'Coperchio aperto' };
  }
  if (s.includes('error')) return { kind: 'error', label: 'Errore stampante' };
  if (s.includes('paused')) return { kind: 'error', label: 'Stampante in pausa' };
  if (s.includes('printing') || s.includes('busy') || s.includes('ioactive') || s.includes('processing') || s.includes('warmingup') || s.includes('warming up')) {
    return { kind: 'busy', label: 'Stampa in corso' };
  }
  if (s.includes('normal') || s.includes('idle') || s.includes('ready')) return { kind: 'ready', label: 'Pronta' };
  return { kind: 'unknown', label: raw };
}

async function msComputePrinterState(force) {
  const now = Date.now();
  if (!force && lastPrinterState && (now - lastPrinterStateTs) < PRINTER_STATE_CACHE_MS) {
    return lastPrinterState;
  }
  const printerName = selectedPrinterName || '';
  if (!printerName) {
    const st = { printerName: '', status: 'no-printer', label: 'Seleziona una stampante', jobs: [], jobCount: 0, hasActiveJob: false, activeJobId: null, rawPrinterStatus: '', message: '', progress: 0 };
    lastPrinterState = st; lastPrinterStateTs = now;
    return st;
  }
  const q = await msReadWindowsPrintQueue(printerName);
  const hasQueueJobs = !!(q.jobs && q.jobs.length > 0);
  if (!hasQueueJobs && activePrintJob) {
    const startedAt = Number(activePrintJob.startedAt) || now;
    if ((now - startedAt) >= ACTIVE_PRINT_JOB_GRACE_MS) {
      activePrintJob = null;
    }
  }
  let status = 'ready';
  let label = 'Pronta';
  if (!q.ok) {
    status = 'offline';
    label = q.message || 'Stampante non raggiungibile';
  } else {
    const rawStatus = String(q.printerStatus || '').trim();
    const rawState = String(q.printerState || '').trim();
    const rawExtended = String(q.extendedPrinterStatus || '').trim();
    const cls = msClassifyPrinterStatus([rawStatus, rawState, rawExtended].filter(Boolean).join(' '));
    if (hasQueueJobs || activePrintJob) {
      status = 'busy';
      label = 'Stampa in corso';
    } else if (!q.printerFound) {
      status = 'offline';
      label = 'Stampante non trovata';
    } else if (q.workOffline || q.wmiWorkOffline) {
      status = 'offline';
      label = 'Stampante offline';
    } else if (q.wmiFound && Number(q.wmiPrinterStatus) === 7) {
      status = 'offline';
      label = 'Stampante offline';
    } else if (q.pnpKeyword && !q.pnpPresent) {
      status = 'offline';
      label = 'Stampante spenta o scollegata';
    } else if (q.pnpKeyword && q.pnpPresent && !q.pnpOk) {
      status = 'error';
      label = 'Errore dispositivo USB';
    } else if (q.wmiFound && Number(q.wmiPrinterStatus) === 6) {
      status = 'error';
      label = 'Stampante in pausa';
    } else if (q.wmiFound && (Number(q.wmiPrinterStatus) === 4 || Number(q.wmiPrinterStatus) === 5)) {
      status = 'busy';
      label = 'Stampa in corso';
    } else if (!rawStatus && !rawState && !rawExtended) {
      status = 'ready';
      label = 'Pronta';
    } else if (!rawStatus) {
      status = 'offline';
      label = 'Stampante spenta o scollegata';
    } else if (cls.kind === 'offline') {
      status = 'offline';
      label = cls.label;
    } else if (cls.kind === 'error') {
      status = 'error';
      label = cls.label;
    } else if (cls.kind === 'unknown') {
      status = 'offline';
      label = 'Stato stampante non rilevato';
    } else {
      status = 'ready';
      label = 'Pronta';
    }
  }
  let progress = 0;
  if (hasQueueJobs) {
    const j = q.jobs[0];
    if (j.totalPages > 0) progress = Math.min(100, Math.round((j.pagesPrinted / j.totalPages) * 100));
    else if (activePrintJob) progress = Math.min(95, Math.round((Date.now() - activePrintJob.startedAt) / 600));
  } else if (activePrintJob && status === 'busy') {
    progress = Math.min(95, Math.round((Date.now() - activePrintJob.startedAt) / 600));
  }
  const state = {
    printerName,
    status,
    label,
    jobs: q.jobs || [],
    jobCount: (q.jobs || []).length,
    hasActiveJob: !!activePrintJob,
    activeJobId: activePrintJob ? activePrintJob.brokerJobId : null,
    rawPrinterStatus: q.printerStatus || '',
    message: q.message || '',
    progress,
  };
  try {
    const diagSig = [
      state.printerName || '',
      String(q.ok ? 'ok' : 'err'),
      q.printerFound ? '1' : '0',
      String(state.rawPrinterStatus || '').trim(),
      q.workOffline ? '1' : '0',
      String(q.printerState || '').trim(),
      String(q.extendedPrinterStatus || '').trim(),
      q.wmiFound ? '1' : '0',
      String(Number(q.wmiPrinterStatus || 0)),
      String(Number(q.wmiPrinterState || 0)),
      String(Number(q.wmiDetectedErrorState || 0)),
      q.wmiWorkOffline ? '1' : '0',
      String(q.pnpKeyword || ''),
      q.pnpPresent ? '1' : '0',
      q.pnpOk ? '1' : '0',
      String(state.status || ''),
      String(state.jobCount || 0),
      state.hasActiveJob ? '1' : '0',
      String(state.message || ''),
    ].join('|');
    if (diagSig !== lastPrinterDiagSig) {
      lastPrinterDiagSig = diagSig;
      console.log('[printer-state raw] name=%s ok=%s found=%s raw="%s" workOffline=%s pState="%s" ext="%s" wmi{found=%s,status=%d,state=%d,err=%d,off=%s,avail=%d} pnp{kw=%s,present=%s,ok=%s,n=%d} status=%s jobs=%d active=%s msg="%s"',
        state.printerName || '-',
        q.ok ? 'true' : 'false',
        q.printerFound ? '1' : '0',
        String(state.rawPrinterStatus || ''),
        q.workOffline ? '1' : '0',
        String(q.printerState || ''),
        String(q.extendedPrinterStatus || ''),
        q.wmiFound ? '1' : '0',
        Number(q.wmiPrinterStatus || 0),
        Number(q.wmiPrinterState || 0),
        Number(q.wmiDetectedErrorState || 0),
        q.wmiWorkOffline ? '1' : '0',
        Number(q.wmiAvailability || 0),
        String(q.pnpKeyword || ''),
        q.pnpPresent ? '1' : '0',
        q.pnpOk ? '1' : '0',
        Array.isArray(q.pnpDevices) ? q.pnpDevices.length : 0,
        state.status,
        Number(state.jobCount || 0),
        state.hasActiveJob ? '1' : '0',
        String(state.message || ''));
    }
  } catch (_) {}
  lastPrinterState = state;
  lastPrinterStateTs = now;
  return state;
}

function msBroadcastPrinterState(state) {
  try {
    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
          w.webContents.send('printer-state', state);
        }
      } catch (_) {}
    });
  } catch (_) {}
}

function msStartPrinterPolling() {
  if (printerStatePollTimer) return;
  printerStatePollTimer = setInterval(async () => {
    try {
      const st = await msComputePrinterState(true);
      msBroadcastPrinterState(st);
      if (activePrintJob && (st.jobs || []).length === 0) {
        activePrintJob = null;
        msBroadcastPrinterState(await msComputePrinterState(true));
      }
    } catch (_) {}
  }, 2000);
}
try { msStartPrinterPolling(); } catch (_) {}

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
      var __msFrameOpaqueProbeCache = Object.create(null);
      var __msDefaultPreviewRect = { left: 0.0767, top: 0.1094, width: 0.8466, height: 0.7812 };

      function __msClamp01(v) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > 1) return 1;
        return n;
      }

      function __msNormalizePreviewRect(rect, fallback) {
        var fb = fallback || __msDefaultPreviewRect;
        var source = (rect && typeof rect === 'object') ? rect : fb;
        var width = __msClamp01(source.width);
        var height = __msClamp01(source.height);
        if (width <= 0 || height <= 0) {
          width = __msClamp01(fb.width);
          height = __msClamp01(fb.height);
        }
        // A offset 0 la foto deve risultare centrata sul foglio (orizzontale e
        // verticale), mantenendo le dimensioni del foro rilevato. Cosi'
        // calibrazione, live, post-scatto e salvataggio restano allineati.
        return {
          left: __msClamp01((1 - width) / 2),
          top: __msClamp01((1 - height) / 2),
          width: width,
          height: height
        };
      }

      function __msApplyPreviewRectVars(ft, rect) {
        if (!ft || !rect) return;
        var normalized = __msNormalizePreviewRect(rect, __msDefaultPreviewRect);
        var left = normalized.left;
        var top = normalized.top;
        var width = normalized.width;
        var height = normalized.height;
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

          function componentScan(alphaMax) {
            var total = w * h;
            var seen = new Uint8Array(total);
            var qx = new Int32Array(total);
            var qy = new Int32Array(total);
            var best = null;

            for (var sy = 0; sy < h; sy++) {
              for (var sx = 0; sx < w; sx++) {
                var startIdx = sy * w + sx;
                if (seen[startIdx] || data[startIdx * 4 + 3] > alphaMax) continue;

                var head = 0;
                var tail = 0;
                var minX = sx;
                var maxX = sx;
                var minY = sy;
                var maxY = sy;
                var count = 0;
                var touchesBorder = false;
                var rowMin = Object.create(null);
                var rowMax = Object.create(null);
                var rowCount = Object.create(null);
                var colMin = Object.create(null);
                var colMax = Object.create(null);
                var colCount = Object.create(null);

                seen[startIdx] = 1;
                qx[tail] = sx;
                qy[tail] = sy;
                tail++;

                while (head < tail) {
                  var x0 = qx[head];
                  var y0 = qy[head];
                  head++;
                  count++;
                  if (x0 < minX) minX = x0;
                  if (x0 > maxX) maxX = x0;
                  if (y0 < minY) minY = y0;
                  if (y0 > maxY) maxY = y0;
                  if (x0 === 0 || y0 === 0 || x0 === w - 1 || y0 === h - 1) touchesBorder = true;
                  if (rowCount[y0] === undefined) { rowCount[y0] = 0; rowMin[y0] = x0; rowMax[y0] = x0; }
                  rowCount[y0]++;
                  if (x0 < rowMin[y0]) rowMin[y0] = x0;
                  if (x0 > rowMax[y0]) rowMax[y0] = x0;
                  if (colCount[x0] === undefined) { colCount[x0] = 0; colMin[x0] = y0; colMax[x0] = y0; }
                  colCount[x0]++;
                  if (y0 < colMin[x0]) colMin[x0] = y0;
                  if (y0 > colMax[x0]) colMax[x0] = y0;

                  var nx, ny, ni;
                  nx = x0 + 1; ny = y0;
                  if (nx < w) {
                    ni = ny * w + nx;
                    if (!seen[ni] && data[ni * 4 + 3] <= alphaMax) { seen[ni] = 1; qx[tail] = nx; qy[tail] = ny; tail++; }
                  }
                  nx = x0 - 1; ny = y0;
                  if (nx >= 0) {
                    ni = ny * w + nx;
                    if (!seen[ni] && data[ni * 4 + 3] <= alphaMax) { seen[ni] = 1; qx[tail] = nx; qy[tail] = ny; tail++; }
                  }
                  nx = x0; ny = y0 + 1;
                  if (ny < h) {
                    ni = ny * w + nx;
                    if (!seen[ni] && data[ni * 4 + 3] <= alphaMax) { seen[ni] = 1; qx[tail] = nx; qy[tail] = ny; tail++; }
                  }
                  nx = x0; ny = y0 - 1;
                  if (ny >= 0) {
                    ni = ny * w + nx;
                    if (!seen[ni] && data[ni * 4 + 3] <= alphaMax) { seen[ni] = 1; qx[tail] = nx; qy[tail] = ny; tail++; }
                  }
                }

                var relW = (maxX - minX + 1) / w;
                var relH = (maxY - minY + 1) / h;
                if (touchesBorder || relW < 0.30 || relH < 0.30 || relW > 0.98 || relH > 0.98) continue;
                if (!best || count > best.count) {
                  var median = function(values) {
                    values.sort(function(a, b) { return a - b; });
                    var mid = Math.floor(values.length / 2);
                    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
                  };
                  var rowLefts = [];
                  var rowRights = [];
                  var minRowPixels = Math.max(12, Math.round(w * 0.04));
                  Object.keys(rowCount).forEach(function(k) {
                    if (rowCount[k] >= minRowPixels) {
                      rowLefts.push(rowMin[k]);
                      rowRights.push(rowMax[k]);
                    }
                  });
                  var colTops = [];
                  var colBottoms = [];
                  var minColPixels = Math.max(12, Math.round(h * 0.04));
                  Object.keys(colCount).forEach(function(k) {
                    if (colCount[k] >= minColPixels) {
                      colTops.push(colMin[k]);
                      colBottoms.push(colMax[k]);
                    }
                  });
                  if (rowLefts.length >= 8 && colTops.length >= 8) {
                    minX = Math.round(median(rowLefts));
                    maxX = Math.round(median(rowRights));
                    minY = Math.round(median(colTops));
                    maxY = Math.round(median(colBottoms));
                  }
                  best = { count: count, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
                }
              }
            }

            if (!best) return null;
            var padX = 1 / w;
            var padY = 1 / h;
            var left = __msClamp01(best.minX / w + padX);
            var top = __msClamp01(best.minY / h + padY);
            var width = __msClamp01((best.maxX - best.minX + 1) / w - padX * 2);
            var height = __msClamp01((best.maxY - best.minY + 1) / h - padY * 2);
            if (width < 0.30 || height < 0.30) return null;
            return { left: left, top: top, width: width, height: height };
          }

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

          return componentScan(8) || componentScan(20) || componentScan(36) || scan(8) || scan(20) || scan(36) || null;
        } catch (_) {
          return null;
        }
      }

      function __msComputeOpaqueRectFromImage(img) {
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

          var minX = w, minY = h, maxX = -1, maxY = -1;
          for (var y = 0; y < h; y++) {
            var row = y * w * 4;
            for (var x = 0; x < w; x++) {
              var a = data[row + x * 4 + 3];
              if (a > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX <= minX || maxY <= minY) return null;

          var left = __msClamp01(minX / w);
          var top = __msClamp01(minY / h);
          var width = __msClamp01((maxX - minX + 1) / w);
          var height = __msClamp01((maxY - minY + 1) / h);
          if (width < 0.3 || height < 0.3) return null;
          return { left: left, top: top, width: width, height: height };
        } catch (_) {
          return null;
        }
      }

      function __msApplyOpaqueRectVars(ft, rect) {
        if (!ft || !rect) return;
        ft.style.setProperty('--ms-frame-left', String(__msClamp01(rect.left)), 'important');
        ft.style.setProperty('--ms-frame-top', String(__msClamp01(rect.top)), 'important');
        ft.style.setProperty('--ms-frame-w', String(__msClamp01(rect.width)), 'important');
        ft.style.setProperty('--ms-frame-h', String(__msClamp01(rect.height)), 'important');
      }

      function __msResetOpaqueRectVars(ft) {
        if (!ft) return;
        try { ft.style.removeProperty('--ms-frame-left'); } catch (_) {}
        try { ft.style.removeProperty('--ms-frame-top'); } catch (_) {}
        try { ft.style.removeProperty('--ms-frame-w'); } catch (_) {}
        try { ft.style.removeProperty('--ms-frame-h'); } catch (_) {}
      }

      function __msEnsureOpaqueRect(ft, frameSrc) {
        if (!ft) return;
        var src = String(frameSrc || '').trim();
        if (!src) {
          __msResetOpaqueRectVars(ft);
          try { ft.__msOpaqueRectSrc = ''; } catch (_) {}
          return;
        }

        var cached = __msFrameOpaqueProbeCache[src];
        if (cached && cached.done) {
          if (cached.rect) __msApplyOpaqueRectVars(ft, cached.rect);
          else __msResetOpaqueRectVars(ft);
          return;
        }
        if (cached && !cached.done) return;

        __msFrameOpaqueProbeCache[src] = { done: false, rect: null };
        var probe = new Image();
        try { probe.crossOrigin = 'anonymous'; } catch (_) {}
        probe.onload = function() {
          var rect = __msComputeOpaqueRectFromImage(probe);
          __msFrameOpaqueProbeCache[src] = { done: true, rect: rect };
          if (!ft || !ft.isConnected) return;
          if (String(ft.__msOpaqueRectSrc || '') !== src) return;
          if (rect) __msApplyOpaqueRectVars(ft, rect);
          else __msResetOpaqueRectVars(ft);
        };
        probe.onerror = function() {
          __msFrameOpaqueProbeCache[src] = { done: true, rect: null };
          if (!ft || !ft.isConnected) return;
          if (String(ft.__msOpaqueRectSrc || '') !== src) return;
          __msResetOpaqueRectVars(ft);
        };
        probe.src = src;
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
          var rect = __msNormalizePreviewRect(__msComputeTransparentRectFromImage(probe), __msDefaultPreviewRect);
          __msPreviewFrameProbeCache[src] = { done: true, rect: rect };
          if (!ft || !ft.isConnected) return;
          if (String(ft.__msPreviewRectSrc || '') !== src) return;
          __msApplyPreviewRectVars(ft, rect);
        };
        probe.onerror = function() {
          __msPreviewFrameProbeCache[src] = { done: true, rect: null };
          if (!ft || !ft.isConnected) return;
          if (String(ft.__msPreviewRectSrc || '') !== src) return;
          __msResetPreviewRectVars(ft);
        };
        probe.src = src;
      }

      function __msGetPreviewRectForSource(frameSrc) {
        try {
          var src = String(frameSrc || '').trim();
          if (!src) return null;
          var cached = __msPreviewFrameProbeCache[src];
          if (cached && cached.done) return __msNormalizePreviewRect(cached.rect, __msDefaultPreviewRect);
          if (!cached) {
            __msPreviewFrameProbeCache[src] = { done: false, rect: null };
            var probe = new Image();
            try { probe.crossOrigin = 'anonymous'; } catch (_) {}
            probe.onload = function() {
              var rect = __msNormalizePreviewRect(__msComputeTransparentRectFromImage(probe), __msDefaultPreviewRect);
              __msPreviewFrameProbeCache[src] = { done: true, rect: rect };
              try { if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync(); } catch (_) {}
              try { if (typeof window.__msRefreshCalibrationPreviewSample === 'function') window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
            };
            probe.onerror = function() {
              __msPreviewFrameProbeCache[src] = { done: true, rect: null };
            };
            probe.src = src;
          }
        } catch (_) {}
        return __msNormalizePreviewRect(null, __msDefaultPreviewRect);
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

      function ensureWhiteMasks() {
        var root = getPreferredParent() || document.documentElement || document.body;
        var ids = ['top', 'right', 'bottom', 'left'];
        var out = {};
        for (var i = 0; i < ids.length; i++) {
          var k = ids[i];
          var id = 'ms-session-white-mask-' + k;
          var el = document.getElementById(id);
          if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;background:#000000;pointer-events:none;display:none;margin:0;padding:0;border:0;';
            el.style.setProperty('z-index', '2147483645', 'important');
            root.appendChild(el);
          } else if (root && el.parentNode !== root) {
            root.appendChild(el);
          }
          el.style.setProperty('background', '#000000', 'important');
          out[k] = el;
        }
        return out;
      }

      function hideWhiteMasks() {
        ['top', 'right', 'bottom', 'left'].forEach(function(k) {
          var el = document.getElementById('ms-session-white-mask-' + k);
          if (el) el.style.setProperty('display', 'none', 'important');
        });
      }

      function ensureBlackBackdrop() {
        var root = getPreferredParent() || document.documentElement || document.body;
        var el = document.getElementById('ms-session-black-backdrop');
        if (!el) {
          el = document.createElement('div');
          el.id = 'ms-session-black-backdrop';
          el.style.cssText = 'position:fixed;inset:0;background:#000000;pointer-events:none;display:none;margin:0;padding:0;border:0;';
          el.style.setProperty('z-index', '2147483643', 'important');
          root.appendChild(el);
        } else if (root && el.parentNode !== root) {
          root.appendChild(el);
        }
        el.style.setProperty('position', 'fixed', 'important');
        el.style.setProperty('inset', '0', 'important');
        el.style.setProperty('background', '#000000', 'important');
        el.style.setProperty('display', 'block', 'important');
        el.style.setProperty('z-index', '2147483643', 'important');
        return el;
      }

      function hideBlackBackdrop() {
        var el = document.getElementById('ms-session-black-backdrop');
        if (el) el.style.setProperty('display', 'none', 'important');
      }

      function resolveFrameCalibration() {
        try {
          var clampNum = function(v, min, max, fb) {
            var n = parseFloat(v);
            if (!isFinite(n)) n = fb;
            return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
          };
          var selected = '';
          try { selected = String(localStorage.getItem(SELECTED_KEY) || ''); } catch (_) {}
          var frameKey = 'postcard::' + selected;
          var framePresets = {};
          var presets = {};
          try { framePresets = JSON.parse(localStorage.getItem('ms-cal-frame-presets-v1') || '{}') || {}; } catch (_) { framePresets = {}; }
          try { presets = JSON.parse(localStorage.getItem('ms-cal-presets-v1') || '{}') || {}; } catch (_) { presets = {}; }
          var byFrame = selected ? framePresets[frameKey] : null;
          var base = (byFrame && typeof byFrame === 'object') ? byFrame : (presets.postcard || null);
          if (!base || typeof base !== 'object') base = { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
          return {
            offsetXmm: clampNum(base.offsetXmm, -5, 5, 0),
            offsetYmm: clampNum(base.offsetYmm, -5, 5, 0),
            zoomPct: clampNum(base.zoomPct, 80, 120, 100),
            photoOffsetXmm: clampNum(base.photoOffsetXmm, -5, 5, 0),
            photoOffsetYmm: clampNum(base.photoOffsetYmm, -5, 5, 0),
            photoZoomPct: clampNum(base.photoZoomPct, 80, 120, 100)
          };
        } catch (_) {
          return { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
        }
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
            var __duringCountdown = !!window.__msCountdownActive;
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
            var __oldColPanel = document.getElementById('ms-lv-collage-panel');
            if (__oldColPanel && __oldColPanel.parentNode) __oldColPanel.parentNode.removeChild(__oldColPanel);
            var __oldGrid = document.getElementById('ms-lv-grid');
            if (__oldGrid && __oldGrid.parentNode) __oldGrid.parentNode.removeChild(__oldGrid);
            var __oldLp = document.getElementById('ms-lv-layout-preview');
            if (!__duringCountdown && __oldLp && __oldLp.parentNode) __oldLp.parentNode.removeChild(__oldLp);
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

              // ── Live printer pill ──
              '#ms-lv-printer-pill{position:fixed;top:32px;right:32px;z-index:2147483647;pointer-events:none;' +
              'display:inline-flex;align-items:center;gap:10px;padding:10px 18px;border-radius:999px;' +
              'background:linear-gradient(180deg,rgba(22,22,28,0.62) 0%,rgba(14,14,18,0.66) 100%);' +
              'backdrop-filter:blur(38px) saturate(160%) brightness(1.04);-webkit-backdrop-filter:blur(38px) saturate(160%) brightness(1.04);' +
              'border:1px solid rgba(255,255,255,0.13);' +
              'box-shadow:0 12px 30px rgba(0,0,0,0.50),inset 0 1px 0 rgba(255,255,255,0.07);' +
              'color:rgba(255,255,255,0.92);' +
              'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
              'font-size:14px;font-weight:500;letter-spacing:0.6px;line-height:1;white-space:nowrap;}' +
              '#ms-lv-printer-pill .ms-lv-pp-dot{width:10px;height:10px;border-radius:50%;background:#9ca3af;box-shadow:0 0 6px rgba(255,255,255,0.18);}' +
              '#ms-lv-printer-pill[data-status="ready"] .ms-lv-pp-dot{background:#22c55e;box-shadow:0 0 10px rgba(34,197,94,0.6);}' +
              '#ms-lv-printer-pill[data-status="busy"] .ms-lv-pp-dot{background:#facc15;box-shadow:0 0 10px rgba(250,204,21,0.6);animation:msLvPpPulse 1.4s ease-in-out infinite;}' +
              '#ms-lv-printer-pill[data-status="error"] .ms-lv-pp-dot,#ms-lv-printer-pill[data-status="offline"] .ms-lv-pp-dot{background:#ef4444;box-shadow:0 0 10px rgba(239,68,68,0.6);}' +
              '#ms-lv-printer-pill .ms-lv-pp-bar{position:absolute;left:8px;right:8px;bottom:4px;height:2px;border-radius:2px;background:rgba(255,255,255,0.08);overflow:hidden;}' +
              '#ms-lv-printer-pill .ms-lv-pp-fill{height:100%;width:0;background:linear-gradient(90deg,#facc15,#f97316);transition:width 0.4s ease;}' +
              '@keyframes msLvPpPulse{0%,100%{opacity:1;}50%{opacity:0.55;}}' +

              // ── Pulsante scatto disabilitato durante stampa ──
              '.ms-lv-shoot.is-print-busy{filter:grayscale(0.5) brightness(0.8);opacity:0.65;pointer-events:none!important;cursor:not-allowed!important;animation:none!important;}' +
              '.ms-lv-shoot.is-print-busy::before,.ms-lv-shoot.is-print-busy::after{animation:none!important;}' +

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
          // ── Collage / layout panel + griglia 2x2 (style "Stories") ──
          if (!document.getElementById('ms-lv-collage-css')) {
            var __ccss = document.createElement('style');
            __ccss.id = 'ms-lv-collage-css';
            __ccss.textContent =
              // Griglia live disattivata (richiesta UI pulita senza separatori)
              '#ms-lv-grid{display:none !important;}' +
              // Pannello layout: bottone in alto a destra con tendina opzioni.
              '#ms-lv-collage-panel{position:fixed;right:24px;top:92px;z-index:2147483647;' +
              'display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:8px;' +
              'border-radius:18px;background:rgba(14,14,20,0.50);' +
              'backdrop-filter:blur(28px) saturate(160%);-webkit-backdrop-filter:blur(28px) saturate(160%);' +
              'border:1px solid rgba(255,255,255,0.10);' +
              'box-shadow:0 18px 50px rgba(0,0,0,0.55),inset 0 1px 0 rgba(255,255,255,0.08);' +
              'animation:msColPanelIn 0.45s cubic-bezier(.22,1.2,.36,1) both;}' +
              '@keyframes msColPanelIn{0%{opacity:0;transform:translateY(-10px);}100%{opacity:1;transform:translateY(0);}}' +
              '#ms-lv-collage-panel .ms-col-title{height:62px;border-radius:18px;padding:0 22px;border:1px solid rgba(255,255,255,0.14);' +
              'display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;background:rgba(255,255,255,0.08);' +
              'font-size:15px;font-weight:800;letter-spacing:2.5px;color:rgba(255,255,255,0.92);' +
              'text-transform:uppercase;margin:0;text-align:center;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,sans-serif;}' +
              '#ms-lv-collage-panel .ms-col-title::after{content:"";width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid currentColor;opacity:0.72;transition:transform 0.18s;}' +
              '#ms-lv-collage-panel.is-open .ms-col-title::after{transform:rotate(180deg);}' +
              '#ms-lv-collage-panel .ms-col-btn{position:relative;width:68px;height:68px;border-radius:18px;cursor:pointer;' +
              'display:none;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.14);' +
              'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.92);' +
              'transition:transform 0.18s cubic-bezier(.22,1.2,.36,1),background 0.2s,border-color 0.2s;outline:none;' +
              '-webkit-user-select:none;user-select:none;}' +
              '#ms-lv-collage-panel.is-open .ms-col-btn{display:inline-flex;}' +
              '#ms-lv-collage-panel .ms-col-btn:hover{transform:scale(1.06);background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.28);}' +
              '#ms-lv-collage-panel .ms-col-btn.is-active{background:#ffffff;border-color:#ffffff;color:#0a0a0a;' +
              'box-shadow:0 8px 22px rgba(255,255,255,0.18),inset 0 0 0 1px rgba(0,0,0,0.04);}' +
              '#ms-lv-collage-panel .ms-col-btn.is-active svg{stroke:#0a0a0a;}' +
              '#ms-lv-collage-panel .ms-col-btn svg{width:36px;height:36px;stroke:currentColor;fill:none;stroke-width:1.8;}' +
              // Indicatore progresso scatto (in alto al centro durante la sequenza)
              '#ms-lv-collage-progress{position:fixed;top:32px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
              'display:flex;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(14,14,20,0.55);' +
              'backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);' +
              'border:1px solid rgba(255,255,255,0.12);box-shadow:0 10px 30px rgba(0,0,0,0.45);' +
              'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,sans-serif;' +
              'animation:msColProgIn 0.3s ease-out both;}' +
              '@keyframes msColProgIn{0%{opacity:0;transform:translate(-50%,-12px);}100%{opacity:1;transform:translate(-50%,0);}}' +
              '#ms-lv-collage-progress .ms-col-prog-dot{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,0.22);' +
              'transition:background 0.25s,transform 0.25s;}' +
              '#ms-lv-collage-progress .ms-col-prog-dot.done{background:#22c55e;transform:scale(1.1);}' +
              '#ms-lv-collage-progress .ms-col-prog-dot.cur{background:#fff;transform:scale(1.25);' +
              'box-shadow:0 0 0 3px rgba(255,255,255,0.20);}' +
              // Overlay anteprima layout: celle posizionate sulla preview
              '#ms-lv-layout-preview{position:fixed;inset:0;z-index:2147483644;pointer-events:none;' +
              'display:flex;align-items:center;justify-content:center;}' +
              '#ms-lv-layout-preview .ms-lp-sheet{position:relative;aspect-ratio:2/3;height:96vh;max-width:96vw;width:auto;}' +
              '#ms-lv-layout-preview .ms-lp-backdrop{position:absolute;inset:0;' +
              'background-color:#0b0b12;}' +
              '#ms-lv-layout-preview .ms-lp-cell{position:absolute;box-sizing:border-box;border-radius:10px;' +
              'border:2px solid rgba(255,255,255,0.52);background:rgba(255,255,255,0.04);' +
              'transition:background 0.25s,box-shadow 0.25s,opacity 0.25s;overflow:hidden;}' +
              '#ms-lv-layout-preview .ms-lp-logo{position:absolute;inset:0;z-index:1;pointer-events:none;' +
              'display:flex;align-items:center;justify-content:center;}' +
              '#ms-lv-layout-preview .ms-lp-logo-img{max-width:78%;max-height:78%;width:auto;height:auto;' +
              'object-fit:contain;opacity:0.26;}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="active"]{' +
              'border-color:rgba(255,255,255,0.98);' +
              'box-shadow:inset 0 0 0 2px rgba(255,255,255,0.40),0 0 30px rgba(255,255,255,0.26);' +
              'background:rgba(255,255,255,0.06);animation:msLpPulse 1.6s ease-in-out infinite;}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="done"]{' +
              'border-color:rgba(34,197,94,0.70);box-shadow:inset 0 0 0 1px rgba(34,197,94,0.45);background:rgba(0,0,0,0.10);}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="idle"]{opacity:0.94;}' +
              '#ms-lv-layout-preview .ms-lp-num{position:absolute;top:8px;left:8px;padding:3px 8px;border-radius:999px;' +
              'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,sans-serif;' +
              'font-size:11px;font-weight:800;letter-spacing:1.2px;color:#fff;background:rgba(0,0,0,0.55);' +
              'border:1px solid rgba(255,255,255,0.20);text-shadow:0 1px 4px rgba(0,0,0,0.7);}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="active"] .ms-lp-num{background:#ffffff;color:#0a0a0a;border-color:#fff;}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="done"] .ms-lp-num{background:rgba(34,197,94,0.92);color:#06140a;border-color:rgba(34,197,94,0.8);}' +
              '#ms-lv-layout-preview .ms-lp-thumb{position:absolute;inset:0;z-index:2;width:100%;height:100%;object-fit:cover;opacity:0.95;}' +
              '#ms-lv-layout-preview .ms-lp-live-canvas{position:absolute;inset:0;z-index:2;width:100%;height:100%;pointer-events:none;background:#000;}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="idle"]{background:rgba(0,0,0,0.55);}' +
              '#ms-lv-layout-preview .ms-lp-cell[data-state="active"] .ms-lp-live-canvas{filter:brightness(1.02) saturate(1.05);}' +
              '#ms-lv-layout-preview .ms-lp-bigshot{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);' +
              'padding:8px 18px;border-radius:999px;background:rgba(255,255,255,0.96);color:#0a0a0a;' +
              'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,sans-serif;' +
              'font-size:18px;font-weight:800;letter-spacing:0.6px;' +
              'box-shadow:0 10px 28px rgba(0,0,0,0.45),0 0 0 1px rgba(0,0,0,0.06);' +
              'white-space:nowrap;animation:msLpBigIn 0.4s cubic-bezier(.22,1.2,.36,1) both;}' +
              '@keyframes msLpBigIn{0%{opacity:0;transform:translate(-50%,8px);}100%{opacity:1;transform:translate(-50%,0);}}' +
              '@keyframes msLpPulse{0%,100%{box-shadow:0 0 0 3px rgba(255,255,255,0.18),0 0 28px rgba(255,255,255,0.30);}50%{box-shadow:0 0 0 5px rgba(255,255,255,0.10),0 0 42px rgba(255,255,255,0.18);}}' +
              '';
            (document.head || document.documentElement).appendChild(__ccss);
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
            // Pillola stato stampante in alto a destra (sempre visibile in pre-scatto)
            try {
              var __pp = document.getElementById('ms-lv-printer-pill');
              if (!__pp) {
                __pp = document.createElement('div');
                __pp.id = 'ms-lv-printer-pill';
                __pp.setAttribute('data-status', 'no-printer');
                __pp.innerHTML = '<span class="ms-lv-pp-dot"></span><span class="ms-lv-pp-label">Stampante</span>';
                (document.body || document.documentElement).appendChild(__pp);
              }
              if (window.electronAPI && typeof window.electronAPI.getPrinterState === 'function') {
                if (typeof window.__msSubscribePrinterState === 'function') { try { window.__msSubscribePrinterState(); } catch (_) {} }
                if (typeof window.__msFetchPrinterState === 'function') { try { window.__msFetchPrinterState(true); } catch (_) {} }
                // Polling locale aggiuntivo per aggiornare la pillola in pre-scatto
                if (!window.__msLvPrinterPoll) {
                  window.__msLvPrinterPoll = setInterval(function() {
                    try { if (typeof window.__msFetchPrinterState === 'function') window.__msFetchPrinterState(false); } catch (_) {}
                  }, 2500);
                }
              }
            } catch (_) {}
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
            // ── COLLAGE: definizioni & pannello layout (idempotenti, su window) ──
            if (!window.__msCollageInited) {
              window.__msCollageInited = true;
              window.__MS_COLLAGE_LAYOUTS = {
                '1':      [{x:0,y:0,w:1200,h:1800}],
                '2v':     [{x:0,y:0,w:1200,h:900},{x:0,y:900,w:1200,h:900}],
                '2h':     [{x:0,y:0,w:600,h:1800},{x:600,y:0,w:600,h:1800}],
                '4':      [{x:0,y:0,w:600,h:900},{x:600,y:0,w:600,h:900},{x:0,y:900,w:600,h:900},{x:600,y:900,w:600,h:900}],
                'strip3': [{x:0,y:0,w:1200,h:600},{x:0,y:600,w:1200,h:600},{x:0,y:1200,w:1200,h:600}]
              };
              window.__msGetCollageLayout = function() {
                try {
                  var v = String(localStorage.getItem('msCollageLayoutV1') || '').trim();
                  if (v && window.__MS_COLLAGE_LAYOUTS[v]) return v;
                } catch (_) {}
                return '1';
              };
              window.__msSetCollageLayout = function(k) {
                try { if (window.__MS_COLLAGE_LAYOUTS[k]) localStorage.setItem('msCollageLayoutV1', k); } catch (_) {}
              };
              window.__msDrawSlot = function(ctx, video, slot, gap) {
                gap = gap || 0;
                var x = slot.x + gap, y = slot.y + gap;
                var w = slot.w - gap * 2, h = slot.h - gap * 2;
                if (w <= 0 || h <= 0) return;
                var vw = video && video.videoWidth | 0;
                var vh = video && video.videoHeight | 0;
                if (!vw || !vh) return;
                var slotAR = w / h, vAR = vw / vh;
                var sx = 0, sy = 0, sw = vw, sh = vh;
                if (vAR > slotAR) { sw = vh * slotAR; sx = (vw - sw) / 2; }
                else if (vAR < slotAR) { sh = vw / slotAR; sy = (vh - sh) / 2; }
                ctx.save();
                ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
                ctx.translate(x + w, y); ctx.scale(-1, 1); // mirror selfie
                ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
                ctx.restore();
              };
              // Face detector singleton (Shape Detection API)
              window.__msGetFaceDetector = function() {
                try {
                  if (window.__msFaceDetector === undefined) {
                    if (typeof window.FaceDetector === 'function') {
                      try {
                        window.__msFaceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
                      } catch (e) {
                        window.__msFaceDetector = null;
                        console.log('[ms] FaceDetector ctor failed: ' + (e && e.message));
                      }
                    } else {
                      window.__msFaceDetector = null;
                      console.log('[ms] FaceDetector API non disponibile (fallback luma)');
                    }
                  }
                  return window.__msFaceDetector;
                } catch (_) { return null; }
              };
              // Restituisce la bbox del viso in coordinate del SOURCE video (px), o null
              window.__msDetectFaceBBox = function(video) {
                return new Promise(function(resolve) {
                  try {
                    var det = window.__msGetFaceDetector();
                    if (!det || !video || !video.videoWidth) { resolve(null); return; }
                    // Per performance/affidabilità: scalo a max 640px lato lungo
                    var vw = video.videoWidth | 0, vh = video.videoHeight | 0;
                    var maxSide = 640;
                    var scale = Math.min(1, maxSide / Math.max(vw, vh));
                    var dw = Math.max(64, Math.round(vw * scale));
                    var dh = Math.max(64, Math.round(vh * scale));
                    var c = document.createElement('canvas');
                    c.width = dw; c.height = dh;
                    var cx = c.getContext('2d');
                    cx.drawImage(video, 0, 0, dw, dh);
                    var t0 = Date.now();
                    det.detect(c).then(function(faces) {
                      if (!faces || !faces.length) { resolve(null); return; }
                      // Prendo la faccia più grande
                      var best = null;
                      for (var i = 0; i < faces.length; i++) {
                        var b = faces[i].boundingBox;
                        if (!b) continue;
                        if (!best || (b.width * b.height) > (best.width * best.height)) best = b;
                      }
                      if (!best) { resolve(null); return; }
                      // Riconverto in coordinate sorgente
                      var invS = 1 / scale;
                      var out = {
                        x: best.x * invS,
                        y: best.y * invS,
                        w: best.width * invS,
                        h: best.height * invS,
                        cx: (best.x + best.width / 2) * invS,
                        cy: (best.y + best.height / 2) * invS,
                        detMs: Date.now() - t0
                      };
                      resolve(out);
                    }).catch(function(e) {
                      console.log('[ms] face detect err: ' + (e && e.message));
                      resolve(null);
                    });
                  } catch (e) { resolve(null); }
                });
              };
              // Calcola un crop di sorgente per replicare l'inquadratura del primo scatto:
              // mantiene la stessa scala del volto e la stessa posizione relativa al crop.
              window.__msFaceAlignCrop = function(fixedCrop, refFace, curFace) {
                try {
                  if (!fixedCrop || !refFace || !curFace || !refFace.w || !curFace.w) return null;
                  // Compensazione scala: se la persona si avvicina/allontana dalla camera il viso
                  // appare più grande/piccolo nel video. Adeguiamo le dimensioni del crop in modo
                  // che il viso occupi la stessa porzione del frame in tutti gli scatti.
                  // s = curFace.w / refFace.w: se il viso è cresciuto del 20% → crop più grande del 20%
                  // così la persona appare con lo stesso zoom del primo scatto.
                  var s = (refFace.w > 10 && curFace.w > 10)
                    ? Math.max(0.75, Math.min(1.33, curFace.w / refFace.w))
                    : 1.0;
                  var sw = fixedCrop.sw * s;
                  var sh = fixedCrop.sh * s;
                  // Se il crop scalato supererebbe i bordi del video, annulla la correzione
                  if (sw > fixedCrop.vw || sh > fixedCrop.vh) return null;
                  // Posizione relativa del volto rispetto al centro del fixedCrop nel primo scatto
                  var refOffX = refFace.cx - (fixedCrop.sx + fixedCrop.sw / 2);
                  var refOffY = refFace.cy - (fixedCrop.sy + fixedCrop.sh / 2);
                  // Centro il crop in modo che il viso attuale finisca alla stessa posizione
                  // relativa che aveva nel primo scatto (offset scalato con s)
                  var sx = curFace.cx - sw / 2 - refOffX * s;
                  var sy = curFace.cy - sh / 2 - refOffY * s;
                  // Clamp dentro al video
                  sx = Math.max(0, Math.min(fixedCrop.vw - sw, sx));
                  sy = Math.max(0, Math.min(fixedCrop.vh - sh, sy));
                  return {
                    sx: sx, sy: sy, sw: sw, sh: sh,
                    vw: fixedCrop.vw, vh: fixedCrop.vh, slotAR: fixedCrop.slotAR,
                    scale: s
                  };
                } catch (_) { return null; }
              };
              window.__msComputeFixedCrop = function(video, slot) {
                try {
                  var vw = video && video.videoWidth | 0;
                  var vh = video && video.videoHeight | 0;
                  if (!vw || !vh || !slot || !slot.w || !slot.h) return null;
                  var slotAR = slot.w / slot.h;
                  var vAR = vw / vh;
                  var sx = 0, sy = 0, sw = vw, sh = vh;
                  if (vAR > slotAR) { sw = vh * slotAR; sx = (vw - sw) / 2; }
                  else if (vAR < slotAR) { sh = vw / slotAR; sy = (vh - sh) / 2; }
                  return { sx: sx, sy: sy, sw: sw, sh: sh, vw: vw, vh: vh, slotAR: slotAR };
                } catch (_) { return null; }
              };
              window.__msBuildCropLuma = function(video, crop, outW, outH) {
                try {
                  var vw = video && video.videoWidth | 0;
                  var vh = video && video.videoHeight | 0;
                  if (!vw || !vh || !crop) return null;
                  var w = Math.max(32, outW | 0), h = Math.max(24, outH | 0);
                  var c = document.createElement('canvas');
                  c.width = w; c.height = h;
                  var cx = c.getContext('2d', { willReadFrequently: true });
                  cx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
                  var img = cx.getImageData(0, 0, w, h).data;
                  var g = new Uint8Array(w * h);
                  for (var i = 0, j = 0; i < img.length; i += 4, j++) {
                    g[j] = (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114) | 0;
                  }
                  return { w: w, h: h, g: g };
                } catch (_) { return null; }
              };
              window.__msEstimateShift = function(refLuma, curLuma, maxShift) {
                try {
                  if (!refLuma || !curLuma) return { dx: 0, dy: 0, score: 1e18 };
                  var w = refLuma.w | 0, h = refLuma.h | 0;
                  if (!w || !h || w !== (curLuma.w | 0) || h !== (curLuma.h | 0)) return { dx: 0, dy: 0, score: 1e18 };
                  var rg = refLuma.g, cg = curLuma.g;
                  var lim = Math.max(0, maxShift | 0);
                  var best = { dx: 0, dy: 0, score: 1e18 };
                  var step = 2;
                  for (var dy = -lim; dy <= lim; dy += step) {
                    for (var dx = -lim; dx <= lim; dx += step) {
                      var sad = 0;
                      var cnt = 0;
                      for (var y = 4; y < h - 4; y += 4) {
                        if (y > h * 0.30 && y < h * 0.70) continue;
                        var y2 = y + dy;
                        if (y2 < 0 || y2 >= h) continue;
                        for (var x = 4; x < w - 4; x += 4) {
                          if (x > w * 0.30 && x < w * 0.70) continue;
                          var x2 = x + dx;
                          if (x2 < 0 || x2 >= w) continue;
                          var i1 = y * w + x;
                          var i2 = y2 * w + x2;
                          var d = rg[i1] - cg[i2];
                          sad += d < 0 ? -d : d;
                          cnt++;
                        }
                      }
                      if (!cnt) continue;
                      var score = sad / cnt;
                      if (score < best.score) best = { dx: dx, dy: dy, score: score };
                    }
                  }
                  return best;
                } catch (_) { return { dx: 0, dy: 0, score: 1e18 }; }
              };
              // Stima scala + traslazione tra frame ref e frame corrente analizzando solo i bordi
              // (esclude la regione centrale dove c'è il soggetto). Ritorna il crop sorgente
              // (sx,sy,sw,sh) da usare per riportare l'inquadratura uguale al primo scatto.
              window.__msEstimateAffineCrop = function(video, fixedCrop, refLuma) {
                try {
                  if (!video || !fixedCrop || !refLuma) return null;
                  var vw = video.videoWidth | 0, vh = video.videoHeight | 0;
                  if (!vw || !vh) return null;
                  // LOCK SCALA: fallback con sola traslazione, nessuna variazione di zoom.
                  var scales = [1.00];
                  var best = { score: 1e18, sx: fixedCrop.sx, sy: fixedCrop.sy, sw: fixedCrop.sw, sh: fixedCrop.sh };
                  for (var si = 0; si < scales.length; si++) {
                    var s = scales[si];
                    var tw = fixedCrop.sw * s;
                    var th = fixedCrop.sh * s;
                    if (tw > vw || th > vh) continue;
                    if (tw < vw * 0.30 || th < vh * 0.30) continue;
                    // Crop iniziale centrato sullo stesso centro del fixedCrop
                    var cx0 = fixedCrop.sx + fixedCrop.sw / 2;
                    var cy0 = fixedCrop.sy + fixedCrop.sh / 2;
                    var tsx = cx0 - tw / 2;
                    var tsy = cy0 - th / 2;
                    var candidate = { sx: tsx, sy: tsy, sw: tw, sh: th };
                    var luma = window.__msBuildCropLuma(video, candidate, refLuma.w, refLuma.h);
                    if (!luma) continue;
                    var est = window.__msEstimateShift(refLuma, luma, 12);
                    if (est.score >= best.score) continue;
                    // Converto dx/dy luma -> pixel sorgente (in scala corrente)
                    var pxX = tw / refLuma.w;
                    var pxY = th / refLuma.h;
                    var sx2 = tsx + (est.dx * pxX);
                    var sy2 = tsy + (est.dy * pxY);
                    sx2 = Math.max(0, Math.min((vw - tw), sx2));
                    sy2 = Math.max(0, Math.min((vh - th), sy2));
                    best = { score: est.score, sx: sx2, sy: sy2, sw: tw, sh: th, scale: s, dx: est.dx, dy: est.dy };
                  }
                  return best;
                } catch (_) { return null; }
              };
              window.__msShowCollageProgress = function(total, current) {
                var el = document.getElementById('ms-lv-collage-progress');
                if (!el) {
                  el = document.createElement('div');
                  el.id = 'ms-lv-collage-progress';
                  (document.body || document.documentElement).appendChild(el);
                }
                el.innerHTML = '';
                for (var i = 0; i < total; i++) {
                  var d = document.createElement('div');
                  d.className = 'ms-col-prog-dot' + (i < current ? ' done' : (i === current ? ' cur' : ''));
                  el.appendChild(d);
                }
                el.style.display = 'flex';
              };
              window.__msHideCollageProgress = function() {
                var el = document.getElementById('ms-lv-collage-progress');
                if (el && el.parentNode) el.parentNode.removeChild(el);
              };
              window.__msStopLayoutPreviewLoop = function() {
                try {
                  if (window.__msLayoutPreviewRaf) cancelAnimationFrame(window.__msLayoutPreviewRaf);
                } catch (_) {}
                window.__msLayoutPreviewRaf = 0;
              };
              window.__msStartLayoutPreviewLoop = function() {
                try { window.__msStopLayoutPreviewLoop(); } catch (_) {}
                var tick = function() {
                  try {
                    var overlay = document.getElementById('ms-lv-layout-preview');
                    if (!overlay) { window.__msLayoutPreviewRaf = 0; return; }
                    var c = overlay.querySelector('.ms-lp-cell[data-state="active"] canvas.ms-lp-live-canvas');
                    var video = document.getElementById('ms-cam-video');
                    if (c && video && video.videoWidth > 0 && video.videoHeight > 0) {
                      var ctx = c.getContext('2d');
                      var cw = c.width | 0, ch = c.height | 0;
                      var vw = video.videoWidth | 0, vh = video.videoHeight | 0;
                      var slotAR = cw / ch, vAR = vw / vh;
                      var sx = 0, sy = 0, sw = vw, sh = vh;
                      var fixed = window.__msLayoutPreviewCrop;
                      if (fixed && fixed.vw === vw && fixed.vh === vh && Math.abs((fixed.slotAR || slotAR) - slotAR) < 0.0001) {
                        sx = fixed.sx; sy = fixed.sy; sw = fixed.sw; sh = fixed.sh;
                      } else {
                        if (vAR > slotAR) {
                          sw = vh * slotAR;
                          sx = (vw - sw) / 2;
                        } else if (vAR < slotAR) {
                          sh = vw / slotAR;
                          sy = (vh - sh) / 2;
                        }
                      }
                      ctx.clearRect(0, 0, cw, ch);
                      ctx.save();
                      ctx.translate(cw, 0);
                      ctx.scale(-1, 1);
                      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
                      ctx.restore();
                    }
                  } catch (_) {}

                  try { window.__msLayoutPreviewRaf = requestAnimationFrame(tick); } catch (_) { window.__msLayoutPreviewRaf = 0; }
                };
                try { window.__msLayoutPreviewRaf = requestAnimationFrame(tick); } catch (_) { window.__msLayoutPreviewRaf = 0; }
              };
              window.__msRenderLayoutPreview = function(layoutKey, activeIdx, thumbs) {
                var slots = window.__MS_COLLAGE_LAYOUTS[layoutKey] || [];
                var overlay = document.getElementById('ms-lv-layout-preview');
                if (!slots.length || layoutKey === '1') {
                  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                  try {
                    var __g0 = document.getElementById('ms-lv-grid');
                    if (__g0) __g0.style.removeProperty('display');
                  } catch (_) {}
                  try { window.__msStopLayoutPreviewLoop(); } catch (_) {}
                  return;
                }
                if (!overlay) {
                  overlay = document.createElement('div');
                  overlay.id = 'ms-lv-layout-preview';
                  (document.body || document.documentElement).appendChild(overlay);
                }
                var fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
                var root = (typeof getPreferredParent === 'function' ? getPreferredParent() : null) || fsEl || document.body || document.documentElement;
                if (root && overlay.parentNode !== root) root.appendChild(overlay);
                overlay.style.setProperty('z-index', '2147483644', 'important');
                try {
                  var __g = document.getElementById('ms-lv-grid');
                  if (__g) __g.style.setProperty('display', 'none', 'important');
                } catch (_) {}
                overlay.innerHTML = '';
                var sheet = document.createElement('div');
                sheet.className = 'ms-lp-sheet';
                try {
                  // La finestra layout deve seguire il foro foto gia' calibrato,
                  // non il rettangolo esterno della cornice/foglio.
                  var photoEl = document.getElementById('video') || document.querySelector('video');
                  var pr = photoEl && photoEl.getBoundingClientRect ? photoEl.getBoundingClientRect() : null;
                  if (pr && pr.width > 8 && pr.height > 8) {
                    sheet.style.setProperty('position', 'fixed', 'important');
                    sheet.style.setProperty('left', pr.left + 'px', 'important');
                    sheet.style.setProperty('top', pr.top + 'px', 'important');
                    sheet.style.setProperty('width', pr.width + 'px', 'important');
                    sheet.style.setProperty('height', pr.height + 'px', 'important');
                    sheet.style.setProperty('max-width', 'none', 'important');
                    sheet.style.setProperty('max-height', 'none', 'important');
                  }
                } catch (_) {}
                var backdrop = document.createElement('div');
                backdrop.className = 'ms-lp-backdrop';
                sheet.appendChild(backdrop);
                overlay.appendChild(sheet);
                var W = 1200, H = 1800;
                var safeActive = (typeof activeIdx === 'number') ? activeIdx : 0;
                var safeThumbs = thumbs || [];
                slots.forEach(function(s, i) {
                  var cell = document.createElement('div');
                  cell.className = 'ms-lp-cell';
                  cell.style.left = (s.x / W * 100) + '%';
                  cell.style.top = (s.y / H * 100) + '%';
                  cell.style.width = (s.w / W * 100) + '%';
                  cell.style.height = (s.h / H * 100) + '%';
                  var state;
                  if (i < safeActive) state = 'done';
                  else if (i === safeActive) state = 'active';
                  else state = 'idle';
                  cell.setAttribute('data-state', state);
                  if (safeThumbs[i]) {
                    var img = document.createElement('img');
                    img.className = 'ms-lp-thumb';
                    img.src = safeThumbs[i];
                    cell.appendChild(img);
                  } else if (state === 'active') {
                    var liveCanvas = document.createElement('canvas');
                    liveCanvas.className = 'ms-lp-live-canvas';
                    liveCanvas.width = Math.max(240, Math.round(s.w));
                    liveCanvas.height = Math.max(240, Math.round(s.h));
                    cell.appendChild(liveCanvas);
                  }
                  if (!safeThumbs[i]) {
                    var logo = document.createElement('div');
                    logo.className = 'ms-lp-logo';
                    var logoImg = document.createElement('img');
                    logoImg.className = 'ms-lp-logo-img';
                    logoImg.src = 'logo sballando.png';
                    logo.appendChild(logoImg);
                    cell.appendChild(logo);
                  }
                  var num = document.createElement('div');
                  num.className = 'ms-lp-num';
                  num.textContent = (i + 1) + '/' + slots.length;
                  cell.appendChild(num);
                  if (state === 'active') {
                    var big = document.createElement('div');
                    big.className = 'ms-lp-bigshot';
                    big.textContent = 'Scatto ' + (i + 1) + ' di ' + slots.length;
                    cell.appendChild(big);
                  }
                  sheet.appendChild(cell);
                });
                try { window.__msStartLayoutPreviewLoop(); } catch (_) {}
              };
              window.__msHideLayoutPreview = function() {
                try { window.__msStopLayoutPreviewLoop(); } catch (_) {}
                try {
                  var __g = document.getElementById('ms-lv-grid');
                  if (__g) __g.style.removeProperty('display');
                } catch (_) {}
                var overlay = document.getElementById('ms-lv-layout-preview');
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
              };
              window.__msCaptureSlotThumb = function(video, slot, fixedCrop) {
                try {
                  var c = document.createElement('canvas');
                  var ratio = slot.w / slot.h;
                  c.width = 240;
                  c.height = Math.round(240 / ratio);
                  var cx = c.getContext('2d');
                  cx.fillStyle = '#000';
                  cx.fillRect(0, 0, c.width, c.height);
                  var vw = video && video.videoWidth | 0;
                  var vh = video && video.videoHeight | 0;
                  if (!vw || !vh) return '';
                  var slotAR = c.width / c.height, vAR = vw / vh;
                  var sx = 0, sy = 0, sw = vw, sh = vh;
                  if (fixedCrop && fixedCrop.vw === vw && fixedCrop.vh === vh && Math.abs((fixedCrop.slotAR || slotAR) - slotAR) < 0.0001) {
                    sx = fixedCrop.sx; sy = fixedCrop.sy; sw = fixedCrop.sw; sh = fixedCrop.sh;
                  } else {
                    if (vAR > slotAR) { sw = vh * slotAR; sx = (vw - sw) / 2; }
                    else if (vAR < slotAR) { sh = vw / slotAR; sy = (vh - sh) / 2; }
                  }
                  cx.save();
                  cx.translate(c.width, 0);
                  cx.scale(-1, 1);
                  cx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
                  cx.restore();
                  return c.toDataURL('image/jpeg', 0.7);
                } catch (_) { return ''; }
              };
              window.__msRunCollage = function(layoutKey) {
                var slots = window.__MS_COLLAGE_LAYOUTS[layoutKey];
                var video = document.getElementById('ms-cam-video');
                if (!video || !slots || !slots.length) {
                  try { window.__msLayoutPreviewCrop = null; } catch (_) {}
                  window.__msShootInFlight = false;
                  return;
                }
                try {
                  window.__msPreviewDismissed = false;
                  window.__msPreviewActive = false;
                } catch (_) {}
                var W = 1200, H = 1800;
                var canvas = document.createElement('canvas');
                canvas.width = W; canvas.height = H;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, W, H);
                var i = 0;
                var thumbs = [];
                var fixedCrop = null;
                var refFace = null;
                var refLuma = null;
                try {
                  fixedCrop = window.__msComputeFixedCrop(video, slots[0]);
                  window.__msLayoutPreviewCrop = fixedCrop || null;
                } catch (_) { fixedCrop = null; }
                // Pre-inizializzo il FaceDetector per evitare lag al primo scatto
                try { window.__msGetFaceDetector(); } catch (_) {}
                var __finishShot = function(useCrop, __alignDbg) {
                  try {
                    console.log('[ms] collage shot=' + i + ' vw=' + (video && video.videoWidth) + ' vh=' + (video && video.videoHeight) +
                      ' fixed=' + (fixedCrop ? ('sx='+fixedCrop.sx+' sy='+fixedCrop.sy+' sw='+fixedCrop.sw+' sh='+fixedCrop.sh+' vw='+fixedCrop.vw+' vh='+fixedCrop.vh) : 'null') +
                      ' use=' + (useCrop ? ('sx='+Math.round(useCrop.sx)+' sy='+Math.round(useCrop.sy)+' sw='+Math.round(useCrop.sw)+' sh='+Math.round(useCrop.sh)) : 'null') +
                      (__alignDbg || ''));
                  } catch (_) {}
                  try { thumbs[i] = window.__msCaptureSlotThumb(video, slots[i], useCrop || fixedCrop) || ''; } catch (_) {}
                  try {
                    if (useCrop && video && video.videoWidth === useCrop.vw && video.videoHeight === useCrop.vh) {
                      var __slot = slots[i];
                      var __g = 12;
                      var __x = __slot.x + __g, __y = __slot.y + __g;
                      var __w = __slot.w - __g * 2, __h = __slot.h - __g * 2;
                      if (__w > 0 && __h > 0) {
                        ctx.save();
                        ctx.beginPath(); ctx.rect(__x, __y, __w, __h); ctx.clip();
                        ctx.translate(__x + __w, __y); ctx.scale(-1, 1);
                        ctx.drawImage(video, useCrop.sx, useCrop.sy, useCrop.sw, useCrop.sh, 0, 0, __w, __h);
                        ctx.restore();
                      }
                    } else {
                      window.__msDrawSlot(ctx, video, slots[i], 12);
                    }
                  } catch (_) {}
                  i++;
                  try { window.__msShowCollageProgress(slots.length, i); } catch (_) {}
                  try { window.__msRenderLayoutPreview(layoutKey, i, thumbs); } catch (_) {}
                  if (i >= slots.length) { setTimeout(finalize, 350); }
                  else { setTimeout(nextShot, 750); }
                };
                var nextShot = function() {
                  if (i >= slots.length) { finalize(); return; }
                  try { window.__msShowCollageProgress(slots.length, i); } catch (_) {}
                  try { window.__msRenderLayoutPreview(layoutKey, i, thumbs); } catch (_) {}
                  window.__msShowCountdown(function() {
                    // Face-based alignment: shot 0 cattura il volto di riferimento, gli altri ci si allineano
                    var detPromise;
                    try { detPromise = window.__msDetectFaceBBox(video); } catch (_) { detPromise = Promise.resolve(null); }
                    detPromise.then(function(curFace) {
                      var useCrop = fixedCrop;
                      var dbg = '';
                      try {
                        if (fixedCrop && !refLuma) {
                          refLuma = window.__msBuildCropLuma(video, fixedCrop, 192, 144);
                        }
                        if (!fixedCrop || !curFace) {
                          // Fallback: allineamento scala+shift sul frame (sfondo) rispetto al primo scatto
                          if (fixedCrop && refLuma && i > 0) {
                            var affFallback = window.__msEstimateAffineCrop(video, fixedCrop, refLuma);
                            if (affFallback && affFallback.sw && affFallback.sh) {
                              useCrop = {
                                sx: affFallback.sx, sy: affFallback.sy, sw: affFallback.sw, sh: affFallback.sh,
                                vw: fixedCrop.vw, vh: fixedCrop.vh, slotAR: fixedCrop.slotAR
                              };
                              dbg = ' face=' + (curFace ? 'yes' : 'no') + ' fallback=affine scale=' + (affFallback.scale || 1).toFixed(3) +
                                ' dx=' + affFallback.dx + ' dy=' + affFallback.dy + ' score=' + Math.round(affFallback.score);
                            } else {
                              dbg = ' face=' + (curFace ? 'yes' : 'no') + ' fallback=none';
                            }
                          } else {
                            dbg = ' face=' + (curFace ? 'yes' : 'no') + ' fallback=skip';
                          }
                        } else if (!refFace) {
                          refFace = curFace;
                          dbg = ' face=REF cx=' + Math.round(curFace.cx) + ' cy=' + Math.round(curFace.cy) + ' w=' + Math.round(curFace.w) + ' detMs=' + curFace.detMs;
                        } else {
                          var aligned = window.__msFaceAlignCrop(fixedCrop, refFace, curFace);
                          if (aligned) {
                            useCrop = aligned;
                            dbg = ' face=cx=' + Math.round(curFace.cx) + ' cy=' + Math.round(curFace.cy) + ' w=' + Math.round(curFace.w) +
                              ' scale=' + (aligned.scale || 1).toFixed(3) + ' detMs=' + curFace.detMs;
                          } else {
                            // fallback affine anche se il face-align fallisce
                            if (fixedCrop && refLuma && i > 0) {
                              var affOnFail = window.__msEstimateAffineCrop(video, fixedCrop, refLuma);
                              if (affOnFail && affOnFail.sw && affOnFail.sh) {
                                useCrop = {
                                  sx: affOnFail.sx, sy: affOnFail.sy, sw: affOnFail.sw, sh: affOnFail.sh,
                                  vw: fixedCrop.vw, vh: fixedCrop.vh, slotAR: fixedCrop.slotAR
                                };
                                dbg = ' face=found-but-align-failed fallback=affine scale=' + (affOnFail.scale || 1).toFixed(3) +
                                  ' dx=' + affOnFail.dx + ' dy=' + affOnFail.dy + ' score=' + Math.round(affOnFail.score);
                              } else {
                                dbg = ' face=found-but-align-failed fallback=none';
                              }
                            } else {
                              dbg = ' face=found-but-align-failed fallback=skip';
                            }
                          }
                        }
                      } catch (_) {}
                      __finishShot(useCrop, dbg);
                    });
                  });
                };
                var finalize = function() {
                  try {
                    canvas.toBlob(function(blob) {
                      try { window.__msLayoutPreviewCrop = null; } catch (_) {}
                      try { window.__msHideCollageProgress(); } catch (_) {}
                      try { window.__msHideLayoutPreview(); } catch (_) {}
                      if (!blob) { window.__msShootInFlight = false; return; }
                      var url = URL.createObjectURL(blob);
                      var stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                      var fname = 'collage_' + stamp + '.jpg';
                      try { localStorage.setItem('last_picture_name', fname); } catch (_) {}
                      try { localStorage.setItem('last_picture_url', url); } catch (_) {}
                      try { window.__msPreviewFallbackUrl = url; } catch (_) {}
                      var ft = document.getElementById('foto_temp');
                      var img = ft && ft.querySelector('img');
                      if (img) img.src = url;
                      if (ft) {
                        try { ft.style.setProperty('display', 'flex', 'important'); } catch (_) { ft.style.display = 'flex'; }
                        try { ft.style.setProperty('visibility', 'visible', 'important'); } catch (_) { ft.style.visibility = 'visible'; }
                        try { ft.style.setProperty('opacity', '1', 'important'); } catch (_) { ft.style.opacity = '1'; }
                      }
                      try {
                        window.__msPreviewDismissed = false;
                        window.__msPreviewActive = true;
                        window.__msHideOverlayUntil = Date.now() + 300;
                      } catch (_) {}
                      try {
                        var __trg = document.getElementById('ms-collage-preview-trigger');
                        if (!__trg) {
                          __trg = document.createElement('button');
                          __trg.id = 'ms-collage-preview-trigger';
                          __trg.type = 'button';
                          __trg.setAttribute('aria-hidden', 'true');
                          __trg.style.position = 'fixed';
                          __trg.style.left = '-9999px';
                          __trg.style.top = '0';
                          __trg.style.width = '1px';
                          __trg.style.height = '1px';
                          __trg.style.opacity = '0';
                          __trg.style.pointerEvents = 'none';
                          (document.body || document.documentElement).appendChild(__trg);
                        }
                        if (typeof __trg.click === 'function') __trg.click();
                      } catch (_) {}
                      try {
                        if (typeof __msEnsurePreview === 'function' && ft) {
                          var __okPrev = __msEnsurePreview(ft, url);
                          console.log('[ms] collage preview ensure=' + (__okPrev ? 'ok' : 'fail'));
                        }
                      } catch (_) {}
                      try {
                        if (typeof window._msSessionFrameLiteSync === 'function') {
                          window._msSessionFrameLiteSync();
                          [60, 180, 420].forEach(function(d) {
                            setTimeout(function() {
                              try { window._msSessionFrameLiteSync(); } catch (_) {}
                            }, d);
                          });
                        }
                      } catch (_) {}
                      console.log('[ms] collage done layout=' + layoutKey + ' shots=' + slots.length);
                      window.__msShootInFlight = false;
                    }, 'image/jpeg', 0.95);
                  } catch (e) {
                    try { window.__msLayoutPreviewCrop = null; } catch (_) {}
                    try { window.__msHideCollageProgress(); } catch (_) {}
                    console.log('[ms] collage finalize err: ' + e.message);
                    window.__msShootInFlight = false;
                  }
                };
                nextShot();
              };
            }

            // ── Pannello layout (5 opzioni) — floating sinistra ──
            if (!document.getElementById('ms-lv-collage-panel')) {
              var panel = document.createElement('div');
              panel.id = 'ms-lv-collage-panel';
              var ic1 = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
              var ic2v = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/></svg>';
              var ic2h = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="16" rx="1.5"/><rect x="13" y="4" width="7" height="16" rx="1.5"/></svg>';
              var ic4  = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/></svg>';
              var ic3s = '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="5" rx="1.2"/><rect x="4" y="9.5" width="16" height="5" rx="1.2"/><rect x="4" y="16" width="16" height="5" rx="1.2"/></svg>';
              var defs = [
                { k: '1',      svg: ic1,  label: '1 foto' },
                { k: '2v',     svg: ic2v, label: '2 verticali' },
                { k: '2h',     svg: ic2h, label: '2 orizzontali' },
                { k: '4',      svg: ic4,  label: '4 quadrati' },
                { k: 'strip3', svg: ic3s, label: 'Strip 3' }
              ];
              var title = document.createElement('button');
              title.type = 'button';
              title.className = 'ms-col-title';
              title.textContent = 'LAYOUT';
              title.addEventListener('click', function(ev) {
                ev.preventDefault(); ev.stopPropagation();
                if (window.__msShootInFlight) return;
                panel.classList.toggle('is-open');
              });
              panel.appendChild(title);
              var current = window.__msGetCollageLayout();
              defs.forEach(function(d) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'ms-col-btn' + (d.k === current ? ' is-active' : '');
                b.setAttribute('data-key', d.k);
                b.setAttribute('title', d.label);
                b.setAttribute('aria-label', d.label);
                b.innerHTML = d.svg;
                b.addEventListener('click', function(ev) {
                  ev.preventDefault(); ev.stopPropagation();
                  if (window.__msShootInFlight) return;
                  window.__msSetCollageLayout(d.k);
                  var nodes = panel.querySelectorAll('.ms-col-btn');
                  for (var n = 0; n < nodes.length; n++) {
                    nodes[n].classList.toggle('is-active', nodes[n].getAttribute('data-key') === d.k);
                  }
                  panel.classList.remove('is-open');
                  try {
                    if (typeof window.__msRenderLayoutPreview === 'function') {
                      window.__msRenderLayoutPreview(d.k, 0, []);
                      setTimeout(function() {
                        try {
                          if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync();
                          window.__msRenderLayoutPreview(d.k, 0, []);
                        } catch (_) {}
                      }, 40);
                    }
                  } catch (_) {}
                });
                panel.appendChild(b);
              });
              (document.body || document.documentElement).appendChild(panel);
              document.addEventListener('click', function(ev) {
                try {
                  if (!panel || !panel.isConnected || panel.contains(ev.target)) return;
                  panel.classList.remove('is-open');
                } catch (_) {}
              }, true);
              try {
                if (typeof window.__msRenderLayoutPreview === 'function') {
                  window.__msRenderLayoutPreview(current, 0, []);
                  setTimeout(function() {
                    try {
                      if (typeof window._msSessionFrameLiteSync === 'function') window._msSessionFrameLiteSync();
                      window.__msRenderLayoutPreview(current, 0, []);
                    } catch (_) {}
                  }, 40);
                }
              } catch (_) {}
            }

            // ── Griglia 2x2 sottile sopra la preview ──
            if (!document.getElementById('ms-lv-grid')) {
              var grid = document.createElement('div');
              grid.id = 'ms-lv-grid';
              (document.body || document.documentElement).appendChild(grid);
            }

            // Click "scatta" → eseguiamo NOI il countdown visivo, poi al termine
            // clicchiamo captureBtn. Se è selezionato un layout multi-foto, eseguiamo
            // invece la sequenza collage (più scatti → singola foto composita).
            document.getElementById('ms-lv-shoot').addEventListener('click', function(ev) {
              ev.preventDefault(); ev.stopPropagation();
              try {
                // Evita doppi click
                if (window.__msShootInFlight) return;
                window.__msShootInFlight = true;
                var __sb = this;
                __sb.classList.add('ms-lv-flash');
                setTimeout(function() { try { __sb.classList.remove('ms-lv-flash'); } catch (_) {} }, 500);

                var __layout = (typeof window.__msGetCollageLayout === 'function') ? window.__msGetCollageLayout() : '1';
                if (__layout && __layout !== '1' && typeof window.__msRunCollage === 'function') {
                  // Sequenza collage multi-scatto, poi salva come UNA singola foto
                  console.log('[ms] start collage layout=' + __layout);
                  window.__msRunCollage(__layout);
                  return;
                }

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
          var colPanelEl = document.getElementById('ms-lv-collage-panel');
          if (colPanelEl && root && colPanelEl.parentNode !== root) root.appendChild(colPanelEl);
          var gridEl = document.getElementById('ms-lv-grid');
          if (gridEl && root && gridEl.parentNode !== root) root.appendChild(gridEl);
          var layoutPreviewEl = document.getElementById('ms-lv-layout-preview');
          var layoutPreviewRoot = (typeof getPreferredParent === 'function' ? getPreferredParent() : null) || root;
          if (layoutPreviewEl && layoutPreviewRoot && layoutPreviewEl.parentNode !== layoutPreviewRoot) layoutPreviewRoot.appendChild(layoutPreviewEl);
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
          var hasSrc = !!(el.src || el.currentSrc);
          if (!hasSrc) return false;
          try { el.currentTime = 0; } catch (_) {}
          try { el.muted = false; el.volume = 1.0; } catch (_) {}
          var p = el.play();
          if (p && typeof p.catch === 'function') {
            p.catch(function() {
              // Autoplay bloccato o decode fallito: fallback al beep WebAudio.
              try {
                if (name === 'sound_shot') {
                  window.__msBeep && window.__msBeep(1200, 0.32, 0.45, 'triangle');
                } else if (/^sound_[1-9]$/.test(name)) {
                  window.__msBeep && window.__msBeep(700, 0.12, 0.32, 'sine');
                } else {
                  window.__msBeep && window.__msBeep(1320, 0.10, 0.32, 'sine');
                }
              } catch (_) {}
            });
          }
          return true;
        } catch (_) { return false; }
      };
      window.__msPlaySaveSound = function() {
        try {
          var played = false;
          var names = ['sound_ok', 'sound_confirm', 'sound_save', 'sound_click'];
          for (var i = 0; i < names.length; i++) {
            if (window.__msPlayPageSound(names[i])) { played = true; break; }
          }
          // Fallback: prova a usare direttamente gli audio reali della pagina
          // (evita countdown/scatto) cercando file "ok/save/confirm/click".
          if (!played) {
            try {
              var audios = Array.from(document.querySelectorAll('audio'));
              var pick = null;
              for (var ai = 0; ai < audios.length; ai++) {
                var a = audios[ai];
                var name = String(a.getAttribute('name') || '').toLowerCase();
                if (name === 'sound_shot' || /^sound_[1-5]$/.test(name)) continue;
                var src = String(a.currentSrc || a.src || '').toLowerCase();
                if (/save|salv|ok|confirm|click/.test(src) || /ok|confirm|save|click/.test(name)) {
                  pick = a;
                  break;
                }
              }
              if (!pick) {
                for (var aj = 0; aj < audios.length; aj++) {
                  var b = audios[aj];
                  var bName = String(b.getAttribute('name') || '').toLowerCase();
                  if (bName && bName !== 'sound_shot' && !/^sound_[1-5]$/.test(bName)) {
                    pick = b;
                    break;
                  }
                }
              }
              if (pick) {
                try { pick.currentTime = 0; } catch (_) {}
                try { pick.muted = false; pick.volume = 1.0; } catch (_) {}
                var pp = pick.play();
                if (pp && typeof pp.catch === 'function') pp.catch(function() {});
                played = true;
              }
            } catch (_) {}
          }
          if (!played) {
            try { window.__msBeep(950, 0.09, 0.28, 'triangle'); } catch (_) {}
          }
          return true;
        } catch (_) { return false; }
      };
      window.__msPlayUiButtonSound = function(kind) {
        try {
          var k = String(kind || 'generic').toLowerCase();
          var played = false;
          var __playPrinterSynth = function() {
            try {
              // Timbrica "stampante": 3 colpi rapidi + coda breve.
              window.__msBeep && window.__msBeep(560, 0.055, 0.22, 'square');
              setTimeout(function() { try { window.__msBeep && window.__msBeep(510, 0.06, 0.22, 'square'); } catch (_) {} }, 70);
              setTimeout(function() { try { window.__msBeep && window.__msBeep(470, 0.07, 0.20, 'square'); } catch (_) {} }, 145);
              setTimeout(function() { try { window.__msBeep && window.__msBeep(360, 0.10, 0.14, 'triangle'); } catch (_) {} }, 245);
            } catch (_) {}
          };
          var names = (k === 'save')
            ? ['sound_save', 'sound_ok', 'sound_confirm']
            : (k === 'print')
              ? ['sound_print', 'sound_printer', 'sound_confirm', 'sound_click']
            : (k === 'cancel')
              ? ['sound_cancel', 'sound_click', 'sound_back']
              : ['sound_click', 'sound_confirm', 'sound_ok'];
          for (var i = 0; i < names.length; i++) {
            if (window.__msPlayPageSound(names[i])) { played = true; break; }
          }
          if (!played) {
            try {
              if (k === 'save') window.__msBeep(1460, 0.09, 0.24, 'triangle');
              else if (k === 'print') {
                __playPrinterSynth();
              }
              else if (k === 'cancel') window.__msBeep(760, 0.08, 0.2, 'sawtooth');
              else window.__msBeep(980, 0.08, 0.22, 'sine');
            } catch (_) {}
          } else if (k === 'print') {
            // Anche se abbiamo suonato un file audio pagina, aggiungi un leggero
            // accento synth per rendere il feedback "stampante" sempre percepibile.
            setTimeout(function() { try { window.__msBeep && window.__msBeep(430, 0.045, 0.12, 'square'); } catch (_) {} }, 35);
          }
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
          try {
            var cal = resolveFrameCalibration();
            var vw = Math.max(1, window.innerWidth || 1);
            var vh = Math.max(1, window.innerHeight || 1);
            ensureBlackBackdrop();
            var zoom = Number(cal && cal.zoomPct) / 100;
            var photoZoom = Number(cal && cal.photoZoomPct) / 100;
            if (!isFinite(zoom)) zoom = 1;
            if (!isFinite(photoZoom)) photoZoom = 1;
            if (zoom < 0.5) zoom = 0.5;
            if (zoom > 2) zoom = 2;
            if (photoZoom < 0.5) photoZoom = 0.5;
            if (photoZoom > 2) photoZoom = 2;
            var frameW = vw * zoom;
            var frameH = vh * zoom;
            var offX = (Number(cal && cal.offsetXmm) / 100) * vw;
            var offY = (Number(cal && cal.offsetYmm) / 150) * vh;
            var photoOffX = (Number(cal && cal.photoOffsetXmm) / 100) * vw;
            var photoOffY = (Number(cal && cal.photoOffsetYmm) / 150) * vh;
            if (!isFinite(offX)) offX = 0;
            if (!isFinite(offY)) offY = 0;
            if (!isFinite(photoOffX)) photoOffX = 0;
            if (!isFinite(photoOffY)) photoOffY = 0;
            var frameX = (vw - frameW) / 2 + offX;
            var frameY = (vh - frameH) / 2 + offY;
            var photoBase = (typeof __msGetPreviewRectForSource === 'function') ? __msGetPreviewRectForSource(src) : null;
            var basePhotoX = photoBase ? (photoBase.left * vw) : 0;
            var basePhotoY = photoBase ? (photoBase.top * vh) : 0;
            var basePhotoW = photoBase ? (photoBase.width * vw) : vw;
            var basePhotoH = photoBase ? (photoBase.height * vh) : vh;
            var photoW = basePhotoW * photoZoom;
            var photoH = basePhotoH * photoZoom;
            var photoX = basePhotoX + (basePhotoW - photoW) / 2 + photoOffX;
            var photoY = basePhotoY + (basePhotoH - photoH) / 2 + photoOffY;

            // Geometria live pre-scatto: segue solo la calibrazione Foto.
            try {
              var liveVideo = document.getElementById('video') || document.querySelector('video');
              if (liveVideo) {
                liveVideo.style.setProperty('position', 'fixed', 'important');
                liveVideo.style.setProperty('left', photoX + 'px', 'important');
                liveVideo.style.setProperty('top', photoY + 'px', 'important');
                liveVideo.style.setProperty('width', photoW + 'px', 'important');
                liveVideo.style.setProperty('height', photoH + 'px', 'important');
                liveVideo.style.setProperty('object-fit', 'cover', 'important');
                liveVideo.style.setProperty('margin', '0', 'important');
                liveVideo.style.setProperty('padding', '0', 'important');
                liveVideo.style.setProperty('border', '0', 'important');
                liveVideo.style.setProperty('z-index', '2147483644', 'important');
              }
            } catch (_) {}
            try {
              var lpSheet = document.querySelector('#ms-lv-layout-preview .ms-lp-sheet');
              if (lpSheet) {
                lpSheet.style.setProperty('position', 'fixed', 'important');
                lpSheet.style.setProperty('left', photoX + 'px', 'important');
                lpSheet.style.setProperty('top', photoY + 'px', 'important');
                lpSheet.style.setProperty('width', photoW + 'px', 'important');
                lpSheet.style.setProperty('height', photoH + 'px', 'important');
                lpSheet.style.setProperty('max-width', 'none', 'important');
                lpSheet.style.setProperty('max-height', 'none', 'important');
              }
            } catch (_) {}

            // Cornice live pre-scatto: stessa geometria della calibrazione/salvataggio.
            ov.style.setProperty('position', 'fixed', 'important');
            ov.style.setProperty('inset', 'auto', 'important');
            ov.style.setProperty('left', frameX + 'px', 'important');
            ov.style.setProperty('top', frameY + 'px', 'important');
            ov.style.setProperty('width', frameW + 'px', 'important');
            ov.style.setProperty('height', frameH + 'px', 'important');

            // Nero pieno fuori dalla cornice: in pre-scatto non deve filtrare
            // la pagina/camera sotto le parti trasparenti della cornice.
            var left = Math.max(0, Math.min(vw, frameX));
            var top = Math.max(0, Math.min(vh, frameY));
            var right = Math.max(0, Math.min(vw, frameX + frameW));
            var bottom = Math.max(0, Math.min(vh, frameY + frameH));
            var visW = Math.max(0, right - left);
            var visH = Math.max(0, bottom - top);

            if (visW < 8 || visH < 8) {
              hideWhiteMasks();
            } else {
              var masks = ensureWhiteMasks();
              masks.top.style.setProperty('display', 'block', 'important');
              masks.top.style.setProperty('left', '0px', 'important');
              masks.top.style.setProperty('top', '0px', 'important');
              masks.top.style.setProperty('width', vw + 'px', 'important');
              masks.top.style.setProperty('height', top + 'px', 'important');

              masks.bottom.style.setProperty('display', 'block', 'important');
              masks.bottom.style.setProperty('left', '0px', 'important');
              masks.bottom.style.setProperty('top', bottom + 'px', 'important');
              masks.bottom.style.setProperty('width', vw + 'px', 'important');
              masks.bottom.style.setProperty('height', Math.max(0, vh - bottom) + 'px', 'important');

              masks.left.style.setProperty('display', 'block', 'important');
              masks.left.style.setProperty('left', '0px', 'important');
              masks.left.style.setProperty('top', top + 'px', 'important');
              masks.left.style.setProperty('width', left + 'px', 'important');
              masks.left.style.setProperty('height', visH + 'px', 'important');

              masks.right.style.setProperty('display', 'block', 'important');
              masks.right.style.setProperty('left', right + 'px', 'important');
              masks.right.style.setProperty('top', top + 'px', 'important');
              masks.right.style.setProperty('width', Math.max(0, vw - right) + 'px', 'important');
              masks.right.style.setProperty('height', visH + 'px', 'important');
            }
          } catch (_) {
            hideBlackBackdrop();
            hideWhiteMasks();
          }
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
          try {
            var __lv = document.getElementById('video') || document.querySelector('video');
            if (__lv) {
              __lv.style.removeProperty('position');
              __lv.style.removeProperty('left');
              __lv.style.removeProperty('top');
              __lv.style.removeProperty('width');
              __lv.style.removeProperty('height');
              __lv.style.removeProperty('object-fit');
              __lv.style.removeProperty('margin');
              __lv.style.removeProperty('padding');
              __lv.style.removeProperty('border');
              __lv.style.removeProperty('z-index');
            }
          } catch (_) {}
          if (!window.__msFrameHideLogged && sess && (rev || !src || hideAfterCapture)) {
            window.__msFrameHideLogged = true;
            try { console.log('[ms] cornice OFF sess=' + sess + ' review=' + rev + ' captureHide=' + hideAfterCapture + ' hasSrc=' + (src ? 'yes' : 'no')); } catch (_) {}
            setTimeout(function() { window.__msFrameHideLogged = false; }, 2000);
          }
          hideWhiteMasks();
          hideBlackBackdrop();
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
              if (el.id === 'captureBtn' || el.id === 'ms-collage-preview-trigger') {
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
                  var img = null;
                  try {
                    if (imgs && imgs.length) {
                      for (var __ii = 0; __ii < imgs.length; __ii++) {
                        var __cand = imgs[__ii];
                        if (!__cand) continue;
                        // Escludi layer tecnici/overlay: non sono la foto scattata.
                        if (__cand.id === 'ms-preview-frame-ov' || __cand.id === 'ms-preview-bg') continue;
                        var __src = String(__cand.currentSrc || __cand.src || '').trim();
                        if (__src) { img = __cand; break; }
                      }
                      if (!img) img = imgs[0];
                    }
                  } catch (_) {}
                  if (!img) return false;

                  try {
                    var main = ft.querySelector(':scope > img#ms-preview-main');
                    var currentMainSrc = String(main && main.src || '').trim();
                    var forced = String(forcedSrc || '').trim();
                    var fallback = String(window.__msPreviewFallbackUrl || '').trim();
                    var rawImgSrc = String(img.currentSrc || img.src || '').trim();
                    var isUsablePreviewSrc = function(value) {
                      var lower = String(value || '').toLowerCase();
                      return !!lower && lower.indexOf('cursor_cancel.png') === -1 && lower.indexOf('cursor_ok.png') === -1 && lower.indexOf('/mirror/index') === -1;
                    };
                    var previewSrc = isUsablePreviewSrc(forced)
                      ? forced
                      : (isUsablePreviewSrc(currentMainSrc)
                        ? currentMainSrc
                        : (isUsablePreviewSrc(rawImgSrc)
                          ? rawImgSrc
                          : (isUsablePreviewSrc(fallback) ? fallback : rawImgSrc)));

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

                  // Applica stessa calibrazione del salvataggio alla preview post-scatto
                  // (offset/zoom della CORNICE; foto full-bleed sotto).
                  try {
                    var __clampCal = function(v, min, max, fb) {
                      var n = parseFloat(v);
                      if (!isFinite(n)) n = fb;
                      n = Math.max(min, Math.min(max, n));
                      return Math.round(n * 10) / 10;
                    };
                    var __cal = null;
                    try {
                      if (typeof window.__msGetEffectiveCalibrationForSave === 'function') {
                        __cal = window.__msGetEffectiveCalibrationForSave('postcard');
                      }
                    } catch (_) {}
                    if (!__cal || typeof __cal !== 'object') {
                      var __preset = {};
                      try { __preset = JSON.parse(localStorage.getItem('ms-cal-presets-v1') || '{}') || {}; } catch (_) { __preset = {}; }
                      __cal = (__preset && __preset.postcard) ? __preset.postcard : { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
                    }
                    var __offXmm = __clampCal(__cal.offsetXmm, -5, 5, 0);
                    var __offYmm = __clampCal(__cal.offsetYmm, -5, 5, 0);
                    var __zoomPct = __clampCal(__cal.zoomPct, 80, 120, 100);
                    var __photoOffXmm = __clampCal(__cal.photoOffsetXmm, -5, 5, 0);
                    var __photoOffYmm = __clampCal(__cal.photoOffsetYmm, -5, 5, 0);
                    var __photoZoomPct = __clampCal(__cal.photoZoomPct, 80, 120, 100);
                    var __zoom = __zoomPct / 100;
                    var __photoZoom = __photoZoomPct / 100;
                    if (__zoom < 0.5) __zoom = 0.5;
                    if (__zoom > 2) __zoom = 2;
                    if (__photoZoom < 0.5) __photoZoom = 0.5;
                    if (__photoZoom > 2) __photoZoom = 2;
                    ft.style.setProperty('--ms-cal-zoom', String(__zoom), 'important');
                    ft.style.setProperty('--ms-cal-offx-r', String(__offXmm / 100), 'important');
                    ft.style.setProperty('--ms-cal-offy-r', String(__offYmm / 150), 'important');
                    ft.style.setProperty('--ms-photo-cal-zoom', String(__photoZoom), 'important');
                    ft.style.setProperty('--ms-photo-cal-offx-r', String(__photoOffXmm / 100), 'important');
                    ft.style.setProperty('--ms-photo-cal-offy-r', String(__photoOffYmm / 150), 'important');
                  } catch (_) {}

                  // Filigrana ID SOLO visiva in preview (non viene salvata/stampata)
                  try {
                    var __idWm = ft.querySelector(':scope > div#ms-preview-id-watermark');
                    if (!__idWm) {
                      __idWm = document.createElement('div');
                      __idWm.id = 'ms-preview-id-watermark';
                      ft.appendChild(__idWm);
                    }
                    var __idTxt = String(window.__msCurrentPreviewIdText || '').trim() || 'ID ----';
                    __idWm.textContent = __idTxt;
                    __idWm.style.cssText =
                      'position:absolute!important;' +
                      'right:34px!important;' +
                      'bottom:calc(var(--ms-dock-h) + var(--ms-dock-bottom) + 24px)!important;' +
                      'z-index:2147483646!important;' +
                      'pointer-events:none!important;' +
                      'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;' +
                      'font-size:30px!important;font-weight:700!important;letter-spacing:0.08em!important;' +
                      'color:rgba(255,255,255,0.90)!important;' +
                      'text-shadow:0 3px 16px rgba(0,0,0,0.85),0 0 2px rgba(0,0,0,0.9)!important;';
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
                      try {
                        var __prefRaw = localStorage.getItem('msPanelPrintEnabled');
                        if (__prefRaw === '0') __panelEnabled = false;
                        if (__prefRaw === '1') __panelEnabled = true;
                      } catch (_) {}
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
                        '@keyframes msPvOkBreathe{0%,100%{box-shadow:0 10px 30px rgba(230,57,70,0.34),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.18);}50%{box-shadow:0 12px 40px rgba(230,57,70,0.52),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.22);}}' +

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
                          '--ms-cal-zoom:1;' +
                          '--ms-cal-offx-r:0;' +
                          '--ms-cal-offy-r:0;' +
                          '--ms-photo-cal-zoom:1;' +
                          '--ms-photo-cal-offx-r:0;' +
                          '--ms-photo-cal-offy-r:0;' +
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
                          'width:calc(var(--ms-card-w) * var(--ms-photo-w) * var(--ms-photo-cal-zoom))!important;' +
                          'height:calc(var(--ms-card-h) * var(--ms-photo-h) * var(--ms-photo-cal-zoom))!important;' +
                          'margin-left:calc(var(--ms-card-w) * (var(--ms-photo-left) + var(--ms-photo-w) / 2 - .5 + var(--ms-photo-cal-offx-r) - var(--ms-photo-w) * var(--ms-photo-cal-zoom) / 2))!important;' +
                          'margin-top:calc(var(--ms-card-h) * (var(--ms-photo-top) + var(--ms-photo-h) / 2 - .5 + var(--ms-photo-cal-offy-r) - var(--ms-photo-h) * var(--ms-photo-cal-zoom) / 2) - var(--ms-dock-block) / 2)!important;' +
                          'object-fit:cover!important;object-position:center center!important;' +
                          'background:#fff!important;image-rendering:auto!important;' +
                          'pointer-events:none!important;z-index:3!important;' +
                          'display:block!important;visibility:visible!important;' +
                          'border-radius:4px!important;padding:0!important;border:0!important;' +
                          'animation:msPvCardIn 0.85s cubic-bezier(.22,1.12,.36,1) both!important;}' +

                        // ── CORNICE GRAFICA (stessa centratura, dimensione card piena) ──
                        '#ms-preview-frame-ov{position:absolute!important;' +
                          'top:50%!important;left:50%!important;' +
                          'width:calc(var(--ms-card-w) * var(--ms-cal-zoom))!important;' +
                          'height:calc(var(--ms-card-h) * var(--ms-cal-zoom))!important;' +
                          'margin-left:calc(var(--ms-card-w) * var(--ms-cal-offx-r) - (var(--ms-card-w) * var(--ms-cal-zoom) / 2))!important;' +
                          'margin-top:calc(var(--ms-card-h) * var(--ms-cal-offy-r) - (var(--ms-card-h) * var(--ms-cal-zoom) / 2) - var(--ms-dock-block) / 2)!important;' +
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
                          'z-index:2147483645;display:flex;gap:10px;align-items:center;justify-content:center;' +
                          'padding:10px 12px;border-radius:140px;max-width:calc(100vw - 32px);box-sizing:border-box;' +
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
                        '.ms-pb-btn{pointer-events:auto;position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;' +
                          'padding:0 18px;height:82px;width:170px;min-width:170px;max-width:170px;border-radius:50px;border:none;box-sizing:border-box;' +
                          'cursor:pointer;font-size:18px;font-weight:500;letter-spacing:1.2px;' +
                          '-webkit-user-select:none;user-select:none;line-height:1;white-space:nowrap;' +
                          'font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
                          'transition:transform 0.20s cubic-bezier(.22,1.2,.36,1),box-shadow 0.20s ease,background 0.20s ease,opacity 0.20s ease;' +
                          'overflow:hidden;}' +
                        '.ms-pb-btn:active{transform:scale(0.94)!important;opacity:0.82!important;}' +
                        '.ms-pb-btn svg{width:20px;height:20px;flex:0 0 auto;}' +
                        '.ms-pb-btn .ms-pb-lbl{position:relative;z-index:1;}' +

                        // Riprova — ghost puro: quasi invisibile, evita di distrarre dal CTA primario
                        '.ms-pb-cancel{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.78);' +
                          'border:1px solid rgba(255,255,255,0.15);' +
                          'box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);}' +
                        '.ms-pb-cancel:active{background:rgba(255,255,255,0.09)!important;}' +

                        // Salva e stampa — blu logo Sballando
                        '.ms-pb-stampa{background:linear-gradient(180deg,rgba(63,105,255,0.88) 0%,rgba(34,67,210,0.92) 100%);color:#fff;' +
                          'border:1px solid rgba(142,167,255,0.42);' +
                          'box-shadow:0 8px 26px rgba(55,105,255,0.30),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.16);}' +
                        '.ms-pb-stampa[data-checked="1"]{background:linear-gradient(180deg,rgba(82,126,255,0.96) 0%,rgba(40,76,224,0.96) 100%);' +
                          'border:1px solid rgba(166,188,255,0.56);color:#fff;' +
                          'box-shadow:0 10px 32px rgba(55,105,255,0.44),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.18);}' +
                        '.ms-pb-stampa .ms-pb-check{display:none!important;}' +
                        '.ms-pb-stampa[data-disabled="1"],.ms-pb-stampa:disabled{background:rgba(255,255,255,0.03)!important;color:rgba(255,255,255,0.42)!important;' +
                          'border:1px solid rgba(255,255,255,0.08)!important;box-shadow:none!important;opacity:0.56!important;cursor:not-allowed!important;pointer-events:none!important;}' +
                        '.ms-pb-stampa[data-disabled="1"] .ms-pb-check,.ms-pb-stampa:disabled .ms-pb-check{background:rgba(255,255,255,0.08)!important;' +
                          'border-color:rgba(255,255,255,0.16)!important;box-shadow:none!important;}' +

                        // Salva — rosso logo Sballando
                        '.ms-pb-ok{background:linear-gradient(180deg,rgba(255,78,94,0.96) 0%,rgba(230,57,70,0.96) 52%,rgba(177,28,42,0.96) 100%);' +
                          'color:#fff;font-weight:600;' +
                          'border:1px solid rgba(255,171,180,0.32);' +
                          'box-shadow:0 10px 30px rgba(230,57,70,0.34),0 3px 10px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.18);' +
                          'animation:msPvOkBreathe 4.2s ease-in-out infinite;}' +
                        '.ms-pb-ok:active{animation:none!important;box-shadow:0 5px 16px rgba(230,57,70,0.36)!important;}' +

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
                        '<button id="ms-btn-stampa" class="ms-pb-btn ms-pb-stampa" data-checked="1"><span class="ms-pb-check"></span>' + __svgPr + '<span class="ms-pb-lbl">Salva e stampa</span></button>' +
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
                          try { if (typeof window.__msPlayUiButtonSound === 'function') window.__msPlayUiButtonSound('cancel'); } catch (_) {}
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
                          try { if (typeof window.__msPlayUiButtonSound === 'function') window.__msPlayUiButtonSound('print'); } catch (_) {}
                          var __cb = __msGetPrintCheckbox();
                          if (__cb && !__cb.disabled) __cb.checked = true;
                          this.setAttribute('data-checked', '1');
                          // Flag persistente: sopravvive a __msCleanupPreviewStyles() che rimuove la action-bar.
                          window.__msPendingPrint = true;
                          try { showToast('Salvataggio e stampa in corso…', 1800, '#3b82f6'); } catch (_) {}
                          var __okBtn = document.getElementById('ms-btn-ok');
                          if (__okBtn && typeof __okBtn.click === 'function') {
                            __okBtn.click();
                          }
                        } catch (_) {}
                      });
                      // Salva → dispatch click su cursor_ok
                      document.getElementById('ms-btn-ok').addEventListener('click', function() {
                        try {
                          try { if (typeof window.__msPlayUiButtonSound === 'function') window.__msPlayUiButtonSound('save'); } catch (_) {}
                          __msCleanupPreviewStyles();
                          var __lp = '';
                          var __ln = '';
                          try {
                            // 1) Blob interceptato durante lo scatto (ha già cornice applicata)
                            var __intercepted = String(window.__msLastBlobDataUrl || '').trim();
                            if (__intercepted && __intercepted.indexOf('data:image/') === 0) {
                              __lp = __intercepted;
                              console.log('[ms] photo from intercepted blob size=' + Math.round(__lp.length / 1024) + 'KB');
                            }
                            // 2) Canvas (solo se non c'è blob - canvas può mostrare feed live)
                            if (!__lp || __lp.indexOf('data:image/') !== 0) {
                              var __cv = window.__msLastPhotoCanvas;
                              if (__cv && __cv.width > 100 && __cv.height > 100) {
                                try {
                                  __lp = __cv.toDataURL('image/jpeg', 0.95);
                                  console.log('[ms] photo from canvas ' + __cv.width + 'x' + __cv.height + ' size=' + Math.round(__lp.length / 1024) + 'KB');
                                } catch (cvErr) {
                                  console.log('[ms] canvas.toDataURL err: ' + cvErr.message);
                                  __lp = '';
                                }
                              }
                            }
                            // 3) Fallback: last_picture_url da localStorage
                            if (!__lp || __lp.indexOf('data:image/') !== 0) {
                              __lp = String(localStorage.getItem('last_picture_url') || '').trim();
                              if (__lp) console.log('[ms] photo from localStorage url type=' + __lp.slice(0, 20));
                            }
                            __ln = String(localStorage.getItem('last_picture_name') || '').trim();
                          } catch (_) {}

                          var __evtRaw = 'evento_senza_nome';
                          try {
                            // 1) Selezione salvata al click START (sorgente di verità)
                            var __savedEvtTxt = String(localStorage.getItem(MS_LAST_EVT_KEY) || '').trim();
                            if (__savedEvtTxt) {
                              __evtRaw = __savedEvtTxt;
                              console.log('[ms] evtRaw from localStorage: ' + __evtRaw);
                            } else {
                              // 2) Fallback: dropdown corrente
                              var __es = document.getElementById('ms-evt-sel');
                              if (__es && __es.selectedIndex >= 0 && __es.options && __es.options[__es.selectedIndex]) {
                                var __esTxt = String(__es.options[__es.selectedIndex].textContent || '').trim();
                                if (__esTxt) __evtRaw = __esTxt;
                              }
                              console.log('[ms] evtRaw from dropdown: ' + __evtRaw + ' (saved was empty)');
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

                          var __runFallbackSave = function() {
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
                          };

                          var __saveViaIpc = function(dataUrl) {
                            return window.electronAPI.saveCapturedPhoto({
                              dataUrl: dataUrl,
                              fileName: __ln,
                              eventName: __evtRaw
                            }).then(function(res) {
                              try {
                                if (res && res.success) {
                                  console.log('[ms] saveCapturedPhoto OK path=' + (res.path || ''));
                                  try { if (typeof window.__msRefreshPreviewIdWatermark === 'function') window.__msRefreshPreviewIdWatermark(); } catch (_) {}
                                  try {
                                    if (typeof window.__msPlaySaveSound === 'function') {
                                      window.__msPlaySaveSound();
                                    }
                                  } catch (_) {}
                                  return res;
                                }
                                console.log('[ms] saveCapturedPhoto FAIL', res && res.message ? res.message : 'unknown');
                              } catch (_) {}
                              return null;
                            }).catch(function() { return null; });
                          };

                          var __printSavedOriginal = function(savedRes) {
                            return new Promise(function(resolve) {
                              try {
                                if (!savedRes || !savedRes.path || !window.electronAPI || typeof window.electronAPI.printImage !== 'function') {
                                  resolve(false); return;
                                }
                                // L'intento di stampa e' ESPLICITO: solo il click su
                                // "Salva e stampa" imposta window.__msPendingPrint=true.
                                // Il bottone "Salva" puro NON deve mai stampare.
                                var __wantsPrint = !!window.__msPendingPrint;
                                if (!__wantsPrint) { resolve(false); return; }
                                try { window.__msPendingPrint = false; } catch (_) {}
                                try { console.log('[ms] preview-print -> path=' + String(savedRes.path)); } catch (_) {}
                                try { showToast('Invio stampa…', 1600, '#3b82f6'); } catch (_) {}

                                try {
                                  var __cur = (window.__msPrinterState && typeof window.__msPrinterState === 'object') ? window.__msPrinterState : {};
                                  window.__msPrinterState = Object.assign({}, __cur, {
                                    status: 'busy',
                                    label: 'Invio in stampa…',
                                    hasActiveJob: true,
                                    progress: 5,
                                  });
                                  if (typeof window.__msUpdatePrinterState === 'function') window.__msUpdatePrinterState(window.__msPrinterState);
                                } catch (_) {}

                                var __printerName = (window.__msPrinterState && window.__msPrinterState.printerName) ? window.__msPrinterState.printerName : null;
                                try { console.log('[ms] printImage call printer=' + String(__printerName || '(default)')); } catch (_) {}
                                window.electronAPI.printImage(String(savedRes.path), __printerName, { copies: 1, paperSize: 'Paper10x15', orientation: 'Portrait' })
                                  .then(function(res) {
                                    try { console.log('[ms] printImage res=' + JSON.stringify(res || null)); } catch (_) {}
                                    if (res && res.success) {
                                      try { showToast('Stampa avviata', 1800, '#22c55e'); } catch (_) {}
                                      try { if (typeof window.__msFetchPrinterState === 'function') window.__msFetchPrinterState(true); } catch (_) {}
                                      resolve(true);
                                      return;
                                    }
                                    if (res && res.busy) {
                                      try { showToast('Stampante occupata: attendi…', 2200, '#facc15'); } catch (_) {}
                                      try { if (typeof window.__msFetchPrinterState === 'function') window.__msFetchPrinterState(true); } catch (_) {}
                                      resolve(false);
                                      return;
                                    }
                                    try { showToast('Stampa fallita: ' + ((res && res.message) || 'errore sconosciuto'), 2600, '#ef4444'); } catch (_) {}
                                    try { if (typeof window.__msFetchPrinterState === 'function') window.__msFetchPrinterState(true); } catch (_) {}
                                    resolve(false);
                                  })
                                  .catch(function(err) {
                                    try { console.log('[ms] printImage error=' + String(err && err.message ? err.message : err)); } catch (_) {}
                                    try { showToast('Errore stampa: ' + (err && err.message ? err.message : 'sconosciuto'), 2600, '#ef4444'); } catch (_) {}
                                    try { if (typeof window.__msFetchPrinterState === 'function') window.__msFetchPrinterState(true); } catch (_) {}
                                    resolve(false);
                                  });
                              } catch (_) { resolve(false); }
                            });
                          };

                          var __toDataUrlPromise = function(urlLike) {
                            return new Promise(function(resolve, reject) {
                              try {
                                var src = String(urlLike || '').trim();
                                if (!src) { reject(new Error('missing source')); return; }
                                if (src.indexOf('data:image/') === 0) { resolve(src); return; }

                                fetch(src).then(function(resp) {
                                  if (!resp || !resp.ok) throw new Error('fetch failed');
                                  return resp.blob();
                                }).then(function(blob) {
                                  var fr = new FileReader();
                                  fr.onloadend = function() { resolve(String(fr.result || '')); };
                                  fr.onerror = function() { reject(new Error('filereader error')); };
                                  fr.readAsDataURL(blob);
                                }).catch(reject);
                              } catch (err) { reject(err); }
                            });
                          };

                          // Composita foto + cornice in formato Canon Selphy (1200x1800, portrait 4"x6" a 300dpi)
                          var __compositeSelphy = function(dataUrl) {
                            return new Promise(function(resolve) {
                              try {
                                var SW = 1200, SH = 1800;
                                var PX_PER_MM_X = SW / 100;
                                var PX_PER_MM_Y = SH / 150;
                                var cvs = document.createElement('canvas');
                                cvs.width = SW; cvs.height = SH;
                                var ctx = cvs.getContext('2d');
                                // Sfondo bianco: le zone fuori dallo zoom restano bianche (no nero/trasparenza).
                                ctx.fillStyle = '#ffffff';
                                ctx.fillRect(0, 0, SW, SH);
                                // Ottieni src della cornice - cerca in ordine di affidabilità
                                var fSrc = '';
                                // 1) ms-preview-frame-ov: è visibile durante la preview/save con src piena
                                try {
                                  var fPrev = document.getElementById('ms-preview-frame-ov');
                                  if (fPrev && fPrev.src && fPrev.src.indexOf('data:') === 0) fSrc = fPrev.src;
                                  console.log('[ms] composite: preview-frame-ov srcLen=' + fSrc.length);
                                } catch (_) {}
                                // 2) ms-session-frame-ov
                                if (!fSrc) {
                                  try {
                                    var fSess = document.getElementById('ms-session-frame-ov');
                                    if (fSess && fSess.src && fSess.src.indexOf('data:') === 0) fSrc = fSess.src;
                                    console.log('[ms] composite: session-frame-ov srcLen=' + fSrc.length);
                                  } catch (_) {}
                                }
                                // 3) __msResolveFrameUrl legge direttamente da localStorage
                                if (!fSrc) {
                                  try {
                                    if (typeof window.__msResolveFrameUrl === 'function') {
                                      var resolved = String(window.__msResolveFrameUrl() || '');
                                      if (resolved && resolved.indexOf('data:') === 0) fSrc = resolved;
                                      console.log('[ms] composite: resolveUrl srcLen=' + fSrc.length);
                                    }
                                  } catch (_) {}
                                }
                                // 4) _msLocalFrames
                                if (!fSrc) {
                                  try {
                                    var selName = getSelectedFrameName();
                                    var frames = window._msLocalFrames || [];
                                    console.log('[ms] composite: localFrames count=' + frames.length + ' sel=' + selName);
                                    for (var fi = 0; fi < frames.length; fi++) {
                                      if (!selName || frames[fi].name === selName) { fSrc = frames[fi].url || ''; break; }
                                    }
                                    console.log('[ms] composite: localFrames fSrcLen=' + fSrc.length);
                                  } catch (_) {}
                                }
                                var __detectHoleRect = function(img) {
                                  try {
                                    var rect = null;
                                    if (typeof __msComputeTransparentRectFromImage === 'function') {
                                      rect = __msComputeTransparentRectFromImage(img);
                                    }
                                    var fallbackRect = (typeof __msDefaultPreviewRect !== 'undefined' && __msDefaultPreviewRect) ? __msDefaultPreviewRect : { left: 0.0767, top: 0.0615, width: 0.8466, height: 0.7812 };
                                    if (typeof __msNormalizePreviewRect === 'function') return __msNormalizePreviewRect(rect, fallbackRect);
                                    return rect || fallbackRect || null;
                                  } catch (_) { return null; }
                                };
                                var drawFrame = function(frameCal, photoImg) {
                                  if (!fSrc) {
                                    console.log('[ms] composite: no frame src, saving photo only');
                                    resolve(cvs.toDataURL('image/jpeg', 0.95)); return;
                                  }
                                  var fImg = new Image();
                                  fImg.onload = function() {
                                    try {
                                      var offXmmF = Number(frameCal && frameCal.offsetXmm);
                                      var offYmmF = Number(frameCal && frameCal.offsetYmm);
                                      var zoomPctF = Number(frameCal && frameCal.zoomPct);
                                      if (!isFinite(offXmmF)) offXmmF = 0;
                                      if (!isFinite(offYmmF)) offYmmF = 0;
                                      if (!isFinite(zoomPctF)) zoomPctF = 100;
                                      var zoomF = zoomPctF / 100;
                                      if (zoomF < 0.5) zoomF = 0.5;
                                      if (zoomF > 2) zoomF = 2;
                                      var frameW = SW * zoomF;
                                      var frameH = SH * zoomF;
                                      var offXF = offXmmF * PX_PER_MM_X;
                                      var offYF = offYmmF * PX_PER_MM_Y;
                                      var photoOffXmmF = Number(frameCal && frameCal.photoOffsetXmm);
                                      var photoOffYmmF = Number(frameCal && frameCal.photoOffsetYmm);
                                      var photoZoomPctF = Number(frameCal && frameCal.photoZoomPct);
                                      if (!isFinite(photoOffXmmF)) photoOffXmmF = 0;
                                      if (!isFinite(photoOffYmmF)) photoOffYmmF = 0;
                                      if (!isFinite(photoZoomPctF)) photoZoomPctF = 100;
                                      var photoZoomF = photoZoomPctF / 100;
                                      if (photoZoomF < 0.5) photoZoomF = 0.5;
                                      if (photoZoomF > 2) photoZoomF = 2;
                                      var photoOffXF = photoOffXmmF * PX_PER_MM_X;
                                      var photoOffYF = photoOffYmmF * PX_PER_MM_Y;
                                      var frameCx = SW / 2 + offXF;
                                      var frameCy = SH / 2 + offYF;
                                      var frameX = frameCx - frameW / 2;
                                      var frameY = frameCy - frameH / 2;

                                      // Riempi bianco, poi foto indipendente dalla cornice, cornice sopra.
                                      ctx.fillStyle = '#ffffff';
                                      ctx.fillRect(0, 0, SW, SH);
                                      if (photoImg) {
                                        var holeRect = __detectHoleRect(fImg);
                                        var basePhX = holeRect ? (holeRect.left * SW) : 0;
                                        var basePhY = holeRect ? (holeRect.top * SH) : 0;
                                        var basePhW = holeRect ? (holeRect.width * SW) : SW;
                                        var basePhH = holeRect ? (holeRect.height * SH) : SH;
                                        var phW = basePhW * photoZoomF;
                                        var phH = basePhH * photoZoomF;
                                        var phX = basePhX + (basePhW - phW) / 2 + photoOffXF;
                                        var phY = basePhY + (basePhH - phH) / 2 + photoOffYF;
                                        try {
                                          var piw = photoImg.naturalWidth, pih = photoImg.naturalHeight;
                                          var pir = piw / pih, par = phW / phH;
                                          var psx = 0, psy = 0, psw = piw, psh = pih;
                                          if (pir > par) { psw = pih * par; psx = (piw - psw) / 2; }
                                          else if (pir < par) { psh = piw / par; psy = (pih - psh) / 2; }
                                          ctx.drawImage(photoImg, psx, psy, psw, psh, phX, phY, phW, phH);
                                        } catch (_) {}
                                      }
                                      ctx.drawImage(fImg, frameX, frameY, frameW, frameH);
                                      var result = cvs.toDataURL('image/jpeg', 0.95);
                                      console.log('[ms] composite: done size=' + Math.round(result.length / 1024) + 'KB');
                                      resolve(result);
                                    } catch (e) { console.log('[ms] composite drawFrame err: ' + e.message); resolve(cvs.toDataURL('image/jpeg', 0.95)); }
                                  };
                                  fImg.onerror = function() { console.log('[ms] composite: fImg onerror'); resolve(cvs.toDataURL('image/jpeg', 0.95)); };
                                  fImg.src = fSrc;
                                };
                                var pImg = new Image();
                                pImg.onload = function() {
                                  try {
                                    var sw = pImg.naturalWidth, sh = pImg.naturalHeight;
                                    console.log('[ms] composite: pImg loaded ' + sw + 'x' + sh);
                                    var __resolveCalForComposite = function() {
                                      try {
                                        var clampNum = function(v, min, max, fb) {
                                          var n = parseFloat(v);
                                          if (!isFinite(n)) n = fb;
                                          return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
                                        };
                                        var selectedFrame = '';
                                        try { selectedFrame = String(localStorage.getItem('msSelectedFrameV1') || ''); } catch (_) {}
                                        var frameKey = 'postcard::' + selectedFrame;
                                        var framePresets = {};
                                        var presets = {};
                                        try { framePresets = JSON.parse(localStorage.getItem('ms-cal-frame-presets-v1') || '{}') || {}; } catch (_) { framePresets = {}; }
                                        try { presets = JSON.parse(localStorage.getItem('ms-cal-presets-v1') || '{}') || {}; } catch (_) { presets = {}; }
                                        var byFrame = selectedFrame ? framePresets[frameKey] : null;
                                        var base = (byFrame && typeof byFrame === 'object') ? byFrame : (presets.postcard || null);
                                        if (base && typeof base === 'object') {
                                          return {
                                            offsetXmm: clampNum(base.offsetXmm, -5, 5, 0),
                                            offsetYmm: clampNum(base.offsetYmm, -5, 5, 0),
                                            zoomPct: clampNum(base.zoomPct, 80, 120, 100),
                                            photoOffsetXmm: clampNum(base.photoOffsetXmm, -5, 5, 0),
                                            photoOffsetYmm: clampNum(base.photoOffsetYmm, -5, 5, 0),
                                            photoZoomPct: clampNum(base.photoZoomPct, 80, 120, 100)
                                          };
                                        }
                                      } catch (_) {}
                                      try {
                                        if (typeof window.__msGetEffectiveCalibrationForSave === 'function') {
                                          var c = window.__msGetEffectiveCalibrationForSave('postcard');
                                          if (c && typeof c === 'object') return c;
                                        }
                                      } catch (_) {}
                                      return { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
                                    };
                                    var __cal = null;
                                    try {
                                      __cal = __resolveCalForComposite();
                                    } catch (_) {}
                                    var offXmm = Number(__cal && __cal.offsetXmm);
                                    var offYmm = Number(__cal && __cal.offsetYmm);
                                    var zoomPct = Number(__cal && __cal.zoomPct);
                                    if (!isFinite(offXmm)) offXmm = 0;
                                    if (!isFinite(offYmm)) offYmm = 0;
                                    if (!isFinite(zoomPct)) zoomPct = 100;
                                    // La foto verra' allineata in drawFrame con offset foto dedicati.
                                    drawFrame(__cal, pImg);
                                  } catch (e) { console.log('[ms] composite pImg err: ' + e.message); resolve(dataUrl); }
                                };
                                pImg.onerror = function() { console.log('[ms] composite: pImg onerror'); resolve(dataUrl); };
                                pImg.src = dataUrl;
                              } catch (e) { console.log('[ms] composite outer err: ' + e.message); resolve(dataUrl); }
                            });
                          };

                          if (__lp && window.electronAPI && typeof window.electronAPI.saveCapturedPhoto === 'function') {
                            __toDataUrlPromise(__lp).then(function(dataUrl) {
                              if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) return Promise.resolve(dataUrl);
                              return __compositeSelphy(dataUrl);
                            }).then(function(composited) {
                              if (!composited || composited.indexOf('data:image/') !== 0) { __runFallbackSave(); return; }
                              return __saveViaIpc(composited);
                            }).then(function(savedRes) {
                              return __printSavedOriginal(savedRes).then(function() { return savedRes; });
                            }).then(function() {
                              try {
                                // Evita che il flusso remoto stampi l'anteprima con formato errato.
                                var __cb2 = __msGetPrintCheckbox();
                                if (__cb2) __cb2.checked = false;
                                var __stBtn2 = document.getElementById('ms-btn-stampa');
                                if (__stBtn2) __stBtn2.setAttribute('data-checked', '0');
                              } catch (_) {}
                              __runFallbackSave();
                            }).catch(function() {
                              __runFallbackSave();
                            });
                          } else {
                            __runFallbackSave();
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

    // ── Photo interceptors ───────────────────────────────────────────────────
    // Cattura il dataUrl del blob E il canvas APPENA viene scattata la foto,
    // così il bottone Salva può usarli anche se il blob URL viene revocato o
    // se la pagina non fa un download locale.
    if (!window.__msBlobInterceptorV1) {
      window.__msBlobInterceptorV1 = true;

      // 1) Intercetta URL.createObjectURL (blob → dataUrl via FileReader)
      var __origCOU = URL.createObjectURL;
      URL.createObjectURL = function(obj) {
        var result = __origCOU.call(URL, obj);
        try {
          if (obj && obj.type && String(obj.type).indexOf('image/') === 0 && obj.size > 10000) {
            var fr = new FileReader();
            fr.onloadend = function() {
              var du = String(fr.result || '');
              if (du && du.indexOf('data:image/') === 0) {
                window.__msLastBlobDataUrl = du;
                console.log('[ms] blob intercepted size=' + Math.round(du.length / 1024) + 'KB');
              }
            };
            fr.readAsDataURL(obj);
          }
        } catch (_) {}
        return result;
      };

      // 2) Intercetta canvas.toBlob → salva riferimento al canvas
      var __origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
        var self = this;
        try {
          if (self.width > 100 && self.height > 100) {
            window.__msLastPhotoCanvas = self;
            console.log('[ms] canvas.toBlob intercepted ' + self.width + 'x' + self.height);
          }
        } catch (_) {}
        return __origToBlob.call(self, cb, type, quality);
      };

      // 3) Intercetta canvas.toDataURL → salva dataUrl direttamente
      var __origToDU = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
        var result = __origToDU.call(this, type, quality);
        try {
          if (this.width > 100 && this.height > 100 && result && result.indexOf('data:image/') === 0) {
            window.__msLastBlobDataUrl = result;
            window.__msLastPhotoCanvas = this;
            console.log('[ms] canvas.toDataURL intercepted size=' + Math.round(result.length / 1024) + 'KB');
          }
        } catch (_) {}
        return result;
      };
    }

    // Determina lo stato sessione dall'URL corrente (evita il race condition del main process)
    var __pn = window.location.pathname;
    var _msSessionPersistedAtBoot = (__pn.indexOf('/mirror/index') >= 0 && __pn !== '/mirror/index.php');
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
        transition: opacity 180ms ease-out;
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
      .ms-tb-sep { width: 1px; height: 22px; background: rgba(255,255,255,0.10); margin: 0 4px; }
      .ms-tb-cta { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; border-radius: 10px; cursor: pointer; font-family: inherit; transition: background 0.18s, transform 0.12s, box-shadow 0.18s, border-color 0.18s; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: #fff; }
      .ms-tb-cta:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.30); transform: translateY(-1px); }
      .ms-tb-cta:active { transform: scale(0.97); }
      .ms-tb-cta-primary { background: #E63946; border-color: rgba(230,57,70,0.85); box-shadow: 0 4px 18px rgba(230,57,70,0.40); }
      .ms-tb-cta-primary:hover { background: #c62828; border-color: rgba(230,57,70,1); box-shadow: 0 6px 24px rgba(230,57,70,0.55); }
      .ms-tb-cta-primary:disabled, .ms-tb-cta:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
      /* Vecchi pulsanti dentro al preview: nascosti, ora vivono nel topbar */
      #ms-start-btn, #ms-gallery-btn { display: none !important; }
      #ms-preview-wrap { flex: 0 0 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 14px 20px 8px; }
      #ms-preview-inner { position: relative; aspect-ratio: 2/3; height: 420px; max-height: 44vh; max-width: 100%; border-radius: 20px; overflow: hidden; background: #fff; box-shadow: 0 20px 70px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.07); }
      #ms-cam-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; transform: scaleX(-1); -webkit-transform: scaleX(-1); z-index: 1; }
      #ms-live-mask-top, #ms-live-mask-right, #ms-live-mask-bottom, #ms-live-mask-left { position: absolute; background: #fff; z-index: 1; pointer-events: none; display: none; }
      #ms-selphy-badge { position: absolute; bottom: 52px; left: 14px; z-index: 5; background: rgba(230,57,70,0.85); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.25); border-radius: 8px; padding: 6px 12px; font-size: 11px; font-weight: 700; color: #fff; letter-spacing: 0.07em; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.5); box-shadow: 0 2px 10px rgba(230,57,70,0.4); }
      #ms-safe-area { position: absolute; inset: 0; z-index: 4; pointer-events: none; border: 2px dashed rgba(255,255,255,0.55); border-radius: 10px; box-shadow: none; }
      #ms-safe-area::before, #ms-safe-area::after { content: ''; position: absolute; width: 20px; height: 20px; border-color: #fff; border-style: solid; }
      #ms-safe-area::before { top: -2px; left: -2px; border-width: 3px 0 0 3px; border-radius: 3px 0 0 0; }
      #ms-safe-area::after { bottom: -2px; right: -2px; border-width: 0 3px 3px 0; border-radius: 0 0 3px 0; }
      #ms-safe-area-br { position: absolute; bottom: -2px; left: -2px; width: 20px; height: 20px; border: 3px solid #fff; border-width: 0 0 3px 3px; border-radius: 0 0 0 3px; z-index: 4; pointer-events: none; }
      #ms-safe-area-tr { position: absolute; top: -2px; right: -2px; width: 20px; height: 20px; border: 3px solid #fff; border-width: 3px 3px 0 0; border-radius: 0 3px 0 0; z-index: 4; pointer-events: none; }
      #ms-safe-label { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 5; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; color: rgba(255,255,255,0.75); text-transform: uppercase; pointer-events: none; white-space: nowrap; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
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
      #ms-start-btn:hover { background: #c62828; box-shadow: 0 6px 28px rgba(230,57,70,0.6); }
      #ms-start-btn:active { filter: brightness(0.95); }
      #ms-gallery-btn {
        position: absolute; top: 62px; right: 14px; z-index: 10;
        background: rgba(22,22,28,0.82); color: #fff; border: 1px solid rgba(255,255,255,0.16); border-radius: 10px;
        padding: 8px 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
        cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
        transition: background 0.2s, transform 0.15s, border-color 0.2s; font-family: inherit;
      }
      #ms-gallery-btn:hover { background: rgba(30,30,40,0.92); border-color: rgba(255,255,255,0.28); transform: translateY(-1px); }
      #ms-gallery-btn:active { transform: scale(0.97); }
      #ms-id-watermark {
        position: absolute; right: 16px; bottom: 14px; z-index: 6; pointer-events: none;
        color: rgba(255,255,255,0.85); font-size: 22px; font-weight: 700; letter-spacing: 0.08em;
        text-shadow: 0 2px 14px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.85);
      }
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
      .ms-inp {
        width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
        color: #f8f9fa; font-size: 13px; font-weight: 500; padding: 9px 12px;
        outline: none; transition: border-color 0.2s, background-color 0.2s; font-family: inherit;
      }
      .ms-inp::placeholder { color: rgba(255,255,255,0.45); }
      .ms-inp:hover { border-color: rgba(255,255,255,0.25); background-color: rgba(255,255,255,0.1); }
      .ms-inp:focus { border-color: #E63946; }
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
      #ms-gallery-modal { position: fixed; inset: 0; z-index: 2147483500; display: none; align-items: center; justify-content: center; background: rgba(3,3,3,0.76); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); opacity: 0; transition: opacity 0.25s cubic-bezier(.22,.9,.25,1); }
      #ms-gallery-modal.show { opacity: 1; }
      #ms-gallery-card { width: 90vw; height: 80vh; max-width: 1680px; border-radius: 18px; border: 1px solid rgba(255,255,255,0.08); background: rgba(20,20,20,0.75); box-shadow: 0 30px 90px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,59,92,0.08), 0 0 36px rgba(255,59,92,0.10); display: flex; flex-direction: column; overflow: hidden; transform: translateY(10px) scale(0.985); transition: transform 0.25s cubic-bezier(.22,.9,.25,1); }
      #ms-gallery-modal.show #ms-gallery-card { transform: translateY(0) scale(1); }
      #ms-gallery-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(14,14,14,0.55); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
      .ms-gh-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .ms-gh-icon { width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; color: #fff; background: radial-gradient(circle at 35% 35%, rgba(255,59,92,0.55), rgba(255,59,92,0.12)); border: 1px solid rgba(255,255,255,0.16); box-shadow: 0 0 20px rgba(255,59,92,0.22); }
      .ms-gh-text { min-width: 0; display: flex; flex-direction: column; }
      #ms-gallery-title { color: #ffffff; font-size: 20px; font-weight: 800; letter-spacing: 0.01em; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #ms-gallery-subtitle { color: #aaaaaa; font-size: 12px; font-weight: 500; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #ms-gallery-close { width: 38px; height: 38px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.36); color: #fff; cursor: pointer; transition: background 0.2s, transform 0.2s, border-color 0.2s; }
      #ms-gallery-close:hover { background: rgba(255,59,92,0.28); border-color: rgba(255,59,92,0.75); transform: scale(1.06); }
      #ms-gallery-chips { display: flex; align-items: center; gap: 8px; padding: 10px 16px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); background: rgba(10,10,10,0.28); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
      #ms-gallery-chips::-webkit-scrollbar { height: 7px; }
      #ms-gallery-chips::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 999px; }
      #ms-gallery-chips::-webkit-scrollbar-track { background: transparent; }
      .ms-g-chip { border: 1px solid rgba(255,255,255,0.14); border-radius: 999px; background: rgba(16,16,24,0.66); color: #f5f5f5; font-size: 11px; font-weight: 700; padding: 6px 12px; cursor: pointer; white-space: nowrap; transition: transform 0.2s, border-color 0.2s, background 0.2s; }
      .ms-g-chip:hover { transform: translateY(-1px); border-color: rgba(255,59,92,0.48); background: rgba(28,28,36,0.8); }
      #ms-gallery-grid { position: relative; display: flex; flex-direction: column; gap: 16px; padding: 14px 18px 16px; flex: 1; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
      #ms-gallery-grid::-webkit-scrollbar { width: 8px; }
      #ms-gallery-grid::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 999px; }
      #ms-gallery-grid::-webkit-scrollbar-track { background: transparent; }
      .ms-g-section { position: relative; border-radius: 16px; border: 1px solid rgba(255,255,255,0.06); background: linear-gradient(180deg, rgba(18,18,22,0.50), rgba(10,10,12,0.62)); padding: 10px 10px 12px; }
      .ms-g-section:nth-child(odd) { background: linear-gradient(180deg, rgba(20,18,24,0.52), rgba(11,10,14,0.64)); }
      .ms-g-section-head { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -2px 2px 8px; padding: 6px 8px; border-radius: 10px; background: rgba(8,8,10,0.58); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
      .ms-g-section-title { color: #f4f4f4; font-size: 12px; font-weight: 800; letter-spacing: 0.04em; }
      .ms-g-section-sub { color: #b8b8c6; font-size: 11px; font-weight: 600; }
      .ms-g-section-line { height: 1px; margin-top: 6px; background: linear-gradient(90deg, rgba(255,59,92,0.28), rgba(255,255,255,0.06)); }
      .ms-g-row { display: flex; align-items: stretch; gap: 20px; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; padding: 6px 2px 4px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) transparent; }
      .ms-g-row::-webkit-scrollbar { height: 8px; }
      .ms-g-row::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 999px; }
      .ms-g-row::-webkit-scrollbar-track { background: transparent; }
      .ms-g-item { position: relative; flex: 0 0 clamp(240px, 24vw, 300px); width: clamp(240px, 24vw, 300px); min-width: 240px; max-width: 300px; height: clamp(460px, 56vh, 540px); flex-shrink: 0; scroll-snap-align: start; border-radius: 24px; overflow: hidden; border: 1px solid rgba(255,255,255,0.08); background: rgba(20,20,20,0.75); box-shadow: 0 12px 34px rgba(0,0,0,0.45); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: transform 0.25s cubic-bezier(.22,.9,.25,1), border-color 0.25s cubic-bezier(.22,.9,.25,1), box-shadow 0.25s cubic-bezier(.22,.9,.25,1); }
      .ms-g-media { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 18px 14px 70px; }
      .ms-g-bg { position: absolute; inset: 0; background-size: cover; background-position: center; filter: blur(20px) saturate(0.9); transform: scale(1.08); opacity: 0.48; }
      .ms-g-bg::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(7,7,7,0.25), rgba(7,7,7,0.62)); }
      .ms-g-photo { position: relative; z-index: 2; width: 100%; height: 100%; object-fit: contain; object-position: center center; display: block; border-radius: 16px; background: rgba(0,0,0,0.40); padding: 6px; box-sizing: border-box; transform: scale(1); transition: transform 0.25s cubic-bezier(.22,.9,.25,1); }
      .ms-g-item:hover, .ms-g-item.sel { border-color: rgba(255,59,92,0.72); box-shadow: 0 0 0 1px rgba(255,59,92,0.35), 0 18px 38px rgba(0,0,0,0.55), 0 0 28px rgba(255,59,92,0.16); transform: translateY(-3px) scale(1.015); }
      .ms-g-item:hover .ms-g-photo, .ms-g-item.sel .ms-g-photo { transform: scale(1.03); }
      .ms-g-id { position: absolute; top: 10px; left: 10px; padding: 4px 9px; border-radius: 999px; background: rgba(0,0,0,0.60); color: #fff; border: 1px solid rgba(255,255,255,0.16); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
      .ms-g-print-badge { position: absolute; top: 10px; right: 10px; z-index: 3; padding: 4px 9px; border-radius: 999px; font-size: 10px; font-weight: 800; letter-spacing: 0.04em; text-shadow: 0 1px 2px rgba(0,0,0,0.75); border: 1px solid transparent; }
      .ms-g-print-badge.printed { color: #d1fae5; background: rgba(16, 185, 129, 0.25); border-color: rgba(16, 185, 129, 0.55); }
      .ms-g-print-badge.not-printed { color: #e5e7eb; background: rgba(75, 85, 99, 0.32); border-color: rgba(148, 163, 184, 0.46); }
      .ms-g-actions { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; display: flex; gap: 8px; padding: 10px; background: linear-gradient(transparent, rgba(0,0,0,0.74) 38%, rgba(0,0,0,0.90) 100%); }
      .ms-g-btn { flex: 1; border: 1px solid rgba(255,255,255,0.18); border-radius: 9px; background: rgba(14,14,20,0.72); color: #fff; font-size: 11px; font-weight: 700; padding: 8px 8px; cursor: pointer; transition: transform 0.2s, background 0.2s, border-color 0.2s; }
      .ms-g-btn:hover { transform: translateY(-1px); background: rgba(26,26,34,0.82); }
      .ms-g-btn.del { border-color: rgba(255,59,92,0.55); color: #ffc3cf; background: rgba(255,59,92,0.16); }
      .ms-g-btn.del:hover { border-color: rgba(255,59,92,0.82); background: rgba(255,59,92,0.26); }
      .ms-g-skel-card { background: linear-gradient(100deg, rgba(28,28,34,0.8) 20%, rgba(42,42,52,0.9) 40%, rgba(28,28,34,0.8) 60%); background-size: 220% 100%; animation: msGSkeleton 1.1s linear infinite; }
      .ms-g-skel-card::after { content: ''; position: absolute; left: 10px; bottom: 10px; width: 60%; height: 12px; border-radius: 999px; background: rgba(0,0,0,0.28); }
      @keyframes msGSkeleton { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
      #ms-gallery-empty { display: none; margin: auto; color: #aaaaaa; font-size: 14px; text-align: center; padding: 20px; }
      #ms-gallery-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px 12px; border-top: 1px solid rgba(255,255,255,0.06); background: rgba(10,10,10,0.36); }
      #ms-gallery-count { color: #ffffff; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
      #ms-gallery-download-all { border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; background: rgba(14,14,20,0.72); color: #fff; font-size: 12px; font-weight: 700; padding: 8px 12px; cursor: pointer; transition: transform 0.2s, border-color 0.2s, background 0.2s; }
      #ms-gallery-download-all:hover { transform: translateY(-1px); border-color: rgba(255,59,92,0.55); background: rgba(24,24,32,0.85); }
      @media (max-width: 1280px) { .ms-g-row { gap: 16px; } .ms-g-item { flex-basis: clamp(228px, 28vw, 290px); width: clamp(228px, 28vw, 290px); } }
      @media (max-width: 980px) { #ms-gallery-card { width: 94vw; height: 84vh; } #ms-gallery-grid { padding: 10px 10px 12px; } .ms-g-row { gap: 12px; } .ms-g-item { flex-basis: clamp(210px, 42vw, 270px); width: clamp(210px, 42vw, 270px); height: clamp(430px, 62vh, 520px); } }
      #ms-gallery-viewer-modal { position: fixed; inset: 0; z-index: 2147483600; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.86); }
      #ms-gallery-viewer-card { position: relative; width: min(96vw, 860px); height: min(90vh, 1260px); display: flex; align-items: center; justify-content: center; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
      #ms-gallery-viewer-card.ms-dragging { cursor: grabbing; }
      #ms-gallery-viewer-media { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; box-shadow: 0 20px 70px rgba(0,0,0,0.7); -webkit-user-drag: none; user-select: none; -webkit-user-select: none; }
      .ms-gv-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.26); background: rgba(0,0,0,0.55); color: #fff; font-size: 28px; line-height: 1; cursor: pointer; }
      #ms-gallery-viewer-prev { left: 12px; }
      #ms-gallery-viewer-next { right: 12px; }
      #ms-gallery-viewer-close { position: absolute; top: 10px; right: 10px; width: 36px; height: 34px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.24); background: rgba(0,0,0,0.55); color: #fff; cursor: pointer; }
      #ms-gallery-viewer-delete { position: absolute; right: 10px; bottom: 10px; border: 1px solid rgba(230,57,70,0.65); border-radius: 8px; background: rgba(230,57,70,0.2); color: #ffd3d8; font-size: 12px; font-weight: 700; padding: 8px 12px; cursor: pointer; }
      #ms-gallery-viewer-meta { position: absolute; left: 10px; bottom: 10px; color: rgba(255,255,255,0.9); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-shadow: 0 2px 8px rgba(0,0,0,0.92); }
      /* Printer status badge in gallery header */
      #ms-gallery-printer-pill { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.10); background: rgba(16,16,20,0.62); min-width: 180px; max-width: 280px; }
      #ms-gallery-printer-pill .ms-pp-dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; box-shadow: 0 0 0 2px rgba(255,255,255,0.04); transition: background 0.25s, box-shadow 0.25s; flex: 0 0 auto; }
      #ms-gallery-printer-pill .ms-pp-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
      #ms-gallery-printer-pill .ms-pp-label { color: #f4f4f4; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #ms-gallery-printer-pill .ms-pp-bar { height: 4px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; display: none; }
      #ms-gallery-printer-pill .ms-pp-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #ffb347, #ff6b6b); transition: width 0.4s ease; }
      #ms-gallery-printer-pill[data-status="ready"] .ms-pp-dot { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.18); }
      #ms-gallery-printer-pill[data-status="busy"] .ms-pp-dot { background: #facc15; box-shadow: 0 0 0 4px rgba(250,204,21,0.20); animation: msPpPulse 1.2s ease-in-out infinite; }
      #ms-gallery-printer-pill[data-status="busy"] .ms-pp-bar { display: block; }
      #ms-gallery-printer-pill[data-status="error"] .ms-pp-dot { background: #ef4444; box-shadow: 0 0 0 4px rgba(239,68,68,0.22); }
      #ms-gallery-printer-pill[data-status="offline"] .ms-pp-dot { background: #94a3b8; box-shadow: 0 0 0 4px rgba(148,163,184,0.18); }
      #ms-gallery-printer-pill[data-status="no-printer"] .ms-pp-dot { background: #6b7280; }
      @keyframes msPpPulse { 0%,100% { box-shadow: 0 0 0 4px rgba(250,204,21,0.20); } 50% { box-shadow: 0 0 0 8px rgba(250,204,21,0.06); } }
      /* Topbar mini progress under Stampante indicator */
      .ms-prt-progress { display: none; width: 80px; height: 3px; border-radius: 999px; background: rgba(255,255,255,0.10); overflow: hidden; margin-left: 6px; align-self: center; }
      .ms-prt-progress-bar { width: 0%; height: 100%; background: linear-gradient(90deg, #ffb347, #ff6b6b); transition: width 0.4s ease; }
      #ms-si-prt[data-status="busy"] .ms-prt-progress { display: inline-block; }
      /* Gallery Stampa button states */
      .ms-g-btn.open.is-blocked { opacity: 0.55; cursor: not-allowed; filter: grayscale(0.4); }
      .ms-g-btn.open.is-busy { color: #ffe39a; border-color: rgba(250,204,21,0.55); background: rgba(120,80,20,0.42); cursor: progress; }
      .ms-g-btn.open.is-busy::after { content: ''; display: inline-block; width: 8px; height: 8px; margin-left: 6px; border-radius: 50%; background: #facc15; animation: msPpPulse 1.1s ease-in-out infinite; vertical-align: middle; }
      /* Printer dropdown styling refinements */
      .ms-field-printer .ms-sel { width: 100%; }
      /* Calibrazione stampa */
      #ms-c-calibration .ms-ct { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      #ms-c-calibration .ms-cal-hint { font-size: 11px; opacity: 0.65; font-weight: 400; }
      .ms-cal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; margin: 10px 0 12px; }
      .ms-cal-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 10px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
      .ms-cal-l { font-size: 12px; opacity: 0.85; }
      .ms-cal-stepper { display: inline-flex; align-items: center; gap: 4px; }
      .ms-cal-stepper input { width: 64px; text-align: center; font-variant-numeric: tabular-nums; font-size: 13px; padding: 4px 6px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.35); color: #fff; -moz-appearance: textfield; }
      .ms-cal-stepper input::-webkit-outer-spin-button, .ms-cal-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .ms-cal-btn { width: 26px; height: 26px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
      .ms-cal-btn:hover { background: rgba(255,255,255,0.14); }
      .ms-cal-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .ms-cal-action { padding: 7px 14px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; letter-spacing: 0.2px; }
      .ms-cal-action:hover { background: rgba(255,255,255,0.12); }
      .ms-cal-action[disabled] { opacity: 0.45; cursor: not-allowed; }
      .ms-cal-primary { background: linear-gradient(180deg,#3b82f6,#2563eb); border-color: rgba(59,130,246,0.6); }
      .ms-cal-primary:hover { background: linear-gradient(180deg,#60a5fa,#2563eb); }
      .ms-cal-ghost { background: transparent; }
      .ms-cal-status { margin-top: 8px; font-size: 11px; opacity: 0.7; min-height: 14px; }
      .ms-cal-body { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: start; }
      @media (max-width: 720px) { .ms-cal-body { grid-template-columns: 1fr; } }
      .ms-cal-controls { min-width: 0; }
      .ms-cal-preview-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; border-radius: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); }
      .ms-cal-preview-title { font-size: 10px; opacity: 0.65; letter-spacing: 0.4px; text-transform: uppercase; }
      .ms-cal-preview-stage { padding: 6px; background: repeating-linear-gradient(45deg, rgba(255,255,255,0.03) 0 6px, rgba(255,255,255,0.06) 6px 12px); border-radius: 6px; }
      #ms-cal-canvas { display: block; background: transparent; }
      .ms-cal-preview-legend { display: flex; gap: 8px; font-size: 9px; opacity: 0.65; flex-wrap: wrap; justify-content: center; }
      .ms-cal-preview-legend span { display: inline-flex; align-items: center; gap: 4px; }
      .ms-cal-lg-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

      /* ============================================================
         PREMIUM REDESIGN — overrides only (no DOM/handler changes)
         Tema dark cinematic + glassmorphism + glow rosso Sballando
         ============================================================ */
      @keyframes msFadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes msAmbientPulse { 0%,100% { opacity: 0.55; } 50% { opacity: 0.85; } }

      /* App background: nero profondo + sfumatura ambient rossa */
      #ms-app {
        background:
          radial-gradient(1200px 700px at 85% -10%, rgba(230,57,70,0.10), transparent 60%),
          radial-gradient(900px 600px at -10% 110%, rgba(230,57,70,0.07), transparent 55%),
          linear-gradient(180deg, #07070b 0%, #0a0a10 60%, #08080d 100%) !important;
      }
      #ms-app::before {
        content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0;
        background-image:
          radial-gradient(rgba(255,255,255,0.025) 1px, transparent 1px);
        background-size: 3px 3px;
        opacity: 0.35;
      }
      #ms-app > * { position: relative; z-index: 1; }

      /* Topbar: visual priority refined */
      #ms-topbar {
        height: 68px !important;
        padding: 0 28px !important;
        background:
          linear-gradient(180deg, rgba(18,18,24,0.78) 0%, rgba(10,10,14,0.62) 100%) !important;
        border-bottom: 1px solid rgba(255,255,255,0.07) !important;
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.30);
      }
      .ms-logo {
        display: inline-flex !important; align-items: center; height: 100%;
        text-shadow: none !important;
      }
      #ms-logo-img {
        display: block;
        height: 40px;
        width: auto;
        max-width: 220px;
        object-fit: contain;
        user-select: none;
        -webkit-user-drag: none;
      }
      .ms-status { gap: 10px !important; margin-left: auto; }
      .ms-si {
        padding: 5px 10px; border-radius: 999px;
        background: rgba(255,255,255,0.025);
        border: 1px solid rgba(255,255,255,0.05);
        font-size: 10.5px !important; font-weight: 500 !important;
        letter-spacing: 0.02em;
        color: rgba(255,255,255,0.48) !important;
        transition: background 0.2s, border-color 0.2s, color 0.2s;
      }
      .ms-si.active { color: rgba(255,255,255,0.76) !important; background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.09); }
      .ms-si .ms-dot { width: 6px; height: 6px; opacity: 0.9; }
      .ms-dot.online { box-shadow: 0 0 0 3px rgba(34,197,94,0.12) !important; }
      .ms-tb-cta {
        padding: 10px 16px !important; font-size: 12px !important; border-radius: 11px !important;
        background: rgba(255,255,255,0.04) !important;
        border: 1px solid rgba(255,255,255,0.09) !important;
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      }
      .ms-tb-cta:hover { background: rgba(255,255,255,0.08) !important; border-color: rgba(255,255,255,0.18) !important; }
      #ms-gallery-btn-top { min-width: 112px; justify-content: center; color: rgba(255,255,255,0.88) !important; }
      #ms-calibration-btn-top { min-width: 122px; justify-content: center; color: rgba(255,255,255,0.82) !important; }
      #ms-calibration-btn-top.is-active {
        background: rgba(230,57,70,0.20) !important;
        border-color: rgba(230,57,70,0.45) !important;
        color: #ffd8dc !important;
      }
      #ms-start-btn-top {
        min-width: 236px;
        height: 44px;
        justify-content: center;
        font-size: 13.5px !important;
        font-weight: 700 !important;
        letter-spacing: 0.07em !important;
      }
      .ms-tb-cta-primary {
        background: linear-gradient(180deg, #ff4d5c 0%, #d62b3a 100%) !important;
        border-color: rgba(255,90,103,0.65) !important;
        box-shadow: 0 10px 26px rgba(230,57,70,0.40), inset 0 1px 0 rgba(255,255,255,0.22) !important;
        text-shadow: 0 1px 2px rgba(0,0,0,0.35);
      }
      .ms-tb-cta-primary:hover {
        background: linear-gradient(180deg, #ff5d6c 0%, #c91f2f 100%) !important;
        box-shadow: 0 12px 34px rgba(230,57,70,0.52), inset 0 1px 0 rgba(255,255,255,0.24) !important;
      }
      .ms-tb-sep { height: 22px !important; background: rgba(255,255,255,0.05) !important; margin: 0 4px !important; }

      /* === F2.1: drawer e gear button rimossi dalla UI === */
      #ms-settings-btn, #ms-settings-backdrop, #ms-settings-drawer {
        display: none !important;
      }

      /* === F2.1: Quick actions Galleria/Calibrazione nel panel sx === */
      .ms-panel-actions {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
        margin-bottom: 4px;
      }
      .ms-pa-btn {
        display: inline-flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 14px;
        color: rgba(255,255,255,0.92);
        font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
        text-align: left; cursor: pointer;
        transition: background 180ms ease, border-color 180ms ease, transform 120ms ease, box-shadow 220ms ease, color 180ms ease;
      }
      .ms-pa-btn .ms-pa-ic {
        width: 32px; height: 32px; flex: 0 0 32px;
        border-radius: 9px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.82);
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 180ms ease, border-color 180ms ease, color 180ms ease;
      }
      .ms-pa-btn:hover {
        background: rgba(230,57,70,0.10);
        border-color: rgba(230,57,70,0.40);
        color: #ffd8dc;
        box-shadow: 0 6px 20px rgba(230,57,70,0.14);
      }
      .ms-pa-btn:hover .ms-pa-ic {
        background: rgba(230,57,70,0.16);
        border-color: rgba(230,57,70,0.45);
        color: #ffb3bb;
      }
      .ms-pa-btn:active { transform: translateY(1px); }
      .ms-pa-btn.is-active {
        background: rgba(230,57,70,0.18);
        border-color: rgba(230,57,70,0.55);
        color: #ffd8dc;
        box-shadow: 0 0 0 1px rgba(230,57,70,0.30);
      }

      /* === F2.1: Icona prima dei titoli card === */
      .ms-ct-ic {
        display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px;
        margin-right: 8px;
        color: rgba(255,90,103,0.90);
        opacity: 0.95;
        flex: 0 0 18px;
      }
      .ms-ct > span:first-child { display: inline-flex; align-items: center; }

      /* === F2.1: Cornici sotto START MIRROR — strip orizzontale === */
      #ms-frames-section {
        width: 100%;
        max-width: 100%;
        margin-top: 8px;
        padding: 14px 6px 10px;
        flex: 0 0 auto;
        animation: msFadeInUp 0.6s ease-out both;
        pointer-events: auto !important;
        position: relative;
        z-index: 5;
      }
      #ms-frames-section *,
      #ms-c-frames.ms-frames-strip,
      #ms-c-frames.ms-frames-strip * {
        pointer-events: auto;
      }
      #ms-c-frames.ms-frames-strip .ms-fi::after,
      #ms-c-frames.ms-frames-strip .ms-fi-del { pointer-events: none; }
      #ms-c-frames.ms-frames-strip .ms-fi-del { pointer-events: auto !important; }
      .ms-frames-head {
        display: flex; align-items: center; justify-content: space-between;
        margin: 0 8px 10px;
      }
      .ms-frames-title {
        display: inline-flex; align-items: center; gap: 8px;
        font-size: 11px; font-weight: 700; letter-spacing: 0.18em;
        color: rgba(255,255,255,0.62);
        text-transform: uppercase;
      }
      .ms-frames-title svg { color: rgba(255,90,103,0.85); }
      .ms-frames-nav { display: inline-flex; align-items: center; gap: 8px; }
      .ms-frames-arrow {
        width: 32px; height: 32px;
        display: inline-flex; align-items: center; justify-content: center;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        color: rgba(255,255,255,0.78);
        cursor: pointer;
        transition: background 160ms ease, border-color 160ms ease, color 160ms ease, transform 120ms ease, opacity 160ms ease;
      }
      .ms-frames-arrow:hover:not(:disabled) {
        background: rgba(230,57,70,0.14);
        border-color: rgba(230,57,70,0.45);
        color: #ffd8dc;
      }
      .ms-frames-arrow:active:not(:disabled) { transform: scale(0.94); }
      .ms-frames-arrow:disabled { opacity: 0.32; cursor: not-allowed; }
      .ms-frames-add {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; font-weight: 600;
        padding: 7px 12px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        color: rgba(255,255,255,0.86);
        cursor: pointer;
        transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
      }
      .ms-frames-add:hover {
        background: rgba(230,57,70,0.14);
        border-color: rgba(230,57,70,0.45);
        color: #ffd8dc;
      }

      /* Override layout della card cornici quando viene spostata sotto START */
      #ms-c-frames.ms-frames-strip {
        margin: 0 !important;
        padding: 0 !important;
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
        animation: none !important;
      }
      #ms-c-frames.ms-frames-strip:hover {
        background: transparent !important;
        border: 0 !important; box-shadow: none !important;
      }
      #ms-c-frames.ms-frames-strip > .ms-ct { display: none !important; }
      #ms-c-frames.ms-frames-strip #ms-frames-grid {
        display: flex !important;
        flex-wrap: nowrap !important;
        gap: 14px !important;
        margin-top: 0 !important;
        padding: 6px 8px 10px !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        scrollbar-width: thin;
        scrollbar-color: rgba(230,57,70,0.45) transparent;
      }
      #ms-c-frames.ms-frames-strip #ms-frames-grid::-webkit-scrollbar { height: 8px; }
      #ms-c-frames.ms-frames-strip #ms-frames-grid::-webkit-scrollbar-track { background: transparent; }
      #ms-c-frames.ms-frames-strip #ms-frames-grid::-webkit-scrollbar-thumb {
        background: linear-gradient(90deg, rgba(230,57,70,0.45), rgba(230,57,70,0.15));
        border-radius: 999px;
      }
      #ms-c-frames.ms-frames-strip #ms-frames-grid::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(90deg, rgba(230,57,70,0.65), rgba(230,57,70,0.30));
      }

      #ms-c-frames.ms-frames-strip .ms-fi {
        position: relative;
        width: 130px !important;
        height: 195px !important;
        border-radius: 14px !important;
        border: 2px solid rgba(255,255,255,0.10) !important;
        background: #0a0a0f !important;
        flex: 0 0 auto !important;
        overflow: hidden !important;
        cursor: pointer;
        transform: none !important;
        transition: border-color 140ms ease, box-shadow 140ms ease;
      }
      #ms-c-frames.ms-frames-strip .ms-fi::after {
        content: '';
        position: absolute; inset: 0;
        background: linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.5) 100%);
        opacity: 0; transition: opacity 220ms ease;
        pointer-events: none;
      }
      #ms-c-frames.ms-frames-strip .ms-fi:hover {
        border-color: rgba(255,90,103,0.55) !important;
        box-shadow: 0 0 0 1px rgba(255,90,103,0.35) !important;
      }
      /* Cornice selezionata: stessa posizione, ring rosso + glow stabile */
      #ms-c-frames.ms-frames-strip .ms-fi.sel {
        border-color: #ff5d6c !important;
        transform: none !important;
        z-index: 2;
        box-shadow:
          0 12px 30px rgba(0,0,0,0.55),
          0 0 26px rgba(230,57,70,0.40),
          0 0 0 3px rgba(255,90,103,0.95),
          0 0 0 6px rgba(255,90,103,0.14) !important;
      }
      /* Sostituisce l'overlay scuro ::after del default per l'elemento selezionato */
      #ms-c-frames.ms-frames-strip .ms-fi.sel::after {
        opacity: 0 !important;
      }
      /* Badge check tondo in alto a destra */
      #ms-c-frames.ms-frames-strip .ms-fi.sel::before {
        content: '';
        position: absolute; top: 8px; right: 8px; z-index: 3;
        width: 26px; height: 26px;
        border-radius: 999px;
        pointer-events: none;
        box-shadow:
          0 4px 14px rgba(230,57,70,0.55),
          0 0 0 2px rgba(0,0,0,0.50),
          inset 0 1px 0 rgba(255,255,255,0.30);
        background-image:
          url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'/></svg>"),
          linear-gradient(135deg, #ff6b7e 0%, #e63946 60%, #b8203a 100%);
        background-repeat: no-repeat, no-repeat;
        background-position: center, center;
      }

      /* Tile "+ Aggiungi" come prima opzione speciale (se presente) */
      #ms-c-frames.ms-frames-strip .ms-fi-add {
        display: flex; align-items: center; justify-content: center;
        font-size: 30px; color: rgba(255,255,255,0.4);
        background:
          repeating-linear-gradient(135deg, rgba(255,255,255,0.04) 0 6px, transparent 6px 12px),
          rgba(255,255,255,0.02) !important;
        border-style: dashed !important;
      }
      #ms-c-frames.ms-frames-strip .ms-fi-add:hover {
        color: #ffd8dc;
        background:
          repeating-linear-gradient(135deg, rgba(230,57,70,0.10) 0 6px, transparent 6px 12px),
          rgba(230,57,70,0.04) !important;
      }

      /* Highlight-on-card quando una voce viene "puntata" — riusato come flash highlight */
      .ms-card.ms-sd-target {
        animation: ms-sd-pulse 1100ms ease;
        border-color: rgba(230,57,70,0.55) !important;
        box-shadow: 0 0 0 1px rgba(230,57,70,0.35), 0 16px 38px rgba(230,57,70,0.18) !important;
      }
      @keyframes ms-sd-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(230,57,70,0.55); }
        45%  { box-shadow: 0 0 0 6px rgba(230,57,70,0.20); }
        100% { box-shadow: 0 0 0 1px rgba(230,57,70,0.35), 0 16px 38px rgba(230,57,70,0.18); }
      }

      /* Preview: technical secondary stage */
      #ms-preview-wrap {
        position: relative;
        padding: 14px 24px 10px !important;
      }
      #ms-preview-wrap::before {
        content: none;
      }
      #ms-preview-inner {
        height: 540px !important; max-height: 56vh !important;
        border-radius: 18px !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        background: #08090d !important;
        box-shadow:
          0 12px 30px rgba(0,0,0,0.52),
          0 0 0 1px rgba(255,255,255,0.04) !important;
      }
      #ms-preview-inner::after {
        content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -28px 45px rgba(0,0,0,0.28);
      }
      #ms-cam-video { filter: saturate(0.84) brightness(0.82) contrast(0.94); }
      #ms-frame-ov { opacity: 0.86; }
      #ms-selphy-badge {
        background: rgba(18,18,26,0.62) !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
        color: rgba(255,255,255,0.75) !important;
        box-shadow: none !important;
      }
      #ms-safe-area,
      #ms-safe-area-br,
      #ms-safe-area-tr,
      #ms-safe-area::before,
      #ms-safe-area::after { opacity: 0.42; }
      #ms-safe-label { opacity: 0.56; letter-spacing: 0.10em !important; }

      /* ============== Calibrazione stampa — modal pro ============== */
      #ms-calibration-backdrop {
        position: fixed; inset: 0; z-index: 2147483400;
        background: rgba(4,4,8,0.78);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        display: none;
      }
      #ms-c-calibration { display: none; }
      #ms-c-calibration.ms-open {
        display: block !important;
        position: fixed !important;
        left: 50% !important; top: 50% !important;
        transform: translate(-50%, -50%) !important;
        animation: none !important;
        width: min(96vw, 1280px) !important;
        max-height: 92vh !important;
        overflow: hidden;
        z-index: 2147483500;
        padding: 0 !important;
        background: linear-gradient(180deg, #15161c 0%, #0e0f14 100%) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        border-radius: 20px !important;
        box-shadow: 0 30px 80px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.05), 0 0 60px rgba(230,57,70,0.10);
      }
      #ms-c-calibration.ms-open .ms-cal-head { display: flex !important; }
      .ms-cal-head {
        display: none;
        align-items: flex-start; justify-content: space-between;
        gap: 18px;
        padding: 18px 22px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ms-cal-head-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .ms-cal-head-eyebrow { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #ff6b78; opacity: 0.85; }
      .ms-cal-head-h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; color: #f5f6fa; }
      .ms-cal-head-sub { font-size: 12px; color: rgba(255,255,255,0.55); letter-spacing: 0.02em; }
      #ms-calibration-close {
        flex: 0 0 auto;
        width: 32px; height: 32px; border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.04);
        color: rgba(255,255,255,0.78);
        cursor: pointer; font-size: 15px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.18s, border-color 0.18s, color 0.18s;
      }
      #ms-calibration-close:hover { background: rgba(230,57,70,0.18); border-color: rgba(230,57,70,0.5); color: #ffd7db; }

      #ms-c-calibration.ms-open .ms-cal-body {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) 340px !important;
        grid-template-rows: 1fr !important;
        gap: 0 !important;
        padding: 0 !important;
        height: calc(92vh - 72px) !important;
        max-height: calc(92vh - 72px) !important;
        min-height: 520px !important;
      }
      #ms-c-calibration.ms-open .ms-cal-stage-col,
      #ms-c-calibration.ms-open .ms-cal-side { height: 100% !important; min-height: 0 !important; }
      .ms-cal-stage-col {
        display: flex; flex-direction: column;
        min-width: 0; min-height: 0;
        padding: 14px 18px 16px;
        gap: 12px;
        background:
          radial-gradient(900px 500px at 50% -10%, rgba(230,57,70,0.05), transparent 60%),
          #0a0b10;
        border-right: 1px solid rgba(255,255,255,0.05);
        overflow: hidden;
      }
      .ms-cal-stage-toolbar {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; flex-wrap: wrap;
      }
      .ms-cal-format-tabs { display: flex; gap: 6px; padding: 4px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; }
      .ms-cal-tab {
        font-family: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em;
        padding: 7px 12px; border-radius: 9px;
        background: transparent; color: rgba(255,255,255,0.62);
        border: 1px solid transparent; cursor: pointer;
        transition: background 0.16s, color 0.16s, border-color 0.16s;
      }
      .ms-cal-tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
      .ms-cal-tab.is-active {
        background: linear-gradient(180deg, rgba(230,57,70,0.22), rgba(230,57,70,0.10));
        color: #ffd7db;
        border-color: rgba(230,57,70,0.45);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      }
      .ms-cal-stage-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .ms-cal-mini-toggle {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; color: rgba(255,255,255,0.65);
        padding: 6px 10px; border-radius: 9px;
        background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
        cursor: pointer; user-select: none;
      }
      .ms-cal-mini-toggle input { accent-color: #ef4444; transform: translateY(0.5px); }
      .ms-cal-zoom { display: inline-flex; align-items: center; gap: 4px; padding: 4px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 9px; }
      .ms-cal-zoom-btn { width: 24px; height: 24px; border-radius: 6px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: #fff; font-weight: 700; cursor: pointer; line-height: 1; }
      .ms-cal-zoom-btn:hover { background: rgba(230,57,70,0.18); border-color: rgba(230,57,70,0.4); }
      #ms-cal-zoom-val { font-size: 11px; min-width: 38px; text-align: center; color: rgba(255,255,255,0.78); font-variant-numeric: tabular-nums; }

      .ms-cal-stage {
        position: relative;
        flex: 1 1 auto; min-height: 0;
        display: flex; align-items: safe center; justify-content: safe center;
        background:
          radial-gradient(closest-side at 50% 40%, rgba(255,255,255,0.04), transparent 70%),
          repeating-linear-gradient(45deg, rgba(255,255,255,0.018) 0 12px, rgba(255,255,255,0.030) 12px 24px);
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.05);
        overflow: auto;
      }
      #ms-cal-canvas {
        display: block;
        max-width: none; max-height: none;
        transform-origin: top left;
        filter: drop-shadow(0 22px 38px rgba(0,0,0,0.55)) drop-shadow(0 4px 10px rgba(0,0,0,0.4));
      }
      .ms-cal-coords {
        position: absolute; left: 14px; bottom: 12px;
        font-size: 11px; color: rgba(255,255,255,0.65);
        background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.08);
        padding: 5px 9px; border-radius: 7px;
        font-variant-numeric: tabular-nums; pointer-events: none;
      }

      .ms-cal-legend {
        display: flex; flex-wrap: wrap; gap: 8px 16px;
        font-size: 11px; color: rgba(255,255,255,0.7);
        padding: 8px 4px 0;
      }
      .ms-cal-legend span { display: inline-flex; align-items: center; gap: 6px; }
      .ms-cal-lg-sw { width: 14px; height: 10px; border-radius: 3px; display: inline-block; }
      .ms-lg-paper { background: rgba(255,255,255,0.95); border: 1px solid rgba(255,255,255,0.4); }
      .ms-lg-print { background: #ffffff; border: 1px dashed rgba(0,0,0,0.55); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15); }
      .ms-lg-safe { background: rgba(34,197,94,0.35); border: 1px dashed #22c55e; }
      .ms-lg-crop { background: rgba(239,68,68,0.30); border: 1px dashed #ef4444; }

      .ms-cal-side {
        display: flex; flex-direction: column; gap: 14px;
        padding: 16px 18px 18px;
        overflow: auto;
        background: rgba(255,255,255,0.012);
      }
      .ms-cal-side::-webkit-scrollbar { width: 8px; }
      .ms-cal-side::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 999px; }
      .ms-cal-section {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 14px;
        padding: 12px 14px;
      }
      .ms-cal-section-title {
        font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
        color: rgba(255,255,255,0.5); margin-bottom: 10px;
      }
      .ms-cal-paper-info {
        font-size: 12px; line-height: 1.55; color: rgba(255,255,255,0.78);
        font-variant-numeric: tabular-nums;
      }
      .ms-cal-paper-info b { color: #fff; font-weight: 600; }

      .ms-cal-slider-row { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; }
      .ms-cal-slider-row + .ms-cal-slider-row { border-top: 1px dashed rgba(255,255,255,0.05); padding-top: 12px; margin-top: 6px; }
      .ms-cal-slider-label { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: rgba(255,255,255,0.78); }
      .ms-cal-slider-val { font-variant-numeric: tabular-nums; color: #fff; font-weight: 600; }
      .ms-cal-slider-wrap { padding: 4px 0; }
      .ms-cal-slider-wrap input[type=range] {
        -webkit-appearance: none; appearance: none;
        width: 100%; height: 4px; border-radius: 4px;
        background: linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0.20));
        outline: none; cursor: pointer;
      }
      .ms-cal-slider-wrap input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 18px; height: 18px; border-radius: 50%;
        background: linear-gradient(180deg, #ff6171, #d62b3a);
        border: 2px solid #fff;
        box-shadow: 0 4px 14px rgba(230,57,70,0.45);
        cursor: pointer;
      }
      .ms-cal-slider-axis { display: flex; justify-content: space-between; font-size: 10px; color: rgba(255,255,255,0.4); font-variant-numeric: tabular-nums; }

      #ms-c-calibration .ms-cal-actions { display: flex !important; flex-wrap: wrap; gap: 8px; }
      #ms-c-calibration .ms-cal-action { padding: 9px 14px !important; font-size: 12px !important; border-radius: 10px !important; }
      #ms-c-calibration .ms-cal-status { font-size: 11.5px !important; opacity: 0.7 !important; padding-top: 8px; min-height: 16px; }

      @media (max-width: 880px) {
        #ms-c-calibration.ms-open .ms-cal-body {
          grid-template-columns: 1fr !important;
          height: auto !important; max-height: calc(92vh - 72px) !important;
          overflow: auto !important;
        }
        .ms-cal-stage-col { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.05); }
      }

      /* === F2: Layout principale 2 colonne (panel sx, preview+CTA dx) === */
      #ms-app {
        display: grid !important;
        grid-template-rows: auto 1fr !important;
        grid-template-columns: minmax(320px, 380px) 1fr !important;
        grid-template-areas:
          "topbar topbar"
          "panel  preview" !important;
        gap: 0 !important;
      }
      #ms-topbar { grid-area: topbar; }
      #ms-panel { grid-area: panel; }
      #ms-preview-wrap { grid-area: preview; }
      #ms-settings-backdrop, #ms-settings-drawer { grid-column: 1 / -1; }

      @media (max-width: 1100px) {
        #ms-app {
          grid-template-columns: 300px 1fr !important;
        }
      }
      @media (max-width: 900px) {
        #ms-app {
          grid-template-columns: 1fr !important;
          grid-template-areas:
            "topbar"
            "preview"
            "panel" !important;
        }
      }

      /* Stage destra: preview enorme + CTA START sotto (centrato) */
      #ms-preview-wrap {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 20px !important;
        padding: 22px 28px 28px !important;
        min-height: 0 !important;
      }
      #ms-preview-inner {
        position: relative !important;
        aspect-ratio: 2 / 3 !important;
        height: auto !important;
        width: min(620px, 100%) !important;
        max-width: min(620px, 100%) !important;
        max-height: calc(100vh - 220px) !important;
        flex: 0 1 auto !important;
        min-height: 0 !important;
        border-radius: 22px !important;
        border: 1px solid rgba(255,255,255,0.10) !important;
        background: #ffffff !important;
        overflow: hidden !important;
        box-shadow:
          0 32px 70px rgba(0,0,0,0.65),
          0 0 0 1px rgba(255,255,255,0.04),
          0 0 80px rgba(230,57,70,0.06) !important;
        animation: msFadeInUp 0.55s ease-out both !important;
      }
      #ms-preview-inner::before {
        content: ''; position: absolute; inset: -1px; border-radius: inherit;
        background: linear-gradient(135deg, rgba(255,90,103,0.18), transparent 35%, transparent 70%, rgba(255,90,103,0.10));
        z-index: 0; pointer-events: none;
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask-composite: exclude; -webkit-mask-composite: xor;
        padding: 1px;
      }

      /* === F2: START MIRROR come CTA principale === */
      #ms-start-btn {
        display: inline-flex !important;
        position: static !important;
        margin: 0 !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 10px !important;
        min-width: 320px !important;
        max-width: 92% !important;
        height: 64px !important;
        padding: 0 36px !important;
        font-size: 15.5px !important;
        font-weight: 800 !important;
        letter-spacing: 0.14em !important;
        text-transform: uppercase;
        color: #fff !important;
        border: 0 !important;
        border-radius: 18px !important;
        cursor: pointer;
        background:
          radial-gradient(120% 220% at 50% 0%, rgba(255,255,255,0.30), transparent 55%),
          linear-gradient(135deg, #ff4d6d 0%, #e63946 50%, #b8203a 100%) !important;
        box-shadow:
          0 14px 36px rgba(230,57,70,0.45),
          0 4px 12px rgba(230,57,70,0.30),
          inset 0 1px 0 rgba(255,255,255,0.30),
          inset 0 -2px 0 rgba(0,0,0,0.18),
          0 0 0 1px rgba(255,90,103,0.55) !important;
        transition: transform 140ms ease, box-shadow 220ms ease, filter 220ms ease;
        z-index: 4 !important;
        flex: 0 0 auto !important;
      }
      #ms-start-btn::before {
        content: ''; position: absolute; inset: -2px; border-radius: 20px;
        background: linear-gradient(120deg, transparent, rgba(255,90,103,0.55), transparent);
        opacity: 0; filter: blur(14px); z-index: -1;
        transition: opacity 320ms ease;
      }
      #ms-start-btn:hover {
        transform: none;
        box-shadow:
          0 22px 50px rgba(230,57,70,0.58),
          0 6px 18px rgba(230,57,70,0.40),
          inset 0 1px 0 rgba(255,255,255,0.36),
          inset 0 -2px 0 rgba(0,0,0,0.18),
          0 0 0 1px rgba(255,120,135,0.85) !important;
      }
      #ms-start-btn:active {
        transform: none;
        box-shadow:
          0 8px 18px rgba(230,57,70,0.40),
          inset 0 2px 4px rgba(0,0,0,0.30),
          0 0 0 1px rgba(255,90,103,0.6) !important;
      }
      #ms-start-btn:disabled {
        opacity: 0.45; cursor: not-allowed; transform: none !important; filter: grayscale(0.4);
        box-shadow: 0 8px 16px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.10) !important;
      }
      #ms-start-btn svg {
        width: 18px; height: 18px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
      }
      /* Vecchia regola che lo nascondeva: la annulliamo (ms-gallery-btn resta nascosto) */
      #ms-gallery-btn { display: none !important; }

      /* Panel layout: più aria, scrollbar custom */
      #ms-panel {
        display: flex !important;
        flex-direction: column !important;
        gap: 12px !important;
        padding: 22px 18px 22px !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        border-right: 1px solid rgba(255,255,255,0.05) !important;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.012) 0%, transparent 30%) !important;
        scrollbar-width: thin;
        scrollbar-color: rgba(230,57,70,0.45) transparent;
      }
      #ms-panel::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
      #ms-panel::-webkit-scrollbar-track { background: transparent !important; }
      #ms-panel::-webkit-scrollbar-thumb { background: linear-gradient(180deg, rgba(230,57,70,0.45), rgba(230,57,70,0.18)) !important; border-radius: 999px !important; }
      #ms-panel::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, rgba(230,57,70,0.65), rgba(230,57,70,0.30)) !important; }

      /* === F3: Cards compatte premium === */
      .ms-card {
        position: relative;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.040) 0%, rgba(255,255,255,0.014) 100%) !important;
        border: 1px solid rgba(255,255,255,0.07) !important;
        border-radius: 14px !important;
        padding: 11px 14px 12px !important;
        backdrop-filter: blur(14px) saturate(140%) !important;
        -webkit-backdrop-filter: blur(14px) saturate(140%) !important;
        box-shadow:
          0 1px 0 rgba(255,255,255,0.04) inset,
          0 8px 22px rgba(0,0,0,0.30);
        transition: border-color 0.22s, transform 0.22s, box-shadow 0.22s, background 0.22s !important;
        animation: msFadeInUp 0.4s ease-out both;
      }
      .ms-card::before {
        content: '';
        position: absolute; top: 0; left: 12px; right: 12px; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,90,103,0.30), transparent);
        opacity: 0; transition: opacity 0.25s;
        pointer-events: none;
      }
      .ms-card:hover {
        border-color: rgba(255,90,103,0.22) !important;
        background: linear-gradient(180deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.020) 100%) !important;
        box-shadow:
          0 1px 0 rgba(255,255,255,0.06) inset,
          0 14px 32px rgba(0,0,0,0.42),
          0 0 22px rgba(230,57,70,0.08);
      }
      .ms-card:hover::before { opacity: 0.85; }
      .ms-card-full { grid-column: 1 / -1; }

      /* Titolo eyebrow */
      .ms-ct {
        font-size: 10px !important;
        font-weight: 700 !important;
        letter-spacing: 0.18em !important;
        text-transform: uppercase;
        color: rgba(255,255,255,0.48) !important;
        margin-bottom: 9px !important;
        padding-bottom: 7px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        display: flex; align-items: center; justify-content: space-between;
      }
      .ms-ct > span:first-child {
        display: inline-flex; align-items: center;
      }

      /* Inputs / Selects compatti */
      .ms-sel, .ms-inp {
        background: rgba(255,255,255,0.04) !important;
        border: 1px solid rgba(255,255,255,0.09) !important;
        border-radius: 10px !important;
        padding: 9px 12px !important;
        font-size: 13px !important;
        transition: border-color 0.18s, background 0.18s, box-shadow 0.18s !important;
      }
      .ms-sel { padding-right: 32px !important; }
      .ms-sel:hover, .ms-inp:hover {
        background: rgba(255,255,255,0.07) !important;
        border-color: rgba(255,255,255,0.18) !important;
      }
      .ms-sel:focus, .ms-inp:focus {
        border-color: rgba(230,57,70,0.65) !important;
        box-shadow: 0 0 0 3px rgba(230,57,70,0.15), 0 0 18px rgba(230,57,70,0.08) !important;
      }
      .ms-fl {
        font-size: 9.5px !important;
        font-weight: 700 !important;
        letter-spacing: 0.14em !important;
        text-transform: uppercase;
        color: rgba(255,255,255,0.46) !important;
      }
      .ms-field { gap: 5px !important; margin-bottom: 9px !important; }
      .ms-field:last-child { margin-bottom: 0 !important; }

      /* Toggle premium */
      .ms-tog { width: 44px !important; height: 24px !important; }
      .ms-slider { background: rgba(255,255,255,0.12) !important; border-radius: 999px !important; box-shadow: inset 0 1px 2px rgba(0,0,0,0.35); }
      .ms-slider::before { width: 18px !important; height: 18px !important; left: 3px !important; top: 3px !important; box-shadow: 0 2px 6px rgba(0,0,0,0.45) !important; }
      .ms-tog input:checked + .ms-slider {
        background: linear-gradient(90deg, #d62b3a, #ff5d6c) !important;
        box-shadow: inset 0 1px 2px rgba(0,0,0,0.25), 0 0 12px rgba(230,57,70,0.45);
      }
      .ms-tog input:checked + .ms-slider::before { transform: translateX(20px) !important; }
      .ms-tr {
        padding: 7px 0 !important;
        border-bottom: 1px solid rgba(255,255,255,0.035);
      }
      .ms-tr:last-of-type { border-bottom: 0 !important; }
      .ms-tl { font-size: 13px !important; font-weight: 500 !important; color: rgba(255,255,255,0.88) !important; }

      /* Path row + choose folder */
      .ms-path-display {
        background: rgba(0,0,0,0.32) !important;
        border: 1px solid rgba(255,255,255,0.07) !important;
        font-size: 12.5px !important; padding: 10px 14px !important; border-radius: 12px !important;
        color: rgba(255,255,255,0.78) !important;
      }
      #ms-btn-choose-folder {
        background: linear-gradient(180deg, rgba(230,57,70,0.20), rgba(230,57,70,0.10)) !important;
        border: 1px solid rgba(230,57,70,0.45) !important;
        color: #ff8b95 !important;
        padding: 10px 16px !important;
        border-radius: 12px !important;
        transition: transform 0.18s, background 0.18s, border-color 0.18s, box-shadow 0.18s !important;
      }
      #ms-btn-choose-folder:hover {
        background: linear-gradient(180deg, rgba(230,57,70,0.34), rgba(230,57,70,0.18)) !important;
        border-color: rgba(230,57,70,0.75) !important;
        transform: translateY(-1px);
        box-shadow: 0 8px 20px rgba(230,57,70,0.30);
      }

      /* Calibrazione: grid migliorato + canvas centrale */
      #ms-c-calibration .ms-cal-body {
        gap: 16px !important;
        align-items: start !important;
      }
      .ms-cal-grid {
        grid-template-columns: repeat(3, 1fr) !important;
        gap: 12px !important;
        margin: 4px 0 16px !important;
      }
      .ms-cal-row {
        flex-direction: column; align-items: stretch; gap: 8px !important;
        padding: 10px !important;
        background: rgba(255,255,255,0.025) !important;
        border: 1px solid rgba(255,255,255,0.06) !important;
        border-radius: 12px !important;
      }
      .ms-cal-l { font-size: 10.5px !important; letter-spacing: 0.10em !important; text-transform: uppercase; opacity: 0.55 !important; }
      .ms-cal-stepper { width: 100% !important; justify-content: space-between !important; }
      .ms-cal-stepper input {
        flex: 1; text-align: center; font-size: 15px !important; font-weight: 700 !important;
        background: rgba(0,0,0,0.30) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        border-radius: 10px !important; padding: 8px 10px !important;
        color: #fff !important;
      }
      .ms-cal-btn {
        width: 32px !important; height: 32px !important; border-radius: 10px !important;
        background: rgba(255,255,255,0.05) !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
        font-size: 16px !important; font-weight: 700 !important;
        transition: background 0.18s, transform 0.12s, border-color 0.18s !important;
      }
      .ms-cal-btn:hover { background: rgba(230,57,70,0.18) !important; border-color: rgba(230,57,70,0.55) !important; }
      .ms-cal-btn:active { transform: scale(0.92); }
      .ms-cal-actions { gap: 10px !important; flex-wrap: wrap; }
      .ms-cal-action {
        padding: 8px 14px !important; font-size: 12px !important; border-radius: 10px !important;
        letter-spacing: 0.05em !important;
        transition: transform 0.18s, background 0.18s, border-color 0.18s, box-shadow 0.18s !important;
      }
      .ms-cal-action:not(.ms-cal-primary):not(.ms-cal-ghost) {
        background: rgba(255,255,255,0.06) !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
      }
      .ms-cal-action:not(.ms-cal-primary):not(.ms-cal-ghost):hover {
        background: rgba(255,255,255,0.12) !important; border-color: rgba(255,255,255,0.24) !important; transform: translateY(-1px);
      }
      .ms-cal-primary {
        background: linear-gradient(180deg, #ff4d5c 0%, #d62b3a 100%) !important;
        border: 1px solid rgba(255,90,103,0.65) !important;
        box-shadow: 0 6px 20px rgba(230,57,70,0.42), inset 0 1px 0 rgba(255,255,255,0.18) !important;
      }
      .ms-cal-primary:hover {
        background: linear-gradient(180deg, #ff5d6c 0%, #c91f2f 100%) !important;
        transform: translateY(-1px);
        box-shadow: 0 10px 30px rgba(230,57,70,0.55) !important;
      }
      .ms-cal-ghost {
        background: transparent !important;
        border: 1px solid rgba(255,255,255,0.10) !important;
        color: rgba(255,255,255,0.65) !important;
      }
      .ms-cal-ghost:hover { background: rgba(255,255,255,0.05) !important; color: #fff !important; border-color: rgba(255,255,255,0.22) !important; }
      .ms-cal-status { font-size: 11.5px !important; opacity: 0.7 !important; padding-top: 6px; }

      .ms-cal-preview-wrap {
        padding: 10px !important; gap: 6px !important;
        border-radius: 16px !important;
        background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015)) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        box-shadow: 0 10px 28px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.04);
      }
      .ms-cal-preview-title {
        font-size: 11px !important; letter-spacing: 0.14em !important;
        color: rgba(255,255,255,0.55) !important;
        padding: 0 6px;
      }
      .ms-cal-preview-stage {
        padding: 8px !important; border-radius: 10px !important;
        background:
          repeating-linear-gradient(45deg, rgba(255,255,255,0.025) 0 8px, rgba(255,255,255,0.045) 8px 16px) !important;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
      }
      .ms-cal-preview-legend { font-size: 10px !important; opacity: 0.6 !important; }

      /* Frames grid */
      .ms-fi {
        width: 56px !important; height: 84px !important; border-radius: 10px !important;
        border-width: 2px !important;
        transition: transform 0.22s cubic-bezier(.22,1.2,.36,1), border-color 0.22s, box-shadow 0.22s !important;
      }
      .ms-fi:hover { transform: none !important; box-shadow: 0 10px 22px rgba(0,0,0,0.50); }
      .ms-fi.sel {
        border-color: #E63946 !important;
        box-shadow: 0 0 0 1px rgba(230,57,70,0.4), 0 0 20px rgba(230,57,70,0.55), 0 8px 22px rgba(0,0,0,0.45) !important;
      }
      #ms-add-frame-lbl {
        height: 36px !important; padding: 6px 16px !important;
        border-radius: 12px !important;
        border: 1px dashed rgba(255,255,255,0.18) !important;
      }
      #ms-add-frame-lbl:hover { border-color: rgba(230,57,70,0.55) !important; color: #ff8b95 !important; }

      /* Toast premium */
      #ms-toast {
        background: linear-gradient(180deg, #ff4d5c, #d62b3a) !important;
        border-radius: 12px !important;
        box-shadow: 0 10px 30px rgba(230,57,70,0.45), 0 0 0 1px rgba(255,255,255,0.10) inset !important;
        padding: 14px 22px !important;
        font-size: 13.5px !important;
        font-weight: 700 !important;
        letter-spacing: 0.02em !important;
      }
    \`;

    // â”€â”€ HTML OVERLAY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!document.getElementById('ms-app')) {
      var appDiv = document.createElement('div');
      appDiv.id = 'ms-app';
      appDiv.innerHTML =
        '<div id="ms-topbar">' +
          '<div class="ms-logo"><img src="logo%20sballando.png" alt="sballando" id="ms-logo-img"/></div>' +
          '<div class="ms-status">' +
            '<div class="ms-si" id="ms-si-cam"><span class="ms-dot" id="ms-d-cam"></span><span>Camera</span></div>' +
            '<div class="ms-si" id="ms-si-prt"><span class="ms-dot" id="ms-d-prt"></span><span id="ms-prt-label">Stampante</span><div class="ms-prt-progress" id="ms-prt-progress"><div class="ms-prt-progress-bar" id="ms-prt-progress-bar"></div></div></div>' +
            '<div class="ms-si" id="ms-si-evt"><span class="ms-dot" id="ms-d-evt"></span><span>Evento</span></div>' +
            '<div class="ms-tb-sep"></div>' +
            '<button id="ms-settings-btn" type="button" class="ms-tb-cta" aria-label="Impostazioni" title="Impostazioni">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<circle cx="12" cy="12" r="3"></circle>' +
                '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
              '</svg>' +
              '<span>Impostazioni</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div id="ms-settings-backdrop" aria-hidden="true"></div>' +
        '<aside id="ms-settings-drawer" aria-label="Impostazioni" aria-hidden="true">' +
          '<div class="ms-sd-head">' +
            '<div class="ms-sd-title"><span class="ms-sd-eyebrow">Pannello</span><span class="ms-sd-h1">Impostazioni</span></div>' +
            '<button id="ms-settings-close" type="button" class="ms-sd-close" aria-label="Chiudi">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +
          '<nav class="ms-sd-list">' +
            '<button type="button" class="ms-sd-item" data-action="gallery">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Galleria</b><em>Sfoglia foto evento</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
            '<button type="button" class="ms-sd-item" data-action="calibration">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Calibrazione</b><em>Allinea stampa Selphy</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
            '<div class="ms-sd-sep"><span>Configurazione</span></div>' +
            '<button type="button" class="ms-sd-item" data-action="printer">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Stampante</b><em>Seleziona dispositivo di stampa</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
            '<button type="button" class="ms-sd-item" data-action="sounds">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Suoni</b><em>Effetti audio</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
            '<button type="button" class="ms-sd-item" data-action="timing">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Tempi</b><em>Scatto · Inattivit\u00e0</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
            '<button type="button" class="ms-sd-item" data-action="folder">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Cartella salvataggio</b><em>Destinazione foto</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
            '<button type="button" class="ms-sd-item" data-action="advanced">' +
              '<span class="ms-sd-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg></span>' +
              '<span class="ms-sd-lb"><b>Opzioni avanzate</b><em>Toggle stampa &amp; altro</em></span>' +
              '<span class="ms-sd-arrow">›</span>' +
            '</button>' +
          '</nav>' +
          '<div class="ms-sd-foot">sballando &middot; v.kiosk</div>' +
        '</aside>' +
        '<div id="ms-preview-wrap">' +
          '<div id="ms-preview-inner">' +
            '<video id="ms-cam-video" autoplay muted playsinline></video>' +
            '<div id="ms-live-mask-top"></div>' +
            '<div id="ms-live-mask-right"></div>' +
            '<div id="ms-live-mask-bottom"></div>' +
            '<div id="ms-live-mask-left"></div>' +
            '<div id="ms-safe-area"><div id="ms-safe-area-br"></div><div id="ms-safe-area-tr"></div></div>' +
            '<div id="ms-safe-label">Formato Canon SELPHY 10×15</div>' +
            '<div id="ms-selphy-badge">SELPHY 10×15 · 1200×1800px</div>' +
            '<img id="ms-frame-ov" alt="" />' +
            '<div id="ms-preview-grad"></div>' +
            '<button id="ms-start-btn" type="button">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
              'START MIRROR' +
            '</button>' +
            '<button id="ms-gallery-btn" type="button">Galleria</button>' +
            '<div id="ms-id-watermark">ID 0001</div>' +
          '</div>' +
        '</div>' +
        '<div id="ms-panel">' +
          '<div class="ms-card" id="ms-c-dev">' +
            '<div class="ms-ct">Camera</div>' +
            '<select class="ms-sel" id="ms-cam-sel"><option value="">Ricerca camera\u2026</option></select>' +
          '</div>' +
          '<div class="ms-card" id="ms-c-evt">' +
            '<div class="ms-ct">Evento</div>' +
            '<div class="ms-field"><input class="ms-inp" id="ms-evt-search" type="text" placeholder="Cerca evento..." autocomplete="off"></div>' +
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
            '<div class="ms-field ms-field-printer"><span class="ms-fl">Stampante</span><select class="ms-sel" id="ms-printer-sel"><option value="">Seleziona stampante…</option></select></div>' +
          '</div>' +
          '<div class="ms-card" id="ms-c-timing">' +
            '<div class="ms-ct">Tempi</div>' +
            '<div class="ms-field"><span class="ms-fl">Scatto (secondi)</span><select class="ms-sel" id="ms-s-countdown"></select></div>' +
            '<div class="ms-field"><span class="ms-fl">Inattivit\u00e0 (minuti)</span><select class="ms-sel" id="ms-s-inactivity"></select></div>' +
          '</div>' +
          '<div class="ms-card ms-card-full" id="ms-c-calibration">' +
            '<div class="ms-cal-head">' +
              '<div class="ms-cal-head-title">' +
                '<span class="ms-cal-head-eyebrow">Stampa</span>' +
                '<span class="ms-cal-head-h1">Calibrazione Canon SELPHY CP1500</span>' +
                '<span class="ms-cal-head-sub" id="ms-cal-format-sub">Postcard 100×148 mm · KP-108</span>' +
              '</div>' +
              '<button type="button" id="ms-calibration-close" aria-label="Chiudi calibrazione">✕</button>' +
            '</div>' +
            '<div class="ms-cal-body">' +
              '<div class="ms-cal-stage-col">' +
                '<div class="ms-cal-stage-toolbar">' +
                  '<div class="ms-cal-format-tabs" id="ms-cal-format-tabs">' +
                    '<button type="button" class="ms-cal-tab is-active" data-format="postcard">Postcard 10×15</button>' +
                  '</div>' +
                  '<div class="ms-cal-stage-tools">' +
                    '<label class="ms-cal-mini-toggle"><input type="checkbox" id="ms-cal-show-ruler" checked><span>Righelli mm</span></label>' +
                    '<label class="ms-cal-mini-toggle"><input type="checkbox" id="ms-cal-show-coords" checked><span>Coordinate</span></label>' +
                    '<div class="ms-cal-zoom"><button type="button" class="ms-cal-zoom-btn" data-zoom-step="-1" aria-label="Riduci zoom anteprima">−</button><span id="ms-cal-zoom-val">100%</span><button type="button" class="ms-cal-zoom-btn" data-zoom-step="1" aria-label="Aumenta zoom anteprima">+</button></div>' +
                  '</div>' +
                '</div>' +
                '<div class="ms-cal-stage" id="ms-cal-stage">' +
                  '<canvas id="ms-cal-canvas" width="460" height="690"></canvas>' +
                  '<div class="ms-cal-coords" id="ms-cal-coords">— mm</div>' +
                '</div>' +
                '<div class="ms-cal-legend">' +
                  '<span><span class="ms-cal-lg-sw ms-lg-paper"></span>Paper border</span>' +
                  '<span><span class="ms-cal-lg-sw ms-lg-print"></span>Area stampabile</span>' +
                  '<span><span class="ms-cal-lg-sw ms-lg-safe"></span>Safe area</span>' +
                  '<span><span class="ms-cal-lg-sw ms-lg-crop"></span>Crop / rischio taglio</span>' +
                '</div>' +
              '</div>' +
              '<div class="ms-cal-side">' +
                '<div class="ms-cal-section">' +
                  '<div class="ms-cal-section-title">Formato carta</div>' +
                  '<div class="ms-cal-paper-info" id="ms-cal-paper-info">—</div>' +
                '</div>' +
                '<div class="ms-cal-section">' +
                  '<div class="ms-cal-section-title">Cornice</div>' +
                  '<div class="ms-cal-slider-row">' +
                    '<div class="ms-cal-slider-label"><span>Offset cornice X</span><span class="ms-cal-slider-val" id="ms-cal-x-val">0.0 mm</span></div>' +
                    '<div class="ms-cal-slider-wrap"><input type="range" id="ms-cal-x" min="-5" max="5" step="0.1" value="0"></div>' +
                    '<div class="ms-cal-slider-axis"><span>−5</span><span>0</span><span>+5</span></div>' +
                  '</div>' +
                  '<div class="ms-cal-slider-row">' +
                    '<div class="ms-cal-slider-label"><span>Offset cornice Y</span><span class="ms-cal-slider-val" id="ms-cal-y-val">0.0 mm</span></div>' +
                    '<div class="ms-cal-slider-wrap"><input type="range" id="ms-cal-y" min="-5" max="5" step="0.1" value="0"></div>' +
                    '<div class="ms-cal-slider-axis"><span>−5</span><span>0</span><span>+5</span></div>' +
                  '</div>' +
                  '<div class="ms-cal-slider-row">' +
                    '<div class="ms-cal-slider-label"><span>Zoom cornice</span><span class="ms-cal-slider-val" id="ms-cal-z-val">100%</span></div>' +
                    '<div class="ms-cal-slider-wrap"><input type="range" id="ms-cal-z" min="80" max="120" step="0.5" value="100"></div>' +
                    '<div class="ms-cal-slider-axis"><span>80</span><span>100</span><span>120</span></div>' +
                  '</div>' +
                '</div>' +
                '<div class="ms-cal-section">' +
                  '<div class="ms-cal-section-title">Foto</div>' +
                  '<div class="ms-cal-slider-row">' +
                    '<div class="ms-cal-slider-label"><span>Offset foto X</span><span class="ms-cal-slider-val" id="ms-cal-px-val">0.0 mm</span></div>' +
                    '<div class="ms-cal-slider-wrap"><input type="range" id="ms-cal-px" min="-5" max="5" step="0.1" value="0"></div>' +
                    '<div class="ms-cal-slider-axis"><span>−5</span><span>0</span><span>+5</span></div>' +
                  '</div>' +
                  '<div class="ms-cal-slider-row">' +
                    '<div class="ms-cal-slider-label"><span>Offset foto Y</span><span class="ms-cal-slider-val" id="ms-cal-py-val">0.0 mm</span></div>' +
                    '<div class="ms-cal-slider-wrap"><input type="range" id="ms-cal-py" min="-5" max="5" step="0.1" value="0"></div>' +
                    '<div class="ms-cal-slider-axis"><span>−5</span><span>0</span><span>+5</span></div>' +
                  '</div>' +
                  '<div class="ms-cal-slider-row">' +
                    '<div class="ms-cal-slider-label"><span>Zoom foto</span><span class="ms-cal-slider-val" id="ms-cal-pz-val">100%</span></div>' +
                    '<div class="ms-cal-slider-wrap"><input type="range" id="ms-cal-pz" min="80" max="120" step="0.5" value="100"></div>' +
                    '<div class="ms-cal-slider-axis"><span>80</span><span>100</span><span>120</span></div>' +
                  '</div>' +
                '</div>' +
                '<div class="ms-cal-section">' +
                  '<div class="ms-cal-actions">' +
                    '<button type="button" id="ms-cal-test" class="ms-cal-action ms-cal-primary">Stampa di test</button>' +
                    '<button type="button" id="ms-cal-save" class="ms-cal-action">Salva preset</button>' +
                    '<button type="button" id="ms-cal-reset" class="ms-cal-action ms-cal-ghost">Reset</button>' +
                  '</div>' +
                  '<div id="ms-cal-status" class="ms-cal-status">—</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="ms-card ms-card-full" id="ms-c-frames">' +
            '<div class="ms-ct"><span>Cornici</span><label id="ms-add-frame-lbl" for="ms-frame-file-input">+ Aggiungi<input type="file" id="ms-frame-file-input" accept=".png,.jpg,.jpeg,.webp,.gif" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;"></label></div>' +
            '<div id="ms-frames-grid"></div>' +
          '</div>' +
          '<div id="ms-calibration-backdrop"></div>' +
          '<div id="ms-gallery-modal">' +
            '<div id="ms-gallery-card">' +
              '<div id="ms-gallery-head"><div class="ms-gh-left"><div class="ms-gh-icon">📷</div><div class="ms-gh-text"><div id="ms-gallery-title">Galleria evento</div><div id="ms-gallery-subtitle">-</div></div></div><div id="ms-gallery-printer-pill" class="ms-pp" data-status="no-printer"><span class="ms-pp-dot"></span><div class="ms-pp-meta"><span class="ms-pp-label">Stampante</span><div class="ms-pp-bar"><div class="ms-pp-fill"></div></div></div></div><button id="ms-gallery-close" type="button">✕</button></div>' +
              '<div id="ms-gallery-chips"></div>' +
              '<div id="ms-gallery-grid"></div>' +
              '<div id="ms-gallery-empty">Nessuna foto per questo evento</div>' +
              '<div id="ms-gallery-foot"><div id="ms-gallery-count">0 foto</div><button id="ms-gallery-download-all" type="button">Scarica tutte</button></div>' +
            '</div>' +
          '</div>' +
          '<div id="ms-gallery-viewer-modal">' +
            '<div id="ms-gallery-viewer-card">' +
              '<button id="ms-gallery-viewer-close" type="button">✕</button>' +
              '<button class="ms-gv-nav" id="ms-gallery-viewer-prev" type="button">‹</button>' +
              '<img id="ms-gallery-viewer-media" alt="">' +
              '<button class="ms-gv-nav" id="ms-gallery-viewer-next" type="button">›</button>' +
              '<div id="ms-gallery-viewer-meta">-</div>' +
              '<button id="ms-gallery-viewer-delete" type="button">Elimina</button>' +
            '</div>' +
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
    var buildVideoConstraints = function(deviceId) {
      var base = {
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 30, max: 60 },
        resizeMode: 'none'
      };
      if (deviceId) base.deviceId = { exact: deviceId };
      return base;
    };

    var bindCameraStream = function(video, stream) {
      try {
        video.srcObject = stream;
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        video.setAttribute('muted', '');
        video.muted = true;
        var tryPlay = function() {
          try {
            var pp = video.play && video.play();
            if (pp && typeof pp.catch === 'function') pp.catch(function() {});
          } catch (_) {}
        };
        video.onloadedmetadata = tryPlay;
        setTimeout(tryPlay, 0);
      } catch (_) {}

      try {
        var track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
        var st = track && track.getSettings ? track.getSettings() : null;
        if (st) {
          console.log('[ms] cam settings ' + (st.width || '?') + 'x' + (st.height || '?') + ' fps=' + (st.frameRate || '?') + ' device=' + (st.deviceId || 'n/a'));
        }
        try {
          var caps = track && track.getCapabilities ? track.getCapabilities() : null;
          if (caps) {
            var capKeys = Object.keys(caps);
            console.log('[ms] cam capabilities=' + JSON.stringify(capKeys));
            var lockAdvanced = [];
            ['zoom','pan','tilt'].forEach(function(k) {
              try {
                var c = caps[k];
                if (c && typeof c === 'object') {
                  var lockVal = (typeof c.min === 'number') ? c.min : (typeof c.start === 'number' ? c.start : 0);
                  if (k === 'zoom') lockVal = (typeof c.min === 'number') ? c.min : 1;
                  var o = {}; o[k] = lockVal;
                  lockAdvanced.push(o);
                }
              } catch (_) {}
            });
            try {
              if (caps.backgroundBlur) lockAdvanced.push({ backgroundBlur: false });
              if (caps.faceFraming || caps.autoFrame || caps.autoFraming) {
                lockAdvanced.push({ faceFraming: false, autoFrame: false, autoFraming: false });
              }
              if (caps.eyeGazeCorrection) lockAdvanced.push({ eyeGazeCorrection: false });
            } catch (_) {}
            if (lockAdvanced.length && track.applyConstraints) {
              track.applyConstraints({ advanced: lockAdvanced }).then(function() {
                console.log('[ms] cam constraints LOCK applied=' + JSON.stringify(lockAdvanced));
              }).catch(function(e) {
                console.log('[ms] cam constraints LOCK failed: ' + (e && e.message));
              });
            }
            try {
              if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.indexOf('manual') >= 0) {
                track.applyConstraints({ advanced: [{ focusMode: 'manual' }] }).catch(function() {});
              }
              if (caps.exposureMode && Array.isArray(caps.exposureMode) && caps.exposureMode.indexOf('manual') >= 0) {
                track.applyConstraints({ advanced: [{ exposureMode: 'manual' }] }).catch(function() {});
              }
              if (caps.whiteBalanceMode && Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.indexOf('manual') >= 0) {
                track.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual' }] }).catch(function() {});
              }
            } catch (_) {}
          }
        } catch (_) {}
      } catch (_) {}

      var d = document.getElementById('ms-d-cam'); if (d) d.className = 'ms-dot online';
      var si = document.getElementById('ms-si-cam'); if (si) si.classList.add('active');
      try {
        setTimeout(function() {
          try { if (typeof window.__msRefreshCalibrationPreviewSample === 'function') window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
        }, 80);
      } catch (_) {}
    };

    var startCamera = function(deviceId) {
      var video = document.getElementById('ms-cam-video');
      if (!video) return;
      if (video.srcObject) { video.srcObject.getTracks().forEach(function(t) { t.stop(); }); video.srcObject = null; }
      if (!deviceId) return;
      navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints(deviceId), audio: false })
        .then(function(stream) {
          bindCameraStream(video, stream);
        })
        .catch(function() {
          navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints(''), audio: false })
            .then(function(stream) { bindCameraStream(video, stream); })
            .catch(function() {
              navigator.mediaDevices.getUserMedia({ video: true, audio: false })
                .then(function(stream) { bindCameraStream(video, stream); })
                .catch(function() {});
            })
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
    var MS_LAST_EVT_KEY = 'ms-last-event-text';

    var syncEvtSel = function() {
      var ui = document.getElementById('ms-evt-sel');
      var search = document.getElementById('ms-evt-search');
      var orig = findOrigEventSelect();
      if (!ui || !orig) return;

      var syncCurrentEventFolder = function(txt) {
        try {
          if (!window.electronAPI || typeof window.electronAPI.setCurrentEventFolder !== 'function') return;
          var t = txt !== undefined ? txt : '';
          if (!t && ui && ui.selectedIndex >= 0 && ui.options && ui.options[ui.selectedIndex]) {
            t = String(ui.options[ui.selectedIndex].textContent || '').trim();
          }
          window.electronAPI.setCurrentEventFolder(t).catch(function() {});
        } catch (_) {}
      };

      // Recupera la selezione salvata manualmente dall'utente
      var savedEvtTxt = '';
      try { savedEvtTxt = String(localStorage.getItem(MS_LAST_EVT_KEY) || '').trim(); } catch (_) {}

      // Non svuotare il dropdown se orig non ha ancora opzioni (potrebbe essere in caricamento)
      if (!orig.options || orig.options.length === 0) return;

      var applyEvtFilter = function() {
        var q = '';
        try { q = String((search && search.value) || '').trim().toLowerCase(); } catch (_) {}
        var all = Array.isArray(ui.__msAllOptions) ? ui.__msAllOptions : [];
        var prevVal = ui.value;
        ui.innerHTML = '';
        all.forEach(function(it) {
          if (q && String(it.text || '').toLowerCase().indexOf(q) < 0) return;
          var o = document.createElement('option');
          o.value = it.value;
          o.text = it.text;
          if (it.selected) o.selected = true;
          ui.appendChild(o);
        });
        if (!ui.value && prevVal) {
          for (var k = 0; k < ui.options.length; k++) {
            if (ui.options[k].value === prevVal) { ui.selectedIndex = k; break; }
          }
        }
      };

      ui.__msAllOptions = [];
      var restoredSaved = false;
      Array.from(orig.options).forEach(function(opt) {
        // opt.text è la proprietà standard HTMLOptionElement per il testo visibile
        var optDisplay = String(opt.text || opt.textContent || opt.label || '').trim();
        var selected = false;
        // Ripristina selezione salvata
        if (savedEvtTxt && optDisplay === savedEvtTxt) {
          selected = true;
          restoredSaved = true;
        } else if (!savedEvtTxt && opt.selected) {
          selected = true;
        }
        ui.__msAllOptions.push({ value: opt.value, text: optDisplay, selected: selected });
      });
      applyEvtFilter();

      if (search && !search.dataset.msb) {
        search.dataset.msb = '1';
        search.addEventListener('input', function() { applyEvtFilter(); });
      }

      // Se abbiamo ripristinato la scelta salvata, sincronizza anche il dropdown originale
      if (restoredSaved && orig) {
        try {
          Array.from(orig.options).forEach(function(o) {
            var od = String(o.text || o.textContent || '').trim();
            o.selected = od === savedEvtTxt;
          });
          orig.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }

      if (ui.value) {
        var d = document.getElementById('ms-d-evt'); if (d) d.className = 'ms-dot online';
        var si = document.getElementById('ms-si-evt'); if (si) si.classList.add('active');
      }
      if (!ui.dataset.msb) {
        ui.dataset.msb = '1';
        ui.addEventListener('change', function() {
          var selTxt = '';
          if (ui.selectedIndex >= 0 && ui.options && ui.options[ui.selectedIndex]) {
            selTxt = String(ui.options[ui.selectedIndex].text || ui.options[ui.selectedIndex].textContent || '').trim();
          }
          // Persisti la scelta dell'utente
          try { localStorage.setItem(MS_LAST_EVT_KEY, selTxt); } catch (_) {}
          if (orig) { orig.value = ui.value; orig.dispatchEvent(new Event('change', { bubbles: true })); }
          syncCurrentEventFolder(selTxt);
          __msRefreshPreviewIdWatermark();
          var hasEvt = !!ui.value;
          var dot = document.getElementById('ms-d-evt'); if (dot) dot.className = 'ms-dot' + (hasEvt ? ' online' : '');
          var si2 = document.getElementById('ms-si-evt'); if (si2) si2.classList.toggle('active', hasEvt);
        });
      }

      // Determina il testo effettivo da usare
      var effectiveTxt = savedEvtTxt || (ui.selectedIndex >= 0 && ui.options[ui.selectedIndex] ? String(ui.options[ui.selectedIndex].text || ui.options[ui.selectedIndex].textContent || '').trim() : '');

      // Su pagina home (non sessione): salva automaticamente in localStorage così il nome persiste
      var __ppn = window.location.pathname;
      var isSessionPage = (__ppn.indexOf('/mirror/index') >= 0 && __ppn !== '/mirror/index.php');
      if (!isSessionPage && effectiveTxt && !savedEvtTxt) {
        try { localStorage.setItem(MS_LAST_EVT_KEY, effectiveTxt); console.log('[ms] auto-saved event on home: ' + effectiveTxt); } catch (_) {}
      }

      syncCurrentEventFolder(effectiveTxt);
      __msRefreshPreviewIdWatermark();
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

    var __msGalleryState = { items: [], index: 0, eventText: '', groups: [], slotMinutes: 30, _groupCacheKey: '', _groupCache: [] };
    var __MS_PRINTED_PHOTOS_LS_KEY = 'msPrintedPhotosByEvent.v1';
    var __msGalleryObserver = null;

    var __msGetPrintedPhotosStore = function() {
      try {
        var raw = localStorage.getItem(__MS_PRINTED_PHOTOS_LS_KEY);
        var parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object') ? parsed : {};
      } catch (_) {
        return {};
      }
    };

    var __msSavePrintedPhotosStore = function(store) {
      try {
        localStorage.setItem(__MS_PRINTED_PHOTOS_LS_KEY, JSON.stringify(store || {}));
      } catch (_) {}
    };

    var __msGetPhotoPrintToken = function(item) {
      if (!item) return '';
      if (item.fileName) return 'f:' + String(item.fileName);
      if (item.id) return 'i:' + String(item.id);
      if (item.path) return 'p:' + String(item.path);
      return '';
    };

    var __msIsPhotoPrinted = function(eventText, item) {
      var evt = String(eventText || __msGalleryState.eventText || __msGetSelectedEventText() || 'evento_senza_nome').trim();
      if (!evt || evt === 'evento_senza_nome') return false;
      var token = __msGetPhotoPrintToken(item);
      if (!token) return false;
      var store = __msGetPrintedPhotosStore();
      var byEvent = store[evt];
      return !!(byEvent && byEvent[token]);
    };

    var __msSetPhotoPrinted = function(eventText, item, printed) {
      var evt = String(eventText || __msGalleryState.eventText || __msGetSelectedEventText() || 'evento_senza_nome').trim();
      if (!evt || evt === 'evento_senza_nome') return;
      var token = __msGetPhotoPrintToken(item);
      if (!token) return;
      var store = __msGetPrintedPhotosStore();
      if (!store[evt] || typeof store[evt] !== 'object') store[evt] = {};
      if (printed) {
        store[evt][token] = 1;
      } else {
        delete store[evt][token];
      }
      __msSavePrintedPhotosStore(store);
    };

    // ── PRINTER STATE (single-job gating, real Windows queue monitoring) ──
    var __msPrinterState = window.__msPrinterState || { printerName: '', status: 'no-printer', label: 'Stampante', jobs: [], hasActiveJob: false, progress: 0, message: '' };
    window.__msPrinterState = __msPrinterState;
    var __msPrinterSubscribed = false;
    var __msPrinterPollTimer = null;
    var __msPrinterStateListeners = [];

    var __msIsPrinterReady = function() {
      var s = __msPrinterState || {};
      return s.status === 'ready' && !s.hasActiveJob;
    };

    var __msAddPrinterStateListener = function(fn) {
      if (typeof fn === 'function') __msPrinterStateListeners.push(fn);
    };

    var __msApplyPrinterStateToUI = function() {
      var s = __msPrinterState || {};
      var status = String(s.status || 'no-printer');
      var label = String(s.label || 'Stampante');
      var prog = Math.max(0, Math.min(100, Number(s.progress || 0)));

      // Topbar indicator
      var siPrt = document.getElementById('ms-si-prt');
      var dotPrt = document.getElementById('ms-d-prt');
      var lblPrt = document.getElementById('ms-prt-label');
      var progBar = document.getElementById('ms-prt-progress-bar');
      if (siPrt) siPrt.setAttribute('data-status', status);
      if (dotPrt) {
        dotPrt.className = 'ms-dot' + (status === 'ready' ? ' online' : (status === 'busy' ? ' warn' : (status === 'error' || status === 'offline' ? ' off' : '')));
      }
      if (lblPrt) lblPrt.textContent = 'Stampante · ' + label;
      if (progBar) progBar.style.width = (status === 'busy' ? prog : 0) + '%';

      // Gallery pill
      var pill = document.getElementById('ms-gallery-printer-pill');
      if (pill) {
        pill.setAttribute('data-status', status);
        var pillLbl = pill.querySelector('.ms-pp-label');
        var pillFill = pill.querySelector('.ms-pp-fill');
        if (pillLbl) pillLbl.textContent = (s.printerName ? s.printerName + ' · ' : '') + label;
        if (pillFill) pillFill.style.width = (status === 'busy' ? prog : 0) + '%';
      }

      // Gallery print buttons gating
      var ready = __msIsPrinterReady();
      var __prefEnabledGallery = true;
      try {
        var __prefRawG = localStorage.getItem('msPanelPrintEnabled');
        if (__prefRawG === '0') __prefEnabledGallery = false;
        if (__prefRawG === '1') __prefEnabledGallery = true;
      } catch (_) {}
      try {
        Array.from(document.querySelectorAll('.ms-g-btn.open')).forEach(function(btn) {
          if (!__prefEnabledGallery) {
            btn.classList.add('is-blocked');
            btn.classList.remove('is-busy');
            btn.disabled = true;
            btn.title = 'Stampa disattivata nelle opzioni';
          } else if (status === 'busy' || s.hasActiveJob) {
            btn.classList.add('is-busy');
            btn.classList.remove('is-blocked');
            btn.disabled = true;
            btn.title = 'Stampa in corso, attendi…';
          } else if (status === 'error' || status === 'offline' || status === 'no-printer') {
            btn.classList.add('is-blocked');
            btn.classList.remove('is-busy');
            btn.disabled = true;
            btn.title = label || 'Stampante non disponibile';
          } else if (ready) {
            btn.classList.remove('is-blocked');
            btn.classList.remove('is-busy');
            btn.disabled = false;
            btn.title = 'Stampa questa foto';
          }
        });
      } catch (_) {}

      // Preview popup Stampa toggle: blocca quando stampante non è pronta
      try {
        var stBtn = document.getElementById('ms-btn-stampa');
        if (stBtn) {
          var __prefEnabled = true;
          try {
            var __prefRaw2 = localStorage.getItem('msPanelPrintEnabled');
            if (__prefRaw2 === '0') __prefEnabled = false;
            if (__prefRaw2 === '1') __prefEnabled = true;
          } catch (_) {}
          if (!ready || !__prefEnabled) {
            stBtn.setAttribute('data-disabled', '1');
            stBtn.disabled = true;
            stBtn.title = !__prefEnabled ? 'Stampa disattivata nelle opzioni' : (label || 'Stampante non disponibile');
          } else {
            stBtn.removeAttribute('data-disabled');
            stBtn.disabled = false;
            stBtn.title = '';
          }
        }
      } catch (_) {}

      // Live pill in pre-scatto (mostra coda stampa precedente)
      try {
        var lvPill = document.getElementById('ms-lv-printer-pill');
        if (lvPill) {
          lvPill.setAttribute('data-status', status);
          var lvPillLbl = lvPill.querySelector('.ms-lv-pp-label');
          if (lvPillLbl) lvPillLbl.textContent = (s.printerName ? s.printerName + ' · ' : '') + label;
        }
      } catch (_) {}

      // Pulsante scatto in pre-scatto: SEMPRE attivo (anche se stampante busy).
      // La stampa dall'anteprima resta bloccata finché non torna verde (gestita sopra su ms-btn-stampa).
      try {
        var lvShoot = document.getElementById('ms-lv-shoot');
        if (lvShoot) {
          lvShoot.classList.remove('is-print-busy');
          lvShoot.removeAttribute('aria-disabled');
          lvShoot.title = 'Scatta';
        }
      } catch (_) {}

      __msPrinterStateListeners.forEach(function(fn) { try { fn(s); } catch (_) {} });
    };

    var __msUpdatePrinterState = window.__msUpdatePrinterState = function(next) {
      if (!next) return;
      __msPrinterState = next;
      window.__msPrinterState = next;
      __msApplyPrinterStateToUI();
    };

    var __msFetchPrinterState = window.__msFetchPrinterState = function(force) {
      try {
        if (!window.electronAPI || typeof window.electronAPI.getPrinterState !== 'function') return Promise.resolve(null);
        return window.electronAPI.getPrinterState(!!force).then(function(st) {
          if (st) __msUpdatePrinterState(st);
          return st;
        }).catch(function() { return null; });
      } catch (_) { return Promise.resolve(null); }
    };

    var __msSubscribePrinterState = window.__msSubscribePrinterState = function() {
      if (__msPrinterSubscribed) return;
      __msPrinterSubscribed = true;
      try {
        if (window.electronAPI && typeof window.electronAPI.onPrinterState === 'function') {
          window.electronAPI.onPrinterState(function(st) { if (st) __msUpdatePrinterState(st); });
        }
      } catch (_) {}
      if (__msPrinterPollTimer) { try { clearInterval(__msPrinterPollTimer); } catch (_) {} }
      __msPrinterPollTimer = setInterval(function() { __msFetchPrinterState(false); }, 3000);
      __msFetchPrinterState(true);
    };

    var __msWirePrintCalibration = function() {
      var card = document.getElementById('ms-c-calibration');
      if (!card || card.dataset.msCalBound === '1') return;
      card.dataset.msCalBound = '1';

      // ── Definizione formati supportati ────────────────────────────
      // Solo "postcard" si stampa davvero (Canon SELPHY CP1500 / KP-108).
      // Gli altri formati sono preset visivi per anteprima/calibrazione futura.
      // Specifiche reali Canon SELPHY CP1500 / KP-108:
      //   - paper 100x148 mm
      //   - stampa full-bleed (nessun margine non stampabile)
      //   - tolleranza di taglio meccanica ~3 mm per lato (zona a rischio crop)
      //   - safe area consigliata 94x142 mm (mantieni contenuti importanti qui)
      var FORMATS = {
        postcard: {
          label: 'Postcard 10×15',
          paper: { w: 100, h: 150 }, margin: 0, bleed: 0, safe: { w: 100, h: 150 },
          sub: 'Postcard 100×150 mm · KP-108 (10×15)',
          info: 'Carta: <b>100 × 150 mm</b> (10×15)<br>Stampa: <b>full-bleed</b> (nessun margine)<br>Area utile: <b>intera superficie del foglio</b>',
          realPrint: true
        }
      };

      var inX = document.getElementById('ms-cal-x');
      var inY = document.getElementById('ms-cal-y');
      var inZ = document.getElementById('ms-cal-z');
      var inPX = document.getElementById('ms-cal-px');
      var inPY = document.getElementById('ms-cal-py');
      var inPZ = document.getElementById('ms-cal-pz');
      var valX = document.getElementById('ms-cal-x-val');
      var valY = document.getElementById('ms-cal-y-val');
      var valZ = document.getElementById('ms-cal-z-val');
      var valPX = document.getElementById('ms-cal-px-val');
      var valPY = document.getElementById('ms-cal-py-val');
      var valPZ = document.getElementById('ms-cal-pz-val');
      var btnTest = document.getElementById('ms-cal-test');
      var btnSave = document.getElementById('ms-cal-save');
      var btnReset = document.getElementById('ms-cal-reset');
      var statusEl = document.getElementById('ms-cal-status');
      var paperInfoEl = document.getElementById('ms-cal-paper-info');
      var formatSubEl = document.getElementById('ms-cal-format-sub');
      var coordsEl = document.getElementById('ms-cal-coords');
      var stageEl = document.getElementById('ms-cal-stage');
      var rulerCb = document.getElementById('ms-cal-show-ruler');
      var coordsCb = document.getElementById('ms-cal-show-coords');
      var zoomVal = document.getElementById('ms-cal-zoom-val');
      var canvas = document.getElementById('ms-cal-canvas');
      var ctx = canvas ? canvas.getContext('2d') : null;

      var setStatus = function(msg) { try { if (statusEl) statusEl.textContent = msg || '—'; } catch (_) {} };
      var clamp = function(v, min, max, fb) { var n = parseFloat(v); if (!isFinite(n)) n = fb; return Math.max(min, Math.min(max, Math.round(n * 10) / 10)); };

      // ── Stato locale ──────────────────────────────────────────────
      var currentFormat = 'postcard';
      var previewZoom = 1.0; // 0.6 .. 1.6 (zoom anteprima — non influenza la stampa)

      var presetsKey = 'ms-cal-presets-v1';
      var framePresetsKey = 'ms-cal-frame-presets-v1';
      var loadAllPresets = function() {
        try { return JSON.parse(localStorage.getItem(presetsKey) || '{}') || {}; } catch (_) { return {}; }
      };
      var saveAllPresets = function(p) {
        try { localStorage.setItem(presetsKey, JSON.stringify(p || {})); } catch (_) {}
      };
      var getPreset = function(fmt) {
        var all = loadAllPresets();
        return all[fmt] || { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
      };
      var setPreset = function(fmt, cal) {
        var all = loadAllPresets();
        all[fmt] = {
          offsetXmm: cal.offsetXmm,
          offsetYmm: cal.offsetYmm,
          zoomPct: cal.zoomPct,
          photoOffsetXmm: cal.photoOffsetXmm,
          photoOffsetYmm: cal.photoOffsetYmm,
          photoZoomPct: cal.photoZoomPct
        };
        saveAllPresets(all);
      };
      var loadAllFramePresets = function() {
        try { return JSON.parse(localStorage.getItem(framePresetsKey) || '{}') || {}; } catch (_) { return {}; }
      };
      var saveAllFramePresets = function(p) {
        try { localStorage.setItem(framePresetsKey, JSON.stringify(p || {})); } catch (_) {}
      };
      var buildFramePresetKey = function(fmt, frameName) {
        return String(fmt || '') + '::' + String(frameName || '');
      };
      var getCurrentFrameName = function() {
        try {
          if (typeof getSelectedFrameName === 'function') return String(getSelectedFrameName() || '');
        } catch (_) {}
        return '';
      };
      var getFramePreset = function(fmt, frameName) {
        if (!frameName) return null;
        var all = loadAllFramePresets();
        var p = all[buildFramePresetKey(fmt, frameName)];
        if (!p || typeof p !== 'object') return null;
        return {
          offsetXmm: clamp(p.offsetXmm, -5, 5, 0),
          offsetYmm: clamp(p.offsetYmm, -5, 5, 0),
          zoomPct: clamp(p.zoomPct, 80, 120, 100),
          photoOffsetXmm: clamp(p.photoOffsetXmm, -5, 5, 0),
          photoOffsetYmm: clamp(p.photoOffsetYmm, -5, 5, 0),
          photoZoomPct: clamp(p.photoZoomPct, 80, 120, 100)
        };
      };
      var setFramePreset = function(fmt, frameName, cal) {
        if (!frameName) return;
        var all = loadAllFramePresets();
        all[buildFramePresetKey(fmt, frameName)] = {
          offsetXmm: cal.offsetXmm,
          offsetYmm: cal.offsetYmm,
          zoomPct: cal.zoomPct,
          photoOffsetXmm: cal.photoOffsetXmm,
          photoOffsetYmm: cal.photoOffsetYmm,
          photoZoomPct: cal.photoZoomPct
        };
        saveAllFramePresets(all);
      };
      var getEffectivePreset = function(fmt, fallback) {
        var frameName = getCurrentFrameName();
        var byFrame = getFramePreset(fmt, frameName);
        if (byFrame) return byFrame;
        if (fallback && typeof fallback === 'object') {
          return {
            offsetXmm: clamp(fallback.offsetXmm, -5, 5, 0),
            offsetYmm: clamp(fallback.offsetYmm, -5, 5, 0),
            zoomPct: clamp(fallback.zoomPct, 80, 120, 100),
            photoOffsetXmm: clamp(fallback.photoOffsetXmm, -5, 5, 0),
            photoOffsetYmm: clamp(fallback.photoOffsetYmm, -5, 5, 0),
            photoZoomPct: clamp(fallback.photoZoomPct, 80, 120, 100)
          };
        }
        return getPreset(fmt);
      };
      var calDefaultPreviewRect = (typeof __msDefaultPreviewRect !== 'undefined' && __msDefaultPreviewRect) ? __msDefaultPreviewRect : { left: 0.0767, top: 0.0615, width: 0.8466, height: 0.7812 };
      var normalizeCalibrationPhotoRect = function(rect, fallback) {
        try {
          var fb = fallback || calDefaultPreviewRect || { left: 0, top: 0, width: 1, height: 1 };
          var source = (rect && typeof rect === 'object') ? rect : fb;
          var clamp01 = function(v) {
            var n = Number(v);
            if (!isFinite(n)) return 0;
            return Math.max(0, Math.min(1, n));
          };
          var width = clamp01(source.width);
          var height = clamp01(source.height);
          if (width <= 0 || height <= 0) {
            width = clamp01(fb.width);
            height = clamp01(fb.height);
          }
          return {
            left: clamp01((1 - width) / 2),
            top: clamp01((1 - height) / 2),
            width: width,
            height: height
          };
        } catch (_) {
          return fallback || calDefaultPreviewRect || null;
        }
      };

      var applyLivePreviewCalibration = function(cal) {
        try {
          var inner = document.getElementById('ms-preview-inner');
          var video = document.getElementById('ms-cam-video');
          var frameOv = document.getElementById('ms-frame-ov');
          var maskTop = document.getElementById('ms-live-mask-top');
          var maskRight = document.getElementById('ms-live-mask-right');
          var maskBottom = document.getElementById('ms-live-mask-bottom');
          var maskLeft = document.getElementById('ms-live-mask-left');
          if (!inner || !video || !frameOv || !maskTop || !maskRight || !maskBottom || !maskLeft) return;

          var hasFrame = !!(frameOv.src && String(frameOv.src || '').trim());
          if (!hasFrame) {
            video.style.inset = '0px';
            video.style.left = '0px';
            video.style.top = '0px';
            video.style.width = '100%';
            video.style.height = '100%';
            frameOv.style.left = '0px';
            frameOv.style.top = '0px';
            frameOv.style.width = '100%';
            frameOv.style.height = '100%';
            [maskTop, maskRight, maskBottom, maskLeft].forEach(function(m) {
              m.style.display = 'none';
            });
            return;
          }

          var c = cal;
          if (!c || typeof c !== 'object') c = getEffectivePreset('postcard', getPreset('postcard'));

          var offXmm = clamp(c && c.offsetXmm, -5, 5, 0);
          var offYmm = clamp(c && c.offsetYmm, -5, 5, 0);
          var zoomPct = clamp(c && c.zoomPct, 80, 120, 100);
          var photoOffXmm = clamp(c && c.photoOffsetXmm, -5, 5, 0);
          var photoOffYmm = clamp(c && c.photoOffsetYmm, -5, 5, 0);
          var photoZoomPct = clamp(c && c.photoZoomPct, 80, 120, 100);
          var zoom = zoomPct / 100;
          var photoZoom = photoZoomPct / 100;
          if (zoom < 0.5) zoom = 0.5;
          if (zoom > 2) zoom = 2;
          if (photoZoom < 0.5) photoZoom = 0.5;
          if (photoZoom > 2) photoZoom = 2;

          var w = inner.clientWidth || 0;
          var h = inner.clientHeight || 0;
          if (!w || !h) return;

          var offX = (offXmm / 100) * w;
          var offY = (offYmm / 150) * h;
          var frameW = w * zoom;
          var frameH = h * zoom;
          var frameX = (w - frameW) / 2 + offX;
          var frameY = (h - frameH) / 2 + offY;
          var photoOffX = (photoOffXmm / 100) * w;
          var photoOffY = (photoOffYmm / 150) * h;
          var livePhotoHole = normalizeCalibrationPhotoRect(frameOverlayHole || (hasFrame ? calDefaultPreviewRect : null), calDefaultPreviewRect);
          var basePhotoX = livePhotoHole ? (livePhotoHole.left * w) : 0;
          var basePhotoY = livePhotoHole ? (livePhotoHole.top * h) : 0;
          var basePhotoW = livePhotoHole ? (livePhotoHole.width * w) : w;
          var basePhotoH = livePhotoHole ? (livePhotoHole.height * h) : h;
          var photoW = basePhotoW * photoZoom;
          var photoH = basePhotoH * photoZoom;
          var photoX = basePhotoX + (basePhotoW - photoW) / 2 + photoOffX;
          var photoY = basePhotoY + (basePhotoH - photoH) / 2 + photoOffY;

          // Video allineato alla calibrazione Foto, separata dalla cornice.
          try { inner.style.background = '#000000'; } catch (_) {}
          video.style.inset = 'auto';
          video.style.left = photoX + 'px';
          video.style.top = photoY + 'px';
          video.style.width = photoW + 'px';
          video.style.height = photoH + 'px';
          video.style.zIndex = '1';

          frameOv.style.inset = 'auto';
          frameOv.style.left = frameX + 'px';
          frameOv.style.top = frameY + 'px';
          frameOv.style.width = frameW + 'px';
          frameOv.style.height = frameH + 'px';
          frameOv.style.zIndex = '3';

          // Nel pannello la camera e' un elemento DOM: mascheriamo tutto cio'
          // che sta fuori dal foro foto, come fa il canvas di calibrazione.
          var left = Math.max(0, Math.min(w, photoX));
          var top = Math.max(0, Math.min(h, photoY));
          var right = Math.max(0, Math.min(w, photoX + photoW));
          var bottom = Math.max(0, Math.min(h, photoY + photoH));
          var visW = Math.max(0, right - left);
          var visH = Math.max(0, bottom - top);

          if (visW < 8 || visH < 8) {
            [maskTop, maskRight, maskBottom, maskLeft].forEach(function(m) {
              m.style.display = 'none';
            });
            return;
          }

          maskTop.style.display = 'block';
          maskTop.style.background = '#000000';
          maskTop.style.zIndex = '2';
          maskTop.style.left = '0px';
          maskTop.style.top = '0px';
          maskTop.style.width = w + 'px';
          maskTop.style.height = top + 'px';

          maskBottom.style.display = 'block';
          maskBottom.style.background = '#000000';
          maskBottom.style.zIndex = '2';
          maskBottom.style.left = '0px';
          maskBottom.style.top = bottom + 'px';
          maskBottom.style.width = w + 'px';
          maskBottom.style.height = Math.max(0, h - bottom) + 'px';

          maskLeft.style.display = 'block';
          maskLeft.style.background = '#000000';
          maskLeft.style.zIndex = '2';
          maskLeft.style.left = '0px';
          maskLeft.style.top = top + 'px';
          maskLeft.style.width = left + 'px';
          maskLeft.style.height = visH + 'px';

          maskRight.style.display = 'block';
          maskRight.style.background = '#000000';
          maskRight.style.zIndex = '2';
          maskRight.style.left = right + 'px';
          maskRight.style.top = top + 'px';
          maskRight.style.width = Math.max(0, w - right) + 'px';
          maskRight.style.height = visH + 'px';
        } catch (_) {}
      };
      window.__msApplyLivePreviewCalibration = applyLivePreviewCalibration;

      window.__msGetEffectiveCalibrationForSave = function(fmt, frameName) {
        try {
          var f = String(fmt || 'postcard');
          var name = (frameName === undefined || frameName === null) ? getCurrentFrameName() : String(frameName || '');
          var byFrame = getFramePreset(f, name);
          if (byFrame) return byFrame;
          if (f === 'postcard' && window.electronAPI && typeof window.electronAPI.getPrintCalibration === 'function') {
            // API async: in questo contesto ritorniamo il preset locale sincrono.
            return getPreset('postcard');
          }
          return getPreset(f);
        } catch (_) {
          return { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
        }
      };

      var readUI = function() {
        return {
          offsetXmm: clamp(inX && inX.value, -5, 5, 0),
          offsetYmm: clamp(inY && inY.value, -5, 5, 0),
          zoomPct:   clamp(inZ && inZ.value, 80, 120, 100),
          photoOffsetXmm: clamp(inPX && inPX.value, -5, 5, 0),
          photoOffsetYmm: clamp(inPY && inPY.value, -5, 5, 0),
          photoZoomPct: clamp(inPZ && inPZ.value, 80, 120, 100)
        };
      };
      var writeUI = function(c) {
        try {
          c = c || { offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 };
          if (inX) inX.value = String(c.offsetXmm || 0);
          if (inY) inY.value = String(c.offsetYmm || 0);
          if (inZ) inZ.value = String(c.zoomPct || 100);
          if (inPX) inPX.value = String(c.photoOffsetXmm || 0);
          if (inPY) inPY.value = String(c.photoOffsetYmm || 0);
          if (inPZ) inPZ.value = String(c.photoZoomPct || 100);
          if (valX) valX.textContent = (c.offsetXmm || 0).toFixed(1) + ' mm';
          if (valY) valY.textContent = (c.offsetYmm || 0).toFixed(1) + ' mm';
          if (valZ) valZ.textContent = Math.round(c.zoomPct || 100) + '%';
          if (valPX) valPX.textContent = (c.photoOffsetXmm || 0).toFixed(1) + ' mm';
          if (valPY) valPY.textContent = (c.photoOffsetYmm || 0).toFixed(1) + ' mm';
          if (valPZ) valPZ.textContent = Math.round(c.photoZoomPct || 100) + '%';
        } catch (_) {}
      };
      var refreshSliderLabels = function() {
        var c = readUI();
        if (valX) valX.textContent = c.offsetXmm.toFixed(1) + ' mm';
        if (valY) valY.textContent = c.offsetYmm.toFixed(1) + ' mm';
        if (valZ) valZ.textContent = Math.round(c.zoomPct) + '%';
        if (valPX) valPX.textContent = c.photoOffsetXmm.toFixed(1) + ' mm';
        if (valPY) valPY.textContent = c.photoOffsetYmm.toFixed(1) + ' mm';
        if (valPZ) valPZ.textContent = Math.round(c.photoZoomPct) + '%';
        applyLivePreviewCalibration(c);
      };

      // ── Sample image (foto reale per anteprima) ───────────────────
      var sampleImg = null, sampleReady = false;
      var frameOverlayImg = null, frameOverlayReady = false;
      var frameOverlayHole = null; // {left, top, width, height} in [0..1] rel a frameOverlayImg

      var __msDetectHoleRect = function(img) {
        try {
          var rect = null;
          if (typeof __msComputeTransparentRectFromImage === 'function') {
            rect = __msComputeTransparentRectFromImage(img);
          }
          return normalizeCalibrationPhotoRect(rect, calDefaultPreviewRect);
        } catch (_) { return null; }
      };
      var loadSample = function() {
        try {
          var src = '';
          // Priorita' 1: ultimo scatto disponibile
          if (!src) {
            try {
              var lp = String(localStorage.getItem('last_picture_url') || '').trim();
              if (lp && !/cursor_(cancel|ok)\.png/i.test(lp)) src = lp;
            } catch (_) {}
          }
          // Priorita' 2: preview foto corrente
          if (!src) {
            var pm = document.getElementById('ms-preview-main');
            if (pm && pm.src && pm.src.indexOf('data:image/') === 0) src = pm.src;
          }
          // Priorita' 3: ultima foto galleria (fallback)
          if (!src && window.__msGalleryState && Array.isArray(window.__msGalleryState.items) && window.__msGalleryState.items.length) {
            var it = window.__msGalleryState.items[0];
            if (it && it.path) src = (typeof window.__msToLocalImageUrl === 'function') ? window.__msToLocalImageUrl(it.path) : ('file:///' + String(it.path).replace(/\\\\/g, '/'));
          }
          if (!src) return;
          var im = new Image();
          im.onload = function() { sampleImg = im; sampleReady = true; renderPreview(); };
          im.onerror = function() { sampleReady = false; };
          im.src = src;
        } catch (_) {}
      };
      var loadFrameOverlaySample = function() {
        try {
          var src = '';
          try {
            var ov = document.getElementById('ms-frame-ov');
            if (ov && ov.src) src = String(ov.src || '').trim();
          } catch (_) {}
          if (!src) {
            try {
              if (typeof window.__msResolveFrameUrl === 'function') src = String(window.__msResolveFrameUrl() || '').trim();
            } catch (_) {}
          }
          if (!src) {
            frameOverlayImg = null;
            frameOverlayReady = false;
            frameOverlayHole = null;
            return;
          }
          frameOverlayHole = calDefaultPreviewRect || null;
          var fim = new Image();
          fim.onload = function() {
            frameOverlayImg = fim;
            frameOverlayReady = true;
            try { frameOverlayHole = __msDetectHoleRect(fim); } catch (_) { frameOverlayHole = null; }
            renderPreview();
          };
          fim.onerror = function() { frameOverlayImg = null; frameOverlayReady = false; frameOverlayHole = null; renderPreview(); };
          fim.src = src;
        } catch (_) {
          frameOverlayImg = null;
          frameOverlayReady = false;
        }
      };

      var drawPlaceholder = function(c, x, y, w, h) {
        var g = c.createLinearGradient(x, y, x + w, y + h);
        g.addColorStop(0, '#3b82f6'); g.addColorStop(1, '#8b5cf6');
        c.fillStyle = g; c.fillRect(x, y, w, h);
        c.fillStyle = 'rgba(255,255,255,0.85)'; c.font = 'bold 14px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('FOTO', x + w / 2, y + h / 2);
      };

      // Geometria stage <-> mm (per coordinate cursore)
      var lastGeom = null;

      var renderPreview = function() {
        if (!ctx || !canvas) return;
        var fmt = FORMATS[currentFormat] || FORMATS.postcard;
        var cal = readUI();

        // Dimensioni stage disponibili
        var stageW = (stageEl && stageEl.clientWidth) || 600;
        var stageH = (stageEl && stageEl.clientHeight) || 600;
        // Padding interno per evitare di toccare i bordi dello stage
        var availW = Math.max(120, stageW - 32);
        var availH = Math.max(120, stageH - 32);

        // Calcolo px-per-mm in modo da contenere il foglio nello stage,
        // poi moltiplico per previewZoom per ottenere il vero rendering
        // alla risoluzione richiesta (niente CSS transform: pixel sempre nitidi
        // e scroll naturale dello stage quando il foglio supera l'area).
        var ratio = fmt.paper.w / fmt.paper.h;
        var basePxPerMm;
        if (availW / availH > ratio) {
          basePxPerMm = (availH / fmt.paper.h);
        } else {
          basePxPerMm = (availW / fmt.paper.w);
        }
        var pxPerMm = basePxPerMm * previewZoom;

        var paperW = fmt.paper.w * pxPerMm;
        var paperH = fmt.paper.h * pxPerMm;

        // CSS size + DPR scaling per nitidezza
        var cssW = Math.ceil(paperW + 24);
        var cssH = Math.ceil(paperH + 24);
        var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
          canvas.style.width = cssW + 'px';
          canvas.style.height = cssH + 'px';
        }
        // Niente transform: lo zoom anteprima e' applicato direttamente nel render.
        canvas.style.transform = 'none';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        var px = (cssW - paperW) / 2;
        var py = (cssH - paperH) / 2;

        // Foglio (paper) — bianco con angoli arrotondati e ombra
        var radius = 8;
        var roundRect = function(x, y, w, h, r) {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
        ctx.fillStyle = '#fafafa';
        roundRect(px, py, paperW, paperH, radius);
        ctx.fill();
        ctx.restore();

        // Aree calcolate
        var marginPx = fmt.margin * pxPerMm;
        var bleedPx = (fmt.bleed || 1) * pxPerMm;

        // Area stampabile (paper - margini)
        var prX = px + marginPx, prY = py + marginPx;
        var prW = paperW - 2 * marginPx, prH = paperH - 2 * marginPx;

        // Safe area (centrata, dimensioni dichiarate)
        var safeW = (fmt.safe.w / fmt.paper.w) * paperW;
        var safeH = (fmt.safe.h / fmt.paper.h) * paperH;
        var safeX = px + (paperW - safeW) / 2;
        var safeY = py + (paperH - safeH) / 2;

        // Calibrazione applicata alla CORNICE (non alla foto).
        var offX = cal.offsetXmm * pxPerMm;
        var offY = cal.offsetYmm * pxPerMm;
        var zoom = cal.zoomPct / 100; if (zoom < 0.5) zoom = 0.5; if (zoom > 2) zoom = 2;
        var frameW = paperW * zoom;
        var frameH = paperH * zoom;
        var frameCx = px + paperW / 2 + offX;
        var frameCy = py + paperH / 2 + offY;
        var frameX = frameCx - frameW / 2;
        var frameY = frameCy - frameH / 2;
        var fw = paperW;
        var fh = paperH;
        var fx = px;
        var fy = py;

        // Clip al foglio
        ctx.save();
        roundRect(px, py, paperW, paperH, radius);
        ctx.clip();

        // Sfondo foglio bianco (così fuori cornice resta bianco)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px, py, paperW, paperH);

        // Foto: usa SOLO i controlli Foto, indipendenti dalla cornice.
        var photoOffX = cal.photoOffsetXmm * pxPerMm;
        var photoOffY = cal.photoOffsetYmm * pxPerMm;
        var photoZoom = cal.photoZoomPct / 100; if (photoZoom < 0.5) photoZoom = 0.5; if (photoZoom > 2) photoZoom = 2;
        var previewPhotoHole = normalizeCalibrationPhotoRect(frameOverlayHole || (frameOverlayReady ? calDefaultPreviewRect : null), calDefaultPreviewRect);
        var basePhX = px + (previewPhotoHole ? previewPhotoHole.left * paperW : 0);
        var basePhY = py + (previewPhotoHole ? previewPhotoHole.top * paperH : 0);
        var basePhW = previewPhotoHole ? previewPhotoHole.width * paperW : paperW;
        var basePhH = previewPhotoHole ? previewPhotoHole.height * paperH : paperH;
        var phW = basePhW * photoZoom;
        var phH = basePhH * photoZoom;
        var phX = basePhX + (basePhW - phW) / 2 + photoOffX;
        var phY = basePhY + (basePhH - phH) / 2 + photoOffY;

        if (sampleReady && sampleImg) {
          // Cover: riempie tutto il foro, croppa per mantenere proporzioni.
          var iw = sampleImg.naturalWidth, ih = sampleImg.naturalHeight;
          var ir = iw / ih, ar2 = phW / phH;
          var sx = 0, sy = 0, sw = iw, sh = ih;
          if (ir > ar2) { sw = ih * ar2; sx = (iw - sw) / 2; }
          else if (ir < ar2) { sh = iw / ar2; sy = (ih - sh) / 2; }
          ctx.drawImage(sampleImg, sx, sy, sw, sh, phX, phY, phW, phH);
        } else {
          drawPlaceholder(ctx, phX, phY, phW, phH);
        }

        if (frameOverlayReady && frameOverlayImg) {
          try { ctx.drawImage(frameOverlayImg, frameX, frameY, frameW, frameH); } catch (_) {}
        }

        ctx.restore(); // end clip foglio

        // === Overlay guida (solo outline, NON coprono mai la foto) ===
        // Bordo foglio (paper border)
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        roundRect(px + 0.5, py + 0.5, paperW - 1, paperH - 1, radius);
        ctx.stroke();

        // Area stampabile: outline nero tratteggiato sottile (solo se margine > 0,
        // altrimenti coincide col bordo carta e creerebbe confusione).
        if (fmt.margin > 0) {
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 1;
          ctx.strokeRect(prX, prY, prW, prH);
          ctx.restore();
        }

        // Safe area: outline verde alto contrasto (solo se piu' stretta del foglio).
        if (fmt.safe.w < fmt.paper.w || fmt.safe.h < fmt.paper.h) {
          ctx.save();
          ctx.setLineDash([7, 4]);
          ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3;
          ctx.strokeRect(safeX, safeY, safeW, safeH);
          ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.5;
          ctx.strokeRect(safeX, safeY, safeW, safeH);
          ctx.restore();
        }

        // Crop zone bleed: solo se bleed > 0 (altrimenti coincide col bordo carta).
        if ((fmt.bleed || 0) > 0) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1;
          var cropX = px + bleedPx, cropY = py + bleedPx;
          var cropW = paperW - 2 * bleedPx, cropH = paperH - 2 * bleedPx;
          ctx.strokeRect(cropX, cropY, cropW, cropH);
          ctx.restore();
        }

        // Croce centrale (riferimento centro cornice)
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 1;
        var ccx = frameCx, ccy = frameCy;
        var cl = Math.max(8, 6 * pxPerMm);
        ctx.beginPath();
        ctx.moveTo(ccx - cl, ccy); ctx.lineTo(ccx + cl, ccy);
        ctx.moveTo(ccx, ccy - cl); ctx.lineTo(ccx, ccy + cl);
        ctx.stroke();

        // Righelli mm (ogni 5 mm tick corti, ogni 10 mm tick lunghi + numeri)
        if (rulerCb && rulerCb.checked) {
          ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1;
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.font = '9px Arial';
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          var tk = 2 * pxPerMm, tkBig = 3.5 * pxPerMm;
          for (var mm = 0; mm <= fmt.paper.w; mm += 5) {
            var xm = px + mm * pxPerMm;
            var big = (mm % 10 === 0);
            ctx.beginPath();
            ctx.moveTo(xm, py); ctx.lineTo(xm, py + (big ? tkBig : tk));
            ctx.moveTo(xm, py + paperH - (big ? tkBig : tk)); ctx.lineTo(xm, py + paperH);
            ctx.stroke();
            if (big && mm > 0 && mm < fmt.paper.w) {
              ctx.fillText(String(mm), xm, py + tkBig + 2);
            }
          }
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          for (var mmy = 0; mmy <= fmt.paper.h; mmy += 5) {
            var ym = py + mmy * pxPerMm;
            var bigY = (mmy % 10 === 0);
            ctx.beginPath();
            ctx.moveTo(px, ym); ctx.lineTo(px + (bigY ? tkBig : tk), ym);
            ctx.moveTo(px + paperW - (bigY ? tkBig : tk), ym); ctx.lineTo(px + paperW, ym);
            ctx.stroke();
            if (bigY && mmy > 0 && mmy < fmt.paper.h) {
              ctx.fillText(String(mmy), px + tkBig + 2, ym);
            }
          }
        }

        // Etichetta valori in alto-sx
        ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.font = '11px Arial';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(
          fmt.label + '  ·  X ' + cal.offsetXmm + 'mm  Y ' + cal.offsetYmm + 'mm  Z ' + cal.zoomPct + '%  ·  FotoX ' + cal.photoOffsetXmm + 'mm  FotoY ' + cal.photoOffsetYmm + 'mm  FotoZ ' + cal.photoZoomPct + '%',
          px + 6, py + 6
        );

        lastGeom = { px: px, py: py, paperW: paperW, paperH: paperH, pxPerMm: pxPerMm, fmt: fmt };
        try { applyLivePreviewCalibration(cal); } catch (_) {}
      };

      var applyFormat = function(fmt, opts) {
        opts = opts || {};
        currentFormat = fmt;
        var def = FORMATS[fmt];
        if (formatSubEl && def) formatSubEl.textContent = def.sub;
        if (paperInfoEl && def) paperInfoEl.innerHTML = def.info;
        // Carica preset salvato per questo formato
        if (fmt === 'postcard' && opts.useBackend) {
          if (window.electronAPI && typeof window.electronAPI.getPrintCalibration === 'function') {
            window.electronAPI.getPrintCalibration().then(function(c) {
              writeUI(getEffectivePreset('postcard', c || getPreset('postcard')));
              setStatus('Calibrazione caricata');
              renderPreview();
            }).catch(function() {
              writeUI(getEffectivePreset('postcard', getPreset('postcard')));
              setStatus('Impossibile leggere calibrazione, uso preset locale');
              renderPreview();
            });
            return;
          }
        }
        writeUI(getEffectivePreset(fmt, getPreset(fmt)));
        if (def && !def.realPrint) setStatus('Preset visivo (stampa reale solo Postcard CP1500)');
        else setStatus('Preset caricato');
        renderPreview();
      };

      // ── Wiring sliders ────────────────────────────────────────────
      [inX, inY, inZ, inPX, inPY, inPZ].forEach(function(el) {
        if (!el) return;
        el.addEventListener('input', function() { refreshSliderLabels(); setStatus('Modifica non salvata'); renderPreview(); });
        el.addEventListener('change', function() { refreshSliderLabels(); renderPreview(); });
      });

      // ── Wiring tabs formato ───────────────────────────────────────
      var tabs = card.querySelectorAll('.ms-cal-tab');
      Array.prototype.forEach.call(tabs, function(t) {
        t.addEventListener('click', function() {
          Array.prototype.forEach.call(tabs, function(x) { x.classList.remove('is-active'); });
          t.classList.add('is-active');
          var fmt = t.getAttribute('data-format') || 'postcard';
          applyFormat(fmt, { useBackend: fmt === 'postcard' });
        });
      });

      // ── Toggles righelli/coords ───────────────────────────────────
      if (rulerCb) rulerCb.addEventListener('change', renderPreview);
      if (coordsCb) coordsCb.addEventListener('change', function() {
        if (coordsEl) coordsEl.style.display = coordsCb.checked ? '' : 'none';
      });

      // ── Zoom anteprima ────────────────────────────────────────────
      Array.prototype.forEach.call(card.querySelectorAll('.ms-cal-zoom-btn'), function(b) {
        b.addEventListener('click', function() {
          var step = parseFloat(b.getAttribute('data-zoom-step') || '0');
          previewZoom = Math.max(0.6, Math.min(1.6, previewZoom + step * 0.1));
          if (zoomVal) zoomVal.textContent = Math.round(previewZoom * 100) + '%';
          renderPreview();
        });
      });

      // ── Coordinate cursore in mm ──────────────────────────────────
      if (canvas) {
        canvas.addEventListener('mousemove', function(e) {
          if (!coordsEl || !coordsCb || !coordsCb.checked || !lastGeom) return;
          var rect = canvas.getBoundingClientRect();
          var cx = (e.clientX - rect.left) * (canvas.width / rect.width / (window.devicePixelRatio || 1));
          var cy = (e.clientY - rect.top) * (canvas.height / rect.height / (window.devicePixelRatio || 1));
          var mmX = (cx - lastGeom.px) / lastGeom.pxPerMm;
          var mmY = (cy - lastGeom.py) / lastGeom.pxPerMm;
          if (mmX < 0 || mmY < 0 || mmX > lastGeom.fmt.paper.w || mmY > lastGeom.fmt.paper.h) {
            coordsEl.textContent = '— mm';
          } else {
            coordsEl.textContent = mmX.toFixed(1) + ' mm × ' + mmY.toFixed(1) + ' mm';
          }
        });
        canvas.addEventListener('mouseleave', function() { if (coordsEl) coordsEl.textContent = '— mm'; });
      }

      // ── Re-render su resize/open ──────────────────────────────────
      var ro = null;
      try {
        if (typeof ResizeObserver !== 'undefined' && stageEl) {
          ro = new ResizeObserver(function() { renderPreview(); });
          ro.observe(stageEl);
        }
      } catch (_) {}
      window.addEventListener('resize', function() { renderPreview(); applyLivePreviewCalibration(); });

      // ── Salva ─────────────────────────────────────────────────────
      if (btnSave) btnSave.addEventListener('click', function() {
        var cal = readUI();
        // Sempre persiste il preset locale per il formato corrente
        setPreset(currentFormat, cal);
        setFramePreset(currentFormat, getCurrentFrameName(), cal);
        var fmtDef = FORMATS[currentFormat];
        if (fmtDef && fmtDef.realPrint && window.electronAPI && typeof window.electronAPI.setPrintCalibration === 'function') {
          // Solo postcard tocca la calibrazione di stampa reale (usata da galleria + post-scatto)
          btnSave.disabled = true;
          var frameOnlyCal = { offsetXmm: cal.offsetXmm, offsetYmm: cal.offsetYmm, zoomPct: cal.zoomPct };
          window.electronAPI.setPrintCalibration(frameOnlyCal).then(function(res) {
            btnSave.disabled = false;
            if (res && res.success) {
              var normalized = res.calibration || frameOnlyCal;
              var merged = {
                offsetXmm: clamp(normalized.offsetXmm, -5, 5, cal.offsetXmm),
                offsetYmm: clamp(normalized.offsetYmm, -5, 5, cal.offsetYmm),
                zoomPct: clamp(normalized.zoomPct, 80, 120, cal.zoomPct),
                photoOffsetXmm: cal.photoOffsetXmm,
                photoOffsetYmm: cal.photoOffsetYmm,
                photoZoomPct: cal.photoZoomPct
              };
              writeUI(merged);
              setPreset(currentFormat, merged);
              setFramePreset(currentFormat, getCurrentFrameName(), merged);
              setStatus('Preset salvato (applicato a stampa galleria + post-scatto)');
              try { showToast('Calibrazione salvata', 1600, '#22c55e'); } catch (_) {}
            } else {
              setStatus('Errore salvataggio: ' + ((res && res.message) || 'sconosciuto'));
            }
          }).catch(function(e) {
            btnSave.disabled = false;
            setStatus('Errore: ' + (e && e.message || 'IPC'));
          });
        } else {
          setStatus('Preset salvato (solo locale — formato non stampato dalla CP1500)');
          try { showToast('Preset ' + (fmtDef && fmtDef.label || currentFormat) + ' salvato', 1600, '#22c55e'); } catch (_) {}
        }
      });

      // ── Reset ─────────────────────────────────────────────────────
      if (btnReset) btnReset.addEventListener('click', function() {
        writeUI({ offsetXmm: 0, offsetYmm: 0, zoomPct: 100, photoOffsetXmm: 0, photoOffsetYmm: 0, photoZoomPct: 100 });
        setStatus('Valori resettati (non salvati)');
        renderPreview();
      });

      // ── Stampa di test ────────────────────────────────────────────
      if (btnTest) btnTest.addEventListener('click', function() {
        var fmtDef = FORMATS[currentFormat];
        if (!fmtDef || !fmtDef.realPrint) {
          setStatus('Stampa di test disponibile solo per Postcard 10×15 (CP1500)');
          try { showToast('Test print solo per Postcard CP1500', 2000, '#f59e0b'); } catch (_) {}
          return;
        }
        if (!window.electronAPI || typeof window.electronAPI.printTestPattern !== 'function') {
          setStatus('Stampa di test non disponibile');
          return;
        }
        var cal = readUI();
        btnTest.disabled = true;
        setStatus('Invio stampa di test…');
        try { if (typeof window.__msPlayUiButtonSound === 'function') window.__msPlayUiButtonSound('print'); } catch (_) {}
        window.electronAPI.printTestPattern({ calibration: cal }).then(function(res) {
          btnTest.disabled = false;
          if (res && res.success) {
            setStatus('Test inviato. Verifica allineamento sul foglio.');
            try { showToast('Stampa di test avviata', 1800, '#22c55e'); } catch (_) {}
          } else {
            setStatus('Test fallito: ' + ((res && res.message) || 'errore'));
            try { showToast('Test fallito: ' + ((res && res.message) || ''), 2400, '#ef4444'); } catch (_) {}
          }
        }).catch(function(e) {
          btnTest.disabled = false;
          setStatus('Test errore: ' + (e && e.message || 'IPC'));
        });
      });

      // Espone refresh pubblico: utile quando l'utente cambia cornice.
      window.__msRefreshCalibrationPreviewSample = function() {
        try { loadSample(); } catch (_) {}
        try { loadFrameOverlaySample(); } catch (_) {}
        try { renderPreview(); } catch (_) {}
        try { applyLivePreviewCalibration(); } catch (_) {}
      };

      // ── Bootstrap ─────────────────────────────────────────────────
      loadSample();
      loadFrameOverlaySample();
      applyFormat('postcard', { useBackend: true });
    };

    var __msPopulatePrinterDropdown = function() {
      var sel = document.getElementById('ms-printer-sel');
      if (!sel || sel.dataset.msPrinterBound === '1') return;
      sel.dataset.msPrinterBound = '1';
      var ensureOptions = function(items, current) {
        sel.innerHTML = '';
        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Seleziona stampante…';
        sel.appendChild(placeholder);
        items.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = p.name + (p.isDefault ? '  ★' : '');
          if (current && current === p.name) opt.selected = true;
          sel.appendChild(opt);
        });
        if (current && !items.some(function(p) { return p.name === current; })) {
          // Aggiunge l'opzione persistita anche se non più rilevata, per non perderla.
          var opt2 = document.createElement('option');
          opt2.value = current; opt2.textContent = current + '  (non rilevata)'; opt2.selected = true;
          sel.appendChild(opt2);
        }
      };
      var loadPrinters = function() {
        if (!window.electronAPI) return;
        var p1 = (typeof window.electronAPI.listSystemPrinters === 'function') ? window.electronAPI.listSystemPrinters() : Promise.resolve({ printers: [] });
        var p2 = (typeof window.electronAPI.getSelectedPrinter === 'function') ? window.electronAPI.getSelectedPrinter() : Promise.resolve({ printerName: '' });
        Promise.all([p1, p2]).then(function(res) {
          var list = (res[0] && Array.isArray(res[0].printers)) ? res[0].printers : [];
          var current = (res[1] && res[1].printerName) ? res[1].printerName : '';
          ensureOptions(list, current);
        }).catch(function() {});
      };
      loadPrinters();
      sel.addEventListener('change', function() {
        var name = String(sel.value || '').trim();
        if (!window.electronAPI || typeof window.electronAPI.setSelectedPrinter !== 'function') return;
        window.electronAPI.setSelectedPrinter(name).then(function(res) {
          if (res && res.state) __msUpdatePrinterState(res.state);
          if (name) showToast('Stampante selezionata: ' + name, 1800, '#22c55e');
        }).catch(function() {});
      });
    };

    var __msTriggerGalleryPrint = function(item, btn) {
      if (!item || !window.electronAPI || typeof window.electronAPI.printImage !== 'function') {
        showToast('Stampa non disponibile', 1800);
        return;
      }
      try { if (typeof window.__msPlayUiButtonSound === 'function') window.__msPlayUiButtonSound('print'); } catch (_) {}
      try {
        var __prefRawGG = localStorage.getItem('msPanelPrintEnabled');
        if (__prefRawGG === '0') {
          showToast('Stampa disattivata nelle opzioni', 2200, '#f59e0b');
          return;
        }
      } catch (_) {}
      if (!__msIsPrinterReady()) {
        var msg = (__msPrinterState && __msPrinterState.label) ? __msPrinterState.label : 'Stampante non disponibile';
        showToast('Stampante occupata: ' + msg, 2200, '#facc15');
        return;
      }
      // UI ottimistica: blocca subito tutti i pulsanti
      __msPrinterState = Object.assign({}, __msPrinterState, { status: 'busy', label: 'Invio in stampa…', hasActiveJob: true, progress: 5 });
      __msApplyPrinterStateToUI();
      var evtToken = String(__msGalleryState.eventText || __msGetSelectedEventText() || 'evento_senza_nome').trim();
      var __msResolvePrintTarget = function() {
        if (item.id && window.electronAPI && typeof window.electronAPI.resolveOriginalPhotoPath === 'function') {
          return window.electronAPI.resolveOriginalPhotoPath(evtToken, String(item.id)).then(function(r) {
            if (r && r.success && r.path) return r.path;
            // Fallback: lascia che main.js risolva by ID via token §
            return evtToken + '§ID:' + String(item.id);
          }).catch(function() {
            return evtToken + '§ID:' + String(item.id);
          });
        }
        if (item.fileName) return Promise.resolve(evtToken + '§' + String(item.fileName));
        if (item.path) return Promise.resolve(String(item.path));
        return Promise.resolve('');
      };
      __msResolvePrintTarget().then(function(filename) {
        try { console.log('[ms] gallery print -> id=' + (item.id || '-') + ' file=' + filename); } catch (_) {}
        if (!filename) {
          showToast('Foto originale non trovata', 2400, '#ef4444');
          __msFetchPrinterState(true);
          return;
        }
        return window.electronAPI.printImage(filename, __msPrinterState.printerName || null, { copies: 1, paperSize: 'Paper10x15', orientation: 'Portrait' });
      }).then(function(res) {
        if (!res) return;
        if (res && res.success) {
          __msSetPhotoPrinted(evtToken, item, true);
          item.__printed = true;
          __msRenderGallery();
          showToast('Stampa avviata', 1800, '#22c55e');
        } else if (res && res.busy) {
          showToast('Stampante occupata: attendi…', 2200, '#facc15');
        } else {
          showToast('Stampa fallita: ' + ((res && res.message) || 'errore sconosciuto'), 2600, '#ef4444');
        }
        __msFetchPrinterState(true);
      }).catch(function(err) {
        showToast('Errore stampa: ' + (err && err.message ? err.message : 'sconosciuto'), 2600, '#ef4444');
        __msFetchPrinterState(true);
      });
    };
    window.__msTriggerGalleryPrint = __msTriggerGalleryPrint;

    var __msGetSelectedEventText = function() {
      try {
        var evtSel = document.getElementById('ms-evt-sel');
        if (evtSel && evtSel.selectedIndex >= 0 && evtSel.options && evtSel.options[evtSel.selectedIndex]) {
          var t = String(evtSel.options[evtSel.selectedIndex].text || evtSel.options[evtSel.selectedIndex].textContent || '').trim();
          if (t) return t;
        }
      } catch (_) {}
      try {
        var ls = String(localStorage.getItem(MS_LAST_EVT_KEY) || '').trim();
        if (ls) return ls;
      } catch (_) {}
      return 'evento_senza_nome';
    };

    var __msToLocalImageUrl = function(absPath) {
      var normalized = String(absPath || '').split(String.fromCharCode(92)).join('/');
      return 'mslocal://localhost/' + encodeURIComponent(normalized);
    };

    var __msLoadEventPhotos = function(eventText) {
      return new Promise(function(resolve) {
        try {
          if (!window.electronAPI || typeof window.electronAPI.getEventPhotos !== 'function') {
            resolve({ success: false, photos: [], nextIdText: '0001' });
            return;
          }
          window.electronAPI.getEventPhotos(eventText).then(function(res) {
            resolve(res || { success: false, photos: [], nextIdText: '0001' });
          }).catch(function() {
            resolve({ success: false, photos: [], nextIdText: '0001' });
          });
        } catch (_) {
          resolve({ success: false, photos: [], nextIdText: '0001' });
        }
      });
    };

    var __msSetPreviewIdText = function(nextIdText) {
      var txt = 'ID ' + String(nextIdText || '0001').padStart(4, '0');
      window.__msCurrentPreviewIdText = txt;
      var wm = document.getElementById('ms-id-watermark');
      if (wm) wm.textContent = txt;
      var pv = document.getElementById('ms-preview-id-watermark');
      if (pv) pv.textContent = txt;
    };

    var __msPad2 = function(v) {
      var n = Number(v) || 0;
      return String(n).padStart(2, '0');
    };

    var __msFmtHm = function(ts) {
      var d = new Date(Number(ts) || 0);
      return __msPad2(d.getHours()) + ':' + __msPad2(d.getMinutes());
    };

    var __msBuildGalleryGroups = function(items) {
      var arr = Array.isArray(items) ? items : [];
      var slotMinutes = Math.max(10, Number(__msGalleryState.slotMinutes) || 30);
      var slotMs = slotMinutes * 60 * 1000;
      var cacheKey = String(slotMinutes) + '|' + arr.map(function(it) {
        return String(it && it.fileName || '') + ':' + String(it && it.mtimeMs || 0);
      }).join('|');
      if (cacheKey === __msGalleryState._groupCacheKey) {
        return __msGalleryState._groupCache;
      }

      var map = Object.create(null);
      arr.forEach(function(item, idx) {
        var rawTs = Number(item && item.mtimeMs) || 0;
        var ts = rawTs > 0 ? rawTs : (Date.now() - (idx * 1000));
        var startMs = Math.floor(ts / slotMs) * slotMs;
        var key = String(startMs);
        if (!map[key]) {
          map[key] = {
            key: key,
            startMs: startMs,
            endMs: startMs + slotMs,
            label: __msFmtHm(startMs) + ' - ' + __msFmtHm(startMs + slotMs),
            items: []
          };
        }
        map[key].items.push({ item: item, index: idx, ts: ts });
      });

      var groups = Object.keys(map).map(function(k) { return map[k]; }).sort(function(a, b) {
        return (b.startMs || 0) - (a.startMs || 0);
      });
      groups.forEach(function(g) {
        g.items.sort(function(a, b) {
          if ((b.ts || 0) !== (a.ts || 0)) return (b.ts || 0) - (a.ts || 0);
          return (b.index || 0) - (a.index || 0);
        });
      });

      __msGalleryState._groupCacheKey = cacheKey;
      __msGalleryState._groupCache = groups;
      return groups;
    };

    var __msSetSelectedGalleryIndex = function(index, card) {
      __msGalleryState.index = index;
      var host = document.getElementById('ms-gallery-grid');
      if (!host) return;
      Array.from(host.querySelectorAll('.ms-g-item.sel')).forEach(function(el) { el.classList.remove('sel'); });
      if (card) card.classList.add('sel');
    };

    var __msDisconnectGalleryObserver = function() {
      if (__msGalleryObserver) {
        try { __msGalleryObserver.disconnect(); } catch (_) {}
      }
      __msGalleryObserver = null;
    };

    var __msPrimeGalleryLazyAssets = function(scopeRoot) {
      var root = scopeRoot || document;
      var lazyImgs = Array.from(root.querySelectorAll('img[data-ms-src], .ms-g-bg[data-ms-bg]'));
      if (!lazyImgs.length) return;

      var hydrate = function(el) {
        if (!el) return;
        if (el.tagName === 'IMG') {
          var src = el.getAttribute('data-ms-src');
          if (src && !el.getAttribute('src')) el.setAttribute('src', src);
          el.removeAttribute('data-ms-src');
          return;
        }
        var bg = el.getAttribute('data-ms-bg');
        if (bg) el.style.backgroundImage = 'url("' + bg.replace(/"/g, '%22') + '")';
        el.removeAttribute('data-ms-bg');
      };

      if (typeof IntersectionObserver !== 'function') {
        lazyImgs.forEach(hydrate);
        return;
      }

      __msDisconnectGalleryObserver();
      __msGalleryObserver = new IntersectionObserver(function(entries, obs) {
        entries.forEach(function(entry) {
          if (!entry.isIntersecting) return;
          hydrate(entry.target);
          obs.unobserve(entry.target);
        });
      }, { root: document.getElementById('ms-gallery-grid'), threshold: 0.12, rootMargin: '120px 0px 120px 0px' });

      lazyImgs.forEach(function(el) { __msGalleryObserver.observe(el); });
    };

    var __msRenderGalleryChips = function(groups) {
      var chips = document.getElementById('ms-gallery-chips');
      if (!chips) return;
      chips.innerHTML = '';
      var arr = Array.isArray(groups) ? groups : [];
      if (!arr.length) return;
      arr.forEach(function(group) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ms-g-chip';
        btn.textContent = __msFmtHm(group.startMs) + ' · ' + String(group.items.length);
        btn.setAttribute('data-target', 'ms-g-sec-' + String(group.key));
        btn.addEventListener('click', function() {
          var target = document.getElementById('ms-g-sec-' + String(group.key));
          if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
        chips.appendChild(btn);
      });
    };

    var __msRefreshPreviewIdWatermark = function() {
      var evtTxt = __msGetSelectedEventText();
      __msLoadEventPhotos(evtTxt).then(function(res) {
        var nextIdText = (res && res.nextIdText) ? String(res.nextIdText) : '0001';
        __msSetPreviewIdText(nextIdText);
      });
    };
    window.__msRefreshPreviewIdWatermark = __msRefreshPreviewIdWatermark;

    var __msRenderGallery = function() {
      var grid = document.getElementById('ms-gallery-grid');
      var empty = document.getElementById('ms-gallery-empty');
      var count = document.getElementById('ms-gallery-count');
      var chips = document.getElementById('ms-gallery-chips');
      if (!grid || !empty || !count) return;

      __msDisconnectGalleryObserver();

      var total = __msGalleryState.items.length;
      if (!total) {
        grid.innerHTML = '';
        if (chips) chips.innerHTML = '';
        empty.style.display = 'block';
        count.textContent = '0 foto · 0 fasce orarie · 0 stampate';
        return;
      }

      var groups = __msBuildGalleryGroups(__msGalleryState.items);
      var printedCount = __msGalleryState.items.reduce(function(acc, photo) {
        if (!photo) return acc;
        return acc + ((photo.__printed || __msIsPhotoPrinted(__msGalleryState.eventText, photo)) ? 1 : 0);
      }, 0);
      __msGalleryState.groups = groups;
      empty.style.display = 'none';
      count.textContent = String(total) + ' foto · ' + String(groups.length) + ' fasce orarie · ' + String(printedCount) + ' stampate';
      __msRenderGalleryChips(groups);

      grid.innerHTML = '';
      var eagerBudget = 12;
      groups.forEach(function(group) {
        var section = document.createElement('section');
        section.className = 'ms-g-section';
        section.id = 'ms-g-sec-' + String(group.key);

        var head = document.createElement('div');
        head.className = 'ms-g-section-head';

        var tWrap = document.createElement('div');
        var title = document.createElement('div');
        title.className = 'ms-g-section-title';
        title.textContent = '🕒 ' + String(group.label);
        var sub = document.createElement('div');
        sub.className = 'ms-g-section-sub';
        sub.textContent = String(group.items.length) + ' foto';
        var line = document.createElement('div');
        line.className = 'ms-g-section-line';
        tWrap.appendChild(title);
        tWrap.appendChild(sub);
        tWrap.appendChild(line);
        head.appendChild(tWrap);

        var row = document.createElement('div');
        row.className = 'ms-g-row';

        group.items.forEach(function(entry, rowIdx) {
          var item = entry.item;
          var idx = entry.index;
          var card = document.createElement('div');
          card.className = 'ms-g-item';
          card.setAttribute('data-index', String(idx));
          if (idx === __msGalleryState.index) card.classList.add('sel');

          var mediaWrap = document.createElement('div');
          mediaWrap.className = 'ms-g-media';

          var bg = document.createElement('div');
          bg.className = 'ms-g-bg';

          var im = document.createElement('img');
          im.className = 'ms-g-photo';
          im.alt = item.fileName || ('foto_' + (idx + 1));
          im.loading = 'lazy';
          im.decoding = 'async';

          var localUrl = __msToLocalImageUrl(item.path);
          if (eagerBudget > 0 || rowIdx < 2) {
            bg.style.backgroundImage = 'url("' + localUrl.replace(/"/g, '%22') + '")';
            im.src = localUrl;
            eagerBudget--;
          } else {
            bg.setAttribute('data-ms-bg', localUrl);
            im.setAttribute('data-ms-src', localUrl);
          }

          var idBadge = document.createElement('div');
          idBadge.className = 'ms-g-id';
          idBadge.textContent = 'ID ' + String(item.id || '----');

          var printBadge = document.createElement('div');
          var isPrinted = !!item.__printed;
          printBadge.className = 'ms-g-print-badge ' + (isPrinted ? 'printed' : 'not-printed');
          printBadge.textContent = isPrinted ? 'Stampata' : 'Non stampata';

          var actions = document.createElement('div');
          actions.className = 'ms-g-actions';

          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'ms-g-btn open';
          openBtn.textContent = 'Stampa';
          openBtn.addEventListener('click', function(ev) {
            ev.stopPropagation();
            __msTriggerGalleryPrint(item, openBtn);
          });

          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'ms-g-btn del';
          delBtn.textContent = 'Elimina';
          delBtn.addEventListener('click', function(ev) {
            ev.stopPropagation();
            __msDeleteGalleryPhoto(idx);
          });

          actions.appendChild(openBtn);
          actions.appendChild(delBtn);
          mediaWrap.appendChild(bg);
          mediaWrap.appendChild(im);
          card.appendChild(mediaWrap);
          card.appendChild(idBadge);
          card.appendChild(printBadge);
          card.appendChild(actions);
          card.addEventListener('mouseenter', function() {
            __msSetSelectedGalleryIndex(idx, card);
          });
          card.addEventListener('pointerdown', function() {
            __msSetSelectedGalleryIndex(idx, card);
          });
          card.addEventListener('click', function() {
            __msSetSelectedGalleryIndex(idx, card);
            __msOpenGalleryViewer(idx);
          });
          row.appendChild(card);
        });

        section.appendChild(head);
        section.appendChild(row);
        grid.appendChild(section);
      });

      __msPrimeGalleryLazyAssets(grid);
      try { __msApplyPrinterStateToUI(); } catch (_) {}
    };

    var __msRenderGalleryViewer = function() {
      var modal = document.getElementById('ms-gallery-viewer-modal');
      var media = document.getElementById('ms-gallery-viewer-media');
      var meta = document.getElementById('ms-gallery-viewer-meta');
      if (!modal || !media || !meta) return;
      var total = __msGalleryState.items.length;
      if (!total) {
        modal.style.display = 'none';
        return;
      }
      if (__msGalleryState.index < 0) __msGalleryState.index = 0;
      if (__msGalleryState.index >= total) __msGalleryState.index = total - 1;
      var current = __msGalleryState.items[__msGalleryState.index];
      media.src = __msToLocalImageUrl(current.path);
      meta.textContent = 'ID ' + String(current.id || '----') + ' · ' + String(current.fileName || 'foto') + ' · ' + String(__msGalleryState.index + 1) + '/' + String(total);
    };

    var __msOpenGalleryViewer = function(index) {
      var modal = document.getElementById('ms-gallery-viewer-modal');
      if (!modal) return;
      if (typeof index === 'number') __msGalleryState.index = index;
      __msRenderGalleryViewer();
      modal.style.display = 'flex';
    };

    var __msCloseGalleryViewer = function() {
      var modal = document.getElementById('ms-gallery-viewer-modal');
      if (modal) modal.style.display = 'none';
    };

    var __msStepGalleryViewer = function(direction) {
      if (!__msGalleryState.items.length) return;
      var dir = direction >= 0 ? 1 : -1;
      __msGalleryState.index = (__msGalleryState.index + dir + __msGalleryState.items.length) % __msGalleryState.items.length;
      __msRenderGalleryViewer();
    };

    var __msDeleteGalleryPhoto = function(index) {
      if (!window.electronAPI || typeof window.electronAPI.deletePhoto !== 'function') {
        showToast('Eliminazione non disponibile', 2200);
        return;
      }
      var item = __msGalleryState.items[index];
      if (!item || !item.fileName) return;
      var token = String(__msGalleryState.eventText || __msGetSelectedEventText() || 'evento_senza_nome') + '§' + String(item.fileName);
      window.electronAPI.deletePhoto(token).then(function(res) {
        if (!res || !res.success) {
          showToast('Errore eliminazione foto', 2500);
          return;
        }
        __msSetPhotoPrinted(__msGalleryState.eventText || __msGetSelectedEventText(), item, false);
        __msLoadEventPhotos(__msGalleryState.eventText || __msGetSelectedEventText()).then(function(newRes) {
          __msGalleryState.items = (newRes && Array.isArray(newRes.photos)) ? newRes.photos : [];
          __msGalleryState.items.forEach(function(photo) {
            photo.__printed = __msIsPhotoPrinted(__msGalleryState.eventText, photo);
          });
          if (__msGalleryState.index >= __msGalleryState.items.length) __msGalleryState.index = Math.max(0, __msGalleryState.items.length - 1);
          __msRenderGallery();
          __msRenderGalleryViewer();
          __msRefreshPreviewIdWatermark();
          showToast('Foto eliminata', 1800, '#22c55e');
        });
      }).catch(function() {
        showToast('Errore eliminazione foto', 2500);
      });
    };

    var __msOpenGallery = function() {
      var modal = document.getElementById('ms-gallery-modal');
      var title = document.getElementById('ms-gallery-title');
      var subtitle = document.getElementById('ms-gallery-subtitle');
      var chips = document.getElementById('ms-gallery-chips');
      if (!modal) return;
      var evtTxt = __msGetSelectedEventText();
      if (!evtTxt || evtTxt === 'evento_senza_nome') {
        showToast('Seleziona un evento per aprire la galleria', 2200);
        return;
      }
      if (title) title.textContent = 'Galleria evento · ' + evtTxt;
      if (subtitle) subtitle.textContent = 'Timeline smart · fasce da 30 minuti';
      modal.style.display = 'flex';
      requestAnimationFrame(function() { modal.classList.add('show'); });
      var skelGrid = document.getElementById('ms-gallery-grid');
      var skelEmpty = document.getElementById('ms-gallery-empty');
      var skelCount = document.getElementById('ms-gallery-count');
      if (chips) chips.innerHTML = '';
      if (skelGrid) {
        skelGrid.innerHTML = '';
        for (var si = 0; si < 3; si++) {
          var skSec = document.createElement('section');
          skSec.className = 'ms-g-section';
          var skHead = document.createElement('div');
          skHead.className = 'ms-g-section-head';
          skHead.textContent = '🕒 --:-- - --:--';
          var skRow = document.createElement('div');
          skRow.className = 'ms-g-row';
          for (var sj = 0; sj < 4; sj++) {
            var sk = document.createElement('div');
            sk.className = 'ms-g-item ms-g-skel-card';
            skRow.appendChild(sk);
          }
          skSec.appendChild(skHead);
          skSec.appendChild(skRow);
          skelGrid.appendChild(skSec);
        }
      }
      if (skelEmpty) skelEmpty.style.display = 'none';
      if (skelCount) skelCount.textContent = 'Caricamento timeline…';
      __msLoadEventPhotos(evtTxt).then(function(res) {
        __msGalleryState.items = (res && Array.isArray(res.photos)) ? res.photos : [];
        __msGalleryState.items.forEach(function(photo) {
          photo.__printed = __msIsPhotoPrinted(evtTxt, photo);
        });
        __msGalleryState.index = 0;
        __msGalleryState.eventText = evtTxt;
        __msGalleryState._groupCacheKey = '';
        __msRenderGallery();
      });
    };

    var __msCloseGallery = function() {
      var modal = document.getElementById('ms-gallery-modal');
      if (!modal) return;
      __msDisconnectGalleryObserver();
      modal.classList.remove('show');
      setTimeout(function() {
        if (!modal.classList.contains('show')) modal.style.display = 'none';
      }, 250);
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
        sessFrameOv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill;z-index:2147483000;pointer-events:none;display:none;';
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
        // Evita doppia cornice: in sessione live la cornice "lite" e' quella attiva.
        // Manteniamo questo overlay allineato come src, ma invisibile quando la lite e' visibile.
        var liteOv = document.getElementById('ms-session-frame-ov-lite');
        var liteActive = false;
        try {
          liteActive = !!(liteOv && window.getComputedStyle(liteOv).display !== 'none');
        } catch (_) {}

        if (sessFrameOv.src !== source) sessFrameOv.src = source;
        if (liteActive) {
          if (sessFrameOv.style.display !== 'none') sessFrameOv.style.display = 'none';
          return;
        }

        if (sessFrameOv.style.display !== 'block') {
          sessFrameOv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill;z-index:2147483000;pointer-events:none;display:block;';
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
          try { if (typeof window.__msRefreshCalibrationPreviewSample === 'function') window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
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
          try { if (typeof window.__msRefreshCalibrationPreviewSample === 'function') window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
          syncSessionFrameOverlay();
        });
        if ((selectedName && fileName === selectedName) || (!selectedName && idx === 0 && !grid.querySelector('.ms-fi.sel'))) {
          item.classList.add('sel');
          var ov0 = document.getElementById('ms-frame-ov');
          if (ov0) { ov0.src = fileUrl; ov0.style.display = 'block'; }
          try { if (typeof window.__msRefreshCalibrationPreviewSample === 'function') window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
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
        if (!ctx2) {
          callback(null, true);
          return;
        }
        // Contain fit: preserva tutta la grafica della cornice, senza tagli.
        // Se il rapporto non e' 2:3, aggiunge margini trasparenti.
        var srcW = img.naturalWidth || img.width || SELPHY_W;
        var srcH = img.naturalHeight || img.height || SELPHY_H;
        var scale = Math.min(SELPHY_W / srcW, SELPHY_H / srcH);
        var drawW = Math.round(srcW * scale);
        var drawH = Math.round(srcH * scale);
        var dx = Math.round((SELPHY_W - drawW) / 2);
        var dy = Math.round((SELPHY_H - drawH) / 2);
        ctx2.clearRect(0, 0, SELPHY_W, SELPHY_H);
        ctx2.imageSmoothingEnabled = true;
        ctx2.imageSmoothingQuality = 'high';
        ctx2.drawImage(img, 0, 0, srcW, srcH, dx, dy, drawW, drawH);
        canvas.toBlob(function(blob) {
          if (!blob) {
            try {
              var fallbackDataUrl = canvas.toDataURL('image/png');
              callback(fallbackDataUrl || null, !fallbackDataUrl);
            } catch (_) {
              callback(null, true);
            }
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

    var refreshPanelFramePreview = function() {
      try {
        if (typeof window.__msRefreshCalibrationPreviewSample === 'function') {
          window.__msRefreshCalibrationPreviewSample();
          setTimeout(function() {
            try { window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
          }, 80);
        }
      } catch (_) {}
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
          refreshPanelFramePreview();
        });
        del.addEventListener('click', function(e) {
          e.stopPropagation();
          var dBtn = findFrameDeleteBtn(img); if (dBtn) dBtn.click();
          setTimeout(refreshFrames, 400);
        });
      });
      if (items.length && !grid.querySelector('.ms-fi.sel')) {
        var first = grid.querySelector('.ms-fi');
        if (first) { first.classList.add('sel'); var ov2 = document.getElementById('ms-frame-ov'); if (ov2) { ov2.src = first.dataset.s; ov2.style.display = 'block'; } refreshPanelFramePreview(); }
      }
      if (!items.length && !(window._msLocalFrames && window._msLocalFrames.length)) {
        var ov3 = document.getElementById('ms-frame-ov');
        if (ov3) ov3.style.display = 'none';
        refreshPanelFramePreview();
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
      __msPopulatePrinterDropdown();
      __msWirePrintCalibration();
      __msSubscribePrinterState();
      bindBtn('ms-gallery-btn', function() { __msOpenGallery(); });
      bindBtn('ms-gallery-btn-top', function() { __msOpenGallery(); });
      bindBtn('ms-start-btn-top', function() {
        var b = document.getElementById('ms-start-btn');
        if (b) { try { b.click(); } catch (_) {} }
      });

      // ── F2: posiziona START MIRROR come CTA sotto la preview ─────
      // Lo spostiamo da dentro #ms-preview-inner a #ms-preview-wrap,
      // come ultimo figlio, cosi' il flex column lo mette sotto e
      // centrato. Idempotente.
      (function() {
        try {
          var btn = document.getElementById('ms-start-btn');
          var wrap = document.getElementById('ms-preview-wrap');
          if (btn && wrap && btn.parentElement !== wrap) {
            wrap.appendChild(btn);
          }
        } catch (_) {}
      })();

      // ── F2.1: Sposta la card "Cornici" sotto START come strip orizzontale ──
      (function() {
        try {
          var wrap = document.getElementById('ms-preview-wrap');
          var framesCard = document.getElementById('ms-c-frames');
          if (!wrap || !framesCard) return;
          // Crea section wrapper (idempotente)
          var section = document.getElementById('ms-frames-section');
          if (!section) {
            section = document.createElement('div');
            section.id = 'ms-frames-section';
            // Header con titolo + frecce navigazione + bottone aggiungi
            var head = document.createElement('div');
            head.className = 'ms-frames-head';
            head.innerHTML =
              '<div class="ms-frames-title">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10v10H7z"/></svg>' +
                '<span>Cornici</span>' +
              '</div>' +
              '<div class="ms-frames-nav">' +
                '<button type="button" class="ms-frames-arrow" id="ms-frames-prev" aria-label="Scorri indietro">' +
                  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
                '</button>' +
                '<button type="button" class="ms-frames-arrow" id="ms-frames-next" aria-label="Scorri avanti">' +
                  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
                '</button>' +
                '<button type="button" class="ms-frames-add" id="ms-frames-add-proxy">' +
                  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                  '<span>Aggiungi</span>' +
                '</button>' +
              '</div>';
            section.appendChild(head);
          }
          // Sposta la card cornici dentro la section (sotto l'header)
          if (framesCard.parentElement !== section) {
            section.appendChild(framesCard);
          }
          framesCard.classList.add('ms-frames-strip');
          // Inserisci la section dopo #ms-start-btn (oppure in fondo a wrap)
          if (section.parentElement !== wrap) {
            wrap.appendChild(section);
          }
          // Wiring proxy del bottone Aggiungi -> click sull'input file esistente
          var proxyBtn = document.getElementById('ms-frames-add-proxy');
          if (proxyBtn && !proxyBtn.dataset.bound) {
            proxyBtn.dataset.bound = '1';
            proxyBtn.addEventListener('click', function() {
              try { console.log('[ms][frames] Aggiungi click'); } catch(_) {}
              var inp = document.getElementById('ms-frame-file-input');
              if (inp) inp.click();
              else console.warn('[ms][frames] file input non trovato');
            });
          }
          // Debug: log su tutti i click dentro la sezione cornici
          if (section && !section.dataset.dbg) {
            section.dataset.dbg = '1';
            section.addEventListener('click', function(ev) {
              try {
                var t = ev.target;
                var fi = t && t.closest && t.closest('.ms-fi');
                console.log('[ms][frames] section click', {
                  tag: t && t.tagName,
                  id: t && t.id,
                  cls: t && t.className,
                  onFrame: !!fi,
                  frameLocal: fi && fi.dataset && fi.dataset.local,
                  frameName: fi && fi.dataset && fi.dataset.name
                });
              } catch (_) {}
            }, true);
          }
          // Wiring frecce navigazione strip
          var grid = document.getElementById('ms-frames-grid');
          var prevBtn = document.getElementById('ms-frames-prev');
          var nextBtn = document.getElementById('ms-frames-next');
          var updateArrows = function() {
            if (!grid || !prevBtn || !nextBtn) return;
            var canScroll = grid.scrollWidth > grid.clientWidth + 2;
            var atStart = grid.scrollLeft <= 2;
            var atEnd = grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 2;
            prevBtn.disabled = !canScroll || atStart;
            nextBtn.disabled = !canScroll || atEnd;
            // Nasconde l'intero gruppo nav quando non c'è nulla da scrollare? No, le manteniamo disabled per coerenza visiva.
          };
          if (prevBtn && !prevBtn.dataset.bound) {
            prevBtn.dataset.bound = '1';
            prevBtn.addEventListener('click', function() {
              if (!grid) return;
              var step = Math.max(grid.clientWidth * 0.6, 144);
              grid.scrollBy({ left: -step, behavior: 'smooth' });
            });
          }
          if (nextBtn && !nextBtn.dataset.bound) {
            nextBtn.dataset.bound = '1';
            nextBtn.addEventListener('click', function() {
              if (!grid) return;
              var step = Math.max(grid.clientWidth * 0.6, 144);
              grid.scrollBy({ left: step, behavior: 'smooth' });
            });
          }
          if (grid && !grid.dataset.boundArrows) {
            grid.dataset.boundArrows = '1';
            grid.addEventListener('scroll', updateArrows, { passive: true });
            // Aggiorna stato frecce quando le cornici cambiano (add/remove)
            try {
              var mo = new MutationObserver(function() {
                requestAnimationFrame(updateArrows);
              });
              mo.observe(grid, { childList: true, subtree: false });
            } catch (_) {}
          }
          requestAnimationFrame(updateArrows);
          window.addEventListener('resize', updateArrows, { passive: true });
        } catch (e) {
          try { console.warn('[ms] frames-section relocate failed:', e.message); } catch(_) {}
        }
      })();

      // ── F2.1: Quick actions Galleria + Calibrazione in cima al panel ──
      (function() {
        try {
          var panel = document.getElementById('ms-panel');
          if (!panel) return;
          if (document.getElementById('ms-panel-actions')) return; // idempotente
          var bar = document.createElement('div');
          bar.id = 'ms-panel-actions';
          bar.className = 'ms-panel-actions';
          bar.innerHTML =
            '<button type="button" class="ms-pa-btn" id="ms-pa-gallery">' +
              '<span class="ms-pa-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>' +
              '<span>Galleria</span>' +
            '</button>' +
            '<button type="button" class="ms-pa-btn" id="ms-pa-calibration">' +
              '<span class="ms-pa-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg></span>' +
              '<span>Calibrazione</span>' +
            '</button>';
          panel.insertBefore(bar, panel.firstChild);
          var gBtn = document.getElementById('ms-pa-gallery');
          if (gBtn) gBtn.addEventListener('click', function() { try { __msOpenGallery(); } catch(_){} });
          var cBtn = document.getElementById('ms-pa-calibration');
          if (cBtn) cBtn.addEventListener('click', function() {
            if (typeof window.__msOpenCalibration === 'function') window.__msOpenCalibration();
            else {
              var legacy = document.getElementById('ms-calibration-btn-top');
              if (legacy) try { legacy.click(); } catch(_){}
            }
          });
        } catch (_) {}
      })();

      // ── F2.1: Aggiungi icone ai titoli delle card del panel ─────
      (function() {
        try {
          var icons = {
            'ms-c-dev':     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
            'ms-c-evt':     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
            'ms-c-save':    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
            'ms-c-pth':     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
            'ms-c-opts':    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
            'ms-c-timing':  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
            'ms-c-frames':  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10v10H7z"/></svg>'
          };
          Object.keys(icons).forEach(function(cardId) {
            var card = document.getElementById(cardId);
            if (!card) return;
            var ct = card.querySelector(':scope > .ms-ct');
            if (!ct) return;
            // Trova il primo span "title" — se non c'è, wrappa il primo nodo testo
            var firstSpan = ct.querySelector('span');
            if (!firstSpan) {
              firstSpan = document.createElement('span');
              firstSpan.textContent = ct.textContent.trim();
              ct.textContent = '';
              ct.appendChild(firstSpan);
            }
            if (!firstSpan.querySelector('.ms-ct-ic')) {
              var icSpan = document.createElement('span');
              icSpan.className = 'ms-ct-ic';
              icSpan.innerHTML = icons[cardId];
              firstSpan.insertBefore(icSpan, firstSpan.firstChild);
            }
          });
        } catch (_) {}
      })();

      // ── F1: Impostazioni (drawer laterale) ──────────────────────
      var __msOpenSettings = function() {
        var btn = document.getElementById('ms-settings-btn');
        var dw = document.getElementById('ms-settings-drawer');
        var bk = document.getElementById('ms-settings-backdrop');
        if (dw) { dw.classList.add('is-open'); dw.setAttribute('aria-hidden', 'false'); }
        if (bk) { bk.classList.add('is-open'); bk.setAttribute('aria-hidden', 'false'); }
        if (btn) btn.classList.add('is-active');
      };
      var __msCloseSettings = function() {
        var btn = document.getElementById('ms-settings-btn');
        var dw = document.getElementById('ms-settings-drawer');
        var bk = document.getElementById('ms-settings-backdrop');
        if (dw) { dw.classList.remove('is-open'); dw.setAttribute('aria-hidden', 'true'); }
        if (bk) { bk.classList.remove('is-open'); bk.setAttribute('aria-hidden', 'true'); }
        if (btn) btn.classList.remove('is-active');
      };
      window.__msOpenSettings = __msOpenSettings;
      window.__msCloseSettings = __msCloseSettings;

      bindBtn('ms-settings-btn', function() {
        var dw = document.getElementById('ms-settings-drawer');
        if (dw && dw.classList.contains('is-open')) __msCloseSettings();
        else __msOpenSettings();
      });
      bindBtn('ms-settings-close', function() { __msCloseSettings(); });
      (function() {
        var bk = document.getElementById('ms-settings-backdrop');
        if (bk && !bk.dataset.bound) {
          bk.dataset.bound = '1';
          bk.addEventListener('click', function() { __msCloseSettings(); });
        }
        // ESC chiude
        if (!window.__msSettingsEscBound) {
          window.__msSettingsEscBound = true;
          document.addEventListener('keydown', function(ev) {
            if (ev.key === 'Escape') {
              var dw = document.getElementById('ms-settings-drawer');
              if (dw && dw.classList.contains('is-open')) { __msCloseSettings(); }
            }
          });
        }
      })();

      // Highlight di una card del pannello (animazione "salta all'occhio")
      var __msFlashCard = function(cardId) {
        var c = document.getElementById(cardId);
        if (!c) return;
        try { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
        c.classList.remove('ms-sd-target');
        // forza reflow per ri-triggerare l'animazione
        void c.offsetWidth;
        c.classList.add('ms-sd-target');
        setTimeout(function() {
          if (c) c.classList.remove('ms-sd-target');
        }, 1600);
        // focus intelligente sul primo input/select/button della card
        try {
          var f = c.querySelector('select, input, button');
          if (f) f.focus({ preventScroll: true });
        } catch (_) {}
      };

      // Apertura modal calibrazione anche da contesti esterni al bottone topbar.
      var __msOpenCalibration = function() {
        var card = document.getElementById('ms-c-calibration');
        var backdrop = document.getElementById('ms-calibration-backdrop');
        if (!card) return;
        card.classList.add('ms-open');
        if (backdrop) backdrop.style.display = 'block';
        var legacy = document.getElementById('ms-calibration-btn-top');
        if (legacy) legacy.classList.add('is-active');
        setTimeout(function() {
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        }, 30);
      };
      window.__msOpenCalibration = __msOpenCalibration;

      // Wiring delle voci del drawer (delegated)
      (function() {
        var drawer = document.getElementById('ms-settings-drawer');
        if (!drawer || drawer.dataset.bound) return;
        drawer.dataset.bound = '1';
        drawer.addEventListener('click', function(ev) {
          var t = ev.target && ev.target.closest ? ev.target.closest('.ms-sd-item') : null;
          if (!t) return;
          var action = t.getAttribute('data-action');
          // Chiudi il drawer prima di aprire altri overlay (evita z-index conflicts)
          __msCloseSettings();
          // Piccolo delay per far percepire la transizione
          setTimeout(function() {
            switch (action) {
              case 'gallery':
                try { __msOpenGallery(); } catch (_) {}
                break;
              case 'calibration':
                __msOpenCalibration();
                break;
              case 'printer':
                __msFlashCard('ms-c-opts');
                break;
              case 'sounds':
                __msFlashCard('ms-c-opts');
                break;
              case 'timing':
                __msFlashCard('ms-c-timing');
                break;
              case 'folder':
                __msFlashCard('ms-c-pth');
                break;
              case 'advanced':
                __msFlashCard('ms-c-opts');
                break;
            }
          }, 220);
        });
      })();
      bindBtn('ms-calibration-btn-top', function() {
        var card = document.getElementById('ms-c-calibration');
        var btn = document.getElementById('ms-calibration-btn-top');
        var backdrop = document.getElementById('ms-calibration-backdrop');
        if (!card) return;
        var willOpen = !card.classList.contains('ms-open');
        if (willOpen) card.classList.add('ms-open');
        else card.classList.remove('ms-open');
        if (backdrop) backdrop.style.display = willOpen ? 'block' : 'none';
        if (btn) {
          if (willOpen) btn.classList.add('is-active');
          else btn.classList.remove('is-active');
        }
        // Forza un resize event così il canvas calibrazione si ridimensiona allo stage appena visibile
        if (willOpen) {
          setTimeout(function() {
            try { window.dispatchEvent(new Event('resize')); } catch (_) {}
          }, 30);
        }
      });
      bindBtn('ms-calibration-close', function() {
        var card = document.getElementById('ms-c-calibration');
        var btn = document.getElementById('ms-calibration-btn-top');
        var backdrop = document.getElementById('ms-calibration-backdrop');
        if (card) card.classList.remove('ms-open');
        if (btn) btn.classList.remove('is-active');
        if (backdrop) backdrop.style.display = 'none';
      });
      (function() {
        var backdrop = document.getElementById('ms-calibration-backdrop');
        if (backdrop && !backdrop.dataset.bound) {
          backdrop.dataset.bound = '1';
          backdrop.addEventListener('click', function() {
            var card = document.getElementById('ms-c-calibration');
            var btn = document.getElementById('ms-calibration-btn-top');
            if (card) card.classList.remove('ms-open');
            if (btn) btn.classList.remove('is-active');
            backdrop.style.display = 'none';
          });
        }
      })();
      bindBtn('ms-gallery-close', function() { __msCloseGallery(); });
      bindBtn('ms-gallery-download-all', function() {
        if (!__msGalleryState.items.length) { showToast('Nessuna foto da scaricare', 1800); return; }
        try {
          __msGalleryState.items.forEach(function(item, idx) {
            setTimeout(function() {
              var a = document.createElement('a');
              a.href = __msToLocalImageUrl(item.path);
              a.download = item.fileName || ('foto_' + (idx + 1) + '.jpg');
              a.style.display = 'none';
              (document.body || document.documentElement).appendChild(a);
              a.click();
              if (a.parentNode) a.parentNode.removeChild(a);
            }, idx * 90);
          });
          showToast('Download foto avviato', 1800, '#22c55e');
        } catch (_) {
          showToast('Download non disponibile', 2000);
        }
      });
      bindBtn('ms-gallery-viewer-close', function() { __msCloseGalleryViewer(); });
      bindBtn('ms-gallery-viewer-prev', function() {
        __msStepGalleryViewer(-1);
      });
      bindBtn('ms-gallery-viewer-next', function() {
        __msStepGalleryViewer(1);
      });
      bindBtn('ms-gallery-viewer-delete', function() {
        __msDeleteGalleryPhoto(__msGalleryState.index);
      });
      var __gModal = document.getElementById('ms-gallery-modal');
      if (__gModal && !__gModal.dataset.msb) {
        __gModal.dataset.msb = '1';
        __gModal.addEventListener('click', function(ev) {
          if (ev.target === __gModal) __msCloseGallery();
        });
      }
      var __gvModal = document.getElementById('ms-gallery-viewer-modal');
      if (__gvModal && !__gvModal.dataset.msb) {
        __gvModal.dataset.msb = '1';
        __gvModal.addEventListener('click', function(ev) {
          if (ev.target === __gvModal) __msCloseGalleryViewer();
        });
      }
      var __gvCard = document.getElementById('ms-gallery-viewer-card');
      if (__gvCard && !__gvCard.dataset.dragBound) {
        __gvCard.dataset.dragBound = '1';
        var __gvDrag = null;
        var __DRAG_THRESHOLD = 45;

        var __gvDragStart = function(x, y, id) {
          if (!__msGalleryState.items.length) return;
          __gvDrag = { id: id, x: x, y: y };
          __gvCard.classList.add('ms-dragging');
        };

        var __gvDragEnd = function(x, y, id) {
          if (!__gvDrag) return;
          if (typeof id !== 'undefined' && id !== null && __gvDrag.id !== id) return;
          var dx = x - __gvDrag.x;
          var dy = y - __gvDrag.y;
          var ax = Math.abs(dx);
          var ay = Math.abs(dy);
          __gvCard.classList.remove('ms-dragging');
          __gvDrag = null;
          if (ax < __DRAG_THRESHOLD && ay < __DRAG_THRESHOLD) return;
          if (ax >= ay) __msStepGalleryViewer(dx < 0 ? 1 : -1);
          else __msStepGalleryViewer(dy < 0 ? 1 : -1);
        };

        var __gvDragCancel = function() {
          __gvCard.classList.remove('ms-dragging');
          __gvDrag = null;
        };

        if (typeof window.PointerEvent === 'function') {
          __gvCard.addEventListener('pointerdown', function(ev) {
            if (ev.button !== 0) return;
            if (ev.target && ev.target.closest && ev.target.closest('button')) return;
            ev.preventDefault();
            __gvDragStart(ev.clientX, ev.clientY, ev.pointerId);
            try { __gvCard.setPointerCapture(ev.pointerId); } catch (_) {}
          });
          __gvCard.addEventListener('pointerup', function(ev) {
            __gvDragEnd(ev.clientX, ev.clientY, ev.pointerId);
            try { __gvCard.releasePointerCapture(ev.pointerId); } catch (_) {}
          });
          __gvCard.addEventListener('pointercancel', function(ev) {
            try { __gvCard.releasePointerCapture(ev.pointerId); } catch (_) {}
            __gvDragCancel();
          });
        } else {
          __gvCard.addEventListener('mousedown', function(ev) {
            if (ev.button !== 0) return;
            if (ev.target && ev.target.closest && ev.target.closest('button')) return;
            ev.preventDefault();
            __gvDragStart(ev.clientX, ev.clientY, 'mouse');
          });
          window.addEventListener('mouseup', function(ev) {
            __gvDragEnd(ev.clientX, ev.clientY, 'mouse');
          });
          __gvCard.addEventListener('touchstart', function(ev) {
            if (ev.target && ev.target.closest && ev.target.closest('button')) return;
            if (!ev.touches || !ev.touches.length) return;
            var t = ev.touches[0];
            __gvDragStart(t.clientX, t.clientY, 'touch');
          }, { passive: true });
          __gvCard.addEventListener('touchend', function(ev) {
            if (!ev.changedTouches || !ev.changedTouches.length) { __gvDragCancel(); return; }
            var t = ev.changedTouches[0];
            __gvDragEnd(t.clientX, t.clientY, 'touch');
          }, { passive: true });
          __gvCard.addEventListener('touchcancel', __gvDragCancel, { passive: true });
        }
      }
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
        // Persisti la selezione evento al momento del click START
        try {
          var __startEvtTxt = '';
          if (evtSel.selectedIndex >= 0 && evtSel.options && evtSel.options[evtSel.selectedIndex]) {
            var __opt = evtSel.options[evtSel.selectedIndex];
            __startEvtTxt = String(__opt.text || __opt.textContent || __opt.label || __opt.innerText || '').trim();
          }
          console.log('[ms] START event text=\"' + __startEvtTxt + '\" val=' + evtSel.value + ' idx=' + evtSel.selectedIndex);
          if (__startEvtTxt) {
            localStorage.setItem(MS_LAST_EVT_KEY, __startEvtTxt);
            console.log('[ms] saved event at START: ' + __startEvtTxt);
            // Imposta anche il main process via IPC (doppia sicurezza)
            try {
              if (window.electronAPI && typeof window.electronAPI.setCurrentEventFolder === 'function') {
                window.electronAPI.setCurrentEventFolder(__startEvtTxt).catch(function() {});
              }
            } catch (_) {}
          }
        } catch (e) { console.log('[ms] START save err: ' + (e && e.message)); }
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
        var hasRemoteStartFlow = !!ob || typeof window.count_down_start === 'function';
        if (hasRemoteStartFlow) {
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
        } else {
          // Locale: nessun bottone START remoto. Avviamo la sessione live qui:
          // 1) garantiamo che la camera sia in streaming
          // 2) spostiamo <video> fuori da ms-app cosi' resta visibile quando
          //    hideOverlayForSession nasconde ms-app
          try {
            var __camSel = document.getElementById('ms-cam-sel');
            if (__camSel && __camSel.value) startCamera(__camSel.value);
            else loadCameras();
          } catch (_) {}
          try {
            var __cv = document.getElementById('ms-cam-video');
            if (__cv) {
              if (!__cv.dataset.msHomeParentId) {
                __cv.dataset.msHomeParentId = (__cv.parentNode && __cv.parentNode.id) || 'ms-preview-inner';
                __cv.dataset.msHomeStyle = __cv.getAttribute('style') || '';
              }
              __cv.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:cover!important;z-index:2147482999!important;background:#000!important;transform:scaleX(-1);';
              (document.documentElement || document.body).appendChild(__cv);
              var __pp = __cv.play && __cv.play(); if (__pp && __pp.catch) __pp.catch(function(){});
            }
          } catch (_) {}
          hideOverlayForSession(true);
          syncSessionFrameOverlay();
          setTimeout(function() { syncSessionFrameOverlay(); }, 120);
          setTimeout(function() { syncSessionFrameOverlay(); }, 420);
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
              showToast('Impossibile adattare la cornice SELPHY: ' + file.name, 2500);
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
    var _msHideOverlayTimer = null;

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
      if (_msHideOverlayTimer) {
        clearTimeout(_msHideOverlayTimer);
        _msHideOverlayTimer = null;
      }
      writeSessionState(false);
      document.documentElement.removeAttribute('data-ms-nav');
      document.documentElement.removeAttribute('data-ms-session');
      // Rimetti ms-cam-video nella sua sede originale se era stato spostato in modalità locale.
      try {
        var __cvR = document.getElementById('ms-cam-video');
        if (__cvR && __cvR.dataset && __cvR.dataset.msHomeParentId) {
          var __homeParent = document.getElementById(__cvR.dataset.msHomeParentId) || document.getElementById('ms-preview-inner');
          if (__homeParent && __cvR.parentNode !== __homeParent) {
            __homeParent.appendChild(__cvR);
          }
          var __prevStyle = __cvR.dataset.msHomeStyle || '';
          if (__prevStyle) __cvR.setAttribute('style', __prevStyle); else __cvR.removeAttribute('style');
          delete __cvR.dataset.msHomeParentId;
          delete __cvR.dataset.msHomeStyle;
        }
      } catch (_) {}
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
      var app = document.getElementById('ms-app');
      var finalizeHide = function() {
        document.documentElement.setAttribute('data-ms-session', '1');
        if (app) {
          app.classList.remove('ms-app-out');
          app.style.display = 'none';
          app.style.opacity = '';
          app.style.pointerEvents = 'none';
          app.style.zIndex = '-1';
        }
      };
      if (_msHideOverlayTimer) {
        clearTimeout(_msHideOverlayTimer);
        _msHideOverlayTimer = null;
      }
      var shouldAnimateHide = !!app && !(_msSessionPersistedAtBoot && force);
      if (shouldAnimateHide) {
        app.style.display = '';
        app.style.opacity = '1';
        app.style.pointerEvents = 'none';
        app.style.zIndex = '999998';
        app.classList.add('ms-app-out');
        _msHideOverlayTimer = setTimeout(function() {
          _msHideOverlayTimer = null;
          finalizeHide();
        }, 180);
      } else {
        finalizeHide();
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
      try { if (typeof window.__msRefreshCalibrationPreviewSample === 'function') window.__msRefreshCalibrationPreviewSample(); } catch (_) {}
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

    const homePageUrl = 'file:///' + path.join(__dirname, 'local-home.html').replace(/\\/g, '/');
    mainWindow.loadURL(homePageUrl);
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
    mainWindow.webContents.on('dom-ready', () => {
      console.log('[nav] dom-ready url=' + mainWindow.webContents.getURL());
      // CSS preventivo: nasconde i vecchi controlli della pagina remota.
      try {
        mainWindow.webContents.insertCSS(
          '#captureBtn,#controls_main,#controls_buttons,.controls_main,' +
          '#controls_user,#controls_user_temp,#controls_user *,#controls_user_temp *,' +
          '#print,label#print,#print_foto,label[for=print_foto]' +
          '{opacity:0!important;visibility:hidden!important;pointer-events:none!important;}'
        );
      } catch (e) { console.log('[nav] insertCSS err: ' + e.message); }
      injectFrameUrlInterceptor(mainWindow);
      injectSessionFrameOverlay(mainWindow);
      // Inietta ms-app subito a dom-ready: crea l'overlay e ripristina opacity in
      // un unico round, eliminando la schermata nera. Il guard interno evita la
      // doppia esecuzione quando did-finish-load richiama la stessa funzione.
      injectRemoteUiRedesign(mainWindow);
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
        const parsedUrl = new URL(currentUrl);
        const pathname = parsedUrl.pathname;
        const isMirrorSessionPage = /\/mirror\/index\d+\.php$/i.test(pathname);
        const isMirrorHomePage = /\/mirror\/index\.php$/i.test(pathname) || /local-home\.html$/i.test(pathname);
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
        const isMirrorHomePage = /\/mirror\/index\.php$/i.test(targetPathname) || /local-home\.html$/i.test(targetPathname);
        const isMirrorIndexPage = /\/mirror\/index\d*\.php$/i.test(targetPathname) || /local-home\.html$/i.test(targetPathname);

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
        console.log('[ms] will-download fired filename=' + (item.getFilename() || '') + ' url=' + String(item.getURL() || '').slice(0, 80));
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
  const homeUrl = 'file:///' + path.join(__dirname, 'local-home.html').replace(/\\/g, '/');
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

ipcMain.handle('list-system-printers', async () => {
    return new Promise((resolve) => {
        try {
            const script = "$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;@(Get-Printer 2>$null | Select-Object Name,PrinterStatus,Default) | ConvertTo-Json -Depth 3 -Compress";
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4500, maxBuffer: 1024 * 1024 }, (err, stdout) => {
                if (err) { resolve({ success: false, printers: [], message: err.message }); return; }
                try {
                    const txt = String(stdout || '').trim();
                    if (!txt) { resolve({ success: true, printers: [] }); return; }
                    const parsed = JSON.parse(txt);
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    resolve({
                        success: true,
                        printers: arr.filter(Boolean).map((p) => ({
                            name: String((p && p.Name) || ''),
                            status: String((p && p.PrinterStatus) || ''),
                            isDefault: !!(p && p.Default),
                        })).filter((p) => p.name),
                    });
                } catch (e) {
                    resolve({ success: false, printers: [], message: 'ParseError: ' + e.message });
                }
            });
        } catch (e) {
            resolve({ success: false, printers: [], message: e.message });
        }
    });
});

ipcMain.handle('get-printer-state', async (_event, force) => {
    try {
        return await msComputePrinterState(!!force);
    } catch (e) {
        return { printerName: selectedPrinterName || '', status: 'error', label: 'Errore lettura stato', jobs: [], jobCount: 0, hasActiveJob: false, message: e.message || '', progress: 0 };
    }
});

ipcMain.handle('set-selected-printer', async (_event, name) => {
    try {
        selectedPrinterName = String(name || '').trim();
        msSavePersistedPrinter();
        const st = await msComputePrinterState(true);
        msBroadcastPrinterState(st);
        return { success: true, printerName: selectedPrinterName, state: st };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('get-selected-printer', async () => {
    return { printerName: selectedPrinterName || '' };
});

ipcMain.handle('get-print-calibration', async () => {
    return { ...printCalibration };
});

ipcMain.handle('set-print-calibration', async (_event, payload) => {
    try {
        printCalibration = msClampCalibration(payload || {});
        msSavePersistedPrinter();
        return { success: true, calibration: { ...printCalibration } };
    } catch (e) {
        return { success: false, message: e && e.message || 'set-print-calibration failed' };
    }
});

ipcMain.handle('print-test-pattern', async (_event, payload) => {
    try {
        const targetPrinter = String((payload && payload.printerName) || selectedPrinterName || '').trim();
        if (!targetPrinter) {
            return { success: false, code: 'NO_PRINTER', message: 'Stampante non selezionata' };
        }
        const preState = await msComputePrinterState(true);
        if (activePrintJob || preState.status === 'busy') {
            return { success: false, busy: true, message: 'Stampante occupata: attendi la stampa corrente', state: preState };
        }
        if (preState.status === 'offline') {
            return { success: false, code: 'OFFLINE', message: preState.label || 'Stampante offline', state: preState };
        }
        if (preState.status === 'error') {
            return { success: false, code: 'ERROR', message: preState.label || 'Errore stampante', state: preState };
        }
        const cal = msClampCalibration((payload && payload.calibration) || printCalibration);
        activePrintJob = { brokerJobId: null, fileName: '__calibration_test__', startedAt: Date.now() };
        msStartPrinterPolling();
        try {
            const direct = await msSubmitDirectWindowsPrint(null, targetPrinter, { calibration: cal, testPattern: true });
            if (activePrintJob) activePrintJob.brokerJobId = direct.id;
            msBroadcastPrinterState(await msComputePrinterState(true));
            return { success: true, id: direct.id, direct: true, calibration: cal };
        } catch (e) {
            activePrintJob = null;
            msBroadcastPrinterState(await msComputePrinterState(true));
            return { success: false, message: e && e.message || 'print-test-pattern failed' };
        }
    } catch (e) {
        return { success: false, message: e && e.message || 'print-test-pattern error' };
    }
});

ipcMain.handle('resolve-original-photo-path', async (_event, eventName, photoId) => {
    try {
        const evt = String(eventName || '').trim();
        const id = String(photoId || '').trim();
        const p = resolvePhotoPathByEventAndId(evt, id);
        try { console.log('[resolve-original-photo-path]', { eventName: evt, photoId: id, resolved: p }); } catch (_) {}
        if (!p) return { success: false, message: 'File originale non trovato per ID ' + id };
        return { success: true, path: p };
    } catch (err) {
        return { success: false, message: err && err.message ? err.message : 'errore risoluzione path' };
    }
});

ipcMain.handle('print-image', async (event, filename, printerName, options = {}) => {
    try {
        try { console.log('[print-image] richiesta', { filename, printerName: printerName || selectedPrinterName }); } catch (_) {}
        const targetPrinter = String(printerName || selectedPrinterName || '').trim();
        if (!targetPrinter) {
            return { success: false, code: 'NO_PRINTER', message: 'Stampante non selezionata' };
        }
        const preState = await msComputePrinterState(true);
        if (activePrintJob || preState.status === 'busy') {
            return { success: false, busy: true, message: 'Stampante occupata: attendi la stampa corrente', state: preState };
        }
        if (preState.status === 'offline') {
            return { success: false, code: 'OFFLINE', message: preState.label || 'Stampante offline', state: preState };
        }
        if (preState.status === 'error') {
            return { success: false, code: 'ERROR', message: preState.label || 'Errore stampante', state: preState };
        }

        const imagePath = resolveImagePath(filename);
        try { console.log('[print-image] path risolto', { imagePath }); } catch (_) {}

        await fs.access(imagePath);

        const payload = {
            imagePath,
            printerName: targetPrinter,
            copies: options.copies || 1,
            paperSize: options.paperSize || 'Paper10x15',
            orientation: options.orientation || 'Portrait',
            metadata: options.metadata || {}
        };

        activePrintJob = { brokerJobId: null, fileName: filename, startedAt: Date.now() };
        msStartPrinterPolling();
        try {
            const response = await callPrintBroker('/jobs', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (response && response.id) activePrintJob.brokerJobId = response.id;
            msBroadcastPrinterState(await msComputePrinterState(true));
            return { success: true, ...response };
        } catch (submitErr) {
            if (msIsBrokerUnavailableError(submitErr)) {
                try {
                    const direct = await msSubmitDirectWindowsPrint(imagePath, targetPrinter);
                    if (activePrintJob) activePrintJob.brokerJobId = direct.id;
                    msBroadcastPrinterState(await msComputePrinterState(true));
                    return {
                        success: true,
                        id: direct.id,
                        direct: true,
                        message: 'Stampa avviata in fallback locale (broker offline)'
                    };
                } catch (directErr) {
                    activePrintJob = null;
                    msBroadcastPrinterState(await msComputePrinterState(true));
                    return {
                        success: false,
                        code: 'BROKER_OFFLINE_FALLBACK_FAILED',
                        message: 'Broker offline e stampa diretta fallita: ' + (directErr && directErr.message ? directErr.message : 'errore sconosciuto')
                    };
                }
            }
            activePrintJob = null;
            msBroadcastPrinterState(await msComputePrinterState(true));
            throw submitErr;
        }
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

ipcMain.handle('get-event-photos', async (_event, eventName) => {
  try {
    const raw = String(eventName || '').trim();
    let folder = getCurrentEventFolderName();
    if (raw && raw !== 'evento_senza_nome') {
      folder = setCurrentEventFolderName(raw);
    }
    const rootPath = getPhotoRootPath();
    const folderPath = path.join(rootPath, folder);
    await fs.mkdir(folderPath, { recursive: true });

    let names = [];
    try {
      names = await fs.readdir(folderPath);
    } catch (_) {
      names = [];
    }

    const photos = [];
    for (const name of names) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(name)) continue;
      const abs = path.join(folderPath, name);
      let stat = null;
      try { stat = await fs.stat(abs); } catch (_) { stat = null; }
      const seq = extractPhotoSeqId(name);
      photos.push({
        id: seq ? String(seq).padStart(4, '0') : '',
        seq: seq || 0,
        fileName: name,
        path: abs,
        mtimeMs: stat && stat.mtimeMs ? Math.floor(stat.mtimeMs) : 0,
      });
    }

    photos.sort((a, b) => {
      if ((b.seq || 0) !== (a.seq || 0)) return (b.seq || 0) - (a.seq || 0);
      if ((b.mtimeMs || 0) !== (a.mtimeMs || 0)) return (b.mtimeMs || 0) - (a.mtimeMs || 0);
      return String(b.fileName || '').localeCompare(String(a.fileName || ''));
    });

    let nextId = photos.length + 1;
    for (const p of photos) {
      if ((p.seq || 0) >= nextId) nextId = p.seq + 1;
    }

    return {
      success: true,
      folder,
      photos,
      nextId,
      nextIdText: String(nextId).padStart(4, '0'),
    };
  } catch (error) {
    return { success: false, message: error.message, photos: [], nextId: 1, nextIdText: '0001' };
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
    // Ignora rawEventName se è il valore di fallback: il main process ha già il valore corretto
    if (rawEventName && rawEventName !== 'evento_senza_nome') {
      eventFolder = setCurrentEventFolderName(rawEventName);
    }
    let fileName = path.basename(rawFileName || '').trim();
    if (fileName.includes('§')) {
      const sep = fileName.includes('§') ? '§' : 'Â§';
      const p = fileName.split(sep);
      if (p.length > 1) {
        // Usa il folder dal filename SOLO se non è stato specificato un eventName dal pannello
        if (!rawEventName) {
          eventFolder = resolveEventFolderName(p[0]);
        }
        fileName = path.basename(p.slice(1).join(sep)).trim();
      }
    }

    // Filename = <nome_evento>_<ID progressivo>.ext
    const rootPath = getPhotoRootPath();
    const folderPath = path.join(rootPath, eventFolder);
    await fs.mkdir(folderPath, { recursive: true });
    // Conta i file già presenti per generare l'ID progressivo
    let nextId = 1;
    try {
      const existing = await fs.readdir(folderPath);
      const photos = existing.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      nextId = photos.length + 1;
    } catch (_) {}
    const seqId = String(nextId).padStart(4, '0');
    fileName = eventFolder + '_' + seqId + ext;

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


