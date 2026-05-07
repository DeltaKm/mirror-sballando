const { app, BrowserWindow, session, ipcMain, screen, webFrameMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const Client = require('ssh2-sftp-client');

const BROKER_URL = process.env.PRINT_BROKER_URL || 'http://127.0.0.1:5177';
const BROKER_TOKEN_HEADER = process.env.PRINT_BROKER_TOKEN_HEADER || 'X-Local-Token';
const TV_WIDTH = 1200;
const TV_HEIGHT = 1920;
let mainWindow;
let isApplyingBounds = false;

function getAppBasePath() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
}

function getPhotoRootPath() {
  return path.join(getAppBasePath(), 'Foto');
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

  if (filename.includes('§')) {
    const folder = filename.split('§')[0];
    const imageName = filename.split('§')[1];
    return path.join(getPhotoRootPath(), folder, imageName);
  }

  return path.join(getPhotoRootPath(), filename);
}

function injectWindowControls(win) {
  const script = `(() => {
    if (window.__msWindowControlsInjected) {
      return;
    }

    window.__msWindowControlsInjected = true;

    const invokeControl = async (action) => {
      try {
        if (window.electronAPI) {
          if (action === 'minimize' && window.electronAPI.minimizeWindow) {
            return await window.electronAPI.minimizeWindow();
          }

          if (action === 'toggle-fullscreen' && window.electronAPI.toggleWindowFullscreen) {
            return await window.electronAPI.toggleWindowFullscreen();
          }
        }
      } catch {}

      try {
        window.postMessage({ source: 'ms-window-controls', action }, '*');
      } catch {}

      return false;
    };

    const ensureControls = () => {
      let host = document.getElementById('ms-window-controls');
      if (host) {
        return;
      }

      host = document.createElement('div');
      host.id = 'ms-window-controls';
      host.style.cssText = [
        'position:fixed',
        'top:12px',
        'right:12px',
        'z-index:2147483647',
        'display:flex',
        'gap:8px',
        'pointer-events:auto'
      ].join(';');

      host.addEventListener('click', (event) => event.stopPropagation(), true);

      const styleButton = (btn) => {
        btn.style.cssText = [
          'width:44px',
          'height:44px',
          'border:none',
          'border-radius:10px',
          'background:rgba(0, 0, 0, 0.55)',
          'color:#fff',
          'font-size:22px',
          'cursor:pointer',
          'line-height:1',
          'backdrop-filter:blur(3px)',
          '-webkit-backdrop-filter:blur(3px)',
          'pointer-events:auto'
        ].join(';');
      };

      const btnMin = document.createElement('button');
      btnMin.type = 'button';
      btnMin.title = 'Riduci';
      btnMin.textContent = '-';
      styleButton(btnMin);
      btnMin.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await invokeControl('minimize');
      });

      const btnFs = document.createElement('button');
      btnFs.type = 'button';
      btnFs.title = 'Fullscreen';
      btnFs.textContent = '[]';
      styleButton(btnFs);
      btnFs.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const isFullscreen = await invokeControl('toggle-fullscreen');
        btnFs.textContent = isFullscreen ? '<>' : '[]';
      });

      host.appendChild(btnMin);
      host.appendChild(btnFs);
      (document.body || document.documentElement).appendChild(host);
    };

    ensureControls();

    const observer = new MutationObserver(() => ensureControls());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  })();`;

  win.webContents.executeJavaScript(script).catch(() => {});
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
  const script = `(() => {
    if (window.__msPreStartResizeInjected) {
      return;
    }

    window.__msPreStartResizeInjected = true;

    const controlsSelector = '#controls';

    const getCandidateDocuments = () => {
      const docs = [document];
      const frames = document.querySelectorAll('iframe');
      frames.forEach((frame) => {
        try {
          if (frame.contentDocument) {
            docs.push(frame.contentDocument);
          }
        } catch {}
      });
      return docs;
    };

    const findControlsContext = () => {
      const docs = getCandidateDocuments();
      for (const doc of docs) {
        const controls = doc.querySelector(controlsSelector);
        if (controls) {
          return { doc, controls };
        }
      }
      return null;
    };

    const findCorniciAnchor = (controls) => {
      if (!controls) {
        return null;
      }

      const actionNodes = controls.querySelectorAll('button, input[type=button], input[type=submit], label, span, td, th, div, b, strong');
      for (const node of actionNodes) {
        const txt = String(node.textContent || node.value || '').trim().toLowerCase();
        if (txt.includes('aggiungi cornici') || txt.includes('cornici') || txt.includes('cornice')) {
          return node.closest('tr, td, div, table') || node;
        }
      }

      const nodes = controls.querySelectorAll('label, span, td, th, div, b, strong');
      for (const node of nodes) {
        const txt = String(node.textContent || '').trim().toLowerCase();
        if (txt.includes('cornici') || txt.includes('cornice')) {
          return node.closest('tr, td, div') || node;
        }
      }
      return null;
    };

    const focusControlPanel = (controls) => {
      if (!controls) {
        return;
      }

      try {
        controls.style.display = 'block';
        controls.style.visibility = 'visible';
        controls.style.opacity = '1';
        controls.scrollIntoView({ block: 'end', behavior: 'smooth' });
      } catch {}
    };

    const ensureStyles = (doc) => {
      let style = doc.getElementById('ms-prestart-resize-style');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'ms-prestart-resize-style';
        doc.head.appendChild(style);
      }

      style.textContent = \
        '#controls{position:fixed !important;left:50% !important;transform:translateX(-50%) !important;bottom:16px !important;width:min(1040px,92vw) !important;max-width:1040px !important;max-height:55vh !important;overflow-y:auto !important;z-index:2147483000 !important;}' +
        '#controls *{font-size:1.06em !important;}' +
        '#controls button,#controls input[type=button],#controls input[type=submit],#controls select,#controls input[type=text],#controls input[type=number]{min-height:52px !important;}' +
        '#ms-usb-camera-chooser{display:flex !important;align-items:center !important;gap:8px !important;flex-wrap:wrap !important;margin:8px 0 10px 0 !important;padding:8px 10px !important;border:1px solid rgba(255,255,255,.45) !important;border-radius:10px !important;background:rgba(0,0,0,.22) !important;}' +
        '#ms-usb-camera-title{color:#fff !important;font-weight:700 !important;padding-right:6px !important;}' +
        '#ms-usb-camera-select{min-width:320px !important;max-width:100% !important;min-height:40px !important;padding:4px 8px !important;border-radius:8px !important;border:1px solid rgba(255,255,255,.65) !important;}' +
        '#ms-usb-camera-hint{color:#fff !important;opacity:.9 !important;font-size:12px !important;}' +
        '#ms-camera-config-section{display:block !important;position:relative !important;margin-top:10px !important;padding:10px !important;border:2px solid rgba(255,255,255,.7) !important;border-radius:10px !important;background:rgba(0,0,0,.28) !important;z-index:30 !important;}' +
        '#ms-camera-config-title{font-size:18px !important;font-weight:800 !important;letter-spacing:.02em !important;color:#fff !important;padding:0 0 8px 0 !important;opacity:1 !important;}' +
        '#ms-camera-config-body{display:grid !important;grid-template-columns:1fr 1fr !important;gap:8px 12px !important;}' +
        '#ms-camera-config-body label{display:flex !important;flex-direction:column !important;gap:4px !important;color:#fff !important;}' +
        '#ms-camera-config-body select,#ms-camera-config-body input[type=range]{width:100% !important;}' +
        '#ms-camera-config-body .ms-camera-empty{grid-column:1/-1 !important;opacity:.85 !important;padding:6px 0 !important;}' +
        '#ms-camera-config-body .ms-camera-full{grid-column:1/-1 !important;}' +
        '#ms-camera-config-body .ms-embedded-camera-panel{position:static !important;left:auto !important;right:auto !important;bottom:auto !important;top:auto !important;width:100% !important;max-height:none !important;overflow:visible !important;margin:0 !important;padding:0 !important;border:none !important;box-shadow:none !important;background:transparent !important;}' +
        '#ms-camera-config-body .ms-embedded-camera-panel button[title="chiudi"],#ms-camera-config-body .ms-embedded-camera-panel .close,#ms-camera-config-body .ms-embedded-camera-panel .btn-close{display:none !important;}' +
        '#ms-prestart-preview{position:fixed !important;top:56px !important;left:50% !important;transform:translateX(-50%) !important;width:min(980px,90vw) !important;height:min(56vh,980px) !important;max-height:56vh !important;border:3px solid rgba(255,255,255,.78) !important;border-radius:22px !important;overflow:hidden !important;box-shadow:0 18px 44px rgba(0,0,0,.5) !important;background:#000 !important;z-index:2147482600 !important;display:flex !important;align-items:center !important;justify-content:center !important;pointer-events:none !important;}' +
        '#ms-prestart-preview .ms-prestart-placeholder{color:rgba(255,255,255,.85) !important;font-size:22px !important;font-weight:600 !important;letter-spacing:.02em !important;}' +
        '#ms-prestart-preview img,#ms-prestart-preview video,#ms-prestart-preview canvas{width:100% !important;height:100% !important;object-fit:cover !important;display:block !important;}' +
        '#ms-prestart-preview .ms-preview-frame{position:absolute !important;inset:0 !important;width:100% !important;height:100% !important;object-fit:cover !important;pointer-events:none !important;}';
    };

    const ensureCameraConfigSection = (doc, controls) => {
      if (!controls) {
        return;
      }

      let section = doc.getElementById('ms-camera-config-section');
      if (!section) {
        section = doc.createElement('div');
        section.id = 'ms-camera-config-section';
        section.innerHTML =
          '<div id="ms-camera-config-title">Impostazioni telecamera</div>' +
          '<div id="ms-camera-config-body">' +
          '<label><span>Dispositivo</span><select><option>Camera predefinita</option></select></label>' +
          '<label><span>Risoluzione</span><select><option>1920x1080</option><option>1280x720</option><option>640x480</option></select></label>' +
          '<label><span>Luminosita</span><input type="range" min="0" max="100" value="50" /></label>' +
          '<label><span>Contrasto</span><input type="range" min="0" max="100" value="50" /></label>' +
          '<label class="ms-camera-full"><input type="checkbox" /> <span>Specchia anteprima</span></label>' +
          '</div>';
      }

      const corniciAnchor = findCorniciAnchor(controls);
      if (corniciAnchor && corniciAnchor.parentNode) {
        const host = corniciAnchor.closest('tr, div, td') || corniciAnchor;
        if (section.parentNode !== host.parentNode || section.previousSibling !== host) {
          host.parentNode.insertBefore(section, host.nextSibling);
        }
      }

      if (!section.parentNode) {
        controls.appendChild(section);
      }

      const body = doc.getElementById('ms-camera-config-body');
      if (!body) {
        return;
      }

      // Se esiste il pannello reale "Camera Settings", spostalo nel pannello controlli
      // per mantenere attive tutte le interazioni (es. scelta telecamera).
      const embedded = body.querySelector('.ms-embedded-camera-panel');
      if (!embedded) {
        const candidates = doc.querySelectorAll('div,section,form,table');
        for (const node of candidates) {
          if (!node || node === section || node.id === 'controls' || body.contains(node) || section.contains(node)) {
            continue;
          }

          const text = String(node.textContent || '').toLowerCase();
          const hasCameraTitle = text.includes('camera settings') || text.includes('impostazioni telecamera');
          const hasControls = node.querySelector('select, input[type=range], input[type=checkbox]');
          if (!hasCameraTitle || !hasControls) {
            continue;
          }

          node.classList.add('ms-embedded-camera-panel');
          node.style.setProperty('position', 'static', 'important');
          node.style.setProperty('left', 'auto', 'important');
          node.style.setProperty('right', 'auto', 'important');
          node.style.setProperty('top', 'auto', 'important');
          node.style.setProperty('bottom', 'auto', 'important');
          node.style.setProperty('width', '100%', 'important');
          node.style.setProperty('max-height', 'none', 'important');
          node.style.setProperty('overflow', 'visible', 'important');
          node.style.setProperty('z-index', 'auto', 'important');

          body.innerHTML = '';
          body.appendChild(node);
          break;
        }
      }

      // Il tasto chiudi/back della sezione camera riporta sempre al pannello controllo.
      const actionButtons = body.querySelectorAll('button, input[type=button], input[type=submit], a');
      actionButtons.forEach((btn) => {
        if (btn.dataset.msReturnBound === '1') {
          return;
        }

        const label = String(btn.textContent || btn.value || '').trim().toLowerCase();
        if (!label.includes('chiudi') && !label.includes('close') && !label.includes('indietro') && !label.includes('back')) {
          return;
        }

        btn.dataset.msReturnBound = '1';
        btn.addEventListener('click', () => {
          setTimeout(() => focusControlPanel(controls), 60);
        });
      });
    };

    const syncPreferredCameraToRealPanel = (doc) => {
      let preferredId = '';
      let preferredLabel = '';
      try {
        preferredId = localStorage.getItem('msPreferredCameraDeviceId') || '';
        preferredLabel = (localStorage.getItem('msPreferredCameraLabel') || '').toLowerCase();
      } catch {}

      if (!preferredId && !preferredLabel) {
        return;
      }

      const cameraSelects = doc.querySelectorAll('select');
      for (const select of cameraSelects) {
        const options = Array.from(select.options || []);
        if (!options.length) {
          continue;
        }

        const text = String(select.closest('div,td,tr,section,form')?.textContent || '').toLowerCase();
        const looksLikeCamera = text.includes('camera') || text.includes('webcam') || text.includes('dispositivo');
        if (!looksLikeCamera) {
          continue;
        }

        let match = null;
        if (preferredId) {
          match = options.find((opt) => String(opt.value || '').includes(preferredId));
        }
        if (!match && preferredLabel) {
          match = options.find((opt) => String(opt.textContent || '').toLowerCase().includes(preferredLabel));
        }

        if (!match) {
          continue;
        }

        if (select.value !== match.value) {
          select.value = match.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
    };

    // Trova il pannello pre-start: prima tenta #controls, poi cerca START MIRROR.
    const findPreStartPanel = () => {
      const ctx = findControlsContext();
      if (ctx && ctx.controls) return ctx.controls;
      const allBtns = document.querySelectorAll('button, input[type=button], input[type=submit], a');
      for (const btn of allBtns) {
        const txt = String(btn.textContent || btn.value || '').trim().toUpperCase();
        if (txt.includes('START') && txt.includes('MIRROR')) {
          return btn.closest('form, table, [id]') || btn.parentElement;
        }
      }
      return null;
    };

    // Preview live sopra il pannello con cornice sovrapposta.
    const startLivePreview = async (deviceId) => {
      const panel = findPreStartPanel();
      const rect = panel ? panel.getBoundingClientRect() : null;

      let preview = document.getElementById('ms-live-preview');
      if (!preview) {
        preview = document.createElement('div');
        preview.id = 'ms-live-preview';
        (document.body || document.documentElement).appendChild(preview);
      }

      if (rect && rect.width > 0 && rect.top > 40) {
        const h = Math.max(80, Math.round(rect.top) - 14);
        preview.style.cssText = [
          'position:fixed',
          'top:8px',
          'left:' + Math.round(rect.left) + 'px',
          'width:' + Math.round(rect.width) + 'px',
          'height:' + h + 'px',
          'z-index:2147483040',
          'background:#000',
          'overflow:hidden',
          'border-radius:12px',
          'border:2px solid rgba(255,255,255,0.7)',
          'pointer-events:none',
          'display:flex',
          'align-items:center',
          'justify-content:center'
        ].join(';');
      }

      let video = preview.querySelector('video');
      if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.setAttribute('playsinline', '');
        video.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;';
        preview.appendChild(video);
      }

      let frameOverlay = document.getElementById('ms-live-frame-overlay');
      if (!frameOverlay) {
        frameOverlay = document.createElement('img');
        frameOverlay.id = 'ms-live-frame-overlay';
        frameOverlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;z-index:2;pointer-events:none;';
        preview.appendChild(frameOverlay);
      }

      // Cerca la cornice selezionata/attiva nel pannello.
      const ctx = findControlsContext();
      if (ctx) {
        const corniciHost = findCorniciAnchor(ctx.controls);
        const searchRoot = corniciHost ? (corniciHost.closest('tr,div,td') || corniciHost) : ctx.controls;
        const imgs = Array.from(searchRoot.querySelectorAll('img'));
        let selectedImg = imgs.find((img) => {
          const p = img.parentElement;
          return p && (p.classList.contains('selected') || p.classList.contains('active') ||
            String(img.style.border || img.style.outline || '').includes('px'));
        });
        if (!selectedImg && imgs.length) selectedImg = imgs[0];
        if (selectedImg) {
          frameOverlay.src = selectedImg.src;
          frameOverlay.style.display = 'block';
        } else {
          frameOverlay.style.display = 'none';
        }
      }

      // Ferma stream precedente.
      if (video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }

      if (!deviceId) {
        preview.style.display = 'none';
        return;
      }

      preview.style.display = 'flex';

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
        video.srcObject = stream;
      } catch {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          video.srcObject = stream;
        } catch {}
      }
    };

    const ensureUsbCameraChooser = (doc) => {
      const controls = findPreStartPanel();
      if (!controls) return;

      let chooser = document.getElementById('ms-usb-camera-chooser');
      if (!chooser) {
        chooser = document.createElement('div');
        chooser.id = 'ms-usb-camera-chooser';
        chooser.innerHTML =
          '<span id="ms-usb-camera-title">Sorgente USB</span>' +
          '<select id="ms-usb-camera-select"></select>';
      }

      // Stili inline sempre aggiornati (non dipendono da CSS padre).
      chooser.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:10px',
        'padding:8px 10px',
        'background:rgba(0,0,0,0.70)',
        'border-top:1px solid rgba(255,255,255,0.25)',
        'border-bottom:1px solid rgba(255,255,255,0.15)',
        'box-sizing:border-box',
        'width:100%'
      ].join(';');

      const title = chooser.querySelector('#ms-usb-camera-title');
      if (title) title.style.cssText = 'color:#fff;font-weight:700;font-size:13px;white-space:nowrap;flex-shrink:0;';

      const select = chooser.querySelector('#ms-usb-camera-select');
      if (!select) return;
      select.style.cssText = 'flex:1;min-width:0;height:32px;padding:2px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.65);background:#fff;font-size:13px;';

      // Inserisci dopo la riga Cornici nel pannello.
      const corniciAnchor = findCorniciAnchor(controls);
      const insertAfterNode = corniciAnchor ? (corniciAnchor.closest('tr,div,td') || corniciAnchor) : null;
      const tag = insertAfterNode ? String(insertAfterNode.tagName).toUpperCase() : '';

      if (tag === 'TR') {
        // Pannello tabella: serve un wrapper TR.
        let row = document.getElementById('ms-usb-camera-row');
        if (!row) {
          row = document.createElement('tr');
          row.id = 'ms-usb-camera-row';
          const td = document.createElement('td');
          td.colSpan = 99;
          td.style.padding = '0';
          td.appendChild(chooser);
          row.appendChild(td);
        }
        if (row.previousElementSibling !== insertAfterNode) {
          insertAfterNode.parentNode.insertBefore(row, insertAfterNode.nextSibling);
        }
      } else if (insertAfterNode && insertAfterNode.parentNode) {
        if (chooser.previousElementSibling !== insertAfterNode) {
          insertAfterNode.parentNode.insertBefore(chooser, insertAfterNode.nextSibling);
        }
      } else if (!controls.contains(chooser)) {
        controls.appendChild(chooser);
      }

      const populate = async () => {
        select.innerHTML = '';
        const makeOpt = (val, txt) => {
          const o = document.createElement('option');
          o.value = val;
          o.textContent = txt;
          return o;
        };

        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
          select.appendChild(makeOpt('', 'Camere non disponibili'));
          return;
        }

        try {
          let devices = await navigator.mediaDevices.enumerateDevices();
          let cams = devices.filter((d) => d.kind === 'videoinput');

          if (!cams.length || cams.every((d) => !d.label)) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
              stream.getTracks().forEach((t) => t.stop());
              devices = await navigator.mediaDevices.enumerateDevices();
              cams = devices.filter((d) => d.kind === 'videoinput');
            } catch {}
          }

          if (!cams.length) {
            select.appendChild(makeOpt('', 'Nessuna camera trovata'));
            return;
          }

          let prevId = '';
          try { prevId = localStorage.getItem('msPreferredCameraDeviceId') || ''; } catch {}

          cams.forEach((cam, idx) => {
            const o = makeOpt(cam.deviceId || '', cam.label || ('Camera ' + (idx + 1)));
            if (prevId && o.value === prevId) o.selected = true;
            select.appendChild(o);
          });

          if (!select.value && select.options.length) select.selectedIndex = 0;

          // Avvia preview con la camera attualmente selezionata.
          if (select.value) startLivePreview(select.value);
        } catch {
          select.appendChild(makeOpt('', 'Errore lettura camere'));
        }
      };

      if (select.dataset.msBound !== '1') {
        select.dataset.msBound = '1';
        select.addEventListener('change', () => {
          const selected = select.options[select.selectedIndex];
          try {
            localStorage.setItem('msPreferredCameraDeviceId', String(select.value || ''));
            localStorage.setItem('msPreferredCameraLabel', String(selected ? selected.textContent : ''));
          } catch {}
          syncPreferredCameraToRealPanel(doc);
          startLivePreview(select.value);
        });
      }

      if (!select.options.length) populate();
    };

    const bindBottomLeftTrigger = () => {
      if (window.__msBottomLeftTriggerBound) {
        return;
      }

      window.__msBottomLeftTriggerBound = true;
      document.addEventListener('click', (event) => {
        const rawTarget = event.target;
        if (!rawTarget || typeof rawTarget.closest !== 'function') {
          return;
        }

        const target = rawTarget.closest('button, input[type=button], input[type=submit], a');
        if (!target) {
          return;
        }

        const text = String(target.textContent || target.value || '').trim().toLowerCase();
        const isCameraTrigger =
          text.includes('camera') ||
          text.includes('settings') ||
          text.includes('impostazioni');

        if (!isCameraTrigger) {
          return;
        }

        setTimeout(() => {
          const context = findControlsContext();
          if (!context) {
            return;
          }

          ensureStyles(context.doc);
          ensureCameraConfigSection(context.doc, context.controls);
          focusControlPanel(context.controls);

          const section = context.doc.getElementById('ms-camera-config-section');
          if (section) {
            section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }, 30);
      }, false);
    };

    const refresh = () => {
      const context = findControlsContext();
      if (context) {
        ensureStyles(context.doc);
        ensureCameraConfigSection(context.doc, context.controls);
        syncPreferredCameraToRealPanel(context.doc);
      }
      ensureUsbCameraChooser(context ? context.doc : document);
    };

    refresh();
    bindBottomLeftTrigger();
    setTimeout(refresh, 500);
    setTimeout(refresh, 1400);

    // Retry leggero: alcune versioni della pagina creano #controls in ritardo.
    let retryCount = 0;
    const retryId = setInterval(() => {
      retryCount += 1;
      const context = findControlsContext();
      if (context) {
        ensureStyles(context.doc);
        ensureCameraConfigSection(context.doc, context.controls);
        syncPreferredCameraToRealPanel(context.doc);
      }
      ensureUsbCameraChooser(context ? context.doc : document);

      const ready = !!(document.getElementById('ms-usb-camera-chooser') && document.getElementById('ms-usb-camera-select') && document.getElementById('ms-usb-camera-select').options.length > 0);
      if (ready || retryCount >= 40) {
        clearInterval(retryId);
      }
    }, 500);
  })();`;

  const executor = targetFrame || win.webContents;
  executor.executeJavaScript(script).catch(() => {});
}

