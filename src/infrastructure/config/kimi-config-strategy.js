/**
 * KimiConfigStrategy - Configuration management for Moonshot's Kimi Code CLI
 *
 * Extends AgentConfigStrategy to provide Kimi-specific configuration:
 * - Manages the global AGENTS.md instruction file at ~/.kimi-code/AGENTS.md
 *   (Kimi's documented global-instructions location; KIMI.md does not exist)
 * - Manages ~/.kimi-code/mcp.json MCP server configuration
 *
 * Key facts (verified against kimi-code v0.26.0 + its source):
 * - Data root is ~/.kimi-code, relocatable via KIMI_CODE_HOME (config, sessions,
 *   skills, credentials AND the global AGENTS.md all move with it).
 * - MCP servers are declared in mcp.json (NOT config.toml) using the standard
 *   `mcpServers` schema. Transport is INFERRED: an entry with a string `command`
 *   is stdio, one with `url` is http. Kimi also reads the Claude-compatible
 *   `<git root>/.mcp.json` and a project-local `.kimi-code/mcp.json`; we write the
 *   USER-level file so every terminal gets the tasks server regardless of repo.
 * - MCP tool names follow the `mcp__<server>__<tool>` convention (same as Claude),
 *   so `mcp__codeagentswarm-tasks__*` works unchanged.
 * - There is NO --mcp-config flag (explicitly removed) — file-based delivery is
 *   the only channel, which is exactly what this strategy does.
 */

const fs = require('fs');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');

// Markers for the CodeAgentSwarm section in AGENTS.md (identical to Codex/opencode).
const AGENTS_MD_START_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const AGENTS_MD_END_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// MCP server key in mcp.json
const MCP_SERVER_KEY = 'codeagentswarm-tasks';

class KimiConfigStrategy extends AgentConfigStrategy {
    constructor() {
        super();
        // Kimi keeps everything under one relocatable data root.
        const override = (process.env.KIMI_CODE_HOME || '').trim();
        this.configDir = override || path.join(this.homeDir, '.kimi-code');
        this.mcpJsonPath = path.join(this.configDir, 'mcp.json');

        // Path to the codeagentswarm-tasks MCP stdio server (same one Claude/Codex register).
        this.mcpServerScript = path.join(
            this.homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks',
            'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js'
        );
    }

    // ==================== IMPLEMENT ABSTRACT METHODS ====================

    getAgentId() {
        return 'kimi';
    }

    getDisplayName() {
        return 'Kimi Code';
    }

    getIconPath() {
        return '../../../assets/icons/kimi-icon.png';
    }

    getSettingsPath() {
        return this.configDir;
    }

    getInstructionsFileName() {
        // Kimi follows the AGENTS.md convention; the global copy lives in its data root.
        return 'AGENTS.md';
    }

    getSectionStartMarker() {
        return AGENTS_MD_START_MARKER;
    }

    getSectionEndMarker() {
        return AGENTS_MD_END_MARKER;
    }

    getTemplatePath(variant = 'full') {
        let file;
        if (variant === 'titles-only') {
            file = 'kimi-md-titles-section.md';
        } else if (variant === 'tasks-only') {
            file = 'kimi-md-tasks-only-section.md';
        } else {
            file = 'kimi-md-tasks-section.md';
        }
        return path.join(__dirname, 'templates', file);
    }

    getMcpConfigPath() {
        return this.mcpJsonPath;
    }

    /**
     * Build the Kimi mcp.json server entry (standard `mcpServers` schema; a string
     * `command` makes it stdio). No `env` block: Kimi spawns stdio servers with the
     * CLI's own environment, and the CAS terminal-detection vars are exported by the
     * spawning terminal, so the MCP process inherits them the same way Claude's does.
     */
    buildMcpServerEntry() {
        const serverPath = this.mcpServerScript.replace(/\\/g, '/');
        return {
            command: 'node',
            args: [serverPath]
        };
    }

