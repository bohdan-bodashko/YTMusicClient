const { ipcRenderer, webFrame } = require('electron');

(function bootstrapAuthPopupPreload() {
  let isHttps = false;
  let hostname = '';
  try {
    isHttps = window.location.protocol === 'https:';
    hostname = window.location.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return;
  }
  if (!isHttps || !hostname) return;

  let bootstrap = null;
  try {
    bootstrap = ipcRenderer.sendSync('preload:bootstrap-sync');
  } catch {
    return;
  }
  if (!bootstrap || typeof bootstrap !== 'object') return;

  const authHosts = new Set(Array.isArray(bootstrap.authHosts) ? bootstrap.authHosts : []);
  const isMusicHost = hostname === 'music.youtube.com';
  const isAuthPage = authHosts.has(hostname);

  if ((!isMusicHost && !isAuthPage) || !bootstrap.authPatcherCode || !bootstrap.authEnv) {
    return;
  }

  const effectiveMode = isAuthPage ? bootstrap.authEnv.mode || 'chrome' : 'chrome';
  const payload = JSON.stringify({
    mode: effectiveMode,
    chromeMajor: bootstrap.authEnv.chromeMajor,
    chromeUa: bootstrap.authEnv.chromeUa,
    firefoxUa: bootstrap.authEnv.firefoxUa,
  });

  webFrame.executeJavaScript(`(${bootstrap.authPatcherCode})(${payload});`).catch((err) => {
    console.error('[AuthPreload] Auth patcher failed:', err);
  });
})();
