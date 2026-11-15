const fs = require('fs');
const path = require('path');
const { ipcRenderer, webFrame } = require('electron');
const { createEnhancementsController } = require('./enhancements');
const { resolveLanguage, getTranslations, formatText } = require('../shared/i18n');
const { isAuthHost } = require('../shared/auth-hosts');

function getHostname() {
  try {
    return window.location.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isOfflinePage() {
  try {
    return (
      window.location.protocol === 'file:' &&
      window.location.pathname.toLowerCase().endsWith('offline.html')
    );
  } catch {
    return false;
  }
}

if (isOfflinePage()) {
  require('./offline');
} else {
  const hostname = getHostname();
  const isMusicHost = hostname === 'music.youtube.com';
  const isAuthPage = isAuthHost(hostname);

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
  let syncOpenModal = null;
  let updateStatsDisplay = null;
  let enhancements = null;
  let lastCategoriesSignature = '';

  function postToPage(type, payload) {
    window.postMessage({ source: 'ytmc-preload', type, payload }, '*');
  }

  function getAppStrings(cfg = currentSettings) {
    const lang = resolveLanguage(cfg && cfg.language, systemLocale);
    return getTranslations(lang);
  }

  function buildPageConfig(cfg, refetchSponsorBlock = false) {
    const t = getAppStrings(cfg);
    return {
      adBlockEnabled: cfg.adBlockEnabled,
      sponsorBlockEnabled: cfg.sponsorBlockEnabled,
      visualizerEnabled: cfg.visualizerEnabled,
      sponsorBlockToast: t.sponsorBlock.skippedToast,
      sponsorBlockCategories: t.sponsorBlock.categories,
      refetchSponsorBlock,
    };
  }

  function ensureModalStyles() {
    if (!document.head || document.getElementById('ytmc-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'ytmc-modal-style';
    style.textContent = `
      @keyframes ytmcOverlayIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes ytmcCardIn {
        from { opacity: 0; transform: translateY(8px) scale(0.975); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      #ytmc-settings-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        background: rgba(5, 5, 8, 0.72);
        backdrop-filter: blur(10px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: "Segoe UI Variable", "Segoe UI", Roboto, sans-serif;
        animation: ytmcOverlayIn 0.16s ease-out;
      }
      .ytmc-modal-card {
        width: 536px;
        max-width: 100%;
        max-height: 88vh;
        overflow-y: auto;
        background: rgba(20, 20, 25, 0.96);
        color: #f4f4f6;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 16px;
        padding: 20px 22px 18px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        animation: ytmcCardIn 0.2s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .ytmc-modal-card::-webkit-scrollbar {
        width: 6px;
      }
      .ytmc-modal-card::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 999px;
      }
      .ytmc-modal-close {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.72);
        font-size: 15px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease, color 0.15s ease, transform 0.12s ease;
      }
      .ytmc-modal-close:hover {
        background: rgba(255, 255, 255, 0.14);
        color: #ffffff;
      }
      .ytmc-modal-close:active {
        transform: scale(0.93);
      }
      .ytmc-tabs-pill {
        display: inline-flex;
        gap: 6px;
        padding: 4px;
        border-radius: 11px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        margin-bottom: 16px;
      }
      .ytmc-tab-btn {
        border: none;
        border-radius: 8px;
        padding: 7px 14px;
        font-size: 12.5px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.7);
        background: transparent;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .ytmc-tab-btn:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.06);
      }
      .ytmc-tab-btn.active {
        background: #ff0033;
        color: #ffffff;
        box-shadow: 0 3px 12px rgba(255, 0, 51, 0.35);
      }
      .ytmc-section-title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
        margin: 14px 2px 7px;
      }
      .ytmc-section-title:first-child {
        margin-top: 0;
      }
      .ytmc-group-card {
        display: flex;
        flex-direction: column;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }
      .ytmc-setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 13px;
        font-size: 13.5px;
        color: #ececef;
        cursor: pointer;
        transition: background 0.14s ease;
      }
      .ytmc-setting-row + .ytmc-setting-row {
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .ytmc-setting-row:hover {
        background: rgba(255, 255, 255, 0.05);
      }
      .ytmc-select {
        background: #23232a;
        color: #f4f4f6;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12.5px;
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s ease;
      }
      .ytmc-select:hover, .ytmc-select:focus {
        border-color: #ff0033;
      }
      .ytmc-switch {
        position: relative;
        display: inline-block;
        width: 38px;
        height: 22px;
        flex-shrink: 0;
      }
      .ytmc-switch input {
        opacity: 0;
        width: 0;
        height: 0;
        position: absolute;
      }
      .ytmc-switch-track {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.2);
        transition: background 0.18s ease;
      }
      .ytmc-switch-thumb {
        position: absolute;
        left: 3px;
        top: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
        transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .ytmc-switch input:checked + .ytmc-switch-track {
        background: #ff0033;
      }
      .ytmc-switch input:checked + .ytmc-switch-track .ytmc-switch-thumb {
        transform: translateX(16px);
      }
      .ytmc-switch input:focus-visible + .ytmc-switch-track {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }
      .ytmc-sb-drawer {
        padding: 10px 13px 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(0, 0, 0, 0.18);
      }
      .ytmc-sb-label {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.65);
        margin-bottom: 8px;
      }
      .ytmc-chip-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .ytmc-chip {
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.78);
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }
      .ytmc-chip:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      .ytmc-chip.active {
        background: rgba(255, 0, 51, 0.2);
        border-color: rgba(255, 0, 51, 0.7);
        color: #ffffff;
      }
      .ytmc-stats-card {
        margin-top: 14px;
        padding: 12px 13px;
        border-radius: 12px;
        background: linear-gradient(135deg, rgba(255, 0, 51, 0.10), rgba(90, 60, 200, 0.10));
        border: 1px solid rgba(255, 255, 255, 0.11);
      }
      .ytmc-stats-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .ytmc-stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .ytmc-stat-tile {
        padding: 9px 11px;
        border-radius: 9px;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(255, 255, 255, 0.07);
      }
      .ytmc-stat-num {
        font-size: 19px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: #ffffff;
      }
      .ytmc-stat-caption {
        font-size: 11.5px;
        color: rgba(255, 255, 255, 0.62);
        margin-top: 2px;
      }
      .ytmc-btn {
        background: rgba(255, 255, 255, 0.09);
        color: #f4f4f6;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 8px 13px;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }
      .ytmc-btn:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .ytmc-btn:active {
        transform: scale(0.97);
      }
      .ytmc-btn-primary {
        background: #ff0033;
        border-color: #ff0033;
        color: #ffffff;
      }
      .ytmc-btn-primary:hover {
        background: #e6002e;
        border-color: #e6002e;
      }
      .ytmc-btn-sm {
        padding: 4px 10px;
        font-size: 11.5px;
        border-radius: 7px;
      }
      .ytmc-textarea {
        width: 100%;
        box-sizing: border-box;
        min-height: 86px;
        background: #0d0d11;
        color: #f4f4f6;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 9px;
        padding: 9px 11px;
        font-size: 12px;
        font-family: Consolas, monospace;
        resize: vertical;
        outline: none;
        transition: border-color 0.15s ease;
      }
      .ytmc-textarea:focus {
        border-color: #ff0033;
      }
      .ytmc-banner {
        font-size: 12px;
        padding: 8px 10px;
        border-radius: 8px;
        margin-bottom: 10px;
        display: none;
      }
      .ytmc-banner.error {
        display: block;
        background: rgba(239, 68, 68, 0.14);
        border: 1px solid rgba(239, 68, 68, 0.38);
        color: #fca5a5;
      }
      .ytmc-banner.success {
        display: block;
        background: rgba(34, 197, 94, 0.14);
        border: 1px solid rgba(34, 197, 94, 0.4);
        color: #86efac;
      }
    `;
    document.head.appendChild(style);
  }

  function closeModal() {
    if (modalOverlay) {
      modalOverlay.remove();
      modalOverlay = null;
    }
    refreshOpenModal = null;
    syncOpenModal = null;
    updateStatsDisplay = null;
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

  function createSettingsModal(initialTab = 'general') {
    if (!document.body) return;
    if (modalOverlay) {
      closeModal();
      if (initialTab === 'general') return;
    }

    ensureModalStyles();

    const overlay = document.createElement('div');
    overlay.id = 'ytmc-settings-overlay';

    const card = document.createElement('div');
    card.className = 'ytmc-modal-card';

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '14px',
    });

    const titleWrap = document.createElement('div');
    Object.assign(titleWrap.style, { display: 'flex', alignItems: 'center', gap: '9px' });
    const brandBadge = document.createElement('span');
    Object.assign(brandBadge.style, {
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      background: '#ff0033',
      boxShadow: '0 0 10px rgba(255, 0, 51, 0.7)',
      flexShrink: '0',
    });

    const tInit = getAppStrings().settingsModal;
    const title = document.createElement('h2');
    title.textContent = tInit.title;
    Object.assign(title.style, { margin: '0', fontSize: '16.5px', fontWeight: '600' });

    titleWrap.appendChild(brandBadge);
    titleWrap.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ytmc-modal-close';
    closeBtn.textContent = '✕';
    closeBtn.title = tInit.closeTooltip;
    closeBtn.setAttribute('aria-label', tInit.closeTooltip);
    closeBtn.addEventListener('click', closeModal);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const tabsBar = document.createElement('div');
    tabsBar.className = 'ytmc-tabs-pill';

    const tabGeneralBtn = document.createElement('button');
    tabGeneralBtn.type = 'button';
    tabGeneralBtn.className = 'ytmc-tab-btn';
    tabGeneralBtn.textContent = tInit.tabGeneral;

    const tabAuthBtn = document.createElement('button');
    tabAuthBtn.type = 'button';
    tabAuthBtn.className = 'ytmc-tab-btn';
    tabAuthBtn.textContent = tInit.tabAuth;

    tabsBar.appendChild(tabGeneralBtn);
    tabsBar.appendChild(tabAuthBtn);
    card.appendChild(tabsBar);

    const bodyContainer = document.createElement('div');
    card.appendChild(bodyContainer);

    let activeTab = initialTab === 'auth' ? 'auth' : 'general';
    let renderedLang = resolveLanguage(currentSettings && currentSettings.language, systemLocale);
    let syncActiveControls = null;

    function setTabVisual(active) {
      activeTab = active;
      tabGeneralBtn.classList.toggle('active', active === 'general');
      tabAuthBtn.classList.toggle('active', active === 'auth');
    }

    async function commitSetting(partial, refetchSponsorBlock = false) {
      currentSettings = await ipcRenderer.invoke('settings:update', partial);
      lastCategoriesSignature = Array.isArray(currentSettings && currentSettings.sponsorBlockCategories)
        ? currentSettings.sponsorBlockCategories.slice().sort().join(',')
        : '';
      postToPage('config', buildPageConfig(currentSettings, refetchSponsorBlock));
      if (enhancements) {
        enhancements.applySettings(currentSettings);
      }
    }

    function renderGeneralTab() {
      setTabVisual('general');
      bodyContainer.replaceChildren();
      const strings = getAppStrings();
      const t = strings.settingsModal;
      const sbCatNames = strings.sponsorBlock.categories;
      const toggleCheckboxes = new Map();
      const chipMap = new Map();

      const addSectionTitle = (txt) => {
        const h = document.createElement('div');
        h.className = 'ytmc-section-title';
        h.textContent = txt;
        bodyContainer.appendChild(h);
      };

      // 1. Interface section
      addSectionTitle(t.sectionInterface);
      const ifaceCard = document.createElement('div');
      ifaceCard.className = 'ytmc-group-card';

      const langRow = document.createElement('div');
      langRow.className = 'ytmc-setting-row';
      langRow.style.cursor = 'default';

      const langLabel = document.createElement('span');
      langLabel.textContent = t.languageLabel;

      const langSelect = document.createElement('select');
      langSelect.className = 'ytmc-select';
      for (const item of [
        { value: 'auto', label: t.langAuto },
        { value: 'uk', label: t.langUk },
        { value: 'en', label: t.langEn },
      ]) {
        const optEl = document.createElement('option');
        optEl.value = item.value;
        optEl.textContent = item.label;
        langSelect.appendChild(optEl);
      }
      langSelect.value = (currentSettings && currentSettings.language) || 'auto';
      langSelect.addEventListener('change', async () => {
        await commitSetting({ language: langSelect.value });
        refreshModalLocale();
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
          text.textContent = opt.label;

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

      // 2. Blocking & SponsorBlock categories
      let sbDrawer = null;
      const selectedSet = new Set(
        Array.isArray(currentSettings && currentSettings.sponsorBlockCategories)
          ? currentSettings.sponsorBlockCategories
          : ['music_offtopic', 'sponsor', 'selfpromo', 'interaction']
      );

      addToggleGroup(
        t.sectionPlayback,
        [
          { key: 'adBlockEnabled', label: t.adBlock },
          {
            key: 'sponsorBlockEnabled',
            label: t.sponsorBlock,
            onAfterChange: (checked) => {
              if (sbDrawer) sbDrawer.style.display = checked ? 'block' : 'none';
            },
          },
        ],
        (group) => {
          sbDrawer = document.createElement('div');
          sbDrawer.className = 'ytmc-sb-drawer';
          sbDrawer.style.display = currentSettings && currentSettings.sponsorBlockEnabled ? 'block' : 'none';

          const lbl = document.createElement('div');
          lbl.className = 'ytmc-sb-label';
          lbl.textContent = t.sponsorCategoriesLabel;
          sbDrawer.appendChild(lbl);

          const chipGrid = document.createElement('div');
          chipGrid.className = 'ytmc-chip-grid';

          const allCats = ['sponsor', 'music_offtopic', 'selfpromo', 'interaction', 'intro', 'outro'];

          for (const catKey of allCats) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ytmc-chip' + (selectedSet.has(catKey) ? ' active' : '');
            chip.textContent = sbCatNames[catKey] || catKey;
            chip.addEventListener('click', async () => {
              if (selectedSet.has(catKey)) selectedSet.delete(catKey);
              else selectedSet.add(catKey);
              chip.classList.toggle('active', selectedSet.has(catKey));
              await commitSetting({ sponsorBlockCategories: [...selectedSet] }, true);
            });
            chipMap.set(catKey, chip);
            chipGrid.appendChild(chip);
          }
          sbDrawer.appendChild(chipGrid);
          group.appendChild(sbDrawer);
        }
      );

      // 3. Appearance & Lyrics
      addToggleGroup(t.sectionAppearance, [
        { key: 'ambientThemeEnabled', label: t.ambientTheme },
        { key: 'visualizerEnabled', label: t.visualizer },
        { key: 'lyricsEnabled', label: t.lyrics },
      ]);

      // 4. Window & Shortcuts
      addToggleGroup(t.sectionSystem, [
        { key: 'globalMediaKeys', label: t.globalMediaKeys },
        { key: 'extraHotkeys', label: t.extraHotkeys },
        { key: 'minimizeToTray', label: t.minimizeToTray },
        { key: 'alwaysOnTop', label: t.alwaysOnTop },
        { key: 'autoLaunch', label: t.autoLaunch },
      ]);

      // 5. Live Protection Stats Card
      const statsCard = document.createElement('div');
      statsCard.className = 'ytmc-stats-card';

      const statsHead = document.createElement('div');
      statsHead.className = 'ytmc-stats-head';

      const statsTitle = document.createElement('span');
      statsTitle.textContent = t.statsTitle;
      Object.assign(statsTitle.style, { fontSize: '12.5px', fontWeight: '600', color: '#f4f4f6' });

      const resetStatsBtn = document.createElement('button');
      resetStatsBtn.type = 'button';
      resetStatsBtn.className = 'ytmc-btn ytmc-btn-sm';
      resetStatsBtn.textContent = t.statsResetBtn;

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
        cap.textContent = caption;
        tile.appendChild(num);
        tile.appendChild(cap);
        return { tile, num };
      };

      const adsCount = (currentSettings && currentSettings.stats && currentSettings.stats.blockedAds) || 0;
      const sbCount = (currentSettings && currentSettings.stats && currentSettings.stats.skippedSegments) || 0;
      const adsTile = makeTile(adsCount, t.statsAdsLabel);
      const sbTile = makeTile(sbCount, t.statsSegmentsLabel);

      statsGrid.appendChild(adsTile.tile);
      statsGrid.appendChild(sbTile.tile);
      statsCard.appendChild(statsGrid);
      bodyContainer.appendChild(statsCard);

      updateStatsDisplay = (stats) => {
        if (!stats) return;
        adsTile.num.textContent = String(stats.blockedAds || 0);
        sbTile.num.textContent = String(stats.skippedSegments || 0);
      };

      syncActiveControls = (cfg) => {
        if (!cfg) return;
        langSelect.value = cfg.language || 'auto';
        for (const [key, checkbox] of toggleCheckboxes.entries()) {
          checkbox.checked = Boolean(cfg[key]);
        }
        if (sbDrawer) {
          sbDrawer.style.display = cfg.sponsorBlockEnabled ? 'block' : 'none';
        }
        const nextCats = Array.isArray(cfg.sponsorBlockCategories)
          ? cfg.sponsorBlockCategories
          : ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];
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
        try {
          const updated = await ipcRenderer.invoke('settings:reset-stats');
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
          resetStatsBtn.textContent = t.statsResetDone;
          setTimeout(() => {
            if (resetStatsBtn.isConnected) {
              resetStatsBtn.textContent = getAppStrings().settingsModal.statsResetBtn;
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
      const t = getAppStrings().settingsModal;

      const modeSection = document.createElement('div');
      modeSection.className = 'ytmc-group-card';
      Object.assign(modeSection.style, { padding: '13px', marginBottom: '12px' });

      const modeTitle = document.createElement('div');
      modeTitle.textContent = t.authModeTitle;
      Object.assign(modeTitle.style, { fontSize: '13px', fontWeight: '600', marginBottom: '10px' });
      modeSection.appendChild(modeTitle);

      const modeSelectRow = document.createElement('div');
      Object.assign(modeSelectRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

      const btnChrome = document.createElement('button');
      btnChrome.type = 'button';
      btnChrome.className = 'ytmc-btn';

      const btnFirefox = document.createElement('button');
      btnFirefox.type = 'button';
      btnFirefox.className = 'ytmc-btn';

      function refreshModeButtons(mode) {
        btnChrome.classList.toggle('ytmc-btn-primary', mode === 'chrome');
        btnFirefox.classList.toggle('ytmc-btn-primary', mode === 'firefox');
        btnChrome.textContent = mode === 'chrome' ? `✓ ${t.authChrome}` : t.authChrome;
        btnFirefox.textContent = mode === 'firefox' ? `✓ ${t.authFirefox}` : t.authFirefox;
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

      syncActiveControls = (cfg) => {
        refreshModeButtons((cfg && cfg.authUserAgentMode) || 'chrome');
      };

      const btnResetAuth = document.createElement('button');
      btnResetAuth.type = 'button';
      btnResetAuth.className = 'ytmc-btn';
      btnResetAuth.textContent = t.authResetBtn;

      const authStatusBanner = document.createElement('div');
      authStatusBanner.className = 'ytmc-banner';
      authStatusBanner.style.marginTop = '10px';
      authStatusBanner.style.marginBottom = '0';

      btnResetAuth.addEventListener('click', async () => {
        await ipcRenderer.invoke('auth:clear-cookies');
        authStatusBanner.textContent = t.authResetSuccess;
        authStatusBanner.className = 'ytmc-banner success';
        setTimeout(closeModal, 900);
      });

      modeSelectRow.appendChild(btnChrome);
      modeSelectRow.appendChild(btnFirefox);
      modeSelectRow.appendChild(btnResetAuth);
      modeSection.appendChild(modeSelectRow);
      modeSection.appendChild(authStatusBanner);
      bodyContainer.appendChild(modeSection);

      const cookieSection = document.createElement('div');
      cookieSection.className = 'ytmc-group-card';
      Object.assign(cookieSection.style, { padding: '13px' });

      const cookieTitle = document.createElement('div');
      cookieTitle.textContent = t.cookieTitle;
      Object.assign(cookieTitle.style, { fontSize: '13px', fontWeight: '600', marginBottom: '6px' });
      cookieSection.appendChild(cookieTitle);

      const steps = document.createElement('div');
      steps.textContent = t.cookieSteps;
      Object.assign(steps.style, {
        fontSize: '12px',
        lineHeight: '1.5',
        color: 'rgba(255, 255, 255, 0.68)',
        marginBottom: '10px',
      });
      cookieSection.appendChild(steps);

      const textarea = document.createElement('textarea');
      textarea.className = 'ytmc-textarea';
      textarea.placeholder = t.cookiePlaceholder;
      textarea.style.marginBottom = '10px';
      cookieSection.appendChild(textarea);

      const statusLine = document.createElement('div');
      statusLine.className = 'ytmc-banner';
      cookieSection.appendChild(statusLine);

      const actionRow = document.createElement('div');
      Object.assign(actionRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

      const openBrowserBtn = document.createElement('button');
      openBrowserBtn.type = 'button';
      openBrowserBtn.className = 'ytmc-btn';
      openBrowserBtn.textContent = t.openBrowserBtn;
      openBrowserBtn.addEventListener('click', () => {
        ipcRenderer.send('auth:open-external-ytm');
      });

      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.className = 'ytmc-btn ytmc-btn-primary';
      importBtn.textContent = t.importBtn;
      importBtn.addEventListener('click', async () => {
        statusLine.className = 'ytmc-banner';
        const result = await ipcRenderer.invoke('auth:import-cookies', textarea.value);
        if (result && result.ok) {
          statusLine.textContent = t.importSuccess;
          statusLine.className = 'ytmc-banner success';
          setTimeout(closeModal, 900);
        } else {
          statusLine.textContent = (result && result.error) || t.importErrorFallback;
          statusLine.className = 'ytmc-banner error';
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
      color: 'rgba(255, 255, 255, 0.45)',
      textAlign: 'center',
    });
    card.appendChild(hint);

    function refreshModalLocale() {
      const prevScroll = card.scrollTop;
      const existingTextarea = bodyContainer.querySelector('textarea');
      const savedDraft = existingTextarea ? existingTextarea.value : '';
      renderedLang = resolveLanguage(currentSettings && currentSettings.language, systemLocale);
      const t = getAppStrings().settingsModal;
      title.textContent = t.title;
      closeBtn.title = t.closeTooltip;
      closeBtn.setAttribute('aria-label', t.closeTooltip);
      tabGeneralBtn.textContent = t.tabGeneral;
      tabAuthBtn.textContent = t.tabAuth;
      hint.textContent = t.hint;
      if (activeTab === 'auth') {
        renderAuthTab();
        const nextTextarea = bodyContainer.querySelector('textarea');
        if (nextTextarea && savedDraft) {
          nextTextarea.value = savedDraft;
        }
      } else {
        renderGeneralTab();
      }
      card.scrollTop = prevScroll;
    }
    refreshOpenModal = refreshModalLocale;
    syncOpenModal = (cfg) => {
      const nextLang = resolveLanguage(cfg && cfg.language, systemLocale);
      if (nextLang !== renderedLang) {
        refreshModalLocale();
      } else if (syncActiveControls) {
        syncActiveControls(cfg);
      }
    };

    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    document.body.appendChild(overlay);
    modalOverlay = overlay;
  }

  // Synchronously align navigator / Client Hints before page scripts run
  if (isMusicHost || isAuthPage) {
    try {
      const authEnv = ipcRenderer.sendSync('auth:get-env');
      const authPatcherPath = path.join(__dirname, 'auth-patcher.js');
      const authPatcherFn = fs.readFileSync(authPatcherPath, 'utf8');
      const effectiveMode = isAuthPage ? authEnv.mode : 'chrome';
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
      systemLocale,
      postToPage,
      onToggleMiniPlayer: () => {
        ipcRenderer.send('ui:toggle-miniplayer');
      },
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
      lastCategoriesSignature = Array.isArray(cfg.sponsorBlockCategories)
        ? cfg.sponsorBlockCategories.slice().sort().join(',')
        : '';
      postToPage('config', buildPageConfig(cfg));
      enhancements.applySettings(cfg);
      enhancements.syncThemeToPage();
    });

    ipcRenderer.on('settings:updated', (_event, cfg) => {
      const nextCatSig = Array.isArray(cfg && cfg.sponsorBlockCategories)
        ? cfg.sponsorBlockCategories.slice().sort().join(',')
        : '';
      const catsChanged = nextCatSig !== lastCategoriesSignature;
      lastCategoriesSignature = nextCatSig;

      currentSettings = cfg;
      postToPage('config', buildPageConfig(cfg, catsChanged));
      enhancements.applySettings(cfg);
      if (syncOpenModal) {
        syncOpenModal(cfg);
      } else if (refreshOpenModal) {
        refreshOpenModal();
      }
    });

    ipcRenderer.on('stats:updated', (_event, stats) => {
      if (currentSettings) {
        currentSettings.stats = stats;
      }
      if (updateStatsDisplay) {
        updateStatsDisplay(stats);
      }
    });

    ipcRenderer.on('miniplayer:visibility', (_event, visible) => {
      if (enhancements) {
        enhancements.setMiniPlayerVisible(Boolean(visible));
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

      if (type === 'page-ready') {
        if (currentSettings) {
          postToPage('config', buildPageConfig(currentSettings));
        }
        if (enhancements) {
          enhancements.syncThemeToPage();
        }
      } else if (type === 'ad-blocked') {
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
      const target = e.target;
      const isTyping = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
      );

      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        if (modalOverlay) {
          closeModal();
          return;
        }
        ipcRenderer.invoke('settings:get').then((cfg) => {
          currentSettings = cfg;
          createSettingsModal('general');
        });
      } else if ((e.ctrlKey || e.metaKey) && !isTyping && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (enhancements) enhancements.toggleLyricsDrawer();
      } else if (e.key === 'Escape' && modalOverlay) {
        closeModal();
      }
    });
  }
}
