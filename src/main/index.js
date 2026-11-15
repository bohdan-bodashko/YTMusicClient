const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
} = require('electron');

const { SettingsManager } = require('./settings');
const { setupNetworkAdBlocker } = require('./adblocker');
const { SponsorBlockService } = require('./sponsorblock');
const lyricsModule = require('./lyrics');
const { LyricsAndArtworkService } = lyricsModule;
const { ShortcutManager } = require('./shortcuts');
const { TrayManager } = require('./tray');
const { MiniPlayerManager } = require('./miniplayer');
const { SettingsWindowManager } = require('./settings-window');
const { TRANSLATIONS, resolveLanguage, getTranslations } = require('../shared/i18n');
const { AUTH_HOSTS, isAuthHost, matchesDomain } = require('../shared/auth-hosts');
const {
  getChromeMajor,
  getCleanChromeUserAgent,
  getFirefoxUserAgent,
  setupAuthHeaders,
  clearGoogleAuthCookies,
  importBrowserCookies,
} = require('./auth');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ytmc-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
    },
  },
]);

const YTMUSIC_URL = 'https://music.youtube.com/';
const OFFLINE_HTML_URL = 'ytmc-app://local/offline.html';
const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer');
const AUTH_PATCHER_PATH = path.resolve(__dirname, '..', 'preload', 'auth-patcher.js');
const PAGE_PATCHER_PATH = path.resolve(__dirname, '..', 'preload', 'page-patcher.js');

const ALLOWED_APP_ASSETS = new Map([
  ['/miniplayer.html', { file: 'miniplayer.html', mime: 'text/html; charset=utf-8' }],
  ['/miniplayer.css', { file: 'miniplayer.css', mime: 'text/css; charset=utf-8' }],
  ['/miniplayer.js', { file: 'miniplayer.js', mime: 'text/javascript; charset=utf-8' }],
  ['/offline.html', { file: 'offline.html', mime: 'text/html; charset=utf-8' }],
  ['/offline.css', { file: 'offline.css', mime: 'text/css; charset=utf-8' }],
  ['/offline.js', { file: 'offline.js', mime: 'text/javascript; charset=utf-8' }],
  ['/settings.html', { file: 'settings.html', mime: 'text/html; charset=utf-8' }],
  ['/settings.css', { file: 'settings.css', mime: 'text/css; charset=utf-8' }],
  ['/settings.js', { file: 'settings.js', mime: 'text/javascript; charset=utf-8' }],
]);

const MAIN_MUSIC_PERMISSIONS = new Set([
  'mediaKeySystem',
  'fullscreen',
  'notifications',
  'clipboard-sanitized-write',
  'storage-access',
  'top-level-storage-access',
  'speaker-selection',
]);

const AUTH_HOST_PERMISSIONS = new Set(['storage-access', 'top-level-storage-access']);

const ALLOWED_PLAYER_COMMANDS = new Set([
  'toggle',
  'play',
  'pause',
  'next',
  'previous',
  'stop',
]);

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,20}$/;
const DATA_IMAGE_BASE64_REGEX =
  /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i;
const MAX_COOKIE_HEADER_LENGTH = 65536;
const MAX_EXTERNAL_OPEN_INTERVAL_MS = 1000;

let mainWindow = null;
let settings = null;
let sponsorBlock = null;
let lyricsService = null;
let shortcuts = null;
let trayManager = null;
let miniPlayer = null;
let settingsWindow = null;
let isQuitting = false;
let currentIsPlaying = false;
let thumbarIcons = null;
let lastThumbarKey = '';
let latestArtworkSeq = 0;
let latestArtworkUrl = '';
let lastFailedUrl = YTMUSIC_URL;
let lastOfflineInfo = null;
let isShowingOffline = false;
let trayStatsTimer = null;
let lastCrashRecoverAt = 0;
let lastExternalOpenAt = 0;
let externalPromptOpen = false;
let cachedAuthPatcherCode = '';
let cachedPagePatcherCode = '';

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
  isQuitting = true;
  try {
    if (settings) settings.flush();
  } catch {
    // Ignore settings flush error during fatal shutdown
  }
  app.exit(1);
});

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.userAgentFallback = getCleanChromeUserAgent();

const isSmokeTest = process.argv.includes('--smoke-test');
let smokeTempUserData = null;
if (isSmokeTest) {
  smokeTempUserData = fs.mkdtempSync(path.join(app.getPath('temp'), 'ytmc-smoke-'));
  app.setPath('userData', smokeTempUserData);
}

const gotTheLock = isSmokeTest ? true : app.requestSingleInstanceLock();

function loadPatcherScripts() {
  cachedAuthPatcherCode = fs.readFileSync(AUTH_PATCHER_PATH, 'utf8');
  cachedPagePatcherCode = fs.readFileSync(PAGE_PATCHER_PATH, 'utf8');
}

function getT() {
  const langSetting = settings ? settings.get('language') : 'auto';
  const lang = resolveLanguage(langSetting, app.getLocale());
  return getTranslations(lang);
}

function sanitizeControlChars(value, maxLen = 300) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function parseHttpsOriginHost(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return '';
    }
    return parsed.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

function isExactAppUrl(rawUrl, expectedPathname) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'ytmc-app:' &&
      parsed.hostname.toLowerCase() === 'local' &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname.toLowerCase() === expectedPathname
    );
  } catch {
    return false;
  }
}

