const {
  CHAT_PERMISSION_MODES,
  normalizePermissionModeForAgent,
} = require('../agent-drivers/chat-permission-modes');
const { SUPPORTED_AGENTS } = require('../agent-drivers/driver-chat-manager');

const SETTING_KEY = 'headless_chat_last_used_selection';
const VALID_PERMISSION_MODES = new Set(Object.values(CHAT_PERMISSION_MODES));

function cleanAgent(agent) {
  return SUPPORTED_AGENTS.includes(agent) ? agent : null;
}

function cleanPermissionMode(permissionMode) {
  return VALID_PERMISSION_MODES.has(permissionMode) ? permissionMode : null;
}

function cleanEffort(effort) {
  if (typeof effort === 'boolean') return effort;
  if (typeof effort !== 'string') return null;
  const value = effort.trim();
  return value.length > 0 && value.length <= 100 ? value : null;
}

function cleanEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const permissionMode = cleanPermissionMode(value.permissionMode);
  const effort = cleanEffort(value.effort);
  return {
    ...(permissionMode ? { permissionMode } : {}),
    ...(effort !== null ? { effort } : {}),
  };
}

function cleanStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { byAgent: {}, fallbackPermissionMode: null };
  }
  const byAgent = {};
  if (value.byAgent && typeof value.byAgent === 'object' && !Array.isArray(value.byAgent)) {
    for (const agent of SUPPORTED_AGENTS) {
      const entry = cleanEntry(value.byAgent[agent]);
      if (Object.keys(entry).length) byAgent[agent] = entry;
    }
  }
  return {
    byAgent,
    fallbackPermissionMode: cleanPermissionMode(value.fallbackPermissionMode),
  };
}

/**
 * Persistent last-used Chat configuration for the headless runtime.
 *
 * Permissions mirror Desktop: remember one value per agent plus a cross-agent
 * fallback, then map that fallback through the target provider's capabilities.
 * Reasoning stays per agent because provider values are not interchangeable.
 */
function createHeadlessChatPreferences({ getSetting, saveSetting } = {}) {
  let cache = null;

  function readAll() {
    if (cache) return cache;
    try {
      const raw = typeof getSetting === 'function' ? getSetting(SETTING_KEY) : null;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      cache = cleanStore(parsed);
    } catch (_) {
      cache = cleanStore(null);
    }
    return cache;
  }

  function read(agent) {
    const key = cleanAgent(agent);
    if (!key) return {};
    const store = readAll();
    const own = store.byAgent[key] || {};
    const permissionMode = own.permissionMode || store.fallbackPermissionMode;
    return {
      ...(permissionMode
        ? { permissionMode: normalizePermissionModeForAgent(key, permissionMode) }
        : {}),
      ...(own.effort !== undefined ? { effort: own.effort } : {}),
    };
  }

  function apply(agent, launchOptions = {}) {
    const remembered = read(agent);
    return {
      ...launchOptions,
      ...(launchOptions.permissionMode === undefined && remembered.permissionMode
        ? { permissionMode: remembered.permissionMode }
        : {}),
      ...(launchOptions.effort === undefined && remembered.effort !== undefined
        ? { effort: remembered.effort }
        : {}),
    };
  }

  function write(agent, selection = {}) {
    const key = cleanAgent(agent);
    if (!key) return false;
    const permissionMode = cleanPermissionMode(selection.permissionMode);
    const effort = cleanEffort(selection.effort);
    if (!permissionMode && effort === null) return false;

    const store = readAll();
    const previous = store.byAgent[key] || {};
    const nextEntry = {
      ...previous,
      ...(permissionMode ? { permissionMode } : {}),
      ...(effort !== null ? { effort } : {}),
    };
    const next = {
      byAgent: { ...store.byAgent, [key]: nextEntry },
      fallbackPermissionMode: permissionMode || store.fallbackPermissionMode,
    };
    if (JSON.stringify(next) === JSON.stringify(store)) return false;

    try {
      if (typeof saveSetting !== 'function') return false;
      const result = saveSetting(SETTING_KEY, next);
      if (result !== true && result?.success !== true) return false;
      cache = next;
      return true;
    } catch (_) {
      return false;
    }
  }

  return { apply, read, write };
}

module.exports = {
  SETTING_KEY,
  createHeadlessChatPreferences,
};
