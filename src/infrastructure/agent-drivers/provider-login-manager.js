/**
 * Runs an agent's own sign-in command as a child process so the whole flow can
 * happen inside Chat: the URL becomes a button, the CLI's output stays visible,
 * and anything the CLI asks for on stdin is typed into the card.
 *
 * Why a child process and not the provider protocol: a signed-out agent has no
 * chat session to talk to. Codex's app-server does expose `account/login/start`,
 * but reaching it would mean standing up a second app-server connection purely
 * to log in. Driving the CLI works identically for every `cli` agent in
 * `provider-login.js`, so that is what this does. See
 * `docs/reference/agent-auth-matrix.md`.
 *
 * The login child is deliberately NOT given a TTY. Both verified flows (Claude,
 * Codex) print a plain URL and either block on stdin or complete via their own
 * local callback. An agent whose login needs a real terminal is marked `manual`
 * instead of being run here half-working.
 */

const EventEmitter = require('events');
const { spawn } = require('child_process');
const { LOGIN_MODES, loginStrategyForAgent } = require('./provider-login');
const { isNativeExe, quoteForCmd } = require('../platform/windows-direct-spawn');

/** Give up on a login the user never finishes, so no child outlives the card. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** A status probe that hangs must not hang the completion event with it. */
const STATUS_TIMEOUT_MS = 15 * 1000;

const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