function checkAllowedArtworkUrl(rawUrl) {
  if (typeof lyricsModule.isAllowedArtworkUrl === 'function') {
    return lyricsModule.isAllowedArtworkUrl(rawUrl);
  }
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    return false;
  }
  const host = parseHttpsOriginHost(rawUrl);
  if (!host || net.isIP(host) !== 0) return false;
  return (
    matchesDomain(host, 'googleusercontent.com') ||
    matchesDomain(host, 'ggpht.com') ||
    matchesDomain(host, 'ytimg.com')
  );
}

function sendPlayerCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:command', command);
  }
}

function isOfflineUrl(rawUrl) {
  return isExactAppUrl(rawUrl, '/offline.html');
}

function matchesPathSegmentPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isAllowedNavigationUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (isOfflineUrl(rawUrl)) return true;
  const host = parseHttpsOriginHost(rawUrl);
  if (!host) return false;
  if (host === 'music.youtube.com' || isAuthHost(host)) return true;
  if (host === 'www.youtube.com' || host === 'youtube.com') {
    try {
      const { pathname } = new URL(rawUrl);
      return (
        matchesPathSegmentPrefix(pathname, '/signin') ||
        matchesPathSegmentPrefix(pathname, '/logout') ||
        matchesPathSegmentPrefix(pathname, '/accounts') ||
        matchesPathSegmentPrefix(pathname, '/oops')
      );
    } catch {
      return false;
    }
  }
  return false;
}

function isAllowedSubframeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (rawUrl === 'about:blank' || rawUrl === 'about:srcdoc') return true;
  const host = parseHttpsOriginHost(rawUrl);
  if (!host) return false;
  return (
    isAuthHost(host) ||
    matchesDomain(host, 'youtube.com') ||
    matchesDomain(host, 'youtube-nocookie.com') ||
    matchesDomain(host, 'google.com') ||
    matchesDomain(host, 'gstatic.com') ||
    matchesDomain(host, 'googleapis.com')
  );
}

function isTrustedExternalHost(host) {
  return (
    matchesDomain(host, 'youtube.com') ||
    matchesDomain(host, 'youtu.be') ||
    matchesDomain(host, 'google.com')
  );
}

async function openExternalSafe(rawUrl, { confirm = true } = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return;
  }

  const now = Date.now();
  if (now - lastExternalOpenAt < MAX_EXTERNAL_OPEN_INTERVAL_MS) {
    return;
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return;

  if (!confirm || isTrustedExternalHost(host)) {
    lastExternalOpenAt = now;
    shell.openExternal(parsed.href).catch((err) => {
      console.warn('[External] Failed to open URL:', err?.message || err);
    });
    return;
  }

  if (externalPromptOpen) return;
  externalPromptOpen = true;
  try {
    const ext = getT().externalLink || {
      title: 'Open external link?',
      message: 'YouTube Music Client wants to open an external URL in your browser:',
      openBtn: 'Open',
      cancelBtn: 'Cancel',
    };
    const parent =
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
    const dialogOpts = {
      type: 'question',
      title: ext.title,
      message: ext.message,
      detail: parsed.href.slice(0, 512),
      buttons: [ext.openBtn, ext.cancelBtn],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, dialogOpts)
      : await dialog.showMessageBox(dialogOpts);
    if (response === 0) {
      lastExternalOpenAt = Date.now();
      await shell.openExternal(parsed.href).catch((err) => {
        console.warn('[External] Failed to open URL:', err?.message || err);
      });
    }
  } catch (err) {
    console.warn('[External] Prompt failed:', err?.message || err);
  } finally {
    externalPromptOpen = false;
  }
}

