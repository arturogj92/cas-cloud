/**
 * OpencodeConfigStrategy - Configuration management for the SST opencode CLI
 *
 * Extends AgentConfigStrategy to provide opencode-specific configuration:
 * - Manages the global AGENTS.md instruction file (opencode's convention)
 * - Manages ~/.config/opencode/opencode.json MCP server configuration (JSON)
 *
 * Key differences from Claude/Gemini:
 * - Uses AGENTS.md instead of OPENCODE.md (the cross-tool standard opencode follows)
 * - Config lives under ~/.config/opencode (XDG-style), not a home-level dotdir
 * - MCP servers use the opencode `mcp.<name>` object with `type: "local"` and a
 *   `command` array; env vars are injected with opencode's documented `{env:VAR}`
 *   config substitution so the CAS terminal-detection vars reach the MCP process.
 */

const fs = require('fs');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');

// Markers for the CodeAgentSwarm section in AGENTS.md (identical to Codex).
const AGENTS_MD_START_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const AGENTS_MD_END_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// MCP Server key in opencode.json
const MCP_SERVER_KEY = 'codeagentswarm-tasks';

class OpencodeConfigStrategy extends AgentConfigStrategy {
    constructor() {
        super();
        // opencode config dir is XDG-style (~/.config/opencode), honoring XDG_CONFIG_HOME.
        const configBase = process.env.XDG_CONFIG_HOME || path.join(this.homeDir, '.config');
        this.configDir = path.join(configBase, 'opencode');
        this.configJsonPath = path.join(this.configDir, 'opencode.json');

        // Path to the codeagentswarm-tasks MCP stdio server (same one Claude/Codex register).
        this.mcpServerScript = path.join(
            this.homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks',
            'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js'
        );
    }

    // ==================== IMPLEMENT ABSTRACT METHODS ====================

    getAgentId() {
        return 'opencode';
    }

    getDisplayName() {
        // SST brands the product lowercase.
        return 'opencode';
    }

    getIconPath() {
        return '../../../assets/icons/opencode-icon.svg';
    }

    getSettingsPath() {
        return this.configDir;
    }

