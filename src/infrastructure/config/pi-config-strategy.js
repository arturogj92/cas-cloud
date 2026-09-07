const fs = require('fs');
const path = require('path');
const CursorConfigStrategy = require('./cursor-config-strategy');
const { getAgentDir } = require('../services/pi-conversation-reader');

// Pi's optional MCP bridge uses the same mcpServers document and ownership rules.
class PiConfigStrategy extends CursorConfigStrategy {
  constructor() {
    super();
    this.configDir = getAgentDir();
    this.mcpPath = path.join(this.configDir, 'mcp.json');
  }
  getAgentId() { return 'pi'; }
  getDisplayName() { return 'Pi (beta)'; }
  getIconPath() { return '../../../assets/icons/pi-icon.svg'; }
  getInstructionsFileName() { return 'AGENTS.md'; }
  getTemplatePath(variant = 'full') {
    const suffix = variant === 'titles-only' ? 'titles-section' : variant === 'tasks-only' ? 'tasks-only-section' : 'tasks-section';
    return path.join(__dirname, 'templates', `opencode-md-${suffix}.md`);
  }
  async addMcpServer() {
    try {
      const target = path.join(this.configDir, 'extensions', 'codeagentswarm.js');
      if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').startsWith('// CodeAgentSwarm Pi extension')) {
        throw new Error('Pi extension codeagentswarm.js belongs to the user; refusing to overwrite it');
      }
      const result = await super.addMcpServer();
      if (!result.success) return { ...result, message: result.message.replace(/Cursor/g, 'Pi') };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = path.join(__dirname, '..', 'hooks', 'pi-extension.js');
      fs.copyFileSync(fs.existsSync(source) ? source : path.join(__dirname, 'pi-extension.js'), target);
      return result;
    } catch (error) { return { success: false, message: error.message }; }
  }
}

module.exports = PiConfigStrategy;
