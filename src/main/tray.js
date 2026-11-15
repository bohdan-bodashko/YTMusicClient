const path = require('path');
const { app, Tray, Menu, nativeImage, dialog } = require('electron');
const { resolveLanguage, getTranslations, formatText } = require('../shared/i18n');

function sanitizeMenuText(text, maxLen = 300) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function escapeMenuLabel(text) {
  const str = sanitizeMenuText(String(text || ''), 300);
  return process.platform === 'win32' ? str.replace(/&/g, '&&') : str;
}

class TrayManager {
  constructor({
    settings,
    onToggleWindow,
    onOpenMainWindow,
    onToggleMiniPlayer,
    onPlayerCommand,
    onToggleLyrics,
    onOpenAuthSettings,
    onClearGoogleAuth,
    onReload,
    onQuit,
    getDialogParent,
  }) {
    this.settings = settings;
    this.onToggleWindow = onToggleWindow;
    this.onOpenMainWindow = onOpenMainWindow;
    this.onToggleMiniPlayer = onToggleMiniPlayer;
    this.onPlayerCommand = onPlayerCommand;
    this.onToggleLyrics = onToggleLyrics;
    this.onOpenAuthSettings = onOpenAuthSettings;
    this.onClearGoogleAuth = onClearGoogleAuth;
    this.onReload = onReload;
    this.onQuit = onQuit;
    this.getDialogParent = typeof getDialogParent === 'function' ? getDialogParent : () => null;
    this.tray = null;
    this.playerState = {
      isPlaying: false,
      title: '',
      artist: '',
    };
  }

  _t() {
    const lang = resolveLanguage(this.settings.get('language'), app.getLocale());
    return getTranslations(lang);
  }

  getBoundsSafe() {
    if (!this.tray) return null;
    try {
      return this.tray.getBounds();
    } catch {
      return null;
    }
  }

  _loadTrayIcon() {
    const assetsDir = path.join(__dirname, '..', '..', 'assets');
    const candidates = ['tray-icon.png', 'icon.png', 'icon.ico'];
    for (const file of candidates) {
      const img = nativeImage.createFromPath(path.join(assetsDir, file));
      if (!img.isEmpty()) {
        return img;
      }
    }
    return nativeImage.createEmpty();
  }

  init() {
    const icon = this._loadTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('YouTube Music');
    this.tray.on('click', () => {
      if (this.onToggleMiniPlayer) {
        this.onToggleMiniPlayer(this.getBoundsSafe());
      } else if (this.onToggleWindow) {
        this.onToggleWindow();
      }
    });
    this.tray.on('double-click', () => {
      if (this.onOpenMainWindow) {
        this.onOpenMainWindow();
      } else if (this.onToggleWindow) {
        this.onToggleWindow(true);
      }
    });
    this.rebuildMenu();
  }

  updatePlayerState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    const nextIsPlaying = Boolean(state.isPlaying);
    const nextTitle = sanitizeMenuText(state.title, 200);
    const nextArtist = sanitizeMenuText(state.artist, 200);

    if (
      this.playerState.isPlaying === nextIsPlaying &&
      this.playerState.title === nextTitle &&
      this.playerState.artist === nextArtist
    ) {
      return;
    }

    this.playerState = {
      isPlaying: nextIsPlaying,
      title: nextTitle,
      artist: nextArtist,
    };

