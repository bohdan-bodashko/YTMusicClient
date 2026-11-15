const SPONSORBLOCK_API = 'https://sponsor.ajay.app/api/skipSegments';
const CACHE_LIMIT = 200;
const DEFAULT_CATEGORIES = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];
const ALLOWED_SB_CATEGORIES = new Set([
  'music_offtopic',
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'filler',
]);
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,20}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_SEGMENTS = 200;
const MAX_VIDEO_DURATION_SEC = 864000;
const MAX_UUID_LEN = 128;

async function readResponseBufferWithLimit(response, maxBytes, controller) {
  const contentLen = Number(response.headers?.get?.('content-length') || '0');
  if (Number.isFinite(contentLen) && contentLen > maxBytes) {
    controller.abort();
    return null;
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.byteLength <= maxBytes ? buf : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

function getAppVersion() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getVersion === 'function') {
      const ver = app.getVersion();
      if (ver) return ver;
    }
  } catch {
    // Fallback outside Electron main process
  }
  try {
    return require('../../package.json').version || '1.2.0';
  } catch {
    return '1.2.0';
  }
}

class SponsorBlockService {
  constructor() {
    this.cache = new Map();
    this.inFlight = new Map();
  }

  _setCache(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }

  async getSegments(videoId, categories) {
    if (!videoId || typeof videoId !== 'string') return [];
    const trimmedId = videoId.trim();
    if (!VIDEO_ID_REGEX.test(trimmedId)) return [];

    let validCategories;
    if (categories === undefined || categories === null) {
      validCategories = DEFAULT_CATEGORIES;
    } else if (Array.isArray(categories)) {
      const seen = new Set();
      validCategories = [];
      for (const c of categories) {
        if (typeof c === 'string') {
          const trimmed = c.trim();
          if (ALLOWED_SB_CATEGORIES.has(trimmed) && !seen.has(trimmed)) {
            seen.add(trimmed);
            validCategories.push(trimmed);
          }
        }
      }
      if (validCategories.length === 0) {
        return [];
      }
    } else {
      validCategories = DEFAULT_CATEGORIES;
    }

    const sortedCategories = validCategories.slice().sort();
    const cacheKey = `${trimmedId}:${sortedCategories.join(',')}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      // Touch for true LRU eviction order
      this._setCache(cacheKey, cached);
      return cached;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const promise = this._fetchSegments(trimmedId, sortedCategories, cacheKey);
    this.inFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async _fetchSegments(videoId, categories, cacheKey) {
    const params = new URLSearchParams({
      videoID: videoId,
      categories: JSON.stringify(categories),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${SPONSORBLOCK_API}?${params.toString()}`, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'User-Agent': `YTMusicClient/${getAppVersion()}`,
        },
      });

      if (response.status === 200) {
        if (response.url) {
          const finalUrl = new URL(response.url);
          if (finalUrl.protocol !== 'https:' || finalUrl.hostname.toLowerCase() !== 'sponsor.ajay.app') {
            return [];
          }
        }
        const buf = await readResponseBufferWithLimit(response, MAX_RESPONSE_BYTES, controller);
        if (!buf) {
          return [];
        }
        const data = JSON.parse(buf.toString('utf8'));
        const segments = Array.isArray(data)
          ? data
              .slice(0, MAX_SEGMENTS)
              .filter(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  !Array.isArray(item) &&
                  (!item.actionType || item.actionType === 'skip') &&
                  typeof item.category === 'string' &&
                  ALLOWED_SB_CATEGORIES.has(item.category) &&
                  (item.UUID === undefined ||
                    (typeof item.UUID === 'string' && item.UUID.length <= MAX_UUID_LEN)) &&
                  Array.isArray(item.segment) &&
                  item.segment.length === 2 &&
                  typeof item.segment[0] === 'number' &&
                  typeof item.segment[1] === 'number'
              )
              .map((item) => ({
                start: item.segment[0],
                end: item.segment[1],
                category: item.category,
                uuid: typeof item.UUID === 'string' ? item.UUID : '',
              }))
              .filter(
                (seg) =>
                  Number.isFinite(seg.start) &&
                  Number.isFinite(seg.end) &&
                  seg.start >= 0 &&
                  seg.end > seg.start &&
                  seg.end <= MAX_VIDEO_DURATION_SEC
              )
          : [];
        this._setCache(cacheKey, segments);
        return segments;
      }

      // Only 404 is an authoritative "no segments exist" response; avoid caching 429/5xx failures
      if (response.status === 404) {
        this._setCache(cacheKey, []);
      }
      return [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = { SponsorBlockService };
