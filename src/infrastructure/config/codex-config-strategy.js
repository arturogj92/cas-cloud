/**
 * CodexConfigStrategy - Configuration management for OpenAI Codex CLI
 *
 * Extends AgentConfigStrategy to provide Codex-specific configuration:
 * - Manages project-level AGENTS.md instruction file (Codex's default)
 * - Manages ~/.codex/config.toml MCP server configuration (TOML format)
 *
 * Key differences from Claude/Gemini:
 * - Uses AGENTS.md instead of CODEX.md (Codex convention)
 * - Uses config.toml (TOML) instead of settings.json (JSON)
 * - MCP servers use [mcp_servers.<name>] table format
 */

const fs = require('fs');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');
const { hasOwnedMcpRuntime } = require('./mcp-entry-ownership');

// Markers for the CodeAgentSwarm section in AGENTS.md
const AGENTS_MD_START_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const AGENTS_MD_END_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// MCP Server key in config.toml
const MCP_SERVER_KEY = 'codeagentswarm-tasks';

class CodexConfigStrategy extends AgentConfigStrategy {
    constructor() {
        super();
        this.configTomlPath = path.join(this.homeDir, '.codex', 'config.toml');

        // MCP server configuration for Codex (TOML format is handled differently)
        this.mcpServerConfig = {
            command: 'node',
            args: [
                path.join(this.homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks', 'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js')
            ]
        };
    }

    // ==================== IMPLEMENT ABSTRACT METHODS ====================

    getAgentId() {
        return 'codex';
    }

    getDisplayName() {
        return 'Codex CLI';
    }

    getIconPath() {
        return '../../../assets/icons/codex-icon.svg';
    }

    getSettingsPath() {
        return path.join(this.homeDir, '.codex');
    }

    getInstructionsFileName() {
        // Codex uses AGENTS.md by convention, not CODEX.md
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
            file = 'codex-md-titles-section.md';
        } else if (variant === 'tasks-only') {
            file = 'codex-md-tasks-only-section.md';
        } else {
            file = 'codex-md-tasks-section.md';
        }
        return path.join(__dirname, 'templates', file);
    }

    getMcpConfigPath() {
        return this.configTomlPath;
    }

    /**
     * Check if MCP server is configured in config.toml
     * Codex uses TOML format: [mcp_servers.codeagentswarm-tasks]
     */
    hasMcpServer() {
        try {
            if (!fs.existsSync(this.configTomlPath)) {
                return false;
            }
            const content = fs.readFileSync(this.configTomlPath, 'utf8');
            // Check for the MCP server table
            return content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`);
        } catch (error) {
            console.error('[codex] Error checking MCP server:', error);
            return false;
        }
    }

    /**
     * Add MCP server to Codex config.toml
     * Format:
     * [mcp_servers.codeagentswarm-tasks]
     * command = "node"
     * args = ["/path/to/server.js"]
     */
    async addMcpServer() {
        try {
            // Ensure directory exists
            const dirPath = path.dirname(this.configTomlPath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            let content = '';
            if (fs.existsSync(this.configTomlPath)) {
                content = fs.readFileSync(this.configTomlPath, 'utf8');
            }

            // Check if already exists
            if (content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`)) {
                if (!this._mcpBaseTableOwned(content)) {
                    return { success: false, message: `MCP key '${MCP_SERVER_KEY}' belongs to the user; refusing to overwrite it` };
                }
                const expectedPath = this.mcpServerConfig.args[0].replace(/\\/g, '/');
                if (this._mcpBaseTable(content).includes(`args = ["${expectedPath}"]`)) {
                    return { success: true, message: 'MCP server already configured' };
                }
                content = this.stripMcpServerTables(content, MCP_SERVER_KEY);
            }

            // Build the TOML section for MCP server
            const mcpSection = this.buildMcpServerToml();

            // Append to config (add newlines for separation)
            if (content && !content.endsWith('\n')) {
                content += '\n';
            }
            content += '\n' + mcpSection;

