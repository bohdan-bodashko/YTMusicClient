const modalTitle = document.getElementById('modalTitle');
const closeBtn = document.getElementById('closeBtn');
const tabGeneralBtn = document.getElementById('tabGeneralBtn');
const tabAuthBtn = document.getElementById('tabAuthBtn');
const bodyContainer = document.getElementById('bodyContainer');
const hintText = document.getElementById('hintText');

const DEFAULT_SB_CATEGORIES = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];
const ALL_SB_CATEGORIES = [
  'sponsor',
  'music_offtopic',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
];

let bootstrap = { locale: navigator.language || '', translations: {} };
let currentSettings = null;
let activeTab = 'general';
let renderedLang = 'en';
let syncActiveControls = null;
let updateStatsDisplay = null;

function resolveLanguage(settingLang = 'auto', systemLocale = '') {
  if (settingLang === 'uk' || settingLang === 'en') {
    return settingLang;
  }
  const locale = String(systemLocale || '').toLowerCase();
  return locale.startsWith('uk') ? 'uk' : 'en';
}

function getAppStrings(cfg = currentSettings) {
  const translations = bootstrap.translations || {};
  const lang = resolveLanguage(cfg && cfg.language, bootstrap.locale);
  if (Object.hasOwn(translations, lang)) {
    return translations[lang] || {};
  }
  return Object.hasOwn(translations, 'en') ? translations.en || {} : {};
}

function setTabVisual(tab) {
  activeTab = tab === 'auth' ? 'auth' : 'general';
  const isGeneral = activeTab === 'general';
  tabGeneralBtn.classList.toggle('active', isGeneral);
  tabAuthBtn.classList.toggle('active', !isGeneral);
  tabGeneralBtn.setAttribute('aria-selected', isGeneral ? 'true' : 'false');
  tabAuthBtn.setAttribute('aria-selected', isGeneral ? 'false' : 'true');
}

function makeToggleSwitch(checked, onChange) {
  const label = document.createElement('span');
  label.className = 'ytmc-switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(checked);
  const track = document.createElement('span');
  track.className = 'ytmc-switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'ytmc-switch-thumb';
  track.appendChild(thumb);
  label.appendChild(checkbox);
  label.appendChild(track);
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  return { wrapper: label, checkbox };
}

async function commitSetting(partial) {
  if (!window.settingsAPI) return;
  currentSettings = await window.settingsAPI.updateSettings(partial);
}

