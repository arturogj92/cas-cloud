/**
 * Antigravity headless chat driver.
 *
 * Antigravity does not expose ACP or another persistent structured protocol.
 * Its supported non-interactive surface is one `agy --print` process per turn,
 * resumed with `--conversation <id>`. `--output-format stream-json` still gives
 * us canonical message/tool/usage events while Antigravity itself persists the
 * conversation that its TUI later resumes.
 *
 * Print mode cannot stop to ask permissions. Chat therefore runs Antigravity in
 * its terminal sandbox with explicit auto-approval; the switch confirmation
 * discloses that provider-specific constraint to the user.
 */
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProviderEvent } = require('./provider-events');
const {
  promptWithFileReferences,
  createChatImageDirectory,
  materializeChatImages
} = require('./chat-attachments');
const { CHAT_ANSWER_PLACEMENT_PREAMBLE } = require('./chat-answer-placement');
const { CHAT_HISTORY_EVENT_LIMIT } = require('./chat-history-limits');
const defaultConversationReader = require('../services/antigravity-conversation-reader');
const {
  registerAntigravityCapability,
  unregisterAntigravityCapability
} = require('../mcp/antigravity-mcp-launcher');
const { mergeSessionCommunicationEnv } = require('./session-communication-env');

const PROVIDER = 'antigravity';
const DEFAULT_STOP_GRACE_MS = 1500;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10000;
const SUBAGENT_DESCRIPTION_LIMIT = 120;
const TEXT_ONLY_AGENT = 'codeagentswarm-title';
/** How long a message to a subagent waits for the parent's turn to end. */
const SUBAGENT_SEND_WAIT_MS = 5 * 60 * 1000;
const SUBAGENT_SEND_POLL_MS = 500;

/**
 * Where Antigravity writes a conversation's clean transcript.
 *
 * A subagent invocation reports this path as a `file://` uri, but a child of a
 * turn this process never streamed (or one whose uri is malformed) still lives
 * at the conventional location under the brain directory.
 *
 * @param {string} conversationId
 * @returns {string}
 */
function defaultTranscriptPath(conversationId) {
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
}

/**
 * Turn the `log_uri` of a subagent invocation into a plain path.
 * @param {string} [logUri]
 * @returns {string} An empty string when the uri is missing or unusable.
 */
function transcriptPathFromUri(logUri) {
  if (!logUri) return '';
  try {
    return new URL(String(logUri)).pathname;
  } catch (_) {
    return '';
  }
}

function writeTextOnlyAgent(cwd) {
  const agentDir = path.join(cwd, '.agents', 'agents', TEXT_ONLY_AGENT);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.md'), [
    '---',
    `name: ${TEXT_ONLY_AGENT}`,
    'description: Generate a short conversation title without tools.',
    'mainAgent: true',
    'subagent: false',
    'inheritCustomizations: false',
    'tools: []',
    'mcpServers: []',
    'skills: []',
    'plugins: []',
    '---',
    'Return only the requested title.'
  ].join('\n'));
}

/**
 * The subagent row a `step_type: "subagent"` update stands for.
 * @param {{agentType: string, description: string}} entry
 * @param {string} conversationId The child conversation id.
 * @param {string} status Canonical item status.
 * @returns {Object}
 */
function subagentRowPayload(entry, conversationId, status) {
  return {
    itemType: 'collab_agent_tool_call',
    status,
    title: 'Subagent task',
    detail: entry.description,
    data: {
      subagent: {
        agentType: entry.agentType,
        description: entry.description,
        background: true,
        taskId: conversationId
      }
    }
  };
}

function extractUserRequest(content) {
  const text = typeof content === 'string' ? content : '';
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return (match ? match[1] : text).trim();
}

/**
 * Converts Antigravity's clean transcript into the same completed message rows
 * every other driver returns when resuming a conversation.
 */
