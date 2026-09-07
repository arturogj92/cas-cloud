import type { MobileRuntimeState, RuntimeItem } from './protocol';
import type { MobileTheme } from './storage';

const WATCH_SNAPSHOT_MAX_BYTES = 50_000;

export const WATCH_AGENTS = ['codex', 'claude', 'opencode', 'kimi', 'antigravity', 'grok', 'cursor', 'pi'] as const;

export type WatchEvent =
  | { id: string; type: 'command'; action: 'refresh' }
  | { id: string; type: 'command'; action: 'loadSession'; sessionId: string }
  | { id: string; type: 'command'; action: 'createSession'; agent: typeof WATCH_AGENTS[number]; projectPath: string }
  | { id: string; type: 'command'; action: 'setStatus'; sessionId: string; status: string }
  | { id: string; type: 'command'; action: 'closeSession'; sessionId: string }
  | { id: string; type: 'audio'; sessionId: string; uri: string; mimeType: 'audio/mp4'; durationMs: number }
  | { id: string; type: 'error'; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, max: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function itemText(item: RuntimeItem) {
  const data = record(item.data);
  const value = item.content.assistant_text || item.content.text || data?.text || item.detail;
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
}

export function makeWatchMessages(items: RuntimeItem[], limit = 4) {
  return items
    .filter((item) => (item.itemType === 'user_message' || item.itemType === 'assistant_message') && itemText(item))
    .slice(-limit)
    .map((item) => ({
      id: item.itemId,
      role: item.itemType === 'user_message' ? 'user' : 'assistant',
      text: itemText(item),
    }));
}

function fallbackStatusLabel(status: string, running: boolean) {
  if (running || status === 'working' || status === 'running') return 'Working';
  if (status === 'needs_input') return 'Needs input';
  if (status === 'stopped' || status === 'completed') return 'Done';
  if (status === 'ready') return 'Ready';
  return status.replace(/[_-]+/g, ' ').replace(/^./, (value) => value.toUpperCase());
}

export function makeWatchSnapshot(runtime: MobileRuntimeState, theme: MobileTheme, prioritizedClientRequestId?: string) {
  const statuses = Object.fromEntries(runtime.terminalStatuses.map((status) => [status.key, status]));
  const sessions = runtime.sessions
    .filter((session) => session.state !== 'stopped')
    .sort((a, b) => Number(b.clientRequestId === prioritizedClientRequestId) - Number(a.clientRequestId === prioritizedClientRequestId)
      || Number(b.needsAttention) - Number(a.needsAttention)
      || Number(Boolean(b.currentTurn)) - Number(Boolean(a.currentTurn))
      || (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, 12)
    .map((session) => {
      const running = Boolean(session.currentTurn);
      const status = session.workStatus || (running ? 'working' : session.state);
      return {
        id: session.sessionId,
        ...(session.clientRequestId ? { clientRequestId: session.clientRequestId.slice(0, 128) } : {}),
        title: (session.title || session.goal || session.activity || session.agent || 'Session').slice(0, 80),
        agent: session.agent || 'agent',
        project: session.project?.name || '',
        projectPath: (session.project?.path || '').slice(0, 512),
        activity: (session.activity || '').slice(0, 120),
        status,
        statusLabel: statuses[status]?.label || fallbackStatusLabel(status, running),
        statusColor: statuses[status]?.color || '',
        running,
        needsAttention: session.needsAttention,
        messages: makeWatchMessages(session.items),
      };
    });
  const usedPaths = new Set(sessions.map((session) => session.projectPath));
  let iconBudget = 40_000;
  const projects = runtime.projects
    .slice()
    .sort((a, b) => Number(usedPaths.has(b.path)) - Number(usedPaths.has(a.path)))
    .slice(0, 20)
    .map((project) => {
      const iconDataUrl = project.iconDataUrl || '';
      const keepIcon = iconDataUrl.length > 0 && iconDataUrl.length <= iconBudget;
      if (keepIcon) iconBudget -= iconDataUrl.length;
      return {
        name: project.name.slice(0, 60),
        path: project.path.slice(0, 512),
        color: project.color || '',
        emoji: project.icon?.startsWith('emoji:') ? Array.from(project.icon.slice(6))[0] || '' : '',
        ...(keepIcon ? { iconDataUrl } : {}),
      };
    });
  const snapshot = {
    version: 1,
    phase: runtime.phase,
    computerName: runtime.computerName || '',
    theme,
    updatedAt: Date.now(),
    agents: WATCH_AGENTS.map((id) => ({ id, label: id === 'pi' ? 'Pi (beta)' : id === 'opencode' ? 'OpenCode' : id[0].toUpperCase() + id.slice(1) })),
    projects,
    statuses: runtime.terminalStatuses.slice(0, 12).map((status) => ({ key: status.key, label: status.label.slice(0, 40), color: status.color })),
    sessions,
  };
  // WatchConnectivity rejects application contexts above ~65 KB; shed project images until it fits.
  while (JSON.stringify(snapshot).length > WATCH_SNAPSHOT_MAX_BYTES) {
    const heaviest = snapshot.projects.filter((project) => project.iconDataUrl).sort((a, b) => b.iconDataUrl!.length - a.iconDataUrl!.length)[0];
    if (!heaviest) break;
    delete heaviest.iconDataUrl;
  }
  return snapshot;
}

export function parseWatchEvent(value: unknown): WatchEvent | null {
  const event = record(value);
  const id = boundedString(event?.id, 128);
  const type = boundedString(event?.type, 20);
  if (!event || !id || !type) return null;
  if (type === 'error') {
    const message = boundedString(event.message, 300);
    return message ? { id, type, message } : null;
  }
  if (type === 'audio') {
    const sessionId = boundedString(event.sessionId, 200);
    const uri = boundedString(event.uri, 2048);
    const durationMs = Number(event.durationMs);
    if (!sessionId || !uri?.startsWith('file://') || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 120_000) return null;
    return { id, type, sessionId, uri, mimeType: 'audio/mp4', durationMs };
  }
  if (type !== 'command') return null;
  if (event.action === 'refresh') return { id, type, action: 'refresh' };
  if (event.action === 'loadSession') {
    const sessionId = boundedString(event.sessionId, 200);
    return sessionId ? { id, type, action: 'loadSession', sessionId } : null;
  }
  if (event.action === 'closeSession') {
    const sessionId = boundedString(event.sessionId, 200);
    return sessionId ? { id, type, action: 'closeSession', sessionId } : null;
  }
  if (event.action === 'setStatus') {
    const sessionId = boundedString(event.sessionId, 200);
    const status = boundedString(event.status, 40);
    return sessionId && status ? { id, type, action: 'setStatus', sessionId, status } : null;
  }
  const agent = boundedString(event.agent, 32);
  const projectPath = boundedString(event.projectPath, 2048);
  if (event.action !== 'createSession' || !agent || !projectPath || !WATCH_AGENTS.includes(agent as typeof WATCH_AGENTS[number])) return null;
  return { id, type, action: 'createSession', agent: agent as typeof WATCH_AGENTS[number], projectPath };
}
