const CHAT_PERMISSION_MODES = Object.freeze({
  APPROVAL_REQUIRED: 'approval-required',
  AUTO_ACCEPT_EDITS: 'auto-accept-edits',
  AUTO: 'auto',
  FULL_ACCESS: 'full-access'
});

const CHAT_INTERACTION_MODES = Object.freeze({
  DEFAULT: 'default',
  AGENT: 'agent',
  PLAN: 'plan',
  ASK: 'ask'
});

const CHAT_PERMISSION_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    id: CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    label: 'Ask before actions',
    description: 'Read-only until you approve changes and commands'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    label: 'Auto-accept edits',
    description: 'Allow workspace edits; ask before commands and risky actions'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO,
    label: 'Auto',
    description: 'Let the provider review routine actions; ask when risk remains'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.FULL_ACCESS,
    label: 'Full access',
    description: 'Turbo/Yolo mode without approval prompts'
  })
]);

const CODEX_PERMISSION_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    label: 'Ask for approval',
    description: 'Work in this workspace; ask before internet access or editing files outside it'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO,
    label: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.FULL_ACCESS,
    label: 'Full Access',
    description: 'Edit outside this workspace and access the internet without asking'
  })
]);

const CLAUDE_PERMISSION_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    id: CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    label: 'Manual',
    description: 'Ask before edits, commands, and other protected actions'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    label: 'Accept edits',
    description: 'Accept file edits automatically; ask before other actions'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO,
    label: 'Auto mode',
    description: 'Use Claude’s safety classifier and ask only when needed'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.FULL_ACCESS,
    label: 'Bypass permissions',
    description: 'Skip all permission checks; available only when enabled at startup'
  })
]);

const ACP_PERMISSION_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    id: CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    label: 'Ask before actions',
    description: 'Show every permission request from the provider'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    label: 'Auto-approve edits',
    description: 'Approve file edits; ask before commands and other actions'
  }),
  Object.freeze({
    id: CHAT_PERMISSION_MODES.FULL_ACCESS,
    label: 'Always approve',
    description: 'Automatically choose an allow response for every permission request'
  })
]);

const PERMISSION_MODE_IDS_BY_AGENT = Object.freeze({
  claude: Object.freeze([
    CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    CHAT_PERMISSION_MODES.AUTO,
    CHAT_PERMISSION_MODES.FULL_ACCESS
  ]),
  codex: Object.freeze([
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    CHAT_PERMISSION_MODES.AUTO,
    CHAT_PERMISSION_MODES.FULL_ACCESS
  ]),
  opencode: Object.freeze([
    CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    CHAT_PERMISSION_MODES.FULL_ACCESS
  ]),
  kimi: Object.freeze([
    CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    CHAT_PERMISSION_MODES.FULL_ACCESS
  ]),
  grok: Object.freeze([
    CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    CHAT_PERMISSION_MODES.FULL_ACCESS
  ]),
  cursor: Object.freeze([
    CHAT_PERMISSION_MODES.APPROVAL_REQUIRED,
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    CHAT_PERMISSION_MODES.FULL_ACCESS
  ]),
  antigravity: Object.freeze([CHAT_PERMISSION_MODES.FULL_ACCESS])
});
const PERMISSION_AGENT_LABELS = Object.freeze({
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  grok: 'Grok Build',
  cursor: 'Cursor Agent'
});

function normalizeChatPermissionMode(value) {
  const normalized = String(value || '').replace(/[_\s]/g, '-').toLowerCase();
  if ([
    CHAT_PERMISSION_MODES.FULL_ACCESS,
    'bypasspermissions',
    'bypass-permissions',
    'turbo',
    'yolo',
    'always-approve'
  ].includes(normalized)) {
    return CHAT_PERMISSION_MODES.FULL_ACCESS;
  }
  if ([
    CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS,
    'acceptedits',
    'accept-edits'
  ].includes(normalized)) {
    return CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS;
  }
  if ([
    CHAT_PERMISSION_MODES.AUTO,
    'auto-mode',
    'auto-review',
    'approve-for-me'
  ].includes(normalized)) {
    return CHAT_PERMISSION_MODES.AUTO;
  }
  return CHAT_PERMISSION_MODES.APPROVAL_REQUIRED;
}

function normalizeChatInteractionMode(value) {
  const normalized = String(value || '').replace(/[_\s]/g, '-').toLowerCase();
  if (normalized === CHAT_INTERACTION_MODES.AGENT) return CHAT_INTERACTION_MODES.AGENT;
  if (normalized === CHAT_INTERACTION_MODES.ASK) return CHAT_INTERACTION_MODES.ASK;
  return normalized === CHAT_INTERACTION_MODES.PLAN
    || normalized === 'plan-mode'
    ? CHAT_INTERACTION_MODES.PLAN
    : CHAT_INTERACTION_MODES.DEFAULT;
}

function normalizeInteractionModeForAgent(agent, value) {
  const normalized = normalizeChatInteractionMode(value);
  if (agent === 'cursor') {
    return normalized === CHAT_INTERACTION_MODES.DEFAULT
      ? CHAT_INTERACTION_MODES.AGENT
      : normalized;
  }
  return agent === 'claude' ? normalized : CHAT_INTERACTION_MODES.DEFAULT;
}

function interactionModesForAgent(agent) {
  if (agent === 'cursor') {
    return [
      CHAT_INTERACTION_MODES.AGENT,
      CHAT_INTERACTION_MODES.PLAN,
      CHAT_INTERACTION_MODES.ASK
    ];
  }
  return agent === 'claude'
    ? [CHAT_INTERACTION_MODES.DEFAULT, CHAT_INTERACTION_MODES.PLAN]
    : [];
}

