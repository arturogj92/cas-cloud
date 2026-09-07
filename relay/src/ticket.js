const encoder = new TextEncoder();

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function verifyRelayTicket(token, secret, now = Math.floor(Date.now() / 1000)) {
  try {
    if (typeof token !== 'string' || !secret) throw new Error('missing ticket');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed ticket');
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    if (header.alg !== 'HS256'
      || claims.iss !== 'codeagentswarm'
      || !['codeagentswarm-relay', 'codeagentswarm-mobile-relay'].includes(claims.aud)
      || !['desktop', 'mobile'].includes(claims.role)
      || (claims.role === 'desktop' && claims.aud !== 'codeagentswarm-relay')
      || (claims.role === 'mobile' && claims.aud !== 'codeagentswarm-mobile-relay')
      || (claims.role === 'mobile' && claims.tokenVersion !== 1)
      || typeof claims.sub !== 'string'
      || typeof claims.runtimeId !== 'string'
      || claims.exp <= now
      || (claims.iat && claims.iat > now + 60)
      || (claims.nbf && claims.nbf > now + 5)) throw new Error('invalid ticket claims');
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw new Error('invalid ticket signature');
    return claims;
  } catch {
    throw new Error('Invalid or expired relay ticket');
  }
}
