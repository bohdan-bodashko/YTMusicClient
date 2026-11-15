const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniPlayerAPI', {
  onStateUpdate: (cb) => ipcRenderer.on('miniplayer:state', (_e, data) => cb(data)),
  onTimeUpdate: (cb) => ipcRenderer.on('miniplayer:time', (_e, time) => cb(time)),
  onThemeUpdate: (cb) => ipcRenderer.on('miniplayer:theme', (_e, theme) => cb(theme)),
  sendCommand: (command) => ipcRenderer.send('miniplayer:command', command),
  seek: (time) => ipcRenderer.send('miniplayer:seek', time),
  setVolume: (volume) => ipcRenderer.send('miniplayer:volume', volume),
  togglePin: () => ipcRenderer.invoke('miniplayer:toggle-pin'),
  openMainWindow: () => ipcRenderer.send('miniplayer:open-main'),
  close: () => ipcRenderer.send('miniplayer:close'),
});