    /**
     * Read and parse mcp.json. Returns {} when the file is missing/empty and null
     * when it exists but cannot be parsed (never clobber a user's hand-edited file).
     * @returns {Object|null}
     * @private
     */
    _readMcpConfig() {
        try {
            if (!fs.existsSync(this.mcpJsonPath)) {
                return {};
            }
            const raw = fs.readFileSync(this.mcpJsonPath, 'utf8').trim();
            if (!raw) {
                return {};
            }
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }

    /**
     * Check if the MCP server is configured in mcp.json.
     */
    hasMcpServer() {
        try {
            const cfg = this._readMcpConfig();
            return !!(cfg && cfg.mcpServers && cfg.mcpServers[MCP_SERVER_KEY]);
        } catch (error) {
            console.error('[kimi] Error checking MCP server:', error);
            return false;
        }
    }

    /**
     * Add the MCP server to mcp.json, preserving every user-defined server. Refuses
     * to touch the file when it exists but is not valid JSON.
     */
    async addMcpServer() {
        try {
            if (fs.existsSync(this.mcpJsonPath)) {
                const cfg = this._readMcpConfig();
                if (cfg === null) {
                    return { success: false, message: 'mcp.json is not valid JSON; refusing to modify' };
                }

                if (cfg.mcpServers && cfg.mcpServers[MCP_SERVER_KEY]) {
                    const existing = cfg.mcpServers[MCP_SERVER_KEY];
                    if (!this.isCodeAgentSwarmMcpEntry(existing)) {
                        return { success: false, message: `MCP key '${MCP_SERVER_KEY}' belongs to the user; refusing to overwrite it` };
                    }
                    const current = this.buildMcpServerEntry();
                    if (existing.command === current.command && JSON.stringify(existing.args) === JSON.stringify(current.args)) {
                        return { success: true, message: 'MCP server already configured' };
                    }
                    cfg.mcpServers[MCP_SERVER_KEY] = { ...existing, ...current };
                    fs.writeFileSync(this.mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
                    return { success: true, message: 'MCP server updated successfully' };
                }

                if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
                    cfg.mcpServers = {};
                }
                cfg.mcpServers[MCP_SERVER_KEY] = this.buildMcpServerEntry();
                fs.writeFileSync(this.mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
                console.log('[kimi] MCP server added to mcp.json');
                return { success: true, message: 'MCP server added successfully' };
            }

            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true });
            }
            const cfg = {
                mcpServers: {
                    [MCP_SERVER_KEY]: this.buildMcpServerEntry()
                }
            };
            fs.writeFileSync(this.mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
            console.log('[kimi] MCP server added to new mcp.json');
            return { success: true, message: 'MCP server added successfully' };
        } catch (error) {
            console.error('[kimi] Error adding MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove the MCP server from mcp.json (preserving every other server).
     */
    async removeMcpServer() {
        try {
            if (!fs.existsSync(this.mcpJsonPath)) {
                return { success: true, message: 'mcp.json does not exist' };
            }

            const cfg = this._readMcpConfig();
            if (cfg === null) {
                return { success: false, message: 'mcp.json is not valid JSON; nothing was removed' };
            }

            if (!cfg.mcpServers || !cfg.mcpServers[MCP_SERVER_KEY]) {
                return { success: true, message: 'MCP server not found (already removed)' };
            }
            if (!this.isCodeAgentSwarmMcpEntry(cfg.mcpServers[MCP_SERVER_KEY])) {
                return { success: true, message: 'MCP key belongs to the user; left untouched' };
            }

            delete cfg.mcpServers[MCP_SERVER_KEY];
            fs.writeFileSync(this.mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
            console.log('[kimi] MCP server removed from mcp.json');
            return { success: true, message: 'MCP server removed successfully' };
        } catch (error) {
            console.error('[kimi] Error removing MCP server:', error);
            return { success: false, message: error.message };
        }
    }
}

module.exports = KimiConfigStrategy;
