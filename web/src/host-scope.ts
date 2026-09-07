import type { RuntimeCommand, RuntimeHistoryConversation, RuntimeHost } from './protocol';

export function hostScopedId(runtimeId: string, value: string) {
  return `${runtimeId.length}:${runtimeId}${value}`;
}

export function splitHostScopedId(value?: string | null) {
  if (!value) return null;
  const separator = value.indexOf(':');
  const length = Number(value.slice(0, separator));
  if (separator < 1 || !Number.isSafeInteger(length) || length < 1) return null;
  const runtimeId = value.slice(separator + 1, separator + 1 + length);
  const original = value.slice(separator + 1 + length);
  return runtimeId.length === length && original ? { runtimeId, value: original } : null;
}

export function unscopedCommand(command: RuntimeCommand) {
  let runtimeId: string | null = command.runtimeId || null;
  const routed: RuntimeCommand = { ...command, payload: command.payload ? { ...command.payload } : undefined };
  delete routed.runtimeId;
  if (routed.sessionId) {
    const target = splitHostScopedId(routed.sessionId);
    if (!target) throw new Error('This session has no host');
    if (runtimeId && runtimeId !== target.runtimeId) throw new Error('The command mixes two hosts');
    runtimeId = target.runtimeId;
    routed.sessionId = target.value;
  }
  for (const key of ['cwd', 'projectPath', 'historyId'] as const) {
    const value = routed.payload?.[key];
    if (typeof value !== 'string') continue;
    const target = splitHostScopedId(value);
    if (!target) continue;
    if (runtimeId && runtimeId !== target.runtimeId) throw new Error('The command mixes two hosts');
    runtimeId = target.runtimeId;
    routed.payload![key] = target.value;
  }
  return { runtimeId, command: routed };
}

export function scopeHostHistory(
  conversation: RuntimeHistoryConversation,
  host: Pick<RuntimeHost, 'runtimeId' | 'name' | 'kind' | 'phase'>,
): RuntimeHistoryConversation {
  return {
    ...conversation,
    id: hostScopedId(host.runtimeId, conversation.id),
    sessionId: hostScopedId(host.runtimeId, conversation.sessionId),
    projectPath: hostScopedId(host.runtimeId, conversation.projectPath),
    hostRuntimeId: host.runtimeId,
    hostName: host.name,
    hostKind: host.kind,
    hostPhase: host.phase,
  };
}

export function mergeHostHistory(
  cached: RuntimeHistoryConversation[],
  refreshed: RuntimeHistoryConversation[],
  refreshedHostRuntimeIds: string[],
) {
  const replacedHosts = new Set(refreshedHostRuntimeIds);
  const preserved = cached.filter((conversation) => (
    !conversation.hostRuntimeId || !replacedHosts.has(conversation.hostRuntimeId)
  ));
  return [...new Map([...refreshed, ...preserved].map((conversation) => [conversation.id, conversation])).values()]
    .sort((left, right) => right.timestamp - left.timestamp);
}

export function withoutHostHistory(history: RuntimeHistoryConversation[], runtimeId: string) {
  return history.filter((conversation) => conversation.hostRuntimeId !== runtimeId);
}

export function fulfilledHostRuntimeIds(results: PromiseSettledResult<{ runtimeId: string }>[]) {
  return results.flatMap((result) => result.status === 'fulfilled' ? [result.value.runtimeId] : []);
}

type PrivatePeerDescriptor = { runtimeId: string; publicKey: string; relayOrigin: string; ownerId: string; name: string };

export function tokenOwnerId(token: string) {
  try {
    const encoded = token.split('.')[1];
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const payload = JSON.parse(globalThis.atob(`${encoded.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - encoded.length % 4) % 4)}`));
    return typeof payload.sub === 'string' && payload.sub.length <= 200 ? payload.sub : null;
  } catch {
    return null;
  }
}

export function privatePeerRoster(target: PrivatePeerDescriptor, descriptors: PrivatePeerDescriptor[]) {
  return descriptors
    .filter((peer) => peer.runtimeId !== target.runtimeId
      && peer.relayOrigin === target.relayOrigin
      && peer.ownerId === target.ownerId)
    .map(({ runtimeId, publicKey, name }) => ({ runtimeId, publicKey, name }));
}
