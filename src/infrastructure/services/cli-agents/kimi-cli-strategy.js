/**
 * Kimi Code CLI Strategy
 *
 * Concrete implementation of CliAgentStrategy for Moonshot's Kimi Code CLI
 * (https://moonshotai.github.io/kimi-code/, npm `@moonshot-ai/kimi-code`).
 *
 * Every fact below was verified against a real `kimi --version` / `kimi --help` on
 * v0.26.0, not against the docs, because two things make the docs unreliable here:
 * the product ships ~1 release/day, and a stale help-center page documents the
 * DEPRECATED Python CLI while calling itself "Kimi Code CLI".
 *
 * Verified CLI surface (v0.26.0):
 * - New interactive session (TUI): `kimi`
 * - Turbo / auto-approve:          `kimi --yolo` (alias -y)  <-- a real bypass flag, unlike opencode
 * - Continue last session in cwd:  `kimi --continue` (alias -c, LOWERCASE; the legacy
 *                                  Python CLI used -C uppercase)
 * - Resume a specific session:     `kimi --session <id>` (alias -S)
 * - Headless:                      `kimi --prompt <text>` (alias -p). NOTE: the legacy CLI
 *                                  called this `--print`, which does NOT exist here.
 * - Instructions file convention:  AGENTS.md (no KIMI.md exists)
 * - Data root:                     ~/.kimi-code (relocatable via KIMI_CODE_HOME)
 * - Config:                        ~/.kimi-code/config.toml (TOML)
 * - Skills:                        ~/.kimi-code/skills AND ~/.agents/skills (shared!)
 *
 * Sessions are stored PER WORKING DIRECTORY (like Codex), not in one flat store
 * (unlike opencode/antigravity):
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/state.json      (title, timestamps)
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl (transcript)
 *   ~/.kimi-code/session_index.jsonl                               (global index)
 */
const path = require('path');
const os = require('os');
const CliAgentStrategy = require('./cli-agent-strategy');

// Lazy load to avoid circular dependencies (mirrors codex/opencode strategies)
let kimiCliInstaller = null;
let KimiHooksManager = null;

function getKimiCliInstaller() {
    if (!kimiCliInstaller) {
        kimiCliInstaller = require('../kimi-cli-installer');
    }
    return kimiCliInstaller;
}

function getKimiHooksManager() {
    if (!KimiHooksManager) {
        KimiHooksManager = require('../../hooks/kimi-hooks-manager');
    }
    return KimiHooksManager;
}

class KimiCliStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._hooksManager = null;
        this._customBinaryPath = null;
    }

    /**
     * Set a custom binary path for the Kimi Code CLI.
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
        return 'kimi';
    }

    getDisplayName() {
        return 'Kimi Code';
    }

    getIcon() {
        // Path relative to renderer context
        return '../../../assets/icons/kimi-icon.png';
    }

    getExecutableName() {
        // Prefer an explicit user binary; otherwise the ABSOLUTE path of a verified
        // TypeScript-lineage (0.x) binary. We do NOT fall back to a bare `kimi`, because
        // the deprecated Python kimi-cli installs the same command name and launching it
        // would silently give the user a different product that reads a different config
        // dir (~/.kimi instead of ~/.kimi-code). If nothing valid is found, 'kimi' is
        // returned so the install flow can surface a real error rather than a crash.
        return this._customBinaryPath || getKimiCliInstaller().getKimiPath() || 'kimi';
    }

    getSettingsPath() {
        // Kimi keeps everything under a single relocatable data root. Honor KIMI_CODE_HOME:
        // the app may point different worktrees at different roots, and every path below
        // (config, sessions, skills, credentials, AGENTS.md) moves with it.
        return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    }

    getInstructionsFileName() {
        // Kimi follows the AGENTS.md convention (like Codex and opencode). KIMI.md does
        // not exist. Composed by the base config strategy as getSettingsPath() + this.
        return 'AGENTS.md';
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
        return getKimiCliInstaller();
    }

    isInstalled() {
        return getKimiCliInstaller().isInstalled();
    }

    getExecutablePath() {
        return getKimiCliInstaller().getKimiPath();
    }

    async install(mainWindow) {
        return getKimiCliInstaller().install(mainWindow);
    }

    async ensureInstalled(mainWindow) {
        return getKimiCliInstaller().ensureInstalled(mainWindow);
    }

    // ========================================
    // Command Methods
    // ========================================

    getNewSessionCommand(turboMode = false) {
        const executable = this.getExecutableName();
        return turboMode ? `${executable} ${this.getTurboModeFlag()}` : executable;
    }

    getResumeSessionCommand(sessionId = null) {
        const executable = this.getExecutableName();
        // Verified: --session <id> resumes that session; --continue resumes the most
        // recent session FOR THE CURRENT WORKING DIRECTORY. They are mutually exclusive.
        if (sessionId) {
            return `${executable} --session ${sessionId}`;
        }
        return `${executable} --continue`;
    }

    getTurboModeFlag() {
        // Verified on --help: "-y, --yolo  Automatically approve all actions."
        return '--yolo';
    }

    getResumeFlag() {
        return '--continue';
    }

    // ========================================
    // Hooks Methods
    // ========================================

    getHooksManager(options = {}) {
        if (!this._hooksManager) {
            const KimiHooksManagerClass = getKimiHooksManager();
            this._hooksManager = new KimiHooksManagerClass(options);
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
     * File-change tracking rides on the PreToolUse/PostToolUse hooks written into
     * config.toml by kimi-hooks-manager.
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

    supportsQuota() {
        return true;
    }

    async getQuota() {
        try {
            const { getInstance } = require('../quota/kimi-quota-reader');
            return await getInstance().getQuota();
        } catch (e) {
            return null;
        }
    }

    // ========================================
    // Detection Methods
    // ========================================

    getReadyPatterns() {
        // Signals the Kimi TUI is up, used to hide the loading overlay. Verified against
        // the real banner: it prints "Welcome to Kimi Code!" inside a box, then a prompt.
        return [
            'Welcome to Kimi Code',
            'Kimi Code',
            '/sessions to browse',
            '❯',
            '>'
        ];
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new KimiCliStrategy();
    }
    return instance;
}

module.exports = {
    KimiCliStrategy,
    getInstance
};
