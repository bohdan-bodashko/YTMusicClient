const path = require('path');
const { Tray, Menu, nativeImage, dialog } = require('electron');

class TrayManager {
  constructor({ settings, onToggleWindow, onToggleMiniPlayer, onPlayerCommand, onToggleLyrics, onOpenAuthSettings, onClearGoogleAuth, onReload, onQuit }) {
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
    const trackText = this.playerState.title
      ? `♪ ${this.playerState.title}${this.playerState.artist ? ' — ' + this.playerState.artist : ''}`
      : '♪ Нічого не відтворюється';

    const truncatedTrack = trackText.length > 48 ? trackText.slice(0, 45) + '...' : trackText;

    const template = [
      {
        label: truncatedTrack,
        enabled: false,
      },
      {
        label: 'Відкрити / Сховати головне вікно',
        click: () => this.onToggleWindow(),
      },
      {
        label: 'Міні-плеєр',
        click: () => this.onToggleMiniPlayer && this.onToggleMiniPlayer(this.tray.getBounds()),
      },
      { type: 'separator' },
      {
        label: this.playerState.isPlaying ? '⏸ Пауза' : '▶ Відтворити',
        click: () => this.onPlayerCommand('toggle'),
      },
      {
        label: '⏭ Наступний трек',
        click: () => this.onPlayerCommand('next'),
      },
      {
        label: '⏮ Попередній трек',
        click: () => this.onPlayerCommand('previous'),
      },
      {
        label: '📝 Показати / сховати текст пісні',
        click: () => this.onToggleLyrics && this.onToggleLyrics(),
      },
      { type: 'separator' },
      {
        label: 'Налаштування',
        submenu: [
          {
            label: 'Блокування реклами (AdBlock)',
            type: 'checkbox',
            checked: cfg.adBlockEnabled,
            click: (item) => this.settings.set('adBlockEnabled', item.checked),
          },
          {
            label: 'SponsorBlock (пропуск пауз/інтро)',
            type: 'checkbox',
            checked: cfg.sponsorBlockEnabled,
            click: (item) => this.settings.set('sponsorBlockEnabled', item.checked),
          },
          { type: 'separator' },
          {
            label: 'Адаптивний фон під обкладинку',
            type: 'checkbox',
            checked: cfg.ambientThemeEnabled,
            click: (item) => this.settings.set('ambientThemeEnabled', item.checked),
          },
          {
            label: 'Аудіовізуалізатор',
            type: 'checkbox',
            checked: cfg.visualizerEnabled,
            click: (item) => this.settings.set('visualizerEnabled', item.checked),
          },
          {
            label: 'Синхронізовані тексти (Ctrl+L)',
            type: 'checkbox',
            checked: cfg.lyricsEnabled,
            click: (item) => this.settings.set('lyricsEnabled', item.checked),
          },
          { type: 'separator' },
          {
            label: 'Глобальні медіа-клавіші',
            type: 'checkbox',
            checked: cfg.globalMediaKeys,
            click: (item) => this.settings.set('globalMediaKeys', item.checked),
          },
          {
            label: 'Додаткові клавіші (Ctrl+Alt+Space / ← / →)',
            type: 'checkbox',
            checked: cfg.extraHotkeys,
            click: (item) => this.settings.set('extraHotkeys', item.checked),
          },
          { type: 'separator' },
          {
            label: 'Згортати в трей при закритті',
            type: 'checkbox',
            checked: cfg.minimizeToTray,
            click: (item) => this.settings.set('minimizeToTray', item.checked),
          },
          {
            label: 'Завжди зверху',
            type: 'checkbox',
            checked: cfg.alwaysOnTop,
            click: (item) => this.settings.set('alwaysOnTop', item.checked),
          },
          {
            label: 'Автозапуск з Windows',
            type: 'checkbox',
            checked: cfg.autoLaunch,
            click: (item) => this.settings.set('autoLaunch', item.checked),
          },
        ],
      },
      {
        label: 'Акаунт Google',
        submenu: [
          {
            label: 'Режим входу: Chrome (рекомендовано)',
            type: 'radio',
            checked: (cfg.authUserAgentMode || 'chrome') === 'chrome',
            click: () => this.settings.set('authUserAgentMode', 'chrome'),
          },
          {
            label: 'Режим входу: Firefox (резервний)',
            type: 'radio',
            checked: cfg.authUserAgentMode === 'firefox',
            click: () => this.settings.set('authUserAgentMode', 'firefox'),
          },
          { type: 'separator' },
          {
            label: 'Очистити кеш входу Google',
            click: () => this.onClearGoogleAuth && this.onClearGoogleAuth(),
          },
          {
            label: 'Увійти через cookies з браузера...',
            click: () => this.onOpenAuthSettings && this.onOpenAuthSettings(),
          },
        ],
      },
      {
        label: `Статистика: ${cfg.stats?.blockedAds || 0} рекл. / ${cfg.stats?.skippedSegments || 0} сегм.`,
        click: () => {
          const current = this.settings.getAll();
          dialog.showMessageBox({
            type: 'info',
            title: 'Статистика YouTube Music Client',
            message: 'Статистика захисту та пропусків',
            detail:
              `Заблоковано рекламних запитів / роликів: ${current.stats?.blockedAds || 0}\n` +
              `Пропущено фрагментів SponsorBlock: ${current.stats?.skippedSegments || 0}\n\n` +
              `Підказка: натисніть Ctrl+, у вікні програми для швидких налаштувань.`,
            buttons: ['OK'],
          });
        },
      },
      { type: 'separator' },
      {
        label: 'Відкрити / Сховати вікно',
        click: () => this.onToggleWindow(),
      },
      {
        label: 'Перезавантажити сторінку',
        click: () => this.onReload(),
      },
      {
        label: 'Вийти',
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
