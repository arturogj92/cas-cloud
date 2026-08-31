/**
 * Codex `app-server` driver.
 *
 * Speaks newline-delimited JSON-RPC over stdio to a spawned `codex app-server`
 * child process (codex-cli 0.144.6+) and translates its native notifications
 * into the canonical provider-event vocabulary, so the rest of CodeAgentSwarm
 * never has to know Codex's wire format.
 *
 * Note: codex app-server messages have no `jsonrpc` field; they are plain
 * `{ id?, method?, params?, result?, error? }` objects, one per line.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonRpcChunk } = require('./jsonrpc-line-parser');
const { createProviderEvent } = require('./provider-events');
const { mergeSessionCommunicationEnv } = require('./session-communication-env');
const { promptWithFileReferences, contentImageAttachments } = require('./chat-attachments');
const { ProviderAuthenticationError } = require('./provider-auth');
const { isNativeExe, quoteForCmd } = require('../platform/windows-direct-spawn');
const {
  normalizeChatPermissionMode,
  permissionModeForDriver
} = require('./chat-permission-modes');
const { CHAT_HISTORY_EVENT_LIMIT } = require('./chat-history-limits');
const { CHAT_ANSWER_PLACEMENT_PROMPT } = require('./chat-answer-placement');
const {
  parseSlashCommand,
  formatCodexUsage,
  formatMcpServers
} = require('./slash-commands');

const PROVIDER_ID = 'codex';
const RAW_SOURCE = 'codex.app-server.notification';
const PROVIDER_EVENT_CHANNEL = 'provider-event';
const DEFAULT_BINARY = 'codex';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const HISTORY_REQUEST_TIMEOUT_MS = 120000;
const HISTORY_TURN_PAGE_SIZE = 10;
const INITIAL_HISTORY_TURN_PAGE_SIZE = 3;
const SIGKILL_GRACE_MS = 2000;
/**
 * Hard bound on `_waitForExit`. A child that never spawned emits neither
 * `exit` nor `close`, so without a ceiling `stopSession()` would hang forever.
 */
const EXIT_WAIT_TIMEOUT_MS = SIGKILL_GRACE_MS + 3000;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const TURN_NOT_STEERABLE_PATTERN = /cannot (?:start|steer).* turn|not steerable/i;
const ACTIVE_WRITER_PATTERN = /already has an active writer/i;
/**
 * Name a collaborator goes by when only its spawn item announced it: codex's
 * `spawnAgent` carries no agent path. A later `subAgentActivity`, when the
 * session emits one, refines it into the real nickname.
 */
const SPAWNED_AGENT_FALLBACK_NAME = 'subagent';
const CODEX_STDERR_ERROR_PATTERN = /^\d{4}-\d{2}-\d{2}T\S+\s+ERROR\s+/;
const REASONING_EFFORT_LABELS = Object.freeze({
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra'
});
const DEFAULT_SERVICE_TIER_ID = 'default';
const EPHEMERAL_CODEX_HOME_PREFIX = 'codeagentswarm-codex-home-';
const EPHEMERAL_CODEX_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUIRED_TASK_MCP_TOOL = 'check_active';
const TEXT_ONLY_INSTRUCTIONS = 'Answer with plain text only. Do not call tools, commands, apps, skills, web search, MCP servers, or subagents.';
const IMAGE_ONLY_INSTRUCTIONS = 'Generate exactly one image with the built-in image generation capability. Do not call commands, apps, skills, web search, MCP servers, subagents, or any other tool. Do not return prose.';
const TEXT_ONLY_CONFIG_OVERRIDES = Object.freeze([
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.code_mode=false',
  'features.code_mode_only=false',
  'features.view_image=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'features.apps=false',
  'features.enable_mcp_apps=false',
  'features.plugins=false',
  'features.remote_plugin=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.computer_use=false',
  'features.image_generation=false',
  'features.artifact=false',
  'features.goals=false',
  'features.default_mode_request_user_input=false',
  'features.skill_search=false',
  'features.skill_mcp_dependency_install=false',
  'features.tool_suggest=false',
  'features.workspace_dependencies=false',
  'features.request_permissions_tool=false',
  'features.hooks=false',
  'web_search="disabled"',
]);
const IMAGE_ONLY_CONFIG_OVERRIDES = Object.freeze(TEXT_ONLY_CONFIG_OVERRIDES.map((override) => (
  override === 'features.image_generation=false'
    ? 'features.image_generation=true'
    : override
)));

const CODEX_SANDBOX_POLICIES = Object.freeze({
  'read-only': Object.freeze({ type: 'readOnly' }),
  'workspace-write': Object.freeze({ type: 'workspaceWrite' }),
  'danger-full-access': Object.freeze({ type: 'dangerFullAccess' })
});

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: 'codeagentswarm',
  title: 'CodeAgentSwarm',
  version: '0.1.0'
});
const DEFAULT_CLIENT_CAPABILITIES = Object.freeze({ experimentalApi: true });

function isolatedProviderConfig(source) {
  const kept = [];
  let topLevel = true;
  let providerSection = false;
  for (const line of String(source || '').split(/\r?\n/)) {
    const header = line.trim().match(/^\[{1,2}([^\]]+)/);
    if (header) {
      topLevel = false;
      providerSection = header[1].startsWith('model_providers.');
    }
    if (
      (topLevel && /^\s*model_providers?(?:\.|\s*=)/.test(line))
      || providerSection
    ) kept.push(line);
  }
  const config = kept.join('\n').trim();
  return config ? `${config}\n` : '';
}

function permissionModeFromCodexRuntime(result) {
  if (
    !result
    || (
      result.approvalPolicy === undefined
      && result.approvalsReviewer === undefined
      && result.sandbox === undefined
    )
  ) return null;
  const sandboxType = result?.sandbox?.type;
  if (result?.approvalPolicy === 'never' || sandboxType === 'dangerFullAccess') {
    return 'full-access';
  }
  if (result?.approvalsReviewer === 'auto_review') return 'auto';
  if (result?.approvalPolicy === 'on-request' || sandboxType === 'workspaceWrite') {
    return 'auto-accept-edits';
  }
  return 'approval-required';
}

/** Codex item `type` (camelCase) -> canonical item type. */
const CODEX_ITEM_TYPE_MAP = Object.freeze({
  userMessage: 'user_message',
  agentMessage: 'assistant_message',
  reasoning: 'reasoning',
  plan: 'plan',
  // The checklist `update_plan` publishes. Codex names the thread item
  // `todo_list` on the wire (`codex exec --json`) and `todoList` in the
  // app-server's camelCase vocabulary; both spellings are accepted so the
  // list is never silently dropped as an unknown item.
  todoList: 'plan',
  todo_list: 'plan',
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  dynamicToolCall: 'dynamic_tool_call',
  collabAgentToolCall: 'collab_agent_tool_call',
  webSearch: 'web_search',
  imageView: 'image_view',
  imageGeneration: 'image_generation',
  enteredReviewMode: 'review_entered',
  exitedReviewMode: 'review_exited',
  contextCompaction: 'context_compaction',
  error: 'error'
});

/** Canonical item type -> human readable title. */
const ITEM_TITLE_MAP = Object.freeze({
  assistant_message: 'Assistant message',
  user_message: 'User message',
  reasoning: 'Reasoning',
  plan: 'Plan',
  command_execution: 'Ran command',
  file_change: 'File change',
  mcp_tool_call: 'MCP tool call',
  dynamic_tool_call: 'Tool call',
  web_search: 'Web search',
  image_view: 'Image view',
  image_generation: 'Generated image',
  error: 'Error'
});

/** Item fields scanned, in order, to build a one-line detail. */
const ITEM_DETAIL_FIELDS = Object.freeze([
  'command',
  'title',
  'summary',
  'text',
  'path',
  'query',
  'prompt'
]);

/**
 * Server -> client requests the driver knows how to answer. The native
 * decision literals differ between legacy and v2 methods, so the UI talks in
 * canonical allow/reject decisions and this table translates at the boundary.
 */
const SERVER_REQUEST_TABLE = Object.freeze({
  execCommandApproval: {
    requestType: 'exec_command_approval',
    protocol: 'legacy'
  },
  applyPatchApproval: {
    requestType: 'apply_patch_approval',
    protocol: 'legacy'
  },
  'item/commandExecution/requestApproval': {
    requestType: 'command_execution_approval',
    protocol: 'v2'
  },
  'item/fileChange/requestApproval': {
    requestType: 'file_change_approval',
    protocol: 'v2'
  },
  'item/tool/requestUserInput': {
    requestType: 'tool_user_input',
    protocol: 'user_input'
  },
  'mcpServer/elicitation/request': {
    requestType: 'mcp_tool_approval',
    protocol: 'mcp_elicitation'
  }
});

const APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'allow_once', name: 'Allow once', kind: 'allow_once' }),
  Object.freeze({ id: 'allow_always', name: 'Allow for session', kind: 'allow_always' }),
  Object.freeze({ id: 'reject_once', name: 'Reject', kind: 'reject_once' })
]);

/**
 * Drives a `codex app-server` child process and emits canonical provider events.
 *
 * All events are emitted on the `'provider-event'` channel. The driver never
 * emits `'error'` on the EventEmitter: protocol and process failures surface as
 * canonical `runtime.error` / `session.exited` events instead, so a missing
 * listener can never crash the host process.
 *
 * @fires CodexAppServerDriver#provider-event
 */
