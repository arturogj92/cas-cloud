const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boundedConversationMessages } = require('../agent-drivers/chat-history-pagination');
const { askRemoteProject, listRemoteProjects, parseRemoteResourceId } = require('../mobile/remote-runtime-client');

const CONTROL_FILE = 'cas-session-bridge.json';
const REMOTE_PREFIX = 'remote.';
const REMOTE_REPLY_PREFIX = 'remote-reply.';
const MAX_BODY_BYTES = 16 * 1024;
const REPLY_TTL_MS = 30 * 60 * 1000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function controlPath(dataPath) {
  return path.join(dataPath, CONTROL_FILE);
}

function readControlFile(dataPath, { requireAlive = true } = {}) {
  const filePath = controlPath(dataPath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size > 4096
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('CAS Cloud session bridge control file is unsafe');
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { throw new Error('CAS Cloud session bridge control file is invalid'); }
  if (value?.version !== 1
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.token !== 'string' || !/^[0-9a-f]{64}$/i.test(value.token)) {
    throw new Error('CAS Cloud session bridge control file is invalid');
  }
  if (requireAlive && !isAlive(value.pid)) throw new Error('CAS Cloud is not running');
  return value;
}

function encodeRemoteSessionId(runtimeId, sessionId) {
  return `${REMOTE_PREFIX}${Buffer.from(JSON.stringify([runtimeId, sessionId])).toString('base64url')}`;
}

function decodeRemoteSessionId(value) {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_PREFIX) || value.length > 512) {
    throw new Error('The remote session id is invalid');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(REMOTE_PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || parsed.some((part) => typeof part !== 'string' || !part || part.length > 128)) throw new Error();
    return { runtimeId: parsed[0], sessionId: parsed[1] };
  } catch (_) {
    throw new Error('The remote session id is invalid');
  }
}

