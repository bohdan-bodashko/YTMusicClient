const { AUTH_HOSTS, matchesDomain, isAuthHost } = require('../shared/auth-hosts');

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
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      let host = '';
      try {
        host = new URL(details.url).hostname.toLowerCase();
      } catch {
        host = '';
      }

      const mode = settings.get('authUserAgentMode') || 'chrome';
      const isGoogleOrYouTube =
        isAuthHost(host) || matchesDomain(host, 'google.com') || matchesDomain(host, 'youtube.com');

      if (isGoogleOrYouTube) {
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
  for (const host of AUTH_HOSTS) {
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
    const cleanDomain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (
      isAuthHost(cleanDomain) ||
      cleanDomain.includes('accounts.google') ||
      cleanDomain.includes('accounts.youtube')
    ) {
      const protocol = cookie.secure ? 'https:' : 'http:';
      const url = `${protocol}//${cleanDomain}${cookie.path || '/'}`;
      await targetSession.cookies.remove(url, cookie.name).catch(() => {});
    }
  }
  await targetSession.cookies.flushStore().catch(() => {});
}

function parseCookieHeader(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return [];
  let text = rawInput.trim();
  if (/^cookie\s*:/i.test(text)) {
    text = text.replace(/^cookie\s*:/i, '').trim();
  }

  const pairs = [];
  for (const part of text.split(/;|\r?\n/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Reject control characters or invalid cookie names with whitespace
    if (!name || /[\s\x00-\x1f\x7f]/.test(name) || /[\r\n\x00]/.test(value)) {
      continue;
    }
    pairs.push({ name, value });
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

    if (isHostPrefix) {
      try {
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
      } catch {
        // Ignore individual invalid __Host- cookie and continue
      }
      continue;
    }

    const targets = [
      { url: 'https://music.youtube.com/', domain: '.youtube.com' },
      { url: 'https://accounts.google.com/', domain: '.google.com' },
    ];

    let setAny = false;
    for (const target of targets) {
      try {
        await targetSession.cookies.set({
          url: target.url,
          domain: target.domain,
          name,
          value,
          path: '/',
          secure: true,
          sameSite: 'no_restriction',
          expirationDate,
        });
        setAny = true;
      } catch {
        // Ignore target-specific set failure
      }
    }
    if (setAny) {
      importedCount += 1;
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
};
