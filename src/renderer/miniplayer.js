const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i;
const MAX_DATA_URL_LEN = 8 * 1024 * 1024;

const shell = document.getElementById('shell');
const coverImg = document.getElementById('coverImg');
const coverPlaceholder = document.getElementById('coverPlaceholder');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const progressHit = document.getElementById('progressHit');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const curTimeEl = document.getElementById('curTime');
const totTimeEl = document.getElementById('totTime');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const pinBtn = document.getElementById('pinBtn');
const openMainBtn = document.getElementById('openMainBtn');
const closeBtn = document.getElementById('closeBtn');
const prevBtn = document.getElementById('prevBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const nextBtn = document.getElementById('nextBtn');
const volumeWrap = document.getElementById('volumeWrap');
const muteBtn = document.getElementById('muteBtn');
const volHighIcon = document.getElementById('volHighIcon');
const volLowIcon = document.getElementById('volLowIcon');
const volMuteIcon = document.getElementById('volMuteIcon');
const volumeRange = document.getElementById('volumeRange');

let durationSec = 0;
let currentSec = 0;
let isPlayingState = false;
let isPinnedState = false;
let hasTrackTitle = false;
let lastTrackKey = '';
let lastPct = 0;
let isAdjustingVolume = false;
let isScrubbing = false;
let lastNonZeroVolume = 100;
let currentStrings = null;

function isSafeRasterDataUrl(src) {
  return (
    typeof src === 'string' &&
    src.length > 0 &&
    src.length <= MAX_DATA_URL_LEN &&
    SAFE_DATA_IMAGE_RE.test(src)
  );
}

function sanitizeRgb(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const n = Number(arr[i]);
    if (!Number.isFinite(n)) return null;
    out.push(Math.min(255, Math.max(0, Math.round(n))));
  }
  return out;
}

function refreshDynamicLabels() {
  const s = currentStrings || {};
  const pinText = isPinnedState ? s.unpin || s.pin || 'Unpin' : s.pin || 'Pin on top';
  pinBtn.title = pinText;
  pinBtn.setAttribute('aria-label', pinText);
  pinBtn.setAttribute('aria-pressed', isPinnedState ? 'true' : 'false');

  const ppText = isPlayingState
    ? s.pause || s.playPause || 'Pause'
    : s.play || s.playPause || 'Play';
  playPauseBtn.title = ppText;
  playPauseBtn.setAttribute('aria-label', ppText);

  const volVal = Number(volumeRange.value);
  const muteText = volVal <= 0 ? s.unmute || 'Unmute' : s.mute || 'Mute';
  muteBtn.title = muteText;
  muteBtn.setAttribute('aria-label', muteText);
}

