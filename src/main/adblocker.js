const { matchesDomain, isAuthHost } = require('../shared/auth-hosts');

const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'googletagservices.com',
  '2mdn.net',
  'imasdk.googleapis.com',
  'ads.youtube.com',
];

const YOUTUBE_AD_PATH_PATTERNS = [
  /\/pagead\//i,
  /\/api\/stats\/ads/i,
  /\/api\/stats\/atr/i,
  /\/ptracking/i,
  /\/get_midroll_info/i,
  /\/youtubei\/v1\/log_event/i,
];

function safeDecodePathname(pathname) {
  let decoded = pathname || '/';
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      const next = decoded.replace(/%[0-9A-Fa-f]{2}/g, (hex) => {
        try {
          return decodeURIComponent(hex);
        } catch {
          return hex;
        }
      });
      if (next === decoded) break;
      decoded = next;
    }
  }
  return decoded;
}

function isAdOrTrackingUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return false;

  for (const adHost of AD_HOSTS) {
    if (matchesDomain(host, adHost)) {
      return true;
    }
  }

  const decodedPathname = safeDecodePathname(parsed.pathname);

  if (host === 'play.google.com' && /^\/log(?:\/|$)/i.test(decodedPathname)) {
    return true;
  }

  if (matchesDomain(host, 'youtube.com') || matchesDomain(host, 'youtu.be')) {
    for (const pattern of YOUTUBE_AD_PATH_PATTERNS) {
      if (pattern.test(decodedPathname)) {
        return true;
      }
    }
  }

  return false;
}

function isAuthOrigin(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return isAuthHost(parsed.hostname);
  } catch {
    return false;
  }
}

function setupNetworkAdBlocker(targetSession, settings, onBlocked) {
  targetSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      if (!settings.get('adBlockEnabled')) {
        callback({ cancel: false });
        return;
      }

      if (isAuthOrigin(details.url)) {
        callback({ cancel: false });
        return;
      }

      if (isAdOrTrackingUrl(details.url)) {
        callback({ cancel: true });
        if (typeof onBlocked === 'function') {
          try {
            onBlocked(details.url);
          } catch {
            // Ignore callback errors so blocked requests still complete cleanly
          }
        }
        return;
      }

      callback({ cancel: false });
    }
  );
}

module.exports = { setupNetworkAdBlocker, isAdOrTrackingUrl };
