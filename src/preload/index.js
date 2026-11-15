const fs = require('fs');
const path = require('path');
const { ipcRenderer, webFrame } = require('electron');
const { createEnhancementsController } = require('./enhancements');
const { resolveLanguage, getTranslations, formatText } = require('../shared/i18n');

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

const systemLocale = (() => {
  try {
    return ipcRenderer.sendSync('i18n:get-locale-sync') || navigator.language || '';
  } catch {
    return navigator.language || '';
  }
})();

let currentSettings = null;
let modalOverlay = null;
let refreshOpenModal = null;
let enhancements = null;

function getAppStrings(cfg = currentSettings) {
  const lang = resolveLanguage(cfg && cfg.language, systemLocale);
  return getTranslations(lang);
}

function buildPageConfig(cfg) {
  const t = getAppStrings(cfg);
  return {
    adBlockEnabled: cfg.adBlockEnabled,
    sponsorBlockEnabled: cfg.sponsorBlockEnabled,
    visualizerEnabled: cfg.visualizerEnabled,
    sponsorBlockToast: t.sponsorBlock.skippedToast,
    sponsorBlockCategories: t.sponsorBlock.categories,
  };
}

function closeModal() {
  if (modalOverlay) {
    modalOverlay.remove();
    modalOverlay = null;
  }
  refreshOpenModal = null;
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

  const tInit = getAppStrings().settingsModal;
  const title = document.createElement('h2');
  title.textContent = tInit.title;
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

  const tabGeneralBtn = makeButton(tInit.tabGeneral);
  const tabAuthBtn = makeButton(tInit.tabAuth);
  tabsBar.appendChild(tabGeneralBtn);
  tabsBar.appendChild(tabAuthBtn);
  card.appendChild(tabsBar);

  const bodyContainer = document.createElement('div');
  card.appendChild(bodyContainer);

  let activeTab = initialTab === 'auth' ? 'auth' : 'general';

  function setTabVisual(active) {
    activeTab = active;
    tabGeneralBtn.style.background = active === 'general' ? '#ff0033' : 'rgba(255,255,255,0.08)';
    tabAuthBtn.style.background = active === 'auth' ? '#ff0033' : 'rgba(255,255,255,0.08)';
  }

  function renderGeneralTab() {
    setTabVisual('general');
    bodyContainer.replaceChildren();
    const t = getAppStrings().settingsModal;

    const langRow = document.createElement('div');
    Object.assign(langRow.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '8px 10px',
      borderRadius: '8px',
      background: 'rgba(255, 255, 255, 0.04)',
      fontSize: '13.5px',
      marginBottom: '9px',
    });

    const langLabel = document.createElement('span');
    langLabel.textContent = t.languageLabel;

    const langSelect = document.createElement('select');
    Object.assign(langSelect.style, {
      background: '#262626',
      color: '#f1f1f1',
      border: '1px solid rgba(255, 255, 255, 0.18)',
      borderRadius: '6px',
      padding: '5px 8px',
      fontSize: '12.5px',
      cursor: 'pointer',
      outline: 'none',
    });

    const langOptions = [
      { value: 'auto', label: t.langAuto },
      { value: 'uk', label: t.langUk },
      { value: 'en', label: t.langEn },
    ];
    for (const item of langOptions) {
      const optEl = document.createElement('option');
      optEl.value = item.value;
      optEl.textContent = item.label;
      langSelect.appendChild(optEl);
    }
    langSelect.value = (currentSettings && currentSettings.language) || 'auto';

    langSelect.addEventListener('change', async () => {
      currentSettings = await ipcRenderer.invoke('settings:update', {
        language: langSelect.value,
      });
      postToPage('config', buildPageConfig(currentSettings));
      if (enhancements) {
        enhancements.applySettings(currentSettings);
      }
      refreshModalLocale();
    });

    langRow.appendChild(langLabel);
    langRow.appendChild(langSelect);
    bodyContainer.appendChild(langRow);

    const options = [
      { key: 'adBlockEnabled', label: t.adBlock },
      { key: 'sponsorBlockEnabled', label: t.sponsorBlock },
      { key: 'ambientThemeEnabled', label: t.ambientTheme },
      { key: 'visualizerEnabled', label: t.visualizer },
      { key: 'lyricsEnabled', label: t.lyrics },
      { key: 'globalMediaKeys', label: t.globalMediaKeys },
      { key: 'extraHotkeys', label: t.extraHotkeys },
      { key: 'minimizeToTray', label: t.minimizeToTray },
      { key: 'alwaysOnTop', label: t.alwaysOnTop },
      { key: 'autoLaunch', label: t.autoLaunch },
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
        postToPage('config', buildPageConfig(currentSettings));
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
    statsBox.textContent = formatText(t.statsSummary, { ads: adsCount, segments: sbCount });
    bodyContainer.appendChild(statsBox);
  }

  function renderAuthTab() {
    setTabVisual('auth');
    bodyContainer.replaceChildren();
    const t = getAppStrings().settingsModal;

    const modeSection = document.createElement('div');
    Object.assign(modeSection.style, {
      padding: '12px',
      borderRadius: '10px',
      background: 'rgba(255,255,255,0.04)',
      marginBottom: '14px',
    });

    const modeTitle = document.createElement('div');
    modeTitle.textContent = t.authModeTitle;
    Object.assign(modeTitle.style, { fontSize: '13px', fontWeight: '600', marginBottom: '8px' });
    modeSection.appendChild(modeTitle);

    const modeSelectRow = document.createElement('div');
    Object.assign(modeSelectRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

    const btnChrome = makeButton(t.authChrome);
    const btnFirefox = makeButton(t.authFirefox);

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

    const btnResetAuth = makeButton(t.authResetBtn);
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
    cookieTitle.textContent = t.cookieTitle;
    Object.assign(cookieTitle.style, { fontSize: '13px', fontWeight: '600', marginBottom: '6px' });
    cookieSection.appendChild(cookieTitle);

    const steps = document.createElement('div');
    steps.textContent = t.cookieSteps;
    Object.assign(steps.style, {
      fontSize: '12px',
      lineHeight: '1.45',
      color: '#bdbdbd',
      marginBottom: '10px',
    });
    cookieSection.appendChild(steps);

    const textarea = document.createElement('textarea');
    textarea.placeholder = t.cookiePlaceholder;
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

    const openBrowserBtn = makeButton(t.openBrowserBtn);
    openBrowserBtn.addEventListener('click', () => {
      ipcRenderer.send('auth:open-external-ytm');
    });

    const importBtn = makeButton(t.importBtn, '#ff0033', '#ffffff');
    importBtn.addEventListener('click', async () => {
      statusLine.style.display = 'none';
      const result = await ipcRenderer.invoke('auth:import-cookies', textarea.value);
      if (result && result.ok) {
        closeModal();
      } else {
        statusLine.textContent = (result && result.error) || t.importErrorFallback;
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
  hint.textContent = tInit.hint;
  Object.assign(hint.style, {
    marginTop: '12px',
    fontSize: '11.5px',
    color: '#8e8e8e',
    textAlign: 'center',
  });
  card.appendChild(hint);

  function refreshModalLocale() {
    const t = getAppStrings().settingsModal;
    title.textContent = t.title;
    tabGeneralBtn.textContent = t.tabGeneral;
    tabAuthBtn.textContent = t.tabAuth;
    hint.textContent = t.hint;
    if (activeTab === 'auth') {
      renderAuthTab();
    } else {
      renderGeneralTab();
    }
  }
  refreshOpenModal = refreshModalLocale;

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
    postToPage('config', buildPageConfig(cfg));
    enhancements.applySettings(cfg);
  });

  ipcRenderer.on('settings:updated', (_event, cfg) => {
    currentSettings = cfg;
    postToPage('config', buildPageConfig(cfg));
    enhancements.applySettings(cfg);
    if (refreshOpenModal) {
      refreshOpenModal();
    }
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

  ipcRenderer.on('player:seek', (_event, time) => {
    postToPage('player-seek', { time });
  });

  ipcRenderer.on('player:set-volume', (_event, volume) => {
    postToPage('player-volume', { volume });
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
      ipcRenderer.send('player:time-changed', payload.currentTime || 0);
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
