/**
 * Antigravity CLI Strategy
 *
 * Concrete implementation of CliAgentStrategy for Google's Antigravity CLI
 * (`agy`), the official successor to Gemini CLI (Gemini CLI was retired by
 * Google on 2026-06-18).
 *
 * Verified facts against agy v1.0.13:
 * - New interactive session (TUI): `agy`
 * - Turbo / auto-approve: `agy --dangerously-skip-permissions` (same flag as Claude)
 * - Continue most recent conversation: `agy -c` (alias `--continue`)
 * - Resume a specific conversation: `agy --conversation <id>`
 * - Instructions file convention: AGENTS.md (also reads GEMINI.md)
 * - Reuses ~/.gemini as its config home, under ~/.gemini/antigravity-cli/
 * - CodeAgentSwarm integration (hooks + MCP) is delivered as a single installed
 *   plugin at ~/.gemini/antigravity-cli/plugins/codeagentswarm/ (see
 *   antigravity-hooks-manager).
 */
const path = require('path');
const os = require('os');
const CliAgentStrategy = require('./cli-agent-strategy');

// Lazy load to avoid circular dependencies (mirrors gemini-cli-strategy)
let antigravityCliInstaller = null;
let AntigravityHooksManager = null;

function getAntigravityCliInstaller() {
    if (!antigravityCliInstaller) {
        antigravityCliInstaller = require('../antigravity-cli-installer');
    }
    return antigravityCliInstaller;
}

function getAntigravityHooksManager() {
    if (!AntigravityHooksManager) {
        AntigravityHooksManager = require('../../hooks/antigravity-hooks-manager');
    }
    return AntigravityHooksManager;
}

// Lazy load the quota reader to avoid loading its deps unless quota is queried.
let antigravityQuotaReader = null;
function getAntigravityQuotaReader() {
    if (!antigravityQuotaReader) {
        antigravityQuotaReader = require('../quota/antigravity-quota-reader');
    }
    return antigravityQuotaReader;
}

class AntigravityCliStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._hooksManager = null;
        this._customBinaryPath = null;
    }

    /**
     * Set a custom binary path for the agy CLI.
     * @param {string|null} binaryPath
     */
    setCustomBinaryPath(binaryPath) {
        this._customBinaryPath = binaryPath || null;
    }

    getCustomBinaryPath() {
        return this._customBinaryPath;
    }

    // ========================================
    // Identity Methods
    // ========================================

    getName() {
        return 'antigravity';
    }

    getDisplayName() {
        return 'Antigravity CLI';
    }

    getIcon() {
        return '../../../assets/icons/antigravity-icon.png';
    }

    getExecutableName() {
        return this._customBinaryPath || 'agy';
    }

    getSettingsPath() {
        // agy reuses ~/.gemini as its home, with its own subtree underneath.
        return path.join(os.homedir(), '.gemini', 'antigravity-cli');
    }

    getInstructionsFileName() {
        // Antigravity follows the AGENTS.md cross-tool convention.
        return 'AGENTS.md';
    }

    getSkillsPath() {
        return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'skills');
    }

    supportsSkills() {
        return true;
    }

    // ========================================
    // Installation Methods
    // ========================================

    getInstaller() {
        return getAntigravityCliInstaller();
    }

    isInstalled() {
        return getAntigravityCliInstaller().isInstalled();
    }

    getExecutablePath() {
        return getAntigravityCliInstaller().getAgyPath();
    }

    async install(mainWindow) {
        return getAntigravityCliInstaller().install(mainWindow);
    }

    async ensureInstalled(mainWindow) {
        return getAntigravityCliInstaller().ensureInstalled(mainWindow);
    }

    // ========================================
    // Command Methods
    // ========================================

    getNewSessionCommand(turboMode = false) {
        const executable = this.getExecutableName();
        if (turboMode) {
            return `${executable} ${this.getTurboModeFlag()}`;
        }
        return executable;
    }

    getResumeSessionCommand(sessionId = null) {
        const executable = this.getExecutableName();
        if (sessionId) {
            // agy resumes a specific conversation by id.
            return `${executable} --conversation ${sessionId}`;
        }
        // No id -> continue the most recent conversation.
        return `${executable} -c`;
    }

    getTurboModeFlag() {
        return '--dangerously-skip-permissions';
    }

    getResumeFlag() {
        return '-c';
    }

    // ========================================
    // Hooks Methods
    // ========================================

    getHooksManager(options = {}) {
        if (!this._hooksManager) {
            const AntigravityHooksManagerClass = getAntigravityHooksManager();
            this._hooksManager = new AntigravityHooksManagerClass(options);
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

    // ========================================
    // Quota Capability Methods
    // ========================================

    supportsQuota() {
        return true;
    }

    /**
     * Read the current Antigravity quota via the language-server reader.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null. Never throws.
     */
    async getQuota() {
        return getAntigravityQuotaReader().getInstance().getQuota();
    }

    // ========================================
    // Detection Methods
    // ========================================

    getReadyPatterns() {
        // Signals that the agy TUI is up, used to hide the loading overlay.
        return [
            'Antigravity',
            'agy',
            '❯',
            '>',
            '/help'
        ];
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new AntigravityCliStrategy();
    }
    return instance;
}

module.exports = {
    AntigravityCliStrategy,
    getInstance
};
