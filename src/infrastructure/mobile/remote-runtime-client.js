const crypto = require('crypto');
const WebSocket = require('ws');
const {
  createKeyPair,
  decryptJson,
  encryptJson,
  verificationCode,
} = require('./mobile-crypto');

const PROTOCOL_VERSION = 2;
const SESSION_SUBSCRIPTIONS_FEATURE = 'session-subscriptions';
const MAX_PAIRING_INPUT_LENGTH = 8192;
const MAX_RUNTIME_MESSAGE_BYTES = 1024 * 1024;
const MAX_RESET_SNAPSHOT_BYTES = 256 * 1024;
const MAX_REMOTE_PROMPT_CHARS = 12_000;
const MAX_REMOTE_ANSWER_CHARS = 120_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RUNTIME_KINDS = new Set([
  'welcome',
  'session.opened',
  'session.event',
  'session.closed',
  'session.identity.updated',
  'projects.updated',
  'projects.operation.updated',
  'project.icon.generated',
  'tasks.changed',
  'provider.login.event',
  'provider.operation.updated',
  'quota.updated',
  'command.accepted',
  'command.result',
  'command.completed',
  'coordination.message',
  'cursor.advanced',
]);
const RELAY_KINDS = new Set([
  'pair.challenge',
  'pair.completed',
  'pair.rejected',
  'hello.accepted',
  'credential.renewed',
  'runtime.online',
  'runtime.offline',
  'runtime.message',
  'relay.error',
]);
const RELAY_ERROR_CODES = new Set([
  'hello_required',
  'invalid_backend_origin',
  'invalid_credential_renewal',
  'invalid_device_token',
  'invalid_json',
  'invalid_peer_message',
  'invalid_public_key',
  'invalid_relay_ticket',
  'invalid_runtime_message',
  'message_too_large',
  'mobile_token_expired',
  'pairing_expired',
  'rate_limited',
  'runtime_not_authorized',
  'runtime_reconnected',
  'unsupported_message',
  'unsupported_protocol',
]);
const CONNECTION_REF_PATTERN = /^[a-f0-9]{10}$/;
const COMMAND_TYPES = new Set([
  'session.create',
  'turn.send',
  'turn.interrupt',
  'session.stop',
  'session.models',
  'session.configure',
  'session.subscribe',
  'session.unsubscribe',
  'request.respond',
  'question.respond',
  'history.list',
  'coordination.sessions',
  'coordination.transcript',
  'coordination.message',
  'session.resume',
  'history.older',
  'projects.list',
  'project.directories.list',
  'project.update',
  'project.register',
  'project.clone',
  'project.clone.cancel',
  'project.unregister',
  'tasks.list',
  'task.create',
  'task.update',
  'task.delete',
  'tasks.mutate',
  'providers.list',
  'provider.install',
  'provider.login.describe',
  'provider.login.start',
  'provider.login.submit',
  'provider.login.cancel',
  'workspace.files.list',
  'workspace.files.read',
  'workspace.files.search',
  'workspace.git.status',
  'workspace.git.diff',
  'workspace.git.log',
  'workspace.git.branches',
  'workspace.git.switch',
  'workspace.git.create',
]);
const NON_REPLAYABLE_COMMANDS = new Set(['history.older', 'coordination.sessions', 'coordination.transcript', 'coordination.message', 'projects.list', 'project.directories.list', 'tasks.list',
  'providers.list', 'provider.login.describe', 'provider.login.start', 'provider.login.submit', 'provider.login.cancel',
  'workspace.files.list', 'workspace.files.read', 'workspace.files.search',
  'workspace.git.status', 'workspace.git.diff', 'workspace.git.log', 'workspace.git.branches']);
const FORBIDDEN_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'devicetoken',
  'pairingtoken',
  'secretkey',
  'privatekey',
  'relayticket',
  'authorization',
  'credential',
  'credentials',
  'ticket',
  'token',
]);
const PATH_KEYS = new Set([
  'cwd',
  'path',
  'paths',
  'projectpath',
  'rootpath',
  'worktreepath',
  'workingdirectory',
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeId(value, label, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function normalizedKey(key) {
  return key.replace(/[-_]/g, '').toLowerCase();
}

function assertPublicPayload(value, depth = 0) {
  if (depth > 40) throw new Error('Remote runtime payload is too deeply nested');
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error('Remote runtime payload is too large');
    for (const item of value) assertPublicPayload(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (FORBIDDEN_KEYS.has(normalized)) {
      throw new Error('Remote runtime payload contains a forbidden field');
    }
    assertPublicPayload(child, depth + 1);
  }
}

function stripPathFields(value, depth = 0, preserveRelativePaths = false) {
  if (depth > 40) throw new Error('Remote runtime payload is too deeply nested');
  if (Array.isArray(value)) return value.map((item) => stripPathFields(item, depth + 1, preserveRelativePaths));
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (PATH_KEYS.has(normalized) || normalized.endsWith('path')) {
      if (preserveRelativePaths && (child === null || isSafeRelativePath(child))) {
        clean[key] = typeof child === 'string' ? child.replace(/\\/g, '/') : null;
      }
      continue;
    }
    clean[key] = stripPathFields(child, depth + 1, preserveRelativePaths);
  }
  return clean;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) return false;
  if (/^(?:[A-Za-z]:[\\/]|[/\\]{1,2})/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  return segments.every((segment) => segment && segment !== '..');
}

function assertPathlessCommand(value, depth = 0, allowRelativePath = false) {
  if (depth > 40) throw new Error('Remote runtime command is too deeply nested');
  if (Array.isArray(value)) {
    for (const item of value) assertPathlessCommand(item, depth + 1, allowRelativePath);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (allowRelativePath && normalized === 'relativepath') {
      if (!isSafeRelativePath(child)) throw new Error('Remote runtime relative path is invalid');
      continue;
    }
    if (PATH_KEYS.has(normalized) || normalized.endsWith('path')) {
      throw new Error('Remote runtime commands cannot contain filesystem paths');
    }
    assertPathlessCommand(child, depth + 1, allowRelativePath);
  }
}

function secureOrigin(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash) {
    throw new Error(`Insecure ${label}`);
  }
  return url.origin;
}

function singleParam(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) throw new Error('Pairing URI is incomplete');
  return values[0];
}

