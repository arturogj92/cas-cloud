
export const PROTOCOL_VERSION = 2;
const MAX_PAIRING_URI_LENGTH = 4096;
const MAX_CONTENT_CHARS = 1024 * 1024;
const MAX_TERMINAL_ORDER = 50;
const MOBILE_AGENT_IDS = new Set(['claude', 'codex', 'antigravity', 'opencode', 'kimi', 'grok', 'cursor', 'pi']);

export type ConnectionPhase =
  | 'booting'
  | 'unpaired'
  | 'connecting'
  | 'confirming'
  | 'online'
  | 'offline'
  | 'error';

export type RuntimeHostKind = 'desktop' | 'cloud';
export type RuntimeHostPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';

export type RuntimeItem = {
  itemId: string;
  turnId?: string;
  itemType?: string;
  status?: string;
  remoteCommand?: boolean;
  title?: string;
  detail?: string;
  data?: Record<string, unknown>;
  todos?: RuntimeTodo[];
  content: Record<string, string>;
  contentTruncated?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
};

export type RuntimeTodo = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type RuntimeRequest = {
  requestId: string;
  requestType?: string;
  detail?: string;
  args?: Record<string, unknown>;
  options?: Array<{ id: string; name?: string; kind?: string }>;
};

export type RuntimeQuestion = {
  requestId: string;
  requestType?: string;
  questions?: Array<{
    id: string;
    header?: string;
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    allowsFreeText?: boolean;
    allowsNote?: boolean;
    secret?: boolean;
  }>;
};

export type RuntimeSession = {
  sessionId: string;
  clientRequestId: string | null;
  agent: string | null;
  provider: string | null;
  accountId: string;
  accountLabel: string | null;
  threadId: string | null;
  terminalUuid: string | null;
  terminalOrder: number | null;
  cwd: string | null;
  model: string | null;
  effort: string | boolean | null;
  serviceTier: string | null;
  permissionMode: string | null;
  interactionMode: string | null;
  title: string | null;
  goal: string | null;
  activity: string | null;
  activityHistory: RuntimeActivity[];
  workStatus: string | null;
  lastActivityAt: number | null;
  needsAttention: boolean;
  attentionVersion: number;
  minimized: boolean;
  sandboxMode: boolean;
  resumed: boolean;
  hasEarlierHistory: boolean;
  project: RuntimeProject | null;
  state: string;
  currentTurn: { turnId?: string; state?: string } | null;
  tokenUsage: Record<string, unknown> | null;
  diff: string | null;
  items: RuntimeItem[];
  pendingRequests: RuntimeRequest[];
  pendingQuestions: RuntimeQuestion[];
  lastSeq: number;
  hostRuntimeId?: string;
  hostSessionId?: string;
  hostName?: string;
  hostKind?: RuntimeHostKind;
  hostPhase?: ConnectionPhase;
};

export type RuntimeActivity = {
  activity: string;
  createdAt: string | null;
  taskId: number | null;
};

export type RuntimeProject = {
  projectId?: string;
  rootId?: string;
  name: string;
  path: string;
  color?: string;
  icon?: string;
  iconDataUrl?: string;
  worktreeEligible?: boolean;
  worktreeEligibilityReason?: string;
  useWorktreeByDefault?: boolean;
  registered?: boolean;
  sessionCount?: number;
  hostRuntimeId?: string;
  hostPath?: string;
  hostName?: string;
  hostKind?: RuntimeHostKind;
};

export type RuntimeProjectRoot = { rootId: string; name: string; hostRuntimeId?: string };