function parseAntigravityHistory(text, threadId) {
  const events = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch (_) {
      continue;
    }

    let itemType;
    let message;
    if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
      itemType = 'user_message';
      message = extractUserRequest(step.content);
    } else if (
      step.source === 'MODEL'
      && step.type === 'PLANNER_RESPONSE'
      && typeof step.content === 'string'
    ) {
      itemType = 'assistant_message';
      message = step.content.trim();
    }
    if (!itemType || !message) continue;

    events.push(createProviderEvent({
      type: 'item.completed',
      createdAt: typeof step.created_at === 'string' ? step.created_at : null,
      itemId: `history-${step.step_index ?? index}-${itemType}`,
      payload: {
        itemType,
        status: 'completed',
        data: { text: message, history: true }
      },
      raw: {
        source: 'antigravity.transcript',
        method: step.type,
        payload: step
      }
    }, { provider: PROVIDER, threadId, executionOrigin: 'main' }));
  }
  return events.slice(-CHAT_HISTORY_EVENT_LIMIT);
}

function itemTypeForTool(toolName) {
  const name = String(toolName || '').toLowerCase();
  if (/write|replace|edit|delete|move|rename|notebook/.test(name)) return 'file_change';
  if (/command|shell|terminal|execute/.test(name)) return 'command_execution';
  if (/mcp/.test(name)) return 'mcp_tool_call';
  if (/browser|web|url/.test(name)) return 'web_search';
  if (/image|screenshot/.test(name)) return 'image_view';
  return 'dynamic_tool_call';
}

function toolDetail(toolInfo) {
  if (!toolInfo || typeof toolInfo !== 'object') return '';
  const parameters = toolInfo.parameters || toolInfo.args;
  if (!parameters || typeof parameters !== 'object') return '';
  const value = parameters.TargetFile
    || parameters.AbsolutePath
    || parameters.CommandLine
    || parameters.command
    || parameters.path
    || parameters.query;
  return typeof value === 'string' ? value : '';
}

