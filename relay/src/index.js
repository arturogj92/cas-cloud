import { verifyRelayTicket } from './ticket.js';
import {
  acquireRelayCircuit,
  closeRelayCircuit,
  consumeRelayQuota,
  dailyRequestLimit,
  openRelayCircuit,
  MONTHLY_BILLABLE_UNIT_LIMIT,
  WEBSOCKET_QUOTA_MAX_RESERVATION,
} from './quota.js';

const PROTOCOL_VERSION = 2;
// ponytail: 6 MB covers current encrypted snapshots; add chunked snapshots if real histories exceed it.
const MAX_MESSAGE_BYTES = 6 * 1024 * 1024;
const RUNTIME_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const RELAY_GROUP_ID = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHARE_ID = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_TTL_MS = 5 * 60_000;
const DESKTOP_CLIENTS = new Set(['desktop', 'cas-cloud']);
const DESKTOP_CHANNELS = new Set(['development', 'production']);
const DESKTOP_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const MAX_PREVIEW_REQUEST_BYTES = 1024 * 1024;
const MAX_PREVIEW_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_BATCH_MESSAGES = 64;
const PEER_FALLBACK_RETRY_BASE_MS = 15_000;
const PEER_FALLBACK_RETRY_MAX_MS = 5 * 60_000;
const PREVIEW_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'if-modified-since', 'if-none-match', 'range']);
const PREVIEW_RESPONSE_HEADERS = new Set(['accept-ranges', 'content-range', 'content-type', 'etag', 'last-modified', 'location']);

function json(socket, message) {
  if (!socket) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function shortRef(value) {
  const text = String(value || '');
  if (!text) return undefined;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0').slice(0, 10);
}

function audit(event, socket, fields = {}) {
  const state = socket?.deserializeAttachment?.() || {};
  console.log(JSON.stringify({
    service: 'mobile-relay',
    event,
    connection: state.connectionId,
    role: state.role,
    runtime: shortRef(state.runtimeId),
    device: shortRef(state.deviceId),
    client: state.client,
    version: state.version,
    channel: state.channel,
    platform: state.platform,
    ...fields,
  }));
}

function safeDesktopMetadata(claims) {
  return {
    ...(DESKTOP_CLIENTS.has(claims.client) ? { client: claims.client } : {}),
    ...(typeof claims.version === 'string' && claims.version.length <= 64 ? { version: claims.version } : {}),
    ...(DESKTOP_CHANNELS.has(claims.channel) ? { channel: claims.channel } : {}),
    ...(DESKTOP_PLATFORMS.has(claims.platform) ? { platform: claims.platform } : {}),
  };
}

function fail(socket, code, message, closeCode) {
  if (closeCode) audit('connection.rejected', socket, { code, closeCode });
  json(socket, { kind: 'relay.error', code, message });
  if (closeCode) socket.close(closeCode, code);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => PAIRING_CODE_ALPHABET[byte & 31]).join('');
}

function normalizedPairingCode(value) {
  const code = String(value || '').toUpperCase().replace(/[-\s]/g, '');
  return PAIRING_CODE.test(code) ? code : null;
}

function formattedPairingCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function secureOrigin(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      || url.username || url.password || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function pairingCodeResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function desktopConnectResponse(value) {
  const code = normalizedPairingCode(value);
  if (!code) return new Response('This connection link is invalid', { status: 400 });
  const formatted = formattedPairingCode(code);
  const deepLink = `codeagentswarm://connect?code=${encodeURIComponent(formatted)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect CAS Cloud</title><style>body{box-sizing:border-box;min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#130b22;color:#f5efff;font:16px system-ui,sans-serif}main{max-width:480px;text-align:center}h1{font-size:28px}p{color:#b9aacb;line-height:1.55}a{display:inline-block;margin-top:12px;padding:12px 18px;border-radius:10px;background:#ffc31a;color:#241800;font-weight:750;text-decoration:none}</style></head><body><main><h1>Connect CAS Cloud</h1><p>CodeAgentSwarm Desktop should open automatically. This link is single-use and expires after five minutes.</p><a href="${deepLink}">Open CodeAgentSwarm</a></main><script nonce="cas-connect">location.href=${JSON.stringify(deepLink)}</script></body></html>`;
  return new Response(html, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-cas-connect'; frame-ancestors 'none'; base-uri 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function quotaResponse(quota) {
  const unavailable = quota.reason === 'unavailable';
  const retrySeconds = quota.retryAt
    ? Math.max(1, Math.ceil((Date.parse(quota.retryAt) - Date.now()) / 1000))
    : 60;
  return Response.json({
    status: unavailable ? 'quota_unavailable' : 'usage_limited',
    reason: quota.reason,
    ...(quota.retryAt ? { retryAt: quota.retryAt } : {}),
  }, {
    status: unavailable ? 503 : 429,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'retry-after': String(retrySeconds),
    },
  });
}

async function guardedDurableFetch(env, target, request) {
  const circuit = await acquireRelayCircuit(env.RELAY_QUOTA);
  if (!circuit.allowed) return quotaResponse({ reason: 'unavailable', retryAt: circuit.retryAt });
  const quota = await consumeRelayQuota(env.RELAY_QUOTA);
  if (!quota.allowed) return quotaResponse(quota);
  try {
    const response = await target.fetch(request);
    if (circuit.probe) await closeRelayCircuit(env.RELAY_QUOTA);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Exceeded allowed volume of requests in Durable Objects free tier')) throw error;
    const retryAt = await openRelayCircuit(env.RELAY_QUOTA);
    console.error(JSON.stringify({
      service: 'mobile-relay',
      event: 'durable-objects.backoff',
      retryAt: new Date(retryAt).toISOString(),
    }));
    return quotaResponse({
      reason: 'unavailable',
      retryAt: new Date(retryAt).toISOString(),
    });
  }
}

function validBox(box) {
  return box
    && typeof box === 'object'
    && typeof box.nonce === 'string'
    && /^[A-Za-z0-9_-]{32}$/.test(box.nonce)
    && typeof box.ciphertext === 'string'
    && /^[A-Za-z0-9_-]{22,8388608}$/.test(box.ciphertext);
}

function rawText(raw) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return '';
}