function permissionOptionsForAgent(agent, {
  allowBypassPermissions = false
} = {}) {
  if (agent === 'codex') return CODEX_PERMISSION_MODE_OPTIONS.map((option) => ({ ...option }));
  if (agent === 'claude') {
    return CLAUDE_PERMISSION_MODE_OPTIONS
      .filter((option) => (
        option.id !== CHAT_PERMISSION_MODES.FULL_ACCESS || allowBypassPermissions
      ))
      .map((option) => ({ ...option }));
  }
  if (['opencode', 'kimi', 'grok', 'cursor'].includes(agent)) {
    return ACP_PERMISSION_MODE_OPTIONS.map((option) => {
      if (
        option.id === CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS
        && PERMISSION_AGENT_LABELS[agent]
      ) {
        return {
          ...option,
          description: `Auto-approve ${PERMISSION_AGENT_LABELS[agent]} file edits; ask for commands and other actions`
        };
      }
      return { ...option };
    });
  }
  const supported = PERMISSION_MODE_IDS_BY_AGENT[agent]
    || PERMISSION_MODE_IDS_BY_AGENT.opencode;
  return CHAT_PERMISSION_MODE_OPTIONS
    .filter((option) => supported.includes(option.id))
    .map((option) => {
      if (option.id === CHAT_PERMISSION_MODES.AUTO && agent === 'codex') {
        return {
          ...option,
          description: 'Codex reviews routine actions automatically; asks when risk remains'
        };
      }
      if (option.id === CHAT_PERMISSION_MODES.AUTO && agent === 'claude') {
        return {
          ...option,
          description: 'Claude decides when it can continue safely and asks when needed'
        };
      }
      if (
        option.id === CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS
        && PERMISSION_AGENT_LABELS[agent]
      ) {
        return {
          ...option,
          description: `Auto-approve ${PERMISSION_AGENT_LABELS[agent]} file edits; ask for commands and other actions`
        };
      }
      if (option.id === CHAT_PERMISSION_MODES.FULL_ACCESS && agent === 'antigravity') {
        return {
          ...option,
          description: 'Required by Antigravity print mode; no approval prompts'
        };
      }
      return option;
    });
}

function normalizePermissionModeForAgent(agent, value) {
  if (agent === 'antigravity') return CHAT_PERMISSION_MODES.FULL_ACCESS;
  let normalized = normalizeChatPermissionMode(value);
  // Codex 0.146 folded the old read-only/untrusted profile out of its TUI.
  // A saved legacy "approval-required" session now means the native
  // "Ask for approval" profile: workspace-write + on-request + user review.
  if (agent === 'codex' && normalized === CHAT_PERMISSION_MODES.APPROVAL_REQUIRED) {
    normalized = CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS;
  }
  const supported = PERMISSION_MODE_IDS_BY_AGENT[agent]
    || PERMISSION_MODE_IDS_BY_AGENT.opencode;
  return supported.includes(normalized)
    ? normalized
    : agent === 'codex'
      ? CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS
      : CHAT_PERMISSION_MODES.APPROVAL_REQUIRED;
}

/**
 * Native startup / turn policy for providers with first-class permission
 * controls. ACP providers use the normalized mode in DriverChatManager.
 */
function permissionModeForDriver(agent, value) {
  const mode = normalizePermissionModeForAgent(agent, value);
  if (agent === 'claude') {
    return {
      permissionMode: mode === CHAT_PERMISSION_MODES.FULL_ACCESS
        ? 'bypassPermissions'
        : mode === CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS
          ? 'acceptEdits'
          : mode === CHAT_PERMISSION_MODES.AUTO
            ? 'auto'
          : 'default',
      // Claude refuses an in-session switch to bypass unless the child was
      // explicitly launched with the enabling flag. Standard sessions must
      // not silently opt in merely because the Chat UI exists.
      allowDangerouslySkipPermissions: mode === CHAT_PERMISSION_MODES.FULL_ACCESS
    };
  }
  if (agent === 'codex') {
    if (mode === CHAT_PERMISSION_MODES.FULL_ACCESS) {
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        approvalsReviewer: 'user'
      };
    }
    if (mode === CHAT_PERMISSION_MODES.AUTO) {
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        approvalsReviewer: 'auto_review'
      };
    }
    if (mode === CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS) {
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user'
      };
    }
    return {
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      approvalsReviewer: 'user'
    };
  }
  return {};
}

function shouldAutoApproveRequest(value, event) {
  const mode = normalizeChatPermissionMode(value);
  if (mode === CHAT_PERMISSION_MODES.FULL_ACCESS) return true;
  if (mode !== CHAT_PERMISSION_MODES.AUTO_ACCEPT_EDITS) return false;
  const requestType = String(event?.payload?.requestType || '').toLowerCase();
  return requestType.includes('file_change')
    || requestType.includes('file-change')
    || requestType.includes('edit');
}

module.exports = {
  CHAT_PERMISSION_MODES,
  CHAT_INTERACTION_MODES,
  CHAT_PERMISSION_MODE_OPTIONS,
  normalizeChatPermissionMode,
  normalizeChatInteractionMode,
  normalizeInteractionModeForAgent,
  normalizePermissionModeForAgent,
  interactionModesForAgent,
  permissionOptionsForAgent,
  permissionModeForDriver,
  shouldAutoApproveRequest,
  PERMISSION_MODE_IDS_BY_AGENT
};
