'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, audited bridge between the sandboxed renderer and the main process.
 * Nothing here exposes Node, the filesystem, or arbitrary IPC channels.
 */
contextBridge.exposeInMainWorld('desktop', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximized: (callback) => {
      const handler = (_event, value) => {
        try {
          callback(Boolean(value));
        } catch (error) {
          console.error(error);
        }
      };
      ipcRenderer.on('window:maximized', handler);
      return () => ipcRenderer.removeListener('window:maximized', handler);
    }
  },
  store: {
    save: (state) => ipcRenderer.invoke('store:save', state),
    load: () => ipcRenderer.invoke('store:load'),
    clear: () => ipcRenderer.invoke('store:clear')
  },
  app: {
    info: () => ipcRenderer.invoke('app:info')
  }
});
