/**
 * GrokConfigStrategy - Configuration management for xAI's Grok Build CLI
 *
 * Extends AgentConfigStrategy to provide Grok-specific configuration:
 * - Manages the global instruction file at ~/.grok/rules/codeagentswarm.md
 * - Manages ~/.grok/config.toml MCP server configuration (TOML format)
 *
 * Key facts (verified against a real ~/.grok produced by grok v0.2.x):
 * - Data root is ~/.grok, relocatable via GROK_HOME (config, sessions, skills,
 *   rules and hooks all move with it).
 * - Global instructions are every markdown file under <GROK_HOME>/rules/, so we own
 *   exactly ONE file there (codeagentswarm.md) and never touch the user's own rules.
 * - MCP servers live in config.toml under `[mcp_servers.<name>]` (the same table
 *   shape Codex uses), with `command`, `args` and an `enabled` flag.
 * - MCP tool names follow the `mcp__<server>__<tool>` convention, so
 *   `mcp__codeagentswarm-tasks__*` works unchanged.
 *
 * The MCP block is written between explicit `# CODEAGENTSWARM MCP START/END`
 * comments so removal is byte-clean; removal ALSO strips any nested sub-table
 * (`[mcp_servers.codeagentswarm-tasks.<...>]`) Grok may have persisted, because a
 * dangling sub-table implicitly recreates a transport-less parent table and breaks
 * config load (the exact Codex failure mode).
 */

const fs = require('fs');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');
const { hasOwnedMcpRuntime } = require('./mcp-entry-ownership');

// Markers for the CodeAgentSwarm section in the instruction markdown (identical to
// Codex/Kimi/opencode).
const INSTRUCTIONS_START_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const INSTRUCTIONS_END_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// MCP server key in config.toml
const MCP_SERVER_KEY = 'codeagentswarm-tasks';

// Fences around our config.toml MCP block, so removal never guesses.
const MCP_BLOCK_START = '# CODEAGENTSWARM MCP START';
const MCP_BLOCK_END = '# CODEAGENTSWARM MCP END';

// Env vars the MCP stdio server needs to attribute tool calls to THIS terminal.
// Grok 1.0 expands ${VAR} references inside the native `env` map.
const MCP_ENV_VARS = [
    'CODEAGENTSWARM_ACTIVE_SESSION',
    'CODEAGENTSWARM_CURRENT_QUADRANT',
    'CODEAGENTSWARM_DB_PATH',
    'CODEAGENTSWARM_AGENT_TYPE',
    'CODEAGENTSWARM_WEBHOOK_PORT',
    'CODEAGENTSWARM_TERMINAL_ID',
    'CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED',
    'CODEAGENTSWARM_SESSION_BRIDGE_PORT',
    'CODEAGENTSWARM_SESSION_BRIDGE_TOKEN'
];

// Fences around the [compat.claude] block we own. Grok imports Claude's
// ~/.claude hooks by default (title-gate, stop, bash snapshot…), so a Grok
// session ends up running TWO title-gates and TWO Stop notifiers. That is
// latency + false denies + status posts attributed to the wrong dialect.
// We pin `hooks = false` under an owned fence so a user can still re-enable
// Claude skills/MCP compat elsewhere; we only silence the hook import.
const COMPAT_CLAUDE_START = '# CODEAGENTSWARM COMPAT.CLAUDE START';
const COMPAT_CLAUDE_END = '# CODEAGENTSWARM COMPAT.CLAUDE END';

class GrokConfigStrategy extends AgentConfigStrategy {
    constructor() {
        super();
        // Grok keeps everything under one relocatable data root.
        const override = (process.env.GROK_HOME || '').trim();
        this.configDir = override || path.join(this.homeDir, '.grok');
        this.configTomlPath = path.join(this.configDir, 'config.toml');

        // Path to the codeagentswarm-tasks MCP stdio server (same one Claude/Codex register).
        this.mcpServerConfig = {
            command: 'node',
            args: [
                path.join(
                    this.homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks',
                    'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js'
                )
            ]
        };
    }

    // ==================== IMPLEMENT ABSTRACT METHODS ====================

    getAgentId() {
        return 'grok';
    }

    getDisplayName() {
        return 'Grok Build';
    }

    getIconPath() {
        return '../../../assets/icons/grok-icon.svg';
    }

    getSettingsPath() {
        return this.configDir;
    }

    getInstructionsFileName() {
        // Grok loads every *.md under <GROK_HOME>/rules/ as a global rule file.
        return path.join('rules', 'codeagentswarm.md');
    }

