const { contextBridge, ipcRenderer } = require('electron');
const { resolveLanguage, getTranslations } = require('../shared/i18n');

let cachedLanguageSetting = 'auto';

async function loadLanguageSetting() {
  try {
    const cfg = await ipcRenderer.invoke('settings:get');
    if (cfg && cfg.language) {
      cachedLanguageSetting = cfg.language;
    }
  } catch {
    // Ignore if settings IPC is unavailable
  }
  return cachedLanguageSetting;
}

function enrichInfo(rawInfo) {
  const info = rawInfo && typeof rawInfo === 'object' ? rawInfo : {};
  const lang = resolveLanguage(
    info.language || cachedLanguageSetting,
    info.locale || navigator.language || ''
  );
  const t = getTranslations(lang);
  return {
    errorCode: info.errorCode ?? '',
    errorDescription: info.errorDescription || '',
    validatedURL: info.validatedURL || '',
    locale: info.locale || navigator.language || '',
    lang,
    strings: t.offline,
  };
}

if (!window.__ytmcOfflineApiExposed) {
  window.__ytmcOfflineApiExposed = true;
  loadLanguageSetting();

  contextBridge.exposeInMainWorld('offlineAPI', {
    onInfo: (cb) => {
      ipcRenderer.on('offline:info', async (_event, rawInfo) => {
        await loadLanguageSetting();
        cb(enrichInfo(rawInfo));
      });
    },
    getInfo: async () => {
      const [rawInfo] = await Promise.all([
        ipcRenderer.invoke('offline:get-info').catch(() => ({})),
        loadLanguageSetting(),
      ]);
      return enrichInfo(rawInfo);
    },
    retryLoad: () => {
      ipcRenderer.send('ui:retry-load');
    },
  });
}
