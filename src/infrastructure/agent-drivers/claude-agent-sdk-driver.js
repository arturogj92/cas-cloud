/**
 * Claude Agent SDK driver.
 *
 * Drives the user's own logged-in `claude` binary through
 * `@anthropic-ai/claude-agent-sdk` in streaming-input mode (the `prompt` option
 * is an async iterable of user messages, so one child process serves the whole
 * conversation) and translates the SDK messages into the canonical
 * provider-event vocabulary, so the rest of CodeAgentSwarm never has to know
 * Claude's message shapes.
 *
 * CONFIG / BILLING: the agent runs with WHATEVER configuration the user has set
 * up for their own CLI — exactly like the terminals do. We deliberately do NOT
 * add, remove or override any environment variable: the PTY spawns agents with
 * `env: { ...process.env, <CodeAgentSwarm vars> }` and scrubs nothing, so the
 * chat must inherit identically. Otherwise the SAME agent would behave
 * differently depending on whether the user entered through the terminal or the
 * chat (e.g. a user with `ANTHROPIC_API_KEY` exported: the terminal honours it,
 * a scrubbing chat would silently ignore it).
 *
 * What that means in practice: a user logged in with `claude` and no API-key
 * config gets subscription billing (`apiKeySource: 'none'` in the init message,
 * plus `five_hour` rate-limit telemetry — both verified empirically against a
 * real subscription login). A user who has configured an API key, a proxy
 * (`ANTHROPIC_BASE_URL`) or Bedrock/Vertex gets exactly that, same as their CLI.
 * The init message's `apiKeySource` tells us which one is active, so the UI can
 * surface it instead of the app deciding silently.
 *
 * The one thing we never do on our own initiative is SET `CLAUDE_CONFIG_DIR`:
 * pointing it anywhere (even at the real `~/.claude`) rescopes the macOS
 * keychain lookup and the CLI answers "Not logged in · Please run /login". It is
 * forwarded only when a caller explicitly passes `configDir` (isolated-home use
 * case, e.g. tests).
 *
 * See {@link buildClaudeChildEnv}.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { isNativeExe } = require('../platform/windows-direct-spawn');
const { mergeSessionCommunicationEnv } = require('./session-communication-env');

/** Where the SDK keeps its per-platform CLI, e.g. claude-agent-sdk-win32-arm64. */
const SDK_PLATFORM_PACKAGE = `claude-agent-sdk-${process.platform}-${process.arch}`;

/**
 * The spawnable twin of a Claude binary inside `packageDir`.
 *
 * Left to itself the SDK resolves the binary next to its own module, which inside a
 * packaged app is `resources/app.asar/node_modules/@anthropic-ai/<pkg>/claude.exe`.
 * No process can be spawned from inside an asar archive, so the launch fails with
 * "native binary ... exists but failed to launch" — and, because `fs.existsSync` is
 * asar-aware, the file even looks present. electron-builder unpacks this package
 * (`asarUnpack` in package.json), so the runnable twin is the same path with
 * `app.asar` swapped for `app.asar.unpacked`.
 *
 * Running from source there is no asar and the plain path is already runnable.
 *
 * @returns {string|null} An existing, spawnable binary, or null to let the SDK decide.
 */
function spawnableClaudeBinary(packageDir, exists = fs.existsSync) {
  if (!packageDir) return null;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const packed = path.join(packageDir, exe);
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
  // The unpacked path FIRST: inside a package both answer true, and only this one is
  // a real file on disk.
  for (const candidate of [unpacked, packed]) {
    try {
      if (exists(candidate)) return candidate;
    } catch (_) { /* unreadable candidate: try the next */ }
  }
  return null;
}

function unpackedClaudeBinary() {
  try {
    // The SDK's `exports` map hides its own package.json, so resolve the entry point
    // and walk up to the scope directory instead.
    const scope = path.dirname(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')));
    return spawnableClaudeBinary(path.join(scope, SDK_PLATFORM_PACKAGE));
  } catch (_) {
    return null;
  }
}
const { createProviderEvent } = require('./provider-events');
const {
  promptWithFileReferences,
  splitDataUrl,
  contentImageAttachments
} = require('./chat-attachments');
const {
  normalizeSlashCommands,
  parseSlashCommand,
  formatClaudeUsage,
  formatMcpServers
} = require('./slash-commands');
const { findSessionTranscript } = require('../services/claude-project-path-resolver');
const {
  CHAT_INTERACTION_MODES,
  CHAT_PERMISSION_MODES,
  normalizeChatInteractionMode,
  normalizeChatPermissionMode,
  permissionModeForDriver
} = require('./chat-permission-modes');
const { CHAT_HISTORY_EVENT_LIMIT } = require('./chat-history-limits');
const { CHAT_ANSWER_PLACEMENT_PROMPT } = require('./chat-answer-placement');

const PROVIDER_ID = 'claude';
const RAW_SOURCE = 'claude.sdk.message';
const PROVIDER_EVENT_CHANNEL = 'provider-event';
const DEFAULT_BINARY = 'claude';
const SDK_MODULE_ID = '@anthropic-ai/claude-agent-sdk';
const DEFAULT_STARTUP_PROBE_MS = 750;
const DEFAULT_AUTH_PROBE_MS = 15000;
const STOP_DRAIN_TIMEOUT_MS = 5000;
const DETAIL_MAX_LENGTH = 400;

/** Reasoning effort levels accepted by the SDK `effort` option. */
const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_LABELS = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
});

/** Claude tool name -> canonical item type. */
const CLAUDE_TOOL_ITEM_TYPE_MAP = Object.freeze({
  Bash: 'command_execution',
  BashOutput: 'command_execution',
  KillShell: 'command_execution',
  Edit: 'file_change',
  Write: 'file_change',
  MultiEdit: 'file_change',
  NotebookEdit: 'file_change',
  WebSearch: 'web_search',
  WebFetch: 'web_search',
  Task: 'collab_agent_tool_call',
  Agent: 'collab_agent_tool_call',
  TodoWrite: 'plan',
  ExitPlanMode: 'plan',
  // Newer Claude harnesses replace `TodoWrite` with this trio. Each call
  // carries one fragment of the checklist, so the full list is rebuilt from
  // the accumulator in `applyClaudeTaskResult` rather than from any one call.
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan'
});

/** Claude task tools whose results feed the checklist accumulator. */
const CLAUDE_TASK_TOOLS = Object.freeze(['TaskCreate', 'TaskUpdate', 'TaskList']);

/** Provider task status that ends a subagent -> canonical item status. */
const SUBAGENT_TERMINAL_STATUS = Object.freeze({
  completed: 'completed',
  failed: 'failed',
  killed: 'failed',
  stopped: 'failed'
});

/** Canonical item type -> human readable title. */
const ITEM_TITLE_MAP = Object.freeze({
  assistant_message: 'Assistant message',
  user_message: 'User message',
  reasoning: 'Reasoning',
  plan: 'Plan',
  command_execution: 'Ran command',
  file_change: 'File change',
  web_search: 'Web search',
  collab_agent_tool_call: 'Subagent task',
  context_compaction: 'Context compaction'
});

/** Streaming block types that carry assistant text. */
const TEXT_BLOCK_TYPES = Object.freeze(['text']);

/** Streaming block types that carry reasoning. */
const THINKING_BLOCK_TYPES = Object.freeze(['thinking', 'redacted_thinking']);

/** Streaming block types that carry a tool invocation. */
const TOOL_USE_BLOCK_TYPES = Object.freeze(['tool_use', 'server_tool_use', 'mcp_tool_use']);

/** Tool input fields scanned, in order, to build a one-line detail. */
const TOOL_DETAIL_FIELDS = Object.freeze([
  'command',
  'file_path',
  'pattern',
  'description',
  'prompt',
  'query',
  'url'
]);

/**
 * Build the child env for the agent: the user's environment, untouched.
 *
 * We add nothing and remove nothing, so the agent runs with the same
 * configuration it would have in one of the app's terminals (which spawn with
 * `env: { ...process.env, <CodeAgentSwarm vars> }`). Subscription, API key,
 * proxy or Bedrock — whatever the user set up for their CLI is what runs here.
 *
 * The only opt-in is `configDir`: we never set `CLAUDE_CONFIG_DIR` on our own
 * (it rescopes the keychain lookup and breaks the login), but a caller that
 * manages an isolated home can ask for it explicitly.
 *
 * @param {Object} [baseEnv] Env to derive from; never mutated.
 * @param {string} [configDir] Explicit Claude config dir, opt-in only.
 * @returns {Object} A fresh env object to hand to the SDK.
 */
function buildClaudeChildEnv(baseEnv, configDir) {
  const env = { ...(baseEnv || {}) };
  if (typeof configDir === 'string' && configDir) {
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

/**
 * Parse JSONL text into objects, silently skipping blank and corrupt lines.
 *
 * A transcript is read while the agent may still be appending to it, so the
 * last line is routinely half-written. That is history noise, not a failure.
 *
 * @param {string} text
 * @returns {Object[]}
 */
function parseJsonlLines(text) {
  const lines = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch (parseError) {
      // A truncated or malformed line is history noise, not a failure.
    }
  }
  return lines;
}

/**
 * Locate a subagent's transcript inside a session's `subagents/` tree.
 *
 * Claude Code writes one `agent-<agentId>.jsonl` per subagent plus a sibling
 * `agent-<agentId>.meta.json` describing it. Nested subagents live deeper in
 * the same tree, so the scan is recursive. A corrupt meta file is skipped, not
 * fatal: one unreadable sibling must never hide the subagent being opened.
 *
 * @param {string} subagentsDir Directory to scan.
 * @param {{toolUseId?: string, taskId?: string}} needles How to recognise it.
 *   `taskId` is the subagent's stable identity — it *is* the on-disk agentId,
 *   and it survives a revival, which mints a new `tool_use_id` for the same
 *   agent. `toolUseId` covers restored history rows, whose only handle is the
 *   original spawn call the meta file recorded.
 * @returns {{agentId: string, meta: Object, jsonlPath: string}|null}
 */
function resolveSubagentTranscript(subagentsDir, { toolUseId, taskId } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true, recursive: true });
  } catch (error) {
    return null;
  }

  for (const entry of entries) {
    if (!entry || !entry.isFile()) continue;
    const match = /^agent-(.+)\.meta\.json$/.exec(entry.name);
    if (!match) continue;

    const agentId = match[1];
    // Node's recursive readdir reports the containing directory in
    // `parentPath` (`path` on older majors); either way it is absolute here.
    const dir = entry.parentPath || entry.path || subagentsDir;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
    } catch (error) {
      continue;
    }
    if (!meta || typeof meta !== 'object') continue;
    const matches = (toolUseId && meta.toolUseId === toolUseId)
      || (taskId && agentId === taskId)
      || (toolUseId && agentId === toolUseId);
    if (!matches) continue;

    return { agentId, meta, jsonlPath: path.join(dir, `agent-${agentId}.jsonl`) };
  }

  return null;
}

/**
 * Read a conversation's transcript from disk as parsed JSONL lines.
 *
 * The SDK resumes a session but never re-emits its past messages, so the only
 * source for a resumed conversation's history is Claude's own
 * `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl` file.
 *
 * Never throws: a missing, unreadable or partly corrupt transcript degrades to
 * `null` / the lines that did parse, and the session still resumes.
 *
 * @param {string} sessionId
 * @param {string} [configDir] Explicit Claude config dir, when the caller runs
 *   against an isolated home; defaults to Claude's own `~/.claude/projects`.
 * @returns {Object[]|null} Parsed lines, or null when there is no transcript.
 */
