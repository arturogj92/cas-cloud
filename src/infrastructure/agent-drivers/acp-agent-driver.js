/**
 * ACP driver shared by OpenCode, Kimi Code, Grok Build and Cursor Agent.
 *
 * Both CLIs expose the Agent Client Protocol over newline-delimited JSON-RPC:
 *   opencode acp --cwd <dir>
 *   kimi acp
 *
 * This module deliberately implements only the client surface CodeAgentSwarm
 * owns (initialize, session load/new/prompt/cancel, config options and
 * permission responses). Provider-specific wire data is translated immediately
 * into the same canonical events used by Codex and Claude.
 *
 * Normalizes ACP sessions into the shared provider event model.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { isNativeExe, quoteForCmd } = require('../platform/windows-direct-spawn');
const { parseJsonRpcChunk } = require('./jsonrpc-line-parser');
const { createProviderEvent } = require('./provider-events');
const { promptWithFileReferences, splitDataUrl } = require('./chat-attachments');
const { CHAT_ANSWER_PLACEMENT_PREAMBLE } = require('./chat-answer-placement');
const { normalizeSlashCommands } = require('./slash-commands');
const { CHAT_HISTORY_EVENT_LIMIT } = require('./chat-history-limits');
const { cleanCursorUserText } = require('../services/cursor-conversation-reader');
const { cleanGrokUserText } = require('../services/grok-conversation-reader');
const { mergeSessionCommunicationEnv } = require('./session-communication-env');
const {
  THOUGHT_PARAM_IDS,
  parseCursorModelId,
  cursorUsesExplodedIds,
  buildCursorModelCatalog,
  cursorWireModelId,
  cursorWireIdForParamChange,
  cursorEffortFromParsed
} = require('./cursor-model-catalog');

const PROVIDER_EVENT_CHANNEL = 'provider-event';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const CAPABILITY_PROBE_TIMEOUT_MS = 10000;
const HISTORY_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_STOP_GRACE_MS = 1500;
const AGENT_BUSY_ERROR_CODE = 'turn.agent_busy';
const AGENT_BUSY_MESSAGE_PATTERN = /Cannot launch a new turn while another turn/i;
// A single Kimi answer has been observed occupying the session for ~2m45s while
// it chains internal turns, so the budget has to outlast a long run by a wide
// margin: giving up early would lose the user's message, which is the very bug
// the retry exists to fix. Stopping the turn releases the wait immediately.
const DEFAULT_AGENT_BUSY_RETRY = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 5000,
  budgetMs: 600000
});
const GROK_EFFORT_LEVELS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]);
const CODEAGENTSWARM_SESSION_ENV_KEYS = Object.freeze([
  'CODEAGENTSWARM_ACTIVE_SESSION',
  'CODEAGENTSWARM_CURRENT_QUADRANT',
  'CODEAGENTSWARM_AGENT_TYPE',
  'CODEAGENTSWARM_TERMINAL_ID',
  'CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED',
  'CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED',
  'CODEAGENTSWARM_SESSION_BRIDGE_PORT',
  'CODEAGENTSWARM_SESSION_BRIDGE_TOKEN',
  'CODEAGENTSWARM_DRIVER_CHAT'
]);

const ACP_TOOL_KIND_TO_ITEM = Object.freeze({
  read: 'dynamic_tool_call',
  edit: 'file_change',
  delete: 'file_change',
  move: 'file_change',
  search: 'web_search',
  execute: 'command_execution',
  think: 'reasoning',
  fetch: 'web_search',
  switch_mode: 'dynamic_tool_call',
  other: 'dynamic_tool_call'
});

/** Lowercased tool titles that mean "delegate to a subagent". Exact matches. */
const ACP_SUBAGENT_TITLES = Object.freeze(['agent', 'task']);

const ACP_TOOL_STATUS = Object.freeze({
  pending: 'inProgress',
  in_progress: 'inProgress',
  completed: 'completed',
  failed: 'failed'
});

function defaultBinaryPath(provider) {
  if (provider === 'cursor') {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA
        || path.win32.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local');
      return path.win32.join(localAppData, 'cursor-agent', 'cursor-agent.cmd');
    }
    return path.join(os.homedir(), '.local', 'bin', 'cursor-agent');
  }
  if (provider === 'kimi') {
    const installed = path.join(os.homedir(), '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
    return installed;
  }
  if (provider === 'grok') {
    return path.join(
      process.env.GROK_HOME || path.join(os.homedir(), '.grok'),
      'bin',
      process.platform === 'win32' ? 'grok.exe' : 'grok'
    );
  }
  return 'opencode';
}

function defaultBinaryArgs(provider, cwd, effort, toolsDisabled = false) {
  if (provider === 'opencode') return ['acp', '--cwd', cwd];
  if (provider === 'cursor') return ['acp'];
  if (provider === 'grok') {
    return [
      ...(toolsDisabled ? ['--tools', ''] : []),
      ...(effort ? ['--effort', effort] : []),
      'agent',
      'stdio'
    ];
  }
  if (provider === 'kimi' && toolsDisabled) {
    return ['--agent-file', path.join(cwd, '.codeagentswarm-title-agent.md'), 'acp'];
  }
  return ['acp'];
}

function killWindowsProcessTree(pid) {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false
    });
    killer.once('error', reject);
    killer.once('exit', (code) => {
      if (code === 0 || code === 128) resolve();
      else reject(new Error(`taskkill exited with code ${code}`));
    });
  });
}

/**
 * Convert Cursor's user and project mcp.json files to ACP session servers.
 * Project entries override user entries with the same name. Files are read
 * only: invalid or unsupported entries stay untouched and are skipped.
 */
function readCursorMcpServers(cwd, {
  homeDir = os.homedir(),
  capabilities = {},
  sessionEnv = {}
} = {}) {
  const codeAgentSwarmServerPath = path.join(homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks', 'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js');
  const merged = {};
  const projectOverrides = new Set();
  const userConfigPath = path.join(homeDir, '.cursor', 'mcp.json');
  const projectConfigPath = path.join(cwd, '.cursor', 'mcp.json');
  const configFiles = [[userConfigPath, false]];
  if (path.resolve(projectConfigPath) !== path.resolve(userConfigPath)) {
    configFiles.push([projectConfigPath, true]);
  }
  for (const [file, isProject] of configFiles) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (config?.mcpServers && typeof config.mcpServers === 'object') {
        if (isProject) {
          for (const name of Object.keys(config.mcpServers)) projectOverrides.add(name);
        }
        Object.assign(merged, config.mcpServers);
      }
    } catch (_) {
      // Preserve missing and invalid user files exactly as they are.
    }
  }

  const transportCapabilities = capabilities.mcpCapabilities || {};
  return Object.entries(merged).flatMap(([name, config]) => {
    if (!config || typeof config !== 'object' || config.disabled === true) return [];
    if (typeof config.command === 'string' && config.command) {
      const env = { ...(config.env || {}) };
      const configuredServerPath = Array.isArray(config.args) && config.args[0]
        ? path.resolve(String(config.args[0]))
        : '';
      const expectedServerPath = path.resolve(codeAgentSwarmServerPath);
      const isOwnedServer = name === 'codeagentswarm-tasks'
        && !projectOverrides.has(name)
        && config.command === 'node'
        && (process.platform === 'win32'
          ? configuredServerPath.toLowerCase() === expectedServerPath.toLowerCase()
          : configuredServerPath === expectedServerPath);
      if (isOwnedServer) {
        for (const key of CODEAGENTSWARM_SESSION_ENV_KEYS) {
          if (sessionEnv[key] !== undefined) env[key] = String(sessionEnv[key]);
        }
      }
      return [{
        name,
        command: config.command,
        args: Array.isArray(config.args) ? config.args.map(String) : [],
        env: Object.entries(env).map(([key, value]) => ({
          name: key,
          value: String(value)
        }))
      }];
    }
    const type = config.type === 'sse' ? 'sse' : 'http';
    if (
      typeof config.url !== 'string'
      || !config.url
      || transportCapabilities[type] !== true
    ) return [];
    return [{
      type,
      name,
      url: config.url,
      headers: Object.entries(config.headers || {}).map(([key, value]) => ({
        name: key,
        value: String(value)
      }))
    }];
  });
}

/**
 * Read the choices out of one elicitation form property.
 *
 * ACP spells them two ways: `enum` is a bare list of values, `oneOf` a list of
 * `{const, title}` so the agent can label a value. Both collapse to the
 * canonical `{label, description}`, where the label is what gets sent back.
 *
 * @param {Object} property One `requestedSchema.properties` entry.
 * @returns {Array<{label: string, description: string}>} Empty when free-text.
 */
function acpPropertyOptions(property) {
  if (Array.isArray(property?.oneOf)) {
    return property.oneOf
      .map((choice) => ({
        label: typeof choice?.const === 'string' ? choice.const : '',
        description: typeof choice?.title === 'string' ? choice.title : ''
      }))
      .filter((option) => option.label);
  }
  if (Array.isArray(property?.enum)) {
    return property.enum
      .filter((value) => typeof value === 'string' && value)
      .map((value) => ({ label: value, description: '' }));
  }
  return [];
}

/**
 * Turn an ACP elicitation form into canonical questions, one per property.
 *
 * The canonical `id` is the property name because that is the key ACP expects
 * back in the `accept` content.
 *
 * @param {Object} params Native `session/elicitation` params.
 * @returns {import('./provider-events').CanonicalQuestion[]}
 */
function mapAcpElicitationQuestions(params) {
  const schema = params?.requestedSchema || {};
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const message = typeof params?.message === 'string' ? params.message : '';

  return Object.entries(properties).map(([name, property]) => {
    const options = acpPropertyOptions(property);
    const title = typeof property?.title === 'string' && property.title ? property.title : name;
    const description = typeof property?.description === 'string' ? property.description : '';
    return {
      id: name,
      header: title,
      // The form's own message is the only prompt some agents send, so it is
      // the fallback when a property describes itself with nothing but a name.
      question: description || title || message,
      options,
      multiSelect: false,
      // A closed list still allows typing: ACP has no way to say "these choices
      // are exhaustive", and refusing free text would strand the user.
      allowsFreeText: true,
      allowsNote: true,
      secret: property?.format === 'password'
    };
  });
}

