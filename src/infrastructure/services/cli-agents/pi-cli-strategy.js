const os = require('os');
const path = require('path');
const CliAgentStrategy = require('./cli-agent-strategy');
const { quoteForCmd } = require('../../platform/windows-direct-spawn');

function quote(value) {
  return process.platform === 'win32' ? quoteForCmd(value) : `'${String(value).replace(/'/g, "'\\''")}'`;
}

class PiCliStrategy extends CliAgentStrategy {
  setCustomBinaryPath(value) { this._customBinaryPath = value || null; }
  getCustomBinaryPath() { return this._customBinaryPath || null; }
  getName() { return 'pi'; }
  getDisplayName() { return 'Pi (beta)'; }
  getIcon() { return '../../../assets/icons/pi-icon.svg'; }
  getExecutableName() { return this._customBinaryPath || this.getExecutablePath() || 'pi'; }
  getSettingsPath() { return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'); }
  getInstructionsFileName() { return 'AGENTS.md'; }
  getSkillsPath() { return path.join(this.getSettingsPath(), 'skills'); }
  supportsSkills() { return true; }
  getInstaller() { return require('../pi-cli-installer'); }
  isInstalled() { return this.getInstaller().isInstalled(); }
  getExecutablePath() { return this.getInstaller().getPiPath(); }
  install(window) { return this.getInstaller().install(window); }
  ensureInstalled(window) { return this.getInstaller().ensureInstalled(window); }
  getNewSessionCommand() { return quote(this.getExecutableName()); }
  getResumeSessionCommand(id) { return `${this.getNewSessionCommand()} ${id ? `--session ${quote(id)}` : '--continue'}`; }
  getResumeFlag() { return '--session'; }
  getTurboModeFlag() { return ''; }
  getHooksManager() { return null; }
  supportsResume() { return true; }
  supportsSessionId() { return true; }
  supportsTurboMode() { return false; }
  supportsFileChangeTracking() { return false; }
  supportsQuota() { return false; }
  getReadyPatterns() { return ['pi', '/model', '/login']; }
}

let instance;
module.exports = { PiCliStrategy, getInstance: () => (instance ||= new PiCliStrategy()) };
