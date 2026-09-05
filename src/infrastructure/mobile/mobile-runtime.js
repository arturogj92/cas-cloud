const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SESSION_EVENT,
  SESSION_STARTING,
  SESSION_STARTED
} = require('../agent-drivers/driver-chat-manager');
const { permissionOptionsForAgent } = require('../agent-drivers/chat-permission-modes');
const { isProviderEventType } = require('../agent-drivers/provider-events');
const {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_AUDIO_BYTES,
  safeAttachmentName,
  normalizeChatAttachments
} = require('../agent-drivers/chat-attachments');
const { FRESHNESS_TTL_MS } = require('../../domain/value-objects/quota-snapshot');
const { MAX_TERMINALS } = require('../../shared/config/terminal-limits');
const { MAX_TERMINAL_SHORTCUTS } = require('../../shared/config/shortcut-limits');
const { parseTodoEntries } = require('../../shared/parsers/todo-list-parser');
const { attentionPushPayload } = require('./mobile-push');
const { projectPathsMatch } = require('../services/claude-project-path-resolver');
const { parseSessionCoordinationPrompt } = require('../../shared/parsers/session-coordination-message');
const {
  conversationMessagesToEvents,
  normalizeConversationMessages,
  pageConversationMessages
} = require('../agent-drivers/chat-history-pagination');

const PROTOCOL_VERSION = 2;
const SESSION_SUBSCRIPTIONS_FEATURE = 'session-subscriptions';
const SNAPSHOT_PROJECT_ICONS_FEATURE = 'snapshot-project-icons';
const SUBSCRIPTION_ONLY_EVENT_TYPES = new Set([
  'session.config.updated',
  'session.commands.updated',
  'thread.started',
  'thread.token-usage.updated',
  'turn.diff.updated',
  'item.started',
  'item.updated',
  'item.completed',
  'content.delta',
  'account.rate-limits.updated',
]);
const STREAM_METRICS_INTERVAL_MS = 60_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ITEMS_PER_SESSION = 500;
const MAX_CONTENT_CHARS = 1024 * 1024;
const MAX_INITIAL_PROMPT_CHARS = 100000;
// Reconnect telemetry (2026-08-16) showed a capped 3 MB reset snapshot costing ~3.2 s of a
// ~4 s cold resume; the phone lazily loads older pages anyway, so the cold-start payload
// only needs the recent tail. Production resets still reached ~4 s at 512 KB, so the
// cold payload now keeps the same conversation-first policy inside 256 KB.
// ponytail: single global budget, split per-session if one
// chatty session ever starves the rest.
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SNAPSHOT_PROJECT_ICON_CHARS = 64 * 1024;
const MAX_SNAPSHOT_ITEM_BYTES = 128 * 1024;
const MAX_ATTACHMENT_CHUNK_CHARS = 448 * 1024;
const MAX_PENDING_UPLOAD_CHARS = 48 * 1024 * 1024;
const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RETAINED_MEDIA_CHARS = 64 * 1024 * 1024;
const MAX_MOBILE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL_CHARS = 32 * 1024;
const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const MOBILE_AGENTS = new Set(['claude', 'codex', 'opencode', 'kimi', 'antigravity', 'grok', 'cursor']);
const REASONING_CONFIG_IDS = new Set(['effort', 'thinking', 'reasoning_effort']);
const MOBILE_USAGE_ACTIONS = Object.freeze({
  'session.create': 'mobile_chat_session_created',
  'session.resume': 'mobile_chat_session_resumed',
  'history.list': 'mobile_history_opened',
  'history.older': 'mobile_history_older_loaded',
  'turn.send': 'mobile_chat_turn_started',
  'session.status': 'mobile_terminal_status_changed',
  'session.handoff': 'mobile_conversation_handoff_started',
  'session.action': 'mobile_conversation_action_started',
  'session.minimize': 'mobile_session_minimized',
  'session.restore': 'mobile_session_restored',
  'session.stop': 'mobile_session_stopped',
  'preview.create': 'mobile_local_preview_opened',
  'attachment.begin': 'mobile_attachment_upload_started',
  'request.respond': 'mobile_permission_responded',
  'question.respond': 'mobile_question_responded'
});

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

function compactCommandError(error) {
  const message = cleanText(error?.message, 500) || 'Command failed';
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'command_failed';
  const operationId = typeof error?.operationId === 'string'
    && /^[A-Za-z0-9._:-]{1,256}$/.test(error.operationId)
    ? error.operationId
    : null;
  return {
    message,
    code,
    retryable: error?.retryable === true,
    ...(operationId ? { operationId } : {}),
  };
}

function isSubscriptionOnlyEnvelope(envelope) {
  return envelope?.kind === 'session.event'
    && SUBSCRIPTION_ONLY_EVENT_TYPES.has(envelope.event?.type);
}

function cleanProject(value) {
  if (!value || typeof value !== 'object') return null;
  const name = cleanText(value.name, 200);
  const projectPath = cleanText(value.path, 4096);
  if (!name || !projectPath) return null;
  return {
    name,
    path: projectPath,
    ...(cleanText(value.projectId, 128) ? { projectId: cleanText(value.projectId, 128) } : {}),
    ...(cleanText(value.color, 32) ? { color: cleanText(value.color, 32) } : {}),
    ...(cleanText(value.icon, 500) ? { icon: cleanText(value.icon, 500) } : {}),
    ...(cleanText(value.iconDataUrl, 100000) ? { iconDataUrl: cleanText(value.iconDataUrl, 100000) } : {})
  };
}

function compactActivityHistory(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 50).flatMap((row) => {
    const activity = cleanText(row?.activity, 1000);
    if (!activity) return [];
    return [{
      activity,
      createdAt: cleanText(row.createdAt, 64),
      taskId: Number.isSafeInteger(row.taskId) ? row.taskId : null
    }];
  });
}

function compactModels(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 100).flatMap((row) => {
    const id = cleanText(row?.id, 200);
    if (!id) return [];
    const descriptors = Array.isArray(row?.capabilities?.optionDescriptors)
      ? row.capabilities.optionDescriptors.slice(0, 20).flatMap((descriptor) => {
        const descriptorId = cleanText(descriptor?.id, 100);
        if (!descriptorId) return [];
        return [{
          id: descriptorId,
          label: cleanText(descriptor.label, 100) || descriptorId,
          type: cleanText(descriptor.type, 30) || 'select',
          ...(['string', 'boolean'].includes(typeof descriptor.currentValue)
            ? { currentValue: descriptor.currentValue }
            : {}),
          options: (Array.isArray(descriptor.options) ? descriptor.options : []).slice(0, 50).flatMap((option) => {
            const optionId = cleanText(option?.id ?? option?.value, 200);
            return optionId ? [{ id: optionId, label: cleanText(option.label ?? option.name, 100) || optionId }] : [];
          })
        }];
      }) : [];
    return [{
      id,
      name: cleanText(row.name, 200) || id,
      ...(row.current === true ? { current: true } : {}),
      capabilities: { optionDescriptors: descriptors }
    }];
  });
}

function compactQuotaSnapshots(rows, catalogs = []) {
  const catalogsByProvider = new Map((Array.isArray(catalogs) ? catalogs : []).map((catalog) => (
    [catalog?.provider, catalog]
  )));
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const agent = cleanText(row?.agent, 100);
    if (!agent) return [];
    const accountId = cleanText(row.accountId, 200) || 'current';
    const catalog = catalogsByProvider.get(agent);
    const account = catalog?.accounts?.find(({ id }) => id === accountId);
    if (catalog && (!account || account.status?.loggedIn === false)) return [];
    const fetchedAt = Number.isFinite(Number(row.fetchedAt)) ? Number(row.fetchedAt) : Date.now();
    const windows = (Array.isArray(row.windows) ? row.windows : []).slice(0, 20).flatMap((window) => {
      const key = cleanText(window?.key, 100);
      const remainingFraction = Number(window?.remainingFraction);
      if (!key || !Number.isFinite(remainingFraction)) return [];
      return [{
        key,
        ...(cleanText(window.label, 200) ? { label: cleanText(window.label, 200) } : {}),
        remainingFraction: Math.max(0, Math.min(1, remainingFraction)),
        resetsAt: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
        ...(cleanText(window.model, 200) ? { model: cleanText(window.model, 200) } : {}),
        ...(cleanText(window.severity, 30) ? { severity: cleanText(window.severity, 30) } : {})
      }];
    });
    const tightestRemaining = Number(row.tightest?.remainingFraction);
    const tightest = Number.isFinite(tightestRemaining) ? {
      remainingFraction: Math.max(0, Math.min(1, tightestRemaining)),
      ...(cleanText(row.tightest?.severity, 30) ? { severity: cleanText(row.tightest.severity, 30) } : {}),
      resetsAt: Number.isFinite(Number(row.tightest?.resetsAt)) ? Number(row.tightest.resetsAt) : null
    } : null;
    const accountLabel = cleanText(account?.label, 200) || cleanText(row.accountLabel, 200);
    return [{
      agent,
      accountId,
      ...(accountLabel ? { accountLabel } : {}),
      ...(cleanText(row.provider, 100) ? { provider: cleanText(row.provider, 100) } : {}),
      ...(cleanText(row.plan, 100) ? { plan: cleanText(row.plan, 100) } : {}),
      windows,
      tightest,
      fetchedAt,
      ...(cleanText(row.source, 100) ? { source: cleanText(row.source, 100) } : {}),
      stale: row.stale === true || (Date.now() - fetchedAt) > FRESHNESS_TTL_MS
    }];
  }).slice(0, 20);
}

function compactTerminalStatuses(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 50).flatMap((row) => {
    if (row?.enabled === 0 || row?.enabled === false) return [];
    const key = cleanText(row?.status_key ?? row?.key, 100);
    const label = cleanText(row?.label, 100);
    const color = cleanText(row?.color, 32);
    return key && label && color ? [{ key, label, color }] : [];
  });
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function isConversationItem(item) {
  return item?.itemType === 'assistant_message'
    || (item?.itemType === 'user_message' && !parseSessionCoordinationPrompt(item.data?.text));
}

function tailText(value, maxBytes) {
  if (typeof value !== 'string') return value;
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  return encoded.subarray(encoded.length - maxBytes).toString('utf8').replace(/^\uFFFD/, '');
}

function compactSnapshotItem(item) {
  if (jsonBytes(item) <= MAX_SNAPSHOT_ITEM_BYTES) return item;
  let remaining = MAX_SNAPSHOT_ITEM_BYTES - 4096;
  const content = {};
  for (const [stream, value] of Object.entries(item.content || {})) {
    if (typeof value !== 'string' || remaining <= 0) continue;
    const compacted = tailText(value, Math.min(32 * 1024, remaining));
    content[stream] = compacted;
    remaining -= Buffer.byteLength(compacted);
  }
  return {
    itemId: item.itemId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.itemType ? { itemType: item.itemType } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.title ? { title: tailText(item.title, 4096) } : {}),
    ...(item.detail ? { detail: tailText(item.detail, 32 * 1024) } : {}),
    ...(Array.isArray(item.todos) ? { todos: item.todos } : {}),
    content,
    contentTruncated: true
  };
}

