const LRCLIB_GET = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const LYRICS_CACHE_LIMIT = 150;
const ARTWORK_CACHE_LIMIT = 80;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const MISS_CACHE_TTL_MS = 2 * 60 * 1000;

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

function cleanTrackTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    // Strip parenthetical/bracketed feat clauses first so we never leave an orphaned "(" or "["
    .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|with)\s+[^\]\)]+[\)\]]/gi, '')
    // Strip official/video/audio/remaster/live/explicit edition tags in brackets
    .replace(
      /\s*[\(\[]\s*(?:official(?:\s+(?:music|lyric|lyrics|hd|4k|audio|video))*\s*(?:video|audio|visualizer)?|lyrics?(?:\s+video)?|hd|4k|hq|audio(?:\s+only)?|video|explicit|clean|live|acoustic|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?)\s*[\)\]]/gi,
      ''
    )
    // Strip trailing feat./ft. outside brackets without eating closing delimiters
    .replace(/\s+(?:feat\.?|ft\.?)\s+[^(\[\)\]\-|]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistName(artist, { splitCollaborators = false } = {}) {
  if (!artist || typeof artist !== 'string') return '';
  let cleaned = artist
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s+\b(?:feat\.?|ft\.?)\b.*$/i, '')
    .trim();
  if (splitCollaborators) {
    cleaned = cleaned.split(/,|&|•/)[0].trim();
  }
  return cleaned;
}