function previewRoute(url) {
  if (!url.pathname.startsWith('/preview/')) return null;
  const parts = url.pathname.slice('/preview/'.length).split('/');
  if (parts.length < 2) return false;
  let runtimeId;
  try {
    runtimeId = decodeURIComponent(parts.shift());
  } catch {
    return false;
  }
  const shareId = parts.shift();
  if (!RUNTIME_ID.test(runtimeId || '') || !SHARE_ID.test(shareId || '')) return false;
  return {
    runtimeId,
    shareId,
    path: `/${parts.join('/')}${url.search}`,
    proxyBase: `${url.origin}/preview/${encodeURIComponent(runtimeId)}/${shareId}`,
  };
}

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function unbase64(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function allowedHeaders(headers, allowed) {
  return Array.from(headers.entries()).flatMap(([name, value]) => (
    allowed.has(name.toLowerCase()) && value.length <= 8192 ? [[name.toLowerCase(), value]] : []
  ));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (typeof env.MOBILE_RELAY_SECRET !== 'string'
      || env.MOBILE_RELAY_SECRET.length < 32
      || !env.RELAY_QUOTA) {
      return Response.json({ status: 'misconfigured' }, { status: 503 });
    }
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'codeagentswarm-connect',
        protocolVersion: PROTOCOL_VERSION,
        safetyLimits: {
          dailyBillableRequests: dailyRequestLimit(),
          monthlyBillableRequests: MONTHLY_BILLABLE_UNIT_LIMIT / 20,
        },
      });
    }
    if (url.pathname.startsWith('/connect/')) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return desktopConnectResponse(url.pathname.slice('/connect/'.length));
    }
    if (url.pathname.startsWith('/api/mobile/pairing-code/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' },
        });
      }
      if (request.method !== 'GET') return pairingCodeResponse({ error: 'Method not allowed' }, 405);
      const code = normalizedPairingCode(url.pathname.slice('/api/mobile/pairing-code/'.length));
      if (!code) return pairingCodeResponse({ error: 'This pairing code is invalid or expired' }, 400);
      const target = env.RUNTIMES.get(env.RUNTIMES.idFromName(`pairing-code:${code}`));
      return guardedDurableFetch(env, target, new Request(`${url.origin}/_pairing-code/resolve?relay=${encodeURIComponent(url.origin)}`));
    }
    const preview = previewRoute(url);
    if (preview === false) return new Response('Invalid preview link', { status: 400 });
    if (preview) {
      const target = env.RUNTIMES.get(env.RUNTIMES.idFromName(preview.runtimeId));
      return guardedDurableFetch(env, target, request);
    }
    if (url.pathname === '/api/mobile/peer-ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const relayGroupId = url.searchParams.get('group');
      if (!RELAY_GROUP_ID.test(relayGroupId || '')) return new Response('Invalid relay group', { status: 400 });
      audit('peer_group.connection_opened', null, { group: shortRef(relayGroupId) });
      const target = env.RUNTIMES.get(env.RUNTIMES.idFromName(`peer-group:${relayGroupId}`));
      return guardedDurableFetch(env, target, request);
    }
    if (url.pathname !== '/api/mobile/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404 });
    }
    const runtimeId = url.searchParams.get('runtime');
    if (!RUNTIME_ID.test(runtimeId || '')) return new Response('Invalid runtime', { status: 400 });
    audit('connection.opened', null, { runtime: shortRef(runtimeId) });
    const target = env.RUNTIMES.get(env.RUNTIMES.idFromName(runtimeId));
    return guardedDurableFetch(env, target, request);
  },
};