function defaultLoadTranscript(sessionId, configDir) {
  try {
    const projectsDir = configDir ? path.join(configDir, 'projects') : undefined;
    const transcriptPath = findSessionTranscript(sessionId, projectsDir);
    if (!transcriptPath) return null;

    return parseJsonlLines(fs.readFileSync(transcriptPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

/**
 * Fresh state for {@link mapClaudeSdkEvent}.
 *
 * `blocks` maps a streaming content-block index to `{kind, itemId}`; `tools`
 * maps an in-flight `tool_use` id to `{itemType, name, input}` so a later
 * `tool_result` can be correlated back to the item it completes and can read
 * the arguments the call was made with.
 *
 * `tasks` accumulates the `TaskCreate`/`TaskUpdate`/`TaskList` checklist. It
 * deliberately survives turn boundaries: the list is conversation-scoped, so
 * follow-up messages must keep seeing the steps created earlier.
 *
 * `subagents` maps a live subagent's itemId to `{taskId}` and `subagentsByTask`
 * is its reverse index: the SDK addresses a subagent by `task_id` in
 * `task_updated` / `task_notification` / `background_tasks_changed`, but the
 * timeline row it has to close is keyed by the `tool_use_id` that opened it.
 * They also survive turn boundaries, because a backgrounded subagent outlives
 * the turn that launched it.
 *
 * `subagentItemsByTask` maps a task id to the itemId its row was FIRST opened
 * with, and unlike the two maps above it is never deleted. That persistence is
 * what lets a revived subagent — the SDK re-announces a finished one under a
 * brand new `tool_use_id` when the parent talks to it again — reopen its
 * original row instead of adding a second one.
 *
 * @returns {{turnId: null, currentMessageId: null, blocks: Object, tools: Object,
 *   tasks: Object[], subagents: Object, subagentsByTask: Object,
 *   subagentItemsByTask: Object}}
 */
function createInitialMapperState() {
  return {
    turnId: null,
    currentMessageId: null,
    blocks: {},
    tools: {},
    tasks: [],
    subagents: {},
    subagentsByTask: {},
    subagentItemsByTask: {}
  };
}

/**
 * Drives a `claude` session through the Claude Agent SDK and emits canonical
 * provider events.
 *
 * All events are emitted on the `'provider-event'` channel. The driver never
 * emits `'error'` on the EventEmitter: SDK and transport failures surface as
 * canonical `runtime.error` / `session.exited` events instead, so a missing
 * listener can never crash the host process.
 *
 * @fires ClaudeAgentSdkDriver#provider-event
 */
class ClaudeAgentSdkDriver extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.binaryPath='claude'] Claude executable to drive.
   * @param {Object} [options.env] Extra env vars merged over `process.env`.
   * @param {string} [options.configDir] Explicit `CLAUDE_CONFIG_DIR`; leaving it
   *   unset is what keeps the subscription login working.
   * @param {Function} [options.queryFn] Injectable SDK `query`, for tests.
   * @param {Function} [options.loadQueryFn] Injectable lazy SDK loader, for tests.
   * @param {number} [options.startupProbeMs=750] How long `startSession`
   *   watches the fresh stream for an immediate spawn failure before
   *   declaring the session ready.
   * @param {number} [options.authProbeMs=15000] Maximum time to wait for the
   *   SDK's local initialization result. It verifies the existing CLI login
   *   without sending a user prompt or making a model request.
   * @param {(sessionId: string) => (Object[]|null)} [options.loadTranscript]
   *   Reads a conversation's transcript lines; injectable for tests.
   */
  constructor({
    binaryPath = DEFAULT_BINARY,
    env,
    configDir,
    queryFn,
    loadQueryFn = loadClaudeQueryFn,
    startupProbeMs = DEFAULT_STARTUP_PROBE_MS,
    authProbeMs = DEFAULT_AUTH_PROBE_MS,
    loadTranscript
  } = {}) {
    super();
    this._binaryPath = binaryPath;
    this._env = env || {};
    this._configDir = configDir;
    this._queryFn = queryFn || null;
    this._loadQueryFn = loadQueryFn;
    this._startupProbeMs = startupProbeMs;
    this._authProbeMs = authProbeMs;
    this._loadTranscript = loadTranscript
      || ((sessionId) => defaultLoadTranscript(sessionId, this._configDir));

    this._query = null;
    this._abortController = null;
    this._promptQueue = [];
    this._promptWaiter = null;
    this._promptClosed = false;
    this._state = 'idle';
    this._threadId = null;
    // The SELECTABLE model id (`ModelInfo.value`, e.g. 'claude-fable-5[1m]') —
    // the only id the picker and the resumed CLI command understand.
    this._model = null;
    // The canonical wire id the provider resolved that alias to (e.g.
    // 'claude-fable-5'). Reported by `system:init`, never selectable.
    this._resolvedModel = null;
    /** @type {Map<string, string>} wire id -> selectable alias, from the catalog. */
    this._modelAliasByResolvedId = new Map();
    this._effort = null;
    this._permissionMode = 'approval-required';
    this._allowBypassPermissions = false;
    this._interactionMode = CHAT_INTERACTION_MODES.DEFAULT;
    this._resumed = false;
    this._nativePermissionObserved = false;
    this._activeTurnId = null;
    this._turnCounter = 0;
    this._mapperState = createInitialMapperState();
    this._streamDone = null;
    this._stopping = false;
    this._pendingApprovals = new Map();
    this._pendingQuestions = new Map();
  }

  /** @returns {string} 'idle'|'starting'|'ready'|'running'|'stopped'|'error'. */
  get state() {
    return this._state;
  }

  /** @returns {string|null} Claude session id once the session is started. */
  get threadId() {
    return this._threadId;
  }

  /**
   * Open the SDK query and probe it briefly for an immediate failure.
   *
   * `threadId` is normally `null` here: Claude mints the session id when the
   * first turn is sent, so it arrives via the `thread.started` event (and the
   * {@link ClaudeAgentSdkDriver#threadId} getter) during that turn.
   *
   * @param {Object} [options]
   * @param {string} [options.cwd] Working directory for the Claude session.
   * @param {string} [options.model] Model id; omitted lets Claude decide.
   * @param {string} [options.effort] One of {@link CLAUDE_EFFORT_LEVELS}.
   * @param {string} [options.resumeSessionId] Existing Claude session id to
   *   resume; the conversation continues under that SAME id.
   * @returns {Promise<{threadId: string|null, model: string|undefined, cwd: string,
   *   historyEvents: Object[]}>} `historyEvents` carries a resumed conversation's
   *   past messages as fully-wrapped canonical events (empty when not resuming).
   *   It travels in the START RESULT instead of the `provider-event` stream
   *   because the IPC layer only maps sessionId -> WebContents AFTER
   *   `startSession` resolves, so anything emitted here had no owner yet and was
   *   silently dropped before reaching the renderer.
   */
  async startSession({
    cwd,
    model,
    effort,
    autoApprove = false,
    permissionMode,
    interactionMode,
    toolsDisabled = false,
    ephemeral = false,
    resumeSessionId
  } = {}) {
    if (this._state !== 'idle') {
      throw new Error('Claude session already started');
    }
    this._setState('starting');

    const resolvedCwd = cwd || process.cwd();
    try {
      const queryFn = this._queryFn || await this._loadQueryFn();
      if (this._stopping || this._state === 'stopped') {
        throw new Error('Claude session start was cancelled');
      }
      const validEffort = this._resolveEffort(effort);
      this._model = model || null;
      this._resolvedModel = null;
      this._effort = validEffort || null;
      this._permissionMode = normalizeChatPermissionMode(
        autoApprove ? 'full-access' : permissionMode
      );
      this._allowBypassPermissions = (
        this._permissionMode === CHAT_PERMISSION_MODES.FULL_ACCESS
      );
      this._interactionMode = normalizeChatInteractionMode(interactionMode);
      this._resumed = Boolean(resumeSessionId);

      // Claude keeps the same session id across a resume (no fork), so the
      // thread identity is known here instead of arriving with the first turn.
      if (resumeSessionId) this._threadId = resumeSessionId;

      this._abortController = new AbortController();
      const nativePermission = permissionModeForDriver(
        'claude',
        this._permissionMode
      );
      // On Windows the SDK can only spawn a real .exe: `claude` installs as an
      // npm shim (extensionless script + .cmd) and the SDK dies with "native
      // binary not found" / EINVAL. Falling back to the SDK's own bundled platform
      // binary boots fine from source — but inside a PACKAGED app the SDK resolves
      // that binary to `resources/app.asar/...`, and nothing can be spawned from
      // inside an asar ("exists but failed to launch"). unpackedClaudeBinary()
      // hands back the runnable copy electron-builder left next to it.
      const executablePath = process.platform === 'win32' && !isNativeExe(this._binaryPath)
        ? unpackedClaudeBinary()
        : this._binaryPath;
      const options = {
        cwd: resolvedCwd,
        env: buildClaudeChildEnv(
          mergeSessionCommunicationEnv(process.env, this._env),
          this._configDir
        ),
        settingSources: ['user', 'project', 'local'],
        ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: CHAT_ANSWER_PLACEMENT_PROMPT
        },
        includePartialMessages: true,
        ...(toolsDisabled ? {
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: !ephemeral
        } : {}),
        permissionMode: this._interactionMode === CHAT_INTERACTION_MODES.PLAN
          ? 'plan'
          : nativePermission.permissionMode,
        allowDangerouslySkipPermissions: nativePermission.allowDangerouslySkipPermissions,
        canUseTool: (toolName, input, permissionOptions) => (
          this._handlePermissionRequest(toolName, input, permissionOptions)
        ),
        abortController: this._abortController,
        ...(model ? { model } : {}),
        ...(validEffort ? { effort: validEffort } : {}),
        ...(resumeSessionId ? { resume: resumeSessionId } : {})
      };

      this._query = queryFn({ prompt: this._promptIterable(), options });
      this._streamDone = this._consumeStream();

      // Claude's SDK exposes the same initialization-only account probe used
      // by the provider runtime. The prompt iterable has not yielded anything yet, so this
      // verifies the user's existing CLI auth without sending a prompt or
      // starting a billable model turn. Older SDK/test doubles do not expose
      // this method and retain the bounded stream probe below.
      if (typeof this._query.initializationResult === 'function') {
        await waitBounded(this._query.initializationResult(), this._authProbeMs);
      }

      // Claude mints the session id only when the first turn is sent, so
      // there is no init handshake to wait for here. The probe just gives an
      // immediate spawn failure (bad binary path, broken SDK) a chance to
      // surface before the session is declared ready.
      await waitBounded(this._streamDone, this._startupProbeMs);
      if (this._state === 'error') {
        // The consume loop already emitted the detailed runtime.error.
        throw new Error('Claude session failed to start');
      }
      if (this._stopping || this._state === 'stopped') {
        throw new Error('Claude session start was cancelled');
      }

      const historyEvents = resumeSessionId
        ? this._collectTranscriptHistory(resumeSessionId)
        : [];

      this._setState('ready');
      const reportedModel = resumeSessionId
        ? (this._model || model)
        : (model || this._model);
      return {
        threadId: this._threadId,
        model: reportedModel || undefined,
        cwd: resolvedCwd,
        historyEvents,
        ...(resumeSessionId && this._effort ? { effort: this._effort } : {}),
        ...(this._nativePermissionObserved
          ? {
              permissionMode: this._permissionMode,
              interactionMode: this._interactionMode
            }
          : {})
      };
    } catch (error) {
      if (!this._stopping) this._failStart(error);
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
    const canSend = this._query && (this._state === 'ready' || this._state === 'running');
    if (!canSend) {
      throw new Error('Claude session not started');
    }

    // Claude's stream has no native turn boundary, so the driver owns turn
    // identity and stamps it onto every event mapped until the result arrives.
    // Sending while that turn is running is Claude SDK steering: enqueue the
    // new user input into the same query and retain the original turn boundary.
    const steeringTurnId = this._state === 'running' ? this._activeTurnId : null;
    const turnId = steeringTurnId || `turn-${++this._turnCounter}`;
    if (!steeringTurnId) {
      this._activeTurnId = turnId;
      this._mapperState = { ...this._mapperState, turnId };
      this._setState('running');
      this._emitProviderEvent({ type: 'turn.started', turnId, payload: {} });
    }

    const prompt = promptWithFileReferences(text, attachments);
    const content = [
      ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ...attachments
        .filter((attachment) => attachment.type === 'image')
        .map((attachment) => {
          const decoded = splitDataUrl(attachment.dataUrl);
          return decoded ? {
            type: 'image',
            source: {
              type: 'base64',
              media_type: decoded.mimeType,
              data: decoded.base64
            }
          } : null;
        })
        .filter(Boolean)
    ];

    this._pushPrompt({
      type: 'user',
      session_id: this._threadId || '',
      parent_tool_use_id: null,
      message: { role: 'user', content }
    });

    return { turnId, ...(steeringTurnId ? { steered: true } : {}) };
  }

  /**
   * Ask Claude to interrupt the active turn. No-op when no turn is running.
   * @returns {Promise<void>}
   */
  async interruptTurn() {
    if (!this._activeTurnId || !this._query) return undefined;
    try {
      await this._query.interrupt();
    } catch (error) {
      this._emitProviderEvent({
        type: 'runtime.warning',
        payload: { message: `Claude interrupt failed: ${error.message}` }
      });
    }
    return undefined;
  }

  /**
   * List the models the current Claude account can use.
   * @returns {Promise<Object[]>} Model descriptors.
   */
  async listModels() {
    if (!this._query) {
      throw new Error('Claude session not started');
    }
    const models = await this._query.supportedModels();
    this._rememberModelAliases(models);
    return (Array.isArray(models) ? models : []).map((model) => {
      // Claude Agent SDK's ModelInfo uses `value` as the selectable id. Older
      // SDK builds and test doubles used `model`/`id`, so retain those as
      // compatibility fallbacks instead of silently returning an empty list.
      const id = model.value || model.model || model.id;
      const effortLevels = Array.isArray(model.supportedEffortLevels)
        ? model.supportedEffortLevels.filter((level) => CLAUDE_EFFORT_LEVELS.includes(level))
        : [];
      // Claude Code uses High as its built-in reasoning default (the same
      // default exposed by the provider). Advertise it explicitly so a fresh Chat has a
      // real selected value instead of a dead "Reasoning" button.
      const defaultEffort = effortLevels.includes('high')
        ? 'high'
        : effortLevels[0];
      const optionDescriptors = model.supportsEffort && effortLevels.length
        ? [{
            id: 'effort',
            label: 'Reasoning',
            type: 'select',
            options: effortLevels.map((level) => ({
              id: level,
              label: EFFORT_LABELS[level] || level,
              ...(level === defaultEffort ? { isDefault: true } : {})
            })),
            currentValue: this._effort || defaultEffort
          }]
        : [];
      return {
        id,
        name: model.displayName || model.name || id,
        ...(model.description ? { description: model.description } : {}),
        // Published so the renderer can map a provider-reported wire id back
        // onto this row instead of falling through to "no model selected".
        ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
        current: this._coversModel(id, model.resolvedModel),
        capabilities: { optionDescriptors }
      };
    }).filter((model) => model.id);
  }

  /**
   * Index the catalog's alias -> wire id pairs. `system:init` reports the WIRE
   * id, so without this map an explicit selection like 'claude-fable-5[1m]'
   * would be replaced by 'claude-fable-5', which no picker row matches.
   * @param {Array<Object>} models Raw SDK `ModelInfo` rows.
   */
  _rememberModelAliases(models) {
    for (const model of Array.isArray(models) ? models : []) {
      const alias = model && (model.value || model.model || model.id);
      if (alias && model.resolvedModel) {
        this._modelAliasByResolvedId.set(model.resolvedModel, alias);
      }
    }
  }

  /** Does this catalog row represent the model the session is running? */
  _coversModel(alias, resolvedModel) {
    if (!this._model && !this._resolvedModel) return false;
    if (alias === this._model) return true;
    if (!resolvedModel) return false;
    return resolvedModel === this._model || resolvedModel === this._resolvedModel;
  }

  /** Commands exposed by the live Claude Code process. */
  async listCommands() {
    if (!this._query) throw new Error('Claude session not started');
    const commands = typeof this._query.supportedCommands === 'function'
      ? await this._query.supportedCommands()
      : [];
    const normalized = normalizeSlashCommands(commands, 'claude');
    const names = new Set(normalized.map((command) => command.name));
    if (typeof this._query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function'
        && !names.has('usage')) {
      normalized.push({
        name: 'usage',
        description: 'Show session usage and plan limits',
        argumentHint: '',
        aliases: [],
        source: 'claude'
      });
    }
    if (typeof this._query.mcpServerStatus === 'function' && !names.has('mcp')) {
      normalized.push({
        name: 'mcp',
        description: 'Show configured MCP servers and connection status',
        argumentHint: '',
        aliases: [],
        source: 'claude'
      });
    }
    return normalized;
  }

  /**
   * Execute commands that have a structured SDK API without spending a model
   * turn. Other Claude commands fall through to the normal prompt stream,
   * where Claude Code handles them and emits `local_command_output`.
   */
  async runCommand(commandLine) {
    if (!this._query) throw new Error('Claude session not started');
    const command = parseSlashCommand(commandLine);
    if (!command) return { handled: false };
    if (
      command.name === 'usage'
      && typeof this._query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function'
    ) {
      const usage = await this._query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return { handled: true, output: formatClaudeUsage(usage) };
    }
    if (command.name === 'mcp' && typeof this._query.mcpServerStatus === 'function') {
      const servers = await this._query.mcpServerStatus();
      return { handled: true, output: formatMcpServers(servers) };
    }
    return { handled: false };
  }

  /** Change a setting supported by the long-lived SDK query. */
  async setConfigOption(configId, value) {
    if (!this._query) throw new Error('Claude session not started');
    if (configId === 'permissionMode' && typeof this._query.setPermissionMode === 'function') {
      const normalized = normalizeChatPermissionMode(value);
      if (
        normalized === CHAT_PERMISSION_MODES.FULL_ACCESS
        && !this._allowBypassPermissions
      ) {
        throw new Error(
          'Bypass permissions must be enabled when the Claude session starts'
        );
      }
      this._permissionMode = normalized;
      if (this._interactionMode !== CHAT_INTERACTION_MODES.PLAN) {
        const native = permissionModeForDriver('claude', normalized);
        await this._query.setPermissionMode(native.permissionMode);
      }
      return { changed: true, configId, value: normalized };
    }
    if (configId === 'interactionMode' && typeof this._query.setPermissionMode === 'function') {
      const normalized = normalizeChatInteractionMode(value);
      this._interactionMode = normalized;
      const native = normalized === CHAT_INTERACTION_MODES.PLAN
        ? 'plan'
        : permissionModeForDriver('claude', this._permissionMode).permissionMode;
      await this._query.setPermissionMode(native);
      return { changed: true, configId, value: normalized };
    }
    if (configId === 'model' && typeof this._query.setModel === 'function') {
      await this._query.setModel(value);
      this._model = value;
      // The previously resolved wire id belonged to the old alias; the next
      // `system:init` reports the new one.
      this._resolvedModel = null;
      return { changed: true, configId, value };
    }
    if (configId === 'effort' && typeof this._query.applyFlagSettings === 'function') {
      const effort = this._resolveEffort(value);
      if (!effort) throw new Error(`Unsupported Claude effort level: ${value}`);
      await this._query.applyFlagSettings({ effortLevel: effort });
      this._effort = effort;
      return { changed: true, configId, value: effort };
    }
    throw new Error(`Unsupported Claude configuration option: ${configId}`);
  }

  /** Resolve one permission callback parked by `_handlePermissionRequest`. */
  async respondToRequest({ requestId, decision } = {}) {
    const key = String(requestId || '');
    const pending = this._pendingApprovals.get(key);
    if (!pending) throw new Error('Unknown Claude permission request');
    this._pendingApprovals.delete(key);
    pending.detachAbort();

    const allowed = decision === 'allow_once'
      || decision === 'allow_always'
      || decision === 'allow_session';
    if (allowed) {
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(decision !== 'allow_once' && pending.suggestions.length
          ? { updatedPermissions: pending.suggestions }
          : {})
      });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: 'Rejected by user',
        interrupt: false
      });
    }
    this._emitProviderEvent({
      type: 'request.resolved',
      requestId: key,
      itemId: pending.toolUseId || undefined,
      turnId: this._activeTurnId || undefined,
      payload: { requestType: pending.requestType, decision }
    });
  }

  /**
   * Resolve one `AskUserQuestion` callback parked by `_handleQuestionRequest`.
   *
   * The SDK returns the answers to the model through `updatedInput`: `answers`
   * is keyed by the question TEXT (multi-select values comma-joined) and the
   * optional comment travels in `annotations[questionText].notes`.
   *
   * @param {Object} [response]
   * @param {string} response.requestId
   * @param {'submit'|'decline'} response.decision
   * @param {Object<string, {values: string[], note?: string}>} [response.answers]
   */
  async respondToQuestion({ requestId, decision, answers } = {}) {
    const key = String(requestId || '');
    const pending = this._pendingQuestions.get(key);
    if (!pending) throw new Error('Unknown Claude question request');
    this._pendingQuestions.delete(key);
    pending.detachAbort();

    if (decision !== 'submit') {
      pending.resolve({
        behavior: 'deny',
        message: 'User declined to answer',
        interrupt: false
      });
      this._emitProviderEvent({
        type: 'question.resolved',
        requestId: key,
        itemId: pending.toolUseId || undefined,
        turnId: this._activeTurnId || undefined,
        payload: { requestType: 'tool_user_input', decision: 'declined' }
      });
      return;
    }

    const answersByKey = {};
    const annotations = {};
    for (const question of pending.questions) {
      const entry = answers ? answers[question.id] : undefined;
      const values = Array.isArray(entry?.values)
        ? entry.values.filter((value) => typeof value === 'string' && value)
        : [];
      if (values.length) answersByKey[question.id] = values.join(', ');
      const note = typeof entry?.note === 'string' && entry.note.trim()
        ? entry.note.trim()
        : '';
      if (note) annotations[question.id] = { notes: note };
    }

    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        answers: answersByKey,
        ...(Object.keys(annotations).length ? { annotations } : {})
      }
    });
    this._emitProviderEvent({
      type: 'question.resolved',
      requestId: key,
      itemId: pending.toolUseId || undefined,
      turnId: this._activeTurnId || undefined,
      payload: { requestType: 'tool_user_input', decision: 'submitted', answers }
    });
  }

  /**
   * Close the prompt stream and abort the SDK query. Idempotent.
   * @returns {Promise<void>}
   */
  async stopSession() {
    if (this._state === 'stopped') return;
    if (!this._query) {
      if (this._state === 'starting') {
        this._stopping = true;
        this._closePrompt();
        try {
          if (this._abortController) this._abortController.abort();
        } catch (_) {
          // The not-yet-owned query is already going away.
        }
        this._setState('stopped');
      }
      return;
    }

    this._stopping = true;
    this._denyAllPendingApprovals('Session stopped');
    this._cancelAllPendingQuestions('Session stopped');
    this._closePrompt();
    try {
      this._abortController.abort();
    } catch (error) {
      // Already settled; the stream is going away either way.
    }

    await waitBounded(this._streamDone, STOP_DRAIN_TIMEOUT_MS);

    this._setState('stopped');
    this._emitProviderEvent({
      type: 'session.exited',
      payload: { exitKind: 'graceful', reason: 'Session stopped' }
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Turn Claude's permission callback into a canonical request and leave the
   * callback promise pending until the user acts in the chat.
   */
  _handlePermissionRequest(toolName, input, options = {}) {
    // A question is structured user input, not a permission: it must never be
    // auto-approved nor rendered as an Allow/Reject row.
    if (toolName === 'AskUserQuestion') return this._handleQuestionRequest(input, options);

    const requestId = String(options.requestId || options.toolUseID || `permission-${Date.now()}`);
    const requestType = classifyClaudeRequestType(toolName);
    const suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];

    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this._pendingApprovals.has(requestId)) return;
        this._pendingApprovals.delete(requestId);
        resolve({ behavior: 'deny', message: 'Permission request cancelled', interrupt: false });
        this._emitProviderEvent({
          type: 'request.resolved',
          requestId,
          itemId: options.toolUseID || undefined,
          turnId: this._activeTurnId || undefined,
          payload: { requestType, decision: 'cancelled' }
        });
      };
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      const detachAbort = () => {
        if (options.signal && typeof options.signal.removeEventListener === 'function') {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      this._pendingApprovals.set(requestId, {
        resolve,
        detachAbort,
        input,
        suggestions,
        requestType,
        toolUseId: options.toolUseID
      });
      this._emitProviderEvent({
        type: 'request.opened',
        requestId,
        itemId: options.toolUseID || undefined,
        turnId: this._activeTurnId || undefined,
        payload: {
          requestType,
          detail: options.title
            || options.description
            || claudeToolDetail(toolName, input)
            || `${toolName} requires permission`,
          args: {
            toolName,
            input,
            ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
            ...(options.decisionReason ? { decisionReason: options.decisionReason } : {})
          },
          options: [
            { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            ...(suggestions.length
              ? [{ id: 'allow_always', name: 'Allow for session', kind: 'allow_always' }]
              : []),
            { id: 'reject_once', name: 'Reject', kind: 'reject_once' }
          ]
        }
      });
    });
  }

  /**
   * Turn an `AskUserQuestion` tool call into a canonical question and leave the
   * `canUseTool` promise pending until the user answers in the chat.
   *
   * @param {Object} input Native `AskUserQuestion` input.
   * @param {Object} [options] `canUseTool` options.
   * @returns {Promise<Object>} The `canUseTool` result.
   */
  _handleQuestionRequest(input, options = {}) {
    const requestId = String(options.requestId || options.toolUseID || `question-${Date.now()}`);
    const questions = mapClaudeQuestions(input?.questions);

    if (questions.length === 0) {
      this._emitProviderEvent({
        type: 'runtime.warning',
        payload: { message: 'Claude asked a question without any content' }
      });
      return Promise.resolve({
        behavior: 'deny',
        message: 'Malformed question',
        interrupt: false
      });
    }

    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this._pendingQuestions.has(requestId)) return;
        this._pendingQuestions.delete(requestId);
        resolve({ behavior: 'deny', message: 'Question cancelled', interrupt: false });
        this._emitProviderEvent({
          type: 'question.resolved',
          requestId,
          itemId: options.toolUseID || undefined,
          turnId: this._activeTurnId || undefined,
          payload: { requestType: 'tool_user_input', decision: 'cancelled' }
        });
      };
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      const detachAbort = () => {
        if (options.signal && typeof options.signal.removeEventListener === 'function') {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      this._pendingQuestions.set(requestId, {
        resolve,
        detachAbort,
        input,
        questions,
        toolUseId: options.toolUseID
      });
      this._emitProviderEvent({
        type: 'question.opened',
        requestId,
        itemId: options.toolUseID || undefined,
        turnId: this._activeTurnId || undefined,
        payload: { requestType: 'tool_user_input', questions }
      });
    });
  }

  /** Cancel every outstanding question when the session goes away. */
  _cancelAllPendingQuestions(message) {
    for (const [requestId, pending] of this._pendingQuestions) {
      pending.detachAbort();
      pending.resolve({ behavior: 'deny', message, interrupt: false });
      this._emitProviderEvent({
        type: 'question.resolved',
        requestId,
        itemId: pending.toolUseId || undefined,
        turnId: this._activeTurnId || undefined,
        payload: { requestType: 'tool_user_input', decision: 'cancelled' }
      });
    }
    this._pendingQuestions.clear();
  }

  _denyAllPendingApprovals(message) {
    for (const [requestId, pending] of this._pendingApprovals) {
      pending.detachAbort();
      pending.resolve({ behavior: 'deny', message, interrupt: false });
      this._emitProviderEvent({
        type: 'request.resolved',
        requestId,
        itemId: pending.toolUseId || undefined,
        turnId: this._activeTurnId || undefined,
        payload: { requestType: pending.requestType, decision: 'cancelled' }
      });
    }
    this._pendingApprovals.clear();
  }

  /**
   * Read one subagent's own conversation from disk.
   *
   * Claude Code keeps a full transcript per delegated agent next to the parent
   * session's, so a subagent's timeline can be shown without asking the parent
   * anything. The file grows while the subagent runs, so the caller polls with
   * the `known` size/mtime it last saw and gets `unchanged: true` when nothing
   * moved — cheaper than re-mapping the whole transcript every tick.
   *
   * @param {{toolUseId: string, taskId?: string,
   *   known?: {size: number, mtimeMs: number}}} params `toolUseId` is the
   *   parent timeline row's item id; `taskId` is the subagent's stable
   *   identity, which keeps pointing at the same transcript across revivals.
   * @returns {Promise<Object>} `{agentId, agentType, description, spawnDepth,
   *   running, talk, events, fileSize, fileMtimeMs}`, or `{..., unchanged:
   *   true}`. `talk` tells the UI how a message reaches this subagent.
   */
  async openSubagentConversation({ toolUseId, taskId, known } = {}) {
    if (!this._threadId) {
      throw new Error('This conversation has no on-disk transcript yet');
    }

    const notFound = () => new Error('Subagent conversation not found on disk');
    const projectsDir = this._configDir ? path.join(this._configDir, 'projects') : undefined;
    const transcriptPath = findSessionTranscript(this._threadId, projectsDir);
    if (!transcriptPath) throw notFound();

    const subagentsDir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    const resolved = resolveSubagentTranscript(subagentsDir, { toolUseId, taskId });
    if (!resolved) throw notFound();

    let stat;
    try {
      stat = fs.statSync(resolved.jsonlPath);
    } catch (error) {
      throw notFound();
    }

    // The mapper tracks every subagent that is still live, so "is it still
    // running" needs no extra probe. The task id is checked first: a revived
    // subagent is registered under its new tool_use id, and only its task id
    // still matches the row the caller is asking about.
    const mapperState = this._mapperState;
    const running = Boolean(
      mapperState
      && ((taskId && mapperState.subagentsByTask && mapperState.subagentsByTask[taskId])
        || (mapperState.subagents && mapperState.subagents[toolUseId]))
    );
    const identity = {
      agentId: resolved.agentId,
      agentType: resolved.meta.agentType,
      description: resolved.meta.description
    };

    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
      return { ...identity, running, talk: 'relay', unchanged: true };
    }

    const lines = parseJsonlLines(fs.readFileSync(resolved.jsonlPath, 'utf8'));
    const events = mapClaudeTranscriptToEvents(lines, { includeSidechain: true })
      .map((bare) => createProviderEvent(bare, {
        provider: PROVIDER_ID,
        threadId: this._threadId || undefined
      }));

    return {
      ...identity,
      spawnDepth: resolved.meta.spawnDepth,
      running,
      talk: 'relay',
      events,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs
    };
  }

  /**
   * Deliver a message to a delegated agent through its parent.
   *
   * The SDK gives no direct channel to a subagent, but the parent holds a
   * `SendMessage` tool, so the relay is an ordinary turn asking it to pass the
   * text along verbatim.
   *
   * @param {{taskId?: string, agentId?: string, agentType?: string,
   *   text: string}} params
   * @returns {Promise<Object>} The parent turn's result.
   */
  async sendToSubagentConversation({ taskId, agentId, agentType, text } = {}) {
    const target = agentId || taskId;
    const relay = `[Relay to subagent] Deliver the following message VERBATIM to your subagent "${target}"${agentType ? ` (${agentType})` : ''} using the SendMessage tool, then briefly confirm delivery. Do not act on the message yourself.\n\n${text}`;
    return this.sendTurn({ text: relay });
  }

  /**
   * Build a resumed conversation's past messages as historical items.
   *
   * The SDK loads the conversation server-side but streams nothing that already
   * happened, so the timeline is rebuilt from the transcript on disk.
   *
   * Events are returned fully wrapped (the shape the `provider-event` channel
   * carries) rather than emitted: the caller hands them to the renderer in the
   * start result, which is the only path that has an owner at this point.
   *
   * @param {string} sessionId The resumed Claude session id.
   * @returns {Object[]} Wrapped canonical events, oldest first.
   */
  _collectTranscriptHistory(sessionId) {
    const lines = this._loadTranscript(sessionId);
    const events = mapClaudeTranscriptToEvents(lines || [], {
      maxEvents: CHAT_HISTORY_EVENT_LIMIT
    });
    return events.map((bare) => createProviderEvent(bare, {
      provider: PROVIDER_ID,
      threadId: this._threadId || undefined,
      executionOrigin: 'main'
    }));
  }

  /**
   * Validate the requested effort level, warning about unknown ones.
   * @param {string} [effort]
   * @returns {string|undefined} The effort to forward, if any.
   */
  _resolveEffort(effort) {
    if (effort === undefined) return undefined;
    if (CLAUDE_EFFORT_LEVELS.includes(effort)) return effort;
    this._emitProviderEvent({
      type: 'runtime.warning',
      payload: { message: `Ignoring unknown Claude effort level: ${effort}` }
    });
    return undefined;
  }

  /**
   * Report a startup failure and tear the query down.
   * @param {Error} error
   */
  _failStart(error) {
    this._emitRuntimeError(error.message, 'transport_error');
    this._setState('error');
    try {
      if (this._abortController) this._abortController.abort();
    } catch (abortError) {
      // Nothing else to do: the session is already failed.
    }
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

  // ------------------------------------------------------------ prompt stream

  /**
   * The async iterable handed to the SDK as `prompt`; yields queued user
   * messages and ends once {@link ClaudeAgentSdkDriver#_closePrompt} ran.
   * @returns {AsyncGenerator<Object>}
   */
  async *_promptIterable() {
    for (;;) {
      if (this._promptQueue.length > 0) {
        yield this._promptQueue.shift();
        continue;
      }
      if (this._promptClosed) return;
      await new Promise((resolve) => {
        this._promptWaiter = resolve;
      });
      this._promptWaiter = null;
    }
  }

  /**
   * Queue one SDK user message and wake the prompt iterable.
   * @param {Object} message
   */
  _pushPrompt(message) {
    this._promptQueue.push(message);
    if (this._promptWaiter) this._promptWaiter();
  }

  /** End the prompt iterable so the SDK can finish. */
  _closePrompt() {
    this._promptClosed = true;
    if (this._promptWaiter) this._promptWaiter();
  }

  // ------------------------------------------------------------ message stream

  /**
   * Drain the SDK message iterator, mapping every message to canonical events.
   * Never rejects: failures are reported as canonical events.
   * @returns {Promise<void>}
   */
  async _consumeStream() {
    try {
      for await (const message of this._query) {
        this._applyBookkeeping(message);
        const { events, state } = mapClaudeSdkEvent(message, this._mapperState);
        this._mapperState = state;
        for (const bare of events) {
          this._emitProviderEvent(bare);
        }
        if (message && message.type === 'result') await this._emitContextUsage();
      }
      this._activeTurnId = null;
      if (this._stopping || this._state === 'error') return;

      this._state = 'stopped';
      this._emitProviderEvent({
        type: 'session.exited',
        payload: { exitKind: 'graceful', reason: 'claude agent stream ended' }
      });
    } catch (error) {
      this._activeTurnId = null;
      if (this._stopping || isAbortError(error)) return;

      this._emitRuntimeError(error.message, 'transport_error');
      this._state = 'error';
      this._emitProviderEvent({
        type: 'session.exited',
        payload: { exitKind: 'error', reason: error.message }
      });
    }
  }

  /**
   * Report how full the context window is, straight from the SDK.
   *
   * `result.usage` looks like it could answer this and cannot: it ACCUMULATES
   * every request the turn made, so a turn with six tool round-trips counts the
   * same cached prefix six times. A real session read 348K that way against a
   * window `/context` put at 58.8K. `getContextUsage()` is the exact data
   * behind `/context`, so Chat and the TUI now agree.
   *
   * Never throws: a usage read must not take a completed turn down with it.
   * @returns {Promise<void>}
   */
  async _emitContextUsage() {
    if (!this._query || typeof this._query.getContextUsage !== 'function') return;
    let context = null;
    try {
      context = await this._query.getContextUsage();
    } catch (error) {
      return;
    }
    const usage = normalizeClaudeContextUsage(context);
    if (!usage) return;
    this._emitProviderEvent({
      type: 'thread.token-usage.updated',
      payload: { usage }
    });
  }

  /**
   * Adopt the model reported by `system:init` WITHOUT losing the user's
   * selection. The SDK reports the canonical wire id it resolved the selected
   * alias to (its own docs: "`resolvedModel` lets hosts match a persisted
   * explicit id against the alias row that covers it"), so overwriting
   * `_model` with it left the picker, the reasoning descriptors and the
   * Chat -> Terminal handoff pointing at an id no catalog row matches.
   *
   * @param {string|undefined} reported `system:init`'s `model`.
   */
  _applyReportedModel(reported) {
    if (!reported) return;
    this._resolvedModel = reported;
    const alias = this._modelAliasByResolvedId.get(reported);
    if (alias) {
      this._model = alias;
      return;
    }
    // No catalog yet (init can beat the first `listModels`) or the provider
    // reported something the catalog does not cover. An explicit selection
    // still outranks the report; only an empty one adopts it.
    if (!this._model) this._model = reported;
  }

  /**
   * Adopt Claude's native permissionMode without treating the access policy as
   * "leave Plan". Plan is a separate interaction; default/acceptEdits/auto are
   * the live access policy. A stale spawn-time init on a new session must not
   * undo Plan after start or setPermissionMode asked for it. A resumed thread
   * still takes the native session as truth. Live status updates always win.
   *
   * @param {string} native SDK permissionMode.
   * @param {{fromInit?: boolean}} [options]
   */
  _applyNativePermissionMode(native, { fromInit = false } = {}) {
    if (native === 'plan') {
      this._interactionMode = CHAT_INTERACTION_MODES.PLAN;
    } else {
      this._permissionMode = normalizeChatPermissionMode(native);
      const keepPlan = !this._resumed
        && this._interactionMode === CHAT_INTERACTION_MODES.PLAN
        && fromInit;
      if (!keepPlan) this._interactionMode = CHAT_INTERACTION_MODES.DEFAULT;
    }
    this._emitProviderEvent({
      type: 'session.config.updated',
      payload: {
        ...(this._model ? { model: this._model } : {}),
        permissionMode: this._permissionMode,
        interactionMode: this._interactionMode
      }
    });
  }

  /**
   * Track session identity and state from the SDK messages.
   * @param {Object} message
   */
  _applyBookkeeping(message) {
    if (message?.type === 'system' && message.subtype === 'init') {
      this._threadId = message.session_id || this._threadId;
      this._applyReportedModel(message.model);
      if (typeof message.permissionMode === 'string') {
        this._nativePermissionObserved = true;
        this._applyNativePermissionMode(message.permissionMode, { fromInit: true });
      }
      return;
    }
    if (
      message?.type === 'system'
      && message.subtype === 'status'
      && typeof message.permissionMode === 'string'
    ) {
      this._applyNativePermissionMode(message.permissionMode);
      return;
    }
    if (message?.type === 'result') {
      this._threadId = message.session_id || this._threadId;
      this._activeTurnId = null;
      if (!this._stopping && this._state === 'running') this._setState('ready');
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
    const event = createProviderEvent(bare, {
      provider: PROVIDER_ID,
      threadId: this._threadId || undefined,
      executionOrigin: 'main'
    });
    /**
     * @event ClaudeAgentSdkDriver#provider-event
     * @type {import('./provider-events').ProviderEvent}
     */
    this.emit(PROVIDER_EVENT_CHANNEL, event);
  }
}

let sdkQueryPromise = null;

/**
 * Lazily resolve the SDK `query` function, caching the import promise.
 * @returns {Promise<Function>}
 */
function loadClaudeQueryFn() {
  if (!sdkQueryPromise) {
    // The SDK is ESM-only and this app is CommonJS. A literal `import()` here
    // would be transpiled to `require()` by jest/babel and fail with
    // ERR_REQUIRE_ESM, so the dynamic import is built via the Function
    // constructor to stay a native import at runtime.
    // eslint-disable-next-line no-new-func
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    sdkQueryPromise = dynamicImport(SDK_MODULE_ID).then((sdkModule) => sdkModule.query);
  }
  return sdkQueryPromise;
}

/**
 * Await `promise` but give up after `timeoutMs`.
 * @param {Promise<*>} promise
 * @param {number} timeoutMs
 * @returns {Promise<*>} The settled value, or null on timeout.
 */
async function waitBounded(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Error} [error]
 * @returns {boolean} True when the error is an abort, not a real failure.
 */
function isAbortError(error) {
  return error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
}

/**
 * Synthetic method name identifying an SDK message in the `raw` passthrough.
 * @param {Object} [message]
 * @returns {string}
 */
function sdkMethod(message) {
  const type = message?.type;
  if (type === 'system' && typeof message.subtype === 'string') {
    return `claude/system/${message.subtype}`;
  }
  if (type === 'stream_event' && typeof message.event?.type === 'string') {
    const eventType = message.event.type;
    if (eventType === 'content_block_delta' && typeof message.event.delta?.type === 'string') {
      return `claude/stream_event/${eventType}/${message.event.delta.type}`;
    }
    return `claude/stream_event/${eventType}`;
  }
  return `claude/${String(type)}`;
}

/**
 * Build the `raw` passthrough attached to every mapped event.
 * @param {Object} message
 * @returns {{source: string, method: string, payload: Object}}
 */
function buildRaw(message) {
  return { source: RAW_SOURCE, method: sdkMethod(message), payload: message };
}

/**
 * Envelope fields shared by every event mapped from one SDK message.
 * @param {Object} message
 * @param {Object} state
 * @returns {{threadId?: string, turnId?: string}}
 */
function envelopeFields(message, state) {
  const fields = {};
  if (typeof message?.session_id === 'string' && message.session_id) {
    fields.threadId = message.session_id;
  }
  if (state?.turnId) fields.turnId = state.turnId;
  return fields;
}

/**
 * Build an item lifecycle event for one SDK message.
 * @param {'item.started'|'item.updated'|'item.completed'} type
 * @param {Object} message
 * @param {Object} state
 * @param {string} itemId
 * @param {Object} payload
 * @returns {Object} A bare canonical event.
 */
function itemEvent(type, message, state, itemId, payload) {
  return {
    type,
    ...envelopeFields(message, state),
    itemId,
    payload,
    raw: buildRaw(message)
  };
}

/**
 * Translate a Claude tool name into the canonical item vocabulary.
 * @param {string} name
 * @returns {string} Canonical item type, `'dynamic_tool_call'` when unmapped.
 */
function classifyClaudeToolItemType(name) {
  if (typeof name !== 'string' || !name) return 'dynamic_tool_call';
  if (Object.prototype.hasOwnProperty.call(CLAUDE_TOOL_ITEM_TYPE_MAP, name)) {
    return CLAUDE_TOOL_ITEM_TYPE_MAP[name];
  }
  return name.startsWith('mcp__') ? 'mcp_tool_call' : 'dynamic_tool_call';
}

/**
 * @param {string} itemType Canonical item type.
 * @param {string} [toolName] Native Claude tool name.
 * @returns {string} Human readable title, never empty.
 */
function itemTitle(itemType, toolName) {
  if (itemType === 'mcp_tool_call' && typeof toolName === 'string') {
    const [prefix, server, ...rest] = toolName.split('__');
    const tool = rest.join('__');
    if (prefix === 'mcp' && server && tool) return `${server} · ${tool}`;
  }
  if (Object.prototype.hasOwnProperty.call(ITEM_TITLE_MAP, itemType)) {
    return ITEM_TITLE_MAP[itemType];
  }
  return typeof toolName === 'string' && toolName ? toolName : 'Tool call';
}

/**
 * First meaningful one-line description found on a tool input.
 * @param {string} [name] Tool name, kept for symmetry with {@link itemTitle}.
 * @param {Object} [input] Native tool input.
 * @returns {string|undefined}
 */
function claudeToolDetail(name, input) {
  if (!input || typeof input !== 'object') return undefined;
  for (const field of TOOL_DETAIL_FIELDS) {
    const detail = truncate(input[field]);
    if (detail) return detail;
  }
  try {
    const serialized = JSON.stringify(input);
    return serialized === '{}' ? undefined : truncate(serialized);
  } catch (error) {
    return undefined;
  }
}

/**
 * Trim and cap a free-text detail.
 * @param {*} text
 * @returns {string|undefined} Undefined when there is nothing to show.
 */
function truncate(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > DETAIL_MAX_LENGTH
    ? `${trimmed.slice(0, DETAIL_MAX_LENGTH - 1)}…`
    : trimmed;
}

/**
 * Flatten the many shapes a tool result content can take into plain text.
 * @param {*} value
 * @returns {string} Empty string when there is no text at all.
 */
function extractTextContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractTextContent).join('');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return extractTextContent(value.content);
  }
  return '';
}

