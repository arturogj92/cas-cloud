/**
 * OpencodeHooksManager - Hook management for the SST opencode CLI.
 *
 * Unlike Claude/Codex (which merge hooks into a config file) opencode has a
 * native PLUGIN system: any ESM module under ~/.config/opencode/plugins/ is
 * auto-loaded at startup. CodeAgentSwarm's ENTIRE opencode integration is
 * delivered as a single generated plugin file:
 *
 *   ~/.config/opencode/plugins/codeagentswarm.js
 *
 * That one plugin covers all three hook groups (mirrors the Antigravity manager):
 *   - notifications: forwards `session.idle` -> claude_finished and
 *     `permission.asked` -> confirmation_needed to the CAS webhook server.
 *   - fileChange:    snapshots write/edit/patch tool calls (tool.execute.before /
 *     .after) and POSTs file_edited events that feed the diff viewer.
 *   - titleGate:     a retained toggle group with NO runtime effect in opencode.
 *     The only per-tool lever opencode offers is throwing in tool.execute.before,
 *     which is a hard DENY, and CodeAgentSwarm hooks must never block a tool call
 *     (a session without the CAS MCP tools cannot comply with a gate). Kept only so
 *     the Privacy toggle and boot reconciler expose a uniform surface across agents.
 *
 * VERIFIED empirically against opencode v1.17.13:
 *   - plugins export `export const X = async (ctx) => ({ ...hooks })`.
 *   - `event: async ({ event }) => {}` receives { type, properties } events,
 *     including session.created (properties.info.parentID set for subagents),
 *     session.idle (properties.sessionID), permission.asked, file.edited.
 *   - `"tool.execute.before"(input, output)` where input = { tool, sessionID,
 *     callID }, output = { args }; throwing an Error DENIES the tool call.
 *   - `"tool.execute.after"(input, output)`.
 *
 * The plugin no-ops entirely when not launched inside a CodeAgentSwarm terminal.
 *
 * Mirrors the public surface of CodexHooksManager / AntigravityHooksManager so
 * the cross-agent service (HookSystemPreferences, reconcileAgentHooks, the
 * per-agent Privacy toggles) can drive every manager uniformly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// The three hook groups this manager can enable/disable independently.
const ALL_GROUPS = ['notifications', 'fileChange', 'titleGate'];
// Substring that uniquely identifies OUR generated plugin file.
const PLUGIN_SIGNATURE = 'CodeAgentSwarm';
// Marker line prefix carrying the enabled-groups list (parsed on restart so the
// granular Privacy toggles converge, like the Antigravity reconcile pattern).
const GROUPS_MARKER_PREFIX = '// @cas-groups:';

class OpencodeHooksManager {
    constructor(options = {}) {
        this.isDevMode = options.isDevMode || false;
        // Match WebhookServer ports: Production 45782, Development 45783.
        this.webhookPort = this.isDevMode ? 45783 : 45782;
        this.isWindows = process.platform === 'win32';

        // opencode config dir is XDG-style (~/.config/opencode), honoring XDG_CONFIG_HOME.
        const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        this.configDir = path.join(configBase, 'opencode');
        this.pluginsDir = path.join(this.configDir, 'plugins');
        this.pluginPath = path.join(this.pluginsDir, 'codeagentswarm.js');
        // Kept for checkHooksStatus display (the MCP config file lives alongside).
        this.configPath = path.join(this.configDir, 'opencode.json');
        // Path shown by the Privacy panel as "where our config lives" for this agent.
        this.settingsPath = this.pluginPath;

        // Which CodeAgentSwarm hook groups are currently desired in the plugin.
        // Seed from disk so a per-agent toggle survives a restart (default all-on
        // when no plugin exists yet). reconcileAgentHooks() then flips these via
        // the granular install/remove*Hooks methods and we rebuild the plugin.
        this.enabledGroups = this._readGroupsFromDisk();

        console.log(`[OpencodeHooksManager] Initialized (${this.isDevMode ? 'DEV' : 'PROD'} mode, port ${this.webhookPort}, platform: ${this.isWindows ? 'Windows' : 'Unix'})`);
    }

    /**
     * Read the enabled-groups set from the installed plugin's marker line.
     * Defaults to all groups enabled when the plugin file does not exist yet.
     * Fail-safe: any read/parse error also defaults to all groups.
     * @returns {Set<string>}
     * @private
     */
    _readGroupsFromDisk() {
        try {
            if (!fs.existsSync(this.pluginPath)) {
                return new Set(ALL_GROUPS);
            }
            const content = fs.readFileSync(this.pluginPath, 'utf8');
            const groups = this._parseGroupsMarker(content);
            return groups || new Set(ALL_GROUPS);
        } catch (error) {
            return new Set(ALL_GROUPS);
        }
    }

    /**
     * Parse the `// @cas-groups: a,b,c` marker from plugin source.
     * @param {string} content
     * @returns {Set<string>|null} null when no marker is present.
     * @private
     */
    _parseGroupsMarker(content) {
        if (!content) return null;
        const line = content.split('\n').find(l => l.trim().startsWith(GROUPS_MARKER_PREFIX));
        if (!line) return null;
        const raw = line.slice(line.indexOf(GROUPS_MARKER_PREFIX) + GROUPS_MARKER_PREFIX.length);
        const groups = raw.split(',')
            .map(s => s.trim())
            .filter(g => ALL_GROUPS.includes(g));
        return new Set(groups);
    }

    /**
     * Build the generated plugin source, embedding the currently-enabled groups
     * both in the `@cas-groups:` marker and the ENABLED const.
     * @returns {string}
     */
    buildPluginSource() {
        const groups = ALL_GROUPS.filter(g => this.enabledGroups.has(g));
        const marker = `${GROUPS_MARKER_PREFIX} ${groups.join(',')}`;
        const enabled = ALL_GROUPS
            .map(g => `${g}: ${this.enabledGroups.has(g)}`)
            .join(', ');

        // NOTE: the plugin body below uses NO backticks and NO ${...} sequences,
        // so it embeds cleanly inside this template literal. Keep it that way.
        return `// CodeAgentSwarm opencode plugin - Auto-generated by CodeAgentSwarm - Do not edit manually.
${marker}
// Forwards opencode events to the CodeAgentSwarm webhook (notifications + file-change
// tracking). No-ops entirely when not running inside a CodeAgentSwarm terminal.
// The titleGate flag in ENABLED is retained for cross-agent toggle uniformity but has
// NO runtime effect here: the only per-tool lever opencode offers is throwing in
// tool.execute.before, which is a hard DENY, and CodeAgentSwarm hooks must never block
// a tool call (a session without the CAS MCP tools cannot comply with a gate).
const ENABLED = { ${enabled} };
const DEV_PORT = 45783;
const PROD_PORT = 45782;
// opencode tool names are lowercase. Map them to the FileChangeTracker's
// Gemini-style names: 'write' -> write_file (recorded as a "created" change when
// original content is empty) and 'edit'/'patch' -> replace ("modified"). Both
// carry full originalContent/newContent, so the tracker renders a full diff.
const TOOLNAME_MAP = { write: 'write_file', edit: 'replace', patch: 'replace' };

export const CodeAgentSwarmPlugin = async () => {
  const quadrant = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
  const terminalIdEnv = process.env.CODEAGENTSWARM_TERMINAL_ID;
  if (!quadrant && !terminalIdEnv) return {};

  const fs = await import('node:fs');

  const terminalId = String(quadrant || '0');
  // Post to THIS instance's webhook port (injected into the opencode process env by
  // CodeAgentSwarm); fall back to the legacy dev-first / prod probe for older builds.
  const envPort = Number(process.env.CODEAGENTSWARM_WEBHOOK_PORT);
  const PORTS = Number.isInteger(envPort) && envPort > 0 ? [envPort] : [DEV_PORT, PROD_PORT];
  const WRITE_TOOLS = new Set(['write', 'edit', 'patch']);
  const childSessions = new Set();
  const preState = new Map();

  async function post(payload) {
    const body = JSON.stringify(payload);
    for (const port of PORTS) {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(2000)
        });
        if (res && res.ok) return;
      } catch (e) { /* try next port */ }
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (!event || !event.type) return;
        if (event.type === 'session.created') {
          const info = event.properties && event.properties.info;
          if (info && info.parentID) childSessions.add(info.id);
        }
        if (!ENABLED.notifications) return;
        // Driver-backed Chat: the ACP driver already reports turn ends and
        // permission requests; this plugin must not double-report them.
        if (process.env.CODEAGENTSWARM_DRIVER_CHAT) return;
        if (event.type === 'session.idle') {
          const sid = event.properties && event.properties.sessionID;
          if (sid && childSessions.has(sid)) return;
          await post({ type: 'claude_finished', terminalId, agent: 'opencode' });
        } else if (event.type === 'permission.asked') {
          const p = event.properties || {};
          const tool = (p.permission && (p.permission.type || p.permission.title)) || p.type || 'opencode-action';
          await post({ type: 'confirmation_needed', terminalId, agent: 'opencode', tool: String(tool) });
        }
      } catch (e) { /* never break opencode */ }
    },
    'tool.execute.before': async (input, output) => {
      if (!ENABLED.fileChange) return;
      try {
        if (!input || !WRITE_TOOLS.has(input.tool)) return;
        const args = (output && output.args) || {};
        const filePath = args.filePath || args.file_path || null;
        if (!filePath) return;
        let originalContent = '';
        try { if (fs.existsSync(filePath)) originalContent = fs.readFileSync(filePath, 'utf8'); } catch (e) {}
        preState.set(input.callID, { filePath, originalContent, tool: input.tool });
      } catch (e) { /* fail-safe */ }
    },
    'tool.execute.after': async (input, output) => {
      if (!ENABLED.fileChange) return;
      try {
        if (!input || !WRITE_TOOLS.has(input.tool)) return;
        const st = preState.get(input.callID);
        if (!st) return;
        preState.delete(input.callID);
        let newContent = '';
        try { if (fs.existsSync(st.filePath)) newContent = fs.readFileSync(st.filePath, 'utf8'); } catch (e) {}
        if (newContent === st.originalContent) return;
        await post({
          type: 'file_edited',
          terminalId,
          toolName: TOOLNAME_MAP[st.tool] || st.tool,
          filePath: st.filePath,
          content: newContent,
          originalContent: st.originalContent,
          newContent
        });
      } catch (e) { /* fail-safe */ }
    }
  };
};
`;
    }

    /**
     * Write the plugin file to reflect the current enabledGroups — or delete it
     * when no groups are enabled. Wrapped so a filesystem failure never throws
     * into the cross-agent reconcile path.
     * @returns {Promise<{success: boolean, error?: string}>}
     * @private
     */
    async _applyPlugin() {
        try {
            if (this.enabledGroups.size === 0) {
                if (fs.existsSync(this.pluginPath)) {
                    fs.rmSync(this.pluginPath, { force: true });
                }
                return { success: true };
            }
            if (!fs.existsSync(this.pluginsDir)) {
                fs.mkdirSync(this.pluginsDir, { recursive: true });
            }
            fs.writeFileSync(this.pluginPath, this.buildPluginSource(), 'utf8');
            return { success: true };
        } catch (error) {
            console.error('[OpencodeHooksManager] Error applying plugin:', error);
            return { success: false, error: error.message };
        }
    }

    // ============================================================
    // Public lifecycle
    // ============================================================

    async installHooks() {
        this.enabledGroups = new Set(ALL_GROUPS);
        return this._applyPlugin();
    }

    async removeHooks() {
        try {
            // Only remove OUR generated file (identified by path + signature).
            if (fs.existsSync(this.pluginPath)) {
                let isOurs = false;
                try {
                    isOurs = fs.readFileSync(this.pluginPath, 'utf8').includes(PLUGIN_SIGNATURE);
                } catch (e) { /* treat as not ours */ }
                if (isOurs) {
                    fs.rmSync(this.pluginPath, { force: true });
                }
            }
            this.enabledGroups = new Set();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ── Granular hook groups (mirror Antigravity) so reconcileAgentHooks() can
    //    honor each Privacy toggle independently. Each flips the desired-set and
    //    rebuilds the single plugin. ──────────────────────────────────────────
    async installNotificationsHooks() { this.enabledGroups.add('notifications'); return this._applyPlugin(); }
    async removeNotificationsHooks()  { this.enabledGroups.delete('notifications'); return this._applyPlugin(); }
    async installFileChangeHooks()    { this.enabledGroups.add('fileChange'); return this._applyPlugin(); }
    async removeFileChangeHooks()     { this.enabledGroups.delete('fileChange'); return this._applyPlugin(); }
    async installTitleGateHooks()     { this.enabledGroups.add('titleGate'); return this._applyPlugin(); }
    async removeTitleGateHooks()      { this.enabledGroups.delete('titleGate'); return this._applyPlugin(); }

    // ── Status readers (used by the Privacy panel via HookSystemPreferences).
    //    Read the installed plugin's marker line from disk — fast, fail-safe. ──
    async _hasGroup(group) {
        try {
            if (!fs.existsSync(this.pluginPath)) return false;
            const content = fs.readFileSync(this.pluginPath, 'utf8');
            const groups = this._parseGroupsMarker(content);
            return !!(groups && groups.has(group));
        } catch (error) {
            return false;
        }
    }

    async hasNotificationsHooks() { return this._hasGroup('notifications'); }
    async hasFileChangeHooks()    { return this._hasGroup('fileChange'); }
    async hasTitleGateHooks()     { return this._hasGroup('titleGate'); }

    async checkHooksStatus() {
        const hasNotifyHook = await this.hasNotificationsHooks();
        const hasFileChangeTracking = await this.hasFileChangeHooks();
        const hasTitleGate = await this.hasTitleGateHooks();
        return {
            installed: hasNotifyHook,
            hasNotifyHook,
            hasFileChangeTracking,
            hasTitleGate,
            hasPreToolHook: hasTitleGate,
            hasPostToolHook: hasFileChangeTracking,
            configPath: this.pluginPath,
            notify: null,
            limitations: [
                'Delivered as a native opencode plugin (~/.config/opencode/plugins/codeagentswarm.js)'
            ]
        };
    }

    async ensureFullConfiguration() {
        const hooksResult = await this.installHooks();
        return { success: hooksResult.success, hooks: hooksResult };
    }

    // Write the plugin file for the CURRENT enabledGroups (no group changes).
    async ensureHookScripts() {
        return this._applyPlugin();
    }
}

module.exports = OpencodeHooksManager;
