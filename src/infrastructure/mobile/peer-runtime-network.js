const { EventEmitter } = require('events');
const crypto = require('crypto');
const { RemoteRuntimeClient } = require('./remote-runtime-client');
const { decryptJson, encryptJson } = require('./mobile-crypto');

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PEERS = 32;
const PEER_ACCESS_TTL_MS = 7 * 24 * 60 * 60_000;
const PEER_HANDSHAKE_TIMEOUT_MS = 5_000;

function peerRef(value) {
  return value
    ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10)
    : undefined;
}

function validPeer(peer, ownRuntimeId) {
  return peer
    && ID_PATTERN.test(peer.runtimeId || '')
    && peer.runtimeId !== ownRuntimeId
    && KEY_PATTERN.test(peer.publicKey || '')
    && typeof peer.name === 'string'
    && peer.name.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(peer.name);
}

class PeerRelaySocket extends EventEmitter {
  constructor(network, peer) {
    super();
    this.network = network;
    this.peer = peer;
    this.readyState = 0;
    this.handshakeComplete = false;
    this.handshakeTimer = null;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(raw) {
    if (this.readyState !== 1) return;
    if (raw === 'ping') {
      queueMicrotask(() => this.emit('message', 'pong'));
      return;
    }
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.kind === 'hello.mobile') {
      this.emit('message', JSON.stringify({ kind: 'hello.accepted', role: 'mobile' }));
      this.emit('message', JSON.stringify({ kind: 'runtime.online' }));
      return;
    }
    if (message.kind === 'runtime.message' && message.box) {
      if (!this.network.relay.sendPeerMessage(this.peer.runtimeId, message.box, 'to-runtime')) {
        this.network._diagnostic('peer.route_failed', { peer: peerRef(this.peer.runtimeId), stream: 'to-runtime' });
        this.offline();
      } else if (this.readyState === 1 && !this.handshakeComplete && !this.handshakeTimer) {
        this.handshakeTimer = setTimeout(() => this.offline(), PEER_HANDSHAKE_TIMEOUT_MS);
      }
    }
  }

  receive(box) {
    if (this.readyState !== 1) return;
    try {
      decryptJson(box, this.network.keyPair.secretKey, this.peer.publicKey);
      this.network.relay.emit('diagnostic', { event: 'peer.response_verified', stream: 'to-client' });
    } catch {
      this.network.relay.emit('diagnostic', { event: 'peer.response_rejected', reason: 'decrypt_failed' });
    }
    this.handshakeComplete = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.emit('message', JSON.stringify({ kind: 'runtime.message', box }));
  }

  ping() { if (this.readyState === 1) queueMicrotask(() => this.emit('pong')); }
  terminate() { this.close(); }
  offline() {
    if (this.readyState !== 1) return;
    this.emit('message', JSON.stringify({ kind: 'runtime.offline' }));
    this.close();
  }
  close() {
    if (this.readyState === 3) return;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.readyState = 3;
    this.emit('close');
  }
}

class PeerRuntimeNetwork {
  constructor({ runtime, relay, runtimeId, keyPair, loadRosters = () => ({}), saveRosters = () => {} } = {}) {
    if (!runtime || !relay || !ID_PATTERN.test(runtimeId || '')
      || !KEY_PATTERN.test(keyPair?.publicKey || '') || !KEY_PATTERN.test(keyPair?.secretKey || '')) {
      throw new Error('Peer runtime network configuration is invalid');
    }
    this.runtime = runtime;
    this.relay = relay;
    this.runtimeId = runtimeId;
    this.keyPair = keyPair;
    this.loadRosters = loadRosters;
    this.saveRosters = saveRosters;
    this.rosters = new Map();
    this.revokedPeers = new Set();
    this.peers = new Map();
    this.clients = new Map();
    this.clientSockets = new Map();
    this.serverSockets = new Map();
    this.envelopeListeners = new Set();
    this.clientListeners = new Set();
    this.started = false;
    this.onRelayEvent = (event) => this._handleRelayEvent(event);
  }

  start() {
    if (this.started) return;
    this.started = true;
    const saved = this.loadRosters() || {};
    const savedRosters = saved.version === 1 && saved.rosters && typeof saved.rosters === 'object'
      ? saved.rosters : saved;
    if (saved.version === 1 && Array.isArray(saved.revoked)) {
      this.revokedPeers = new Set(saved.revoked.filter((runtimeId) => (
        ID_PATTERN.test(runtimeId || '') && runtimeId !== this.runtimeId
      )));
    }
    for (const [deviceId, peers] of Object.entries(savedRosters)) {
      if (!ID_PATTERN.test(deviceId) || !Array.isArray(peers)) continue;
      this.rosters.set(deviceId, peers.slice(0, MAX_PEERS).filter((peer) => validPeer(peer, this.runtimeId)));
    }
    this.relay.on('event', this.onRelayEvent);
    this._rebuildPeers();
    this._diagnostic('peer.network_started', { rosters: this.rosters.size, peers: this.peers.size });
  }