class CodexAppServerDriver extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.binaryPath='codex'] Codex executable to spawn.
   * @param {Object} [options.env] Extra env vars merged over `process.env`.
   * @param {{name: string, title: string, version: string}} [options.clientInfo]
   * @param {number} [options.requestTimeoutMs=30000] Per-request timeout.
   * @param {Function} [options.spawnFn] Injectable spawn, for tests.
   * @param {string} [options.requiredMcpServer] MCP server whose activation
   *   check is repaired before the first turn when possible.
   * @param {Function} [options.repairMcpConfig] Repairs the on-disk MCP config
   *   before the running app-server reloads it.
   * @param {{register: Function, unregister: Function}} [options.processRegistry]
   *   PID registry the child is tracked in; injectable for tests.
   */
  constructor({
    binaryPath = DEFAULT_BINARY,
    env,
    clientInfo,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnFn,
    processRegistry,
    requiredMcpServer,
    repairMcpConfig
  } = {}) {
    super();
    this._binaryPath = binaryPath;
    this._env = env || {};
    this._clientInfo = clientInfo || DEFAULT_CLIENT_INFO;
    this._requestTimeoutMs = requestTimeoutMs;
    this._spawnFn = spawnFn || spawn;
    this._processRegistry = processRegistry || require('../platform/spawned-process-registry');
    this._requiredMcpServer = requiredMcpServer || null;
    this._repairMcpConfig = repairMcpConfig || null;

    this._child = null;
    this._pendingRequests = new Map();
    this._pendingApprovals = new Map();
    this._pendingQuestions = new Map();
    this._nextRequestId = 1;
    this._threadId = null;
    this._activeTurnId = null;
    this._sessionCwd = null;
    this._stdoutRemainder = '';
    this._stderrRemainder = '';
    this._state = 'idle';
    this._stopping = false;
    this._exited = false;
    this._turnOverrides = {};
    this._queuedTurnInputs = [];
    this._flushingQueuedTurnInputs = false;
    this._ephemeralCodexHome = null;
    // childThreadId -> { events, status, agentType, description, rowOpened }.
    // A collaborator agent streams its own turns to this same client under its
    // own thread id, so its events are buffered here instead of leaking into
    // the main conversation.
    this._childThreads = new Map();
    // Native spawn item id -> childThreadId, so the item's later completed
    // echo is recognized even when it no longer carries the receiver ids.
    this._spawnItemChildThreads = new Map();
  }

  /** @returns {string} 'idle'|'starting'|'ready'|'running'|'stopped'|'error'. */
  get state() {
    return this._state;
  }

  /** @returns {string|null} Codex thread id once the session is started. */
  get threadId() {
    return this._threadId;
  }

  /**
   * Spawn `codex app-server`, run the JSON-RPC handshake and open a thread.
   *
   * @param {Object} [options]
   * @param {string} [options.cwd] Working directory for the Codex session.
   * @param {string} [options.model] Model id; omitted lets Codex decide.
   * @param {string} [options.effort] Reasoning effort for subsequent turns.
   * @param {string} [options.sandbox='workspace-write'] Codex sandbox policy.
   * @param {string} [options.approvalPolicy='on-request'] Codex approval policy.
   * @param {string} [options.approvalsReviewer] Codex approval reviewer.
   * @param {string} [options.permissionMode] Normalized Chat permission policy.
   * @param {boolean} [options.imageGenerationOnly] Isolate the session and
   *   expose only Codex image generation.
   * @param {string} [options.resumeSessionId] Existing codex thread id to resume
   *   instead of opening a fresh thread.
   * @returns {Promise<{threadId: string, model: string|undefined, cwd: string|undefined,
   *   historyEvents: Object[]}>} `historyEvents` carries a resumed thread's past
   *   turns as fully-wrapped canonical events (empty for a fresh thread). It
   *   travels in the START RESULT instead of the `provider-event` stream because
   *   the IPC layer only maps sessionId -> WebContents AFTER `startSession`
   *   resolves, so anything emitted during the handshake had no owner yet and
   *   was silently dropped before reaching the renderer.
   */
  async startSession({
    cwd,
    model,
    effort,
    sandbox = 'workspace-write',
    approvalPolicy = 'on-request',
    autoApprove = false,
    permissionMode,
    toolsDisabled = false,
    imageGenerationOnly = false,
    resumeSessionId
  } = {}) {
    if (this._state !== 'idle') {
      throw new Error('Codex session already started');
    }
    this._childThreads.clear();
    this._setState('starting');
    if (model) this._turnOverrides.model = model;
    if (effort) this._turnOverrides.effort = effort;

    const resolvedCwd = cwd || process.cwd();
    const permissionPolicy = permissionMode === undefined
      ? null
      : permissionModeForDriver('codex', permissionMode);
    const isolatedUtility = toolsDisabled || imageGenerationOnly;
    const resolvedSandbox = isolatedUtility
      ? 'read-only'
      : autoApprove
      ? 'danger-full-access'
      : permissionPolicy?.sandbox || sandbox;
    const resolvedApprovalPolicy = isolatedUtility
      ? 'untrusted'
      : autoApprove
      ? 'never'
      : permissionPolicy?.approvalPolicy || approvalPolicy;
    const resolvedApprovalsReviewer = isolatedUtility
      ? 'user'
      : autoApprove
      ? 'user'
      : permissionPolicy?.approvalsReviewer;
    if (autoApprove || permissionPolicy) {
      this._turnOverrides.approvalPolicy = resolvedApprovalPolicy;
      this._turnOverrides.sandboxPolicy = {
        ...(CODEX_SANDBOX_POLICIES[resolvedSandbox] || CODEX_SANDBOX_POLICIES['read-only'])
      };
      this._turnOverrides.approvalsReviewer = resolvedApprovalsReviewer || 'user';
    }
    try {
      this._spawnChild(resolvedCwd, { toolsDisabled, imageGenerationOnly });
      return await this._handshake({
        cwd: resolvedCwd,
        model,
        sandbox: resolvedSandbox,
        approvalPolicy: resolvedApprovalPolicy,
        approvalsReviewer: resolvedApprovalsReviewer,
        toolsDisabled,
        imageGenerationOnly,
        resumeSessionId
      });
    } catch (error) {
      this._failStart(error);
      throw error;
    }
  }

  /**
   * Start a new turn with a plain-text user message.
   * Streamed content arrives asynchronously as canonical events.
   *
   * @param {{text: string}} params
   * @returns {Promise<{turnId: string}>}
   */
  async sendTurn({ text, attachments = [] }) {
    const canSend = this._threadId && (this._state === 'ready' || this._state === 'running');
    if (!canSend) {
      throw new Error('Codex session not started');
    }
    const prompt = promptWithFileReferences(text, attachments);
    const input = [
      ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ...attachments
        .filter((attachment) => attachment.type === 'image')
        .map((attachment) => ({ type: 'image', url: attachment.dataUrl }))
    ];
    try {
      return await this._sendInput(input);
    } catch (error) {
      if (!TURN_NOT_STEERABLE_PATTERN.test(error.message)) throw error;
      this._queuedTurnInputs.push(input);
      return { turnId: this._activeTurnId, queued: true };
    }
  }

  async _sendInput(input) {
    if (this._state === 'running' && this._activeTurnId) {
      const activeTurnId = this._activeTurnId;
      await this._request('turn/steer', {
        threadId: this._threadId,
        expectedTurnId: activeTurnId,
        input
      });
      return { turnId: activeTurnId, steered: true };
    }
    const result = await this._request('turn/start', {
      threadId: this._threadId,
      input,
      ...this._turnOverrides
    });
    this._activeTurnId = result?.turn?.id;
    return { turnId: this._activeTurnId };
  }

  async _flushQueuedTurnInputs() {
    if (this._flushingQueuedTurnInputs || this._activeTurnId) return;
    this._flushingQueuedTurnInputs = true;
    try {
      const input = this._queuedTurnInputs.shift();
      if (!input) return;
      try {
        await this._sendInput(input);
      } catch (error) {
        if (TURN_NOT_STEERABLE_PATTERN.test(error.message)) {
          this._queuedTurnInputs.unshift(input);
        } else {
          this._emitRuntimeError(error.message, 'transport_error');
        }
      }
    } finally {
      this._flushingQueuedTurnInputs = false;
    }
  }

  /**
   * Ask Codex to interrupt the active turn. No-op when no turn is running.
   * @returns {Promise<void>}
   */
  async interruptTurn() {
    if (!this._activeTurnId) return undefined;
    await this._request('turn/interrupt', {
      threadId: this._threadId,
      turnId: this._activeTurnId
    });
    return undefined;
  }

  /** Load the preceding native Codex turn without reading the whole rollout. */
  async loadEarlierHistory(cursor) {
    if (!this._threadId || !cursor) {
      return { historyEvents: [], historyCursor: null, hasEarlierHistory: false };
    }
    const page = await this._request('thread/turns/list', {
      threadId: this._threadId,
      cursor,
      limit: HISTORY_TURN_PAGE_SIZE,
      sortDirection: 'desc',
      itemsView: 'full'
    });
    return this._historyPageResult(page);
  }

  /**
   * List the models the current Codex account can use.
   * @returns {Promise<Object[]>} Model descriptors.
   */
  async listModels() {
    const models = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const result = await this._request('model/list', cursor ? { cursor } : {});
      if (Array.isArray(result?.data)) models.push(...result.data);
      const nextCursor = result?.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    const descriptors = models.map((model) => {
      const id = model.model || model.id;
      const defaultEffort = model.defaultReasoningEffort;
      const effortOptions = (Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : [])
        .map((entry) => (
          typeof entry === 'string' ? entry : entry && entry.reasoningEffort
        ))
        .filter(Boolean)
        .map((effort) => ({
          id: effort,
          label: REASONING_EFFORT_LABELS[effort] || effort,
          ...(effort === defaultEffort ? { isDefault: true } : {})
        }));
      const serviceTiers = (Array.isArray(model.serviceTiers) ? model.serviceTiers : [])
        .filter((tier) => tier && typeof tier.id === 'string' && tier.id)
        .map((tier) => ({
          id: tier.id,
          label: tier.name || tier.id,
          ...(tier.description ? { description: tier.description } : {})
        }));
      const defaultServiceTier = serviceTiers.some((tier) => (
        tier.id === model.defaultServiceTier
      )) ? model.defaultServiceTier : DEFAULT_SERVICE_TIER_ID;
      const selectedServiceTier = [DEFAULT_SERVICE_TIER_ID, ...serviceTiers.map((tier) => tier.id)]
        .includes(this._turnOverrides.serviceTier)
        ? this._turnOverrides.serviceTier
        : defaultServiceTier;
      const optionDescriptors = [
        ...(effortOptions.length ? [{
          id: 'effort',
          label: 'Reasoning',
          type: 'select',
          options: effortOptions,
          currentValue: this._turnOverrides.effort || defaultEffort || effortOptions[0].id
        }] : []),
        ...(serviceTiers.length ? [{
          id: 'serviceTier',
          label: 'Speed',
          type: 'select',
          options: [{
            id: DEFAULT_SERVICE_TIER_ID,
            label: 'Standard',
            ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {})
          }, ...serviceTiers.map((tier) => ({
            ...tier,
            ...(tier.id === defaultServiceTier ? { isDefault: true } : {})
          }))],
          currentValue: selectedServiceTier
        }] : [])
      ];
      return {
        id,
        name: model.displayName || model.name || id,
        ...(model.description ? { description: model.description } : {}),
        current: this._turnOverrides.model
          ? id === this._turnOverrides.model
          : model.isDefault === true,
        capabilities: { optionDescriptors }
      };
    }).filter((model) => model.id);

    // `model/list` can omit a configured custom model even though thread/start
    // accepts it. Keep the active model selectable and borrow only the
    // capabilities Codex itself advertised for its regular catalog. This
    // appends custom Codex models without inventing
    // provider-specific reasoning levels.
    const activeModel = String(this._turnOverrides.model || '').trim();
    if (!activeModel || descriptors.some((model) => model.id === activeModel)) {
      return descriptors;
    }

    const fallbackCapabilities = descriptors
      .find((model) => Array.isArray(model?.capabilities?.optionDescriptors))
      ?.capabilities || { optionDescriptors: [] };
    const optionDescriptors = fallbackCapabilities.optionDescriptors.map((descriptor) => ({
      ...descriptor,
      options: Array.isArray(descriptor.options)
        ? descriptor.options.map((option) => ({ ...option }))
        : descriptor.options,
      ...((descriptor.id === 'effort' || descriptor.id === 'serviceTier')
        && this._turnOverrides[descriptor.id]
        ? { currentValue: this._turnOverrides[descriptor.id] }
        : {})
    }));

    return [
      ...descriptors.map((model) => ({ ...model, current: false })),
      {
        id: activeModel,
        name: activeModel,
        current: true,
        custom: true,
        capabilities: { optionDescriptors }
      }
    ];
  }

  /**
   * Codex app-server has no CLI slash-command discovery endpoint. These two
   * commands map to protocol methods present in the running app-server schema,
   * so they are real capabilities rather than prompts disguised as commands.
   */
  async listCommands() {
    return [
      // `thread/compact/start` is in the app-server's own ClientRequest schema
      // (`codex app-server generate-json-schema`, codex-cli 0.146.0). Only
      // offered once a thread exists: it takes a threadId.
      ...(this._threadId ? [{
        name: 'compact',
        description: 'Free up context by summarizing the conversation so far',
        argumentHint: '',
        aliases: [],
        source: 'codex'
      }] : []),
      {
        name: 'usage',
        description: 'Show account token usage and rate-limit windows',
        argumentHint: '',
        aliases: [],
        source: 'codex'
      },
      {
        name: 'mcp',
        description: 'Show configured MCP servers and connection status',
        argumentHint: '',
        aliases: [],
        source: 'codex'
      }
    ];
  }

  async runCommand(commandLine) {
    const command = parseSlashCommand(commandLine);
    if (!command) return { handled: false };
    if (command.name === 'compact') {
      if (!this._threadId) throw new Error('Codex has no conversation to compact yet');
      // Returns `{}` immediately and runs the summarization as a REAL turn:
      // the app-server emits its own turn.started / item / turn.completed
      // stream, which also refreshes the token gauge when it lands. Nothing
      // to await here beyond the acknowledgement.
      await this._request('thread/compact/start', { threadId: this._threadId });
      return { handled: true, output: 'Compacting the conversation…' };
    }
    if (command.name === 'usage') {
      const [tokenUsage, rateLimits] = await Promise.all([
        this._request('account/usage/read', null),
        this._request('account/rateLimits/read', null)
      ]);
      return {
        handled: true,
        output: formatCodexUsage(tokenUsage || {}, rateLimits || {})
      };
    }
    if (command.name === 'mcp') {
      return { handled: true, output: formatMcpServers(await this._listMcpServers()) };
    }
    return { handled: false };
  }

  /**
   * Codex accepts model, effort and service-tier overrides on `turn/start`;
   * they also become the defaults for subsequent turns in the same thread.
   */
  async setConfigOption(configId, value) {
    if (configId === 'permissionMode') {
      const normalized = normalizeChatPermissionMode(value);
      const native = permissionModeForDriver('codex', normalized);
      this._turnOverrides.approvalPolicy = native.approvalPolicy;
      this._turnOverrides.sandboxPolicy = {
        ...(CODEX_SANDBOX_POLICIES[native.sandbox] || CODEX_SANDBOX_POLICIES['read-only'])
      };
      this._turnOverrides.approvalsReviewer = native.approvalsReviewer;
      return { changed: true, configId, value: normalized };
    }
    if (configId !== 'model' && configId !== 'effort' && configId !== 'serviceTier') {
      throw new Error(`Unsupported Codex configuration option: ${configId}`);
    }
    this._turnOverrides[configId] = value;
    return { changed: true, configId, value };
  }

  /** Resolve a parked approval request with a canonical UI decision. */
  async respondToRequest({ requestId, decision } = {}) {
    const key = String(requestId || '');
    const pending = this._pendingApprovals.get(key);
    if (!pending) throw new Error('Unknown Codex approval request');

    const result = buildCodexApprovalResponse(pending.protocol, decision);
    this._sendMessage({ id: pending.id, result });
    this._pendingApprovals.delete(key);
    this._emitProviderEvent({
      type: 'request.resolved',
      requestId: key,
      ...pending.envelope,
      payload: { requestType: pending.requestType, decision }
    });
  }

  /**
   * Resolve a parked structured question with the user's answers.
   *
   * @param {Object} [response]
   * @param {string} response.requestId
   * @param {'submit'|'decline'} response.decision
   * @param {Object<string, {values: string[], note?: string}>} [response.answers]
   */
  async respondToQuestion({ requestId, decision, answers } = {}) {
    const key = String(requestId || '');
    const pending = this._pendingQuestions.get(key);
    if (!pending) throw new Error('Unknown Codex question request');
    this._pendingQuestions.delete(key);

    let result;
    let resolvedDecision;
    if (decision !== 'submit') {
      result = { answers: {} };
      resolvedDecision = 'declined';
    } else {
      const native = {};
      for (const question of pending.questions) {
        const entry = answers ? answers[question.id] : undefined;
        const values = Array.isArray(entry?.values)
          ? entry.values.filter((value) => typeof value === 'string' && value)
          : [];
        if (values.length) native[question.id] = { answers: values };
      }
      result = { answers: native };
      resolvedDecision = 'submitted';
    }

    this._sendMessage({ id: pending.id, result });
    this._emitProviderEvent({
      type: 'question.resolved',
      requestId: key,
      ...pending.envelope,
      payload: {
        requestType: pending.requestType,
        decision: resolvedDecision,
        ...(resolvedDecision === 'submitted' ? { answers } : {})
      }
    });
  }

  /**
   * Terminate the child process. Idempotent.
   * @returns {Promise<void>}
   */
  async stopSession() {
    if (this._state === 'stopped' || !this._child) {
      this._cleanupEphemeralCodexHome();
      return;
    }

    this._stopping = true;
    this._rejectAllPending(new Error('Codex session stopped'));
    this._queuedTurnInputs = [];
    this._denyAllPendingApprovals();
    this._cancelAllPendingQuestions();

    const killTimer = setTimeout(() => this._forceKill(), SIGKILL_GRACE_MS);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    this._child.kill();

    await this._waitForExit();
    clearTimeout(killTimer);

    this._childThreads.clear();
    this._setState('stopped');
    this._emitProviderEvent({
      type: 'session.exited',
      payload: { exitKind: 'graceful', reason: 'Session stopped' }
    });
    this._cleanupEphemeralCodexHome();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Spawn the child process and wire its streams.
   * @param {string} cwd
   * @param {{toolsDisabled?: boolean, imageGenerationOnly?: boolean}} options
   */
  _spawnChild(cwd, { toolsDisabled = false, imageGenerationOnly = false } = {}) {
    // An npm-installed codex on Windows is a `.cmd` shim: libuv resolves a bare
    // name only to `.exe`, and Node refuses to spawn a `.cmd` without a shell
    // (CVE-2024-27980), so only cmd.exe can launch it. Same route the PTY
    // launcher takes, and the same shape as Node's `shell: true`: each token
    // quoted, then ONE outer pair around the whole line for cmd's /S rule.
    // ponytail: the registered PID is cmd.exe, so a hard kill can orphan the
    // grandchild on Windows; upgrade to `taskkill /T` if zombies show up.
    let file = this._binaryPath;
    const configOverrides = imageGenerationOnly
      ? IMAGE_ONLY_CONFIG_OVERRIDES
      : toolsDisabled
        ? TEXT_ONLY_CONFIG_OVERRIDES
        : [];
    let args = [
      'app-server',
      ...configOverrides.flatMap((override) => ['-c', override])
    ];
    if (process.platform === 'win32' && !isNativeExe(file)) {
      const command = [file, ...args].map(quoteForCmd).join(' ');
      args = ['/d', '/s', '/c', `"${command}"`];
      file = 'cmd.exe';
    }
    const childEnv = mergeSessionCommunicationEnv(process.env, this._env);
    if (toolsDisabled || imageGenerationOnly) {
      childEnv.CODEX_HOME = this._createEphemeralCodexHome(childEnv);
    }
    try {
      this._child = this._spawnFn(file, args, {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // The whole command line is ONE argv entry: without verbatim args Node
        // re-quotes it and escapes the embedded quotes as `\"`, which cmd.exe does
        // not parse. Node's own `shell: true` does exactly this.
        ...(file === 'cmd.exe' ? { windowsVerbatimArguments: true } : {})
      });
    } catch (error) {
      this._cleanupEphemeralCodexHome();
      throw error;
    }

    this._child.stdout.setEncoding('utf8');
    this._child.stderr.setEncoding('utf8');
    this._child.stdout.on('data', (chunk) => this._handleStdoutChunk(chunk));
    this._child.stderr.on('data', (chunk) => this._handleStderrChunk(chunk));
    this._child.on('error', (error) => this._handleChildError(error));
    this._child.on('exit', (code, signal) => this._handleChildExit(code, signal));
    // A dead child turns writes into EPIPE; swallow them, `exit` is the signal.
    if (this._child.stdin) this._child.stdin.on('error', () => {});

    // Track the PID in the app's registry: `spawnedProcessRegistry.killAll()` is
    // the ONLY cleanup that runs on the dev-mode `process.exit(0)` quit path and
    // on crashes, so a driver child left out of it survived as a zombie
    // `codex app-server` after every dev quit.
    const { pid } = this._child;
    if (pid !== undefined) {
      this._processRegistry.register(pid);
      this._child.once('exit', () => this._processRegistry.unregister(pid));
    }
  }

  /**
   * Run initialize / initialized / thread-start (or thread-resume).
   * @param {{cwd: string, model?: string, sandbox: string, approvalPolicy: string,
   *          approvalsReviewer?: string, resumeSessionId?: string}} options
   * @returns {Promise<{threadId: string, model: string|undefined, cwd: string|undefined,
   *   historyEvents: Object[]}>}
   */
  async _handshake({
    cwd,
    model,
    sandbox,
    approvalPolicy,
    approvalsReviewer,
    toolsDisabled,
    imageGenerationOnly,
    resumeSessionId
  }) {
    await this._request('initialize', {
      clientInfo: this._clientInfo,
      capabilities: DEFAULT_CLIENT_CAPABILITIES
    });
    this._sendMessage({ method: 'initialized' });

    // Ask the app-server instead of parsing `codex login status`. A custom
    // model provider can be valid
    // with no OpenAI account, while a stock Codex setup explicitly reports
    // `requiresOpenaiAuth: true` when sign-in is missing.
    const account = await this._request('account/read', {});
    if (!account?.account && account?.requiresOpenaiAuth) {
      throw new ProviderAuthenticationError(
        'codex',
        'Codex is not signed in. Run `codex login`, then retry Chat.'
      );
    }

    const utilityInstructions = imageGenerationOnly
      ? IMAGE_ONLY_INSTRUCTIONS
      : toolsDisabled
        ? TEXT_ONLY_INSTRUCTIONS
        : null;
    const threadParams = {
      cwd,
      sandbox,
      approvalPolicy,
      // Normal chats append to Codex's prompt. Isolated utility turns replace
      // it so the model receives no unrelated agent/tool instructions.
      developerInstructions: utilityInstructions || CHAT_ANSWER_PLACEMENT_PROMPT,
      ...(utilityInstructions ? {
        baseInstructions: utilityInstructions,
        ephemeral: true,
        environments: [],
        runtimeWorkspaceRoots: [cwd],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: { web_search: 'disabled' }
      } : {}),
      ...(approvalsReviewer ? { approvalsReviewer } : {}),
      ...(model ? { model } : {})
    };
    let readOnly = false;
    let result;
    if (resumeSessionId) {
      try {
        result = await this._request('thread/resume', {
          threadId: resumeSessionId,
          excludeTurns: true,
          initialTurnsPage: {
            limit: INITIAL_HISTORY_TURN_PAGE_SIZE,
            sortDirection: 'desc',
            itemsView: 'summary'
          },
          ...threadParams
        });
      } catch (error) {
        if (!ACTIVE_WRITER_PATTERN.test(String(error?.message || error))) throw error;
        result = await this._request('thread/read', {
          threadId: resumeSessionId,
          includeTurns: false
        });
        readOnly = true;
      }
    } else {
      result = await this._request('thread/start', threadParams);
    }

    // Service tier is authoritative for fresh and resumed threads. On resume,
    // the interactive TUI may also have changed model, effort or permissions;
    // app-server reports that live state so Chat avoids stale launch metadata.
    if (result?.serviceTier) this._turnOverrides.serviceTier = result.serviceTier;
    if (resumeSessionId) {
      if (result?.model) this._turnOverrides.model = result.model;
      if (result?.reasoningEffort) this._turnOverrides.effort = result.reasoningEffort;
      if (result?.approvalPolicy) this._turnOverrides.approvalPolicy = result.approvalPolicy;
      if (result?.sandbox) this._turnOverrides.sandboxPolicy = { ...result.sandbox };
      if (result?.approvalsReviewer) {
        this._turnOverrides.approvalsReviewer = result.approvalsReviewer;
      }
    }

    this._threadId = result?.thread?.id || result?.threadId || (resumeSessionId || null);
    if (!toolsDisabled && !imageGenerationOnly) {
      try {
        await this._ensureRequiredMcpServer(this._threadId);
      } catch (error) {
        console.warn(`[CodexAppServerDriver] Continuing without verified task MCP tools: ${error.message}`);
      }
    }
    this._sessionCwd = result?.cwd || result?.thread?.cwd || cwd;
    let historyPage = result?.initialTurnsPage;
    const returnedTurns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    if (resumeSessionId && !historyPage && returnedTurns.length === 0) {
      try {
        historyPage = await this._request('thread/turns/list', {
          threadId: this._threadId,
          limit: INITIAL_HISTORY_TURN_PAGE_SIZE,
          sortDirection: 'desc',
          itemsView: 'summary'
        });
      } catch (_) {
        // Older/custom app-servers may not expose experimental pagination.
      }
    }
    // Experimental resume omits turns so large rollouts do not cross IPC. Keep
    // collecting them when an older/custom server returns them anyway.
    const history = historyPage
      ? this._historyPageResult(historyPage)
      : {
        historyEvents: resumeSessionId ? this._collectThreadHistory(result?.thread) : [],
        historyCursor: null,
        hasEarlierHistory: Boolean(resumeSessionId)
      };
    this._setState('ready');

    return {
      threadId: this._threadId,
      model: result?.model,
      ...(result?.reasoningEffort ? { effort: result.reasoningEffort } : {}),
      ...(this._turnOverrides.serviceTier ? { serviceTier: this._turnOverrides.serviceTier } : {}),
      ...(permissionModeFromCodexRuntime(result)
        ? { permissionMode: permissionModeFromCodexRuntime(result) }
        : {}),
      cwd: this._sessionCwd,
      ...history,
      ...(readOnly
        ? {
          readOnly: true,
          providerStatus: {
            state: 'thread_busy',
            agent: PROVIDER_ID,
            title: 'Codex conversation is open read-only',
            message: 'Another Codex client is using this conversation. You can read it here now; close it there, then retry to continue.',
            actionLabel: 'Retry'
          }
        }
        : {})
    };
  }

  async _listMcpServers(threadId) {
    const servers = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const result = await this._request('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        ...(threadId ? { threadId } : {}),
        ...(cursor ? { cursor } : {})
      });
      if (Array.isArray(result?.data)) servers.push(...result.data);
      const nextCursor = result?.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return servers;
  }

  async _ensureRequiredMcpServer(threadId) {
    if (!this._requiredMcpServer) return;
    const connected = (servers) => servers.some((server) => (
      server?.name === this._requiredMcpServer
      && Object.values(server.tools || {}).some((tool) => tool?.name === REQUIRED_TASK_MCP_TOOL)
    ));
    if (connected(await this._listMcpServers(threadId))) return;

    if (this._repairMcpConfig && await this._repairMcpConfig() === false) {
      throw new Error('CodeAgentSwarm could not repair the Codex MCP configuration. Restart CodeAgentSwarm and retry Chat.');
    }
    await this._request('config/mcpServer/reload', null);
  }

  /**
   * Build a resumed thread's past items as historical `item.completed` events.
   *
   * The timeline reducer renders `item.completed` rows from `payload.data`, so
   * replaying history through the SAME mapper the live stream uses guarantees
   * the chat shows exactly what it would have shown while the turns happened.
   *
   * Events are returned fully wrapped (the shape the `provider-event` channel
   * carries) rather than emitted: the caller hands them to the renderer in the
   * start result, which is the only path that has an owner at this point.
   *
   * @param {Object} [thread] The `thread` block of a `thread/resume` response.
   * @param {string} [threadId] Thread the items belong to; defaults to this
   *   session's, and is the child's own id when a collaborator is read.
   * @returns {Object[]} Wrapped canonical events, oldest first.
   */
  _collectThreadHistory(thread, threadId = this._threadId) {
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const pairs = [];
    for (const turn of turns) {
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of items) {
        pairs.push({ turn, item });
      }
    }

    const events = [];
    for (const { turn, item } of pairs.slice(-CHAT_HISTORY_EVENT_LIMIT)) {
      const notification = {
        method: 'item/completed',
        params: { threadId, turnId: turn?.id, item }
      };
      // A restored conversation's collaborators are all finished, so their
      // rows are replayed closed; without this the drill-down affordance
      // would simply be missing from a resumed codex thread.
      const bareEvents = item?.type === 'subAgentActivity'
        ? subAgentActivityHistoryEvents(notification)
        : itemEvents('item.completed', notification, completedItemStatus(item), {
          restoreAttachments: true
        });
      for (const bare of bareEvents) {
        events.push(createProviderEvent(
          {
            ...bare,
            createdAt: codexHistoryItemTime(turn, bare.payload.itemType),
            payload: { ...bare.payload, historical: true }
          },
          {
            provider: PROVIDER_ID,
            threadId: threadId || undefined,
            executionOrigin: executionOriginForThread(threadId, this._threadId)
          }
        ));
      }
    }
    return events;
  }

  /** Convert a descending native turn page into chronological Chat events. */
  _historyPageResult(page) {
    const turns = Array.isArray(page?.data) ? [...page.data].reverse() : [];
    const historyCursor = page?.nextCursor || null;
    return {
      historyEvents: this._collectThreadHistory({ turns }),
      historyCursor,
      hasEarlierHistory: Boolean(historyCursor)
    };
  }

  /**
   * Report a handshake/spawn failure and tear the child down.
   * @param {Error} error
   */
  _failStart(error) {
    this._emitRuntimeError(error.message, 'transport_error');
    this._setState('error');
    if (this._child && !this._exited) {
      try {
        this._child.kill();
      } catch (killError) {
        // Nothing else to do: the session is already failed.
      }
    }
    if (!this._child) this._cleanupEphemeralCodexHome();
  }

  _createEphemeralCodexHome(env) {
    const sourceHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this._cleanupStaleEphemeralCodexHomes();
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), EPHEMERAL_CODEX_HOME_PREFIX));
    this._ephemeralCodexHome = isolatedHome;
    try {
      try { fs.chmodSync(isolatedHome, 0o700); } catch (_) {}
      const sourceAuth = path.join(sourceHome, 'auth.json');
      if (fs.existsSync(sourceAuth)) {
        const isolatedAuth = path.join(isolatedHome, 'auth.json');
        try {
          fs.linkSync(sourceAuth, isolatedAuth);
        } catch {
          try {
            fs.symlinkSync(sourceAuth, isolatedAuth, 'file');
          } catch {
            fs.copyFileSync(sourceAuth, isolatedAuth);
            try { fs.chmodSync(isolatedAuth, 0o600); } catch (_) {}
          }
        }
      }
      const sourceConfig = path.join(sourceHome, 'config.toml');
      if (fs.existsSync(sourceConfig)) {
        const config = isolatedProviderConfig(fs.readFileSync(sourceConfig, 'utf8'));
        if (config) {
          const isolatedConfig = path.join(isolatedHome, 'config.toml');
          fs.writeFileSync(isolatedConfig, config, { mode: 0o600 });
        }
      }
      return isolatedHome;
    } catch (error) {
      this._cleanupEphemeralCodexHome();
      throw error;
    }
  }

  _cleanupEphemeralCodexHome() {
    if (!this._ephemeralCodexHome) return;
    try {
      fs.rmSync(this._ephemeralCodexHome, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50
      });
      this._ephemeralCodexHome = null;
    } catch (error) {
      console.warn(`[CodexAppServerDriver] Could not remove ephemeral Codex home: ${error.message}`);
    }
  }

  _cleanupStaleEphemeralCodexHomes() {
    const tempRoot = os.tmpdir();
    let entries;
    try { entries = fs.readdirSync(tempRoot, { withFileTypes: true }); } catch (_) { return; }
    const staleBefore = Date.now() - EPHEMERAL_CODEX_HOME_MAX_AGE_MS;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(EPHEMERAL_CODEX_HOME_PREFIX)) continue;
      const candidate = path.join(tempRoot, entry.name);
      try {
        if (fs.statSync(candidate).mtimeMs < staleBefore) {
          fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
      } catch (_) {}
    }
  }

  /** Send SIGKILL when the child ignored SIGTERM. */
  _forceKill() {
    if (this._exited || !this._child) return;
    try {
      this._child.kill('SIGKILL');
    } catch (error) {
      // Process already gone.
    }
  }

  /**
   * Resolves on the FIRST of `exit`, `close` or a hard timeout.
   *
   * `exit` alone is not enough: a child that failed to spawn (ENOENT) only ever
   * emits `error` + `close`, so waiting for `exit` hung `stopSession()` — and
   * with it the whole `driverchat:start` IPC round trip — forever.
   *
   * @returns {Promise<void>}
   */
  _waitForExit() {
    if (this._exited || !this._child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, EXIT_WAIT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      const settle = () => {
        clearTimeout(timer);
        resolve();
      };
      this._child.once('exit', settle);
      this._child.once('close', settle);
    });
  }

  /**
   * @param {'idle'|'starting'|'ready'|'running'|'stopped'|'error'} state
   * @param {string} [reason]
   */
  _setState(state, reason) {
    this._state = state;
    this._emitProviderEvent({
      type: 'session.state.changed',
      payload: reason ? { state, reason } : { state }
    });
  }

  // ------------------------------------------------------------- jsonrpc i/o

  /**
   * Write one JSON-RPC message as a single line.
   * @param {Object} message
   */
  _sendMessage(message) {
    if (!this._child || !this._child.stdin) return;
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Issue a JSON-RPC request and wait for its response.
   * @param {string} method
   * @param {Object} params
   * @returns {Promise<Object>} The `result` payload.
   */
  _request(method, params) {
    const id = this._nextRequestId++;
    const timeoutMs = ['thread/resume', 'thread/read', 'thread/turns/list'].includes(method)
      ? Math.max(this._requestTimeoutMs, HISTORY_REQUEST_TIMEOUT_MS)
      : this._requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this._pendingRequests.set(id, { resolve, reject, method, timer });
      this._sendMessage({ id, method, params });
    });
  }

  /**
   * Reject and clear every in-flight request.
   * @param {Error} error
   */
  _rejectAllPending(error) {
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pendingRequests.clear();
  }

  /**
   * Frame a stdout chunk and route each message.
   * @param {string} chunk
   */
  _handleStdoutChunk(chunk) {
    const { messages, remainder, invalidLines } = parseJsonRpcChunk(this._stdoutRemainder, chunk);
    this._stdoutRemainder = remainder;

    for (const line of invalidLines) {
      this._emitProviderEvent({
        type: 'runtime.warning',
        payload: { message: 'Unparseable JSON-RPC line from codex app-server', detail: { line } }
      });
    }
    for (const message of messages) {
      this._handleMessage(message);
    }
  }

  /**
   * Surface codex's own ERROR log lines; ignore the rest of stderr.
   * @param {string} chunk
   */
  _handleStderrChunk(chunk) {
    const lines = `${this._stderrRemainder}${chunk}`.split('\n');
    this._stderrRemainder = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!CODEX_STDERR_ERROR_PATTERN.test(line)) continue;
      this._emitProviderEvent({ type: 'runtime.warning', payload: { message: line.trim() } });
    }
  }

  /**
   * Route one decoded JSON-RPC message.
   * @param {Object} message
   */
  _handleMessage(message) {
    if (message.method && message.id !== undefined) {
      this._handleServerRequest(message);
      return;
    }
    if (message.method) {
      this._handleNotification(message);
      return;
    }
    if (message.id !== undefined) {
      this._resolvePending(message);
    }
  }

  /**
   * Settle the pending request matching a response message.
   * @param {Object} message
   */
  _resolvePending(message) {
    const pending = this._pendingRequests.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingRequests.delete(message.id);

    if (message.error) {
      const { message: text, code } = message.error;
      pending.reject(new Error(`Codex request failed: ${text || 'unknown'} (code ${code})`));
      return;
    }
    pending.resolve(message.result);
  }

  // ---------------------------------------------------------- notifications

  /**
   * Update internal bookkeeping, then emit the canonical events.
   *
   * A collaborator agent's own turns stream to this same client tagged with
   * ITS thread id, so anything that is not the session's thread is buffered as
   * a child conversation instead of being mapped onto the main timeline.
   *
   * @param {{method: string, params?: Object}} notification
   */
  _handleNotification({ method, params }) {
    const notifThreadId = params && (params.threadId || (params.thread && params.thread.id));
    if (notifThreadId && this._threadId && notifThreadId !== this._threadId) {
      this._handleChildNotification(notifThreadId, method, params);
      return;
    }
    if (this._handleSubAgentActivity(method, params)) return;
    if (this._handleSpawnAgentItem(method, params)) return;

    this._applyNotificationBookkeeping(method, params);
    for (const bare of mapCodexNotification({ method, params }, {
      rootThreadId: this._threadId
    })) {
      this._emitProviderEvent(bare);
    }
  }

  /**
   * Buffer one notification belonging to a collaborator agent's own thread.
   *
   * The child's events are kept per thread so its conversation can be opened
   * on demand; the ONLY thing that reaches the main timeline from here is the
   * lifecycle of the subagent row the parent opened.
   *
   * @param {string} childThreadId
   * @param {string} method
   * @param {Object} [params]
   * @returns {void}
   */
  _handleChildNotification(childThreadId, method, params) {
    const entry = this._childThreadEntry(childThreadId);
    const revived = entry.status !== 'running' && method.startsWith('item/');

    for (const bare of mapCodexNotification({ method, params })) {
      entry.events.push(createProviderEvent(bare, {
        provider: PROVIDER_ID,
        threadId: childThreadId
      }));
      if (entry.events.length > CHAT_HISTORY_EVENT_LIMIT) entry.events.shift();
    }

    if (revived) {
      entry.status = 'running';
      this._emitSubagentRowEvent('item.updated', childThreadId, entry, 'inProgress', method, params);
      return;
    }
    if (method !== 'turn/completed' && method !== 'turn/failed') return;

    entry.status = method === 'turn/failed' ? 'failed' : 'completed';
    this._emitSubagentRowEvent('item.completed', childThreadId, entry, entry.status, method, params);
  }

  /**
   * The buffer of one collaborator thread, created on first sight.
   * @param {string} childThreadId
   * @returns {{events: Object[], status: string, agentType: string,
   *   description: string, rowOpened: boolean}}
   */
  _childThreadEntry(childThreadId) {
    let entry = this._childThreads.get(childThreadId);
    if (!entry) {
      entry = { events: [], status: 'running', agentType: '', description: '', rowOpened: false };
      this._childThreads.set(childThreadId, entry);
    }
    return entry;
  }

  /**
   * Open the main-timeline row of a spawned collaborator agent.
   *
   * The parent thread announces the spawn with a `subAgentActivity` item and
   * echoes the very same item as completed milliseconds later. Closing the row
   * on that echo would finish it before the collaborator has said anything, so
   * the echo is swallowed and the row closes when the CHILD thread ends.
   *
   * @param {string} method
   * @param {Object} [params]
   * @returns {boolean} True when the notification was a subagent announcement
   *   and must not travel any further.
   */
  _handleSubAgentActivity(method, params) {
    const item = params && params.item;
    if (!item || item.type !== 'subAgentActivity') return false;
    const childThreadId = item.agentThreadId;
    if (method !== 'item/started' || item.kind !== 'started' || !childThreadId) return true;

    const entry = this._childThreadEntry(childThreadId);
    entry.agentType = subAgentNickname(item.agentPath);
    entry.description = entry.agentType;
    entry.rowOpened = true;
    this._emitSubagentRowEvent('item.started', childThreadId, entry, 'inProgress', method, params);
    return true;
  }

  /**
   * Open the main-timeline row of a collaborator from its native spawn item.
   *
   * `subAgentActivity` is not always there: a parent driving the cell/`wait`
   * flow emits none at all, so the spawn item is the only announcement of the
   * child. Its own events are swallowed for the same reason the activity echo
   * is — the spawn call completes the instant the child is launched, and
   * closing the row there would settle a collaborator that just started.
   *
   * @param {string} method
   * @param {Object} [params]
   * @returns {boolean} True when the notification opened (or belongs to) a
   *   collaborator row and must not travel any further.
   */
  _handleSpawnAgentItem(method, params) {
    if (method !== 'item/started' && method !== 'item/completed') return false;
    const item = params && params.item;
    if (!item || item.type !== 'collabAgentToolCall') return false;

    // The completed echo can arrive without the receiver ids, so the item is
    // remembered by its own id: whatever it echoes belongs to the same child.
    // An id-less item is never remembered — an `undefined` key would make any
    // other id-less collab call pass for a spawn echo and be swallowed.
    const childThreadId = spawnedChildThreadId(item)
      || (item.id ? this._spawnItemChildThreads.get(item.id) : '');
    if (!childThreadId) return false;
    if (item.id) this._spawnItemChildThreads.set(item.id, childThreadId);

    const entry = this._childThreadEntry(childThreadId);
    if (!entry.agentType) {
      entry.agentType = SPAWNED_AGENT_FALLBACK_NAME;
      entry.description = SPAWNED_AGENT_FALLBACK_NAME;
    }
    entry.rowOpened = true;
    // The row always follows the CHILD's state, never the item's. An echo that
    // trails the child's own end must close the row, not reopen it: the child
    // thread is over, so no second `turn/completed` would ever settle it again.
    const settled = entry.status !== 'running';
    this._emitSubagentRowEvent(
      settled ? 'item.completed' : 'item.started',
      childThreadId,
      entry,
      settled ? entry.status : 'inProgress',
      method,
      params
    );
    return true;
  }

  /**
   * Emit one lifecycle event of a subagent row on the main timeline.
   *
   * Nothing is emitted for a child nobody opened a row for: an orphan child
   * thread (no `subAgentActivity` was seen) has no row to keep in sync.
   *
   * @param {'item.started'|'item.updated'|'item.completed'} type
   * @param {string} childThreadId
   * @param {Object} entry The child's buffer.
   * @param {string} status Canonical item status.
   * @param {string} method Native method, for the raw passthrough.
   * @param {Object} [params] Native params, for the raw passthrough.
   * @returns {void}
   */
  _emitSubagentRowEvent(type, childThreadId, entry, status, method, params) {
    if (!entry.rowOpened) return;
    this._emitProviderEvent({
      type,
      turnId: params && params.turnId,
      itemId: subagentRowItemId(childThreadId),
      payload: subagentRowPayload(entry.agentType, status, childThreadId),
      raw: buildRaw(method, params)
    });
  }

  /**
   * Read one collaborator agent's own conversation.
   *
   * A live child is served straight from the buffer its notifications feed;
   * the caller polls with the `cursor` it last saw and gets `unchanged: true`
   * while no new event arrived. A child of a RESTORED parent was never
   * streamed to this process, so its rollout is resumed from disk instead.
   *
   * @param {{taskId: string, known?: {cursor: number}}} params `taskId` is the
   *   collaborator's thread id, which is the row's stable identity.
   * @returns {Promise<Object>} `{agentId, agentType, description, running,
   *   talk, events, cursor}`, or `{agentId, running, talk, unchanged: true}`.
   */
  async openSubagentConversation({ taskId, known } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) {
      throw new Error('Subagent conversation not found on disk');
    }
    const entry = this._childThreads.get(taskId);
    if (entry) {
      const running = entry.status === 'running';
      if (known && known.cursor === entry.events.length) {
        return { agentId: taskId, running, talk: 'relay', unchanged: true };
      }
      return {
        agentId: taskId,
        agentType: entry.agentType || 'collaborator',
        description: entry.description || entry.agentType || '',
        running,
        talk: 'relay',
        events: entry.events.slice(),
        cursor: entry.events.length
      };
    }

    let result;
    try {
      // Resuming a child must not touch this session's identity: the driver
      // keeps driving the PARENT thread, this is only a read of the rollout.
      result = await this._request('thread/resume', { threadId: taskId });
    } catch (error) {
      const nativeMessage = String(error && error.message || '');
      const missingConversationPatterns = [
        /\bthread not found\b/i,
        /\bno rollout found for thread id\b/i
      ];
      if (missingConversationPatterns.some((pattern) => pattern.test(nativeMessage))) {
        throw new Error('Subagent conversation not found on disk');
      }
      throw error;
    }

    const events = this._collectThreadHistory(result?.thread, taskId);
    return {
      agentId: taskId,
      agentType: 'collaborator',
      description: '',
      running: false,
      talk: 'relay',
      events,
      cursor: events.length
    };
  }

  /**
   * Deliver a message to a collaborator agent through its parent.
   *
   * Codex forbids `turn/start` on a sub-agent thread ("direct app-server input
   * is not allowed for multi-agent v2 sub-agents"), so the only way in is the
   * parent's own collaboration tooling, driven by an ordinary parent turn.
   *
   * @param {{taskId: string, agentType?: string, text: string}} params
   * @returns {Promise<{turnId: string}>}
   */
  async sendToSubagentConversation({ taskId, agentType, text } = {}) {
    const relay = `[Relay to collaborator agent] Deliver the following message VERBATIM to your collaborator agent with thread id "${taskId}"${agentType ? ` (${agentType})` : ''} using your multi-agent collaboration send_input tool (resume it first with resume_agent if it is closed), then briefly confirm delivery. Do not act on the message yourself.\n\n${text}`;
    return this.sendTurn({ text: relay });
  }

  /**
   * Track thread/turn identity and session state from native notifications.
   * @param {string} method
   * @param {Object} [params]
   */
  _applyNotificationBookkeeping(method, params) {
    if (method === 'thread/started') {
      if (!this._threadId) this._threadId = params?.thread?.id;
      return;
    }
    if (method === 'turn/started') {
      this._activeTurnId = params?.turn?.id;
      this._setState('running');
      return;
    }
    if (method === 'turn/completed') {
      this._activeTurnId = null;
      this._expirePendingQuestions();
      this._setState('ready');
      void this._flushQueuedTurnInputs();
    }
  }

  // -------------------------------------------------------- server requests

  /**
   * Park a server -> client request until the renderer sends a user decision.
   * @param {{id: (string|number), method: string, params?: Object}} request
   */
  _handleServerRequest({ id, method, params }) {
    const known = Object.prototype.hasOwnProperty.call(SERVER_REQUEST_TABLE, method);
    if (!known) {
      this._rejectUnknownServerRequest(id, method);
      return;
    }

    const { requestType, protocol } = SERVER_REQUEST_TABLE[method];
    const envelope = {
      ...(params?.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(params?.itemId !== undefined ? { itemId: params.itemId } : {})
    };

    // Structured tool questions need a dedicated form UI. MCP tool approvals
    // arrive as message-only elicitations and use the normal permission card.
    if (protocol === 'user_input') {
      this._handleUserInputRequest(id, requestType, params, envelope);
      return;
    }

    const requestId = String(id);
    const persist = params?._meta?.persist;
    const supportsSession = persist === 'session'
      || (Array.isArray(persist) && persist.includes('session'));
    const options = protocol === 'mcp_elicitation'
      ? [
          APPROVAL_OPTIONS[0],
          ...(supportsSession ? [APPROVAL_OPTIONS[1]] : []),
          APPROVAL_OPTIONS[2]
        ]
      : APPROVAL_OPTIONS;
    this._pendingApprovals.set(requestId, {
      id,
      protocol,
      requestType,
      envelope
    });
    this._emitProviderEvent({
      type: 'request.opened',
      requestId,
      ...envelope,
      payload: {
        requestType,
        detail: approvalDetail(params),
        args: params,
        options
      }
    });
  }

  /**
   * Park a structured question until the user answers it in the chat.
   *
   * Codex only sends `item/tool/requestUserInput` in Plan collaboration mode,
   * and it used to be auto-answered with an empty object; now the JSON-RPC
   * request stays open until {@link CodexAppServerDriver#respondToQuestion}.
   *
   * @param {string|number} id JSON-RPC id of the server request.
   * @param {string} requestType Canonical request type.
   * @param {Object} [params] Native request params.
   * @param {{turnId?: string, itemId?: string}} envelope
   */
  _handleUserInputRequest(id, requestType, params, envelope) {
    const questions = mapCodexUserInputQuestions(params?.questions);
    if (questions.length === 0) {
      // Nothing renderable: answering empty is the only honest way out, the
      // alternative being a card the user cannot possibly fill in.
      this._sendMessage({ id, result: { answers: {} } });
      this._emitProviderEvent({
        type: 'runtime.warning',
        payload: { message: 'Codex requested user input without any renderable question' }
      });
      return;
    }

    const requestId = String(id);
    this._pendingQuestions.set(requestId, { id, requestType, envelope, questions });

    const autoMs = params?.autoResolutionMs;
    const expiresAtMs = typeof autoMs === 'number' && Number.isFinite(autoMs) && autoMs > 0
      ? Date.now() + autoMs
      : undefined;
    this._emitProviderEvent({
      type: 'question.opened',
      requestId,
      ...envelope,
      payload: {
        requestType,
        questions,
        ...(expiresAtMs ? { expiresAtMs } : {})
      }
    });
  }

  /** Answer every outstanding question emptily before stopping its process. */
  _cancelAllPendingQuestions() {
    for (const [requestId, pending] of this._pendingQuestions) {
      this._sendMessage({ id: pending.id, result: { answers: {} } });
      this._emitProviderEvent({
        type: 'question.resolved',
        requestId,
        ...pending.envelope,
        payload: { requestType: pending.requestType, decision: 'cancelled' }
      });
    }
    this._pendingQuestions.clear();
  }

  /**
   * Settle every outstanding question when the turn ends.
   *
   * No JSON-RPC reply is sent on purpose: the server either auto-resolved the
   * request itself (`autoResolutionMs`) or it died with the turn, so replying
   * would answer it twice.
   */
  _expirePendingQuestions() {
    for (const [requestId, pending] of this._pendingQuestions) {
      this._emitProviderEvent({
        type: 'question.resolved',
        requestId,
        ...pending.envelope,
        payload: { requestType: pending.requestType, decision: 'expired' }
      });
    }
    this._pendingQuestions.clear();
  }

  /** Deny every outstanding server request before stopping its process. */
  _denyAllPendingApprovals() {
    for (const [requestId, pending] of this._pendingApprovals) {
      const result = buildCodexApprovalResponse(pending.protocol, 'reject_once');
      this._sendMessage({ id: pending.id, result });
      this._emitProviderEvent({
        type: 'request.resolved',
        requestId,
        ...pending.envelope,
        payload: { requestType: pending.requestType, decision: 'reject_once' }
      });
    }
    this._pendingApprovals.clear();
  }

  /**
   * Reply with a JSON-RPC "method not found" and warn.
   * @param {string|number} id
   * @param {string} method
   */
  _rejectUnknownServerRequest(id, method) {
    this._sendMessage({
      id,
      error: {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: `Method not supported by CodeAgentSwarm driver: ${method}`
      }
    });
    this._emitProviderEvent({
      type: 'runtime.warning',
      payload: { message: `Unsupported codex app-server request: ${method}` }
    });
  }

  // -------------------------------------------------------------- child exit

  /**
   * Spawn/transport failure reported by the child process.
   * @param {Error} error
   */
  _handleChildError(error) {
    // The child never came up: there is no process to wait for, so mark it
    // exited or every later `_waitForExit()` would sit on an event that the
    // failed spawn is never going to emit.
    if (!this._child || this._child.pid === undefined) {
      this._exited = true;
      this._cleanupEphemeralCodexHome();
    }

    const described = this._describeChildError(error);
    this._rejectAllPending(described);
    this._emitRuntimeError(described.message, 'transport_error');
    this._state = 'error';
  }

  /**
   * Turn a raw spawn error into something a user can act on.
   * @param {Error} error
   * @returns {Error} The original error, or a clearer replacement.
   */
  _describeChildError(error) {
    if (error?.code === 'ENOENT') {
      return new Error(
        `Codex CLI not found ('${this._binaryPath}'). `
        + 'Install Codex or make sure it is on your PATH.'
      );
    }
    return error;
  }

  /**
   * @param {number|null} code
   * @param {string|null} signal
   */
  _handleChildExit(code, signal) {
    this._exited = true;
    const reason = `codex app-server exited with code ${code}`;
    this._rejectAllPending(new Error(reason));
    this._drainStdoutRemainder();
    this._cleanupEphemeralCodexHome();

    if (this._stopping) return;

    this._state = code === 0 ? 'stopped' : 'error';
    this._emitProviderEvent({
      type: 'session.exited',
      payload: {
        exitKind: code === 0 ? 'graceful' : 'error',
        ...(code === null || code === undefined ? {} : { exitCode: code }),
        reason
      }
    });
  }

  /** Parse whatever was left in the stdout buffer when the child died. */
  _drainStdoutRemainder() {
    if (!this._stdoutRemainder) return;
    const { messages } = parseJsonRpcChunk(this._stdoutRemainder, '\n');
    this._stdoutRemainder = '';
    for (const message of messages) {
      this._handleMessage(message);
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * @param {string} message
   * @param {'provider_error'|'transport_error'|'unknown'} errorClass
   */
  _emitRuntimeError(message, errorClass) {
    this._emitProviderEvent({
      type: 'runtime.error',
      payload: { message, class: errorClass }
    });
  }

  /**
   * Wrap a bare event and publish it on the provider-event channel.
   * @param {Object} bare
   */
  _emitProviderEvent(bare) {
    const executionOrigin = bare && bare.executionOrigin
      ? bare.executionOrigin
      : bare?.threadId && this._threadId && bare.threadId !== this._threadId
        ? 'subagent'
        : 'main';
    const event = createProviderEvent(bare, {
      provider: PROVIDER_ID,
      threadId: this._threadId || undefined,
      executionOrigin
    });
    /**
     * @event CodexAppServerDriver#provider-event
     * @type {import('./provider-events').ProviderEvent}
     */
    this.emit(PROVIDER_EVENT_CHANNEL, event);
  }
}

/**
 * App-server history exposes turn boundaries, not per-item timestamps.
 * @param {Object} turn
 * @param {string} itemType
 * @returns {string|null}
 */
function codexHistoryItemTime(turn, itemType) {
  const seconds = itemType === 'user_message'
    ? turn?.startedAt
    : (turn?.completedAt ?? turn?.startedAt);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Build the `raw` passthrough attached to every mapped event.
 * @param {string} method
 * @param {Object} [params]
 * @returns {{source: string, method: string, payload: Object|undefined}}
 */
function buildRaw(method, params) {
  return { source: RAW_SOURCE, method, payload: params };
}

/**
 * Human-readable detail for an approval request.
 * @param {Object} [params]
 * @returns {string|undefined}
 */
function approvalDetail(params) {
  const command = joinCommand(params?.command);
  if (command) return command;
  if (typeof params?.message === 'string' && params.message) return params.message;
  return typeof params?.reason === 'string' && params.reason ? params.reason : undefined;
}

/**
 * Translate codex's native `requestUserInput` questions into the canonical
 * question shape. Codex questions are single-select, carry no comment field,
 * and mark a free-text answer with `isOther`.
 *
 * @param {Array<Object>} [rawQuestions]
 * @returns {import('./provider-events').CanonicalQuestion[]} Only the questions
 *   that can actually be rendered and answered.
 */
function mapCodexUserInputQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];

  const questions = [];
  for (const raw of rawQuestions) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    const header = typeof raw?.header === 'string' ? raw.header.trim() : '';
    const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
    const options = (Array.isArray(raw?.options) ? raw.options : [])
      .map((option) => ({
        label: typeof option?.label === 'string' ? option.label.trim() : '',
        description: typeof option?.description === 'string' ? option.description.trim() : ''
      }))
      .filter((option) => option.label);
    const allowsFreeText = raw?.isOther === true;

    if (!id || !question || (options.length === 0 && !allowsFreeText)) continue;
    questions.push({
      id,
      header: header || 'Question',
      question,
      options,
      multiSelect: false,
      allowsFreeText,
      allowsNote: false,
      secret: raw?.isSecret === true
    });
  }
  return questions;
}