function renderGeneralTab() {
  setTabVisual('general');
  bodyContainer.replaceChildren();
  const strings = getAppStrings();
  const t = strings.settingsModal || {};
  const sbCatNames = (strings.sponsorBlock && strings.sponsorBlock.categories) || {};
  const toggleCheckboxes = new Map();
  const chipMap = new Map();

  const addSectionTitle = (txt) => {
    const h = document.createElement('div');
    h.className = 'ytmc-section-title';
    h.textContent = txt || '';
    bodyContainer.appendChild(h);
  };

  addSectionTitle(t.sectionInterface);
  const ifaceCard = document.createElement('div');
  ifaceCard.className = 'ytmc-group-card';

  const langRow = document.createElement('div');
  langRow.className = 'ytmc-setting-row is-static';

  const langLabel = document.createElement('span');
  langLabel.textContent = t.languageLabel || '';

  const langSelect = document.createElement('select');
  langSelect.className = 'ytmc-select';
  for (const item of [
    { value: 'auto', label: t.langAuto || 'Auto' },
    { value: 'uk', label: t.langUk || 'Українська' },
    { value: 'en', label: t.langEn || 'English' },
  ]) {
    const optEl = document.createElement('option');
    optEl.value = item.value;
    optEl.textContent = item.label;
    langSelect.appendChild(optEl);
  }
  langSelect.value = (currentSettings && currentSettings.language) || 'auto';
  langSelect.addEventListener('change', async () => {
    await commitSetting({ language: langSelect.value });
    refreshLocale();
  });

  langRow.appendChild(langLabel);
  langRow.appendChild(langSelect);
  ifaceCard.appendChild(langRow);
  bodyContainer.appendChild(ifaceCard);

  const addToggleGroup = (sectionTitle, items, extraDrawerFn = null) => {
    addSectionTitle(sectionTitle);
    const group = document.createElement('div');
    group.className = 'ytmc-group-card';

    for (const opt of items) {
      const row = document.createElement('label');
      row.className = 'ytmc-setting-row';

      const text = document.createElement('span');
      text.textContent = opt.label || '';

      const { wrapper, checkbox } = makeToggleSwitch(
        currentSettings && currentSettings[opt.key],
        async (checked) => {
          await commitSetting({ [opt.key]: checked });
          if (opt.onAfterChange) opt.onAfterChange(checked);
        }
      );
      toggleCheckboxes.set(opt.key, checkbox);

      row.appendChild(text);
      row.appendChild(wrapper);
      group.appendChild(row);
    }

    if (extraDrawerFn) {
      extraDrawerFn(group);
    }
    bodyContainer.appendChild(group);
  };

  let sbDrawer = null;
  const selectedSet = new Set(
    Array.isArray(currentSettings && currentSettings.sponsorBlockCategories)
      ? currentSettings.sponsorBlockCategories
      : DEFAULT_SB_CATEGORIES
  );

  addToggleGroup(
    t.sectionPlayback,
    [
      { key: 'adBlockEnabled', label: t.adBlock },
      {
        key: 'sponsorBlockEnabled',
        label: t.sponsorBlock,
        onAfterChange: (checked) => {
          if (sbDrawer) sbDrawer.classList.toggle('is-hidden', !checked);
        },
      },
    ],
    (group) => {
      sbDrawer = document.createElement('div');
      sbDrawer.className = 'ytmc-sb-drawer';
      if (!(currentSettings && currentSettings.sponsorBlockEnabled)) {
        sbDrawer.classList.add('is-hidden');
      }

      const lbl = document.createElement('div');
      lbl.className = 'ytmc-sb-label';
      lbl.textContent = t.sponsorCategoriesLabel || '';
      sbDrawer.appendChild(lbl);

      const chipGrid = document.createElement('div');
      chipGrid.className = 'ytmc-chip-grid';

      for (const catKey of ALL_SB_CATEGORIES) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ytmc-chip' + (selectedSet.has(catKey) ? ' active' : '');
        chip.textContent = Object.hasOwn(sbCatNames, catKey) ? sbCatNames[catKey] : catKey;
        chip.addEventListener('click', async () => {
          if (selectedSet.has(catKey)) selectedSet.delete(catKey);
          else selectedSet.add(catKey);
          chip.classList.toggle('active', selectedSet.has(catKey));
          await commitSetting({ sponsorBlockCategories: [...selectedSet] });
        });
        chipMap.set(catKey, chip);
        chipGrid.appendChild(chip);
      }
      sbDrawer.appendChild(chipGrid);
      group.appendChild(sbDrawer);
    }
  );

  addToggleGroup(t.sectionAppearance, [
    { key: 'ambientThemeEnabled', label: t.ambientTheme },
    { key: 'visualizerEnabled', label: t.visualizer },
    { key: 'lyricsEnabled', label: t.lyrics },
  ]);

  addToggleGroup(t.sectionSystem, [
    { key: 'globalMediaKeys', label: t.globalMediaKeys },
    { key: 'extraHotkeys', label: t.extraHotkeys },
    { key: 'minimizeToTray', label: t.minimizeToTray },
    { key: 'alwaysOnTop', label: t.alwaysOnTop },
    { key: 'autoLaunch', label: t.autoLaunch },
  ]);

  const statsCard = document.createElement('div');
  statsCard.className = 'ytmc-stats-card';

  const statsHead = document.createElement('div');
  statsHead.className = 'ytmc-stats-head';

  const statsTitle = document.createElement('span');
  statsTitle.className = 'ytmc-stats-title';
  statsTitle.textContent = t.statsTitle || '';

  const resetStatsBtn = document.createElement('button');
  resetStatsBtn.type = 'button';
  resetStatsBtn.className = 'ytmc-btn ytmc-btn-sm';
  resetStatsBtn.textContent = t.statsResetBtn || '';

  statsHead.appendChild(statsTitle);
  statsHead.appendChild(resetStatsBtn);
  statsCard.appendChild(statsHead);

  const statsGrid = document.createElement('div');
  statsGrid.className = 'ytmc-stats-grid';

  const makeTile = (numVal, caption) => {
    const tile = document.createElement('div');
    tile.className = 'ytmc-stat-tile';
    const num = document.createElement('div');
    num.className = 'ytmc-stat-num';
    num.textContent = String(numVal);
    const cap = document.createElement('div');
    cap.className = 'ytmc-stat-caption';
    cap.textContent = caption || '';
    tile.appendChild(num);
    tile.appendChild(cap);
    return { tile, num };
  };

  const adsCount = (currentSettings && currentSettings.stats && currentSettings.stats.blockedAds) || 0;
  const sbCount =
    (currentSettings && currentSettings.stats && currentSettings.stats.skippedSegments) || 0;
  const adsTile = makeTile(adsCount, t.statsAdsLabel);
  const sbTile = makeTile(sbCount, t.statsSegmentsLabel);

  statsGrid.appendChild(adsTile.tile);
  statsGrid.appendChild(sbTile.tile);
  statsCard.appendChild(statsGrid);
  bodyContainer.appendChild(statsCard);

  updateStatsDisplay = (stats) => {
    if (!stats || typeof stats !== 'object') return;
    adsTile.num.textContent = String(stats.blockedAds || 0);
    sbTile.num.textContent = String(stats.skippedSegments || 0);
  };

  syncActiveControls = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    langSelect.value = cfg.language || 'auto';
    for (const [key, checkbox] of toggleCheckboxes.entries()) {
      checkbox.checked = Boolean(cfg[key]);
    }
    if (sbDrawer) {
      sbDrawer.classList.toggle('is-hidden', !cfg.sponsorBlockEnabled);
    }
    const nextCats = Array.isArray(cfg.sponsorBlockCategories)
      ? cfg.sponsorBlockCategories
      : DEFAULT_SB_CATEGORIES;
    selectedSet.clear();
    for (const catKey of nextCats) selectedSet.add(catKey);
    for (const [catKey, chip] of chipMap.entries()) {
      chip.classList.toggle('active', selectedSet.has(catKey));
    }
    if (cfg.stats) {
      updateStatsDisplay(cfg.stats);
    }
  };

  resetStatsBtn.addEventListener('click', async () => {
    if (!window.settingsAPI) return;
    try {
      const updated = await window.settingsAPI.resetStats();
      if (updated && typeof updated === 'object') {
        if (updated.stats) {
          currentSettings = updated;
          updateStatsDisplay(updated.stats);
        } else {
          currentSettings = { ...(currentSettings || {}), stats: updated };
          updateStatsDisplay(updated);
        }
      } else {
        updateStatsDisplay({ blockedAds: 0, skippedSegments: 0 });
      }
      resetStatsBtn.textContent = (getAppStrings().settingsModal || {}).statsResetDone || '';
      setTimeout(() => {
        if (resetStatsBtn.isConnected) {
          resetStatsBtn.textContent = (getAppStrings().settingsModal || {}).statsResetBtn || '';
        }
      }, 1800);
    } catch {
      // Ignore transient reset error
    }
  });
}