  stop() {
    this.started = false;
    this.relay.removeListener('event', this.onRelayEvent);
    for (const socket of this.clientSockets.values()) socket.close();
    for (const socket of this.serverSockets.values()) socket.close();
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
    this.clientSockets.clear();
    this.serverSockets.clear();
    this._notifyClients();
    this._diagnostic('peer.network_stopped');
  }

  replacePeers(deviceId, peers) {
    if (!ID_PATTERN.test(deviceId || '') || !Array.isArray(peers) || peers.length > MAX_PEERS
      || peers.some((peer) => !validPeer(peer, this.runtimeId))) {
      throw new Error('Private device group is invalid');
    }
    const previousPeers = new Set(this.peers.keys());
    const unique = [...new Map(peers.map((peer) => [peer.runtimeId, {
      runtimeId: peer.runtimeId,
      publicKey: peer.publicKey,
      name: peer.name.trim().slice(0, 200) || 'Connected host',
    }])).values()];
    if (unique.length) this.rosters.set(deviceId, unique);
    else this.rosters.delete(deviceId);
    for (const runtimeId of this.revokedPeers) {
      if (![...this.rosters.values()].some((roster) => roster.some((peer) => peer.runtimeId === runtimeId))) {
        this.revokedPeers.delete(runtimeId);
      }
    }
    this._saveState();
    this._rebuildPeers();
    this._diagnostic('peer.roster_replaced', {
      rosters: this.rosters.size,
      peers: this.peers.size,
      added: [...this.peers.keys()].filter((runtimeId) => !previousPeers.has(runtimeId)).length,
      removed: [...previousPeers].filter((runtimeId) => !this.peers.has(runtimeId)).length,
    });
    return { peers: unique.length };
  }

  removePeer(runtimeId) {
    if (!ID_PATTERN.test(runtimeId || '')) return false;
    if (![...this.rosters.values()].some((roster) => roster.some((peer) => peer.runtimeId === runtimeId))) return false;
    this.revokedPeers.add(runtimeId);
    this._saveState();
    this._rebuildPeers();
    this._diagnostic('peer.removed_by_user', { peer: peerRef(runtimeId) });
    return true;
  }

  getClients() { return [...this.clients.values()]; }
  clientForRuntime(runtimeId) { return this.clients.get(runtimeId) || null; }
  subscribeClients(listener) {
    this.clientListeners.add(listener);
    return () => this.clientListeners.delete(listener);
  }
  subscribeEnvelopes(listener) {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }

  _rebuildPeers() {
    const next = new Map();
    for (const roster of this.rosters.values()) {
      for (const peer of roster) {
        if (this.revokedPeers.has(peer.runtimeId)) continue;
        const existing = next.get(peer.runtimeId);
        if (existing && existing.publicKey !== peer.publicKey) continue;
        next.set(peer.runtimeId, peer);
      }
    }
    for (const runtimeId of this.peers.keys()) {
      const previous = this.peers.get(runtimeId);
      const current = next.get(runtimeId);
      if (current?.publicKey === previous.publicKey) continue;
      this._removePeer(runtimeId);
    }
    this.peers = next;
    for (const peer of this.peers.values()) {
      if (!this.clients.has(peer.runtimeId)) this._addPeer(peer);
    }
    this._notifyClients();
  }

  _saveState() {
    this.saveRosters({
      version: 1,
      rosters: Object.fromEntries(this.rosters),
      revoked: [...this.revokedPeers],
    });
  }