function mapCursorQuestions(params) {
  return (Array.isArray(params?.questions) ? params.questions : []).map((question) => ({
    id: question.id,
    header: params.title || 'Question',
    question: question.prompt,
    options: (Array.isArray(question.options) ? question.options : [])
      .map((option) => ({ label: option.label, description: '' }))
      .filter((option) => option.label),
    multiSelect: question.allowMultiple === true,
    allowsFreeText: false,
    allowsNote: false,
    secret: false
  })).filter((question) => question.id && question.question && question.options.length);
}

function requestTypeForTool(toolCall) {
  switch (toolCall && toolCall.kind) {
    case 'read':
      return 'file_read_approval';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_change_approval';
    case 'execute':
      return 'exec_command_approval';
    default:
      return 'unknown';
  }
}

function contentText(content) {
  if (!content || typeof content !== 'object') return '';
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function toolDetail(update) {
  const rawInput = update && update.rawInput;
  if (rawInput && typeof rawInput === 'object') {
    const value = rawInput.command
      || rawInput.path
      || rawInput.file_path
      || rawInput.query
      || rawInput.pattern;
    if (Array.isArray(value)) return value.join(' ');
    if (typeof value === 'string') return value;
  }
  if (Array.isArray(update && update.locations) && update.locations[0]) {
    return update.locations[0].path || update.locations[0].uri || '';
  }
  return '';
}

/**
 * Who an ACP tool call delegates to, when it delegates at all.
 *
 * ACP has no kind for delegation, so it is recognised from the payload: an
 * explicit `subagent_type` argument, or one of the exact titles the agents use
 * for their delegation tool. The title match is exact on purpose — a substring
 * match would turn every tool with "agent" in its name (`update_terminal_activity`
 * and most MCP tools) into a phantom subagent.
 *
 * @param {Object} update ACP tool_call update.
 * @returns {{agentType?: string, description?: string}|null}
 */
function acpSubagentInfo(update) {
  const rawInput = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {};
  const agentType = typeof rawInput.subagent_type === 'string' && rawInput.subagent_type.trim()
    ? rawInput.subagent_type.trim()
    : '';
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (!agentType && !ACP_SUBAGENT_TITLES.includes(title.toLowerCase())) return null;

  const description = typeof rawInput.description === 'string' && rawInput.description.trim()
    ? rawInput.description.trim()
    : title;
  return {
    ...(agentType ? { agentType } : {}),
    ...(description ? { description } : {})
  };
}

/**
 * Read the context line out of an ACP agent's `usage` command reply.
 *
 * Kimi 0.31.1 answers `/usage` with, verbatim:
 *
 *   Session usage:
 *   - Total: input 28,753, output 161, cache read 50,688, cache creation 0
 *   - kimi-code/k3: input 28,753, output 161, cache read 50,688, cache creation 0
 *   - Context: 39,823 / 1,048,576 (3.8%)
 *
 * Only the `Context:` pair is read, because it is the one number that means the
 * same thing as every other provider's gauge. The per-model totals are left
 * alone: they mix cache reads across requests, exactly the trap that made the
 * Claude gauge report 348K for a 58.8K window.
 *
 * This is a text contract, not a protocol one. If an agent changes its wording
 * the match simply fails and the gauge stays hidden — never a wrong number.
 *
 * @param {string} text Concatenated reply text.
 * @returns {{usedTokens: number, maxTokens: number}|undefined}
 */
function parseAcpUsageReport(text) {
  const match = /Context:\s*([\d.,\s]+?)\s*\/\s*([\d.,\s]+?)\s*(?:\(|$|\n)/m.exec(String(text || ''));
  if (!match) return undefined;
  const toNumber = (raw) => Number(String(raw).replace(/[,\s]/g, ''));
  const usedTokens = toNumber(match[1]);
  const maxTokens = toNumber(match[2]);
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return undefined;
  return {
    usedTokens,
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {})
  };
}

/**
 * Maps one ACP session/update notification to canonical provider events.
 *
 * @param {Object} params ACP notification params.
 * @param {{provider: string, threadId: string, turnId?: string}} context
 * @returns {Object[]} canonical events.
 */
function mapAcpSessionUpdate(params, context) {
  const update = params && params.update;
  if (!update || typeof update.sessionUpdate !== 'string') return [];
  const executionOrigin = executionOriginForThread(
    context.threadId,
    context.rootThreadId
  );
  const providerContext = {
    provider: context.provider,
    threadId: context.threadId,
    executionOrigin
  };
  const envelope = {
    ...(context.turnId ? { turnId: context.turnId } : {}),
    executionOrigin,
    raw: {
      source: 'acp.jsonrpc',
      method: 'session/update',
      payload: params
    }
  };

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      let text = contentText(update.content);
      if (context.provider === 'cursor') text = cleanCursorUserText(text);
      if (context.provider === 'grok') text = cleanGrokUserText(text);
      if (!text) return [];
      const userEnvelope = (context.provider === 'cursor' || context.provider === 'grok')
        ? {
          ...envelope,
          raw: {
            ...envelope.raw,
            payload: {
              ...params,
              update: {
                ...update,
                content: typeof update.content === 'string'
                  ? text
                  : { ...update.content, text }
              }
            }
          }
        }
        : envelope;
      return [createProviderEvent({
        type: 'item.completed',
        ...userEnvelope,
        ...(update.messageId ? { itemId: update.messageId } : {}),
        payload: {
          itemType: 'user_message',
          status: 'completed',
          historical: true,
          data: { text }
        }
      }, providerContext)];
    }
    case 'agent_message_chunk': {
      const delta = contentText(update.content);
      if (!delta) return [];
      return [createProviderEvent({
        type: 'content.delta',
        ...envelope,
        ...(update.messageId ? { itemId: update.messageId } : {}),
        payload: { streamKind: 'assistant_text', delta }
      }, providerContext)];
    }
    case 'agent_thought_chunk': {
      const delta = contentText(update.content);
      if (!delta) return [];
      return [createProviderEvent({
        type: 'content.delta',
        ...envelope,
        ...(update.messageId ? { itemId: update.messageId } : {}),
        payload: { streamKind: 'reasoning_text', delta }
      }, providerContext)];
    }
    case 'tool_call':
    case 'tool_call_update': {
      if (!update.toolCallId) return [];
      const status = ACP_TOOL_STATUS[update.status] || 'inProgress';
      const terminal = status === 'completed' || status === 'failed';
      const subagent = acpSubagentInfo(update);
      const itemType = subagent
        ? 'collab_agent_tool_call'
        : ACP_TOOL_KIND_TO_ITEM[update.kind] || 'dynamic_tool_call';
      return [createProviderEvent({
        type: update.sessionUpdate === 'tool_call' && !terminal
          ? 'item.started'
          : terminal ? 'item.completed' : 'item.updated',
        ...envelope,
        itemId: update.toolCallId,
        payload: {
          itemType,
          status,
          ...(update.title ? { title: update.title } : {}),
          ...(toolDetail(update) ? { detail: toolDetail(update) } : {}),
          data: {
            ...(subagent ? { subagent } : {}),
            ...(update.kind ? { kind: update.kind } : {}),
            ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
            ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
            ...(Array.isArray(update.content) ? { content: update.content } : {})
          }
        }
      }, providerContext)];
    }
    case 'plan': {
      if (!Array.isArray(update.entries)) return [];
      return [createProviderEvent({
        type: 'item.updated',
        ...envelope,
        itemId: `plan-${context.turnId || context.threadId}`,
        payload: {
          itemType: 'plan',
          status: update.entries.every((entry) => entry && entry.status === 'completed')
            ? 'completed'
            : 'inProgress',
          title: 'Plan',
          data: {
            entries: update.entries.map((entry) => ({
              step: entry && entry.content ? entry.content : '',
              status: entry && entry.status ? entry.status : 'pending',
              priority: entry && entry.priority ? entry.priority : 'medium'
            }))
          }
        }
      }, providerContext)];
    }
    case 'usage_update': {
      return [createProviderEvent({
        type: 'thread.token-usage.updated',
        ...envelope,
        payload: {
          usage: {
            usedTokens: Number(update.used) || 0,
            maxTokens: Number(update.size) || 0
          }
        }
      }, providerContext)];
    }
    case 'current_mode_update':
    case 'config_option_update':
    case 'available_commands_update':
    case 'session_info_update':
    default:
      return [];
  }
}

/**
 * ACP does not require child sessions, but when an implementation reports one
 * its session id is the only reliable provenance signal available to us.
 * Missing roots stay unknown and therefore remain visible.
 * @param {string} threadId
 * @param {string} rootThreadId
 * @returns {'main'|'subagent'|'unknown'}
 */
function executionOriginForThread(threadId, rootThreadId) {
  if (!threadId || !rootThreadId) return 'unknown';
  return threadId === rootThreadId ? 'main' : 'subagent';
}

/**
 * Normalize ACP's session-scoped configuration schema to the same
 * model-capability descriptor contract used by Codex and Claude.
 */
