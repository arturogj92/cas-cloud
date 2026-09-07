import {
  MobileRuntimeClient,
  parsePairingUri,
  normalizePairingCode,
  type MobileRuntimeState,
  type RuntimeCommand,
  type RuntimeEnvelope,
  type RuntimeHistoryConversation,
  type RuntimeHost,
  type RuntimeProject,
  type RuntimeProjectRoot,
  type RuntimeSession,
  type RuntimeShortcut,
} from './runtime';
import {
  clearRuntimeCache,
  clearSavedConnection,
  loadRuntimeCache,
  loadPendingDeviceRevocation,
  loadSavedConnection,
  loadConnectionIds,
  saveRuntimeCache,
  saveMobileNotificationsEnabled,
  savePendingDeviceRevocation,
  saveSavedConnection,
  clearPendingDeviceRevocation,
  removeMobileHistoryHost,
  updateConnectionIds,
} from './storage';
import type { MobileAttachment } from './mobile-attachments';
import { fulfilledHostRuntimeIds, hostScopedId, privatePeerRoster, scopeHostHistory, splitHostScopedId, unscopedCommand } from './host-scope';
import { diagnostic, getDiagnostics as readDiagnostics } from './diagnostics';

export { hostScopedId, mergeHostHistory, scopeHostHistory, splitHostScopedId } from './host-scope';

const DEFAULT_PAIRING_CODE_ORIGIN = process.env.EXPO_PUBLIC_MOBILE_RELAY_URL
  || 'https://codeagentswarm-connect.elcaminodelprogramadorweb.workers.dev';

type ClientFactory = (runtimeId: string) => MobileRuntimeClient;
type Child = { client: MobileRuntimeClient; state: MobileRuntimeState; unsubscribe: () => void; unsubscribeEnvelopes: () => void };

function hostName(state: MobileRuntimeState) {
  return state.computerName || (state.hostKind === 'cloud' ? 'CAS Cloud' : 'CAS Desktop');
}

function mapProject(project: RuntimeProject | null, runtimeId: string, state: MobileRuntimeState) {
  if (!project) return null;
  return {
    ...project,
    path: hostScopedId(runtimeId, project.path),
    hostRuntimeId: runtimeId,
    hostPath: project.path,
    hostName: hostName(state),
    hostKind: state.hostKind,
  };
}

function mapSession(session: RuntimeSession, runtimeId: string, state: MobileRuntimeState): RuntimeSession {
  return {
    ...session,
    sessionId: hostScopedId(runtimeId, session.sessionId),
    cwd: session.cwd ? hostScopedId(runtimeId, session.cwd) : null,
    project: mapProject(session.project, runtimeId, state),
    hostRuntimeId: runtimeId,
    hostSessionId: session.sessionId,
    hostName: hostName(state),
    hostKind: state.hostKind,
    hostPhase: state.phase,
  };
}

function mapShortcut(shortcut: RuntimeShortcut, runtimeId: string, state: MobileRuntimeState): RuntimeShortcut {
  return {
    ...shortcut,
    shortcutId: hostScopedId(runtimeId, shortcut.shortcutId),
    projectPath: hostScopedId(runtimeId, shortcut.projectPath),
    hostRuntimeId: runtimeId,
    hostName: hostName(state),
    hostKind: state.hostKind,
  };
}

function mapProjectRoot(root: RuntimeProjectRoot, runtimeId: string): RuntimeProjectRoot {
  return { ...root, hostRuntimeId: runtimeId };
}

export class WebMultiHostRuntimeClient {
  private children = new Map<string, Child>();
  private listeners = new Set<(state: MobileRuntimeState) => void>();
  private envelopeListeners = new Set<(message: RuntimeEnvelope) => void>();
  private state: MobileRuntimeState = {
    runtimeId: null, computerName: null, hostKind: 'desktop', hostPlatform: 'unknown', capabilities: [], availableAgents: [], lastSeq: 0,
    sessions: [], projects: [], shortcuts: [], quotas: [], terminalStatuses: [], projectRoots: [], phase: 'booting', challengeCode: null,
    challengeExpiresAt: null, error: null, hosts: [],
  };
  private preferredRuntimeId: string | null = null;
  private pairingRuntimeId: string | null = null;
  private peerRosterFingerprints = new Map<string, string>();
  private started = false;
  private active = true;
  private visibleSessionId: string | null = null;