    getSectionStartMarker() {
        return INSTRUCTIONS_START_MARKER;
    }

    getSectionEndMarker() {
        return INSTRUCTIONS_END_MARKER;
    }

    getTemplatePath(variant = 'full') {
        let file;
        if (variant === 'titles-only') {
            file = 'grok-md-titles-section.md';
        } else if (variant === 'tasks-only') {
            file = 'grok-md-tasks-only-section.md';
        } else {
            file = 'grok-md-tasks-section.md';
        }
        return path.join(__dirname, 'templates', file);
    }

    getMcpConfigPath() {
        return this.configTomlPath;
    }

    /**
     * Check if the MCP server is configured in config.toml.
     */
    hasMcpServer() {
        try {
            if (!fs.existsSync(this.configTomlPath)) {
                return false;
            }
            const content = fs.readFileSync(this.configTomlPath, 'utf8');
            return content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`);
        } catch (error) {
            console.error('[grok] Error checking MCP server:', error);
            return false;
        }
    }

    /**
     * Build the fenced TOML block for the MCP server.
     * @returns {string}
     */
    buildMcpServerToml() {
        const serverPath = this.mcpServerConfig.args[0].replace(/\\/g, '/');
        const envLiteral = MCP_ENV_VARS
            .map((name) => `${name} = "\${${name}}"`)
            .join(', ');
        return `${MCP_BLOCK_START}
[mcp_servers.${MCP_SERVER_KEY}]
command = "${this.mcpServerConfig.command}"
args = ["${serverPath}"]
enabled = true
env = { ${envLiteral} }
${MCP_BLOCK_END}
`;
    }

    /**
     * True when our MCP block is present, points at THIS machine's stdio server
     * path, is enabled, and carries Grok's native env map. Older installs using
     * the ignored env_vars field are rewritten on the next enable.
     * @param {string} content
     * @returns {boolean}
     */
    isMcpBlockCurrent(content) {
        if (!content || !content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`)) {
            return false;
        }
        const serverPath = this.mcpServerConfig.args[0].replace(/\\/g, '/');
        if (!content.includes(serverPath)) {
            return false;
        }
        // enabled = true (tolerate whitespace / comments-free TOML).
        if (!/enabled\s*=\s*true\b/i.test(content)) {
            return false;
        }
        if (!/\benv\s*=\s*\{/.test(content) || /\benv_vars\s*=/.test(content)) {
            return false;
        }
        return MCP_ENV_VARS.every((name) => content.includes(`${name} = "\${${name}}"`));
    }

    /**
     * Build (or return) the fenced [compat.claude] block that disables Claude
     * hook import. Skills/MCP/agents_md compat stay at Grok's defaults.
     * @returns {string}
     */
    buildClaudeHooksCompatToml() {
        return `${COMPAT_CLAUDE_START}
[compat.claude]
hooks = false
${COMPAT_CLAUDE_END}
`;
    }

    /**
     * True when a bare `[compat.claude]` table header exists outside our fence
     * (user- or org-authored). TOML 1.0 forbids redefining a table, so we must
     * never append a second header when this is true.
     * @param {string} content
     * @returns {boolean}
     */
    hasExternalCompatClaudeTable(content) {
        if (!content) return false;
        // Strip our fenced region so we only see foreign ownership.
        let scan = content;
        const start = scan.indexOf(COMPAT_CLAUDE_START);
        const end = scan.indexOf(COMPAT_CLAUDE_END);
        if (start !== -1 && end !== -1 && end > start) {
            scan = scan.slice(0, start) + scan.slice(end + COMPAT_CLAUDE_END.length);
        }
        return /^\s*\[\s*compat\.claude\s*\]\s*$/m.test(scan);
    }

