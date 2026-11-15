const path = require('path');
const { BrowserWindow } = require('electron');

const SETTINGS_URL = 'ytmc-app://local/settings.html';

class SettingsWindowManager {
  constructor() {
    this.win = null;
    this._creating = false;
    this._isLoaded = false;
    this._pendingShow = false;
    this._pendingTab = 'general';
  }

  isOwnWebContents(contents) {
    if (!contents) return false;
    if (this._creating) return true;
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === contents);
  }

  _normalizeTab(tab) {
    return tab === 'auth' ? 'auth' : 'general';
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    this._isLoaded = false;
    this._pendingShow = false;
    this._creating = true;
    try {
      this.win = new BrowserWindow({
        width: 580,
        height: 680,
        minWidth: 480,
        minHeight: 520,
        autoHideMenuBar: true,
        backgroundColor: '#141419',
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
        show: false,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'settings.js'),
          partition: 'settings',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
        },
      });
    } finally {
      this._creating = false;
    }

    this.win.setMenuBarVisibility(false);

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
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('settings:init-tab', this._pendingTab);
        if (this._pendingShow) {
          this._pendingShow = false;
          if (this.win.isMinimized()) this.win.restore();
          this.win.show();
          this.win.focus();
        }
      }
    });

    this.win.once('ready-to-show', () => {
      if (this._pendingShow && this._isLoaded && this.win && !this.win.isDestroyed()) {
        this._pendingShow = false;
        this.win.show();
        this.win.focus();
      }
    });

    this.win.webContents.on('render-process-gone', () => {
      this._isLoaded = false;
      this._pendingShow = false;
      this.destroy();
    });

    this.win.on('closed', () => {
      this._isLoaded = false;
      this._pendingShow = false;
      this.win = null;
    });

    this.win.loadURL(SETTINGS_URL).catch(() => {});

    return this.win;
  }

  open(tab = 'general') {
    const nextTab = this._normalizeTab(tab);
    this._pendingTab = nextTab;
    const win = this._ensureWindow();

    if (!this._isLoaded) {
      this._pendingShow = true;
      return;
    }

    win.webContents.send('settings:init-tab', nextTab);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  close() {
    this._pendingShow = false;
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
  }

  sendSettingsUpdated(cfg) {
    if (this.win && !this.win.isDestroyed() && this._isLoaded) {
      this.win.webContents.send('settings:updated', cfg);
    }
  }

  sendStatsUpdated(stats) {
    if (this.win && !this.win.isDestroyed() && this._isLoaded) {
      this.win.webContents.send('stats:updated', stats);
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

module.exports = { SettingsWindowManager };
