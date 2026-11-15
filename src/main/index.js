const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
} = require('electron');

const { SettingsManager } = require('./settings');
const { setupNetworkAdBlocker } = require('./adblocker');
const { SponsorBlockService } = require('./sponsorblock');
const { LyricsAndArtworkService } = require('./lyrics');
const { ShortcutManager } = require('./shortcuts');
const { TrayManager } = require('./tray');
const { MiniPlayerManager } = require('./miniplayer');
const { resolveLanguage, getTranslations } = require('../shared/i18n');
const { isAuthHost } = require('../shared/auth-hosts');
const {
  getChromeMajor,
  getCleanChromeUserAgent,
  getFirefoxUserAgent,
  setupAuthHeaders,
  clearGoogleAuthCookies,
  importBrowserCookies,
} = require('./auth');

const YTMUSIC_URL = 'https://music.youtube.com/';
const OFFLINE_HTML_PATH = path.resolve(__dirname, '..', 'renderer', 'offline.html');
const OFFLINE_HTML_URL = pathToFileURL(OFFLINE_HTML_PATH).href;

const ALLOWED_PERMISSIONS = new Set([
  'mediaKeySystem',
  'fullscreen',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'storage-access',
  'top-level-storage-access',
  'speaker-selection',
]);

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.userAgentFallback = getCleanChromeUserAgent();

let mainWindow = null;
let settings = null;
let sponsorBlock = null;
let lyricsService = null;
let shortcuts = null;
let trayManager = null;
let miniPlayer = null;
let isQuitting = false;
let currentIsPlaying = false;
let thumbarIcons = null;
let lastThumbarKey = '';
let latestArtworkSeq = 0;
let lastFailedUrl = YTMUSIC_URL;
let lastOfflineInfo = null;
let isShowingOffline = false;
let trayStatsTimer = null;
let lastCrashRecoverAt = 0;

const isSmokeTest = process.argv.includes('--smoke-test');
let smokeTempUserData = null;
if (isSmokeTest) {
  smokeTempUserData = path.join(app.getPath('temp'), `ytmc-smoke-${process.pid}`);
  app.setPath('userData', smokeTempUserData);
}

const gotTheLock = isSmokeTest ? true : app.requestSingleInstanceLock();

function getT() {
  const langSetting = settings ? settings.get('language') : 'auto';
  const lang = resolveLanguage(langSetting, app.getLocale());
  return getTranslations(lang);
}

function sendPlayerCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:command', command);
  }
}

function isOfflineUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const cleanTarget = new URL(rawUrl).href.split('#')[0].split('?')[0].toLowerCase();
    return cleanTarget === OFFLINE_HTML_URL.toLowerCase();
  } catch {
    return false;
  }
}

function isAllowedNavigationUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (isOfflineUrl(rawUrl)) return true;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'music.youtube.com' || isAuthHost(host)) return true;
    if (host === 'www.youtube.com' || host === 'youtube.com') {
      return (
        parsed.pathname.startsWith('/signin') ||
        parsed.pathname.startsWith('/logout') ||
        parsed.pathname.startsWith('/accounts') ||
        parsed.pathname.startsWith('/oops')
      );
    }
    return false;
  } catch {
    return false;
  }
}

function buildPopupOptions() {
  return {
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
}

function attachNavigationGuards(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'music.youtube.com' || isAuthHost(parsed.hostname))) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: buildPopupOptions(),
        };
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      // Ignore invalid URLs
    }
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      // Ignore invalid URLs
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
  const targetPath = portableFile || process.execPath;
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
  if (displays.length > 0 && x !== undefined && y !== undefined) {
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
      sandbox: false,
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
    }
  });

  if (!isSmokeTest) {
    mainWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        if (isOfflineUrl(validatedURL)) return;

        let retryTarget = YTMUSIC_URL;
        try {
          if (validatedURL && new URL(validatedURL).hostname.toLowerCase() === 'music.youtube.com') {
            retryTarget = validatedURL;
          }
        } catch {
          retryTarget = YTMUSIC_URL;
        }
        lastFailedUrl = retryTarget;
        lastOfflineInfo = {
          errorCode,
          errorDescription: errorDescription || '',
          validatedURL: validatedURL || YTMUSIC_URL,
        };
        isShowingOffline = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadFile(OFFLINE_HTML_PATH).catch((err) => {
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
      } else if (currentUrl.startsWith('https://music.youtube.com')) {
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
        mainWindow.loadFile(OFFLINE_HTML_PATH).catch(() => {});
        return;
      }
      lastCrashRecoverAt = now;
      mainWindow.loadURL(YTMUSIC_URL).catch(() => {});
    });
  }

  mainWindow.loadURL(YTMUSIC_URL).catch(() => {});
}

function setupSessionPermissions() {
  const isOriginAllowed = (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      return (
        parsed.protocol === 'https:' &&
        (parsed.hostname === 'music.youtube.com' ||
          parsed.hostname === 'www.youtube.com' ||
          isAuthHost(parsed.hostname))
      );
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (!ALLOWED_PERMISSIONS.has(permission)) {
        callback(false);
        return;
      }
      const targetUrl = (details && details.requestingUrl) || webContents.getURL();
      callback(isOriginAllowed(targetUrl));
    }
  );

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    return isOriginAllowed(requestingOrigin);
  });
}

