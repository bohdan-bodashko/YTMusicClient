const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'ogs.google.com',
  'consent.google.com',
  'consent.youtube.com',
  'gds.google.com',
  'signin.google.com',
]);

function matchesDomain(hostname, domain) {
  if (!hostname || !domain) return false;
  const host = String(hostname).trim().toLowerCase().replace(/\.+$/, '');
  const target = String(domain).trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || !target) return false;
  return host === target || host.endsWith(`.${target}`);
}

function isAuthHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).trim().toLowerCase().replace(/\.+$/, '');
  return AUTH_HOSTS.has(host);
}

module.exports = {
  AUTH_HOSTS,
  matchesDomain,
  isAuthHost,
};
