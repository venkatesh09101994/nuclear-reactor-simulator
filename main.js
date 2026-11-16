'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const MAX_SAVE_BYTES = 2 * 1024 * 1024;

let mainWindow = null;
let saveFile = null;
let windowStateFile = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to write', file, error);
    return false;
  }
}

function loadWindowState() {
  const saved = readJson(windowStateFile, {});
  const state = { bounds: {}, maximized: false, ...saved };
  if (!state.bounds || typeof state.bounds !== 'object') state.bounds = {};
  return state;
}

function createWindow() {
  const saved = loadWindowState();
  const bounds = saved.bounds || {};

  mainWindow = new BrowserWindow({
    width: Number.isFinite(bounds.width) ? bounds.width : 1360,
    height: Number.isFinite(bounds.height) ? bounds.height : 900,
    x: Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: Number.isFinite(bounds.y) ? bounds.y : undefined,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#060a12',
    title: 'PWR-9 · Nuclear Reactor Simulator',
    icon: path.join(ROOT, 'icon.ico'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: true
    }
  });

  if (saved.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(ROOT, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  const sendMaximized = (value) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', value);
    }
  };
  mainWindow.on('maximize', () => sendMaximized(true));
  mainWindow.on('unmaximize', () => sendMaximized(false));

  mainWindow.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const next = {
      maximized,
      bounds: maximized ? loadWindowState().bounds : mainWindow.getNormalBounds()
    };
    writeJson(windowStateFile, next);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Keep the renderer locked to the local bundle.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    saveFile = path.join(app.getPath('userData'), 'savegame.json');
    windowStateFile = path.join(app.getPath('userData'), 'window-state.json');

    ipcMain.handle('window:minimize', () => {
      if (mainWindow) mainWindow.minimize();
      return true;
    });

    ipcMain.handle('window:toggle-maximize', () => {
      if (!mainWindow) return false;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      return mainWindow.isMaximized();
    });

    ipcMain.handle('window:close', () => {
      if (mainWindow) mainWindow.close();
      return true;
    });

    ipcMain.handle('window:is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()));

    ipcMain.handle('store:save', (_event, payload) => {
      let serialized;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        return { ok: false, error: 'Save data is not serializable.' };
      }
      if (typeof serialized !== 'string' || serialized.length > MAX_SAVE_BYTES) {
        return { ok: false, error: 'Save data is too large.' };
      }
      return { ok: writeJson(saveFile, payload) };
    });

    ipcMain.handle('store:load', () => readJson(saveFile, null));

    ipcMain.handle('store:clear', () => {
      try {
        fs.rmSync(saveFile, { force: true });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    });

    ipcMain.handle('app:info', () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform
    }));

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
