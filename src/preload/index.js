const fs = require('fs');
const path = require('path');
const { ipcRenderer, webFrame } = require('electron');
const { createEnhancementsController } = require('./enhancements');

const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'myaccount.google.com',
  'signin.google.com',
  'ogs.google.com',
]);

function getHostname() {
  try {
    return window.location.hostname.toLowerCase();
  } catch {
    return '';
  }
}

const hostname = getHostname();
const isMusicHost = hostname === 'music.youtube.com';
const isAuthHost = AUTH_HOSTS.has(hostname);

function postToPage(type, payload) {
  window.postMessage({ source: 'ytmc-preload', type, payload }, '*');
}

let currentSettings = null;
let modalOverlay = null;
let enhancements = null;

function closeModal() {
  if (modalOverlay) {
    modalOverlay.remove();
    modalOverlay = null;
  }
}

function makeButton(label, bg = 'rgba(255,255,255,0.1)', color = '#f1f1f1') {
  const btn = document.createElement('button');
  btn.textContent = label;
  Object.assign(btn.style, {
    background: bg,
    color,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '8px',
    padding: '8px 12px',
    fontSize: '12.5px',
    fontWeight: '500',
    cursor: 'pointer',
  });
  return btn;
}

function createSettingsModal(initialTab = 'general') {
  if (!document.body) return;
  if (modalOverlay) {
    closeModal();
    if (initialTab === 'general') return;
  }

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1000000',
    background: 'rgba(0, 0, 0, 0.74)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'Roboto, Segoe UI, sans-serif',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    width: '490px',
    maxWidth: '94vw',
    maxHeight: '88vh',
    overflowY: 'auto',
    background: '#181818',
    color: '#f1f1f1',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    borderRadius: '14px',
    padding: '20px 22px',
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.65)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '14px',
  });

  const title = document.createElement('h2');
  title.textContent = 'Налаштування YT Music Client';
  Object.assign(title.style, {
    margin: '0',
    fontSize: '17px',
    fontWeight: '600',
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'transparent',
    border: 'none',
    color: '#aaa',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
  });
  closeBtn.addEventListener('click', closeModal);

  header.appendChild(title);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // Tabs
  const tabsBar = document.createElement('div');
  Object.assign(tabsBar.style, {
    display: 'flex',
    gap: '8px',
    marginBottom: '16px',
  });

  const tabGeneralBtn = makeButton('Основні');
  const tabAuthBtn = makeButton('Вхід в акаунт Google');
  tabsBar.appendChild(tabGeneralBtn);
  tabsBar.appendChild(tabAuthBtn);
  card.appendChild(tabsBar);

  const bodyContainer = document.createElement('div');
  card.appendChild(bodyContainer);

  function setTabVisual(active) {
    tabGeneralBtn.style.background = active === 'general' ? '#ff0033' : 'rgba(255,255,255,0.08)';
    tabAuthBtn.style.background = active === 'auth' ? '#ff0033' : 'rgba(255,255,255,0.08)';
  }

  function renderGeneralTab() {
    setTabVisual('general');
    bodyContainer.replaceChildren();

    const options = [
      { key: 'adBlockEnabled', label: 'Блокування реклами та трекінгу (AdBlock)' },
      { key: 'sponsorBlockEnabled', label: 'SponsorBlock (пропуск пауз, інтро, аутро)' },
      { key: 'ambientThemeEnabled', label: 'Адаптивний фон під обкладинку треку' },
      { key: 'visualizerEnabled', label: 'Аудіовізуалізатор у панелі плеєра' },
      { key: 'lyricsEnabled', label: 'Синхронізовані тексти пісень (Ctrl+L)' },
      { key: 'globalMediaKeys', label: 'Глобальні медіа-клавіші (Play/Pause, Next, Prev)' },
      { key: 'extraHotkeys', label: 'Додаткові клавіші (Ctrl+Alt+Space / ← / →)' },
      { key: 'minimizeToTray', label: 'Згортати в системний трей при закритті' },
      { key: 'alwaysOnTop', label: 'Вікно завжди зверху' },
      { key: 'autoLaunch', label: 'Автозапуск разом із Windows' },
    ];

    const list = document.createElement('div');
    Object.assign(list.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '9px',
    });

    for (const opt of options) {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'rgba(255, 255, 255, 0.04)',
        cursor: 'pointer',
        fontSize: '13.5px',
      });

      const text = document.createElement('span');
      text.textContent = opt.label;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(currentSettings && currentSettings[opt.key]);
      Object.assign(checkbox.style, {
        width: '17px',
        height: '17px',
        accentColor: '#ff0033',
        cursor: 'pointer',
      });

      checkbox.addEventListener('change', async () => {
        currentSettings = await ipcRenderer.invoke('settings:update', {
          [opt.key]: checkbox.checked,
        });
        postToPage('config', {
          adBlockEnabled: currentSettings.adBlockEnabled,
          sponsorBlockEnabled: currentSettings.sponsorBlockEnabled,
          visualizerEnabled: currentSettings.visualizerEnabled,
        });
        if (enhancements) {
          enhancements.applySettings(currentSettings);
        }
      });

      row.appendChild(text);
      row.appendChild(checkbox);
      list.appendChild(row);
    }
    bodyContainer.appendChild(list);

    const statsBox = document.createElement('div');
    Object.assign(statsBox.style, {
      marginTop: '14px',
      padding: '10px 12px',
      borderRadius: '8px',
      background: 'rgba(255, 0, 51, 0.09)',
      border: '1px solid rgba(255, 0, 51, 0.25)',
      fontSize: '12.5px',
      color: '#e5e5e5',
    });
    const adsCount = (currentSettings && currentSettings.stats && currentSettings.stats.blockedAds) || 0;
    const sbCount = (currentSettings && currentSettings.stats && currentSettings.stats.skippedSegments) || 0;
    statsBox.textContent = `Заблоковано реклами: ${adsCount}   •   Пропущено SponsorBlock: ${sbCount}`;
    bodyContainer.appendChild(statsBox);
  }

  function renderAuthTab() {
    setTabVisual('auth');
    bodyContainer.replaceChildren();

    const modeSection = document.createElement('div');
    Object.assign(modeSection.style, {
      padding: '12px',
      borderRadius: '10px',
      background: 'rgba(255,255,255,0.04)',
      marginBottom: '14px',
    });

    const modeTitle = document.createElement('div');
    modeTitle.textContent = '1. Режим сумісності входу Google (якщо блокує звичайний вхід):';
    Object.assign(modeTitle.style, { fontSize: '13px', fontWeight: '600', marginBottom: '8px' });
    modeSection.appendChild(modeTitle);

    const modeSelectRow = document.createElement('div');
    Object.assign(modeSelectRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

    const btnChrome = makeButton('Chrome (стандартний)');
    const btnFirefox = makeButton('Firefox (резервний)');

    function refreshModeButtons(mode) {
      btnChrome.style.background = mode === 'chrome' ? '#ff0033' : 'rgba(255,255,255,0.08)';
      btnFirefox.style.background = mode === 'firefox' ? '#ff0033' : 'rgba(255,255,255,0.08)';
    }
    refreshModeButtons((currentSettings && currentSettings.authUserAgentMode) || 'chrome');

    btnChrome.addEventListener('click', async () => {
      currentSettings = await ipcRenderer.invoke('settings:update', { authUserAgentMode: 'chrome' });
      refreshModeButtons('chrome');
    });
    btnFirefox.addEventListener('click', async () => {
      currentSettings = await ipcRenderer.invoke('settings:update', { authUserAgentMode: 'firefox' });
      refreshModeButtons('firefox');
    });

    const btnResetAuth = makeButton('Очистити кеш входу й оновити');
    btnResetAuth.addEventListener('click', async () => {
      await ipcRenderer.invoke('auth:clear-cookies');
      closeModal();
    });

    modeSelectRow.appendChild(btnChrome);
    modeSelectRow.appendChild(btnFirefox);
    modeSelectRow.appendChild(btnResetAuth);
    modeSection.appendChild(modeSelectRow);
    bodyContainer.appendChild(modeSection);

    // Cookie import fallback
    const cookieSection = document.createElement('div');
    Object.assign(cookieSection.style, {
      padding: '12px',
      borderRadius: '10px',
      background: 'rgba(255,255,255,0.04)',
    });

    const cookieTitle = document.createElement('div');
    cookieTitle.textContent = '2. Гарантований вхід через cookies зі звичайного браузера:';
    Object.assign(cookieTitle.style, { fontSize: '13px', fontWeight: '600', marginBottom: '6px' });
    cookieSection.appendChild(cookieTitle);

    const steps = document.createElement('div');
    steps.textContent =
      'Якщо Google все одно пише «додаток може бути небезпечним»: 1) Відкрийте music.youtube.com у Chrome/Edge і увійдіть там. ' +
      '2) Натисніть F12 → Network (Мережа) → оновіть сторінку (F5) → оберіть запит music.youtube.com → скопіюйте заголовок запиту Cookie: (Request Headers). ' +
      '3) Вставте його нижче і натисніть «Імпортувати та увійти».';
    Object.assign(steps.style, {
      fontSize: '12px',
      lineHeight: '1.45',
      color: '#bdbdbd',
      marginBottom: '10px',
    });
    cookieSection.appendChild(steps);

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Вставте сюди рядок Cookie (наприклад: HSID=...; SSID=...; SAPISID=...;)';
    Object.assign(textarea.style, {
      width: '100%',
      boxSizing: 'border-box',
      minHeight: '84px',
      background: '#0e0e0e',
      color: '#f1f1f1',
      border: '1px solid rgba(255,255,255,0.18)',
      borderRadius: '8px',
      padding: '8px 10px',
      fontSize: '12px',
      fontFamily: 'Consolas, monospace',
      resize: 'vertical',
      marginBottom: '10px',
    });
    cookieSection.appendChild(textarea);

    const statusLine = document.createElement('div');
    Object.assign(statusLine.style, {
      fontSize: '12px',
      marginBottom: '8px',
      color: '#f87171',
      display: 'none',
    });
    cookieSection.appendChild(statusLine);

    const actionRow = document.createElement('div');
    Object.assign(actionRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

    const openBrowserBtn = makeButton('Відкрити music.youtube.com у браузері');
    openBrowserBtn.addEventListener('click', () => {
      ipcRenderer.send('auth:open-external-ytm');
    });

    const importBtn = makeButton('Імпортувати та увійти', '#ff0033', '#ffffff');
    importBtn.addEventListener('click', async () => {
      statusLine.style.display = 'none';
      const result = await ipcRenderer.invoke('auth:import-cookies', textarea.value);
      if (result && result.ok) {
        closeModal();
      } else {
        statusLine.textContent = (result && result.error) || 'Не вдалося імпортувати cookies.';
        statusLine.style.display = 'block';
      }
    });

    actionRow.appendChild(openBrowserBtn);
    actionRow.appendChild(importBtn);
    cookieSection.appendChild(actionRow);
    bodyContainer.appendChild(cookieSection);
  }

  tabGeneralBtn.addEventListener('click', renderGeneralTab);
  tabAuthBtn.addEventListener('click', renderAuthTab);

  if (initialTab === 'auth') {
    renderAuthTab();
  } else {
    renderGeneralTab();
  }

  const hint = document.createElement('div');
  hint.textContent = 'Підказка: натисніть Ctrl+, у будь-який момент, щоб відкрити або закрити це вікно.';
  Object.assign(hint.style, {
    marginTop: '12px',
    fontSize: '11.5px',
    color: '#8e8e8e',
    textAlign: 'center',
  });
  card.appendChild(hint);

  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.body.appendChild(overlay);
  modalOverlay = overlay;
}

// Synchronously align navigator / Client Hints before page scripts run
if (isMusicHost || isAuthHost) {
  try {
    const authEnv = ipcRenderer.sendSync('auth:get-env');
    const authPatcherPath = path.join(__dirname, 'auth-patcher.js');
    const authPatcherFn = fs.readFileSync(authPatcherPath, 'utf8');
    const effectiveMode = isAuthHost ? authEnv.mode : 'chrome';
    const payload = JSON.stringify({
      mode: effectiveMode,
      chromeMajor: authEnv.chromeMajor,
      chromeUa: authEnv.chromeUa,
      firefoxUa: authEnv.firefoxUa,
    });
    webFrame.executeJavaScript(`(${authPatcherFn})(${payload});`).catch((err) => {
      console.error('[Preload] Auth patcher failed:', err);
    });
  } catch (err) {
    console.error('[Preload] Failed to initialize auth patcher:', err);
  }
}

if (isMusicHost) {
  enhancements = createEnhancementsController({
    postToPage,
    onOpenSettings: () => {
      ipcRenderer.invoke('settings:get').then((cfg) => {
        currentSettings = cfg;
        createSettingsModal('general');
      });
    },
  });

  try {
    const patcherPath = path.join(__dirname, 'page-patcher.js');
    const patcherCode = fs.readFileSync(patcherPath, 'utf8');
    webFrame.executeJavaScript(patcherCode).catch((err) => {
      console.error('[Preload] Failed to inject page patcher:', err);
    });
  } catch (err) {
    console.error('[Preload] Failed to read page patcher:', err);
  }

  ipcRenderer.invoke('settings:get').then((cfg) => {
    currentSettings = cfg;
    postToPage('config', {
      adBlockEnabled: cfg.adBlockEnabled,
      sponsorBlockEnabled: cfg.sponsorBlockEnabled,
      visualizerEnabled: cfg.visualizerEnabled,
    });
    enhancements.applySettings(cfg);
  });

  ipcRenderer.on('settings:updated', (_event, cfg) => {
    currentSettings = cfg;
    postToPage('config', {
      adBlockEnabled: cfg.adBlockEnabled,
      sponsorBlockEnabled: cfg.sponsorBlockEnabled,
      visualizerEnabled: cfg.visualizerEnabled,
    });
    enhancements.applySettings(cfg);
  });

  ipcRenderer.on('ui:open-settings', (_event, tab) => {
    ipcRenderer.invoke('settings:get').then((cfg) => {
      currentSettings = cfg;
      createSettingsModal(tab || 'general');
    });
  });

  ipcRenderer.on('ui:toggle-lyrics', () => {
    if (enhancements) enhancements.toggleLyricsDrawer();
  });

  ipcRenderer.on('player:command', (_event, command) => {
    postToPage('player-command', { command });
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'ytmc-page') return;
    const { type, payload } = event.data;

    if (type === 'ad-blocked') {
      ipcRenderer.send('adblock:blocked');
    } else if (type === 'sponsorblock-skipped') {
      ipcRenderer.send('sponsorblock:skipped');
    } else if (type === 'player-state') {
      ipcRenderer.send('player:state-changed', payload);
      if (enhancements) enhancements.handlePlayerState(payload);
    } else if (type === 'player-time' && payload) {
      if (enhancements) enhancements.updateLyricsPlaybackTime(payload.currentTime || 0);
    } else if (type === 'sponsorblock-request' && payload && payload.videoId) {
      const segments = await ipcRenderer.invoke('sponsorblock:fetch', payload.videoId);
      postToPage('sponsorblock-segments', {
        videoId: payload.videoId,
        segments,
      });
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      ipcRenderer.invoke('settings:get').then((cfg) => {
        currentSettings = cfg;
        createSettingsModal('general');
      });
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      if (enhancements) enhancements.toggleLyricsDrawer();
    } else if (e.key === 'Escape' && modalOverlay) {
      closeModal();
    }
  });
}