  constructor(private readonly createClient: ClientFactory = (runtimeId) => new MobileRuntimeClient(runtimeId)) {}

  subscribe(listener: (state: MobileRuntimeState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  subscribeEnvelopes(listener: (message: RuntimeEnvelope) => void) {
    this.envelopeListeners.add(listener);
    return () => { this.envelopeListeners.delete(listener); };
  }

  getState() { return this.state; }
  getPairedRuntimeId() {
    return this.state.hosts?.some((host) => host.runtimeId === this.preferredRuntimeId)
      ? this.preferredRuntimeId
      : this.state.hosts?.[0]?.runtimeId || null;
  }
  getDiagnostics() { return readDiagnostics(); }

  reportSessionOpen(sessionId: string, trace: Parameters<MobileRuntimeClient['reportSessionOpen']>[1]) {
    const target = splitHostScopedId(sessionId);
    const child = target ? this.children.get(target.runtimeId) : null;
    if (target && child) child.client.reportSessionOpen(target.value, trace);
  }

  resolveSessionId(sessionId: string) {
    if (splitHostScopedId(sessionId)) return sessionId;
    if (this.children.size !== 1) return sessionId;
    const [runtimeId, child] = [...this.children.entries()][0];
    return child.state.phase !== 'booting' && child.state.sessions.some((session) => session.sessionId === sessionId)
      ? hostScopedId(runtimeId, sessionId)
      : sessionId;
  }

  setPreferredRuntimeId(runtimeId: string | null) {
    if (runtimeId && !this.children.has(runtimeId)) return;
    if (this.preferredRuntimeId === runtimeId) return;
    this.preferredRuntimeId = runtimeId;
    this.publish();
  }

  setVisibleSession(sessionId: string | null) {
    if (this.visibleSessionId === sessionId) return;
    this.visibleSessionId = sessionId;
    const target = sessionId ? splitHostScopedId(sessionId) : null;
    for (const [runtimeId, child] of this.children) {
      void child.client.setVisibleSession(target?.runtimeId === runtimeId ? target.value : null);
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    let [runtimeIds, legacy, legacyRevocation] = await Promise.all([
      loadConnectionIds(),
      loadSavedConnection(),
      loadPendingDeviceRevocation(),
    ]);
    if (legacy && !runtimeIds.includes(legacy.runtimeId)) {
      try {
        await saveSavedConnection(legacy, legacy.runtimeId);
        const legacyCache = await loadRuntimeCache();
        if (legacyCache) await saveRuntimeCache(legacyCache, legacy.runtimeId);
        runtimeIds = await updateConnectionIds((ids) => [...ids, legacy.runtimeId]);
        await Promise.allSettled([clearSavedConnection(legacy.refreshToken), clearRuntimeCache()]);
      } catch {
        // Keep the legacy keys intact so a later load can retry the migration.
      }
    }
    if (legacyRevocation && runtimeIds.includes(legacyRevocation.replacementRuntimeId)) {
      try {
        await savePendingDeviceRevocation(legacyRevocation, legacyRevocation.replacementRuntimeId);
        await clearPendingDeviceRevocation(legacyRevocation.id);
      } catch {
        // The original marker remains available for a later migration attempt.
      }
    }
    await Promise.allSettled(runtimeIds.map(async (runtimeId) => {
      const child = this.ensureChild(runtimeId);
      await child.client.start();
    }));
    diagnostic('multi_host.started', { hostCount: runtimeIds.length });
    this.preferredRuntimeId ||= runtimeIds[0] || null;
    this.publish();
  }

  stop() {
    this.started = false;
    for (const child of this.children.values()) {
      child.unsubscribe();
      child.unsubscribeEnvelopes();
      child.client.stop();
    }
    this.children.clear();
  }

  setActive(active: boolean) {
    this.active = active;
    for (const child of this.children.values()) child.client.setActive(active);
  }
  reconnectNow(trigger = 'manual') { for (const child of this.children.values()) child.client.reconnectNow(trigger); }
  async setNotificationsEnabled(enabled: boolean) {
    await saveMobileNotificationsEnabled(enabled);
    await Promise.all([...this.children.values()].map(({ client }) => client.setNotificationsEnabled(enabled)));
  }

  async pair(raw: string) {
    const pairing = parsePairingUri(raw);
    this.pairingRuntimeId = pairing.runtimeId;
    this.preferredRuntimeId = pairing.runtimeId;
    const child = this.ensureChild(pairing.runtimeId);
    await child.client.start();
    await child.client.pair(raw);
  }

  async pairCode(raw: string, origin = DEFAULT_PAIRING_CODE_ORIGIN) {
    const code = normalizePairingCode(raw);
    const target = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) || target.username || target.password) throw new Error('The pairing service is not secure');
    const response = await fetch(`${target.origin}/api/mobile/pairing-code/${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof body.pairingUri !== 'string') throw new Error('This pairing code is invalid or has expired');
    return this.pair(body.pairingUri);
  }

  cancelPairing() {
    if (!this.pairingRuntimeId) return;
    const runtimeId = this.pairingRuntimeId;
    const child = this.children.get(runtimeId);
    child?.client.cancelPairing();
    if (child?.state.phase === 'unpaired') this.removeChild(runtimeId);
    this.pairingRuntimeId = null;
    this.publish();
  }

  async forgetDevice(runtimeId = this.getPairedRuntimeId() || '') {
    const child = this.children.get(runtimeId);
    if (!child) return;
    if (child.state.phase === 'online') {
      await Promise.race([
        child.client.sendCommand({ type: 'coordination.peers.replace', payload: { peers: [] } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Peer cleanup timed out')), 2_000)),
      ]).catch(() => {});
    }
    await child.client.forgetDevice();
    this.removeChild(runtimeId);
    await removeMobileHistoryHost(runtimeId);
    this.preferredRuntimeId = [...this.children.keys()][0] || null;
    await updateConnectionIds((ids) => ids.filter((savedRuntimeId) => savedRuntimeId !== runtimeId));
    this.publish();
    void this.syncPeerRosters();
  }

  async sendCommand(command: RuntimeCommand, commandId?: string) {
    if (command.type === 'history.list') {
      const online = [...this.children.entries()].filter(([, child]) => child.state.phase === 'online');
      const results = await Promise.allSettled(online.map(async ([runtimeId, child]) => {
        const result = await child.client.sendCommand(command, commandId) as { conversations?: RuntimeHistoryConversation[] };
        const host = {
          runtimeId,
          name: hostName(child.state),
          kind: child.state.hostKind,
          phase: child.state.phase,
        };
        return {
          runtimeId,
          conversations: (result.conversations || []).map((conversation) => scopeHostHistory(conversation, host)),
        };
      }));
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const conversations = fulfilled.flatMap((result) => result.value.conversations);
      if (!conversations.length && results.length && results.every((result) => result.status === 'rejected')) throw results[0].reason;
      return { conversations, refreshedHostRuntimeIds: fulfilledHostRuntimeIds(results) };
    }
    const routed = this.routeCommand(command);
    const result = await routed.child.client.sendCommand(routed.command, commandId) as Record<string, unknown> | undefined;
    if (result && typeof result.sessionId === 'string') return { ...result, sessionId: hostScopedId(routed.runtimeId, result.sessionId) };
    return result;
  }

  sendTurn(sessionId: string, text: string, attachments: MobileAttachment[] = [], onProgress?: (progress: number) => void, commandId?: string) {
    const target = this.sessionTarget(sessionId);
    return target.child.client.sendTurn(target.sessionId, text, attachments, onProgress, commandId);
  }

  transcribeAudio(uri: string, mimeType: string, durationMs: number, sessionId?: string) {
    const child = sessionId ? this.sessionTarget(sessionId).child : this.preferredChild();
    return child.client.transcribeAudio(uri, mimeType, durationMs);
  }

  readAttachment(sessionId: string, attachmentId: string) {
    const target = this.sessionTarget(sessionId);
    return target.child.client.readAttachment(target.sessionId, attachmentId);
  }

  resolveImageReference(sessionId: string, path: string) {
    const target = this.sessionTarget(sessionId);
    return target.child.client.resolveImageReference(target.sessionId, path);
  }

  createPreview(url: string, sessionId?: string) {
    const child = sessionId ? this.sessionTarget(sessionId).child : this.preferredChild();
    return child.client.createPreview(url);
  }

  private ensureChild(runtimeId: string) {
    const existing = this.children.get(runtimeId);
    if (existing) return existing;
    const client = this.createClient(runtimeId);
    client.setActive(this.active);
    const visible = this.visibleSessionId ? splitHostScopedId(this.visibleSessionId) : null;
    void client.setVisibleSession(visible?.runtimeId === runtimeId ? visible.value : null);
    const child: Child = { client, state: client.getState(), unsubscribe: () => {}, unsubscribeEnvelopes: () => {} };
    child.unsubscribe = client.subscribe((state) => {
      child.state = state;
      if (client.getPairedRuntimeId() === runtimeId) {
        void updateConnectionIds((ids) => {
          if (ids.includes(runtimeId)) return ids;
          diagnostic('multi_host.host_saved', { hostCount: ids.length + 1 });
          return [...ids, runtimeId];
        });
      }
      if (state.phase === 'online') {
        if (this.pairingRuntimeId === runtimeId) this.pairingRuntimeId = null;
        void this.syncPeerRosters();
      } else if (state.phase === 'unpaired' && this.started && this.pairingRuntimeId !== runtimeId) {
        void updateConnectionIds((ids) => ids.filter((savedRuntimeId) => savedRuntimeId !== runtimeId));
        if (this.preferredRuntimeId === runtimeId) this.preferredRuntimeId = null;
      }
      this.publish();
    });
    child.unsubscribeEnvelopes = client.subscribeEnvelopes((message) => {
      for (const listener of this.envelopeListeners) listener({ ...message, hostRuntimeId: runtimeId });
    });
    this.children.set(runtimeId, child);
    return child;
  }

  private removeChild(runtimeId: string) {
    const child = this.children.get(runtimeId);
    if (!child) return;
    child.unsubscribe();
    child.unsubscribeEnvelopes();
    child.client.stop();
    this.children.delete(runtimeId);
    this.peerRosterFingerprints.delete(runtimeId);
  }

  private preferredChild() {
    const runtimeId = this.preferredRuntimeId;
    const child = runtimeId ? this.children.get(runtimeId) : null;
    const online = child?.state.phase === 'online' ? child : [...this.children.values()].find((candidate) => candidate.state.phase === 'online');
    if (!online) throw new Error('No connected host is available');
    return online;
  }

  private sessionTarget(sessionId: string) {
    const parsed = splitHostScopedId(sessionId);
    if (!parsed) throw new Error('This session has no host');
    const child = this.children.get(parsed.runtimeId);
    if (!child) throw new Error('This session host is no longer connected');
    this.preferredRuntimeId = parsed.runtimeId;
    return { runtimeId: parsed.runtimeId, sessionId: parsed.value, child };
  }

  private routeCommand(command: RuntimeCommand) {
    const target = unscopedCommand(command);
    const routed = target.command;
    let runtimeId = target.runtimeId || this.preferredRuntimeId;
    let child = runtimeId ? this.children.get(runtimeId) : null;
    if (!target.runtimeId && child?.state.phase !== 'online') {
      const online = [...this.children.entries()].find(([, candidate]) => candidate.state.phase === 'online');
      runtimeId = online?.[0] || null;
      child = online?.[1] || null;
    }
    if (!runtimeId || !child) throw new Error('Choose a connected host first');
    this.preferredRuntimeId = runtimeId;
    return { runtimeId, child, command: routed };
  }

  private publish() {
    const entries = [...this.children.entries()];
    const hosts: RuntimeHost[] = entries.filter(([, child]) => child.state.phase !== 'unpaired').map(([runtimeId, child]) => ({
      runtimeId,
      name: hostName(child.state),
      kind: child.state.hostKind,
      platform: child.state.hostPlatform,
      phase: child.state.phase,
      error: child.state.error,
      sessionCount: child.state.sessions.filter((session) => session.state !== 'stopped').length,
      projectCount: child.state.projects.length,
      capabilities: child.state.capabilities,
      availableAgents: child.state.availableAgents,
      terminalStatuses: child.state.terminalStatuses,
    }));
    const activeId = this.preferredRuntimeId && hosts.some((host) => host.runtimeId === this.preferredRuntimeId)
      ? this.preferredRuntimeId
      : hosts[0]?.runtimeId || null;
    const active = activeId ? this.children.get(activeId)?.state : null;
    const pairing = this.pairingRuntimeId ? this.children.get(this.pairingRuntimeId)?.state : null;
    const online = entries.some(([, child]) => child.state.phase === 'online');
    const phases = entries.map(([, child]) => child.state.phase);
    const phase = pairing && ['connecting', 'confirming'].includes(pairing.phase)
      ? pairing.phase
      : online ? 'online'
        : phases.includes('connecting') ? 'connecting'
          : phases.includes('error') ? 'error'
            : hosts.length ? 'offline' : 'unpaired';
    this.state = {
      runtimeId: activeId,
      computerName: hosts.length > 1 ? `${hosts.length} connected hosts` : active?.computerName || null,
      hostKind: active?.hostKind || 'desktop',
      hostPlatform: active?.hostPlatform || 'unknown',
      capabilities: [...new Set(entries.flatMap(([, child]) => child.state.capabilities))],
      availableAgents: [...new Set(entries.flatMap(([, child]) => child.state.availableAgents))],
      lastSeq: Math.max(0, ...entries.map(([, child]) => child.state.lastSeq)),
      sessions: entries.flatMap(([runtimeId, child]) => child.state.sessions.map((session) => mapSession(session, runtimeId, child.state))),
      projects: entries.flatMap(([runtimeId, child]) => child.state.projects.map((project) => mapProject(project, runtimeId, child.state)!)),
      shortcuts: entries.flatMap(([runtimeId, child]) => child.state.shortcuts.map((shortcut) => mapShortcut(shortcut, runtimeId, child.state))),
      quotas: entries.flatMap(([, child]) => child.state.quotas),
      terminalStatuses: active?.terminalStatuses || entries.find(([, child]) => child.state.terminalStatuses.length)?.[1].state.terminalStatuses || [],
      projectRoots: entries.flatMap(([runtimeId, child]) => child.state.projectRoots.map((root) => mapProjectRoot(root, runtimeId))),
      phase,
      challengeCode: pairing?.challengeCode || null,
      challengeExpiresAt: pairing?.challengeExpiresAt || null,
      error: !online ? entries.find(([, child]) => child.state.error)?.[1].state.error || null : null,
      hosts,
    };
    for (const listener of this.listeners) listener(this.state);
  }

  private async syncPeerRosters() {
    const descriptors = [...this.children.values()].flatMap(({ client }) => {
      const descriptor = client.getPeerDescriptor();
      return descriptor ? [descriptor] : [];
    });
    await Promise.allSettled([...this.children.entries()].map(async ([runtimeId, child]) => {
      if (child.state.phase !== 'online') return;
      const target = child.client.getPeerDescriptor();
      if (!target) return;
      const peers = privatePeerRoster(target, descriptors);
      const fingerprint = JSON.stringify(peers);
      if (this.peerRosterFingerprints.get(runtimeId) === fingerprint) return;
      this.peerRosterFingerprints.set(runtimeId, fingerprint);
      try {
        await child.client.sendCommand({ type: 'coordination.peers.replace', payload: { peers } });
        diagnostic('multi_host.private_group_synced', { hostCount: peers.length + 1 });
      } catch {
        if (this.peerRosterFingerprints.get(runtimeId) === fingerprint) this.peerRosterFingerprints.delete(runtimeId);
      }
    }));
  }
}