/**
 * Kind of approval a denied tool call corresponds to.
 * @param {string} [toolName]
 * @returns {string} One of the canonical request types.
 */
function classifyClaudeRequestType(toolName) {
  const itemType = classifyClaudeToolItemType(toolName);
  if (itemType === 'command_execution') return 'command_execution_approval';
  if (itemType === 'file_change') return 'file_change_approval';
  return 'unknown';
}

/**
 * Translate `AskUserQuestion` questions into the canonical question shape.
 *
 * The canonical `id` is the question TEXT because that is the key the SDK
 * looks answers up by in `AskUserQuestionInput.answers` / `.annotations`.
 *
 * @param {Array<Object>} [rawQuestions]
 * @returns {import('./provider-events').CanonicalQuestion[]}
 */
function mapClaudeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];

  const questions = [];
  rawQuestions.forEach((raw, index) => {
    const text = typeof raw?.question === 'string' && raw.question ? raw.question : '';
    if (!text) return;
    const options = (Array.isArray(raw?.options) ? raw.options : [])
      .map((option) => ({
        label: typeof option?.label === 'string' ? option.label : '',
        description: typeof option?.description === 'string' ? option.description : ''
      }))
      .filter((option) => option.label);
    questions.push({
      id: text || `q-${index}`,
      header: typeof raw?.header === 'string' && raw.header ? raw.header : `Question ${index + 1}`,
      question: text,
      options,
      multiSelect: raw?.multiSelect === true,
      allowsFreeText: true,
      allowsNote: true,
      secret: false
    });
  });
  return questions;
}

