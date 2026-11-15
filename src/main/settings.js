const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ALLOWED_LANGUAGES = new Set(['auto', 'uk', 'en']);
const ALLOWED_AUTH_MODES = new Set(['chrome', 'firefox']);
const ALLOWED_SB_CATEGORIES = new Set([
  'music_offtopic',
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
]);

const BOOLEAN_KEYS = new Set([
  'adBlockEnabled',
  'sponsorBlockEnabled',
  'ambientThemeEnabled',
  'visualizerEnabled',
  'lyricsEnabled',
  'globalMediaKeys',
  'extraHotkeys',
  'minimizeToTray',
  'alwaysOnTop',
  'autoLaunch',
]);

const DEFAULT_SETTINGS = {
  language: 'auto',
  adBlockEnabled: true,
  sponsorBlockEnabled: true,
  sponsorBlockCategories: ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'],
  ambientThemeEnabled: true,
  visualizerEnabled: true,
  lyricsEnabled: true,
  globalMediaKeys: true,
  extraHotkeys: false,
  minimizeToTray: true,
  alwaysOnTop: false,
  autoLaunch: false,
  authUserAgentMode: 'chrome',
  windowBounds: {
    width: 1280,
    height: 820,
    x: undefined,
    y: undefined,
    isMaximized: false,
  },
  stats: {
    blockedAds: 0,
    skippedSegments: 0,
  },
};

function sanitizeWindowBounds(value, fallback) {
  const base = fallback || DEFAULT_SETTINGS.windowBounds;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(base);
  }
  const width =
    typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
      ? Math.max(420, Math.round(value.width))
      : base.width;
  const height =
    typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0
      ? Math.max(320, Math.round(value.height))
      : base.height;
  const x =
    typeof value.x === 'number' && Number.isFinite(value.x) && value.x > -30000
      ? Math.round(value.x)
      : undefined;
  const y =
    typeof value.y === 'number' && Number.isFinite(value.y) && value.y > -30000
      ? Math.round(value.y)
      : undefined;
  const isMaximized =
    typeof value.isMaximized === 'boolean' ? value.isMaximized : Boolean(base.isMaximized);
  return { width, height, x, y, isMaximized };
}

function sanitizeStats(value, fallback) {
  const base = fallback || DEFAULT_SETTINGS.stats;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(base);
  }
  const toNonNegInt = (n, def) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
  return {
    blockedAds: toNonNegInt(value.blockedAds, base.blockedAds),
    skippedSegments: toNonNegInt(value.skippedSegments, base.skippedSegments),
  };
}