function compactProviderEvent(event) {
  if (!event || !isProviderEventType(event.type)) return null;
  const payload = event.payload || {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const attachments = data && Array.isArray(data.attachments)
    ? data.attachments.slice(0, MAX_CHAT_ATTACHMENTS).flatMap((attachment) => {
      if (!attachment || !['image', 'audio', 'file'].includes(attachment.type)) return [];
      return [{
        type: attachment.type,
        name: cleanText(attachment.name, 255) || attachment.type,
        ...(cleanText(attachment.mimeType, 100) ? { mimeType: cleanText(attachment.mimeType, 100) } : {}),
        ...(Number.isFinite(attachment.sizeBytes) ? { sizeBytes: Math.max(0, attachment.sizeBytes) } : {}),
        ...(Number.isFinite(attachment.durationMs) ? { durationMs: Math.max(0, attachment.durationMs) } : {}),
        ...(cleanText(attachment.attachmentId, 128) ? { attachmentId: cleanText(attachment.attachmentId, 128) } : {}),
        ...(typeof attachment.thumbnailDataUrl === 'string'
          && attachment.thumbnailDataUrl.length <= MAX_THUMBNAIL_CHARS
          && /^data:image\/[a-z0-9.+-]+;base64,/i.test(attachment.thumbnailDataUrl)
          ? { thumbnailDataUrl: attachment.thumbnailDataUrl }
          : {})
      }];
    }) : null;
  let compactData = attachments ? { ...data, attachments } : data;
  const todos = payload.itemType === 'plan' && event.executionOrigin !== 'subagent'
    ? parseTodoEntries(payload)
    : [];
  if (payload.itemType === 'user_message' && Array.isArray(data?.content)) {
    const { content, ...rest } = compactData;
    const text = content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter((part) => part.trim())
      .join('\n')
      .slice(0, MAX_INITIAL_PROMPT_CHARS);
    const contentAttachments = content.slice(0, MAX_CHAT_ATTACHMENTS).flatMap((part) => {
      if (!part || part.type !== 'image') return [];
      const mimeType = typeof part.url === 'string'
        ? /^data:([^;,]+)/.exec(part.url)?.[1]
        : null;
      return [{ type: 'image', name: 'Image', ...(mimeType ? { mimeType } : {}) }];
    });
    compactData = {
      ...rest,
      ...(typeof rest.text === 'string' ? {} : { text }),
      ...(attachments === null && contentAttachments.length ? { attachments: contentAttachments } : {})
    };
  }
  const compact = {
    eventId: event.eventId,
    provider: event.provider,
    type: event.type,
    executionOrigin: event.executionOrigin,
    createdAt: event.createdAt,
    payload: {
      ...(compactData === data ? payload : { ...payload, data: compactData }),
      ...(todos.length ? { todos } : {})
    }
  };
  for (const key of ['threadId', 'turnId', 'itemId', 'requestId']) {
    if (event[key] !== undefined) compact[key] = event[key];
  }
  return compact;
}

class MobileRuntime {
  constructor({
    manager,
    replayLimit = 2000,
    runtimeId = crypto.randomUUID(),
    getComputerName = () => null,
    getProjects = () => [],
    getShortcuts = () => [],
    replaceShortcuts = null,
    getProjectRoots = () => [],
    getProjectsRevision = () => 0,
    getCapabilities = () => [],
    getAvailableAgents = () => [],
    getQuota = () => [],
    getProviderAccounts = () => [],
    getTerminalStatuses = () => [],
    getClientMetadata = () => ({}),
    getHistory = async () => [],
    getConversationContent = null,
    listCoordinatedSessions = null,
    readCoordinatedTranscript = null,
    sendCoordinatedMessage = null,
    replaceCoordinatedPeers = null,
    listTasks = null,
    createTask = null,
    updateTask = null,
    deleteTask = null,
    mutateTasks = null,
    listProviders = null,
    installProvider = null,
    describeProviderLogin = null,
    startProviderLogin = null,
    submitProviderLogin = null,
    cancelProviderLogin = null,
    workspaceFilesList = null,
    workspaceFilesRead = null,
    workspaceFilesSearch = null,
    workspaceGitStatus = null,
    workspaceGitDiff = null,
    workspaceGitLog = null,
    workspaceGitBranches = null,
    workspaceGitSwitch = null,
    workspaceGitCreate = null,
    listProjects = null,
    listProjectDirectories = null,
    listProjectLocations = null,
    addProjectLocation = null,
    createProject = null,
    updateProject = null,
    gitAvailability = null,
    listGitHubRepositories = null,
    projectIconAvailability = null,
    generateProjectIcon = null,
    registerProject = null,
    cloneProject = null,
    cancelProjectClone = null,
    unregisterProject = null,
    previewService = null,
    createSession = null,
    onRemoteTurn = null,
    onRemoteProviderEvent = null,
    onUsageEvent = null,
    createAttachmentThumbnail = null,
    setSessionStatus = null,
    handoffSession = null,
    sessionAction = null,
    closeSession = null,
    minimizeSession = null,
    restoreSession = null,
    notifyAttention = null,
    sendTurn = null,
    onSessionsChanged = null,
    diagnostic = () => {}
  } = {}) {
    if (!manager) throw new Error('MobileRuntime requires a DriverChatManager');
    this.manager = manager;
    this.replayLimit = replayLimit;
    this.runtimeId = runtimeId;
    this.getComputerName = getComputerName;
    this.getProjects = getProjects;
    this.getShortcuts = getShortcuts;
    this.replaceShortcuts = replaceShortcuts;
    this.getProjectRoots = getProjectRoots;
    this.getProjectsRevision = getProjectsRevision;
    this.getCapabilities = getCapabilities;
    this.getAvailableAgents = getAvailableAgents;
    this.getQuota = getQuota;
    this.getProviderAccounts = getProviderAccounts;
    this.getTerminalStatuses = getTerminalStatuses;
    this.getClientMetadata = getClientMetadata;
    this.getHistory = getHistory;
    this.getConversationContent = getConversationContent;
    this.listCoordinatedSessions = listCoordinatedSessions;
    this.readCoordinatedTranscript = readCoordinatedTranscript;
    this.sendCoordinatedMessage = sendCoordinatedMessage;
    this.replaceCoordinatedPeers = replaceCoordinatedPeers;
    this.listTasks = listTasks;
    this.createTask = createTask;
    this.updateTask = updateTask;
    this.deleteTask = deleteTask;
    this.mutateTasks = mutateTasks;
    this.listProviders = listProviders;
    this.installProvider = installProvider;
    this.describeProviderLogin = describeProviderLogin;
    this.startProviderLogin = startProviderLogin;
    this.submitProviderLogin = submitProviderLogin;
    this.cancelProviderLogin = cancelProviderLogin;
    this.workspaceFilesList = workspaceFilesList;
    this.workspaceFilesRead = workspaceFilesRead;
    this.workspaceFilesSearch = workspaceFilesSearch;
    this.workspaceGitStatus = workspaceGitStatus;
    this.workspaceGitDiff = workspaceGitDiff;
    this.workspaceGitLog = workspaceGitLog;
    this.workspaceGitBranches = workspaceGitBranches;
    this.workspaceGitSwitch = workspaceGitSwitch;
    this.workspaceGitCreate = workspaceGitCreate;
    this.listProjects = listProjects;
    this.listProjectDirectories = listProjectDirectories;
    this.listProjectLocations = listProjectLocations;
    this.addProjectLocation = addProjectLocation;
    this.createProject = createProject;
    this.updateProject = updateProject;
    this.gitAvailability = gitAvailability;
    this.listGitHubRepositories = listGitHubRepositories;
    this.projectIconAvailability = projectIconAvailability;
    this.generateProjectIcon = generateProjectIcon;
    this.registerProject = registerProject;
    this.cloneProject = cloneProject;
    this.cancelProjectClone = cancelProjectClone;
    this.unregisterProject = unregisterProject;
    this.previewService = previewService;
    this.createSession = createSession;
    this.onRemoteTurn = onRemoteTurn;
    this.onRemoteProviderEvent = onRemoteProviderEvent;
    this.onUsageEvent = onUsageEvent;
    this.createAttachmentThumbnail = createAttachmentThumbnail;
    this.setSessionStatus = setSessionStatus;
    this.handoffSession = handoffSession;
    this.sessionAction = sessionAction;
    this.closeSession = closeSession;
    this.minimizeSession = minimizeSession;
    this.restoreSession = restoreSession;
    this.notifyAttention = notifyAttention;
    this.sendTurn = sendTurn || ((sessionId, input) => this.manager.sendTurn(sessionId, input));
    this.onSessionsChanged = onSessionsChanged;
    this.reportDiagnostic = diagnostic;
    this.sequence = 0;
    this.events = [];
    this.providerEventIds = new Set();
    this.remoteTurnSessions = new Set();
    this.clients = new Set();
    this.sessions = new Map();
    this.commands = new Map();
    this.history = new Map();
    this.historyResumes = new Map();
    this.attachmentUploads = new Map();
    this.retainedMedia = new Map();
    this.mobileFiles = new Map();
    this.mobileFileDirectory = null;
    this.quotaFreshnessTimer = null;
    this.streamMetricsTimer = null;
    this.streamMetricsDirty = false;
    this.streamMetrics = {
      startedAt: Date.now(),
      publishedEvents: 0,
      highFrequencyPublished: 0,
      highFrequencySent: 0,
      highFrequencySkipped: 0,
      cursorMarkersSent: 0,
      outboundMessages: 0,
      outboundBytes: 0,
      helloMessages: 0,
      resetWelcomes: 0,
      replayWelcomes: 0,
      subscribeCommands: 0,
      unsubscribeCommands: 0,
      hydrationSnapshots: 0,
    };
    this.started = false;
    this._onSessionStarting = (session) => this._registerStartingSession(session);
    this._onSessionStarted = (session) => {
      if (session?.ephemeral !== true) this._registerSession(session);
    };
    this._onSessionEvent = ({ sessionId, event }) => this._publishProviderEvent(sessionId, event);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.manager.on(SESSION_STARTING, this._onSessionStarting);
    this.manager.on(SESSION_STARTED, this._onSessionStarted);
    this.manager.on(SESSION_EVENT, this._onSessionEvent);
    this.streamMetricsTimer = setInterval(
      () => this._emitStreamMetrics('interval'),
      STREAM_METRICS_INTERVAL_MS,
    );
    this.streamMetricsTimer.unref?.();
  }

  stop() {
    clearTimeout(this.quotaFreshnessTimer);
    this.quotaFreshnessTimer = null;
    clearInterval(this.streamMetricsTimer);
    this.streamMetricsTimer = null;
    if (!this.started) return;
    this._emitStreamMetrics('stop');
    this.started = false;
    this.manager.removeListener(SESSION_STARTING, this._onSessionStarting);
    this.manager.removeListener(SESSION_STARTED, this._onSessionStarted);
    this.manager.removeListener(SESSION_EVENT, this._onSessionEvent);
    for (const client of this.clients) client.detach();
    this.clients.clear();
    this.attachmentUploads.clear();
    this.retainedMedia.clear();
    this.mobileFiles.clear();
    this.historyResumes.clear();
    this.remoteTurnSessions.clear();
    if (this.mobileFileDirectory && path.basename(this.mobileFileDirectory).startsWith('cas-mobile-files-')) {
      try { fs.rmSync(this.mobileFileDirectory, { recursive: true, force: true }); } catch (_) {}
    }
    this.mobileFileDirectory = null;
  }

  _sessionsChanged() {
    if (typeof this.onSessionsChanged !== 'function') return;
    try {
      this.onSessionsChanged(this.sessions);
    } catch (error) {
      console.error(`Could not persist CAS Cloud sessions: ${error.message}`);
    }
  }

  attachSocket(socket) {
    if (!socket || typeof socket.on !== 'function' || typeof socket.send !== 'function') {
      throw new Error('attachSocket requires a WebSocket-compatible socket');
    }
    const client = {
      socket,
      ready: false,
      selective: false,
      subscriptions: new Set(),
      skippedSeq: 0,
      detach: null
    };
    const onMessage = (raw) => this._handleMessage(client, raw);
    const onClose = () => client.detach();
    client.detach = () => {
      socket.removeListener('message', onMessage);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onClose);
      if (this.clients.has(client) && this.started) this._emitStreamMetrics('client_detached');
      this.clients.delete(client);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onClose);
    this.clients.add(client);
    return client.detach;
  }

  _snapshotSession(session) {
    return {
      sessionId: session.sessionId,
      clientRequestId: session.clientRequestId,
      agent: session.agent,
      provider: session.provider,
      accountId: session.accountId,
      accountLabel: session.accountLabel,
      threadId: session.threadId,
      terminalUuid: session.terminalUuid,
      communicationEnabled: session.communicationEnabled === true,
      terminalOrder: session.terminalOrder,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      serviceTier: session.serviceTier,
      permissionMode: session.permissionMode,
      interactionMode: session.interactionMode,
      title: session.title,
      goal: session.goal,
      activity: session.activity,
      activityHistory: session.activityHistory,
      workStatus: session.workStatus,
      lastActivityAt: session.lastActivityAt,
      needsAttention: session.needsAttention,
      attentionVersion: session.attentionVersion,
      minimized: session.minimized,
      sandboxMode: session.sandboxMode === true,
      resumed: session.resumed === true,
      hasEarlierHistory: session.resumed === true || session.historyTruncated === true,
      project: session.project,
      state: session.state,
      currentTurn: session.currentTurn,
      tokenUsage: session.tokenUsage,
      // Mobile does not render the unified diff. Live events can still update it, but
      // carrying every terminal diff in a cold snapshot only delays reconnection.
      diff: null,
      items: Array.from(session.items.values()),
      pendingRequests: Array.from(session.pendingRequests.values()),
      pendingQuestions: Array.from(session.pendingQuestions.values()),
      lastSeq: session.lastSeq
    };
  }

  _subscriptionSnapshot(session) {
    const snapshot = this._snapshotSession(session);
    if (jsonBytes(snapshot) <= MAX_SNAPSHOT_BYTES) return snapshot;

    const compact = {
      ...snapshot,
      activityHistory: [],
      diff: null,
      items: [],
      hasEarlierHistory: snapshot.hasEarlierHistory || snapshot.items.some(isConversationItem),
    };
    let used = jsonBytes(compact);
    const candidates = snapshot.items.map((item, sourceIndex) => ({
      item: compactSnapshotItem(item),
      sourceIndex,
    }));
    const selected = [];
    for (const tier of [
      candidates.filter(({ item }) => isConversationItem(item)),
      candidates.filter(({ item }) => !isConversationItem(item)),
    ]) {
      for (let index = tier.length - 1; index >= 0; index -= 1) {
        const candidate = tier[index];
        const bytes = jsonBytes(candidate.item) + 1;
        if (used + bytes > MAX_SNAPSHOT_BYTES) continue;
        selected.push(candidate);
        used += bytes;
      }
    }
    compact.items = selected
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
      .map(({ item }) => item);
    return compact;
  }

  snapshot({ projectIcons = false } = {}) {
    const allProjects = this._projects();
    const projects = allProjects.slice(0, 100);
    const snapshot = {
      computerName: cleanText(this.getComputerName(), 200),
      projects,
      shortcuts: this._shortcuts(allProjects),
      capabilities: (this.getCapabilities() || []).slice(0, 50).flatMap((capability) => (
        typeof capability === 'string' && capability.length <= 100 ? [capability] : []
      )),
      availableAgents: this._availableAgents(),
      projectsRevision: Number(this.getProjectsRevision()) || 0,
      projectRoots: (this.getProjectRoots() || []).slice(0, 100).map((root) => ({
        rootId: cleanText(root?.rootId, 128),
        name: cleanText(root?.name, 200),
      })),
      projectsTruncated: allProjects.length > projects.length,
      quotas: compactQuotaSnapshots(this.getQuota(), this.getProviderAccounts()),
      terminalStatuses: compactTerminalStatuses(this.getTerminalStatuses()),
      sessions: Array.from(this.sessions.values(), (session) => this._snapshotSession(session))
    };
    const referencedProjectIcons = new Set();
    if (projectIcons) {
      for (const session of snapshot.sessions) {
        if (!session.project?.iconDataUrl) continue;
        const projectIconIndex = projects.findIndex((project) => (
          project.path === session.project.path && project.iconDataUrl === session.project.iconDataUrl
        ));
        if (projectIconIndex < 0) continue;
        const { iconDataUrl, ...project } = session.project;
        session.project = { ...project, projectIconIndex };
        referencedProjectIcons.add(projectIconIndex);
      }
    }
    if (jsonBytes(snapshot) <= MAX_SNAPSHOT_BYTES) return snapshot;

    const compact = {
      computerName: snapshot.computerName,
      projects: snapshot.projects.map((project) => ({ ...project })),
      capabilities: snapshot.capabilities,
      availableAgents: snapshot.availableAgents,
      projectsRevision: snapshot.projectsRevision,
      projectRoots: snapshot.projectRoots,
      projectsTruncated: snapshot.projectsTruncated,
      quotas: snapshot.quotas,
      terminalStatuses: snapshot.terminalStatuses,
      sessions: snapshot.sessions.map(({ items, ...session }) => ({
        ...session,
        activityHistory: [],
        diff: null,
        items: []
      })),
      truncated: true
    };
    let iconChars = compact.projects.reduce((total, project) => total + (project.iconDataUrl?.length || 0), 0);
    for (let index = compact.projects.length - 1; iconChars > MAX_SNAPSHOT_PROJECT_ICON_CHARS && index >= 0; index -= 1) {
      if (referencedProjectIcons.has(index)) continue;
      const icon = compact.projects[index].iconDataUrl;
      if (!icon) continue;
      delete compact.projects[index].iconDataUrl;
      iconChars -= icon.length;
    }
    let used = jsonBytes(compact);
    for (let index = compact.projects.length - 1; used > MAX_SNAPSHOT_BYTES && index >= 0; index -= 1) {
      if (referencedProjectIcons.has(index)) continue;
      if (!compact.projects[index].iconDataUrl) continue;
      delete compact.projects[index].iconDataUrl;
      used = jsonBytes(compact);
    }
    const candidates = snapshot.sessions.map((session) => session.items
      .map((item, sourceIndex) => ({ item: compactSnapshotItem(item), sourceIndex })));
    const tiers = [
      candidates.map((items) => items.filter(({ item }) => isConversationItem(item))),
      candidates.map((items) => items.filter(({ item }) => !isConversationItem(item)))
    ];
    const selected = candidates.map(() => []);
    for (const tier of tiers) {
      for (let offset = 1; tier.some((items) => offset <= items.length); offset += 1) {
        for (let index = 0; index < tier.length; index += 1) {
          const candidate = tier[index][tier[index].length - offset];
          if (!candidate) continue;
          const bytes = jsonBytes(candidate.item) + 1;
          if (used + bytes > MAX_SNAPSHOT_BYTES) continue;
          selected[index].push(candidate);
          used += bytes;
        }
      }
    }
    compact.sessions.forEach((session, index) => {
      session.items = selected[index]
        .sort((left, right) => left.sourceIndex - right.sourceIndex)
        .map(({ item }) => item);
      const conversationCount = (items) => items.filter(isConversationItem).length;
      if (conversationCount(session.items) < conversationCount(snapshot.sessions[index].items)) {
        session.hasEarlierHistory = true;
      }
    });
    return compact;
  }

  _projects() {
    let rows = [];
    try {
      rows = this.getProjects() || [];
    } catch (_) {}
    const seen = new Set();
    return rows.flatMap((project) => {
      if (!project || typeof project.path !== 'string' || !project.path || seen.has(project.path)) return [];
      seen.add(project.path);
      const projectId = cleanText(project.projectId, 128)
        || (Number.isSafeInteger(project.id) && project.id > 0 ? String(project.id) : null);
      return [{
        path: project.path,
        ...(projectId ? { projectId } : {}),
        ...(typeof project.rootId === 'string' && project.rootId ? { rootId: project.rootId } : {}),
        name: typeof project.display_name === 'string' && project.display_name
          ? project.display_name
          : (typeof project.name === 'string' && project.name) || path.basename(project.path),
        ...(typeof project.color === 'string' && project.color ? { color: project.color } : {}),
        ...(typeof project.icon === 'string' && project.icon ? { icon: project.icon } : {}),
        ...(typeof project.iconDataUrl === 'string' && project.iconDataUrl ? { iconDataUrl: project.iconDataUrl } : {}),
        ...(typeof project.worktreeEligible === 'boolean' ? { worktreeEligible: project.worktreeEligible } : {}),
        ...(typeof project.worktreeEligibilityReason === 'string'
          ? { worktreeEligibilityReason: project.worktreeEligibilityReason }
          : {}),
        ...(typeof project.useWorktreeByDefault === 'boolean'
          ? { useWorktreeByDefault: project.useWorktreeByDefault }
          : {}),
        ...(typeof project.registered === 'boolean' ? { registered: project.registered } : {}),
        ...(Number.isSafeInteger(project.sessionCount) ? { sessionCount: project.sessionCount } : {}),
        ...(typeof project.activity === 'string' ? { activity: cleanText(project.activity, 300) } : {}),
        ...(typeof project.status === 'string' ? { status: cleanText(project.status, 100) } : {})
      }];
    });
  }

  _availableAgents() {
    try {
      return [...new Set((this.getAvailableAgents() || []).filter((agent) => MOBILE_AGENTS.has(agent)))];
    } catch (_) {
      return [];
    }
  }

  /** Desktop navbar shortcuts (navbar_shortcuts rows), so the wide web can start an agent in one tap. */
  _shortcuts(allProjects = this._projects()) {
    let rows = [];
    try {
      rows = this.getShortcuts() || [];
    } catch (_) {}
    const projects = new Map(allProjects.map((project) => [project.path, project]));
    return rows.flatMap((row) => {
      const projectPath = typeof row?.project_path === 'string' ? row.project_path : '';
      if (!projectPath || row.session_id || row.sandbox_mode === true) return [];
      const project = projects.get(projectPath)
        || allProjects.find((candidate) => projectPathsMatch(candidate.path, projectPath));
      if (!project) return [];
      return [{
        shortcutId: String(row.id),
        name: cleanText(row.name || row.project_name, 80),
        projectPath: project.path,
        projectName: cleanText(row.project_name, 120),
        ...(typeof row.project_color === 'string' && row.project_color ? { color: row.project_color } : {}),
        ...(project?.projectId ? { projectId: project.projectId } : {}),
        ...(project?.icon ? { icon: project.icon } : {}),
        ...(project?.iconDataUrl ? { iconDataUrl: project.iconDataUrl } : {}),
        agent: MOBILE_AGENTS.has(row.agent_type) ? row.agent_type : 'claude',
        useWorktree: row.use_worktree === true ? true : (row.use_worktree === false ? false : null)
      }];
    }).slice(0, MAX_TERMINAL_SHORTCUTS);
  }

  updateSessionIdentity(identity = {}) {
    const directId = cleanText(identity.sessionId, 128);
    const threadId = cleanText(identity.threadId, 500);
    const terminalUuid = cleanText(identity.terminalUuid, 500);
    const sessions = Array.from(this.sessions.values());
    const terminalMatches = terminalUuid
      ? sessions.filter((candidate) => candidate.terminalUuid === terminalUuid && candidate.state !== 'stopped')
      : [];
    const session = (directId && this.sessions.get(directId))
      || (threadId && sessions.find((candidate) => candidate.threadId === threadId))
      || (terminalMatches.length === 1 && terminalMatches[0]);
    if (!session) return false;
    const patch = {};
    if (Object.hasOwn(identity, 'title')) patch.title = cleanText(identity.title, 300);
    if (Object.hasOwn(identity, 'goal')) patch.goal = cleanText(identity.goal, 1000);
    if (Object.hasOwn(identity, 'activity')) patch.activity = cleanText(identity.activity, 1000);
    if (Object.hasOwn(identity, 'activityHistory')) patch.activityHistory = compactActivityHistory(identity.activityHistory);
    if (Object.hasOwn(identity, 'workStatus')) patch.workStatus = cleanText(identity.workStatus, 100);
    if (Number.isSafeInteger(identity.lastActivityAt)) patch.lastActivityAt = identity.lastActivityAt;
    if (Object.hasOwn(identity, 'needsAttention')) patch.needsAttention = identity.needsAttention === true;
    if (Number.isSafeInteger(identity.attentionVersion)) patch.attentionVersion = identity.attentionVersion;
    if (Object.hasOwn(identity, 'minimized')) patch.minimized = identity.minimized === true;
    if (Object.hasOwn(identity, 'sandboxMode')) patch.sandboxMode = identity.sandboxMode === true;
    if (Number.isSafeInteger(identity.desktopTerminalId) && identity.desktopTerminalId > 0) {
      patch.desktopTerminalId = identity.desktopTerminalId;
    }
    if (Object.hasOwn(identity, 'project')) patch.project = cleanProject(identity.project);
    if (Number.isSafeInteger(identity.terminalOrder) && identity.terminalOrder > 0 && identity.terminalOrder <= MAX_TERMINALS) {
      patch.terminalOrder = identity.terminalOrder;
    }
    Object.assign(session, patch);
    session.lastSeq = this._publish('session.identity.updated', {
      sessionId: session.sessionId,
      identity: patch
    }).seq;
    this._sessionsChanged();
    return true;
  }

  notifySessionIdentity(identity = {}, alert = {}) {
    const directId = cleanText(identity.sessionId, 128);
    const threadId = cleanText(identity.threadId, 500);
    const terminalUuid = cleanText(identity.terminalUuid, 500);
    const sessions = Array.from(this.sessions.values());
    const terminalMatches = terminalUuid
      ? sessions.filter((candidate) => candidate.terminalUuid === terminalUuid && candidate.state !== 'stopped')
      : [];
    const session = (directId && this.sessions.get(directId))
      || (threadId && sessions.find((candidate) => candidate.threadId === threadId && candidate.state !== 'stopped'))
      || (terminalMatches.length === 1 && terminalMatches[0]);
    if (!session || session.state === 'stopped' || typeof this.notifyAttention !== 'function') {
      return Promise.resolve({ sent: 0 });
    }
    return Promise.resolve(this.notifyAttention(attentionPushPayload(session, alert)))
      .catch(() => ({ sent: 0 }));
  }

  notifyTerminal(terminalId, alert = {}) {
    if (!Number.isSafeInteger(terminalId) || terminalId < 1 || typeof this.notifyAttention !== 'function') {
      return Promise.resolve({ sent: 0 });
    }
    const matches = Array.from(this.sessions.values()).filter((session) => (
      session.desktopTerminalId === terminalId && session.state !== 'stopped'
    ));
    if (matches.length !== 1) return Promise.resolve({ sent: 0 });
    return Promise.resolve(this.notifyAttention(attentionPushPayload(matches[0], alert)))
      .catch(() => ({ sent: 0 }));
  }

  publishQuota(snapshots = this.getQuota()) {
    const compact = compactQuotaSnapshots(snapshots, this.getProviderAccounts());
    clearTimeout(this.quotaFreshnessTimer);
    this.quotaFreshnessTimer = null;
    const now = Date.now();
    const nextExpiry = compact.reduce((next, snapshot) => (
      snapshot.stale ? next : Math.min(next, snapshot.fetchedAt + FRESHNESS_TTL_MS + 1)
    ), Infinity);
    if (nextExpiry > now && Number.isFinite(nextExpiry)) {
      this.quotaFreshnessTimer = setTimeout(() => {
        this.quotaFreshnessTimer = null;
        this.publishQuota();
      }, nextExpiry - now);
      this.quotaFreshnessTimer.unref?.();
    }
    return this._publish('quota.updated', { snapshots: compact });
  }

  publishProjects({ revision = this.getProjectsRevision() } = {}) {
    const allProjects = this._projects();
    const projects = allProjects.slice(0, 100);
    return this._publish('projects.updated', {
      revision: Number(revision) || 0,
      projects,
      shortcuts: this._shortcuts(allProjects),
      availableAgents: this._availableAgents(),
      projectsTruncated: allProjects.length > projects.length,
    });
  }

  publishProjectOperation(operation = {}) {
    const operationError = operation.error && typeof operation.error === 'object'
      ? compactCommandError(operation.error)
      : (typeof operation.error === 'string' && /^[a-z0-9_]{1,64}$/.test(operation.error)
        ? { code: operation.error, message: operation.error, retryable: false }
        : null);
    return this._publish('projects.operation.updated', {
      operationId: cleanText(operation.operationId, 128),
      requestId: cleanText(operation.requestId, 128),
      type: 'clone',
      state: cleanText(operation.state, 32),
      revision: Number.isSafeInteger(operation.revision) && operation.revision >= 0 ? operation.revision : 0,
      ...(typeof operation.projectId === 'string' ? { projectId: cleanText(operation.projectId, 128) } : {}),
      ...(operationError ? { error: operationError } : {}),
    });
  }

  publishTasksChanged({ projectId, revision }) {
    return this._publish('tasks.changed', {
      projectId: cleanText(projectId, 128),
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
    });
  }

  publishProjectIconEvent(event = {}) {
    const iconDataUrl = typeof event.iconDataUrl === 'string' && event.iconDataUrl.length <= 100_000
      ? event.iconDataUrl : null;
    return this._publish('project.icon.generated', {
      jobId: cleanText(event.jobId, 100),
      projectId: cleanText(event.projectId, 128),
      success: event.success === true,
      applied: event.applied === true,
      unavailable: event.unavailable === true,
      ...(cleanText(event.error, 500) ? { error: cleanText(event.error, 500) } : {}),
      ...(cleanText(event.icon, 300) ? { icon: cleanText(event.icon, 300) } : {}),
      ...(iconDataUrl ? { iconDataUrl } : {}),
    });
  }

  publishProviderLoginEvent(event = {}) {
    return this._publish('provider.login.event', {
      loginId: cleanText(event.loginId, 128),
      agent: MOBILE_AGENTS.has(event.agent) ? event.agent : null,
      type: cleanText(event.type, 64),
      payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
    });
  }

  publishProviderOperation(event = {}) {
    return this._publish('provider.operation.updated', {
      agent: MOBILE_AGENTS.has(event.agent) ? event.agent : null,
      operation: cleanText(event.operation, 64),
      stage: cleanText(event.stage, 100),
      line: cleanText(event.line, 2_000),
    });
  }

  _registerStartingSession(started) {
    const clientRequestId = cleanText(started?.clientRequestId, 128);
    if (!clientRequestId || typeof started.sessionId !== 'string') return;
    this._session(started.sessionId, {
      clientRequestId,
      agent: started.agent,
      provider: started.agent,
      accountId: started.accountId || 'current',
      accountLabel: started.accountLabel || null,
      terminalOrder: Number.isSafeInteger(started.terminalId) && started.terminalId > 0 ? started.terminalId : null,
      desktopTerminalId: Number.isSafeInteger(started.terminalId) && started.terminalId > 0 ? started.terminalId : null,
      cwd: started.cwd,
      state: 'starting'
    });
    this._publish('session.opened', {
      session: {
        sessionId: started.sessionId,
        clientRequestId,
        agent: started.agent,
        provider: started.agent,
        accountId: started.accountId || 'current',
        accountLabel: started.accountLabel || null,
        terminalOrder: Number.isSafeInteger(started.terminalId) && started.terminalId > 0 ? started.terminalId : null,
        cwd: started.cwd,
        state: 'starting'
      }
    });
  }

  _registerSession(started) {
    if (!started || typeof started.sessionId !== 'string') return;
    const restarting = this.sessions.get(started.sessionId)?.restarting === true;
    const clientRequestId = cleanText(started.clientRequestId, 128);
    this._session(started.sessionId, {
      clientRequestId,
      agent: started.agent,
      provider: started.agent,
      accountId: started.accountId || 'current',
      accountLabel: started.accountLabel || null,
      threadId: started.threadId,
      terminalUuid: started.terminalUuid,
      communicationEnabled: started.communicationEnabled === true,
      terminalOrder: Number.isSafeInteger(started.terminalId) && started.terminalId > 0 ? started.terminalId : null,
      desktopTerminalId: Number.isSafeInteger(started.terminalId) && started.terminalId > 0 ? started.terminalId : null,
      cwd: started.cwd,
      model: started.model,
      effort: started.effort,
      serviceTier: started.serviceTier,
      permissionMode: started.permissionMode,
      interactionMode: started.interactionMode,
      supportsResume: started.supportsResume !== false,
      needsAttention: false,
      attentionVersion: 0,
      minimized: false,
      resumed: started.resumed === true,
      state: 'ready'
    });
    this._publish('session.opened', {
      session: {
        sessionId: started.sessionId,
        ...(clientRequestId ? { clientRequestId } : {}),
        agent: started.agent,
        provider: started.agent,
        accountId: started.accountId || 'current',
        accountLabel: started.accountLabel || null,
        threadId: started.threadId,
        terminalUuid: started.terminalUuid,
        communicationEnabled: started.communicationEnabled === true,
        terminalOrder: Number.isSafeInteger(started.terminalId) && started.terminalId > 0 ? started.terminalId : null,
        cwd: started.cwd,
        model: started.model,
        effort: started.effort,
        serviceTier: started.serviceTier,
        permissionMode: started.permissionMode,
        interactionMode: started.interactionMode,
        supportsResume: started.supportsResume !== false,
        needsAttention: false,
        attentionVersion: 0,
        minimized: false,
        state: 'ready',
        resumed: started.resumed === true,
        hasEarlierHistory: started.resumed === true
      }
    });
    for (const event of restarting ? [] : started.historyEvents || []) {
      this._publishProviderEvent(started.sessionId, event);
    }
    this._sessionsChanged();
  }

  async _hydrateHistoryTranscript(sessionId, entry) {
    if (typeof this.getConversationContent !== 'function' || !entry?.sessionId) return;
    for (let attempt = 0; attempt < 20 && !this.sessions.has(sessionId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const session = this.sessions.get(sessionId) || this._session(sessionId, {
      agent: entry.agent,
      provider: entry.agent,
      threadId: entry.sessionId,
      cwd: entry.projectPath,
      state: 'ready'
    });
    const replayed = new Map();
    for (const item of session.items.values()) {
      if (item.itemType !== 'user_message' && item.itemType !== 'assistant_message') continue;
      const text = cleanText(item.data?.text ?? item.content?.assistant_text ?? item.detail, MAX_INITIAL_PROMPT_CHARS);
      const attachments = Array.isArray(item.data?.attachments) ? item.data.attachments : [];
      if (!text && !attachments.length) continue;
      const key = `${item.itemType}\0${text}`;
      if (!replayed.has(key)) replayed.set(key, []);
      replayed.get(key).push(item);
    }
    let messages = [];
    try {
      messages = await this.getConversationContent({
        sessionId: entry.sessionId,
        projectDir: entry.projectDir,
        agent: entry.agent
      });
    } catch (_error) {
      return;
    }
    if (!Array.isArray(messages) || !messages.length) return;
    const recent = normalizeConversationMessages(messages).slice(-200);
    recent.forEach((message, index) => {
      const role = message.role;
      const text = cleanText(message.text, MAX_INITIAL_PROMPT_CHARS);
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (!role || (!text && !attachments.length)) return;
      const key = `${role}\0${text}`;
      const existing = replayed.get(key)?.shift();
      const existingAttachments = Array.isArray(existing?.data?.attachments) ? existing.data.attachments : [];
      const hasAllRetainedAttachments = attachments.every((attachment, attachmentIndex) => {
        const retained = existingAttachments[attachmentIndex];
        return typeof retained?.attachmentId === 'string'
          && (!attachment?.type || retained.type === attachment.type)
          && (!attachment?.name || retained.name === attachment.name);
      });
      if (existing && (!attachments.length || hasAllRetainedAttachments)) {
        return;
      }
      const createdAt = Number.isFinite(message.timestamp)
        ? new Date(message.timestamp).toISOString()
        : new Date().toISOString();
      this._publishProviderEvent(sessionId, {
        eventId: `history-hydrate:${sessionId}:${entry.sessionId}:${index}`,
        provider: entry.agent,
        type: 'item.completed',
        itemId: existing?.itemId || `history-hydrate:${sessionId}:${entry.sessionId}:${index}`,
        createdAt,
        payload: {
          itemType: role,
          status: 'completed',
          data: {
            text: text || '',
            ...(attachments.length ? { attachments } : {})
          }
        }
      });
    });
    session.items = new Map(Array.from(session.items.entries()).sort(([, a], [, b]) => (
      (a.startedAtMs ?? Number.MAX_SAFE_INTEGER) - (b.startedAtMs ?? Number.MAX_SAFE_INTEGER)
    )));
  }

  _publishProviderEvent(sessionId, event) {
    // Handshake events arrive before SESSION_STARTED and have no user-visible
    // owner. Creating sessions from them leaves anonymous error cards behind.
    if (!this.sessions.has(sessionId)) return;
    if (!event || !isProviderEventType(event.type)) return;
    // A credential restart retains the live transcript. Native resume may replay
    // it with different IDs or deltas, so it must not be appended a second time.
    if (this.sessions.get(sessionId).restarting
      && ['item.started', 'item.updated', 'item.completed', 'content.delta', 'turn.started', 'turn.completed'].includes(event.type)) return;
    if (
      event.visibility === 'internal'
      && !['request.opened', 'request.updated', 'request.closed', 'question.opened',
        'question.updated', 'question.closed', 'runtime.error', 'session.exited'].includes(event.type)
    ) return;
    if (event.eventId && this.providerEventIds.has(event.eventId)) return;
    const compact = this._compactProviderEvent(sessionId, event);
    if (!compact || typeof sessionId !== 'string') return;
    if (compact.eventId) this.providerEventIds.add(compact.eventId);
    const session = this.sessions.get(sessionId);
    let anonymousItemStarted = null;
    const stream = compact.type === 'content.delta' ? compact.payload?.streamKind : null;
    if (session && !compact.itemId && (stream === 'assistant_text' || stream === 'reasoning_text')) {
      const prefix = `anonymous-${compact.turnId || compact.eventId}-${stream}-`;
      const latest = Array.from(session.items.values()).at(-1);
      compact.itemId = compact.turnId && latest?.itemId?.startsWith(prefix) && latest.status === 'inProgress'
        ? latest.itemId
        : `${prefix}${compact.eventId}`;
      if (!session.items.has(compact.itemId)) {
        anonymousItemStarted = {
          ...compact,
          eventId: `${compact.eventId}:item-started`,
          type: 'item.started',
          payload: {
            itemType: stream === 'assistant_text' ? 'assistant_message' : 'reasoning',
            status: 'inProgress'
          }
        };
      }
    }
    if (session && compact.itemId) {
      const providerItemId = compact.itemId;
      const aliased = session.itemAliases.get(providerItemId);
      if (aliased) {
        compact.itemId = aliased;
      } else if (compact.payload?.itemType === 'user_message' && !compact.payload.localEcho) {
        const text = cleanText(compact.payload.data?.text ?? compact.payload.detail, MAX_INITIAL_PROMPT_CHARS) || '';
        const remote = Array.from(session.items.values()).find((item) => {
          if (!item.localEcho || item.providerItemId) return false;
          const localText = cleanText(item.data?.text ?? item.detail, MAX_INITIAL_PROMPT_CHARS) || '';
          if (!text || localText === text) return true;
          const hasFileReference = item.data?.attachments?.some((attachment) => (
            attachment.type === 'file' || attachment.type === 'audio'
          ));
          const referencePrefix = `${localText ? `${localText}\n\n` : ''}Attached local files:\n- `;
          return hasFileReference && text.startsWith(referencePrefix);
        });
        if (remote) {
          session.itemAliases.set(providerItemId, remote.itemId);
          compact.itemId = remote.itemId;
        }
      }
      const localEcho = session.items.get(compact.itemId);
      if (localEcho?.localEcho && compact.payload?.itemType === 'user_message') {
        compact.payload = {
          ...compact.payload,
          providerItemId,
          data: { ...(compact.payload.data || {}), ...(localEcho.data || {}) }
        };
      }
    }
    if (anonymousItemStarted) {
      const started = this._publish('session.event', { sessionId, event: anonymousItemStarted });
      this._reduceSession(started.seq, sessionId, anonymousItemStarted);
    }
    const envelope = this._publish('session.event', { sessionId, event: compact });
    this._reduceSession(envelope.seq, sessionId, compact);
    if (this.remoteTurnSessions.has(sessionId) && typeof this.onRemoteProviderEvent === 'function') {
      try {
        this.onRemoteProviderEvent(sessionId, { threadId: session.threadId, event: compact });
      } catch (_) {}
    }
    if (this.remoteTurnSessions.has(sessionId) && compact.type === 'turn.completed') {
      const state = compact.payload?.state;
      const outcome = state === 'failed' ? 'failed' : state === 'interrupted' ? 'interrupted' : 'completed';
      this._reportUsage(`mobile_chat_turn_${outcome}`, { agent: session.agent || session.provider });
    }
    if (compact.type === 'turn.completed' || compact.type === 'session.exited') {
      this.remoteTurnSessions.delete(sessionId);
    }
    if (['session.state.changed', 'session.config.updated', 'session.exited', 'thread.started', 'turn.started', 'turn.completed'].includes(compact.type)) {
      this._sessionsChanged();
    }
  }

  _compactProviderEvent(sessionId, event) {
    const eventData = event?.payload?.data;
    const eventAttachments = Array.isArray(eventData?.attachments) ? eventData.attachments : null;
    const retainedAttachments = eventAttachments?.some((attachment) => typeof attachment?.dataUrl === 'string')
      ? this._retainAttachments(sessionId, eventAttachments)
      : eventAttachments;
    return compactProviderEvent(retainedAttachments === eventAttachments ? event : {
      ...event,
      payload: { ...event.payload, data: { ...eventData, attachments: retainedAttachments } }
    });
  }

  publishUserTurn(sessionId, { text = '', attachments = [] } = {}, { remote = false, itemId = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const retainedAttachments = this._retainAttachments(sessionId, attachments);
    this._publishProviderEvent(sessionId, {
      eventId: crypto.randomUUID(),
      provider: session.provider || session.agent,
      type: 'item.completed',
      executionOrigin: 'main',
      createdAt: new Date().toISOString(),
      itemId: itemId || `${remote ? 'mobile' : 'desktop'}-user-${crypto.randomUUID()}`,
      payload: {
        itemType: 'user_message',
        status: 'completed',
        localEcho: true,
        ...(remote ? { remoteCommand: true } : {}),
        data: { text, attachments: retainedAttachments }
      }
    });
    return true;
  }

  _retainAttachments(sessionId, attachments) {
    return (Array.isArray(attachments) ? attachments : []).map((attachment) => {
      if (!attachment || !['image', 'audio'].includes(attachment.type) || typeof attachment.dataUrl !== 'string') {
        return attachment;
      }
      const existing = cleanText(attachment.attachmentId, 128);
      if (existing && this.retainedMedia.get(existing)?.sessionId === sessionId) return attachment;
      const separator = attachment.dataUrl.indexOf(',');
      if (separator < 0) return attachment;
      const encoded = attachment.dataUrl.slice(separator + 1);
      const attachmentId = crypto.randomUUID();
      let thumbnailDataUrl = null;
      if (attachment.type === 'image' && typeof this.createAttachmentThumbnail === 'function') {
        try {
          const thumbnail = this.createAttachmentThumbnail(attachment.dataUrl);
          if (typeof thumbnail === 'string'
            && thumbnail.length <= MAX_THUMBNAIL_CHARS
            && /^data:image\/[a-z0-9.+-]+;base64,/i.test(thumbnail)) {
            thumbnailDataUrl = thumbnail;
          }
        } catch (_) {}
      }
      this.retainedMedia.set(attachmentId, {
        attachmentId,
        sessionId,
        type: attachment.type,
        name: cleanText(attachment.name, 255) || attachment.type,
        mimeType: cleanText(attachment.mimeType, 100) || `${attachment.type}/octet-stream`,
        sizeBytes: Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : Buffer.from(encoded, 'base64').length,
        encoded,
        updatedAt: Date.now()
      });
      this._pruneRetainedMedia();
      return {
        ...attachment,
        attachmentId,
        ...(thumbnailDataUrl ? { thumbnailDataUrl } : {})
      };
    });
  }

  _readRetainedAttachment(sessionId, payload) {
    const attachmentId = cleanText(payload.attachmentId, 128);
    const retained = attachmentId && this.retainedMedia.get(attachmentId);
    if (!retained || retained.sessionId !== sessionId) throw new Error('Attachment was not found');
    const index = Number(payload.index);
    const total = Math.max(1, Math.ceil(retained.encoded.length / MAX_ATTACHMENT_CHUNK_CHARS));
    if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw new Error('Invalid attachment chunk');
    retained.updatedAt = Date.now();
    return {
      attachmentId,
      index,
      total,
      type: retained.type,
      name: retained.name,
      mimeType: retained.mimeType,
      sizeBytes: retained.sizeBytes,
      data: retained.encoded.slice(index * MAX_ATTACHMENT_CHUNK_CHARS, (index + 1) * MAX_ATTACHMENT_CHUNK_CHARS)
    };
  }

  _pruneRetainedMedia() {
    let total = Array.from(this.retainedMedia.values()).reduce((sum, item) => sum + item.encoded.length, 0);
    if (total <= MAX_RETAINED_MEDIA_CHARS) return;
    const oldest = Array.from(this.retainedMedia.values()).sort((left, right) => left.updatedAt - right.updatedAt);
    for (const item of oldest) {
      this.retainedMedia.delete(item.attachmentId);
      total -= item.encoded.length;
      if (total <= MAX_RETAINED_MEDIA_CHARS) break;
    }
  }

  _publish(kind, payload) {
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: this.runtimeId,
      seq: ++this.sequence,
      eventId: crypto.randomUUID(),
      kind,
      createdAt: new Date().toISOString(),
      ...payload
    };
    this.streamMetrics.publishedEvents += 1;
    if (isSubscriptionOnlyEnvelope(envelope)) this.streamMetrics.highFrequencyPublished += 1;
    this.streamMetricsDirty = true;
    this.events.push(envelope);
    while (this.events.length > this.replayLimit) {
      const removed = this.events.shift();
      if (removed.kind === 'session.event' && removed.event?.eventId) {
        this.providerEventIds.delete(removed.event.eventId);
      }
    }
    for (const client of this.clients) {
      if (client.ready) this._sendStreamEnvelope(client, envelope);
    }
    return envelope;
  }

  _sendStreamEnvelope(client, envelope) {
    const highFrequency = isSubscriptionOnlyEnvelope(envelope);
    const subscribed = !highFrequency
      || client.subscriptions.has(envelope.sessionId);
    if (client.selective && !subscribed) {
      client.skippedSeq = envelope.seq;
      this.streamMetrics.highFrequencySkipped += 1;
      this.streamMetricsDirty = true;
      return true;
    }
    if (!this._flushSkippedSeq(client)) return false;
    const sent = this._send(client, envelope);
    if (sent && highFrequency) this.streamMetrics.highFrequencySent += 1;
    return sent;
  }

  _flushSkippedSeq(client) {
    if (!client.skippedSeq) return true;
    const sent = this._send(client, {
      kind: 'cursor.advanced',
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: this.runtimeId,
      seq: client.skippedSeq,
    });
    if (sent) {
      client.skippedSeq = 0;
      this.streamMetrics.cursorMarkersSent += 1;
    }
    return sent;
  }

  _session(sessionId, patch = {}) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        clientRequestId: null,
        agent: null,
        provider: null,
        accountId: 'current',
        accountLabel: null,
        threadId: null,
        terminalUuid: null,
        communicationEnabled: false,
        terminalOrder: null,
        desktopTerminalId: null,
        cwd: null,
        model: null,
        effort: null,
        serviceTier: null,
        permissionMode: null,
        interactionMode: null,
        supportsResume: true,
        title: null,
        goal: null,
        activity: null,
        activityHistory: [],
        workStatus: null,
        lastActivityAt: null,
        needsAttention: false,
        attentionVersion: 0,
        minimized: false,
        sandboxMode: false,
        resumed: false,
        historyTruncated: false,
        project: null,
        state: 'unknown',
        currentTurn: null,
        tokenUsage: null,
        diff: null,
        items: new Map(),
        itemAliases: new Map(),
        pendingRequests: new Map(),
        pendingQuestions: new Map(),
        lastSeq: 0
      };
      this.sessions.set(sessionId, session);
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) session[key] = value;
    }
    return session;
  }

  _reduceSession(seq, sessionId, event) {
    const session = this._session(sessionId, {
      provider: event.provider || undefined,
      threadId: event.threadId || undefined,
      lastSeq: seq
    });
    const payload = event.payload || {};
    if (event.type === 'session.state.changed') session.state = payload.state || session.state;
    if (event.type === 'session.config.updated') {
      for (const key of ['model', 'effort', 'serviceTier', 'permissionMode', 'interactionMode']) {
        if (payload[key] !== undefined) session[key] = payload[key];
      }
    }
    if (event.type === 'session.exited') session.state = 'stopped';
    if (event.type === 'thread.started') session.threadId = payload.providerThreadId || event.threadId;
    if (event.type === 'thread.token-usage.updated') session.tokenUsage = payload.usage || null;
    if (event.type === 'turn.started') {
      session.currentTurn = { turnId: event.turnId, state: 'running' };
    }
    if (event.type === 'turn.completed') {
      const endedAtMs = Date.parse(event.createdAt);
      session.currentTurn = { turnId: event.turnId, state: payload.state || 'completed' };
      for (const item of session.items.values()) {
        if (item.turnId === event.turnId && item.status === 'inProgress') {
          item.status = payload.state === 'failed' ? 'failed' : 'completed';
          if (Number.isFinite(endedAtMs)) item.endedAtMs = endedAtMs;
        }
      }
    }
    if (event.type === 'turn.diff.updated') session.diff = payload.unifiedDiff || '';

    if (event.itemId && event.type.startsWith('item.')) {
      const previous = session.items.get(event.itemId) || { itemId: event.itemId, content: {} };
      const eventAtMs = Date.parse(event.createdAt);
      session.items.set(event.itemId, {
        ...previous,
        ...payload,
        itemId: event.itemId,
        turnId: event.turnId || previous.turnId,
        status: payload.status || (event.type === 'item.completed' ? 'completed' : previous.status),
        ...(Number.isFinite(eventAtMs) && previous.startedAtMs === undefined
          ? { startedAtMs: eventAtMs }
          : {}),
        ...(Number.isFinite(eventAtMs) && event.type === 'item.completed'
          ? { endedAtMs: eventAtMs }
          : {})
      });
      // ponytail: retain the latest 500 timeline items; persist transcripts if mobile history exceeds it.
      while (session.items.size > MAX_ITEMS_PER_SESSION) {
        const oldestItemId = session.items.keys().next().value;
        const oldestItem = session.items.get(oldestItemId);
        if (oldestItem?.itemType === 'user_message' || oldestItem?.itemType === 'assistant_message') {
          session.historyTruncated = true;
        }
        session.items.delete(oldestItemId);
      }
    }
    if (event.itemId && event.type === 'content.delta') {
      const item = session.items.get(event.itemId) || { itemId: event.itemId, content: {} };
      const stream = payload.streamKind || 'unknown';
      const next = `${item.content?.[stream] || ''}${payload.delta || ''}`;
      item.content = {
        ...(item.content || {}),
        [stream]: next.length > MAX_CONTENT_CHARS ? next.slice(-MAX_CONTENT_CHARS) : next
      };
      if (next.length > MAX_CONTENT_CHARS) item.contentTruncated = true;
      session.items.set(event.itemId, item);
    }
    if (event.requestId && event.type === 'request.opened') {
      session.pendingRequests.set(event.requestId, { requestId: event.requestId, ...payload });
    }
    if (event.requestId && event.type === 'request.resolved') {
      session.pendingRequests.delete(event.requestId);
    }
    if (event.requestId && event.type === 'question.opened') {
      session.pendingQuestions.set(event.requestId, { requestId: event.requestId, ...payload });
    }
    if (event.requestId && event.type === 'question.resolved') {
      session.pendingQuestions.delete(event.requestId);
    }
  }

  _handleMessage(client, raw) {
    const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
    if (bytes > MAX_MESSAGE_BYTES) {
      this._sendProtocolError(client, 'message_too_large', 'Messages are limited to 1 MB');
      return;
    }
    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch (_) {
      this._sendProtocolError(client, 'invalid_json', 'Message must be valid JSON');
      return;
    }
    if (!client.ready) {
      this._handleHello(client, message);
      return;
    }
    if (message.kind !== 'command') {
      this._sendProtocolError(client, 'unknown_message', 'Expected a command');
      return;
    }
    this._handleCommand(client, message);
  }

  _handleHello(client, message) {
    const helloReceivedAt = Date.now();
    if (message.kind !== 'hello' || message.protocolVersion !== PROTOCOL_VERSION) {
      this._sendProtocolError(client, 'unsupported_protocol', `Protocol ${PROTOCOL_VERSION} is required`);
      return;
    }
    client.selective = Array.isArray(message.features)
      && message.features.slice(0, 20).includes(SESSION_SUBSCRIPTIONS_FEATURE);
    const projectIcons = Array.isArray(message.features)
      && message.features.slice(0, 20).includes(SNAPSHOT_PROJECT_ICONS_FEATURE);
    client.subscriptions = new Set(client.selective && Array.isArray(message.subscriptions)
      ? message.subscriptions.slice(0, 20).filter((sessionId) => (
          typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 128
        ))
      : []);
    client.skippedSeq = 0;
    this.streamMetrics.helloMessages += 1;
    this.streamMetricsDirty = true;
    const cursor = message.cursor;
    const oldestSeq = this.events.length ? this.events[0].seq : this.sequence + 1;
    const replayable = this.sequence > 0
      && cursor
      && cursor.runtimeId === this.runtimeId
      && Number.isSafeInteger(cursor.seq)
      && cursor.seq >= oldestSeq - 1
      && cursor.seq <= this.sequence;
    const welcome = {
      kind: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: this.runtimeId,
      latestSeq: this.sequence,
      reset: !replayable,
      features: [
        ...(client.selective ? [SESSION_SUBSCRIPTIONS_FEATURE] : []),
        ...(projectIcons ? [SNAPSHOT_PROJECT_ICONS_FEATURE] : []),
      ],
      desktop: this.getClientMetadata(),
      capabilities: (this.getCapabilities() || []).slice(0, 50).flatMap((capability) => (
        typeof capability === 'string' && capability.length <= 100 ? [capability] : []
      )),
      ...(!replayable ? { snapshot: this.snapshot({ projectIcons }) } : {})
    };
    this.streamMetrics[replayable ? 'replayWelcomes' : 'resetWelcomes'] += 1;
    // How long the desktop itself took to answer, so the mobile reconnect timeline can
    // separate desktop work (mostly building the snapshot) from transport time.
    welcome.builtMs = Math.max(0, Math.round(Date.now() - helloReceivedAt));
    this._send(client, welcome);
    if (replayable) {
      for (const event of this.events) {
        if (event.seq > cursor.seq) this._sendStreamEnvelope(client, event);
      }
      this._flushSkippedSeq(client);
    }
    client.ready = true;
    if (!replayable && welcome.snapshot?.truncated) this.publishProjects();
  }

  _handleCommand(client, message) {
    const commandId = message.commandId;
    if (typeof commandId !== 'string' || commandId.length < 1 || commandId.length > 128) {
      this._sendProtocolError(client, 'invalid_command_id', 'commandId must be 1-128 characters');
      return;
    }
    // Attachment chunks and private requested reads already have their own bounds.
    // Their payloads must not also enter command history or replay.
    const directResult = ['attachment.read', 'history.older', 'session.subscribe', 'session.unsubscribe', 'coordination.sessions', 'coordination.transcript', 'coordination.message', 'coordination.peers.replace',
      'tasks.list', 'projects.list', 'project.directories.list', 'project.locations.list',
      'providers.list', 'provider.login.describe',
      'workspace.files.list', 'workspace.files.read', 'workspace.files.search',
      'workspace.git.status', 'workspace.git.diff', 'workspace.git.log', 'workspace.git.branches'].includes(message.command?.type);
    const existing = directResult ? null : this.commands.get(commandId);
    if (existing) {
      this._send(client, { kind: 'command.accepted', commandId, duplicate: true });
      if (existing.done) {
        this._send(client, { kind: 'command.result', commandId, ...existing.result });
      }
      return;
    }

    const record = directResult ? null : { done: false, result: null };
    if (record) this.commands.set(commandId, record);
    this._send(client, { kind: 'command.accepted', commandId, duplicate: false });
    Promise.resolve()
      .then(() => this._executeCommand(message.command, {
        commandId,
        client,
        deviceId: client.socket?.device?.id,
        reply: (payload) => this._send(client, {
          kind: 'coordination.message',
          protocolVersion: PROTOCOL_VERSION,
          runtimeId: this.runtimeId,
          message: payload,
        }),
      }))
      .then(
        (result) => ({ success: true, result }),
        (error) => ({ success: false, error: compactCommandError(error) })
      )
      .then((result) => {
        const commandType = message.command?.type;
        const successAction = MOBILE_USAGE_ACTIONS[commandType];
        if (successAction) {
          const resultSessionId = result.result?.sessionId || message.command?.sessionId;
          const session = this.sessions.get(resultSessionId);
          const candidateAgent = session?.agent || session?.provider || message.command?.payload?.agent;
          const agent = MOBILE_AGENTS.has(candidateAgent) ? candidateAgent : null;
          this._reportUsage(result.success ? successAction : 'mobile_command_failed', {
            ...(agent ? { agent } : {}),
            ...(!result.success ? { command_type: commandType } : {})
          });
        }
        if (!record) {
          this._send(client, { kind: 'command.result', commandId, ...result });
          return;
        }
        record.done = true;
        record.result = result;
        this._publish('command.completed', { commandId, ...result });
        this._pruneCommands();
      });
  }

  _reportUsage(action, context = {}) {
    if (typeof this.onUsageEvent !== 'function') return;
    try { this.onUsageEvent(action, { surface: 'mobile', ...context }); } catch (_) {}
  }

  async _executeCommand(command = {}, context = {}) {
    this._pruneAttachmentUploads();
    const sessionId = command.sessionId;
    const payload = command.payload || {};
    const exactPayload = (allowed) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The command payload is invalid');
      const unexpected = Object.keys(payload).find((key) => !allowed.includes(key));
      if (unexpected) throw new Error(`Unexpected project field: ${unexpected}`);
    };
    const mutationRequestId = () => payload.requestId || context.commandId;
    if (command.type === 'session.subscribe' || command.type === 'session.unsubscribe') {
      exactPayload([]);
      if (!context.client?.selective) throw new Error('Session subscriptions were not negotiated');
      const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : null;
      if (!session) throw new Error('The agent is no longer open');
      if (command.type === 'session.unsubscribe') {
        context.client.subscriptions.delete(sessionId);
        this.streamMetrics.unsubscribeCommands += 1;
        this.streamMetricsDirty = true;
        return { subscribed: false };
      }
      if (!this._flushSkippedSeq(context.client)) {
        throw new Error('The session cursor could not be synchronized');
      }
      context.client.subscriptions.add(sessionId);
      this.streamMetrics.subscribeCommands += 1;
      this.streamMetrics.hydrationSnapshots += 1;
      this.streamMetricsDirty = true;
      return {
        subscribed: true,
        session: this._subscriptionSnapshot(session),
      };
    }
    if (command.type === 'coordination.peers.replace') {
      if (typeof this.replaceCoordinatedPeers !== 'function' || typeof context.deviceId !== 'string') {
        throw new Error('Private device groups are unavailable');
      }
      exactPayload(['peers']);
      return this.replaceCoordinatedPeers(context.deviceId, payload.peers);
    }
    if (command.type === 'coordination.sessions') {
      if (typeof this.listCoordinatedSessions !== 'function') throw new Error('Session discovery is unavailable');
      exactPayload([]);
      return this.listCoordinatedSessions();
    }
    if (command.type === 'coordination.transcript') {
      if (typeof this.readCoordinatedTranscript !== 'function') throw new Error('Conversation reading is unavailable');
      exactPayload(['targetSessionId', 'limit']);
      const targetSessionId = cleanText(payload.targetSessionId, 128);
      const limit = payload.limit === undefined ? 30 : Number(payload.limit);
      if (!targetSessionId) throw new Error('Choose a session to read');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
        throw new Error('Conversation limit must be between 1 and 60');
      }
      return this.readCoordinatedTranscript({ targetSessionId, limit });
    }
    if (command.type === 'coordination.message') {
      if (typeof this.sendCoordinatedMessage !== 'function') throw new Error('Session messaging is unavailable');
      exactPayload(['sourceSessionId', 'targetSessionId', 'sourceName', 'sourceAgent', 'message', 'communicationRequestId', 'replyTargetSessionId']);
      if (typeof payload.sourceSessionId !== 'string' || !payload.sourceSessionId.trim() || payload.sourceSessionId.length > 128
        || typeof payload.targetSessionId !== 'string' || !payload.targetSessionId.trim() || payload.targetSessionId.length > 128
        || typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 12_000
        || typeof payload.communicationRequestId !== 'string' || !payload.communicationRequestId.trim() || payload.communicationRequestId.length > 128
        || typeof payload.replyTargetSessionId !== 'string' || !payload.replyTargetSessionId.trim() || payload.replyTargetSessionId.length > 512) {
        throw new Error('Session message details are invalid');
      }
      const sourceSessionId = cleanText(payload.sourceSessionId, 128);
      const targetSessionId = cleanText(payload.targetSessionId, 128);
      const sourceName = cleanText(payload.sourceName, 120);
      const sourceAgent = cleanText(payload.sourceAgent, 60);
      const message = cleanText(payload.message, 12_000);
      const communicationRequestId = cleanText(payload.communicationRequestId, 128);
      const replyTargetSessionId = cleanText(payload.replyTargetSessionId, 512);
      if (!sourceSessionId || !targetSessionId || !message || !communicationRequestId || !replyTargetSessionId) {
        throw new Error('Session message details are invalid');
      }
      return this.sendCoordinatedMessage({
        sourceSessionId,
        targetSessionId,
        sourceName,
        sourceAgent,
        message,
        communicationRequestId,
        replyTargetSessionId,
      }, context.reply);
    }
    if (command.type === 'projects.list') {
      if (typeof this.listProjects !== 'function') throw new Error('Remote projects are unavailable');
      exactPayload(['cursor', 'limit']);
      return this.listProjects({ cursor: payload.cursor, limit: payload.limit });
    }
    if (command.type === 'project.directories.list') {
      if (typeof this.listProjectDirectories !== 'function') throw new Error('Remote folder browsing is unavailable');
      exactPayload(['directoryPath', 'rootId', 'relativePath']);
      return this.listProjectDirectories({
        directoryPath: payload.directoryPath,
        rootId: payload.rootId,
        relativePath: payload.relativePath,
      });
    }
    if (['project.locations.list', 'project.locations.add'].includes(command.type)) {
      const adding = command.type === 'project.locations.add';
      exactPayload(adding ? ['locationId', 'requestId'] : ['locationId', 'offset']);
      try {
        const result = adding
          ? await this.addProjectLocation({ locationId: payload.locationId, requestId: mutationRequestId() })
          : await this.listProjectLocations(payload);
        if (adding) this.publishProjects();
        return result;
      } catch (error) {
        // Filesystem/SQLite exceptions must not disclose paths to the controller.
        throw Object.assign(new Error('The remote location could not be read or saved.'), {
          code: ['location_expired', 'location_permission_denied'].includes(error.code) ? error.code : 'location_unavailable',
        });
      }
    }
    if (command.type === 'project.create') {
      if (typeof this.createProject !== 'function') throw new Error('Remote project creation is unavailable');
      exactPayload(['name', 'projectPath', 'color', 'icon', 'requestId']);
      const result = await this.createProject({ ...payload, requestId: mutationRequestId() });
      this.publishProjects();
      return result;
    }
    if (command.type === 'project.update') {
      if (typeof this.updateProject !== 'function') throw new Error('Remote project editing is unavailable');
      exactPayload(['projectId', 'displayName', 'projectPath', 'color', 'icon', 'requestId']);
      const result = await this.updateProject({ ...payload, requestId: mutationRequestId() });
      this.publishProjects();
      return result;
    }
    if (command.type === 'project.git.availability') {
      if (typeof this.gitAvailability !== 'function') return { available: false };
      exactPayload(['rootId']);
      return this.gitAvailability({ rootId: cleanText(payload.rootId, 128) });
    }
    if (command.type === 'project.github.repositories') {
      exactPayload(['rootId']);
      if (typeof this.listGitHubRepositories !== 'function') throw new Error('Remote GitHub import is unavailable');
      return this.listGitHubRepositories();
    }
    if (command.type === 'project.icon.availability') {
      if (typeof this.projectIconAvailability !== 'function') return { available: false };
      exactPayload(['projectId']);
      return this.projectIconAvailability({ projectId: cleanText(payload.projectId, 128) });
    }
    if (command.type === 'project.icon.generate') {
      if (typeof this.generateProjectIcon !== 'function') throw new Error('Codex icon generation is unavailable');
      exactPayload(['projectId', 'description', 'jobId']);
      const projectId = cleanText(payload.projectId, 128);
      const description = cleanText(payload.description, 1000);
      const jobId = cleanText(payload.jobId, 100);
      if (!projectId || !description || !jobId || !/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Project icon request is invalid');
      return this.generateProjectIcon({ projectId, description, jobId });
    }
    if (command.type === 'project.register') {
      if (typeof this.registerProject !== 'function') throw new Error('Remote project registration is unavailable');
      exactPayload(['rootId', 'relativePath', 'requestId']);
      const result = await this.registerProject({ rootId: payload.rootId, relativePath: payload.relativePath, requestId: mutationRequestId() });
      this.publishProjects();
      return result;
    }
    if (command.type === 'project.clone') {
      if (typeof this.cloneProject !== 'function') throw new Error('Remote project cloning is unavailable');
      exactPayload(['rootId', 'url', 'relativePath', 'displayName', 'color', 'icon', 'requestId', 'githubRepository']);
      if (typeof payload.requestId !== 'string' || !payload.requestId) throw new Error('A clone requestId is required');
      return this.cloneProject({
        rootId: payload.rootId,
        url: payload.url,
        ...(payload.githubRepository !== undefined ? { githubRepository: payload.githubRepository } : {}),
        relativePath: payload.relativePath,
        displayName: payload.displayName,
        color: payload.color,
        icon: payload.icon,
        requestId: payload.requestId,
      });
    }
    if (command.type === 'project.clone.cancel') {
      if (typeof this.cancelProjectClone !== 'function') throw new Error('Remote clone cancellation is unavailable');
      exactPayload(['operationId', 'requestId']);
      return this.cancelProjectClone({ operationId: payload.operationId, requestId: mutationRequestId() });
    }
    if (command.type === 'project.unregister') {
      if (typeof this.unregisterProject !== 'function') throw new Error('Remote project removal is unavailable');
      exactPayload(['projectId', 'requestId']);
      const result = await this.unregisterProject({ projectId: payload.projectId, requestId: mutationRequestId() });
      this.publishProjects();
      return result;
    }
    if (command.type === 'shortcuts.replace') {
      if (typeof this.replaceShortcuts !== 'function') throw new Error('Remote shortcut management is unavailable');
      exactPayload(['shortcuts']);
      if (!Array.isArray(payload.shortcuts) || payload.shortcuts.length > MAX_TERMINAL_SHORTCUTS) {
        throw new Error(`Choose up to ${MAX_TERMINAL_SHORTCUTS} shortcuts`);
      }
      const projects = this._projects();
      const shortcuts = payload.shortcuts.map((shortcut) => {
        if (!shortcut || typeof shortcut !== 'object' || Array.isArray(shortcut)) throw new Error('The shortcut is invalid');
        const unexpected = Object.keys(shortcut).find((key) => !['name', 'projectPath', 'agent', 'useWorktree'].includes(key));
        if (unexpected) throw new Error(`Unexpected shortcut field: ${unexpected}`);
        const projectPath = cleanText(shortcut.projectPath, 4096);
        const project = projects.find((candidate) => projectPathsMatch(candidate.path, projectPath));
        if (!project) throw new Error('Choose a configured project');
        const name = cleanText(shortcut.name, 80);
        if (!name) throw new Error('Name the shortcut');
        if (!this._availableAgents().includes(shortcut.agent)) throw new Error('Choose an installed provider');
        if (shortcut.useWorktree !== null && shortcut.useWorktree !== undefined && typeof shortcut.useWorktree !== 'boolean') {
          throw new Error('The shortcut worktree option is invalid');
        }
        return {
          name,
          project_path: project.path,
          project_name: project.name,
          project_color: project.color || '#007ACC',
          agent_type: shortcut.agent,
          use_worktree: shortcut.useWorktree ?? null,
        };
      });
      const result = await this.replaceShortcuts(shortcuts);
      if (result?.success === false) throw new Error(result.error || 'Could not save shortcuts');
      this.publishProjects();
      return { success: true, shortcuts: this._shortcuts() };
    }
    if (command.type === 'tasks.list') {
      if (typeof this.listTasks !== 'function') throw new Error('Remote tasks are unavailable');
      exactPayload(['projectId', 'cursor', 'limit']);
      return this.listTasks({
        projectId: cleanText(payload.projectId, 128),
        cursor: payload.cursor === null || payload.cursor === undefined ? null : cleanText(payload.cursor, 256),
        limit: payload.limit
      });
    }
    if (command.type === 'task.create') {
      if (typeof this.createTask !== 'function') throw new Error('Remote task creation is unavailable');
      exactPayload(['projectId', 'title', 'description', 'parentTaskId', 'labels', 'status', 'plan', 'implementation', 'requestId']);
      return this.createTask({ ...payload, requestId: mutationRequestId() });
    }
    if (command.type === 'task.update') {
      if (typeof this.updateTask !== 'function') throw new Error('Remote task updates are unavailable');
      exactPayload(['projectId', 'id', 'targetProjectId', 'title', 'description', 'status', 'plan', 'implementation', 'labels', 'parentTaskId', 'sortOrder', 'requestId']);
      return this.updateTask({ ...payload, requestId: mutationRequestId() });
    }
    if (command.type === 'task.delete') {
      if (typeof this.deleteTask !== 'function') throw new Error('Remote task deletion is unavailable');
      exactPayload(['projectId', 'id', 'requestId']);
      return this.deleteTask({ ...payload, requestId: mutationRequestId() });
    }
    if (command.type === 'tasks.mutate') {
      if (typeof this.mutateTasks !== 'function') throw new Error('Remote task mutations are unavailable');
      exactPayload(['operations', 'requestId']);
      return this.mutateTasks({ operations: payload.operations, requestId: mutationRequestId() });
    }
    if (command.type === 'providers.list') {
      if (typeof this.listProviders !== 'function') throw new Error('Remote provider management is unavailable');
      exactPayload([]);
      return { providers: await this.listProviders() };
    }
    if (command.type === 'provider.install') {
      if (typeof this.installProvider !== 'function') throw new Error('Remote provider installation is unavailable');
      exactPayload(['agent', 'requestId']);
      if (!MOBILE_AGENTS.has(payload.agent)) throw new Error('Choose a supported provider');
      const result = await this.installProvider(payload.agent, (progress) => this.publishProviderOperation({
        agent: payload.agent,
        operation: 'install',
        ...progress,
      }));
      this.publishProjects();
      return result;
    }
    if (command.type === 'provider.login.describe') {
      if (typeof this.describeProviderLogin !== 'function') throw new Error('Remote provider sign-in is unavailable');
      exactPayload(['agent']);
      if (!MOBILE_AGENTS.has(payload.agent)) throw new Error('Choose a supported provider');
      const session = sessionId ? this.sessions.get(sessionId) : null;
      if (sessionId && (!session || session.agent !== payload.agent)) throw new Error('Remote sign-in session is invalid');
      return this.describeProviderLogin(payload.agent, { accountId: session?.accountId || 'current' });
    }
    if (command.type === 'provider.login.start') {
      if (typeof this.startProviderLogin !== 'function') throw new Error('Remote provider sign-in is unavailable');
      exactPayload(['agent', 'replaceAccount']);
      if (!MOBILE_AGENTS.has(payload.agent) || (payload.replaceAccount !== undefined && typeof payload.replaceAccount !== 'boolean')) {
        throw new Error('Remote provider sign-in is invalid');
      }
      const session = sessionId ? this.sessions.get(sessionId) : null;
      if (sessionId && (!session || session.agent !== payload.agent)) throw new Error('Remote sign-in session is invalid');
      if (session?.currentTurn?.state === 'running') throw new Error('Wait for the current response to finish');
      return this.startProviderLogin({ agent: payload.agent, accountId: session?.accountId || 'current', replaceAccount: payload.replaceAccount === true });
    }
    if (command.type === 'provider.login.submit') {
      if (typeof this.submitProviderLogin !== 'function') throw new Error('Remote provider sign-in is unavailable');
      exactPayload(['loginId', 'text']);
      return this.submitProviderLogin(cleanText(payload.loginId, 128), cleanText(payload.text, 10_000) || '');
    }
    if (command.type === 'provider.login.cancel') {
      if (typeof this.cancelProviderLogin !== 'function') throw new Error('Remote provider sign-in is unavailable');
      exactPayload(['loginId']);
      return this.cancelProviderLogin(cleanText(payload.loginId, 128));
    }
    const workspaceOperations = {
      'workspace.files.list': [this.workspaceFilesList, ['projectId', 'relativePath']],
      'workspace.files.read': [this.workspaceFilesRead, ['projectId', 'relativePath']],
      'workspace.files.search': [this.workspaceFilesSearch, ['projectId', 'relativePath', 'query']],
      'workspace.git.status': [this.workspaceGitStatus, ['projectId']],
      'workspace.git.diff': [this.workspaceGitDiff, ['projectId']],
      'workspace.git.log': [this.workspaceGitLog, ['projectId']],
      'workspace.git.branches': [this.workspaceGitBranches, ['projectId']],
      'workspace.git.switch': [this.workspaceGitSwitch, ['projectId', 'branchName']],
      'workspace.git.create': [this.workspaceGitCreate, ['projectId', 'branchName']],
    };
    if (workspaceOperations[command.type]) {
      const [operation, allowed] = workspaceOperations[command.type];
      if (typeof operation !== 'function') throw new Error('Remote workspace operation is unavailable');
      exactPayload(allowed);
      const projectId = cleanText(payload.projectId, 128);
      if (!projectId) throw new Error('Choose a configured project');
      return operation({
        projectId,
        relativePath: payload.relativePath,
        query: payload.query,
        branchName: payload.branchName === undefined ? undefined : cleanText(payload.branchName, 255),
      });
    }
    if (command.type === 'preview.create') {
      if (!this.previewService) throw new Error('Localhost previews are unavailable');
      return this.previewService.create(payload.url);
    }
    if (command.type === 'preview.close') {
      if (!this.previewService) return { closed: false };
      return { closed: this.previewService.close(payload.shareId) };
    }
    if (command.type === 'history.list') {
      const rows = await this.getHistory();
      const projects = this._projects();
      const projectsByPath = new Map(projects.map((project) => [project.path, project]));
      const conversations = (Array.isArray(rows) ? rows : []).slice(0, 500).flatMap((row) => {
        if (!row || typeof row.sessionId !== 'string' || typeof row.projectPath !== 'string') return [];
        const agent = row.agent
          || (row.isCodex ? 'codex'
            : (row.isAntigravity ? 'antigravity'
              : (row.isOpencode ? 'opencode' : (row.isKimi ? 'kimi' : (row.isGrok ? 'grok' : (row.isCursor ? 'cursor' : 'claude'))))));
        if (!MOBILE_AGENTS.has(agent)) return [];
        const projectDir = cleanText(row.projectDir, 4096) || '';
        const project = projectsByPath.get(row.projectPath)
          || projects.find((entry) => projectPathsMatch(entry.path, row.projectPath));
        const entry = {
          id: crypto.createHash('sha256').update(`${agent}\0${row.sessionId}\0${projectDir}`).digest('base64url').slice(0, 43),
          sessionId: row.sessionId,
          agent,
          title: cleanText(row.displayText || row.display, 300) || 'Untitled conversation',
          projectPath: project?.path || row.projectPath,
          projectDir,
          projectName: project?.name || cleanText(row.projectName, 200) || path.basename(row.projectPath),
          timestamp: Number.isFinite(row.timestamp) ? row.timestamp : 0,
          ...(agent === 'cursor'
            ? { supportsChatResume: row.supportsChatResume === true }
            : {})
        };
        return [entry];
      });
      this.history = new Map(conversations.map((entry) => [entry.id, entry]));
      return { conversations };
    }
    if (command.type === 'session.resume') {
      if (typeof this.createSession !== 'function') throw new Error('Remote session creation is unavailable');
      const entry = this.history.get(payload.historyId);
      if (!entry) throw new Error('Reload history before opening this conversation');
      if (entry.agent === 'cursor' && entry.supportsChatResume !== true) {
        throw new Error('This Cursor CLI version cannot resume ACP chats. Run `cursor-agent update` or start a new chat.');
      }
      const active = Array.from(this.sessions.values()).find((session) => (
        session.agent === entry.agent
        && session.threadId === entry.sessionId
        && session.state !== 'stopped'
      ));
      if (active) {
        await this._hydrateHistoryTranscript(active.sessionId, entry);
        return { success: true, sessionId: active.sessionId, reused: true };
      }
      const pending = this.historyResumes.get(entry.id);
      if (pending) return pending;
      const resume = Promise.resolve(this.createSession({
        agent: entry.agent,
        cwd: entry.projectPath,
        initialPrompt: '',
        resumeSessionId: entry.sessionId,
        title: entry.title
      })).then(async (result) => {
        if (result?.sessionId) await this._hydrateHistoryTranscript(result.sessionId, entry);
        return result;
      }).finally(() => {
        if (this.historyResumes.get(entry.id) === resume) this.historyResumes.delete(entry.id);
      });
      this.historyResumes.set(entry.id, resume);
      return resume;
    }
    if (command.type === 'session.create') {
      if (typeof this.createSession !== 'function') throw new Error('Remote session creation is unavailable');
      if (!MOBILE_AGENTS.has(payload.agent)) throw new Error('Choose a supported agent');
      const sharedCreateFields = ['agent', 'initialPrompt', 'clientRequestId', 'useWorktree'];
      let project;
      if (Object.hasOwn(payload, 'projectId')) {
        exactPayload([...sharedCreateFields, 'projectId']);
        if (typeof payload.projectId !== 'string' || !payload.projectId || payload.projectId.length > 128) {
          throw new Error('Choose a configured project');
        }
        project = this._projects().find((entry) => entry.projectId === payload.projectId);
        if (!project) throw new Error('Choose a project configured on this computer');
      } else {
        exactPayload([...sharedCreateFields, 'cwd']);
        if (typeof payload.cwd !== 'string' || !payload.cwd || payload.cwd.length > 4096) {
          throw new Error('Choose a configured project');
        }
        project = this._projects().find((entry) => projectPathsMatch(entry.path, payload.cwd));
        if (!project) throw new Error('Choose a project configured on this computer');
      }
      const initialPrompt = payload.initialPrompt === undefined ? '' : payload.initialPrompt;
      if (typeof initialPrompt !== 'string' || initialPrompt.length > MAX_INITIAL_PROMPT_CHARS) {
        throw new Error('The first message is too long');
      }
      if (payload.clientRequestId !== undefined && (
        typeof payload.clientRequestId !== 'string'
        || !payload.clientRequestId.trim()
        || payload.clientRequestId.length > 128
      )) throw new Error('The session request id is invalid');
      if (payload.useWorktree !== undefined && typeof payload.useWorktree !== 'boolean') {
        throw new Error('The worktree preference is invalid');
      }
      const clientRequestId = payload.clientRequestId?.trim() || null;
      try {
        const result = await this.createSession({
          agent: payload.agent,
          cwd: project.path,
          ...(project.projectId ? { projectId: project.projectId } : {}),
          initialPrompt: initialPrompt.trim(),
          ...(typeof payload.useWorktree === 'boolean'
            ? { useWorktree: payload.useWorktree && project.worktreeEligible === true }
            : {}),
          ...(clientRequestId ? { clientRequestId } : {})
        });
        if (!result || typeof result.sessionId !== 'string' || !result.sessionId) {
          throw new Error(result?.error || 'The desktop could not create the session');
        }
        return result;
      } catch (error) {
        const started = clientRequestId && Array.from(this.sessions.values()).find((session) => (
          session.clientRequestId === clientRequestId && session.state !== 'stopped'
        ));
        if (started) {
          started.state = 'stopped';
          started.lastSeq = this._publish('session.closed', {
            sessionId: started.sessionId,
            reason: 'start_failed'
          }).seq;
        }
        throw error;
      }
    }
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('A live sessionId is required');
    switch (command.type) {
      case 'history.older': {
        const session = this._session(sessionId);
        if (typeof this.getConversationContent !== 'function' || !session.threadId) {
          return { items: [], nextCursor: null, hasMore: false };
        }
        const messages = await this.getConversationContent({
          sessionId: session.threadId,
          projectDir: session.cwd,
          agent: session.agent
        });
        const knownCount = Array.from(session.items.values()).filter(isConversationItem).length;
        // A subscribed client receives this session's bounded snapshot on subscribe. Its own
        // knownCount can still describe the truncated welcome it asked from, so the page must
        // end before the rows that hydration delivers or they show up twice.
        const hydratedCount = context.client?.subscriptions?.has(sessionId)
          ? this._subscriptionSnapshot(session).items.filter(isConversationItem).length
          : 0;
        const page = pageConversationMessages(messages, {
          before: Number.isSafeInteger(payload.before) ? payload.before : undefined,
          anchor: payload.anchor && typeof payload.anchor === 'object' ? {
            role: cleanText(payload.anchor.role, 32),
            text: cleanText(payload.anchor.text, 2000),
            timestamp: cleanText(payload.anchor.timestamp, 64)
          } : null,
          knownCount: Number.isSafeInteger(payload.knownCount) ? payload.knownCount : knownCount,
          hydratedCount,
          limit: 30
        });
        const events = conversationMessagesToEvents(page.messages, {
          provider: session.agent,
          threadId: session.threadId
        });
        return {
          items: events.map((event) => {
            const compact = this._compactProviderEvent(sessionId, event);
            return {
              itemId: compact.itemId,
              itemType: compact.payload.itemType,
              status: 'completed',
              data: {
                ...compact.payload.data,
                text: cleanText(compact.payload.data.text, 20000) || ''
              },
              content: {},
              startedAtMs: Date.parse(compact.createdAt),
              endedAtMs: Date.parse(compact.createdAt)
            };
          }),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore
        };
      }
      case 'attachment.begin':
        return this._beginAttachmentUpload(sessionId, payload);
      case 'attachment.chunk':
        return this._appendAttachmentChunk(sessionId, payload);
      case 'attachment.abort':
        return { aborted: this.attachmentUploads.delete(cleanText(payload.uploadId, 128)) };
      case 'attachment.read':
        return this._readRetainedAttachment(sessionId, payload);
      case 'reference.resolve': {
        const referencePath = cleanText(payload.path, 4096);
        if (payload.kind !== 'image' || !referencePath) throw new Error('Invalid image reference');
        const result = await this.manager.resolveReference(sessionId, { kind: 'image', path: referencePath });
        if (!result?.success || typeof result.dataUrl !== 'string') return result;
        const [retained] = this._retainAttachments(sessionId, [{
          type: 'image',
          name: result.relativePath || path.basename(referencePath),
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          dataUrl: result.dataUrl
        }]);
        return {
          success: true,
          kind: 'image',
          relativePath: result.relativePath || path.basename(referencePath),
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          attachmentId: retained.attachmentId,
          ...(retained.thumbnailDataUrl ? { thumbnailDataUrl: retained.thumbnailDataUrl } : {})
        };
      }
      case 'session.restart': {
        exactPayload([]);
        const session = this.sessions.get(sessionId);
        if (!session || !session.cwd) throw new Error('The remote conversation is unavailable');
        if (session.currentTurn?.state === 'running' || session.state === 'starting') {
          throw new Error('Wait for the current response to finish');
        }
        if (session.threadId && session.supportsResume === false) {
          throw new Error('This provider cannot resume this conversation after sign-in');
        }
        session.state = 'starting';
        session.restarting = true;
        try {
          await this.manager.restartSession(sessionId, {
            agent: session.agent,
            accountId: session.accountId || 'current',
            cwd: session.cwd,
            resumeSessionId: session.threadId || undefined,
            model: session.model,
            effort: session.effort,
            permissionMode: session.permissionMode,
            interactionMode: session.interactionMode,
            terminalId: session.desktopTerminalId,
            terminalUuid: session.terminalUuid,
            clientRequestId: session.clientRequestId,
            providerOptions: session.serviceTier ? [{ id: 'serviceTier', value: session.serviceTier }] : [],
          });
          return { restarted: true };
        } catch (error) {
          session.state = 'error';
          throw error;
        } finally {
          delete session.restarting;
        }
      }
      case 'session.models':
        return {
          models: compactModels(await this.manager.listModels(sessionId)),
          permissionModes: permissionOptionsForAgent(this._session(sessionId).agent, {
            allowBypassPermissions: this._session(sessionId).permissionMode === 'full-access'
          })
        };
      case 'session.configure': {
        const configId = cleanText(payload.configId, 100);
        if (!['model', 'effort', 'thinking', 'reasoning_effort', 'serviceTier', 'permissionMode'].includes(configId)) {
          throw new Error('Choose a model, reasoning, speed, or permission option');
        }
        const value = typeof payload.value === 'boolean' && REASONING_CONFIG_IDS.has(configId)
          ? payload.value
          : cleanText(payload.value, 200);
        if (value === null || value === '') throw new Error('Choose a configuration value');
        const session = this._session(sessionId);
        if (session.currentTurn?.state === 'running') {
          throw new Error('Wait for the current response to finish');
        }
        return this.manager.setConfigOption(sessionId, configId, value);
      }
      case 'session.status': {
        if (typeof this.setSessionStatus !== 'function') throw new Error('Changing agent status is unavailable');
        if (payload.status !== null && typeof payload.status !== 'string') {
          throw new Error('Choose an available agent status');
        }
        const requested = payload.status === null || payload.status === 'clear'
          ? null
          : cleanText(payload.status, 100);
        const catalog = compactTerminalStatuses(this.getTerminalStatuses());
        if (requested && !catalog.some((status) => status.key === requested)) {
          throw new Error('Choose an available agent status');
        }
        const session = this._session(sessionId);
        if (session.state === 'stopped') throw new Error('The agent is no longer open');
        const result = await this.setSessionStatus({
          sessionId,
          threadId: session.threadId,
          terminalUuid: session.terminalUuid,
          status: requested
        });
        if (!result?.success) throw new Error(result?.error || 'Could not change the agent status');
        if (session.workStatus !== requested) this.updateSessionIdentity({ sessionId, workStatus: requested });
        return { status: requested };
      }
      case 'session.handoff': {
        if (typeof this.handoffSession !== 'function') throw new Error('Continuing with another LLM is unavailable');
        const targetAgent = cleanText(payload.targetAgent, 50);
        const session = this._session(sessionId);
        if (!targetAgent || targetAgent === session.agent || !this._availableAgents().includes(targetAgent)) {
          throw new Error('Choose a different installed LLM');
        }
        if (session.state === 'stopped') throw new Error('The agent is no longer open');
        const result = await this.handoffSession({
          sessionId,
          threadId: session.threadId,
          terminalUuid: session.terminalUuid,
          targetAgent,
        });
        if (!result?.success) throw new Error(result?.error || 'Could not continue the conversation');
        return result;
      }
      case 'session.action': {
        if (typeof this.sessionAction !== 'function') throw new Error('Conversation actions are unavailable');
        exactPayload(['action', 'title']);
        const action = cleanText(payload.action, 50);
        if (!['generateTitle', 'fork', 'rename', 'resetTitle', 'promoteSandbox'].includes(action)) {
          throw new Error('Choose an available conversation action');
        }
        const session = this._session(sessionId);
        if (session.state === 'stopped') throw new Error('The agent is no longer open');
        if (action === 'fork' && session.agent === 'cursor') throw new Error('Fork is unavailable for Cursor');
        const title = action === 'rename' ? cleanText(payload.title, 300) : null;
        if (action === 'rename' && !title) throw new Error('Enter an agent title');
        if (action === 'promoteSandbox' && !session.sandboxMode) throw new Error('This conversation is not running in Sandbox');
        const result = await this.sessionAction({
          sessionId,
          threadId: session.threadId,
          terminalUuid: session.terminalUuid,
          action,
          ...(title ? { title } : {}),
        });
        if (!result?.success) throw new Error(result?.error || 'Could not complete the conversation action');
        return result;
      }
      case 'session.read': {
        if (typeof this.setSessionStatus !== 'function') throw new Error('Marking notifications as read is unavailable');
        const session = this._session(sessionId);
        if (session.state === 'stopped') throw new Error('The agent is no longer open');
        const attentionVersion = Number(payload.attentionVersion);
        if (!Number.isSafeInteger(attentionVersion) || attentionVersion !== session.attentionVersion) {
          return { needsAttention: session.needsAttention };
        }
        const result = await this.setSessionStatus({
          sessionId,
          threadId: session.threadId,
          terminalUuid: session.terminalUuid,
          attentionVersion,
          read: true
        });
        if (!result?.success) throw new Error(result?.error || 'Could not mark the notification as read');
        const current = session.attentionVersion === attentionVersion;
        if (!result.needsAttention && current) {
          this.updateSessionIdentity({ sessionId, needsAttention: false });
        }
        return { needsAttention: !!result.needsAttention || !current };
      }
      case 'session.minimize': {
        if (typeof this.minimizeSession !== 'function') throw new Error('Minimizing agents is unavailable');
        const session = this._session(sessionId);
        if (session.state === 'stopped') throw new Error('The agent is no longer open');
        const result = await this.minimizeSession({
          sessionId,
          threadId: session.threadId,
          terminalUuid: session.terminalUuid
        });
        if (!result?.success) throw new Error(result?.error || 'Could not minimize the agent');
        if (!session.minimized) this.updateSessionIdentity({ sessionId, minimized: true });
        return { minimized: true };
      }
      case 'session.restore': {
        if (typeof this.restoreSession !== 'function') throw new Error('Restoring minimized agents is unavailable');
        const session = this._session(sessionId);
        if (session.state === 'stopped') throw new Error('The agent is no longer open');
        const result = await this.restoreSession({
          sessionId,
          threadId: session.threadId,
          terminalUuid: session.terminalUuid
        });
        if (!result?.success) throw new Error(result?.error || 'Could not restore the agent');
        if (session.minimized) this.updateSessionIdentity({ sessionId, minimized: false });
        return { restored: true };
      }
      case 'turn.send': {
        if (payload.attachments !== undefined) {
          throw new Error('Mobile attachments must use the upload protocol');
        }
        const uploadIds = Array.isArray(payload.attachmentUploadIds)
          ? payload.attachmentUploadIds
          : [];
        if (uploadIds.length > MAX_CHAT_ATTACHMENTS) throw new Error('Too many attachment uploads');
        const uploaded = [];
        let attachments;
        try {
          for (const uploadId of uploadIds) uploaded.push(this._uploadedAttachment(sessionId, uploadId));
          attachments = normalizeChatAttachments(uploaded);
        } catch (error) {
          this._removeMobileFiles(uploaded);
          throw error;
        }
        const text = typeof payload.text === 'string' ? payload.text : '';
        const localEchoId = `mobile-user-${crypto.randomUUID()}`;
        this.publishUserTurn(sessionId, { text, attachments }, { remote: true, itemId: localEchoId });
        if (typeof this.onRemoteTurn === 'function') {
          try { this.onRemoteTurn(sessionId, { text, attachments }); } catch (_) {}
        }
        this.remoteTurnSessions.add(sessionId);
        this._sessionsChanged();
        try {
          const delivered = await this.sendTurn(sessionId, { text, attachments });
          for (const uploadId of uploadIds) this.attachmentUploads.delete(uploadId);
          return { accepted: true, ...(delivered?.turnId ? { turnId: delivered.turnId } : {}) };
        } catch (error) {
          const localEcho = this.sessions.get(sessionId)?.items.get(localEchoId);
          if (localEcho?.providerItemId) return { accepted: true };
          this._publishProviderEvent(sessionId, {
            eventId: crypto.randomUUID(),
            provider: this.sessions.get(sessionId)?.provider,
            type: 'item.completed',
            executionOrigin: 'main',
            createdAt: new Date().toISOString(),
            itemId: localEchoId,
            payload: {
              itemType: 'user_message',
              status: 'failed',
              localEcho: true,
              remoteCommand: true,
              data: { text, attachments: localEcho?.data?.attachments || [] }
            }
          });
          this.remoteTurnSessions.delete(sessionId);
          this._sessionsChanged();
          throw error;
        } finally {
          this._removeMobileFiles(attachments);
        }
      }
      case 'turn.interrupt':
        await this.manager.interruptTurn(sessionId);
        return { interrupted: true };
      case 'session.stop': {
        const session = this.sessions.get(sessionId);
        if (!session || session.state === 'stopped') return { stopped: true };
        let result;
        if (typeof this.closeSession === 'function') {
          const closed = await this.closeSession({
            sessionId,
            clientRequestId: session.clientRequestId,
            threadId: session.threadId,
            terminalUuid: session.terminalUuid
          });
          if (!closed?.success) throw new Error(closed?.error || 'Could not stop the agent');
          result = { stopped: true };
        } else {
          result = await this.manager.stopSession(sessionId);
        }
        if (result?.stopped) {
          session.state = 'stopped';
          session.lastSeq = this._publish('session.closed', { sessionId, reason: 'remote' }).seq;
          this._sessionsChanged();
        }
        return result;
      }
      case 'request.respond':
        await this.manager.respondToRequest(sessionId, {
          requestId: payload.requestId,
          decision: payload.decision
        });
        return { resolved: true };
      case 'question.respond':
        await this.manager.respondToQuestion(sessionId, {
          requestId: payload.requestId,
          decision: payload.decision,
          answers: payload.answers,
          attachments: payload.attachments
        });
        return { resolved: true };
      default:
        throw new Error(`Unsupported mobile command: ${String(command.type)}`);
    }
  }

  _beginAttachmentUpload(sessionId, payload) {
    const uploadId = cleanText(payload.uploadId, 128);
    const type = cleanText(payload.type, 20);
    const mimeType = cleanText(payload.mimeType, 100);
    const name = cleanText(payload.name, 255);
    const sizeBytes = Number(payload.sizeBytes);
    const chunkCount = Number(payload.chunkCount);
    const maximum = type === 'image'
      ? MAX_CHAT_IMAGE_BYTES
      : type === 'audio'
        ? MAX_CHAT_AUDIO_BYTES
        : MAX_CHAT_FILE_BYTES;
    if (!uploadId || !/^[a-zA-Z0-9._:-]+$/.test(uploadId)) throw new Error('Invalid attachment upload');
    if (!['image', 'audio', 'file'].includes(type)
      || (type !== 'file' && !mimeType?.startsWith(`${type}/`))) throw new Error('Invalid attachment type');
    if (!name || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maximum) throw new Error('Invalid attachment size');
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 64) throw new Error('Invalid attachment chunks');
    const current = this.attachmentUploads.get(uploadId);
    if (current) {
      if (current.sessionId !== sessionId || current.sizeBytes !== sizeBytes || current.chunkCount !== chunkCount) {
        throw new Error('Attachment upload already exists');
      }
      return { uploadId, received: current.chunks.size };
    }
    this.attachmentUploads.set(uploadId, {
      uploadId,
      sessionId,
      type,
      name,
      mimeType,
      sizeBytes,
      durationMs: Number.isFinite(payload.durationMs) ? Math.max(0, Number(payload.durationMs)) : 0,
      chunkCount,
      chunks: new Map(),
      updatedAt: Date.now()
    });
    return { uploadId, received: 0 };
  }

  _appendAttachmentChunk(sessionId, payload) {
    const uploadId = cleanText(payload.uploadId, 128);
    const upload = uploadId && this.attachmentUploads.get(uploadId);
    const index = Number(payload.index);
    const data = payload.data;
    if (!upload || upload.sessionId !== sessionId) throw new Error('Attachment upload was not found');
    if (!Number.isSafeInteger(index) || index < 0 || index >= upload.chunkCount) throw new Error('Invalid attachment chunk');
    if (typeof data !== 'string' || !data.length || data.length > MAX_ATTACHMENT_CHUNK_CHARS || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) {
      throw new Error('Invalid attachment chunk');
    }
    const existing = upload.chunks.get(index);
    if (existing && existing !== data) throw new Error('Attachment chunk does not match');
    const pendingChars = Array.from(this.attachmentUploads.values()).reduce(
      (sum, item) => sum + Array.from(item.chunks.values()).reduce((size, chunk) => size + chunk.length, 0),
      0
    );
    if (!existing && pendingChars + data.length > MAX_PENDING_UPLOAD_CHARS) throw new Error('Too many pending attachments');
    upload.chunks.set(index, data);
    upload.updatedAt = Date.now();
    return { uploadId, received: upload.chunks.size, total: upload.chunkCount };
  }

  _uploadedAttachment(sessionId, value) {
    const uploadId = cleanText(value, 128);
    const upload = uploadId && this.attachmentUploads.get(uploadId);
    if (!upload || upload.sessionId !== sessionId) throw new Error('Attachment upload was not found');
    if (upload.chunks.size !== upload.chunkCount) throw new Error('Attachment upload is incomplete');
    const encoded = Array.from({ length: upload.chunkCount }, (_, index) => upload.chunks.get(index) || '').join('');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== upload.sizeBytes) throw new Error('Attachment upload is corrupt');
    if (upload.type === 'file') {
      const retainedBytes = Array.from(this.mobileFiles.values()).reduce((sum, value) => sum + value, 0);
      if (retainedBytes + upload.sizeBytes > MAX_MOBILE_FILE_BYTES) {
        throw new Error('Too many mobile files are still being delivered');
      }
      if (!this.mobileFileDirectory) {
        this.mobileFileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-mobile-files-'));
      }
      const name = safeAttachmentName(upload.name, 'attachment', 180);
      const filePath = path.join(this.mobileFileDirectory, `${crypto.randomUUID()}-${name}`);
      fs.writeFileSync(filePath, bytes, { mode: 0o600 });
      this.mobileFiles.set(filePath, upload.sizeBytes);
      return {
        type: 'file',
        name,
        path: filePath,
        mimeType: upload.mimeType || 'application/octet-stream',
        sizeBytes: upload.sizeBytes,
        transient: true
      };
    }
    return {
      type: upload.type,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      ...(upload.durationMs ? { durationMs: upload.durationMs } : {}),
      dataUrl: `data:${upload.mimeType};base64,${encoded}`
    };
  }

  _removeMobileFiles(attachments) {
    for (const attachment of attachments || []) {
      const filePath = attachment?.type === 'file' ? attachment.path : null;
      if (!filePath || !this.mobileFiles.has(filePath)) continue;
      this.mobileFiles.delete(filePath);
      try { fs.rmSync(filePath, { force: true }); } catch (_) {}
    }
  }

  _pruneAttachmentUploads() {
    const cutoff = Date.now() - ATTACHMENT_UPLOAD_TTL_MS;
    for (const [uploadId, upload] of this.attachmentUploads) {
      if (upload.updatedAt < cutoff) this.attachmentUploads.delete(uploadId);
    }
  }

  handlePreviewRequest(message) {
    if (!this.previewService) {
      return Promise.resolve({
        requestId: message?.requestId,
        status: 503,
        headers: [['content-type', 'text/plain; charset=utf-8']],
        bodyBase64: Buffer.from('Localhost previews are unavailable').toString('base64')
      });
    }
    return this.previewService.handleRelayRequest(message);
  }

  _pruneCommands() {
    if (this.commands.size <= 500) return;
    for (const [commandId, command] of this.commands) {
      if (!command.done) continue;
      this.commands.delete(commandId);
      if (this.commands.size <= 500) break;
    }
  }

  _sendProtocolError(client, code, message) {
    this._send(client, { kind: 'protocol.error', code, message });
  }

  _send(client, message) {
    if (client.socket.readyState !== undefined && client.socket.readyState !== 1) return false;
    try {
      const serialized = JSON.stringify(message);
      client.socket.send(serialized);
      this.streamMetrics.outboundMessages += 1;
      this.streamMetrics.outboundBytes += Buffer.byteLength(serialized);
      this.streamMetricsDirty = true;
      return true;
    } catch (_) {
      client.detach();
      return false;
    }
  }

  _emitStreamMetrics(reason) {
    if (!this.streamMetricsDirty) return;
    const clients = Array.from(this.clients).filter((client) => client.ready);
    const selectiveClients = clients.filter((client) => client.selective);
    const savedMessages = Math.max(
      0,
      this.streamMetrics.highFrequencySkipped - this.streamMetrics.cursorMarkersSent,
    );
    const baselineMessages = this.streamMetrics.outboundMessages + savedMessages;
    this._diagnostic('runtime.stream_metrics', {
      metricsVersion: 1,
      reason,
      uptimeMs: Math.max(0, Date.now() - this.streamMetrics.startedAt),
      clients: clients.length,
      selectiveClients: selectiveClients.length,
      legacyClients: clients.length - selectiveClients.length,
      activeSubscriptions: selectiveClients.reduce((sum, client) => sum + client.subscriptions.size, 0),
      publishedEvents: this.streamMetrics.publishedEvents,
      highFrequencyPublished: this.streamMetrics.highFrequencyPublished,
      highFrequencySent: this.streamMetrics.highFrequencySent,
      highFrequencySkipped: this.streamMetrics.highFrequencySkipped,
      cursorMarkersSent: this.streamMetrics.cursorMarkersSent,
      outboundMessages: this.streamMetrics.outboundMessages,
      outboundBytes: this.streamMetrics.outboundBytes,
      estimatedRelayMessagesSaved: savedMessages,
      estimatedRelayReductionPct: baselineMessages
        ? Number(((savedMessages / baselineMessages) * 100).toFixed(1))
        : 0,
      helloMessages: this.streamMetrics.helloMessages,
      resetWelcomes: this.streamMetrics.resetWelcomes,
      replayWelcomes: this.streamMetrics.replayWelcomes,
      subscribeCommands: this.streamMetrics.subscribeCommands,
      unsubscribeCommands: this.streamMetrics.unsubscribeCommands,
      hydrationSnapshots: this.streamMetrics.hydrationSnapshots,
    });
    this.streamMetricsDirty = false;
  }

  _diagnostic(event, details = {}) {
    try { this.reportDiagnostic({ event, ...details }); } catch (_) { /* diagnostics never affect Chat */ }
  }
}

module.exports = {
  MobileRuntime,
  PROTOCOL_VERSION,
  compactProviderEvent
};
