const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { decryptJson, encryptJson, verificationCode } = require('./mobile-crypto');

const PROTOCOL_VERSION = 2;
const PAIRING_REQUEST_TIMEOUT_MS = 5_000;
const WEBSOCKET_OPEN_TIMEOUT_MS = 3_000;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_PONG_TIMEOUT_MS = 10_000;
// Below this the deflate header and CPU cost outweigh what a small frame saves.
const COMPRESSION_THRESHOLD_BYTES = 4096;

function relayUrl(relayOrigin, runtimeId) {
  const url = new URL(relayOrigin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/mobile/ws';
  url.search = '';
  url.searchParams.set('runtime', runtimeId);
  url.hash = '';
  return url.toString();
}

class RelayDeviceSocket extends EventEmitter {
  constructor(client, device) {
    super();
    this.client = client;
    this.device = device;
    this.readyState = 1;
    // Only phones that announced `accepts: ['deflate']` in their hello receive compressed
    // boxes; older clients keep getting plain JSON.
    this.acceptsDeflate = false;
  }

  send(raw) {
    if (this.readyState !== 1) return;
    const json = String(raw);
    const bytes = Buffer.byteLength(json);
    const payload = JSON.parse(json);
    if (payload.kind === 'welcome' && payload.snapshot?.truncated) {
      this.client.emit('diagnostic', {
        event: 'runtime.snapshot_truncated',
        bytes,
      });
    }
    const codec = this.acceptsDeflate && bytes > COMPRESSION_THRESHOLD_BYTES ? 'deflate' : null;
    this.client._send({
      kind: 'runtime.message',
      deviceId: this.device.id,
      ...(codec ? { codec } : {}),
      box: encryptJson(payload, this.client.keyPair.secretKey, this.device.publicKey, codec),
    });
  }

  receive(box) {
    if (this.readyState !== 1) return;
    try {
      const payload = decryptJson(box, this.client.keyPair.secretKey, this.device.publicKey);
      if (payload?.kind === 'hello' && Array.isArray(payload.accepts)) {
        this.acceptsDeflate = payload.accepts.includes('deflate');
      }
      this.emit('message', JSON.stringify(payload));
    } catch (error) {
      this.client.emit('event', { kind: 'security.error', deviceId: this.device.id, message: error.message });
    }
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
}

class MobileRelayClient extends EventEmitter {
  constructor({
    runtime,
    getToken,
    getRuntimeId,
    getKeyPair,
    backendUrl,
    fetchImpl = globalThis.fetch,
    createWebSocket = (url) => new WebSocket(url),
  } = {}) {
    super();
    if (!runtime) throw new Error('MobileRelayClient requires a MobileRuntime');
    if (typeof fetchImpl !== 'function') throw new Error('MobileRelayClient requires fetch');
    this.runtime = runtime;
    this.getToken = getToken || (() => null);
    this.getRuntimeId = getRuntimeId || (() => crypto.randomUUID());
    this.getKeyPair = getKeyPair;
    this.backendUrl = new URL(backendUrl).origin;
    this.fetch = fetchImpl;
    this.createWebSocket = createWebSocket;
    this.socket = null;
    this.runtimeId = null;
    this.relayOrigin = null;
    this.keyPair = null;
    this.status = 'stopped';
    this.enabled = false;
    this.connecting = false;
    this.connectionGeneration = 0;
    this.authRejected = false;
    this.yielded = false;
    this.handshake = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.requests = new Map();
    this.pairings = new Map();
    this.devices = new Map();
  }

  start() {
    this.yielded = false;
    if (this.enabled) return;
    this.enabled = true;
    this.runtime.start();
    void this._connect();
  }

  async notifyAttention(payload = {}) {
    const runtimeId = this.runtimeId || this.getRuntimeId();
    if (!runtimeId) return { sent: 0 };
    return this._api('/api/mobile/notify', {
      runtimeId,
      sessionId: payload.sessionId,
      title: payload.title,
      body: payload.body,
    }).catch((error) => {
      this.emit('diagnostic', { event: 'push.failed', status: error.status });
      return { sent: 0 };
    });
  }

  stop() {
    this.connectionGeneration += 1;
    this.enabled = false;
    this.connecting = false;
    this._clearHandshake();
    this._stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._closeDevices();
    this._rejectRequests(new Error('Mobile relay stopped'));
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try { socket.close(); } catch (_) { /* already closed */ }
    }
    this._setStatus('stopped');
  }

  async ensureConnected(options = {}) {
    // A yielded runtime lost this account's relay slot to another app instance. Only an explicit
    // user action (pairing, sign-in, focusing this window) may take it back; a background sync
    // that revives it would make two instances fight over the same runtime id forever.
    const revive = options?.revive !== false;
    if (this.yielded && !revive) return this.getStatus();
    if (this.runtimeId && this.runtimeId !== this.getRuntimeId()) this.stop();
    this.yielded = false;
    this.authRejected = false;
    if (!this.enabled) this.start();
    else void this._connect();
    if (this.status === 'online') return this.getStatus();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Could not connect to the mobile relay'));
      }, 10_000);
      const onStatus = (status) => {
        if (status.status === 'online') {
          cleanup();
          resolve(status);
        } else if (status.status === 'signed_out' || status.status === 'auth_error') {
          cleanup();
          reject(new Error(status.status === 'signed_out' ? 'Sign in before connecting mobile' : 'Authentication failed'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('status', onStatus);
      };
      this.on('status', onStatus);
    });
  }

  getStatus() {
    return {
      status: this.status,
      runtimeId: this.runtimeId,
      devices: Array.from(this.devices.values(), ({ device }) => device),
    };
  }

  async createPairing() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureConnected();
      try {
        return await this._requestPairing();
      } catch (error) {
        const retryable = error.code === 'PAIRING_TIMEOUT' || error.code === 'RELAY_DISCONNECTED';
        if (!retryable) throw error;
        this._resetConnection();
        if (attempt > 0) {
          this._scheduleReconnect();
          throw error;
        }
        this.emit('diagnostic', { event: 'pairing.retry', reason: error.code.toLowerCase() });
      }
    }
  }

  _requestPairing() {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        const error = new Error('Pairing request timed out');
        error.code = 'PAIRING_TIMEOUT';
        reject(error);
      }, PAIRING_REQUEST_TIMEOUT_MS);
      this.requests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve({
            ...value,
            relayOrigin: this.relayOrigin,
            backendOrigin: this.backendUrl,
            runtimeId: this.runtimeId,
            desktopPublicKey: this.keyPair.publicKey,
          });
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this._send({
        kind: 'pair.create',
        requestId,
        desktopPublicKey: this.keyPair.publicKey,
        backendOrigin: this.backendUrl,
      })) {
        clearTimeout(timer);
        this.requests.delete(requestId);
        const error = new Error('Mobile relay disconnected');
        error.code = 'RELAY_DISCONNECTED';
        reject(error);
      }
    });
  }

  async confirmPairing(pairingId, accept) {
    if (this.status !== 'online') throw new Error('Mobile relay is offline');
    const pending = this.pairings.get(pairingId);
    if (!pending) throw new Error('Pairing request expired');
    let deviceToken;
    let refreshTokenBox;
    if (accept === true) {
      const response = await this._api('/api/mobile/device-token', {
        runtimeId: this.runtimeId,
        device: pending.device,
      });
      deviceToken = response.deviceToken;
      refreshTokenBox = encryptJson(
        { refreshToken: response.refreshToken },
        this.keyPair.secretKey,
        pending.device.publicKey
      );
    }
    if (!this._send({
      kind: 'pair.confirm',
      pairingId,
      accept: accept === true,
      ...(deviceToken ? { deviceToken, refreshTokenBox } : {})
    })) {
      throw new Error('Mobile relay is offline');
    }
    this.pairings.delete(pairingId);
  }

  async listDevices() {
    const response = await this._api('/api/mobile/devices', undefined, 'GET');
    const devices = (Array.isArray(response?.devices) ? response.devices : []).map((device) => ({
      id: device.id,
      runtimeId: device.runtime_id,
      deviceId: device.device_id,
      name: device.device_name,
      lastSeenAt: device.last_seen_at,
      createdAt: device.created_at,
    }));
    this.emit('diagnostic', { event: 'devices.listed', count: devices.length });
    return devices;
  }

  async revokeDevice(id) {
    await this._api(`/api/mobile/devices/${encodeURIComponent(id)}`, undefined, 'DELETE');
    this.emit('diagnostic', { event: 'device.revoked' });
  }

  async _api(pathname, body, method = 'POST') {
    const tokenResult = this.getToken();
    const token = tokenResult && typeof tokenResult.then === 'function'
      ? await tokenResult
      : tokenResult;
    if (!token) throw new Error('Sign in before connecting mobile');
    const options = {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await this.fetch(`${this.backendUrl}${pathname}`, options);
    if (!response.ok) {
      this.emit('diagnostic', { event: 'backend.rejected', method, path: pathname.replace(/\/[0-9a-f-]{36}$/i, '/:id'), status: response.status });
      const error = new Error(response.status === 401 ? 'Authentication failed' : 'Mobile connect service is unavailable');
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  async _connect() {
    if (!this.enabled || this.authRejected || this.socket || this.connecting) return;
    let initialToken;
    try {
      initialToken = this.getToken();
    } catch (_) {
      this._setStatus('signed_out');
      return;
    }
    if (!initialToken) {
      this._setStatus('signed_out');
      return;
    }
    const generation = this.connectionGeneration;
    this.runtimeId = this.getRuntimeId();
    this.keyPair = this.getKeyPair?.();
    if (!this.keyPair?.publicKey || !this.keyPair?.secretKey) {
      this._setStatus('auth_error');
      return;
    }
    this.connecting = true;
    this._setStatus('connecting');
    const ticketStartedAt = Date.now();
    let failurePhase = 'ticket';
    try {
      const access = await this._api('/api/mobile/desktop-ticket', { runtimeId: this.runtimeId });
      if (generation !== this.connectionGeneration || !this.enabled || this.socket) return;
      failurePhase = 'websocket';
      this.relayOrigin = new URL(access.relayOrigin).origin;
      const socket = this.createWebSocket(relayUrl(this.relayOrigin, this.runtimeId));
      this.socket = socket;
      this.handshake = {
        startedAt: Date.now(),
        ticketMs: Date.now() - ticketStartedAt,
        opened: false,
        reported: false,
        timer: setTimeout(() => {
          if (this.socket !== socket || this.handshake?.opened) return;
          this.handshake.errorCode ||= 'OPEN_TIMEOUT';
          this._reportConnectFailure('websocket');
          try {
            if (typeof socket.terminate === 'function') socket.terminate();
            else socket.close();
          } catch (_) { /* already closed */ }
        }, WEBSOCKET_OPEN_TIMEOUT_MS),
      };
      this.handshake.timer.unref?.();
      socket.on('open', () => {
        if (this.socket !== socket) return;
        clearTimeout(this.handshake.timer);
        this.handshake.opened = true;
        this._send({ kind: 'hello.desktop', protocolVersion: PROTOCOL_VERSION, ticket: access.ticket });
        // Without this the relay can accept the socket and never answer, leaving the client
        // stuck in 'connecting' with a half-open socket until TCP finally notices.
        this.handshake.timer = setTimeout(() => {
          if (this.socket !== socket) return;
          this._reportConnectFailure('hello');
          // terminate(), not close(): a peer that never answered hello will not answer the
          // close handshake either, and ws would wait its ~30s closeTimeout before giving up.
          try {
            if (typeof socket.terminate === 'function') socket.terminate();
            else socket.close();
          } catch (_) { /* already closed */ }
        }, HELLO_TIMEOUT_MS);
        this.handshake.timer.unref?.();
      });
      socket.on('message', (raw) => this._handleMessage(socket, raw));
      socket.on('error', (error) => {
        if (this.socket === socket && this.handshake && error?.code) {
          this.handshake.errorCode = String(error.code).slice(0, 40);
        }
      });
      socket.on('close', () => this._handleClose(socket));
      socket.on('pong', () => {
        if (this.socket !== socket) return;
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      });
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      this.emit('diagnostic', {
        event: 'relay.connect_failed',
        phase: failurePhase,
        ms: Date.now() - ticketStartedAt,
        status: error.status,
        code: error?.code ? String(error.code).slice(0, 40) : undefined,
      });
      if (error.status === 401) {
        this.authRejected = true;
        this._setStatus('auth_error');
      } else {
        this._setStatus('offline');
        this._scheduleReconnect();
      }
    } finally {
      if (generation === this.connectionGeneration) this.connecting = false;
    }
  }

  _reportConnectFailure(phase) {
    if (!this.handshake || this.handshake.reported) return;
    this.handshake.reported = true;
    this.emit('diagnostic', {
      event: 'relay.connect_failed',
      phase,
      ms: Date.now() - this.handshake.startedAt,
      ticketMs: this.handshake.ticketMs,
      code: this.handshake.errorCode,
    });
  }

  _clearHandshake() {
    if (this.handshake?.timer) clearTimeout(this.handshake.timer);
    this.handshake = null;
  }

  _handleMessage(socket, raw) {
    if (this.socket !== socket) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (message.kind === 'hello.accepted') {
      if (this.handshake) {
        this.emit('diagnostic', {
          event: 'relay.connected',
          ticketMs: this.handshake.ticketMs,
          connectMs: Date.now() - this.handshake.startedAt,
        });
        clearTimeout(this.handshake.timer);
        this.handshake.timer = null;
        this.handshake.accepted = true;
      }
      this.reconnectAttempt = 0;
      this._setStatus('online');
      this._startHeartbeat(socket);
      return;
    }
    if (message.kind === 'pair.created') {
      const request = this.requests.get(message.requestId);
      if (request) {
        this.requests.delete(message.requestId);
        request.resolve(message);
      }
      return;
    }
    if (message.kind === 'pair.scanned' && message.device?.publicKey) {
      this.pairings.set(message.pairingId, { device: message.device });
      this.emit('event', {
        ...message,
        verificationCode: verificationCode(this.keyPair.secretKey, message.device.publicKey, message.pairingId),
      });
      return;
    }
    if (message.kind === 'mobile.connected' && message.device?.id && message.device?.publicKey) {
      this._attachDevice(message.device);
      this.emit('event', message);
      return;
    }
    if (message.kind === 'mobile.disconnected') {
      this._detachDevice(message.deviceId);
      this.emit('event', message);
      return;
    }
    if (message.kind === 'preview.request' && typeof this.runtime.handlePreviewRequest === 'function') {
      void this.runtime.handlePreviewRequest(message).then(
        (response) => this._send({ kind: 'preview.response', ...response }),
        (error) => this._send({
          kind: 'preview.response',
          requestId: message.requestId,
          status: 502,
          headers: [['content-type', 'text/plain; charset=utf-8']],
          bodyBase64: Buffer.from(error.message || 'Localhost preview failed').toString('base64')
        })
      );
      return;
    }
    if (message.kind === 'runtime.message') {
      this.devices.get(message.deviceId)?.socket.receive(message.box);
      return;
    }
    if (message.kind === 'relay.error' && message.code === 'invalid_relay_ticket') {
      this.authRejected = true;
      this._setStatus('auth_error');
    }
    if (message.kind === 'relay.error' && message.code === 'runtime_reconnected') {
      this.emit('event', message);
      this.yielded = true;
      this.stop();
      return;
    }
    this.emit('event', message);
  }

  _handleClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this._stopHeartbeat();
    if (this.handshake && !this.handshake.accepted) {
      this._reportConnectFailure(this.handshake.opened ? 'hello' : 'websocket');
    }
    this._clearHandshake();
    this._closeDevices();
    const error = new Error('Mobile relay disconnected');
    error.code = 'RELAY_DISCONNECTED';
    this._rejectRequests(error);
    if (!this.enabled) return;
    if (!this.authRejected) {
      this._setStatus('offline');
      this._scheduleReconnect();
    }
  }

  // System sleep kills the TCP connection without delivering 'close': the socket sits
  // half-open, status stays 'online', and reconnection logic never runs. A ws-level ping
  // forces a write that surfaces the death; no pong within the deadline → terminate, which
  // fires 'close' and routes into the normal reconnect path. Skipped when the socket
  // implementation has no ping (unit-test fakes).
  _startHeartbeat(socket) {
    this._stopHeartbeat();
    if (typeof socket.ping !== 'function') return;
    this.heartbeatTimer = setInterval(() => this._pingSocket(socket), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  _pingSocket(socket) {
    if (this.socket !== socket) {
      this._stopHeartbeat();
      return;
    }
    if (this.pongTimer) return;
    try { socket.ping(); } catch (_) { return; }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.socket !== socket) return;
      this.emit('diagnostic', { event: 'relay.heartbeat_timeout' });
      // terminate(), not close(): a dead peer will not answer the close handshake and ws
      // would wait its ~30s closeTimeout before firing 'close'.
      try {
        if (typeof socket.terminate === 'function') socket.terminate();
        else socket.close();
      } catch (_) { /* already closed */ }
    }, HEARTBEAT_PONG_TIMEOUT_MS);
    this.pongTimer.unref?.();
  }

  _stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  // Sleep can leave either a half-open socket or an old reconnect backoff behind. On resume,
  // replace both immediately instead of spending another 10-15s proving they are stale.
  verifyConnection() {
    if (!this.enabled || this.yielded || this.authRejected) return;
    this.reconnectAttempt = 0;
    this._resetConnection();
    void this._connect();
  }

  _scheduleReconnect() {
    if (!this.enabled || this.reconnectTimer) return;
    const delay = Math.min(15_000, 500 * (2 ** this.reconnectAttempt++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _resetConnection() {
    this.connectionGeneration += 1;
    this._clearHandshake();
    this._stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.connecting = false;
    this._closeDevices();
    const error = new Error('Mobile relay disconnected');
    error.code = 'RELAY_DISCONNECTED';
    this._rejectRequests(error);
    try { socket?.close(); } catch (_) { /* already closed */ }
    this._setStatus('offline');
  }

  _attachDevice(device) {
    if (this.devices.has(device.id)) return;
    const socket = new RelayDeviceSocket(this, device);
    const detachRuntime = this.runtime.attachSocket(socket);
    this.devices.set(device.id, { device, socket, detachRuntime });
  }

  _detachDevice(deviceId) {
    const connected = this.devices.get(deviceId);
    if (!connected) return;
    this.devices.delete(deviceId);
    connected.socket.close();
    connected.detachRuntime();
  }

  _closeDevices() {
    for (const deviceId of Array.from(this.devices.keys())) this._detachDevice(deviceId);
  }

  _rejectRequests(error) {
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }

  _send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', this.getStatus());
  }
}

module.exports = { MobileRelayClient, RelayDeviceSocket, relayUrl };
