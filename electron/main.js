/**
 * Anndevta POS — Electron Main Process (Offline SQLite Edition)
 *
 * Startup sequence:
 *  1. Spawn backend.exe (PyInstaller FastAPI server with SQLite)
 *  2. Poll /api/health until backend is ready
 *  3. Open BrowserWindow loading the React production build
 *  4. On quit: gracefully terminate backend
 */

const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * In production (packaged .exe), __dirname is inside the asar.
 * process.resourcesPath points to the Resources/ folder next to the .exe.
 * In development, we resolve from the repo root.
 */
const IS_PACKAGED = app.isPackaged;

function getResourcePath(...segments) {
  if (IS_PACKAGED) {
    // Packaged: binaries and React build are in process.resourcesPath (extraResources)
    return path.join(process.resourcesPath, ...segments);
  }
  // Dev: __dirname = D:\GIT\POS-system\electron\
  // React build lives in frontend\build\
  if (segments[0] === 'build') {
    return path.join(__dirname, '..', 'frontend', ...segments);
  }
  // bin/ and other resources are at repo root
  return path.join(__dirname, '..', ...segments);
}

// Log directory — stored in user's AppData so it persists between updates
const LOG_DIR = path.join(app.getPath('userData'), 'logs');

// SQLite database path — stored in user's AppData so it persists between updates
const DB_PATH = path.join(app.getPath('userData'), 'pos_data.db');

// Bundled binaries
const BACKEND_EXE = getResourcePath('bin', 'backend.exe');

// React production build (index.html)
const REACT_BUILD = getResourcePath('build', 'index.html');

// Backend API
const BACKEND_PORT = 8000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const HEALTH_URL = `${BACKEND_URL}/api/health`;

// ─── State ───────────────────────────────────────────────────────────────────

let mainWindow = null;
let backendProc = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logToFile(tag, data) {
  const logPath = path.join(LOG_DIR, 'electron.log');
  const line = `[${new Date().toISOString()}] [${tag}] ${data}\n`;
  try { fs.appendFileSync(logPath, line); } catch (_) { }
}

let backendErrorLogs = [];

function spawnSilent(exe, args, opts = {}) {
  const proc = spawn(exe, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: path.dirname(exe),
    ...opts,
  });
  proc.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    logToFile(path.basename(exe), msg);
  });
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    backendErrorLogs.push(msg);
    if (backendErrorLogs.length > 15) backendErrorLogs.shift();
    logToFile(`${path.basename(exe)}:ERR`, msg);
  });
  proc.on('error', (e) => {
    backendErrorLogs.push(e.message);
    logToFile(`${path.basename(exe)}:ERROR`, e.message);
  });
  return proc;
}

