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
    if (host === adHost || host.endsWith('.' + adHost)) {
      return true;
    }
  }

  if (
    host.endsWith('youtube.com') ||
    host.endsWith('youtu.be') ||
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

const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'myaccount.google.com',
  'signin.google.com',
]);

function isAuthOrigin(rawUrl) {
  if (!rawUrl) return false;
  try {
    return AUTH_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function setupNetworkAdBlocker(targetSession, settings, onBlocked) {
  targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
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
  });
}

module.exports = { setupNetworkAdBlocker, isAdOrTrackingUrl };
