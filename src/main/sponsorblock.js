const SPONSORBLOCK_API = 'https://sponsor.ajay.app/api/skipSegments';
const CACHE_LIMIT = 200;
const DEFAULT_CATEGORIES = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,20}$/;

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
      validCategories = categories.filter((c) => typeof c === 'string' && c.trim().length > 0);
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
        headers: {
          'User-Agent': `YTMusicClient/${getAppVersion()}`,
        },
      });

      if (response.status === 200) {
        const data = await response.json();
        const segments = Array.isArray(data)
          ? data
              .filter(
                (item) =>
                  item &&
                  (!item.actionType || item.actionType === 'skip') &&
                  Array.isArray(item.segment) &&
                  item.segment.length === 2
              )
              .map((item) => ({
                start: Number(item.segment[0]),
                end: Number(item.segment[1]),
                category: item.category || 'unknown',
                uuid: item.UUID || '',
              }))
              .filter(
                (seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start
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
