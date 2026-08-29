/**
 * AntigravityConfigStrategy - Configuration management for Antigravity CLI (`agy`)
 *
 * Extends AgentConfigStrategy to provide Antigravity-specific configuration:
 * - Manages the GLOBAL instruction section in ~/.gemini/GEMINI.md
 * - Manages the codeagentswarm-tasks entry in agy's GLOBAL
 *   ~/.gemini/config/mcp_config.json (via the hooks-manager helpers), so the
 *   MCP-connection Privacy toggle genuinely adds/removes the task tools.
 *
 * Key location decision (verified against agy v1.0.13):
 * - `agy` reads ~/.gemini/GEMINI.md GLOBALLY (the legacy ~/.gemini/GEMINI.md
 *   already drives Antigravity's CodeAgentSwarm awareness). We therefore write the
 *   CodeAgentSwarm instruction section into ~/.gemini/GEMINI.md.
 * - We deliberately do NOT use a shared project-root AGENTS.md: Codex already owns
 *   ~/.codex/AGENTS.md and both use the same START/END markers, so co-locating in a
 *   shared AGENTS.md would cause marker collisions.
 *
 * Note: this never deletes the user's physical ~/.gemini files; it only manages the
 * CodeAgentSwarm-delimited section inside GEMINI.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');

// Markers for the CodeAgentSwarm section in GEMINI.md (same convention as the
// other strategies — shared markers are safe because each agent owns a different
// instruction file).
const ANTIGRAVITY_MD_START_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const ANTIGRAVITY_MD_END_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// MCP Server key (lives in the plugin's mcp_config.json, owned by the hooks manager)
const MCP_SERVER_KEY = 'codeagentswarm-tasks';

class AntigravityConfigStrategy extends AgentConfigStrategy {
    constructor({ isDevMode = false } = {}) {
        super();
        this.isDevMode = isDevMode;
        // MCP for Antigravity is delivered by the hooks-manager plugin, not by this
        // strategy. We only READ this path to report accurate status to the Privacy
        // panel; we never WRITE it here (the hooks manager owns it).
        this.pluginMcpConfigPath = path.join(
            this.homeDir, '.gemini', 'antigravity-cli', 'plugins', 'codeagentswarm', 'mcp_config.json'
        );
    }

    // ==================== IMPLEMENT ABSTRACT METHODS ====================

    getAgentId() {
        return 'antigravity';
    }

    getDisplayName() {
        return 'Antigravity CLI';
    }

    getIconPath() {
        return '../../../assets/icons/antigravity-icon.png';
    }

    getSettingsPath() {
        return path.join(this.homeDir, '.gemini');
    }

    getInstructionsFileName() {
        // agy reads ~/.gemini/GEMINI.md globally; we drive its CAS awareness there.
        return 'GEMINI.md';
    }

    getSectionStartMarker() {
        return ANTIGRAVITY_MD_START_MARKER;
    }

    getSectionEndMarker() {
        return ANTIGRAVITY_MD_END_MARKER;
    }

    getTemplatePath(variant = 'full') {
        let file;
        if (variant === 'titles-only') {
            file = 'antigravity-md-titles-section.md';
        } else if (variant === 'tasks-only') {
            file = 'antigravity-md-tasks-only-section.md';
        } else {
            file = 'antigravity-md-tasks-section.md';
        }
        return path.join(__dirname, 'templates', file);
    }

    getMcpConfigPath() {
        // Surface the plugin's mcp_config.json so the Privacy panel points at the
        // file that actually carries the MCP server for Antigravity.
        return this.pluginMcpConfigPath;
    }

    /**
     * Check if the MCP server is configured for Antigravity.
     * READ-ONLY: the entry lives in the hooks-manager plugin's mcp_config.json.
     * @returns {boolean}
     */
    hasMcpServer() {
        try {
            // The GLOBAL ~/.gemini/config/mcp_config.json is what agy actually
            // loads servers from (the plugin-local copy is inert), so it is the
            // truth the Privacy panel must report.
            const globalPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
            if (!fs.existsSync(globalPath)) {
                return false;
            }
            const config = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
            return !!(config.mcpServers && config.mcpServers[MCP_SERVER_KEY]);
        } catch (error) {
            console.error('[antigravity] Error checking MCP server:', error);
            return false;
        }
    }

    /**
     * Write the codeagentswarm-tasks entry into agy's GLOBAL mcp_config.json —
     * the file agy actually loads servers from. Reuses the hooks-manager
     * helpers so there is exactly one implementation of that file's format.
     * (These used to be no-ops while the hooks plugin re-wrote the global entry
     * unconditionally; that made the MCP-connection toggle a lie for
     * antigravity — disabling it removed nothing.)
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async addMcpServer() {
        const AntigravityHooksManager = require('../hooks/antigravity-hooks-manager');
        const result = new AntigravityHooksManager({ isDevMode: this.isDevMode }).ensureGlobalMcpServer();
        return result.success
            ? { success: true, message: 'MCP server registered in global mcp_config.json' }
            : { success: false, message: result.error || 'Failed to write global mcp_config.json' };
    }

    /**
     * Remove the codeagentswarm-tasks entry from agy's GLOBAL mcp_config.json,
     * preserving any user-defined servers. See addMcpServer.
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async removeMcpServer() {
        const AntigravityHooksManager = require('../hooks/antigravity-hooks-manager');
        const result = new AntigravityHooksManager({ isDevMode: this.isDevMode }).removeGlobalMcpServer();
        return result.success
            ? { success: true, message: 'MCP server removed from global mcp_config.json' }
            : { success: false, message: result.error || 'Failed to update global mcp_config.json' };
    }
}

module.exports = AntigravityConfigStrategy;