function buildPopupOptions() {
  return {
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'auth.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  };
}

function attachNavigationGuards(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    const host = parseHttpsOriginHost(url);
    if (host && (host === 'music.youtube.com' || isAuthHost(host))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: buildPopupOptions(),
      };
    }
    void openExternalSafe(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (details) => {
    if (isAllowedNavigationUrl(details.url)) return;
    details.preventDefault();
    void openExternalSafe(details.url);
  });

  webContents.on('will-redirect', (details) => {
    if (details.isMainFrame !== false) {
      if (isAllowedNavigationUrl(details.url)) return;
      details.preventDefault();
      return;
    }
    if (!isAllowedSubframeUrl(details.url)) {
      details.preventDefault();
    }
  });

  webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    if (!isAllowedSubframeUrl(details.url)) {
      details.preventDefault();
    }
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function registerAppProtocolOnSession(targetSession) {
  targetSession.protocol.handle('ytmc-app', async (request) => {
    const notFound = () =>
      new Response('Not Found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      });

    if (!request || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return notFound();
    }

    let parsed;
    try {
      parsed = new URL(request.url);
    } catch {
      return notFound();
    }

    if (
      parsed.protocol !== 'ytmc-app:' ||
      parsed.hostname.toLowerCase() !== 'local' ||
      parsed.port ||
      parsed.username ||
      parsed.password
    ) {
      return notFound();
    }

    const entry = ALLOWED_APP_ASSETS.get(parsed.pathname.toLowerCase());
    if (!entry) {
      return notFound();
    }

    const filePath = path.resolve(RENDERER_DIR, entry.file);
    if (!filePath.startsWith(`${RENDERER_DIR}${path.sep}`)) {
      return notFound();
    }

    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(request.method === 'HEAD' ? null : data, {
        status: 200,
        headers: {
          'Content-Type': entry.mime,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return notFound();
    }
  });
}

function getThumbarIcons() {
  if (thumbarIcons) return thumbarIcons;
  const assetsDir = path.join(__dirname, '..', '..', 'assets');
  thumbarIcons = {
    prev: nativeImage.createFromPath(path.join(assetsDir, 'thumb-prev.png')),
    play: nativeImage.createFromPath(path.join(assetsDir, 'thumb-play.png')),
    pause: nativeImage.createFromPath(path.join(assetsDir, 'thumb-pause.png')),
    next: nativeImage.createFromPath(path.join(assetsDir, 'thumb-next.png')),
  };
  return thumbarIcons;
}

function updateThumbarButtons(isPlaying, force = false) {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return;
  if (!mainWindow.isVisible()) return;

  const langSetting = settings ? settings.get('language') : 'auto';
  const lang = resolveLanguage(langSetting, app.getLocale());
  const key = `${Boolean(isPlaying)}:${lang}`;
  if (!force && key === lastThumbarKey) return;

  const icons = getThumbarIcons();
  if (
    icons.prev.isEmpty() ||
    icons.play.isEmpty() ||
    icons.pause.isEmpty() ||
    icons.next.isEmpty()
  ) {
    return;
  }

  const t = getTranslations(lang).thumbar;
  try {
    const ok = mainWindow.setThumbarButtons([
      {
        tooltip: t.prev,
        icon: icons.prev,
        click: () => sendPlayerCommand('previous'),
      },
      {
        tooltip: isPlaying ? t.pause : t.play,
        icon: isPlaying ? icons.pause : icons.play,
        click: () => sendPlayerCommand('toggle'),
      },
      {
        tooltip: t.next,
        icon: icons.next,
        click: () => sendPlayerCommand('next'),
      },
    ]);
    if (ok !== false) {
      lastThumbarKey = key;
    }
  } catch (err) {
    console.warn('[Thumbar] Failed to update taskbar buttons:', err.message);
  }
}

function toggleWindowVisibility(forceShow = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (forceShow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    updateThumbarButtons(currentIsPlaying, true);
  } else {
    mainWindow.hide();
  }
}

function getAutoLaunchTarget() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  let targetPath = process.execPath;
  if (
    app.isPackaged &&
    typeof portableFile === 'string' &&
    path.isAbsolute(portableFile) &&
    portableFile.toLowerCase().endsWith('.exe')
  ) {
    try {
      if (fs.statSync(portableFile).isFile()) {
        targetPath = portableFile;
      }
    } catch {
      // Ignore invalid portable executable path and fall back to process.execPath
    }
  }
  const args = app.isPackaged ? [] : [path.resolve(__dirname, '..', '..')];
  return { path: targetPath, args };
}

function syncAutoLaunch(enabled) {
  try {
    const wantEnabled = Boolean(enabled);
    const { path: targetPath, args } = getAutoLaunchTarget();
    const current = app.getLoginItemSettings({ path: targetPath, args });
    if (wantEnabled || current.openAtLogin !== wantEnabled) {
      app.setLoginItemSettings({
        openAtLogin: wantEnabled,
        path: targetPath,
        args,
      });
    }
  } catch (err) {
    console.warn('[AutoLaunch] Failed to update login item settings:', err.message);
  }
}

function resolveWindowBounds(savedBounds) {
  const raw = savedBounds && typeof savedBounds === 'object' ? savedBounds : {};
  let width = Number.isFinite(raw.width) ? Math.max(420, Math.round(raw.width)) : 1280;
  let height = Number.isFinite(raw.height) ? Math.max(320, Math.round(raw.height)) : 820;
  let x = Number.isFinite(raw.x) ? Math.round(raw.x) : undefined;
  let y = Number.isFinite(raw.y) ? Math.round(raw.y) : undefined;
  const isMaximized = Boolean(raw.isMaximized);

  const displays = screen.getAllDisplays();
  if (displays.length > 0) {
    if (x !== undefined && y !== undefined) {
      const isVisibleOnAny = displays.some((d) => {
        const wa = d.workArea;
        const overlapW = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
        const overlapH = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
        return overlapW >= 100 && overlapH >= 80;
      });

      if (!isVisibleOnAny) {
        const wa = screen.getPrimaryDisplay().workArea;
        width = Math.min(width, wa.width);
        height = Math.min(height, wa.height);
        x = wa.x + Math.round((wa.width - width) / 2);
        y = wa.y + Math.round((wa.height - height) / 2);
      } else {
        const wa = screen.getDisplayMatching({ x, y, width, height }).workArea;
        if (width > wa.width) width = wa.width;
        if (height > wa.height) height = wa.height;
      }
    } else {
      const wa = screen.getPrimaryDisplay().workArea;
      width = Math.min(width, wa.width);
      height = Math.min(height, wa.height);
    }
  }

  return { width, height, x, y, isMaximized };
}

function buildOfflinePayload() {
  return {
    ...(lastOfflineInfo || {
      errorCode: '',
      errorDescription: '',
      validatedURL: lastFailedUrl || YTMUSIC_URL,
    }),
    locale: app.getLocale(),
    language: settings ? settings.get('language') : 'auto',
  };
}

async function resetGoogleAuthSession() {
  await clearGoogleAuthCookies(session.defaultSession);
  if (mainWindow && !mainWindow.isDestroyed()) {
    isShowingOffline = false;
    lastOfflineInfo = null;
    mainWindow.loadURL(YTMUSIC_URL).catch(() => {});
  }
}

function createMainWindow() {
  const bounds = resolveWindowBounds(settings.get('windowBounds'));
  const winOptions = {
    width: bounds.width,
    height: bounds.height,
    minWidth: 420,
    minHeight: 320,
    title: 'YouTube Music',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    alwaysOnTop: Boolean(settings.get('alwaysOnTop')),
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };

  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    winOptions.x = bounds.x;
    winOptions.y = bounds.y;
  }

  mainWindow = new BrowserWindow(winOptions);

  const saveBounds = (immediate = false) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    const isMaximized = mainWindow.isMaximized();
    const current = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    if (
      !current ||
      !Number.isFinite(current.width) ||
      !Number.isFinite(current.height) ||
      current.width < 420 ||
      current.height < 320 ||
      current.x <= -30000 ||
      current.y <= -30000
    ) {
      return;
    }
    settings.set(
      'windowBounds',
      {
        width: current.width,
        height: current.height,
        x: current.x,
        y: current.y,
        isMaximized,
      },
      { debounceMs: immediate ? 0 : 350 }
    );
  };

  mainWindow.on('resize', () => saveBounds(false));
  mainWindow.on('move', () => saveBounds(false));

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      if (bounds.isMaximized) {
        mainWindow.maximize();
      }
      updateThumbarButtons(currentIsPlaying, true);
    }
  });

  mainWindow.on('show', () => {
    updateThumbarButtons(currentIsPlaying, true);
  });

  mainWindow.on('restore', () => {
    updateThumbarButtons(currentIsPlaying, true);
  });

  mainWindow.on('close', (event) => {
    saveBounds(true);
    if (!isQuitting && settings.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    isQuitting = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (isQuitting || !settings?.get('minimizeToTray')) {
      if (miniPlayer) miniPlayer.destroy();
      if (settingsWindow) settingsWindow.destroy();
    }
  });

  if (!isSmokeTest) {
    mainWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        if (isOfflineUrl(validatedURL)) return;

        let retryTarget = YTMUSIC_URL;
        if (parseHttpsOriginHost(validatedURL) === 'music.youtube.com') {
          retryTarget = validatedURL;
        }
        lastFailedUrl = retryTarget;
        lastOfflineInfo = {
          errorCode,
          errorDescription: errorDescription || '',
          validatedURL: validatedURL || YTMUSIC_URL,
        };
        isShowingOffline = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(OFFLINE_HTML_URL).catch((err) => {
            console.error('[Main] Failed to load offline page:', err);
          });
        }
      }
    );

    mainWindow.webContents.on('did-finish-load', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const currentUrl = mainWindow.webContents.getURL();
      if (isOfflineUrl(currentUrl)) {
        mainWindow.webContents.send('offline:info', buildOfflinePayload());
      } else if (parseHttpsOriginHost(currentUrl) === 'music.youtube.com') {
        isShowingOffline = false;
        lastOfflineInfo = null;
      }
      mainWindow.webContents.send('miniplayer:visibility', Boolean(miniPlayer?.isVisible()));
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      if (details && details.reason === 'clean-exit') return;
      console.error('[Main] Renderer process gone:', details?.reason, details?.exitCode);
      const now = Date.now();
      if (now - lastCrashRecoverAt < 5000) {
        lastOfflineInfo = {
          errorCode: details?.exitCode || -1,
          errorDescription: `Renderer crashed (${details?.reason || 'unknown'})`,
          validatedURL: lastFailedUrl || YTMUSIC_URL,
        };
        isShowingOffline = true;
        mainWindow.loadURL(OFFLINE_HTML_URL).catch(() => {});
        return;
      }
      lastCrashRecoverAt = now;
      mainWindow.loadURL(YTMUSIC_URL).catch(() => {});
    });
  }

  mainWindow.loadURL(YTMUSIC_URL).catch(() => {});
}

