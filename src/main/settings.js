const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
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

class SettingsManager {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    this.data = this._load();
    this.listeners = new Set();
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
    if (!current || typeof current !== 'object') return result;
    for (const key of Object.keys(defaults)) {
      if (key in current) {
        if (
          defaults[key] !== null &&
          typeof defaults[key] === 'object' &&
          !Array.isArray(defaults[key])
        ) {
          result[key] = this._mergeDefaults(defaults[key], current[key]);
        } else {
          result[key] = current[key];
        }
      }
    }
    return result;
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Settings] Failed to save config:', err);
    }
  }

  getAll() {
    return structuredClone(this.data);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
    this._notify(key, value);
    return this.getAll();
  }

  update(partial) {
    for (const [key, value] of Object.entries(partial)) {
      if (key in DEFAULT_SETTINGS) {
        this.data[key] = value;
      }
    }
    this._save();
    this._notify('*', this.getAll());
    return this.getAll();
  }

  incrementStat(statKey, by = 1) {
    if (!this.data.stats) {
      this.data.stats = { blockedAds: 0, skippedSegments: 0 };
    }
    this.data.stats[statKey] = (this.data.stats[statKey] || 0) + by;
    this._save();
    this._notify('stats', this.data.stats);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(key, value) {
    for (const fn of this.listeners) {
      try {
        fn(key, value, this.getAll());
      } catch (err) {
        console.error('[Settings] Listener error:', err);
      }
    }
  }
}

module.exports = { SettingsManager, DEFAULT_SETTINGS };
