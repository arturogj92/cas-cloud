/**
 * CLI Agent Strategy - Abstract Base Class
 *
 * Implements the Strategy Pattern for multi-agent CLI support.
 * Each CLI agent (Claude Code, Codex CLI, etc.) implements this interface.
 *
 * @abstract
 */
class CliAgentStrategy {
    constructor() {
        if (new.target === CliAgentStrategy) {
            throw new Error('CliAgentStrategy is an abstract class and cannot be instantiated directly');
        }
    }

    // ========================================
    // Identity Methods
    // ========================================

    /**
     * Get the internal name identifier for this agent
     * @returns {string} e.g., 'claude', 'codex'
     */
    getName() {
        throw new Error('Abstract method getName() must be implemented');
    }

    /**
     * Get the display name for UI
     * @returns {string} e.g., 'Claude Code', 'Codex CLI'
     */
    getDisplayName() {
        throw new Error('Abstract method getDisplayName() must be implemented');
    }

    /**
     * Get the icon path or SVG for this agent
     * @returns {string} Path to icon file
     */
    getIcon() {
        throw new Error('Abstract method getIcon() must be implemented');
    }

    /**
     * Get the executable name for this CLI
     * @returns {string} e.g., 'claude', 'codex'
     */
    getExecutableName() {
        throw new Error('Abstract method getExecutableName() must be implemented');
    }

    /**
     * Get the settings directory path
     * @returns {string} e.g., '~/.claude', '~/.codex'
     */
    getSettingsPath() {
        throw new Error('Abstract method getSettingsPath() must be implemented');
    }

    /**
     * Get the instructions file name (project-level)
     * @returns {string} e.g., 'CLAUDE.md', 'AGENTS.md'
     */
    getInstructionsFileName() {
        throw new Error('Abstract method getInstructionsFileName() must be implemented');
    }

    /**
     * Get the global skills directory path for this agent.
     * Each skill lives as a subfolder inside this directory containing a SKILL.md.
     * @returns {string|null} Absolute path, or null if the agent has no skills concept
     */
    getSkillsPath() {
        return null;
    }

    /**
     * Whether this agent supports installing skills via the marketplace UI.
     * Defaults to false; agents must opt-in by overriding.
     * @returns {boolean}
     */
    supportsSkills() {
        return false;
    }

    // ========================================
    // Installation Methods
    // ========================================

    /**
     * Get the installer instance for this agent
     * @returns {Object} Installer instance with isInstalled(), install(), etc.
     */
    getInstaller() {
        throw new Error('Abstract method getInstaller() must be implemented');
    }

    /**
     * Check if the CLI is installed
     * @returns {boolean}
     */
    isInstalled() {
        return this.getInstaller().isInstalled();
    }

    /**
     * Get the path to the CLI executable
     * @returns {string|null}
     */
    getExecutablePath() {
        const installer = this.getInstaller();
        if (typeof installer.getClaudePath === 'function') {
            return installer.getClaudePath();
        }
        return null;
    }

    /**
     * Install the CLI
     * @param {BrowserWindow} mainWindow - Electron main window for dialogs
     * @returns {Promise<boolean>}
     */
    async install(mainWindow) {
        return this.getInstaller().install(mainWindow);
    }

    /**
     * Ensure CLI is installed, installing if necessary
     * @param {BrowserWindow} mainWindow - Electron main window for dialogs
     * @returns {Promise<boolean>}
     */
    async ensureInstalled(mainWindow) {
        return this.getInstaller().ensureInstalled(mainWindow);
    }

    // ========================================
    // Command Methods
    // ========================================

    /**
     * Get the command to start a new session
     * @param {boolean} turboMode - Whether to enable turbo/danger mode
     * @returns {string} The command to execute
     */
    getNewSessionCommand(turboMode = false) {
        throw new Error('Abstract method getNewSessionCommand() must be implemented');
    }

    /**
     * Get the command to resume a session
     * @param {string|null} sessionId - Optional specific session ID
     * @returns {string} The command to execute
     */
    getResumeSessionCommand(sessionId = null) {
        throw new Error('Abstract method getResumeSessionCommand() must be implemented');
    }

    /**
     * Get a resume command that is safe to run even if the target session might
     * be busy/live. By default this is identical to getResumeSessionCommand();
     * agents whose CLI rejects resuming a running session (e.g. Claude Code)
     * override this to transparently work around it. Async because the check
     * may need to query the CLI.
     * @param {string|null} sessionId - Optional specific session ID
     * @returns {Promise<string>} The command to execute
     */
    async getSafeResumeSessionCommand(sessionId = null) {
        return this.getResumeSessionCommand(sessionId);
    }

    /**
     * Get the turbo/danger mode flag for this CLI
     * @returns {string|null} The flag, or null if not supported
     */
    getTurboModeFlag() {
        return null;
    }

    /**
     * Get the resume flag for this CLI
     * @returns {string|null} The flag, or null if not supported
     */
    getResumeFlag() {
        return null;
    }

    // ========================================
    // Hooks Methods
    // ========================================

    /**
     * Get the hooks manager for this agent
     * @param {Object} options - Options to pass to hooks manager
     * @returns {Object} Hooks manager instance
     */
    getHooksManager(options = {}) {
        throw new Error('Abstract method getHooksManager() must be implemented');
    }

    // ========================================
    // Feature Support Methods
    // ========================================

    /**
     * Check if this agent supports session resume
     * @returns {boolean}
     */
    supportsResume() {
        return false;
    }

    /**
     * Check if this agent supports turbo/danger mode
     * @returns {boolean}
     */
    supportsTurboMode() {
        return false;
    }

    /**
     * Check if this agent supports specific session IDs
     * @returns {boolean}
     */
    supportsSessionId() {
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
            default:
                return false;
        }
    }

    // ========================================
    // Quota Capability Methods
    // ========================================

    /**
     * Check if this agent exposes a usage quota that the navbar can display.
     * @returns {boolean}
     */
    supportsQuota() {
        return false;
    }

    /**
     * Read the current quota for this agent.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null if unavailable.
     *          MUST never throw — degrade to null on any error.
     */
    async getQuota() {
        return null;
    }

    // ========================================
    // Detection Methods
    // ========================================

    /**
     * Get patterns to detect when the agent is ready (for loader hiding)
     * @returns {string[]} Array of strings/patterns to match in output
     */
    getReadyPatterns() {
        return [];
    }

    /**
     * Check if output indicates the agent is ready
     * @param {string} output - Terminal output to check
     * @returns {boolean}
     */
    isReady(output) {
        const patterns = this.getReadyPatterns();
        return patterns.some(pattern => {
            if (pattern instanceof RegExp) {
                return pattern.test(output);
            }
            return output.includes(pattern);
        });
    }
}

module.exports = CliAgentStrategy;