            // Write back
            fs.writeFileSync(this.configTomlPath, content, 'utf8');
            console.log('[codex] MCP server added to config.toml');
            return { success: true, message: 'MCP server added successfully' };
        } catch (error) {
            console.error('[codex] Error adding MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Build TOML section for MCP server
     */
    buildMcpServerToml() {
        const serverPath = this.mcpServerConfig.args[0].replace(/\\/g, '/');
        return `[mcp_servers.${MCP_SERVER_KEY}]
command = "${this.mcpServerConfig.command}"
args = ["${serverPath}"]
env_vars = ["CODEAGENTSWARM_ACTIVE_SESSION", "CODEAGENTSWARM_CURRENT_QUADRANT", "CODEAGENTSWARM_TERMINAL_ID", "CODEAGENTSWARM_DB_PATH", "CODEAGENTSWARM_AGENT_TYPE", "CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED", "CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED", "CODEAGENTSWARM_SESSION_BRIDGE_PORT", "CODEAGENTSWARM_SESSION_BRIDGE_TOKEN"]
`;
    }

    /**
     * Remove the MCP server from Codex config.toml.
     *
     * Removes BOTH the main `[mcp_servers.codeagentswarm-tasks]` table AND every
     * nested sub-table that Codex itself may have persisted under it — most
     * importantly the per-tool approval settings Codex writes as
     * `[mcp_servers.codeagentswarm-tasks.tools.<tool>]` when the user approves a
     * task tool inside the Codex TUI.
     *
     * Leaving those sub-tables behind used to break Codex completely: a dangling
     * `[mcp_servers.codeagentswarm-tasks.tools.check_active]` implicitly recreates
     * the parent `mcp_servers.codeagentswarm-tasks` table with NO command and NO
     * url, so Codex aborts config load with
     * `invalid transport in mcp_servers.codeagentswarm-tasks` (verified against
     * codex-cli). Turning an agent "Off" must leave the file as a clean install,
     * so we strip the whole table subtree, not just the exact header.
     */
    async removeMcpServer() {
        try {
            if (!fs.existsSync(this.configTomlPath)) {
                return { success: true, message: 'config.toml does not exist' };
            }

            const content = fs.readFileSync(this.configTomlPath, 'utf8');
            if (this._mcpBaseTableOwned(content) === false) {
                return { success: true, message: 'MCP key belongs to the user; left untouched' };
            }
            const stripped = this.stripMcpServerTables(content, MCP_SERVER_KEY);

            // Nothing belonging to our server (base table or nested sub-tables)
            // was present — the file is already clean, leave it byte-for-byte.
            if (stripped === content) {
                return { success: true, message: 'MCP server not found (already removed)' };
            }

            fs.writeFileSync(this.configTomlPath, stripped, 'utf8');
            console.log('[codex] MCP server (and any nested tables) removed from config.toml');
            return { success: true, message: 'MCP server removed successfully' };
        } catch (error) {
            console.error('[codex] Error removing MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Strip a `[mcp_servers.<key>]` TOML table AND every dotted descendant table
     * (`[mcp_servers.<key>.anything...]`) from a config.toml string, preserving
     * every unrelated section byte-for-byte.
     *
     * Line-based on purpose: a value line such as `args = ["/x"]` contains a `[`
     * that a character-level regex mistakes for a section boundary (the exact bug
     * the previous implementation was patched for). In TOML a bare `[...]` line is
     * always a table header — values are written as `key = [...]` — so scanning
     * header lines is the robust way to find section boundaries.
     *
     * @param {string} content - full config.toml text
     * @param {string} key - server key, e.g. 'codeagentswarm-tasks'
     * @returns {string} content with the table subtree removed (unchanged if absent)
     */
    stripMcpServerTables(content, key) {
        const base = `mcp_servers.${key}`;
        // A whole-line table header: `[dotted.key]` with no brackets inside.
        const headerRegex = /^\s*\[([^[\]]+)\]\s*$/;
        const lines = content.split('\n');
        const kept = [];
        let dropping = false;
        let changed = false;

        for (const line of lines) {
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

        // Collapse the blank-line gaps left where tables were removed.
        return kept.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    _mcpBaseTableOwned(content) {
        const table = this._mcpBaseTable(content);
        return table === null ? null : hasOwnedMcpRuntime(table);
    }

    _mcpBaseTable(content) {
        const header = `[mcp_servers.${MCP_SERVER_KEY}]`;
        const start = content.indexOf(header);
        if (start === -1) return null;
        const remainder = content.slice(start + header.length);
        const nextHeader = remainder.search(/^\s*\[/m);
        return nextHeader === -1 ? remainder : remainder.slice(0, nextHeader);
    }

    /**
     * Override to handle AGENTS.md instead of global CODEX.md
     * Codex reads AGENTS.md from project root, not global config
     */
    getInstructionFilePath() {
        // For global config, use ~/.codex/AGENTS.md
        // But Codex primarily reads from project root
        return path.join(this.getSettingsPath(), this.getInstructionsFileName());
    }
}

module.exports = CodexConfigStrategy;