function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = [];
  const timeTagRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  let offsetSec = 0;

  for (const rawLine of lrcText.split(/\r?\n/)) {
    const offsetMatch = rawLine.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i);
    if (offsetMatch) {
      const ms = parseInt(offsetMatch[1], 10);
      if (Number.isFinite(ms)) {
        offsetSec = Math.max(-30, Math.min(30, ms / 1000));
      }
      continue;
    }

    const matches = [...rawLine.matchAll(timeTagRegex)];
    if (matches.length === 0) continue;
    const text = rawLine.replace(timeTagRegex, '').trim();
    for (const m of matches) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      const fracStr = m[3] || '0';
      const frac = parseInt(fracStr, 10) / Math.pow(10, fracStr.length);
      const time = Math.max(0, minutes * 60 + seconds + frac - offsetSec);
      lines.push({ time, text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function parseLyricRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const synced = parseLrc(record.syncedLyrics);
  const plain = typeof record.plainLyrics === 'string' ? record.plainLyrics.trim() : '';
  if (synced.length === 0 && plain.length === 0) {
    return null;
  }
  return { record, synced, plain };
}

class LyricsAndArtworkService {
  constructor() {
    this.lyricsCache = new Map();
    this.artworkCache = new Map();
    this.inFlightLyrics = new Map();
    this.inFlightArtwork = new Map();
  }

  _setLru(map, limit, key, val) {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= limit) {
      map.delete(map.keys().next().value);
    }
    map.set(key, val);
  }

  async _fetchJson(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': `YTMusicClient/${getAppVersion()}` },
      });
      if (res.status === 404) {
        return { ok: true, status: 404, data: null };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, data: null };
      }
      const data = await res.json();
      return { ok: true, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async _lookupArtistCandidates(cleanedTitle, artistCandidate, duration, networkState) {
    if (artistCandidate) {
      const params = new URLSearchParams({
        track_name: cleanedTitle,
        artist_name: artistCandidate,
      });
      if (Number.isFinite(duration) && duration > 0) {
        params.set('duration', String(Math.round(duration)));
      }
      const exactRes = await this._fetchJson(`${LRCLIB_GET}?${params.toString()}`);
      if (!exactRes.ok) networkState.hadTransientFailure = true;
      const parsedExact = parseLyricRecord(exactRes.data);
      if (parsedExact) return parsedExact;
    }

    const searchParams = new URLSearchParams({ track_name: cleanedTitle });
    if (artistCandidate) searchParams.set('artist_name', artistCandidate);
    const searchRes = await this._fetchJson(`${LRCLIB_SEARCH}?${searchParams.toString()}`);
    if (!searchRes.ok) networkState.hadTransientFailure = true;
    let results = searchRes.data;

    if ((!Array.isArray(results) || results.length === 0) && artistCandidate) {
      const fallbackParams = new URLSearchParams({
        q: `${artistCandidate} ${cleanedTitle}`,
      });
      const fbRes = await this._fetchJson(`${LRCLIB_SEARCH}?${fallbackParams.toString()}`);
      if (!fbRes.ok) networkState.hadTransientFailure = true;
      results = fbRes.data;
    }

    if (Array.isArray(results) && results.length > 0) {
      const valid = [];
      for (const item of results) {
        const parsed = parseLyricRecord(item);
        if (parsed) valid.push(parsed);
      }
      if (valid.length > 0) {
        valid.sort((a, b) => {
          const aSynced = a.synced.length > 0 ? 1 : 0;
          const bSynced = b.synced.length > 0 ? 1 : 0;
          if (aSynced !== bSynced) return bSynced - aSynced;
          if (Number.isFinite(duration) && duration > 0) {
            const aDiff = Math.abs((a.record.duration || duration) - duration);
            const bDiff = Math.abs((b.record.duration || duration) - duration);
            return aDiff - bDiff;
          }
          return 0;
        });
        return valid[0];
      }
    }

    return null;
  }

  async getLyrics({ title, artist, duration } = {}) {
    const cleanedTitle = cleanTrackTitle(title);
    const primaryArtist = cleanArtistName(artist, { splitCollaborators: false });
    const splitArtist = cleanArtistName(artist, { splitCollaborators: true });
    if (!cleanedTitle) {
      return { found: false, synced: [], plain: '' };
    }

    const cacheKey = `${primaryArtist.toLowerCase()}::${cleanedTitle.toLowerCase()}`;
    if (this.lyricsCache.has(cacheKey)) {
      const entry = this.lyricsCache.get(cacheKey);
      if (entry.value.found || Date.now() < entry.expiresAt) {
        this._setLru(this.lyricsCache, LYRICS_CACHE_LIMIT, cacheKey, entry);
        return entry.value;
      }
      this.lyricsCache.delete(cacheKey);
    }

    if (this.inFlightLyrics.has(cacheKey)) {
      return this.inFlightLyrics.get(cacheKey);
    }

    const promise = (async () => {
      const networkState = { hadTransientFailure: false };
      let matched = await this._lookupArtistCandidates(
        cleanedTitle,
        primaryArtist,
        duration,
        networkState
      );

      if (!matched && splitArtist && splitArtist.toLowerCase() !== primaryArtist.toLowerCase()) {
        matched = await this._lookupArtistCandidates(
          cleanedTitle,
          splitArtist,
          duration,
          networkState
        );
      }

      const result = matched
        ? {
            found: true,
            trackName: matched.record.trackName || cleanedTitle,
            artistName: matched.record.artistName || primaryArtist,
            synced: matched.synced,
            plain: matched.record.plainLyrics || '',
          }
        : { found: false, synced: [], plain: '' };

      if (result.found) {
        this._setLru(this.lyricsCache, LYRICS_CACHE_LIMIT, cacheKey, {
          value: result,
          expiresAt: Infinity,
        });
      } else if (!networkState.hadTransientFailure) {
        this._setLru(this.lyricsCache, LYRICS_CACHE_LIMIT, cacheKey, {
          value: result,
          expiresAt: Date.now() + MISS_CACHE_TTL_MS,
        });
      }

      return result;
    })();

    this.inFlightLyrics.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightLyrics.delete(cacheKey);
    }
  }

  async fetchArtworkDataUrl(artworkUrl) {
    if (!artworkUrl || typeof artworkUrl !== 'string') return null;
    if (artworkUrl.startsWith('data:image/')) return artworkUrl;

    let parsedUrl;
    try {
      parsedUrl = new URL(artworkUrl);
    } catch {
      return null;
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return null;
    }

    if (this.artworkCache.has(artworkUrl)) {
      const cached = this.artworkCache.get(artworkUrl);
      this._setLru(this.artworkCache, ARTWORK_CACHE_LIMIT, artworkUrl, cached);
      return cached;
    }

    if (this.inFlightArtwork.has(artworkUrl)) {
      return this.inFlightArtwork.get(artworkUrl);
    }

    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(artworkUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': `YTMusicClient/${getAppVersion()}` },
        });
        if (!res.ok) return null;

        const rawType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (rawType && !rawType.startsWith('image/')) {
          return null;
        }
        const contentLen = Number(res.headers.get('content-length') || '0');
        if (Number.isFinite(contentLen) && contentLen > MAX_ARTWORK_BYTES) {
          return null;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0 || buf.byteLength > MAX_ARTWORK_BYTES) {
          return null;
        }

        const contentType = rawType || 'image/jpeg';
        const dataUrl = `data:${contentType};base64,${buf.toString('base64')}`;
        this._setLru(this.artworkCache, ARTWORK_CACHE_LIMIT, artworkUrl, dataUrl);
        return dataUrl;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();

    this.inFlightArtwork.set(artworkUrl, promise);
    try {
      return await promise;
    } finally {
      this.inFlightArtwork.delete(artworkUrl);
    }
  }
}

module.exports = {
  LyricsAndArtworkService,
  cleanTrackTitle,
  cleanArtistName,
  parseLrc,
};
