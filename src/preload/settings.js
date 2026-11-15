const { contextBridge, ipcRenderer } = require('electron');

const MAX_COOKIE_INPUT_LENGTH = 65536;

function isSettingsOrigin() {
  try {
    return (
      window.location.origin === 'ytmc-app://local' &&
      window.location.pathname.toLowerCase() === '/settings.html'
    );
  } catch {
    return false;
  }
}

function subscribeChannel(channel, cb, transform = null) {
  if (typeof cb !== 'function') {
    throw new TypeError('Callback must be a function');
  }
  const handler = (_event, payload) => {
    cb(transform ? transform(payload) : payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

let exposed = false;
if (isSettingsOrigin() && !exposed) {
  exposed = true;
  let cachedBootstrap = null;
  try {
    const raw = ipcRenderer.sendSync('preload:bootstrap-sync');
    if (raw && typeof raw === 'object') {
      cachedBootstrap = {
        locale: typeof raw.locale === 'string' ? raw.locale : '',
        translations:
          raw.translations && typeof raw.translations === 'object' ? raw.translations : {},
      };
    }
  } catch {
    cachedBootstrap = { locale: '', translations: {} };
  }

  contextBridge.exposeInMainWorld('settingsAPI', {
    getBootstrap: () =>
      cachedBootstrap || { locale: navigator.language || '', translations: {} },
    getSettings: () => ipcRenderer.invoke('settings:get'),
    updateSettings: (partial) => {
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        return ipcRenderer.invoke('settings:get');
      }
      return ipcRenderer.invoke('settings:update', partial);
    },
    resetStats: () => ipcRenderer.invoke('settings:reset-stats'),
    clearGoogleAuth: () => ipcRenderer.invoke('auth:clear-cookies'),
    openExternalYtm: () => ipcRenderer.send('auth:open-external-ytm'),
    importCookies: (raw) => {
      if (typeof raw !== 'string') {
        return Promise.resolve({ ok: false, error: 'Invalid cookie input.' });
      }
      if (raw.length > MAX_COOKIE_INPUT_LENGTH) {
        return Promise.resolve({ ok: false, error: 'Cookie input exceeds maximum allowed size.' });
      }
      return ipcRenderer.invoke('auth:import-cookies', raw);
    },
    close: () => ipcRenderer.send('settings:close'),
    onInitTab: (cb) =>
      subscribeChannel('settings:init-tab', cb, (tab) => (tab === 'auth' ? 'auth' : 'general')),
    onSettingsUpdated: (cb) => subscribeChannel('settings:updated', cb),
    onStatsUpdated: (cb) => subscribeChannel('stats:updated', cb),
  });
}