function parsePairingInput(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > MAX_PAIRING_INPUT_LENGTH) throw new Error('Pairing URI is invalid');
  let inner = value;
  if (!value.startsWith('codeagentswarm://')) {
    let wrapper;
    try {
      wrapper = new URL(value);
    } catch {
      throw new Error('Pairing URI is invalid');
    }
    const local = wrapper.hostname === 'localhost' || wrapper.hostname === '127.0.0.1' || wrapper.hostname === '[::1]';
    if ((wrapper.protocol !== 'https:' && !(wrapper.protocol === 'http:' && local))
      || wrapper.username
      || wrapper.password
      || wrapper.hash
      || [...wrapper.searchParams.keys()].some((key) => key !== 'pairing')) {
      throw new Error('Pairing URI is insecure');
    }
    inner = singleParam(wrapper, 'pairing');
  }
  if (inner.length > 4096) throw new Error('Pairing URI is invalid');
  let pairing;
  try {
    pairing = new URL(inner);
  } catch {
    throw new Error('Pairing URI is invalid');
  }
  const allowed = new Set(['v', 'relay', 'backend', 'runtime', 'token', 'key']);
  if (pairing.protocol !== 'codeagentswarm:'
    || pairing.hostname !== 'pair'
    || (pairing.pathname !== '' && pairing.pathname !== '/')
    || pairing.hash
    || [...pairing.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw new Error('Pairing URI is not a CodeAgentSwarm v2 URI');
  }
  const version = singleParam(pairing, 'v');
  const runtimeId = singleParam(pairing, 'runtime');
  const pairingToken = singleParam(pairing, 'token');
  const runtimePublicKey = singleParam(pairing, 'key');
  if (version !== '2' || !ID_PATTERN.test(runtimeId) || !TOKEN_PATTERN.test(pairingToken) || !KEY_PATTERN.test(runtimePublicKey)) {
    throw new Error('Pairing URI is incomplete');
  }
  return {
    relayOrigin: secureOrigin(singleParam(pairing, 'relay'), 'relay origin'),
    backendOrigin: secureOrigin(singleParam(pairing, 'backend'), 'backend origin'),
    runtimeId,
    pairingToken,
    runtimePublicKey,
  };
}

function relayWebSocketUrl(relayOrigin, runtimeId) {
  const url = new URL(secureOrigin(relayOrigin, 'relay origin'));
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/mobile/ws';
  url.searchParams.set('runtime', safeId(runtimeId, 'runtime id', 128));
  return url.toString();
}

function remoteSessionRef(runtimeId, sessionId) {
  const safeRuntimeId = safeId(runtimeId, 'runtime id', 128);
  const safeSessionId = safeId(sessionId, 'session id');
  return {
    runtimeId: safeRuntimeId,
    sessionId: safeSessionId,
    key: `${safeRuntimeId.length}:${safeRuntimeId}${safeSessionId}`,
  };
}

function remoteResourceId(kind, runtimeId, resourceId) {
  if (!['project', 'session'].includes(kind)) throw new Error('Remote resource type is invalid');
  const runtime = safeId(runtimeId, 'runtime id', 128);
  const resource = safeId(resourceId, `${kind} id`, 128);
  return `remote-${kind}.${Buffer.from(JSON.stringify([runtime, resource])).toString('base64url')}`;
}

function parseRemoteResourceId(kind, value) {
  const prefix = `remote-${kind}.`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 512) {
    throw new Error(`The remote ${kind} id is invalid`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    return {
      runtimeId: safeId(parsed[0], 'runtime id', 128),
      resourceId: safeId(parsed[1], `${kind} id`, 128),
    };
  } catch (_) {
    throw new Error(`The remote ${kind} id is invalid`);
  }
}

function publicLabel(value, fallback, max = 200) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  if (!clean || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(clean)) return fallback;
  return clean;
}

function listRemoteProjects(client) {
  if (!client || typeof client.getState !== 'function') throw new Error('Remote runtime is unavailable');
  const state = client.getState();
  if (state.phase !== 'online' || !ID_PATTERN.test(state.runtime?.id || '') || !state.snapshot) {
    throw new Error('Remote runtime is offline');
  }
  const agents = [...new Set((Array.isArray(state.snapshot.availableAgents)
    ? state.snapshot.availableAgents
    : []).filter((agent) => typeof agent === 'string' && ID_PATTERN.test(agent)))];
  const seen = new Set();
  const projects = (Array.isArray(state.snapshot.projects) ? state.snapshot.projects : []).flatMap((project) => {
    const projectId = typeof project?.projectId === 'string' && ID_PATTERN.test(project.projectId)
      ? project.projectId
      : null;
    if (!projectId || seen.has(projectId)) return [];
    seen.add(projectId);
    return [{
      id: remoteResourceId('project', state.runtime.id, projectId),
      name: publicLabel(project.name, 'Remote project'),
    }];
  });
  return {
    host: publicLabel(state.runtime.name, 'Paired host', 100),
    agents,
    projects,
    truncated: state.snapshot.projectsTruncated === true,
  };
}