    if (this.tray) {
      const statusIcon = nextIsPlaying ? '▶' : '⏸';
      const trackLabel = nextTitle
        ? `${statusIcon} ${nextTitle}${nextArtist ? ' — ' + nextArtist : ''}`
        : 'YouTube Music';
      this.tray.setToolTip(trackLabel.slice(0, 127));
      this.rebuildMenu();
    }
  }

  rebuildMenu() {
    if (!this.tray) return;

    const cfg = this.settings.getAll();
    const tr = this._t().tray;
    const trackText = this.playerState.title
      ? `♪ ${this.playerState.title}${this.playerState.artist ? ' — ' + this.playerState.artist : ''}`
      : `♪ ${tr.nothingPlaying}`;

    const truncatedTrack = trackText.length > 48 ? `${trackText.slice(0, 45)}...` : trackText;
    const currentLangSetting = cfg.language || 'auto';

    const template = [
      {
        label: escapeMenuLabel(truncatedTrack),
        enabled: false,
      },
      {
        label: escapeMenuLabel(tr.openHideMain),
        click: () => this.onToggleWindow && this.onToggleWindow(),
      },
      {
        label: escapeMenuLabel(tr.miniPlayer),
        click: () => this.onToggleMiniPlayer && this.onToggleMiniPlayer(this.getBoundsSafe()),
      },
      { type: 'separator' },
      {
        label: escapeMenuLabel(this.playerState.isPlaying ? `⏸ ${tr.pause}` : `▶ ${tr.play}`),
        click: () => this.onPlayerCommand && this.onPlayerCommand('toggle'),
      },
      {
        label: escapeMenuLabel(`⏭ ${tr.next}`),
        click: () => this.onPlayerCommand && this.onPlayerCommand('next'),
      },
      {
        label: escapeMenuLabel(`⏮ ${tr.prev}`),
        click: () => this.onPlayerCommand && this.onPlayerCommand('previous'),
      },
      {
        label: escapeMenuLabel(`📝 ${tr.toggleLyrics}`),
        click: () => this.onToggleLyrics && this.onToggleLyrics(),
      },
      { type: 'separator' },
      {
        label: escapeMenuLabel(tr.settings),
        submenu: [
          {
            label: escapeMenuLabel(tr.language),
            submenu: [
              {
                label: escapeMenuLabel(tr.langAuto),
                type: 'radio',
                checked: currentLangSetting === 'auto',
                click: () => this.settings.set('language', 'auto'),
              },
              {
                label: escapeMenuLabel(tr.langUk),
                type: 'radio',
                checked: currentLangSetting === 'uk',
                click: () => this.settings.set('language', 'uk'),
              },
              {
                label: escapeMenuLabel(tr.langEn),
                type: 'radio',
                checked: currentLangSetting === 'en',
                click: () => this.settings.set('language', 'en'),
              },
            ],
          },
          { type: 'separator' },
          {
            label: escapeMenuLabel(tr.adBlock),
            type: 'checkbox',
            checked: Boolean(cfg.adBlockEnabled),
            click: (item) => this.settings.set('adBlockEnabled', item.checked),
          },
          {
            label: escapeMenuLabel(tr.sponsorBlock),
            type: 'checkbox',
            checked: Boolean(cfg.sponsorBlockEnabled),
            click: (item) => this.settings.set('sponsorBlockEnabled', item.checked),
          },
          { type: 'separator' },
          {
            label: escapeMenuLabel(tr.ambientTheme),
            type: 'checkbox',
            checked: Boolean(cfg.ambientThemeEnabled),
            click: (item) => this.settings.set('ambientThemeEnabled', item.checked),
          },
          {
            label: escapeMenuLabel(tr.visualizer),
            type: 'checkbox',
            checked: Boolean(cfg.visualizerEnabled),
            click: (item) => this.settings.set('visualizerEnabled', item.checked),
          },
          {
            label: escapeMenuLabel(tr.lyrics),
            type: 'checkbox',
            checked: Boolean(cfg.lyricsEnabled),
            click: (item) => this.settings.set('lyricsEnabled', item.checked),
          },
          { type: 'separator' },
          {
            label: escapeMenuLabel(tr.globalMediaKeys),
            type: 'checkbox',
            checked: Boolean(cfg.globalMediaKeys),
            click: (item) => this.settings.set('globalMediaKeys', item.checked),
          },
          {
            label: escapeMenuLabel(tr.extraHotkeys),
            type: 'checkbox',
            checked: Boolean(cfg.extraHotkeys),
            click: (item) => this.settings.set('extraHotkeys', item.checked),
          },
          { type: 'separator' },
          {
            label: escapeMenuLabel(tr.minimizeToTray),
            type: 'checkbox',
            checked: Boolean(cfg.minimizeToTray),
            click: (item) => this.settings.set('minimizeToTray', item.checked),
          },
          {
            label: escapeMenuLabel(tr.alwaysOnTop),
            type: 'checkbox',
            checked: Boolean(cfg.alwaysOnTop),
            click: (item) => this.settings.set('alwaysOnTop', item.checked),
          },
          {
            label: escapeMenuLabel(tr.autoLaunch),
            type: 'checkbox',
            checked: Boolean(cfg.autoLaunch),
            click: (item) => this.settings.set('autoLaunch', item.checked),
          },
        ],
      },
      {
        label: escapeMenuLabel(tr.googleAccount),
        submenu: [
          {
            label: escapeMenuLabel(tr.authModeChrome),
            type: 'radio',
            checked: (cfg.authUserAgentMode || 'chrome') === 'chrome',
            click: () => this.settings.set('authUserAgentMode', 'chrome'),
          },
          {
            label: escapeMenuLabel(tr.authModeFirefox),
            type: 'radio',
            checked: cfg.authUserAgentMode === 'firefox',
            click: () => this.settings.set('authUserAgentMode', 'firefox'),
          },
          { type: 'separator' },
          {
            label: escapeMenuLabel(tr.clearAuthCache),
            click: () => this.onClearGoogleAuth && this.onClearGoogleAuth(),
          },
          {
            label: escapeMenuLabel(tr.importCookiesMenu),
            click: () => this.onOpenAuthSettings && this.onOpenAuthSettings(),
          },
        ],
      },
      {
        label: escapeMenuLabel(
          formatText(tr.statsLabel, {
            ads: cfg.stats?.blockedAds || 0,
            segments: cfg.stats?.skippedSegments || 0,
          })
        ),
        click: () => {
          const current = this.settings.getAll();
          const dialogTr = this._t().tray;
          const parent = this.getDialogParent();
          const options = {
            type: 'info',
            title: dialogTr.statsDialogTitle,
            message: dialogTr.statsDialogMessage,
            detail: formatText(dialogTr.statsDialogDetail, {
              ads: current.stats?.blockedAds || 0,
              segments: current.stats?.skippedSegments || 0,
            }),
            buttons: ['OK'],
          };
          const promise = parent
            ? dialog.showMessageBox(parent, options)
            : dialog.showMessageBox(options);
          promise.catch(() => {});
        },
      },
      { type: 'separator' },
      {
        label: escapeMenuLabel(tr.reload),
        click: () => this.onReload && this.onReload(),
      },
      {
        label: escapeMenuLabel(tr.quit),
        click: () => this.onQuit && this.onQuit(),
      },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayManager, escapeMenuLabel };