/**
 * @param {Object} [source]
 * @param {string} field
 * @returns {number} The non-negative finite value, or 0.
 */
function numericField(source, field) {
  const value = source?.[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Normalize the SDK's context-usage report into the canonical shape.
 *
 * This is the same data `/context` prints, and it is the ONLY honest answer to
 * "how full is the window": see `_emitContextUsage` for why `result.usage`
 * cannot be used for it.
 *
 * @param {Object} [context] `SDKControlGetContextUsageResponse`.
 * @returns {Object|undefined} Undefined when the SDK reported nothing usable.
 */
function normalizeClaudeContextUsage(context) {
  const usedTokens = numericField(context, 'totalTokens');
  if (!(usedTokens > 0)) return undefined;
  const maxTokens = numericField(context, 'maxTokens');
  return {
    usedTokens,
    ...(maxTokens > 0 ? { maxTokens } : {})
  };
}

/** Prefix the Claude CLI reserves for its own debug lines inside `result.errors`. */
const EDE_DIAGNOSTIC_PREFIX = '[ede_diagnostic]';

/**
 * The `result.errors` entries meant for a human, i.e. everything the CLI did not
 * tag as an internal diagnostic.
 *
 * `ede` stands for "error during execution": the CLI appends those lines when a
 * turn ends early (the user steered, a tool call was cut) and filters them out of
 * its own UI before showing anything. They must never reach ours either, both
 * because they are meaningless to the user and because their wording ("turn
 * aborted (...)") otherwise poisons the substring checks below and can mask a
 * real failure.
 *
 * @param {Object} message
 * @returns {string[]}
 */
function reportableClaudeErrors(message) {
  return (Array.isArray(message?.errors) ? message.errors : [])
    .filter((error) => typeof error === 'string' && error)
    .filter((error) => !error.startsWith(EDE_DIAGNOSTIC_PREFIX));
}

/**
 * Claude result message -> canonical turn state.
 *
 * `is_error` must be checked on its own: a `success` subtype can still carry
 * `is_error: true` with the failure text in `result` (observed on auth errors).
 *
 * @param {Object} message
 * @returns {string} One of the canonical turn states.
 */
function mapClaudeTurnState(message) {
  const hasErrors = Array.isArray(message?.errors) && message.errors.length > 0;
  const joinedErrors = reportableClaudeErrors(message).join(' ').toLowerCase();
  const terminalReason = typeof message?.terminal_reason === 'string'
    ? message.terminal_reason.toLowerCase()
    : '';

  if (message?.subtype === 'success' && message.is_error !== true) return 'completed';
  if (
    terminalReason === 'aborted_streaming'
    || terminalReason.includes('interrupt')
    || joinedErrors.includes('interrupt')
    || joinedErrors.includes('abort')
  ) {
    return 'interrupted';
  }
  // Errors that are ALL internal diagnostics describe a turn that was cut, not one
  // that broke: there is nothing to report, so this is an interruption.
  if (message?.subtype === 'error_during_execution' && hasErrors && !joinedErrors) {
    return 'interrupted';
  }
  if (joinedErrors.includes('cancel')) return 'cancelled';
  return 'failed';
}

/**
 * Human-readable reason a turn did not complete.
 * @param {Object} message
 * @returns {string|undefined}
 */
function claudeResultErrorMessage(message) {
  const errors = reportableClaudeErrors(message);
  if (errors.length > 0) return errors.join('; ');
  return typeof message?.result === 'string' && message.is_error ? message.result : undefined;
}

/**
 * Register a streaming content block in a copy of the mapper state.
 * @param {Object} state
 * @param {number} index
 * @param {{kind: string, itemId: string}} block
 * @returns {Object} The next mapper state.
 */
function withBlock(state, index, block) {
  return { ...state, blocks: { ...state.blocks, [index]: block } };
}

/**
 * Drop a streaming content block from a copy of the mapper state.
 * @param {Object} state
 * @param {number} index
 * @returns {Object} The next mapper state.
 */
function withoutBlock(state, index) {
  const blocks = { ...state.blocks };
  delete blocks[index];
  return { ...state, blocks };
}

/**
 * Register an in-flight tool call in a copy of the mapper state.
 * @param {Object} state
 * @param {string} toolUseId
 * @param {{itemType: string, name: string, input?: Object}} tool
 * @returns {Object} The next mapper state.
 */
function withTool(state, toolUseId, tool) {
  return { ...state, tools: { ...state.tools, [toolUseId]: tool } };
}

/**
 * Register a live subagent in a copy of the mapper state, in both directions.
 * @param {Object} state
 * @param {string} itemId Timeline item the subagent is drawn as.
 * @param {string} taskId Provider-side task id.
 * @returns {Object} The next mapper state.
 */
function withSubagent(state, itemId, taskId) {
  return {
    ...state,
    subagents: { ...state.subagents, [itemId]: { taskId } },
    subagentsByTask: { ...state.subagentsByTask, [taskId]: itemId }
  };
}

/**
 * Drop a finished subagent from a copy of the mapper state.
 * @param {Object} state
 * @param {string} itemId
 * @returns {Object} The next mapper state, unchanged when it was not registered.
 */
function withoutSubagent(state, itemId) {
  const entry = state.subagents?.[itemId];
  if (!entry) return state;
  const subagents = { ...state.subagents };
  delete subagents[itemId];
  const subagentsByTask = { ...state.subagentsByTask };
  delete subagentsByTask[entry.taskId];
  return { ...state, subagents, subagentsByTask };
}

/**
 * Name a `Task` tool call runs a subagent under, read straight off its input.
 * Foreground calls only: a backgrounded one is announced by `task_started`.
 * @param {Object} [input] Native tool input.
 * @returns {{agentType: string, description?: string, background: false}|null}
 */
function syncSubagentInfo(input) {
  const agentType = taskString(input?.subagent_type);
  if (!agentType) return null;
  const description = taskString(input?.description);
  return { agentType, ...(description ? { description } : {}), background: false };
}

/**
 * The registered item a task message addresses, by tool use id first and by
 * task id second: `task_updated` and `background_tasks_changed` only carry the
 * latter, while the row was opened under the former.
 * @param {Object} message
 * @param {Object} state
 * @returns {string|null} Null when no live subagent matches.
 */
function subagentItemId(message, state) {
  const toolUseId = taskString(message.tool_use_id);
  if (toolUseId && state.subagents?.[toolUseId]) return toolUseId;
  const taskId = taskString(message.task_id);
  return (taskId && state.subagentsByTask?.[taskId]) || null;
}

/**
 * @param {*} value
 * @returns {string} Trimmed text, or `''` when `value` is not usable text.
 */
function taskString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * @param {*} value
 * @returns {string[]} Only the non-empty strings in `value`.
 */
function taskStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => taskString(entry)) : [];
}