/**
 * Build the protocol-specific result envelope for an approval response.
 * @param {'legacy'|'v2'|'mcp_elicitation'} protocol
 * @param {string} decision
 * @returns {Object}
 */
function buildCodexApprovalResponse(protocol, decision) {
  if (protocol === 'mcp_elicitation') {
    const allowForSession = decision === 'allow_always' || decision === 'allow_session';
    const allowOnce = decision === 'allow_once' || decision === 'accept' || decision === 'approved';
    return {
      action: allowForSession || allowOnce ? 'accept' : 'decline',
      content: null,
      _meta: allowForSession ? { persist: 'session' } : null
    };
  }
  return { decision: translateCodexApprovalDecision(protocol, decision) };
}

/**
 * Translate the shared chat decisions to Codex's two approval enums.
 * @param {'legacy'|'v2'} protocol
 * @param {string} decision
 * @returns {string}
 */
function translateCodexApprovalDecision(protocol, decision) {
  const allowForSession = decision === 'allow_always' || decision === 'allow_session';
  const allowOnce = decision === 'allow_once' || decision === 'accept' || decision === 'approved';
  if (protocol === 'legacy') {
    if (allowForSession) return 'approved_for_session';
    if (allowOnce) return 'approved';
    return 'denied';
  }
  if (allowForSession) return 'acceptForSession';
  if (allowOnce) return 'accept';
  return 'decline';
}