  _addPeer(peer) {
    const network = this;
    let connection = {
      relayOrigin: 'https://peer.codeagentswarm.invalid',
      backendOrigin: 'https://peer.codeagentswarm.invalid',
      runtimeId: peer.runtimeId,
      deviceToken: 'peer-runtime',
      refreshToken: 'P'.repeat(43),
      accessExpiresAt: Date.now() + PEER_ACCESS_TTL_MS,
      publicKey: network.keyPair.publicKey,
      secretKey: network.keyPair.secretKey,
      runtimePublicKey: peer.publicKey,
    };
    const store = {
      async loadOrCreate() {
        return {
          device: { id: `peer-${network.runtimeId}`, name: 'Private device group' },
          connection,
        };
      },
      async setConnection(next) { connection = next; },
      async clearConnection() {},
      async get() { return { connection }; },
    };
    class Socket extends PeerRelaySocket {
      constructor() {
        super(network, peer);
        const previous = network.clientSockets.get(peer.runtimeId);
        if (previous && previous !== this) previous.close();
        network.clientSockets.set(peer.runtimeId, this);
      }
    }
    const client = new RemoteRuntimeClient({
      store,
      WebSocketImpl: Socket,
      deviceName: 'Private device group',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          deviceToken: 'peer-runtime',
          refreshToken: 'P'.repeat(43),
          expiresAt: Date.now() + PEER_ACCESS_TTL_MS,
        }),
      }),
      diagnostic: ({ event, ...details }) => this._diagnostic(event, {
        ...details,
        scope: 'peer',
        peer: peerRef(peer.runtimeId),
      }),
    });
    client.subscribeEnvelopes((envelope) => {
      for (const listener of this.envelopeListeners) listener(peer.runtimeId, envelope, client);
    });
    this.clients.set(peer.runtimeId, client);
    this._diagnostic('peer.added', { peer: peerRef(peer.runtimeId) });
    void client.start();
  }

  _removePeer(runtimeId) {
    this.clients.get(runtimeId)?.stop();
    this.clients.delete(runtimeId);
    this.clientSockets.get(runtimeId)?.close();
    this.clientSockets.delete(runtimeId);
    this.serverSockets.get(runtimeId)?.close();
    this.serverSockets.delete(runtimeId);
    this._diagnostic('peer.removed', { peer: peerRef(runtimeId) });
  }

  _handleRelayEvent(event) {
    if (event?.kind === 'peer.offline' && ID_PATTERN.test(event.targetRuntimeId || '')) {
      this._diagnostic('peer.offline', { peer: peerRef(event.targetRuntimeId) });
      this.clientSockets.get(event.targetRuntimeId)?.offline();
      this.serverSockets.get(event.targetRuntimeId)?.close();
      this.serverSockets.delete(event.targetRuntimeId);
      return;
    }
    if (event?.kind !== 'peer.message'
      || !ID_PATTERN.test(event.sourceRuntimeId || '')
      || !KEY_PATTERN.test(event.sourcePublicKey || '')) return;
    const peer = this.peers.get(event.sourceRuntimeId);
    if (!peer || peer.publicKey !== event.sourcePublicKey) {
      this._diagnostic('peer.message_rejected', {
        reason: peer ? 'key_mismatch' : 'not_introduced',
        peer: peerRef(event.sourceRuntimeId),
      });
      return;
    }
    if (event.stream === 'to-client') {
      this.clientSockets.get(peer.runtimeId)?.receive(event.box);
      return;
    }
    if (event.stream !== 'to-runtime') {
      this._diagnostic('peer.message_rejected', { reason: 'invalid_stream', peer: peerRef(peer.runtimeId) });
      return;
    }
    let payload;
    try { payload = decryptJson(event.box, this.keyPair.secretKey, peer.publicKey); } catch {
      this._diagnostic('peer.message_rejected', { reason: 'decrypt_failed', peer: peerRef(peer.runtimeId) });
      return;
    }
    if (payload?.kind === 'hello') {
      this._diagnostic('peer.hello_decrypted', {
        peer: peerRef(peer.runtimeId),
        stream: 'to-runtime',
        bytes: Buffer.byteLength(JSON.stringify(event.box)),
      });
    }
    let socket = this.serverSockets.get(peer.runtimeId);
    if (payload?.kind === 'hello' && socket) {
      this._diagnostic('peer.inbound_replaced', { peer: peerRef(peer.runtimeId) });
      socket.close();
      this.serverSockets.delete(peer.runtimeId);
      socket = null;
    }
    if (!socket) {
      socket = new EventEmitter();
      socket.readyState = 1;
      socket.send = (raw) => {
        if (socket.readyState !== 1) return;
        let response;
        try { response = JSON.parse(String(raw)); } catch { return; }
        const box = encryptJson(response, this.keyPair.secretKey, peer.publicKey);
        if (!this.relay.sendPeerMessage(peer.runtimeId, box, 'to-client')) {
          this._diagnostic('peer.route_failed', { peer: peerRef(peer.runtimeId), stream: 'to-client' });
        } else if (response.kind === 'welcome') {
          this._diagnostic('peer.welcome_sent', {
            peer: peerRef(peer.runtimeId),
            stream: 'to-client',
            bytes: Buffer.byteLength(JSON.stringify(box)),
          });
        }
      };
      socket.close = () => {
        if (socket.readyState !== 1) return;
        socket.readyState = 3;
        socket.emit('close');
      };
      this.serverSockets.set(peer.runtimeId, socket);
      this.runtime.attachSocket(socket);
      this._diagnostic('peer.inbound_connected', { peer: peerRef(peer.runtimeId) });
    }
    socket.emit('message', JSON.stringify(payload));
  }

  receivePeerBox(sourceRuntimeId, sourcePublicKey, box) {
    this._handleRelayEvent({ kind: 'peer.message', sourceRuntimeId, sourcePublicKey, stream: 'to-runtime', box });
  }

  _notifyClients() {
    const clients = this.getClients();
    for (const listener of this.clientListeners) listener(clients);
  }

  _diagnostic(event, details = {}) {
    this.relay.emit('diagnostic', { event, ...details });
  }
}

module.exports = { PeerRuntimeNetwork };
