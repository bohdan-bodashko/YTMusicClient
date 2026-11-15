const { AUTH_HOSTS, matchesDomain, isAuthHost } = require('../shared/auth-hosts');

const MAX_COOKIE_HEADER_LENGTH = 65536;
const MAX_IMPORTED_COOKIES = 200;

const SET_COOKIE_ATTRIBUTES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'secure',
  'httponly',
  'samesite',
  'priority',
  'partitioned',
  'sameparty',
  'comment',
  'version',
]);

const JS_READABLE_AUTH_COOKIES = new Set([
  'SAPISID',
  'APISID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
]);

const HTTP_ONLY_AUTH_COOKIES = new Set([
  'SID',
  'HSID',
  'SSID',
  'SIDCC',
  'LOGIN_INFO',
  'NID',
  'OSID',
  'LSID',
  'ACCOUNT_CHOOSER',
  'LSOLH',
  'GAPS',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-OSID',
  '__Host-1PLSID',
  '__Host-3PLSID',
  '__Host-GAPS',
]);

const GOOGLE_ACCOUNT_ONLY_COOKIES = new Set([
  'ACCOUNT_CHOOSER',
  'LSOLH',
  'GAPS',
  'OSID',
  'LSID',
  '__Secure-OSID',
  '__Host-1PLSID',
  '__Host-3PLSID',
  '__Host-GAPS',
]);

function isHttpOnlyAuthCookie(name) {
  if (JS_READABLE_AUTH_COOKIES.has(name)) return false;
  if (HTTP_ONLY_AUTH_COOKIES.has(name)) return true;
  if (/^__Secure-(?:1|3)P(?:SID|OSID|LSID)/i.test(name)) return true;
  if (/^__Host-(?:1|3)PLSID$/i.test(name)) return true;
  return false;
}

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

  targetSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      let host = '';
      try {
        host = new URL(details.url).hostname.toLowerCase().replace(/\.+$/, '');
      } catch {
        host = '';
      }

      const mode = settings.get('authUserAgentMode') || 'chrome';
      const isAuthOrPlayerHost =
        isAuthHost(host) || host === 'music.youtube.com' || host === 'www.youtube.com';
      const isGoogleOrYouTube =
        isAuthHost(host) || matchesDomain(host, 'google.com') || matchesDomain(host, 'youtube.com');

      if (isAuthOrPlayerHost) {
        setHeaderCaseInsensitive(headers, 'X-Requested-With', null);
      }

      if (mode === 'firefox' && isAuthHost(host)) {
        setHeaderCaseInsensitive(headers, 'User-Agent', firefoxUa);
        deleteHeadersByPrefix(headers, 'sec-ch-ua');
      } else {
        setHeaderCaseInsensitive(headers, 'User-Agent', chromeUa);
        if (isGoogleOrYouTube) {
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
    }
  );
}

async function clearGoogleAuthCookies(targetSession) {
  const storageHosts = new Set([
    ...AUTH_HOSTS,
    'music.youtube.com',
    'www.youtube.com',
    'youtube.com',
    'google.com',
  ]);
  for (const host of storageHosts) {
    await targetSession
      .clearStorageData({
        origin: `https://${host}`,
        storages: ['cookies', 'localstorage', 'serviceworkers'],
      })
      .catch(() => {});
  }

  const cookies = await targetSession.cookies.get({}).catch(() => []);
  for (const cookie of cookies) {
    if (!cookie.domain) continue;
    const cleanDomain = cookie.domain.replace(/^\./, '').toLowerCase().replace(/\.+$/, '');
    if (
      isAuthHost(cleanDomain) ||
      matchesDomain(cleanDomain, 'google.com') ||
      matchesDomain(cleanDomain, 'youtube.com')
    ) {
      const protocol = cookie.secure ? 'https:' : 'http:';
      const cookiePath = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
      const url = `${protocol}//${cleanDomain}${cookiePath}`;
      await targetSession.cookies.remove(url, cookie.name).catch(() => {});
    }
  }
  await targetSession.cookies.flushStore().catch(() => {});
}

function parseCookieHeader(rawInput) {
  if (!rawInput || typeof rawInput !== 'string' || rawInput.length > MAX_COOKIE_HEADER_LENGTH) {
    return [];
  }
  let text = rawInput.trim();
  if (/^(?:set-)?cookie\s*:/i.test(text)) {
    text = text.replace(/^(?:set-)?cookie\s*:/i, '').trim();
  }

  const deduped = new Map();
  for (const part of text.split(/;|\r?\n/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (
      !name ||
      name.length > 256 ||
      value.length > 16384 ||
      SET_COOKIE_ATTRIBUTES.has(name.toLowerCase()) ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
      /[\x00-\x1f\x7f]/.test(value)
    ) {
      continue;
    }
    if (!deduped.has(name) && deduped.size >= MAX_IMPORTED_COOKIES) {
      break;
    }
    deduped.set(name, value);
  }
  return Array.from(deduped, ([name, value]) => ({ name, value }));
}

async function importBrowserCookies(targetSession, rawCookieHeader, noCookiesMessage) {
  if (typeof rawCookieHeader !== 'string' || rawCookieHeader.length > MAX_COOKIE_HEADER_LENGTH) {
    throw new Error(noCookiesMessage || 'No valid cookies found in the pasted text.');
  }

  const pairs = parseCookieHeader(rawCookieHeader);
  if (pairs.length === 0) {
    throw new Error(noCookiesMessage || 'No valid cookies found in the pasted text.');
  }

  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
  let importedCount = 0;

  for (const { name, value } of pairs) {
    const isHostPrefix = name.startsWith('__Host-');
    const httpOnly = isHttpOnlyAuthCookie(name);
    const sameSite = name.startsWith('__Secure-3P') ? 'no_restriction' : 'lax';
    const isGoogleAccountCookie = GOOGLE_ACCOUNT_ONLY_COOKIES.has(name);

    if (isHostPrefix) {
      const hostUrl = isGoogleAccountCookie
        ? 'https://accounts.google.com/'
        : 'https://music.youtube.com/';
      try {
        await targetSession.cookies.set({
          url: hostUrl,
          name,
          value,
          path: '/',
          secure: true,
          httpOnly,
          sameSite,
          expirationDate,
        });
        importedCount += 1;
      } catch {
        // Ignore individual invalid __Host- cookie and continue
      }
      continue;
    }

    const target = isGoogleAccountCookie
      ? { url: 'https://accounts.google.com/', domain: '.google.com' }
      : { url: 'https://music.youtube.com/', domain: '.youtube.com' };

    try {
      await targetSession.cookies.set({
        url: target.url,
        domain: target.domain,
        name,
        value,
        path: '/',
        secure: true,
        httpOnly,
        sameSite,
        expirationDate,
      });
      importedCount += 1;
    } catch {
      // Ignore individual invalid cookie and continue
    }
  }

  if (importedCount === 0) {
    throw new Error(noCookiesMessage || 'No valid cookies found in the pasted text.');
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
  isHttpOnlyAuthCookie,
};