function getTvSimulationBounds() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;
  const fitScale = Math.min(bounds.width / TV_WIDTH, bounds.height / TV_HEIGHT);
  const defaultWidth = Math.max(1, Math.floor(TV_WIDTH * fitScale));
  const defaultHeight = Math.max(1, Math.floor(TV_HEIGHT * fitScale));

  // Consenti ingrandimento fino alla dimensione logica TV reale (1200x1920).
  const maxWidth = TV_WIDTH;
  const maxHeight = TV_HEIGHT;
  const minWidth = defaultWidth;
  const minHeight = defaultHeight;

  const x = bounds.x + Math.floor((bounds.width - defaultWidth) / 2);
  const y = bounds.y + Math.floor((bounds.height - defaultHeight) / 2);

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

function enforceTvSize(win) {
  if (!win || win.isDestroyed() || isApplyingBounds) {
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
        icon: path.join(__dirname, 'favicon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadURL('https://webservice.sballando.it/mirror/index.php');
    //win.loadURL('https://webservice.sballando.it/mirror/index6.html?id=24&ver='+ver_cache);
    //win.loadFile('index.html');
    mainWindow.setMenu(null);
    enforceTvSize(mainWindow);

    mainWindow.on('enter-html-full-screen', () => enforceTvSize(mainWindow));
    mainWindow.on('maximize', () => enforceTvSize(mainWindow));
    mainWindow.on('restore', () => enforceTvSize(mainWindow));
    screen.on('display-metrics-changed', () => enforceTvSize(mainWindow));

    mainWindow.webContents.on('did-finish-load', () => {
      injectRemoteUiRedesign(mainWindow);
      injectWindowControls(mainWindow);
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

        // Inietta anche nei frame secondari: molte UI remote mettono i controlli qui.
        injectRemoteUiRedesign(mainWindow, frame);
      } catch {}
    });

    session.defaultSession.on('will-download', (event, item, webContents) => {

        var fileName_full = item.getFilename();
        var folder = fileName_full.split("§")[0];
        var fileName = fileName_full.split("§")[1];

        //const downloadPath = path.join(__dirname, 'Foto/'+folder);

        const downloadPath = path.join(getPhotoRootPath(), folder);

        item.setSavePath(path.join(downloadPath, fileName));

        const fs = require('fs');
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
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

    if (!nextState) {
      enforceTvSize(mainWindow);
    }

    return nextState;
  }

  return false;
});
ipcMain.handle('get-printers', async () => {
    return await callPrintBroker('/printers');
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
    const folder = filename_.split("§")[0];
    const filename = filename_.split("§")[1];

    const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    const downloadPath = path.join(appPath, 'Foto/'+folder);

    try {
        const filePath = path.join(downloadPath, filename);
        await fs.unlink(filePath);
        console.log(`Foto cancellata: ${filePath}`);
        return { success: true, message: `Foto ${filename} cancellata con successo` };
    } catch (error) {
        console.error(`Errore durante la cancellazione di ${filename}:`, error);
        event.reply('delete-photo-response', { success: false, message: `Errore: ${error.message}` });
    }
});

ipcMain.handle('upload-photo', async (event, filename_) => {
  console.log(`upload-photo: ${filename_}`);

  const folder = filename_.split("§")[0];
  const filename = filename_.split("§")[1];

  const downloadPath = path.join(getPhotoRootPath(), folder);

  try {
    const filePath = path.join(downloadPath, filename);
    // Verifica che il file esista
    await fs.access(filePath);

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
    const config = {
      host,
      port,
      username
    };

    if (password) {
      config.password = password;
    }

    if (privateKeyPath) {
      config.privateKey = await fs.readFile(privateKeyPath);
    }

    await sftp.connect(config);
    const remotePath = path.posix.join(remoteBasePath, folder, 'gallery', filename);
    await sftp.put(filePath, remotePath);
    await sftp.end();

    return { success: true, message: `Foto ${filename} caricata con successo su ${remotePath}` };
  } catch (error) {
    console.error(`Errore durante l'upload di ${filename}:`, error);
    return { success: false, message: `Errore: ${error.message}` };
  }
});

app.whenReady().then(createWindow);

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