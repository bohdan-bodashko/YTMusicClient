(() => {
  if (window.__ytmcPatched) return;
  window.__ytmcPatched = true;

  const config = {
    adBlockEnabled: true,
    sponsorBlockEnabled: true,
    visualizerEnabled: true,
  };

  let visualizerColors = {
    primary: [255, 45, 85],
    secondary: [120, 70, 220],
  };

  const CATEGORY_LABELS = {
    music_offtopic: 'не-музична частина',
    sponsor: 'спонсор',
    selfpromo: 'самопромо',
    interaction: 'інтерактив/прохання',
    intro: 'інтро',
    outro: 'аутро',
  };

  let currentVideoId = null;
  let activeSegments = [];
  let skippedInPass = new Set();
  let lastVideoTime = 0;
  let savedMuteBeforeAd = null;
  let lastReportedState = '';

  function postToPreload(type, payload = {}) {
    window.postMessage({ source: 'ytmc-page', type, payload }, '*');
  }

  // ---- 1. Trusted-Types-safe Toast ----
  let toastTimer = null;
  function showToast(text) {
    if (!document.body) return;
    let el = document.getElementById('ytmc-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ytmc-toast';
      Object.assign(el.style, {
        position: 'fixed',
        right: '20px',
        bottom: '92px',
        zIndex: '999999',
        background: 'rgba(24, 24, 24, 0.94)',
        color: '#f1f1f1',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        borderRadius: '10px',
        padding: '10px 14px',
        fontFamily: 'Roboto, Segoe UI, sans-serif',
        fontSize: '13px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
        transform: 'translateY(6px)',
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
    }, 2800);
  }

  // ---- 2. Ad-stripping in JSON / Fetch ----
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];

  function stripAdsFromObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return false;
    let removed = false;
    for (const key of AD_KEYS) {
      if (key in obj) {
        delete obj[key];
        removed = true;
      }
    }
    if (obj.playerResponse && typeof obj.playerResponse === 'object') {
      if (stripAdsFromObject(obj.playerResponse, depth + 1)) removed = true;
    }
    if (obj.response && typeof obj.response === 'object') {
      if (stripAdsFromObject(obj.response, depth + 1)) removed = true;
    }
    return removed;
  }

  const origJsonParse = JSON.parse;
  JSON.parse = function patchedJsonParse(text, reviver) {
    const parsed = origJsonParse.call(this, text, reviver);
    if (
      config.adBlockEnabled &&
      typeof text === 'string' &&
      (text.includes('adPlacements') || text.includes('playerAds') || text.includes('adSlots'))
    ) {
      if (stripAdsFromObject(parsed)) {
        postToPreload('ad-blocked');
      }
    }
    return parsed;
  };

  const origResponseJson = Response.prototype.json;
  Response.prototype.json = async function patchedResponseJson() {
    const data = await origResponseJson.call(this);
    if (config.adBlockEnabled && stripAdsFromObject(data)) {
      postToPreload('ad-blocked');
    }
    return data;
  };

  // ---- 3. CSS Ad/Upsell Hider ----
  function syncAdBlockStyle() {
    const existing = document.getElementById('ytmc-adblock-style');
    if (!config.adBlockEnabled) {
      if (existing) existing.remove();
      return;
    }
    if (existing || !document.head) return;
    const style = document.createElement('style');
    style.id = 'ytmc-adblock-style';
    style.textContent = `
      ytmusic-mealbar-promo-renderer,
      ytmusic-upsell-dialog-renderer,
      ytmusic-statement-banner-renderer,
      ytd-banner-promo-renderer,
      #player-ads,
      .ytp-ad-module,
      .ytp-ad-overlay-container,
      .ytp-ad-player-overlay {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ---- 4. Fallback Video Ad Skipper ----
  function checkAndSkipDomAd() {
    if (!config.adBlockEnabled) return;
    const player = document.getElementById('movie_player');
    const video = document.querySelector('video');
    if (!player || !video) return;

    const isAdShowing =
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting');

    if (isAdShowing) {
      if (savedMuteBeforeAd === null) {
        savedMuteBeforeAd = video.muted;
      }
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }
      const skipBtn = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button'
      );
      if (skipBtn) {
        skipBtn.click();
      }
      postToPreload('ad-blocked');
    } else if (savedMuteBeforeAd !== null) {
      video.muted = savedMuteBeforeAd;
      savedMuteBeforeAd = null;
    }
  }

  // ---- 5. Video & Track Monitoring + SponsorBlock ----
  function detectVideoId() {
    const player = document.getElementById('movie_player');
    if (player && typeof player.getVideoData === 'function') {
      const data = player.getVideoData();
      if (data && data.video_id) return data.video_id;
    }
    const urlId = new URLSearchParams(window.location.search).get('v');
    if (urlId) return urlId;
    const titleLink = document.querySelector('ytmusic-player-bar a.ytp-title-link');
    if (titleLink && titleLink.href) {
      try {
        return new URL(titleLink.href).searchParams.get('v');
      } catch {
        return null;
      }
    }
    return null;
  }

  function refreshTrackAndSegments() {
    const vid = detectVideoId();
    if (vid && vid !== currentVideoId) {
      currentVideoId = vid;
      activeSegments = [];
      skippedInPass.clear();
      lastVideoTime = 0;
      if (config.sponsorBlockEnabled) {
        postToPreload('sponsorblock-request', { videoId: vid });
      }
    }
    reportPlayerState();
  }

  function handleVideoTimeUpdate(video) {
    if (!config.sponsorBlockEnabled || !activeSegments.length) return;
    const t = video.currentTime;
    // Reset skip markers if user rewound significantly
    if (t < lastVideoTime - 2) {
      skippedInPass.clear();
    }
    lastVideoTime = t;

    for (const seg of activeSegments) {
      const key = `${seg.uuid || seg.start}-${seg.end}`;
      if (skippedInPass.has(key)) continue;
      if (t >= seg.start && t < seg.end - 0.35) {
        skippedInPass.add(key);
        video.currentTime = seg.end;
        postToPreload('sponsorblock-skipped');
        const label = CATEGORY_LABELS[seg.category] || seg.category;
        showToast(`SponsorBlock: пропущено (${label})`);
        break;
      }
    }
  }

  function readTrackMetadata() {
    const msMeta = navigator.mediaSession && navigator.mediaSession.metadata;
    const titleEl = document.querySelector('ytmusic-player-bar .title.ytmusic-player-bar');
    const bylineEl = document.querySelector('ytmusic-player-bar .byline.ytmusic-player-bar');

    const title = (titleEl && titleEl.textContent && titleEl.textContent.trim()) ||
      (msMeta && msMeta.title) ||
      '';

    let artist = (msMeta && msMeta.artist) || '';
    if (!artist && bylineEl && bylineEl.textContent) {
      artist = bylineEl.textContent.split('•')[0].trim();
    }

    let artworkUrl = '';
    if (msMeta && Array.isArray(msMeta.artwork) && msMeta.artwork.length > 0) {
      artworkUrl = msMeta.artwork[msMeta.artwork.length - 1].src || msMeta.artwork[0].src || '';
    }
    if (!artworkUrl) {
      const imgEl = document.querySelector('ytmusic-player-bar img.image');
      if (imgEl && imgEl.src) artworkUrl = imgEl.src;
    }

    const video = document.querySelector('video');
    const isPlaying = Boolean(video && !video.paused && !video.ended);
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
    return { isPlaying, title, artist, videoId: currentVideoId, artworkUrl, duration };
  }

  function reportPlayerState() {
    const state = readTrackMetadata();
    const serialized = JSON.stringify(state);
    if (serialized !== lastReportedState) {
      lastReportedState = serialized;
      postToPreload('player-state', state);
    }
  }

  function executePlayerCommand(command) {
    const bar = document.querySelector('ytmusic-player-bar');
    const video = document.querySelector('video');
    const playPauseBtn = bar && bar.querySelector('.play-pause-button');
    const nextBtn = bar && bar.querySelector('.next-button');
    const prevBtn = bar && bar.querySelector('.previous-button');

    switch (command) {
      case 'toggle':
        if (playPauseBtn) playPauseBtn.click();
        else if (video) video.paused ? video.play() : video.pause();
        break;
      case 'play':
        if (video && video.paused) {
          if (playPauseBtn) playPauseBtn.click();
          else video.play();
        }
        break;
      case 'pause':
        if (video && !video.paused) {
          if (playPauseBtn) playPauseBtn.click();
          else video.pause();
        }
        break;
      case 'next':
        if (nextBtn) nextBtn.click();
        break;
      case 'previous':
        if (prevBtn) prevBtn.click();
        break;
      case 'stop':
        if (video) {
          if (!video.paused && playPauseBtn) playPauseBtn.click();
          else video.pause();
          video.currentTime = 0;
        }
        break;
      default:
        break;
    }
    setTimeout(reportPlayerState, 120);
  }

  // ---- 6. Audio Visualizer ----
  let vizCanvas = null;
  let vizCtx = null;
  let vizAudioCtx = null;
  let vizAnalyser = null;
  let vizData = null;
  let vizRafId = null;
  let vizSourceAttachedVideo = null;
  let vizSmoothed = null;

  function ensureVisualizerCanvas() {
    if (!document.body) return null;
    if (!vizCanvas) {
      vizCanvas = document.createElement('canvas');
      vizCanvas.id = 'ytmc-visualizer';
      Object.assign(vizCanvas.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: '72px',
        width: '100%',
        height: '44px',
        pointerEvents: 'none',
        zIndex: '3',
        opacity: '0.78',
      });
      document.body.appendChild(vizCanvas);
      vizCtx = vizCanvas.getContext('2d');
    }

    const bar = document.querySelector('ytmusic-player-bar');
    if (bar) {
      const rect = bar.getBoundingClientRect();
      if (rect.height > 0) {
        vizCanvas.style.bottom = `${Math.round(rect.height)}px`;
      }
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.floor(window.innerWidth * dpr);
    const targetH = Math.floor(44 * dpr);
    if (vizCanvas.width !== targetW || vizCanvas.height !== targetH) {
      vizCanvas.width = targetW;
      vizCanvas.height = targetH;
    }

    vizCanvas.style.display = config.visualizerEnabled ? 'block' : 'none';
    return vizCanvas;
  }

  function setupVisualizerAudio(video) {
    if (!config.visualizerEnabled || !video) return;
    if (vizSourceAttachedVideo === video && vizAnalyser) {
      if (vizAudioCtx && vizAudioCtx.state === 'suspended') {
        vizAudioCtx.resume().catch(() => {});
      }
      return;
    }

    try {
      const stream =
        typeof video.captureStream === 'function'
          ? video.captureStream()
          : typeof video.mozCaptureStream === 'function'
          ? video.mozCaptureStream()
          : null;

      if (!stream) return;

      const connectStream = () => {
        if (vizSourceAttachedVideo === video && vizAnalyser) return;
        const tracks = stream.getAudioTracks();
        if (!tracks || tracks.length === 0) return;

        if (!vizAudioCtx) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return;
          vizAudioCtx = new AudioCtx();
        }
        if (vizAudioCtx.state === 'suspended') {
          vizAudioCtx.resume().catch(() => {});
        }

        vizAnalyser = vizAudioCtx.createAnalyser();
        vizAnalyser.fftSize = 128;
        vizAnalyser.smoothingTimeConstant = 0.78;
        vizData = new Uint8Array(vizAnalyser.frequencyBinCount);
        vizSmoothed = new Float32Array(vizAnalyser.frequencyBinCount);

        const src = vizAudioCtx.createMediaStreamSource(stream);
        src.connect(vizAnalyser);
        vizSourceAttachedVideo = video;
        startVisualizerLoop();
      };

      if (stream.getAudioTracks().length > 0) {
        connectStream();
      } else {
        stream.addEventListener('addtrack', connectStream, { once: true });
      }
    } catch {
      // Non-fatal: skip visualizer if browser blocks captureStream on a protected stream
    }
  }

  function startVisualizerLoop() {
    if (vizRafId) return;

    const renderFrame = () => {
      vizRafId = null;
      if (!config.visualizerEnabled || document.hidden) {
        if (vizCtx && vizCanvas) {
          vizCtx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
        }
        return;
      }

      const canvas = ensureVisualizerCanvas();
      if (!canvas || !vizCtx || !vizAnalyser || !vizData) return;

      vizAnalyser.getByteFrequencyData(vizData);
      const video = document.querySelector('video');
      const playing = Boolean(video && !video.paused && !video.ended);

      const w = canvas.width;
      const h = canvas.height;
      vizCtx.clearRect(0, 0, w, h);

      const bins = Math.min(48, vizData.length);
      const totalBars = bins * 2;
      const gap = Math.max(2, w / (totalBars * 3.5));
      const barWidth = Math.max(2, (w - gap * (totalBars - 1)) / totalBars);

      const p = visualizerColors.primary;
      const s = visualizerColors.secondary;
      const grad = vizCtx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, `rgba(${s[0]}, ${s[1]}, ${s[2]}, 0.72)`);
      grad.addColorStop(0.5, `rgba(${p[0]}, ${p[1]}, ${p[2]}, 0.86)`);
      grad.addColorStop(1, `rgba(${s[0]}, ${s[1]}, ${s[2]}, 0.72)`);
      vizCtx.fillStyle = grad;

      let maxEnergy = 0;
      for (let i = 0; i < bins; i += 1) {
        const raw = playing ? vizData[i] / 255 : 0;
        vizSmoothed[i] = vizSmoothed[i] * 0.72 + raw * 0.28;
        if (vizSmoothed[i] > maxEnergy) maxEnergy = vizSmoothed[i];

        const barH = Math.max(2, Math.pow(vizSmoothed[i], 1.15) * (h - 4));
        const y = h - barH;

        // Mirrored symmetric spectrum from center outwards
        const leftX = w / 2 - (i + 1) * (barWidth + gap) + gap / 2;
        const rightX = w / 2 + i * (barWidth + gap) + gap / 2;
        const radius = Math.min(barWidth / 2, barH / 2, 4);

        vizCtx.beginPath();
        vizCtx.roundRect(leftX, y, barWidth, barH, [radius, radius, 0, 0]);
        vizCtx.roundRect(rightX, y, barWidth, barH, [radius, radius, 0, 0]);
        vizCtx.fill();
      }

      if (playing || maxEnergy > 0.01) {
        vizRafId = requestAnimationFrame(renderFrame);
      }
    };

    vizRafId = requestAnimationFrame(renderFrame);
  }

  // ---- 7. Attach Video & Mutation Observers ----
  let hookedVideo = null;
  let lastTimeSent = 0;
  function attachVideoHooks() {
    const video = document.querySelector('video');
    if (!video || video === hookedVideo) return;
    hookedVideo = video;

    video.addEventListener('play', () => {
      refreshTrackAndSegments();
      checkAndSkipDomAd();
      setupVisualizerAudio(video);
      startVisualizerLoop();
    });
    video.addEventListener('playing', () => {
      setupVisualizerAudio(video);
      startVisualizerLoop();
    });
    video.addEventListener('pause', reportPlayerState);
    video.addEventListener('ended', reportPlayerState);
    video.addEventListener('loadedmetadata', () => {
      refreshTrackAndSegments();
      checkAndSkipDomAd();
    });
    video.addEventListener('seeked', () => {
      postToPreload('player-time', { currentTime: video.currentTime });
    });
    video.addEventListener('timeupdate', () => {
      checkAndSkipDomAd();
      handleVideoTimeUpdate(video);
      const now = performance.now();
      if (now - lastTimeSent > 180) {
        lastTimeSent = now;
        postToPreload('player-time', { currentTime: video.currentTime });
      }
    });
  }

  function startObservers() {
    syncAdBlockStyle();
    ensureVisualizerCanvas();
    attachVideoHooks();

    const observer = new MutationObserver(() => {
      syncAdBlockStyle();
      attachVideoHooks();
      checkAndSkipDomAd();
      refreshTrackAndSegments();
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(refreshTrackAndSegments, 200);
    });

    window.addEventListener('resize', ensureVisualizerCanvas);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && config.visualizerEnabled) {
        startVisualizerLoop();
      }
    });

    setInterval(() => {
      attachVideoHooks();
      refreshTrackAndSegments();
      ensureVisualizerCanvas();
    }, 1500);
  }

  // ---- 8. Listen for commands/settings from preload ----
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'ytmc-preload') return;
    const { type, payload } = event.data;

    if (type === 'config' && payload) {
      const prevSb = config.sponsorBlockEnabled;
      if (typeof payload.adBlockEnabled === 'boolean') {
        config.adBlockEnabled = payload.adBlockEnabled;
      }
      if (typeof payload.sponsorBlockEnabled === 'boolean') {
        config.sponsorBlockEnabled = payload.sponsorBlockEnabled;
      }
      if (typeof payload.visualizerEnabled === 'boolean') {
        config.visualizerEnabled = payload.visualizerEnabled;
        ensureVisualizerCanvas();
        if (config.visualizerEnabled) {
          const video = document.querySelector('video');
          if (video) setupVisualizerAudio(video);
          startVisualizerLoop();
        }
      }
      syncAdBlockStyle();
      if (!prevSb && config.sponsorBlockEnabled && currentVideoId) {
        postToPreload('sponsorblock-request', { videoId: currentVideoId });
      }
    } else if (type === 'visualizer-theme' && payload) {
      if (Array.isArray(payload.primary)) visualizerColors.primary = payload.primary;
      if (Array.isArray(payload.secondary)) visualizerColors.secondary = payload.secondary;
    } else if (type === 'sponsorblock-segments' && payload) {
      if (payload.videoId === currentVideoId) {
        activeSegments = Array.isArray(payload.segments) ? payload.segments : [];
      }
    } else if (type === 'player-command' && payload) {
      executePlayerCommand(payload.command);
    } else if (type === 'player-seek' && payload && Number.isFinite(payload.time)) {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = Math.max(0, payload.time);
        postToPreload('player-time', { currentTime: video.currentTime });
      }
    } else if (type === 'toast' && payload && payload.text) {
      showToast(payload.text);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  } else {
    startObservers();
  }
})();
