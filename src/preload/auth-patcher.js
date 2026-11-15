(function applyAuthEnvironment(opts) {
  if (window.__ytmcAuthPatched) return;
  window.__ytmcAuthPatched = true;

  const mode = (opts && opts.mode) || 'chrome';
  const major = (opts && opts.chromeMajor) || '134';
  const chromeUa = (opts && opts.chromeUa) || navigator.userAgent;
  const firefoxUa = (opts && opts.firefoxUa) || '';

  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });
  } catch {
    // Ignore if non-configurable
  }

  if (mode === 'firefox' && firefoxUa) {
    try {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => firefoxUa,
        configurable: true,
      });
      Object.defineProperty(navigator, 'appVersion', {
        get: () => '5.0 (Windows)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'vendor', {
        get: () => '',
        configurable: true,
      });
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => undefined,
        configurable: true,
      });
      Object.defineProperty(window, 'chrome', {
        get: () => undefined,
        configurable: true,
      });
    } catch {
      // Ignore property redefinition limits
    }
    return;
  }

  // Chrome mode: align JS Navigator & Client Hints with HTTP headers
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => chromeUa,
      configurable: true,
    });
  } catch {
    // Ignore
  }

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

  try {
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

    Object.defineProperty(navigator, 'userAgentData', {
      get: () => fakeUaData,
      configurable: true,
    });
  } catch {
    // Ignore
  }

  if (!window.chrome) {
    try {
      Object.defineProperty(window, 'chrome', {
        value: {
          app: { isInstalled: false },
          runtime: {},
        },
        writable: true,
        configurable: true,
      });
    } catch {
      // Ignore
    }
  }
})
