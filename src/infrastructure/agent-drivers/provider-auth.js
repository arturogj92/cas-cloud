const { canLoginFromChat } = require('./provider-login');

const PROVIDER_AUTH = Object.freeze({
  claude: {
    label: 'Claude Code',
    command: 'claude auth login'
  },
  codex: {
    label: 'Codex',
    command: 'codex login'
  },
  opencode: {
    label: 'OpenCode',
    command: 'opencode auth login'
  },
  kimi: {
    label: 'Kimi Code',
    command: 'kimi login'
  },
  antigravity: {
    label: 'Antigravity',
    command: null
  },
  grok: {
    label: 'Grok Build',
    command: 'grok login'
  },
  cursor: {
    label: 'Cursor Agent',
    command: 'cursor-agent login'
  }
});

const AUTH_ERROR_PATTERNS = Object.freeze([
  /\bnot logged in\b/i,
  /\bnot authenticated\b/i,
  /\bunauthenticated\b/i,
  /\bauthentication required\b/i,
  /\bplease (?:run|use) [^\n]*(?:login|log in|sign in)\b/i,
  /\brun [^\n]*(?:login|log in|sign in)\b/i,
  /\b(?:login|log in|sign in) (?:is )?required\b/i,
  /\bmissing (?:an? )?(?:api key|access token|auth token|credentials?)\b/i,
  /\b(?:invalid|expired) (?:api key|access token|auth token|credentials?)\b/i,
  /\b401\b[^\n]*(?:unauthorized|authentication|credentials?)/i,
  /\bauthentication[_\s]+failed\b/i,
  /\bfailed to authenticate\b/i,
  /\boauth (?:session|token)\b[^\n]*\bexpired\b/i
]);

const MISSING_PROVIDER_PATTERNS = Object.freeze([
  /\bENOENT\b/i,
  /\b(?:CLI|native binary|executable|command)\b[^\n]*\bnot found\b/i,
  /\bnot installed\b/i,
  /\b(?:claude|codex|antigravity|agy|opencode|kimi|grok|cursor(?:-agent)?)\b[^\n]*\bnot found\b/i
]);

const ACCOUNT_SWITCH_PATTERN = /\b(?:oauth_org_not_allowed|disabled Claude subscription access)\b/i;

class ProviderAuthenticationError extends Error {
  constructor(agent, message) {
    const status = createUnauthenticatedStatus(agent, message);
    super(status.message);
    this.name = 'ProviderAuthenticationError';
    this.code = 'provider_unauthenticated';
    this.providerStatus = status;
  }
}

class ProviderUnavailableError extends Error {
  constructor(agent) {
    const status = createProviderUnavailableStatus(agent);
    super(status.message);
    this.name = 'ProviderUnavailableError';
    this.code = 'provider_not_installed';
    this.providerStatus = status;
  }
}

function providerAuthMetadata(agent) {
  return PROVIDER_AUTH[agent] || {
    label: agent || 'Agent',
    command: null
  };
}

function createUnauthenticatedStatus(agent, detail) {
  const metadata = providerAuthMetadata(agent);
  const message = typeof detail === 'string' && detail.trim()
    ? detail.trim()
    : `${metadata.label} is not signed in.`;
  // The banner's own button is the only way out while the composer is locked,
  // so its label must match what pressing it will really do.
  const inChat = canLoginFromChat(agent);
  return {
    state: 'unauthenticated',
    agent,
    title: `${metadata.label} is not signed in`,
    message,
    command: metadata.command,
    canLoginFromChat: inChat,
    actionLabel: inChat ? 'Sign in' : 'Open CLI to sign in'
  };
}

function createProviderUnavailableStatus(agent) {
  const metadata = providerAuthMetadata(agent);
  return {
    state: 'not_installed',
    agent,
    title: `${metadata.label} is not installed`,
    message: `Install or configure ${metadata.label} in Settings › Providers, then retry Chat.`,
    actionLabel: 'Open Providers'
  };
}

function classifyProviderAuthError(agent, error) {
  if (error && error.code === 'provider_unauthenticated' && error.providerStatus) {
    return error.providerStatus;
  }

  const message = String(error && error.message ? error.message : error || '').trim();
  if (agent === 'claude' && ACCOUNT_SWITCH_PATTERN.test(message)) {
    return {
      state: 'access_restricted',
      agent,
      title: 'This Claude account cannot use Claude Code',
      message: 'Its organization blocks subscription access. Use another account or configure API billing.',
      command: 'claude auth logout',
      canLoginFromChat: true,
      switchAccount: true,
      actionLabel: 'Change account'
    };
  }
  if (!message || !AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return null;
  }
  return createUnauthenticatedStatus(agent, message);
}

function classifyProviderStartupError(agent, error) {
  const authStatus = classifyProviderAuthError(agent, error);
  if (authStatus) return authStatus;
  if (error && error.code === 'provider_not_installed' && error.providerStatus) {
    return error.providerStatus;
  }

  const message = String(error && error.message ? error.message : error || '').trim();
  if (error?.code !== 'ENOENT'
    && !MISSING_PROVIDER_PATTERNS.some((pattern) => pattern.test(message))) {
    return null;
  }
  return createProviderUnavailableStatus(agent);
}

function serializeProviderError(agent, error) {
  const message = String(error && error.message ? error.message : error || 'Provider error');
  const providerStatus = classifyProviderStartupError(agent, error);
  const providerCode = providerStatus?.state === 'not_installed'
    ? 'provider_not_installed'
    : 'provider_unauthenticated';
  return {
    error: message,
    ...(error && error.code ? { code: error.code } : {}),
    ...(providerStatus
      ? {
        code: providerCode,
        providerStatus
      }
      : {})
  };
}

module.exports = {
  ProviderAuthenticationError,
  ProviderUnavailableError,
  classifyProviderAuthError,
  classifyProviderStartupError,
  createProviderUnavailableStatus,
  createUnauthenticatedStatus,
  providerAuthMetadata,
  serializeProviderError
};