export type RuntimeTask = {
  id: number;
  title: string;
  description: string;
  plan: string;
  implementation: string;
  status: 'pending' | 'in_progress' | 'in_testing' | 'completed';
  labels: Array<string | { text: string; color: number }>;
  parentTaskId: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeTaskPage = {
  tasks: RuntimeTask[];
  nextCursor?: string | null;
  counts?: Record<RuntimeTask['status'], number>;
};

/** A desktop navbar shortcut: one tap starts `agent` in `projectPath`. */
export type RuntimeShortcut = {
  shortcutId: string;
  name: string;
  projectPath: string;
  projectName: string;
  color?: string;
  icon?: string;
  iconDataUrl?: string;
  projectId?: string;
  agent: string;
  useWorktree: boolean | null;
  hostRuntimeId?: string;
  hostName?: string;
  hostKind?: RuntimeHostKind;
};

export type RuntimeTerminalStatus = {
  key: string;
  label: string;
  color: string;
};

export type RuntimeQuotaWindow = {
  key: string;
  label: string | null;
  remainingFraction: number;
  resetsAt: number | null;
  model: string | null;
  severity: string | null;
};

export type RuntimeQuotaSnapshot = {
  agent: string;
  accountId: string;
  accountLabel: string | null;
  provider: string | null;
  plan: string | null;
  windows: RuntimeQuotaWindow[];
  tightest: { remainingFraction: number; severity: string | null; resetsAt: number | null } | null;
  fetchedAt: number;
  source: string | null;
  stale: boolean;
};

export type RuntimeProvider = {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  login: {
    mode: 'cli' | 'manual' | 'unavailable';
    status: { known: boolean; loggedIn?: boolean; detail?: string };
  };
};

const RUNTIME_PROVIDER_IDS = new Set(['claude', 'codex', 'opencode', 'kimi', 'antigravity', 'grok', 'cursor', 'pi']);

export function normalizeRuntimeProvider(value: unknown): RuntimeProvider | null {
  const provider = recordOrNull(value);
  const id = stringOrNull(provider?.id);
  const login = recordOrNull(provider?.login);
  const status = recordOrNull(login?.status);
  if (!provider || !id || !RUNTIME_PROVIDER_IDS.has(id)) return null;
  return {
    id,
    name: stringOrNull(provider.name)?.slice(0, 100) || id,
    installed: provider.installed === true,
    version: stringOrNull(provider.version)?.slice(0, 100) || null,
    login: {
      mode: login?.mode === 'cli' || login?.mode === 'manual' ? login.mode : 'unavailable',
      status: {
        known: status?.known === true,
        ...(status?.known === true ? {
          loggedIn: status.loggedIn === true,
          detail: stringOrNull(status.detail)?.slice(0, 300) || undefined,
        } : {}),
      },
    },
  };
}

export type RuntimeHistoryConversation = {
  id: string;
  sessionId: string;
  agent: string;
  title: string;
  projectPath: string;
  projectDir: string;
  projectName: string;
  timestamp: number;
  hostRuntimeId?: string;
  hostName?: string;
  hostKind?: RuntimeHostKind;
  hostPhase?: ConnectionPhase;
};

export type RuntimeCache = {
  runtimeId: string | null;
  computerName: string | null;
  hostKind: RuntimeHostKind;
  hostPlatform: RuntimeHostPlatform;
  capabilities: string[];
  availableAgents: string[];
  lastSeq: number;
  sessions: RuntimeSession[];
  projects: RuntimeProject[];
  shortcuts: RuntimeShortcut[];
  quotas: RuntimeQuotaSnapshot[];
  terminalStatuses: RuntimeTerminalStatus[];
  projectRoots: RuntimeProjectRoot[];
};

export type RuntimeHost = {
  runtimeId: string;
  name: string;
  kind: RuntimeHostKind;
  platform: RuntimeHostPlatform;
  phase: ConnectionPhase;
  error: string | null;
  sessionCount: number;
  projectCount: number;
  capabilities: string[];
  availableAgents: string[];
  terminalStatuses?: RuntimeTerminalStatus[];
};

export type MobileRuntimeState = RuntimeCache & {
  phase: ConnectionPhase;
  challengeCode: string | null;
  challengeExpiresAt: number | null;
  error: string | null;
  hosts?: RuntimeHost[];
};

export type PairingCredentials = {
  relayOrigin: string;
  backendOrigin: string;
  runtimeId: string;
  pairingToken: string;
  desktopPublicKey: string;
};

export type RuntimeCommand = {
  type: 'turn.send' | 'turn.interrupt' | 'session.stop' | 'session.minimize' | 'session.restore' | 'session.read' | 'session.status' | 'session.handoff' | 'session.action' | 'session.subscribe' | 'session.unsubscribe' | 'request.respond' | 'question.respond' | 'session.create' | 'session.resume' | 'history.list' | 'history.older' | 'session.models' | 'session.configure' | 'preview.create' | 'preview.close' | 'attachment.begin' | 'attachment.chunk' | 'attachment.abort' | 'attachment.read' | 'reference.resolve' | 'providers.list' | 'provider.login.start' | 'provider.login.submit' | 'provider.login.cancel' | 'shortcuts.replace' | 'coordination.sessions' | 'coordination.transcript' | 'coordination.message' | 'coordination.peers.replace' | 'projects.list' | 'project.directories.list' | 'project.create' | 'project.update' | 'project.icon.availability' | 'project.icon.generate' | 'project.register' | 'project.clone' | 'project.clone.cancel' | 'project.unregister' | 'tasks.list' | 'task.create' | 'task.update' | 'task.delete' | 'tasks.mutate';
  runtimeId?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
};

export type RuntimeEnvelope = Record<string, unknown> & {
  kind?: string;
  runtimeId?: string;
  seq?: number;
};

export const emptyRuntimeCache = (): RuntimeCache => ({ runtimeId: null, computerName: null, hostKind: 'desktop', hostPlatform: 'unknown', capabilities: [], availableAgents: [...MOBILE_AGENT_IDS], lastSeq: 0, sessions: [], projects: [], shortcuts: [], quotas: [], terminalStatuses: [], projectRoots: [] });

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function previewHttpUrl(relayOrigin: string, runtimeId: string, shareId: string, path = '/') {
  const url = new URL(relayOrigin);
  const target = new URL(path, 'http://preview.local');
  url.protocol = 'https:';
  url.pathname = `/preview/${encodeURIComponent(runtimeId)}/${encodeURIComponent(shareId)}${target.pathname}`;
  url.search = target.search;
  url.hash = target.hash;
  return url.toString();
}

export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeItem(value: unknown): RuntimeItem | null {
  const item = recordOrNull(value);
  const itemId = stringOrNull(item?.itemId);
  if (!item || !itemId) return null;
  const content = recordOrNull(item.content) || {};
  const todos = (Array.isArray(item.todos) ? item.todos : []).slice(0, 200).flatMap((value) => {
    const todo = recordOrNull(value);
    const step = stringOrNull(todo?.step)?.slice(0, 500);
    if (!step) return [];
    const status = todo?.status === 'completed' || todo?.status === 'in_progress'
      ? todo.status
      : 'pending';
    return [{ step, status } as RuntimeTodo];
  });
  return {
    ...item,
    itemId,
    todos,
    content: Object.fromEntries(
      Object.entries(content).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  } as RuntimeItem;
}

function normalizeActivityHistory(value: unknown): RuntimeActivity[] {
  return (Array.isArray(value) ? value : []).slice(0, 50).flatMap((value) => {
    const entry = recordOrNull(value);
    const activity = stringOrNull(entry?.activity)?.slice(0, 1000);
    if (!entry || !activity) return [];
    return [{
      activity,
      createdAt: stringOrNull(entry.createdAt)?.slice(0, 64) || null,
      taskId: Number.isSafeInteger(entry.taskId) ? Number(entry.taskId) : null,
    }];
  });
}

export function normalizeSession(value: unknown): RuntimeSession | null {
  const session = recordOrNull(value);
  const sessionId = stringOrNull(session?.sessionId);
  if (!session || !sessionId) return null;
  return {
    sessionId,
    clientRequestId: stringOrNull(session.clientRequestId),
    agent: stringOrNull(session.agent),
    provider: stringOrNull(session.provider),
    accountId: stringOrNull(session.accountId) || 'current',
    accountLabel: stringOrNull(session.accountLabel),
    threadId: stringOrNull(session.threadId),
    terminalUuid: stringOrNull(session.terminalUuid),
    terminalOrder: Number.isSafeInteger(session.terminalOrder) && Number(session.terminalOrder) > 0 && Number(session.terminalOrder) <= MAX_TERMINAL_ORDER
      ? Number(session.terminalOrder)
      : null,
    cwd: stringOrNull(session.cwd),
    model: stringOrNull(session.model),
    effort: typeof session.effort === 'boolean' ? session.effort : stringOrNull(session.effort),
    serviceTier: stringOrNull(session.serviceTier),
    permissionMode: stringOrNull(session.permissionMode),
    interactionMode: stringOrNull(session.interactionMode),
    title: stringOrNull(session.title),
    goal: stringOrNull(session.goal),
    activity: stringOrNull(session.activity),
    activityHistory: normalizeActivityHistory(session.activityHistory),
    workStatus: stringOrNull(session.workStatus),
    lastActivityAt: Number.isSafeInteger(session.lastActivityAt) ? Number(session.lastActivityAt) : null,
    needsAttention: session.needsAttention === true,
    attentionVersion: Number.isSafeInteger(session.attentionVersion) ? Number(session.attentionVersion) : 0,
    minimized: session.minimized === true,
    sandboxMode: session.sandboxMode === true,
    resumed: session.resumed === true,
    hasEarlierHistory: session.hasEarlierHistory === true,
    project: normalizeProject(session.project),
    state: stringOrNull(session.state) || 'unknown',
    currentTurn: recordOrNull(session.currentTurn) as RuntimeSession['currentTurn'],
    tokenUsage: recordOrNull(session.tokenUsage),
    diff: typeof session.diff === 'string' ? session.diff : null,
    items: Array.isArray(session.items) ? session.items.map(normalizeItem).filter(Boolean) as RuntimeItem[] : [],
    pendingRequests: Array.isArray(session.pendingRequests)
      ? session.pendingRequests.filter((request) => stringOrNull(recordOrNull(request)?.requestId)) as RuntimeRequest[]
      : [],
    pendingQuestions: Array.isArray(session.pendingQuestions)
      ? session.pendingQuestions.filter((request) => stringOrNull(recordOrNull(request)?.requestId)) as RuntimeQuestion[]
      : [],
    lastSeq: Number.isSafeInteger(session.lastSeq) ? Number(session.lastSeq) : 0,
  };
}

function normalizeProject(value: unknown): RuntimeProject | null {
  const project = recordOrNull(value);
  const name = stringOrNull(project?.name);
  const path = stringOrNull(project?.path);
  if (!name || !path) return null;
  return {
    ...(typeof project?.projectId === 'string' ? { projectId: project.projectId } : {}),
    ...(typeof project?.rootId === 'string' ? { rootId: project.rootId } : {}),
    name,
    path,
    ...(typeof project?.color === 'string' ? { color: project.color } : {}),
    ...(typeof project?.icon === 'string' ? { icon: project.icon } : {}),
    ...(typeof project?.iconDataUrl === 'string' ? { iconDataUrl: project.iconDataUrl } : {}),
    ...(typeof project?.worktreeEligible === 'boolean' ? { worktreeEligible: project.worktreeEligible } : {}),
    ...(typeof project?.worktreeEligibilityReason === 'string'
      ? { worktreeEligibilityReason: project.worktreeEligibilityReason }
      : {}),
    ...(typeof project?.useWorktreeByDefault === 'boolean'
      ? { useWorktreeByDefault: project.useWorktreeByDefault }
      : {}),
    ...(typeof project?.registered === 'boolean' ? { registered: project.registered } : {}),
    ...(Number.isSafeInteger(project?.sessionCount) ? { sessionCount: Number(project?.sessionCount) } : {}),
  };
}

function normalizeShortcut(value: unknown): RuntimeShortcut | null {
  const shortcut = recordOrNull(value);
  const shortcutId = stringOrNull(shortcut?.shortcutId);
  const projectPath = stringOrNull(shortcut?.projectPath);
  const projectName = stringOrNull(shortcut?.projectName) || projectPath;
  const name = stringOrNull(shortcut?.name) || projectName;
  if (!shortcutId || !projectPath || !name || !projectName) return null;
  return {
    shortcutId,
    name,
    projectPath,
    projectName,
    ...(typeof shortcut?.color === 'string' ? { color: shortcut.color } : {}),
    ...(typeof shortcut?.icon === 'string' ? { icon: shortcut.icon } : {}),
    ...(typeof shortcut?.iconDataUrl === 'string' ? { iconDataUrl: shortcut.iconDataUrl } : {}),
    ...(typeof shortcut?.projectId === 'string' ? { projectId: shortcut.projectId } : {}),
    agent: stringOrNull(shortcut?.agent) || 'claude',
    useWorktree: shortcut?.useWorktree === true ? true : shortcut?.useWorktree === false ? false : null,
  };
}

function normalizeTerminalStatus(value: unknown): RuntimeTerminalStatus | null {
  const status = recordOrNull(value);
  const key = stringOrNull(status?.key ?? status?.status_key);
  const label = stringOrNull(status?.label);
  const color = stringOrNull(status?.color);
  return key && label && color ? { key, label, color } : null;
}

function finiteFraction(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function normalizeQuotaSnapshot(value: unknown): RuntimeQuotaSnapshot | null {
  const snapshot = recordOrNull(value);
  const agent = stringOrNull(snapshot?.agent);
  if (!snapshot || !agent) return null;
  const windows = (Array.isArray(snapshot.windows) ? snapshot.windows : []).flatMap((value) => {
    const window = recordOrNull(value);
    const key = stringOrNull(window?.key);
    const remainingFraction = finiteFraction(window?.remainingFraction);
    if (!window || !key || remainingFraction === null) return [];
    return [{
      key,
      label: stringOrNull(window.label),
      remainingFraction,
      resetsAt: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
      model: stringOrNull(window.model),
      severity: stringOrNull(window.severity),
    }];
  });
  const rawTightest = recordOrNull(snapshot.tightest);
  const tightestRemaining = finiteFraction(rawTightest?.remainingFraction);
  return {
    agent,
    accountId: stringOrNull(snapshot.accountId) || 'current',
    accountLabel: stringOrNull(snapshot.accountLabel),
    provider: stringOrNull(snapshot.provider),
    plan: stringOrNull(snapshot.plan),
    windows,
    tightest: rawTightest && tightestRemaining !== null ? {
      remainingFraction: tightestRemaining,
      severity: stringOrNull(rawTightest.severity),
      resetsAt: Number.isFinite(Number(rawTightest.resetsAt)) ? Number(rawTightest.resetsAt) : null,
    } : null,
    fetchedAt: Number.isFinite(Number(snapshot.fetchedAt)) ? Number(snapshot.fetchedAt) : 0,
    source: stringOrNull(snapshot.source),
    stale: snapshot.stale === true,
  };
}

export function normalizeRuntimeCache(value: unknown): RuntimeCache {
  const cache = recordOrNull(value);
  if (!cache) return emptyRuntimeCache();
  return {
    runtimeId: stringOrNull(cache.runtimeId),
    computerName: stringOrNull(cache.computerName)?.trim().slice(0, 200) || null,
    hostKind: cache.hostKind === 'cloud' ? 'cloud' : 'desktop',
    hostPlatform: normalizeHostPlatform(cache.hostPlatform),
    capabilities: normalizeCapabilities(cache.capabilities),
    availableAgents: (Array.isArray(cache.availableAgents) ? cache.availableAgents : []).flatMap((agent) => (
      typeof agent === 'string' && MOBILE_AGENT_IDS.has(agent) ? [agent] : []
    )),
    lastSeq: Number.isSafeInteger(cache.lastSeq) && Number(cache.lastSeq) >= 0
      ? Number(cache.lastSeq)
      : 0,
    sessions: Array.isArray(cache.sessions)
      ? cache.sessions.map(normalizeSession).filter(Boolean) as RuntimeSession[]
      : [],
    projects: Array.isArray(cache.projects)
      ? cache.projects.flatMap((value) => {
          const project = normalizeProject(value);
          return project ? [project] : [];
        })
      : [],
    shortcuts: Array.isArray(cache.shortcuts)
      ? cache.shortcuts.flatMap((value) => {
          const shortcut = normalizeShortcut(value);
          return shortcut ? [shortcut] : [];
        })
      : [],
    quotas: Array.isArray(cache.quotas)
      ? cache.quotas.map(normalizeQuotaSnapshot).filter(Boolean) as RuntimeQuotaSnapshot[]
      : [],
    terminalStatuses: Array.isArray(cache.terminalStatuses)
      ? cache.terminalStatuses.map(normalizeTerminalStatus).filter(Boolean) as RuntimeTerminalStatus[]
      : [],
    projectRoots: (Array.isArray(cache.projectRoots) ? cache.projectRoots : []).flatMap((value) => {
      const root = recordOrNull(value);
      const rootId = stringOrNull(root?.rootId);
      const name = stringOrNull(root?.name);
      return rootId && name ? [{ rootId, name }] : [];
    }),
  };
}

function normalizeCapabilities(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).slice(0, 50).flatMap((capability) => (
    typeof capability === 'string' && capability.length <= 100 ? [capability] : []
  ));
}

function hostKindFromMetadata(value: unknown): RuntimeHostKind {
  const metadata = recordOrNull(value);
  return metadata?.headless === true || metadata?.client === 'cas-cli' ? 'cloud' : 'desktop';
}

function normalizeHostPlatform(value: unknown): RuntimeHostPlatform {
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : 'unknown';
}

function hostPlatformFromMetadata(value: unknown): RuntimeHostPlatform {
  return normalizeHostPlatform(recordOrNull(value)?.platform);
}

export function sortSessionsByTerminalOrder(sessions: RuntimeSession[]): RuntimeSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (
      (a.session.terminalOrder ?? Number.MAX_SAFE_INTEGER)
      - (b.session.terminalOrder ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index
    ))
    .map(({ session }) => session);
}

export function sortSessionsByRecentActivity(sessions: RuntimeSession[]): RuntimeSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (
      (b.session.lastActivityAt || 0) - (a.session.lastActivityAt || 0)
      || a.index - b.index
    ))
    .map(({ session }) => session);
}