/**
 * @param {*} value Provider status spelling.
 * @returns {'pending'|'in_progress'|'completed'}
 */
function taskStatus(value) {
  if (value === 'completed') return 'completed';
  if (value === 'in_progress') return 'in_progress';
  return 'pending';
}

/**
 * Fold one `TaskCreate`/`TaskUpdate`/`TaskList` result into the checklist.
 *
 * The trio only ever describes a delta, so the rendered list has to be
 * accumulated here rather than read off any single call:
 *
 * - `TaskList` is the authoritative snapshot and replaces the whole list.
 * - `TaskCreate` appends. Its id exists only in the tool *result*, never in the
 *   arguments, which is why the result is threaded in.
 * - `TaskUpdate` mutates in place, addressed by the `taskId` argument. A
 *   `deleted` status removes the step instead of rendering a dead row.
 *
 * @param {Object[]} tasks Current accumulated steps.
 * @param {{name: string, input?: Object}} tool The tool call being completed.
 * @param {*} result The message's `tool_use_result`, when the SDK sent one.
 * @returns {{tasks: Object[], changed: boolean}} `changed` is false when the
 *   result carried nothing usable, so the caller can skip a pointless repaint.
 */
function applyClaudeTaskResult(tasks, tool, result) {
  const input = (tool && tool.input) || {};
  const data = result && typeof result === 'object' && !Array.isArray(result) ? result : {};

  if (tool.name === 'TaskList') {
    if (!Array.isArray(data.tasks)) return { tasks, changed: false };
    const next = [];
    for (const entry of data.tasks) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const id = taskString(entry.id);
      const subject = taskString(entry.subject);
      if (!id || !subject) continue;
      next.push({
        id,
        subject,
        status: taskStatus(entry.status),
        blockedBy: taskStringArray(entry.blockedBy)
      });
    }
    return { tasks: next, changed: true };
  }

  if (tool.name === 'TaskCreate') {
    const created = data.task && typeof data.task === 'object' ? data.task : {};
    const id = taskString(created.id);
    const subject = taskString(created.subject) || taskString(input.subject);
    if (!id || !subject) return { tasks, changed: false };
    const next = tasks.filter((task) => task.id !== id);
    next.push({
      id,
      subject,
      status: taskStatus(input.status),
      blockedBy: taskStringArray(input.addBlockedBy)
    });
    return { tasks: next, changed: true };
  }

  const taskId = taskString(input.taskId) || taskString(data.taskId);
  if (!taskId) return { tasks, changed: false };
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return { tasks, changed: false };

  if (input.status === 'deleted') {
    return { tasks: tasks.filter((task) => task.id !== taskId), changed: true };
  }

  const current = tasks[index];
  const subject = taskString(input.subject) || current.subject;
  const status = typeof input.status === 'string' ? taskStatus(input.status) : current.status;
  const added = taskStringArray(input.addBlockedBy);
  const blockedBy = added.length
    ? Array.from(new Set([...current.blockedBy, ...added]))
    : current.blockedBy;

  if (
    subject === current.subject
    && status === current.status
    && blockedBy.length === current.blockedBy.length
  ) {
    return { tasks, changed: false };
  }

  const next = tasks.slice();
  next[index] = { ...current, subject, status, blockedBy };
  return { tasks: next, changed: true };
}

