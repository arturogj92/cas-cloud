import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  createKeyPair,
  configurePrng,
  decryptJson,
  encryptJson,
  verificationCode,
  type MobileKeyPair,
} from './mobile-crypto';

configurePrng((target) => Crypto.getRandomValues(target));

import {
  clearMobileHistory,
  clearRuntimeCache,
  clearPendingDeviceRevocation,
  clearSavedConnection,
  loadPendingDeviceRevocation,
  loadRuntimeCache,
  loadSavedConnection,
  savePendingDeviceRevocation,
  saveMobileNotificationsEnabled,
  savePendingSends,
  saveRuntimeCache,
  saveSavedConnection,
  stableDeviceId,
  withPairingStorageLock,
  type PendingDeviceRevocation,
  type SavedConnection,
} from './storage';
import { withTimeout } from './promise-timeout';
import {
  commandTimelinePayload,
  reconnectTimelinePayload,
  sessionOpenTimelinePayload,
  type SessionOpenTrace,
} from './reconnect-timeline';
import { presentSessionAlerts, registerPushToken } from './push';
import { classifyPendingDeviceRevocation, revokeMobileDevice } from './device-revocation';
import { diagnostic, getDiagnostics, initializeDiagnostics } from './diagnostics';
import { LatestValueWriter } from './latest-value-writer';
import { tokenOwnerId } from './host-scope';
import { invalidateTaskCache } from './task-cache';
import {
  MAX_MOBILE_ATTACHMENT_BYTES,
  attachmentUploadChunks,
  createMobileAttachment,
  type MobileAttachment,
} from './mobile-attachments';
import {
  PROTOCOL_VERSION,
  applyRuntimeEnvelope,
  newlyAttentiveSessions,
  emptyRuntimeCache as emptyCache,
  normalizePairingCode,
  normalizeSession,
  normalizeRuntimeCache,
  parsePairingUri,
  previewHttpUrl,
  recordOrNull,
  relayWebSocketUrl,
  stringOrNull,
  type MobileRuntimeState,
  type PairingCredentials,
  type RuntimeCache,
  type RuntimeCommand,
  type RuntimeEnvelope,
  type RuntimeItem,
  type RuntimeSession,
} from './protocol';

const connectionRef = (value: unknown) => {
  const ref = stringOrNull(value);
  return ref && /^[a-f0-9]{10}$/.test(ref) ? ref : undefined;
};

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_PONG_TIMEOUT_MS = 5_000;
const COMMAND_ACK_TIMEOUT_MS = 3_000;
const NON_REPLAYABLE_COMMANDS = new Set([
  'attachment.read', 'history.older', 'providers.list',
  'project.directories.list',
  'coordination.message', 'coordination.sessions', 'coordination.transcript', 'coordination.peers.replace',
]);
const ACCESS_REFRESH_LEAD_MS = 2 * 60_000;
const ACCESS_REFRESH_RETRY_MS = 8_000;
const RELAY_CREDENTIAL_RENEW_TIMEOUT_MS = 5_000;
const CONNECT_DEADLINE_MS = 12_000;
// Serializing the whole replay cache is JS-thread work; 250 ms meant four full stringifies a second while agents streamed.
const PERSIST_DEBOUNCE_MS = 1_500;
// Codecs this client can decode. A desktop that does not understand the negotiation simply
// keeps sending plain JSON boxes.
const HELLO_ACCEPTS = ['deflate'];
const SESSION_SUBSCRIPTIONS_FEATURE = 'session-subscriptions';
const DEFAULT_PAIRING_CODE_ORIGIN = process.env.EXPO_PUBLIC_MOBILE_RELAY_URL
  || 'https://codeagentswarm-connect.elcaminodelprogramadorweb.workers.dev';

export * from './protocol';

type PendingCommand = {
  message: { kind: string; commandId: string; command: RuntimeCommand };
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  ackTimer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  attempts: number;
  ackMs: number | null;
};

type ConnectionWrite = {
  connection: SavedConnection | null;
  expectedRefreshToken?: string;
};

type PendingRevocationWrite = {
  revocation: PendingDeviceRevocation | null;
  expectedId?: string;
};

type ConnectTrace = {
  startedAt: number;
  socketStartedAt: number;
  helloStartedAt: number;
  attempts: number;
  trigger: string;
  refreshMs: number;
  socketMs: number;
  helloMs: number;
};

export class MobileRuntimeClient {
  private state: MobileRuntimeState = { ...emptyCache(), phase: 'booting', challengeCode: null, challengeExpiresAt: null, error: null };
  private listeners = new Set<(state: MobileRuntimeState) => void>();
  private envelopeListeners = new Set<(message: RuntimeEnvelope) => void>();
  private socket: WebSocket | null = null;
  private savedConnection: SavedConnection | null = null;
  private pairing: PairingCredentials | null = null;
  private pairingKeys: MobileKeyPair | null = null;
  private deviceId = '';
  private enabled = false;
  private active = true;
  private remotePushRegistered = false;
  private pushRegistration: Promise<boolean> | null = null;
  private runtimeOnline = false;
  private reconnectAttempt = 0;
  private connectTrigger = 'boot';
  private connectTrace: ConnectTrace | null = null;
  private desktopVersion: string | null = null;
  private desktopChannel: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private credentialRenewTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRevocationTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private pendingCommands = new Map<string, PendingCommand>();
  private visibleSessionId: string | null = null;
  private subscriptionsSupported = false;
  private resyncPending = false;
  private connectionWriter: LatestValueWriter<ConnectionWrite>;
  private runtimeCacheWriter: LatestValueWriter<RuntimeCache | null>;
  private pendingRevocationWriter: LatestValueWriter<PendingRevocationWrite>;
  private notificationPreferenceWriter = new LatestValueWriter<boolean>(async (enabled) => {
    await saveMobileNotificationsEnabled(enabled);
    if (this.pushRegistration) await this.pushRegistration.catch(() => false);
    this.remotePushRegistered = false;
    if (this.savedConnection) await this.registerRemotePush(this.savedConnection);
  });

  constructor(private readonly storageScope?: string) {
    this.connectionWriter = new LatestValueWriter<ConnectionWrite>(({ connection, expectedRefreshToken }) => (
      connection ? saveSavedConnection(connection, storageScope) : clearSavedConnection(expectedRefreshToken, storageScope)
    ));
    this.runtimeCacheWriter = new LatestValueWriter<RuntimeCache | null>((cache) => (
      cache ? saveRuntimeCache(cache, storageScope) : clearRuntimeCache(storageScope)
    ));
    this.pendingRevocationWriter = new LatestValueWriter<PendingRevocationWrite>(({ revocation, expectedId }) => (
      revocation ? savePendingDeviceRevocation(revocation, storageScope) : clearPendingDeviceRevocation(expectedId, storageScope)
    ));
  }