export function parsePairingUri(raw: string): PairingCredentials {
  const value = raw.trim();
  if (!value || value.length > MAX_PAIRING_URI_LENGTH) throw new Error('This QR code is invalid');
  let pairing: URL;
  try {
    pairing = new URL(value);
  } catch {
    throw new Error('This QR code does not contain a valid link');
  }
  const route = pairing.hostname || pairing.pathname.replace(/^\//, '');
  if (pairing.protocol !== 'codeagentswarm:' || route !== 'pair' || pairing.searchParams.get('v') !== '2') {
    throw new Error('This is not a CodeAgentSwarm QR code');
  }
  const token = pairing.searchParams.get('token') || '';
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new Error('This QR code has expired or is corrupted');
  const runtimeId = pairing.searchParams.get('runtime') || '';
  const desktopPublicKey = pairing.searchParams.get('key') || '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runtimeId) || !/^[A-Za-z0-9_-]{43}$/.test(desktopPublicKey)) {
    throw new Error('This QR code is incomplete');
  }
  let relay: URL;
  let backend: URL;
  try {
    relay = new URL(pairing.searchParams.get('relay') || '');
    backend = new URL(pairing.searchParams.get('backend') || '');
  } catch {
    throw new Error('The QR code servers are invalid');
  }
  const localRelay = relay.hostname === 'localhost'
    || relay.hostname === '127.0.0.1'
    || relay.hostname === '[::1]';
  const localBackend = backend.hostname === 'localhost'
    || backend.hostname === '127.0.0.1'
    || backend.hostname === '[::1]';
  if ((relay.protocol !== 'https:' && !(relay.protocol === 'http:' && localRelay))
    || relay.username || relay.password
    || (backend.protocol !== 'https:' && !(backend.protocol === 'http:' && localBackend))
    || backend.username || backend.password) {
    throw new Error('The QR code connection is not secure');
  }
  return {
    relayOrigin: relay.origin,
    backendOrigin: backend.origin,
    runtimeId,
    pairingToken: token,
    desktopPublicKey,
  };
}