/**
 * Render the accumulator in the canonical checklist shape the chat panel
 * already understands, so no renderer-side schema knows about Claude's trio.
 *
 * Blocking dependencies ride along in the step text because the canonical
 * checklist entry has nowhere else to put them.
 *
 * @param {Object[]} tasks
 * @returns {Array<{content: string, status: string}>}
 */
function claudeTasksToTodos(tasks) {
  return tasks.map((task) => ({
    content: task.blockedBy.length
      ? `${task.subject} (blocked by #${task.blockedBy.join(', #')})`
      : task.subject,
    status: task.status
  }));
}

/**
 * Drop a finished tool call from a copy of the mapper state.
 * @param {Object} state
 * @param {string} toolUseId
 * @returns {Object} The next mapper state, unchanged when the tool was unknown.
 */
function withoutTool(state, toolUseId) {
  if (!Object.prototype.hasOwnProperty.call(state.tools, toolUseId)) return state;
  const tools = { ...state.tools };
  delete tools[toolUseId];
  return { ...state, tools };
}

/**
 * `system/init` -> `thread.started`.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapSystemInit(message, state) {
  const providerThreadId = message.session_id;
  if (typeof providerThreadId !== 'string' || !providerThreadId) return { events: [], state };
  return {
    events: [{
      type: 'thread.started',
      threadId: providerThreadId,
      payload: { providerThreadId },
      raw: buildRaw(message)
    }],
    state
  };
}

/**
 * `system/compact_boundary` -> a completed context-compaction item.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapCompactBoundary(message, state) {
  return {
    events: [{
      type: 'item.completed',
      ...envelopeFields(message, state),
      ...(typeof message.uuid === 'string' ? { itemId: message.uuid } : {}),
      payload: {
        itemType: 'context_compaction',
        status: 'completed',
        title: 'Context compaction',
        data: message.compact_metadata
      },
      raw: buildRaw(message)
    }],
    state
  };
}

/** `system/local_command_output` -> assistant-style command output. */
function mapLocalCommandOutput(message, state) {
  if (typeof message.content !== 'string' || !message.content.trim()) {
    return { events: [], state };
  }
  return {
    events: [{
      type: 'item.completed',
      ...envelopeFields(message, state),
      itemId: message.uuid || `local-command-${message.session_id || 'output'}`,
      payload: {
        itemType: 'assistant_message',
        status: 'completed',
        title: 'Command output',
        data: { text: message.content }
      },
      raw: buildRaw(message)
    }],
    state
  };
}