function setupIpc() {
  ipcMain.on('i18n:get-locale-sync', (event) => {
    event.returnValue = app.getLocale();
  });

  ipcMain.on('auth:get-env', (event) => {
    event.returnValue = {
      mode: settings.get('authUserAgentMode') || 'chrome',
      chromeMajor: getChromeMajor(),
      chromeUa: getCleanChromeUserAgent(),
      firefoxUa: getFirefoxUserAgent(),
    };
  });

  ipcMain.handle('auth:clear-cookies', async () => {
    await resetGoogleAuthSession();
    return { ok: true };
  });

  ipcMain.on('auth:open-external-ytm', () => {
    shell.openExternal(YTMUSIC_URL);
  });

  ipcMain.handle('auth:import-cookies', async (_event, rawCookieHeader) => {
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

  ipcMain.handle('settings:get', () => settings.getAll());

  ipcMain.handle('settings:update', (_event, partial) => {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return settings.getAll();
    }
    return settings.update(partial);
  });

  ipcMain.handle('settings:reset-stats', () => {
    settings.resetStats();
    return settings.getAll();
  });

  ipcMain.on('adblock:blocked', () => {
    settings.incrementStat('blockedAds', 1);
  });

  ipcMain.on('sponsorblock:skipped', () => {
    settings.incrementStat('skippedSegments', 1);
  });

  ipcMain.handle('sponsorblock:fetch', async (_event, videoId) => {
    if (!settings.get('sponsorBlockEnabled')) return [];
    return sponsorBlock.getSegments(videoId, settings.get('sponsorBlockCategories'));
  });

  ipcMain.handle('lyrics:fetch', async (_event, query) => {
    if (!settings.get('lyricsEnabled')) return { found: false, synced: [], plain: '' };
    return lyricsService.getLyrics(query || {});
  });

  ipcMain.handle('artwork:fetch-data-url', async (_event, artworkUrl) => {
    if (!settings.get('ambientThemeEnabled')) return null;
    return lyricsService.fetchArtworkDataUrl(artworkUrl);
  });

  ipcMain.handle('offline:get-info', () => buildOfflinePayload());

  ipcMain.on('ui:retry-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      isShowingOffline = false;
      mainWindow.loadURL(lastFailedUrl || YTMUSIC_URL).catch(() => {});
    }
  });

  ipcMain.on('ui:toggle-miniplayer', () => {
    if (miniPlayer) {
      miniPlayer.toggle(trayManager?.getBoundsSafe());
    }
  });

  ipcMain.on('player:state-changed', async (_event, state) => {
    try {
      if (!state || typeof state !== 'object') return;
      currentIsPlaying = Boolean(state.isPlaying);
      updateThumbarButtons(currentIsPlaying);
      if (trayManager) {
        trayManager.updatePlayerState(state);
      }
      if (miniPlayer) {
        const artworkUrl = typeof state.artworkUrl === 'string' ? state.artworkUrl : '';
        const cachedArtwork =
          artworkUrl && lyricsService.artworkCache.has(artworkUrl)
            ? lyricsService.artworkCache.get(artworkUrl)
            : '';

        miniPlayer.updateState({
          ...state,
          artworkUrl,
          artworkDataUrl: cachedArtwork || '',
        });

        if (artworkUrl && !cachedArtwork) {
          const seq = ++latestArtworkSeq;
          const dataUrl = (await lyricsService.fetchArtworkDataUrl(artworkUrl)) || '';
          if (
            seq === latestArtworkSeq &&
            miniPlayer &&
            miniPlayer.latestState.artworkUrl === artworkUrl
          ) {
            miniPlayer.updateState({ artworkDataUrl: dataUrl });
          }
        } else {
          latestArtworkSeq += 1;
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        const title = state.title
          ? `${state.title}${state.artist ? ' — ' + state.artist : ''} | YouTube Music`
          : 'YouTube Music';
        mainWindow.setTitle(title);
      }
    } catch (err) {
      console.error('[IPC] player:state-changed error:', err);
    }
  });

  ipcMain.on('player:time-changed', (_event, currentTime) => {
    if (miniPlayer && Number.isFinite(currentTime)) {
      miniPlayer.updateTime(currentTime);
    }
  });

  ipcMain.on('player:theme-changed', (_event, theme) => {
    if (miniPlayer) {
      miniPlayer.updateTheme(theme);
    }
  });

  ipcMain.on('miniplayer:command', (_event, command) => {
    sendPlayerCommand(command);
  });

  ipcMain.on('miniplayer:seek', (_event, time) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player:seek', time);
    }
  });

  ipcMain.on('miniplayer:volume', (_event, volume) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player:set-volume', volume);
    }
  });

  ipcMain.handle('miniplayer:toggle-pin', () => {
    return miniPlayer ? miniPlayer.togglePin() : false;
  });

  ipcMain.on('miniplayer:open-main', () => {
    toggleWindowVisibility(true);
    if (miniPlayer && !miniPlayer.isPinned) {
      miniPlayer.hide();
    }
  });

  ipcMain.on('miniplayer:close', () => {
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
    if (miniPlayer && miniPlayer.isOwnWebContents(contents)) {
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
          toggleWindowVisibility(true);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ui:open-settings', 'auth');
          }
        },
        onClearGoogleAuth: resetGoogleAuthSession,
        onReload: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (isShowingOffline) {
              isShowingOffline = false;
              mainWindow.loadURL(lastFailedUrl || YTMUSIC_URL).catch(() => {});
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
        } else if (changed('stats') && (all.stats?.blockedAds || 0) === 0 && (all.stats?.skippedSegments || 0) === 0) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('settings:updated', all);
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