/**
 * Poll a URL until it returns HTTP 200 or timeout expires.
 * @param {string} url
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
function waitForUrl(url, timeoutMs = 60000, intervalMs = 1000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve(true);
        } else {
          res.resume();
          setTimeout(attempt, intervalMs);
        }
      });
      req.on('error', () => setTimeout(attempt, intervalMs));
      req.setTimeout(3000, () => { req.destroy(); setTimeout(attempt, intervalMs); });
    }
    attempt();
  });
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function startServices() {
  ensureDir(LOG_DIR);
  ensureDir(path.dirname(DB_PATH));

  logToFile('main', `IS_PACKAGED=${IS_PACKAGED}`);
  logToFile('main', `BACKEND_EXE=${BACKEND_EXE}`);
  logToFile('main', `REACT_BUILD=${REACT_BUILD}`);
  logToFile('main', `DB_PATH=${DB_PATH}`);

  // Kill orphaned backend processes from prior runs to ensure port 8000 is available
  if (process.platform === 'win32') {
    try {
      logToFile('main', 'Cleaning up any existing backend.exe processes...');
      await new Promise((resolve) => {
        const kill = spawn('taskkill', ['/F', '/IM', 'backend.exe'], { windowsHide: true });
        kill.on('exit', resolve);
        kill.on('error', resolve);
        setTimeout(resolve, 3000); // Safety timeout
      });
    } catch (_) { }
  }

  // Clear stale SQLite WAL lock files left by crashed previous sessions
  try {
    const walFile = DB_PATH + '-wal';
    const shmFile = DB_PATH + '-shm';
    if (fs.existsSync(walFile)) { fs.unlinkSync(walFile); logToFile('main', 'Cleared stale WAL file'); }
    if (fs.existsSync(shmFile)) { fs.unlinkSync(shmFile); logToFile('main', 'Cleared stale SHM file'); }
  } catch (e) {
    logToFile('main', `WAL cleanup warning: ${e.message}`);
  }

  // Start FastAPI backend (SQLite only — no MongoDB)
  if (!fs.existsSync(BACKEND_EXE)) {
    if (!IS_PACKAGED) {
      logToFile('main', 'backend.exe not found in dev mode — spawning python backend server...');
      const backendDir = path.join(__dirname, '..', 'backend');
      const pyCmd = process.platform === 'win32' ? 'py' : 'python3';
      backendProc = spawn(pyCmd, ['server.py'], {
        cwd: backendDir,
        env: {
          ...process.env,
          DB_PATH: DB_PATH,
          DB_NAME: 'thali_pos',
          JWT_SECRET: 'thali-pos-super-secret-key-987654321',
          ADMIN_EMAIL: 'admin@pos.com',
          ADMIN_PASSWORD: 'admin123',
          PORT: String(BACKEND_PORT),
        },
        windowsHide: true,
      });
      if (backendProc && backendProc.pid) {
        logToFile('main', `backend.py spawned PID: ${backendProc.pid}`);
        if (backendProc.stdout) {
          backendProc.stdout.on('data', (d) => logToFile('backend.py', d.toString().trim()));
        }
        if (backendProc.stderr) {
          backendProc.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            backendErrorLogs.push(msg);
            if (backendErrorLogs.length > 15) backendErrorLogs.shift();
            logToFile('backend.py:ERR', msg);
          });
        }
      }
    } else {
      logToFile('main', 'WARN: backend.exe not found — assuming external backend is running');
    }
  } else {
    logToFile('main', 'Starting backend.exe...');
    backendProc = spawnSilent(BACKEND_EXE, [], {
      env: {
        ...process.env,
        DB_PATH: DB_PATH,
        DB_NAME: 'thali_pos',
        JWT_SECRET: 'thali-pos-super-secret-key-987654321',
        ADMIN_EMAIL: 'admin@pos.com',
        ADMIN_PASSWORD: 'admin123',
        PORT: String(BACKEND_PORT),
      },
    });
    logToFile('main', `backend PID: ${backendProc.pid}`);
  }

  // Wait for backend to be ready
  logToFile('main', `Waiting for backend at ${HEALTH_URL}...`);
  const ready = await waitForUrl(HEALTH_URL, 90000, 1000);
  if (!ready) {
    logToFile('main', 'ERROR: Backend did not become ready in time');
    const errorDetails = backendErrorLogs.join('\n') || 'Backend server failed to bind or initialize database.';
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Anndevta POS — Startup Error',
      message: 'The backend server failed to start.',
      detail: `Details:\n${errorDetails}\n\nCheck full logs at:\n${LOG_DIR}\n\nDo you want to open the log folder?`,
      buttons: ['Open Logs', 'Quit'],
    });
    if (choice === 0) shell.openPath(LOG_DIR);
    app.quit();
    return false;
  }
  logToFile('main', 'Backend is ready!');
  return true;
}

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Anndevta POS',
    icon: IS_PACKAGED ? path.join(__dirname, 'icon.ico') : path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow file:// → http://127.0.0.1 XHR (needed for packaged mode)
      webSecurity: true,
    },
    backgroundColor: '#0f172a',
    show: false, // show after content loads
  });

  // In dev mode load React dev server; in production load the built index.html
  if (!IS_PACKAGED && process.env.ELECTRON_DEV) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(REACT_BUILD);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

function killProcess(proc, name) {
  if (!proc) return;
  try {
    logToFile('main', `Terminating ${name} (PID ${proc.pid})...`);
    if (process.platform === 'win32') {
      // Use taskkill to kill the process and all its children recursively and forcibly.
      // This is crucial to prevent zombie PyInstaller backend processes on Windows.
      spawn('taskkill', ['/F', '/T', '/PID', proc.pid.toString()]);
    } else {
      process.kill(proc.pid, 'SIGTERM');
    }
  } catch (e) {
    logToFile('main', `Failed to kill ${name}: ${e.message}`);
  }
}

function shutdownServices() {
  killProcess(backendProc, 'backend');
}

// ─── IPC Handlers for Authentication Persistence ────────────────────────────
function getSessionFilePath() {
  const userDataDir = app.getPath('userData');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  return path.join(userDataDir, 'session.json');
}

function readSession() {
  const sessionFile = getSessionFilePath();
  try {
    if (fs.existsSync(sessionFile)) {
      const data = fs.readFileSync(sessionFile, 'utf8');
      if (!data || data.trim() === '') {
        logToFile('main', 'Session file is empty');
        return {};
      }
      return JSON.parse(data);
    }
  } catch (e) {
    logToFile('main', `Failed to read session file: ${e.message}. Resetting...`);
    try { fs.writeFileSync(sessionFile, '{}', 'utf8'); } catch (_) { }
  }
  return {};
}

function writeSession(session) {
  const sessionFile = getSessionFilePath();
  try {
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf8');
  } catch (e) {
    logToFile('main', `Failed to write session file: ${e.message}`);
  }
}

ipcMain.on('log-from-renderer', (event, { tag, message }) => {
  logToFile(`renderer:${tag}`, message);
});

ipcMain.handle('set-auth-data', (event, { key, value }) => {
  logToFile('ipc', `set-auth-data for key: ${key}`);
  const session = readSession();
  session[key] = value;
  writeSession(session);
  return true;
});

ipcMain.handle('get-auth-data', (event, { key }) => {
  logToFile('ipc', `get-auth-data for key: ${key}`);
  const session = readSession();
  const val = session[key] || null;
  logToFile('ipc', `get-auth-data result for ${key}: ${val ? 'found' : 'not found'}`);
  return val;
});

ipcMain.handle('delete-auth-data', (event, { key }) => {
  logToFile('ipc', `delete-auth-data for key: ${key}`);
  const session = readSession();
  delete session[key];
  writeSession(session);
  return true;
});

ipcMain.handle('clear-auth-data', () => {
  logToFile('ipc', 'clear-auth-data');
  const sessionFile = getSessionFilePath();
  try {
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
  } catch (e) {
    logToFile('main', `Failed to delete session file: ${e.message}`);
  }
  return true;
});


ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('open-logs', () => {
  shell.openPath(LOG_DIR);
  return true;
});

// ─── Printer IPC Handlers for Thermal Paper Cutting ───────────────────────────
async function resolvePrinter(requestedName) {
  if (!mainWindow) return { error: "Main window is not available." };
  let list = [];
  try {
    list = await mainWindow.webContents.getPrintersAsync();
    logToFile('main', `getPrintersAsync found ${list.length} printer(s): ${JSON.stringify(list.map(p => ({ name: p.name, isDefault: p.isDefault })))}`);
  } catch (e) {
    logToFile('main', `Failed to get printers: ${e.message}`);
    return { error: `Failed to detect installed printers: ${e.message}` };
  }

  if (!list || list.length === 0) {
    logToFile('main', 'No installed printers found on system.');
    return { error: "No installed printer found on system. Please connect a thermal printer." };
  }

  const cleanName = (requestedName || "").trim();
  const isSystemDefaultReq = !cleanName || cleanName === "system_default" || cleanName.toLowerCase() === "system default";

  if (isSystemDefaultReq) {
    const defaultP = list.find(p => p.isDefault);
    const chosen = defaultP ? defaultP.name : list[0].name;
    logToFile('main', `Resolved 'system_default' to printer: '${chosen}'`);
    return { printerName: chosen, isDefault: true };
  }

  const exact = list.find(p => p.name === cleanName);
  if (exact) {
    logToFile('main', `Resolved exact printer match: '${exact.name}'`);
    return { printerName: exact.name, isDefault: exact.isDefault };
  }

  const ci = list.find(p => p.name.trim().toLowerCase() === cleanName.toLowerCase());
  if (ci) {
    logToFile('main', `Resolved case-insensitive printer match: '${ci.name}'`);
    return { printerName: ci.name, isDefault: ci.isDefault };
  }

  // If specified printer not found, fallback to system default
  const defaultP = list.find(p => p.isDefault);
  const fallback = defaultP ? defaultP.name : list[0].name;
  logToFile('main', `Requested printer '${cleanName}' not found in list. Falling back to '${fallback}'`);
  return {
    printerName: fallback,
    isDefault: !!defaultP,
    warning: `Selected printer '${cleanName}' was not found. Using '${fallback}' instead.`
  };
}

function printHtmlWindow(html, targetDevice, paperWidth = 80) {
  return new Promise((resolve) => {
    // Strip any scripts that might call window.print or window.close
    const cleanHtml = (html || '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    const printWin = new BrowserWindow({
      show: false,
      width: 400,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });

    let didFinish = false;
    let timer = null;

    const cleanup = () => {
      if (didFinish) return;
      didFinish = true;
      if (timer) clearTimeout(timer);
      try {
        if (printWin && !printWin.isDestroyed()) {
          printWin.destroy();
        }
      } catch (_) {}
    };

    timer = setTimeout(() => {
      if (!didFinish) {
        logToFile('main', `Print job timed out for device: '${targetDevice}'`);
        cleanup();
        resolve({ success: false, error: "Print job timed out." });
      }
    }, 15000);

    printWin.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (didFinish || !printWin || printWin.isDestroyed()) return;

        const is58 = Number(paperWidth) === 58;
        const widthMicrons = is58 ? 58000 : 80000;

        const printOptions = {
          silent: true,
          printBackground: true,
          color: false,
          margins: { marginType: 'none' },
          pageSize: {
            width: widthMicrons,
            height: 300000,
          },
          scaleFactor: 100,
        };

        if (targetDevice && targetDevice !== "system_default" && targetDevice !== "System Default") {
          printOptions.deviceName = targetDevice;
        }

        logToFile('main', `Sending print to deviceName: '${printOptions.deviceName || "System Default"}' with width: ${is58 ? "58mm" : "80mm"}`);

        printWin.webContents.print(printOptions, (success, failureReason) => {
          logToFile('main', `print result: success=${success}, reason=${failureReason}`);
          cleanup();
          if (success) {
            resolve({ success: true, printerName: targetDevice || "System Default" });
          } else {
            resolve({
              success: false,
              error: failureReason || "Print job failed. Please check printer connection or driver.",
              printerName: targetDevice,
            });
          }
        });
      }, 250);
    });

    printWin.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
      logToFile('main', `Failed to load print template: ${errorDescription}`);
      cleanup();
      resolve({ success: false, error: `Failed to load print template: ${errorDescription}` });
    });

    printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cleanHtml)}`);
  });
}


ipcMain.handle('printer:get-printers', async () => {
  if (!mainWindow) return [];
  try {
    const list = await mainWindow.webContents.getPrintersAsync();
    return list.map(p => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
      status: p.status
    }));
  } catch (e) {
    logToFile('main', `Failed to get printers: ${e.message}`);
    return [];
  }
});

ipcMain.handle('printer:print', async (event, { html, printerName, paperWidth }) => {
  const resolution = await resolvePrinter(printerName);
  if (resolution.error) {
    return { success: false, error: resolution.error };
  }
  return await printHtmlWindow(html, resolution.printerName, paperWidth);
});

ipcMain.handle('printer:print-parcel', async (event, { kitchenHTML, customerHTML, printerName, paperWidth }) => {
  const resolution = await resolvePrinter(printerName);
  if (resolution.error) {
    return { success: false, error: resolution.error };
  }

  const targetDevice = resolution.printerName;

  const res1 = await printHtmlWindow(kitchenHTML, targetDevice, paperWidth);
  if (!res1.success) {
    return { success: false, error: `Kitchen coupon print failed: ${res1.error}` };
  }

  await new Promise(r => setTimeout(r, 600));

  const res2 = await printHtmlWindow(customerHTML, targetDevice, paperWidth);
  if (!res2.success) {
    return { success: false, error: `Customer receipt print failed: ${res2.error}` };
  }

  return { success: true, printerName: targetDevice };
});

ipcMain.handle('printer:test-print', async (event, { printerName, paperWidth }) => {
  const resolution = await resolvePrinter(printerName);
  if (resolution.error) {
    return { success: false, error: resolution.error };
  }

  const targetDevice = resolution.printerName;
  const is58 = Number(paperWidth) === 58;
  const widthStr = is58 ? "58mm" : "80mm";
  const printableWidth = is58 ? "48mm" : "72mm";
  const testHTML = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Test Print</title>
<style>
  @page { size: ${widthStr} auto; margin: 0mm; }
  * { box-sizing: border-box !important; margin: 0; padding: 0; }
  html, body { width: 100%; max-width: ${printableWidth}; margin: 0; padding: 0; background: #fff; color: #000; font-family: 'Segoe UI', Arial, monospace; font-size: 12px; line-height: 1.35; }
  .test-wrap { width: ${printableWidth}; max-width: ${printableWidth}; margin: 0; padding: 2mm 1.5mm 4mm 1.5mm; text-align: center; overflow: hidden; }
  .receipt-row-table { width: 100% !important; table-layout: fixed !important; border-collapse: collapse !important; }
  .cut-line { border-top: 1.5px dashed #000; margin: 4px 0; }
  .paper-feed-end { height: 35px; }
</style></head>
<body>
  <div class="test-wrap">
    <h3 style="margin:0 0 3px 0; font-size: 15px; font-weight: 800;">ANNDEVTA POS</h3>
    <p style="margin:2px 0; font-weight: bold; font-size: 12px;">*** TEST PRINT SUCCESSFUL ***</p>
    <div class="cut-line"></div>
    <table class="receipt-row-table" style="font-size:11.5px; margin:2px 0;">
      <tr>
        <td style="width:46%; text-align:left; padding:1.5px 0;">Printer:</td>
        <td style="width:54%; text-align:right; font-weight:bold; padding:1.5px 1px 1.5px 0; white-space:nowrap;">${targetDevice}</td>
      </tr>
      <tr>
        <td style="width:46%; text-align:left; padding:1.5px 0;">Paper Width:</td>
        <td style="width:54%; text-align:right; padding:1.5px 1px 1.5px 0; white-space:nowrap;">${widthStr} (${is58 ? "2 Inch" : "3 Inch"})</td>
      </tr>
      <tr>
        <td style="width:46%; text-align:left; padding:1.5px 0;">Sample Total:</td>
        <td style="width:54%; text-align:right; font-weight:800; font-size:14px; padding:1.5px 1px 1.5px 0; white-space:nowrap;">₹189.00</td>
      </tr>
    </table>
    <div class="cut-line"></div>
    <p style="margin:3px 0; font-size:11px;">RetSol RTP-80 Ready (72mm Active Width)</p>
    <div class="paper-feed-end"></div>
  </div>
</body></html>`;

  return await printHtmlWindow(testHTML, targetDevice, paperWidth);
});


// ─── App lifecycle ───────────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Show a loading splash via a small window while services start
    const splash = new BrowserWindow({
      width: 480,
      height: 300,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { nodeIntegration: false },
    });
    splash.loadFile(path.join(__dirname, 'splash.html'));
    splash.center();

    const ok = await startServices();
    if (!ok) return;

    createWindow();
    splash.destroy();
  });
}

app.on('before-quit', shutdownServices);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
