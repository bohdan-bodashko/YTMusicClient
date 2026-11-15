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

const AD_PATH_PATTERNS = [
  /\/pagead\//i,
  /\/api\/stats\/ads/i,
  /\/api\/stats\/atr/i,
  /\/ptracking/i,
  /\/get_midroll_info/i,
  /\/youtubei\/v1\/log_event/i,
  /^https:\/\/play\.google\.com\/log/i,
];

function isAdOrTrackingUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  for (const adHost of AD_HOSTS) {
    if (matchesDomain(host, adHost)) {
      return true;
    }
  }

  if (
    matchesDomain(host, 'youtube.com') ||
    matchesDomain(host, 'youtu.be') ||
    host === 'play.google.com'
  ) {
    for (const pattern of AD_PATH_PATTERNS) {
      if (pattern.test(rawUrl)) {
        return true;
      }
    }
  }

  return false;
}

function isAuthOrigin(rawUrl) {
  if (!rawUrl) return false;
  try {
    return isAuthHost(new URL(rawUrl).hostname);
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

      if (
        isAuthOrigin(details.url) ||
        isAuthOrigin(details.initiator) ||
        isAuthOrigin(details.referrer)
      ) {
        callback({ cancel: false });
        return;
      }

      if (isAdOrTrackingUrl(details.url)) {
        if (typeof onBlocked === 'function') {
          onBlocked(details.url);
        }
        callback({ cancel: true });
        return;
      }

      callback({ cancel: false });
    }
  );
}

module.exports = { setupNetworkAdBlocker, isAdOrTrackingUrl };
