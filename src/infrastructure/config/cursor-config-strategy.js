/** Cursor configuration, preserving every user and project MCP server. */
const fs = require('fs');
const path = require('path');
const AgentConfigStrategy = require('./agent-config-strategy');

const START = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const END = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';
const MCP_KEY = 'codeagentswarm-tasks';

class CursorConfigStrategy extends AgentConfigStrategy {
    constructor() {
        super();
        this.configDir = path.join(this.homeDir, '.cursor');
        this.mcpPath = path.join(this.configDir, 'mcp.json');
        this.mcpServerPath = path.join(this.homeDir, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks', 'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js');
    }

    getAgentId() { return 'cursor'; }
    getDisplayName() { return 'Cursor Agent'; }
    getIconPath() { return '../../../assets/icons/cursor-icon.svg'; }
    getSettingsPath() { return this.configDir; }
    getInstructionsFileName() { return path.join('rules', 'codeagentswarm.mdc'); }
    getSectionStartMarker() { return START; }
    getSectionEndMarker() { return END; }
    getTemplatePath(variant = 'full') {
        const suffix = variant === 'titles-only' ? 'titles-section' : variant === 'tasks-only' ? 'tasks-only-section' : 'tasks-section';
        return path.join(__dirname, 'templates', `grok-md-${suffix}.md`);
    }
    getMcpConfigPath() { return this.mcpPath; }

    _readConfig() {
        if (!fs.existsSync(this.mcpPath)) return {};
        const raw = fs.readFileSync(this.mcpPath, 'utf8').trim();
        if (!raw) return {};
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    hasMcpServer() {
        const config = this._readConfig();
        return Boolean(config?.mcpServers?.[MCP_KEY]);
    }

    async addMcpServer() {
        try {
            const config = this._readConfig();
            if (config === null) return { success: false, message: 'Cursor mcp.json is not valid JSON; refusing to modify it' };
            if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
            if (config.mcpServers[MCP_KEY]) {
                const existing = config.mcpServers[MCP_KEY];
                if (!this.isCodeAgentSwarmMcpEntry(existing)) {
                    return { success: false, message: `MCP key '${MCP_KEY}' belongs to the user; refusing to overwrite it` };
                }
                const current = { command: 'node', args: [this.mcpServerPath] };
                if (existing.command === current.command && JSON.stringify(existing.args) === JSON.stringify(current.args)) {
                    return { success: true, message: 'MCP server already configured' };
                }
                config.mcpServers[MCP_KEY] = { ...existing, ...current };
                fs.mkdirSync(this.configDir, { recursive: true });
                fs.writeFileSync(this.mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
                return { success: true, message: 'MCP server updated successfully' };
            }
            config.mcpServers[MCP_KEY] = { command: 'node', args: [this.mcpServerPath] };
            fs.mkdirSync(this.configDir, { recursive: true });
            fs.writeFileSync(this.mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            return { success: true, message: 'MCP server added successfully' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async removeMcpServer() {
        try {
            const config = this._readConfig();
            if (config === null) return { success: false, message: 'Cursor mcp.json is not valid JSON; nothing was removed' };
            if (!config?.mcpServers?.[MCP_KEY]) return { success: true, message: 'MCP server not found' };
            if (!this.isCodeAgentSwarmMcpEntry(config.mcpServers[MCP_KEY])) {
                return { success: true, message: 'MCP key belongs to the user; left untouched' };
            }
            delete config.mcpServers[MCP_KEY];
            fs.writeFileSync(this.mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            return { success: true, message: 'MCP server removed successfully' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}

module.exports = CursorConfigStrategy;