function renderAuthTab() {
  setTabVisual('auth');
  updateStatsDisplay = null;
  bodyContainer.replaceChildren();
  const t = getAppStrings().settingsModal || {};

  const modeSection = document.createElement('div');
  modeSection.className = 'ytmc-group-card ytmc-auth-card';

  const modeTitle = document.createElement('div');
  modeTitle.className = 'ytmc-auth-card-title';
  modeTitle.textContent = t.authModeTitle || '';
  modeSection.appendChild(modeTitle);

  const modeSelectRow = document.createElement('div');
  modeSelectRow.className = 'ytmc-btn-row';

  const btnChrome = document.createElement('button');
  btnChrome.type = 'button';
  btnChrome.className = 'ytmc-btn';

  const btnFirefox = document.createElement('button');
  btnFirefox.type = 'button';
  btnFirefox.className = 'ytmc-btn';

  function refreshModeButtons(mode) {
    const strings = getAppStrings().settingsModal || {};
    btnChrome.classList.toggle('ytmc-btn-primary', mode === 'chrome');
    btnFirefox.classList.toggle('ytmc-btn-primary', mode === 'firefox');
    btnChrome.textContent =
      mode === 'chrome' ? `✓ ${strings.authChrome || 'Chrome'}` : strings.authChrome || 'Chrome';
    btnFirefox.textContent =
      mode === 'firefox' ? `✓ ${strings.authFirefox || 'Firefox'}` : strings.authFirefox || 'Firefox';
  }
  refreshModeButtons((currentSettings && currentSettings.authUserAgentMode) || 'chrome');

  btnChrome.addEventListener('click', async () => {
    await commitSetting({ authUserAgentMode: 'chrome' });
    refreshModeButtons('chrome');
  });
  btnFirefox.addEventListener('click', async () => {
    await commitSetting({ authUserAgentMode: 'firefox' });
    refreshModeButtons('firefox');
  });

  syncActiveControls = (cfg) => {
    refreshModeButtons((cfg && cfg.authUserAgentMode) || 'chrome');
  };

  const btnResetAuth = document.createElement('button');
  btnResetAuth.type = 'button';
  btnResetAuth.className = 'ytmc-btn';
  btnResetAuth.textContent = t.authResetBtn || '';

  const authStatusBanner = document.createElement('div');
  authStatusBanner.className = 'ytmc-banner is-auth-status';

  btnResetAuth.addEventListener('click', async () => {
    if (!window.settingsAPI) return;
    await window.settingsAPI.clearGoogleAuth();
    const strings = getAppStrings().settingsModal || {};
    authStatusBanner.textContent = strings.authResetSuccess || '';
    authStatusBanner.className = 'ytmc-banner is-auth-status success';
    setTimeout(() => {
      if (window.settingsAPI) window.settingsAPI.close();
    }, 900);
  });

  modeSelectRow.appendChild(btnChrome);
  modeSelectRow.appendChild(btnFirefox);
  modeSelectRow.appendChild(btnResetAuth);
  modeSection.appendChild(modeSelectRow);
  modeSection.appendChild(authStatusBanner);
  bodyContainer.appendChild(modeSection);

  const cookieSection = document.createElement('div');
  cookieSection.className = 'ytmc-group-card ytmc-auth-card';

  const cookieTitle = document.createElement('div');
  cookieTitle.className = 'ytmc-auth-card-title';
  cookieTitle.textContent = t.cookieTitle || '';
  cookieSection.appendChild(cookieTitle);

  const steps = document.createElement('div');
  steps.className = 'ytmc-auth-steps';
  steps.textContent = t.cookieSteps || '';
  cookieSection.appendChild(steps);

  const textarea = document.createElement('textarea');
  textarea.className = 'ytmc-textarea';
  textarea.placeholder = t.cookiePlaceholder || '';
  cookieSection.appendChild(textarea);

  const statusLine = document.createElement('div');
  statusLine.className = 'ytmc-banner';
  cookieSection.appendChild(statusLine);

  const actionRow = document.createElement('div');
  actionRow.className = 'ytmc-btn-row';

  const openBrowserBtn = document.createElement('button');
  openBrowserBtn.type = 'button';
  openBrowserBtn.className = 'ytmc-btn';
  openBrowserBtn.textContent = t.openBrowserBtn || '';
  openBrowserBtn.addEventListener('click', () => {
    if (window.settingsAPI) window.settingsAPI.openExternalYtm();
  });

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'ytmc-btn ytmc-btn-primary';
  importBtn.textContent = t.importBtn || '';
  importBtn.addEventListener('click', async () => {
    if (!window.settingsAPI) return;
    statusLine.className = 'ytmc-banner';
    const result = await window.settingsAPI.importCookies(textarea.value);
    const strings = getAppStrings().settingsModal || {};
    if (result && result.ok) {
      statusLine.textContent = strings.importSuccess || '';
      statusLine.className = 'ytmc-banner success';
      textarea.value = '';
      setTimeout(() => {
        if (window.settingsAPI) window.settingsAPI.close();
      }, 900);
    } else {
      statusLine.textContent = (result && result.error) || strings.importErrorFallback || '';
      statusLine.className = 'ytmc-banner error';
    }
  });

  actionRow.appendChild(openBrowserBtn);
  actionRow.appendChild(importBtn);
  cookieSection.appendChild(actionRow);
  bodyContainer.appendChild(cookieSection);
}

