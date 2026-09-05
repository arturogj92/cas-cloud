/**
 * Codex CLI Strategy
 *
 * Concrete implementation of CliAgentStrategy for OpenAI Codex CLI.
 * Encapsulates codex-cli-installer and codex-hooks-manager logic.
 *
 * Key differences from Claude/Gemini:
 * - Uses TOML config instead of JSON
 * - Resume is a subcommand: `codex resume <id>` not `codex --resume`
 * - Turbo mode uses --full-auto flag
 * - Instructions file is AGENTS.md not CODEX.md
 * - Limited hooks: only notify (agent-turn-complete, approval-requested)
 */
const path = require('path');
const os = require('os');
const CliAgentStrategy = require('./cli-agent-strategy');

// Lazy load to avoid circular dependencies
let codexCliInstaller = null;
let CodexHooksManager = null;

function getCodexCliInstaller() {
    if (!codexCliInstaller) {
        codexCliInstaller = require('../codex-cli-installer');
    }
    return codexCliInstaller;
}

function getCodexHooksManager() {
    if (!CodexHooksManager) {
        CodexHooksManager = require('../../hooks/codex-hooks-manager');
    }
    return CodexHooksManager;
}

// Lazy load the quota reader to avoid loading its deps unless quota is queried.
let codexQuotaReader = null;
function getCodexQuotaReader() {
    if (!codexQuotaReader) {
        codexQuotaReader = require('../quota/codex-quota-reader');
    }
    return codexQuotaReader;
}

class CodexCliStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._hooksManager = null;
        this._customBinaryPath = null;
        this._quotaAccountResolver = null;
        this._quotaAccountResolverEnabled = null;
    }

    /**
     * Set a custom binary path for Codex CLI.
     * When set, this path is used instead of the default 'codex' command.
     * @param {string|null} binaryPath - Full path to the binary, or null to reset
     */
    setCustomBinaryPath(binaryPath) {
        this._customBinaryPath = binaryPath || null;
    }

    /**
     * Get the current custom binary path, if any.
     * @returns {string|null}
     */
    getCustomBinaryPath() {
        return this._customBinaryPath;
    }

    // ========================================
    // Identity Methods
    // ========================================

    getName() {
        return 'codex';
    }

    getDisplayName() {
        return 'Codex CLI';
    }

    getIcon() {
        // Path relative to renderer context
        return '../../../assets/icons/codex-icon.svg';
    }

    getExecutableName() {
        return this._customBinaryPath || 'codex';
    }

    getSettingsPath() {
        return path.join(os.homedir(), '.codex');
    }

    getInstructionsFileName() {
        // Codex uses AGENTS.md, not CODEX.md
        return 'AGENTS.md';
    }

    getSkillsPath() {
        // Codex CLI reads skills from $CODEX_HOME/skills (defaulting to
        // ~/.codex/skills). Confirmed empirically against the native binary:
        //   _codex_home() = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
        //   root = os.path.join(_codex_home(), "skills")
        // The previous "~/.agents/skills" path (agentskills.io convention) was
        // never read by Codex CLI; skills installed there were invisible to it
        // AND collided with Gemini, which DOES read ~/.agents/skills/.
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        return path.join(codexHome, 'skills');
    }

    supportsSkills() {
        return true;
    }

    // ========================================
    // Installation Methods
    // ========================================

    getInstaller() {
        return getCodexCliInstaller();
    }

    isInstalled() {
        return getCodexCliInstaller().isInstalled();
    }

    getExecutablePath() {
        return getCodexCliInstaller().getCodexPath();
    }

    async install(mainWindow) {
        return getCodexCliInstaller().install(mainWindow);
    }

    async ensureInstalled(mainWindow) {
        return getCodexCliInstaller().ensureInstalled(mainWindow);
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
        // Codex uses subcommand syntax: `codex resume` not `codex --resume`
        if (sessionId) {
            return `${executable} resume ${sessionId}`;
        }
        return `${executable} resume --last`;
    }

    getTurboModeFlag() {
        // Codex uses --dangerously-bypass-approvals-and-sandbox for full auto mode
        // (equivalent to Claude's --dangerously-skip-permissions)
        return '--dangerously-bypass-approvals-and-sandbox';
    }

    getResumeFlag() {
        // Note: Codex uses subcommand, not flag
        return 'resume';
    }

    // ========================================
    // Hooks Methods
    // ========================================

    getHooksManager(options = {}) {
        if (!this._hooksManager) {
            const CodexHooksManagerClass = getCodexHooksManager();
            this._hooksManager = new CodexHooksManagerClass(options);
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
     * Codex has limited hooks - no file change tracking
     * @returns {boolean}
     */
    supportsFileChangeTracking() {
        return false;
    }

    /**
     * Check if this agent supports a specific feature
     * @param {string} featureName - Name of the feature to check
     * @returns {boolean}
     */
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
    // Quota Capability Methods
    // ========================================

    supportsQuota() {
        return true;
    }

    /**
     * Read the current Codex quota via the dedicated rollout reader.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null. Never throws.
     */
    async getQuota() {
        return getCodexQuotaReader().getInstance().getQuota();
    }

    setQuotaAccountResolver(resolver, isEnabled = null, activeBindings = null, bindingSince = null) {
        this._quotaAccountResolver = typeof resolver === 'function' ? resolver : null;
        this._quotaAccountResolverEnabled = typeof isEnabled === 'function' ? isEnabled : null;
        this._quotaAccountBindings = typeof activeBindings === 'function' ? activeBindings : null;
        this._quotaAccountBindingSince = typeof bindingSince === 'function' ? bindingSince : null;
    }

    async getQuotas() {
        const resolver = this._quotaAccountResolverEnabled?.() === false
            ? null
            : this._quotaAccountResolver;
        const bindings = resolver ? this._quotaAccountBindings?.() : null;
        const bindingSince = (resolver ? this._quotaAccountBindingSince?.() : null) ?? null;
        return getCodexQuotaReader().getInstance().getQuotas(resolver, bindings, bindingSince);
    }

    // ========================================
    // Detection Methods
    // ========================================

    getReadyPatterns() {
        return [
            'Codex>',
            '❯',
            '>',
            'codex-cli',
            'Welcome to Codex',
            'What would you like to do?'
        ];
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new CodexCliStrategy();
    }
    return instance;
}

module.exports = {
    CodexCliStrategy,
    getInstance
};
