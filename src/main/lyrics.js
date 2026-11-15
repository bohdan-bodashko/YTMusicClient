const LRCLIB_GET = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const LYRICS_CACHE_LIMIT = 150;
const ARTWORK_CACHE_LIMIT = 80;

function cleanTrackTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*[\(\[](?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer)|lyrics?|hd|4k|hq|audio|video|explicit|remastered(?:\s+\d{4})?)[\)\]]/gi, '')
    .replace(/\s*(?:feat\.?|ft\.?)\s+[^(\[\-|]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistName(artist) {
  if (!artist) return '';
  return artist
    .replace(/\s*-\s*Topic$/i, '')
    .split(/,|&|•|\bfeat\.?\b|\bft\.?\b/i)[0]
    .trim();
}

function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = [];
  const timeTagRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const rawLine of lrcText.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(timeTagRegex)];
    if (matches.length === 0) continue;
    const text = rawLine.replace(timeTagRegex, '').trim();
    for (const m of matches) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      const fracStr = m[3] || '0';
      const frac = parseInt(fracStr, 10) / Math.pow(10, fracStr.length);
      const time = minutes * 60 + seconds + frac;
      lines.push({ time, text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

class LyricsAndArtworkService {
  constructor() {
    this.lyricsCache = new Map();
    this.artworkCache = new Map();
  }

  async _fetchJson(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'YTMusicClient/1.0.0' },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getLyrics({ title, artist, duration }) {
    const cleanedTitle = cleanTrackTitle(title);
    const cleanedArtist = cleanArtistName(artist);
    if (!cleanedTitle) {
      return { found: false, synced: [], plain: '' };
    }

    const cacheKey = `${cleanedArtist.toLowerCase()}::${cleanedTitle.toLowerCase()}`;
    if (this.lyricsCache.has(cacheKey)) {
      return this.lyricsCache.get(cacheKey);
    }

    let match = null;

    if (cleanedArtist) {
      const params = new URLSearchParams({
        track_name: cleanedTitle,
        artist_name: cleanedArtist,
      });
      if (Number.isFinite(duration) && duration > 0) {
        params.set('duration', String(Math.round(duration)));
      }
      const exact = await this._fetchJson(`${LRCLIB_GET}?${params.toString()}`);
      if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
        match = exact;
      }
    }

    if (!match) {
      const searchParams = new URLSearchParams({ track_name: cleanedTitle });
      if (cleanedArtist) searchParams.set('artist_name', cleanedArtist);
      let results = await this._fetchJson(`${LRCLIB_SEARCH}?${searchParams.toString()}`);

      if ((!Array.isArray(results) || results.length === 0) && cleanedArtist) {
        const fallbackParams = new URLSearchParams({
          q: `${cleanedArtist} ${cleanedTitle}`,
        });
        results = await this._fetchJson(`${LRCLIB_SEARCH}?${fallbackParams.toString()}`);
      }

      if (Array.isArray(results) && results.length > 0) {
        // Prefer syncedLyrics and closest duration
        results.sort((a, b) => {
          const aSynced = a.syncedLyrics ? 1 : 0;
          const bSynced = b.syncedLyrics ? 1 : 0;
          if (aSynced !== bSynced) return bSynced - aSynced;
          if (Number.isFinite(duration) && duration > 0) {
            const aDiff = Math.abs((a.duration || duration) - duration);
            const bDiff = Math.abs((b.duration || duration) - duration);
            return aDiff - bDiff;
          }
          return 0;
        });
        match = results.find((r) => r.syncedLyrics || r.plainLyrics) || null;
      }
    }

    const result = match
      ? {
          found: true,
          trackName: match.trackName || cleanedTitle,
          artistName: match.artistName || cleanedArtist,
          synced: parseLrc(match.syncedLyrics),
          plain: match.plainLyrics || '',
        }
      : { found: false, synced: [], plain: '' };

    if (this.lyricsCache.size >= LYRICS_CACHE_LIMIT) {
      this.lyricsCache.delete(this.lyricsCache.keys().next().value);
    }
    this.lyricsCache.set(cacheKey, result);
    return result;
  }

  async fetchArtworkDataUrl(artworkUrl) {
    if (!artworkUrl || typeof artworkUrl !== 'string') return null;
    if (artworkUrl.startsWith('data:')) return artworkUrl;
    if (this.artworkCache.has(artworkUrl)) {
      return this.artworkCache.get(artworkUrl);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(artworkUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'YTMusicClient/1.0.0' },
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      const dataUrl = `data:${contentType};base64,${buf.toString('base64')}`;

      if (this.artworkCache.size >= ARTWORK_CACHE_LIMIT) {
        this.artworkCache.delete(this.artworkCache.keys().next().value);
      }
      this.artworkCache.set(artworkUrl, dataUrl);
      return dataUrl;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  LyricsAndArtworkService,
  cleanTrackTitle,
  cleanArtistName,
  parseLrc,
};