  subscribe(listener: (state: MobileRuntimeState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribeEnvelopes(listener: (message: RuntimeEnvelope) => void) {
    this.envelopeListeners.add(listener);
    return () => { this.envelopeListeners.delete(listener); };
  }

  getState() {
    return this.state;
  }

  getPairedRuntimeId() {
    return this.savedConnection?.runtimeId || null;
  }

  getPeerDescriptor() {
    const connection = this.savedConnection;
    const ownerId = connection ? tokenOwnerId(connection.deviceToken) : null;
    if (!connection || !ownerId) return null;
    return {
      runtimeId: connection.runtimeId,
      publicKey: connection.desktopPublicKey,
      relayOrigin: connection.relayOrigin,
      ownerId,
      name: this.state.computerName || (this.state.hostKind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop'),
    };
  }

  getDiagnostics() {
    return getDiagnostics();
  }

  setNotificationsEnabled(enabled: boolean) {
    return this.notificationPreferenceWriter.set(enabled);
  }

  async start() {
    if (this.enabled) return;
    this.enabled = true;
    const [savedConnection, cachedState, deviceId, pendingRevocation] = await Promise.all([
      loadSavedConnection(this.storageScope),
      loadRuntimeCache(this.storageScope),
      stableDeviceId(),
      loadPendingDeviceRevocation(this.storageScope),
    ]);
    if (!this.enabled) return;
    void initializeDiagnostics();
    this.savedConnection = savedConnection;
    this.deviceId = deviceId;
    diagnostic('client.started', { savedConnection: Boolean(savedConnection) });
    if (!savedConnection && cachedState) await this.runtimeCacheWriter.set(null).catch(() => false);
    const cache = savedConnection ? normalizeRuntimeCache(cachedState) : emptyCache();
    if (savedConnection && !cache.runtimeId) cache.runtimeId = savedConnection.runtimeId;
    if (!savedConnection) {
      void clearMobileHistory(this.storageScope).catch(() => {});
      void invalidateTaskCache(this.storageScope).catch(() => {});
    }
    this.setState({ ...cache, phase: savedConnection ? 'connecting' : 'unpaired', challengeCode: null, challengeExpiresAt: null, error: null });
    if (pendingRevocation === undefined) void this.retryPendingDeviceRevocation();
    else if (pendingRevocation) void this.retryPendingDeviceRevocation(pendingRevocation);
    if (savedConnection && this.active) {
      void this.connect();
    }
  }

  stop() {
    diagnostic('client.stopped');
    this.enabled = false;
    this.pairing = null;
    this.pairingKeys = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.stopHeartbeat();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.credentialRenewTimer) clearTimeout(this.credentialRenewTimer);
    if (this.pendingRevocationTimer) clearTimeout(this.pendingRevocationTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.refreshTimer = null;
    this.credentialRenewTimer = null;
    this.pendingRevocationTimer = null;
    this.persistTimer = null;
    this.connectTrace = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.reject(new Error('The connection was closed'));
    }
    this.pendingCommands.clear();
  }

  async pair(raw: string) {
    const pairing = parsePairingUri(raw);
    if (this.pairing?.pairingToken === pairing.pairingToken && (this.socket || this.connecting)) return;
    if (Platform.OS === 'web' && !globalThis.navigator?.locks) {
      throw new Error('This browser cannot safely replace a paired computer. Update it and try again.');
    }
    const pendingRevocation = await loadPendingDeviceRevocation(this.storageScope);
    if (pendingRevocation === undefined) {
      throw new Error('Could not verify the previous computer. Restart the app and try again.');
    }
    if (pendingRevocation) {
      const currentConnection = Platform.OS === 'web' || this.storageScope
        ? await loadSavedConnection(this.storageScope)
        : this.savedConnection || await loadSavedConnection(this.storageScope);
      if ((Platform.OS === 'web' || this.storageScope) && this.savedConnection && !currentConnection) {
        throw new Error('Could not verify the current computer. Restart the app and try again.');
      }
      const action = classifyPendingDeviceRevocation(pendingRevocation, currentConnection);
      if (action === 'discard') {
        if (!await this.pendingRevocationWriter.set({ revocation: null, expectedId: pendingRevocation.id })) {
          throw new Error('The computer changed while pairing. Try again.');
        }
      } else if (action === 'wait') {
        throw new Error('Could not verify the previous computer. Restart the app and try again.');
      } else if (!await revokeMobileDevice(pendingRevocation)) {
        throw new Error('Could not disconnect the previous computer. Check your connection and try again.');
      } else if (!await this.pendingRevocationWriter.set({ revocation: null, expectedId: pendingRevocation.id })) {
        throw new Error('The computer changed while pairing. Try again.');
      }
    }
    const pairingKeys = createKeyPair();
    this.pairing = pairing;
    this.noteReconnectTrigger('pair');
    diagnostic('pair.started');
    this.pairingKeys = pairingKeys;
    this.disconnectSocket();
    this.setState({ ...this.state, phase: 'connecting', challengeCode: null, challengeExpiresAt: null, error: null });
    void this.connect();
  }

  async pairCode(raw: string, origin = DEFAULT_PAIRING_CODE_ORIGIN) {
    const code = normalizePairingCode(raw);
    const target = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) || target.username || target.password) {
      throw new Error('The pairing service is not secure');
    }
    try {
      const response = await withTimeout(fetch(
        `${target.origin}/api/mobile/pairing-code/${encodeURIComponent(code)}`,
        { headers: { Accept: 'application/json' } },
      ), 10_000);
      if (!response.ok) throw new Error('Pairing code unavailable');
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.pairingUri !== 'string') throw new Error('Invalid pairing response');
      return this.pair(body.pairingUri);
    } catch {
      throw new Error('This pairing code is invalid or has expired');
    }
  }

  async forgetDevice(_runtimeId?: string) {
    if (this.pushRegistration) await this.pushRegistration.catch(() => false);
    await withPairingStorageLock(async () => {
      const isolatedStorage = Platform.OS === 'web' || Boolean(this.storageScope);
      const currentConnection = isolatedStorage
        ? await loadSavedConnection(this.storageScope)
        : this.savedConnection;
      if (isolatedStorage && this.savedConnection && !currentConnection) {
        throw new Error('Could not verify the current computer. Restart the app and try again.');
      }
      const pendingRevocation = await loadPendingDeviceRevocation(this.storageScope);
      if (pendingRevocation === undefined) {
        throw new Error('Could not verify whether another computer is still connected. Try again.');
      }
      // Scoped Forget is local-first: an offline host cannot keep its credential visible.
      if (pendingRevocation && isolatedStorage) void revokeMobileDevice(pendingRevocation);
      else if (pendingRevocation && !await revokeMobileDevice(pendingRevocation)) {
        throw new Error('Could not forget the previous computer. Check your connection and try again.');
      }
      if (pendingRevocation
        && !await this.pendingRevocationWriter.set({ revocation: null, expectedId: pendingRevocation.id })) {
        throw new Error('The paired computer changed. Try again.');
      }
      if (isolatedStorage) void revokeMobileDevice(currentConnection);
      else if (!await revokeMobileDevice(currentConnection)) {
        throw new Error('Could not forget this computer. Check your connection and try again.');
      }
      if (!await this.connectionWriter.set({
        connection: null,
        expectedRefreshToken: currentConnection?.refreshToken,
      })) throw new Error('The paired computer changed. Try again.');
    });
    this.savedConnection = null;
    this.pairing = null;
    this.pairingKeys = null;
    this.remotePushRegistered = false;
    this.pushRegistration = null;
    await this.clearRuntimeData();
    diagnostic('device.forgotten');
    this.disconnectSocket();
    this.setState({ ...emptyCache(), phase: 'unpaired', challengeCode: null, challengeExpiresAt: null, error: null });
  }

  cancelPairing() {
    if (!this.pairing) return;
    this.pairing = null;
    this.pairingKeys = null;
    this.disconnectSocket();
    this.setState({
      ...this.state,
      phase: this.savedConnection ? 'offline' : 'unpaired',
      challengeCode: null,
      challengeExpiresAt: null,
      error: null,
    });
    diagnostic('pair.cancelled', { retainedConnection: Boolean(this.savedConnection) });
    if (this.savedConnection && this.enabled && this.active) this.scheduleReconnect();
  }

  reconnectNow(trigger = 'manual') {
    const connectionStarting = this.state.phase === 'connecting'
      && (this.connecting || (this.socket && this.socket.readyState < 2));
    if (!this.enabled || !this.active || connectionStarting || (!this.savedConnection && !this.pairing)) return;
    this.noteReconnectTrigger(trigger);
    this.disconnectSocket();
    void this.connect();
  }

  private noteReconnectTrigger(trigger: string) {
    this.connectTrigger = trigger;
    if (this.connectTrace) this.connectTrace.trigger = trigger;
  }

  private async retryPendingDeviceRevocation(revocation?: PendingDeviceRevocation) {
    if (!this.enabled) return;
    const retryLater = () => {
      if (this.pendingRevocationTimer) clearTimeout(this.pendingRevocationTimer);
      this.pendingRevocationTimer = setTimeout(() => {
        this.pendingRevocationTimer = null;
        void this.retryPendingDeviceRevocation();
      }, ACCESS_REFRESH_RETRY_MS);
    };
    const pendingRevocation = revocation ?? await loadPendingDeviceRevocation(this.storageScope);
    if (pendingRevocation === undefined) {
      retryLater();
      return;
    }
    if (!pendingRevocation) return;
    const currentConnection = this.savedConnection || await loadSavedConnection(this.storageScope);
    const action = classifyPendingDeviceRevocation(pendingRevocation, currentConnection);
    if (action === 'discard') {
      const cleared = await this.pendingRevocationWriter
        .set({ revocation: null, expectedId: pendingRevocation.id })
        .catch(() => false);
      if (!cleared && this.enabled) retryLater();
      return;
    }
    if (action === 'wait') {
      retryLater();
      return;
    }
    if (await revokeMobileDevice(pendingRevocation)) {
      const cleared = await this.pendingRevocationWriter
        .set({ revocation: null, expectedId: pendingRevocation.id })
        .catch(() => false);
      if (!cleared && this.enabled) retryLater();
      return;
    }
    if (this.enabled) retryLater();
  }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    diagnostic(active ? 'client.resumed' : 'client.suspended');
    if (active) {
      this.reconnectNow('resume');
      return;
    }
    this.flushPersist();
    if (!this.savedConnection) return;
    this.runtimeOnline = false;
    this.disconnectSocket();
    this.connectTrace = null;
    this.setState({ ...this.state, phase: this.state.sessions.length ? 'offline' : 'connecting', error: null });
  }

  reportSessionOpen(_sessionId: string, trace: Omit<SessionOpenTrace, 'mobileVersion' | 'mobileBuild' | 'desktopVersion' | 'channel'>) {
    const payload = sessionOpenTimelinePayload({ ...trace, ...this.telemetryMetadata() });
    diagnostic('session.open.timeline', payload);
    this.reportTelemetry(payload);
  }

  async setVisibleSession(sessionId: string | null) {
    if (this.visibleSessionId === sessionId) return;
    const previous = this.visibleSessionId;
    this.visibleSessionId = sessionId;
    if (this.state.phase !== 'online' || !this.subscriptionsSupported) return;
    if (previous) {
      await this.sendCommand({ type: 'session.unsubscribe', sessionId: previous }).catch(() => {});
    }
    if (!sessionId || this.visibleSessionId !== sessionId) return;
    await this.hydrateVisibleSession(sessionId);
  }

  // A reset welcome shares one 256 KB budget across every session, so the open Chat can come back
  // with a handful of items. The hello already re-subscribed it; this fetches its bounded snapshot.
  private async hydrateVisibleSession(sessionId: string) {
    const result = recordOrNull(await this.sendCommand({
      type: 'session.subscribe',
      sessionId,
    }).catch(() => null));
    const hydrated = normalizeSession(result?.session);
    if (!hydrated || this.visibleSessionId !== sessionId) return;
    this.setState({
      ...this.state,
      sessions: [hydrated, ...this.state.sessions.filter((session) => session.sessionId !== sessionId)],
    });
    this.schedulePersist();
  }

  sendCommand(command: RuntimeCommand, commandId = Crypto.randomUUID()) {
    if (this.state.phase !== 'online') return Promise.reject(new Error('The host is not connected'));
    diagnostic('command.sent', { type: command.type });
    const message = { kind: 'command', commandId, command };
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = command.type === 'session.create' || command.type === 'session.resume' || command.type === 'session.handoff' || command.type === 'session.action' ? 120_000 : 45_000;
      const timer = setTimeout(() => {
        const pending = this.pendingCommands.get(commandId);
        if (pending?.ackTimer) clearTimeout(pending.ackTimer);
        if (pending) this.reportCommandTimeline(pending, false);
        this.pendingCommands.delete(commandId);
        reject(new Error('The command timed out'));
      }, timeoutMs);
      const pending: PendingCommand = {
        message,
        resolve,
        reject,
        timer,
        ackTimer: null,
        startedAt: Date.now(),
        attempts: 0,
        ackMs: null,
      };
      this.pendingCommands.set(commandId, pending);
      if (!this.sendPendingCommand(pending)) {
        clearTimeout(timer);
        this.pendingCommands.delete(commandId);
        this.reportCommandTimeline(pending, false);
        reject(new Error('The connection was lost'));
      }
    });
  }

  async transcribeAudio(uri: string, mimeType: string, durationMs: number) {
    if (!this.savedConnection) throw new Error('This device is not paired');
    const source = await withTimeout(fetch(uri), 15_000);
    const audio = await source.blob();
    if (!audio.size || audio.size > MAX_MOBILE_ATTACHMENT_BYTES) throw new Error('The recording is too large');
    diagnostic('transcription.started', { durationMs, sizeBytes: audio.size });
    const request = () => withTimeout(fetch(`${this.savedConnection!.backendOrigin}/api/mobile/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.savedConnection!.deviceToken}`,
        'Content-Type': mimeType,
        'X-Audio-Duration-Ms': String(durationMs),
      },
      body: audio,
    }), 60_000);
    let response = await request();
    if (response.status === 401 && await this.refreshAccess()) response = await request();
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      diagnostic('transcription.failed', { status: response.status });
      throw new Error(stringOrNull(result?.error) || 'Could not transcribe the recording');
    }
    const text = stringOrNull(result?.text)?.trim();
    if (!text) throw new Error('No speech was detected');
    diagnostic('transcription.completed');
    return text;
  }

  async sendTurn(
    sessionId: string,
    text: string,
    attachments: MobileAttachment[] = [],
    onProgress?: (progress: number) => void,
    commandId = Crypto.randomUUID(),
  ) {
    const uploads = attachments.map((attachment, index) => ({
      attachment,
      index,
      uploadId: `${commandId}:upload:${index}`,
      chunks: attachmentUploadChunks(attachment),
    }));
    const totalChunks = uploads.reduce((sum, upload) => sum + upload.chunks.length, 0);
    let sentChunks = 0;
    try {
      for (const { attachment, index, uploadId, chunks } of uploads) {
        await this.sendCommand({
          type: 'attachment.begin',
          sessionId,
          payload: {
            uploadId,
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            durationMs: attachment.durationMs,
            chunkCount: chunks.length,
          },
        }, `${commandId}:begin:${index}`);
        for (const [chunkIndex, chunk] of chunks.entries()) {
          await this.sendCommand({
            type: 'attachment.chunk',
            sessionId,
            payload: { uploadId, ...chunk },
          }, `${commandId}:chunk:${index}:${chunkIndex}`);
          sentChunks += 1;
          onProgress?.(totalChunks ? sentChunks / totalChunks : 1);
        }
      }
      return await this.sendCommand({
        type: 'turn.send',
        sessionId,
        payload: {
          text,
          ...(uploads.length ? { attachmentUploadIds: uploads.map((upload) => upload.uploadId) } : {}),
        },
      }, commandId);
    } catch (error) {
      for (const { index, uploadId } of uploads) {
        void this.sendCommand({
          type: 'attachment.abort',
          sessionId,
          payload: { uploadId },
        }, `${commandId}:abort:${index}`).catch(() => {});
      }
      throw error;
    }
  }

  async readAttachment(sessionId: string, attachmentId: string) {
    const read = (index: number) => this.sendCommand({
      type: 'attachment.read',
      sessionId,
      payload: { attachmentId, index },
    }) as Promise<Record<string, unknown>>;
    const first = await read(0);
    const total = Number(first.total);
    if (!Number.isSafeInteger(total) || total < 1 || total > 64) throw new Error('Invalid attachment response');
    const rest = await Promise.all(Array.from({ length: total - 1 }, (_, index) => read(index + 1)));
    const chunks = [first, ...rest];
    if (chunks.some((chunk, index) => (
      chunk.attachmentId !== attachmentId
      || Number(chunk.index) !== index
      || Number(chunk.total) !== total
      || typeof chunk.data !== 'string'
    ))) throw new Error('Incomplete attachment response');
    const type = first.type;
    if (type !== 'image' && type !== 'audio') throw new Error('Unsupported downloadable attachment');
    const mimeType = typeof first.mimeType === 'string' ? first.mimeType : '';
    return createMobileAttachment({
      type,
      name: typeof first.name === 'string' ? first.name : type,
      mimeType,
      dataUrl: `data:${mimeType};base64,${chunks.map((chunk) => chunk.data).join('')}`,
    });
  }

  async resolveImageReference(sessionId: string, path: string) {
    return await this.sendCommand({
      type: 'reference.resolve',
      sessionId,
      payload: { kind: 'image', path },
    }) as Record<string, unknown>;
  }

  async createPreview(url: string) {
    const result = await this.sendCommand({ type: 'preview.create', payload: { url } }) as Record<string, unknown>;
    const shareId = stringOrNull(result?.shareId);
    const path = stringOrNull(result?.path) || '/';
    if (!this.savedConnection || !shareId) throw new Error('Could not create the preview');
    return previewHttpUrl(
      this.savedConnection.relayOrigin,
      this.savedConnection.runtimeId,
      shareId,
      path,
    );
  }

  private async connect() {
    if (!this.enabled || !this.active || this.socket || this.connecting) return;
    this.connecting = true;
    const trace: ConnectTrace | null = !this.pairing && this.savedConnection
      ? this.connectTrace || {
          startedAt: Date.now(),
          socketStartedAt: 0,
          helloStartedAt: 0,
          attempts: this.reconnectAttempt,
          trigger: this.connectTrigger,
          refreshMs: 0,
          socketMs: 0,
          helloMs: 0,
        }
      : null;
    if (trace) trace.attempts = this.reconnectAttempt;
    this.connectTrace = trace;
    if (!this.pairing && this.savedConnection && this.savedConnection.accessExpiresAt <= Date.now()) {
      this.setState({ ...this.state, phase: 'connecting', error: null });
      const refreshStartedAt = Date.now();
      const refreshed = await this.refreshAccess();
      if (trace) trace.refreshMs += Date.now() - refreshStartedAt;
      if (!refreshed) {
        this.connecting = false;
        return;
      }
    }
    if (!this.enabled || !this.active) {
      this.connecting = false;
      return;
    }
    const relayOrigin = this.pairing?.relayOrigin || this.savedConnection?.relayOrigin;
    const runtimeId = this.pairing?.runtimeId || this.savedConnection?.runtimeId;
    if (!relayOrigin || !runtimeId) {
      this.connecting = false;
      return;
    }
    this.setState({ ...this.state, phase: 'connecting', error: null });
    diagnostic('relay.connecting', { mode: this.pairing ? 'pairing' : 'mobile', attempt: this.reconnectAttempt });
    if (trace) trace.socketStartedAt = Date.now();
    const socket = new WebSocket(relayWebSocketUrl(relayOrigin, runtimeId));
    this.socket = socket;
    this.connecting = false;
    this.armConnectTimer(socket);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (trace) {
        trace.socketMs += Date.now() - trace.socketStartedAt;
        trace.socketStartedAt = 0;
        trace.helloStartedAt = Date.now();
      }
      diagnostic('relay.opened', { mode: this.pairing ? 'pairing' : 'mobile' });
      const hello = this.pairing
        ? {
            kind: 'hello.pair',
            protocolVersion: PROTOCOL_VERSION,
            pairingToken: this.pairing.pairingToken,
            device: {
              id: this.deviceId,
              name: 'CodeAgentSwarm Mobile',
              publicKey: this.pairingKeys?.publicKey,
            },
          }
        : {
            kind: 'hello.mobile',
            protocolVersion: PROTOCOL_VERSION,
            ticket: this.savedConnection?.deviceToken,
          };
      this.sendRelay(hello);
    };
    socket.onmessage = (event) => this.handleRelayMessage(socket, event.data);
    socket.onerror = () => diagnostic('relay.socket_error');
    socket.onclose = (event) => this.handleClose(socket, event);
  }

  private async handleRelayMessage(socket: WebSocket, raw: unknown) {
    if (this.socket !== socket) return;
    if (raw === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    const text = typeof raw === 'string' ? raw : String(raw);
    let message: RuntimeEnvelope;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const awaitingWelcome = Boolean(this.savedConnection && this.runtimeOnline && this.state.phase === 'connecting');
    if (message.kind !== 'relay.error'
      && message.kind !== 'pair.rejected'
      && message.kind !== 'runtime.online'
      && message.kind !== 'runtime.message'
      && !awaitingWelcome) {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.startHeartbeat(socket);
    }
    if (message.kind === 'pair.challenge') {
      diagnostic('pair.challenge_received');
      const pairingId = stringOrNull(message.pairingId);
      if (!pairingId || !this.pairing || !this.pairingKeys) return this.fail('The pairing could not be verified');
      const advertisedKey = stringOrNull(message.desktopPublicKey);
      if (advertisedKey !== this.pairing.desktopPublicKey) return this.fail('The host identity has changed');
      this.setState({
        ...this.state,
        phase: 'confirming',
        challengeCode: verificationCode(
          this.pairingKeys.secretKey,
          this.pairing.desktopPublicKey,
          pairingId,
        ),
        challengeExpiresAt: Number(message.expiresAt) || null,
        error: null,
      });
      return;
    }
    if (message.kind === 'pair.completed') {
      const pairing = this.pairing;
      const pairingKeys = this.pairingKeys;
      const token = stringOrNull(message.deviceToken);
      const runtimeId = stringOrNull(message.runtimeId);
      const accessExpiresAt = Number(message.accessExpiresAt);
      let refreshToken: string | null = null;
      try {
        refreshToken = stringOrNull(decryptJson(
          recordOrNull(message.refreshTokenBox),
          pairingKeys?.secretKey || '',
          pairing?.desktopPublicKey || '',
        )?.refreshToken);
      } catch {
        refreshToken = null;
      }
      if (!token
        || !refreshToken
        || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)
        || !runtimeId
        || !Number.isFinite(accessExpiresAt)
        || accessExpiresAt <= Date.now()
        || !pairing
        || !pairingKeys) return this.fail('The pairing could not be completed');
      const savedConnection = {
        relayOrigin: pairing.relayOrigin,
        backendOrigin: pairing.backendOrigin,
        deviceToken: token,
        refreshToken,
        accessExpiresAt,
        runtimeId,
        publicKey: pairingKeys.publicKey,
        secretKey: pairingKeys.secretKey,
        desktopPublicKey: pairing.desktopPublicKey,
      };
      let pendingRevocation: PendingDeviceRevocation | null;
      try {
        const result = await withPairingStorageLock(async () => {
          const isolatedStorage = Platform.OS === 'web' || Boolean(this.storageScope);
          const replacedConnection = isolatedStorage
            ? await loadSavedConnection(this.storageScope)
            : this.savedConnection;
          if (isolatedStorage) {
            if (this.savedConnection && !replacedConnection) {
              throw new Error('The current computer could not be verified');
            }
            const existingRevocation = await loadPendingDeviceRevocation(this.storageScope);
            if (existingRevocation === undefined) throw new Error('The previous computer could not be verified');
            if (existingRevocation) {
              const action = classifyPendingDeviceRevocation(existingRevocation, replacedConnection);
              if (action === 'wait') throw new Error('The previous computer could not be verified');
              if (action === 'revoke' && !await revokeMobileDevice(existingRevocation)) {
                throw new Error('The previous computer could not be disconnected');
              }
              if (!await this.pendingRevocationWriter.set({
                revocation: null,
                expectedId: existingRevocation.id,
              })) throw new Error('The paired computer changed');
            }
          }
          const nextRevocation: PendingDeviceRevocation | null = replacedConnection
            && replacedConnection.refreshToken !== savedConnection.refreshToken
            ? {
                id: Crypto.randomUUID(),
                backendOrigin: replacedConnection.backendOrigin,
                refreshToken: replacedConnection.refreshToken,
                replacementRuntimeId: savedConnection.runtimeId,
            }
            : null;
          if (nextRevocation
            && !await this.pendingRevocationWriter.set({ revocation: nextRevocation })) {
            throw new Error('The paired computer changed');
          }
          const current = await this.connectionWriter.set({ connection: savedConnection });
          if (current) this.savedConnection = savedConnection;
          if (!current
            || !this.enabled
            || this.socket !== socket
            || this.pairing !== pairing
            || this.pairingKeys !== pairingKeys) {
            return { persisted: false, connectionCommitted: current, pendingRevocation: nextRevocation };
          }
          return { persisted: true, connectionCommitted: true, pendingRevocation: nextRevocation };
        });
        pendingRevocation = result.pendingRevocation;
        if (result.connectionCommitted && pendingRevocation) {
          void this.retryPendingDeviceRevocation(pendingRevocation);
        }
        if (!result.persisted) return;
      } catch {
        void revokeMobileDevice(savedConnection);
        return this.fail('The pairing could not be saved');
      }
      this.savedConnection = savedConnection;
      await this.clearRuntimeData();
      this.setState({ ...emptyCache(), runtimeId: savedConnection.runtimeId, phase: 'connecting', challengeCode: null, challengeExpiresAt: null, error: null });
      diagnostic('pair.completed', { connection: connectionRef(message.connection) });
      this.pairing = null;
      this.pairingKeys = null;
      this.connectTrace = {
        startedAt: Date.now(),
        socketStartedAt: 0,
        helloStartedAt: Date.now(),
        attempts: 0,
        trigger: 'pair',
        refreshMs: 0,
        socketMs: 0,
        helloMs: 0,
      };
      this.scheduleAccessRefresh();
      if (this.runtimeOnline) this.sendRuntimeHello();
      return;
    }
    if (message.kind === 'hello.accepted') {
      diagnostic('relay.authenticated', {
        role: stringOrNull(message.role) || 'mobile',
        connection: connectionRef(message.connection),
      });
      if (this.savedConnection) this.scheduleAccessRefresh();
      return;
    }
    if (message.kind === 'credential.renewed') {
      const accessExpiresAt = Number(message.accessExpiresAt);
      if (!this.savedConnection
        || !Number.isFinite(accessExpiresAt)
        || Math.abs(accessExpiresAt - this.savedConnection.accessExpiresAt) > 2_000) return;
      if (this.credentialRenewTimer) clearTimeout(this.credentialRenewTimer);
      this.credentialRenewTimer = null;
      diagnostic('credential.relay_renewed');
      this.scheduleAccessRefresh();
      return;
    }
    if (message.kind === 'runtime.online') {
      diagnostic('runtime.online');
      this.runtimeOnline = true;
      this.armConnectTimer(socket);
      this.startHeartbeat(socket);
      if (this.savedConnection) this.sendRuntimeHello();
      return;
    }
    if (message.kind === 'runtime.offline') {
      diagnostic('runtime.offline');
      this.runtimeOnline = false;
      this.resyncPending = false;
      this.subscriptionsSupported = false;
      this.setState({ ...this.state, phase: 'offline', challengeCode: null, challengeExpiresAt: null, error: null });
      return;
    }
    if (message.kind === 'runtime.message') {
      if (!this.savedConnection) return;
      try {
        const runtimeMessage = decryptJson(
          recordOrNull(message.box),
          this.savedConnection.secretKey,
          this.savedConnection.desktopPublicKey,
          stringOrNull(message.codec),
        );
        if (runtimeMessage?.kind === 'welcome') {
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.startHeartbeat(socket);
        this.handleRuntimeMessage(runtimeMessage, text.length);
      } catch {
        this.fail('The relay sent a message that could not be verified');
      }
      return;
    }
    if (message.kind === 'relay.error' || message.kind === 'pair.rejected') {
      const code = stringOrNull(message.code);
      diagnostic('relay.rejected', { code: code || message.kind });
      if (this.savedConnection
        && this.credentialRenewTimer
        && (code === 'unsupported_message' || code === 'invalid_credential_renewal')) {
        clearTimeout(this.credentialRenewTimer);
        this.credentialRenewTimer = null;
        diagnostic('credential.relay_renew_fallback', { code });
        this.disconnectSocket();
        void this.connect();
        return;
      }
      if (this.savedConnection && (code === 'invalid_relay_ticket' || code === 'mobile_token_expired')) {
        this.disconnectSocket();
        void this.connect();
        return;
      }
      this.fail(stringOrNull(message.message) || (message.kind === 'pair.rejected'
        ? 'The host rejected the pairing'
        : 'Could not connect to the relay'));
    }
  }

  private handleRuntimeMessage(message: RuntimeEnvelope | null, rawBytes = 0) {
    if (!message) return;
    if (message.kind === 'command.accepted') {
      this.acceptCommand(message);
      return;
    }
    if (message.kind === 'command.result') {
      this.resolveCommand(message);
      return;
    }
    if (message.kind === 'session.closed') {
      for (const [commandId, pending] of this.pendingCommands) {
        if (pending.message.command.type !== 'session.stop' || pending.message.command.sessionId !== message.sessionId) continue;
        clearTimeout(pending.timer);
        if (pending.ackTimer) clearTimeout(pending.ackTimer);
        this.pendingCommands.delete(commandId);
        this.reportCommandTimeline(pending, true);
        diagnostic('command.completed');
        pending.resolve({ stopped: true });
      }
    }
    const result = applyRuntimeEnvelope(this.state, message);
    if (result.gap) {
      if (!this.resyncPending) {
        this.resyncPending = true;
        this.sendRuntimeHello(false);
      }
      return;
    }
    if (message.kind === 'welcome') {
      this.resyncPending = false;
      this.subscriptionsSupported = Array.isArray(message.features)
        && message.features.includes(SESSION_SUBSCRIPTIONS_FEATURE);
    }
    const shouldAlert = message.kind === 'session.identity.updated' || message.kind === 'session.opened';
    const alerts = shouldAlert ? newlyAttentiveSessions(this.state.sessions, result.cache.sessions) : [];
    this.setState({
      ...this.state,
      ...result.cache,
      phase: message.kind === 'welcome' ? 'online' : this.state.phase,
      challengeCode: null,
      challengeExpiresAt: null,
      error: null,
    });
    if (message.kind === 'provider.login.event') {
      for (const listener of this.envelopeListeners) listener(message);
    }
    if (message.kind === 'command.completed') this.resolveCommand(message);
    if (alerts.length) void this.presentLocalFallback(alerts);
    this.schedulePersist();
    if (message.kind === 'welcome') {
      const desktop = recordOrNull(message.desktop);
      this.desktopVersion = stringOrNull(desktop?.version);
      this.desktopChannel = stringOrNull(desktop?.channel);
      diagnostic('runtime.synced', { sessions: result.cache.sessions.length, lastSeq: result.cache.lastSeq });
      if (message.reset === true && this.visibleSessionId && this.subscriptionsSupported) void this.hydrateVisibleSession(this.visibleSessionId);
      if (this.savedConnection) void this.registerRemotePush(this.savedConnection);
      this.reconnectAttempt = 0;
      this.reportReconnectTimeline(message.reset === true, rawBytes, message.builtMs);
      for (const [commandId, pending] of this.pendingCommands) {
        if (pending.attempts > 0 && NON_REPLAYABLE_COMMANDS.has(pending.message.command.type)) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(commandId);
          this.reportCommandTimeline(pending, false);
          pending.reject(new Error('The request was interrupted while reconnecting. Try again.'));
          continue;
        }
        this.sendPendingCommand(pending);
      }
    }
  }

  // Fire-and-forget measurement of how long "reconnecting" really lasted. snapshotBytes is the
  // raw relay frame that carried the welcome, the closest cheap proxy for the snapshot size.
  // builtMs, when the desktop reports it, is the part of helloMs the desktop itself spent.
  private reportReconnectTimeline(reset: boolean, snapshotBytes: number, builtMs?: unknown) {
    const trace = this.connectTrace;
    this.connectTrace = null;
    this.connectTrigger = 'retry';
    if (!trace) return;
    const connection = this.savedConnection;
    const now = Date.now();
    const desktopMs = typeof builtMs === 'number' && Number.isFinite(builtMs) && builtMs >= 0 ? builtMs : undefined;
    const payload = reconnectTimelinePayload({
      trigger: trace.trigger,
      platform: Platform.OS,
      totalMs: now - trace.startedAt,
      refreshMs: trace.refreshMs,
      socketMs: trace.socketMs,
      helloMs: trace.helloMs + (trace.helloStartedAt ? now - trace.helloStartedAt : 0),
      attempts: trace.attempts,
      reset,
      snapshotBytes,
      ...(desktopMs === undefined ? {} : { desktopMs }),
      ...this.telemetryMetadata(),
    });
    diagnostic('reconnect.timeline', payload);
    if (connection) this.reportTelemetry(payload);
  }

  private acceptCommand(message: RuntimeEnvelope) {
    const commandId = stringOrNull(message.commandId);
    const pending = commandId ? this.pendingCommands.get(commandId) : null;
    if (!pending) return;
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    pending.ackTimer = null;
    if (pending.ackMs === null) pending.ackMs = Date.now() - pending.startedAt;
    diagnostic('command.accepted', {
      type: pending.message.command.type,
      ackMs: pending.ackMs,
      attempts: pending.attempts,
    });
  }

  private sendPendingCommand(pending: PendingCommand) {
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    if (!this.sendRuntime(pending.message)) return false;
    pending.attempts += 1;
    // Large direct reads cannot replay; large upload frames use heartbeat + the 45s command timeout.
    if (NON_REPLAYABLE_COMMANDS.has(pending.message.command.type) || pending.message.command.type === 'attachment.chunk') return true;
    const timer = setTimeout(() => {
      if (this.pendingCommands.get(pending.message.commandId) !== pending || pending.ackTimer !== timer) return;
      pending.ackTimer = null;
      diagnostic('command.ack_timeout', {
        type: pending.message.command.type,
        attempts: pending.attempts,
      });
      this.reconnectNow('command_timeout');
    }, COMMAND_ACK_TIMEOUT_MS);
    pending.ackTimer = timer;
    return true;
  }

  private reportCommandTimeline(pending: PendingCommand, success: boolean) {
    const payload = commandTimelinePayload({
      platform: Platform.OS,
      commandType: pending.message.command.type,
      totalMs: Date.now() - pending.startedAt,
      ackMs: pending.ackMs,
      attempts: pending.attempts,
      success,
      ...this.telemetryMetadata(),
    });
    diagnostic('command.timeline', payload);
    this.reportTelemetry(payload);
  }

  private telemetryMetadata() {
    const constants = Constants as typeof Constants & {
      platform?: { ios?: { buildNumber?: string }; android?: { versionCode?: number } };
    };
    const mobileVersion = stringOrNull(constants.expoConfig?.version);
    const nativeBuild = Platform.OS === 'ios'
      ? constants.platform?.ios?.buildNumber
      : constants.platform?.android?.versionCode;
    return {
      ...(mobileVersion ? { mobileVersion } : {}),
      ...(nativeBuild === undefined || nativeBuild === null ? {} : { mobileBuild: String(nativeBuild) }),
      ...(this.desktopVersion ? { desktopVersion: this.desktopVersion } : {}),
      ...(this.desktopChannel ? { channel: this.desktopChannel } : {}),
    };
  }

  private reportTelemetry(payload: Record<string, unknown>) {
    const connection = this.savedConnection;
    if (!connection) return;
    void withTimeout(fetch(`${connection.backendOrigin}/api/mobile/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.deviceToken}`,
      },
      body: JSON.stringify(payload),
    }), 10_000).catch(() => diagnostic('telemetry.send_failed'));
  }

  private resolveCommand(message: RuntimeEnvelope) {
    const commandId = stringOrNull(message.commandId);
    const pending = commandId ? this.pendingCommands.get(commandId) : null;
    if (!commandId || !pending) return;
    clearTimeout(pending.timer);
    if (pending.ackTimer) clearTimeout(pending.ackTimer);
    this.pendingCommands.delete(commandId);
    this.reportCommandTimeline(pending, message.success === true);
    if (message.success === true) {
      diagnostic('command.completed');
      this.retainInitialHistoryPage(pending.message.command, message.result);
      pending.resolve(message.result);
    } else {
      diagnostic('command.failed');
      const structuredError = recordOrNull(message.error);
      pending.reject(new Error(
        stringOrNull(message.error)
        || stringOrNull(structuredError?.message)
        || 'The command failed',
      ));
    }
  }

  private retainInitialHistoryPage(command: RuntimeCommand, value: unknown) {
    if (command.type !== 'history.older' || Number.isSafeInteger(command.payload?.before) || !command.sessionId) return;
    const result = recordOrNull(value);
    const loaded = (Array.isArray(result?.items) ? result.items : []).filter((item): item is RuntimeItem => (
      Boolean(stringOrNull(recordOrNull(item)?.itemId))
    ));
    const index = this.state.sessions.findIndex((session) => session.sessionId === command.sessionId);
    if (!loaded.length || index < 0) return;
    const session = this.state.sessions[index];
    const items = Array.from(new Map(
      [...loaded, ...session.items].map((item) => [item.itemId, item]),
    ).values());
    if (items.length === session.items.length) return;
    const sessions = [...this.state.sessions];
    sessions[index] = { ...session, items };
    this.setState({ ...this.state, sessions });
    this.schedulePersist();
    diagnostic('history.cached', { sessionId: command.sessionId, loaded: loaded.length, total: items.length });
  }

  private sendRuntimeHello(withCursor = true) {
    const cursor = withCursor && this.state.runtimeId && this.state.lastSeq > 0
      ? { runtimeId: this.state.runtimeId, seq: this.state.lastSeq }
      : undefined;
    this.sendRuntime({
      kind: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      accepts: HELLO_ACCEPTS,
      features: [SESSION_SUBSCRIPTIONS_FEATURE],
      subscriptions: this.visibleSessionId ? [this.visibleSessionId] : [],
      ...(cursor ? { cursor } : {}),
    });
  }

  private sendRuntime(payload: Record<string, unknown>) {
    if (!this.savedConnection) return false;
    return this.sendRelay({
      kind: 'runtime.message',
      box: encryptJson(payload, this.savedConnection.secretKey, this.savedConnection.desktopPublicKey),
    });
  }

  private sendRelay(message: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private handleClose(socket: WebSocket, event?: CloseEvent) {
    if (this.socket !== socket) return;
    const now = Date.now();
    if (this.connectTrace?.socketStartedAt) {
      this.connectTrace.socketMs += now - this.connectTrace.socketStartedAt;
      this.connectTrace.socketStartedAt = 0;
    }
    if (this.connectTrace?.helloStartedAt) {
      this.connectTrace.helloMs += now - this.connectTrace.helloStartedAt;
      this.connectTrace.helloStartedAt = 0;
    }
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.stopHeartbeat();
    if (this.credentialRenewTimer) clearTimeout(this.credentialRenewTimer);
    this.credentialRenewTimer = null;
    this.socket = null;
    diagnostic('relay.closed', {
      reconnecting: this.enabled && Boolean(this.savedConnection || this.pairing),
      phase: this.state.phase,
      runtimeOnline: this.runtimeOnline,
      ...(event ? { closeCode: event.code, clean: event.wasClean } : {}),
    });
    this.runtimeOnline = false;
    this.resyncPending = false;
    this.subscriptionsSupported = false;
    if (this.pairing) {
      this.pairing = null;
      this.pairingKeys = null;
      this.setState({
        ...this.state,
        phase: this.savedConnection ? 'offline' : 'unpaired',
        challengeCode: null,
        challengeExpiresAt: null,
        error: 'The connection was closed. Scan a new QR code.',
      });
      if (this.savedConnection && this.enabled && this.active) this.scheduleReconnect();
      return;
    }
    if (!this.enabled || (!this.savedConnection && !this.pairing)) return;
    // Keep the trigger that started this reconnection chain (resume, heartbeat_timeout, …)
    // across failed attempts; only a healthy connection dying starts a new 'close' chain.
    if (this.connectTrigger === 'retry') this.noteReconnectTrigger('close');
    this.setState({ ...this.state, phase: this.state.sessions.length ? 'offline' : 'connecting' });
    this.scheduleReconnect();
  }

  private armConnectTimer(socket: WebSocket) {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      const payload = {
        event: 'reconnect.timeout',
        trigger: this.connectTrace?.trigger || this.connectTrigger,
        platform: Platform.OS,
        phase: this.runtimeOnline ? 'welcome' : 'socket',
        totalMs: this.connectTrace ? Date.now() - this.connectTrace.startedAt : CONNECT_DEADLINE_MS,
        attempts: this.reconnectAttempt,
        ...this.telemetryMetadata(),
      };
      diagnostic('reconnect.timeout', payload);
      this.reportTelemetry(payload);
      this.handleClose(socket);
      try { socket.close(); } catch { /* native WebSocket may already be gone */ }
    }, CONNECT_DEADLINE_MS);
  }

  private refreshAccess() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performAccessRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performAccessRefresh() {
    const persistedConnection = await loadSavedConnection(this.storageScope);
    const connection = persistedConnection || (Platform.OS === 'web' || this.storageScope ? null : this.savedConnection);
    if (!this.enabled) return false;
    if (!connection) {
      this.savedConnection = null;
      this.disconnectSocket();
      this.setState({ ...emptyCache(), phase: 'unpaired', challengeCode: null, challengeExpiresAt: null, error: null });
      return false;
    }
    this.savedConnection = connection;
    diagnostic('credential.refresh_started');
    try {
      const response = await withTimeout(fetch(`${connection.backendOrigin}/api/mobile/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: connection.refreshToken }),
      }), 10_000);
      if (response.status === 401) {
        const replacement = await loadSavedConnection(this.storageScope);
        if (replacement && replacement.refreshToken !== connection.refreshToken) {
          this.savedConnection = replacement;
          diagnostic('credential.refresh_superseded');
          this.applyRefreshedCredential(replacement);
          return true;
        }
        if (!this.enabled || this.savedConnection !== connection) return false;
        diagnostic('credential.revoked');
        this.savedConnection = null;
        await this.connectionWriter.set({
          connection: null,
          expectedRefreshToken: connection.refreshToken,
        }).catch(() => {});
        this.disconnectSocket();
        this.setState({
          ...emptyCache(),
          phase: 'unpaired',
          challengeCode: null,
          challengeExpiresAt: null,
          error: 'This device has been revoked. Scan the QR code again to reconnect it.',
        });
        return false;
      }
      if (!response.ok) throw new Error('Mobile credential refresh failed');
      const refreshed = await response.json() as Record<string, unknown>;
      const deviceToken = stringOrNull(refreshed.deviceToken);
      const refreshToken = stringOrNull(refreshed.refreshToken);
      const accessExpiresAt = Number(refreshed.expiresAt);
      if (!deviceToken
        || !refreshToken
        || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)
        || !Number.isFinite(accessExpiresAt)
        || accessExpiresAt <= Date.now()) throw new Error('Invalid refreshed mobile credential');
      if (!this.enabled || this.savedConnection !== connection) return false;
      const refreshedConnection = { ...connection, deviceToken, refreshToken, accessExpiresAt };
      const current = await withPairingStorageLock(async () => {
        const isolatedStorage = Platform.OS === 'web' || Boolean(this.storageScope);
        const persistedConnection = isolatedStorage
          ? await loadSavedConnection(this.storageScope)
          : this.savedConnection;
        if (isolatedStorage && this.savedConnection && !persistedConnection) {
          throw new Error('The current computer could not be verified');
        }
        if (!this.enabled
          || this.savedConnection !== connection
          || persistedConnection?.refreshToken !== connection.refreshToken) return false;
        const persisted = await this.connectionWriter.set({ connection: refreshedConnection });
        if (!persisted || this.savedConnection !== connection) return false;
        this.savedConnection = refreshedConnection;
        return true;
      });
      if (!current) return false;
      diagnostic('credential.refresh_completed');
      void this.registerRemotePush(refreshedConnection);
      this.applyRefreshedCredential(refreshedConnection);
      return true;
    } catch {
      diagnostic('credential.refresh_failed');
      if (this.savedConnection) {
        const socketStillValid = Boolean(
          this.socket
          && this.socket.readyState === 1
          && this.savedConnection.accessExpiresAt > Date.now(),
        );
        if (socketStillValid) {
          diagnostic('credential.refresh_retry_scheduled', { delay: ACCESS_REFRESH_RETRY_MS });
          this.scheduleAccessRefresh(ACCESS_REFRESH_RETRY_MS);
        } else {
          if (this.socket) this.disconnectSocket();
          this.setState({ ...this.state, phase: 'offline', error: 'Could not renew the connection. Retrying…' });
          this.scheduleReconnect();
        }
      }
      return false;
    }
  }

  private applyRefreshedCredential(connection: SavedConnection) {
    if (!this.enabled || this.savedConnection !== connection) return;
    if (!this.socket || this.socket.readyState !== 1) {
      this.scheduleAccessRefresh();
      return;
    }
    const socket = this.socket;
    diagnostic('credential.relay_renew_started');
    try {
      socket.send(JSON.stringify({
        kind: 'credential.renew',
        protocolVersion: PROTOCOL_VERSION,
        ticket: connection.deviceToken,
      }));
    } catch {
      this.handleClose(socket);
      return;
    }
    if (this.credentialRenewTimer) clearTimeout(this.credentialRenewTimer);
    this.credentialRenewTimer = setTimeout(() => {
      this.credentialRenewTimer = null;
      if (this.socket !== socket || this.savedConnection !== connection) return;
      diagnostic('credential.relay_renew_timeout');
      this.disconnectSocket();
      void this.connect();
    }, RELAY_CREDENTIAL_RENEW_TIMEOUT_MS);
  }

  private scheduleAccessRefresh(delayOverride?: number) {
    if (!this.savedConnection) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = delayOverride ?? Math.max(
      0,
      this.savedConnection.accessExpiresAt - Date.now() - ACCESS_REFRESH_LEAD_MS,
    );
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAccess();
    }, delay);
  }

  private registerRemotePush(connection: SavedConnection) {
    const registration = registerPushToken(connection).then((registered) => {
      if (this.savedConnection === connection) this.remotePushRegistered = registered;
      return registered;
    });
    this.pushRegistration = registration;
    return registration;
  }

  private async presentLocalFallback(sessions: RuntimeSession[]) {
    const alerts = this.storageScope
      ? sessions.map((session) => ({
        ...session,
        sessionId: `${this.storageScope!.length}:${this.storageScope}${session.sessionId}`,
        title: `${session.title?.trim() || 'CodeAgentSwarm'} · ${this.state.computerName || (this.state.hostKind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop')}`,
      }))
      : sessions;
    if (!this.remotePushRegistered) await presentSessionAlerts(alerts);
  }

  private scheduleReconnect() {
    if (!this.enabled || !this.active || !this.savedConnection || this.reconnectTimer) return;
    if (!this.connectTrace) {
      this.connectTrace = {
        startedAt: Date.now(),
        socketStartedAt: 0,
        helloStartedAt: 0,
        attempts: this.reconnectAttempt,
        trigger: this.connectTrigger,
        refreshMs: 0,
        socketMs: 0,
        helloMs: 0,
      };
    }
    const attempt = this.reconnectAttempt++;
    const delay = attempt === 0 && !this.connecting
      ? 0
      : Math.min(8_000, 400 * (2 ** Math.max(0, attempt - 1)));
    diagnostic('relay.reconnect_scheduled', { delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startHeartbeat(socket: WebSocket) {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.pingSocket(socket), HEARTBEAT_INTERVAL_MS);
  }

  private pingSocket(socket: WebSocket) {
    if (this.socket !== socket || socket.readyState !== 1) {
      this.stopHeartbeat();
      return;
    }
    if (this.pongTimer) return;
    try {
      socket.send('ping');
    } catch {
      this.handleClose(socket);
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.socket !== socket) return;
      diagnostic('relay.heartbeat_timeout');
      this.handleClose(socket);
      // More specific than the close it just triggered, so it wins the pending reconnect.
      this.noteReconnectTrigger('heartbeat_timeout');
      try { socket.close(); } catch { /* native WebSocket may already be gone */ }
    }, HEARTBEAT_PONG_TIMEOUT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }

  private disconnectSocket() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.credentialRenewTimer) clearTimeout(this.credentialRenewTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.stopHeartbeat();
    this.refreshTimer = null;
    this.credentialRenewTimer = null;
    this.resyncPending = false;
    this.subscriptionsSupported = false;
    for (const pending of this.pendingCommands.values()) {
      if (pending.ackTimer) clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private fail(error: string) {
    diagnostic('client.failed', { reason: error });
    const pairingFailed = Boolean(this.pairing);
    this.pairing = null;
    this.pairingKeys = null;
    this.disconnectSocket();
    this.connectTrace = null;
    this.setState({ ...this.state, phase: this.savedConnection ? 'offline' : 'unpaired', error });
    if (pairingFailed && this.savedConnection && this.enabled && this.active) this.scheduleReconnect();
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private flushPersist() {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistNow();
  }

  private persistNow() {
    void this.runtimeCacheWriter.set({
      runtimeId: this.state.runtimeId,
      computerName: this.state.computerName,
      hostKind: this.state.hostKind,
      hostPlatform: this.state.hostPlatform,
      capabilities: this.state.capabilities,
      lastSeq: this.state.lastSeq,
      sessions: this.state.sessions,
      projects: this.state.projects,
      shortcuts: this.state.shortcuts,
      availableAgents: this.state.availableAgents,
      quotas: this.state.quotas,
      terminalStatuses: this.state.terminalStatuses,
      projectRoots: this.state.projectRoots,
    });
  }

  private async clearRuntimeData() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await Promise.all([
      this.runtimeCacheWriter.set(null),
      clearMobileHistory(this.storageScope),
      invalidateTaskCache(this.storageScope),
      ...(this.storageScope ? [] : [savePendingSends({})]),
    ]);
  }

  private setState(state: MobileRuntimeState) {
    if (state.phase !== this.state.phase) diagnostic('state.changed', { from: this.state.phase, to: state.phase });
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
