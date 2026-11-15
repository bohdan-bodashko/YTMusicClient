const { ipcRenderer } = require('electron');

function createSvgIcon(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
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

function extractPaletteFromDataUrl(dataUrl) {
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

          // Skip near-black, near-white, and desaturated grays when possible
          if (luma < 22 || luma > 235) continue;
          const weight = sat * 2.5 + 0.2;

          // Quantize into 24-step buckets
          const qr = Math.round(r / 24) * 24;
          const qg = Math.round(g / 24) * 24;
          const qb = Math.round(b / 24) * 24;
          const key = `${qr},${qg},${qb}`;
          const prev = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0, count: 0 };
          prev.r += r * weight;
          prev.g += g * weight;
          prev.b += b * weight;
          prev.w += weight;
          prev.count += 1;
          buckets.set(key, prev);
        }

        const sorted = [...buckets.values()].sort((a, b) => b.w - a.w);
        if (sorted.length === 0) {
          resolve({ primary: [255, 45, 85], secondary: [120, 40, 200] });
          return;
        }

        const p = sorted[0];
        const primary = [
          Math.min(255, Math.round(p.r / p.w)),
          Math.min(255, Math.round(p.g / p.w)),
          Math.min(255, Math.round(p.b / p.w)),
        ];

        let secondary = primary;
        for (let i = 1; i < sorted.length; i += 1) {
          const cand = sorted[i];
          const cr = Math.round(cand.r / cand.w);
          const cg = Math.round(cand.g / cand.w);
          const cb = Math.round(cand.b / cand.w);
          const dist = Math.hypot(cr - primary[0], cg - primary[1], cb - primary[2]);
          if (dist > 55) {
            secondary = [cr, cg, cb];
            break;
          }
        }

        resolve({ primary, secondary });
      } catch {
        resolve({ primary: [255, 45, 85], secondary: [120, 40, 200] });
      }
    };
    img.onerror = () => resolve({ primary: [255, 45, 85], secondary: [120, 40, 200] });
    img.src = dataUrl;
  });
}

