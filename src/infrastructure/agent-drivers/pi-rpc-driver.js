const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { stripVTControlCharacters } = require('util');
const { createProviderEvent } = require('./provider-events');
const { parseJsonRpcChunk } = require('./jsonrpc-line-parser');
const { splitDataUrl, promptWithFileReferences } = require('./chat-attachments');
const { CHAT_ANSWER_PLACEMENT_PREAMBLE } = require('./chat-answer-placement');
const { mergeSessionCommunicationEnv } = require('./session-communication-env');
const { quoteForCmd } = require('../platform/windows-direct-spawn');
const reader = require('../services/pi-conversation-reader');
const { CHAT_HISTORY_EVENT_LIMIT } = require('./chat-history-limits');
const { ProviderAuthenticationError } = require('./provider-auth');

function toolType(name) {
  if (['edit', 'write'].includes(name)) return 'file_change';
  if (['bash', 'powershell'].includes(name)) return 'command_execution';
  return name?.startsWith('mcp__') ? 'mcp_tool_call' : 'dynamic_tool_call';
}
function messageItems(message, id, history = false) {
  const items = [];
  if (message.role === 'toolResult') return [{ itemId: message.toolCallId,
    payload: { itemType: toolType(message.toolName), status: message.isError ? 'failed' : 'completed',
      title: message.toolName, data: { text: reader.textContent(message.content), output: reader.textContent(message.content), history } } }];
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
  if (message.role === 'user') {
    items.push({ itemId: id, payload: { itemType: 'user_message', status: 'completed', data: {
      text: reader.textContent(content), history,
      attachments: content.filter((part) => part.type === 'image').map((part) => ({ type: 'image', mimeType: part.mimeType, dataUrl: `data:${part.mimeType};base64,${part.data}` })),
    } } });
  } else if (message.role === 'assistant') {
    content.forEach((part, index) => {
      if (part.type === 'text' || part.type === 'thinking') items.push({ itemId: `${id}-${index}`,
        payload: { itemType: part.type === 'thinking' ? 'reasoning' : 'assistant_message', status: 'completed',
          data: { text: part.text || part.thinking || '', history } } });
      if (part.type === 'toolCall') items.push({ itemId: part.id,
        payload: { itemType: toolType(part.name), status: history ? 'completed' : 'inProgress', title: part.name,
          data: { toolName: part.name, arguments: part.arguments, history } } });
    });
  }
  return items;
}

