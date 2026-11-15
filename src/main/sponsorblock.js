const SPONSORBLOCK_API = 'https://sponsor.ajay.app/api/skipSegments';
const CACHE_LIMIT = 200;

class SponsorBlockService {
  constructor() {
    this.cache = new Map();
  }

  async getSegments(videoId, categories = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction']) {
    if (!videoId || typeof videoId !== 'string') return [];

    const validCategories = Array.isArray(categories) && categories.length > 0
      ? categories
      : ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];

    const cacheKey = `${videoId}:${validCategories.slice().sort().join(',')}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const params = new URLSearchParams({
      videoID: videoId,
      categories: JSON.stringify(validCategories),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${SPONSORBLOCK_API}?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'YTMusicClient/1.0.0',
        },
      });

      let segments = [];
      if (response.status === 200) {
        const data = await response.json();
        if (Array.isArray(data)) {
          segments = data
            .filter((item) => Array.isArray(item.segment) && item.segment.length === 2)
            .map((item) => ({
              start: Number(item.segment[0]),
              end: Number(item.segment[1]),
              category: item.category || 'unknown',
              uuid: item.UUID || '',
            }))
            .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start);
        }
      }

      if (this.cache.size >= CACHE_LIMIT) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, segments);
      return segments;
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
