/**
 * DriverChatManager — owns driver-backed chat sessions in the MAIN process.
 *
 * Each session is one live agent driver (Codex app-server, Claude Agent SDK or
 * an ACP CLI) keyed by a generated sessionId. The manager re-emits every canonical
 * provider event as a `'session-event'` — `{ sessionId, event }` — so the IPC
 * layer can route streams to the renderer without knowing any driver internals.
 *
 * Additive by construction: the PTY terminals are untouched by this path.
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  normalizeChatAttachments,
  createChatImageDirectory,
  materializeChatImages,
  answersWithAttachmentReferences
} = require('./chat-attachments');
const {
  CHAT_INTERACTION_MODES,
  CHAT_PERMISSION_MODES,
  normalizeInteractionModeForAgent,
  normalizePermissionModeForAgent,
  shouldAutoApproveRequest
} = require('./chat-permission-modes');
const { CodexAppServerDriver } = require('./codex-app-server-driver');
const { ClaudeAgentSdkDriver } = require('./claude-agent-sdk-driver');
const { AcpAgentDriver } = require('./acp-agent-driver');
const { AntigravityPrintDriver } = require('./antigravity-print-driver');
const {
  resolveChatReference,
  openChatHtmlReference,
  openChatFileReference
} = require('./chat-reference-resolver');

const SESSION_EVENT = 'session-event';
const SESSION_STARTING = 'session-starting';
const SESSION_STARTED = 'session-started';
const SUPPORTED_AGENTS = Object.freeze([
  'codex',
  'claude',
  'opencode',
  'kimi',
  'antigravity',
  'grok',
  'cursor'
]);
const REASONING_CONFIG_IDS = new Set(['effort', 'thinking', 'reasoning_effort']);
const MAX_MATERIALIZED_CHAT_FILE_BYTES = 64 * 1024 * 1024;

function waitForStart(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    return Promise.reject(signal.reason || new Error('Chat session start was cancelled'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('Chat session start was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Default driver factory. `agent` is validated upstream by `startSession`, so
 * the factory only has to pick between the drivers wired into chat today.
 *
 * @param {{ agent: string, env: Object, binaryPath?: string,
 *   requiredMcpServer?: string, repairMcpConfig?: Function }} options
 * @returns {CodexAppServerDriver|ClaudeAgentSdkDriver|AcpAgentDriver}
 */
function defaultCreateDriver({ agent, env, binaryPath, requiredMcpServer, repairMcpConfig }) {
  if (agent === 'claude') return new ClaudeAgentSdkDriver({ env, binaryPath });
  if (agent === 'antigravity') return new AntigravityPrintDriver({ env, binaryPath });
  if (agent === 'opencode' || agent === 'kimi' || agent === 'grok' || agent === 'cursor') {
    return new AcpAgentDriver({ provider: agent, env, binaryPath });
  }
  return new CodexAppServerDriver({
    env,
    binaryPath,
    requiredMcpServer,
    repairMcpConfig
  });
}