export function normalizePairingCode(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(compact)) throw new Error('This pairing code is not valid');
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export type PairingInput =
  { kind: 'uri'; uri: string };

export function pairingInputFromUrl(raw: string): PairingInput | null {
  const value = raw.trim();
  if (value.startsWith('codeagentswarm://pair')) return { kind: 'uri', uri: value };
  try {
    const url = new URL(value);
    const localDev = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !localDev) return null;
    const pairing = url.searchParams.get('pairing');
    return pairing?.startsWith('codeagentswarm://pair') ? { kind: 'uri', uri: pairing } : null;
  } catch {
    return null;
  }
}

export function relayWebSocketUrl(relayOrigin: string, runtimeId: string): string {
  const url = new URL(relayOrigin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/api/mobile/ws';
  url.search = '';
  url.searchParams.set('runtime', runtimeId);
  url.hash = '';
  return url.toString();
}

function mutableSessionById(cache: RuntimeCache, sessionId: string, cloneCollections = false): RuntimeSession {
  const index = cache.sessions.findIndex((session) => session.sessionId === sessionId);
  if (index >= 0) {
    const found = cache.sessions[index];
    const mutable = cloneCollections ? {
      ...found,
      items: [...found.items],
      pendingRequests: [...found.pendingRequests],
      pendingQuestions: [...found.pendingQuestions],
    } : { ...found };
    cache.sessions = [...cache.sessions];
    cache.sessions[index] = mutable;
    return mutable;
  }
  const created = normalizeSession({ sessionId })!;
  cache.sessions = [...cache.sessions, created];
  return created;
}

function reduceProviderEvent(session: RuntimeSession, event: Record<string, unknown>, seq: number) {
  const type = stringOrNull(event.type);
  const payload = recordOrNull(event.payload) || {};
  session.lastSeq = seq;
  session.provider = stringOrNull(event.provider) || session.provider;
  session.threadId = stringOrNull(event.threadId) || session.threadId;
  if (type === 'session.state.changed') session.state = stringOrNull(payload.state) || session.state;
  if (type === 'session.exited') session.state = 'stopped';
  if (type === 'thread.started') session.threadId = stringOrNull(payload.providerThreadId) || session.threadId;
  if (type === 'thread.token-usage.updated') session.tokenUsage = recordOrNull(payload.usage);
  if (type === 'turn.started') session.currentTurn = { turnId: stringOrNull(event.turnId) || undefined, state: 'running' };
  if (type === 'turn.completed') {
    const endedAtMs = Date.parse(stringOrNull(event.createdAt) || '');
    session.currentTurn = {
      turnId: stringOrNull(event.turnId) || undefined,
      state: stringOrNull(payload.state) || 'completed',
    };
    for (const item of session.items) {
      if (item.turnId === session.currentTurn.turnId && item.status === 'inProgress') {
        item.status = session.currentTurn.state === 'failed' ? 'failed' : 'completed';
        if (Number.isFinite(endedAtMs)) item.endedAtMs = endedAtMs;
      }
    }
  }
  if (type === 'turn.diff.updated') session.diff = typeof payload.unifiedDiff === 'string' ? payload.unifiedDiff : '';
  if (type === 'session.config.updated') {
    for (const key of ['model', 'effort', 'serviceTier', 'permissionMode', 'interactionMode'] as const) {
      if (typeof payload[key] === 'string' || (key === 'effort' && typeof payload[key] === 'boolean')) {
        session[key] = payload[key] as never;
      }
    }
  }

  const itemId = stringOrNull(event.itemId);
  if (itemId && type?.startsWith('item.')) {
    const index = session.items.findIndex((item) => item.itemId === itemId);
    const previous = index >= 0 ? session.items[index] : { itemId, content: {} };
    const eventAtMs = Date.parse(stringOrNull(event.createdAt) || '');
    const next = {
      ...previous,
      ...payload,
      itemId,
      turnId: stringOrNull(event.turnId) || previous.turnId,
      status: stringOrNull(payload.status) || (type === 'item.completed' ? 'completed' : previous.status),
      content: previous.content,
      ...(Number.isFinite(eventAtMs) && previous.startedAtMs === undefined ? { startedAtMs: eventAtMs } : {}),
      ...(Number.isFinite(eventAtMs) && type === 'item.completed' ? { endedAtMs: eventAtMs } : {}),
    } as RuntimeItem;
    if (index >= 0) session.items[index] = next;
    else session.items.push(next);
  }
  if (itemId && type === 'content.delta') {
    const index = session.items.findIndex((item) => item.itemId === itemId);
    const item = index >= 0 ? { ...session.items[index] } : { itemId, content: {} } as RuntimeItem;
    const eventAtMs = Date.parse(stringOrNull(event.createdAt) || '');
    if (item.startedAtMs === undefined && Number.isFinite(eventAtMs)) item.startedAtMs = eventAtMs;
    const stream = stringOrNull(payload.streamKind) || 'unknown';
    const delta = typeof payload.delta === 'string' ? payload.delta : '';
    const joined = `${item.content[stream] || ''}${delta}`;
    item.content = {
      ...item.content,
      [stream]: joined.length > MAX_CONTENT_CHARS ? joined.slice(-MAX_CONTENT_CHARS) : joined,
    };
    if (joined.length > MAX_CONTENT_CHARS) item.contentTruncated = true;
    if (index >= 0) session.items[index] = item;
    else session.items.push(item);
  }

  const requestId = stringOrNull(event.requestId);
  if (requestId && type === 'request.opened') {
    session.pendingRequests = [
      ...session.pendingRequests.filter((request) => request.requestId !== requestId),
      { requestId, ...payload },
    ] as RuntimeRequest[];
  }
  if (requestId && type === 'request.resolved') {
    session.pendingRequests = session.pendingRequests.filter((request) => request.requestId !== requestId);
  }
  if (requestId && type === 'question.opened') {
    session.pendingQuestions = [
      ...session.pendingQuestions.filter((request) => request.requestId !== requestId),
      { requestId, ...payload },
    ] as RuntimeQuestion[];
  }
  if (requestId && type === 'question.resolved') {
    session.pendingQuestions = session.pendingQuestions.filter((request) => request.requestId !== requestId);
  }
}

export function applyRuntimeEnvelope(
  current: RuntimeCache,
  message: RuntimeEnvelope,
): { cache: RuntimeCache; gap: boolean } {
  if (message.kind === 'welcome') {
    const runtimeId = stringOrNull(message.runtimeId);
    if (!runtimeId) return { cache: current, gap: true };
    if (message.reset === true) {
      const snapshot = recordOrNull(message.snapshot);
      const cache = normalizeRuntimeCache({
        runtimeId,
        computerName: snapshot?.computerName,
        hostKind: hostKindFromMetadata(message.desktop),
        hostPlatform: hostPlatformFromMetadata(message.desktop),
        capabilities: message.capabilities ?? snapshot?.capabilities,
        lastSeq: Number.isSafeInteger(message.latestSeq) ? message.latestSeq : 0,
        sessions: Array.isArray(snapshot?.sessions) ? snapshot.sessions : [],
        projects: Array.isArray(snapshot?.projects) ? snapshot.projects : [],
        shortcuts: Array.isArray(snapshot?.shortcuts) ? snapshot.shortcuts : [],
        availableAgents: Array.isArray(snapshot?.availableAgents) ? snapshot.availableAgents : [...MOBILE_AGENT_IDS],
        quotas: Array.isArray(snapshot?.quotas) ? snapshot.quotas : [],
        terminalStatuses: Array.isArray(snapshot?.terminalStatuses) ? snapshot.terminalStatuses : [],
        projectRoots: Array.isArray(snapshot?.projectRoots) ? snapshot.projectRoots : [],
      });
      // A compact reconnect can omit every message without deleting the conversation.
      // Keep its loaded timeline until the existing session subscription hydrates it.
      if (runtimeId === current.runtimeId && Array.isArray(message.features) && message.features.includes('session-subscriptions')) {
        const cachedItems = new Map(current.sessions.map((session) => [session.sessionId, session.items]));
        for (const session of cache.sessions) {
          if (session.hasEarlierHistory && session.items.length === 0) {
            session.items = cachedItems.get(session.sessionId) || session.items;
          }
        }
      }
      return { cache, gap: false };
    }
    const capabilities = normalizeCapabilities(message.capabilities);
    if (capabilities.some((capability) => ['tasks.list', 'project.update', 'project.unregister'].includes(capability))
      && current.projects.some((project) => !project.projectId)) {
      return { cache: current, gap: true };
    }
    return {
      cache: {
        ...current,
        runtimeId,
        hostKind: hostKindFromMetadata(message.desktop),
        hostPlatform: hostPlatformFromMetadata(message.desktop),
        capabilities: capabilities.length
          ? capabilities
          : current.capabilities,
        lastSeq: Math.min(current.lastSeq, Number(message.latestSeq) || 0),
      },
      gap: false,
    };
  }

  const runtimeId = stringOrNull(message.runtimeId);
  const seq = message.seq;
  if (!runtimeId || !Number.isSafeInteger(seq) || Number(seq) <= 0) return { cache: current, gap: false };
  if (runtimeId !== current.runtimeId
    || (message.kind !== 'cursor.advanced' && Number(seq) > current.lastSeq + 1)) {
    return { cache: current, gap: true };
  }
  if (Number(seq) <= current.lastSeq) return { cache: current, gap: false };

  const cache: RuntimeCache = {
    runtimeId: current.runtimeId,
    computerName: current.computerName,
    hostKind: current.hostKind,
    hostPlatform: current.hostPlatform,
    capabilities: current.capabilities,
    availableAgents: current.availableAgents,
    lastSeq: Number(seq),
    sessions: current.sessions,
    projects: current.projects,
    shortcuts: current.shortcuts,
    quotas: current.quotas,
    terminalStatuses: current.terminalStatuses,
    projectRoots: current.projectRoots,
  };
  if (message.kind === 'session.opened') {
    const opened = normalizeSession(recordOrNull(message.session));
    if (opened) {
      const existing = cache.sessions.find((session) => session.sessionId === opened.sessionId);
      cache.sessions = [{
        ...(existing || opened),
        ...opened,
        items: existing?.items || opened.items,
        pendingRequests: existing?.pendingRequests || opened.pendingRequests,
        pendingQuestions: existing?.pendingQuestions || opened.pendingQuestions,
      }, ...cache.sessions.filter((session) => session.sessionId !== opened.sessionId)];
    }
  } else if (message.kind === 'session.event') {
    const sessionId = stringOrNull(message.sessionId);
    const event = recordOrNull(message.event);
    if (sessionId && event) reduceProviderEvent(mutableSessionById(cache, sessionId, true), event, Number(seq));
  } else if (message.kind === 'session.closed') {
    const sessionId = stringOrNull(message.sessionId);
    if (sessionId) mutableSessionById(cache, sessionId).state = 'stopped';
  } else if (message.kind === 'session.identity.updated') {
    const sessionId = stringOrNull(message.sessionId);
    const identity = recordOrNull(message.identity);
    if (sessionId && identity) {
      const session = mutableSessionById(cache, sessionId);
      if (Object.hasOwn(identity, 'title')) session.title = stringOrNull(identity.title);
      if (Object.hasOwn(identity, 'goal')) session.goal = stringOrNull(identity.goal);
      if (Object.hasOwn(identity, 'activity')) session.activity = stringOrNull(identity.activity);
      if (Object.hasOwn(identity, 'activityHistory')) session.activityHistory = normalizeActivityHistory(identity.activityHistory);
      if (Object.hasOwn(identity, 'workStatus')) session.workStatus = stringOrNull(identity.workStatus);
      if (Object.hasOwn(identity, 'lastActivityAt')) {
        session.lastActivityAt = Number.isSafeInteger(identity.lastActivityAt)
          ? Number(identity.lastActivityAt)
          : null;
      }
      if (Object.hasOwn(identity, 'needsAttention')) session.needsAttention = identity.needsAttention === true;
      if (Number.isSafeInteger(identity.attentionVersion)) session.attentionVersion = Number(identity.attentionVersion);
      if (Object.hasOwn(identity, 'minimized')) session.minimized = identity.minimized === true;
      if (Object.hasOwn(identity, 'sandboxMode')) session.sandboxMode = identity.sandboxMode === true;
      if (Object.hasOwn(identity, 'project')) session.project = normalizeProject(identity.project);
      if (Number.isSafeInteger(identity.terminalOrder) && Number(identity.terminalOrder) > 0 && Number(identity.terminalOrder) <= MAX_TERMINAL_ORDER) {
        session.terminalOrder = Number(identity.terminalOrder);
      }
      session.lastSeq = Number(seq);
    }
  } else if (message.kind === 'quota.updated') {
    cache.quotas = Array.isArray(message.snapshots)
      ? message.snapshots.map(normalizeQuotaSnapshot).filter(Boolean) as RuntimeQuotaSnapshot[]
      : [];
  } else if (message.kind === 'projects.updated') {
    cache.projects = Array.isArray(message.projects)
      ? message.projects.map(normalizeProject).filter(Boolean) as RuntimeProject[]
      : [];
    cache.shortcuts = Array.isArray(message.shortcuts)
      ? message.shortcuts.map(normalizeShortcut).filter(Boolean) as RuntimeShortcut[]
      : [];
    if (Array.isArray(message.availableAgents)) {
      cache.availableAgents = message.availableAgents.flatMap((agent) => (
        typeof agent === 'string' && MOBILE_AGENT_IDS.has(agent) ? [agent] : []
      ));
    }
  }
  return { cache, gap: false };
}

export function newlyAttentiveSessions(
  previous: RuntimeSession[],
  next: RuntimeSession[],
): RuntimeSession[] {
  const before = new Map(previous.map((session) => [session.sessionId, session]));
  return next.filter((session) => {
    if (!session.needsAttention) return false;
    const old = before.get(session.sessionId);
    if (!old) return true;
    return !old.needsAttention || session.attentionVersion > old.attentionVersion;
  });
}

export function sessionAlertCopy(session: Pick<RuntimeSession, 'sessionId' | 'title'>) {
  return {
    sessionId: session.sessionId,
    title: session.title?.trim() || 'CodeAgentSwarm',
    body: 'A session needs your attention',
  };
}
