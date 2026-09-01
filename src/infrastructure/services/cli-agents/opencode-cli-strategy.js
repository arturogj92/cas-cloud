/**
 * opencode CLI Strategy
 *
 * Concrete implementation of CliAgentStrategy for the SST opencode CLI
 * (https://opencode.ai, npm package `opencode-ai`).
 *
 * The agent appears in the picker, can be launched, and is fully wired into
 * CodeAgentSwarm: task-system MCP injection (opencode.json), notification +
 * file-change hooks and the terminal-title gate (all delivered as a single
 * native opencode plugin — see opencode-hooks-manager.js).
 *
 * Key facts about the SST opencode CLI (verified against v1.17.x):
 * - New interactive session (TUI): `opencode`
 * - Resume last session: `opencode --continue` (alias `-c`)
 * - Resume a specific session: `opencode --session <id>` (alias `-s`)
 * - Instructions file convention: AGENTS.md (the cross-tool standard), NOT OPENCODE.md
 * - Global config lives in ~/.config/opencode (opencode.json), unlike the
 *   home-level dotdirs used by Claude (~/.claude) / Codex (~/.codex) / Gemini (~/.gemini)
 * - No single "turbo/danger" flag like Codex's --dangerously-...; permissions are
 *   config-driven, so turbo mode is intentionally not exposed for the MVP.
 */
const path = require('path');
const os = require('os');
const CliAgentStrategy = require('./cli-agent-strategy');

// Lazy load to avoid circular dependencies (mirrors codex-cli-strategy)
let opencodeCliInstaller = null;
let OpencodeHooksManager = null;

function getOpencodeCliInstaller() {
    if (!opencodeCliInstaller) {
        opencodeCliInstaller = require('../opencode-cli-installer');
    }
    return opencodeCliInstaller;
}

function getOpencodeHooksManager() {
    if (!OpencodeHooksManager) {
        OpencodeHooksManager = require('../../hooks/opencode-hooks-manager');
    }
    return OpencodeHooksManager;
}

class OpencodeCliStrategy extends CliAgentStrategy {
    constructor() {
        super();
        this._hooksManager = null;
        this._customBinaryPath = null;
    }

    /**
     * Set a custom binary path for the opencode CLI.
     * When set, this path is used instead of the default 'opencode' command.
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
        return 'opencode';
    }

    getDisplayName() {
        // SST brands the product lowercase.
        return 'opencode';
    }

    getIcon() {
        // Path relative to renderer context
        return '../../../assets/icons/opencode-icon.svg';
    }

    getExecutableName() {
        // Prefer an explicit user binary; otherwise, if MORE THAN ONE opencode is on
        // PATH, prefer the SST build (>= 1.x) over the legacy 0.0.x that ignores the
        // opencode.json config (resolveBestPath returns null when there is no such
        // conflict, keeping the plain `opencode` PATH default). A full path still
        // matches the bracketed-paste detector (isOpencodeCommand: endsWith '/opencode').
        return this._customBinaryPath || getOpencodeCliInstaller().resolveBestPath() || 'opencode';
    }

    getSettingsPath() {
        // SST opencode keeps its config under ~/.config/opencode (XDG-style),
        // not a home-level dotdir like the other agents.
        return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
    }

    getInstructionsFileName() {
        // opencode follows the AGENTS.md convention (same as Codex).
        return 'AGENTS.md';
    }

    // ========================================
    // Skills Methods
    // ========================================

    getSkillsPath() {
        // App-managed skills live under opencode's XDG config dir, mirroring the
        // per-agent skills layout used by the other CLIs.
        return path.join(this.getSettingsPath(), 'skills');
    }

    supportsSkills() {
        return true;
    }

    // ========================================
    // Installation Methods
    // ========================================

    getInstaller() {
        return getOpencodeCliInstaller();
    }

    isInstalled() {
        return getOpencodeCliInstaller().isInstalled();
    }

    getExecutablePath() {
        return getOpencodeCliInstaller().getOpencodePath();
    }

    async install(mainWindow) {
        return getOpencodeCliInstaller().install(mainWindow);
    }

    async ensureInstalled(mainWindow) {
        return getOpencodeCliInstaller().ensureInstalled(mainWindow);
    }

    // ========================================
    // Command Methods
    // ========================================

    getNewSessionCommand(turboMode = false) {
        // opencode (MVP) has no turbo/danger flag; turboMode is ignored.
        return this.getExecutableName();
    }

    getResumeSessionCommand(sessionId = null) {
        const executable = this.getExecutableName();
        // SST opencode resume is flag-based:
        //   specific session -> `opencode --session <id>`
        //   last session     -> `opencode --continue`
        if (sessionId) {
            return `${executable} --session ${sessionId}`;
        }
        return `${executable} --continue`;
    }

    getResumeFlag() {
        return '--continue';
    }

    // ========================================
    // Hooks Methods
    // ========================================

    getHooksManager(options = {}) {
        if (!this._hooksManager) {
            const OpencodeHooksManagerClass = getOpencodeHooksManager();
            this._hooksManager = new OpencodeHooksManagerClass(options);
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
        // No single bypass flag in opencode; permissions are config-driven.
        return false;
    }

    supportsSessionId() {
        return true;
    }

    /**
     * File-change tracking is implemented via the opencode plugin's
     * tool.execute.before/after hooks (see opencode-hooks-manager.js).
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
    // Detection Methods
    // ========================================

    getReadyPatterns() {
        // Signals that the opencode TUI is up, used to hide the loading overlay.
        return [
            'opencode',
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
        instance = new OpencodeCliStrategy();
    }
    return instance;
}

module.exports = {
    OpencodeCliStrategy,
    getInstance
};
