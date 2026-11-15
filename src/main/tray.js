const path = require('path');
const { app, Tray, Menu, nativeImage, dialog } = require('electron');
const { resolveLanguage, getTranslations, formatText } = require('../shared/i18n');

class TrayManager {
  constructor({
    settings,
    onToggleWindow,
    onToggleMiniPlayer,
    onPlayerCommand,
    onToggleLyrics,
    onOpenAuthSettings,
    onClearGoogleAuth,
    onReload,
    onQuit,
  }) {
    this.settings = settings;
    this.onToggleWindow = onToggleWindow;
    this.onToggleMiniPlayer = onToggleMiniPlayer;
    this.onPlayerCommand = onPlayerCommand;
    this.onToggleLyrics = onToggleLyrics;
    this.onOpenAuthSettings = onOpenAuthSettings;
    this.onClearGoogleAuth = onClearGoogleAuth;
    this.onReload = onReload;
    this.onQuit = onQuit;
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

  init() {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    this.tray = new Tray(icon);
    this.tray.setToolTip('YouTube Music');
    this.tray.on('click', () => {
      if (this.onToggleMiniPlayer) {
        this.onToggleMiniPlayer(this.tray.getBounds());
      } else {
        this.onToggleWindow();
      }
    });
    this.rebuildMenu();
  }

  updatePlayerState(state) {
    this.playerState = { ...this.playerState, ...state };
    if (this.tray) {
      const trackLabel = this.playerState.title
        ? `${this.playerState.title}${this.playerState.artist ? ' — ' + this.playerState.artist : ''}`
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

    const truncatedTrack = trackText.length > 48 ? trackText.slice(0, 45) + '...' : trackText;
    const currentLangSetting = cfg.language || 'auto';

    const template = [
      {
        label: truncatedTrack,
        enabled: false,
      },
      {
        label: tr.openHideMain,
        click: () => this.onToggleWindow(),
      },
      {
        label: tr.miniPlayer,
        click: () => this.onToggleMiniPlayer && this.onToggleMiniPlayer(this.tray.getBounds()),
      },
      { type: 'separator' },
      {
        label: this.playerState.isPlaying ? `⏸ ${tr.pause}` : `▶ ${tr.play}`,
        click: () => this.onPlayerCommand('toggle'),
      },
      {
        label: `⏭ ${tr.next}`,
        click: () => this.onPlayerCommand('next'),
      },
      {
        label: `⏮ ${tr.prev}`,
        click: () => this.onPlayerCommand('previous'),
      },
      {
        label: `📝 ${tr.toggleLyrics}`,
        click: () => this.onToggleLyrics && this.onToggleLyrics(),
      },
      { type: 'separator' },
      {
        label: tr.settings,
        submenu: [
          {
            label: tr.language,
            submenu: [
              {
                label: tr.langAuto,
                type: 'radio',
                checked: currentLangSetting === 'auto',
                click: () => this.settings.set('language', 'auto'),
              },
              {
                label: tr.langUk,
                type: 'radio',
                checked: currentLangSetting === 'uk',
                click: () => this.settings.set('language', 'uk'),
              },
              {
                label: tr.langEn,
                type: 'radio',
                checked: currentLangSetting === 'en',
                click: () => this.settings.set('language', 'en'),
              },
            ],
          },
          { type: 'separator' },
          {
            label: tr.adBlock,
            type: 'checkbox',
            checked: cfg.adBlockEnabled,
            click: (item) => this.settings.set('adBlockEnabled', item.checked),
          },
          {
            label: tr.sponsorBlock,
            type: 'checkbox',
            checked: cfg.sponsorBlockEnabled,
            click: (item) => this.settings.set('sponsorBlockEnabled', item.checked),
          },
          { type: 'separator' },
          {
            label: tr.ambientTheme,
            type: 'checkbox',
            checked: cfg.ambientThemeEnabled,
            click: (item) => this.settings.set('ambientThemeEnabled', item.checked),
          },
          {
            label: tr.visualizer,
            type: 'checkbox',
            checked: cfg.visualizerEnabled,
            click: (item) => this.settings.set('visualizerEnabled', item.checked),
          },
          {
            label: tr.lyrics,
            type: 'checkbox',
            checked: cfg.lyricsEnabled,
            click: (item) => this.settings.set('lyricsEnabled', item.checked),
          },
          { type: 'separator' },
          {
            label: tr.globalMediaKeys,
            type: 'checkbox',
            checked: cfg.globalMediaKeys,
            click: (item) => this.settings.set('globalMediaKeys', item.checked),
          },
          {
            label: tr.extraHotkeys,
            type: 'checkbox',
            checked: cfg.extraHotkeys,
            click: (item) => this.settings.set('extraHotkeys', item.checked),
          },
          { type: 'separator' },
          {
            label: tr.minimizeToTray,
            type: 'checkbox',
            checked: cfg.minimizeToTray,
            click: (item) => this.settings.set('minimizeToTray', item.checked),
          },
          {
            label: tr.alwaysOnTop,
            type: 'checkbox',
            checked: cfg.alwaysOnTop,
            click: (item) => this.settings.set('alwaysOnTop', item.checked),
          },
          {
            label: tr.autoLaunch,
            type: 'checkbox',
            checked: cfg.autoLaunch,
            click: (item) => this.settings.set('autoLaunch', item.checked),
          },
        ],
      },
      {
        label: tr.googleAccount,
        submenu: [
          {
            label: tr.authModeChrome,
            type: 'radio',
            checked: (cfg.authUserAgentMode || 'chrome') === 'chrome',
            click: () => this.settings.set('authUserAgentMode', 'chrome'),
          },
          {
            label: tr.authModeFirefox,
            type: 'radio',
            checked: cfg.authUserAgentMode === 'firefox',
            click: () => this.settings.set('authUserAgentMode', 'firefox'),
          },
          { type: 'separator' },
          {
            label: tr.clearAuthCache,
            click: () => this.onClearGoogleAuth && this.onClearGoogleAuth(),
          },
          {
            label: tr.importCookiesMenu,
            click: () => this.onOpenAuthSettings && this.onOpenAuthSettings(),
          },
        ],
      },
      {
        label: formatText(tr.statsLabel, {
          ads: cfg.stats?.blockedAds || 0,
          segments: cfg.stats?.skippedSegments || 0,
        }),
        click: () => {
          const current = this.settings.getAll();
          const dialogTr = this._t().tray;
          dialog.showMessageBox({
            type: 'info',
            title: dialogTr.statsDialogTitle,
            message: dialogTr.statsDialogMessage,
            detail: formatText(dialogTr.statsDialogDetail, {
              ads: current.stats?.blockedAds || 0,
              segments: current.stats?.skippedSegments || 0,
            }),
            buttons: ['OK'],
          });
        },
      },
      { type: 'separator' },
      {
        label: tr.reload,
        click: () => this.onReload(),
      },
      {
        label: tr.quit,
        click: () => this.onQuit(),
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

module.exports = { TrayManager };