/**
 * @param {string|string[]|undefined} command
 * @returns {string|undefined}
 */
function joinCommand(command) {
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : undefined;
}

/**
 * Translate a codex item `type` into the canonical vocabulary.
 * @param {string} rawType
 * @returns {string} Canonical item type, `'unknown'` when unmapped.
 */
function toCanonicalItemType(rawType) {
  if (typeof rawType !== 'string') return 'unknown';
  return Object.prototype.hasOwnProperty.call(CODEX_ITEM_TYPE_MAP, rawType)
    ? CODEX_ITEM_TYPE_MAP[rawType]
    : 'unknown';
}

/**
 * @param {string} itemType Canonical item type.
 * @param {Object} [item] Native codex item.
 * @returns {string|undefined}
 */
function itemTitle(itemType, item) {
  if (itemType === 'mcp_tool_call' && item?.server && item?.tool) {
    return `${item.server} · ${item.tool}`;
  }
  // A generic tool row shows its title as the verb once it settles, so the tool
  // the agent actually called has to be in it: `Tool call` alone says nothing.
  if (itemType === 'dynamic_tool_call' && typeof item?.tool === 'string' && item.tool) {
    return `${ITEM_TITLE_MAP.dynamic_tool_call} · ${item.tool}`;
  }
  return ITEM_TITLE_MAP[itemType];
}

