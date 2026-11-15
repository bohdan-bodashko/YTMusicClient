const TRANSLATIONS = {
  uk: {
    app: {
      title: 'YouTube Music',
    },
    tray: {
      nothingPlaying: 'Нічого не відтворюється',
      openHideMain: 'Відкрити / Сховати головне вікно',
      miniPlayer: 'Міні-плеєр',
      pause: 'Пауза',
      play: 'Відтворити',
      next: 'Наступний трек',
      prev: 'Попередній трек',
      toggleLyrics: 'Показати / сховати текст пісні',
      settings: 'Налаштування',
      language: 'Мова / Language',
      langAuto: 'Авто (за системою)',
      langUk: 'Українська',
      langEn: 'English',
      adBlock: 'Блокування реклами (AdBlock)',
      sponsorBlock: 'SponsorBlock (пропуск пауз/інтро)',
      ambientTheme: 'Адаптивний фон під обкладинку',
      visualizer: 'Аудіовізуалізатор',
      lyrics: 'Синхронізовані тексти (Ctrl+L)',
      globalMediaKeys: 'Глобальні медіа-клавіші',
      extraHotkeys: 'Додаткові клавіші (Ctrl+Alt+Space / ← / →)',
      minimizeToTray: 'Згортати в трей при закритті',
      alwaysOnTop: 'Завжди зверху',
      autoLaunch: 'Автозапуск з Windows',
      googleAccount: 'Акаунт Google',
      authModeChrome: 'Режим входу: Chrome (рекомендовано)',
      authModeFirefox: 'Режим входу: Firefox (резервний)',
      clearAuthCache: 'Очистити кеш входу Google',
      importCookiesMenu: 'Увійти через cookies з браузера...',
      statsLabel: 'Статистика: {ads} рекл. / {segments} сегм.',
      statsDialogTitle: 'Статистика YouTube Music Client',
      statsDialogMessage: 'Статистика захисту та пропусків',
      statsDialogDetail:
        'Заблоковано рекламних запитів / роликів: {ads}\n' +
        'Пропущено фрагментів SponsorBlock: {segments}\n\n' +
        'Підказка: натисніть Ctrl+, у вікні програми для швидких налаштувань.',
      reload: 'Перезавантажити сторінку',
      quit: 'Вийти',
    },
    thumbar: {
      prev: 'Попередній трек',
      play: 'Відтворити',
      pause: 'Пауза',
      next: 'Наступний трек',
    },
    settingsModal: {
      title: 'Налаштування YT Music Client',
      tabGeneral: 'Основні',
      tabAuth: 'Вхід в акаунт Google',
      languageLabel: 'Мова інтерфейсу',
      langAuto: 'Авто (система)',
      langUk: 'Українська',
      langEn: 'English',
      adBlock: 'Блокування реклами та трекінгу (AdBlock)',
      sponsorBlock: 'SponsorBlock (пропуск пауз, інтро, аутро)',
      ambientTheme: 'Адаптивний фон під обкладинку треку',
      visualizer: 'Аудіовізуалізатор у панелі плеєра',
      lyrics: 'Синхронізовані тексти пісень (Ctrl+L)',
      globalMediaKeys: 'Глобальні медіа-клавіші (Play/Pause, Next, Prev)',
      extraHotkeys: 'Додаткові клавіші (Ctrl+Alt+Space / ← / →)',
      minimizeToTray: 'Згортати в системний трей при закритті',
      alwaysOnTop: 'Вікно завжди зверху',
      autoLaunch: 'Автозапуск разом із Windows',
      statsSummary: 'Заблоковано реклами: {ads}   •   Пропущено SponsorBlock: {segments}',
      hint: 'Підказка: натисніть Ctrl+, у будь-який момент, щоб відкрити або закрити це вікно.',
      authModeTitle: '1. Режим сумісності входу Google (якщо блокує звичайний вхід):',
      authChrome: 'Chrome (стандартний)',
      authFirefox: 'Firefox (резервний)',
      authResetBtn: 'Очистити кеш входу й оновити',
      cookieTitle: '2. Гарантований вхід через cookies зі звичайного браузера:',
      cookieSteps:
        'Якщо Google все одно пише «додаток може бути небезпечним»: 1) Відкрийте music.youtube.com у Chrome/Edge і увійдіть там. ' +
        '2) Натисніть F12 → Network (Мережа) → оновіть сторінку (F5) → оберіть запит music.youtube.com → скопіюйте заголовок запиту Cookie: (Request Headers). ' +
        '3) Вставте його нижче і натисніть «Імпортувати та увійти».',
      cookiePlaceholder: 'Вставте сюди рядок Cookie (наприклад: HSID=...; SSID=...; SAPISID=...;)',
      openBrowserBtn: 'Відкрити music.youtube.com у браузері',
      importBtn: 'Імпортувати та увійти',
      importErrorFallback: 'Не вдалося імпортувати cookies.',
    },
    lyrics: {
      syncLabel: 'Синхр: {offset}с',
      minusHalf: '-0.5с',
      plusHalf: '+0.5с',
      reset: 'Скинути',
      nativeBtn: 'Текст YT',
      backToSynced: '← Повернутися до синхронізованого тексту',
      empty: 'Увімкніть трек, щоб завантажити синхронізований текст.',
      loading: 'Пошук синхронізованого тексту...',
      plainBadge: 'Звичайний текст (без таймінгів)',
      notFound: 'Синхронізований текст для цього треку не знайдено у базі LRCLIB.',
      lyricsBtnTooltip: 'Синхронізований текст пісні (Ctrl+L)',
      settingsBtnTooltip: 'Налаштування YT Music Client (Ctrl+,)',
    },
    sponsorBlock: {
      skippedToast: 'SponsorBlock: пропущено ({category})',
      categories: {
        music_offtopic: 'не-музична частина',
        sponsor: 'спонсор',
        selfpromo: 'самопромо',
        interaction: 'інтерактив/прохання',
        intro: 'інтро',
        outro: 'аутро',
      },
    },
    miniPlayer: {
      title: 'YouTube Music — Міні-плеєр',
      pin: 'Закріпити поверх вікон',
      openMain: 'Відкрити головне вікно',
      close: 'Сховати міні-плеєр',
      nothingPlaying: 'Нічого не відтворюється',
      prev: 'Попередній трек',
      playPause: 'Відтворити / Пауза',
      next: 'Наступний трек',
      volume: 'Гучність',
    },
    authErrors: {
      noCookiesFound: 'Не знайдено жодного коректного cookie у вставленому тексті.',
    },
  },
  en: {
    app: {
      title: 'YouTube Music',
    },
    tray: {
      nothingPlaying: 'Nothing playing',
      openHideMain: 'Show / Hide Main Window',
      miniPlayer: 'Mini Player',
      pause: 'Pause',
      play: 'Play',
      next: 'Next track',
      prev: 'Previous track',
      toggleLyrics: 'Toggle Lyrics Tab',
      settings: 'Settings',
      language: 'Language / Мова',
      langAuto: 'Auto (System)',
      langUk: 'Українська',
      langEn: 'English',
      adBlock: 'Ad & Tracker Blocking (AdBlock)',
      sponsorBlock: 'SponsorBlock (skip non-music/intro)',
      ambientTheme: 'Adaptive Album Background',
      visualizer: 'Audio Visualizer',
      lyrics: 'Synced Lyrics (Ctrl+L)',
      globalMediaKeys: 'Global Media Keys',
      extraHotkeys: 'Extra Hotkeys (Ctrl+Alt+Space / ← / →)',
      minimizeToTray: 'Minimize to tray on close',
      alwaysOnTop: 'Always on top',
      autoLaunch: 'Launch with Windows',
      googleAccount: 'Google Account',
      authModeChrome: 'Sign-in mode: Chrome (recommended)',
      authModeFirefox: 'Sign-in mode: Firefox (fallback)',
      clearAuthCache: 'Clear Google Sign-In cache',
      importCookiesMenu: 'Sign in via browser cookies...',
      statsLabel: 'Stats: {ads} ads / {segments} seg.',
      statsDialogTitle: 'YouTube Music Client Stats',
      statsDialogMessage: 'Protection & Skip Statistics',
      statsDialogDetail:
        'Blocked ad requests / ads: {ads}\n' +
        'Skipped SponsorBlock segments: {segments}\n\n' +
        'Tip: press Ctrl+, inside the app window for quick settings.',
      reload: 'Reload page',
      quit: 'Quit',
    },
    thumbar: {
      prev: 'Previous track',
      play: 'Play',
      pause: 'Pause',
      next: 'Next track',
    },
    settingsModal: {
      title: 'YT Music Client Settings',
      tabGeneral: 'General',
      tabAuth: 'Google Sign-In',
      languageLabel: 'Interface language',
      langAuto: 'Auto (System)',
      langUk: 'Українська',
      langEn: 'English',
      adBlock: 'Ad & tracker blocking (AdBlock)',
      sponsorBlock: 'SponsorBlock (skip non-music, intro, outro)',
      ambientTheme: 'Adaptive album-art background',
      visualizer: 'Audio visualizer in player bar',
      lyrics: 'Synced lyrics (Ctrl+L)',
      globalMediaKeys: 'Global media keys (Play/Pause, Next, Prev)',
      extraHotkeys: 'Extra hotkeys (Ctrl+Alt+Space / ← / →)',
      minimizeToTray: 'Minimize to system tray on close',
      alwaysOnTop: 'Always on top',
      autoLaunch: 'Launch automatically with Windows',
      statsSummary: 'Blocked ads: {ads}   •   SponsorBlock skips: {segments}',
      hint: 'Tip: press Ctrl+, anytime to open or close this window.',
      authModeTitle: '1. Google Sign-In compatibility mode (if default sign-in is blocked):',
      authChrome: 'Chrome (standard)',
      authFirefox: 'Firefox (fallback)',
      authResetBtn: 'Clear sign-in cache & reload',
      cookieTitle: '2. Guaranteed sign-in via regular browser cookies:',
      cookieSteps:
        'If Google still says "this browser or app may not be secure": 1) Open music.youtube.com in Chrome/Edge and sign in there. ' +
        '2) Press F12 → Network → reload (F5) → select any music.youtube.com request → copy the Cookie: Request Header value. ' +
        '3) Paste it below and click "Import & Sign In".',
      cookiePlaceholder: 'Paste Cookie header string here (e.g. HSID=...; SSID=...; SAPISID=...;)',
      openBrowserBtn: 'Open music.youtube.com in browser',
      importBtn: 'Import & Sign In',
      importErrorFallback: 'Failed to import cookies.',
    },
    lyrics: {
      syncLabel: 'Sync: {offset}s',
      minusHalf: '-0.5s',
      plusHalf: '+0.5s',
      reset: 'Reset',
      nativeBtn: 'YT Lyrics',
      backToSynced: '← Back to synced lyrics',
      empty: 'Play a track to load synced lyrics.',
      loading: 'Searching for synced lyrics...',
      plainBadge: 'Plain lyrics (unsynced)',
      notFound: 'No synced lyrics found for this track on LRCLIB.',
      lyricsBtnTooltip: 'Synced Lyrics (Ctrl+L)',
      settingsBtnTooltip: 'YT Music Client Settings (Ctrl+,)',
    },
    sponsorBlock: {
      skippedToast: 'SponsorBlock: skipped ({category})',
      categories: {
        music_offtopic: 'non-music section',
        sponsor: 'sponsor',
        selfpromo: 'self-promotion',
        interaction: 'interaction reminder',
        intro: 'intro',
        outro: 'outro',
      },
    },
    miniPlayer: {
      title: 'YouTube Music — Mini Player',
      pin: 'Pin on top',
      openMain: 'Open main window',
      close: 'Hide mini player',
      nothingPlaying: 'Nothing playing',
      prev: 'Previous track',
      playPause: 'Play / Pause',
      next: 'Next track',
      volume: 'Volume',
    },
    authErrors: {
      noCookiesFound: 'No valid cookies found in the pasted text.',
    },
  },
};

function resolveLanguage(settingLang = 'auto', systemLocale = '') {
  if (settingLang === 'uk' || settingLang === 'en') {
    return settingLang;
  }
  const locale = String(systemLocale || '').toLowerCase();
  if (locale.startsWith('uk')) {
    return 'uk';
  }
  return 'en';
}

function getTranslations(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

function formatText(template, vars = {}) {
  let out = String(template || '');
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

module.exports = {
  TRANSLATIONS,
  resolveLanguage,
  getTranslations,
  formatText,
};
