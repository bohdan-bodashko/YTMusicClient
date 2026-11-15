const dns = require('dns');
const net = require('net');
const { matchesDomain } = require('../shared/auth-hosts');

const LRCLIB_GET = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const LYRICS_CACHE_LIMIT = 150;
const ARTWORK_CACHE_LIMIT = 32;
const ARTWORK_CACHE_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const MAX_LYRICS_JSON_BYTES = 1 * 1024 * 1024;
const MAX_QUERY_TEXT_LEN = 512;
const MAX_METADATA_TEXT_LEN = 300;
const MAX_LRC_BYTES = 200_000;
const MAX_LRC_LINES = 2000;
const MISS_CACHE_TTL_MS = 2 * 60 * 1000;
const ALLOWED_ARTWORK_DOMAINS = ['googleusercontent.com', 'ggpht.com', 'ytimg.com'];
const ALLOWED_ARTWORK_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

function isPrivateOrReservedIpv4Octets(a, b, c) {
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / current network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

function parseIpv6Words(rawIp) {
  let addr = rawIp.toLowerCase();
  const lastColon = addr.lastIndexOf(':');
  if (addr.includes('.') && lastColon !== -1) {
    const ipv4Part = addr.slice(lastColon + 1);
    if (!net.isIPv4(ipv4Part)) return null;
    const octets = ipv4Part.split('.').map(Number);
    const wHi = ((octets[0] << 8) | octets[1]).toString(16);
    const wLo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon)}:${wHi}:${wLo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const parts =
    halves.length === 2
      ? [...left, ...Array(missing).fill('0'), ...right]
      : left;
  if (parts.length !== 8) return null;

  const words = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(parseInt(part, 16));
  }
  return words;
}

function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const clean = ip.split('%')[0].trim();
  if (net.isIPv4(clean)) {
    const [a, b, c] = clean.split('.').map(Number);
    return isPrivateOrReservedIpv4Octets(a, b, c);
  }
  if (net.isIPv6(clean)) {
    const words = parseIpv6Words(clean);
    if (!words) return true;

    const isAllZeroPrefix4 = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0;
    const isAllZeroPrefix5 = isAllZeroPrefix4 && words[4] === 0;

    // :: (unspecified) and ::1 (loopback)
    if (isAllZeroPrefix5 && words[5] === 0 && words[6] === 0 && (words[7] === 0 || words[7] === 1)) {
      return true;
    }
    // ff00::/8 multicast
    if ((words[0] & 0xff00) === 0xff00) return true;
    // fc00::/7 unique local addresses
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 link-local
    if ((words[0] & 0xffc0) === 0xfe80) return true;
    // fec0::/10 deprecated site-local
    if ((words[0] & 0xffc0) === 0xfec0) return true;
    // 2001:db8::/32 documentation
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

    // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), IPv4-translated (::ffff:0:0:0/96), NAT64 (64:ff9b::/96)
    const embedsIpv4 =
      (isAllZeroPrefix5 && (words[5] === 0xffff || words[5] === 0)) ||
      (isAllZeroPrefix4 && words[4] === 0xffff && words[5] === 0) ||
      (words[0] === 0x0064 &&
        words[1] === 0xff9b &&
        words[2] === 0 &&
        words[3] === 0 &&
        words[4] === 0 &&
        words[5] === 0);
    if (embedsIpv4) {
      const a = (words[6] >> 8) & 0xff;
      const b = words[6] & 0xff;
      const c = (words[7] >> 8) & 0xff;
      return isPrivateOrReservedIpv4Octets(a, b, c);
    }
    return false;
  }
  return true;
}

function isAllowedArtworkUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  if (!host || net.isIP(host) !== 0) return false;

  return ALLOWED_ARTWORK_DOMAINS.some((domain) => matchesDomain(host, domain));
}

