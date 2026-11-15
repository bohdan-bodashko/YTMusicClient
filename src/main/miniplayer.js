const path = require('path');
const { BrowserWindow, screen } = require('electron');

class MiniPlayerManager {
  constructor() {
    this.win = null;
    this.isPinned = false;
    this.lastHideTime = 0;
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

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;

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
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'miniplayer.html'));

    this.win.webContents.on('did-finish-load', () => {
      this._pushFullSync();
    });

    this.win.on('blur', () => {
      if (!this.isPinned && this.win && !this.win.isDestroyed() && this.win.isVisible()) {
        this.hide();
      }
    });

    this.win.on('closed', () => {
      this.win = null;
    });

    return this.win;
  }

  _positionNearTray(trayBounds) {
    if (!this.win || this.win.isDestroyed()) return;
    const { width, height } = this.win.getBounds();

    const hasBounds = trayBounds && trayBounds.width > 0 && trayBounds.height > 0;
    const display = hasBounds
      ? screen.getDisplayMatching(trayBounds)
      : screen.getPrimaryDisplay();
    const wa = display.workArea;

    let x = wa.x + wa.width - width - 12;
    let y = wa.y + wa.height - height - 12;

    if (hasBounds) {
      x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
      x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));

      const isBottom = trayBounds.y >= wa.y + wa.height / 2;
      y = isBottom ? wa.y + wa.height - height - 10 : wa.y + 10;
    }

    this.win.setPosition(x, y, false);
  }

  show(trayBounds) {
    const win = this._ensureWindow();
    if (!this.isPinned) {
      this._positionNearTray(trayBounds);
    }
    this._pushFullSync();
    win.show();
    win.focus();
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.lastHideTime = Date.now();
      this.win.hide();
    }
  }

  toggle(trayBounds) {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.hide();
      return;
    }
    // Prevent immediate re-open when tray click happens right after blur hid the window
    if (Date.now() - this.lastHideTime < 260) {
      this.lastHideTime = 0;
      return;
    }
    this.show(trayBounds);
  }

  togglePin() {
    this.isPinned = !this.isPinned;
    this._pushFullSync();
    return this.isPinned;
  }

  _pushFullSync() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('miniplayer:state', {
      ...this.latestState,
      isPinned: this.isPinned,
      strings: this.latestStrings,
    });
    this.win.webContents.send('miniplayer:theme', this.latestTheme);
  }

  updateState(partial) {
    this.latestState = { ...this.latestState, ...partial };
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.webContents.send('miniplayer:state', {
        ...this.latestState,
        isPinned: this.isPinned,
        strings: this.latestStrings,
      });
    }
  }

  updateLocale(strings) {
    this.latestStrings = strings || null;
    this._pushFullSync();
  }

  updateTime(currentTime) {
    this.latestState.currentTime = currentTime;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.webContents.send('miniplayer:time', currentTime);
    }
  }

  updateTheme(theme) {
    if (theme && Array.isArray(theme.primary) && Array.isArray(theme.secondary)) {
      this.latestTheme = theme;
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
        this.win.webContents.send('miniplayer:theme', this.latestTheme);
      }
    }
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}

module.exports = { MiniPlayerManager };
