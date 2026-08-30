/**
 * ClaudeConfigStrategy - Configuration management for Claude Code
 *
 * Extends AgentConfigStrategy to provide Claude-specific configuration:
 * - Manages ~/.claude/CLAUDE.md instruction file
 * - Manages ~/.claude.json MCP server configuration
 */

const fs = require('fs');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');
const { getGlobalCodeAgentSwarmSection } = require('./claude-md-global-config');
const { safeReadConfigFile } = require('../../shared/utils/safe-config-reader');

// Markers for the CodeAgentSwarm section in CLAUDE.md
const CLAUDE_MD_START_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const CLAUDE_MD_END_MARKER = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// MCP Server key in .claude.json
const MCP_SERVER_KEY = 'codeagentswarm-tasks';

class ClaudeConfigStrategy extends AgentConfigStrategy {
    constructor() {
        super();
        this.claudeJsonPath = path.join(this.homeDir, '.claude.json');

        // MCP server configuration
        this.mcpServerConfig = {
            type: 'stdio',
            command: 'node',
            args: [
                path.join(this.homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks', 'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js')
            ],
            env: {}
        };
    }

    // ==================== IMPLEMENT ABSTRACT METHODS ====================

    getAgentId() {
        return 'claude';
    }

    getDisplayName() {
        return 'Claude Code';
    }

    getIconPath() {
        return '../../../assets/icons/claude-icon.svg';
    }

    getSettingsPath() {
        return path.join(this.homeDir, '.claude');
    }

    getInstructionsFileName() {
        return 'CLAUDE.md';
    }

    getSectionStartMarker() {
        return CLAUDE_MD_START_MARKER;
    }

    getSectionEndMarker() {
        return CLAUDE_MD_END_MARKER;
    }

    getTemplatePath() {
        return path.join(__dirname, 'templates', 'claude-md-tasks-section.md');
    }

    getMcpConfigPath() {
        return this.claudeJsonPath;
    }

    /**
     * Override loadTemplate to use the dynamic content generator
     * instead of the static template file (which only has a placeholder)
     * @param {string} [variant='full'] - 'full' | 'titles-only' | 'tasks-only'
     * @param {object} [options={}] - section-level options ({ includeStatus, allowTaskCreation })
     * @returns {Promise<string|null>}
     */
    async loadTemplate(variant = 'full', options = {}) {
        try {
            if (variant === 'communication-only') {
                return this._sessionCommunicationOnlyTemplate();
            }
            const includeStatus = options.includeStatus !== false;
            const contentVariant = options.allowTaskCreation === false && variant === 'full'
                ? 'titles-only'
                : variant;
            let genOptions;
            if (contentVariant === 'titles-only') {
                genOptions = { includeTaskManagement: false, includeTitles: true, includeStatus };
            } else if (contentVariant === 'tasks-only') {
                genOptions = { includeTaskManagement: true, includeTitles: false, includeStatus };
            } else {
                genOptions = { includeTaskManagement: true, includeTitles: true, includeStatus };
            }
            // Use the full content generator instead of static template. The
            // no-create override block is spliced by the shared base helper, so
            // Claude and the static-template agents carry identical wording.
            const section = getGlobalCodeAgentSwarmSection(genOptions);
            const withStatusPolicy = contentVariant === 'titles-only' && includeStatus
                ? this._addTerminalStatusPolicy(section)
                : section;
            const withPlanPolicy = this._addPlanAccuracyPolicy(withStatusPolicy);
            return this._applySessionCommunicationPolicy(this._applyTaskCreationGate(withPlanPolicy, variant, options), options.includeSessionCommunication === true);
        } catch (error) {
            console.error('[claude] Error loading template from generator:', error);
            return null;
        }
    }

    hasMcpServer() {
        try {
            const content = safeReadConfigFile(this.claudeJsonPath);
            if (content === null) {
                return false;
            }
            const config = JSON.parse(content);
            return !!(config.mcpServers && config.mcpServers[MCP_SERVER_KEY]);
        } catch (error) {
            console.error('[claude] Error checking MCP server:', error);
            return false;
        }
    }

    async addMcpServer() {
        try {
            let config = {};

            const content = safeReadConfigFile(this.claudeJsonPath);
            if (content !== null) {
                config = JSON.parse(content);
            }

            // Initialize mcpServers if it doesn't exist
            if (!config.mcpServers) {
                config.mcpServers = {};
            }

            // Check if already exists
            if (config.mcpServers[MCP_SERVER_KEY]) {
                const existing = config.mcpServers[MCP_SERVER_KEY];
                if (!this.isCodeAgentSwarmMcpEntry(existing)) {
                    return { success: false, message: `MCP key '${MCP_SERVER_KEY}' belongs to the user; refusing to overwrite it` };
                }
                if (existing.command === this.mcpServerConfig.command
                    && JSON.stringify(existing.args) === JSON.stringify(this.mcpServerConfig.args)) {
                    return { success: true, message: 'MCP server already configured' };
                }
                config.mcpServers[MCP_SERVER_KEY] = { ...existing, ...this.mcpServerConfig, env: existing.env || {} };
                fs.writeFileSync(this.claudeJsonPath, JSON.stringify(config, null, 2), 'utf8');
                return { success: true, message: 'MCP server updated successfully' };
            }

            // Add the MCP server
            config.mcpServers[MCP_SERVER_KEY] = this.mcpServerConfig;

            // Write back
            fs.writeFileSync(this.claudeJsonPath, JSON.stringify(config, null, 2), 'utf8');
            return { success: true, message: 'MCP server added successfully' };
        } catch (error) {
            console.error('[claude] Error adding MCP server:', error);
            return { success: false, message: error.message };
        }
    }

    async removeMcpServer() {
        try {
            const content = safeReadConfigFile(this.claudeJsonPath);
            if (content === null) {
                return { success: true, message: '.claude.json does not exist' };
            }

            const config = JSON.parse(content);

            // Check if MCP server exists
            if (!config.mcpServers || !config.mcpServers[MCP_SERVER_KEY]) {
                return { success: true, message: 'MCP server not found (already removed)' };
            }
            if (!this.isCodeAgentSwarmMcpEntry(config.mcpServers[MCP_SERVER_KEY])) {
                return { success: true, message: 'MCP key belongs to the user; left untouched' };
            }

            // Remove the MCP server
            delete config.mcpServers[MCP_SERVER_KEY];

            // Write back
            fs.writeFileSync(this.claudeJsonPath, JSON.stringify(config, null, 2), 'utf8');
            return { success: true, message: 'MCP server removed successfully' };
        } catch (error) {
            console.error('[claude] Error removing MCP server:', error);
            return { success: false, message: error.message };
        }
    }
}

module.exports = ClaudeConfigStrategy;
