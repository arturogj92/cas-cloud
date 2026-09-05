/**
 * How each agent can be signed in, and how much of that CodeAgentSwarm can
 * actually drive from inside Chat.
 *
 * This is a CAPABILITY table, not a wish list: every `cli` entry below was
 * observed by running the command and reading what it printed. An agent whose
 * flow has not been observed stays `manual` — showing the user a command they
 * can run themselves is honest, while pretending to drive a flow we have never
 * seen is not.
 *
 * The evidence, the versions and the re-verify commands live in
 * `docs/reference/agent-auth-matrix.md`. Re-check after any agent CLI upgrade.
 */

/** What CodeAgentSwarm can do about signing this agent in. */
const LOGIN_MODES = Object.freeze({
  /** Drive the CLI ourselves and show the flow inside Chat. */
  CLI: 'cli',
  /** Tell the user the command; only a terminal can complete it. */
  MANUAL: 'manual',
  /** No command exists; credentials come from somewhere else entirely. */
  UNAVAILABLE: 'unavailable'
});

const PROVIDER_LOGIN = Object.freeze({
  claude: {
    mode: LOGIN_MODES.CLI,
    label: 'Claude Code',
    command: ['claude', 'auth', 'login'],
    logoutCommand: ['claude', 'auth', 'logout'],
    // The code is optional: some auth paths ask for it, while browser callback
    // auth completes the process without any pasted input.
    acceptsCode: true,
    codeHint: 'Paste the code from the browser',
    statusCommand: ['claude', 'auth', 'status', '--json'],
    verified: '2026-08-22 · claude 2.1.240'
  },
  codex: {
    mode: LOGIN_MODES.CLI,
    label: 'Codex',
    command: ['codex', 'login'],
    logoutCommand: ['codex', 'logout'],
    // Observed: starts a local callback server on :1455 and completes on its
    // own once the browser redirects back. Nothing to paste.
    acceptsCode: false,
    statusCommand: ['codex', 'login', 'status'],
    verified: '2026-08-22 · codex-cli 0.149.0',
    // The app-server also exposes account/login/start + account/login/completed.
    // Adopting it would remove this child process; see the matrix doc.
    nativeProtocolAvailable: true
  },
  grok: {
    mode: LOGIN_MODES.CLI,
    label: 'Grok Build',
    // `--device-auth` is Grok's own headless path, which is exactly our case:
    // no TTY, the user reads a code and finishes in a browser.
    command: ['grok', 'login', '--device-auth'],
    logoutCommand: ['grok', 'logout'],
    acceptsCode: true,
    codeHint: 'Only if Grok asks for something back',
    statusCommand: null,
    verified: '2026-08-11 · grok 1.0.0'
  },
  cursor: {
    mode: LOGIN_MODES.CLI,
    label: 'Cursor Agent',
    command: ['cursor-agent', 'login'],
    logoutCommand: ['cursor-agent', 'logout'],
    acceptsCode: false,
    statusCommand: ['cursor-agent', 'status'],
    verified: '2026-08-15 · cursor-agent 2026.01.17-d239e66'
  },
  opencode: {
    // The odd one out. Its sign-in is a separate CLI subcommand with an
    // arrow-key provider picker, and its own interface has no /login, so
    // sending the user to Terminal view would land them in the OpenCode UI with
    // nothing to type. This one really does need a system shell.
    mode: LOGIN_MODES.MANUAL,
    label: 'OpenCode',
    command: ['opencode', 'auth', 'login'],
    terminalHint: null,
    reason: 'OpenCode signs in from a separate command that asks you to pick provider and method from an interactive list. Its agent interface has no sign-in of its own.',
    verified: '2026-08-10 · opencode 1.18.11'
  },
  kimi: {
    mode: LOGIN_MODES.CLI,
    label: 'Kimi Code',
    command: ['kimi', 'login'],
    acceptsCode: false,
    verified: '2026-09-04 · kimi 0.36.1; device flow captured on 0.38.0'
  },
  antigravity: {
    mode: LOGIN_MODES.UNAVAILABLE,
    label: 'Antigravity',
    command: null,
    terminalHint: '/login',
    reason: 'The Antigravity CLI has no sign-in command of its own, so it can only be done from inside the agent.',
    verified: '2026-08-10 · agy 1.1.11'
  }
});

/**
 * @param {string} agent
 * @returns {{mode: string, label: string, command: string[]|null,
 *   acceptsCode?: boolean, codeHint?: string, statusCommand?: string[]|null,
 *   reason?: string, verified?: string|null}}
 */
function loginStrategyForAgent(agent) {
  return PROVIDER_LOGIN[agent] || {
    mode: LOGIN_MODES.UNAVAILABLE,
    label: agent || 'Agent',
    command: null,
    reason: 'CodeAgentSwarm does not know how this agent signs in.'
  };
}

/** True when Chat can run the flow itself instead of sending the user away. */
function canLoginFromChat(agent) {
  return loginStrategyForAgent(agent).mode === LOGIN_MODES.CLI;
}

/** A callback on the host's localhost cannot be reached by a remote browser. */
function loginStrategyForRemoteAgent(agent) {
  const strategy = loginStrategyForAgent(agent);
  if (agent === 'codex') return { ...strategy, command: ['codex', 'login', '--device-auth'] };
  if (strategy.mode !== LOGIN_MODES.CLI) return {
    ...strategy,
    terminalHint: null,
    reason: `${strategy.reason || ''} Complete sign-in on the remote computer.`,
  };
  return strategy;
}

/** True when Chat can clear the current credentials before starting login. */
function canSwitchAccount(agent) {
  const strategy = loginStrategyForAgent(agent);
  return strategy.mode === LOGIN_MODES.CLI
    && Array.isArray(strategy.logoutCommand)
    && strategy.logoutCommand.length > 0
    && Array.isArray(strategy.statusCommand)
    && strategy.statusCommand.length > 0;
}

/**
 * What the user types in Terminal view to sign in, for agents Chat cannot drive.
 *
 * It is the agent's OWN slash command, not a shell command: in Terminal view
 * that slot is running the agent's interface, so `kimi login` typed there would
 * go into the agent as text. This is the single most common way to get this
 * card wrong.
 */
function terminalLoginHint(agent) {
  return loginStrategyForAgent(agent).terminalHint || null;
}

/** The shell command, kept for documentation and for the auth banner. */
function loginCommandLine(agent) {
  const { command } = loginStrategyForAgent(agent);
  return Array.isArray(command) && command.length ? command.join(' ') : null;
}

module.exports = {
  LOGIN_MODES,
  PROVIDER_LOGIN,
  loginStrategyForAgent,
  loginStrategyForRemoteAgent,
  canLoginFromChat,
  canSwitchAccount,
  loginCommandLine,
  terminalLoginHint
};