function acpOptionDescriptor(option) {
  if (!option || !option.id || option.id === 'model') return null;
  // Cursor repeats Agent/Plan/Ask as ACP `configOptions` id `mode`. The
  // dedicated interaction-mode picker already owns that control. Leave other
  // ACP `mode` options (for example OpenCode session mode) intact.
  if (option.id === 'mode' || option.category === 'mode') {
    const values = (Array.isArray(option.options) ? option.options : [])
      .map((entry) => entry && (entry.value || entry.id))
      .filter(Boolean);
    if (values.length && values.every((value) => ['agent', 'plan', 'ask'].includes(value))) {
      return null;
    }
  }
  const normalizedOptionId = String(option.id).replace(/[-_]/g, '').toLowerCase();
  const reasoningOption = normalizedOptionId === 'thinking'
    || normalizedOptionId === 'effort'
    || normalizedOptionId === 'reasoningeffort';
  const label = reasoningOption
    ? 'Reasoning'
    : option.name || option.label || option.id;

  if (option.type === 'boolean') {
    return {
      id: option.id,
      label,
      type: 'boolean',
      ...(typeof option.currentValue === 'boolean'
        ? { currentValue: option.currentValue }
        : {})
    };
  }

  if (option.type !== 'select' || !Array.isArray(option.options)) return null;
  return {
    id: option.id,
    label,
    type: 'select',
    options: option.options.map((entry) => ({
      id: entry.value || entry.id,
      label: entry.name || entry.label || entry.value || entry.id,
      ...(entry.description ? { description: entry.description } : {})
    })).filter((entry) => entry.id),
    ...(typeof option.currentValue === 'string' && option.currentValue
      ? { currentValue: option.currentValue }
      : {})
  };
}

function isReasoningOptionDescriptor(option) {
  if (!option || !option.id) return false;
  const id = String(option.id).replace(/[-_]/g, '').toLowerCase();
  return id === 'thinking' || id === 'effort' || id === 'reasoningeffort';
}

/**
 * Grok 0.2.x exposes reasoning on each model's `_meta`, not through ACP's
 * top-level configOptions. Preserve that provider-owned order and vocabulary;
 * never manufacture the generic none/minimal/xhigh catalogue in the UI.
 */
function grokReasoningDescriptor(model) {
  const meta = model && model._meta && typeof model._meta === 'object'
    ? model._meta
    : {};
  if (meta.supportsReasoningEffort !== true) return null;
  const advertised = Array.isArray(meta.reasoningEfforts)
    ? meta.reasoningEfforts
    : [];
  const currentValue = typeof meta.reasoningEffort === 'string'
    ? meta.reasoningEffort
    : '';
  const options = advertised.map((entry) => {
    const raw = typeof entry === 'string' ? { id: entry } : (entry || {});
    const id = raw.id || raw.value;
    if (!id) return null;
    const label = raw.name || raw.label
      || (id === 'xhigh' ? 'Extra high' : id.charAt(0).toUpperCase() + id.slice(1));
    return {
      id,
      label,
      ...(raw.description ? { description: raw.description } : {}),
      ...(raw.isDefault === true || id === currentValue ? { isDefault: true } : {})
    };
  }).filter(Boolean);
  if (options.length === 0) return null;
  return {
    id: 'effort',
    label: 'Reasoning',
    type: 'select',
    currentValue: currentValue || options.find((option) => option.isDefault)?.id || options[0].id,
    options
  };
}

function selectedGrokModel(modelState) {
  if (
    !modelState
    || !Array.isArray(modelState.availableModels)
    || modelState.availableModels.length === 0
  ) return null;
  return modelState.availableModels.find(
    (model) => model && model.modelId === modelState.currentModelId
  ) || modelState.availableModels[0];
}

/**
 * Detect the transient "the agent is still busy" rejection of `session/prompt`.
 *
 * Kimi's agent-core resolves the previous prompt on the first `turn.ended`, but
 * its TurnFlow keeps the session occupied while it chains internal turns (goal
 * continuations, step-cap continuations, background-task wake-ups). A prompt
 * submitted in that window is rejected with a structured JSON-RPC error. The
 * message match is only a fallback for agent versions that omit `data`.
 */
function isAgentBusyError(error) {
  if (!error) return false;
  const data = error.rpcData;
  if (data && typeof data === 'object' && data.code === AGENT_BUSY_ERROR_CODE) return true;
  return AGENT_BUSY_MESSAGE_PATTERN.test(String(error.message || ''));
}

class AcpAgentDriver extends EventEmitter {
  constructor({
    provider,
    binaryPath,
    binaryArgs,
    env,
    spawnFn,
    processRegistry,
    treeKillFn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    agentBusyRetry
  } = {}) {
    super();
    if (!['opencode', 'kimi', 'grok', 'cursor'].includes(provider)) {
      throw new Error(`Unsupported ACP provider: ${String(provider)}`);
    }
    this.provider = provider;
    this._binaryPath = binaryPath || defaultBinaryPath(provider);
    this._binaryArgs = Array.isArray(binaryArgs) ? binaryArgs.slice() : null;
    this._env = { ...(env || {}) };
    this._spawnFn = spawnFn || spawn;
    this._treeKillFn = treeKillFn || (!spawnFn ? killWindowsProcessTree : null);
    // Injected spawners are normally unit-test fakes; do not register their
    // made-up PIDs unless a registry is explicitly injected alongside them.
    this._processRegistry = processRegistry
      || (!spawnFn ? require('../platform/spawned-process-registry') : null);
    this._requestTimeoutMs = requestTimeoutMs;
    this._stopGraceMs = stopGraceMs;
    this._agentBusyRetry = { ...DEFAULT_AGENT_BUSY_RETRY, ...(agentBusyRetry || {}) };
    this._pendingDelays = new Set();
    this._state = 'idle';
    this._process = null;
    this._stdoutRemainder = '';
    this._nextRequestId = 1;
    this._pendingRpc = new Map();
    this._pendingApprovals = new Map();
    this._pendingQuestions = new Map();
    this._threadId = null;
    // ACP normally scopes a transport to one session. Keep the root-only
    // default; child ids are admitted only after a matching parent relation.
    this._relatedSessionIds = new Set();
    this._cwd = null;
    this._activeTurnId = null;
    this._cancelRequestedTurnId = null;
    this._promptsInFlight = 0;
    this._promptTail = Promise.resolve();
    this._openAssistantItems = new Set();
    this._openReasoningItems = new Set();
    this._configOptions = [];
    this._availableCommands = [];
    // Non-null only while the driver's own `/usage` reading is in flight; its
    // chunks are collected here instead of reaching the conversation.
    this._usageProbe = null;
    this._modelState = null;
    this._modeState = null;
    this._capabilities = {};
    this._effort = '';
    this._historyEvents = [];
    this._collectingHistory = false;
    this._stopping = false;
    /** Session instructions ride on the first prompt; see `sendTurn`. */
    this._answerPlacementSent = false;
    /** @type {Map<string, number>} subagent toolCallId -> spawn ordinal. */
    this._subagentOrdinals = new Map();
  }