/**
 * `system/permission_denied` -> an opened and immediately denied request.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapPermissionDenied(message, state) {
  const requestType = classifyClaudeRequestType(message.tool_name);
  const envelope = {
    ...envelopeFields(message, state),
    ...(typeof message.tool_use_id === 'string' ? { itemId: message.tool_use_id } : {})
  };
  const raw = buildRaw(message);

  return {
    events: [
      {
        type: 'request.opened',
        ...envelope,
        payload: {
          requestType,
          ...(message.message ? { detail: message.message } : {}),
          args: {
            toolName: message.tool_name,
            toolUseId: message.tool_use_id,
            ...(message.decision_reason ? { decisionReason: message.decision_reason } : {})
          }
        },
        raw
      },
      {
        type: 'request.resolved',
        ...envelope,
        payload: { requestType, decision: 'denied' },
        raw
      }
    ],
    state
  };
}

/**
 * `system/task_started` -> an opened, or reopened, subagent item.
 *
 * Only agent tasks qualify: the same subtype also announces backgrounded
 * shells, which are commands and already have their own row. A task id already
 * known to `subagentItemsByTask` is a revival — the parent sent a message to a
 * finished subagent, so the SDK re-announces it under a new `tool_use_id` — and
 * it updates the row it opened the first time instead of opening another.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapTaskStarted(message, state) {
  const agentType = taskString(message.subagent_type);
  const taskId = taskString(message.task_id);
  if (!agentType || !taskId || message.skip_transcript === true) return { events: [], state };

  const description = taskString(message.description);
  const existingItemId = state.subagentItemsByTask && state.subagentItemsByTask[taskId];
  const itemId = existingItemId || taskString(message.tool_use_id) || `task-${taskId}`;

  const payload = {
    itemType: 'collab_agent_tool_call',
    status: 'inProgress',
    title: ITEM_TITLE_MAP.collab_agent_tool_call,
    ...(description ? { detail: description } : {}),
    data: {
      subagent: {
        agentType,
        ...(description ? { description } : {}),
        background: true,
        taskId
      }
    }
  };

  if (existingItemId) {
    return {
      events: [itemEvent('item.updated', message, state, existingItemId, payload)],
      state: withSubagent(state, existingItemId, taskId)
    };
  }

  return {
    events: [itemEvent('item.started', message, state, itemId, payload)],
    state: {
      ...withSubagent(state, itemId, taskId),
      subagentItemsByTask: { ...state.subagentItemsByTask, [taskId]: itemId }
    }
  };
}

/**
 * `system/task_updated` -> a refreshed, or closed, subagent item.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapTaskUpdated(message, state) {
  const itemId = subagentItemId(message, state);
  if (!itemId) return { events: [], state };

  const patch = message.patch && typeof message.patch === 'object' ? message.patch : {};
  const nativeStatus = taskString(patch.status);
  const terminalStatus = SUBAGENT_TERMINAL_STATUS[nativeStatus];
  const description = taskString(patch.description);

  return {
    events: [itemEvent(
      terminalStatus ? 'item.completed' : 'item.updated',
      message,
      state,
      itemId,
      {
        itemType: 'collab_agent_tool_call',
        status: terminalStatus || 'inProgress',
        title: ITEM_TITLE_MAP.collab_agent_tool_call,
        ...(description ? { detail: description } : {}),
        data: {
          subagent: {
            ...(description ? { description } : {}),
            ...(nativeStatus ? { state: nativeStatus } : {}),
            background: true
          }
        }
      }
    )],
    state: terminalStatus ? withoutSubagent(state, itemId) : state
  };
}

/**
 * `system/task_notification` -> a closed subagent item.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapTaskNotification(message, state) {
  const itemId = subagentItemId(message, state);
  if (!itemId) return { events: [], state };

  const nativeStatus = taskString(message.status);
  const summary = truncate(message.summary);

  return {
    events: [itemEvent('item.completed', message, state, itemId, {
      itemType: 'collab_agent_tool_call',
      status: SUBAGENT_TERMINAL_STATUS[nativeStatus] || 'completed',
      title: ITEM_TITLE_MAP.collab_agent_tool_call,
      ...(summary ? { detail: summary } : {}),
      data: {
        subagent: {
          ...(nativeStatus ? { state: nativeStatus } : {}),
          background: true
        }
      }
    })],
    state: withoutSubagent(state, itemId)
  };
}

/**
 * `system/background_tasks_changed` -> a closed item per subagent the SDK has
 * stopped listing. It is the only signal for a subagent that ends without a
 * notification of its own, so the row would otherwise spin forever.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapBackgroundTasksChanged(message, state) {
  const registered = state.subagents || {};
  const live = new Set(
    (Array.isArray(message.tasks) ? message.tasks : [])
      .map((task) => taskString(task?.task_id))
      .filter(Boolean)
  );

  const events = [];
  let nextState = state;
  for (const itemId of Object.keys(registered)) {
    if (live.has(registered[itemId].taskId)) continue;
    events.push(itemEvent('item.completed', message, state, itemId, {
      itemType: 'collab_agent_tool_call',
      status: 'completed',
      title: ITEM_TITLE_MAP.collab_agent_tool_call,
      data: { subagent: { state: 'stopped', background: true } }
    }));
    nextState = withoutSubagent(nextState, itemId);
  }

  return { events, state: nextState };
}

/** system subtype -> mapper. */
const SYSTEM_SUBTYPE_MAPPERS = Object.freeze({
  init: mapSystemInit,
  local_command_output: mapLocalCommandOutput,
  compact_boundary: mapCompactBoundary,
  permission_denied: mapPermissionDenied,
  task_started: mapTaskStarted,
  task_updated: mapTaskUpdated,
  task_notification: mapTaskNotification,
  background_tasks_changed: mapBackgroundTasksChanged
});

/**
 * `stream_event/content_block_start` -> an `item.started` for the new block.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapContentBlockStart(message, state) {
  const { index, content_block: block } = message.event;
  if (typeof index !== 'number' || !block) return { events: [], state };

  const fallbackItemId = `${state.currentMessageId || 'msg'}:${index}`;

  if (TEXT_BLOCK_TYPES.includes(block.type)) {
    return {
      events: [itemEvent('item.started', message, state, fallbackItemId, {
        itemType: 'assistant_message',
        status: 'inProgress',
        title: ITEM_TITLE_MAP.assistant_message
      })],
      state: withBlock(state, index, { kind: 'text', itemId: fallbackItemId })
    };
  }

  if (THINKING_BLOCK_TYPES.includes(block.type)) {
    return {
      events: [itemEvent('item.started', message, state, fallbackItemId, {
        itemType: 'reasoning',
        status: 'inProgress',
        title: ITEM_TITLE_MAP.reasoning
      })],
      state: withBlock(state, index, { kind: 'thinking', itemId: fallbackItemId })
    };
  }

  if (TOOL_USE_BLOCK_TYPES.includes(block.type)) {
    const hasId = typeof block.id === 'string' && block.id;
    const itemId = hasId ? block.id : fallbackItemId;
    const itemType = classifyClaudeToolItemType(block.name);

    let nextState = withBlock(state, index, { kind: 'tool_use', itemId });
    if (hasId) nextState = withTool(nextState, block.id, { itemType, name: block.name });

    return {
      events: [itemEvent('item.started', message, state, itemId, {
        itemType,
        status: 'inProgress',
        title: itemTitle(itemType, block.name)
      })],
      state: nextState
    };
  }

  return { events: [], state: withBlock(state, index, { kind: 'unknown', itemId: fallbackItemId }) };
}

/**
 * `stream_event/content_block_delta` -> a `content.delta`.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapContentBlockDelta(message, state) {
  const { index, delta } = message.event;
  // `input_json_delta` (tool arguments) and anything else is not user-facing text.
  const isText = delta?.type === 'text_delta';
  const isThinking = delta?.type === 'thinking_delta';
  if (!isText && !isThinking) return { events: [], state };

  const streamKind = isText ? 'assistant_text' : 'reasoning_text';
  const text = isText ? delta.text : delta.thinking;
  if (typeof text !== 'string' || text === '') return { events: [], state };

  const block = state.blocks[index];
  return {
    events: [{
      type: 'content.delta',
      ...envelopeFields(message, state),
      ...(block ? { itemId: block.itemId } : {}),
      payload: { streamKind, delta: text, contentIndex: index },
      raw: buildRaw(message)
    }],
    state
  };
}

/**
 * `stream_event/content_block_stop` -> `item.completed` for text/reasoning.
 * Tool blocks stay open: they complete when their `tool_result` arrives.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapContentBlockStop(message, state) {
  const { index } = message.event;
  const block = state.blocks[index];
  if (!block) return { events: [], state };

  const nextState = withoutBlock(state, index);
  if (block.kind === 'text') {
    return {
      events: [itemEvent('item.completed', message, state, block.itemId, {
        itemType: 'assistant_message',
        status: 'completed',
        title: ITEM_TITLE_MAP.assistant_message
      })],
      state: nextState
    };
  }
  if (block.kind === 'thinking') {
    return {
      events: [itemEvent('item.completed', message, state, block.itemId, {
        itemType: 'reasoning',
        status: 'completed',
        title: ITEM_TITLE_MAP.reasoning
      })],
      state: nextState
    };
  }
  return { events: [], state: nextState };
}

/** streaming event type -> mapper. */
const STREAM_EVENT_MAPPERS = Object.freeze({
  message_start: (message, state) => ({
    events: [],
    state: { ...state, currentMessageId: message.event.message?.id ?? null }
  }),
  content_block_start: mapContentBlockStart,
  content_block_delta: mapContentBlockDelta,
  content_block_stop: mapContentBlockStop
});