async function askRemoteProject(client, {
  projectId,
  agent,
  prompt,
  timeoutMs = 300_000,
} = {}) {
  const state = client?.getState?.();
  const reference = parseRemoteResourceId('project', projectId);
  const catalog = listRemoteProjects(client);
  if (reference.runtimeId !== state.runtime.id || !catalog.projects.some((project) => project.id === projectId)) {
    throw new Error('Choose a project from the paired host');
  }
  if (!catalog.agents.includes(agent)) throw new Error('Choose an agent installed on the paired host');
  const message = typeof prompt === 'string' ? prompt.trim() : '';
  if (!message || message.length > MAX_REMOTE_PROMPT_CHARS) {
    throw new Error(`Remote prompt must contain between 1 and ${MAX_REMOTE_PROMPT_CHARS} characters`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error('Remote response timeout must be between 1 and 900 seconds');
  }
  if (typeof client.subscribeEnvelopes !== 'function' || typeof client.sendCommand !== 'function') {
    throw new Error('Remote runtime is unavailable');
  }

  const requestId = client.randomUUID();
  let sessionId = null;
  let settled = false;
  let answerChars = 0;
  let answerTruncated = false;
  const answerOrder = [];
  const answers = new Map();
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const settle = (turnState, detail = {}) => {
    if (settled) return;
    settled = true;
    resolveCompletion({ state: turnState, ...detail });
  };
  const appendAnswer = (key, text) => {
    if (typeof text !== 'string' || !text) return;
    if (!answers.has(key)) {
      answers.set(key, '');
      answerOrder.push(key);
    }
    const room = MAX_REMOTE_ANSWER_CHARS - answerChars;
    if (room <= 0) {
      answerTruncated = true;
      return;
    }
    const piece = text.slice(0, room);
    answers.set(key, answers.get(key) + piece);
    answerChars += piece.length;
    if (piece.length < text.length) answerTruncated = true;
  };
  const onEnvelope = (envelope) => {
    if (envelope?.kind === 'session.opened'
      && envelope.session?.clientRequestId === requestId
      && ID_PATTERN.test(envelope.session?.sessionId || '')) {
      sessionId = envelope.session.sessionId;
    }
    if (!sessionId || envelope?.sessionId !== sessionId) return;
    if (envelope.kind === 'session.closed') return settle('stopped');
    if (envelope.kind !== 'session.event' || !envelope.event) return;
    const event = envelope.event;
    const key = typeof event.itemId === 'string' && event.itemId
      ? event.itemId
      : `turn:${event.turnId || 'current'}`;
    if (event.type === 'content.delta' && event.payload?.streamKind === 'assistant_text') {
      appendAnswer(key, event.payload.delta);
    } else if (event.type === 'item.completed' && event.payload?.itemType === 'assistant_message') {
      const fullText = event.payload?.data?.text;
      const current = answers.get(key) || '';
      if (typeof fullText === 'string' && fullText.startsWith(current)) appendAnswer(key, fullText.slice(current.length));
    } else if (event.type === 'question.opened' || event.type === 'request.opened') {
      settle('needs_input');
    } else if (event.type === 'turn.completed') {
      const turnState = event.payload?.state === 'failed'
        ? 'failed'
        : ['interrupted', 'cancelled'].includes(event.payload?.state) ? 'interrupted' : 'completed';
      settle(turnState);
    }
  };
  const unsubscribe = client.subscribeEnvelopes(onEnvelope);
  const timer = setTimeout(() => settle('working'), timeoutMs);
  try {
    const created = await client.sendCommand({
      type: 'session.create',
      runtimeId: state.runtime.id,
      payload: {
        agent,
        projectId: reference.resourceId,
        initialPrompt: message,
        clientRequestId: requestId,
      },
    }, requestId);
    if (!ID_PATTERN.test(created?.sessionId || '')) throw new Error('The paired host did not create a session');
    sessionId = created.sessionId;
    const outcome = await completion;
    const answer = answerOrder.map((key) => answers.get(key).trim()).filter(Boolean).join('\n\n');
    return {
      session_id: remoteResourceId('session', state.runtime.id, sessionId),
      host: catalog.host,
      project: catalog.projects.find((project) => project.id === projectId).name,
      agent,
      ...outcome,
      answer: answer.slice(0, MAX_REMOTE_ANSWER_CHARS),
      answer_truncated: answerTruncated || answer.length > MAX_REMOTE_ANSWER_CHARS,
    };
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

class RemoteRuntimeClient {
  constructor({
    store,
    WebSocketImpl = WebSocket,
    fetchImpl = global.fetch,
    randomUUID = crypto.randomUUID,
    now = Date.now,
    deviceName = 'CodeAgentSwarm Desktop',
    diagnostic = () => {},
    timeouts = {},
  } = {}) {
    if (!store) throw new Error('Remote runtime store is required');
    if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is required');
    this.store = store;
    this.WebSocketImpl = WebSocketImpl;
    this.fetch = fetchImpl;
    this.randomUUID = randomUUID;
    this.now = now;
    this.deviceName = deviceName;
    this.reportDiagnostic = diagnostic;
    this.timeouts = {
      open: timeouts.open ?? 12_000,
      heartbeat: timeouts.heartbeat ?? 15_000,
      pong: timeouts.pong ?? 5_000,
      commandAck: timeouts.commandAck ?? 3_000,
      command: timeouts.command ?? 45_000,
      refreshLead: timeouts.refreshLead ?? 2 * 60_000,
      refreshRetry: timeouts.refreshRetry ?? 8_000,
      renew: timeouts.renew ?? 5_000,
      reconnectBase: timeouts.reconnectBase ?? 400,
      reconnectMax: timeouts.reconnectMax ?? 8_000,
    };
    this.state = {
      phase: 'stopped',
      device: null,
      runtime: null,
      challenge: null,
      cursor: null,
      snapshot: null,
      lastEnvelope: null,
      error: null,
    };
    this.listeners = new Set();
    this.envelopeListeners = new Set();
    this.enabled = false;
    this.socket = null;
    this.connecting = false;
    this.runtimeOnline = false;
    this.identity = null;
    this.connection = null;
    this.pairing = null;
    this.pairingKeys = null;
    this.pendingCommands = new Map();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.openTimer = null;
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.refreshTimer = null;
    this.renewTimer = null;
    this.refreshPromise = null;
    this.connectTrace = null;
    this.lastSocketError = null;
    this.subscriptions = new Set();
    this.subscriptionsSupported = false;
    this.resyncPending = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  subscribeEnvelopes(listener) {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }

  getState() {
    return clone(this.state);
  }

  async start() {
    if (this.enabled) return this.getState();
    this.enabled = true;
    const saved = await this.store.loadOrCreate(this.deviceName);
    if (!this.enabled) return this.getState();
    this.identity = saved.device;
    this.connection = saved.connection;
    this._diagnostic('remote.client_started', { savedConnection: Boolean(this.connection) });
    this._setState({
      ...this.state,
      phase: this.connection ? 'connecting' : 'unpaired',
      device: clone(this.identity),
      runtime: this._publicRuntime(),
      error: null,
    });
    if (this.connection) void this._connect();
    return this.getState();
  }

  stop() {
    this.enabled = false;
    this.pairing = null;
    this.pairingKeys = null;
    this._clearTimers();
    this._closeSocket();
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.reject(new Error('Remote runtime connection closed'));
    }
    this.pendingCommands.clear();
    this._diagnostic('remote.client_stopped');
    this._setState({ ...this.state, phase: 'stopped', challenge: null });
  }

  async pair(raw) {
    if (!this.enabled || !this.identity) throw new Error('Remote runtime client has not started');
    const pairing = parsePairingInput(raw);
    if (this.connection && pairing.runtimeId !== this.connection.runtimeId) {
      throw new Error('Replacing a saved remote runtime is not supported yet');
    }
    const keys = createKeyPair();
    this.pairing = pairing;
    this.pairingKeys = keys;
    this.runtimeOnline = false;
    this._diagnostic('remote.pair_started');
    this._closeSocket();
    this._setState({
      ...this.state,
      phase: 'connecting',
      challenge: null,
      error: null,
    });
    await this._connect();
  }

  cancelPairing() {
    if (!this.pairing) return;
    this.pairing = null;
    this.pairingKeys = null;
    this._closeSocket();
    this._setState({
      ...this.state,
      phase: this.connection ? 'offline' : 'unpaired',
      challenge: null,
      error: null,
    });
    if (this.connection && this.enabled) this._scheduleReconnect();
  }

  async disconnect() {
    if (!this.connection) {
      this.cancelPairing();
      return this.getState();
    }
    const connection = this.connection;
    let response;
    try {
      response = await this.fetch(`${connection.backendOrigin}/api/mobile/device`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${connection.refreshToken}` },
      });
    } catch {
      throw new Error('Remote runtime could not be disconnected');
    }
    if (!response.ok) throw new Error('Remote runtime could not be disconnected');
    await this.store.clearConnection(connection.refreshToken);
    if (this.connection !== connection) return this.getState();
    this.connection = null;
    this.pairing = null;
    this.pairingKeys = null;
    this.runtimeOnline = false;
    this._clearTimers();
    this._closeSocket();
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.reject(new Error('Remote runtime was disconnected'));
    }
    this.pendingCommands.clear();
    this._setState({
      phase: 'unpaired',
      device: clone(this.identity),
      runtime: null,
      challenge: null,
      cursor: null,
      snapshot: null,
      lastEnvelope: null,
      error: null,
    });
    return this.getState();
  }

  sendCommand(command, commandId = this.randomUUID()) {
    if (this.state.phase !== 'online' || !this.connection) {
      return Promise.reject(new Error('Remote runtime is offline'));
    }
    let wireCommand;
    try {
      wireCommand = this._validateCommand(command);
      if (!COMMAND_ID_PATTERN.test(commandId)) throw new Error('Invalid command id');
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = this.pendingCommands.get(commandId);
    if (existing) return existing.promise;
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const pending = {
      commandId,
      message: { kind: 'command', commandId, command: wireCommand },
      promise,
      resolve,
      reject,
      attempts: 0,
      startedAt: this.now(),
      acknowledgedAt: null,
      acknowledged: false,
      ackTimer: null,
      timer: setTimeout(() => {
        this.pendingCommands.delete(commandId);
        this._diagnostic('remote.command_timeout', {
          type: wireCommand.type,
          attempts: pending.attempts,
          totalMs: this.now() - pending.startedAt,
        });
        reject(new Error('Remote runtime command timed out'));
      }, this.timeouts.command),
    };
    this.pendingCommands.set(commandId, pending);
    if (!this._sendPendingCommand(pending)) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(commandId);
      reject(new Error('Remote runtime is offline'));
    }
    return promise;
  }

  async subscribeSession(sessionId) {
    if (!this.connection) return null;
    const { sessionId: safeSessionId } = remoteSessionRef(this.connection.runtimeId, sessionId);
    this.subscriptions.add(safeSessionId);
    if (this.state.phase !== 'online' || !this.subscriptionsSupported) return null;
    const result = await this.sendCommand({
      type: 'session.subscribe',
      runtimeId: this.connection.runtimeId,
      sessionId: safeSessionId,
    });
    return clone(result?.session || null);
  }

  async unsubscribeSession(sessionId) {
    if (!this.connection) return;
    const { sessionId: safeSessionId } = remoteSessionRef(this.connection.runtimeId, sessionId);
    this.subscriptions.delete(safeSessionId);
    if (this.state.phase !== 'online' || !this.subscriptionsSupported) return;
    await this.sendCommand({
      type: 'session.unsubscribe',
      runtimeId: this.connection.runtimeId,
      sessionId: safeSessionId,
    });
  }

  reconnectNow() {
    if (!this.enabled || (!this.connection && !this.pairing)) return;
    this._closeSocket();
    void this._connect();
  }

  _validateCommand(command) {
    if (!command || typeof command !== 'object' || !COMMAND_TYPES.has(command.type)) {
      throw new Error('Remote runtime command is not allowed');
    }
    if (command.runtimeId !== this.connection.runtimeId) throw new Error('Remote runtime identity does not match');
    const wire = { type: command.type };
    if (command.sessionId !== undefined) {
      const reference = remoteSessionRef(command.runtimeId, command.sessionId);
      wire.sessionId = reference.sessionId;
    }
    if (command.payload !== undefined) {
      assertPublicPayload(command.payload);
      assertPathlessCommand(command.payload, 0, command.type === 'project.directories.list' || command.type === 'project.register' || command.type === 'project.clone'
        || command.type.startsWith('workspace.files.'));
      wire.payload = clone(command.payload);
    }
    return wire;
  }

  async _connect() {
    if (!this.enabled || this.socket || this.connecting || (!this.connection && !this.pairing)) return;
    this.connecting = true;
    const mode = this.pairing ? 'pairing' : 'runtime';
    const attempt = this.reconnectAttempt;
    this.connectTrace = { startedAt: this.now(), openedAt: null, authenticatedAt: null, mode, attempt };
    this.lastSocketError = null;
    this._diagnostic('remote.relay_connecting', { mode, attempt });
    if (!this.pairing && this.connection.accessExpiresAt <= this.now()) {
      const refreshed = await this._refreshAccess();
      if (!refreshed) {
        this.connecting = false;
        return;
      }
    }
    const target = this.pairing || this.connection;
    if (!this.enabled || !target) {
      this.connecting = false;
      return;
    }
    let socket;
    try {
      socket = new this.WebSocketImpl(relayWebSocketUrl(target.relayOrigin, target.runtimeId));
    } catch (error) {
      this.connecting = false;
      this._diagnostic('remote.connect_failed', {
        phase: 'socket',
        code: typeof error?.code === 'string' ? error.code.slice(0, 40) : undefined,
        totalMs: this.now() - this.connectTrace.startedAt,
      });
      this._setState({ ...this.state, phase: 'offline' });
      if (this.connection) this._scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connecting = false;
    this._bind(socket, 'open', () => this._handleOpen(socket));
    this._bind(socket, 'message', (raw) => void this._handleRelayMessage(socket, raw?.data ?? raw));
    this._bind(socket, 'close', (code) => this._handleClose(socket, code));
    this._bind(socket, 'error', (error) => {
      this.lastSocketError = typeof error?.code === 'string' ? error.code.slice(0, 40) : null;
      this._diagnostic('remote.socket_error', { code: this.lastSocketError || undefined });
    });
    this.openTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this._diagnostic('remote.connect_failed', {
        phase: 'socket', reason: 'timeout', totalMs: this.connectTrace ? this.now() - this.connectTrace.startedAt : undefined,
      });
      this._handleClose(socket);
      try { socket.close(); } catch {}
    }, this.timeouts.open);
  }

  _bind(socket, event, listener) {
    if (typeof socket.on === 'function') socket.on(event, listener);
    else socket[`on${event}`] = listener;
  }

  _handleOpen(socket) {
    if (this.socket !== socket) return;
    if (this.connectTrace) this.connectTrace.openedAt = this.now();
    this._diagnostic('remote.relay_opened', {
      mode: this.pairing ? 'pairing' : 'runtime',
      socketMs: this.connectTrace ? this.now() - this.connectTrace.startedAt : undefined,
    });
    if (this.pairing) {
      this._sendRelay({
        kind: 'hello.pair',
        protocolVersion: PROTOCOL_VERSION,
        pairingToken: this.pairing.pairingToken,
        device: {
          id: this.identity.id,
          name: this.identity.name,
          publicKey: this.pairingKeys.publicKey,
        },
      });
      return;
    }
    this._sendRelay({
      kind: 'hello.mobile',
      protocolVersion: PROTOCOL_VERSION,
      ticket: this.connection.deviceToken,
    });
  }

  async _handleRelayMessage(socket, raw) {
    if (this.socket !== socket) return;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (text === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return this._protocolFailure(socket);
    }
    if (!message || typeof message !== 'object' || !RELAY_KINDS.has(message.kind)) {
      return this._protocolFailure(socket);
    }
    if (message.kind !== 'relay.error' && message.kind !== 'pair.rejected') {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this._startHeartbeat(socket);
    }
    if (message.kind === 'pair.challenge') return this._handlePairChallenge(message);
    if (message.kind === 'pair.completed') return this._handlePairCompleted(socket, message);
    if (message.kind === 'hello.accepted') {
      if (this.connectTrace) this.connectTrace.authenticatedAt = this.now();
      this._diagnostic('remote.relay_authenticated', {
        mode: this.pairing ? 'pairing' : 'runtime',
        totalMs: this.connectTrace ? this.now() - this.connectTrace.startedAt : undefined,
        connection: CONNECTION_REF_PATTERN.test(message.connection || '') ? message.connection : undefined,
      });
      this._scheduleRefresh();
      return;
    }
    if (message.kind === 'credential.renewed') {
      if (!this.connection || Number(message.accessExpiresAt) !== this.connection.accessExpiresAt) {
        return this._protocolFailure(socket);
      }
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.renewTimer = null;
      this._diagnostic('remote.credential_renewed');
      this._scheduleRefresh();
      return;
    }
    if (message.kind === 'runtime.online') {
      this.runtimeOnline = true;
      this._diagnostic('remote.runtime_online', {
        totalMs: this.connectTrace ? this.now() - this.connectTrace.startedAt : undefined,
      });
      if (this.connection) this._sendRuntimeHello();
      return;
    }
    if (message.kind === 'runtime.offline') {
      this.runtimeOnline = false;
      this.resyncPending = false;
      this.subscriptionsSupported = false;
      this._diagnostic('remote.runtime_offline');
      this._setState({ ...this.state, phase: 'offline', error: null });
      return;
    }
    if (message.kind === 'runtime.message') {
      if (!this.connection) return this._protocolFailure(socket);
      let envelope;
      try {
        envelope = decryptJson(message.box, this.connection.secretKey, this.connection.runtimePublicKey, message.codec);
      } catch {
        this._diagnostic('remote.message_rejected', { reason: 'decrypt_failed' });
        return this._protocolFailure(socket);
      }
      if (envelope?.kind === 'welcome') {
        this._diagnostic('remote.welcome_decrypted', {
          bytes: Buffer.byteLength(JSON.stringify(message.box)),
        });
      }
      return this._handleRuntimeEnvelope(envelope);
    }
    if (message.kind === 'relay.error' || message.kind === 'pair.rejected') {
      this._diagnostic('remote.relay_rejected', {
        code: RELAY_ERROR_CODES.has(message.code)
          ? message.code
          : message.kind === 'pair.rejected' ? 'pair_rejected' : 'unknown',
      });
      const renewFallback = this.connection
        && this.renewTimer
        && (message.code === 'unsupported_message' || message.code === 'invalid_credential_renewal');
      if (renewFallback) {
        clearTimeout(this.renewTimer);
        this.renewTimer = null;
        this.reconnectNow();
        return;
      }
      this._fail(this.pairing ? 'Remote runtime rejected pairing' : 'Relay rejected the connection');
    }
  }

  _handlePairChallenge(message) {
    if (!this.pairing || !this.pairingKeys || !ID_PATTERN.test(message.pairingId || '')) {
      return this._protocolFailure(this.socket);
    }
    if (message.desktopPublicKey !== this.pairing.runtimePublicKey) return this._protocolFailure(this.socket);
    const expiresAt = Number(message.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) return this._protocolFailure(this.socket);
    this._diagnostic('remote.pair_challenge_received', { expiresInMs: expiresAt - this.now() });
    this._setState({
      ...this.state,
      phase: 'confirming',
      challenge: {
        code: verificationCode(this.pairingKeys.secretKey, this.pairing.runtimePublicKey, message.pairingId),
        expiresAt,
      },
      error: null,
    });
  }

  async _handlePairCompleted(socket, message) {
    const pairing = this.pairing;
    const keys = this.pairingKeys;
    if (!pairing || !keys || this.socket !== socket) return this._protocolFailure(socket);
    let refreshToken;
    try {
      refreshToken = decryptJson(message.refreshTokenBox, keys.secretKey, pairing.runtimePublicKey)?.refreshToken;
    } catch {
      return this._protocolFailure(socket);
    }
    const accessExpiresAt = Number(message.accessExpiresAt);
    if (message.runtimeId !== pairing.runtimeId
      || typeof message.deviceToken !== 'string'
      || !message.deviceToken
      || message.deviceToken.length > 8192
      || !KEY_PATTERN.test(refreshToken || '')
      || !Number.isSafeInteger(accessExpiresAt)
      || accessExpiresAt <= this.now()) {
      return this._protocolFailure(socket);
    }
    const connection = {
      relayOrigin: pairing.relayOrigin,
      backendOrigin: pairing.backendOrigin,
      runtimeId: pairing.runtimeId,
      deviceToken: message.deviceToken,
      refreshToken,
      accessExpiresAt,
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      runtimePublicKey: pairing.runtimePublicKey,
    };
    try {
      await this.store.setConnection(connection);
    } catch {
      return this._fail('Pairing could not be saved');
    }
    if (!this.enabled || this.socket !== socket || this.pairing !== pairing) return;
    this.connection = connection;
    this.pairing = null;
    this.pairingKeys = null;
    this._diagnostic('remote.pair_completed', {
      totalMs: this.connectTrace ? this.now() - this.connectTrace.startedAt : undefined,
    });
    this._setState({
      phase: 'syncing',
      device: clone(this.identity),
      runtime: this._publicRuntime(),
      challenge: null,
      cursor: null,
      snapshot: null,
      lastEnvelope: null,
      error: null,
    });
    this._scheduleRefresh();
    if (this.runtimeOnline) this._sendRuntimeHello();
  }

  _handleRuntimeEnvelope(envelope) {
    let safe;
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(envelope));
      if (!envelope || typeof envelope !== 'object' || bytes > MAX_RUNTIME_MESSAGE_BYTES) {
        throw new Error('Invalid runtime envelope');
      }
      assertPublicPayload(envelope);
      if (envelope.kind === 'welcome' && envelope.reset === true) {
        if (!envelope.snapshot || typeof envelope.snapshot !== 'object' || Buffer.byteLength(JSON.stringify(envelope.snapshot)) > MAX_RESET_SNAPSHOT_BYTES) {
          throw new Error('Invalid runtime snapshot');
        }
      }
      const commandType = envelope.kind === 'command.result'
        ? this.pendingCommands.get(envelope.commandId)?.message?.command?.type
        : null;
      safe = stripPathFields(envelope, 0, commandType === 'project.directories.list');
    } catch {
      const kind = typeof envelope?.kind === 'string' && /^[a-z][a-z0-9.]{0,63}$/.test(envelope.kind)
        ? envelope.kind
        : undefined;
      this._diagnostic('remote.runtime_rejected', { reason: 'invalid_envelope', kind });
      return this._protocolFailure(this.socket);
    }
    if (safe.kind === 'command.accepted') {
      this._acceptCommand(safe);
      return;
    }
    if (safe.kind === 'command.result') {
      this._resolveCommand(safe);
      return;
    }
    if (safe.kind === 'coordination.message') {
      this._emitEnvelope(safe);
      return;
    }
    if (safe.kind === 'welcome') {
      const eventRuntimeId = safe.runtimeId;
      const latestSeq = Number(safe.latestSeq);
      if (!ID_PATTERN.test(eventRuntimeId || '') || !Number.isSafeInteger(latestSeq) || latestSeq < 0) {
        this._diagnostic('remote.runtime_rejected', { reason: 'invalid_welcome' });
        return this._protocolFailure(this.socket);
      }
      this.resyncPending = false;
      this.subscriptionsSupported = Array.isArray(safe.features)
        && safe.features.includes(SESSION_SUBSCRIPTIONS_FEATURE);
      if (safe.reset === true) {
        this._setState({
          ...this.state,
          phase: 'online',
          runtime: {
            ...this._publicRuntime(),
            name: typeof safe.snapshot.computerName === 'string' ? safe.snapshot.computerName.slice(0, 100) : null,
          },
          cursor: { runtimeId: eventRuntimeId, seq: latestSeq },
          snapshot: safe.snapshot,
          lastEnvelope: safe,
          error: null,
        });
      } else {
        const cursor = this.state.cursor;
        if (!cursor || cursor.runtimeId !== eventRuntimeId || latestSeq < cursor.seq) {
          this._diagnostic('remote.runtime_resync', { reason: 'welcome_cursor_mismatch' });
          this._requestRuntimeResync();
          return;
        }
        this._setState({ ...this.state, phase: 'online', lastEnvelope: safe, error: null });
      }
      this.reconnectAttempt = 0;
      this._diagnostic('remote.runtime_synced', {
        totalMs: this.connectTrace ? this.now() - this.connectTrace.startedAt : undefined,
        reset: safe.reset === true,
        bytes,
        sessions: Array.isArray(safe.snapshot?.sessions) ? safe.snapshot.sessions.length : undefined,
        projects: Array.isArray(safe.snapshot?.projects) ? safe.snapshot.projects.length : undefined,
      });
      this.connectTrace = null;
      this._emitEnvelope(safe);
      for (const pending of this.pendingCommands.values()) {
        if (pending.attempts > 0 && NON_REPLAYABLE_COMMANDS.has(pending.message.command.type)) {
          this._rejectCommand(pending, 'Remote read was interrupted by reconnect');
        } else {
          this._sendPendingCommand(pending);
        }
      }
      return;
    }
    const seq = Number(safe.seq);
    const cursor = this.state.cursor;
    const advancesCursor = safe.kind === 'cursor.advanced';
    if (!cursor
      || safe.runtimeId !== cursor.runtimeId
      || !Number.isSafeInteger(seq)
      || seq <= 0
      || (!advancesCursor && seq > cursor.seq + 1)) {
      this._diagnostic('remote.runtime_resync', {
        reason: !cursor ? 'missing_cursor'
          : safe.runtimeId !== cursor.runtimeId ? 'runtime_changed'
            : !Number.isSafeInteger(seq) || seq <= 0 ? 'invalid_sequence' : 'sequence_gap',
        expectedSeq: cursor ? cursor.seq + 1 : undefined,
        receivedSeq: Number.isSafeInteger(seq) ? seq : undefined,
      });
      this._requestRuntimeResync();
      return;
    }
    if (seq <= cursor.seq) return;
    if (!RUNTIME_KINDS.has(safe.kind)) {
      this._diagnostic('remote.runtime_ignored', { kind: safe.kind, seq });
      this._setState({
        ...this.state,
        cursor: { runtimeId: cursor.runtimeId, seq },
        error: null,
      });
      return;
    }
    this._setState({
      ...this.state,
      cursor: { runtimeId: cursor.runtimeId, seq },
      lastEnvelope: safe,
      error: null,
    });
    this._emitEnvelope(safe);
    if (safe.kind === 'command.completed') this._resolveCommand(safe);
  }

  _emitEnvelope(envelope) {
    const state = this.getState();
    for (const listener of this.envelopeListeners) listener(clone(envelope), state);
  }

  _sendRuntimeHello(withCursor = true) {
    const cursor = withCursor ? this.state.cursor : null;
    this._setState({ ...this.state, phase: 'syncing' });
    const sent = this._sendRuntime({
      kind: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      accepts: ['deflate'],
      features: [SESSION_SUBSCRIPTIONS_FEATURE],
      subscriptions: [...this.subscriptions],
      ...(cursor ? { cursor } : {}),
    });
    this._diagnostic(sent ? 'remote.hello_sent' : 'remote.hello_send_failed', {
      cursor: Boolean(cursor),
    });
  }

  _requestRuntimeResync() {
    if (this.resyncPending) return;
    this.resyncPending = true;
    this._sendRuntimeHello(false);
  }

  _sendRuntime(payload) {
    if (!this.connection) return false;
    return this._sendRelay({
      kind: 'runtime.message',
      box: encryptJson(payload, this.connection.secretKey, this.connection.runtimePublicKey),
    });
  }

  _sendRelay(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  _sendPendingCommand(pending) {
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (!this._sendRuntime(pending.message)) return false;
    pending.attempts += 1;
    pending.acknowledged = false;
    this._diagnostic('remote.command_sent', {
      type: pending.message.command.type,
      attempt: pending.attempts,
    });
    if (!NON_REPLAYABLE_COMMANDS.has(pending.message.command.type)) {
      pending.ackTimer = setTimeout(() => {
        pending.ackTimer = null;
        if (this.pendingCommands.get(pending.commandId) === pending && !pending.acknowledged) {
          this._diagnostic('remote.command_ack_timeout', {
            type: pending.message.command.type,
            attempts: pending.attempts,
            totalMs: this.now() - pending.startedAt,
          });
          this.reconnectNow();
        }
      }, this.timeouts.commandAck);
    }
    return true;
  }

  _acceptCommand(message) {
    const pending = this.pendingCommands.get(message.commandId);
    if (!pending) return;
    pending.acknowledged = true;
    pending.acknowledgedAt ||= this.now();
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    pending.ackTimer = null;
    this._diagnostic('remote.command_accepted', {
      type: pending.message.command.type,
      ackMs: pending.acknowledgedAt - pending.startedAt,
      attempts: pending.attempts,
    });
  }

  _resolveCommand(message) {
    const pending = this.pendingCommands.get(message.commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    this.pendingCommands.delete(message.commandId);
    this._diagnostic('remote.command_completed', {
      type: pending.message.command.type,
      success: message.success === true,
      totalMs: this.now() - pending.startedAt,
      ackMs: pending.acknowledgedAt ? pending.acknowledgedAt - pending.startedAt : undefined,
      attempts: pending.attempts,
    });
    if (message.success === true) pending.resolve(clone(message.result));
    else {
      const error = new Error('Remote runtime command failed');
      if (/^[a-z0-9_]{1,64}$/.test(message.error?.code || '')) error.code = message.error.code;
      if (message.error?.retryable === true) error.retryable = true;
      if (ID_PATTERN.test(message.error?.operationId || '')) error.operationId = message.error.operationId;
      pending.reject(error);
    }
  }

  _rejectCommand(pending, message) {
    clearTimeout(pending.timer);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    this.pendingCommands.delete(pending.commandId);
    pending.reject(new Error(message));
  }

  _handleClose(socket, closeCode) {
    if (this.socket !== socket) return;
    const previousPhase = this.state.phase;
    const trace = this.connectTrace;
    this._closeSocket(false);
    this.runtimeOnline = false;
    this._diagnostic('remote.relay_closed', {
      phase: previousPhase,
      totalMs: trace ? this.now() - trace.startedAt : undefined,
      code: Number.isInteger(closeCode) ? closeCode : undefined,
      socketCode: this.lastSocketError || undefined,
    });
    this.connectTrace = null;
    this.lastSocketError = null;
    if (!this.enabled) return;
    if (this.pairing) {
      this.pairing = null;
      this.pairingKeys = null;
      this._setState({ ...this.state, phase: this.connection ? 'offline' : 'unpaired', challenge: null, error: 'Pairing connection closed' });
    } else {
      this._setState({ ...this.state, phase: 'offline' });
    }
    if (this.connection) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.enabled || !this.connection || this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempt;
    const delay = attempt === 1
      ? 0
      : Math.min(this.timeouts.reconnectMax, this.timeouts.reconnectBase * (2 ** (attempt - 2)));
    this._diagnostic('remote.reconnect_scheduled', { attempt, delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._connect();
    }, delay);
  }

  _startHeartbeat(socket) {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== 1 || this.pongTimer) return;
      try {
        socket.send('ping');
      } catch {
        return this._handleClose(socket);
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.socket === socket) {
          this._diagnostic('remote.heartbeat_timeout');
          this._handleClose(socket);
          try { socket.close(); } catch {}
        }
      }, this.timeouts.pong);
    }, this.timeouts.heartbeat);
  }

  _scheduleRefresh(delayOverride) {
    if (!this.connection) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = delayOverride ?? Math.max(0, this.connection.accessExpiresAt - this.now() - this.timeouts.refreshLead);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this._refreshAccess();
    }, delay);
  }

  _refreshAccess() {
    if (!this.refreshPromise) {
      this.refreshPromise = this._performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async _performRefresh() {
    const saved = await this.store.get();
    const connection = saved?.connection;
    if (!this.enabled || !connection) return false;
    this.connection = connection;
    this._diagnostic('remote.credential_refresh_started');
    try {
      const response = await this.fetch(`${connection.backendOrigin}/api/mobile/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: connection.refreshToken }),
      });
      if (response.status === 401) {
        const latest = await this.store.get();
        if (latest?.connection?.refreshToken !== connection.refreshToken) {
          this.connection = latest.connection;
          return true;
        }
        await this.store.clearConnection(connection.refreshToken);
        this.connection = null;
        this._closeSocket();
        this._diagnostic('remote.credential_revoked');
        this._setState({ ...this.state, phase: 'unpaired', runtime: null, cursor: null, snapshot: null, error: 'Remote runtime authorization was revoked' });
        return false;
      }
      if (!response.ok) throw new Error('Refresh failed');
      const body = await response.json();
      const refreshed = {
        ...connection,
        deviceToken: body.deviceToken,
        refreshToken: body.refreshToken,
        accessExpiresAt: Number(body.expiresAt),
      };
      if (typeof refreshed.deviceToken !== 'string'
        || !refreshed.deviceToken
        || refreshed.deviceToken.length > 8192
        || !KEY_PATTERN.test(refreshed.refreshToken || '')
        || !Number.isSafeInteger(refreshed.accessExpiresAt)
        || refreshed.accessExpiresAt <= this.now()) throw new Error('Invalid refresh response');
      if (!this.enabled || this.connection.refreshToken !== connection.refreshToken) return false;
      await this.store.setConnection(refreshed);
      this.connection = refreshed;
      this._diagnostic('remote.credential_refresh_completed');
      this._setState({ ...this.state, runtime: this._publicRuntime() });
      this._renewSocket(refreshed);
      return true;
    } catch {
      this._diagnostic('remote.credential_refresh_failed', {
        socketUsable: Boolean(this.connection && this.socket?.readyState === 1 && this.connection.accessExpiresAt > this.now()),
      });
      if (this.connection && this.socket?.readyState === 1 && this.connection.accessExpiresAt > this.now()) {
        this._scheduleRefresh(this.timeouts.refreshRetry);
      } else {
        this._closeSocket();
        this._setState({ ...this.state, phase: 'offline', error: 'Remote runtime authorization could not be renewed' });
        this._scheduleReconnect();
      }
      return false;
    }
  }

  _renewSocket(connection) {
    if (!this.socket || this.socket.readyState !== 1) {
      this._scheduleRefresh();
      this._scheduleReconnect();
      return;
    }
    const socket = this.socket;
    this._diagnostic('remote.credential_renew_started');
    this._sendRelay({ kind: 'credential.renew', protocolVersion: PROTOCOL_VERSION, ticket: connection.deviceToken });
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      if (this.socket === socket && this.connection === connection) {
        this._diagnostic('remote.credential_renew_timeout');
        this.reconnectNow();
      }
    }, this.timeouts.renew);
  }

  _protocolFailure(socket) {
    if (socket && this.socket !== socket) return;
    this._diagnostic('remote.protocol_error', { phase: this.state.phase });
    this._closeSocket();
    this._setState({ ...this.state, phase: 'offline', error: 'Remote runtime sent an invalid message' });
    if (this.connection) this._scheduleReconnect();
  }

  _fail(message) {
    const pairingFailed = Boolean(this.pairing);
    this.pairing = null;
    this.pairingKeys = null;
    this._diagnostic('remote.connection_failed', { pairing: pairingFailed });
    this._closeSocket();
    this._setState({ ...this.state, phase: this.connection ? 'offline' : 'unpaired', challenge: null, error: message });
    if (pairingFailed && this.connection) this._scheduleReconnect();
  }

  _closeSocket(close = true) {
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.openTimer = null;
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.renewTimer = null;
    this.resyncPending = false;
    this.subscriptionsSupported = false;
    for (const pending of this.pendingCommands.values()) {
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (close) {
      try { socket?.close(); } catch {}
    }
  }

  _clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.reconnectTimer = null;
    this.refreshTimer = null;
  }

  _publicRuntime() {
    return this.connection ? { id: this.connection.runtimeId, name: null } : null;
  }

  _setState(state) {
    this.state = clone(state);
    const publicState = this.getState();
    for (const listener of this.listeners) listener(publicState);
  }

  _diagnostic(event, details = {}) {
    const entry = {
      event,
      ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
    };
    try { this.reportDiagnostic(entry); } catch (_) { /* diagnostics never affect the connection */ }
  }
}

module.exports = {
  askRemoteProject,
  listRemoteProjects,
  RemoteRuntimeClient,
  parsePairingInput,
  parseRemoteResourceId,
  relayWebSocketUrl,
  remoteResourceId,
  remoteSessionRef,
  stripPathFields,
};
