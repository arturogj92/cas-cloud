const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DriverChatManager } = require('../agent-drivers/driver-chat-manager');
const { MobileRuntime } = require('../mobile/mobile-runtime');
const { MobileRelayClient } = require('../mobile/mobile-relay-client');
const { createKeyPair } = require('../mobile/mobile-crypto');
const { HeadlessProjectRegistry } = require('./headless-project-registry');
const { AGENT_IDS, HeadlessProviderService } = require('./headless-provider-service');
const { HeadlessTaskService } = require('./headless-task-service');
const workspace = require('./project-workspace-read');
const ClaudeConversationSearchService = require('../services/claude-conversation-search-service');
const CodexConversationSearchService = require('../services/codex-conversation-search-service');
const AntigravityConversationSearchService = require('../services/antigravity-conversation-search-service');
const OpencodeConversationSearchService = require('../services/opencode-conversation-search-service');
const KimiConversationSearchService = require('../services/kimi-conversation-search-service');
const GrokConversationSearchService = require('../services/grok-conversation-search-service');
const CursorConversationSearchService = require('../services/cursor-conversation-search-service');
const { projectPathsMatch } = require('../services/claude-project-path-resolver');
const platformConfig = require('../platform/platform-config');
const DatabaseManager = require('../database/database');
const { buildConversationHandoff } = require('../../shared/utils/conversation-handoff');
const { generateConversationTitle } = require('../../application/conversation-title-generator');
const { forkConversation } = require('../services/conversation-fork-service');

const DEFAULT_BACKEND_URL = 'https://codeagentswarm-backend-production.up.railway.app';
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TERMINAL_STATUSES = [
  { status_key: 'needs_input', label: 'Needs input', color: '#f97316', icon: 'message-circle-question', sort_order: 1 },
  { status_key: 'needs_testing', label: 'Needs testing', color: '#3b82f6', icon: 'flask-conical', sort_order: 2 },
  { status_key: 'working', label: 'Working', color: '#fbbf24', icon: 'hammer', sort_order: 3 },
  { status_key: 'done', label: 'Done', color: '#22c55e', icon: 'circle-check', sort_order: 4 },
];
const HEADLESS_PROJECT_CAPABILITIES = Object.freeze([
  'projects.list',
  'project.register',
  'project.clone',
  'project.clone.cancel',
  'project.unregister',
  'shortcuts.manage',
  'session.action',
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

function appDataPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'linux') {
    const xdgConfigHome = typeof env.XDG_CONFIG_HOME === 'string'
      ? env.XDG_CONFIG_HOME.trim()
      : '';
    if (xdgConfigHome && path.isAbsolute(xdgConfigHome)) {
      return path.join(xdgConfigHome, 'codeagentswarm');
    }
    return path.join(home, '.config', 'codeagentswarm');
  }
  return platformConfig.getAppDataPath();
}

function configPath(options = {}) {
  const env = options.env || process.env;
  return env.CAS_CLI_CONFIG
    || path.join(appDataPath({ ...options, env }), 'cas-cli.json');
}

function validIdentity(value) {
  return value
    && typeof value.runtimeId === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/.test(value.runtimeId)
    && KEY_PATTERN.test(value.keyPair?.publicKey || '')
    && KEY_PATTERN.test(value.keyPair?.secretKey || '');
}

function loadIdentity(filePath = configPath()) {
  if (fs.existsSync(filePath)) {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      throw new Error(`CAS CLI identity is corrupt: ${filePath}`);
    }
    if (!validIdentity(stored)) throw new Error(`CAS CLI identity is invalid: ${filePath}`);
    fs.chmodSync(filePath, 0o600);
    return stored;
  }

  const identity = { runtimeId: crypto.randomUUID(), keyPair: createKeyPair() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return identity;
}

function loadDesktopAuth(dataPath = appDataPath()) {
  const authPath = path.join(dataPath, 'auth-data.json');
  if (!fs.existsSync(authPath)) return null;
  let contents = fs.readFileSync(authPath, 'utf8').trim();
  if (/^[0-9a-f]{32}:[0-9a-f]+$/i.test(contents)) {
    const keyPath = path.join(dataPath, '.encryption-key');
    if (!fs.existsSync(keyPath)) throw new Error('The desktop login encryption key is missing');
    const [ivHex, encryptedHex, ...extra] = contents.split(':');
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (extra.length || key.length !== 32 || !/^[0-9a-f]{32}$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(encryptedHex)) {
      throw new Error('The desktop login file is invalid');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
      contents = decipher.update(encryptedHex, 'hex', 'utf8') + decipher.final('utf8');
    } catch (_) {
      throw new Error('The desktop login could not be decrypted');
    }
  }
  try {
    return JSON.parse(contents);
  } catch (_) {
    throw new Error('The desktop login file is corrupt');
  }
}