class PiRpcDriver extends EventEmitter {
  constructor({ binaryPath = 'pi', env = {}, spawnFn = spawn, processRegistry, platform = process.platform } = {}) {
    super();
    this.binaryPath = binaryPath;
    this.env = env;
    this.spawnFn = spawnFn;
    this.platform = platform;
    this.registry = processRegistry || (spawnFn === spawn ? require('../platform/spawned-process-registry') : null);
    this.pending = new Map();
    this.dialogs = new Map();
    this.remainder = '';
    this.state = 'idle';
    this.sequence = 0;
    this.history = [];
  }
  get threadId() { return this._threadId; }
  async startSession({ cwd = process.cwd(), resumeSessionId, model, effort, toolsDisabled = false, ephemeral = false } = {}) {
    if (this.state !== 'idle') throw new Error('Pi session already started');
    this.cwd = cwd;
    this.state = 'starting';
    try {
      // Files preserve multiline instructions across Windows shims and make an
      // extension inside Electron's ASAR readable by the external Pi process.
      this.launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-pi-launch-'));
      const promptFile = path.join(this.launchDir, 'instructions.md');
      fs.writeFileSync(promptFile, CHAT_ANSWER_PLACEMENT_PREAMBLE);
      const args = ['--mode', 'rpc', '--append-system-prompt', promptFile];
      if (toolsDisabled) args.push('--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files');
      else {
        const extension = path.join(__dirname, '..', 'hooks', 'pi-extension.js');
        const stagedExtension = path.join(this.launchDir, 'extension.js');
        fs.copyFileSync(fs.existsSync(extension) ? extension : path.join(__dirname, 'pi-extension.js'), stagedExtension);
        args.push('-e', stagedExtension);
      }
      if (ephemeral) args.push('--no-session');
      if (resumeSessionId) {
        const session = reader.findSession(resumeSessionId, reader.getDataRoot({ ...process.env, ...this.env }));
        if (!session) throw new Error('Pi conversation was not found');
        args.push('--session', session.filePath);
        this.cwd = session.projectPath || cwd;
      }
      if (model) args.push('--model', model);
      if (effort) args.push('--thinking', effort);
      let file = this.binaryPath;
      let spawnArgs = args;
      const env = { ...mergeSessionCommunicationEnv(process.env, this.env), CODEAGENTSWARM_DRIVER_CHAT: '1' };
      // npm's Pi shim uses /usr/bin/env node. Keep its owning runtime ahead of
      // login-shell defaults (e.g. nvm Node 20 cannot run a Homebrew Pi install).
      if (this.platform !== 'win32' && path.isAbsolute(file)
        && fs.existsSync(path.join(path.dirname(file), 'node'))) {
        env.PATH = [path.dirname(file), env.PATH].filter(Boolean).join(path.delimiter);
      }
      if (this.platform === 'win32' && !/\.exe$/i.test(file)) {
        if ([file, ...args].some((value) => /["%\r\n]/.test(String(value)))) {
          throw new Error('Pi Windows launch arguments contain unsupported shell characters');
        }
        spawnArgs = ['/d', '/s', '/c', `"${[file, ...args].map(quoteForCmd).join(' ')}"`];
        file = 'cmd.exe';
      }
      const proc = this.spawnFn(file, spawnArgs, { cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        ...(file === 'cmd.exe' ? { windowsVerbatimArguments: true } : {}),
      });
      this.process = proc;
      this.registry?.register(proc.pid);
      proc.stdout.setEncoding?.('utf8');
      proc.stdout.on('data', (chunk) => {
        const parsed = parseJsonRpcChunk(this.remainder, chunk);
        this.remainder = parsed.remainder;
        for (const message of parsed.messages) this.handle(message);
        if (parsed.invalidLines.length) this.emitEvent({ type: 'runtime.warning', payload: { message: 'Pi sent an invalid protocol message' } });
      });
      let stderr = '';
      proc.stderr.setEncoding?.('utf8');
      proc.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
      proc.stdin.on('error', (error) => { this.fail(error); void this.stopSession(); });
      proc.once('error', (error) => this.fail(error));
      proc.once('exit', (code) => {
        this.registry?.unregister(proc.pid);
        const detail = stripVTControlCharacters(stderr).trim();
        this.fail(new Error(`Pi exited (${code ?? 'signal'})${detail ? `: ${detail}` : ''}`));
      });
      const current = await this.request('get_state');
      if (!toolsDisabled) {
        const { commands = [] } = await this.request('get_commands');
        if (!commands.some((command) => command.name === '__codeagentswarm_ready')) {
          throw new Error('Pi could not load the Swarm integration. Repair it before starting Chat.');
        }
      }
      const { models } = await this.request('get_available_models');
      if (Array.isArray(models) && models.length === 0) {
        throw new ProviderAuthenticationError('pi', 'Pi has no configured model provider. Open Pi in CLI view (or run pi on the remote computer), enter /login and choose a provider, then reopen Chat. Pi uses its own login, separate from Codex and Claude.');
      }
      this._threadId = current.sessionId;
      this.model = current.model ? `${current.model.provider}/${current.model.id}` : '';
      this.effort = current.thinkingLevel || 'off';
      if (resumeSessionId) {
        const { entries, leafId } = await this.request('get_entries');
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const branch = [];
        let node = byId.get(leafId);
        const seen = new Set();
        while (node && !seen.has(node.id)) { seen.add(node.id); branch.push(node); node = byId.get(node.parentId); }
        this.history = branch.reverse().flatMap((entry) => entry.type === 'message'
          ? messageItems(entry.message, entry.id, true).map((item) => createProviderEvent({ ...item, type: 'item.completed', createdAt: entry.timestamp }, { provider: 'pi', threadId: this.threadId })) : []);
      }
      this.state = 'ready';
      this.emitEvent({ type: 'thread.started', payload: { providerThreadId: this.threadId } });
      this.emitEvent({ type: 'session.state.changed', payload: { state: 'ready' } });
      return { threadId: this.threadId, cwd: this.cwd, model: this.model, effort: this.effort, supportsResume: !ephemeral,
        historyEvents: this.history.slice(-CHAT_HISTORY_EVENT_LIMIT),
        hasEarlierHistory: this.history.length > CHAT_HISTORY_EVENT_LIMIT,
        historyCursor: Math.max(0, this.history.length - CHAT_HISTORY_EVENT_LIMIT),
      };
    } catch (error) { await this.stopSession(); throw error; }
  }
  async probeCapabilities() { return { supportsResume: true, loadSession: true }; }
  async loadEarlierHistory(cursor) {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.history.length) throw new Error('Invalid Pi history cursor');
    const start = Math.max(0, cursor - CHAT_HISTORY_EVENT_LIMIT);
    return { historyEvents: this.history.slice(start, cursor), historyCursor: start, hasEarlierHistory: start > 0 };
  }
  sendTurn({ text, attachments = [] } = {}) {
    if (this.state !== 'ready' || this.turnId) throw new Error('Pi is not ready for a new message');
    this.started = false;
    this.completion = null;
    this.streamingItems = new Set();
    this.turnDiffs = [];
    const images = attachments.filter((item) => item.type === 'image').map((item) => {
      const image = splitDataUrl(item.dataUrl);
      if (!image) throw new Error('Invalid Pi image attachment');
      return { type: 'image', data: image.base64, mimeType: image.mimeType };
    });
    this.turnId = crypto.randomUUID();
    const turnId = this.turnId;
    this.emitEvent({ type: 'turn.started', payload: {} });
    this.request('prompt', { message: promptWithFileReferences(text, attachments.filter((item) => item.type !== 'image')), ...(images.length ? { images } : {}) }, 0)
      .then(async () => {
        // Prompt acknowledges preflight before agent_start. Ask Pi for its state before
        // finishing a prompt handled entirely by an extension command/input handler.
        if (!this.started && this.turnId === turnId) {
          const state = await this.request('get_state');
          if (!this.started && this.turnId === turnId && !state.isStreaming && !state.isCompacting && !state.pendingMessageCount) {
            this.finish(this.completion?.state || 'completed', this.completion?.errorMessage);
          }
        }
      })
      .catch((error) => { if (this.turnId === turnId) this.finish('failed', error.message); });
    return Promise.resolve({ turnId });
  }
  async interruptTurn() {
    this.completion = { state: 'interrupted' };
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, { cancelled: true }, 'cancelled');
    await this.request('abort');
    this.finish('interrupted');
  }
  async stopSession() {
    if (this.state === 'stopped' && (!this.process || this.process.exitCode != null || this.process.signalCode != null)) return;
    this.finish('cancelled');
    this.state = 'stopped';
    if (this.process) {
      if (this.platform === 'win32') this.registry?.kill(this.process.pid);
      this.process.kill();
      if (this.process.exitCode == null) await new Promise((resolve) => {
        const timer = setTimeout(() => { this.registry?.kill(this.process.pid); this.process.kill('SIGKILL'); resolve(); }, 1500);
        this.process.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.fail(new Error('Pi session closed'));
  }
  request(type, params = {}, timeout = 30000) {
    if (!this.process || this.state === 'stopped') return Promise.reject(new Error('Pi is not running'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi timed out: ${type}`)); }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, type, ...params }); } catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  }
  write(message) { this.process.stdin.write(`${JSON.stringify(message)}\n`); }
  async listModels() {
    const { models } = await this.request('get_available_models');
    const { levels } = await this.request('get_available_thinking_levels');
    return models.map((model) => ({ id: `${model.provider}/${model.id}`, name: `${model.name} · ${model.provider}`,
      current: `${model.provider}/${model.id}` === this.model,
      capabilities: { optionDescriptors: model.reasoning && `${model.provider}/${model.id}` === this.model ? [{ id: 'effort', label: 'Reasoning', type: 'select',
        options: levels
          .map((id) => ({ id, label: id })), currentValue: this.effort }] : [] },
    }));
  }
  async setConfigOption(id, value) {
    if (id === 'model') {
      const { models } = await this.request('get_available_models');
      const model = models.find((item) => `${item.provider}/${item.id}` === value);
      if (!model) throw new Error('Unknown Pi model');
      await this.request('set_model', { provider: model.provider, modelId: model.id });
      this.model = value;
    } else if (id === 'effort') {
      const { levels } = await this.request('get_available_thinking_levels');
      if (!levels.includes(value)) throw new Error('Unsupported Pi reasoning level');
      await this.request('set_thinking_level', { level: value });
    } else throw new Error(`Unsupported Pi option: ${id}`);
    const current = await this.request('get_state');
    this.effort = current.thinkingLevel || 'off';
    this.emitEvent({ type: 'session.config.updated', payload: { model: this.model, effort: this.effort } });
    return { success: true, value };
  }
  async listCommands() {
    const result = await this.request('get_commands');
    return (result.commands || []).filter((command) => command.name !== '__codeagentswarm_ready');
  }
  async runCommand(line) {
    if (!/^\/compact(?:\s|$)/.test(line)) return { handled: false };
    await this.request('compact', { customInstructions: line.slice(8).trim() }, 0);
    return { handled: true };
  }
  handle(message) {
    if (typeof message?.type !== 'string') {
      this.emitEvent({ type: 'runtime.warning', payload: { message: 'Pi sent an invalid protocol message' } });
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data || {});
      else pending.reject(Object.assign(new Error(message.error || 'Pi rejected the command'), { rpcCode: -1 }));
      return;
    }
    if (message.type === 'extension_ui_request') { this.openDialog(message); return; }
    if (message.type === 'extension_error') {
      this.completion = { state: 'failed', errorMessage: message.error || 'Pi extension failed' };
      this.emitEvent({ type: 'runtime.error', payload: { message: message.error || 'Pi extension failed' } });
      return;
    }
    if (!this.turnId) return;
    if (message.type === 'agent_start') this.started = true;
    if (message.type === 'message_start') this.messageId = crypto.randomUUID();
    if (message.type === 'message_update') {
      const delta = message.assistantMessageEvent;
      if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') {
        const reasoning = delta.type === 'thinking_delta';
        const itemId = `${this.messageId}-${delta.contentIndex}`;
        if (!this.streamingItems.has(itemId)) {
          this.streamingItems.add(itemId);
          this.emitEvent({ type: 'item.started', itemId, payload: { itemType: reasoning ? 'reasoning' : 'assistant_message', status: 'inProgress', data: { text: '' } } });
        }
        this.emitEvent({ type: 'content.delta', itemId,
          payload: { streamKind: reasoning ? 'reasoning_text' : 'assistant_text', delta: delta.delta } });
      }
    }
    if (message.type === 'message_end') {
      for (const item of messageItems(message.message, this.messageId)) this.emitEvent({ ...item, type: 'item.completed' });
      if (message.message?.role === 'assistant' && message.message.stopReason !== 'error') this.completion = null;
      if (message.message?.stopReason === 'error') this.completion = { state: 'failed', errorMessage: message.message.errorMessage };
      if (message.message?.stopReason === 'aborted') this.completion = { state: 'interrupted' };
    }
    if (message.type.startsWith('tool_execution_')) {
      const done = message.type === 'tool_execution_end';
      const output = reader.textContent((message.result || message.partialResult)?.content);
      const patch = message.result?.details?.patch;
      if (done && !message.isError && typeof patch === 'string' && patch) {
        this.turnDiffs.push(patch);
        this.emitEvent({ type: 'turn.diff.updated', payload: { unifiedDiff: this.turnDiffs.join('\n') } });
      }
      this.emitEvent({ type: done ? 'item.completed' : message.type === 'tool_execution_start' ? 'item.started' : 'item.updated', itemId: message.toolCallId,
        payload: { itemType: toolType(message.toolName), status: done ? (message.isError ? 'failed' : 'completed') : 'inProgress',
          title: message.toolName, data: { toolName: message.toolName, arguments: message.args, text: output, output } } });
    }
    // A Pi turn is one model step; only agent_settled also waits for retries and queued work.
    if (message.type === 'agent_settled') {
      this.request('get_session_stats').then((stats) => this.emitEvent({ type: 'thread.token-usage.updated', payload: { usage: {
        usedTokens: stats.contextUsage?.tokens || 0, maxTokens: stats.contextUsage?.contextWindow,
        totalProcessedTokens: stats.tokens?.total, inputTokens: stats.tokens?.input, outputTokens: stats.tokens?.output,
        cachedInputTokens: stats.tokens?.cacheRead,
      } } })).catch(() => {});
      this.finish(this.completion?.state || 'completed', this.completion?.errorMessage);
    }
  }
  openDialog(message) {
    if (!['select', 'confirm', 'input', 'editor'].includes(message.method)) {
      if (message.method === 'notify') this.emitEvent({ type: 'runtime.warning', payload: { message: message.message } });
      return;
    }
    const approval = message.method === 'confirm' && message.title === 'CodeAgentSwarm approval';
    let args;
    if (approval) { try { args = JSON.parse(message.message); } catch (_) { this.write({ type: 'extension_ui_response', id: message.id, cancelled: true }); return; } }
    const requestType = approval ? (toolType(args.toolName) === 'file_change' ? 'file_change_approval' : 'command_execution_approval') : 'tool_user_input';
    const dialog = { ...message, approval, requestType };
    if (Number.isFinite(message.timeout) && message.timeout > 0) dialog.timer = setTimeout(() => this.resolveDialog(message.id, null, 'expired'), message.timeout);
    this.dialogs.set(message.id, dialog);
    this.emitEvent({ type: approval ? 'request.opened' : 'question.opened', requestId: message.id,
      payload: approval ? { requestType,
        detail: args.toolName, args: args.input,
        options: [{ id: 'allow_once', kind: 'allow_once', label: 'Allow' }, { id: 'reject_once', kind: 'reject_once', label: 'Reject' }] } : { requestType: 'tool_user_input',
        questions: [{ id: message.id, header: 'Pi', question: [message.title, message.message].filter(Boolean).join('\n'),
          options: (message.method === 'confirm' ? ['Yes', 'No'] : message.options || []).map((label) => ({ label, description: '' })),
          multiSelect: false, allowsFreeText: ['input', 'editor'].includes(message.method), allowsNote: false }],
        ...(dialog.timer ? { expiresAtMs: Date.now() + message.timeout } : {}),
      },
    });
  }
  resolveDialog(id, response, decision) {
    const dialog = this.dialogs.get(id);
    if (!dialog) return;
    this.dialogs.delete(id);
    clearTimeout(dialog.timer);
    if (response && this.state !== 'stopped') this.write({ type: 'extension_ui_response', id, ...response });
    this.emitEvent({ type: dialog.approval ? 'request.resolved' : 'question.resolved', requestId: id,
      payload: { requestType: dialog.requestType, decision } });
  }
  async respondToRequest({ requestId, decision }) {
    if (!this.dialogs.get(requestId)?.approval) throw new Error('Pi approval is no longer pending');
    this.resolveDialog(requestId, { confirmed: ['accept', 'acceptForSession', 'approved', 'allow', 'allow_once'].includes(decision) }, decision);
  }
  async respondToQuestion({ requestId, decision, answers }) {
    const dialog = this.dialogs.get(requestId);
    if (!dialog || dialog.approval) throw new Error('Pi question is no longer pending');
    const value = answers?.[requestId]?.values?.[0];
    if (decision === 'submitted' && (typeof value !== 'string' || (dialog.method === 'select' && !dialog.options.includes(value)) || (dialog.method === 'confirm' && !['Yes', 'No'].includes(value)))) {
      throw new Error('Invalid Pi question answer');
    }
    const response = decision !== 'submitted' ? { cancelled: true }
      : dialog.method === 'confirm' ? { confirmed: value === 'Yes' } : { value: value || '' };
    this.resolveDialog(requestId, response, decision);
  }
  finish(state = 'completed', errorMessage) {
    if (!this.turnId) return;
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, { cancelled: true }, 'cancelled');
    this.emitEvent({ type: 'turn.completed', payload: { state, ...(errorMessage ? { errorMessage } : {}) } });
    this.turnId = null;
  }
  fail(error) {
    const closing = this.state === 'stopped';
    this.state = 'stopped';
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.finish('failed', error.message);
    if (!this.exited) {
      this.exited = true;
      this.emitEvent({ type: 'session.exited', payload: { reason: error.message, exitKind: closing ? 'graceful' : 'error' } });
    }
    this.state = 'stopped';
    if (this.launchDir) {
      fs.rmSync(this.launchDir, { recursive: true, force: true, maxRetries: 3 });
      this.launchDir = null;
    }
  }
  emitEvent(event) { this.emit('provider-event', createProviderEvent({ turnId: this.turnId, ...event }, { provider: 'pi', threadId: this.threadId, turnId: this.turnId, executionOrigin: 'main' })); }
}

module.exports = { PiRpcDriver, messageItems };
