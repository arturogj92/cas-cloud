const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProviderLoginManager } = require('../agent-drivers/provider-login-manager');
const {
  canSwitchAccount,
  loginStrategyForAgent,
  terminalLoginHint,
} = require('../agent-drivers/provider-login');
const { initializeCliAgentRegistry } = require('../services/cli-agents/cli-agent-registry-bootstrap');

const AGENT_IDS = Object.freeze(['claude', 'codex', 'antigravity', 'opencode', 'kimi', 'grok', 'cursor']);
const AGENT_BINARIES = Object.freeze({
  claude: ['claude'],
  codex: ['codex'],
  antigravity: ['agy'],
  opencode: ['opencode'],
  kimi: [path.join(os.homedir(), '.kimi-code', 'bin', 'kimi'), 'kimi'],
  grok: [path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'bin', 'grok'), 'grok'],
  cursor: [path.join(os.homedir(), '.local', 'bin', 'cursor-agent'), 'cursor-agent'],
});

function findExecutable(candidates, envPath = process.env.PATH || '', fsImpl = fs) {
  for (const candidate of candidates || []) {
    const locations = path.isAbsolute(candidate)
      ? [candidate]
      : envPath.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, candidate));
    for (const executable of locations) {
      try {
        fsImpl.accessSync(executable, fs.constants.X_OK);
        return executable;
      } catch (_) {}
    }
  }
  return null;
}

function run(file, args, { env, timeout = 10_000, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl(file, args, { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, output: `${stdout || ''}\n${stderr || ''}`.trim() });
    });
  });
}

function publicLogin(agent, strategy, status = { known: false }) {
  return {
    mode: strategy.mode,
    label: strategy.label,
    acceptsCode: strategy.acceptsCode === true,
    codeHint: String(strategy.codeHint || '').slice(0, 200),
    command: Array.isArray(strategy.command) ? strategy.command.join(' ').slice(0, 300) : null,
    terminalHint: terminalLoginHint(agent) || null,
    reason: String(strategy.reason || '').slice(0, 500),
    canSwitchAccount: false,
    status,
  };
}

function headlessLoginStrategy(agent) {
  const strategy = loginStrategyForAgent(agent);
  return agent === 'codex'
    ? { ...strategy, command: ['codex', 'login', '--device-auth'] }
    : strategy;
}

class HeadlessProviderService extends EventEmitter {
  constructor({ registry, env = process.env, fsImpl = fs, execFileImpl = execFile, loginManager } = {}) {
    super();
    this.registry = registry || initializeCliAgentRegistry();
    this.env = env;
    this.fs = fsImpl;
    this.execFile = execFileImpl;
    this.loginManager = loginManager || new ProviderLoginManager({
      resolveEnv: async () => this.env,
      resolveBinary: ({ agent }) => this.executable(agent),
      resolveStrategy: headlessLoginStrategy,
    });
    this.loginManager.on('login-event', (event) => this.emit('login-event', {
      loginId: event.loginId,
      agent: event.agent,
      type: event.type,
      payload: event.type === 'output'
        ? { text: String(event.payload?.text || '').slice(0, 16_000) }
        : event.payload,
    }));
  }

  executable(agent) {
    if (!AGENT_IDS.includes(agent)) return null;
    const custom = this.registry.get(agent)?.getCustomBinaryPath?.();
    return findExecutable([custom, ...AGENT_BINARIES[agent]].filter(Boolean), this.env.PATH || '', this.fs);
  }

  async inspect(agent, { includePath = false } = {}) {
    if (!AGENT_IDS.includes(agent)) throw new Error('Choose a supported provider');
    const strategy = this.registry.get(agent);
    const executable = this.executable(agent);
    const login = headlessLoginStrategy(agent);
    if (!executable) {
      return {
        id: agent,
        name: strategy.getDisplayName(),
        installed: false,
        version: null,
        login: { ...publicLogin(agent, login), canSwitchAccount: canSwitchAccount(agent) },
        canInstall: typeof strategy.getInstaller?.()?.install === 'function',
      };
    }
    const versionResult = await run(executable, ['--version'], {
      env: this.env,
      execFileImpl: this.execFile,
    });
    const version = versionResult.output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] || null;
    const auth = await this.loginManager.status(agent, { binaryPath: executable }).catch(() => ({ known: false }));
    return {
      id: agent,
      name: strategy.getDisplayName(),
      installed: true,
      version,
      login: { ...publicLogin(agent, login, auth), canSwitchAccount: canSwitchAccount(agent) },
      canInstall: true,
      ...(includePath ? { path: executable } : {}),
    };
  }

  list() {
    return Promise.all(AGENT_IDS.map((agent) => this.inspect(agent)));
  }

  async install(agent, onProgress = () => {}) {
    if (!AGENT_IDS.includes(agent)) throw new Error('Choose a supported provider');
    const strategy = this.registry.get(agent);
    const installer = strategy.getInstaller?.();
    if (!installer || typeof installer.install !== 'function') throw new Error('This provider has no supported installer');
    if (this.executable(agent)) return { success: true, alreadyInstalled: true, provider: await this.inspect(agent) };
    const installed = await installer.install(null, {
      env: this.env,
      onStage: (stage) => onProgress({ stage: String(stage || '').slice(0, 100) }),
      onProgress: (line) => onProgress({ stage: 'installing', line: String(line || '').slice(0, 2_000) }),
    });
    if (!installed) throw new Error(installer.getLastError?.() || `Could not install ${strategy.getDisplayName()}`);
    return { success: true, provider: await this.inspect(agent) };
  }

  async describeLogin(agent) {
    const provider = await this.inspect(agent);
    return { agent, ...provider.login };
  }

  startLogin(options) { return this.loginManager.start(options); }
  submitLogin(loginId, text) { this.loginManager.submitInput(loginId, text); return { success: true }; }
  cancelLogin(loginId) { return this.loginManager.cancel(loginId); }
  stop() { this.loginManager.cancelAll(); }
}

module.exports = { AGENT_BINARIES, AGENT_IDS, HeadlessProviderService, findExecutable, headlessLoginStrategy };