    /**
     * Inside an existing user-owned [compat.claude] table, set hooks = false
     * (or leave it if already false). Does not add a second table header.
     * @param {string} content
     * @returns {string}
     */
    _patchHooksFalseInExternalCompatClaude(content) {
        const headerRegex = /^\s*\[([^[\]]+)\]\s*$/;
        const lines = content.split('\n');
        const out = [];
        let inCompat = false;
        let sawHooks = false;
        let changed = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(headerRegex);
            if (match) {
                if (inCompat && !sawHooks) {
                    // End of table without hooks key — inject before the next header.
                    out.push('hooks = false');
                    changed = true;
                }
                const tablePath = match[1].trim().replace(/\s*\.\s*/g, '.');
                inCompat = tablePath === 'compat.claude';
                sawHooks = false;
                out.push(line);
                continue;
            }
            if (inCompat && /^\s*hooks\s*=/.test(line)) {
                sawHooks = true;
                if (!/hooks\s*=\s*false\b/.test(line)) {
                    out.push('hooks = false');
                    changed = true;
                    continue;
                }
            }
            out.push(line);
        }
        if (inCompat && !sawHooks) {
            out.push('hooks = false');
            changed = true;
        }
        return changed ? out.join('\n') : content;
    }

    /**
     * Ensure Claude-hook import is off. Prefer our fenced block when no foreign
     * [compat.claude] exists. If the user already has that table, PATCH hooks
     * inside it — never emit a second header (TOML redefinition = parse fail).
     * @param {string} content
     * @returns {string}
     */
    ensureClaudeHooksCompatDisabled(content) {
        const block = this.buildClaudeHooksCompatToml();
        if (!content) return block;

        const start = content.indexOf(COMPAT_CLAUDE_START);
        const end = content.indexOf(COMPAT_CLAUDE_END);
        if (start !== -1 && end !== -1 && end > start) {
            // Replace only our fenced region (do NOT globally collapse newlines).
            const afterEnd = end + COMPAT_CLAUDE_END.length;
            const before = content.slice(0, start);
            let after = content.slice(afterEnd);
            if (after.startsWith('\n')) after = after.slice(1);
            return before + block + (after.startsWith('\n') || !after ? after : '\n' + after);
        }

        // User/org already owns [compat.claude] — patch in place, no second header.
        if (this.hasExternalCompatClaudeTable(content)) {
            return this._patchHooksFalseInExternalCompatClaude(content);
        }

        let out = content;
        if (!out.endsWith('\n')) out += '\n';
        return out + '\n' + block;
    }

    /**
     * Remove ONLY our fenced COMPAT.CLAUDE block (never a user-owned table we
     * only patched). Used when uninstalling CAS Grok integration.
     * @param {string} content
     * @returns {string}
     */
    stripClaudeHooksCompatFence(content) {
        if (!content) return content || '';
        const start = content.indexOf(COMPAT_CLAUDE_START);
        const end = content.indexOf(COMPAT_CLAUDE_END);
        if (start === -1 || end === -1 || end <= start) return content;
        const afterEnd = end + COMPAT_CLAUDE_END.length;
        const before = content.slice(0, start);
        let after = content.slice(afterEnd);
        if (after.startsWith('\n')) after = after.slice(1);
        // Only collapse the seam where the fence was — not the whole file.
        let joined = before + after;
        if (before.endsWith('\n\n') && after.startsWith('\n')) {
            joined = before + after.replace(/^\n+/, '\n');
        }
        return joined;
    }

    /**
     * Disk helper: ensure Claude hooks compat is off. Safe to call from the
     * hooks reconciler even when the task-system MCP toggle is OFF.
     * @returns {{success:boolean, changed?:boolean, message?:string}}
     */
    ensureClaudeHooksCompatOnDisk() {
        try {
            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true });
            }
            let content = '';
            if (fs.existsSync(this.configTomlPath)) {
                content = fs.readFileSync(this.configTomlPath, 'utf8');
            }
            const next = this.ensureClaudeHooksCompatDisabled(content);
            if (next !== content) {
                fs.writeFileSync(this.configTomlPath, next, 'utf8');
                console.log('[grok] Claude hook compat disabled in config.toml');
                return { success: true, changed: true };
            }
            return { success: true, changed: false };
        } catch (error) {
            console.error('[grok] Error ensuring Claude hooks compat:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Add the MCP server to config.toml, appending our fenced block and preserving
     * every user-authored section byte-for-byte. Also upgrades a stale block that
     * uses the obsolete env_vars field, and pins Claude-hook-compat off so Grok
     * sessions do not inherit Claude's title-gate/Stop hooks.
     */
    async addMcpServer() {
        try {
            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true });
            }

            let content = '';
            if (fs.existsSync(this.configTomlPath)) {
                content = fs.readFileSync(this.configTomlPath, 'utf8');
            }

            if (this.isMcpBlockCurrent(content)) {
                // MCP is fine; still make sure Claude-hook-compat is pinned off
                // (a user may have wiped the fence, or this is a first upgrade).
                const withCompat = this.ensureClaudeHooksCompatDisabled(content);
                if (withCompat !== content) {
                    fs.writeFileSync(this.configTomlPath, withCompat, 'utf8');
                    console.log('[grok] Claude hook compat disabled in config.toml');
                }
                return { success: true, message: 'MCP server already configured' };
            }

            const hasOwnedPath = hasOwnedMcpRuntime(content);
            if (content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`) && !content.includes(MCP_BLOCK_START) && !hasOwnedPath) {
                return { success: false, message: `MCP key '${MCP_SERVER_KEY}' belongs to the user; refusing to overwrite it` };
            }

            // Stale or missing: strip any previous owned MCP tables, then append
            // the current block. Preserves every unrelated section.
            if (content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`) || content.includes(MCP_BLOCK_START)) {
                content = this.stripMcpServerTables(content, MCP_SERVER_KEY);
            }

            if (content && !content.endsWith('\n')) {
                content += '\n';
            }
            content += (content ? '\n' : '') + this.buildMcpServerToml();
            content = this.ensureClaudeHooksCompatDisabled(content);

            fs.writeFileSync(this.configTomlPath, content, 'utf8');
            console.log('[grok] MCP server added/upgraded in config.toml');
            return { success: true, message: 'MCP server added successfully' };
        } catch (error) {
            console.error('[grok] Error adding MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove the MCP server from config.toml: drop our fenced MCP block AND any
     * `[mcp_servers.codeagentswarm-tasks...]` table (including nested sub-tables),
     * PLUS our COMPAT.CLAUDE fence so "Off" restores vanilla Grok behaviour
     * (Claude hook import is no longer forced off by CAS).
     */
    async removeMcpServer() {
        try {
            if (!fs.existsSync(this.configTomlPath)) {
                return { success: true, message: 'config.toml does not exist' };
            }

            const content = fs.readFileSync(this.configTomlPath, 'utf8');
            const hasOwnedPath = hasOwnedMcpRuntime(content);
            if (content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`) && !content.includes(MCP_BLOCK_START) && !hasOwnedPath) {
                return { success: true, message: 'MCP key belongs to the user; left untouched' };
            }
            let stripped = this.stripMcpServerTables(content, MCP_SERVER_KEY);
            stripped = this.stripClaudeHooksCompatFence(stripped);

            // Nothing of ours was present — leave the file byte-for-byte.
            if (stripped === content) {
                return { success: true, message: 'MCP server not found (already removed)' };
            }

            fs.writeFileSync(this.configTomlPath, stripped, 'utf8');
            console.log('[grok] MCP server + CAS Claude-compat fence removed from config.toml');
            return { success: true, message: 'MCP server removed successfully' };
        } catch (error) {
            console.error('[grok] Error removing MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Strip our fenced MCP block plus any `[mcp_servers.<key>]` table AND every
     * dotted descendant table from a config.toml string, preserving every unrelated
     * section byte-for-byte.
     *
     * Line-based on purpose: a value line such as `args = ["/x"]` contains a `[`
     * that a character-level regex mistakes for a section boundary. In TOML a bare
     * `[...]` line is always a table header — values are written as `key = [...]` —
     * so scanning header lines is the robust way to find section boundaries.
     *
     * @param {string} content - full config.toml text
     * @param {string} key - server key, e.g. 'codeagentswarm-tasks'
     * @returns {string} content with the block/table subtree removed (unchanged if absent)
     */
    stripMcpServerTables(content, key) {
        const base = `mcp_servers.${key}`;
        // A whole-line table header: `[dotted.key]` with no brackets inside.
        const headerRegex = /^\s*\[([^[\]]+)\]\s*$/;
        const lines = content.split('\n');
        const kept = [];
        let dropping = false;
        let inFence = false;
        let changed = false;

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed === MCP_BLOCK_START) {
                inFence = true;
                changed = true;
                continue;
            }
            if (inFence) {
                changed = true;
                if (trimmed === MCP_BLOCK_END) {
                    inFence = false;
                    dropping = false;
                }
                continue;
            }

            const match = line.match(headerRegex);
            if (match) {
                // Normalize whitespace around dotted separators (TOML allows
                // `[ a . b ]`) before deciding ownership.
                const tablePath = match[1].trim().replace(/\s*\.\s*/g, '.');
                dropping = tablePath === base || tablePath.startsWith(`${base}.`);
            }
            if (dropping) {
                changed = true;
                continue;
            }
            kept.push(line);
        }

        if (!changed) {
            return content;
        }

        // Collapse only runs of 3+ blank lines created by the drop — do not
        // rewrite the user's intentional double-spacing elsewhere as a global
        // rewrite of the whole file (Opus review).
        return kept.join('\n').replace(/\n{4,}/g, '\n\n\n');
    }
}

module.exports = GrokConfigStrategy;
