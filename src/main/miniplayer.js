const path = require('path');
const { BrowserWindow, screen } = require('electron');

const MINIPLAYER_URL = 'ytmc-app://local/miniplayer.html';
const DATA_IMAGE_BASE64_REGEX =
  /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i;

function sanitizeText(value, maxLen = 300) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeRgb(arr) {
  if (!Array.isArray(arr) || arr.length !== 3) return null;
  const out = [];
  for (const ch of arr) {
    if (typeof ch !== 'number' || !Number.isFinite(ch)) return null;
    out.push(Math.max(0, Math.min(255, Math.round(ch))));
  }
  return out;
}

class MiniPlayerManager {
  constructor({ onVisibilityChange } = {}) {
    this.win = null;
    this._creating = false;
    this.isPinned = false;
    this.lastBlurHideTime = 0;
    this._isLoaded = false;
    this._pendingShow = false;
    this._hasBeenShown = false;
    this.onVisibilityChange =
      typeof onVisibilityChange === 'function' ? onVisibilityChange : () => {};
    this.latestState = {
      isPlaying: false,
      title: '',
      artist: '',
      artworkUrl: '',
      artworkDataUrl: '',
      duration: 0,
      currentTime: 0,
      volume: 1,
      muted: false,
    };
    this.latestTheme = {
      primary: [255, 45, 85],
      secondary: [90, 60, 200],
    };
    this.latestStrings = null;
  }

