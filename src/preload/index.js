const { contextBridge, ipcRenderer, webFrame } = require('electron');

const MUSIC_ORIGIN = 'https://music.youtube.com';
const OFFLINE_ORIGIN = 'ytmc-app://local';
const OFFLINE_PATH = '/offline.html';
const ALLOWED_ARTWORK_DOMAINS = ['googleusercontent.com', 'ggpht.com', 'ytimg.com'];
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const MAX_ARTWORK_URL_LEN = 2048;
const MAX_DATA_URL_LEN = 8 * 1024 * 1024;
const MAX_SEEK_SECONDS = 864000;

function resolveLanguage(settingLang = 'auto', systemLocale = '') {
  if (settingLang === 'uk' || settingLang === 'en') {
    return settingLang;
  }
  const locale = String(systemLocale || '').toLowerCase();
  return locale.startsWith('uk') ? 'uk' : 'en';
}

function getTranslations(translations, lang) {
  if (!translations || typeof translations !== 'object') return {};
  if (Object.hasOwn(translations, lang)) {
    return translations[lang] || {};
  }
  return Object.hasOwn(translations, 'en') ? translations.en || {} : {};
}

function formatText(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    vars && Object.hasOwn(vars, key) ? String(vars[key] ?? '') : match
  );
}

function isOfflinePage() {
  try {
    return (
      window.location.origin === OFFLINE_ORIGIN &&
      window.location.pathname.toLowerCase() === OFFLINE_PATH
    );
  } catch {
    return false;
  }
}

function isAllowedArtworkUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_ARTWORK_URL_LEN) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return false;
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (!host || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) {
      return false;
    }
    return ALLOWED_ARTWORK_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function isSafeRasterDataUrl(rawUrl) {
  return (
    typeof rawUrl === 'string' &&
    rawUrl.length > 0 &&
    rawUrl.length <= MAX_DATA_URL_LEN &&
    SAFE_DATA_IMAGE_RE.test(rawUrl)
  );
}

function sanitizeText(value, maxLen = 300) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLen);
}

function sanitizePlayerState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const videoId =
    typeof raw.videoId === 'string' && VIDEO_ID_RE.test(raw.videoId.trim())
      ? raw.videoId.trim()
      : '';
  const duration =
    typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration >= 0
      ? Math.min(MAX_SEEK_SECONDS, raw.duration)
      : 0;
  const volume =
    typeof raw.volume === 'number' && Number.isFinite(raw.volume)
      ? Math.min(1, Math.max(0, raw.volume))
      : 1;
  return {
    isPlaying: Boolean(raw.isPlaying),
    title: sanitizeText(raw.title, 300),
    artist: sanitizeText(raw.artist, 300),
    videoId,
    artworkUrl: isAllowedArtworkUrl(raw.artworkUrl) ? raw.artworkUrl : '',
    duration,
    volume,
    muted: Boolean(raw.muted),
  };
}

function createWindowRateLimiter(windowMs, maxEvents) {
  const timestamps = [];
  return () => {
    const now = Date.now();
    while (timestamps.length > 0 && now - timestamps[0] >= windowMs) {
      timestamps.shift();
    }
    if (timestamps.length >= maxEvents) {
      return false;
    }
    timestamps.push(now);
    return true;
  };
}

function readBootstrapSync() {
  try {
    const data = ipcRenderer.sendSync('preload:bootstrap-sync');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function initOfflinePreload(translations, systemLocale) {
  let cachedLanguageSetting = 'auto';

  async function loadLanguageSetting() {
    try {
      const cfg = await ipcRenderer.invoke('settings:get');
      if (cfg && typeof cfg.language === 'string') {
        cachedLanguageSetting = cfg.language;
      }
    } catch {
      // Ignore if settings IPC is unavailable
    }
    return cachedLanguageSetting;
  }

  function enrichInfo(rawInfo) {
    const info = rawInfo && typeof rawInfo === 'object' ? rawInfo : {};
    const lang = resolveLanguage(
      info.language || cachedLanguageSetting,
      info.locale || systemLocale || navigator.language || ''
    );
    const t = getTranslations(translations, lang);
    return {
      errorCode: info.errorCode ?? '',
      errorDescription: typeof info.errorDescription === 'string' ? info.errorDescription : '',
      validatedURL: typeof info.validatedURL === 'string' ? info.validatedURL : '',
      locale: info.locale || navigator.language || '',
      lang,
      strings: t.offline || {},
    };
  }

  loadLanguageSetting();

  contextBridge.exposeInMainWorld('offlineAPI', {
    onInfo: (cb) => {
      if (typeof cb !== 'function') {
        throw new TypeError('Callback must be a function');
      }
      const handler = async (_event, rawInfo) => {
        await loadLanguageSetting();
        cb(enrichInfo(rawInfo));
      };
      ipcRenderer.on('offline:info', handler);
      return () => {
        ipcRenderer.removeListener('offline:info', handler);
      };
    },
    getInfo: async () => {
      const [rawInfo] = await Promise.all([
        ipcRenderer.invoke('offline:get-info').catch(() => ({})),
        loadLanguageSetting(),
      ]);
      return enrichInfo(rawInfo);
    },
    retryLoad: () => {
      ipcRenderer.send('ui:retry-load');
    },
  });
}

function createSvgIcon(paths, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function rgbToCss(rgb, alpha = 1) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function boostColorForDarkBg(rgb, minLuma = 90) {
  let [r, g, b] = rgb;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma >= minLuma) return [r, g, b];
  if (luma < 8) return [255, 45, 85];
  const factor = Math.min(3.5, minLuma / Math.max(1, luma));
  r = Math.min(255, Math.round(r * factor));
  g = Math.min(255, Math.round(g * factor));
  b = Math.min(255, Math.round(b * factor));
  return [r, g, b];
}

function extractPaletteFromDataUrl(dataUrl) {
  const fallback = { primary: [255, 45, 85], secondary: [120, 40, 200] };
  if (!isSafeRasterDataUrl(dataUrl)) {
    return Promise.resolve(fallback);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 28;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 128) continue;

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const sat = max === 0 ? 0 : (max - min) / max;

          if (luma < 22 || luma > 235) continue;
          const weight = sat * 2.5 + 0.2;

          const qr = Math.round(r / 24) * 24;
          const qg = Math.round(g / 24) * 24;
          const qb = Math.round(b / 24) * 24;
          const key = `${qr},${qg},${qb}`;
          const prev = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
          prev.r += r * weight;
          prev.g += g * weight;
          prev.b += b * weight;
          prev.w += weight;
          buckets.set(key, prev);
        }

        const sorted = [...buckets.values()].sort((a, b) => b.w - a.w);
        if (sorted.length === 0) {
          resolve(fallback);
          return;
        }

        const p = sorted[0];
        const rawPrimary = [
          Math.min(255, Math.round(p.r / p.w)),
          Math.min(255, Math.round(p.g / p.w)),
          Math.min(255, Math.round(p.b / p.w)),
        ];
        const primary = boostColorForDarkBg(rawPrimary, 92);

        let secondary = primary;
        for (let i = 1; i < sorted.length; i += 1) {
          const cand = sorted[i];
          const cr = Math.round(cand.r / cand.w);
          const cg = Math.round(cand.g / cand.w);
          const cb = Math.round(cand.b / cand.w);
          const dist = Math.hypot(cr - rawPrimary[0], cg - rawPrimary[1], cb - rawPrimary[2]);
          if (dist > 55) {
            secondary = boostColorForDarkBg([cr, cg, cb], 64);
            break;
          }
        }

        resolve({ primary, secondary });
      } catch {
        resolve(fallback);
      }
    };
    img.onerror = () => resolve(fallback);
    img.src = dataUrl;
  });
}

