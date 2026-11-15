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
  if (typeof hostname !== 'string' || typeof domain !== 'string') return false;
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  const target = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || !target || host.startsWith('.') || host.includes('..')) return false;
  return host === target || host.endsWith(`.${target}`);
}

function isAuthHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!host || host.startsWith('.') || host.includes('..')) return false;
  return AUTH_HOSTS.has(host);
}

module.exports = {
  AUTH_HOSTS,
  matchesDomain,
  isAuthHost,
};
