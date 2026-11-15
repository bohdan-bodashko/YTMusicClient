(function applyAuthEnvironment(opts) {
  const PATCH_GUARD = Symbol.for('ytmc:auth-env-patched');
  if (window[PATCH_GUARD]) return;
  try {
    Object.defineProperty(window, PATCH_GUARD, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    // Ignore if window is non-extensible
  }

  const mode = (opts && opts.mode) || 'chrome';
  const major = (opts && opts.chromeMajor) || '134';
  const chromeUa = (opts && opts.chromeUa) || navigator.userAgent;
  const firefoxUa = (opts && opts.firefoxUa) || '';

  const safeDefine = (target, prop, descriptor) => {
    try {
      Object.defineProperty(target, prop, descriptor);
    } catch {
      // Ignore if non-configurable in this context
    }
  };

  if (typeof Navigator !== 'undefined' && Navigator.prototype) {
    safeDefine(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true,
    });
  }
  safeDefine(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  });

  if (mode === 'firefox' && firefoxUa) {
    safeDefine(navigator, 'userAgent', {
      get: () => firefoxUa,
      configurable: true,
    });
    safeDefine(navigator, 'appVersion', {
      get: () => '5.0 (Windows)',
      configurable: true,
    });
    safeDefine(navigator, 'vendor', {
      get: () => '',
      configurable: true,
    });
    safeDefine(navigator, 'userAgentData', {
      get: () => undefined,
      configurable: true,
    });
    try {
      delete window.chrome;
    } catch {
      // Ignore
    }
    safeDefine(window, 'chrome', {
      get: () => undefined,
      configurable: true,
    });
    return;
  }

  // Chrome mode: align JS Navigator & Client Hints with HTTP headers
  safeDefine(navigator, 'userAgent', {
    get: () => chromeUa,
    configurable: true,
  });

  const spoofedBrands = [
    { brand: 'Not:A-Brand', version: '24' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];

  const spoofedFullList = [
    { brand: 'Not:A-Brand', version: '24.0.0.0' },
    { brand: 'Chromium', version: `${major}.0.0.0` },
    { brand: 'Google Chrome', version: `${major}.0.0.0` },
  ];

  const fakeUaData = {
    brands: spoofedBrands,
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: async (hints) => {
      const res = {
        brands: spoofedBrands,
        mobile: false,
        platform: 'Windows',
      };
      if (Array.isArray(hints)) {
        if (hints.includes('architecture')) res.architecture = 'x86';
        if (hints.includes('bitness')) res.bitness = '64';
        if (hints.includes('fullVersionList')) res.fullVersionList = spoofedFullList;
        if (hints.includes('uaFullVersion')) res.uaFullVersion = `${major}.0.0.0`;
        if (hints.includes('platformVersion')) res.platformVersion = '15.0.0';
        if (hints.includes('model')) res.model = '';
        if (hints.includes('wow64')) res.wow64 = false;
      }
      return res;
    },
    toJSON: () => ({
      brands: spoofedBrands,
      mobile: false,
      platform: 'Windows',
    }),
  };

  safeDefine(navigator, 'userAgentData', {
    get: () => fakeUaData,
    configurable: true,
  });

  if (!window.chrome) {
    safeDefine(window, 'chrome', {
      value: {
        app: { isInstalled: false },
        runtime: {},
      },
      writable: true,
      configurable: true,
    });
  }
})