function createEnhancementsController({
  onOpenSettings,
  onToggleMiniPlayer,
  postToPage,
  translations,
  systemLocale,
}) {
  let settings = {
    ambientThemeEnabled: true,
    visualizerEnabled: true,
    lyricsEnabled: true,
    language: 'auto',
  };

  function getLyricsStrings() {
    const lang = resolveLanguage(settings.language, systemLocale);
    return getTranslations(translations, lang).lyrics || {};
  }

  let syncOffsetSec = 0;

  function formatSyncOffset() {
    const t = getLyricsStrings();
    const offset = `${syncOffsetSec > 0 ? '+' : ''}${syncOffsetSec.toFixed(1)}`;
    return formatText(t.syncLabel, { offset });
  }

  let currentTrack = {
    title: '',
    artist: '',
    duration: 0,
    artworkUrl: '',
    videoId: '',
  };

  let lastArtworkUrl = '';
  let currentPalette = { primary: [255, 45, 85], secondary: [90, 60, 200] };
  let lastPublishedThemeSig = '';

  let isLyricsViewVisible = false;
  let forcedLyricsTab = false;
  let lastForcedLyricsAt = 0;
  let showNativeFallback = false;
  let lyricsLoading = false;
  let currentLyricsKey = '';
  let lyricsData = { found: false, synced: [], plain: '' };
  let activeLineIndex = -1;
  let lastPlaybackTime = 0;
  let userScrollPaused = false;
  let scrollResumeTimer = null;
  let programmaticScrollTimer = null;
  let isProgrammaticScroll = false;
  let copyTimer = null;
  let isMiniPlayerOpen = false;

  let inlineContainerEl = null;
  let inlineBodyEl = null;
  let resumeSyncBtnEl = null;
  let offsetLabelEl = null;
  let offsetMinusBtn = null;
  let offsetPlusBtn = null;
  let offsetResetBtn = null;
  let copyLyricsBtn = null;
  let nativeToggleBtn = null;
  let lineElements = [];
  let lyricsToggleBtn = null;
  let miniPlayerToggleBtn = null;
  let settingsBtn = null;
  const hookedTabs = new WeakSet();

  function ensureAmbientElements() {
    if (!document.head || !document.body) return;

    if (!document.getElementById('ytmc-ambient-style')) {
      const style = document.createElement('style');
      style.id = 'ytmc-ambient-style';
      style.textContent = `
        :root {
          --ytmc-c1: rgba(255, 45, 85, 0.24);
          --ytmc-c2: rgba(90, 60, 200, 0.20);
          --ytmc-accent: rgb(255, 45, 85);
          --ytmc-accent-soft: rgba(255, 45, 85, 0.16);
        }
        #ytmc-ambient-bg {
          position: fixed;
          inset: 0;
          z-index: 2;
          pointer-events: none;
          mix-blend-mode: screen;
          background:
            radial-gradient(circle at 16% 20%, var(--ytmc-c1) 0%, transparent 54%),
            radial-gradient(circle at 84% 78%, var(--ytmc-c2) 0%, transparent 58%);
          transition: opacity 0.65s ease;
          opacity: 0;
        }
        #ytmc-ambient-bg.ytmc-active {
          opacity: 1;
        }
        body.ytmc-ambient-on ytmusic-player-bar {
          background: linear-gradient(90deg, rgba(20, 20, 24, 0.94), rgba(26, 26, 32, 0.95)) !important;
          border-top: 1px solid rgba(255, 255, 255, 0.12) !important;
          box-shadow: 0 -6px 30px var(--ytmc-c1) !important;
          transition: box-shadow 1s ease;
        }
        .ytmc-bar-btn {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 1px solid transparent;
          background: transparent;
          color: #b0b0b6;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          margin-left: 4px;
          padding: 0;
          transition: background 0.16s ease, color 0.16s ease, transform 0.12s ease, border-color 0.16s ease;
        }
        .ytmc-bar-btn:hover {
          background: rgba(255, 255, 255, 0.11);
          color: #ffffff;
        }
        .ytmc-bar-btn:active {
          transform: scale(0.92);
        }
        .ytmc-bar-btn.ytmc-btn-active {
          color: var(--ytmc-accent);
          background: var(--ytmc-accent-soft);
          border-color: rgba(255, 255, 255, 0.14);
        }
        tp-yt-paper-tab[data-ytmc-forced="true"] {
          color: #ffffff !important;
          opacity: 1 !important;
          box-shadow: inset 0 -2px 0 var(--ytmc-accent, #ffffff);
        }
        #ytmc-inline-lyrics {
          position: relative;
          display: none;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
          height: 100%;
          overflow: hidden;
          font-family: "Segoe UI Variable", "Segoe UI", Roboto, sans-serif;
          color: #f4f4f6;
        }
        .ytmc-lyrics-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px;
          padding: 10px 8px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.09);
          background: rgba(16, 16, 20, 0.45);
          backdrop-filter: blur(10px);
          border-radius: 10px 10px 0 0;
        }
        .ytmc-lyrics-stepper {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px;
          border-radius: 9px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .ytmc-lyrics-sync-label {
          font-size: 11.5px;
          font-weight: 500;
          color: rgba(255, 255, 255, 0.78);
          padding: 0 6px;
          font-variant-numeric: tabular-nums;
        }
        .ytmc-pill-btn {
          background: rgba(255, 255, 255, 0.08);
          color: #ececef;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 7px;
          padding: 4px 9px;
          font-size: 11.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
        }
        .ytmc-pill-btn:hover {
          background: rgba(255, 255, 255, 0.16);
          color: #ffffff;
        }
        .ytmc-pill-btn:active {
          transform: scale(0.95);
        }
        .ytmc-pill-btn.ytmc-pill-accent {
          background: var(--ytmc-accent-soft);
          border-color: var(--ytmc-accent);
          color: #ffffff;
        }
        .ytmc-pill-btn.ytmc-pill-success {
          background: rgba(34, 197, 94, 0.18);
          border-color: rgba(34, 197, 94, 0.5);
          color: #86efac;
        }
        #ytmc-inline-lyrics-body {
          position: relative;
          flex: 1 1 auto;
          overflow-y: auto;
          padding: 16px 8px 56px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          scroll-behavior: smooth;
        }
        #ytmc-inline-lyrics-body::-webkit-scrollbar {
          width: 6px;
        }
        #ytmc-inline-lyrics-body::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 999px;
        }
        #ytmc-inline-lyrics-body::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.34);
        }
        .ytmc-lyrics-badge {
          font-size: 11.5px;
          color: rgba(255, 255, 255, 0.56);
          margin-bottom: 8px;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          align-self: flex-start;
        }
        .ytmc-lyric-line {
          font-size: 18px;
          line-height: 1.48;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.46);
          padding: 8px 12px;
          border-radius: 10px;
          border-left: 3px solid transparent;
          cursor: pointer;
          transform-origin: left center;
          transition: color 0.22s ease, transform 0.22s ease, background 0.22s ease, border-color 0.22s ease;
        }
        .ytmc-lyric-line:hover {
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.85);
        }
        .ytmc-lyric-line.ytmc-lyric-past {
          color: rgba(255, 255, 255, 0.30);
        }
        .ytmc-lyric-line.ytmc-lyric-active {
          color: #ffffff;
          font-weight: 700;
          background: rgba(255, 255, 255, 0.09);
          border-left-color: var(--ytmc-accent);
          transform: scale(1.015);
          text-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
        }
        .ytmc-skeleton-line {
          height: 20px;
          border-radius: 8px;
          background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.05) 75%);
          background-size: 200% 100%;
          animation: ytmcShimmer 1.4s infinite linear;
          margin-bottom: 10px;
        }
        @keyframes ytmcShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .ytmc-lyrics-state-card {
          margin-top: 28px;
          padding: 20px 18px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
        }
        #ytmc-resume-sync {
          position: absolute;
          left: 50%;
          bottom: 14px;
          transform: translateX(-50%);
          z-index: 5;
          display: none;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(20, 20, 26, 0.92);
          backdrop-filter: blur(12px);
          color: #ffffff;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
          transition: transform 0.15s ease, background 0.15s ease;
        }
        #ytmc-resume-sync:hover {
          background: rgba(34, 34, 42, 0.96);
          transform: translateX(-50%) translateY(-1px);
        }
      `;
      document.head.appendChild(style);
    }

    let bg = document.getElementById('ytmc-ambient-bg');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'ytmc-ambient-bg';
      document.body.appendChild(bg);
      applyAmbientColors(true);
    }
  }

  function applyAmbientColors(forceBroadcast = false) {
    const bg = document.getElementById('ytmc-ambient-bg');
    const root = document.documentElement;
    if (!root) return;

    root.style.setProperty('--ytmc-c1', rgbToCss(currentPalette.primary, 0.25));
    root.style.setProperty('--ytmc-c2', rgbToCss(currentPalette.secondary, 0.22));
    root.style.setProperty('--ytmc-accent', rgbToCss(currentPalette.primary, 1));
    root.style.setProperty('--ytmc-accent-soft', rgbToCss(currentPalette.primary, 0.18));

    if (bg) {
      bg.classList.toggle('ytmc-active', Boolean(settings.ambientThemeEnabled));
    }
    if (document.body) {
      document.body.classList.toggle('ytmc-ambient-on', Boolean(settings.ambientThemeEnabled));
    }

    const sig = `${Boolean(settings.ambientThemeEnabled)}:${currentPalette.primary.join(',')}:${currentPalette.secondary.join(',')}`;
    if (forceBroadcast || sig !== lastPublishedThemeSig) {
      lastPublishedThemeSig = sig;
      postToPage('visualizer-theme', {
        primary: currentPalette.primary,
        secondary: currentPalette.secondary,
      });
      ipcRenderer.send('player:theme-changed', currentPalette);
    }
  }

  async function updateArtworkColors(artworkUrl) {
    if (!isAllowedArtworkUrl(artworkUrl) || artworkUrl === lastArtworkUrl) return;
    try {
      const dataUrl = await ipcRenderer.invoke('artwork:fetch-data-url', artworkUrl);
      if (!isSafeRasterDataUrl(dataUrl) || artworkUrl !== currentTrack.artworkUrl) return;
      lastArtworkUrl = artworkUrl;
      currentPalette = await extractPaletteFromDataUrl(dataUrl);
      if (artworkUrl !== currentTrack.artworkUrl) return;
      applyAmbientColors();
    } catch {
      // Ignore transient artwork errors
    }
  }

  function isPlayerPageOpen(playerPage) {
    if (!playerPage) return false;
    const uiState = playerPage.getAttribute('player-ui-state');
    if (
      uiState === 'MINIPLAYER' ||
      uiState === 'PLAYER_BAR_ONLY' ||
      uiState === 'INACTIVE' ||
      uiState === 'HIDDEN'
    ) {
      return false;
    }
    const appLayout = document.querySelector('ytmusic-app-layout');
    const toggleBtn = document.querySelector('ytmusic-player-bar .toggle-player-page-button');
    const hasOpenAttr =
      playerPage.hasAttribute('player-page-open_') ||
      playerPage.hasAttribute('player-page-open') ||
      Boolean(
        appLayout &&
          (appLayout.hasAttribute('player-page-open_') ||
            appLayout.hasAttribute('player-page-open'))
      ) ||
      uiState === 'PLAYER_PAGE_OPEN' ||
      Boolean(toggleBtn && toggleBtn.getAttribute('aria-expanded') === 'true');

    const style = window.getComputedStyle ? window.getComputedStyle(playerPage) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return false;
    }
    if (hasOpenAttr) {
      return true;
    }
    const rect =
      typeof playerPage.getBoundingClientRect === 'function'
        ? playerPage.getBoundingClientRect()
        : null;
    return Boolean(
      rect && rect.height > 120 && rect.top < (window.innerHeight || 0) - 80
    );
  }

  function getSelectedTabIndex(ctx) {
    if (!ctx) return -1;
    if (ctx.tabsEl) {
      const rawProp = ctx.tabsEl.selected;
      if (rawProp !== undefined && rawProp !== null && rawProp !== '') {
        const n = Number(rawProp);
        if (Number.isFinite(n)) return n;
      }
      const rawAttr = ctx.tabsEl.getAttribute('selected');
      if (rawAttr !== null && rawAttr !== '') {
        const n = Number(rawAttr);
        if (Number.isFinite(n)) return n;
      }
    }
    return ctx.tabs.findIndex(
      (tab) =>
        tab.classList.contains('iron-selected') || tab.getAttribute('aria-selected') === 'true'
    );
  }

  function getPlayerPageContext() {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (!playerPage) return null;
    const sidePanel = playerPage.querySelector('#side-panel');
    if (!sidePanel) return null;
    const tabsEl = sidePanel.querySelector('tp-yt-paper-tabs');
    const tabs = tabsEl ? Array.from(tabsEl.querySelectorAll('tp-yt-paper-tab')) : [];
    const lyricsTab = tabs[1] || null;
    const tabRenderer = sidePanel.querySelector(
      '#tab-renderer, tp-yt-iron-pages, iron-pages, ytmusic-tab-renderer'
    );
    const allNativePanels = Array.from(
      sidePanel.querySelectorAll('tp-yt-iron-pages, iron-pages, #tab-renderer, ytmusic-tab-renderer')
    ).filter((el) => !el.closest('#ytmc-inline-lyrics'));
    return { playerPage, sidePanel, tabsEl, tabs, lyricsTab, tabRenderer, allNativePanels };
  }

  function updateOffsetResetState() {
    if (offsetResetBtn) {
      offsetResetBtn.classList.toggle('ytmc-pill-accent', Math.abs(syncOffsetSec) > 0.01);
    }
  }

  function pauseAutoScrollTemporarily() {
    userScrollPaused = true;
    if (resumeSyncBtnEl && isLyricsViewVisible && lyricsData.synced && lyricsData.synced.length > 0) {
      resumeSyncBtnEl.style.display = 'inline-flex';
    }
    clearTimeout(scrollResumeTimer);
    scrollResumeTimer = setTimeout(() => {
      userScrollPaused = false;
      if (resumeSyncBtnEl) resumeSyncBtnEl.style.display = 'none';
      if (activeLineIndex >= 0 && lineElements[activeLineIndex]) {
        scrollToActiveLine(lineElements[activeLineIndex]);
      }
    }, 6500);
  }

  function scrollToActiveLine(el) {
    if (!el || !inlineBodyEl) return;
    isProgrammaticScroll = true;
    clearTimeout(programmaticScrollTimer);
    const targetTop = el.offsetTop - inlineBodyEl.clientHeight * 0.42 + el.clientHeight / 2;
    inlineBodyEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    programmaticScrollTimer = setTimeout(() => {
      isProgrammaticScroll = false;
      programmaticScrollTimer = null;
    }, 900);
  }

  function getCopyableLyricsText() {
    if (lyricsData.synced && lyricsData.synced.length > 0) {
      return lyricsData.synced.map((item) => item.text).filter(Boolean).join('\n');
    }
    return lyricsData.plain || '';
  }

  function ensureInlineLyricsContainer(ctx) {
    if (!ctx || !ctx.sidePanel) return null;

    if (!inlineContainerEl || !ctx.sidePanel.contains(inlineContainerEl)) {
      inlineContainerEl = document.createElement('div');
      inlineContainerEl.id = 'ytmc-inline-lyrics';

      const syncBar = document.createElement('div');
      syncBar.className = 'ytmc-lyrics-toolbar';

      const t = getLyricsStrings();

      const stepper = document.createElement('div');
      stepper.className = 'ytmc-lyrics-stepper';

      const makeMiniBtn = (txt, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ytmc-pill-btn';
        b.textContent = txt || '';
        b.addEventListener('click', fn);
        return b;
      };

      offsetMinusBtn = makeMiniBtn(t.minusHalf, () => {
        syncOffsetSec = Number((syncOffsetSec - 0.5).toFixed(1));
        offsetLabelEl.textContent = formatSyncOffset();
        updateOffsetResetState();
        updateLyricsPlaybackTime(lastPlaybackTime, true);
      });
      stepper.appendChild(offsetMinusBtn);

      offsetLabelEl = document.createElement('span');
      offsetLabelEl.className = 'ytmc-lyrics-sync-label';
      offsetLabelEl.textContent = formatSyncOffset();
      stepper.appendChild(offsetLabelEl);

      offsetPlusBtn = makeMiniBtn(t.plusHalf, () => {
        syncOffsetSec = Number((syncOffsetSec + 0.5).toFixed(1));
        offsetLabelEl.textContent = formatSyncOffset();
        updateOffsetResetState();
        updateLyricsPlaybackTime(lastPlaybackTime, true);
      });
      stepper.appendChild(offsetPlusBtn);

      offsetResetBtn = makeMiniBtn(t.reset, () => {
        syncOffsetSec = 0;
        offsetLabelEl.textContent = formatSyncOffset();
        updateOffsetResetState();
        updateLyricsPlaybackTime(lastPlaybackTime, true);
      });
      stepper.appendChild(offsetResetBtn);

      const rightControls = document.createElement('div');
      Object.assign(rightControls.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      });

      copyLyricsBtn = makeMiniBtn(t.copyBtn, async () => {
        const txt = getCopyableLyricsText();
        if (!txt) return;
        try {
          await navigator.clipboard.writeText(txt);
          const curT = getLyricsStrings();
          copyLyricsBtn.textContent = curT.copiedBtn || 'Copied!';
          copyLyricsBtn.classList.add('ytmc-pill-success');
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => {
            if (copyLyricsBtn) {
              copyLyricsBtn.textContent = getLyricsStrings().copyBtn || 'Copy';
              copyLyricsBtn.classList.remove('ytmc-pill-success');
            }
          }, 1800);
        } catch {
          // Ignore clipboard permissions error
        }
      });
      rightControls.appendChild(copyLyricsBtn);

      nativeToggleBtn = makeMiniBtn(t.nativeBtn, () => {
        showNativeFallback = true;
        syncInlineLyricsState();
      });
      rightControls.appendChild(nativeToggleBtn);

      syncBar.appendChild(stepper);
      syncBar.appendChild(rightControls);
      inlineContainerEl.appendChild(syncBar);

      inlineBodyEl = document.createElement('div');
      inlineBodyEl.id = 'ytmc-inline-lyrics-body';
      const handleUserScrollIntent = () => {
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = null;
        isProgrammaticScroll = false;
        pauseAutoScrollTemporarily();
      };
      inlineBodyEl.addEventListener('wheel', handleUserScrollIntent, { passive: true });
      inlineBodyEl.addEventListener('touchstart', handleUserScrollIntent, { passive: true });
      inlineBodyEl.addEventListener('pointerdown', handleUserScrollIntent, { passive: true });
      inlineBodyEl.addEventListener(
        'scrollend',
        () => {
          clearTimeout(programmaticScrollTimer);
          programmaticScrollTimer = null;
          isProgrammaticScroll = false;
        },
        { passive: true }
      );
      inlineBodyEl.addEventListener(
        'scroll',
        () => {
          if (
            !isProgrammaticScroll &&
            isLyricsViewVisible &&
            lyricsData.synced &&
            lyricsData.synced.length > 0
          ) {
            pauseAutoScrollTemporarily();
          }
        },
        { passive: true }
      );
      inlineContainerEl.appendChild(inlineBodyEl);

      resumeSyncBtnEl = document.createElement('button');
      resumeSyncBtnEl.id = 'ytmc-resume-sync';
      resumeSyncBtnEl.type = 'button';
      resumeSyncBtnEl.textContent = t.resumeSyncBtn || 'Resume auto-scroll';
      resumeSyncBtnEl.addEventListener('click', () => {
        clearTimeout(scrollResumeTimer);
        userScrollPaused = false;
        resumeSyncBtnEl.style.display = 'none';
        if (activeLineIndex >= 0 && lineElements[activeLineIndex]) {
          scrollToActiveLine(lineElements[activeLineIndex]);
        }
      });
      inlineContainerEl.appendChild(resumeSyncBtnEl);
    }

    if (inlineContainerEl.parentNode !== ctx.sidePanel) {
      ctx.sidePanel.appendChild(inlineContainerEl);
    }

    return inlineContainerEl;
  }

  function renderLyricsContent() {
    const ctx = getPlayerPageContext();
    if (!ctx) return;
    ensureInlineLyricsContainer(ctx);
    if (!inlineBodyEl) return;

    inlineBodyEl.replaceChildren();
    lineElements = [];
    activeLineIndex = -1;
    userScrollPaused = false;
    clearTimeout(scrollResumeTimer);
    if (resumeSyncBtnEl) resumeSyncBtnEl.style.display = 'none';
    const t = getLyricsStrings();

    if (copyLyricsBtn) {
      copyLyricsBtn.style.display = getCopyableLyricsText() ? 'inline-block' : 'none';
    }

    if (!currentTrack.title) {
      const card = document.createElement('div');
      card.className = 'ytmc-lyrics-state-card';
      const empty = document.createElement('div');
      empty.textContent = t.empty || '';
      Object.assign(empty.style, {
        color: 'rgba(255,255,255,0.72)',
        fontSize: '14px',
        lineHeight: '1.5',
      });
      card.appendChild(empty);
      inlineBodyEl.appendChild(card);
      return;
    }

    if (lyricsLoading) {
      const loading = document.createElement('div');
      loading.textContent = t.loading || '';
      Object.assign(loading.style, {
        color: 'rgba(255,255,255,0.75)',
        fontSize: '13.5px',
        margin: '10px 0 14px',
      });
      inlineBodyEl.appendChild(loading);
      const widths = ['74%', '88%', '62%', '82%', '54%', '79%'];
      for (const w of widths) {
        const sk = document.createElement('div');
        sk.className = 'ytmc-skeleton-line';
        sk.style.width = w;
        inlineBodyEl.appendChild(sk);
      }
      return;
    }

    if (lyricsData.synced && lyricsData.synced.length > 0) {
      const badge = document.createElement('div');
      badge.className = 'ytmc-lyrics-badge';
      badge.textContent = t.syncedBadge || '';
      inlineBodyEl.appendChild(badge);

      for (const item of lyricsData.synced) {
        const lineEl = document.createElement('div');
        lineEl.className = 'ytmc-lyric-line';
        lineEl.textContent = item.text || '♪';
        lineEl.addEventListener('click', () => {
          userScrollPaused = false;
          if (resumeSyncBtnEl) resumeSyncBtnEl.style.display = 'none';
          postToPage('player-seek', { time: item.time });
        });
        inlineBodyEl.appendChild(lineEl);
        lineElements.push(lineEl);
      }
      updateLyricsPlaybackTime(lastPlaybackTime, true);
      return;
    }

    if (typeof lyricsData.plain === 'string' && lyricsData.plain) {
      const badge = document.createElement('div');
      badge.className = 'ytmc-lyrics-badge';
      badge.textContent = t.plainBadge || '';
      inlineBodyEl.appendChild(badge);

      for (const rawLine of lyricsData.plain.split(/\r?\n/)) {
        const p = document.createElement('div');
        p.textContent = rawLine || ' ';
        Object.assign(p.style, {
          fontSize: '15.5px',
          lineHeight: '1.65',
          color: 'rgba(255, 255, 255, 0.88)',
          minHeight: '14px',
          padding: '0 4px',
        });
        inlineBodyEl.appendChild(p);
      }
      return;
    }

    const card = document.createElement('div');
    card.className = 'ytmc-lyrics-state-card';
    const notFound = document.createElement('div');
    notFound.textContent = t.notFound || '';
    Object.assign(notFound.style, {
      color: 'rgba(255,255,255,0.74)',
      fontSize: '14px',
      lineHeight: '1.5',
    });
    const actionsRow = document.createElement('div');
    Object.assign(actionsRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'ytmc-pill-btn ytmc-pill-accent';
    retryBtn.textContent = t.retryBtn || '';
    retryBtn.addEventListener('click', () => fetchLyricsForCurrentTrack(true));

    const fallbackBtn = document.createElement('button');
    fallbackBtn.type = 'button';
    fallbackBtn.className = 'ytmc-pill-btn';
    fallbackBtn.textContent = t.nativeBtn || '';
    fallbackBtn.addEventListener('click', () => {
      showNativeFallback = true;
      syncInlineLyricsState();
    });

    actionsRow.appendChild(retryBtn);
    actionsRow.appendChild(fallbackBtn);
    card.appendChild(notFound);
    card.appendChild(actionsRow);
    inlineBodyEl.appendChild(card);
  }

  async function fetchLyricsForCurrentTrack(force = false) {
    if (!settings.lyricsEnabled || !currentTrack.title) return;
    const key = `${currentTrack.artist}::${currentTrack.title}`.toLowerCase();
    if (!force && key === currentLyricsKey && (lyricsLoading || lyricsData.found)) return;

    currentLyricsKey = key;
    lyricsLoading = true;
    if (isLyricsViewVisible) renderLyricsContent();

    try {
      const result = await ipcRenderer.invoke('lyrics:fetch', {
        title: currentTrack.title,
        artist: currentTrack.artist,
        duration: currentTrack.duration,
      });

      if (key !== currentLyricsKey) return;
      lyricsData =
        result && typeof result === 'object'
          ? {
              found: Boolean(result.found),
              synced: Array.isArray(result.synced) ? result.synced : [],
              plain: typeof result.plain === 'string' ? result.plain : '',
            }
          : { found: false, synced: [], plain: '' };
    } catch {
      if (key !== currentLyricsKey) return;
      lyricsData = { found: false, synced: [], plain: '' };
    } finally {
      if (key === currentLyricsKey) {
        lyricsLoading = false;
        if (isLyricsViewVisible) renderLyricsContent();
      }
    }
  }

  function updateLyricsPlaybackTime(currentTime, forceScroll = false) {
    if (Number.isFinite(currentTime)) {
      lastPlaybackTime = currentTime;
    }
    if (!isLyricsViewVisible || !lyricsData.synced || lyricsData.synced.length === 0) return;
    const t = lastPlaybackTime + syncOffsetSec;

    let idx = -1;
    for (let i = 0; i < lyricsData.synced.length; i += 1) {
      if (lyricsData.synced[i].time <= t + 0.15) {
        idx = i;
      } else {
        break;
      }
    }

    if (idx === activeLineIndex && !forceScroll) return;

    activeLineIndex = idx;
    for (let i = 0; i < lineElements.length; i += 1) {
      const el = lineElements[i];
      el.classList.toggle('ytmc-lyric-active', i === idx);
      el.classList.toggle('ytmc-lyric-past', idx >= 0 && i < idx);
    }

    if (idx >= 0 && lineElements[idx] && (!userScrollPaused || forceScroll)) {
      scrollToActiveLine(lineElements[idx]);
    }
  }

  function hookTabInteractions(ctx) {
    if (!ctx || !ctx.tabs || ctx.tabs.length < 2) return;

    const lyricsTab = ctx.lyricsTab;
    if (settings.lyricsEnabled && lyricsTab) {
      if (lyricsTab.hasAttribute('disabled')) {
        lyricsTab.removeAttribute('disabled');
      }
      if (lyricsTab.disabled) {
        lyricsTab.disabled = false;
      }
      if (lyricsTab.getAttribute('aria-disabled') !== 'false') {
        lyricsTab.setAttribute('aria-disabled', 'false');
      }
      if (lyricsTab.style.pointerEvents !== 'auto') {
        lyricsTab.style.pointerEvents = 'auto';
      }
      if (lyricsTab.style.opacity !== '1') {
        lyricsTab.style.opacity = '1';
      }
      if (lyricsTab.style.cursor !== 'pointer') {
        lyricsTab.style.cursor = 'pointer';
      }
    }

    const handleTabActivatedByIndex = (idx, isClickPhase) => {
      if (idx === 1 && settings.lyricsEnabled) {
        if (isClickPhase) {
          forcedLyricsTab = true;
          lastForcedLyricsAt = Date.now();
          showNativeFallback = false;
          syncInlineLyricsState();
          setTimeout(syncInlineLyricsState, 30);
        }
      } else {
        forcedLyricsTab = false;
        lastForcedLyricsAt = 0;
        showNativeFallback = false;
        syncInlineLyricsState();
        setTimeout(syncInlineLyricsState, 30);
      }
    };

    if (ctx.tabsEl && !hookedTabs.has(ctx.tabsEl)) {
      hookedTabs.add(ctx.tabsEl);

      const handleDelegatedTabInteraction = (e) => {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        const currentCtx = getPlayerPageContext();
        if (!currentCtx || !currentCtx.tabs.length) return;
        const rawTarget = e.target;
        const targetEl =
          rawTarget && rawTarget.nodeType === 1
            ? rawTarget
            : rawTarget && rawTarget.parentElement;
        const clickedTab =
          targetEl && targetEl.closest ? targetEl.closest('tp-yt-paper-tab') : null;
        if (!clickedTab) return;
        const idx = currentCtx.tabs.indexOf(clickedTab);
        if (idx === -1) return;
        handleTabActivatedByIndex(idx, e.type === 'click' || e.type === 'keydown');
      };

      ctx.tabsEl.addEventListener('pointerdown', handleDelegatedTabInteraction, true);
      ctx.tabsEl.addEventListener('click', handleDelegatedTabInteraction, true);
      ctx.tabsEl.addEventListener('keydown', handleDelegatedTabInteraction, true);

      const handleSelectionChange = (e) => {
        const currentCtx = getPlayerPageContext();
        if (!currentCtx) return;
        let selectedIdx = NaN;
        if (e && e.detail && e.detail.selected !== undefined && e.detail.selected !== null) {
          selectedIdx = Number(e.detail.selected);
        } else if (e && e.detail && e.detail.item) {
          const itemIdx = currentCtx.tabs.indexOf(e.detail.item);
          if (itemIdx >= 0) selectedIdx = itemIdx;
        }
        if (!Number.isFinite(selectedIdx)) {
          selectedIdx = getSelectedTabIndex(currentCtx);
        }

        if (selectedIdx === 1) {
          if (settings.lyricsEnabled) {
            showNativeFallback = false;
          }
        } else if (selectedIdx >= 0) {
          const withinBounceWindow =
            e &&
            e.type !== 'iron-activate' &&
            forcedLyricsTab &&
            Date.now() - lastForcedLyricsAt < 300;
          if (!withinBounceWindow) {
            forcedLyricsTab = false;
            lastForcedLyricsAt = 0;
            showNativeFallback = false;
          }
        }
        syncInlineLyricsState();
        setTimeout(syncInlineLyricsState, 20);
      };

      ctx.tabsEl.addEventListener('selected-changed', handleSelectionChange);
      ctx.tabsEl.addEventListener('iron-select', handleSelectionChange);
      ctx.tabsEl.addEventListener('iron-activate', handleSelectionChange);
    }
  }

  function syncInlineLyricsState() {
    const ctx = getPlayerPageContext();
    if (!ctx) return;

    hookTabInteractions(ctx);
    ensureInlineLyricsContainer(ctx);

    const playerOpen = isPlayerPageOpen(ctx.playerPage);
    if (!playerOpen) {
      forcedLyricsTab = false;
      lastForcedLyricsAt = 0;
      showNativeFallback = false;
    }

    const selectedIdx = getSelectedTabIndex(ctx);
    const nativeLyricsSelected = selectedIdx === 1;
    const lyricsTabActive = Boolean(
      settings.lyricsEnabled && playerOpen && (nativeLyricsSelected || forcedLyricsTab)
    );

    const shouldShowInline = lyricsTabActive && !showNativeFallback;
    const wasVisible = isLyricsViewVisible;
    isLyricsViewVisible = shouldShowInline;

    const showForcedMarker = Boolean(
      shouldShowInline && forcedLyricsTab && !nativeLyricsSelected && ctx.lyricsTab
    );
    for (const tab of ctx.tabs) {
      const wantForced = showForcedMarker && tab === ctx.lyricsTab;
      if (wantForced) {
        if (tab.getAttribute('data-ytmc-forced') !== 'true') {
          tab.setAttribute('data-ytmc-forced', 'true');
        }
      } else if (tab.hasAttribute('data-ytmc-forced')) {
        tab.removeAttribute('data-ytmc-forced');
      }
    }

    if (inlineContainerEl) {
      const nextInlineDisplay = shouldShowInline ? 'flex' : 'none';
      if (inlineContainerEl.style.display !== nextInlineDisplay) {
        inlineContainerEl.style.display = nextInlineDisplay;
      }
    }

    const nextNativeDisplay = shouldShowInline ? 'none' : '';
    for (const panel of ctx.allNativePanels) {
      if (panel.style.display !== nextNativeDisplay) {
        panel.style.display = nextNativeDisplay;
      }
    }

    let backBanner = document.getElementById('ytmc-back-to-synced');
    if (lyricsTabActive && showNativeFallback) {
      if (!backBanner) {
        backBanner = document.createElement('button');
        backBanner.id = 'ytmc-back-to-synced';
        backBanner.type = 'button';
        backBanner.className = 'ytmc-pill-btn ytmc-pill-accent';
        backBanner.textContent = getLyricsStrings().backToSynced || '';
        Object.assign(backBanner.style, {
          margin: '8px 0',
          padding: '6px 12px',
          alignSelf: 'flex-start',
        });
        backBanner.addEventListener('click', () => {
          showNativeFallback = false;
          syncInlineLyricsState();
        });
      }
      if (backBanner.parentNode !== ctx.sidePanel) {
        const anchor =
          ctx.tabsEl && ctx.tabsEl.parentNode === ctx.sidePanel
            ? ctx.tabsEl.nextSibling
            : ctx.tabRenderer && ctx.tabRenderer.parentNode === ctx.sidePanel
              ? ctx.tabRenderer
              : ctx.sidePanel.firstChild;
        ctx.sidePanel.insertBefore(backBanner, anchor);
      }
      if (backBanner.style.display !== 'inline-block') {
        backBanner.style.display = 'inline-block';
      }
    } else if (backBanner && backBanner.style.display !== 'none') {
      backBanner.style.display = 'none';
    }

    if (lyricsToggleBtn) {
      lyricsToggleBtn.style.display = settings.lyricsEnabled ? 'inline-flex' : 'none';
      lyricsToggleBtn.classList.toggle('ytmc-btn-active', shouldShowInline);
      lyricsToggleBtn.setAttribute('aria-pressed', shouldShowInline ? 'true' : 'false');
    }

    if (shouldShowInline && !wasVisible) {
      renderLyricsContent();
      fetchLyricsForCurrentTrack(false);
    }
  }

  function activateLyricsTab(ctx) {
    if (!ctx || !ctx.lyricsTab) return;
    hookTabInteractions(ctx);
    showNativeFallback = false;
    forcedLyricsTab = true;
    lastForcedLyricsAt = Date.now();
    ctx.lyricsTab.click();
    syncInlineLyricsState();
  }

  function openOrToggleLyricsTab() {
    if (!settings.lyricsEnabled) return;
    const ctx = getPlayerPageContext();
    if (!ctx) return;

    const isPlayerOpen = isPlayerPageOpen(ctx.playerPage);
    if (!isPlayerOpen) {
      const toggleBtn =
        document.querySelector('ytmusic-player-bar .toggle-player-page-button') ||
        document.querySelector('ytmusic-player-bar .middle-controls') ||
        document.querySelector('ytmusic-miniplayer ytmusic-track-info');
      if (toggleBtn) toggleBtn.click();
      setTimeout(() => {
        const refreshed = getPlayerPageContext();
        if (refreshed && refreshed.lyricsTab) {
          activateLyricsTab(refreshed);
        }
      }, 220);
      return;
    }

    if (isLyricsViewVisible && ctx.tabs[0]) {
      forcedLyricsTab = false;
      lastForcedLyricsAt = 0;
      showNativeFallback = false;
      ctx.tabs[0].click();
      syncInlineLyricsState();
    } else if (ctx.lyricsTab) {
      activateLyricsTab(ctx);
    }
  }

  function bindPlayerBarButton(btn, onActivate) {
    const stopBubble = (e) => {
      e.stopPropagation();
    };
    for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'tap']) {
      btn.addEventListener(eventName, stopBubble);
    }
    for (const eventName of ['touchstart', 'touchend']) {
      btn.addEventListener(eventName, stopBubble, { passive: true });
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!e.isTrusted) return;
      onActivate();
    });
  }

  function ensurePlayerBarButtons() {
    const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons');
    if (!rightControls) return;
    const t = getLyricsStrings();

    if (!document.getElementById('ytmc-miniplayer-btn') && typeof onToggleMiniPlayer === 'function') {
      const mpBtn = document.createElement('button');
      mpBtn.id = 'ytmc-miniplayer-btn';
      mpBtn.type = 'button';
      mpBtn.className = 'ytmc-bar-btn';
      mpBtn.title = t.miniPlayerBtnTooltip || '';
      mpBtn.setAttribute('aria-label', t.miniPlayerBtnTooltip || '');
      mpBtn.setAttribute('aria-pressed', isMiniPlayerOpen ? 'true' : 'false');
      mpBtn.appendChild(
        createSvgIcon([
          'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
        ])
      );
      bindPlayerBarButton(mpBtn, onToggleMiniPlayer);
      rightControls.prepend(mpBtn);
      miniPlayerToggleBtn = mpBtn;
    }

    if (!document.getElementById('ytmc-lyrics-btn')) {
      const btn = document.createElement('button');
      btn.id = 'ytmc-lyrics-btn';
      btn.type = 'button';
      btn.className = 'ytmc-bar-btn';
      btn.title = t.lyricsBtnTooltip || '';
      btn.setAttribute('aria-label', t.lyricsBtnTooltip || '');
      btn.setAttribute('aria-pressed', isLyricsViewVisible ? 'true' : 'false');
      btn.appendChild(
        createSvgIcon([
          'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
        ])
      );
      bindPlayerBarButton(btn, openOrToggleLyricsTab);
      rightControls.prepend(btn);
      lyricsToggleBtn = btn;
    }

    if (!document.getElementById('ytmc-settings-btn')) {
      const gearBtn = document.createElement('button');
      gearBtn.id = 'ytmc-settings-btn';
      gearBtn.type = 'button';
      gearBtn.className = 'ytmc-bar-btn';
      gearBtn.title = t.settingsBtnTooltip || '';
      gearBtn.setAttribute('aria-label', t.settingsBtnTooltip || '');
      gearBtn.appendChild(
        createSvgIcon([
          'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
        ])
      );
      bindPlayerBarButton(gearBtn, onOpenSettings);
      rightControls.prepend(gearBtn);
      settingsBtn = gearBtn;
    }

    if (lyricsToggleBtn) {
      lyricsToggleBtn.style.display = settings.lyricsEnabled ? 'inline-flex' : 'none';
      lyricsToggleBtn.classList.toggle('ytmc-btn-active', isLyricsViewVisible);
      lyricsToggleBtn.setAttribute('aria-pressed', isLyricsViewVisible ? 'true' : 'false');
    }
    if (miniPlayerToggleBtn) {
      miniPlayerToggleBtn.classList.toggle('ytmc-btn-active', isMiniPlayerOpen);
      miniPlayerToggleBtn.setAttribute('aria-pressed', isMiniPlayerOpen ? 'true' : 'false');
    }
  }

  function setMiniPlayerVisible(visible) {
    isMiniPlayerOpen = Boolean(visible);
    if (miniPlayerToggleBtn) {
      miniPlayerToggleBtn.classList.toggle('ytmc-btn-active', isMiniPlayerOpen);
      miniPlayerToggleBtn.setAttribute('aria-pressed', isMiniPlayerOpen ? 'true' : 'false');
    }
  }

  function applySettings(newSettings) {
    if (!newSettings || typeof newSettings !== 'object') return;
    const prevLang = resolveLanguage(settings.language, systemLocale);
    settings = { ...settings, ...newSettings };
    const nextLang = resolveLanguage(settings.language, systemLocale);
    ensureAmbientElements();
    applyAmbientColors();
    ensurePlayerBarButtons();

    if (
      settings.ambientThemeEnabled &&
      currentTrack.artworkUrl &&
      currentTrack.artworkUrl !== lastArtworkUrl
    ) {
      updateArtworkColors(currentTrack.artworkUrl);
    }

    if (!settings.lyricsEnabled) {
      forcedLyricsTab = false;
      lastForcedLyricsAt = 0;
      showNativeFallback = false;
    }

    if (prevLang !== nextLang) {
      const t = getLyricsStrings();
      if (offsetLabelEl) offsetLabelEl.textContent = formatSyncOffset();
      if (offsetMinusBtn) offsetMinusBtn.textContent = t.minusHalf || '';
      if (offsetPlusBtn) offsetPlusBtn.textContent = t.plusHalf || '';
      if (offsetResetBtn) offsetResetBtn.textContent = t.reset || '';
      if (copyLyricsBtn) copyLyricsBtn.textContent = t.copyBtn || '';
      if (nativeToggleBtn) nativeToggleBtn.textContent = t.nativeBtn || '';
      if (resumeSyncBtnEl) resumeSyncBtnEl.textContent = t.resumeSyncBtn || '';
      const backBanner = document.getElementById('ytmc-back-to-synced');
      if (backBanner) backBanner.textContent = t.backToSynced || '';
      if (lyricsToggleBtn) {
        lyricsToggleBtn.title = t.lyricsBtnTooltip || '';
        lyricsToggleBtn.setAttribute('aria-label', t.lyricsBtnTooltip || '');
      }
      if (miniPlayerToggleBtn) {
        miniPlayerToggleBtn.title = t.miniPlayerBtnTooltip || '';
        miniPlayerToggleBtn.setAttribute('aria-label', t.miniPlayerBtnTooltip || '');
      }
      if (settingsBtn) {
        settingsBtn.title = t.settingsBtnTooltip || '';
        settingsBtn.setAttribute('aria-label', t.settingsBtnTooltip || '');
      }
      renderLyricsContent();
    }
    syncInlineLyricsState();
  }

  function handlePlayerState(state) {
    if (!state) return;
    const prevKey = `${currentTrack.artist}::${currentTrack.title}`.toLowerCase();
    const nextArtwork = isAllowedArtworkUrl(state.artworkUrl) ? state.artworkUrl : '';
    currentTrack = {
      title: typeof state.title === 'string' ? state.title : '',
      artist: typeof state.artist === 'string' ? state.artist : '',
      duration: Number.isFinite(state.duration) ? state.duration : 0,
      artworkUrl: nextArtwork,
      videoId: typeof state.videoId === 'string' ? state.videoId : '',
    };
    const nextKey = `${currentTrack.artist}::${currentTrack.title}`.toLowerCase();

    if (settings.ambientThemeEnabled && currentTrack.artworkUrl) {
      updateArtworkColors(currentTrack.artworkUrl);
    }

    if (nextKey !== prevKey) {
      syncOffsetSec = 0;
      activeLineIndex = -1;
      lastPlaybackTime = 0;
      currentLyricsKey = '';
      lyricsLoading = false;
      userScrollPaused = false;
      clearTimeout(scrollResumeTimer);
      clearTimeout(programmaticScrollTimer);
      programmaticScrollTimer = null;
      isProgrammaticScroll = false;
      if (resumeSyncBtnEl) resumeSyncBtnEl.style.display = 'none';
      if (offsetLabelEl) offsetLabelEl.textContent = formatSyncOffset();
      updateOffsetResetState();
      lyricsData = { found: false, synced: [], plain: '' };
      if (isLyricsViewVisible) {
        fetchLyricsForCurrentTrack(true);
      }
    }
  }

  let uiSyncTimer = null;
  function scheduleUiSync() {
    if (uiSyncTimer !== null) return;
    uiSyncTimer = setTimeout(() => {
      uiSyncTimer = null;
      ensureAmbientElements();
      ensurePlayerBarButtons();
      syncInlineLyricsState();
    }, 150);
  }

  function initDomObservers() {
    ensureAmbientElements();
    ensurePlayerBarButtons();
    syncInlineLyricsState();

    const observer = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i += 1) {
        const mut = mutations[i];
        const target = mut.target;
        if (
          target &&
          target.nodeType === 1 &&
          target.closest &&
          target.closest('#ytmc-inline-lyrics, #ytmc-ambient-bg, #ytmc-back-to-synced, .ytmc-bar-btn')
        ) {
          continue;
        }
        if (mut.type === 'attributes') {
          if (
            target &&
            target.nodeType === 1 &&
            ((target.closest && target.closest('ytmusic-player-page #side-panel')) ||
              target.tagName === 'YTMUSIC-PLAYER-PAGE' ||
              target.tagName === 'YTMUSIC-APP-LAYOUT')
          ) {
            scheduleUiSync();
            break;
          }
          continue;
        }
        if (
          !document.getElementById('ytmc-settings-btn') ||
          !document.getElementById('ytmc-ambient-bg') ||
          (target && target.closest && target.closest('ytmusic-player-page #side-panel'))
        ) {
          scheduleUiSync();
          break;
        }
      }
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'selected',
          'aria-selected',
          'class',
          'player-page-open_',
          'player-page-open',
          'player-ui-state',
        ],
      });
    }

    setInterval(() => {
      if (document.hidden) return;
      if (!document.getElementById('ytmc-settings-btn') || !document.getElementById('ytmc-ambient-bg')) {
        ensureAmbientElements();
        ensurePlayerBarButtons();
      }
      syncInlineLyricsState();
    }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomObservers, { once: true });
  } else {
    initDomObservers();
  }

  return {
    applySettings,
    handlePlayerState,
    updateLyricsPlaybackTime,
    setMiniPlayerVisible,
    syncThemeToPage: () => applyAmbientColors(true),
    toggleLyricsDrawer: openOrToggleLyricsTab,
  };
}