function tokenExpired(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) && payload.exp <= Math.floor(Date.now() / 1000) + 60;
  } catch (_) {
    return false;
  }
}

async function createAccessTokenProvider({
  backendUrl = DEFAULT_BACKEND_URL,
  env = process.env,
  fetchImpl = globalThis.fetch,
  appDataPath,
} = {}) {
  const desktopAuth = env.CAS_ACCESS_TOKEN ? null : loadDesktopAuth(appDataPath);
  let token = env.CAS_ACCESS_TOKEN || desktopAuth?.token;
  const refreshToken = env.CAS_REFRESH_TOKEN || desktopAuth?.refreshToken;
  let refreshPromise = null;
  if (!token && !refreshToken) {
    throw new Error('Sign in to the CodeAgentSwarm desktop app, or set CAS_ACCESS_TOKEN on this host');
  }
  return () => {
    if (token && !tokenExpired(token)) return token;
    if (!refreshToken) throw new Error('The CodeAgentSwarm login expired and cannot be refreshed');
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const response = await fetchImpl(`${new URL(backendUrl).origin}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('The CodeAgentSwarm login could not be refreshed');
        const refreshed = await response.json();
        const nextToken = refreshed.accessToken || refreshed.access_token;
        if (typeof nextToken !== 'string' || !nextToken) {
          throw new Error('The CodeAgentSwarm login refresh returned no access token');
        }
        token = nextToken;
        return token;
      })().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  };
}

function resolveProject(projectPath = process.cwd()) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(projectPath));
  } catch (_) {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Project is not a directory: ${projectPath}`);
  return {
    name: path.basename(resolved) || resolved,
    path: resolved,
    worktreeEligible: false,
    useWorktreeByDefault: false,
  };
}

function runtimeDatabasePath(identity, { env = process.env, dataPath = appDataPath({ env }) } = {}) {
  if (typeof env.CODEAGENTSWARM_DB_PATH === 'string' && env.CODEAGENTSWARM_DB_PATH.trim()) {
    return env.CODEAGENTSWARM_DB_PATH;
  }
  const runtimeKey = crypto.createHash('sha256').update(identity.runtimeId).digest('hex').slice(0, 32);
  return path.join(dataPath, 'runtimes', `${runtimeKey}.db`);
}

function opaqueProjectId(runtimeId, projectPath) {
  return crypto.createHash('sha256').update(`${runtimeId}\0${projectPath}`).digest('base64url').slice(0, 32);
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
    return value.offset;
  } catch (_) {
    throw new Error('The task cursor is invalid');
  }
}

function compactTask(task) {
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  let labels = task.labels;
  if (typeof labels === 'string') {
    try { labels = JSON.parse(labels); } catch (_) { labels = []; }
  }
  return {
    id: Number(task.id),
    title: text(task.title, 500),
    description: text(task.description, 4000),
    plan: text(task.plan, 4000),
    implementation: text(task.implementation, 4000),
    status: text(task.status, 100),
    labels: Array.isArray(labels) ? labels.slice(0, 20).flatMap((label) => {
      if (typeof label === 'string') return [text(label, 100)];
      if (label && typeof label.text === 'string' && Number.isSafeInteger(label.color)) {
        return [{ text: text(label.text, 100), color: Math.max(0, Math.min(7, label.color)) }];
      }
      return [];
    }) : [],
    parentTaskId: task.parent_task_id === null ? null : Number(task.parent_task_id),
    sortOrder: Number(task.sort_order) || 0,
    createdAt: text(task.created_at, 64),
    updatedAt: text(task.updated_at, 64),
  };
}

function createHistoryServices() {
  return {
    claude: new ClaudeConversationSearchService(),
    codex: new CodexConversationSearchService(),
    antigravity: new AntigravityConversationSearchService(),
    opencode: new OpencodeConversationSearchService(),
    kimi: new KimiConversationSearchService(),
    grok: new GrokConversationSearchService(),
    cursor: new CursorConversationSearchService(),
  };
}