    getInstructionsFileName() {
        // opencode follows the AGENTS.md convention (same as Codex), not OPENCODE.md.
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
            file = 'opencode-md-titles-section.md';
        } else if (variant === 'tasks-only') {
            file = 'opencode-md-tasks-only-section.md';
        } else {
            file = 'opencode-md-tasks-section.md';
        }
        return path.join(__dirname, 'templates', file);
    }

    getMcpConfigPath() {
        return this.configJsonPath;
    }

    /**
     * Build the opencode MCP server entry.
     * `{env:VAR}` is opencode's documented config substitution — it guarantees the
     * CAS terminal-detection env vars reach the MCP server process (the opencode
     * analog of Codex's env_vars list).
     */
    buildMcpServerEntry() {
        const serverPath = this.mcpServerScript.replace(/\\/g, '/');
        return {
            type: 'local',
            command: ['node', serverPath],
            enabled: true,
            environment: {
                CODEAGENTSWARM_CURRENT_QUADRANT: '{env:CODEAGENTSWARM_CURRENT_QUADRANT}',
                CODEAGENTSWARM_TERMINAL_ID: '{env:CODEAGENTSWARM_TERMINAL_ID}',
                CODEAGENTSWARM_ACTIVE_SESSION: '{env:CODEAGENTSWARM_ACTIVE_SESSION}',
                CODEAGENTSWARM_DB_PATH: '{env:CODEAGENTSWARM_DB_PATH}',
                CODEAGENTSWARM_AGENT_TYPE: '{env:CODEAGENTSWARM_AGENT_TYPE}',
                CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED: '{env:CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED}',
                CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED: '{env:CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED}',
                CODEAGENTSWARM_SESSION_BRIDGE_PORT: '{env:CODEAGENTSWARM_SESSION_BRIDGE_PORT}',
                CODEAGENTSWARM_SESSION_BRIDGE_TOKEN: '{env:CODEAGENTSWARM_SESSION_BRIDGE_TOKEN}'
            }
        };
    }

    /**
     * Read and parse opencode.json. Returns null when the file is missing or is
     * not valid JSON (opencode also accepts JSONC with comments, which we must
     * never clobber).
     * @returns {Object|null}
     * @private
     */
    _readConfig() {
        try {
            if (!fs.existsSync(this.configJsonPath)) {
                return {};
            }
            const raw = fs.readFileSync(this.configJsonPath, 'utf8').trim();
            if (!raw) {
                return {};
            }
            return JSON.parse(raw);
        } catch (error) {
            // Not valid JSON (e.g. JSONC with comments) — signal "cannot parse".
            return null;
        }
    }

    /**
     * Check if MCP server is configured in opencode.json.
     */
    hasMcpServer() {
        try {
            const cfg = this._readConfig();
            return !!(cfg && cfg.mcp && cfg.mcp[MCP_SERVER_KEY]);
        } catch (error) {
            console.error('[opencode] Error checking MCP server:', error);
            return false;
        }
    }

    /**
     * Add MCP server to opencode.json (preserving every other key). Refuses to
     * touch the file when it exists but is not valid JSON, so user JSONC config
     * is never clobbered.
     */
    async addMcpServer() {
        try {
            // Refuse to modify an existing-but-unparseable config file.
            if (fs.existsSync(this.configJsonPath)) {
                const cfg = this._readConfig();
                if (cfg === null) {
                    return { success: false, message: 'opencode.json is not valid JSON; refusing to modify' };
                }

                if (cfg.mcp && cfg.mcp[MCP_SERVER_KEY]) {
                    if (!this.isCodeAgentSwarmMcpEntry(cfg.mcp[MCP_SERVER_KEY])) {
                        return { success: false, message: `MCP key '${MCP_SERVER_KEY}' belongs to the user; refusing to overwrite it` };
                    }
                    const current = this.buildMcpServerEntry();
                    if (JSON.stringify(cfg.mcp[MCP_SERVER_KEY]) === JSON.stringify(current)) {
                        return { success: true, message: 'MCP server already configured' };
                    }
                    cfg.mcp[MCP_SERVER_KEY] = current;
                    fs.writeFileSync(this.configJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
                    return { success: true, message: 'MCP server updated successfully' };
                }

                if (!cfg.mcp || typeof cfg.mcp !== 'object') {
                    cfg.mcp = {};
                }
                cfg.mcp[MCP_SERVER_KEY] = this.buildMcpServerEntry();
                fs.writeFileSync(this.configJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
                console.log('[opencode] MCP server added to opencode.json');
                return { success: true, message: 'MCP server added successfully' };
            }

            // Create a fresh config file with the schema hint.
            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true });
            }
            const cfg = {
                $schema: 'https://opencode.ai/config.json',
                mcp: {
                    [MCP_SERVER_KEY]: this.buildMcpServerEntry()
                }
            };
            fs.writeFileSync(this.configJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
            console.log('[opencode] MCP server added to new opencode.json');
            return { success: true, message: 'MCP server added successfully' };
        } catch (error) {
            console.error('[opencode] Error adding MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove MCP server from opencode.json (preserving every other key).
     */
    async removeMcpServer() {
        try {
            if (!fs.existsSync(this.configJsonPath)) {
                return { success: true, message: 'opencode.json does not exist' };
            }

            const cfg = this._readConfig();
            if (cfg === null) {
                return { success: false, message: 'opencode.json is not valid JSON; nothing was removed' };
            }

            if (!cfg.mcp || !cfg.mcp[MCP_SERVER_KEY]) {
                return { success: true, message: 'MCP server not found (already removed)' };
            }
            if (!this.isCodeAgentSwarmMcpEntry(cfg.mcp[MCP_SERVER_KEY])) {
                return { success: true, message: 'MCP key belongs to the user; left untouched' };
            }

            delete cfg.mcp[MCP_SERVER_KEY];
            fs.writeFileSync(this.configJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
            console.log('[opencode] MCP server removed from opencode.json');
            return { success: true, message: 'MCP server removed successfully' };
        } catch (error) {
            console.error('[opencode] Error removing MCP server:', error);
            return { success: false, message: error.message };
        }
    }
}

module.exports = OpencodeConfigStrategy;
