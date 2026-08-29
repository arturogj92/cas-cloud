/**
 * Claude Code Strategy
 *
 * Concrete implementation of CliAgentStrategy for Claude Code CLI.
 * Encapsulates existing claude-code-installer and hooks-manager logic.
 */
const path = require('path');
const os = require('os');
const CliAgentStrategy = require('./cli-agent-strategy');

// Lazy load to avoid circular dependencies
let claudeCodeInstaller = null;
let HooksManager = null;
// Lazy load the quota readers to avoid loading their deps unless quota is queried.
let claudeQuotaReader = null;
let claudeOAuthQuotaReader = null;

function getClaudeCodeInstaller() {
    if (!claudeCodeInstaller) {
        claudeCodeInstaller = require('../claude-code-installer');
    }
    return claudeCodeInstaller;
}

function getClaudeQuotaReader() {
    if (!claudeQuotaReader) {
        claudeQuotaReader = require('../quota/claude-quota-reader');
    }
    return claudeQuotaReader;
}

function getClaudeOAuthQuotaReader() {
    if (!claudeOAuthQuotaReader) {
        claudeOAuthQuotaReader = require('../quota/claude-oauth-quota-reader');
    }
    return claudeOAuthQuotaReader;
}

function getHooksManager() {
    if (!HooksManager) {
        HooksManager = require('../../hooks/hooks-manager');
    }
    return HooksManager;
}

class ClaudeCodeStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._hooksManager = null;
        this._customBinaryPath = null;
    }

    /**
     * Set a custom binary path for Claude CLI.
     * When set, this path is used instead of the default 'claude' command.
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
        return 'claude';
    }

    getDisplayName() {
        return 'Claude Code';
    }

    getIcon() {
        // Path relative to renderer context
        return '../../../assets/icons/claude-icon.svg';
    }

    getExecutableName() {
        return this._customBinaryPath || 'claude';
    }

    getSettingsPath() {
        return path.join(os.homedir(), '.claude');
    }

    getInstructionsFileName() {
        return 'CLAUDE.md';
    }

    getSkillsPath() {
        return path.join(os.homedir(), '.claude', 'skills');
    }

    supportsSkills() {
        return true;
    }

    // ========================================
    // Installation Methods
    // ========================================

    getInstaller() {
        return getClaudeCodeInstaller();
    }

    isInstalled() {
        return getClaudeCodeInstaller().isInstalled();
    }

    getExecutablePath() {
        return getClaudeCodeInstaller().getClaudePath();
    }

    async install(mainWindow) {
        return getClaudeCodeInstaller().install(mainWindow);
    }

    async ensureInstalled(mainWindow) {
        return getClaudeCodeInstaller().ensureInstalled(mainWindow);
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
            return `${executable} -r ${sessionId}`;
        }
        return `${executable} --resume`;
    }

    /**
     * Resume command that survives the "session is a live background agent" case.
     *
     * `claude -r <id>` refuses (exits 1) when <id> is currently running as a
     * background agent — Claude suggests attaching or `--fork-session`. When we
     * detect that situation we append `--fork-session` so the resume branches
     * off the live session's history instead of failing. In every other case
     * (no sessionId, session not live, or the check fails) we fall back to the
     * plain resume command.
     * @param {string|null} sessionId - Optional specific session ID
     * @returns {Promise<string>} The command to execute
     */
    async getSafeResumeSessionCommand(sessionId = null) {
        const base = this.getResumeSessionCommand(sessionId);
        if (!sessionId) {
            // No specific session => interactive picker, no double-resume risk.
            return base;
        }
        const { isSessionRunningAsBackgroundAgent } = require('./claude-bg-agents');
        const isLiveBackgroundAgent = await isSessionRunningAsBackgroundAgent(sessionId);
        return isLiveBackgroundAgent ? `${base} --fork-session` : base;
    }

    getTurboModeFlag() {
        return '--dangerously-skip-permissions';
    }

    getResumeFlag() {
        return '--resume';
    }

    // ========================================
    // Hooks Methods
    // ========================================

    getHooksManager(options = {}) {
        if (!this._hooksManager) {
            const HooksManagerClass = getHooksManager();
            this._hooksManager = new HooksManagerClass(options);
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
     * Read the current Claude quota.
     *
     * Tries the OAuth usage endpoint FIRST — it returns the rich data (plan tier,
     * per-model weekly limits, always-fresh percentages). If the token is absent
     * or the request fails, it returns null and we fall back to the statusLine
     * cache reader. So: rich data when the token works, graceful degrade otherwise.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null. Never throws.
     */
    async getQuota() {
        const oauthSnapshot = await getClaudeOAuthQuotaReader().getInstance().getQuota();
        if (oauthSnapshot) return oauthSnapshot;
        return getClaudeQuotaReader().getInstance().getQuota();
    }

    async getQuotas() {
        const current = await this.getQuota();
        const snapshots = await getClaudeQuotaReader().getInstance().getQuotas();
        const byAccount = new Map(snapshots.map((snapshot) => [snapshot.accountId || 'current', snapshot]));
        if (current) byAccount.set('current', { ...current, accountId: 'current' });
        return Array.from(byAccount.values());
    }

    // ========================================
    // Detection Methods
    // ========================================

    getReadyPatterns() {
        return [
            'Welcome to Claude',
            'Type /help',
            'Tips:',
            '╭─',  // Claude's box drawing
            'Claude Code'
        ];
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new ClaudeCodeStrategy();
    }
    return instance;
}

module.exports = {
    ClaudeCodeStrategy,
    getInstance
};