class ProviderLoginManager extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {Function} [options.spawnFn] Injectable spawn (tests).
   * @param {(context: {agent: string}) => Promise<Object>} [options.resolveEnv]
   *        Extra environment for the child, typically the login-shell PATH.
   * @param {(context: {agent: string}) => (string|null|Promise<string|null>)}
   *        [options.resolveBinary] User-configured CLI path, so a custom binary
   *        signs in the same install Chat will later run.
   * @param {number} [options.timeoutMs]
   */
  constructor({ spawnFn, resolveEnv, resolveBinary, resolveStrategy, timeoutMs } = {}) {
    super();
    this._spawn = spawnFn || spawn;
    this._resolveEnv = resolveEnv || (async () => ({}));
    this._resolveBinary = resolveBinary || (() => null);
    // Seam for tests: they point the flow at a fake CLI so the runner is
    // exercised against a real child process instead of a mocked spawn.
    this._resolveStrategy = resolveStrategy || loginStrategyForAgent;
    this._timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this._nextId = 0;
    /** @type {Map<string, Object>} loginId -> live flow. */
    this._flows = new Map();
    // Injected spawners are unit-test fakes; only real children need reaping.
    this._registry = spawnFn ? null : safeRequireRegistry();
  }

  get activeCount() {
    return this._flows.size;
  }

  /**
   * Starts the agent's login command.
   *
   * @param {{agent: string}} options
   * @returns {Promise<{loginId: string, agent: string, acceptsCode: boolean,
   *   codeHint: string, command: string}>}
   * @throws when the agent cannot be signed in from Chat — callers should have
   *         checked `mode` first and rendered the manual card instead.
   */
  async start({ agent, accountId, replaceAccount = false } = {}) {
    const strategy = this._resolveStrategy(agent);
    if (strategy.mode !== LOGIN_MODES.CLI) {
      throw new Error(`${strategy.label} cannot be signed in from Chat`);
    }

    const env = { ...process.env, ...(await this._resolveEnv({ agent, ...(accountId ? { accountId } : {}) })) };
    if (replaceAccount) await this._logout(agent, strategy, env);

    const [defaultBinary, ...args] = strategy.command;
    const binary = (await this._resolveBinary({ agent })) || defaultBinary;
    const loginId = `login-${++this._nextId}`;

    const child = this._spawnCommand(binary, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const flow = {
      loginId,
      agent,
      accountId: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_ID || 'current',
      strategy,
      child,
      settled: false,
      urls: new Set(),
      timer: setTimeout(
        () => this._settle(flow, { success: false, message: 'Sign-in timed out. Try again.' }),
        this._timeoutMs
      )
    };
    this._flows.set(loginId, flow);

    if (this._registry && child.pid !== undefined) {
      this._registry.register(child.pid);
      child.once('exit', () => this._registry.unregister(child.pid));
    }

    const onChunk = (chunk) => this._handleOutput(flow, chunk);
    if (child.stdout) child.stdout.on('data', onChunk);
    if (child.stderr) child.stderr.on('data', onChunk);
    child.once('error', (error) => this._settle(flow, {
      success: false,
      message: `Could not run \`${strategy.command.join(' ')}\`: ${error.message}`
    }));
    child.once('exit', (code) => this._handleExit(flow, code));

    return {
      loginId,
      agent,
      accountId: flow.accountId,
      acceptsCode: strategy.acceptsCode === true,
      codeHint: strategy.codeHint || '',
      command: strategy.command.join(' '),
      replaceAccount: replaceAccount === true
    };
  }

  async _logout(agent, strategy, env) {
    if (!Array.isArray(strategy.logoutCommand) || !strategy.logoutCommand.length) {
      throw new Error(`${strategy.label} cannot switch accounts from Chat`);
    }
    const [defaultBinary, ...args] = strategy.logoutCommand;
    const binary = (await this._resolveBinary({ agent })) || defaultBinary;
    const result = await this._runToCompletion(binary, args, env);
    if (!result || result.code !== 0) {
      throw new Error(`Could not sign out of ${strategy.label}`);
    }
    const status = await this.status(agent, {
      accountId: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_ID || 'current'
    }).catch(() => ({ known: false }));
    if (status.known && status.loggedIn) {
      throw new Error(`${strategy.label} is still signed in`);
    }
  }

  /** Signs out one CLI profile without immediately starting another login. */
  async logout(agent, { accountId } = {}) {
    const strategy = this._resolveStrategy(agent);
    const env = { ...process.env, ...(await this._resolveEnv({ agent, ...(accountId ? { accountId } : {}) })) };
    await this._logout(agent, strategy, env);
    return { agent, accountId: env.CODEAGENTSWARM_PROVIDER_ACCOUNT_ID || 'current' };
  }

  /**
   * Types a line into the running login, for the CLIs that ask for a pasted
   * code. A trailing newline is added because the CLI is waiting on a line.
   *
   * @param {string} loginId
   * @param {string} text
   */
  submitInput(loginId, text) {
    const flow = this._mustGet(loginId);
    if (!flow.child.stdin || flow.child.stdin.destroyed) {
      throw new Error('The sign-in is no longer accepting input');
    }
    flow.child.stdin.write(`${String(text == null ? '' : text).trim()}\n`);
  }

  /**
   * Aborts a login the user gave up on.
   * @param {string} loginId
   */
  cancel(loginId) {
    const flow = this._flows.get(loginId);
    if (!flow) return { cancelled: false };
    this._settle(flow, { success: false, message: 'Sign-in cancelled.', cancelled: true });
    return { cancelled: true };
  }

  /** Stops every live login (app quit, window gone). */
  cancelAll() {
    for (const loginId of [...this._flows.keys()]) this.cancel(loginId);
  }

  /**
   * Reads the agent's own signed-in state, when it has a machine-readable one.
   *
   * @param {string} agent
   * @returns {Promise<{known: boolean, loggedIn?: boolean, detail?: string}>}
   *          `known: false` means this agent has no status command — the absence
   *          of an answer must not be reported as "signed out".
   */
  async status(agent, { binaryPath = null, accountId } = {}) {
    const strategy = this._resolveStrategy(agent);
    if (!Array.isArray(strategy.statusCommand) || !strategy.statusCommand.length) {
      return this._emitStatus(agent, accountId, { known: false });
    }
    const [defaultBinary, ...args] = strategy.statusCommand;
    const binary = binaryPath || (await this._resolveBinary({ agent })) || defaultBinary;
    const env = { ...process.env, ...(await this._resolveEnv({ agent, ...(accountId ? { accountId } : {}) })) };
    const result = await this._runToCompletion(binary, args, env);
    const resolvedAccountId = env.CODEAGENTSWARM_PROVIDER_ACCOUNT_ID || accountId || 'current';
    if (!result) return this._emitStatus(agent, resolvedAccountId, { known: false });
    return this._emitStatus(agent, resolvedAccountId, { known: true, ...interpretStatus(agent, result) });
  }

  _emitStatus(agent, accountId, status) {
    this.emit('status-event', { agent, accountId: accountId || 'current', status });
    return status;
  }

  _handleOutput(flow, chunk) {
    const text = String(chunk).replace(ANSI_PATTERN, '');
    if (!text) return;
    this._emit(flow, 'output', { text });
    for (const url of text.match(URL_PATTERN) || []) {
      if (flow.urls.has(url)) continue;
      flow.urls.add(url);
      this._emit(flow, 'url', { url });
    }
  }

  async _handleExit(flow, code) {
    if (flow.settled) return;
    // The exit code alone is not trustworthy across CLIs, so confirm with the
    // agent's own status command whenever it has one.
    const status = await this.status(flow.agent, { accountId: flow.accountId }).catch(() => ({ known: false }));
    const success = status.known ? status.loggedIn === true : code === 0;
    this._settle(flow, {
      success,
      message: success
        ? `${flow.strategy.label} is signed in.${status.detail ? ` ${status.detail}` : ''}`
        : `${flow.strategy.label} sign-in did not complete.`,
      status
    });
  }

  _settle(flow, result) {
    if (flow.settled) return;
    flow.settled = true;
    clearTimeout(flow.timer);
    this._flows.delete(flow.loginId);
    try {
      if (flow.child.exitCode === null && flow.child.signalCode === null) {
        flow.child.kill();
      }
    } catch (_) {
      // Already gone; nothing to reap.
    }
    this._emit(flow, 'completed', result);
  }

  _emit(flow, type, payload) {
    this.emit('login-event', {
      loginId: flow.loginId,
      agent: flow.agent,
      accountId: flow.accountId,
      type,
      payload
    });
  }

  _mustGet(loginId) {
    const flow = this._flows.get(loginId);
    if (!flow) throw new Error('Unknown sign-in');
    return flow;
  }

  _spawnCommand(binary, args, options) {
    if (process.platform !== 'win32' || isNativeExe(binary)) {
      return this._spawn(binary, args, options);
    }
    return this._spawn(
      process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', `"${[binary, ...args].map(quoteForCmd).join(' ')}"`],
      { ...options, windowsVerbatimArguments: true }
    );
  }

  /** Runs a short command and resolves its output, never rejecting. */
  _runToCompletion(binary, args, env) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this._spawnCommand(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {
        resolve(null);
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) { /* already gone */ }
        resolve(null);
      }, STATUS_TIMEOUT_MS);
      if (child.stdout) child.stdout.on('data', (chunk) => { out += String(chunk); });
      if (child.stderr) child.stderr.on('data', (chunk) => { out += String(chunk); });
      child.once('error', () => { clearTimeout(timer); resolve(null); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output: out.replace(ANSI_PATTERN, '').trim() });
      });
    });
  }
}

/**
 * Turns a status command's output into a verdict. Claude answers JSON; Codex
 * answers a sentence. Both are read here rather than in the caller so a new
 * agent only touches this function.
 */
function interpretStatus(agent, { code, output }) {
  if (agent === 'claude') {
    try {
      const parsed = JSON.parse(output);
      const detail = [parsed.email, parsed.subscriptionType].filter(Boolean).join(' · ');
      return { loggedIn: parsed.loggedIn === true, detail };
    } catch (_) {
      return { loggedIn: false, detail: '' };
    }
  }
  if (agent === 'codex') {
    // "Not logged in" contains "logged in", so the negative has to be tested
    // first or a signed-out Codex reads as signed in.
    const signedOut = /\bnot\s+(?:logged|signed)\s+in\b/i.test(output);
    return {
      loggedIn: !signedOut && /\b(?:logged|signed)\s+in\b/i.test(output),
      detail: output.split('\n')[0] || ''
    };
  }
  return { loggedIn: code === 0, detail: output.split('\n')[0] || '' };
}

function safeRequireRegistry() {
  try {
    return require('../platform/spawned-process-registry');
  } catch (_) {
    return null;
  }
}

module.exports = { ProviderLoginManager, interpretStatus };