function setupSessionPermissions() {
  const isPermissionAllowed = (rawUrl, permission) => {
    const host = parseHttpsOriginHost(rawUrl);
    if (!host) return false;
    if (host === 'music.youtube.com') {
      return MAIN_MUSIC_PERMISSIONS.has(permission);
    }
    if (isAuthHost(host)) {
      return AUTH_HOST_PERMISSIONS.has(permission);
    }
    return false;
  };

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (!details || !details.requestingUrl || details.isMainFrame === false) {
        callback(false);
        return;
      }
      callback(isPermissionAllowed(details.requestingUrl, permission));
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      if (details && details.isMainFrame === false) {
        return false;
      }
      return isPermissionAllowed(requestingOrigin, permission);
    }
  );

  session.defaultSession.setDevicePermissionHandler(() => false);

  for (const partitionName of ['miniplayer', 'settings']) {
    const ses = session.fromPartition(partitionName);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
  }
}

function isSenderMainFrame(event) {
  return Boolean(
    event &&
      event.sender &&
      !event.sender.isDestroyed() &&
      event.senderFrame &&
      event.senderFrame === event.sender.mainFrame
  );
}

function isMainFrameOf(event, targetWin) {
  if (!isSenderMainFrame(event) || !targetWin || targetWin.isDestroyed()) return false;
  return event.sender === targetWin.webContents;
}