function applyShellStrings() {
  const lang = resolveLanguage(currentSettings && currentSettings.language, bootstrap.locale);
  document.documentElement.lang = lang;
  const t = getAppStrings().settingsModal || {};
  document.title = t.title || 'YT Music Client Settings';
  modalTitle.textContent = t.title || 'YT Music Client Settings';
  closeBtn.title = t.closeTooltip || 'Close (Esc)';
  closeBtn.setAttribute('aria-label', t.closeTooltip || 'Close (Esc)');
  tabGeneralBtn.textContent = t.tabGeneral || 'General';
  tabAuthBtn.textContent = t.tabAuth || 'Google Sign-In';
  hintText.textContent = t.hint || '';
}

function refreshLocale() {
  const prevScroll = bodyContainer.scrollTop;
  const existingTextarea = bodyContainer.querySelector('textarea');
  const savedDraft = existingTextarea ? existingTextarea.value : '';
  renderedLang = resolveLanguage(currentSettings && currentSettings.language, bootstrap.locale);
  applyShellStrings();
  if (activeTab === 'auth') {
    renderAuthTab();
    const nextTextarea = bodyContainer.querySelector('textarea');
    if (nextTextarea && savedDraft) {
      nextTextarea.value = savedDraft;
    }
  } else {
    renderGeneralTab();
  }
  bodyContainer.scrollTop = prevScroll;
}