function effortFromModelId(modelId) {
  const match = String(modelId || '').match(/-(low|medium|high)$/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Parse `agy models`, whose public output is one tab-separated id/label pair
 * per line. Antigravity publishes reasoning variants as separate stable slugs;
 * group only bases with multiple advertised efforts so the UI cannot invent an
 * effort option for fixed models such as Claude.
 */
function parseModelCatalog(stdout) {
  const entries = String(stdout || '').split(/\r?\n/)
    .map((line) => {
      const [rawId, ...rawName] = line.trim().split('\t');
      const id = String(rawId || '').trim();
      return id ? {
        id,
        name: rawName.join('\t').trim() || id,
        effort: effortFromModelId(id)
      } : null;
    })
    .filter(Boolean);
  const variantsByBase = new Map();

  for (const entry of entries) {
    if (!entry.effort) continue;
    const baseId = entry.id.slice(0, -(entry.effort.length + 1));
    const variants = variantsByBase.get(baseId) || [];
    variants.push(entry);
    variantsByBase.set(baseId, variants);
  }

  const emittedBases = new Set();
  return entries.flatMap((entry) => {
    const baseId = entry.effort
      ? entry.id.slice(0, -(entry.effort.length + 1))
      : entry.id;
    const variants = variantsByBase.get(baseId) || [];
    if (variants.length < 2) {
      return [{ id: entry.id, name: entry.name, efforts: [], variantIds: [entry.id] }];
    }
    if (emittedBases.has(baseId)) return [];
    emittedBases.add(baseId);
    return [{
      id: baseId,
      name: entry.name.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, ''),
      efforts: variants.map((variant) => variant.effort),
      variantIds: variants.map((variant) => variant.id)
    }];
  });
}

class AntigravityPrintDriver extends EventEmitter {
  constructor({
    binaryPath = 'agy',
    env,
    spawnFn,
    execFileFn,
    processRegistry,
    conversationReader,
    readFileFn,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    modelListTimeoutMs = DEFAULT_MODEL_LIST_TIMEOUT_MS
  } = {}) {
    super();
    this._binaryPath = binaryPath;
    this._env = { ...(env || {}) };
    this._spawnFn = spawnFn || spawn;
    this._execFileFn = execFileFn || execFile;
    this._processRegistry = processRegistry
      || (!spawnFn ? require('../platform/spawned-process-registry') : null);
    this._conversationReader = conversationReader || defaultConversationReader;
    this._readFileFn = readFileFn || ((filePath) => fs.readFileSync(filePath, 'utf8'));
    this._stopGraceMs = stopGraceMs;
    this._modelListTimeoutMs = modelListTimeoutMs;
    this._state = 'idle';
    this._cwd = null;
    this._threadId = null;
    this._model = '';
    this._effort = '';
    this._modelEfforts = new Map();
    this._modelEffortSelections = new Map();
    this._active = null;
    this._sessionExited = false;
    this._attachmentDir = null;
    /** Session instructions ride on the first prompt; see `sendTurn`. */
    this._answerPlacementSent = false;
    // Child conversation id -> {agentType, description, logPath, rowOpen}.
    // It outlives the turn that spawned each child: an earlier turn's subagent
    // stays browsable for as long as the session lives.
    this._subagents = new Map();
  }

  get threadId() {
    return this._threadId;
  }

  async startSession({
    cwd,
    resumeSessionId,
    model,
    effort,
    toolsDisabled = false,
    ephemeral = false
  } = {}) {
    if (this._state !== 'idle') throw new Error('Antigravity chat session already started');
    this._state = 'starting';
    this._cwd = cwd || process.cwd();
    this._threadId = resumeSessionId || null;
    this._model = model || '';
    this._effort = effort || '';
    this._toolsDisabled = toolsDisabled === true;
    this._ephemeral = ephemeral === true;
    if (this._toolsDisabled) writeTextOnlyAgent(this._cwd);
    this._emit({ type: 'session.state.changed', payload: { state: 'starting' } });

    const historyEvents = resumeSessionId ? this._readHistory(resumeSessionId) : [];
    this._state = 'ready';
    if (resumeSessionId) {
      this._emit({
        type: 'thread.started',
        threadId: resumeSessionId,
        payload: { providerThreadId: resumeSessionId }
      });
    }
    this._emit({ type: 'session.state.changed', payload: { state: 'ready' } });

    return {
      threadId: resumeSessionId || '',
      cwd: this._cwd,
      model: this._model,
      effort: this._effort,
      historyEvents
    };
  }

  async sendTurn({ text, attachments = [] } = {}) {
    if (this._state !== 'ready') throw new Error('Antigravity chat session is not ready');
    const materializedImages = this._materializeImages(attachments);
    const promptText = promptWithFileReferences(text, [
      ...attachments.filter((attachment) => attachment.type === 'file'),
      ...materializedImages
    ]);
    if (!promptText) throw new Error('sendTurn requires non-empty text or attachments');
    // `agy --help` exposes no instructions flag, so the session rule travels on
    // the first prompt. Later turns resume the same conversation with
    // `--conversation`, which already carries it in the agent's history.
    const prompt = this._answerPlacementSent
      ? promptText
      : `${CHAT_ANSWER_PLACEMENT_PREAMBLE}\n\n${promptText}`;
    this._answerPlacementSent = true;

    const turnId = crypto.randomUUID();
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--print-timeout',
      '5m',
      '--sandbox',
      // Without an explicit workspace Antigravity silently seats headless
      // sessions in ~/.gemini/.../scratch even when the process cwd is correct.
      // Adding the recorded conversation directory keeps file tools in the
      // same project the TUI was using.
      '--add-dir',
      this._cwd
    ];
    if (this._toolsDisabled) {
      args.push(
        '--agent',
        TEXT_ONLY_AGENT,
        '--mode',
        'plan',
        '--disable-slash-commands'
      );
    }
    else args.push('--dangerously-skip-permissions');
    const extraDirectories = new Set([
      ...attachments
        .filter((attachment) => attachment.type === 'file')
        .map((attachment) => path.dirname(attachment.path)),
      ...materializedImages.map((attachment) => path.dirname(attachment.path))
    ]);
    for (const directory of extraDirectories) {
      if (directory && directory !== this._cwd) args.push('--add-dir', directory);
    }
    if (this._threadId) args.push('--conversation', this._threadId);
    if (this._model) args.push('--model', this._model);
    if (this._effort) args.push('--effort', this._effort);

    const proc = this._spawnPrint(args);
    const active = {
      proc,
      turnId,
      stdoutRemainder: '',
      stderr: '',
      assistantItemId: `assistant-${turnId}`,
      assistantStarted: false,
      assistantText: '',
      result: null,
      requestedState: null,
      settled: false,
      resolve: null,
      reject: null
    };
    active.promise = new Promise((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    // Completion is represented by provider events. Keep the private promise
    // for interrupt/stop coordination, but consume failures here so callers can
    // receive the turn id immediately without creating an unhandled rejection.
    active.promise.catch(() => {});
    this._active = active;
    this._state = 'running';

    proc.stdout.on('data', (chunk) => this._handleStdout(active, chunk));
    proc.stderr.on('data', (chunk) => {
      active.stderr = `${active.stderr}${chunk.toString('utf8')}`.slice(-12000);
    });
    proc.once('error', (error) => this._finishTurn(active, {
      state: active.requestedState || 'failed',
      error
    }));
    proc.once('exit', (code, signal) => {
      // agy print's `result` is conversation-scoped, not turn-scoped: once any
      // historical step failed, every later turn of that conversation reports
      // status ERROR plus that stale error even when the new turn succeeded
      // (verified live 2026-08-06, see docs/diagnostics). A turn that exited 0
      // and produced an answer is a success regardless of result.status.
      const answered = Boolean(
        active.assistantText || (active.result && active.result.response)
      );
      const successful = code === 0
        && (!active.result || active.result.status === 'SUCCESS' || answered);
      const state = active.requestedState || (successful ? 'completed' : 'failed');
      const message = active.result && active.result.error
        ? String(active.result.error)
        : active.stderr.trim() || `Antigravity exited with code ${code}${signal ? ` (${signal})` : ''}`;
      this._finishTurn(active, {
        state,
        ...(state === 'failed' ? { error: new Error(message) } : {})
      });
    });

    this._emit({ type: 'turn.started', turnId, payload: {} });
    this._emit({
      type: 'item.completed',
      turnId,
      itemId: `user-${turnId}`,
      payload: {
        itemType: 'user_message',
        status: 'completed',
        data: { text: typeof text === 'string' ? text.trim() : '', attachments }
      }
    });
    this._emit({ type: 'session.state.changed', payload: { state: 'running' } });
    return { turnId };
  }

  async interruptTurn() {
    if (!this._active) return;
    await this._terminateActive('interrupted');
  }

  async stopSession() {
    if (this._state === 'stopped') return;
    if (this._active) await this._terminateActive('cancelled');
    this._state = 'stopped';
    this._emit({ type: 'session.state.changed', payload: { state: 'stopped' } });
    if (!this._sessionExited) {
      this._sessionExited = true;
      this._emit({
        type: 'session.exited',
        payload: { reason: 'stopped', exitKind: 'graceful', exitCode: 0 }
      });
    }
    if (this._attachmentDir) {
      try { fs.rmSync(this._attachmentDir, { recursive: true, force: true }); } catch (_) {}
      this._attachmentDir = null;
    }
    if (this._ephemeral && this._threadId) {
      const conversationsDir = this._conversationReader.getConversationsDir?.();
      const brainDir = this._conversationReader.getBrainDir?.();
      const conversationFiles = conversationsDir ? [
        path.join(conversationsDir, `${this._threadId}.db`),
        path.join(conversationsDir, `${this._threadId}.db-wal`),
        path.join(conversationsDir, `${this._threadId}.db-shm`)
      ] : [];
      for (const filePath of conversationFiles) {
        try { fs.rmSync(filePath, { force: true }); } catch (_) {}
      }
      if (brainDir) {
        try {
          fs.rmSync(path.join(brainDir, this._threadId), { recursive: true, force: true });
        } catch (_) {}
      }
    }
    this._subagents.clear();
  }

  /**
   * Spawn one `agy --print` process and track its pid like every other child.
   *
   * Cleanup is scoped by pid (never by process name), so anything this driver
   * starts has to go through here.
   *
   * @param {string[]} args
   * @returns {import('child_process').ChildProcess}
   */
  _spawnPrint(args) {
    const childEnv = mergeSessionCommunicationEnv(process.env, this._env);
    const proc = this._spawnFn(this._binaryPath, args, {
      cwd: this._cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (Number.isInteger(proc.pid)) {
      if (this._processRegistry) this._processRegistry.register(proc.pid);
      let capability = null;
      try { capability = registerAntigravityCapability(proc.pid, childEnv); } catch (_) {}
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (this._processRegistry) this._processRegistry.unregister(proc.pid);
        if (capability) unregisterAntigravityCapability(capability);
      };
      proc.once('exit', cleanup);
      proc.once('error', cleanup);
    }
    return proc;
  }

  /**
   * Read one subagent's own conversation from its transcript on disk.
   *
   * A subagent invocation is a real Antigravity conversation with its own
   * clean transcript, in the very format a resumed conversation is rebuilt
   * from — so the child's timeline is just that file, parsed.
   *
   * @param {{taskId: string, known?: {size: number, mtimeMs: number}}} params
   *   `taskId` is the child conversation id carried by the row.
   * @returns {Promise<Object>} `{agentId, agentType, description, running,
   *   talk, events, fileSize, fileMtimeMs}`, or `{..., unchanged: true}`.
   */
  async openSubagentConversation({ taskId, known } = {}) {
    const notFound = () => new Error('Subagent conversation not found on disk');
    if (!taskId) throw notFound();
    const entry = this._subagents.get(taskId);
    const transcriptPath = (entry && entry.logPath) || defaultTranscriptPath(taskId);

    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch (_) {
      throw notFound();
    }

    // Children die with the print process that invoked them, so a child is
    // still working only while its parent turn is in flight.
    const running = Boolean(this._active) && Boolean(entry && entry.rowOpen);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
      return { agentId: taskId, running, talk: 'direct', unchanged: true };
    }

    return {
      agentId: taskId,
      agentType: (entry && entry.agentType) || 'subagent',
      description: (entry && entry.description) || '',
      running,
      talk: 'direct',
      events: parseAntigravityHistory(this._readFileFn(transcriptPath), taskId),
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs
    };
  }

  /**
   * Deliver a message straight to a subagent, no parent relay.
   *
   * A subagent is an ordinary conversation, so a short-lived print process
   * resumed on the child's id prompts it directly. Its stream is dropped: the
   * open frame re-reads the child's transcript from disk, which is where both
   * the delivered message and the reply show up.
   *
   * @param {{taskId: string, text: string}} params
   * @returns {Promise<{delivered: true}>}
   */
  async sendToSubagentConversation({ taskId, text } = {}) {
    if (!taskId) throw new Error('Subagent conversation not found on disk');
    // Antigravity print mode runs one process at a time; a courier racing the
    // parent turn over the same conversation store is a corruption. Waiting for
    // the turn beats refusing: the user typed the message for a reason, and
    // making them retype it later is the same wait with extra steps.
    await this._awaitIdleParent();

    const args = [
      '--conversation',
      taskId,
      '-p',
      text,
      '--output-format',
      'stream-json',
      '--print-timeout',
      '5m',
      '--dangerously-skip-permissions',
      '--sandbox'
    ];
    if (this._cwd) args.push('--add-dir', this._cwd);
    const proc = this._spawnPrint(args);

    return new Promise((resolve, reject) => {
      if (proc.stdout) proc.stdout.resume();
      if (proc.stderr) proc.stderr.resume();
      proc.once('error', reject);
      proc.once('exit', () => resolve({ delivered: true }));
    });
  }

  /**
   * Wait until no print process of this session is running.
   *
   * Bounded: a parent turn that never ends must surface as a failed delivery
   * the user can see and retry, not as a promise that hangs for the rest of the
   * session with the message stuck in the composer's outbox.
   *
   * @returns {Promise<void>}
   * @throws {Error} When the parent is still busy at the ceiling.
   */
  async _awaitIdleParent() {
    const deadline = Date.now() + SUBAGENT_SEND_WAIT_MS;
    while (this._active) {
      if (Date.now() >= deadline) {
        throw new Error("the main agent's turn is still running");
      }
      await new Promise((resolve) => setTimeout(resolve, SUBAGENT_SEND_POLL_MS));
    }
  }

  _materializeImages(attachments) {
    const images = (attachments || []).filter((attachment) => attachment.type === 'image');
    if (!images.length) return [];
    if (!this._attachmentDir) this._attachmentDir = createChatImageDirectory();
    return materializeChatImages(images, this._attachmentDir);
  }

  async listModels() {
    const stdout = await new Promise((resolve, reject) => {
      const child = this._execFileFn(
        this._binaryPath,
        ['models'],
        {
          cwd: this._cwd || process.cwd(),
          env: mergeSessionCommunicationEnv(process.env, this._env),
          timeout: this._modelListTimeoutMs,
          killSignal: 'SIGTERM',
          maxBuffer: 1024 * 1024
        },
        (error, output, stderr) => {
          // agy 1.1.x can print the complete catalog and keep its event loop
          // alive. Node then reaches the timeout and reports an error even
          // though the useful result is already in stdout; prefer that result.
          if (String(output || '').trim()) {
            resolve(String(output));
            return;
          }
          if (error) {
            reject(new Error(String(stderr || error.message || 'Could not list Antigravity models').trim()));
            return;
          }
          resolve(String(output || ''));
        }
      );
      if (this._processRegistry && child && Number.isInteger(child.pid)) {
        this._processRegistry.register(child.pid);
        child.once('exit', () => this._processRegistry.unregister(child.pid));
      }
      // `agy models` waits for stdin to close when it is launched through
      // execFile (unlike a shell pipeline). Without this EOF it prints nothing
      // and survives until the timeout, so the selector always looked empty.
      if (child && child.stdin && typeof child.stdin.end === 'function') {
        child.stdin.end();
      }
    });
    const catalog = parseModelCatalog(stdout);
    const selected = catalog.find((model) => (
      model.id === this._model || model.variantIds.includes(this._model)
    )) || (!this._model ? catalog[0] : null);
    if (selected) {
      const selectedVariant = selected.variantIds.find((id) => id === this._model);
      const variantEffort = effortFromModelId(selectedVariant);
      this._model = selected.id;
      this._effort = selected.efforts.includes(variantEffort || this._effort)
        ? (variantEffort || this._effort)
        : (selected.efforts[0] || '');
    }
    this._modelEfforts = new Map(catalog.map((model) => [model.id, model.efforts]));
    this._modelEffortSelections = new Map(catalog.map((model) => {
      const candidate = model.id === this._model
        ? this._effort
        : this._modelEffortSelections.get(model.id);
      return [
        model.id,
        model.efforts.includes(candidate) ? candidate : (model.efforts[0] || '')
      ];
    }));
    if (selected) this._effort = this._modelEffortSelections.get(this._model) || '';

    return catalog.map(({ id, name, efforts }) => ({
      id,
      name,
      current: id === this._model,
      capabilities: {
        optionDescriptors: efforts.length ? [{
          id: 'effort',
          label: 'Reasoning',
          type: 'select',
          options: efforts.map((effort, index) => ({
            id: effort,
            label: effort[0].toUpperCase() + effort.slice(1),
            ...(index === 0 ? { isDefault: true } : {})
          })),
          currentValue: this._modelEffortSelections.get(id)
        }] : []
      }
    }));
  }

  async setConfigOption(configId, value) {
    if (configId === 'model') {
      this._model = String(value || '');
      this._effort = this._modelEffortSelections.get(this._model) || '';
      return { success: true };
    }
    if (configId === 'effort') {
      const effort = String(value || '');
      if (!(this._modelEfforts.get(this._model) || []).includes(effort)) {
        throw new Error(`Unsupported Antigravity effort for ${this._model}: ${effort}`);
      }
      this._effort = effort;
      this._modelEffortSelections.set(this._model, effort);
      return { success: true };
    }
    throw new Error(`Unsupported Antigravity config option: ${configId}`);
  }

  async respondToRequest() {
    throw new Error('Antigravity print mode does not expose interactive requests');
  }

  _readHistory(threadId) {
    const candidates = [
      this._conversationReader.getFullTranscriptPath(threadId),
      this._conversationReader.getTranscriptPath(threadId)
    ];
    for (const filePath of candidates) {
      try {
        return parseAntigravityHistory(this._readFileFn(filePath), threadId);
      } catch (_) {
        // Try the truncated transcript when the full one is not present yet.
      }
    }
    return [];
  }

  _handleStdout(active, chunk) {
    if (active !== this._active || active.settled) return;
    active.stdoutRemainder += chunk.toString('utf8');
    let newline;
    while ((newline = active.stdoutRemainder.indexOf('\n')) !== -1) {
      const line = active.stdoutRemainder.slice(0, newline).trim();
      active.stdoutRemainder = active.stdoutRemainder.slice(newline + 1);
      if (!line) continue;
      try {
        this._handleMessage(active, JSON.parse(line));
      } catch (error) {
        this._emit({
          type: 'runtime.warning',
          turnId: active.turnId,
          payload: {
            message: 'Malformed Antigravity stream message',
            detail: { line, error: error.message }
          }
        });
      }
    }
  }

  _handleMessage(active, message) {
    const reportedThreadId = message.conversation_id
      || message.init?.conversation_id
      || message.step_update?.conversation_id
      || message.result?.conversation_id;
    if (reportedThreadId && reportedThreadId !== this._threadId) {
      this._threadId = reportedThreadId;
      this._emit({
        type: 'thread.started',
        threadId: reportedThreadId,
        payload: { providerThreadId: reportedThreadId }
      });
    }

    if (message.event === 'step_update') {
      this._handleStepUpdate(active, message.step_update || {});
      return;
    }
    if (message.event === 'result') {
      active.result = message.result || {};
      const response = typeof active.result.response === 'string'
        ? active.result.response
        : '';
      if (response && !active.assistantText) this._appendAssistant(active, response);
    }
  }

  _handleStepUpdate(active, update) {
    if (update.step_type === 'agent_response' && typeof update.text_delta === 'string') {
      this._appendAssistant(active, update.text_delta);
    }
    if (update.step_type === 'tool') {
      const state = String(update.state || '').toUpperCase();
      const toolStepId = update.step_index ?? (update.tool_name || 'unknown');
      const itemId = `tool-${active.turnId}-${toolStepId}`;
      const itemType = itemTypeForTool(update.tool_name);
      const failed = state === 'FAILED' || state === 'ERROR';
      this._emit({
        type: state === 'ACTIVE' ? 'item.started' : 'item.completed',
        turnId: active.turnId,
        itemId,
        payload: {
          itemType,
          status: state === 'ACTIVE' ? 'inProgress' : failed ? 'failed' : 'completed',
          title: update.tool_name || 'Antigravity tool',
          ...(toolDetail(update.tool_info) ? { detail: toolDetail(update.tool_info) } : {}),
          data: {
            toolName: update.tool_name,
            ...(update.tool_info ? { toolInfo: update.tool_info } : {})
          }
        },
        raw: {
          source: 'antigravity.stream-json',
          method: 'step_update',
          payload: update
        }
      });
    }
    if (update.step_type === 'subagent') {
      this._registerSubagents(active, update);
    }
    if (update.usage && typeof update.usage === 'object') {
      this._emit({
        type: 'thread.token-usage.updated',
        turnId: active.turnId,
        payload: {
          usage: {
            usedTokens: Number(update.usage.total_tokens) || 0,
            inputTokens: Number(update.usage.input_tokens) || 0,
            outputTokens: Number(update.usage.output_tokens) || 0,
            reasoningOutputTokens: Number(update.usage.thinking_tokens) || 0,
            cachedInputTokens: Number(update.usage.cache_read_tokens) || 0
          }
        }
      });
    }
  }

  /**
   * Open a timeline row for every subagent this update invokes for the first time.
   *
   * Antigravity reports the same invocation twice (ACTIVE, then DONE) with an
   * identical payload, and its DONE only means "invoked" — the child keeps
   * working for the rest of the parent turn. The second report is therefore
   * ignored and the row stays in progress.
   *
   * @param {Object} active The turn in flight.
   * @param {Object} update The `step_type: "subagent"` step update.
   * @returns {void}
   */
  _registerSubagents(active, update) {
    const invocations = update.subagent_info && Array.isArray(update.subagent_info.subagents)
      ? update.subagent_info.subagents
      : [];
    for (const invocation of invocations) {
      const conversationId = invocation && invocation.conversation_id;
      if (!conversationId || this._subagents.has(conversationId)) continue;
      const entry = {
        agentType: invocation.type_name || invocation.role || 'subagent',
        description: String(invocation.initial_prompt || invocation.role || '')
          .slice(0, SUBAGENT_DESCRIPTION_LIMIT),
        logPath: transcriptPathFromUri(invocation.log_uri),
        rowOpen: true
      };
      this._subagents.set(conversationId, entry);
      this._emit({
        type: 'item.started',
        turnId: active.turnId,
        itemId: `subagent-${conversationId}`,
        payload: subagentRowPayload(entry, conversationId, 'inProgress'),
        raw: {
          source: 'antigravity.stream-json',
          method: 'step_update',
          payload: update
        }
      });
    }
  }

  /**
   * Close every subagent row the finishing turn still holds open.
   * @param {Object} active The turn being settled.
   * @returns {void}
   */
  _closeSubagentRows(active) {
    for (const [conversationId, entry] of this._subagents) {
      if (!entry.rowOpen) continue;
      entry.rowOpen = false;
      this._emit({
        type: 'item.completed',
        turnId: active.turnId,
        itemId: `subagent-${conversationId}`,
        payload: subagentRowPayload(entry, conversationId, 'completed')
      });
    }
  }

  _appendAssistant(active, delta) {
    if (!delta) return;
    if (!active.assistantStarted) {
      active.assistantStarted = true;
      this._emit({
        type: 'item.started',
        turnId: active.turnId,
        itemId: active.assistantItemId,
        payload: { itemType: 'assistant_message', status: 'inProgress' }
      });
    }
    active.assistantText += delta;
    this._emit({
      type: 'content.delta',
      turnId: active.turnId,
      itemId: active.assistantItemId,
      payload: { streamKind: 'assistant_text', delta }
    });
  }

  _finishTurn(active, { state, error } = {}) {
    if (active.settled) return;
    active.settled = true;
    if (active.assistantStarted) {
      this._emit({
        type: 'item.completed',
        turnId: active.turnId,
        itemId: active.assistantItemId,
        payload: {
          itemType: 'assistant_message',
          status: state === 'failed' ? 'failed' : 'completed',
          data: { text: active.assistantText }
        }
      });
    }
    // A subagent lives inside the parent print process, so the turn ending is
    // the terminal edge of every child it invoked.
    this._closeSubagentRows(active);
    if (error) {
      this._emit({
        type: 'runtime.error',
        turnId: active.turnId,
        payload: {
          message: error.message,
          class: 'provider_error'
        }
      });
    }
    this._emit({
      type: 'turn.completed',
      turnId: active.turnId,
      payload: {
        state,
        ...(error ? { errorMessage: error.message } : {})
      }
    });
    this._active = null;
    if (this._state !== 'stopped') {
      this._state = 'ready';
      this._emit({ type: 'session.state.changed', payload: { state: 'ready' } });
    }
    if (state === 'failed') active.reject(error || new Error('Antigravity turn failed'));
    else active.resolve({ turnId: active.turnId });
  }

  async _terminateActive(state) {
    const active = this._active;
    if (!active) return;
    active.requestedState = state;
    try { active.proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
    let timer;
    await Promise.race([
      active.promise.catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, this._stopGraceMs);
      })
    ]);
    clearTimeout(timer);
    if (!active.settled) {
      try { active.proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      let killTimer;
      await Promise.race([
        active.promise.catch(() => {}),
        new Promise((resolve) => {
          killTimer = setTimeout(resolve, this._stopGraceMs);
        })
      ]);
      clearTimeout(killTimer);
    }
    if (!active.settled) this._finishTurn(active, { state });
  }

  _emit(bareEvent) {
    this.emit('provider-event', createProviderEvent(bareEvent, {
      provider: PROVIDER,
      ...(this._threadId ? { threadId: this._threadId } : {}),
      executionOrigin: 'main'
    }));
  }
}

module.exports = {
  AntigravityPrintDriver,
  parseAntigravityHistory,
  extractUserRequest,
  itemTypeForTool
};