/**
 * First meaningful one-line description found on a native codex item.
 * @param {Object} [item]
 * @returns {string|undefined}
 */
function itemDetail(item) {
  if (!item) return undefined;
  for (const field of ITEM_DETAIL_FIELDS) {
    const value = field === 'command' ? joinCommand(item.command) : item[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Normalize codex token usage into the canonical shape, omitting absent keys.
 * @param {Object} [tokenUsage]
 * @returns {Object|undefined} Undefined when there is nothing meaningful yet.
 */
function normalizeCodexTokenUsage(tokenUsage) {
  const usedTokens = tokenUsage?.last?.totalTokens;
  if (typeof usedTokens !== 'number' || !(usedTokens > 0)) return undefined;

  const usage = { usedTokens };
  const totalProcessed = tokenUsage?.total?.totalTokens;
  if (typeof totalProcessed === 'number' && totalProcessed > usedTokens) {
    usage.totalProcessedTokens = totalProcessed;
  }
  if (typeof tokenUsage.modelContextWindow === 'number') {
    usage.maxTokens = tokenUsage.modelContextWindow;
  }
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
    if (typeof tokenUsage.last[field] === 'number') usage[field] = tokenUsage.last[field];
  }
  return usage;
}

/**
 * Codex turn status -> canonical turn state.
 * @param {string} status
 * @returns {string}
 */
function mapTurnStatus(status) {
  return status === 'failed' || status === 'interrupted' || status === 'completed'
    ? status
    : 'completed';
}

/**
 * Build a `content.delta` event, or nothing when the delta is empty.
 * @param {string} streamKind
 * @param {{method: string, params?: Object}} notification
 * @param {Object} [extra] Extra payload keys (contentIndex / summaryIndex).
 * @returns {Object[]}
 */
function contentDeltaEvents(streamKind, { method, params }, extra = {}) {
  const delta = params?.delta;
  if (typeof delta !== 'string' || delta === '') return [];
  return [{
    type: 'content.delta',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    payload: { streamKind, delta, ...extra },
    raw: buildRaw(method, params)
  }];
}

/**
 * Build an `item.started` / `item.completed` event from a native item.
 * @param {'item.started'|'item.completed'} type
 * @param {{method: string, params?: Object}} notification
 * @param {string} status Canonical item status.
 * @param {{restoreAttachments?: boolean}} [options]
 * @returns {Object[]}
 */
function itemEvents(type, { method, params }, status, { restoreAttachments = false } = {}) {
  const item = params?.item;
  const rawItemType = toCanonicalItemType(item?.type);
  if (rawItemType === 'unknown') return [];

  // Only the spawn stands for a collaborator. Every other collaboration call —
  // above all the `wait` codex loops on every 30s while a child works — is an
  // ordinary tool call: typed as a subagent it became a "Delegating" row that
  // never finished and whose drill-down had no thread behind it.
  const childThreadId = spawnedChildThreadId(item);
  const itemType = rawItemType === 'collab_agent_tool_call' && !childThreadId
    ? 'dynamic_tool_call'
    : rawItemType;

  const title = itemTitle(itemType, item);
  const detail = itemDetail(item);
  const historyAttachments = restoreAttachments && itemType === 'user_message'
    ? contentImageAttachments(item?.content)
    : [];
  const data = childThreadId
    ? {
      ...item,
      subagent: {
        agentType: 'subagent',
        description: 'subagent',
        background: true,
        taskId: childThreadId
      }
    }
    : historyAttachments.length
      ? { ...item, attachments: historyAttachments }
      : item;
  return [{
    type,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: item.id,
    payload: {
      itemType,
      status,
      ...(title !== undefined ? { title } : {}),
      ...(detail !== undefined ? { detail } : {}),
      data
    },
    raw: buildRaw(method, params)
  }];
}

/**
 * The collaborator thread a native item spawned, when it is a spawn at all.
 * @param {Object} [item] Native codex item.
 * @returns {string} `''` for anything that is not a `spawnAgent` with a child.
 */
function spawnedChildThreadId(item) {
  if (item?.type !== 'collabAgentToolCall' || item?.tool !== 'spawnAgent') return '';
  const receiverThreadId = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds[0] : '';
  return typeof receiverThreadId === 'string' ? receiverThreadId.trim() : '';
}

/**
 * The name a collaborator agent goes by: the last segment of its agent path
 * (`/root/sum` -> `sum`), which is what the model called it when spawning it.
 * @param {string} [agentPath]
 * @returns {string}
 */
function subAgentNickname(agentPath) {
  const segments = String(agentPath || '').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : 'collaborator';
}

/**
 * Item id of the main-timeline row that stands for a collaborator agent.
 * Derived from the child's thread id so every lifecycle event of that
 * collaborator lands in ONE row, no matter which notification produced it.
 * @param {string} childThreadId
 * @returns {string}
 */
function subagentRowItemId(childThreadId) {
  return `subagent-${childThreadId}`;
}

/**
 * Payload of a collaborator agent's main-timeline row.
 * @param {string} nickname
 * @param {string} status Canonical item status.
 * @param {string} childThreadId Doubles as the row's stable task id.
 * @returns {Object}
 */
function subagentRowPayload(nickname, status, childThreadId) {
  const agentType = nickname || 'collaborator';
  return {
    itemType: 'collab_agent_tool_call',
    status,
    title: 'Subagent task',
    detail: agentType,
    data: {
      subagent: {
        agentType,
        description: agentType,
        background: true,
        taskId: childThreadId
      }
    }
  };
}

/**
 * Replay a resumed thread's `subAgentActivity` item as a finished subagent row.
 * @param {{method: string, params: Object}} notification
 * @returns {Object[]}
 */
function subAgentActivityHistoryEvents({ method, params }) {
  const item = params.item;
  const childThreadId = item && item.agentThreadId;
  if (!childThreadId) return [];
  return [{
    type: 'item.completed',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: subagentRowItemId(childThreadId),
    payload: subagentRowPayload(subAgentNickname(item.agentPath), 'completed', childThreadId),
    raw: buildRaw(method, params)
  }];
}

/**
 * Canonical status of a completed codex item.
 * @param {Object} [item]
 * @returns {string}
 */
function completedItemStatus(item) {
  if (item?.status === 'failed') return 'failed';
  if (item?.status === 'declined') return 'declined';
  return 'completed';
}

/** method -> mapper. Each mapper returns an array of bare canonical events. */
const NOTIFICATION_MAPPERS = Object.freeze({
  'thread/started': ({ method, params }) => {
    const providerThreadId = params?.thread?.id;
    if (!providerThreadId) return [];
    return [{
      type: 'thread.started',
      threadId: providerThreadId,
      payload: { providerThreadId },
      raw: buildRaw(method, params)
    }];
  },

  'turn/started': ({ method, params }) => {
    const turnId = params?.turn?.id;
    if (!turnId) return [];
    return [{
      type: 'turn.started',
      threadId: params.threadId,
      turnId,
      payload: {},
      raw: buildRaw(method, params)
    }];
  },

  'turn/completed': ({ method, params }) => {
    const turn = params?.turn;
    if (!turn?.id) return [];
    const errorMessage = turn.error?.message;
    return [{
      type: 'turn.completed',
      threadId: params.threadId,
      turnId: turn.id,
      payload: {
        state: mapTurnStatus(turn.status),
        ...(errorMessage ? { errorMessage } : {})
      },
      raw: buildRaw(method, params)
    }];
  },

  'turn/diff/updated': ({ method, params }) => {
    const unifiedDiff = params?.diff;
    if (typeof unifiedDiff !== 'string') return [];
    return [{
      type: 'turn.diff.updated',
      threadId: params.threadId,
      turnId: params.turnId,
      payload: { unifiedDiff },
      raw: buildRaw(method, params)
    }];
  },

  // The app-server publishes the checklist as a turn-level notification, not
  // as a thread item: its `plan` item is `{id, text}`, prose with no steps.
  // Reading only items is why the card never appeared for Codex in Chat.
  //
  // The notification repeats with the whole plan and carries no item id, so a
  // synthetic per-turn id keeps every update refreshing one card instead of
  // appending a row per revision.
  'turn/plan/updated': ({ method, params }) => {
    const steps = params?.plan;
    const turnId = params?.turnId;
    if (!Array.isArray(steps) || !steps.length || !turnId) return [];
    return [{
      type: 'item.completed',
      threadId: params.threadId,
      turnId,
      itemId: `${turnId}-plan`,
      payload: {
        itemType: 'plan',
        status: 'completed',
        title: 'Plan',
        data: { name: 'update_plan', plan: steps }
      },
      raw: buildRaw(method, params)
    }];
  },

  'item/started': (notification, options) => itemEvents(
    'item.started',
    notification,
    'inProgress',
    { restoreAttachments: options?.historical }
  ),

  'item/completed': (notification, options) => itemEvents(
    'item.completed',
    notification,
    completedItemStatus(notification.params?.item),
    { restoreAttachments: options?.historical }
  ),

  'item/agentMessage/delta': (n) => contentDeltaEvents('assistant_text', n),

  'item/reasoning/textDelta': (n) => contentDeltaEvents('reasoning_text', n, {
    contentIndex: n.params?.contentIndex
  }),

  'item/reasoning/summaryTextDelta': (n) => contentDeltaEvents('reasoning_summary_text', n, {
    summaryIndex: n.params?.summaryIndex
  }),

  'item/reasoning/summaryPartAdded': ({ method, params }) => [{
    type: 'item.updated',
    threadId: params?.threadId,
    turnId: params?.turnId,
    itemId: params?.itemId,
    payload: { itemType: 'reasoning', data: params },
    raw: buildRaw(method, params)
  }],

  'item/commandExecution/outputDelta': (n) => contentDeltaEvents('command_output', n),

  'item/fileChange/outputDelta': (n) => contentDeltaEvents('file_change_output', n),

  'item/plan/delta': (n) => contentDeltaEvents('plan_text', n),

  'item/fileChange/patchUpdated': ({ method, params }) => [{
    type: 'item.updated',
    threadId: params?.threadId,
    turnId: params?.turnId,
    itemId: params?.itemId,
    payload: { itemType: 'file_change', data: { changes: params?.changes } },
    raw: buildRaw(method, params)
  }],

  'item/mcpToolCall/progress': ({ method, params }) => [{
    type: 'item.updated',
    threadId: params?.threadId,
    turnId: params?.turnId,
    itemId: params?.itemId,
    payload: {
      itemType: 'mcp_tool_call',
      ...(params?.message !== undefined ? { detail: params.message } : {}),
      data: params
    },
    raw: buildRaw(method, params)
  }],

  'thread/tokenUsage/updated': ({ method, params }) => {
    const usage = normalizeCodexTokenUsage(params?.tokenUsage);
    if (!usage) return [];
    return [{
      type: 'thread.token-usage.updated',
      threadId: params.threadId,
      turnId: params.turnId,
      payload: { usage },
      raw: buildRaw(method, params)
    }];
  },

  'account/rateLimits/updated': ({ method, params }) => [{
    type: 'account.rate-limits.updated',
    threadId: params?.threadId,
    payload: { rateLimits: params?.rateLimits },
    raw: buildRaw(method, params)
  }],

  error: ({ method, params }) => {
    const message = params?.error?.message;
    const base = {
      threadId: params?.threadId,
      turnId: params?.turnId,
      raw: buildRaw(method, params)
    };
    if (params?.willRetry === true) {
      return [{ ...base, type: 'runtime.warning', payload: { message, detail: params } }];
    }
    return [{
      ...base,
      type: 'runtime.error',
      payload: { message, class: 'provider_error', detail: params }
    }];
  }
});

/**
 * Translate one native codex app-server notification into canonical events.
 *
 * Pure and deterministic: no clock, no randomness, never throws on missing
 * fields. Unmapped methods and incomplete payloads yield an empty array.
 *
 * @param {{method: string, params?: Object}} notification
 * @param {{rootThreadId?: string, historical?: boolean}} [options]
 * @returns {Object[]} Bare canonical events, ready for `createProviderEvent`.
 */
function mapCodexNotification(notification, { rootThreadId, historical = false } = {}) {
  const method = notification?.method;
  if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_MAPPERS, method)) return [];
  const events = NOTIFICATION_MAPPERS[method](notification, { historical });
  const threadId = notification?.params?.threadId || notification?.params?.thread?.id;
  const executionOrigin = executionOriginForThread(threadId, rootThreadId);
  return events.map((event) => ({ ...event, executionOrigin }));
}

/**
 * Codex app-server identifies collaboration output by its native child
 * thread. A missing root or thread id stays unknown and is rendered normally.
 * @param {string} threadId
 * @param {string} rootThreadId
 * @returns {'main'|'subagent'|'unknown'}
 */
function executionOriginForThread(threadId, rootThreadId) {
  if (!threadId || !rootThreadId) return 'unknown';
  return threadId === rootThreadId ? 'main' : 'subagent';
}

module.exports = { CodexAppServerDriver, mapCodexNotification };