function safeBearer(request, token) {
  const actual = request.headers.authorization;
  if (typeof actual !== 'string' || typeof token !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(actual);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size <= MAX_BODY_BYTES) text += chunk;
    });
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new Error('Request body is too large'));
      try {
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch (_) {
        reject(new Error('Request body must be JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function publicRemoteState(client) {
  const state = client.getState();
  return {
    phase: state.phase,
    runtime: state.runtime ? { id: state.runtime.id, name: state.runtime.name || null } : null,
    challenge: state.challenge ? { code: state.challenge.code, expiresAt: state.challenge.expiresAt } : null,
    error: state.error || null,
  };
}

class HeadlessSessionBridge {
  constructor({ runtime, remoteClient, peerRuntimeNetwork = null, dataPath, deliverMessage, createPairingLink = null, randomBytes = crypto.randomBytes } = {}) {
    if (!runtime || !remoteClient || typeof deliverMessage !== 'function' || !path.isAbsolute(dataPath || '')) {
      throw new Error('CAS Cloud session bridge configuration is invalid');
    }
    this.runtime = runtime;
    this.remoteClient = remoteClient;
    this.peerRuntimeNetwork = peerRuntimeNetwork;
    this.dataPath = dataPath;
    this.deliverMessage = deliverMessage;
    this.createPairingLink = createPairingLink;
    this.adminToken = randomBytes(32).toString('hex');
    this.sessionSecret = randomBytes(32);
    this.server = null;
    this.port = null;
    this.activeRemoteSessionStarts = new Set();
    this.pendingReplies = new Map();
    this.unsubscribeEnvelopes = null;
    this.unsubscribePeerEnvelopes = null;
  }

  sessionEnv(terminalUuid) {
    if (!this.port || typeof terminalUuid !== 'string' || !terminalUuid) return {};
    const token = crypto.createHmac('sha256', this.sessionSecret).update(terminalUuid).digest('hex');
    return {
      CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED: '1',
      CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED: '1',
      CODEAGENTSWARM_SESSION_BRIDGE_PORT: String(this.port),
      CODEAGENTSWARM_SESSION_BRIDGE_TOKEN: token,
    };
  }

  async start() {
    if (this.server) return { port: this.port };
    const filePath = controlPath(this.dataPath);
    if (fs.existsSync(filePath)) {
      const existing = readControlFile(this.dataPath, { requireAlive: false });
      if (isAlive(existing.pid)) throw new Error('Another CAS Cloud session bridge is already running');
      fs.unlinkSync(filePath);
    }
    const server = http.createServer((request, response) => {
      this._handle(request, response).catch(() => sendJson(response, 500, { error: 'Session bridge failed' }));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = server.address().port;
    this.unsubscribeEnvelopes = this.remoteClient.subscribeEnvelopes((envelope) => {
      if (envelope?.kind === 'coordination.message') void this._receiveResponse(envelope.message);
    });
    this.unsubscribePeerEnvelopes = this.peerRuntimeNetwork?.subscribeEnvelopes((_runtimeId, envelope) => {
      if (envelope?.kind === 'coordination.message') void this._receiveResponse(envelope.message);
    }) || null;
    fs.mkdirSync(this.dataPath, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(filePath, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        port: this.port,
        token: this.adminToken,
      })}\n`, { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    } catch (error) {
      this.unsubscribeEnvelopes?.();
      this.unsubscribeEnvelopes = null;
      this.unsubscribePeerEnvelopes?.();
      this.unsubscribePeerEnvelopes = null;
      this.server = null;
      this.port = null;
      await new Promise((resolve) => server.close(resolve));
      throw error;
    }
    return { port: this.port };
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.unsubscribeEnvelopes?.();
    this.unsubscribeEnvelopes = null;
    this.unsubscribePeerEnvelopes?.();
    this.unsubscribePeerEnvelopes = null;
    this.pendingReplies.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
    const filePath = controlPath(this.dataPath);
    try {
      const current = readControlFile(this.dataPath, { requireAlive: false });
      if (current.pid === process.pid && current.token === this.adminToken) fs.unlinkSync(filePath);
    } catch (_) {}
  }

  _sourceAllowed(sourceSessionId) {
    return Array.from(this.runtime.sessions.values()).some((session) => (
      session.terminalUuid === sourceSessionId && session.state !== 'stopped'
    ));
  }

  _sourceSession(sourceSessionId) {
    return Array.from(this.runtime.sessions.values()).find((session) => (
      session.terminalUuid === sourceSessionId && session.state !== 'stopped'
    ));
  }

  _pruneReplies(now = Date.now()) {
    for (const [requestId, pending] of this.pendingReplies) {
      if (pending.expiresAt <= now) this.pendingReplies.delete(requestId);
    }
  }

  _rememberReply(requestId, value) {
    this._pruneReplies();
    if (this.pendingReplies.size >= 256) this.pendingReplies.delete(this.pendingReplies.keys().next().value);
    this.pendingReplies.set(requestId, { ...value, expiresAt: Date.now() + REPLY_TTL_MS });
  }

  async receiveRemoteMessage(payload, reply) {
    if (!payload || typeof reply !== 'function') throw new Error('Session message details are invalid');
    const target = this._sourceSession(payload.targetSessionId);
    if (!target) throw new Error('The target session is unavailable');
    this._pruneReplies();
    if (this.pendingReplies.has(payload.communicationRequestId)) throw new Error('The session request is already active');
    const replyRouteId = `${REMOTE_REPLY_PREFIX}${crypto.randomUUID()}`;
    this._rememberReply(payload.communicationRequestId, {
      direction: 'incoming',
      sourceSessionId: replyRouteId,
      targetSessionId: payload.targetSessionId,
      remoteSourceSessionId: payload.sourceSessionId,
      replyTargetSessionId: payload.replyTargetSessionId,
      reply,
    });
    try {
      return await this.deliverMessage({
        targetSessionId: payload.targetSessionId,
        sourceSessionId: replyRouteId,
        sourceName: payload.sourceName,
        sourceAgent: payload.sourceAgent,
        message: payload.message,
        messageType: 'request',
        communicationRequestId: payload.communicationRequestId,
      });
    } catch (error) {
      this.pendingReplies.delete(payload.communicationRequestId);
      throw error;
    }
  }

  async _receiveResponse(payload) {
    if (!payload || payload.messageType !== 'response'
      || typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 12_000
      || typeof payload.sourceSessionId !== 'string' || typeof payload.targetSessionId !== 'string'
      || typeof payload.replyToRequestId !== 'string') return;
    this._pruneReplies();
    const pending = this.pendingReplies.get(payload.replyToRequestId);
    if (!pending || pending.direction !== 'outgoing' || pending.responding
      || pending.sourceSessionId !== payload.targetSessionId
      || pending.targetSessionId !== payload.sourceSessionId) return;
    pending.responding = true;
    try {
      await this.deliverMessage({
        targetSessionId: payload.targetSessionId,
        sourceSessionId: payload.sourceSessionId,
        sourceName: payload.sourceName,
        sourceAgent: payload.sourceAgent,
        message: payload.message,
        messageType: 'response',
        replyToRequestId: payload.replyToRequestId,
      });
      this.pendingReplies.delete(payload.replyToRequestId);
    } catch (_) {
      pending.responding = false;
    }
  }

  _remoteClients() {
    const clients = [...(this.peerRuntimeNetwork?.getClients() || []), this.remoteClient];
    const unique = new Map();
    for (const client of clients) {
      const state = client?.getState?.();
      if (state?.phase === 'online' && state.runtime?.id && !unique.has(state.runtime.id)) {
        unique.set(state.runtime.id, client);
      }
    }
    return [...unique.values()];
  }

  _remoteClient(runtimeId) {
    return this._remoteClients().find((client) => client.getState().runtime.id === runtimeId) || null;
  }

  async _remoteCommand(type, payload, runtimeId = null) {
    const client = runtimeId ? this._remoteClient(runtimeId) : this._remoteClients()[0];
    const state = client?.getState?.();
    if (!client || state.phase !== 'online' || !state.runtime?.id) throw new Error('The paired host is offline');
    return client.sendCommand({
      type,
      runtimeId: state.runtime.id,
      payload,
    });
  }

  async _handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/admin/')) {
      if (!safeBearer(request, this.adminToken)) return sendJson(response, 401, { error: 'Unauthorized' });
      if (request.method === 'GET' && url.pathname === '/admin/remote-runtime') {
        return sendJson(response, 200, publicRemoteState(this.remoteClient));
      }
      if (request.method === 'POST' && url.pathname === '/admin/pairing-link') {
        if (typeof this.createPairingLink !== 'function') return sendJson(response, 503, { error: 'Pairing is unavailable' });
        try {
          const result = await this.createPairingLink();
          return sendJson(response, 201, { url: result.url, expiresAt: result.expiresAt });
        } catch (_) {
          return sendJson(response, 503, { error: 'Could not create a connection link' });
        }
      }
      if (request.method === 'POST' && url.pathname === '/admin/remote-runtime/pair') {
        const body = await readJson(request);
        if (typeof body.pairing !== 'string' || !body.pairing.trim()) {
          return sendJson(response, 400, { error: 'Pairing input is required' });
        }
        try {
          await this.remoteClient.pair(body.pairing);
          return sendJson(response, 202, publicRemoteState(this.remoteClient));
        } catch (error) {
          return sendJson(response, 409, { error: error.message || 'Pairing failed' });
        }
      }
      if (request.method === 'DELETE' && url.pathname === '/admin/remote-runtime') {
        try {
          await this.remoteClient.disconnect();
          return sendJson(response, 200, publicRemoteState(this.remoteClient));
        } catch (error) {
          return sendJson(response, 503, { error: error.message || 'The Mac link could not be removed' });
        }
      }
      return sendJson(response, 404, { error: 'Not found' });
    }

    const sourceSessionId = request.headers['x-codeagentswarm-session-id'];
    const expected = typeof sourceSessionId === 'string'
      ? crypto.createHmac('sha256', this.sessionSecret).update(sourceSessionId).digest('hex')
      : null;
    if (!safeBearer(request, expected)) return sendJson(response, 401, { error: 'Unauthorized' });
    if (!this._sourceAllowed(sourceSessionId)) return sendJson(response, 403, { error: 'The source session is unavailable' });

    if (request.method === 'GET' && url.pathname === '/session-communication/sessions') {
      try {
        const results = await Promise.allSettled(this._remoteClients().map(async (client) => ({
          state: client.getState(),
          result: await client.sendCommand({
            type: 'coordination.sessions',
            runtimeId: client.getState().runtime.id,
            payload: {},
          }),
        })));
        const sessions = results.flatMap((entry) => entry.status === 'fulfilled' ? (({ state, result }) => (
          (Array.isArray(result?.sessions) ? result.sessions : []).slice(0, 100).flatMap((session) => (
            session && typeof session.id === 'string' && session.id.length <= 128 ? [{
              id: encodeRemoteSessionId(state.runtime.id, session.id),
              name: clip(session.name, 120), agent: clip(session.agent, 60), project: clip(session.project, 160),
              goal: clip(session.goal, 1200), activity: clip(session.activity, 500), status: clip(session.status, 80),
              surface: session.surface === 'chat' ? 'chat' : 'terminal',
              state: ['working', 'needs_input'].includes(session.state) ? session.state : 'idle',
              host: state.runtime.name || 'Paired host', is_current: false,
            }] : []
          ))
        ))(entry.value) : []);
        return sendJson(response, 200, { sessions });
      } catch (_) {
        return sendJson(response, 503, { error: 'The paired Mac is offline' });
      }
    }

    if (request.method === 'POST' && url.pathname === '/session-communication/transcript') {
      const body = await readJson(request);
      const limit = body.limit === undefined ? 30 : Number(body.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
        return sendJson(response, 400, { error: 'Conversation limit must be between 1 and 60' });
      }
      let target;
      try { target = decodeRemoteSessionId(body.target_session_id); }
      catch (error) { return sendJson(response, 400, { error: error.message }); }
      const client = this._remoteClient(target.runtimeId);
      const state = client?.getState();
      if (!client) return sendJson(response, 404, { error: 'The remote session is unavailable' });
      try {
        const result = await this._remoteCommand('coordination.transcript', {
          targetSessionId: target.sessionId,
          limit,
        }, target.runtimeId);
        const snapshot = boundedConversationMessages(result?.messages, { limit });
        return sendJson(response, 200, {
          session: {
            id: body.target_session_id,
            name: clip(result?.session?.name, 120),
            agent: clip(result?.session?.agent, 60),
            project: clip(result?.session?.project, 160),
            host: state.runtime.name || 'Paired Mac',
          },
          messages: snapshot.messages,
          truncated: result?.truncated === true || snapshot.truncated,
        });
      } catch (_) {
        return sendJson(response, 503, { error: 'The paired Mac could not return the conversation' });
      }
    }

    if (request.method === 'POST' && url.pathname === '/session-communication/messages') {
      const body = await readJson(request);
      const allowed = ['target_session_id', 'message', 'message_type', 'reply_to_request_id'];
      const messageType = body.message_type === undefined ? 'request' : body.message_type;
      if (Object.keys(body).some((key) => !allowed.includes(key))
        || typeof body.target_session_id !== 'string' || !body.target_session_id || body.target_session_id.length > 512
        || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 12_000
        || !['request', 'response'].includes(messageType)
        || (messageType === 'response' && (typeof body.reply_to_request_id !== 'string' || !body.reply_to_request_id))
        || (messageType === 'request' && body.reply_to_request_id !== undefined)) {
        return sendJson(response, 400, { error: 'Session message details are invalid' });
      }
      this._pruneReplies();
      if (messageType === 'response') {
        const pending = this.pendingReplies.get(body.reply_to_request_id);
        if (!pending || pending.direction !== 'incoming'
          || pending.sourceSessionId !== body.target_session_id
          || pending.targetSessionId !== sourceSessionId) {
          return sendJson(response, 409, { error: 'The response does not match an active session request' });
        }
        const source = this._sourceSession(sourceSessionId);
        if (!pending.reply({
          sourceSessionId: pending.replyTargetSessionId,
          targetSessionId: pending.remoteSourceSessionId,
          sourceName: source?.title || `${source?.agent || 'CAS Cloud'} session`,
          sourceAgent: source?.agent || source?.provider || 'agent',
          message: body.message.trim(),
          messageType: 'response',
          replyToRequestId: body.reply_to_request_id,
        })) return sendJson(response, 503, { error: 'The paired host is offline' });
        this.pendingReplies.delete(body.reply_to_request_id);
        return sendJson(response, 200, { success: true, status: 'delivered' });
      }
      let target;
      try { target = decodeRemoteSessionId(body.target_session_id); }
      catch (error) { return sendJson(response, 400, { error: error.message }); }
      if (!this._remoteClient(target.runtimeId)) return sendJson(response, 404, { error: 'The remote session is unavailable' });
      const source = this._sourceSession(sourceSessionId);
      const communicationRequestId = crypto.randomUUID();
      this._rememberReply(communicationRequestId, {
        direction: 'outgoing',
        sourceSessionId,
        targetSessionId: body.target_session_id,
      });
      try {
        const result = await this._remoteCommand('coordination.message', {
          sourceSessionId,
          targetSessionId: target.sessionId,
          sourceName: source?.title || `${source?.agent || 'CAS Cloud'} session`,
          sourceAgent: source?.agent || source?.provider || 'agent',
          message: body.message.trim(),
          communicationRequestId,
          replyTargetSessionId: body.target_session_id,
        }, target.runtimeId);
        return sendJson(response, 200, {
          success: true,
          status: result?.status === 'delivered' ? 'delivered' : 'queued',
          request_id: communicationRequestId,
        });
      } catch (_) {
        this.pendingReplies.delete(communicationRequestId);
        return sendJson(response, 503, { error: 'The paired Mac is offline' });
      }
    }

    if (request.method === 'GET' && url.pathname === '/session-communication/remote-projects') {
      try {
        const catalogs = this._remoteClients().map((client) => listRemoteProjects(client));
        if (!catalogs.length) throw new Error('No connected hosts');
        return sendJson(response, 200, {
          host: catalogs.length === 1 ? catalogs[0].host : `${catalogs.length} connected hosts`,
          agents: [...new Set(catalogs.flatMap((catalog) => catalog.agents))],
          projects: catalogs.flatMap((catalog) => catalog.projects),
          truncated: catalogs.some((catalog) => catalog.truncated),
        });
      } catch (_) {
        return sendJson(response, 503, { error: 'The paired Mac is offline' });
      }
    }

    if (request.method === 'POST' && url.pathname === '/session-communication/remote-projects/ask') {
      const body = await readJson(request);
      const allowed = ['project_id', 'agent', 'prompt', 'timeout_seconds'];
      const timeoutSeconds = body.timeout_seconds === undefined ? 300 : Number(body.timeout_seconds);
      if (Object.keys(body).some((key) => !allowed.includes(key))
        || typeof body.project_id !== 'string' || !body.project_id || body.project_id.length > 512
        || typeof body.agent !== 'string' || !body.agent || body.agent.length > 60
        || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12_000
        || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 900) {
        return sendJson(response, 400, { error: 'Remote session details are invalid' });
      }
      if (this.activeRemoteSessionStarts.has(sourceSessionId)) {
        return sendJson(response, 409, { error: 'This session already has a remote start in progress' });
      }
      this.activeRemoteSessionStarts.add(sourceSessionId);
      try {
        const target = parseRemoteResourceId('project', body.project_id);
        const client = this._remoteClient(target.runtimeId);
        if (!client) throw new Error('The paired host is offline');
        const result = await askRemoteProject(client, {
          projectId: body.project_id,
          agent: body.agent,
          prompt: body.prompt,
          timeoutMs: timeoutSeconds * 1000,
        });
        return sendJson(response, 200, result);
      } catch (error) {
        const offline = error?.message === 'Remote runtime is offline';
        return sendJson(response, offline ? 503 : 409, {
          error: offline ? 'The paired Mac is offline' : 'The paired Mac could not create the session',
        });
      } finally {
        this.activeRemoteSessionStarts.delete(sourceSessionId);
      }
    }
    return sendJson(response, 404, { error: 'Not found' });
  }
}

function requestHeadlessBridge(dataPath, method, pathname, body = null) {
  let control;
  try { control = readControlFile(dataPath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('CAS Cloud is not running');
    throw error;
  }
  const payload = body === null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: control.port,
      path: pathname,
      method,
      headers: {
        Authorization: `Bearer ${control.token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let result;
        try { result = text ? JSON.parse(text) : {}; }
        catch (_) { return reject(new Error('CAS Cloud returned invalid JSON')); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(result.error || `CAS Cloud returned HTTP ${response.statusCode}`));
        }
        resolve(result);
      });
    });
    request.on('timeout', () => request.destroy(new Error('CAS Cloud did not respond')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

module.exports = {
  HeadlessSessionBridge,
  controlPath,
  decodeRemoteSessionId,
  encodeRemoteSessionId,
  readControlFile,
  requestHeadlessBridge,
};
