const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
} = require('electron');

const { SettingsManager } = require('./settings');
const { setupNetworkAdBlocker } = require('./adblocker');
const { SponsorBlockService } = require('./sponsorblock');
const { LyricsAndArtworkService } = require('./lyrics');
const { ShortcutManager } = require('./shortcuts');
const { TrayManager } = require('./tray');
const {
  AUTH_HOSTS,
  getChromeMajor,
  getCleanChromeUserAgent,
  getFirefoxUserAgent,
  setupAuthHeaders,
  clearGoogleAuthCookies,
  importBrowserCookies,
} = require('./auth');

const YTMUSIC_URL = 'https://music.youtube.com/';

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.userAgentFallback = getCleanChromeUserAgent();

let mainWindow = null;
let settings = null;
let sponsorBlock = null;
let lyricsService = null;
let shortcuts = null;
let trayManager = null;
let isQuitting = false;
let currentIsPlaying = false;

const isSmokeTest = process.argv.includes('--smoke-test');
if (isSmokeTest) {
  app.setPath('userData', path.join(app.getPath('temp'), `ytmc-smoke-${process.pid}`));
}

const gotTheLock = isSmokeTest ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else if (!isSmokeTest) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function sendPlayerCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:command', command);
  }
}

function updateThumbarButtons(isPlaying) {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return;
  const assetsDir = path.join(__dirname, '..', '..', 'assets');
  try {
    mainWindow.setThumbarButtons([
      {
        tooltip: 'Попередній трек',
        icon: nativeImage.createFromPath(path.join(assetsDir, 'thumb-prev.png')),
        click: () => sendPlayerCommand('previous'),
      },
      {
        tooltip: isPlaying ? 'Пауза' : 'Відтворити',
        icon: nativeImage.createFromPath(
          path.join(assetsDir, isPlaying ? 'thumb-pause.png' : 'thumb-play.png')
        ),
        click: () => sendPlayerCommand('toggle'),
      },
      {
        tooltip: 'Наступний трек',
        icon: nativeImage.createFromPath(path.join(assetsDir, 'thumb-next.png')),
        click: () => sendPlayerCommand('next'),
      },
    ]);
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
    updateThumbarButtons(currentIsPlaying);
  } else {
    mainWindow.hide();
  }
}

function syncAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname, '..', '..')],
    });
  } catch (err) {
    console.warn('[AutoLaunch] Failed to update login item settings:', err.message);
  }
}

function createMainWindow() {
  const bounds = settings.get('windowBounds') || {};
  const winOptions = {
    width: bounds.width || 1280,
    height: bounds.height || 820,
    minWidth: 420,
    minHeight: 320,
    title: 'YouTube Music',
    backgroundColor: '#030303',
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

  if (bounds.isMaximized) {
    mainWindow.maximize();
  }

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const current = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    settings.set('windowBounds', {
      width: current.width,
      height: current.height,
      x: current.x,
      y: current.y,
      isMaximized,
    });
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--smoke-test')) {
      mainWindow.show();
      updateThumbarButtons(currentIsPlaying);
    }
  });

  mainWindow.on('close', (event) => {
    saveBounds();
    if (!isQuitting && settings.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'music.youtube.com' || AUTH_HOSTS.has(parsed.hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: '#030303',
            icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
            webPreferences: {
              preload: path.join(__dirname, '..', 'preload', 'index.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
            },
          },
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

  mainWindow.loadURL(YTMUSIC_URL);
}

function setupIpc() {
  ipcMain.on('auth:get-env', (event) => {
    event.returnValue = {
      mode: settings.get('authUserAgentMode') || 'chrome',
      chromeMajor: getChromeMajor(),
      chromeUa: getCleanChromeUserAgent(),
      firefoxUa: getFirefoxUserAgent(),
    };
  });

  ipcMain.handle('auth:clear-cookies', async () => {
    await clearGoogleAuthCookies(session.defaultSession);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(YTMUSIC_URL);
    }
    return { ok: true };
  });

  ipcMain.on('auth:open-external-ytm', () => {
    shell.openExternal(YTMUSIC_URL);
  });

  ipcMain.handle('auth:import-cookies', async (_event, rawCookieHeader) => {
    try {
      const res = await importBrowserCookies(session.defaultSession, rawCookieHeader);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(YTMUSIC_URL);
      }
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:get', () => settings.getAll());

  ipcMain.handle('settings:update', (_event, partial) => {
    return settings.update(partial);
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

  ipcMain.on('player:state-changed', (_event, state) => {
    if (!state || typeof state !== 'object') return;
    currentIsPlaying = Boolean(state.isPlaying);
    updateThumbarButtons(currentIsPlaying);
    if (trayManager) {
      trayManager.updatePlayerState(state);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const title = state.title
        ? `${state.title}${state.artist ? ' — ' + state.artist : ''} | YouTube Music`
        : 'YouTube Music';
      mainWindow.setTitle(title);
    }
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.ytmusicclient.desktop');
  nativeTheme.themeSource = 'dark';

  const cleanUa = getCleanChromeUserAgent();
  app.userAgentFallback = cleanUa;
  session.defaultSession.setUserAgent(cleanUa);

  settings = new SettingsManager();
  sponsorBlock = new SponsorBlockService();
  lyricsService = new LyricsAndArtworkService();
  shortcuts = new ShortcutManager(sendPlayerCommand);
  trayManager = new TrayManager({
    settings,
    onToggleWindow: toggleWindowVisibility,
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
    onClearGoogleAuth: async () => {
      await clearGoogleAuthCookies(session.defaultSession);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(YTMUSIC_URL);
      }
    },
    onReload: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  setupAuthHeaders(session.defaultSession, settings);
  setupNetworkAdBlocker(session.defaultSession, settings, () => {
    settings.incrementStat('blockedAds', 1);
  });

  setupIpc();
  createMainWindow();
  trayManager.init();
  shortcuts.apply(settings);

  if (process.argv.includes('--smoke-test')) {
    const finishSmoke = (status) => {
      console.log(`SMOKE_TEST_${status}`);
      isQuitting = true;
      app.quit();
    };
    mainWindow.webContents.once('did-finish-load', () => {
      console.log(`LOADED_URL=${mainWindow.webContents.getURL()}`);
      finishSmoke('OK');
    });
    mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`LOAD_FAILED=${code}:${desc}`);
      finishSmoke('LOAD_FAILED');
    });
    setTimeout(() => finishSmoke('TIMEOUT'), 8000);
    return;
  }

  syncAutoLaunch(settings.get('autoLaunch'));

  settings.onChange((key, _val, all) => {
    if (key === 'globalMediaKeys' || key === 'extraHotkeys' || key === '*') {
      shortcuts.apply(settings);
    }
    if (key === 'alwaysOnTop' || key === '*') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(Boolean(all.alwaysOnTop));
      }
    }
    if (key === 'autoLaunch' || key === '*') {
      syncAutoLaunch(all.autoLaunch);
    }
    if (trayManager) {
      trayManager.rebuildMenu();
    }
    if (key !== 'windowBounds' && key !== 'stats') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('settings:updated', all);
      }
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (shortcuts) shortcuts.unregisterAll();
  if (trayManager) trayManager.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !settings?.get('minimizeToTray')) {
    app.quit();
  }
});
