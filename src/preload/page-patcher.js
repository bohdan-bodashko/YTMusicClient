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

  let CATEGORY_LABELS = {
    music_offtopic: 'non-music section',
    sponsor: 'sponsor',
    selfpromo: 'self-promotion',
    interaction: 'interaction reminder',
    intro: 'intro',
    outro: 'outro',
  };
  let sponsorBlockToastTemplate = 'SponsorBlock: skipped ({category})';

  let currentVideoId = null;
  let activeSegments = [];
  let skippedInPass = new Set();
  let lastVideoTime = 0;
  let savedMuteBeforeAd = null;
  let wasAdShowing = false;
  let lastReportedState = '';

  function postToPreload(type, payload = {}) {
    window.postMessage({ source: 'ytmc-page', type, payload }, '*');
  }

  // ---- 1. Trusted-Types-safe Frosted Glass Toast ----
  let toastTimer = null;
  let toastDotEl = null;
  let toastTextEl = null;

  function showToast(text) {
    if (!document.body || !text) return;
    let el = document.getElementById('ytmc-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ytmc-toast';
      Object.assign(el.style, {
        position: 'fixed',
        right: '20px',
        bottom: '88px',
        zIndex: '999999',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '9px',
        background: 'rgba(18, 18, 24, 0.90)',
        backdropFilter: 'blur(14px)',
        color: '#f4f4f6',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        borderRadius: '11px',
        padding: '10px 14px',
        fontFamily: '"Segoe UI Variable", "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
        fontWeight: '500',
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.5)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 0.22s ease, transform 0.22s ease',
        transform: 'translateY(8px)',
      });

      toastDotEl = document.createElement('span');
      Object.assign(toastDotEl.style, {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        flexShrink: '0',
      });

      toastTextEl = document.createElement('span');
      el.appendChild(toastDotEl);
      el.appendChild(toastTextEl);
      document.body.appendChild(el);
    }

    const bar = document.querySelector('ytmusic-player-bar');
    if (bar && !bar.hasAttribute('hidden')) {
      const rect = bar.getBoundingClientRect();
      if (rect.height > 0 && rect.top < window.innerHeight) {
        el.style.bottom = `${Math.round(window.innerHeight - rect.top + 16)}px`;
      } else {
        el.style.bottom = '20px';
      }
    } else {
      el.style.bottom = '20px';
    }

    const p = visualizerColors.primary;
    if (toastDotEl) {
      toastDotEl.style.background = `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
      toastDotEl.style.boxShadow = `0 0 8px rgba(${p[0]}, ${p[1]}, ${p[2]}, 0.75)`;
    }
    if (toastTextEl) {
      toastTextEl.textContent = text;
    } else {
      el.textContent = text;
    }

    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
    }, 2800);
  }

  // ---- 2. Ad-stripping in JSON / Fetch ----
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];

  function stripAdsFromObject(obj, depth = 0, seen = null) {
    if (!obj || typeof obj !== 'object' || depth > 3) return false;
    const visited = seen || new WeakSet();
    if (visited.has(obj)) return false;
    visited.add(obj);

    let removed = false;
    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        delete obj[key];
        removed = true;
      }
    }
    if (obj.playerResponse && typeof obj.playerResponse === 'object') {
      if (stripAdsFromObject(obj.playerResponse, depth + 1, visited)) removed = true;
    }
    if (obj.response && typeof obj.response === 'object') {
      if (stripAdsFromObject(obj.response, depth + 1, visited)) removed = true;
    }
    return removed;
  }

  const origJsonParse = JSON.parse;
  JSON.parse = function patchedJsonParse(text, reviver) {
    const parsed = origJsonParse.call(this, text, reviver);
    if (
      config.adBlockEnabled &&
      typeof text === 'string' &&
      (text.includes('adPlacements') ||
        text.includes('playerAds') ||
        text.includes('adSlots') ||
        text.includes('adBreakHeartbeatParams'))
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
  function isAdCurrentlyShowing() {
    const player = document.getElementById('movie_player');
    if (!player) return false;
    return (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  function checkAndSkipDomAd() {
    const video = document.querySelector('video');
    const isAdShowing = isAdCurrentlyShowing();

    if (!config.adBlockEnabled) {
      if (savedMuteBeforeAd !== null && video) {
        video.muted = savedMuteBeforeAd;
      }
      savedMuteBeforeAd = null;
      wasAdShowing = false;
      return;
    }

    if (!video) return;

    if (isAdShowing) {
      if (!wasAdShowing) {
        wasAdShowing = true;
        postToPreload('ad-blocked');
      }
      if (savedMuteBeforeAd === null) {
        savedMuteBeforeAd = video.muted;
      }
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.35) {
        video.currentTime = video.duration;
      }
      const skipBtn = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button'
      );
      if (skipBtn) {
        skipBtn.click();
      }
    } else {
      wasAdShowing = false;
      if (savedMuteBeforeAd !== null) {
        video.muted = savedMuteBeforeAd;
        savedMuteBeforeAd = null;
      }
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
    const titleLink = document.querySelector(
      'ytmusic-player-bar a.ytp-title-link, ytmusic-player-bar .title a[href*="v="]'
    );
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
    if (isAdCurrentlyShowing()) {
      return;
    }
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
    if (!config.sponsorBlockEnabled || !activeSegments.length || isAdCurrentlyShowing()) return;
    const t = video.currentTime;
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
        showToast(sponsorBlockToastTemplate.replace('{category}', label));
        break;
      }
    }
  }

  function readTrackMetadata() {
    const msMeta = navigator.mediaSession && navigator.mediaSession.metadata;
    const titleEl = document.querySelector('ytmusic-player-bar .title.ytmusic-player-bar');
    const bylineEl = document.querySelector('ytmusic-player-bar .byline.ytmusic-player-bar');

    const title =
      (titleEl && titleEl.textContent && titleEl.textContent.trim()) ||
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

    const player = document.getElementById('movie_player');
    const video = document.querySelector('video');
    const isPlaying = Boolean(video && !video.paused && !video.ended);
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;

    let volume = video && typeof video.volume === 'number' ? video.volume : 1;
    let muted = Boolean(video && video.muted);
    if (player && typeof player.getVolume === 'function') {
      const pVol = Number(player.getVolume());
      if (Number.isFinite(pVol)) {
        volume = Math.min(1, Math.max(0, pVol / 100));
      }
    }
    if (player && typeof player.isMuted === 'function') {
      muted = Boolean(player.isMuted());
    }

    return { isPlaying, title, artist, videoId: currentVideoId, artworkUrl, duration, volume, muted };
  }

  function reportPlayerState() {
    if (isAdCurrentlyShowing()) return;
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

  // ---- 6. Perceptual Audio Visualizer ----
  let vizCanvas = null;
  let vizCtx = null;
  let vizAudioCtx = null;
  let vizAnalyser = null;
  let vizData = null;
  let vizRafId = null;
  let vizSourceAttachedVideo = null;
  let vizSourceNode = null;
  let vizSmoothed = null;
  const VIZ_BANDS = 40;
  let bandBinRanges = null;

  function computeBandRanges(binCount) {
    const ranges = [];
    const minBin = 1;
    const maxBin = Math.max(minBin + 1, Math.min(binCount - 1, Math.round(binCount * 0.62)));
    for (let i = 0; i < VIZ_BANDS; i += 1) {
      const t0 = i / VIZ_BANDS;
      const t1 = (i + 1) / VIZ_BANDS;
      const start = Math.floor(minBin * Math.pow(maxBin / minBin, t0));
      const end = Math.max(start, Math.floor(minBin * Math.pow(maxBin / minBin, t1)));
      ranges.push([start, Math.min(binCount - 1, end)]);
    }
    return ranges;
  }

  function isPlayerBarVisible() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar || bar.hasAttribute('hidden')) return { visible: false, bottomPx: 72 };
    const rect = bar.getBoundingClientRect();
    if (rect.height <= 0 || rect.top >= window.innerHeight - 4) {
      return { visible: false, bottomPx: 72 };
    }
    const bottomPx = Math.max(0, Math.round(window.innerHeight - rect.top));
    return { visible: true, bottomPx };
  }

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
        opacity: '0.82',
      });
      document.body.appendChild(vizCanvas);
      vizCtx = vizCanvas.getContext('2d');
    }

    const barState = isPlayerBarVisible();
    vizCanvas.style.bottom = `${barState.bottomPx}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.floor(window.innerWidth * dpr));
    const targetH = Math.floor(44 * dpr);
    if (vizCanvas.width !== targetW || vizCanvas.height !== targetH) {
      vizCanvas.width = targetW;
      vizCanvas.height = targetH;
    }

    const shouldShow = Boolean(config.visualizerEnabled && barState.visible);
    vizCanvas.style.display = shouldShow ? 'block' : 'none';
    return shouldShow ? vizCanvas : null;
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

        if (vizSourceNode) {
          try { vizSourceNode.disconnect(); } catch {}
          vizSourceNode = null;
        }

        if (!vizAnalyser) {
          vizAnalyser = vizAudioCtx.createAnalyser();
          vizAnalyser.fftSize = 256;
          vizAnalyser.smoothingTimeConstant = 0.76;
          vizData = new Uint8Array(vizAnalyser.frequencyBinCount);
          vizSmoothed = new Float32Array(VIZ_BANDS);
          bandBinRanges = computeBandRanges(vizAnalyser.frequencyBinCount);
        }

        vizSourceNode = vizAudioCtx.createMediaStreamSource(stream);
        vizSourceNode.connect(vizAnalyser);
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
      if (!canvas || !vizCtx || !vizAnalyser || !vizData || !vizSmoothed || !bandBinRanges) return;

      vizAnalyser.getByteFrequencyData(vizData);
      const video = document.querySelector('video');
      const playing = Boolean(video && !video.paused && !video.ended);

      const w = canvas.width;
      const h = canvas.height;
      vizCtx.clearRect(0, 0, w, h);

      const totalBars = VIZ_BANDS * 2;
      const gap = Math.max(2, w / (totalBars * 3.2));
      const barWidth = Math.max(2, (w - gap * (totalBars - 1)) / totalBars);

      const p = visualizerColors.primary;
      const s = visualizerColors.secondary;
      const grad = vizCtx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, `rgba(${s[0]}, ${s[1]}, ${s[2]}, 0.45)`);
      grad.addColorStop(0.55, `rgba(${p[0]}, ${p[1]}, ${p[2]}, 0.82)`);
      grad.addColorStop(1, `rgba(255, 255, 255, 0.88)`);
      vizCtx.fillStyle = grad;

      let maxEnergy = 0;
      for (let i = 0; i < VIZ_BANDS; i += 1) {
        let raw = 0;
        if (playing) {
          const [startBin, endBin] = bandBinRanges[i];
          let sum = 0;
          let count = 0;
          for (let b = startBin; b <= endBin; b += 1) {
            sum += vizData[b];
            count += 1;
          }
          raw = count > 0 ? sum / (count * 255) : 0;
        }

        const attackRelease = raw > vizSmoothed[i] ? 0.34 : 0.22;
        vizSmoothed[i] = vizSmoothed[i] * (1 - attackRelease) + raw * attackRelease;
        if (vizSmoothed[i] > maxEnergy) maxEnergy = vizSmoothed[i];

        const barH = Math.max(2, Math.pow(vizSmoothed[i], 1.1) * (h - 4));
        const y = h - barH;

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

  // ---- 7. Attach Video & Throttled Mutation Observers ----
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
    video.addEventListener('volumechange', reportPlayerState);
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

  let domCheckTimer = null;
  function scheduleDomCheck() {
    if (domCheckTimer !== null) return;
    domCheckTimer = setTimeout(() => {
      domCheckTimer = null;
      syncAdBlockStyle();
      attachVideoHooks();
      checkAndSkipDomAd();
      refreshTrackAndSegments();
      ensureVisualizerCanvas();
    }, 100);
  }

  function isOwnElement(node) {
    let cur = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (cur) {
      if (cur.id && cur.id.startsWith('ytmc-')) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function startObservers() {
    syncAdBlockStyle();
    ensureVisualizerCanvas();
    attachVideoHooks();

    const observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (let i = 0; i < mutations.length; i += 1) {
        if (!isOwnElement(mutations[i].target)) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        scheduleDomCheck();
      }
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
      setTimeout(refreshTrackAndSegments, 180);
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
    }, 2000);
  }

  // ---- 8. Listen for commands/settings from preload ----
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'ytmc-preload') return;
    const { type } = event.data;
    const payload = event.data.payload !== undefined ? event.data.payload : event.data.data;

    if (type === 'config' && payload) {
      const prevSb = config.sponsorBlockEnabled;
      if (typeof payload.adBlockEnabled === 'boolean') {
        config.adBlockEnabled = payload.adBlockEnabled;
      }
      if (typeof payload.sponsorBlockEnabled === 'boolean') {
        config.sponsorBlockEnabled = payload.sponsorBlockEnabled;
        if (!config.sponsorBlockEnabled) {
          activeSegments = [];
        }
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
      if (typeof payload.sponsorBlockToast === 'string') {
        sponsorBlockToastTemplate = payload.sponsorBlockToast;
      }
      if (payload.sponsorBlockCategories && typeof payload.sponsorBlockCategories === 'object') {
        CATEGORY_LABELS = { ...CATEGORY_LABELS, ...payload.sponsorBlockCategories };
      }
      syncAdBlockStyle();
      if (config.sponsorBlockEnabled && currentVideoId && (!prevSb || payload.refetchSponsorBlock)) {
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
    } else if (type === 'player-volume' && payload && Number.isFinite(payload.volume)) {
      const clamped = Math.min(1, Math.max(0, payload.volume));
      const player = document.getElementById('movie_player');
      if (player && typeof player.setVolume === 'function') {
        player.setVolume(Math.round(clamped * 100));
        if (clamped === 0 && typeof player.mute === 'function') player.mute();
        else if (clamped > 0 && typeof player.unMute === 'function') player.unMute();
      } else {
        const video = document.querySelector('video');
        if (video) {
          video.volume = clamped;
          video.muted = clamped === 0;
        }
      }
      reportPlayerState();
    } else if (type === 'toast' && payload && payload.text) {
      showToast(payload.text);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  } else {
    startObservers();
  }

  postToPreload('page-ready');
})();
