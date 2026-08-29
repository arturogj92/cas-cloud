/**
 * Grok Build CLI Strategy
 *
 * Concrete implementation of CliAgentStrategy for xAI's Grok Build CLI
 * (https://x.ai/cli, binary `grok`).
 *
 * Verified CLI surface (v0.2.x `grok --help`):
 * - New interactive session (TUI): `grok`
 * - Turbo / auto-approve:          `grok --always-approve`  (there is NO --yolo flag;
 *                                  the TUI persists the same thing as
 *                                  `permission_mode = "always-approve"` in config.toml)
 * - Continue last session in cwd:  `grok --continue` (alias -c)
 * - Resume a specific session:     `grok --resume <id>`
 * - Headless:                      `grok -p` / `grok --single`
 * - Data root:                     ~/.grok (relocatable via GROK_HOME)
 * - Config:                        ~/.grok/config.toml (TOML)
 * - Global instructions:           ~/.grok/rules/*.md
 * - Skills:                        ~/.grok/skills
 *
 * Sessions are stored per working directory, keyed by the URL-ENCODED cwd:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/summary.json
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl
 *
 * SuperGrok weekly usage is read via cli-chat-proxy billing
 * (`/v1/billing?format=credits`) — same data as the CLI `/usage` command.
 * See `quota/grok-quota-reader.js`.
 */
const path = require('path');
const os = require('os');
const CliAgentStrategy = require('./cli-agent-strategy');

// Lazy load to avoid circular dependencies (mirrors codex/kimi strategies)
let grokCliInstaller = null;
let GrokHooksManager = null;

function getGrokCliInstaller() {
    if (!grokCliInstaller) {
        grokCliInstaller = require('../grok-cli-installer');
    }
    return grokCliInstaller;
}

function getGrokHooksManager() {
    if (!GrokHooksManager) {
        GrokHooksManager = require('../../hooks/grok-hooks-manager');
    }
    return GrokHooksManager;
}

class GrokCliStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._hooksManager = null;
        this._customBinaryPath = null;
    }

    /**
     * Set a custom binary path for the Grok Build CLI.
     * @param {string|null} binaryPath - Full path to the binary, or null to reset
     */
    setCustomBinaryPath(binaryPath) {
        this._customBinaryPath = binaryPath || null;
    }

    /**
     * @returns {string|null}
     */
    getCustomBinaryPath() {
        return this._customBinaryPath;
    }

    // ========================================
    // Identity Methods
    // ========================================

    getName() {
        return 'grok';
    }

    getDisplayName() {
        return 'Grok Build';
    }

    getIcon() {
        // Path relative to renderer context
        return '../../../assets/icons/grok-icon.svg';
    }

    getExecutableName() {
        // The official installer drops the binary at ~/.grok/bin/grok and PATHs it via
        // the shell rc, which a GUI-launched Electron app never sees — so prefer the
        // resolved absolute path and only fall back to a bare `grok`.
        return this._customBinaryPath || getGrokCliInstaller().getGrokPath() || 'grok';
    }

    getSettingsPath() {
        // Grok keeps everything under a single relocatable data root. Honor GROK_HOME:
        // config, sessions, skills, rules and hooks all move with it.
        return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
    }

    getInstructionsFileName() {
        // Grok reads every markdown file under <GROK_HOME>/rules/ as global
        // instructions. We own exactly one file there so a user's own rules survive.
        return path.join('rules', 'codeagentswarm.md');
    }

    // ========================================
    // Skills Methods
    // ========================================

    getSkillsPath() {
        return path.join(this.getSettingsPath(), 'skills');
    }

    supportsSkills() {
        return true;
    }

    // ========================================
    // Installation Methods
    // ========================================

    getInstaller() {
        return getGrokCliInstaller();
    }

    isInstalled() {
        return getGrokCliInstaller().isInstalled();
    }

    getExecutablePath() {
        return getGrokCliInstaller().getGrokPath();
    }

    async install(mainWindow) {
        return getGrokCliInstaller().install(mainWindow);
    }

    async ensureInstalled(mainWindow) {
        return getGrokCliInstaller().ensureInstalled(mainWindow);
    }

    // ========================================
    // Command Methods
    // ========================================

    /**
     * Quote an absolute path that contains spaces so the shell sees one token.
     * Bare command names (`grok`) are left alone.
     * @param {string} executable
     * @returns {string}
     */
    _shellQuoteExecutable(executable) {
        const e = String(executable || 'grok');
        if (!/[\s"]/.test(e)) return e;
        // Windows-friendly double quotes; escape embedded quotes.
        return `"${e.replace(/"/g, '\\"')}"`;
    }

    getNewSessionCommand(turboMode = false) {
        const executable = this._shellQuoteExecutable(this.getExecutableName());
        return turboMode ? `${executable} ${this.getTurboModeFlag()}` : executable;
    }

    getResumeSessionCommand(sessionId = null) {
        const executable = this._shellQuoteExecutable(this.getExecutableName());
        // Verified: --resume <id> resumes that session; --continue resumes the most
        // recent session FOR THE CURRENT WORKING DIRECTORY.
        if (sessionId) {
            // Session ids are UUIDs (no spaces); still quote defensively if weird.
            const id = /[\s"]/.test(sessionId) ? `"${String(sessionId).replace(/"/g, '\\"')}"` : sessionId;
            return `${executable} --resume ${id}`;
        }
        return `${executable} --continue`;
    }

    getTurboModeFlag() {
        // Verified on --help: "--always-approve  Automatically approve all tool calls".
        // `--yolo` does NOT exist on Grok (that is Kimi's flag).
        return '--always-approve';
    }

    getResumeFlag() {
        return '--continue';
    }

    // ========================================
    // Hooks Methods
    // ========================================

    getHooksManager(options = {}) {
        if (!this._hooksManager) {
            const GrokHooksManagerClass = getGrokHooksManager();
            this._hooksManager = new GrokHooksManagerClass(options);
        }
        return this._hooksManager;
    }

    // ========================================
    // Feature Support Methods
    // ========================================

    supportsResume() {
        return true;
    }

    supportsTurboMode() {
        return true;
    }

    supportsSessionId() {
        return true;
    }

    /**
     * File-change tracking rides on the PostToolUse hook JSON written into
     * <GROK_HOME>/hooks/ by grok-hooks-manager.
     * @returns {boolean}
     */
    supportsFileChangeTracking() {
        return true;
    }

    supportsFeature(featureName) {
        switch (featureName) {
            case 'resume':
                return this.supportsResume();
            case 'turboMode':
            case 'dangerMode':
                return this.supportsTurboMode();
            case 'sessionId':
                return this.supportsSessionId();
            case 'fileChangeTracking':
                return this.supportsFileChangeTracking();
            default:
                return false;
        }
    }

    // ========================================
    // Quota Methods
    // ========================================

    /**
     * SuperGrok weekly usage via cli-chat-proxy billing endpoint
     * (`GET .../v1/billing?format=credits` with the OIDC token from ~/.grok/auth.json).
     * Same data the CLI's `/usage` command shows. See grok-quota-reader.js.
     * @returns {boolean}
     */
    supportsQuota() {
        return true;
    }

    async getQuota() {
        try {
            const { getInstance } = require('../quota/grok-quota-reader');
            return await getInstance().getQuota();
        } catch (_e) {
            return null;
        }
    }

    // ========================================
    // Detection Methods
    // ========================================

    getReadyPatterns() {
        // Signals the Grok TUI is up, used to hide the loading overlay.
        return [
            'Grok',
            'Welcome',
            '❯',
            '>'
        ];
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new GrokCliStrategy();
    }
    return instance;
}

module.exports = {
    GrokCliStrategy,
    getInstance
};
