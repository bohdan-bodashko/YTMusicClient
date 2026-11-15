const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'myaccount.google.com',
  'signin.google.com',
  'ogs.google.com',
]);

function getChromeMajor() {
  const full = process.versions.chrome || '134.0.0.0';
  return full.split('.')[0] || '134';
}

function getCleanChromeUserAgent() {
  const major = getChromeMajor();
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function getFirefoxUserAgent() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';
}

function isAuthHost(hostname) {
  if (!hostname) return false;
  return AUTH_HOSTS.has(hostname.toLowerCase());
}

function setHeaderCaseInsensitive(headers, targetName, value) {
  const lower = targetName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
  if (value !== undefined && value !== null) {
    headers[targetName] = value;
  }
}

function deleteHeadersByPrefix(headers, prefix) {
  const lowerPrefix = prefix.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith(lowerPrefix)) {
      delete headers[key];
    }
  }
}

function setupAuthHeaders(targetSession, settings) {
  const major = getChromeMajor();
  const chromeUa = getCleanChromeUserAgent();
  const firefoxUa = getFirefoxUserAgent();
  const secChUa = `"Not:A-Brand";v="24", "Chromium";v="${major}", "Google Chrome";v="${major}"`;
  const secChUaFull = `"Not:A-Brand";v="24.0.0.0", "Chromium";v="${major}.0.0.0", "Google Chrome";v="${major}.0.0.0"`;

  targetSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    let host = '';
    try {
      host = new URL(details.url).hostname;
    } catch {
      host = '';
    }

    const mode = settings.get('authUserAgentMode') || 'chrome';
    setHeaderCaseInsensitive(headers, 'X-Requested-With', null);

    if (mode === 'firefox' && isAuthHost(host)) {
      setHeaderCaseInsensitive(headers, 'User-Agent', firefoxUa);
      deleteHeadersByPrefix(headers, 'sec-ch-ua');
    } else {
      setHeaderCaseInsensitive(headers, 'User-Agent', chromeUa);
      if (host.endsWith('google.com') || host.endsWith('youtube.com')) {
        setHeaderCaseInsensitive(headers, 'Sec-CH-UA', secChUa);
        setHeaderCaseInsensitive(headers, 'Sec-CH-UA-Mobile', '?0');
        setHeaderCaseInsensitive(headers, 'Sec-CH-UA-Platform', '"Windows"');
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase();
          if (lower === 'sec-ch-ua-full-version-list') {
            headers[key] = secChUaFull;
          } else if (lower === 'sec-ch-ua-full-version') {
            headers[key] = `"${major}.0.0.0"`;
          }
        }
      }
    }

    callback({ requestHeaders: headers });
  });
}

async function clearGoogleAuthCookies(targetSession) {
  const authOrigins = [
    'https://accounts.google.com',
    'https://accounts.youtube.com',
    'https://gds.google.com',
    'https://myaccount.google.com',
  ];
  for (const origin of authOrigins) {
    await targetSession.clearStorageData({
      origin,
      storages: ['cookies', 'localstorage', 'serviceworkers'],
    });
  }
  const cookies = await targetSession.cookies.get({});
  for (const cookie of cookies) {
    if (
      cookie.domain &&
      (cookie.domain.includes('accounts.google') ||
        cookie.domain.includes('accounts.youtube') ||
        cookie.domain === 'gds.google.com')
    ) {
      const protocol = cookie.secure ? 'https:' : 'http:';
      const cleanDomain = cookie.domain.replace(/^\./, '');
      const url = `${protocol}//${cleanDomain}${cookie.path || '/'}`;
      await targetSession.cookies.remove(url, cookie.name).catch(() => {});
    }
  }
}

function parseCookieHeader(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return [];
  let text = rawInput.trim();
  if (/^cookie\s*:/i.test(text)) {
    text = text.replace(/^cookie\s*:/i, '').trim();
  }

  const pairs = [];
  for (const part of text.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (name && value !== undefined) {
      pairs.push({ name, value });
    }
  }
  return pairs;
}

async function importBrowserCookies(targetSession, rawCookieHeader, noCookiesMessage) {
  const pairs = parseCookieHeader(rawCookieHeader);
  if (pairs.length === 0) {
    throw new Error(noCookiesMessage || 'No valid cookies found in the pasted text.');
  }

  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  let importedCount = 0;

  for (const { name, value } of pairs) {
    const isHostPrefix = name.startsWith('__Host-');
    const isSecurePrefix = name.startsWith('__Secure-') || isHostPrefix;

    if (isHostPrefix) {
      await targetSession.cookies.set({
        url: 'https://music.youtube.com/',
        name,
        value,
        path: '/',
        secure: true,
        sameSite: 'lax',
        expirationDate,
      });
      importedCount += 1;
      continue;
    }

    const targets = [
      { url: 'https://music.youtube.com/', domain: '.youtube.com' },
      { url: 'https://accounts.google.com/', domain: '.google.com' },
    ];

    for (const target of targets) {
      await targetSession.cookies
        .set({
          url: target.url,
          domain: target.domain,
          name,
          value,
          path: '/',
          secure: isSecurePrefix || true,
          sameSite: 'no_restriction',
          expirationDate,
        })
        .catch(() => {});
    }
    importedCount += 1;
  }

  await targetSession.cookies.flushStore();
  return { importedCount };
}

module.exports = {
  AUTH_HOSTS,
  isAuthHost,
  getChromeMajor,
  getCleanChromeUserAgent,
  getFirefoxUserAgent,
  setupAuthHeaders,
  clearGoogleAuthCookies,
  parseCookieHeader,
  importBrowserCookies,
};
