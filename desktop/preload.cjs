const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('astralDesktop', {
  computer: Object.fromEntries(
    ['status', 'pair', 'start', 'stop', 'grant'].map((method) => [
      method,
      (value) => ipcRenderer.invoke('astral:computer:' + method, value),
    ]),
  ),
  openMailLink: (url) => ipcRenderer.invoke('astral:mail:open-link', url),
  updates: {
    status: () => ipcRenderer.invoke('astral:updates:status'),
    platform: () => ipcRenderer.invoke('astral:updates:platform'),
    download: (value) => ipcRenderer.invoke('astral:updates:download', value),
    cancel: () => ipcRenderer.invoke('astral:updates:cancel'),
    install: () => ipcRenderer.invoke('astral:updates:install'),
    onProgress: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('astral:updates:progress', handler);
      return () => ipcRenderer.removeListener('astral:updates:progress', handler);
    },
  },
  notifications: {
    supported: () => ipcRenderer.invoke('astral:notifications:supported'),
    show: (notice) => ipcRenderer.invoke('astral:notifications:show', notice),
    onClick: (callback) => {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('astral:notification:click', handler);
      return () => ipcRenderer.removeListener('astral:notification:click', handler);
    },
  },
});