export class RuntimeRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.previewRequests = new Map();
    this.peerDeliveries = new Map();
    this.peerFallbackBackoffs = new Map();
    this.socketMessages = new WeakMap();
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (['/_peer/message', '/_peer/batch'].includes(url.pathname) && request.method === 'POST') {
      let message;
      try { message = await request.json(); } catch { return new Response(null, { status: 400 }); }
      const messages = url.pathname === '/_peer/batch' ? message.messages : [message];
      const ownerId = await this.state.storage.get('ownerId');
      if (!ownerId || ownerId !== message.userId
        || !RUNTIME_ID.test(message.sourceRuntimeId || '')
        || !PUBLIC_KEY.test(message.sourcePublicKey || '')
        || !Array.isArray(messages) || !messages.length || messages.length > MAX_BATCH_MESSAGES
        || messages.some((entry) => (
          !entry || !['to-runtime', 'to-client'].includes(entry.stream) || !validBox(entry.box)
        ))) return new Response(null, { status: 403 });
      const desktop = this.desktop();
      if (!desktop) return new Response(null, { status: 503 });
      const delivered = messages.every((entry) => json(desktop, {
        kind: 'peer.message',
        sourceRuntimeId: message.sourceRuntimeId,
        sourcePublicKey: message.sourcePublicKey,
        stream: entry.stream,
        box: entry.box,
      }));
      return new Response(null, { status: delivered ? 202 : 503 });
    }
    if (url.pathname.startsWith('/_pairing-code/')) return this.pairingCodeRequest(request, url);
    const preview = previewRoute(url);
    if (preview) return this.preview(request, preview);
    if (url.pathname === '/api/mobile/peer-ws') {
      const relayGroupId = url.searchParams.get('group');
      if (!RELAY_GROUP_ID.test(relayGroupId || '')) return new Response('Invalid relay group', { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({
        role: 'peer-pending',
        relayGroupId,
        connectionId: crypto.randomUUID().replaceAll('-', '').slice(0, 10),
        openedAt: Date.now(),
        messageCount: 0,
        messageBytes: 0,
        peerMessages: 0,
        peerBatches: 0,
      });
      audit('peer_group.connection_accepted', server, { group: shortRef(relayGroupId) });
      return new Response(null, { status: 101, webSocket: client });
    }
    const runtimeId = url.searchParams.get('runtime');
    if (!RUNTIME_ID.test(runtimeId || '')) return new Response('Invalid runtime', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      role: 'pending',
      runtimeId,
      connectionId: crypto.randomUUID().replaceAll('-', '').slice(0, 10),
      openedAt: Date.now(),
      messageCount: 0,
        messageBytes: 0,
        runtimeMessages: 0,
        runtimeBatches: 0,
        peerMessages: 0,
    });
    audit('connection.accepted', server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async pairingCodeRequest(request, url) {
    if (url.pathname === '/_pairing-code/register' && request.method === 'PUT') {
      let invite;
      try { invite = await request.json(); } catch { return new Response(null, { status: 400 }); }
      if (!RUNTIME_ID.test(invite.runtimeId || '')
        || !/^[A-Za-z0-9_-]{40,128}$/.test(invite.pairingToken || '')
        || !PUBLIC_KEY.test(invite.desktopPublicKey || '')
        || !secureOrigin(invite.backendOrigin)
        || !Number.isFinite(invite.expiresAt)) return new Response(null, { status: 400 });
      const current = await this.state.storage.get('pairingCode');
      if (current?.expiresAt > Date.now()) return new Response(null, { status: 409 });
      await this.state.storage.put('pairingCode', invite);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/_pairing-code/consume' && request.method === 'DELETE') {
      await this.state.storage.delete('pairingCode');
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== '/_pairing-code/resolve' || request.method !== 'GET') return new Response(null, { status: 404 });
    const invite = await this.state.storage.get('pairingCode');
    if (!invite || invite.expiresAt <= Date.now()) {
      if (invite) await this.state.storage.delete('pairingCode');
      return pairingCodeResponse({ error: 'This pairing code is invalid or expired' }, 410);
    }
    const relayOrigin = secureOrigin(url.searchParams.get('relay'));
    if (!relayOrigin) return pairingCodeResponse({ error: 'This pairing code is invalid or expired' }, 400);
    const payload = new URL('codeagentswarm://pair');
    payload.searchParams.set('relay', relayOrigin);
    payload.searchParams.set('backend', invite.backendOrigin);
    payload.searchParams.set('runtime', invite.runtimeId);
    payload.searchParams.set('token', invite.pairingToken);
    payload.searchParams.set('key', invite.desktopPublicKey);
    payload.searchParams.set('v', '2');
    console.log(JSON.stringify({ service: 'mobile-relay', event: 'pair.code_resolved', runtime: shortRef(invite.runtimeId) }));
    return pairingCodeResponse({ pairingUri: payload.toString(), expiresAt: invite.expiresAt });
  }

  async registerPairingCode(invite) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomPairingCode();
      const target = this.env.RUNTIMES.get(this.env.RUNTIMES.idFromName(`pairing-code:${code}`));
      const response = await guardedDurableFetch(this.env, target, new Request('https://relay.internal/_pairing-code/register', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invite),
      }));
      if (response.status === 201) return code;
      if (response.status !== 409) throw new Error('Could not register pairing code');
    }
    throw new Error('Could not allocate pairing code');
  }

  async consumePairingCode(code) {
    if (!PAIRING_CODE.test(code || '')) return;
    const target = this.env.RUNTIMES.get(this.env.RUNTIMES.idFromName(`pairing-code:${code}`));
    await guardedDurableFetch(this.env, target, new Request('https://relay.internal/_pairing-code/consume', { method: 'DELETE' }));
  }

  async preview(request, route) {
    const desktop = this.desktop();
    if (!desktop) return new Response('Your computer is offline', { status: 503 });
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_PREVIEW_REQUEST_BYTES) return new Response('Preview requests are limited to 1 MB', { status: 413 });
    const body = ['GET', 'HEAD'].includes(request.method) ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_PREVIEW_REQUEST_BYTES) return new Response('Preview requests are limited to 1 MB', { status: 413 });

    const requestId = crypto.randomUUID();
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.previewRequests.delete(requestId);
        resolve(null);
      }, 20_000);
      this.previewRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      });
      if (!json(desktop, {
        kind: 'preview.request',
        requestId,
        shareId: route.shareId,
        method: request.method,
        path: route.path,
        headers: allowedHeaders(request.headers, PREVIEW_REQUEST_HEADERS),
        bodyBase64: body.length ? base64(body) : '',
        proxyBase: route.proxyBase,
      })) {
        clearTimeout(timer);
        this.previewRequests.delete(requestId);
        resolve(null);
      }
    });
    if (!result) return new Response('The localhost app did not respond', { status: 504 });
    const bytes = unbase64(result.bodyBase64 || '');
    if (!bytes || bytes.length > MAX_PREVIEW_RESPONSE_BYTES) return new Response('Invalid preview response', { status: 502 });
    const status = Number.isInteger(result.status) && result.status >= 200 && result.status <= 599 ? result.status : 502;
    const headers = new Headers();
    for (const entry of Array.isArray(result.headers) ? result.headers.slice(0, 64) : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const name = String(entry[0] || '').toLowerCase();
      const value = String(entry[1] || '');
      if (PREVIEW_RESPONSE_HEADERS.has(name) && value && value.length <= 8192) headers.append(name, value);
    }
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    audit('preview.completed', desktop, { status, bytes: bytes.length });
    return new Response(request.method === 'HEAD' ? null : bytes, { status, headers });
  }

  sockets(role) {
    return this.state.getWebSockets().filter((socket) => socket.deserializeAttachment()?.role === role);
  }

  desktop() {
    return this.sockets('desktop')[0] || null;
  }

  peer(runtimeId, userId) {
    return this.sockets('peer').find((socket) => {
      const state = socket.deserializeAttachment();
      return state.runtimeId === runtimeId && state.userId === userId;
    }) || null;
  }

  mobiles(deviceId, exclude = null) {
    return this.sockets('mobile').filter((socket) => {
      if (socket === exclude || socket.deserializeAttachment()?.deviceId !== deviceId) return false;
      if (socket.deserializeAttachment()?.accessExpiresAt > Date.now()) return true;
      fail(socket, 'mobile_token_expired', 'The mobile credential expired', 4001);
      return false;
    });
  }

  async authenticate(socket, message) {
    const runtimeId = socket.deserializeAttachment()?.runtimeId;
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      fail(socket, 'unsupported_protocol', `Protocol ${PROTOCOL_VERSION} is required`, 4002);
      return;
    }
    if (message.kind === 'hello.pair') {
      await this.startPairing(socket, message);
      return;
    }
    if (!['hello.desktop', 'hello.mobile'].includes(message.kind)) {
      fail(socket, 'hello_required', 'Authenticate before sending messages', 4001);
      return;
    }
    let claims;
    try {
      claims = await verifyRelayTicket(message.ticket, this.env.MOBILE_RELAY_SECRET);
    } catch {
      fail(socket, 'invalid_relay_ticket', 'The relay ticket is invalid or expired', 4001);
      return;
    }
    const role = message.kind === 'hello.desktop' ? 'desktop' : 'mobile';
    if (claims.role !== role || claims.runtimeId !== runtimeId) {
      fail(socket, 'invalid_relay_ticket', 'The relay ticket does not match this runtime', 4001);
      return;
    }
    if (role === 'desktop') await this.registerDesktop(socket, claims);
    else await this.registerMobile(socket, claims);
  }

  async authenticatePeer(socket, message) {
    const pending = socket.deserializeAttachment() || {};
    if (message.protocolVersion !== PROTOCOL_VERSION || message.kind !== 'hello.desktop') {
      fail(socket, 'hello_required', 'Authenticate before sending peer messages', 4001);
      return;
    }
    let claims;
    try {
      claims = await verifyRelayTicket(message.ticket, this.env.MOBILE_RELAY_SECRET);
    } catch {
      fail(socket, 'invalid_relay_ticket', 'The relay ticket is invalid or expired', 4001);
      return;
    }
    if (claims.role !== 'desktop'
      || claims.relayGroupId !== pending.relayGroupId
      || !RUNTIME_ID.test(claims.runtimeId || '')
      || !PUBLIC_KEY.test(claims.publicKey || '')) {
      fail(socket, 'invalid_relay_ticket', 'The relay ticket does not match this peer group', 4001);
      return;
    }
    if (!await this.claimOwner(socket, claims.sub)) return;
    const previous = this.peer(claims.runtimeId, claims.sub);
    socket.serializeAttachment({
      ...pending,
      role: 'peer',
      runtimeId: claims.runtimeId,
      userId: claims.sub,
      publicKey: claims.publicKey,
      ...safeDesktopMetadata(claims),
    });
    this.peerFallbackBackoffs.delete(claims.runtimeId);
    if (previous && previous !== socket) fail(previous, 'runtime_reconnected', 'The peer connected elsewhere', 4000);
    audit('peer_group.connected', socket, { group: shortRef(pending.relayGroupId) });
    json(socket, { kind: 'hello.accepted', role: 'peer', connection: pending.connectionId });
    for (const peer of this.sockets('peer')) {
      if (peer !== socket) json(peer, { kind: 'peer.online', targetRuntimeId: claims.runtimeId });
    }
  }

  async claimOwner(socket, userId) {
    const ownerId = await this.state.storage.get('ownerId');
    if (ownerId && ownerId !== userId) {
      fail(socket, 'runtime_not_authorized', 'This runtime belongs to another account', 4003);
      return false;
    }
    if (!ownerId) await this.state.storage.put('ownerId', userId);
    return true;
  }

  async registerDesktop(socket, claims) {
    if (!await this.claimOwner(socket, claims.sub)) return;
    const previous = this.desktop();
    const pending = socket.deserializeAttachment() || {};
    socket.serializeAttachment({
      ...pending,
      role: 'desktop',
      runtimeId: claims.runtimeId,
      userId: claims.sub,
      ...safeDesktopMetadata(claims),
      ...(PUBLIC_KEY.test(claims.publicKey || '') ? { publicKey: claims.publicKey } : {}),
    });
    audit('desktop.connected', socket, { authMs: Date.now() - Number(pending.openedAt || Date.now()) });
    if (previous && previous !== socket) fail(previous, 'runtime_reconnected', 'The runtime connected elsewhere', 4000);
    json(socket, { kind: 'hello.accepted', role: 'desktop', connection: pending.connectionId });
    const announcedDevices = new Set();
    for (const mobile of this.sockets('mobile')) {
      const state = mobile.deserializeAttachment();
      if (state.accessExpiresAt <= Date.now()) {
        fail(mobile, 'mobile_token_expired', 'The mobile credential expired', 4001);
        continue;
      }
      if (!announcedDevices.has(state.deviceId)) {
        announcedDevices.add(state.deviceId);
        json(socket, {
          kind: 'mobile.connected',
          device: { id: state.deviceId, name: state.deviceName, publicKey: state.publicKey },
        });
      }
      json(mobile, { kind: 'runtime.online' });
    }
  }

  async registerMobile(socket, claims) {
    if (!DEVICE_ID.test(claims.deviceId || '') || !PUBLIC_KEY.test(claims.publicKey || '')) {
      fail(socket, 'invalid_relay_ticket', 'The mobile credential is incomplete', 4001);
      return;
    }
    if (!await this.claimOwner(socket, claims.sub)) return;
    const desktop = this.desktop();
    const connected = this.mobiles(claims.deviceId);
    const pending = socket.deserializeAttachment() || {};
    socket.serializeAttachment({
      ...pending,
      role: 'mobile',
      runtimeId: claims.runtimeId,
      userId: claims.sub,
      deviceId: claims.deviceId,
      deviceName: claims.deviceName,
      publicKey: claims.publicKey,
      accessExpiresAt: claims.exp * 1000,
    });
    audit('mobile.connected', socket, {
      authMs: Date.now() - Number(pending.openedAt || Date.now()),
      replicas: connected.length + 1,
      desktopOnline: Boolean(desktop),
    });
    if (!connected.length) {
      json(desktop, {
        kind: 'mobile.connected',
        device: { id: claims.deviceId, name: claims.deviceName, publicKey: claims.publicKey },
      });
    }
    json(socket, { kind: desktop ? 'runtime.online' : 'runtime.offline' });
    json(socket, { kind: 'hello.accepted', role: 'mobile', connection: pending.connectionId });
  }

  async startPairing(socket, message) {
    const runtimeId = socket.deserializeAttachment()?.runtimeId;
    const pairing = await this.state.storage.get('pairing');
    if (!pairing
      || pairing.expiresAt <= Date.now()
      || pairing.token !== message.pairingToken
      || !DEVICE_ID.test(message.device?.id || '')
      || typeof message.device?.name !== 'string'
      || !message.device.name.trim()
      || message.device.name.length > 80
      || !PUBLIC_KEY.test(message.device?.publicKey || '')) {
      fail(socket, 'pairing_expired', 'This pairing request is invalid or expired', 4003);
      return;
    }
    await this.state.storage.delete('pairing');
    await this.consumePairingCode(pairing.pairingCode);
    const pairingId = crypto.randomUUID();
    const pending = {
      pairingId,
      userId: pairing.userId,
      expiresAt: pairing.expiresAt,
      deviceId: message.device.id,
      deviceName: message.device.name.trim(),
      publicKey: message.device.publicKey,
    };
    await this.state.storage.put(`pending:${pairingId}`, pending);
    socket.serializeAttachment({ ...socket.deserializeAttachment(), role: 'pairing', runtimeId, pairingId });
    audit('pair.scanned', socket, { pairing: shortRef(pairingId) });
    json(this.desktop(), {
      kind: 'pair.scanned',
      pairingId,
      device: { id: pending.deviceId, name: pending.deviceName, publicKey: pending.publicKey },
      expiresAt: pending.expiresAt,
    });
    json(socket, {
      kind: 'pair.challenge',
      pairingId,
      desktopPublicKey: pairing.desktopPublicKey,
      expiresAt: pending.expiresAt,
    });
  }

  async createPairing(socket, state, message) {
    if (!PUBLIC_KEY.test(message.desktopPublicKey || '')) {
      fail(socket, 'invalid_public_key', 'The desktop public key is invalid');
      return;
    }
    const backendOrigin = secureOrigin(message.backendOrigin);
    if (!backendOrigin) {
      fail(socket, 'invalid_backend_origin', 'The mobile backend origin is invalid');
      return;
    }
    const stale = await this.state.storage.list({ prefix: 'pending:' });
    await Promise.all(Array.from(stale, ([key, value]) => (
      value.expiresAt <= Date.now() ? this.state.storage.delete(key) : null
    )).filter(Boolean));
    const pairing = {
      token: randomToken(),
      desktopPublicKey: message.desktopPublicKey,
      userId: state.userId,
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    const previous = await this.state.storage.get('pairing');
    if (previous?.pairingCode) await this.consumePairingCode(previous.pairingCode);
    pairing.pairingCode = await this.registerPairingCode({
      runtimeId: state.runtimeId,
      pairingToken: pairing.token,
      desktopPublicKey: pairing.desktopPublicKey,
      backendOrigin,
      expiresAt: pairing.expiresAt,
    });
    await this.state.storage.put('pairing', pairing);
    audit('pair.created', socket);
    json(socket, {
      kind: 'pair.created',
      requestId: message.requestId,
      pairingToken: pairing.token,
      pairingCode: formattedPairingCode(pairing.pairingCode),
      expiresAt: pairing.expiresAt,
    });
  }

  async confirmPairing(socket, state, message) {
    const pending = await this.state.storage.get(`pending:${message.pairingId}`);
    const mobile = this.sockets('pairing').find(
      (candidate) => candidate.deserializeAttachment()?.pairingId === message.pairingId
    );
    if (!pending || !mobile || pending.userId !== state.userId || pending.expiresAt <= Date.now()) {
      if (pending) await this.state.storage.delete(`pending:${message.pairingId}`);
      fail(socket, 'pairing_expired', 'This pairing request is no longer active');
      return;
    }
    await this.state.storage.delete(`pending:${message.pairingId}`);
    if (message.accept !== true) {
      audit('pair.rejected', socket, { pairing: shortRef(message.pairingId) });
      json(mobile, { kind: 'pair.rejected', pairingId: message.pairingId });
      mobile.close(4003, 'pairing_rejected');
      json(socket, { kind: 'pair.rejected', pairingId: message.pairingId });
      return;
    }
    if (!validBox(message.refreshTokenBox)) {
      fail(socket, 'invalid_device_token', 'The mobile refresh credential is invalid');
      return;
    }
    let claims;
    try {
      claims = await verifyRelayTicket(message.deviceToken, this.env.MOBILE_RELAY_SECRET);
    } catch {
      fail(socket, 'invalid_device_token', 'The mobile device token is invalid');
      return;
    }
    if (claims.role !== 'mobile'
      || claims.sub !== state.userId
      || claims.runtimeId !== state.runtimeId
      || claims.deviceId !== pending.deviceId
      || claims.publicKey !== pending.publicKey) {
      fail(socket, 'invalid_device_token', 'The mobile device token does not match the pairing');
      return;
    }
    mobile.serializeAttachment({
      ...mobile.deserializeAttachment(),
      role: 'mobile',
      runtimeId: state.runtimeId,
      userId: state.userId,
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      publicKey: pending.publicKey,
      accessExpiresAt: claims.exp * 1000,
    });
    audit('pair.completed', socket, {
      pairing: shortRef(message.pairingId),
      device: shortRef(pending.deviceId),
    });
    json(socket, {
      kind: 'mobile.connected',
      device: { id: pending.deviceId, name: pending.deviceName, publicKey: pending.publicKey },
    });
    json(mobile, { kind: 'runtime.online' });
    json(mobile, {
      kind: 'pair.completed',
      pairingId: message.pairingId,
      deviceToken: message.deviceToken,
      refreshTokenBox: message.refreshTokenBox,
      accessExpiresAt: claims.exp * 1000,
      runtimeId: state.runtimeId,
      connection: mobile.deserializeAttachment()?.connectionId,
    });
    json(socket, {
      kind: 'pair.completed',
      pairingId: message.pairingId,
      device: { id: pending.deviceId, name: pending.deviceName },
    });
  }

  relay(socket, state, message) {
    if (!validBox(message.box)) {
      fail(socket, 'invalid_runtime_message', 'Encrypted payload is missing or too large');
      return;
    }
    if (state.role === 'mobile') {
      if (!json(this.desktop(), { kind: 'runtime.message', deviceId: state.deviceId, box: message.box })) {
        json(socket, { kind: 'runtime.offline' });
      }
      return;
    }
    if (state.role === 'desktop' && DEVICE_ID.test(message.deviceId || '')) {
      // The desktop compresses large payloads for phones that negotiated it. The relay
      // forwards that one known marker so the phone can decode the box it still cannot read.
      const codec = message.codec === 'deflate' ? { codec: 'deflate' } : {};
      for (const mobile of this.mobiles(message.deviceId)) {
        json(mobile, { kind: 'runtime.message', ...codec, box: message.box });
      }
      return;
    }
    fail(socket, 'invalid_runtime_message', 'Target device is missing');
  }

  consumeBatchRate(socket, count) {
    const current = socket.deserializeAttachment();
    const rateCount = Number(current.rateCount || 0) + count - 1;
    if (rateCount > 6_000) {
      fail(socket, 'rate_limited', 'Too many relay messages', 4008);
      return false;
    }
    socket.serializeAttachment({ ...current, rateCount });
    return true;
  }

  relayRuntimeBatch(socket, state, message) {
    if (state.role !== 'desktop'
      || !DEVICE_ID.test(message.deviceId || '')
      || !Array.isArray(message.messages)
      || !message.messages.length
      || message.messages.length > MAX_BATCH_MESSAGES
      || message.messages.some((entry) => (
        !entry || !validBox(entry.box) || (entry.codec !== undefined && entry.codec !== 'deflate')
      ))) {
      fail(socket, 'invalid_runtime_message', 'Encrypted runtime batch is invalid');
      return;
    }
    if (!this.consumeBatchRate(socket, message.messages.length)) return;
    const mobiles = this.mobiles(message.deviceId);
    for (const entry of message.messages) {
      const codec = entry.codec === 'deflate' ? { codec: 'deflate' } : {};
      for (const mobile of mobiles) json(mobile, { kind: 'runtime.message', ...codec, box: entry.box });
    }
    const current = socket.deserializeAttachment() || state;
    socket.serializeAttachment({
      ...current,
      runtimeMessages: Number(current.runtimeMessages || 0) + message.messages.length,
      runtimeBatches: Number(current.runtimeBatches || 0) + 1,
    });
    audit('runtime.batch_routed', socket, {
      messages: message.messages.length,
      recipients: mobiles.length,
    });
  }

  async relayPeer(socket, state, message) {
    if (!PUBLIC_KEY.test(state.publicKey || '')
      || !RUNTIME_ID.test(message.targetRuntimeId || '')
      || message.targetRuntimeId === state.runtimeId
      || !['to-runtime', 'to-client'].includes(message.stream)
      || !validBox(message.box)) {
      fail(socket, 'invalid_peer_message', 'Private host message is invalid');
      return;
    }
    const targetRuntimeId = message.targetRuntimeId;
    const response = await this.deliverPeerToRuntime(state, message);
    const current = socket.deserializeAttachment() || state;
    socket.serializeAttachment({
      ...current,
      peerDelivered: Number(current.peerDelivered || 0) + (response?.status === 202 ? 1 : 0),
      peerFailed: Number(current.peerFailed || 0) + (response?.status === 202 ? 0 : 1),
    });
    audit(response?.status === 202 ? 'peer.message_routed' : 'peer.message_failed', socket, {
      target: shortRef(targetRuntimeId),
      stream: message.stream,
      bytes: new TextEncoder().encode(JSON.stringify(message.box)).length,
      status: response?.status || 503,
    });
    if (response?.status !== 202) json(socket, { kind: 'peer.offline', targetRuntimeId });
  }

  async deliverPeerToRuntime(state, messageOrMessages) {
    const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages];
    const targetRuntimeId = messages[0].targetRuntimeId;
    const target = this.env.RUNTIMES.get(this.env.RUNTIMES.idFromName(targetRuntimeId));
    const previous = this.peerDeliveries.get(targetRuntimeId) || Promise.resolve();
    const delivery = previous.catch(() => {}).then(async () => {
      const backoff = this.peerFallbackBackoffs.get(targetRuntimeId);
      if (backoff?.retryAt > Date.now()) return null;
      const response = await guardedDurableFetch(this.env, target, new Request(
        messages.length > 1 ? 'https://relay.internal/_peer/batch' : 'https://relay.internal/_peer/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: state.userId,
            sourceRuntimeId: state.runtimeId,
            sourcePublicKey: state.publicKey,
            ...(messages.length > 1
              ? { messages: messages.map(({ stream, box }) => ({ stream, box })) }
              : { stream: messages[0].stream, box: messages[0].box }),
          }),
        },
      ));
      if (response?.status === 202) this.peerFallbackBackoffs.delete(targetRuntimeId);
      else {
        const attempt = Number(backoff?.attempt || 0) + 1;
        this.peerFallbackBackoffs.set(targetRuntimeId, {
          attempt,
          retryAt: Date.now() + Math.min(
            PEER_FALLBACK_RETRY_MAX_MS,
            PEER_FALLBACK_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 10)),
          ),
        });
      }
      return response;
    });
    this.peerDeliveries.set(targetRuntimeId, delivery);
    let response;
    try { response = await delivery; } catch { response = null; }
    if (this.peerDeliveries.get(targetRuntimeId) === delivery) this.peerDeliveries.delete(targetRuntimeId);
    return response;
  }

  async relayPeerGroup(socket, state, message) {
    const messages = message.kind === 'peer.batch' ? message.messages : [message];
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_BATCH_MESSAGES
      || messages.some((entry) => (
        !entry || !RUNTIME_ID.test(entry.targetRuntimeId || '')
        || entry.targetRuntimeId === state.runtimeId
        || !['to-runtime', 'to-client'].includes(entry.stream)
        || !validBox(entry.box)
      ))) {
      fail(socket, 'invalid_peer_message', 'Private host message is invalid');
      return;
    }
    if (!this.consumeBatchRate(socket, messages.length)) return;
    let delivered = 0;
    let fallback = 0;
    const offline = new Set();
    const fallbackByRuntime = new Map();
    for (const entry of messages) {
      const target = this.peer(entry.targetRuntimeId, state.userId);
      if (json(target, {
        kind: 'peer.message',
        sourceRuntimeId: state.runtimeId,
        sourcePublicKey: state.publicKey,
        stream: entry.stream,
        box: entry.box,
      })) {
        this.peerFallbackBackoffs.delete(entry.targetRuntimeId);
        delivered += 1;
      }
      else {
        const pending = fallbackByRuntime.get(entry.targetRuntimeId) || [];
        pending.push(entry);
        fallbackByRuntime.set(entry.targetRuntimeId, pending);
      }
    }
    for (const [targetRuntimeId, pending] of fallbackByRuntime) {
      if ((await this.deliverPeerToRuntime(state, pending))?.status === 202) {
        delivered += pending.length;
        fallback += pending.length;
      } else offline.add(targetRuntimeId);
    }
    for (const targetRuntimeId of offline) json(socket, { kind: 'peer.offline', targetRuntimeId });
    const current = socket.deserializeAttachment() || state;
    socket.serializeAttachment({
      ...current,
      peerMessages: Number(current.peerMessages || 0) + messages.length,
      peerBatches: Number(current.peerBatches || 0) + (message.kind === 'peer.batch' ? 1 : 0),
      peerDelivered: Number(current.peerDelivered || 0) + delivered,
      peerFailed: Number(current.peerFailed || 0) + messages.length - delivered,
    });
    audit('peer_group.messages_routed', socket, {
      group: shortRef(state.relayGroupId),
      batch: message.kind === 'peer.batch',
      messages: messages.length,
      delivered,
      fallback,
      failed: messages.length - delivered,
    });
  }

  async renewMobileCredential(socket, state, message) {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      fail(socket, 'unsupported_protocol', `Protocol ${PROTOCOL_VERSION} is required`);
      return;
    }
    let claims;
    try {
      claims = await verifyRelayTicket(message.ticket, this.env.MOBILE_RELAY_SECRET);
    } catch {
      fail(socket, 'invalid_credential_renewal', 'The renewed mobile credential is invalid');
      return;
    }
    if (claims.role !== 'mobile'
      || !Number.isFinite(claims.exp)
      || claims.sub !== state.userId
      || claims.runtimeId !== state.runtimeId
      || claims.deviceId !== state.deviceId
      || claims.publicKey !== state.publicKey) {
      fail(socket, 'invalid_credential_renewal', 'The renewed mobile credential does not match this device');
      return;
    }
    const accessExpiresAt = claims.exp * 1000;
    socket.serializeAttachment({ ...state, accessExpiresAt });
    audit('mobile.credential_renewed', socket);
    json(socket, { kind: 'credential.renewed', accessExpiresAt });
  }

  webSocketMessage(socket, raw) {
    const previous = this.socketMessages.get(socket) || Promise.resolve();
    const delivery = previous.catch(() => {}).then(() => this.processWebSocketMessage(socket, raw));
    this.socketMessages.set(socket, delivery);
    return delivery.finally(() => {
      if (this.socketMessages.get(socket) === delivery) this.socketMessages.delete(socket);
    });
  }

  async processWebSocketMessage(socket, raw) {
    const attachment = socket.deserializeAttachment() || {};
    const now = Date.now();
    const quotaDay = new Date(now).toISOString().slice(0, 10);
    const quotaMonth = quotaDay.slice(0, 7);
    const sameQuotaPeriod = attachment.quotaDay === quotaDay
      && attachment.quotaMonth === quotaMonth;
    const previousReservation = sameQuotaPeriod
      && Number.isSafeInteger(attachment.quotaReservation)
      && attachment.quotaReservation > 0
      ? attachment.quotaReservation
      : 0;
    let quotaRemaining = sameQuotaPeriod
      && Number.isSafeInteger(attachment.quotaRemaining)
      && attachment.quotaRemaining > 0
      ? attachment.quotaRemaining
      : 0;
    let quotaReservation = previousReservation;
    let quota = { allowed: true };
    if (quotaRemaining > 0) {
      quotaRemaining -= 1;
    } else {
      quotaReservation = previousReservation
        ? Math.min(previousReservation * 4, WEBSOCKET_QUOTA_MAX_RESERVATION)
        : 1;
      quota = await consumeRelayQuota(
        this.env.RELAY_QUOTA,
        'websocket',
        now,
        quotaReservation,
      );
      quotaRemaining = quotaReservation - 1;
    }
    if (!quota.allowed) {
      const unavailable = quota.reason === 'unavailable';
      const code = unavailable ? 'quota_unavailable' : 'usage_limit_reached';
      const message = unavailable
        ? 'Relay usage protection is unavailable'
        : `Relay usage safety limit reached until ${quota.retryAt}`;
      audit('quota.blocked', socket, { reason: quota.reason, retryAt: quota.retryAt });
      for (const active of this.state.getWebSockets()) fail(active, code, message, unavailable ? 1013 : 4008);
      return;
    }
    const rateWindow = now - Number(attachment.rateWindow || 0) < 60_000
      ? Number(attachment.rateWindow)
      : now;
    const rateCount = rateWindow === attachment.rateWindow ? Number(attachment.rateCount || 0) + 1 : 1;
    if (rateCount > 6_000) {
      fail(socket, 'rate_limited', 'Too many relay messages', 4008);
      return;
    }
    const text = rawText(raw);
    const messageBytes = text ? new TextEncoder().encode(text).length : 0;
    socket.serializeAttachment({
      ...attachment,
      quotaDay,
      quotaMonth,
      quotaReservation,
      quotaRemaining,
      rateWindow,
      rateCount,
      messageCount: Number(attachment.messageCount || 0) + 1,
      messageBytes: Number(attachment.messageBytes || 0) + messageBytes,
      lastMessageAt: now,
    });
    if (!text || messageBytes > MAX_MESSAGE_BYTES) {
      fail(socket, 'message_too_large', 'Relay messages may not exceed 1 MB', 4009);
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      fail(socket, 'invalid_json', 'Message must be valid JSON');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fail(socket, 'invalid_message', 'Message must be a JSON object');
      return;
    }
    const messageState = socket.deserializeAttachment();
    if (message?.kind === 'runtime.message'
      || (message?.kind === 'peer.message' && messageState?.role !== 'peer')) {
      const current = messageState;
      const counter = message.kind === 'runtime.message' ? 'runtimeMessages' : 'peerMessages';
      socket.serializeAttachment({ ...current, [counter]: Number(current[counter] || 0) + 1 });
    }
    const state = socket.deserializeAttachment();
    if (state?.role === 'mobile' && state.accessExpiresAt <= now) {
      fail(socket, 'mobile_token_expired', 'The mobile credential expired', 4001);
      return;
    }
    if (!state || state.role === 'pending') return this.authenticate(socket, message);
    if (state.role === 'peer-pending') return this.authenticatePeer(socket, message);
    if (state.role === 'desktop' && message.kind === 'preview.response') {
      const pending = typeof message.requestId === 'string' ? this.previewRequests.get(message.requestId) : null;
      if (!pending) return;
      this.previewRequests.delete(message.requestId);
      pending.resolve(message);
      return;
    }
    if (state.role === 'desktop' && message.kind === 'pair.create') return this.createPairing(socket, state, message);
    if (state.role === 'desktop' && message.kind === 'pair.confirm') return this.confirmPairing(socket, state, message);
    if (state.role === 'mobile' && message.kind === 'credential.renew') {
      await this.renewMobileCredential(socket, state, message);
      return;
    }
    if (['desktop', 'mobile'].includes(state.role) && message.kind === 'runtime.message') {
      this.relay(socket, state, message);
      return;
    }
    if (state.role === 'desktop' && message.kind === 'runtime.batch') {
      this.relayRuntimeBatch(socket, state, message);
      return;
    }
    if (state.role === 'desktop' && message.kind === 'peer.message') {
      await this.relayPeer(socket, state, message);
      return;
    }
    if (state.role === 'peer' && ['peer.message', 'peer.batch'].includes(message.kind)) {
      await this.relayPeerGroup(socket, state, message);
      return;
    }
    fail(socket, 'unsupported_message', 'Message is not allowed in the current state');
  }

  async webSocketClose(socket, code, _reason, wasClean) {
    const state = socket.deserializeAttachment();
    audit('connection.closed', socket, {
      durationMs: Date.now() - Number(state?.openedAt || Date.now()),
      code: Number.isInteger(code) ? code : undefined,
      clean: typeof wasClean === 'boolean' ? wasClean : undefined,
      messages: Number(state?.messageCount || 0),
      bytes: Number(state?.messageBytes || 0),
      runtimeMessages: Number(state?.runtimeMessages || 0),
      runtimeBatches: Number(state?.runtimeBatches || 0),
      peerMessages: Number(state?.peerMessages || 0),
      peerBatches: Number(state?.peerBatches || 0),
      peerDelivered: Number(state?.peerDelivered || 0),
      peerFailed: Number(state?.peerFailed || 0),
    });
    if (state?.role === 'mobile' && !this.mobiles(state.deviceId, socket).length) {
      json(this.desktop(), { kind: 'mobile.disconnected', deviceId: state.deviceId });
    }
    if (state?.role === 'desktop' && this.desktop() === socket) {
      for (const mobile of this.sockets('mobile')) json(mobile, { kind: 'runtime.offline' });
    }
    if (state?.role === 'pairing' && state.pairingId) {
      await this.state.storage.delete(`pending:${state.pairingId}`);
    }
  }

  webSocketError(socket) {
    audit('connection.error', socket);
    socket.close(1011, 'relay_error');
  }
}