function applyStrings(strings) {
  if (!strings || typeof strings !== 'object') return;
  currentStrings = strings;
  const inferredLang = strings.lang === 'uk' || strings.lang === 'en' ? strings.lang : 'en';
  document.documentElement.lang = inferredLang;

  if (strings.title) document.title = strings.title;
  if (strings.openMain) {
    openMainBtn.title = strings.openMain;
    openMainBtn.setAttribute('aria-label', strings.openMain);
  }
  if (strings.close) {
    closeBtn.title = strings.close;
    closeBtn.setAttribute('aria-label', strings.close);
  }
  if (strings.prev) {
    prevBtn.title = strings.prev;
    prevBtn.setAttribute('aria-label', strings.prev);
  }
  if (strings.next) {
    nextBtn.title = strings.next;
    nextBtn.setAttribute('aria-label', strings.next);
  }
  if (strings.volume) {
    volumeWrap.title = strings.volume;
    volumeRange.setAttribute('aria-label', strings.volume);
  }
  if (!hasTrackTitle && strings.nothingPlaying) {
    trackTitle.textContent = strings.nothingPlaying;
    trackTitle.title = strings.nothingPlaying;
  }
  refreshDynamicLabels();
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateProgress(current, instant = false) {
  currentSec = Number.isFinite(current) ? Math.max(0, current) : 0;
  curTimeEl.textContent = fmtTime(currentSec);
  totTimeEl.textContent = fmtTime(durationSec);
  const pct =
    durationSec > 0 ? Math.min(100, Math.max(0, (currentSec / durationSec) * 100)) : 0;
  if (instant || pct < lastPct - 1.5) {
    progressFill.classList.add('no-transition');
    progressFill.style.width = `${pct}%`;
    void progressFill.offsetWidth;
    progressFill.classList.remove('no-transition');
  } else {
    progressFill.style.width = `${pct}%`;
  }
  lastPct = pct;
  progressHit.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function updateVolumeVisual(val) {
  const clamped = Math.min(100, Math.max(0, Math.round(val)));
  volumeRange.value = String(clamped);
  volumeRange.style.background = `linear-gradient(to right, var(--accent) ${clamped}%, rgba(255, 255, 255, 0.18) ${clamped}%)`;
  if (clamped > 0) {
    lastNonZeroVolume = clamped;
  }
  volHighIcon.classList.toggle('is-hidden', clamped < 50);
  volLowIcon.classList.toggle('is-hidden', !(clamped > 0 && clamped < 50));
  volMuteIcon.classList.toggle('is-hidden', clamped > 0);
  refreshDynamicLabels();
}

function showArtwork(src) {
  if (!isSafeRasterDataUrl(src)) {
    coverImg.removeAttribute('src');
    coverImg.style.display = 'none';
    coverPlaceholder.style.display = 'block';
    return;
  }
  if (coverImg.src !== src) {
    coverImg.src = src;
  }
  coverImg.style.display = 'block';
  coverPlaceholder.style.display = 'none';
}

coverImg.addEventListener('error', () => {
  coverImg.style.display = 'none';
  coverPlaceholder.style.display = 'block';
});

if (window.miniPlayerAPI) {
  window.miniPlayerAPI.onStateUpdate((state) => {
    if (!state || typeof state !== 'object') return;
    if (state.strings) {
      applyStrings(state.strings);
    }

    hasTrackTitle = Boolean(state.title);
    const fallbackTitle =
      (currentStrings && currentStrings.nothingPlaying) || 'Nothing playing';
    const resolvedTitle = state.title || fallbackTitle;
    const resolvedArtist = state.artist || 'YouTube Music';
    trackTitle.textContent = resolvedTitle;
    trackTitle.title = resolvedTitle;
    trackArtist.textContent = resolvedArtist;
    trackArtist.title = resolvedArtist;

    const trackKey = `${resolvedTitle}::${resolvedArtist}`;
    const trackChanged = trackKey !== lastTrackKey;
    lastTrackKey = trackKey;

    durationSec = Number.isFinite(state.duration) ? state.duration : 0;
    if (!isScrubbing) {
      updateProgress(state.currentTime || 0, trackChanged);
    }

    isPlayingState = Boolean(state.isPlaying);
    shell.classList.toggle('is-playing', isPlayingState);
    playIcon.classList.toggle('is-hidden', isPlayingState);
    pauseIcon.classList.toggle('is-hidden', !isPlayingState);

    isPinnedState = Boolean(state.isPinned);
    pinBtn.classList.toggle('active', isPinnedState);

    showArtwork(state.artworkDataUrl || '');

    if (!isAdjustingVolume && typeof state.volume === 'number') {
      const vol = state.muted ? 0 : Math.round(state.volume * 100);
      updateVolumeVisual(vol);
    } else {
      refreshDynamicLabels();
    }
  });

  window.miniPlayerAPI.onTimeUpdate((time) => {
    if (!isScrubbing) {
      updateProgress(time);
    }
  });

  window.miniPlayerAPI.onThemeUpdate((theme) => {
    if (!theme || typeof theme !== 'object') return;
    const p = sanitizeRgb(theme.primary);
    const s = sanitizeRgb(theme.secondary);
    if (!p || !s) return;
    document.documentElement.style.setProperty('--c1', `rgba(${p[0]}, ${p[1]}, ${p[2]}, 0.32)`);
    document.documentElement.style.setProperty('--c2', `rgba(${s[0]}, ${s[1]}, ${s[2]}, 0.26)`);
    document.documentElement.style.setProperty('--accent', `rgb(${p[0]}, ${p[1]}, ${p[2]})`);
    document.documentElement.style.setProperty(
      '--accent-soft',
      `rgba(${p[0]}, ${p[1]}, ${p[2]}, 0.22)`
    );
    updateVolumeVisual(Number(volumeRange.value));
  });

  prevBtn.addEventListener('click', () => {
    window.miniPlayerAPI.sendCommand('previous');
  });
  playPauseBtn.addEventListener('click', () => {
    window.miniPlayerAPI.sendCommand('toggle');
  });
  nextBtn.addEventListener('click', () => {
    window.miniPlayerAPI.sendCommand('next');
  });
  openMainBtn.addEventListener('click', () => {
    window.miniPlayerAPI.openMainWindow();
  });
  closeBtn.addEventListener('click', () => {
    window.miniPlayerAPI.close();
  });
  pinBtn.addEventListener('click', async () => {
    isPinnedState = Boolean(await window.miniPlayerAPI.togglePin());
    pinBtn.classList.toggle('active', isPinnedState);
    refreshDynamicLabels();
  });
}

function computeRatioFromPointer(clientX) {
  const rect = progressBar.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

progressHit.addEventListener('pointerdown', (e) => {
  if (durationSec <= 0 || e.button !== 0) return;
  isScrubbing = true;
  progressHit.classList.add('scrubbing');
  if (progressHit.setPointerCapture) {
    try {
      progressHit.setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture errors
    }
  }
  const ratio = computeRatioFromPointer(e.clientX);
  updateProgress(ratio * durationSec, true);
});

progressHit.addEventListener('pointermove', (e) => {
  if (!isScrubbing || durationSec <= 0) return;
  const ratio = computeRatioFromPointer(e.clientX);
  updateProgress(ratio * durationSec, true);
});

function finishScrub(e, commit) {
  if (!isScrubbing) return;
  isScrubbing = false;
  progressHit.classList.remove('scrubbing');
  if (commit && durationSec > 0) {
    const ratio = computeRatioFromPointer(e.clientX);
    const target = ratio * durationSec;
    updateProgress(target, true);
    if (window.miniPlayerAPI) {
      window.miniPlayerAPI.seek(target);
    }
  }
}

progressHit.addEventListener('pointerup', (e) => finishScrub(e, true));
progressHit.addEventListener('pointercancel', (e) => finishScrub(e, false));

const stopVolumeAdjust = () => {
  isAdjustingVolume = false;
};
volumeRange.addEventListener('pointerdown', () => {
  isAdjustingVolume = true;
});
volumeRange.addEventListener('pointerup', stopVolumeAdjust);
volumeRange.addEventListener('pointercancel', stopVolumeAdjust);
volumeRange.addEventListener('change', stopVolumeAdjust);
window.addEventListener('pointerup', stopVolumeAdjust);
window.addEventListener('blur', stopVolumeAdjust);

volumeRange.addEventListener('input', () => {
  const val = Number(volumeRange.value);
  updateVolumeVisual(val);
  if (window.miniPlayerAPI) {
    window.miniPlayerAPI.setVolume(val / 100);
  }
});

muteBtn.addEventListener('click', () => {
  const current = Number(volumeRange.value);
  const next = current > 0 ? 0 : lastNonZeroVolume > 0 ? lastNonZeroVolume : 50;
  updateVolumeVisual(next);
  if (window.miniPlayerAPI) {
    window.miniPlayerAPI.setVolume(next / 100);
  }
});

window.addEventListener('keydown', (e) => {
  if (!window.miniPlayerAPI) return;
  if (e.code === 'Space' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    window.miniPlayerAPI.sendCommand('toggle');
  } else if (e.key === 'ArrowLeft' && durationSec > 0) {
    e.preventDefault();
    const next = Math.max(0, currentSec - 5);
    updateProgress(next, true);
    window.miniPlayerAPI.seek(next);
  } else if (e.key === 'ArrowRight' && durationSec > 0) {
    e.preventDefault();
    const next = Math.min(durationSec, currentSec + 5);
    updateProgress(next, true);
    window.miniPlayerAPI.seek(next);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const next = Math.min(100, Number(volumeRange.value) + 5);
    updateVolumeVisual(next);
    window.miniPlayerAPI.setVolume(next / 100);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.max(0, Number(volumeRange.value) - 5);
    updateVolumeVisual(next);
    window.miniPlayerAPI.setVolume(next / 100);
  } else if (e.key.toLowerCase() === 'm') {
    muteBtn.click();
  } else if (e.key === 'Escape') {
    window.miniPlayerAPI.close();
  }
});

updateVolumeVisual(100);