  isOwnWebContents(contents) {
    if (!contents) return false;
    if (this._creating) return true;
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === contents);
  }

  _emitVisibility(visible) {
    try {
      this.onVisibilityChange(Boolean(visible));
    } catch {
      // Ignore listener errors
    }
  }

  isVisible() {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    this._isLoaded = false;
    this._pendingShow = false;
    this._creating = true;
    try {
      this.win = new BrowserWindow({
        width: 356,
        height: 196,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#121216',
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'miniplayer.js'),
          partition: 'miniplayer',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
        },
      });
    } finally {
      this._creating = false;
    }

    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    this.win.webContents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    this.win.webContents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });

    this.win.webContents.on('did-finish-load', () => {
      this._isLoaded = true;
      this._pushFullSync();
      if (this._pendingShow && this.win && !this.win.isDestroyed()) {
        this._pendingShow = false;
        this.win.show();
        this.win.focus();
      }
    });

    this.win.webContents.on('render-process-gone', () => {
      this._isLoaded = false;
      this._pendingShow = false;
      this.destroy();
      this._emitVisibility(false);
    });

    this.win.on('show', () => {
      this._emitVisibility(true);
    });

    this.win.on('hide', () => {
      this._emitVisibility(false);
    });

    this.win.on('blur', () => {
      if (!this.isPinned && this.win && !this.win.isDestroyed() && this.win.isVisible()) {
        this.lastBlurHideTime = Date.now();
        this.win.hide();
      }
    });

    this.win.on('closed', () => {
      this._isLoaded = false;
      this._pendingShow = false;
      this.win = null;
      this._emitVisibility(false);
    });

    this.win.loadURL(MINIPLAYER_URL).catch(() => {});

    return this.win;
  }

  _isBoundsVisibleOnAnyDisplay(bounds) {
    if (!bounds) return false;
    for (const display of screen.getAllDisplays()) {
      const wa = display.workArea;
      const overlapW = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x);
      const overlapH =
        Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y);
      if (overlapW >= 80 && overlapH >= 60) {
        return true;
      }
    }
    return false;
  }

  _positionNearTray(trayBounds) {
    if (!this.win || this.win.isDestroyed()) return;
    const { width, height } = this.win.getBounds();

    const hasBounds = Boolean(trayBounds && trayBounds.width > 0 && trayBounds.height > 0);
    let display;
    if (hasBounds) {
      display = screen.getDisplayMatching(trayBounds);
    } else {
      try {
        display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      } catch {
        display = screen.getPrimaryDisplay();
      }
    }
    const wa = display.workArea;
    const margin = 10;

    let x = wa.x + wa.width - width - 12;
    let y = wa.y + wa.height - height - 12;

    if (hasBounds) {
      if (trayBounds.x < wa.x) {
        // Left-edge vertical taskbar
        x = wa.x + margin;
        y = Math.round(trayBounds.y + trayBounds.height / 2 - height / 2);
      } else if (trayBounds.x >= wa.x + wa.width) {
        // Right-edge vertical taskbar
        x = wa.x + wa.width - width - margin;
        y = Math.round(trayBounds.y + trayBounds.height / 2 - height / 2);
      } else {
        // Top or bottom horizontal taskbar
        x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
        const isBottom = trayBounds.y >= wa.y + wa.height / 2;
        y = isBottom ? wa.y + wa.height - height - margin : wa.y + margin;
      }
      x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));
      y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - height - 8));
    }

    this.win.setPosition(Math.round(x), Math.round(y), false);
  }

  show(trayBounds) {
    const win = this._ensureWindow();
    if (
      !this.isPinned ||
      !this._hasBeenShown ||
      !this._isBoundsVisibleOnAnyDisplay(win.getBounds())
    ) {
      this._positionNearTray(trayBounds);
    }
    this._hasBeenShown = true;

    if (!this._isLoaded) {
      this._pendingShow = true;
      return;
    }

    this._pushFullSync();
    win.show();
    win.focus();
  }

  hide() {
    this._pendingShow = false;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide();
    }
  }

  toggle(trayBounds) {
    if (this.isVisible()) {
      this.hide();
      return;
    }
    // Prevent immediate re-open when tray click happens right after blur hid the window
    if (Date.now() - this.lastBlurHideTime < 380) {
      this.lastBlurHideTime = 0;
      return;
    }
    this.show(trayBounds);
  }

  togglePin() {
    this.isPinned = !this.isPinned;
    if (this.win && !this.win.isDestroyed()) {
      this.win.setAlwaysOnTop(true, this.isPinned ? 'floating' : 'pop-up-menu');
    }
    this._pushFullSync();
    return this.isPinned;
  }

  _pushFullSync() {
    if (!this.win || this.win.isDestroyed() || !this._isLoaded) return;
    this.win.webContents.send('miniplayer:state', {
      ...this.latestState,
      isPinned: this.isPinned,
      strings: this.latestStrings,
    });
    this.win.webContents.send('miniplayer:theme', this.latestTheme);
  }

  updateState(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return;
    const next = { ...this.latestState, artworkUrl: '' };

    if (Object.hasOwn(partial, 'isPlaying')) {
      next.isPlaying = Boolean(partial.isPlaying);
    }
    if (Object.hasOwn(partial, 'title')) {
      next.title = sanitizeText(partial.title, 300);
    }
    if (Object.hasOwn(partial, 'artist')) {
      next.artist = sanitizeText(partial.artist, 300);
    }
    if (Object.hasOwn(partial, 'artworkDataUrl')) {
      next.artworkDataUrl =
        typeof partial.artworkDataUrl === 'string' &&
        DATA_IMAGE_BASE64_REGEX.test(partial.artworkDataUrl)
          ? partial.artworkDataUrl
          : '';
    }
    if (
      Object.hasOwn(partial, 'duration') &&
      typeof partial.duration === 'number' &&
      Number.isFinite(partial.duration) &&
      partial.duration >= 0
    ) {
      next.duration = Math.min(864000, partial.duration);
    }
    if (
      Object.hasOwn(partial, 'currentTime') &&
      typeof partial.currentTime === 'number' &&
      Number.isFinite(partial.currentTime) &&
      partial.currentTime >= 0
    ) {
      next.currentTime = Math.min(864000, partial.currentTime);
    }
    if (
      Object.hasOwn(partial, 'volume') &&
      typeof partial.volume === 'number' &&
      Number.isFinite(partial.volume)
    ) {
      next.volume = Math.max(0, Math.min(1, partial.volume));
    }
    if (Object.hasOwn(partial, 'muted')) {
      next.muted = Boolean(partial.muted);
    }

    this.latestState = next;
    if (this.isVisible() && this._isLoaded) {
      this.win.webContents.send('miniplayer:state', {
        ...this.latestState,
        isPinned: this.isPinned,
        strings: this.latestStrings,
      });
    }
  }

  updateLocale(strings) {
    this.latestStrings = strings && typeof strings === 'object' && !Array.isArray(strings) ? strings : null;
    this._pushFullSync();
  }

  updateTime(currentTime) {
    if (typeof currentTime !== 'number' || !Number.isFinite(currentTime) || currentTime < 0) {
      return;
    }
    const clamped = Math.min(864000, currentTime);
    this.latestState.currentTime = clamped;
    if (this.isVisible() && this._isLoaded) {
      this.win.webContents.send('miniplayer:time', clamped);
    }
  }

  updateTheme(theme) {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return;
    const primary = normalizeRgb(theme.primary);
    const secondary = normalizeRgb(theme.secondary);
    if (primary && secondary) {
      this.latestTheme = { primary, secondary };
      if (this.isVisible() && this._isLoaded) {
        this.win.webContents.send('miniplayer:theme', this.latestTheme);
      }
    }
  }

  destroy() {
    this._pendingShow = false;
    this._isLoaded = false;
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}

module.exports = { MiniPlayerManager };
