/** Cursor Agent CLI strategy. The binary is always `cursor-agent`, never `agent`. */
const os = require('os');
const path = require('path');
const CliAgentStrategy = require('./cli-agent-strategy');

let cursorCliInstaller = null;
function getCursorCliInstaller() {
    if (!cursorCliInstaller) cursorCliInstaller = require('../cursor-cli-installer');
    return cursorCliInstaller;
}

class CursorCliStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._customBinaryPath = null;
    }

    setCustomBinaryPath(binaryPath) { this._customBinaryPath = binaryPath || null; }
    getCustomBinaryPath() { return this._customBinaryPath; }
    getName() { return 'cursor'; }
    getDisplayName() { return 'Cursor Agent'; }
    getIcon() { return '../../../assets/icons/cursor-icon.svg'; }
    getExecutableName() { return this._customBinaryPath || getCursorCliInstaller().getCursorAgentPath() || 'cursor-agent'; }
    getSettingsPath() { return path.join(os.homedir(), '.cursor'); }
    getInstructionsFileName() { return path.join('rules', 'codeagentswarm.mdc'); }
    getSkillsPath() { return path.join(this.getSettingsPath(), 'skills'); }
    supportsSkills() { return true; }
    getInstaller() { return getCursorCliInstaller(); }
    isInstalled() { return getCursorCliInstaller().isInstalled(); }
    getExecutablePath() { return getCursorCliInstaller().getCursorAgentPath(); }
    async install(mainWindow) { return getCursorCliInstaller().install(mainWindow); }
    async ensureInstalled(mainWindow) { return getCursorCliInstaller().ensureInstalled(mainWindow); }

    _quote(value) {
        const text = String(value || 'cursor-agent');
        return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    }

    getNewSessionCommand(turboMode = false) {
        const command = this._quote(this.getExecutableName());
        return turboMode ? `${command} --force` : command;
    }

    getResumeSessionCommand(sessionId = null) {
        const command = this._quote(this.getExecutableName());
        return sessionId ? `${command} --resume ${this._quote(sessionId)}` : `${command} resume`;
    }

    getTurboModeFlag() { return '--force'; }
    getResumeFlag() { return 'resume'; }
    getHooksManager() { return null; }
    supportsResume() { return true; }
    supportsTurboMode() { return true; }
    supportsSessionId() { return true; }
    supportsFileChangeTracking() { return false; }
    supportsQuota() { return true; }
    async getQuota() {
        try {
            return await require('../quota/cursor-quota-reader').getInstance().getQuota();
        } catch {
            return null;
        }
    }
    getReadyPatterns() { return ['Cursor Agent', 'Ask anything', 'Ready', '>']; }
}

let instance = null;
function getInstance() {
    if (!instance) instance = new CursorCliStrategy();
    return instance;
}

module.exports = { CursorCliStrategy, getInstance };