function isMainWindowMusicFrame(event) {
  return isMainFrameOf(event, mainWindow) && parseHttpsOriginHost(event.senderFrame.url) === 'music.youtube.com';
}

function isMainWindowOfflineFrame(event) {
  return isMainFrameOf(event, mainWindow) && isOfflineUrl(event.senderFrame.url);
}

function isMiniPlayerFrame(event) {
  return Boolean(
    miniPlayer &&
      isMainFrameOf(event, miniPlayer.win) &&
      isExactAppUrl(event.senderFrame.url, '/miniplayer.html')
  );
}

function isSettingsFrame(event) {
  return Boolean(
    settingsWindow &&
      isMainFrameOf(event, settingsWindow.win) &&
      isExactAppUrl(event.senderFrame.url, '/settings.html')
  );
}

function buildAuthEnvPayload() {
  return {
    mode: settings.get('authUserAgentMode') || 'chrome',
    chromeMajor: getChromeMajor(),
    chromeUa: getCleanChromeUserAgent(),
    firefoxUa: getFirefoxUserAgent(),
  };
}

function setupIpc() {
  ipcMain.on('preload:bootstrap-sync', (event) => {
    if (!isSenderMainFrame(event)) {
      event.returnValue = null;
      return;
    }

    const frameUrl = event.senderFrame.url;
    const httpsHost = parseHttpsOriginHost(frameUrl);
    const isMainMusic = isMainWindowMusicFrame(event);
    const isMusicOrAuth = httpsHost === 'music.youtube.com' || isAuthHost(httpsHost);
    const isOffline = isMainWindowOfflineFrame(event);
    const isMini = isMiniPlayerFrame(event);
    const isSettings = isSettingsFrame(event);

    if (!isMusicOrAuth && !isOffline && !isMini && !isSettings) {
      event.returnValue = null;
      return;
    }

    event.returnValue = {
      locale: app.getLocale(),
      translations: TRANSLATIONS,
      authHosts: Array.from(AUTH_HOSTS),
      authEnv: isMusicOrAuth ? buildAuthEnvPayload() : null,
      authPatcherCode: isMusicOrAuth ? cachedAuthPatcherCode : '',
      pagePatcherCode: isMainMusic ? cachedPagePatcherCode : '',
    };
  });

  ipcMain.on('i18n:get-locale-sync', (event) => {
    if (!isSenderMainFrame(event)) {
      event.returnValue = '';
      return;
    }
    const frameUrl = event.senderFrame.url;
    const httpsHost = parseHttpsOriginHost(frameUrl);
    const allowed =
      httpsHost === 'music.youtube.com' ||
      isAuthHost(httpsHost) ||
      isMainWindowOfflineFrame(event) ||
      isMiniPlayerFrame(event) ||
      isSettingsFrame(event);
    event.returnValue = allowed ? app.getLocale() : '';
  });

  ipcMain.on('auth:get-env', (event) => {
    if (!isSenderMainFrame(event)) {
      event.returnValue = null;
      return;
    }
    const httpsHost = parseHttpsOriginHost(event.senderFrame.url);
    if (httpsHost !== 'music.youtube.com' && !isAuthHost(httpsHost)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = buildAuthEnvPayload();
  });

  ipcMain.handle('auth:clear-cookies', async (event) => {
    if (!isSettingsFrame(event)) {
      return { ok: false, error: 'Unauthorized' };
    }
    await resetGoogleAuthSession();
    return { ok: true };
  });

  ipcMain.on('auth:open-external-ytm', (event) => {
    if (!isSettingsFrame(event)) return;
    shell.openExternal(YTMUSIC_URL).catch((err) => {
      console.warn('[External] Failed to open YouTube Music:', err?.message || err);
    });
  });

  ipcMain.handle('auth:import-cookies', async (event, rawCookieHeader) => {
    if (!isSettingsFrame(event)) {
      return { ok: false, error: 'Unauthorized' };
    }
    if (
      typeof rawCookieHeader !== 'string' ||
      rawCookieHeader.length === 0 ||
      rawCookieHeader.length > MAX_COOKIE_HEADER_LENGTH
    ) {
      return { ok: false, error: getT().authErrors.noCookiesFound };
    }
    try {
      const res = await importBrowserCookies(
        session.defaultSession,
        rawCookieHeader,
        getT().authErrors.noCookiesFound
      );
      if (mainWindow && !mainWindow.isDestroyed()) {
        isShowingOffline = false;
        lastOfflineInfo = null;
        mainWindow.loadURL(YTMUSIC_URL).catch(() => {});
      }
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:get', (event) => {
    if (
      !isSettingsFrame(event) &&
      !isMainWindowMusicFrame(event) &&
      !isMainWindowOfflineFrame(event)
    ) {
      return null;
    }
    return settings.getAll();
  });

  ipcMain.handle('settings:update', (event, partial) => {
    if (!isSettingsFrame(event)) {
      return null;
    }
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return settings.getAll();
    }
    return settings.update(partial);
  });

  ipcMain.handle('settings:reset-stats', (event) => {
    if (!isSettingsFrame(event)) {
      return null;
    }
    settings.resetStats();
    return settings.getAll();
  });

  ipcMain.on('settings:close', (event) => {
    if (!isSettingsFrame(event)) return;
    if (settingsWindow) settingsWindow.close();
  });

  ipcMain.on('ui:open-settings', (event, tab) => {
    if (!isMainWindowMusicFrame(event)) return;
    if (settingsWindow) {
      settingsWindow.open(tab === 'auth' ? 'auth' : 'general');
    }
  });

  ipcMain.on('adblock:blocked', (event) => {
    if (!isMainWindowMusicFrame(event)) return;
    settings.incrementStat('blockedAds', 1);
  });

  ipcMain.on('sponsorblock:skipped', (event) => {
    if (!isMainWindowMusicFrame(event)) return;
    settings.incrementStat('skippedSegments', 1);
  });

  ipcMain.handle('sponsorblock:fetch', async (event, videoId) => {
    if (!isMainWindowMusicFrame(event)) return [];
    if (!settings.get('sponsorBlockEnabled')) return [];
    if (typeof videoId !== 'string') return [];
    const trimmed = videoId.trim();
    if (!VIDEO_ID_REGEX.test(trimmed)) return [];
    return sponsorBlock.getSegments(trimmed, settings.get('sponsorBlockCategories'));
  });

  ipcMain.handle('lyrics:fetch', async (event, query) => {
    if (!isMainWindowMusicFrame(event)) return { found: false, synced: [], plain: '' };
    if (!settings.get('lyricsEnabled')) return { found: false, synced: [], plain: '' };
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return { found: false, synced: [], plain: '' };
    }
    const cleanQuery = {
      title: typeof query.title === 'string' ? query.title.slice(0, 512) : '',
      artist: typeof query.artist === 'string' ? query.artist.slice(0, 512) : '',
      duration:
        typeof query.duration === 'number' &&
        Number.isFinite(query.duration) &&
        query.duration >= 0 &&
        query.duration <= 864000
          ? query.duration
          : undefined,
    };
    return lyricsService.getLyrics(cleanQuery);
  });

  ipcMain.handle('artwork:fetch-data-url', async (event, artworkUrl) => {
    if (!isMainWindowMusicFrame(event)) return null;
    if (!settings.get('ambientThemeEnabled')) return null;
    if (!checkAllowedArtworkUrl(artworkUrl)) return null;
    return lyricsService.fetchArtworkDataUrl(artworkUrl);
  });

  ipcMain.handle('offline:get-info', (event) => {
    if (!isMainWindowOfflineFrame(event)) return null;
    return buildOfflinePayload();
  });

  ipcMain.on('ui:retry-load', (event) => {
    if (!isMainWindowOfflineFrame(event)) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      isShowingOffline = false;
      const target = isAllowedNavigationUrl(lastFailedUrl) && !isOfflineUrl(lastFailedUrl)
        ? lastFailedUrl
        : YTMUSIC_URL;
      mainWindow.loadURL(target).catch(() => {});
    }
  });

  ipcMain.on('ui:toggle-miniplayer', (event) => {
    if (!isMainWindowMusicFrame(event)) return;
    if (miniPlayer) {
      miniPlayer.toggle(trayManager?.getBoundsSafe());
    }
  });

  ipcMain.on('player:state-changed', async (event, state) => {
    if (!isMainWindowMusicFrame(event)) return;
    try {
      if (!state || typeof state !== 'object' || Array.isArray(state)) return;
      const titleText = sanitizeControlChars(state.title, 300);
      const artistText = sanitizeControlChars(state.artist, 300);
      const validArtworkUrl =
        typeof state.artworkUrl === 'string' && checkAllowedArtworkUrl(state.artworkUrl)
          ? state.artworkUrl
          : '';

      const cleanState = {
        isPlaying: Boolean(state.isPlaying),
        title: titleText,
        artist: artistText,
        artworkUrl: '',
        duration:
          typeof state.duration === 'number' &&
          Number.isFinite(state.duration) &&
          state.duration >= 0
            ? Math.min(864000, state.duration)
            : 0,
        currentTime:
          typeof state.currentTime === 'number' &&
          Number.isFinite(state.currentTime) &&
          state.currentTime >= 0
            ? Math.min(864000, state.currentTime)
            : 0,
        volume:
          typeof state.volume === 'number' && Number.isFinite(state.volume)
            ? Math.max(0, Math.min(1, state.volume))
            : 1,
        muted: Boolean(state.muted),
      };

      currentIsPlaying = cleanState.isPlaying;
      updateThumbarButtons(currentIsPlaying);
      if (trayManager) {
        trayManager.updatePlayerState(cleanState);
      }

      if (miniPlayer) {
        const rawCached =
          validArtworkUrl && lyricsService.artworkCache.has(validArtworkUrl)
            ? lyricsService.artworkCache.get(validArtworkUrl)
            : '';
        const cachedArtwork =
          typeof rawCached === 'string' && DATA_IMAGE_BASE64_REGEX.test(rawCached)
            ? rawCached
            : '';

        miniPlayer.updateState({
          ...cleanState,
          artworkUrl: '',
          artworkDataUrl: cachedArtwork,
        });

        latestArtworkUrl = validArtworkUrl;
        if (validArtworkUrl && !cachedArtwork) {
          const seq = ++latestArtworkSeq;
          const fetched = (await lyricsService.fetchArtworkDataUrl(validArtworkUrl)) || '';
          const safeDataUrl =
            typeof fetched === 'string' && DATA_IMAGE_BASE64_REGEX.test(fetched) ? fetched : '';
          if (seq === latestArtworkSeq && latestArtworkUrl === validArtworkUrl && miniPlayer) {
            miniPlayer.updateState({ artworkDataUrl: safeDataUrl });
          }
        } else {
          latestArtworkSeq += 1;
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        const windowTitle = titleText
          ? `${titleText}${artistText ? ' — ' + artistText : ''} | YouTube Music`
          : 'YouTube Music';
        mainWindow.setTitle(windowTitle);
      }
    } catch (err) {
      console.error('[IPC] player:state-changed error:', err);
    }
  });

  ipcMain.on('player:time-changed', (event, currentTime) => {
    if (!isMainWindowMusicFrame(event)) return;
    if (miniPlayer && typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
      miniPlayer.updateTime(Math.min(864000, currentTime));
    }
  });

  ipcMain.on('player:theme-changed', (event, theme) => {
    if (!isMainWindowMusicFrame(event)) return;
    if (!miniPlayer || !theme || typeof theme !== 'object' || Array.isArray(theme)) return;
    miniPlayer.updateTheme(theme);
  });

  ipcMain.on('miniplayer:command', (event, command) => {
    if (!isMiniPlayerFrame(event)) return;
    if (typeof command === 'string' && ALLOWED_PLAYER_COMMANDS.has(command)) {
      sendPlayerCommand(command);
    }
  });

  ipcMain.on('miniplayer:seek', (event, time) => {
    if (!isMiniPlayerFrame(event)) return;
    if (
      typeof time === 'number' &&
      Number.isFinite(time) &&
      time >= 0 &&
      time <= 864000 &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send('player:seek', time);
    }
  });

  ipcMain.on('miniplayer:volume', (event, volume) => {
    if (!isMiniPlayerFrame(event)) return;
    if (
      typeof volume === 'number' &&
      Number.isFinite(volume) &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      const clamped = Math.max(0, Math.min(1, volume));
      mainWindow.webContents.send('player:set-volume', clamped);
    }
  });

  ipcMain.handle('miniplayer:toggle-pin', (event) => {
    if (!isMiniPlayerFrame(event)) return false;
    return miniPlayer ? miniPlayer.togglePin() : false;
  });

  ipcMain.on('miniplayer:open-main', (event) => {
    if (!isMiniPlayerFrame(event)) return;
    toggleWindowVisibility(true);
    if (miniPlayer && !miniPlayer.isPinned) {
      miniPlayer.hide();
    }
  });

  ipcMain.on('miniplayer:close', (event) => {
    if (!isMiniPlayerFrame(event)) return;
    if (miniPlayer) miniPlayer.hide();
  });
}