function createEnhancementsController({ onOpenSettings, postToPage }) {
  let settings = {
    ambientThemeEnabled: true,
    visualizerEnabled: true,
    lyricsEnabled: true,
  };

  let currentTrack = {
    title: '',
    artist: '',
    duration: 0,
    artworkUrl: '',
    videoId: '',
  };

  let lastArtworkUrl = '';
  let currentPalette = { primary: [255, 45, 85], secondary: [90, 60, 200] };

  // Lyrics state (embedded inside YT Music's standard "Текст" / "Lyrics" tab)
  let isLyricsViewVisible = false;
  let forcedLyricsTab = false;
  let showNativeFallback = false;
  let lyricsLoading = false;
  let currentLyricsKey = '';
  let lyricsData = { found: false, synced: [], plain: '' };
  let activeLineIndex = -1;
  let syncOffsetSec = 0;

  let inlineContainerEl = null;
  let inlineBodyEl = null;
  let offsetLabelEl = null;
  let nativeToggleBtn = null;
  let lineElements = [];
  let lyricsToggleBtn = null;
  let hookedTabs = new WeakSet();

  // ---- 1. Adaptive Ambient Background ----
  function ensureAmbientElements() {
    if (!document.head || !document.body) return;

    if (!document.getElementById('ytmc-ambient-style')) {
      const style = document.createElement('style');
      style.id = 'ytmc-ambient-style';
      style.textContent = `
        :root {
          --ytmc-c1: rgba(255, 45, 85, 0.22);
          --ytmc-c2: rgba(90, 60, 200, 0.20);
          --ytmc-accent: rgb(255, 45, 85);
        }
        #ytmc-ambient-bg {
          position: fixed;
          inset: 0;
          z-index: 2;
          pointer-events: none;
          mix-blend-mode: screen;
          background:
            radial-gradient(circle at 18% 22%, var(--ytmc-c1) 0%, transparent 56%),
            radial-gradient(circle at 82% 76%, var(--ytmc-c2) 0%, transparent 58%);
          transition: opacity 0.6s ease;
          opacity: 0;
        }
        #ytmc-ambient-bg.ytmc-active {
          opacity: 1;
        }
        body.ytmc-ambient-on ytmusic-player-bar {
          background: linear-gradient(90deg, rgba(24,24,24,0.92), rgba(28,28,32,0.94)) !important;
          border-top: 1px solid rgba(255,255,255,0.12) !important;
          box-shadow: 0 -6px 28px var(--ytmc-c1) !important;
          transition: box-shadow 1s ease;
        }
        .ytmc-bar-btn {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: #aaaaaa;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          margin-left: 4px;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .ytmc-bar-btn:hover {
          background: rgba(255,255,255,0.1);
          color: #ffffff;
        }
        .ytmc-bar-btn.ytmc-btn-active {
          color: var(--ytmc-accent);
          background: rgba(255,255,255,0.1);
        }
        #ytmc-inline-lyrics {
          display: none;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
          height: 100%;
          overflow: hidden;
          font-family: Roboto, Segoe UI, sans-serif;
          color: #f1f1f1;
        }
        #ytmc-inline-lyrics-body::-webkit-scrollbar {
          width: 6px;
        }
        #ytmc-inline-lyrics-body::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 3px;
        }
      `;
      document.head.appendChild(style);
    }

    let bg = document.getElementById('ytmc-ambient-bg');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'ytmc-ambient-bg';
      document.body.appendChild(bg);
    }
    applyAmbientColors();
  }

  function applyAmbientColors() {
    const bg = document.getElementById('ytmc-ambient-bg');
    const root = document.documentElement;
    if (!root) return;

    root.style.setProperty('--ytmc-c1', rgbToCss(currentPalette.primary, 0.25));
    root.style.setProperty('--ytmc-c2', rgbToCss(currentPalette.secondary, 0.22));
    root.style.setProperty('--ytmc-accent', rgbToCss(currentPalette.primary, 1));

    if (bg) {
      bg.classList.toggle('ytmc-active', Boolean(settings.ambientThemeEnabled));
    }
    if (document.body) {
      document.body.classList.toggle('ytmc-ambient-on', Boolean(settings.ambientThemeEnabled));
    }

    postToPage('visualizer-theme', {
      primary: currentPalette.primary,
      secondary: currentPalette.secondary,
    });
  }

  async function updateArtworkColors(artworkUrl) {
    if (!artworkUrl || artworkUrl === lastArtworkUrl) return;
    lastArtworkUrl = artworkUrl;

    const dataUrl = await ipcRenderer.invoke('artwork:fetch-data-url', artworkUrl);
    if (!dataUrl) return;
    currentPalette = await extractPaletteFromDataUrl(dataUrl);
    applyAmbientColors();
  }

  // ---- 2. Synced Lyrics inside Standard "Текст" / "Lyrics" Tab ----
  function getPlayerPageContext() {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (!playerPage) return null;
    const sidePanel = playerPage.querySelector('#side-panel');
    if (!sidePanel) return null;
    const tabsEl = sidePanel.querySelector('tp-yt-paper-tabs');
    const tabs = tabsEl ? Array.from(tabsEl.querySelectorAll('tp-yt-paper-tab')) : [];
    const lyricsTab = tabs[1] || null;
    const tabRenderer = sidePanel.querySelector('ytmusic-tab-renderer, #tab-renderer');
    return { playerPage, sidePanel, tabsEl, tabs, lyricsTab, tabRenderer };
  }

  function ensureInlineLyricsContainer(ctx) {
    if (!ctx || !ctx.sidePanel) return null;

    if (!inlineContainerEl || !ctx.sidePanel.contains(inlineContainerEl)) {
      inlineContainerEl = document.createElement('div');
      inlineContainerEl.id = 'ytmc-inline-lyrics';

      // Toolbar row at top of the Lyrics tab
      const syncBar = document.createElement('div');
      Object.assign(syncBar.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '6px',
        padding: '10px 4px',
        fontSize: '12px',
        color: '#a3a3a3',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
      });

      offsetLabelEl = document.createElement('span');
      offsetLabelEl.textContent = 'Синхр: 0.0с';

      const controls = document.createElement('div');
      Object.assign(controls.style, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });

      const makeMiniBtn = (txt, fn) => {
        const b = document.createElement('button');
        b.textContent = txt;
        Object.assign(b.style, {
          background: 'rgba(255,255,255,0.08)',
          color: '#e5e5e5',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '6px',
          padding: '3px 8px',
          fontSize: '11.5px',
          cursor: 'pointer',
        });
        b.addEventListener('click', fn);
        return b;
      };

      controls.appendChild(
        makeMiniBtn('-0.5с', () => {
          syncOffsetSec = Number((syncOffsetSec - 0.5).toFixed(1));
          offsetLabelEl.textContent = `Синхр: ${syncOffsetSec > 0 ? '+' : ''}${syncOffsetSec.toFixed(1)}с`;
        })
      );
      controls.appendChild(
        makeMiniBtn('+0.5с', () => {
          syncOffsetSec = Number((syncOffsetSec + 0.5).toFixed(1));
          offsetLabelEl.textContent = `Синхр: ${syncOffsetSec > 0 ? '+' : ''}${syncOffsetSec.toFixed(1)}с`;
        })
      );
      controls.appendChild(
        makeMiniBtn('Скинути', () => {
          syncOffsetSec = 0;
          offsetLabelEl.textContent = 'Синхр: 0.0с';
        })
      );

      nativeToggleBtn = makeMiniBtn('Текст YT', () => {
        showNativeFallback = true;
        syncInlineLyricsState();
      });
      controls.appendChild(nativeToggleBtn);

      syncBar.appendChild(offsetLabelEl);
      syncBar.appendChild(controls);
      inlineContainerEl.appendChild(syncBar);

      inlineBodyEl = document.createElement('div');
      inlineBodyEl.id = 'ytmc-inline-lyrics-body';
      Object.assign(inlineBodyEl.style, {
        flex: '1 1 auto',
        overflowY: 'auto',
        padding: '18px 6px 42px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        scrollBehavior: 'smooth',
      });
      inlineContainerEl.appendChild(inlineBodyEl);

      if (ctx.tabRenderer && ctx.tabRenderer.parentNode) {
        ctx.tabRenderer.parentNode.insertBefore(inlineContainerEl, ctx.tabRenderer.nextSibling);
      } else {
        ctx.sidePanel.appendChild(inlineContainerEl);
      }
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

    if (!currentTrack.title) {
      const empty = document.createElement('div');
      empty.textContent = 'Увімкніть трек, щоб завантажити синхронізований текст.';
      Object.assign(empty.style, { color: '#9a9a9a', fontSize: '14px', marginTop: '32px' });
      inlineBodyEl.appendChild(empty);
      return;
    }

    if (lyricsLoading) {
      const loading = document.createElement('div');
      loading.textContent = 'Пошук синхронізованого тексту...';
      Object.assign(loading.style, { color: '#bdbdbd', fontSize: '14px', marginTop: '32px' });
      inlineBodyEl.appendChild(loading);
      return;
    }

    if (lyricsData.synced && lyricsData.synced.length > 0) {
      for (const item of lyricsData.synced) {
        const lineEl = document.createElement('div');
        lineEl.textContent = item.text || '♪';
        Object.assign(lineEl.style, {
          fontSize: '18px',
          lineHeight: '1.5',
          fontWeight: '600',
          color: 'rgba(255, 255, 255, 0.38)',
          padding: '6px 10px',
          borderRadius: '10px',
          cursor: 'pointer',
          transformOrigin: 'left center',
          transition: 'color 0.22s ease, transform 0.22s ease, background 0.22s ease',
        });
        lineEl.addEventListener('click', () => {
          postToPage('player-seek', { time: item.time });
        });
        inlineBodyEl.appendChild(lineEl);
        lineElements.push(lineEl);
      }
      return;
    }

    if (lyricsData.plain) {
      const badge = document.createElement('div');
      badge.textContent = 'Звичайний текст (без таймінгів)';
      Object.assign(badge.style, {
        fontSize: '12px',
        color: '#9e9e9e',
        marginBottom: '6px',
      });
      inlineBodyEl.appendChild(badge);

      for (const rawLine of lyricsData.plain.split(/\r?\n/)) {
        const p = document.createElement('div');
        p.textContent = rawLine || ' ';
        Object.assign(p.style, {
          fontSize: '15.5px',
          lineHeight: '1.6',
          color: 'rgba(255, 255, 255, 0.88)',
          minHeight: '14px',
        });
        inlineBodyEl.appendChild(p);
      }
      return;
    }

    const notFound = document.createElement('div');
    notFound.textContent = 'Синхронізований текст для цього треку не знайдено у базі LRCLIB.';
    Object.assign(notFound.style, {
      color: '#9a9a9a',
      fontSize: '14px',
      marginTop: '32px',
      lineHeight: '1.5',
    });
    inlineBodyEl.appendChild(notFound);
  }

  async function fetchLyricsForCurrentTrack(force = false) {
    if (!settings.lyricsEnabled || !currentTrack.title) return;
    const key = `${currentTrack.artist}::${currentTrack.title}`.toLowerCase();
    if (!force && key === currentLyricsKey && (lyricsLoading || lyricsData.found)) return;

    currentLyricsKey = key;
    lyricsLoading = true;
    if (isLyricsViewVisible) renderLyricsContent();

    const result = await ipcRenderer.invoke('lyrics:fetch', {
      title: currentTrack.title,
      artist: currentTrack.artist,
      duration: currentTrack.duration,
    });

    if (key !== currentLyricsKey) return;
    lyricsLoading = false;
    lyricsData = result || { found: false, synced: [], plain: '' };
    if (isLyricsViewVisible) renderLyricsContent();
  }

  function updateLyricsPlaybackTime(currentTime) {
    if (!isLyricsViewVisible || !lyricsData.synced || lyricsData.synced.length === 0) return;
    const t = currentTime + syncOffsetSec;

    let idx = -1;
    for (let i = 0; i < lyricsData.synced.length; i += 1) {
      if (lyricsData.synced[i].time <= t + 0.15) {
        idx = i;
      } else {
        break;
      }
    }

    if (idx === activeLineIndex) return;

    if (activeLineIndex >= 0 && lineElements[activeLineIndex]) {
      const prevEl = lineElements[activeLineIndex];
      prevEl.style.color = 'rgba(255, 255, 255, 0.38)';
      prevEl.style.fontWeight = '600';
      prevEl.style.background = 'transparent';
      prevEl.style.transform = 'scale(1)';
    }

    activeLineIndex = idx;
    if (idx >= 0 && lineElements[idx]) {
      const el = lineElements[idx];
      el.style.color = '#ffffff';
      el.style.fontWeight = '700';
      el.style.background = 'rgba(255, 255, 255, 0.08)';
      el.style.transform = 'scale(1.02)';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function hookTabInteractions(ctx) {
    if (!ctx || !ctx.tabs || ctx.tabs.length < 2) return;

    // Make sure the "Текст" / "Lyrics" tab stays clickable even if YT Music disables it
    const lyricsTab = ctx.lyricsTab;
    if (settings.lyricsEnabled && lyricsTab) {
      if (lyricsTab.hasAttribute('disabled')) {
        lyricsTab.removeAttribute('disabled');
      }
      if (lyricsTab.disabled) {
        lyricsTab.disabled = false;
      }
      lyricsTab.setAttribute('aria-disabled', 'false');
      lyricsTab.style.pointerEvents = 'auto';
      lyricsTab.style.opacity = '1';
      lyricsTab.style.cursor = 'pointer';
    }

    ctx.tabs.forEach((tab, index) => {
      if (hookedTabs.has(tab)) return;
      hookedTabs.add(tab);

      tab.addEventListener('click', () => {
        if (index === 1 && settings.lyricsEnabled) {
          forcedLyricsTab = true;
          showNativeFallback = false;
          if (ctx.tabsEl && Number(ctx.tabsEl.selected) !== 1) {
            try {
              ctx.tabsEl.selected = 1;
            } catch {
              // Ignore if Polymer blocks selection on disabled tab
            }
          }
          setTimeout(syncInlineLyricsState, 30);
        } else {
          forcedLyricsTab = false;
          showNativeFallback = false;
          setTimeout(syncInlineLyricsState, 30);
        }
      });
    });

    if (ctx.tabsEl && !hookedTabs.has(ctx.tabsEl)) {
      hookedTabs.add(ctx.tabsEl);
      ctx.tabsEl.addEventListener('selected-changed', () => {
        if (Number(ctx.tabsEl.selected) === 1) {
          showNativeFallback = false;
        } else {
          forcedLyricsTab = false;
        }
        setTimeout(syncInlineLyricsState, 20);
      });
    }
  }

  function syncInlineLyricsState() {
    const ctx = getPlayerPageContext();
    if (!ctx) return;

    hookTabInteractions(ctx);
    ensureInlineLyricsContainer(ctx);

    const nativeLyricsSelected =
      Number(ctx.tabsEl && ctx.tabsEl.selected) === 1 ||
      (ctx.lyricsTab && ctx.lyricsTab.classList.contains('iron-selected'));

    const lyricsTabActive = Boolean(
      settings.lyricsEnabled && (nativeLyricsSelected || forcedLyricsTab)
    );

    if (forcedLyricsTab && ctx.lyricsTab) {
      ctx.tabs.forEach((t, idx) => {
        t.classList.toggle('iron-selected', idx === 1);
        t.setAttribute('aria-selected', idx === 1 ? 'true' : 'false');
      });
    }

    const shouldShowInline = lyricsTabActive && !showNativeFallback;
    const wasVisible = isLyricsViewVisible;
    isLyricsViewVisible = shouldShowInline;

    if (inlineContainerEl) {
      inlineContainerEl.style.display = shouldShowInline ? 'flex' : 'none';
    }

    if (ctx.tabRenderer) {
      ctx.tabRenderer.style.display = shouldShowInline ? 'none' : '';
      let backBanner = document.getElementById('ytmc-back-to-synced');
      if (lyricsTabActive && showNativeFallback) {
        if (!backBanner) {
          backBanner = document.createElement('button');
          backBanner.id = 'ytmc-back-to-synced';
          backBanner.textContent = '← Повернутися до синхронізованого тексту';
          Object.assign(backBanner.style, {
            margin: '8px 0',
            padding: '6px 12px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.16)',
            background: 'rgba(255,255,255,0.08)',
            color: '#f1f1f1',
            fontSize: '12px',
            cursor: 'pointer',
            alignSelf: 'flex-start',
          });
          backBanner.addEventListener('click', () => {
            showNativeFallback = false;
            syncInlineLyricsState();
          });
          ctx.tabRenderer.parentNode.insertBefore(backBanner, ctx.tabRenderer);
        }
        backBanner.style.display = 'inline-block';
      } else if (backBanner) {
        backBanner.style.display = 'none';
      }
    }

    if (lyricsToggleBtn) {
      lyricsToggleBtn.classList.toggle('ytmc-btn-active', shouldShowInline);
    }

    if (shouldShowInline && !wasVisible) {
      renderLyricsContent();
      fetchLyricsForCurrentTrack(false);
    }
  }

  function openOrToggleLyricsTab() {
    if (!settings.lyricsEnabled) return;
    const ctx = getPlayerPageContext();
    if (!ctx) return;

    const isPlayerOpen = ctx.playerPage.hasAttribute('player-page-open_');
    if (!isPlayerOpen) {
      const toggleBtn = document.querySelector('ytmusic-player-bar .toggle-player-page-button');
      if (toggleBtn) toggleBtn.click();
      setTimeout(() => {
        const refreshed = getPlayerPageContext();
        if (refreshed && refreshed.lyricsTab) {
          showNativeFallback = false;
          forcedLyricsTab = true;
          refreshed.lyricsTab.click();
          syncInlineLyricsState();
        }
      }, 220);
      return;
    }

    const currentlyLyrics = isLyricsViewVisible;
    if (currentlyLyrics && ctx.tabs[0]) {
      forcedLyricsTab = false;
      ctx.tabs[0].click();
      syncInlineLyricsState();
    } else if (ctx.lyricsTab) {
      showNativeFallback = false;
      forcedLyricsTab = true;
      ctx.lyricsTab.click();
      syncInlineLyricsState();
    }
  }

  // ---- 3. Inject Player-Bar Buttons ----
  function ensurePlayerBarButtons() {
    const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons');
    if (!rightControls) return;

    if (!document.getElementById('ytmc-lyrics-btn')) {
      const btn = document.createElement('button');
      btn.id = 'ytmc-lyrics-btn';
      btn.className = 'ytmc-bar-btn';
      btn.title = 'Синхронізований текст пісні (Ctrl+L)';
      btn.appendChild(
        createSvgIcon([
          'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
        ])
      );
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openOrToggleLyricsTab();
      });
      rightControls.prepend(btn);
      lyricsToggleBtn = btn;
    }

    if (!document.getElementById('ytmc-settings-btn')) {
      const gearBtn = document.createElement('button');
      gearBtn.id = 'ytmc-settings-btn';
      gearBtn.className = 'ytmc-bar-btn';
      gearBtn.title = 'Налаштування YT Music Client (Ctrl+,)';
      gearBtn.appendChild(
        createSvgIcon([
          'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
        ])
      );
      gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onOpenSettings();
      });
      rightControls.prepend(gearBtn);
    }

    if (lyricsToggleBtn) {
      lyricsToggleBtn.style.display = settings.lyricsEnabled ? 'inline-flex' : 'none';
      lyricsToggleBtn.classList.toggle('ytmc-btn-active', isLyricsViewVisible);
    }
  }

  function applySettings(newSettings) {
    settings = { ...settings, ...newSettings };
    ensureAmbientElements();
    applyAmbientColors();
    ensurePlayerBarButtons();
    if (!settings.lyricsEnabled) {
      forcedLyricsTab = false;
    }
    syncInlineLyricsState();
  }

  function handlePlayerState(state) {
    if (!state) return;
    const prevKey = `${currentTrack.artist}::${currentTrack.title}`.toLowerCase();
    currentTrack = {
      title: state.title || '',
      artist: state.artist || '',
      duration: state.duration || 0,
      artworkUrl: state.artworkUrl || '',
      videoId: state.videoId || '',
    };
    const nextKey = `${currentTrack.artist}::${currentTrack.title}`.toLowerCase();

    if (settings.ambientThemeEnabled && currentTrack.artworkUrl) {
      updateArtworkColors(currentTrack.artworkUrl);
    }

    if (nextKey !== prevKey) {
      syncOffsetSec = 0;
      if (offsetLabelEl) offsetLabelEl.textContent = 'Синхр: 0.0с';
      lyricsData = { found: false, synced: [], plain: '' };
      if (isLyricsViewVisible) {
        fetchLyricsForCurrentTrack(true);
      }
    }
  }

  function initDomObservers() {
    ensureAmbientElements();
    ensurePlayerBarButtons();
    syncInlineLyricsState();
    setInterval(() => {
      ensureAmbientElements();
      ensurePlayerBarButtons();
      syncInlineLyricsState();
    }, 600);
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
    toggleLyricsDrawer: openOrToggleLyricsTab,
  };
}

module.exports = { createEnhancementsController };