/**
 * Raw Anthropic streaming events (only with `includePartialMessages`).
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapStreamEvent(message, state) {
  const eventType = message.event?.type;
  if (!Object.prototype.hasOwnProperty.call(STREAM_EVENT_MAPPERS, eventType)) {
    return { events: [], state };
  }
  return STREAM_EVENT_MAPPERS[eventType](message, state);
}

/**
 * Full assistant message: only tool calls and errors produce events. Text is
 * skipped on purpose, the driver always runs with `includePartialMessages` so
 * it already streamed as `content.delta`.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapAssistantMessage(message, state) {
  const events = [];
  let nextState = state;

  if (typeof message.error === 'string' && message.error) {
    events.push({
      type: 'runtime.error',
      ...envelopeFields(message, state),
      payload: {
        message: `Claude assistant error: ${message.error}`,
        class: 'provider_error',
        detail: { error: message.error }
      },
      raw: buildRaw(message)
    });
  }

  const content = Array.isArray(message.message?.content) ? message.message.content : [];
  for (const entry of content) {
    if (entry?.type !== 'tool_use' || typeof entry.id !== 'string' || !entry.id) continue;

    const itemType = classifyClaudeToolItemType(entry.name);
    const detail = claudeToolDetail(entry.name, entry.input);
    const subagent = syncSubagentInfo(entry.input);
    const payload = {
      itemType,
      title: itemTitle(itemType, entry.name),
      ...(detail ? { detail } : {}),
      data: {
        id: entry.id,
        name: entry.name,
        input: entry.input,
        ...(subagent ? { subagent } : {})
      }
    };

    if (Object.prototype.hasOwnProperty.call(nextState.tools, entry.id)) {
      // The streaming pass opened this tool before its arguments finished
      // arriving. Record them now: `TaskUpdate` addresses its step by the
      // `taskId` argument, which is unavailable once only the result is left.
      nextState = withTool(nextState, entry.id, {
        ...nextState.tools[entry.id],
        input: entry.input
      });
      events.push(itemEvent('item.updated', message, state, entry.id, payload));
      continue;
    }
    // Partial messages missed this tool_use, so open the item here instead.
    nextState = withTool(nextState, entry.id, {
      itemType,
      name: entry.name,
      input: entry.input
    });
    events.push(itemEvent('item.started', message, state, entry.id, {
      ...payload,
      status: 'inProgress'
    }));
  }

  return { events, state: nextState };
}

/**
 * User message: only the echoed `tool_result` blocks produce events.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapUserMessage(message, state) {
  const content = Array.isArray(message.message?.content) ? message.message.content : [];
  const events = [];
  let nextState = state;

  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== 'string' || !toolUseId) continue;

    const tool = nextState.tools[toolUseId];
    const itemType = tool?.itemType || 'dynamic_tool_call';
    const text = extractTextContent(block.content);

    if ((itemType === 'command_execution' || itemType === 'file_change') && text) {
      events.push({
        type: 'content.delta',
        ...envelopeFields(message, state),
        itemId: toolUseId,
        payload: {
          streamKind: itemType === 'command_execution' ? 'command_output' : 'file_change_output',
          delta: text
        },
        raw: buildRaw(message)
      });
    }

    // Claude's task trio reports its checklist through the structured result,
    // which the SDK hangs off the message rather than the `tool_result` block.
    // A failed call is never folded in: it changed nothing provider-side.
    let todos = null;
    if (tool && CLAUDE_TASK_TOOLS.includes(tool.name) && block.is_error !== true) {
      const applied = applyClaudeTaskResult(
        nextState.tasks,
        tool,
        message.tool_use_result
      );
      if (applied.changed) {
        nextState = { ...nextState, tasks: applied.tasks };
        todos = claudeTasksToTodos(applied.tasks);
      }
    }

    const detail = truncate(text);

    // A backgrounded `Task` returns the moment the subagent is spawned ("running
    // in the background"), long before it is done. Closing the row on that echo
    // would hide a subagent that is still working; only its own task signals do.
    if (nextState.subagents?.[toolUseId] && block.is_error !== true) {
      events.push(itemEvent('item.updated', message, state, toolUseId, {
        itemType,
        status: 'inProgress',
        title: itemTitle(itemType, tool?.name),
        ...(detail ? { detail } : {}),
        data: { ...block, subagent: { background: true } }
      }));
      nextState = withoutTool(nextState, toolUseId);
      continue;
    }

    events.push(itemEvent('item.completed', message, state, toolUseId, {
      itemType,
      status: block.is_error === true ? 'failed' : 'completed',
      title: itemTitle(itemType, tool?.name),
      ...(detail ? { detail } : {}),
      data: todos ? { ...block, name: tool.name, todos } : block
    }));
    nextState = withoutSubagent(withoutTool(nextState, toolUseId), toolUseId);
  }

  return { events, state: nextState };
}

/**
 * Result message: closes the turn and reports the token usage.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapResultMessage(message, state) {
  const turnState = mapClaudeTurnState(message);
  // An intentional stop is not a provider failure. Claude may attach an
  // internal diagnostic string to aborted streams; never surface that as a
  // red error row in the conversation.
  const errorMessage = turnState === 'failed' ? claudeResultErrorMessage(message) : undefined;

  // Token usage is NOT emitted here: `result.usage` cannot express context
  // occupancy. The driver asks the SDK for it right after this message — see
  // `_emitContextUsage`.
  const events = [{
    type: 'turn.completed',
    ...envelopeFields(message, state),
    payload: { state: turnState, ...(errorMessage ? { errorMessage } : {}) },
    raw: buildRaw(message)
  }];

  return {
    events,
    state: { ...state, turnId: null, currentMessageId: null, blocks: {}, tools: {} }
  };
}

/**
 * Subscription rate-limit telemetry.
 * @param {Object} message
 * @param {Object} state
 * @returns {{events: Object[], state: Object}}
 */
function mapRateLimitEvent(message, state) {
  if (!message.rate_limit_info) return { events: [], state };
  return {
    events: [{
      type: 'account.rate-limits.updated',
      ...envelopeFields(message, state),
      payload: { rateLimits: message.rate_limit_info },
      raw: buildRaw(message)
    }],
    state
  };
}

/**
 * SDK message `type` -> mapper. Anything absent yields no events.
 */
const SDK_MESSAGE_MAPPERS = Object.freeze({
  system: (message, state) => {
    const subtype = message.subtype;
    if (!Object.prototype.hasOwnProperty.call(SYSTEM_SUBTYPE_MAPPERS, subtype)) {
      return { events: [], state };
    }
    return SYSTEM_SUBTYPE_MAPPERS[subtype](message, state);
  },
  stream_event: mapStreamEvent,
  assistant: mapAssistantMessage,
  user: mapUserMessage,
  result: mapResultMessage,
  rate_limit_event: mapRateLimitEvent
});

/**
 * Translate one Claude Agent SDK message into canonical events.
 *
 * Pure and deterministic: no clock, no randomness, never throws on missing
 * fields and never mutates `state`. Unmapped message types and incomplete
 * payloads yield no events and the state reference untouched.
 *
 * @param {Object} message An SDK message as yielded by `query()`.
 * @param {Object} state Mapper state from {@link createInitialMapperState}.
 * @returns {{events: Object[], state: Object}} Bare canonical events, ready for
 *   `createProviderEvent`, plus the next mapper state.
 */
function mapClaudeSdkEvent(message, state) {
  const currentState = state || createInitialMapperState();
  // Everything a subagent does is echoed on the parent stream tagged with the
  // `Task` call that spawned it. Mapping it would open first-level rows for
  // work that belongs inside the subagent, and a `Task` a subagent launches
  // itself would show up as one more running subagent of the conversation.
  if (taskString(message?.parent_tool_use_id)) return { events: [], state: currentState };
  const type = message?.type;
  if (!Object.prototype.hasOwnProperty.call(SDK_MESSAGE_MAPPERS, type)) {
    return { events: [], state: currentState };
  }
  return SDK_MESSAGE_MAPPERS[type](message, currentState);
}

/**
 * Envelope shared by every historical event mapped from a transcript line.
 * @param {Object} line
 * @param {string} itemId
 * @returns {{type: string, threadId?: string, itemId: string}}
 */
function historicalEnvelope(line, itemId) {
  return {
    type: 'item.completed',
    createdAt: typeof line.timestamp === 'string' ? line.timestamp : null,
    ...(typeof line.sessionId === 'string' && line.sessionId
      ? { threadId: line.sessionId }
      : {}),
    itemId
  };
}

/**
 * Plain text of a transcript user line: a bare string, or the `text` blocks of
 * a content array joined by newlines. Tool-result-only lines yield ''.
 * @param {Object} [message]
 * @returns {string}
 */
function transcriptUserText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Claude records local slash-command plumbing, task notifications and
 * interruption sentinels as user transcript lines. They are implementation details, not messages the
 * user typed into the conversation, so replaying them as chat bubbles leaks
 * raw XML and misrepresents the history.
 * @param {string} text
 * @returns {boolean}
 */
function isClaudeTranscriptControlText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (normalized === '[Request interrupted by user]') return true;
  return /^<(?:command-name|local-command-(?:stdout|stderr|caveat)|task-notification)\b/i.test(normalized);
}

/**
 * One historical `item.completed` for a transcript user line, if it has text.
 * @param {Object} line
 * @param {string} fallbackId
 * @returns {Object[]} Zero or one bare canonical event.
 */
function transcriptUserEvents(line, fallbackId) {
  const text = transcriptUserText(line.message);
  const attachments = contentImageAttachments(line.message?.content);
  if ((!text.trim() && !attachments.length) || isClaudeTranscriptControlText(text)) return [];

  const itemId = typeof line.uuid === 'string' && line.uuid ? line.uuid : fallbackId;
  return [{
    ...historicalEnvelope(line, itemId),
    payload: {
      itemType: 'user_message',
      status: 'completed',
      title: ITEM_TITLE_MAP.user_message,
      data: { text, ...(attachments.length ? { attachments } : {}) },
      historical: true
    }
  }];
}

/**
 * Historical `item.completed` events for a transcript assistant line: one per
 * text block and one per tool call. Thinking blocks are dropped as history
 * noise, the same way the live stream's reasoning never becomes a timeline row
 * once the turn is over.
 * @param {Object} line
 * @param {string} fallbackId
 * @returns {Object[]} Bare canonical events, in block order.
 */
function transcriptAssistantEvents(line, fallbackId) {
  const content = Array.isArray(line.message?.content) ? line.message.content : [];
  const hasUuid = typeof line.uuid === 'string' && line.uuid;
  const events = [];

  content.forEach((block, blockIndex) => {
    const blockId = `${hasUuid ? line.uuid : fallbackId}:${blockIndex}`;

    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      events.push({
        ...historicalEnvelope(line, blockId),
        payload: {
          itemType: 'assistant_message',
          status: 'completed',
          title: ITEM_TITLE_MAP.assistant_message,
          data: { text: block.text },
          historical: true
        }
      });
      return;
    }

    if (block?.type === 'tool_use') {
      const itemType = classifyClaudeToolItemType(block.name);
      const detail = claudeToolDetail(block.name, block.input);
      // A restored `Task` is still drillable — its transcript is found by
      // tool_use id — but the UI only offers the door to a row that carries
      // its subagent identity, so history must carry it too.
      const subagent = syncSubagentInfo(block.input);
      events.push({
        ...historicalEnvelope(line, block.id || blockId),
        payload: {
          itemType,
          status: 'completed',
          title: itemTitle(itemType, block.name),
          ...(detail ? { detail } : {}),
          data: {
            id: block.id,
            name: block.name,
            input: block.input,
            ...(subagent ? { subagent } : {})
          },
          historical: true
        }
      });
    }
  });

  return events;
}

/**
 * Translate a Claude conversation transcript (parsed JSONL lines) into the
 * historical timeline events a resumed session must show.
 *
 * Pure and deterministic: no clock, no randomness, never throws on garbage and
 * never mutates the input. Meta lines are skipped, as is every line type that
 * is not a real user/assistant message. Sidechain (subagent) lines are skipped
 * too unless `includeSidechain` is set — which is exactly what a subagent's own
 * transcript is made of, since every line in it is a sidechain line.
 *
 * @param {Object[]} lines Parsed transcript lines, oldest first.
 * @param {{maxEvents?: number, includeSidechain?: boolean}} [options] Cap (the
 *   LAST events are kept) and whether subagent lines count as history.
 * @returns {Object[]} Bare canonical events, ready for `createProviderEvent`.
 */
function mapClaudeTranscriptToEvents(lines, {
  maxEvents = CHAT_HISTORY_EVENT_LIMIT,
  includeSidechain = false
} = {}) {
  const source = Array.isArray(lines) ? lines : [];
  const events = [];

  source.forEach((line, index) => {
    if (!line || typeof line !== 'object') return;
    if ((line.isSidechain === true && !includeSidechain) || line.isMeta === true) return;
    if (!line.message || typeof line.message !== 'object') return;

    const fallbackId = `hist-${index}`;
    if (line.type === 'user') {
      events.push(...transcriptUserEvents(line, fallbackId));
      return;
    }
    if (line.type === 'assistant') {
      events.push(...transcriptAssistantEvents(line, fallbackId));
    }
  });

  return events.slice(-maxEvents);
}

module.exports = {
  ClaudeAgentSdkDriver,
  unpackedClaudeBinary,
  spawnableClaudeBinary,
  mapClaudeSdkEvent,
  mapClaudeTranscriptToEvents,
  createInitialMapperState,
  buildClaudeChildEnv,
  parseJsonlLines,
  resolveSubagentTranscript
};