function showTab(tab) {
  const nextTab = tab === 'auth' ? 'auth' : 'general';
  applyShellStrings();
  if (nextTab === 'auth') {
    renderAuthTab();
  } else {
    renderGeneralTab();
  }
}

closeBtn.addEventListener('click', () => {
  if (window.settingsAPI) window.settingsAPI.close();
});

tabGeneralBtn.addEventListener('click', () => showTab('general'));
tabAuthBtn.addEventListener('click', () => showTab('auth'));

window.addEventListener('keydown', (e) => {
  if (!window.settingsAPI) return;
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === ',')) {
    e.preventDefault();
    window.settingsAPI.close();
  }
});

(async function initSettingsWindow() {
  if (!window.settingsAPI) return;
  bootstrap = window.settingsAPI.getBootstrap() || bootstrap;
  window.settingsAPI.onInitTab((tab) => {
    showTab(tab);
  });
  window.settingsAPI.onSettingsUpdated((cfg) => {
    currentSettings = cfg;
    const nextLang = resolveLanguage(cfg && cfg.language, bootstrap.locale);
    if (nextLang !== renderedLang) {
      refreshLocale();
    } else if (syncActiveControls) {
      syncActiveControls(cfg);
    }
  });
  window.settingsAPI.onStatsUpdated((stats) => {
    if (currentSettings) {
      currentSettings.stats = stats;
    }
    if (updateStatsDisplay) {
      updateStatsDisplay(stats);
    }
  });

  currentSettings = await window.settingsAPI.getSettings().catch(() => ({}));
  renderedLang = resolveLanguage(currentSettings && currentSettings.language, bootstrap.locale);
  showTab(activeTab);
})();