function processHeadlessNotifications(runtime, filePath = path.join(os.homedir(), '.codeagentswarm', 'task_notifications.json')) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return 0;
    const notifications = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(notifications)) return 0;
    let applied = 0;
    for (const notification of notifications) {
      if (!notification || notification.processed || typeof notification.terminal_uuid !== 'string') continue;
      let identity = null;
      if (notification.type === 'terminal_title_update') {
        identity = {
          title: notification.title,
          goal: notification.long_title,
        };
      } else if (notification.type === 'terminal_activity_update') {
        identity = { activity: notification.activity };
      } else if (notification.type === 'terminal_status_update') {
        identity = { workStatus: notification.status };
      }
      if (!identity || !runtime.updateSessionIdentity({ terminalUuid: notification.terminal_uuid, ...identity })) continue;
      notification.processed = true;
      applied += 1;
    }
    if (applied) fs.writeFileSync(filePath, JSON.stringify(notifications, null, 2));
    return applied;
  } catch (_) {
    return 0;
  }
}

function createHeadlessHost({
  projectPath,
  projectPaths = projectPath ? [projectPath] : [],
  projectRoots = [],
  getToken,
  identity = loadIdentity(),
  backendUrl = DEFAULT_BACKEND_URL,
  channel = 'production',
  version = 'development',
  env = process.env,
  dataPath,
  database: suppliedDatabase = null,
  manager: suppliedManager = null,
  projectRegistry: suppliedProjectRegistry = null,
  providerService: suppliedProviderService = null,
  historyServices = createHistoryServices(),
  quotaService: suppliedQuotaService = null,
  generateConversationTitle: generateConversationTitleFn = generateConversationTitle,
  forkConversation: forkConversationFn = forkConversation,
  spawnImpl,
} = {}) {
  if (typeof getToken !== 'function') throw new Error('CAS CLI requires an access token provider');
  if (!validIdentity(identity)) throw new Error('CAS CLI identity is invalid');
  const database = suppliedDatabase || new DatabaseManager(null, {
    databasePath: runtimeDatabasePath(identity, { env, dataPath }),
    env,
  });
  const providerService = suppliedProviderService || new HeadlessProviderService({ env });
  const headlessQuotaService = suppliedQuotaService || require('../../application/services/quota-service').getInstance();
  const manager = suppliedManager || new DriverChatManager({
    resolveSpawnEnv: async ({ agent, terminalId, terminalUuid } = {}) => ({
      ...env,
      CODEAGENTSWARM_DB_PATH: database.dbPath,
      ...(Number.isInteger(terminalId) && terminalId > 0 ? {
        CODEAGENTSWARM_ACTIVE_SESSION: '1',
        CODEAGENTSWARM_CURRENT_QUADRANT: String(terminalId),
      } : {}),
      ...(terminalUuid ? { CODEAGENTSWARM_TERMINAL_ID: terminalUuid } : {}),
      ...(agent ? { CODEAGENTSWARM_AGENT_TYPE: agent } : {}),
    }),
    resolveDriverOptions: async ({ agent }) => {
      const binaryPath = providerService.executable(agent);
      return binaryPath ? { binaryPath } : {};
    },
  });
  let runtime;
  const registry = suppliedProjectRegistry || new HeadlessProjectRegistry({
    database,
    runtimeId: identity.runtimeId,
    initialProjectPaths: projectPaths,
    projectRoots,
    ...(spawnImpl ? { spawnImpl } : {}),
    onProjectsChanged: ({ revision }) => runtime?.publishProjects({ revision }),
    onOperation: (operation) => runtime?.publishProjectOperation(operation),
  });
  let observedDataVersion = database.getDataVersion();
  const taskRevisions = new Map();
  let tasksRevisionTimer = null;
  let quotaTimer = null;
  let terminalOrder = 0;

  const publishTasksChanged = (projectId) => {
    const revision = (taskRevisions.get(projectId) || 0) + 1;
    taskRevisions.set(projectId, revision);
    runtime?.publishTasksChanged({ projectId, revision });
    return revision;
  };
  const taskService = new HeadlessTaskService({
    database,
    projectRegistry: registry,
    changed: publishTasksChanged,
  });

  const refreshTasksRevision = () => {
    const next = database.getDataVersion();
    if (next !== observedDataVersion) {
      observedDataVersion = next;
      for (const project of registry.getProjects()) {
        publishTasksChanged(project.projectId);
      }
    }
    return new Map(taskRevisions);
  };

  const listTasks = ({ projectId, cursor, limit }) => {
    const project = registry.resolveProject(projectId);
    const pageSize = limit === undefined ? 25 : Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new Error('Task page size must be between 1 and 50');
    }
    const offset = decodeCursor(cursor);
    const rows = database.getTasksByProject(project.taskProjectName, pageSize + 1, offset);
    refreshTasksRevision();
    return {
      projectId,
      revision: taskRevisions.get(projectId) || 0,
      tasks: rows.slice(0, pageSize).map(compactTask),
      nextCursor: rows.length > pageSize ? encodeCursor(offset + pageSize) : null,
    };
  };
  const inProject = (operation) => async ({ projectId, ...payload }) => {
    try {
      return await operation(registry.resolveProject(projectId).path, payload);
    } catch (_) {
      throw new Error('Remote workspace read failed');
    }
  };
  const getHistory = async () => {
    const projectPaths = registry.getProjects().map((project) => project.path);
    const rows = await Promise.all(Object.entries(historyServices).map(async ([agent, service]) => {
      if (typeof service?.getRecentConversations !== 'function') return [];
      try {
        const conversations = await service.getRecentConversations(500, projectPaths);
        return (Array.isArray(conversations) ? conversations : [])
          .filter((conversation) => projectPaths.some((projectPath) => projectPathsMatch(projectPath, conversation?.projectPath)))
          .map((conversation) => ({ ...conversation, agent }));
      } catch (_) {
        return [];
      }
    }));
    return rows.flat().sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0)).slice(0, 500);
  };
  const getConversationContent = async ({ agent, sessionId, projectDir }) => {
    const service = historyServices[agent];
    if (typeof service?.getConversationContent !== 'function') return [];
    return service.getConversationContent(sessionId, projectDir);
  };

  const updateIdentity = (sessionId, patch) => {
    runtime.updateSessionIdentity({ sessionId, ...patch });
    return { success: true };
  };
  const startingProjects = new Map();
  const changeStartingCount = (projectId, delta) => {
    const count = (startingProjects.get(projectId) || 0) + delta;
    if (count > 0) startingProjects.set(projectId, count);
    else startingProjects.delete(projectId);
  };
  const createSession = async (options) => {
    const { initialPrompt, projectId, cwd, ...startOptions } = options;
    const project = projectId
      ? registry.resolveProject(projectId)
      : registry.resolveLegacyPath(cwd);
    if (!project) throw new Error('Choose a configured remote project');
    changeStartingCount(project.projectId, 1);
    let started = null;
    try {
      const terminalId = ++terminalOrder;
      const terminalUuid = crypto.randomUUID();
      started = await manager.startSession({
        ...startOptions,
        cwd: project.path,
        terminalId,
        terminalUuid,
        permissionMode: 'default',
        useWorktree: false,
      });
      updateIdentity(started.sessionId, {
        title: `${started.agent} · ${project.name}`,
        project,
        workStatus: 'working',
      });
      if (initialPrompt) {
        await manager.sendTurn(started.sessionId, { text: initialPrompt });
      }
      return started;
    } catch (error) {
      if (started?.sessionId) await manager.stopSession(started.sessionId);
      throw error;
    } finally {
      changeStartingCount(project.projectId, -1);
    }
  };
  const handoffSession = async ({ sessionId, targetAgent }) => {
    const source = runtime.sessions.get(sessionId);
    if (!source) throw new Error('The agent is no longer open');
    const sourceSessionId = source.threadId || source.sessionId;
    const projectDir = source.agent === 'claude'
      ? historyServices.claude.encodeProjectPath(source.cwd)
      : '';
    const messages = await getConversationContent({
      agent: source.agent,
      sessionId: sourceSessionId,
      projectDir,
    });
    const handoff = buildConversationHandoff({
      messages,
      title: source.title,
      sourceAgent: source.agent,
      targetAgent,
      sourceSessionId,
      workingDirectory: source.cwd,
      terminalMeta: {
        title: source.title,
        goal: source.goal,
        workStatus: source.workStatus,
        activityHistory: source.activityHistory,
      },
    });
    if (!handoff.normalizedMessages.length) throw new Error('The source conversation has no readable messages');
    let started = null;
    try {
      const terminalId = ++terminalOrder;
      const terminalUuid = crypto.randomUUID();
      started = await manager.startSession({
        agent: targetAgent,
        cwd: source.cwd,
        terminalId,
        terminalUuid,
        permissionMode: 'default',
        useWorktree: false,
      });
      updateIdentity(started.sessionId, {
        title: handoff.terminalMeta.title,
        goal: handoff.terminalMeta.goal,
        workStatus: 'working',
        project: source.project,
      });
      await manager.sendTurn(started.sessionId, { text: handoff.prompt });
      return { success: true, sessionId: started.sessionId };
    } catch (error) {
      if (started?.sessionId) await manager.stopSession(started.sessionId);
      throw error;
    }
  };
  const sessionAction = async ({ sessionId, action, title }) => {
    const source = runtime.sessions.get(sessionId);
    if (!source) return { success: false, error: 'The agent is no longer open' };
    if (action === 'rename') return updateIdentity(sessionId, { title });
    if (action === 'resetTitle') return updateIdentity(sessionId, { title: null });
    if (action === 'generateTitle') {
      const service = historyServices[source.agent];
      const projectDir = source.agent === 'claude' && typeof service?.encodeProjectPath === 'function'
        ? service.encodeProjectPath(source.cwd)
        : source.cwd;
      const generated = await generateConversationTitleFn(manager, {
        messages: await getConversationContent({
          agent: source.agent,
          sessionId: source.threadId || source.sessionId,
          projectDir,
        }),
        selection: { agent: source.agent },
      });
      updateIdentity(sessionId, {
        title: generated.title,
        goal: generated.goal,
        activity: generated.activity,
        activityHistory: [
          { activity: generated.activity, createdAt: new Date().toISOString(), taskId: null },
          ...(source.activityHistory || []),
        ],
      });
      return { success: true, ...generated };
    }
    if (action === 'fork') {
      const forked = await forkConversationFn({
        sessionId: source.threadId || source.sessionId,
        projectPath: source.cwd,
        agentType: source.agent,
      });
      if (!forked?.success || !forked.newSessionId) return forked || { success: false, error: 'Fork failed' };
      terminalOrder = Math.max(terminalOrder, Number(source.terminalOrder) || 0);
      const started = await manager.startSession({
        agent: source.agent,
        cwd: source.cwd,
        terminalId: ++terminalOrder,
        terminalUuid: crypto.randomUUID(),
        permissionMode: 'default',
        resumeSessionId: forked.newSessionId,
        useWorktree: false,
      });
      updateIdentity(started.sessionId, {
        title: `FORKED - ${source.title || source.agent}`,
        goal: source.goal,
        workStatus: 'working',
        project: source.project,
      });
      return { success: true, sessionId: started.sessionId };
    }
    return { success: false, error: 'Turning a Cloud conversation into a project is unavailable' };
  };

  runtime = new MobileRuntime({
    manager,
    runtimeId: identity.runtimeId,
    getComputerName: () => os.hostname().replace(/\.local$/i, '').replace(/-/g, ' '),
    getAvailableAgents: () => AGENT_IDS.filter((agent) => providerService.executable(agent)),
    getProjects: () => registry.getProjects().map((project) => ({
      ...project,
      sessionCount: Array.from(runtime?.sessions?.values() || []).filter((session) => (
        session.project?.projectId === project.projectId && session.state !== 'stopped'
      )).length,
    })),
    getShortcuts: () => database.getAllShortcuts(),
    replaceShortcuts: (shortcuts) => database.saveShortcuts(shortcuts),
    getQuota: () => headlessQuotaService.getCached(),
    getProjectRoots: () => registry.getRoots(),
    getProjectsRevision: () => registry.getRevision(),
    getCapabilities: () => HEADLESS_PROJECT_CAPABILITIES,
    getTerminalStatuses: () => {
      try {
        const statuses = database.getTerminalStatuses?.();
        return Array.isArray(statuses) && statuses.length ? statuses : TERMINAL_STATUSES;
      } catch (_) {
        return TERMINAL_STATUSES;
      }
    },
    getClientMetadata: () => ({ version, channel, client: 'cas-cli', headless: true }),
    getHistory,
    getConversationContent,
    listTasks,
    createTask: (payload) => taskService.create(payload),
    updateTask: (payload) => taskService.update(payload),
    deleteTask: (payload) => taskService.delete(payload),
    mutateTasks: (payload) => taskService.mutate(payload),
    listProviders: () => providerService.list(),
    installProvider: (agent, onProgress) => providerService.install(agent, onProgress),
    describeProviderLogin: (agent) => providerService.describeLogin(agent),
    startProviderLogin: (payload) => providerService.startLogin(payload),
    submitProviderLogin: (loginId, text) => providerService.submitLogin(loginId, text),
    cancelProviderLogin: (loginId) => providerService.cancelLogin(loginId),
    workspaceFilesList: inProject(workspace.list),
    workspaceFilesRead: inProject(workspace.read),
    workspaceFilesSearch: inProject(workspace.search),
    workspaceGitStatus: inProject(workspace.gitStatus),
    workspaceGitDiff: inProject(workspace.gitDiff),
    workspaceGitLog: inProject(workspace.gitLog),
    workspaceGitBranches: inProject(workspace.gitBranches),
    workspaceGitSwitch: inProject(workspace.gitSwitch),
    workspaceGitCreate: inProject(workspace.gitCreate),
    listProjects: (payload) => registry.list(payload),
    registerProject: (payload) => registry.register(payload),
    cloneProject: (payload) => registry.clone(payload),
    cancelProjectClone: (payload) => registry.cancelClone(payload),
    unregisterProject: (payload) => {
      const busy = startingProjects.has(payload.projectId) || Array.from(runtime.sessions.values()).some((session) => (
        session.project?.projectId === payload.projectId && session.state !== 'stopped'
      ));
      if (busy) {
        const error = new Error('The project has a live session');
        error.code = 'project_busy';
        throw error;
      }
      return registry.unregister(payload);
    },
    createSession,
    setSessionStatus: ({ sessionId, status }) => updateIdentity(sessionId, { workStatus: status }),
    handoffSession,
    sessionAction,
    closeSession: async ({ sessionId }) => ({
      success: (await manager.stopSession(sessionId))?.stopped === true,
    }),
    minimizeSession: ({ sessionId }) => updateIdentity(sessionId, { minimized: true }),
    restoreSession: ({ sessionId }) => updateIdentity(sessionId, { minimized: false }),
  });
  const onProviderLoginEvent = (event) => {
    runtime.publishProviderLoginEvent(event);
    if (event.type === 'completed' && event.payload?.success === true) {
      headlessQuotaService.refresh().then(() => runtime.publishQuota()).catch(() => {});
    }
  };
  providerService.on('login-event', onProviderLoginEvent);
  const relay = new MobileRelayClient({
    runtime,
    getToken,
    getRuntimeId: () => identity.runtimeId,
    getKeyPair: () => identity.keyPair,
    backendUrl,
  });
  runtime.notifyAttention = (payload) => relay.notifyAttention(payload);

  return {
    identity,
    manager,
    get project() { return registry.getProjects()[0] || null; },
    get projects() { return registry.getProjects(); },
    projectRegistry: registry,
    databasePath: database.dbPath,
    refreshTasksRevision,
    relay,
    runtime,
    async start() {
      if (!tasksRevisionTimer) {
        tasksRevisionTimer = setInterval(() => {
          refreshTasksRevision();
          processHeadlessNotifications(runtime);
        }, 1000);
        tasksRevisionTimer.unref?.();
      }
      try {
        await headlessQuotaService.refresh();
      } catch (_) {}
      if (!quotaTimer) {
        quotaTimer = setInterval(async () => {
          try {
            await headlessQuotaService.refresh();
            runtime.publishQuota();
          } catch (_) {}
        }, 5 * 60 * 1000);
        quotaTimer.unref?.();
      }
      return relay.ensureConnected();
    },
    async stop() {
      clearInterval(tasksRevisionTimer);
      tasksRevisionTimer = null;
      clearInterval(quotaTimer);
      quotaTimer = null;
      relay.stop();
      runtime.stop();
      await registry.stop();
      providerService.removeListener('login-event', onProviderLoginEvent);
      if (!suppliedProviderService) providerService.stop();
      await manager.stopAll();
      if (!suppliedDatabase) database.close();
    },
  };
}

module.exports = {
  DEFAULT_BACKEND_URL,
  HEADLESS_PROJECT_CAPABILITIES,
  TERMINAL_STATUSES,
  appDataPath,
  configPath,
  createAccessTokenProvider,
  createHeadlessHost,
  loadDesktopAuth,
  loadIdentity,
  processHeadlessNotifications,
  resolveProject,
  runtimeDatabasePath,
  validIdentity,
};