class DriverChatManager extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {(opts: { agent: string, env: Object }) => Object} [options.createDriver]
   *        Driver factory (injectable for tests).
   * @param {(context: { agent: string, terminalId?: number }) => Promise<Object>} [options.resolveSpawnEnv]
   *        Resolves the extra env (typically PATH and exact terminal identity)
   *        the driver child gets.
   * @param {(context: { agent: string, terminalId?: number }) => (Object|Promise<Object>)}
   *        [options.resolveDriverOptions] Resolves provider launch options such
   *        as the custom CLI binary configured in Settings.
   * @param {(context: { sessionId: string, agent: string, terminalId: number,
   *   cwd: string|null, unifiedDiff: string }) => void} [options.onSessionDiff]
   *        Receives canonical cumulative diffs with their owning terminal.
   * @param {(agent: string, sessionId: string) => (string|null|Promise<string|null>)}
   *        [options.resolveResumeCwd] Directory a conversation was recorded in.
   * @param {(context: Object) => (Object|Promise<Object>)} [options.resolveWorkingDir]
   *        Applies the same worktree/sticky-cwd policy as terminal launch.
   * @param {(cwd: string) => boolean} [options.isWorkingDirReserved]
   *        Rejects a directory while worktree cleanup owns it.
   */
  constructor({
    createDriver,
    resolveSpawnEnv,
    resolveDriverOptions,
    onSessionDiff,
    resolveResumeCwd,
    resolveWorkingDir,
    isWorkingDirReserved
  } = {}) {
    super();
    this._createDriver = createDriver || defaultCreateDriver;
    this._resolveSpawnEnv = resolveSpawnEnv || (async () => ({}));
    this._resolveDriverOptions = resolveDriverOptions || (async () => ({}));
    this._onSessionDiff = typeof onSessionDiff === 'function' ? onSessionDiff : null;
    this._resolveResumeCwd = resolveResumeCwd || (() => null);
    this._resolveWorkingDir = resolveWorkingDir || null;
    this._isWorkingDirReserved = isWorkingDirReserved || (() => false);
    /** @type {Map<string, { driver: Object, agent: string, cwd: string|null, terminalId: number|null, onProviderEvent: Function, permissionMode: string, interactionMode: string }>} */
    this._sessions = new Map();
    this._capabilityProbes = new Map();
    this._materializedAttachmentBytes = 0;
  }

  /** @returns {number} live session count. */
  get sessionCount() {
    return this._sessions.size;
  }

  /**
   * @param {string} sessionId
   * @returns {boolean} true while the session is alive.
   */
  hasSession(sessionId) {
    return this._sessions.has(sessionId);
  }

  async probeAgentCapabilities({ agent, cwd } = {}) {
    if (!SUPPORTED_AGENTS.includes(agent)) {
      throw new Error(`Unsupported driver chat agent: ${agent}`);
    }
    if (this._capabilityProbes.has(agent)) return this._capabilityProbes.get(agent);

    const probe = (async () => {
      const resolvedEnv = await this._resolveSpawnEnv({ agent, cwd });
      const resolvedOptions = await this._resolveDriverOptions({ agent }) || {};
      const driver = this._createDriver({
        agent,
        env: { ...resolvedEnv, CODEAGENTSWARM_DRIVER_CHAT: '1' },
        ...resolvedOptions
      });
      if (typeof driver.probeCapabilities !== 'function') {
        throw new Error(`${agent} does not expose capability discovery`);
      }
      return driver.probeCapabilities({ ...(cwd ? { cwd } : {}) });
    })().finally(() => this._capabilityProbes.delete(agent));

    this._capabilityProbes.set(agent, probe);
    return probe;
  }

  /**
   * Spawns a driver and starts its agent session.
   *
   * Each driver owns its provider-specific sandbox and approval defaults.
   * Interactive approval requests are forwarded to the chat UI whenever the
   * provider protocol supports pausing for a decision.
   *
   * @param {Object} [options]
   * @param {string} [options.agent='codex']
   * @param {string} [options.cwd]
   * @param {string} [options.model]
   * @param {string} [options.effort] Provider-native reasoning effort.
   * @param {string} [options.permissionMode] Normalized Chat permission policy.
   * @param {string} [options.interactionMode] Provider interaction mode.
   * @param {boolean} [options.toolsDisabled] Remove provider tools for a
   *        short, untrusted text-only turn.
   * @param {boolean} [options.imageGenerationOnly] Isolate Codex with only
   *        its built-in image generation capability.
   * @param {boolean} [options.ephemeral] Do not keep the utility conversation.
   * @param {Array<{id: string, value: string|boolean}>} [options.providerOptions]
   *        Additional provider options selected for the model.
   * @param {number} [options.terminalId] 1-based terminal slot that owns this
   *        chat. Used only to build the child environment; never sent to a driver.
   * @param {string} [options.resumeSessionId] Agent-native conversation id to
   *        resume instead of starting a fresh one.
   * @param {{signal?: AbortSignal}} [control]
   * @returns {Promise<{ sessionId: string, agent: string, threadId: string, model: string, cwd: string, resumed: boolean, historyEvents: Object[] }>}
   *        `historyEvents` are the resumed conversation's past events, wrapped
   *        exactly like the ones the `provider-event` channel carries. They ride
   *        in the start result because no owner is mapped to this session while
   *        the driver handshake runs, so emitting them there loses them.
   */
  async startSession({
    agent = 'codex',
    accountId,
    cwd,
    model,
    effort,
    autoApprove = false,
    permissionMode,
    interactionMode,
    toolsDisabled = false,
    imageGenerationOnly = false,
    ephemeral = false,
    providerOptions = [],
    terminalId,
    terminalUuid,
    resumeSessionId,
    useWorktree = false,
    worktreeTitle,
    clientRequestId
  } = {}, { signal } = {}) {
    if (!SUPPORTED_AGENTS.includes(agent)) {
      throw new Error(`Unsupported driver chat agent: ${agent}`);
    }
    const sessionId = crypto.randomUUID();
    if (clientRequestId) {
      this.emit(SESSION_STARTING, {
        sessionId,
        clientRequestId,
        agent,
        accountId: accountId || 'current',
        terminalId: Number.isInteger(terminalId) ? terminalId : null,
        cwd: typeof cwd === 'string' && cwd ? cwd : null
      });
    }

    if (resumeSessionId) {
      // A conversation must resume in the directory it was RECORDED in (think
      // per-conversation worktrees), exactly like `create-terminal` does via
      // the session-workdir resolver.
      const recorded = await waitForStart(this._resolveResumeCwd(agent, resumeSessionId), signal);
      if (recorded) cwd = recorded;
    }
    if (this._resolveWorkingDir) {
      const resolved = await waitForStart(this._resolveWorkingDir({
        agent,
        cwd,
        useWorktree: useWorktree === true,
        worktreeTitle,
        resumeSessionId
      }), signal);
      if (resolved && typeof resolved.workingDir === 'string' && resolved.workingDir) {
        cwd = resolved.workingDir;
      }
    }
    if (cwd && this._isWorkingDirReserved(cwd)) {
      throw new Error('This worktree is being deleted');
    }

    const resolvedEnv = await waitForStart(this._resolveSpawnEnv({
      agent,
      ...(accountId ? { accountId } : {}),
      terminalId,
      terminalUuid,
      cwd
    }), signal);
    if (cwd && this._isWorkingDirReserved(cwd)) {
      throw new Error('This worktree is being deleted');
    }
    // Every CLI's GLOBAL lifecycle hook double-reports under a driver-backed
    // Chat: the driver already receives the authoritative turn/permission
    // events, while the hook also fires for delegated subagent turns (codex,
    // kimi background-task wake turns) and for permission requests the driver
    // auto-approves (kimi/grok/opencode ACP "Always approve" -> a false
    // needs_input while the agent is still working, task #12330). Mark EVERY
    // Chat child so those hooks stay silent; agents without such hooks simply
    // ignore the variable.
    const env = { ...resolvedEnv, CODEAGENTSWARM_DRIVER_CHAT: '1' };
    const resolvedOptions = await waitForStart(
      this._resolveDriverOptions({ agent, terminalId }),
      signal
    ) || {};
    const {
      model: defaultModel,
      effort: defaultEffort,
      ...driverOptions
    } = resolvedOptions;
    const resolvedModel = model || defaultModel;
    const resolvedEffort = effort || defaultEffort;
    const driver = this._createDriver({ agent, env, ...driverOptions });
    const onProviderEvent = (event) => this._handleProviderEvent(sessionId, event);
    const hasExplicitPermissionMode = permissionMode !== undefined;
    const normalizedPermissionMode = normalizePermissionModeForAgent(
      agent,
      autoApprove === true ? CHAT_PERMISSION_MODES.FULL_ACCESS : permissionMode
    );
    const normalizedInteractionMode = normalizeInteractionModeForAgent(agent, interactionMode);

    driver.on('provider-event', onProviderEvent);
    this._sessions.set(sessionId, {
      driver,
      agent,
      accountId: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_ID || 'current',
      accountLabel: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_LABEL || '',
      cwd: typeof cwd === 'string' && cwd ? cwd : null,
      terminalId: Number.isInteger(terminalId) && terminalId > 0 ? terminalId : null,
      onProviderEvent,
      permissionMode: normalizedPermissionMode,
      interactionMode: normalizedInteractionMode
    });

    try {
      const session = await waitForStart(driver.startSession({
        ...(cwd ? { cwd } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
        ...(autoApprove === true ? { autoApprove: true } : {}),
        ...(hasExplicitPermissionMode ? { permissionMode: normalizedPermissionMode } : {}),
        ...(['claude', 'cursor'].includes(agent)
          ? { interactionMode: normalizedInteractionMode }
          : {}),
        ...(toolsDisabled === true ? { toolsDisabled: true } : {}),
        ...(imageGenerationOnly === true ? { imageGenerationOnly: true } : {}),
        ...(ephemeral === true ? { ephemeral: true } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {})
      }), signal);
      const record = this._sessions.get(sessionId);
      if (record) {
        record.cwd = typeof session.cwd === 'string' && session.cwd
          ? session.cwd
          : record.cwd;
        record.readOnly = session.readOnly === true;
      }

      // ACP providers publish their model and traits only after session/new or
      // session/load, so those selections must be applied to the live session
      // before its first prompt. Codex, Claude and Antigravity accept model and
      // effort natively at startup; all other descriptors are session options.
      const acpProvider = ['opencode', 'kimi', 'grok', 'cursor'].includes(agent);
      const selections = Array.isArray(providerOptions) ? providerOptions : [];
      // These are remembered preferences, not the session itself. A provider
      // that REJECTS one (a model it no longer accepts, an option it dropped)
      // must not kill a session that is already live: the chat opens on the
      // provider default. Only a protocol-level rejection is tolerated —
      // `rpcCode` is set solely by an ACP error reply, so a timeout, a dead
      // child or any other transport failure still aborts the start.
      const rejected = new Set();
      const applyPreference = async (label, run) => {
        try {
          await waitForStart(run(), signal);
          return true;
        } catch (error) {
          if (signal?.aborted || error?.rpcCode == null) throw error;
          rejected.add(label);
          console.warn(`[chat] ${agent}: ${label} preference rejected: ${error.message}`);
          return false;
        }
      };
      if (acpProvider && resolvedModel && typeof driver.setConfigOption === 'function') {
        await applyPreference('model', () => driver.setConfigOption('model', resolvedModel));
      }
      // What the session really runs, not what was asked for: a rejected mode
      // reported as applied would show `Mode · Plan` over a session still in
      // agent, and get persisted as the slot's choice.
      let appliedInteractionMode = agent === 'cursor'
        ? (session.interactionMode || 'agent')
        : normalizedInteractionMode;
      if (
        agent === 'cursor'
        && normalizedInteractionMode !== (session.interactionMode || 'agent')
        && typeof driver.setConfigOption === 'function'
      ) {
        const applied = await applyPreference('interactionMode', () => (
          driver.setConfigOption('interactionMode', normalizedInteractionMode)
        ));
        if (applied) appliedInteractionMode = normalizedInteractionMode;
      }
      for (const selection of selections) {
        if (!selection || typeof selection.id !== 'string') continue;
        if (selection.id === 'model' && resolvedModel) continue;
        if (selection.id === 'effort' && resolvedEffort && !acpProvider) continue;
        if (typeof driver.setConfigOption !== 'function') {
          throw new Error(`This ${agent} session does not support option ${selection.id}`);
        }
        await applyPreference(selection.id, () => (
          driver.setConfigOption(selection.id, selection.value)
        ));
      }

      const started = {
        sessionId,
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(ephemeral === true ? { ephemeral: true } : {}),
        agent,
        accountId: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_ID || 'current',
        accountLabel: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_LABEL || '',
        terminalId: Number.isInteger(terminalId) ? terminalId : null,
        threadId: session.threadId,
        // A direct Chat has no PTY response from which the renderer can learn
        // its stable slot identity. The spawn environment was resolved from the
        // main-process placeholder, so return that same UUID for persistence
        // and instance-safe MCP notification routing.
        terminalUuid: env.CODEAGENTSWARM_TERMINAL_ID || null,
        model: session.model,
        effort: session.effort || resolvedEffort,
        serviceTier: session.serviceTier
          ?? (rejected.has('serviceTier')
            ? null
            : selections.find((selection) => selection?.id === 'serviceTier')?.value)
          ?? null,
        permissionMode: session.permissionMode || normalizedPermissionMode,
        interactionMode: agent === 'cursor'
          ? appliedInteractionMode
          : session.interactionMode || normalizedInteractionMode,
        interactionModes: session.interactionModes || [],
        supportsResume: agent === 'cursor'
          ? session.capabilities?.loadSession === true
          : session.capabilities?.loadSession !== false,
        cwd: session.cwd,
        resumed: Boolean(resumeSessionId),
        historyEvents: session.historyEvents || [],
        historyCursor: session.historyCursor || null,
        hasEarlierHistory: session.hasEarlierHistory === true,
        ...(session.readOnly ? { readOnly: true } : {}),
        ...(session.providerStatus ? { providerStatus: session.providerStatus } : {})
      };
      this.emit(SESSION_STARTED, started);
      return started;
    } catch (error) {
      if (signal?.aborted) this._teardownSession(sessionId).catch(() => {});
      else await this._teardownSession(sessionId);
      throw error;
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} text
   * @returns {Promise<{ turnId: string }>}
   */
  async sendTurn(sessionId, input) {
    const session = this._mustGetWritableSession(sessionId);
    const structured = input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : { text: input };
    const text = typeof structured.text === 'string' ? structured.text : '';
    const internal = structured.visibility === 'internal';
    let attachments = normalizeChatAttachments(structured.attachments);
    if (!text.trim() && attachments.length === 0) {
      throw new Error('sendTurn requires non-empty text or attachments');
    }
    const materialized = attachments.filter((attachment) => (
      attachment.type === 'audio' || (attachment.type === 'file' && attachment.transient)
    ));
    if (materialized.length) {
      if (!session.attachmentDir) session.attachmentDir = createChatImageDirectory();
      const bytes = materialized.reduce((sum, attachment) => (
        sum + (attachment.type === 'audio' ? attachment.sizeBytes : fs.statSync(attachment.path).size)
      ), 0);
      if (this._materializedAttachmentBytes + bytes > MAX_MATERIALIZED_CHAT_FILE_BYTES) {
        throw new Error('Too many attachment files are still retained by live sessions');
      }
      const copied = [];
      try {
        attachments = attachments.map((attachment) => {
          if (attachment.type === 'audio') {
            const stable = materializeChatImages([attachment], session.attachmentDir)[0];
            copied.push(stable.path);
            return stable;
          }
          if (attachment.type !== 'file' || !attachment.transient) return attachment;
          const copyPath = path.join(session.attachmentDir, `${crypto.randomUUID()}-${path.basename(attachment.name)}`);
          fs.copyFileSync(attachment.path, copyPath);
          copied.push(copyPath);
          const { transient: _transient, ...stable } = attachment;
          return { ...stable, path: copyPath };
        });
      } catch (error) {
        for (const copyPath of copied) fs.rmSync(copyPath, { force: true });
        throw error;
      }
      session.materializedAttachmentBytes = (session.materializedAttachmentBytes || 0) + bytes;
      this._materializedAttachmentBytes += bytes;
    }
    if (internal) session.internalTurn = { turnId: null };
    try {
      const turn = await session.driver.sendTurn({ text, ...(attachments.length ? { attachments } : {}) });
      if (internal && session.internalTurn && !session.internalTurn.turnId && turn?.turnId) {
        session.internalTurn.turnId = turn.turnId;
      }
      return turn;
    } catch (error) {
      if (internal) delete session.internalTurn;
      throw error;
    }
  }

  /**
   * Resolves one explicit local Chat Markdown reference against the cwd that
   * belongs to this live session. The renderer never supplies a root.
   * @param {string} sessionId
   * @param {Object} reference
   * @returns {Promise<Object>}
   */
  async resolveReference(sessionId, reference) {
    const session = this._mustGetSession(sessionId);
    return resolveChatReference({
      root: session.cwd,
      extraRoots: session.attachmentDir ? [session.attachmentDir] : [],
      reference
    });
  }

  /**
   * Validate and open one absolute HTML Chat reference in the system browser.
   * @param {string} sessionId
   * @param {Object} reference
   * @returns {Promise<Object>}
   */
  async openReference(sessionId, reference) {
    const session = this._mustGetSession(sessionId);
    return reference?.kind === 'file'
      ? openChatFileReference({ root: session.cwd, reference })
      : openChatHtmlReference(reference);
  }

  /**
   * Opens (or refreshes) a subagent conversation of a live session.
   *
   * @param {string} sessionId
   * @param {{toolUseId: string, taskId?: string, known?: Object,
   *   subagent?: {agentType?: string, description?: string, ordinal?: number}}} params
   *   `taskId` is the subagent's stable identity, when the row carries one;
   *   `subagent` is what the row knows about it, for the providers whose rows
   *   carry no id at all. `known` is the provider's own freshness stamp.
   * @returns {Promise<Object>} The driver's subagent conversation snapshot.
   */
  async openSubagent(sessionId, { toolUseId, taskId, known, subagent } = {}) {
    const session = this._mustGetSession(sessionId);
    if (typeof session.driver.openSubagentConversation !== 'function') {
      throw new Error('This agent does not support opening subagent conversations');
    }
    return session.driver.openSubagentConversation({ toolUseId, taskId, known, subagent });
  }

  /**
   * Delivers a message to one subagent of a live session.
   *
   * How it gets there is the driver's business: no provider offers a direct
   * channel today, so every one of them relays through the parent agent.
   *
   * @param {string} sessionId
   * @param {{taskId?: string, agentId?: string, agentType?: string,
   *   text: string}} params
   * @returns {Promise<Object>} Whatever the driver's delivery returned.
   */
  async sendToSubagent(sessionId, { taskId, agentId, agentType, text } = {}) {
    const session = this._mustGetWritableSession(sessionId);
    if (typeof session.driver.sendToSubagentConversation !== 'function') {
      throw new Error('This agent cannot deliver messages to a subagent');
    }
    return session.driver.sendToSubagentConversation({ taskId, agentId, agentType, text });
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async interruptTurn(sessionId) {
    return this._mustGetSession(sessionId).driver.interruptTurn();
  }

  /** Load one earlier native history page when the provider supports it. */
  async loadEarlierHistory(sessionId, cursor) {
    const driver = this._mustGetSession(sessionId).driver;
    if (typeof driver.loadEarlierHistory !== 'function') {
      return { historyEvents: [], historyCursor: null, hasEarlierHistory: false };
    }
    return driver.loadEarlierHistory(cursor);
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Array<Object>>} model descriptors.
   */
  async listModels(sessionId) {
    return this._mustGetSession(sessionId).driver.listModels();
  }

  /** Commands exposed by the live provider session. */
  async listCommands(sessionId) {
    const driver = this._mustGetSession(sessionId).driver;
    if (typeof driver.listCommands !== 'function') return [];
    return driver.listCommands();
  }

  /**
   * Run a slash command. Structured provider commands can finish locally;
   * every other command is sent unchanged through the provider's normal prompt
   * path, matching the shared ACP semantics.
   */
  async runCommand(sessionId, commandLine) {
    const session = this._mustGetWritableSession(sessionId);
    if (typeof session.driver.runCommand === 'function') {
      const localResult = await session.driver.runCommand(commandLine);
      if (localResult && localResult.handled) return localResult;
    }
    const turn = await session.driver.sendTurn({ text: commandLine });
    return {
      handled: false,
      sent: true,
      turnId: turn && turn.turnId
    };
  }

  /**
   * Changes a provider session option such as model, effort or permission mode.
   *
   * @param {string} sessionId
   * @param {string} configId
   * @param {string|boolean} value
   */
  async setConfigOption(sessionId, configId, value) {
    const session = this._mustGetSession(sessionId);
    const { driver } = session;
    if (configId === 'permissionMode') {
      const normalized = normalizePermissionModeForAgent(session.agent, value);
      if (
        (session.agent === 'claude' || session.agent === 'codex')
        && typeof driver.setConfigOption === 'function'
      ) {
        await driver.setConfigOption(configId, normalized);
      }
      session.permissionMode = normalized;
      this.emit(SESSION_EVENT, {
        sessionId,
        event: {
          eventId: crypto.randomUUID(),
          provider: session.agent,
          type: 'session.config.updated',
          executionOrigin: 'main',
          createdAt: new Date().toISOString(),
          payload: { permissionMode: normalized }
        }
      });
      return {
        changed: true,
        configId,
        value: normalized
      };
    }
    if (configId === 'interactionMode') {
      if (!['claude', 'cursor'].includes(session.agent) || typeof driver.setConfigOption !== 'function') {
        throw new Error('This agent does not expose a separate plan interaction mode');
      }
      const normalized = normalizeInteractionModeForAgent(session.agent, value);
      await driver.setConfigOption(configId, normalized);
      session.interactionMode = normalized;
      return {
        changed: true,
        configId,
        value: normalized
      };
    }
    if (typeof driver.setConfigOption !== 'function') {
      throw new Error('This agent does not support in-session configuration changes');
    }
    const result = await driver.setConfigOption(configId, value);
    const reportedValue = result && Object.prototype.hasOwnProperty.call(result, 'value')
      ? result.value
      : value;
    const canonicalId = REASONING_CONFIG_IDS.has(configId) ? 'effort' : configId;
    if (['model', 'effort', 'serviceTier'].includes(canonicalId)) {
      const patch = { [canonicalId]: reportedValue };
      if (canonicalId === 'model' && typeof driver.listModels === 'function') {
        try {
          const models = await driver.listModels();
          const active = models.find((model) => model?.current)
            || models.find((model) => model?.id === reportedValue);
          const descriptors = active?.capabilities?.optionDescriptors || [];
          const reasoning = descriptors.find((descriptor) => REASONING_CONFIG_IDS.has(descriptor?.id));
          const speed = descriptors.find((descriptor) => descriptor?.id === 'serviceTier');
          if (reasoning?.currentValue !== undefined) patch.effort = reasoning.currentValue;
          if (speed?.currentValue !== undefined) patch.serviceTier = speed.currentValue;
        } catch (_) {
          // The model switch succeeded; a catalog refresh is only for synced labels.
        }
      }
      Object.assign(session, patch);
      this.emit(SESSION_EVENT, {
        sessionId,
        event: {
          eventId: crypto.randomUUID(),
          provider: session.agent,
          type: 'session.config.updated',
          executionOrigin: 'main',
          createdAt: new Date().toISOString(),
          payload: patch
        }
      });
    }
    return result;
  }

  /**
   * Routes a user decision back to the provider request that opened it.
   *
   * @param {string} sessionId
   * @param {{requestId: string, decision: string}} response
   */
  async respondToRequest(sessionId, response) {
    const driver = this._mustGetSession(sessionId).driver;
    if (typeof driver.respondToRequest !== 'function') {
      throw new Error('This agent does not expose interactive requests');
    }
    return driver.respondToRequest(response);
  }

  /**
   * Routes the user's structured answer back to the provider question that
   * opened it. Questions are structured input: they are never auto-approved by
   * permission modes, so this path has no policy check on purpose.
   *
   * Attachments answered alongside the choices are written to disk here and
   * referenced by path, because a question's answers are plain strings on every
   * provider and no image can ride inside one. See
   * {@link answersWithAttachmentReferences}.
   *
   * @param {string} sessionId
   * @param {{requestId: string, decision: string, answers?: Object, attachments?: Array}} response
   */
  async respondToQuestion(sessionId, response) {
    const session = this._mustGetSession(sessionId);
    const driver = session.driver;
    if (typeof driver.respondToQuestion !== 'function') {
      throw new Error('This agent does not support structured questions');
    }

    const { attachments: raw, ...forDriver } = response;
    // A decline carries no answer to hang a reference on, so materializing its
    // attachments would write the user's photos to disk for nobody to read.
    const attachments = forDriver.decision === 'submit'
      ? normalizeChatAttachments(raw)
      : [];
    if (!attachments.length) return driver.respondToQuestion(forDriver);

    const bytes = attachments.reduce((sum, attachment) => (
      sum + (attachment.type === 'image' || attachment.type === 'audio' ? attachment.sizeBytes : 0)
    ), 0);
    if (this._materializedAttachmentBytes + bytes > MAX_MATERIALIZED_CHAT_FILE_BYTES) {
      throw new Error('Too many attachment files are still retained by live sessions');
    }
    if (!session.attachmentDir) session.attachmentDir = createChatImageDirectory();
    // The data URLs stop here: past this point the answer carries paths, and a
    // driver has no use for megabytes of base64 it would only ignore.
    const files = materializeChatImages(attachments, session.attachmentDir);
    session.materializedAttachmentBytes = (session.materializedAttachmentBytes || 0) + bytes;
    this._materializedAttachmentBytes += bytes;
    return driver.respondToQuestion({
      ...forDriver,
      answers: answersWithAttachmentReferences(forDriver.answers, files)
    });
  }

  /**
   * Idempotent: stopping an unknown session is not an error.
   *
   * @param {string} sessionId
   * @returns {Promise<{ stopped: boolean }>}
   */
  async stopSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return { stopped: false };
    this.emit(SESSION_EVENT, {
      sessionId,
      event: {
        eventId: crypto.randomUUID(),
        provider: session.agent,
        type: 'session.exited',
        executionOrigin: 'main',
        createdAt: new Date().toISOString(),
        payload: { reason: 'stopped' }
      }
    });
    await this._teardownSession(sessionId);
    return { stopped: true };
  }

  /**
   * Stops every live session (app quit).
   *
   * @returns {Promise<void>}
   */
  async stopAll() {
    const sessionIds = Array.from(this._sessions.keys());
    await Promise.all(sessionIds.map((sessionId) => this._teardownSession(sessionId)));
  }

  /**
   * Re-emits a driver event as a session event, then reaps sessions whose child
   * has exited.
   *
   * @param {string} sessionId
   * @param {Object} event canonical provider event.
   */
  _handleProviderEvent(sessionId, event) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    if (session.internalTurn && !session.internalTurn.turnId && event?.turnId) {
      session.internalTurn.turnId = event.turnId;
    }
    const internal = session.internalTurn && (
      !session.internalTurn.turnId || event?.turnId === session.internalTurn.turnId
    );
    if (internal) event = { ...event, visibility: 'internal' };
    if (
      event?.type === 'turn.diff.updated'
      && typeof event.payload?.unifiedDiff === 'string'
      && session.terminalId !== null
      && this._onSessionDiff
    ) {
      try {
        this._onSessionDiff({
          sessionId,
          agent: session.agent,
          terminalId: session.terminalId,
          cwd: session.cwd,
          unifiedDiff: event.payload.unifiedDiff
        });
      } catch (error) {
        console.warn(`[chat] Could not record the session diff: ${error.message}`);
      }
    }
    if (event && event.type === 'session.config.updated') {
      for (const key of ['model', 'effort', 'serviceTier']) {
        if (event.payload?.[key] !== undefined) session[key] = event.payload[key];
      }
      if (event.payload?.permissionMode) {
        session.permissionMode = normalizePermissionModeForAgent(
          session.agent,
          event.payload.permissionMode
        );
      }
      if (['claude', 'cursor'].includes(session.agent) && event.payload?.interactionMode) {
        session.interactionMode = normalizeInteractionModeForAgent(
          session.agent,
          event.payload.interactionMode
        );
      }
    }
    if (
      event
      && event.type === 'request.opened'
      && session.interactionMode !== CHAT_INTERACTION_MODES.PLAN
      && shouldAutoApproveRequest(session.permissionMode, event)
    ) {
      const options = Array.isArray(event.payload?.options) ? event.payload.options : [];
      const allowed = options.find((option) => (
        option
        && ['allow_always', 'allow_session', 'allow_once'].includes(option.kind)
      ));
      if (!allowed || typeof session.driver.respondToRequest !== 'function') {
        this.emit(SESSION_EVENT, {
          sessionId,
          ...(session.accountId !== 'current' ? { accountId: session.accountId } : {}),
          ...(session.accountLabel ? { accountLabel: session.accountLabel } : {}),
          event
        });
        return;
      }
      const decision = allowed.id || allowed.optionId || allowed.kind;
      Promise.resolve(session.driver.respondToRequest({
        requestId: event.requestId,
        decision
      })).catch((error) => {
        this.emit(SESSION_EVENT, {
          sessionId,
          event: {
            ...event,
            type: 'runtime.error',
            payload: {
              message: `Could not apply the current permission mode: ${error.message}`
            }
          }
        });
      });
      return;
    }

    // Forward FIRST so the renderer sees the exit before the session vanishes.
    this.emit(SESSION_EVENT, {
      sessionId,
      ...(session.accountId !== 'current' ? { accountId: session.accountId } : {}),
      ...(session.accountLabel ? { accountLabel: session.accountLabel } : {}),
      event
    });

    if (internal && event?.type === 'turn.completed') delete session.internalTurn;

    if (event && event.type === 'session.exited') {
      // The child is gone and the session can never be reused: detach and drop
      // the entry. No stopSession() call — there is nothing left to stop.
      this._sessions.delete(sessionId);
      session.driver.removeListener('provider-event', session.onProviderEvent);
      this._discardAttachments(session);
    }
  }

  /**
   * Delete a session's materialized attachments.
   *
   * Called from BOTH ends of a session's life — the explicit teardown and the
   * `session.exited` path — because an agent that dies on its own is the more
   * likely ending, and these files are the user's photographs sitting in
   * `os.tmpdir()`. Windows never purges `%TEMP%` on its own.
   *
   * @param {Object} session
   * @returns {void}
   */
  _discardAttachments(session) {
    if (!session || !session.attachmentDir) return;
    try {
      fs.rmSync(session.attachmentDir, { recursive: true, force: true });
    } catch (_) {
      // Keep failed deletions counted so the live-file cap stays conservative.
      return;
    }
    session.attachmentDir = null;
    this._materializedAttachmentBytes = Math.max(
      0,
      this._materializedAttachmentBytes - (session.materializedAttachmentBytes || 0)
    );
    session.materializedAttachmentBytes = 0;
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async _teardownSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    // Delete first so late events cannot resurrect a dying session.
    this._sessions.delete(sessionId);
    session.driver.removeListener('provider-event', session.onProviderEvent);
    try {
      await session.driver.stopSession();
    } catch (_) {
      /* child already gone */
    } finally {
      this._discardAttachments(session);
    }
  }

  /**
   * @param {string} sessionId
   * @returns {{ driver: Object, agent: string, onProviderEvent: Function }}
   */
  _mustGetSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error('Unknown driver chat session');
    return session;
  }

  _mustGetWritableSession(sessionId) {
    const session = this._mustGetSession(sessionId);
    if (session.readOnly) {
      throw new Error('This chat is read-only while another client is using the conversation');
    }
    return session;
  }
}

module.exports = {
  DriverChatManager,
  SESSION_EVENT,
  SESSION_STARTING,
  SESSION_STARTED,
  SUPPORTED_AGENTS,
  defaultCreateDriver
};