function scheduleTrayStatsRebuild() {
  if (!trayManager || trayStatsTimer) return;
  trayStatsTimer = setTimeout(() => {
    trayStatsTimer = null;
    if (trayManager) trayManager.rebuildMenu();
  }, 2000);
}

if (!gotTheLock) {
  app.quit();
} else {
  if (!isSmokeTest) {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        updateThumbarButtons(currentIsPlaying, true);
      }
    });
  }

  app.on('web-contents-created', (_event, contents) => {
    if (
      (miniPlayer && miniPlayer.isOwnWebContents(contents)) ||
      (settingsWindow && settingsWindow.isOwnWebContents(contents))
    ) {
      return;
    }
    attachNavigationGuards(contents);
  });

  app
    .whenReady()
    .then(() => {
      app.setAppUserModelId('com.ytmusicclient.desktop');
      nativeTheme.themeSource = 'dark';
      Menu.setApplicationMenu(null);

      const cleanUa = getCleanChromeUserAgent();
      app.userAgentFallback = cleanUa;
      session.defaultSession.setUserAgent(cleanUa);

      loadPatcherScripts();
      registerAppProtocolOnSession(session.defaultSession);
      registerAppProtocolOnSession(session.fromPartition('miniplayer'));
      registerAppProtocolOnSession(session.fromPartition('settings'));
      setupSessionPermissions();

      settings = new SettingsManager();
      sponsorBlock = new SponsorBlockService();
      lyricsService = new LyricsAndArtworkService();
      shortcuts = new ShortcutManager(sendPlayerCommand);
      miniPlayer = new MiniPlayerManager({
        onVisibilityChange: (visible) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('miniplayer:visibility', Boolean(visible));
          }
        },
      });
      settingsWindow = new SettingsWindowManager();
      trayManager = new TrayManager({
        settings,
        onToggleWindow: toggleWindowVisibility,
        onOpenMainWindow: () => {
          toggleWindowVisibility(true);
          if (miniPlayer && !miniPlayer.isPinned) {
            miniPlayer.hide();
          }
        },
        onToggleMiniPlayer: (bounds) => {
          if (miniPlayer) miniPlayer.toggle(bounds);
        },
        onPlayerCommand: sendPlayerCommand,
        onToggleLyrics: () => {
          toggleWindowVisibility(true);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ui:toggle-lyrics');
          }
        },
        onOpenAuthSettings: () => {
          if (settingsWindow) {
            settingsWindow.open('auth');
          }
        },
        onClearGoogleAuth: resetGoogleAuthSession,
        onReload: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (isShowingOffline) {
              isShowingOffline = false;
              const target =
                isAllowedNavigationUrl(lastFailedUrl) && !isOfflineUrl(lastFailedUrl)
                  ? lastFailedUrl
                  : YTMUSIC_URL;
              mainWindow.loadURL(target).catch(() => {});
            } else {
              mainWindow.webContents.reload();
            }
          }
        },
        onQuit: () => {
          isQuitting = true;
          app.quit();
        },
        getDialogParent: () =>
          mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null,
      });

      setupAuthHeaders(session.defaultSession, settings);
      setupNetworkAdBlocker(session.defaultSession, settings, () => {
        settings.incrementStat('blockedAds', 1);
      });

      setupIpc();
      createMainWindow();
      trayManager.init();
      miniPlayer.updateLocale(getT().miniPlayer);
      shortcuts.apply(settings);

      if (isSmokeTest) {
        let smokeFinished = false;
        let smokeTimer = null;
        const finishSmoke = (status) => {
          if (smokeFinished) return;
          smokeFinished = true;
          if (smokeTimer) clearTimeout(smokeTimer);
          console.log(`SMOKE_TEST_${status}`);
          isQuitting = true;
          app.quit();
        };
        mainWindow.webContents.once('did-finish-load', () => {
          console.log(`LOADED_URL=${mainWindow.webContents.getURL()}`);
          finishSmoke('OK');
        });
        mainWindow.webContents.on(
          'did-fail-load',
          (_e, code, desc, _validatedURL, isMainFrame) => {
            if (!isMainFrame || code === -3) return;
            console.error(`LOAD_FAILED=${code}:${desc}`);
            finishSmoke('LOAD_FAILED');
          }
        );
        smokeTimer = setTimeout(() => finishSmoke('TIMEOUT'), 8000);
        return;
      }

      syncAutoLaunch(settings.get('autoLaunch'));

      settings.onChange((key, _val, all, changedKeys) => {
        const changed = (k) => key === k || Boolean(changedKeys && changedKeys.has(k));

        if (changed('globalMediaKeys') || changed('extraHotkeys')) {
          shortcuts.apply(settings);
        }
        if (changed('alwaysOnTop')) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(Boolean(all.alwaysOnTop));
          }
        }
        if (changed('autoLaunch')) {
          syncAutoLaunch(all.autoLaunch);
        }
        if (changed('language')) {
          updateThumbarButtons(currentIsPlaying, true);
          if (miniPlayer) {
            miniPlayer.updateLocale(getT().miniPlayer);
          }
          if (isShowingOffline && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('offline:info', buildOfflinePayload());
          }
        }
        if (changed('stats')) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('stats:updated', all.stats);
          }
          if (settingsWindow) {
            settingsWindow.sendStatsUpdated(all.stats);
          }
          if ((all.stats?.blockedAds || 0) === 0 && (all.stats?.skippedSegments || 0) === 0) {
            if (trayStatsTimer) {
              clearTimeout(trayStatsTimer);
              trayStatsTimer = null;
            }
            if (trayManager) trayManager.rebuildMenu();
          } else {
            scheduleTrayStatsRebuild();
          }
        }

        const keys = changedKeys ? [...changedKeys] : [key];
        const hasUiSettingChange = keys.some(
          (k) => k !== 'windowBounds' && k !== 'stats' && k !== '*'
        );
        if (hasUiSettingChange) {
          if (trayManager) trayManager.rebuildMenu();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings:updated', all);
          }
          if (settingsWindow) {
            settingsWindow.sendSettingsUpdated(all);
          }
        } else if (
          changed('stats') &&
          (all.stats?.blockedAds || 0) === 0 &&
          (all.stats?.skippedSegments || 0) === 0
        ) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings:updated', all);
          }
          if (settingsWindow) {
            settingsWindow.sendSettingsUpdated(all);
          }
        }
      });
    })
    .catch((err) => {
      console.error('[Main] Fatal startup error:', err);
      isQuitting = true;
      app.quit();
    });

  app.on('before-quit', () => {
    isQuitting = true;
    if (trayStatsTimer) {
      clearTimeout(trayStatsTimer);
      trayStatsTimer = null;
    }
    if (settings) settings.flush();
  });

  app.on('will-quit', () => {
    if (trayStatsTimer) {
      clearTimeout(trayStatsTimer);
      trayStatsTimer = null;
    }
    if (settings) settings.flush();
    if (shortcuts) shortcuts.unregisterAll();
    if (trayManager) trayManager.destroy();
    if (miniPlayer) miniPlayer.destroy();
    if (settingsWindow) settingsWindow.destroy();
    if (isSmokeTest && smokeTempUserData) {
      try {
        fs.rmSync(smokeTempUserData, { recursive: true, force: true });
      } catch {
        // Ignore temp cleanup failure
      }
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (!settings?.get('minimizeToTray') || isQuitting)) {
      app.quit();
    }
  });
}