function sanitizeCategories(value, fallback) {
  if (!Array.isArray(value)) {
    return structuredClone(fallback);
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && ALLOWED_SB_CATEGORIES.has(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function sanitizeSettingValue(key, value, fallback) {
  if (BOOLEAN_KEYS.has(key)) {
    return typeof value === 'boolean' ? value : fallback;
  }
  if (key === 'language') {
    return ALLOWED_LANGUAGES.has(value) ? value : fallback;
  }
  if (key === 'authUserAgentMode') {
    return ALLOWED_AUTH_MODES.has(value) ? value : fallback;
  }
  if (key === 'sponsorBlockCategories') {
    return sanitizeCategories(value, fallback);
  }
  if (key === 'windowBounds') {
    return sanitizeWindowBounds(value, fallback);
  }
  if (key === 'stats') {
    return sanitizeStats(value, fallback);
  }
  return fallback;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.hasOwn(b, k) && valuesEqual(a[k], b[k]));
}

class SettingsManager {
  constructor(filePath) {
    this.filePath = filePath || path.join(app.getPath('userData'), 'config.json');
    this.data = this._load();
    this.listeners = new Set();
    this._saveTimer = null;
    this._dirty = false;
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return this._mergeDefaults(DEFAULT_SETTINGS, parsed);
      }
    } catch (err) {
      console.error('[Settings] Failed to load config, using defaults:', err);
    }
    return structuredClone(DEFAULT_SETTINGS);
  }

  _mergeDefaults(defaults, current) {
    const result = structuredClone(defaults);
    if (!current || typeof current !== 'object' || Array.isArray(current)) return result;
    for (const key of Object.keys(defaults)) {
      if (Object.hasOwn(current, key)) {
        result[key] = sanitizeSettingValue(key, current[key], defaults[key]);
      }
    }
    return result;
  }

  _saveImmediate() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirty = false;
    const payload = JSON.stringify(this.data, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, payload, 'utf8');
      try {
        fs.renameSync(tmpPath, this.filePath);
      } catch (renameErr) {
        // Fallback if Windows AV/indexer momentarily locks the target during rename
        if (renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY')) {
          fs.writeFileSync(this.filePath, payload, 'utf8');
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      console.error('[Settings] Failed to save config:', err);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore temp cleanup failure
      }
    }
  }

  _scheduleSave(debounceMs = 0) {
    if (!debounceMs || debounceMs <= 0) {
      this._saveImmediate();
      return;
    }
    this._dirty = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) {
        this._saveImmediate();
      }
    }, debounceMs);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      this._saveImmediate();
    }
  }

  getAll() {
    return structuredClone(this.data);
  }

  get(key) {
    return Object.hasOwn(this.data, key) ? structuredClone(this.data[key]) : undefined;
  }

  set(key, value, options = {}) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      return this.getAll();
    }
    const sanitized = sanitizeSettingValue(key, value, this.data[key]);
    if (valuesEqual(this.data[key], sanitized)) {
      return this.getAll();
    }
    this.data[key] = sanitized;
    const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 0;
    this._scheduleSave(debounceMs);
    this._notify(key, sanitized, new Set([key]));
    return this.getAll();
  }

  update(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return this.getAll();
    }
    const changedKeys = new Set();
    for (const [key, value] of Object.entries(partial)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
      const sanitized = sanitizeSettingValue(key, value, this.data[key]);
      if (!valuesEqual(this.data[key], sanitized)) {
        this.data[key] = sanitized;
        changedKeys.add(key);
      }
    }
    if (changedKeys.size === 0) {
      return this.getAll();
    }
    this._saveImmediate();
    this._notify('*', this.getAll(), changedKeys);
    return this.getAll();
  }

  incrementStat(statKey, by = 1) {
    if (statKey !== 'blockedAds' && statKey !== 'skippedSegments') return;
    if (typeof by !== 'number' || !Number.isFinite(by) || by <= 0) return;
    if (!this.data.stats || typeof this.data.stats !== 'object') {
      this.data.stats = { blockedAds: 0, skippedSegments: 0 };
    }
    const prev =
      typeof this.data.stats[statKey] === 'number' && Number.isFinite(this.data.stats[statKey])
        ? this.data.stats[statKey]
        : 0;
    this.data.stats[statKey] = prev + Math.floor(by);
    this._scheduleSave(1500);
    this._notify('stats', structuredClone(this.data.stats), new Set(['stats']));
  }

  resetStats() {
    const nextStats = { blockedAds: 0, skippedSegments: 0 };
    if (valuesEqual(this.data.stats, nextStats)) {
      return nextStats;
    }
    this.data.stats = nextStats;
    this._saveImmediate();
    this._notify('stats', structuredClone(this.data.stats), new Set(['stats']));
    return structuredClone(this.data.stats);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(key, value, changedKeys) {
    const snapshot = this.getAll();
    const keys = changedKeys || new Set([key]);
    for (const fn of this.listeners) {
      try {
        fn(key, value, snapshot, keys);
      } catch (err) {
        console.error('[Settings] Listener error:', err);
      }
    }
  }
}

module.exports = { SettingsManager, DEFAULT_SETTINGS, ALLOWED_SB_CATEGORIES };
