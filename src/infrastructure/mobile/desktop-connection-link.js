const DEFAULT_CONNECT_ORIGIN = 'https://codeagentswarm-connect.elcaminodelprogramadorweb.workers.dev';
const PUBLIC_CONNECT_ORIGIN = 'https://connect.codeagentswarm.com';
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

function secureOrigin(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      || url.username || url.password || url.origin !== value) return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

function normalizeCode(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
  return PAIRING_CODE.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null;
}

function configuredOrigin() {
  const value = process.env.CAS_PAIRING_CODE_ORIGIN || DEFAULT_CONNECT_ORIGIN;
  const origin = secureOrigin(value);
  if (!origin) throw new Error('The pairing service is not secure');
  return origin;
}

function codeFromInput(raw) {
  const direct = normalizeCode(raw);
  if (direct) return { code: direct, origin: configuredOrigin() };
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (_) { return null; }
  if (['codeagentswarm:', 'codeagentswarm-dev:'].includes(url.protocol) && url.hostname === 'connect') {
    const code = normalizeCode(url.searchParams.get('code'));
    if (!code) throw new Error('This pairing code is not valid');
    return { code, origin: configuredOrigin() };
  }
  if (!/^\/(?:connect|c)\/[^/]+\/?$/.test(url.pathname)) return null;
  const trusted = new Set([DEFAULT_CONNECT_ORIGIN, PUBLIC_CONNECT_ORIGIN, configuredOrigin()]);
  if (!trusted.has(url.origin) || url.search || url.hash) throw new Error('This pairing code is not valid');
  const code = normalizeCode(url.pathname.split('/').filter(Boolean).at(-1));
  if (!code) throw new Error('This pairing code is not valid');
  return { code, origin: url.origin };
}

async function resolvePairingInput(raw, fetchImpl = globalThis.fetch) {
  const connection = codeFromInput(raw);
  if (!connection) return String(raw || '').trim();
  try {
    const response = await fetchImpl(`${connection.origin}/api/mobile/pairing-code/${encodeURIComponent(connection.code)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (typeof body.pairingUri !== 'string') throw new Error();
    return body.pairingUri;
  } catch (_) {
    throw new Error('This pairing code is invalid or has expired');
  }
}

function desktopConnectionLink(pairing) {
  const code = normalizeCode(pairing?.pairingCode);
  if (!code) throw new Error('CAS Cloud did not return a valid pairing code');
  return `${configuredOrigin()}/connect/${code}`;
}

module.exports = {
  DEFAULT_CONNECT_ORIGIN,
  desktopConnectionLink,
  normalizeCode,
  resolvePairingInput,
};