function initMusicAndAuthPreload(bootstrap, translations, systemLocale) {
  let isHttps = false;
  let hostname = '';
  try {
    isHttps = window.location.protocol === 'https:';
    hostname = window.location.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return;
  }
  if (!isHttps || !hostname) return;

  const authHosts = new Set(Array.isArray(bootstrap.authHosts) ? bootstrap.authHosts : []);
  const isMusicHost = hostname === 'music.youtube.com';
  const isAuthPage = authHosts.has(hostname);

  if ((isMusicHost || isAuthPage) && bootstrap.authPatcherCode && bootstrap.authEnv) {
    try {
      const effectiveMode = isAuthPage ? bootstrap.authEnv.mode || 'chrome' : 'chrome';
      const payload = JSON.stringify({
        mode: effectiveMode,
        chromeMajor: bootstrap.authEnv.chromeMajor,
        chromeUa: bootstrap.authEnv.chromeUa,
        firefoxUa: bootstrap.authEnv.firefoxUa,
      });
      webFrame
        .executeJavaScript(`(${bootstrap.authPatcherCode})(${payload});`)
        .catch((err) => {
          console.error('[Preload] Auth patcher failed:', err);
        });
    } catch (err) {
      console.error('[Preload] Failed to initialize auth patcher:', err);
    }
  }

  if (!isMusicHost) return;

  let currentSettings = null;
  let lastCategoriesSignature = '';

  function postToPage(type, payload) {
    if (window.location.origin !== MUSIC_ORIGIN) return;
    window.postMessage({ source: 'ytmc-preload', type, payload }, MUSIC_ORIGIN);
  }

  function getAppStrings(cfg = currentSettings) {
    const lang = resolveLanguage(cfg && cfg.language, systemLocale);
    return getTranslations(translations, lang);
  }

  function buildPageConfig(cfg, refetchSponsorBlock = false) {
    const t = getAppStrings(cfg);
    return {
      adBlockEnabled: Boolean(cfg && cfg.adBlockEnabled),
      sponsorBlockEnabled: Boolean(cfg && cfg.sponsorBlockEnabled),
      visualizerEnabled: Boolean(cfg && cfg.visualizerEnabled),
      sponsorBlockToast: (t.sponsorBlock && t.sponsorBlock.skippedToast) || '',
      sponsorBlockCategories: (t.sponsorBlock && t.sponsorBlock.categories) || {},
      refetchSponsorBlock,
    };
  }

  const enhancements = createEnhancementsController({
    translations,
    systemLocale,
    postToPage,
    onToggleMiniPlayer: () => {
      ipcRenderer.send('ui:toggle-miniplayer');
    },
    onOpenSettings: () => {
      ipcRenderer.send('ui:open-settings', 'general');
    },
  });

  if (typeof bootstrap.pagePatcherCode === 'string' && bootstrap.pagePatcherCode) {
    webFrame.executeJavaScript(bootstrap.pagePatcherCode).catch((err) => {
      console.error('[Preload] Failed to inject page patcher:', err);
    });
  }

  ipcRenderer.invoke('settings:get').then((cfg) => {
    currentSettings = cfg;
    lastCategoriesSignature = Array.isArray(cfg && cfg.sponsorBlockCategories)
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
  });

  ipcRenderer.on('miniplayer:visibility', (_event, visible) => {
    enhancements.setMiniPlayerVisible(Boolean(visible));
  });

  ipcRenderer.on('ui:toggle-lyrics', () => {
    enhancements.toggleLyricsDrawer();
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

  const allowAdBlocked = createWindowRateLimiter(1000, 20);
  const allowSbSkipped = createWindowRateLimiter(2000, 5);
  const allowSbRequest = createWindowRateLimiter(5000, 10);

  window.addEventListener('message', async (event) => {
    if (
      event.origin !== MUSIC_ORIGIN ||
      event.source !== window ||
      !event.data ||
      typeof event.data !== 'object' ||
      Array.isArray(event.data) ||
      event.data.source !== 'ytmc-page'
    ) {
      return;
    }

    const { type, payload } = event.data;
    if (typeof type !== 'string') return;

    if (type === 'page-ready') {
      if (currentSettings) {
        postToPage('config', buildPageConfig(currentSettings));
      }
      enhancements.syncThemeToPage();
    } else if (type === 'ad-blocked') {
      if (allowAdBlocked()) {
        ipcRenderer.send('adblock:blocked');
      }
    } else if (type === 'sponsorblock-skipped') {
      if (allowSbSkipped()) {
        ipcRenderer.send('sponsorblock:skipped');
      }
    } else if (type === 'player-state') {
      const cleanState = sanitizePlayerState(payload);
      if (!cleanState) return;
      ipcRenderer.send('player:state-changed', cleanState);
      enhancements.handlePlayerState(cleanState);
    } else if (
      type === 'player-time' &&
      payload &&
      typeof payload === 'object' &&
      typeof payload.currentTime === 'number' &&
      Number.isFinite(payload.currentTime) &&
      payload.currentTime >= 0
    ) {
      const safeTime = Math.min(MAX_SEEK_SECONDS, payload.currentTime);
      ipcRenderer.send('player:time-changed', safeTime);
      enhancements.updateLyricsPlaybackTime(safeTime);
    } else if (
      type === 'sponsorblock-request' &&
      payload &&
      typeof payload === 'object' &&
      typeof payload.videoId === 'string'
    ) {
      const videoId = payload.videoId.trim();
      if (!VIDEO_ID_RE.test(videoId) || !allowSbRequest()) return;
      const segments = await ipcRenderer.invoke('sponsorblock:fetch', videoId);
      postToPage('sponsorblock-segments', {
        videoId,
        segments,
      });
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
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
      ipcRenderer.send('ui:open-settings', 'general');
    } else if ((e.ctrlKey || e.metaKey) && !isTyping && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      enhancements.toggleLyricsDrawer();
    }
  });
}

(function bootstrapMainPreload() {
  const bootstrap = readBootstrapSync();
  const translations =
    bootstrap.translations && typeof bootstrap.translations === 'object' ? bootstrap.translations : {};
  const systemLocale =
    typeof bootstrap.locale === 'string' && bootstrap.locale
      ? bootstrap.locale
      : navigator.language || '';

  if (isOfflinePage()) {
    initOfflinePreload(translations, systemLocale);
  } else {
    initMusicAndAuthPreload(bootstrap, translations, systemLocale);
  }
})();