async function readResponseBufferWithLimit(res, maxBytes, controller) {
  const contentLen = Number(res.headers?.get?.('content-length') || '0');
  if (Number.isFinite(contentLen) && contentLen > maxBytes) {
    controller.abort();
    return null;
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength <= maxBytes ? buf : null;
  }

  const reader = res.body.getReader();
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

function cleanTrackTitle(title) {
  if (!title || typeof title !== 'string') return '';
  const bounded = title.slice(0, MAX_QUERY_TEXT_LEN).replace(/\s+/g, ' ').trim();
  if (!bounded) return '';
  return bounded
    // Strip parenthetical/bracketed feat clauses first so we never leave an orphaned "(" or "["
    .replace(/[\(\[]\s*(?:feat\.?|ft\.?|with)\s+[^\]\)]+[\)\]]/gi, '')
    // Strip official/video/audio/remaster/live/explicit edition tags in brackets
    .replace(
      /[\(\[]\s*(?:official(?:\s+(?:music|lyric|lyrics|hd|4k|audio|video))*(?:\s+(?:video|audio|visualizer))?|lyrics?(?:\s+video)?|hd|4k|hq|audio(?:\s+only)?|video|explicit|clean|live|acoustic|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?)\s*[\)\]]/gi,
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
    .slice(0, MAX_QUERY_TEXT_LEN)
    .replace(/\s+/g, ' ')
    .trim()
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
  const cappedText = lrcText.length > MAX_LRC_BYTES ? lrcText.slice(0, MAX_LRC_BYTES) : lrcText;
  const lines = [];
  const timeTagRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  let offsetSec = 0;

  for (const rawLine of cappedText.split(/\r?\n/, MAX_LRC_LINES)) {
    if (lines.length >= MAX_LRC_LINES) break;
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
      if (lines.length >= MAX_LRC_LINES) break;
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
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const synced = parseLrc(record.syncedLyrics);
  const plain =
    typeof record.plainLyrics === 'string'
      ? record.plainLyrics.slice(0, MAX_LRC_BYTES).trim()
      : '';
  if (synced.length === 0 && plain.length === 0) {
    return null;
  }
  const trackName =
    typeof record.trackName === 'string' ? record.trackName.trim().slice(0, MAX_METADATA_TEXT_LEN) : '';
  const artistName =
    typeof record.artistName === 'string' ? record.artistName.trim().slice(0, MAX_METADATA_TEXT_LEN) : '';
  return { record, trackName, artistName, synced, plain };
}

class LyricsAndArtworkService {
  constructor() {
    this.lyricsCache = new Map();
    this.artworkCache = new Map();
    this.artworkCacheBytes = 0;
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

  _setArtworkCache(key, dataUrl) {
    if (this.artworkCache.has(key)) {
      const oldVal = this.artworkCache.get(key);
      this.artworkCacheBytes -= typeof oldVal === 'string' ? oldVal.length : 0;
      this.artworkCache.delete(key);
    }
    const entryBytes = typeof dataUrl === 'string' ? dataUrl.length : 0;
    if (entryBytes === 0 || entryBytes > ARTWORK_CACHE_MAX_TOTAL_BYTES) {
      return;
    }
    while (
      this.artworkCache.size >= ARTWORK_CACHE_LIMIT ||
      this.artworkCacheBytes + entryBytes > ARTWORK_CACHE_MAX_TOTAL_BYTES
    ) {
      const oldestKey = this.artworkCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestVal = this.artworkCache.get(oldestKey);
      this.artworkCacheBytes -= typeof oldestVal === 'string' ? oldestVal.length : 0;
      this.artworkCache.delete(oldestKey);
    }
    this.artworkCache.set(key, dataUrl);
    this.artworkCacheBytes += entryBytes;
  }

  async _fetchJson(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { 'User-Agent': `YTMusicClient/${getAppVersion()}` },
      });
      if (res.status === 404) {
        return { ok: true, status: 404, data: null };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, data: null };
      }
      if (res.url) {
        const finalUrl = new URL(res.url);
        if (finalUrl.protocol !== 'https:' || finalUrl.hostname.toLowerCase() !== 'lrclib.net') {
          return { ok: false, status: 0, data: null };
        }
      }
      const buf = await readResponseBufferWithLimit(res, MAX_LYRICS_JSON_BYTES, controller);
      if (!buf) {
        return { ok: false, status: 0, data: null };
      }
      const data = JSON.parse(buf.toString('utf8'));
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
            trackName: matched.trackName || cleanedTitle,
            artistName: matched.artistName || primaryArtist,
            synced: matched.synced,
            plain: matched.plain,
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
    if (!isAllowedArtworkUrl(artworkUrl)) return null;

    if (this.artworkCache.has(artworkUrl)) {
      const cached = this.artworkCache.get(artworkUrl);
      this._setArtworkCache(artworkUrl, cached);
      return cached;
    }

    if (this.inFlightArtwork.has(artworkUrl)) {
      return this.inFlightArtwork.get(artworkUrl);
    }

    const promise = (async () => {
      const parsedUrl = new URL(artworkUrl);
      const host = parsedUrl.hostname.toLowerCase().replace(/\.+$/, '');

      let resolved;
      try {
        resolved = await dns.promises.lookup(host, { all: true });
      } catch {
        return null;
      }
      if (!Array.isArray(resolved) || resolved.length === 0) {
        return null;
      }
      for (const entry of resolved) {
        if (!entry || isPrivateOrReservedIp(entry.address)) {
          return null;
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(artworkUrl, {
          signal: controller.signal,
          redirect: 'error',
          headers: { 'User-Agent': `YTMusicClient/${getAppVersion()}` },
        });
        if (!res.ok) return null;
        if (res.url && !isAllowedArtworkUrl(res.url)) {
          return null;
        }

        const rawType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_ARTWORK_MIME_TYPES.has(rawType)) {
          return null;
        }

        const buf = await readResponseBufferWithLimit(res, MAX_ARTWORK_BYTES, controller);
        if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_ARTWORK_BYTES) {
          return null;
        }

        const dataUrl = `data:${rawType};base64,${buf.toString('base64')}`;
        this._setArtworkCache(artworkUrl, dataUrl);
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
  isAllowedArtworkUrl,
  isPrivateOrReservedIp,
};