  _initialize(timeoutMs = this._requestTimeoutMs) {
    return this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
        ...(this.provider === 'cursor'
          ? { _meta: { parameterizedModelPicker: true } }
          : {})
      },
      clientInfo: {
        name: 'CodeAgentSwarm',
        title: 'CodeAgentSwarm',
        version: '1.10.0'
      }
    }, timeoutMs);
  }

  async probeCapabilities({ cwd } = {}) {
    if (this._state !== 'idle') throw new Error(`${this.provider} ACP session already started`);
    this._state = 'starting';
    this._cwd = cwd || process.cwd();
    try {
      this._spawn();
      const initialized = await this._initialize(
        Math.min(this._requestTimeoutMs, CAPABILITY_PROBE_TIMEOUT_MS)
      );
      return { ...(initialized?.agentCapabilities || {}) };
    } finally {
      await this.stopSession().catch(() => {});
    }
  }

  async startSession({ cwd, resumeSessionId, effort, toolsDisabled = false } = {}) {
    if (this._state !== 'idle') throw new Error(`${this.provider} ACP session already started`);
    this._state = 'starting';
    this._cwd = cwd || process.cwd();
    this._toolsDisabled = toolsDisabled === true;
    if (this._toolsDisabled && this.provider === 'kimi') {
      fs.writeFileSync(path.join(this._cwd, '.codeagentswarm-title-agent.md'), [
        '---',
        'name: conversation-title',
        'description: Generate a short conversation title',
        'tools: []',
        'subagents: []',
        '---',
        'Answer with the requested title only.'
      ].join('\n'));
    }
    if (this._toolsDisabled && this.provider === 'opencode') {
      const configPath = path.join(this._cwd, '.codeagentswarm-title-opencode.json');
      fs.writeFileSync(configPath, JSON.stringify({
        permission: 'deny',
        tools: { '*': false }
      }));
      this._env.OPENCODE_CONFIG = configPath;
    }
    if (this.provider === 'grok' && effort) {
      this._effort = this._normalizeGrokEffort(effort);
    }
    this._emit({ type: 'session.state.changed', payload: { state: 'starting' } });

    try {
      this._spawn();
      // A well-behaved ACP agent will not send questions unless the client
      // advertises form elicitation. URL elicitation stays unadvertised because
      // this client cannot complete its external browser handoff.
      const initialized = await this._initialize();

      if (this.provider === 'grok') {
        const authMethods = new Set(
          (Array.isArray(initialized && initialized.authMethods)
            ? initialized.authMethods
            : [])
            .map((method) => method && method.id)
            .filter(Boolean)
        );
        const hasApiKey = Boolean(
          (this._env.XAI_API_KEY || process.env.XAI_API_KEY || '').trim()
        );
        const methodId = hasApiKey && authMethods.has('xai.api_key')
          ? 'xai.api_key'
          : authMethods.has('cached_token') ? 'cached_token' : null;
        if (!methodId) {
          throw new Error('Grok is not authenticated. Run `grok login` or set XAI_API_KEY.');
        }
        await this._request('authenticate', {
          methodId,
          _meta: { headless: true }
        });
      }

      if (this.provider === 'cursor') {
        const cursorLogin = (Array.isArray(initialized?.authMethods)
          ? initialized.authMethods
          : []).find((method) => method?.id === 'cursor_login');
        if (!cursorLogin) {
          throw new Error('This Cursor CLI version does not advertise ACP authentication. Run `cursor-agent update`.');
        }
        try {
          await this._request('authenticate', { methodId: 'cursor_login' });
        } catch (error) {
          const detail = String(error?.message || error || '').trim();
          throw new Error(`${detail || 'Cursor authentication failed'}. Run \`cursor-agent login\` or set CURSOR_API_KEY. If login already succeeds, run \`cursor-agent update\`.`);
        }
      }

      this._capabilities = initialized?.agentCapabilities || {};
      if (
        this.provider === 'cursor'
        && resumeSessionId
        && this._capabilities.loadSession !== true
      ) {
        const error = new Error('This Cursor CLI version cannot resume ACP chats. Run `cursor-agent update` or start a new chat.');
        error.code = 'provider_resume_unsupported';
        throw error;
      }

      const mcpServers = this.provider === 'cursor' && !this._toolsDisabled
        ? readCursorMcpServers(this._cwd, {
          capabilities: this._capabilities,
          sessionEnv: this._env
        })
        : [];
      this._collectingHistory = Boolean(resumeSessionId);
      const setup = resumeSessionId
        ? await this._request('session/load', {
          sessionId: resumeSessionId,
          cwd: this._cwd,
          mcpServers
        })
        : await this._request('session/new', {
          cwd: this._cwd,
          mcpServers
        });
      this._threadId = resumeSessionId || setup.sessionId;
      this._configOptions = Array.isArray(setup.configOptions) ? setup.configOptions : [];
      this._availableCommands = normalizeSlashCommands(
        setup.availableCommands,
        this.provider
      );
      this._modelState = setup.models && typeof setup.models === 'object'
        ? setup.models
        : null;
      this._modeState = setup.modes && typeof setup.modes === 'object'
        ? setup.modes
        : null;
      if (this._toolsDisabled) {
        const safeMode = (this._modeState?.availableModes || [])
          .find((mode) => ['ask', 'plan'].includes(mode?.id));
        if (safeMode) {
          await this._request('session/set_mode', {
            sessionId: this._threadId,
            modeId: safeMode.id
          });
          this._modeState = { ...this._modeState, currentModeId: safeMode.id };
        }
      }
      const modelEffort = this.provider === 'grok'
        ? grokReasoningDescriptor(selectedGrokModel(this._modelState))?.currentValue
        : '';
      if (modelEffort) this._effort = modelEffort;
      const cursorModel = this.provider === 'cursor'
        ? parseCursorModelId(
          (this._modelState && this._modelState.currentModelId)
          || this._selectedConfigValue('model')
        )
        : null;
      if (cursorModel && !this._effort) {
        this._effort = cursorEffortFromParsed(cursorModel);
      }
      this._closeOpenTextItems({ history: true });
      this._collectingHistory = false;
      if (this.provider === 'kimi' && resumeSessionId) {
        this._restoreKimiUserHistory(resumeSessionId);
      }
      this._historyEvents = this._historyEvents.slice(-CHAT_HISTORY_EVENT_LIMIT);
      this._state = 'ready';
      this._emit({
        type: 'thread.started',
        threadId: this._threadId,
        payload: { providerThreadId: this._threadId }
      });
      this._emit({ type: 'session.state.changed', payload: { state: 'ready' } });

      return {
        threadId: this._threadId,
        cwd: this._cwd,
        model: (cursorModel && cursorModel.baseId)
          || (this._modelState && this._modelState.currentModelId)
          || this._selectedConfigValue('model'),
        effort: this._selectedConfigValue('thinking')
          || this._selectedConfigValue('effort')
          || this._selectedConfigValue('reasoning')
          || (cursorModel && cursorEffortFromParsed(cursorModel))
          || modelEffort
          || this._effort,
        historyEvents: this._historyEvents.slice(),
        capabilities: this._capabilities,
        interactionMode: this._modeState?.currentModeId || 'default',
        interactionModes: (Array.isArray(this._modeState?.availableModes)
          ? this._modeState.availableModes
          : []).map((mode) => ({
          id: mode.id,
          name: mode.name || mode.id,
          ...(mode.description ? { description: mode.description } : {})
        })).filter((mode) => mode.id)
      };
    } catch (error) {
      this._state = 'error';
      await this.stopSession().catch(() => {});
      throw error;
    }
  }

  async sendTurn({ text, attachments = [] } = {}) {
    if (this._state !== 'ready' && this._state !== 'running') {
      throw new Error(`${this.provider} ACP session is not ready`);
    }
    const promptText = promptWithFileReferences(text, attachments);
    const contentParts = [
      ...(promptText ? [{ type: 'text', text: promptText }] : []),
      ...attachments
        .filter((attachment) => attachment.type === 'image')
        .map((attachment) => {
          const decoded = splitDataUrl(attachment.dataUrl);
          return decoded ? {
            type: 'image',
            data: decoded.base64,
            mimeType: decoded.mimeType
          } : null;
        })
        .filter(Boolean)
    ];
    if (contentParts.length === 0) throw new Error('sendTurn requires non-empty text or attachments');
    // ACP has no place for session instructions, so they ride on the first
    // prompt. The `user_message` row below is built from `text`, so the
    // transcript still shows what the user actually typed.
    const promptParts = this._answerPlacementSent
      ? contentParts
      : [{ type: 'text', text: CHAT_ANSWER_PLACEMENT_PREAMBLE }, ...contentParts];
    this._answerPlacementSent = true;
    const steeringTurnId = this._state === 'running' ? this._activeTurnId : null;
    const turnId = steeringTurnId || crypto.randomUUID();
    if (!steeringTurnId) {
      this._activeTurnId = turnId;
      this._state = 'running';
      this._emit({ type: 'turn.started', turnId, payload: {} });
      this._emit({ type: 'session.state.changed', payload: { state: 'running' } });
    }
    this._emit({
      type: 'item.completed',
      turnId,
      itemId: `user-${crypto.randomUUID()}`,
      payload: {
        itemType: 'user_message',
        status: 'completed',
        data: { text: typeof text === 'string' ? text.trim() : '', attachments }
      }
    });

    this._promptsInFlight += 1;
    // ACP agents generally reject overlapping `session/prompt` requests for
    // the same session. Keep a steer inside the active turn, but serialize the
    // provider RPCs in submission order.
    // A failed prompt must not poison later submissions.
    const prompt = this._promptTail.then(() => (
      this._cancelRequestedTurnId === turnId
        ? { stopReason: 'cancelled' }
        : this._promptWithBusyRetry(turnId, promptParts)
    ));
    this._promptTail = prompt.catch(() => {});
    this._settlePromptTurn(turnId, prompt);
    return { turnId, ...(steeringTurnId ? { steered: true } : {}) };
  }

  _restoreKimiUserHistory(sessionId) {
    const { readKimiMainConversation } = require('../services/kimi-subagent-reader');
    const local = readKimiMainConversation(sessionId);
    // Kimi replays host reminders and background notifications through the same
    // ACP user channel as real prompts. Its local turn origin is the only place
    // that distinguishes them, so fail closed when local truth is unavailable.
    this._historyEvents = this._historyEvents.filter(
      (event) => event.payload?.itemType !== 'user_message'
    );
    if (!local.some((event) => event.payload?.itemType === 'user_message')) return;
    const insertions = new Map();
    let searchFrom = 0;

    for (const event of local) {
      if (event.payload?.itemType === 'user_message') {
        const restored = createProviderEvent({ ...event, createdAt: null }, {
          provider: this.provider,
          threadId: sessionId,
          executionOrigin: 'main'
        });
        const at = Math.min(searchFrom, this._historyEvents.length);
        insertions.set(at, [...(insertions.get(at) || []), restored]);
        continue;
      }

      if (event.itemId && event.payload?.itemType !== 'assistant_message') {
        let lastMatch = -1;
        for (let index = searchFrom; index < this._historyEvents.length; index += 1) {
          if (this._historyEvents[index].itemId === event.itemId) lastMatch = index;
        }
        if (lastMatch >= 0) searchFrom = lastMatch + 1;
        continue;
      }

      const localText = event.payload?.itemType === 'assistant_message'
        ? event.payload.data?.text || ''
        : '';
      let matchedText = '';
      let lastMatch = -1;
      for (let index = searchFrom; localText && index < this._historyEvents.length; index += 1) {
        const candidate = this._historyEvents[index];
        if (candidate.type !== 'content.delta'
          || candidate.payload?.streamKind !== 'assistant_text') continue;
        const next = matchedText + (candidate.payload.delta || '');
        if (!localText.startsWith(next)) {
          if (matchedText) break;
          continue;
        }
        matchedText = next;
        lastMatch = index;
        if (matchedText === localText) break;
      }
      if (lastMatch >= 0) searchFrom = lastMatch + 1;
    }

    const merged = [];
    this._historyEvents.forEach((event, index) => {
      if (insertions.has(index)) merged.push(...insertions.get(index));
      merged.push(event);
    });
    if (insertions.has(this._historyEvents.length)) {
      merged.push(...insertions.get(this._historyEvents.length));
    }
    this._historyEvents = merged;
  }

  /**
   * Send `session/prompt`, retrying while the agent reports it is still busy.
   *
   * The rejection is transient (see `isAgentBusyError`) and the agent gives no
   * "I am free now" signal: it already unsubscribed from its own turn stream,
   * so retrying is the only way to keep the user's message instead of losing it
   * behind a red error row. This runs inside the `_promptTail` chain on purpose:
   * submission order is preserved and `_promptsInFlight` stays >= 1 while we
   * wait, so `_settlePromptTurn` cannot close the turn early. The `user_message`
   * item was already emitted by `sendTurn`, so retries never duplicate it.
   */
  async _promptWithBusyRetry(turnId, promptParts) {
    const { initialDelayMs, maxDelayMs, budgetMs } = this._agentBusyRetry;
    const deadline = Date.now() + budgetMs;
    let delayMs = initialDelayMs;
    for (;;) {
      if (this._isTurnAbandoned(turnId)) return { stopReason: 'cancelled' };
      try {
        return await this._request('session/prompt', {
          sessionId: this._threadId,
          prompt: promptParts
        }, 0);
      } catch (error) {
        if (!isAgentBusyError(error) || Date.now() + delayMs > deadline) throw error;
        await this._delay(delayMs);
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
    }
  }

  _isTurnAbandoned(turnId) {
    return this._cancelRequestedTurnId === turnId
      || this._stopping
      || this._state === 'stopped';
  }

  /**
   * Sleep that can be released early by `_flushPendingDelays`.
   */
  _delay(ms) {
    return new Promise((resolve) => {
      const pending = { timer: null, resolve: null };
      pending.resolve = () => {
        this._pendingDelays.delete(pending);
        resolve();
      };
      pending.timer = setTimeout(pending.resolve, ms);
      this._pendingDelays.add(pending);
    });
  }

  /**
   * Release every outstanding `_delay`. Resolving (not just clearing the timer)
   * is mandatory: an abandoned wait would block the serialized `_promptTail`
   * chain forever and no later prompt could ever be sent.
   */
  _flushPendingDelays() {
    for (const pending of this._pendingDelays) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this._pendingDelays.clear();
  }

  /**
   * Finish an ACP turn in the background.
   *
   * `session/prompt` resolves only after the model has finished, but the shared
   * driver contract acknowledges a submitted turn immediately and streams its
   * lifecycle through provider events. Waiting here made `driverchat:send`
   * block for the full response and, in turn, made a direct Chat launch with an
   * assigned task look frozen until the agent was completely done.
   */
  async _settlePromptTurn(turnId, prompt) {
    let completion;
    try {
      const result = await prompt;
      const stopReason = result && result.stopReason;
      completion = {
        state: stopReason === 'cancelled' ? 'cancelled' : 'completed'
      };
    } catch (error) {
      if (this._stopping || this._state === 'stopped') return;
      completion = { state: 'failed', errorMessage: error.message };
    } finally {
      this._promptsInFlight = Math.max(0, this._promptsInFlight - 1);
    }

    // ACP accepts more than one session/prompt request for a live session.
    // A mid-turn prompt is steering, so only the last outstanding prompt may
    // close the shared turn; an earlier request settling must not make the
    // composer look idle while the steered work is still running.
    if (this._promptsInFlight > 0 || this._stopping || this._state === 'stopped') {
      if (completion && completion.state === 'failed') {
        this._emit({
          type: 'runtime.error',
          turnId,
          payload: { message: completion.errorMessage }
        });
      }
      return;
    }
    this._closeOpenTextItems({
      interrupted: completion.state === 'cancelled' || completion.state === 'interrupted'
    });
    this._emit({ type: 'turn.completed', turnId, payload: completion });
    if (this._cancelRequestedTurnId === turnId) this._cancelRequestedTurnId = null;
    this._activeTurnId = null;
    this._state = 'ready';
    this._emit({ type: 'session.state.changed', payload: { state: 'ready' } });
    await this._readUsageCommand();
  }

  /**
   * Ask an ACP agent for its token usage through the `usage` command it
   * advertises, and publish the reading as canonical usage.
   *
   * The ACP `usage_update` session update is optional and Kimi 0.31.1 never
   * sends one (verified on the wire: a full turn only produces
   * `available_commands_update`, `agent_thought_chunk` and
   * `agent_message_chunk`). What it does advertise is a `usage` command whose
   * reply carries the numbers. Reading it is safe and cheap: three consecutive
   * `/usage` calls all reported `Context: 39,773 / 1,048,576`, so the command
   * is local to the agent — it never reaches the model and never grows the
   * conversation.
   *
   * Capability-gated on purpose: an agent that does not advertise `usage` is
   * simply left without a gauge rather than probed blindly.
   *
   * @returns {Promise<void>} Never rejects; a failed reading is not an error.
   */
  async _readUsageCommand() {
    if (this._usageProbe) return;
    if (!this._availableCommands.some((command) => command.name === 'usage')) return;
    if (this._stopping || this._state === 'stopped' || !this._threadId) return;

    this._usageProbe = [];
    try {
      await this._request('session/prompt', {
        sessionId: this._threadId,
        prompt: [{ type: 'text', text: '/usage' }]
      }, 0);
      const usage = parseAcpUsageReport(this._usageProbe.join(''));
      if (usage) this._emit({ type: 'thread.token-usage.updated', payload: { usage } });
    } catch (error) {
      // The gauge is never worth surfacing an error for.
    } finally {
      this._usageProbe = null;
    }
  }

  async interruptTurn() {
    if (!this._activeTurnId || !this._process) return;
    this._cancelRequestedTurnId = this._activeTurnId;
    this._flushPendingDelays();
    this._sendMessage({
      method: 'session/cancel',
      params: { sessionId: this._threadId }
    });
    // ACP cancellation is a notification, so a broken provider may never
    // settle the outstanding session/prompt request. The driver explicitly
    // interrupts its local prompt fiber before notifying the provider. Resolve
    // our matching RPC locally for the same reason: it releases the serialized
    // prompt queue and lets _settlePromptTurn publish the terminal event.
    this._resolveActivePromptAsCancelled();
    this._cancelPendingApprovals();
  }

  /**
   * Number each subagent tool call of this session in spawn order.
   *
   * The number is what later matches the row to a child session in opencode's
   * database: several `Task` calls can share the same type and description, so
   * "the Nth of them" is the only distinguishing detail the wire gives us.
   * Updates of a call already seen keep the number they were given.
   *
   * @param {Object} event A canonical event, possibly a subagent tool call.
   * @returns {Object} The same event.
   */
  _stampSubagentOrdinal(event) {
    const subagent = event && event.payload && event.payload.data
      ? event.payload.data.subagent
      : null;
    if (!subagent || !event.itemId) return event;
    if (!this._subagentOrdinals.has(event.itemId)) {
      this._subagentOrdinals.set(event.itemId, this._subagentOrdinals.size);
    }
    subagent.ordinal = this._subagentOrdinals.get(event.itemId);
    return event;
  }

  /**
   * Read one subagent's own conversation from the provider's own store.
   *
   * Two ACP agents record a delegated agent somewhere a client can reach:
   * opencode's task tool creates a child `session` row in its database, and
   * kimi writes the child a sibling `agents/agent-N/wire.jsonl`. Either way the
   * child is read without asking the parent anything. Grok keeps nothing, hence
   * the guard.
   *
   * @param {{toolUseId?: string,
   *   subagent?: {agentType?: string, description?: string, ordinal?: number},
   *   known?: {cursorCount: number, cursorUpdated: number}
   *     | {size: number, mtimeMs: number}}} params The identity carried by the
   *   parent timeline row that was clicked.
   * @returns {Promise<Object>} `{agentId, agentType, description, running,
   *   talk, events, ...freshness stamp}`, or `{..., unchanged: true}`.
   */
  async openSubagentConversation({ known, subagent, toolUseId } = {}) {
    if (!this._threadId) throw new Error('Subagent conversation not found on disk');

    const wrapEvents = (events) => events.map((bare) => createProviderEvent(bare, {
      provider: this.provider,
      threadId: this._threadId || undefined
    }));

    if (this.provider === 'opencode') {
      const { openChildConversation } = require('../services/opencode-subagent-reader');
      const result = openChildConversation({
        parentSessionId: this._threadId,
        agentType: subagent && subagent.agentType,
        description: subagent && subagent.description,
        ordinal: subagent && subagent.ordinal,
        known
      });
      // The child runs inside the parent's turn, so the parent being busy is
      // the only "still working" signal opencode gives without polling twice.
      const running = Boolean(this._activeTurnId);
      if (result.unchanged) {
        return { agentId: result.agentId, running, talk: 'direct', unchanged: true };
      }
      return { ...result, running, talk: 'direct', events: wrapEvents(result.events) };
    }

    if (this.provider === 'kimi') {
      const { openKimiSubagentConversation } = require('../services/kimi-subagent-reader');
      // Our row ids prefix kimi's tool call id with the turn (`0:tool_...`);
      // the transcript records the bare id.
      const toolCallId = String(toolUseId || '').split(':').slice(1).join(':') || toolUseId;
      const result = openKimiSubagentConversation({
        sessionId: this._threadId,
        toolCallId,
        known
      });
      // kimi has no channel to message a subagent (TaskStop only kills it), so
      // the drill-down is always read-only.
      const running = Boolean(this._activeTurnId) && !result.finished;
      if (result.unchanged) {
        return { agentId: result.agentId, running, talk: 'none', unchanged: true };
      }
      return {
        agentId: result.agentId,
        agentType: (subagent && subagent.agentType) || 'subagent',
        description: (subagent && subagent.description) || '',
        running,
        talk: 'none',
        events: wrapEvents(result.events),
        fileSize: result.fileSize,
        fileMtimeMs: result.fileMtimeMs
      };
    }

    throw new Error('This agent does not support opening subagent conversations');
  }

  /**
   * Deliver a message straight to a subagent, no parent relay.
   *
   * A child session is an ordinary opencode session, so a second, short-lived
   * ACP connection resumed on the child's id can prompt it directly — the
   * parent never sees the message. The courier owns its own child process and
   * is always stopped, so nothing outlives the delivery.
   *
   * @param {{taskId: string, text: string}} params `taskId` is the child
   *   session id resolved by {@link openSubagentConversation}.
   * @returns {Promise<{turnId: string}>}
   */
  async sendToSubagentConversation({ taskId, text } = {}) {
    if (this.provider !== 'opencode') {
      throw new Error('This agent cannot deliver messages to a subagent');
    }
    if (!taskId) throw new Error('Subagent conversation not found on disk');

    const courier = new this.constructor({
      provider: 'opencode',
      env: this._env,
      binaryPath: this._binaryPath
    });
    try {
      await courier.startSession({ cwd: this._cwd, resumeSessionId: taskId });
      // sendTurn only queues the prompt (the turn settles in the background),
      // so stopping on its resolution would kill the delivery mid-flight.
      const delivered = new Promise((resolve) => {
        courier.on(PROVIDER_EVENT_CHANNEL, (event) => {
          if (['turn.completed', 'runtime.error', 'session.exited'].includes(event.type)) {
            resolve();
          }
        });
      });
      const result = await courier.sendTurn({ text });
      await delivered;
      return result;
    } finally {
      courier.stopSession().catch(() => {});
    }
  }

  async listModels() {
    const optionDescriptors = this._configOptions
      .map(acpOptionDescriptor)
      .filter(Boolean);
    if (
      this.provider === 'cursor'
      && this._modelState
      && Array.isArray(this._modelState.availableModels)
      && this._modelState.availableModels.length > 0
    ) {
      return buildCursorModelCatalog({
        models: this._modelState.availableModels,
        optionDescriptors,
        currentModelId: this._modelState.currentModelId
      });
    }
    if (
      this._modelState
      && Array.isArray(this._modelState.availableModels)
      && this._modelState.availableModels.length > 0
    ) {
      return this._modelState.availableModels.map((entry) => {
        const nativeReasoning = this.provider === 'grok'
          ? grokReasoningDescriptor(entry)
          : null;
        const descriptors = nativeReasoning
          ? optionDescriptors.filter((option) => !isReasoningOptionDescriptor(option))
            .concat(nativeReasoning)
          : optionDescriptors;
        return {
          id: entry.modelId,
          name: entry.name || entry.modelId,
          ...(entry.description ? { description: entry.description } : {}),
          current: entry.modelId === this._modelState.currentModelId,
          capabilities: { optionDescriptors: descriptors }
        };
      }).filter((entry) => entry.id);
    }
    const option = this._configOptions.find((entry) => entry && entry.id === 'model');
    if (!option || !Array.isArray(option.options)) return [];
    return option.options.map((entry) => ({
      id: entry.value,
      name: entry.name || entry.value,
      current: entry.value === option.currentValue,
      capabilities: { optionDescriptors }
    }));
  }

  /** Commands advertised by the ACP agent for this exact session. */
  async listCommands() {
    return this._availableCommands.map((command) => ({
      ...command,
      aliases: command.aliases.slice()
    }));
  }

  /**
   * Replay the effort/fast an exploded Cursor model id carries as the live
   * session's own config options. A parameterized session lists those levels
   * separately, so the params of a stale id are still the user's choice; any
   * the agent no longer offers is skipped rather than sent and rejected.
   *
   * @param {Object} params Parsed `[effort=high,fast=true]` pairs.
   * @param {Object} result The `session/set_config_option` reply for the model.
   * @returns {Promise<Object>} The last reply seen.
   */
  async _applyCursorModelParams(params, result) {
    let latest = result;
    for (const [paramId, paramValue] of Object.entries(params || {})) {
      // The effort param is not always spelled the way the live option is:
      // an id carries `thought_level=high` while the session publishes it as
      // `effort`. Anything else has to match the option id exactly.
      const aliases = THOUGHT_PARAM_IDS.includes(paramId) ? THOUGHT_PARAM_IDS : [paramId];
      const option = this._configOptions.find((entry) => entry && aliases.includes(entry.id));
      const accepted = (Array.isArray(option && option.options) ? option.options : [])
        .some((entry) => entry && String(entry.value ?? entry.id) === String(paramValue));
      if (!accepted) continue;
      latest = await this._request('session/set_config_option', {
        sessionId: this._threadId,
        configId: option.id,
        value: String(paramValue)
      });
      if (Array.isArray(latest && latest.configOptions)) this._configOptions = latest.configOptions;
    }
    return latest;
  }

  async setConfigOption(configId, value) {
    const normalizedConfigId = String(configId).replace(/[-_]/g, '').toLowerCase();
    if (
      this.provider === 'grok'
      && ['effort', 'reasoningeffort', 'thinking'].includes(normalizedConfigId)
    ) {
      return this._restartGrokWithEffort(value);
    }
    if (this.provider === 'grok' && configId === 'model') {
      const modelId = String(value);
      const result = await this._request('session/set_model', {
        sessionId: this._threadId,
        modelId
      });
      this._modelState = {
        ...(this._modelState || {}),
        currentModelId: modelId,
        availableModels: Array.isArray(this._modelState && this._modelState.availableModels)
          ? this._modelState.availableModels
          : []
      };
      return result;
    }
    if (this.provider === 'cursor' && configId === 'model') {
      const selectedId = String(value);
      const catalog = buildCursorModelCatalog({
        models: this._modelState && this._modelState.availableModels,
        optionDescriptors: this._configOptions.map(acpOptionDescriptor).filter(Boolean),
        currentModelId: this._modelState && this._modelState.currentModelId
      });
      const exploded = cursorUsesExplodedIds(this._modelState && this._modelState.availableModels);
      // A parameterized session only accepts base ids. A sticky selection saved
      // while Cursor still advertised exploded SKUs arrives as
      // `grok-4.6[effort=high,fast=true]`, and the agent answers that with
      // "Invalid params", which used to take the whole chat launch down.
      const parsed = parseCursorModelId(selectedId);
      const wireId = exploded ? cursorWireModelId(catalog, selectedId) : parsed.baseId;
      // `session/set_model` succeeds but returns {}. Cursor only sends the
      // replacement effort/fast options on `session/set_config_option`.
      const result = await this._request('session/set_config_option', {
        sessionId: this._threadId,
        configId: 'model',
        value: wireId
      });
      this._modelState = { ...(this._modelState || {}), currentModelId: wireId };
      if (Array.isArray(result && result.configOptions)) this._configOptions = result.configOptions;
      if (exploded) return result;
      return this._applyCursorModelParams(parsed.params, result);
    }
    if (
      this.provider === 'cursor'
      && cursorUsesExplodedIds(this._modelState && this._modelState.availableModels)
      && ['effort', 'fast', 'reasoning', 'thinking'].includes(configId)
    ) {
      const paramIds = configId === 'fast'
        ? ['fast']
        : ['effort', 'reasoning', 'thinking', 'thought_level', 'reasoning_effort'];
      let explodedId = null;
      for (const paramId of paramIds) {
        explodedId = cursorWireIdForParamChange(
          this._modelState.availableModels,
          this._modelState.currentModelId,
          paramId,
          value
        );
        if (explodedId) break;
      }
      if (explodedId) {
        const result = await this._request('session/set_config_option', {
          sessionId: this._threadId,
          configId: 'model',
          value: explodedId
        });
        this._modelState = { ...(this._modelState || {}), currentModelId: explodedId };
        if (Array.isArray(result && result.configOptions)) this._configOptions = result.configOptions;
        return result;
      }
    }
    if (this.provider === 'cursor' && configId === 'interactionMode') {
      const modeId = String(value);
      const result = await this._request('session/set_mode', {
        sessionId: this._threadId,
        modeId
      });
      this._modeState = { ...(this._modeState || {}), currentModeId: modeId };
      return result;
    }
    const result = await this._request('session/set_config_option', {
      sessionId: this._threadId,
      configId,
      ...(typeof value === 'boolean' ? { type: 'boolean', value } : { value: String(value) })
    });
    if (Array.isArray(result && result.configOptions)) this._configOptions = result.configOptions;
    return result;
  }

  /**
   * Resolves one parked ACP permission request.
   *
   * @param {{requestId: string, decision: string}} input
   */
  /**
   * Surface a `session/elicitation` form as canonical questions.
   *
   * ACP does not send multiple-choice questions the way Claude and Codex do:
   * it sends a JSON-Schema form, and choices live in a string property's `enum`
   * (bare values) or `oneOf` (labelled). Each property therefore becomes one
   * question, and a property with neither becomes a free-text one.
   *
   * `url` mode is declined rather than faked: it hands the user to an external
   * browser flow this client does not implement, and pretending otherwise would
   * block the agent forever on an answer that can never arrive.
   *
   * @param {Object} message Raw JSON-RPC request.
   */
  _handleElicitation(message) {
    const params = message.params || {};
    const questions = params.mode === 'url' ? [] : mapAcpElicitationQuestions(params);

    if (!questions.length) {
      this._sendMessage({ id: message.id, result: { action: 'decline' } });
      this._emit({
        type: 'runtime.warning',
        payload: {
          message: params.mode === 'url'
            ? 'Agent asked for a URL-mode elicitation, which this client does not support'
            : 'Agent asked for input without any answerable field'
        }
      });
      return;
    }

    const requestId = String(message.id);
    this._pendingQuestions.set(requestId, { id: message.id, questions });
    this._emit({
      type: 'question.opened',
      requestId,
      turnId: this._activeTurnId || undefined,
      payload: { requestType: 'agent_elicitation', questions }
    });
  }

  /**
   * Answer, or explicitly decline, one parked elicitation.
   *
   * ACP wants `{action: 'accept', content}` keyed by property name, with single
   * values rather than the canonical lists, so multi-select collapses to a
   * comma-joined string. Declining sends `decline`, never an empty `accept`:
   * an empty accept would read to the agent as "the user answered nothing".
   *
   * @param {{requestId: string, decision: string, answers: Object}} response
   */
  async respondToQuestion({ requestId, decision, answers } = {}) {
    const key = String(requestId || '');
    const pending = this._pendingQuestions.get(key);
    if (!pending) throw new Error('Unknown ACP question request');
    this._pendingQuestions.delete(key);

    let result;
    let resolvedDecision;
    if (pending.protocol === 'cursor') {
      if (decision !== 'submit') {
        result = { outcome: { outcome: 'skipped' } };
        resolvedDecision = 'declined';
      } else {
        result = {
          outcome: {
            outcome: 'answered',
            answers: pending.questions.map((question) => {
              const selectedLabels = Array.isArray(answers?.[question.id]?.values)
                ? answers[question.id].values
                : [];
              const optionIds = pending.optionIds?.[question.id] || {};
              return {
                questionId: question.id,
                selectedOptionIds: selectedLabels.map((label) => optionIds[label]).filter(Boolean)
              };
            })
          }
        };
        resolvedDecision = 'submitted';
      }
    } else if (decision !== 'submit') {
      result = { action: 'decline' };
      resolvedDecision = 'declined';
    } else {
      const content = {};
      for (const question of pending.questions) {
        const values = Array.isArray(answers?.[question.id]?.values)
          ? answers[question.id].values.filter((value) => typeof value === 'string' && value)
          : [];
        if (values.length) content[question.id] = values.join(', ');
      }
      result = { action: 'accept', content };
      resolvedDecision = 'submitted';
    }

    this._sendMessage({ id: pending.id, result });
    this._emit({
      type: 'question.resolved',
      requestId: key,
      turnId: this._activeTurnId || undefined,
      payload: { requestType: 'agent_elicitation', decision: resolvedDecision }
    });
  }

  async respondToRequest({ requestId, decision } = {}) {
    const key = String(requestId || '');
    const pending = this._pendingApprovals.get(key);
    if (!pending) throw new Error('Unknown ACP permission request');

    if (pending.protocol === 'cursor_plan') {
      const accepted = ['accept', 'allow', 'allow_once', 'allow-once'].includes(decision);
      this._sendMessage({
        id: pending.id,
        result: { outcome: { outcome: accepted ? 'accepted' : 'rejected' } }
      });
      this._pendingApprovals.delete(key);
      this._emit({
        type: 'request.resolved',
        requestId: key,
        payload: { requestType: 'cursor_create_plan', decision: accepted ? 'accepted' : 'rejected' }
      });
      return;
    }
    const options = Array.isArray(pending.params.options) ? pending.params.options : [];
    const selected = options.find((option) => option.optionId === decision)
      || options.find((option) => option.kind === decision);
    const outcome = selected
      ? { outcome: 'selected', optionId: selected.optionId }
      : { outcome: 'cancelled' };
    this._sendMessage({ id: pending.id, result: { outcome } });
    this._pendingApprovals.delete(key);
    this._emit({
      type: 'request.resolved',
      requestId: key,
      payload: {
        requestType: requestTypeForTool(pending.params.toolCall),
        decision: selected ? selected.kind : 'cancelled'
      }
    });
  }

  async stopSession() {
    if (this._stopping) return;
    this._flushPendingDelays();
    if (!this._process) {
      this._state = 'stopped';
      this._promptsInFlight = 0;
      return;
    }
    this._stopping = true;
    this._cancelPendingApprovals();
    this._cancelPendingQuestions();
    for (const pending of this._pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.provider} ACP session stopped`));
    }
    this._pendingRpc.clear();

    const proc = this._process;
    this._process = null;
    let didExit = false;
    const exited = new Promise((resolve) => {
      const done = () => {
        didExit = true;
        resolve();
      };
      proc.once('exit', done);
      proc.once('close', done);
    });
    if (
      process.platform === 'win32'
      && this._spawnedThroughCmd
      && proc.pid
      && this._treeKillFn
    ) {
      try {
        await this._treeKillFn(proc.pid);
      } catch (_) {
        try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
      }
    } else {
      try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
    }
    let stopTimer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        stopTimer = setTimeout(resolve, this._stopGraceMs);
      })
    ]);
    clearTimeout(stopTimer);
    // `exit` is commonly queued on the same event-loop turn as the grace
    // timer. Give that notification one final chance to land before escalating
    // to SIGKILL, otherwise a clean ACP shutdown can receive two kill signals.
    if (!didExit) await new Promise((resolve) => setImmediate(resolve));
    if (!didExit) {
      try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      let killTimer;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          killTimer = setTimeout(resolve, this._stopGraceMs);
        })
      ]);
      clearTimeout(killTimer);
    }
    this._state = 'stopped';
    this._promptsInFlight = 0;
    this._cancelRequestedTurnId = null;
    this._stopping = false;
  }

  _spawn() {
    const rawArgs = this._binaryArgs
      || defaultBinaryArgs(this.provider, this._cwd, this._effort, this._toolsDisabled);
    // An npm-installed opencode/kimi on Windows is a `.cmd` shim: libuv resolves
    // a bare name only to `.exe`, and Node refuses to spawn a `.cmd` without a
    // shell (CVE-2024-27980), so only cmd.exe can launch it. Same route the PTY
    // launcher takes, and the same shape as Node's `shell: true`: each token
    // quoted, then ONE outer pair around the whole line for cmd's /S rule.
    // ponytail: the registered PID is cmd.exe, so a hard kill can orphan the
    // grandchild on Windows; upgrade to `taskkill /T` if zombies show up.
    let file = this._binaryPath;
    let args = rawArgs;
    if (process.platform === 'win32' && !isNativeExe(file)) {
      args = ['/d', '/s', '/c', `"${[file, ...rawArgs].map(quoteForCmd).join(' ')}"`];
      file = 'cmd.exe';
    }
    this._spawnedThroughCmd = file === 'cmd.exe';
    const proc = this._spawnFn(file, args, {
      cwd: this._cwd,
      env: {
        ...mergeSessionCommunicationEnv(process.env, this._env),
        ...(this.provider === 'grok'
          ? { GROK_OAUTH2_REFERRER: 'codeagentswarm' }
          : {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // The whole command line is ONE argv entry: without verbatim args Node
      // re-quotes it and escapes the embedded quotes as `\"`, which cmd.exe does
      // not parse — a spaced `--cwd "C:\My Projects\app"` would arrive mangled.
      ...(file === 'cmd.exe' ? { windowsVerbatimArguments: true } : {})
    });
    this._process = proc;
    if (this._processRegistry && proc.pid !== undefined) {
      this._processRegistry.register(proc.pid);
      proc.once('exit', () => this._processRegistry.unregister(proc.pid));
    }

    proc.stdout.on('data', (chunk) => this._handleStdout(chunk));
    proc.stderr.on('data', () => {});
    proc.once('error', (error) => this._handleProcessFailure(error));
    proc.once('exit', (code, signal) => this._handleProcessExit(code, signal));
  }

  _handleStdout(chunk) {
    const parsed = parseJsonRpcChunk(this._stdoutRemainder, chunk);
    this._stdoutRemainder = parsed.remainder;
    for (const error of parsed.invalidLines || []) {
      this._emit({
        type: 'runtime.warning',
        payload: { message: `Malformed ${this.provider} ACP message`, detail: error }
      });
    }
    for (const message of parsed.messages) this._handleMessage(message);
  }

  _handleMessage(message) {
    if (message && message.method && message.id === undefined) {
      if (message.method === 'session/update') this._handleSessionUpdate(message.params);
      else if (this.provider === 'cursor') this._handleCursorNotification(message);
      return;
    }
    if (message && message.method && message.id !== undefined) {
      this._handleServerRequest(message);
      return;
    }
    if (message && message.id !== undefined) {
      const pending = this._pendingRpc.get(String(message.id));
      if (!pending) return;
      this._pendingRpc.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(
          message.error.message || `ACP request failed: ${pending.method}`
        );
        // Keep the structured JSON-RPC payload: callers classify transient
        // failures by error code, never by parsing the human message.
        error.rpcCode = message.error.code;
        error.rpcData = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
    }
  }

  _handleServerRequest(message) {
    if (this.provider === 'cursor' && message.method === 'cursor/ask_question') {
      this._handleCursorQuestion(message);
      return;
    }
    if (this.provider === 'cursor' && message.method === 'cursor/create_plan') {
      this._handleCursorPlan(message);
      return;
    }
    if (message.method === 'session/elicitation') {
      this._handleElicitation(message);
      return;
    }
    if (message.method !== 'session/request_permission') {
      this._sendMessage({
        id: message.id,
        error: { code: -32601, message: `Unsupported ACP client method: ${message.method}` }
      });
      return;
    }
    if (this._toolsDisabled) {
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      const rejected = options.find((option) => ['reject_once', 'cancelled'].includes(option?.kind));
      this._sendMessage({
        id: message.id,
        result: rejected
          ? { outcome: 'selected', optionId: rejected.optionId }
          : { outcome: 'cancelled' }
      });
      return;
    }
    const requestId = String(message.id);
    this._pendingApprovals.set(requestId, {
      id: message.id,
      params: message.params || {}
    });
    const params = message.params || {};
    const toolCall = params.toolCall || {};
    this._emit({
      type: 'request.opened',
      requestId,
      turnId: this._activeTurnId || undefined,
      itemId: toolCall.toolCallId || undefined,
      payload: {
        requestType: requestTypeForTool(toolCall),
        detail: toolCall.title || toolDetail(toolCall) || 'Permission required',
        args: toolCall.rawInput,
        options: (params.options || []).map((option) => ({
          id: option.optionId,
          name: option.name,
          kind: option.kind
        }))
      }
    });
  }

  _handleSessionUpdate(params) {
    if (!this._ownsSessionUpdate(params)) return;
    const update = params.update || {};
    // A `/usage` the DRIVER asked for, not the user: swallow its text so the
    // reading never shows up as an assistant message in the conversation.
    if (this._usageProbe && update.sessionUpdate === 'agent_message_chunk') {
      this._usageProbe.push(contentText(update.content) || '');
      return;
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this._availableCommands = normalizeSlashCommands(
        update.availableCommands,
        this.provider
      );
      this._publish(createProviderEvent({
        type: 'session.commands.updated',
        payload: { commands: this._availableCommands }
      }, { provider: this.provider, threadId: params.sessionId }));
    }
    const messageId = update.messageId || null;
    const targetSet = update.sessionUpdate === 'agent_message_chunk'
      ? this._openAssistantItems
      : update.sessionUpdate === 'agent_thought_chunk' ? this._openReasoningItems : null;
    if (targetSet && messageId && !targetSet.has(messageId)) {
      targetSet.add(messageId);
      this._publish(createProviderEvent({
        type: 'item.started',
        ...(this._activeTurnId ? { turnId: this._activeTurnId } : {}),
        itemId: messageId,
        payload: {
          itemType: update.sessionUpdate === 'agent_message_chunk' ? 'assistant_message' : 'reasoning',
          status: 'inProgress'
        }
      }, { provider: this.provider, threadId: params.sessionId }));
    }
    const events = mapAcpSessionUpdate(params, {
      provider: this.provider,
      threadId: params.sessionId,
      rootThreadId: this._threadId,
      turnId: this._activeTurnId || undefined
    });
    for (const event of events) this._publish(this._stampSubagentOrdinal(event));
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      this._configOptions = update.configOptions;
    }
    if (update.sessionUpdate === 'current_mode_update' && update.currentModeId) {
      this._modeState = { ...(this._modeState || {}), currentModeId: update.currentModeId };
      this._emit({
        type: 'session.config.updated',
        payload: { interactionMode: update.currentModeId }
      });
    }
  }

  _handleCursorQuestion(message) {
    const params = message.params || {};
    const questions = mapCursorQuestions(params);
    if (!questions.length) {
      this._sendMessage({ id: message.id, result: { outcome: { outcome: 'skipped' } } });
      return;
    }
    const optionIds = {};
    for (const question of params.questions || []) {
      optionIds[question.id] = Object.fromEntries(
        (question.options || []).map((option) => [option.label, option.id])
      );
    }
    const requestId = String(message.id);
    this._pendingQuestions.set(requestId, {
      id: message.id,
      protocol: 'cursor',
      questions,
      optionIds
    });
    this._emit({
      type: 'question.opened',
      requestId,
      turnId: this._activeTurnId || undefined,
      itemId: params.toolCallId || undefined,
      payload: { requestType: 'cursor_ask_question', questions }
    });
  }

  _handleCursorPlan(message) {
    const params = message.params || {};
    const requestId = String(message.id);
    this._pendingApprovals.set(requestId, {
      id: message.id,
      protocol: 'cursor_plan',
      params
    });
    if (Array.isArray(params.todos)) {
      this._handleCursorNotification({ method: 'cursor/update_todos', params });
    }
    this._emit({
      type: 'request.opened',
      requestId,
      turnId: this._activeTurnId || undefined,
      itemId: params.toolCallId || undefined,
      payload: {
        requestType: 'cursor_create_plan',
        detail: params.name || params.overview || 'Cursor wants approval for its plan',
        args: { plan: params.plan, todos: params.todos || [], phases: params.phases || [] },
        options: [
          { id: 'accept', name: 'Accept plan', kind: 'allow_once' },
          { id: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    });
  }

  _handleCursorNotification(message) {
    const params = message.params || {};
    if (message.method === 'cursor/update_todos') {
      this._handleSessionUpdate({
        sessionId: this._threadId,
        update: {
          sessionUpdate: 'plan',
          entries: (params.todos || []).map((todo) => ({
            content: todo.content,
            status: todo.status,
            priority: 'medium'
          }))
        }
      });
      return;
    }
    if (message.method === 'cursor/task') {
      const subagentType = typeof params.subagentType === 'string'
        ? params.subagentType
        : params.subagentType?.custom;
      this._handleSessionUpdate({
        sessionId: this._threadId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: params.toolCallId,
          title: 'Task',
          kind: 'other',
          status: 'completed',
          rawInput: {
            description: params.description,
            prompt: params.prompt,
            subagent_type: subagentType
          },
          rawOutput: {
            agentId: params.agentId,
            durationMs: params.durationMs,
            model: params.model
          }
        }
      });
      return;
    }
    if (message.method === 'cursor/generate_image') {
      this._handleSessionUpdate({
        sessionId: this._threadId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: params.toolCallId,
          title: 'Generate image',
          kind: 'other',
          status: 'completed',
          rawInput: {
            description: params.description,
            referenceImagePaths: params.referenceImagePaths
          },
          rawOutput: { filePath: params.filePath }
        }
      });
    }
  }

  _ownsSessionUpdate(params) {
    if (!params || typeof params.sessionId !== 'string') return false;
    if (!this._threadId) return true;
    if (params.sessionId === this._threadId || this._relatedSessionIds.has(params.sessionId)) {
      return true;
    }
    const metadata = params.update && params.update._meta;
    const parentSessionId = metadata && (
      metadata.parentSessionId || metadata.parentID
    );
    if (parentSessionId !== this._threadId) return false;
    this._relatedSessionIds.add(params.sessionId);
    return true;
  }

  _closeOpenTextItems({ history = false, interrupted = false } = {}) {
    const close = (set, itemType) => {
      for (const itemId of set) {
        this._publish(createProviderEvent({
          type: 'item.completed',
          ...(this._activeTurnId && !history ? { turnId: this._activeTurnId } : {}),
          itemId,
          payload: { itemType, status: 'completed' }
        }, { provider: this.provider, threadId: this._threadId }));
      }
      set.clear();
    };
    // A cancelled thought must remain visually stopped, not receive a green
    // completed check immediately before turn.completed closes the turn.
    if (interrupted) this._openReasoningItems.clear();
    else close(this._openReasoningItems, 'reasoning');
    close(this._openAssistantItems, 'assistant_message');
  }

  _resolveActivePromptAsCancelled() {
    for (const [id, pending] of this._pendingRpc) {
      if (pending.method !== 'session/prompt') continue;
      this._pendingRpc.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ stopReason: 'cancelled' });
      return true;
    }
    return false;
  }

  _cancelPendingApprovals() {
    for (const [requestId, pending] of this._pendingApprovals) {
      this._sendMessage({ id: pending.id, result: { outcome: { outcome: 'cancelled' } } });
      this._emit({
        type: 'request.resolved',
        requestId,
        payload: {
          requestType: requestTypeForTool(pending.params.toolCall),
          decision: 'cancelled'
        }
      });
    }
    this._pendingApprovals.clear();
  }

  _cancelPendingQuestions() {
    for (const [requestId, pending] of this._pendingQuestions) {
      const result = pending.protocol === 'cursor'
        ? { outcome: { outcome: 'cancelled' } }
        : { action: 'decline' };
      this._sendMessage({ id: pending.id, result });
      this._emit({
        type: 'question.resolved',
        requestId,
        payload: { requestType: pending.protocol === 'cursor' ? 'cursor_ask_question' : 'agent_elicitation', decision: 'cancelled' }
      });
    }
    this._pendingQuestions.clear();
  }

  _publish(event) {
    if (this._collectingHistory) {
      const last = this._historyEvents[this._historyEvents.length - 1];
      const userChunk = event.raw?.payload?.update?.sessionUpdate === 'user_message_chunk';
      const sameUserMessage = userChunk && last?.payload?.itemType === 'user_message'
        && (event.itemId ? last.itemId === event.itemId : !last.itemId);
      if (sameUserMessage) {
        last.payload.data.text += event.payload.data.text;
        return;
      }
      this._historyEvents.push({ ...event, createdAt: null });
      return;
    }
    this.emit(PROVIDER_EVENT_CHANNEL, event);
  }

  _emit(bareEvent) {
    this._publish(createProviderEvent(bareEvent, {
      provider: this.provider,
      threadId: this._threadId || undefined,
      executionOrigin: 'main'
    }));
  }

  _request(method, params, timeoutMs = this._requestTimeoutMs) {
    if (!this._process || !this._process.stdin) {
      return Promise.reject(new Error(`${this.provider} ACP process is not running`));
    }
    const id = this._nextRequestId++;
    if (method === 'session/load') {
      timeoutMs = Math.max(timeoutMs, HISTORY_REQUEST_TIMEOUT_MS);
    }
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this._pendingRpc.delete(String(id));
          reject(new Error(`${this.provider} ACP request timed out: ${method}`));
        }, timeoutMs)
        : null;
      this._pendingRpc.set(String(id), { method, resolve, reject, timer });
      this._sendMessage({ id, method, params });
    });
  }

  _sendMessage(message) {
    if (!this._process || !this._process.stdin || this._process.stdin.destroyed) return;
    this._process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  _selectedConfigValue(id) {
    const option = this._configOptions.find((entry) => entry && entry.id === id);
    return option && option.currentValue;
  }

  _normalizeGrokEffort(value) {
    const normalized = String(value || '').toLowerCase();
    if (!GROK_EFFORT_LEVELS.includes(normalized)) {
      throw new Error(`Unsupported Grok reasoning effort: ${String(value)}`);
    }
    return normalized;
  }

  async _restartGrokWithEffort(value) {
    if (this._activeTurnId || this._state === 'running') {
      throw new Error('Wait for the current Grok response to finish');
    }
    const effort = this._normalizeGrokEffort(value);
    if (effort === this._effort) {
      return { changed: false, configId: 'effort', value: effort };
    }

    const cwd = this._cwd;
    const resumeSessionId = this._threadId;
    await this.stopSession();
    this._state = 'idle';
    this._stopping = false;
    this._stdoutRemainder = '';
    this._nextRequestId = 1;
    this._threadId = null;
    this._activeTurnId = null;
    this._cancelRequestedTurnId = null;
    this._promptsInFlight = 0;
    this._openAssistantItems.clear();
    this._openReasoningItems.clear();
    this._configOptions = [];
    this._modelState = null;
    this._historyEvents = [];
    this._effort = effort;

    await this.startSession({ cwd, resumeSessionId, effort });
    return { changed: true, configId: 'effort', value: effort };
  }

  _handleProcessFailure(error) {
    this._flushPendingDelays();
    for (const pending of this._pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pendingRpc.clear();
  }

  _handleProcessExit(code, signal) {
    if (this._stopping) return;
    this._flushPendingDelays();
    const wasActive = this._state !== 'stopped';
    this._process = null;
    this._state = code === 0 ? 'stopped' : 'error';
    for (const pending of this._pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.provider} ACP exited before replying`));
    }
    this._pendingRpc.clear();
    if (wasActive) {
      this._emit({
        type: 'session.exited',
        payload: {
          exitKind: code === 0 ? 'graceful' : 'error',
          exitCode: typeof code === 'number' ? code : undefined,
          reason: signal || undefined
        }
      });
    }
  }
}

module.exports = {
  AcpAgentDriver,
  mapAcpSessionUpdate,
  parseAcpUsageReport,
  mapAcpElicitationQuestions,
  mapCursorQuestions,
  readCursorMcpServers,
  requestTypeForTool,
  isAgentBusyError
};
