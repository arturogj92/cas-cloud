import type { RuntimeSession } from './protocol';
import { splitHostScopedId } from './host-scope';
import type { PendingSendCache, PersistedPendingSend } from './storage';

export function isPendingSendInFlight(entry: PersistedPendingSend) {
  return !entry.queued && !entry.delivered && !entry.failed;
}

export function selectNextPendingDrain(
  pendingSends: PendingSendCache,
  sendableSessionIds: ReadonlySet<string>,
) {
  return Object.entries(pendingSends)
    .filter(([sessionId, entries]) => (
      sendableSessionIds.has(sessionId)
      && !entries.some(isPendingSendInFlight)
    ))
    .flatMap(([sessionId, entries]) => entries
      .filter((entry) => entry.queued && !entry.delivered && !entry.confirmed && !entry.failed)
      .map((entry) => ({ sessionId, entry })))
    .sort((left, right) => (left.entry.createdAtMs || 0) - (right.entry.createdAtMs || 0))[0];
}

export function migratePendingSendSessions(
  current: PendingSendCache,
  sessions: ReadonlyArray<Pick<RuntimeSession, 'sessionId' | 'clientRequestId' | 'state'>>,
  allowLegacySessionIds = true,
) {
  const destinations = new Map<string, string | null>();
  for (const session of sessions) {
    const legacySessionId = splitHostScopedId(session.sessionId)?.value;
    for (const sourceId of [session.clientRequestId, allowLegacySessionIds ? legacySessionId : null]) {
      if (!sourceId || sourceId === session.sessionId) continue;
      const destination = session.state === 'stopped' ? null : session.sessionId;
      if (!destinations.has(sourceId)) destinations.set(sourceId, destination);
      else if (destinations.get(sourceId) !== destination) destinations.set(sourceId, null);
    }
  }
  let next = current;
  for (const [sourceId, sessionId] of destinations) {
    const queued = next[sourceId];
    if (!sessionId || !queued?.length) continue;
    if (next === current) next = { ...current };
    delete next[sourceId];
    const merged = new Map((next[sessionId] || [])
      .map((entry) => [entry.id, entry] as const));
    for (const entry of queued) merged.set(entry.id, entry);
    next[sessionId] = [...merged.values()]
      .sort((left, right) => (left.createdAtMs || 0) - (right.createdAtMs || 0));
  }
  return next;
}
