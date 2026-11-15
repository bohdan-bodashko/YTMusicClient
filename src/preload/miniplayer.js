const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_COMMANDS = new Set(['toggle', 'play', 'pause', 'next', 'previous', 'stop']);
const MAX_SEEK_SECONDS = 864000;

function isMiniPlayerOrigin() {
  try {
    return (
      window.location.origin === 'ytmc-app://local' &&
      window.location.pathname.toLowerCase() === '/miniplayer.html'
    );
  } catch {
    return false;
  }
}

function subscribeChannel(channel, cb) {
  if (typeof cb !== 'function') {
    throw new TypeError('Callback must be a function');
  }
  const handler = (_event, payload) => {
    cb(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

let exposed = false;
if (isMiniPlayerOrigin() && !exposed) {
  exposed = true;
  contextBridge.exposeInMainWorld('miniPlayerAPI', {
    onStateUpdate: (cb) => subscribeChannel('miniplayer:state', cb),
    onTimeUpdate: (cb) => subscribeChannel('miniplayer:time', cb),
    onThemeUpdate: (cb) => subscribeChannel('miniplayer:theme', cb),
    sendCommand: (command) => {
      if (typeof command === 'string' && ALLOWED_COMMANDS.has(command)) {
        ipcRenderer.send('miniplayer:command', command);
      }
    },
    seek: (time) => {
      if (typeof time === 'number' && Number.isFinite(time) && time >= 0) {
        ipcRenderer.send('miniplayer:seek', Math.min(MAX_SEEK_SECONDS, time));
      }
    },
    setVolume: (volume) => {
      if (typeof volume === 'number' && Number.isFinite(volume)) {
        const clamped = Math.min(1, Math.max(0, volume));
        ipcRenderer.send('miniplayer:volume', clamped);
      }
    },
    togglePin: () => ipcRenderer.invoke('miniplayer:toggle-pin'),
    openMainWindow: () => ipcRenderer.send('miniplayer:open-main'),
    close: () => ipcRenderer.send('miniplayer:close'),
  });
}
