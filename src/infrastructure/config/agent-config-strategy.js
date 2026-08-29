/**
 * AgentConfigStrategy - Abstract base class for agent configuration management
 *
 * This implements the Strategy Pattern for managing instruction files (CLAUDE.md, GEMINI.md, etc.)
 * and related configuration for different AI agents.
 *
 * Each agent (Claude, Gemini, future agents) implements this interface to provide
 * consistent configuration management across the application.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { hasOwnedMcpRuntime } = require('./mcp-entry-ownership');

// Shared status contract for every static-template agent. Claude has its own
// generated, already-strong status section in claude-md-global-config.js; the
// remaining agents all pass through _filterStatusContent(), so keeping the
// decisive final-turn rule here prevents their templates from drifting apart.
const TERMINAL_STATUS_POLICY = [
    '- **Work-phase status** (colored badge): keep it up to date with `set_terminal_status(status)` at EVERY phase change.',
    '`needs_input` is ONLY for a real user answer or decision that you must receive before you can continue; never use it as a generic end-of-turn status, after finishing work, after a commit/push, or merely because you are yielding a final response.',
    'Always, before EVERY final response — including short read-only verification or follow-up turns — re-read the current `set_terminal_status` tool description and choose the most specific enabled status from that live, user-customizable catalog; the examples in this file are not exhaustive.',
    'In particular, if `pushed` exists and the code was committed and pushed, use `pushed` instead of `done`, `needs_testing`, or `needs_input`.',
    'Make `set_terminal_status` your final CodeAgentSwarm status action after commit/push and before the final response.',
    'The user can also set a status by hand from the UI; update it afterwards whenever the phase changes.',
].join(' ');

const PLAN_ACCURACY_HEADING = '### Plan accuracy before final responses';
const PLAN_ACCURACY_POLICY = [
    PLAN_ACCURACY_HEADING,
    '',
    'If you created or updated a plan, checklist, or todo list during the turn:',
    '',
    '- Reconcile it immediately before every final response.',
    '- Mark only genuinely finished items completed.',
    '- Never leave an item `in_progress` when the turn ends. Leave unfinished work pending and explain the blocker or next step.',
    '- Never claim the task is complete while any plan item remains pending or `in_progress`.',
    '- When all work is done, publish one final plan update with every item completed before the final response.',
    '',
    'Validation, commit, and push do not update the plan automatically.',
].join('\n');

// Block spliced into the instruction section when the agent's task-creation
// sub-toggle is off. The MCP server enforces the same rule by hiding the two
// creation tools; this copy also tells the agent to continue silently when no
// existing board task fits.
const TASK_CREATION_DISABLED_BLOCK = [
    '',
    '## 🚫 TASK CREATION IS DISABLED',
    '',
    'The user turned OFF task creation for this agent.',
    '',
    '- **NEVER** call `create_task` or `create_subtask`. They are not available to you.',
    '- The board is the user\'s. Only manage cards that are ALREADY on it.',
    '- Need a task? `list_tasks` or `search_tasks` to find the existing one, then',
    '  `start_task` on it. `update_task_*`, `submit_for_testing` and `complete_task`',
    '  still work for existing tasks.',
    '- Nothing on the board fits the request? Just do the work without task tracking.',
    '- Keep this setting invisible in normal replies. Mention it only when the user asks',
    '  about Kanban or task tracking.',
    ''
].join('\n');

class AgentConfigStrategy {
    constructor() {
        if (new.target === AgentConfigStrategy) {
            throw new Error('AgentConfigStrategy is abstract and cannot be instantiated directly');
        }
        this.homeDir = os.homedir();
    }

    // ==================== ABSTRACT METHODS (must be implemented) ====================

    /**
     * Get the agent's unique identifier
     * @returns {string} e.g., 'claude', 'gemini'
     */
    getAgentId() {
        throw new Error('Abstract method getAgentId() must be implemented');
    }

    /**
     * Get the agent's display name
     * @returns {string} e.g., 'Claude Code', 'Gemini CLI'
     */
    getDisplayName() {
        throw new Error('Abstract method getDisplayName() must be implemented');
    }

    /**
     * Get the path to the agent's brand icon (renderer-relative).
     * Used by the Privacy & Integrations panel to render an agent's identity
     * visually instead of plain text. New agents only need to override this
     * to participate in the inventory matrix.
     * @returns {string} e.g., '../../../assets/icons/claude-icon.svg'
     */
    getIconPath() {
        throw new Error('Abstract method getIconPath() must be implemented');
    }

    /**
     * Get the path to the agent's settings directory
     * @returns {string} e.g., '~/.claude', '~/.gemini'
     */
    getSettingsPath() {
        throw new Error('Abstract method getSettingsPath() must be implemented');
    }

    /**
     * Get the instruction file name
     * @returns {string} e.g., 'CLAUDE.md', 'GEMINI.md'
     */
    getInstructionsFileName() {
        throw new Error('Abstract method getInstructionsFileName() must be implemented');
    }

    /**
     * Get the start marker for CodeAgentSwarm section
     * @returns {string}
     */
    getSectionStartMarker() {
        throw new Error('Abstract method getSectionStartMarker() must be implemented');
    }

    /**
     * Get the end marker for CodeAgentSwarm section
     * @returns {string}
     */
    getSectionEndMarker() {
        throw new Error('Abstract method getSectionEndMarker() must be implemented');
    }

    /**
     * Get the path to the template file for this agent
     * @param {string} [variant='full'] - 'full' (tasks + titles) or 'titles-only'
     *   (terminal titles without the kanban task-management rules)
     * @returns {string}
     */
    getTemplatePath(variant = 'full') {
        throw new Error('Abstract method getTemplatePath() must be implemented');
    }

    /**
     * Check if MCP server configuration exists for this agent
     * @returns {boolean}
     */
    hasMcpServer() {
        throw new Error('Abstract method hasMcpServer() must be implemented');
    }

    /**
     * Add MCP server configuration for this agent
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async addMcpServer() {
        throw new Error('Abstract method addMcpServer() must be implemented');
    }

    /**
     * Remove MCP server configuration for this agent
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async removeMcpServer() {
        throw new Error('Abstract method removeMcpServer() must be implemented');
    }

    /**
     * Get the absolute path to the MCP config file for this agent
     * @returns {string}
     */
    getMcpConfigPath() {
        throw new Error('Abstract method getMcpConfigPath() must be implemented');
    }

    /** Only entries pointing at CAS's private MCP runtime belong to this app. */
    isCodeAgentSwarmMcpEntry(entry) {
        try {
            return hasOwnedMcpRuntime(entry);
        } catch (_) {
            return false;
        }
    }

    // ==================== CONCRETE METHODS (shared implementation) ====================

    /**
     * Get the full path to the global instructions file
     * @returns {string}
     */
    getGlobalInstructionsPath() {
        return path.join(this.getSettingsPath(), this.getInstructionsFileName());
    }

    /**
     * Check if the task system is enabled for this agent
     * @returns {boolean}
     */
    isTaskSystemEnabled() {
        try {
            const hasMdSection = this.hasInstructionSection();
            const hasMcp = this.hasMcpServer();
            return hasMdSection && hasMcp;
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error checking task system status:`, error);
            return false;
        }
    }

    /**
     * Check if the instructions file has the CodeAgentSwarm section
     * @returns {boolean}
     */
    hasInstructionSection() {
        try {
            const filePath = this.getGlobalInstructionsPath();
            if (!fs.existsSync(filePath)) {
                return false;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            return content.includes(this.getSectionStartMarker()) &&
                   content.includes(this.getSectionEndMarker());
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error checking instruction section:`, error);
            return false;
        }
    }

    /**
     * Load the template content for this agent
     * @param {string} [variant='full'] - which instruction variant to load
     * @param {object} [options={}] - section-level options (e.g. { includeStatus })
     * @returns {Promise<string|null>}
     */
    async loadTemplate(variant = 'full', options = {}) {
        try {
            if (variant === 'communication-only') {
                return this._sessionCommunicationOnlyTemplate();
            }
            const contentVariant = options.allowTaskCreation === false && variant === 'full'
                ? 'titles-only'
                : variant;
            const templatePath = this.getTemplatePath(contentVariant);
            if (!fs.existsSync(templatePath)) {
                console.error(`[${this.getAgentId()}] Template not found at: ${templatePath}`);
                return null;
            }
            const template = fs.readFileSync(templatePath, 'utf8');
            const filtered = this._filterStatusContent(template, options.includeStatus !== false);
            const withPlanPolicy = this._addPlanAccuracyPolicy(filtered);
            return this._applySessionCommunicationPolicy(this._applyTaskCreationGate(withPlanPolicy, variant, options), options.includeSessionCommunication === true);
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error loading template:`, error);
            return null;
        }
    }

    /**
     * Remove task-creation commands and splice the disabled block just before
     * the section end marker when the variant carries task rules.
     * Keeping it INSIDE the markers matters: everything outside them is user
     * content that the enable/disable rewrites must never touch.
     * @param {string|null} content
     * @param {string} variant - 'full' | 'titles-only' | 'tasks-only' | 'none'
     * @param {object} options - section-level options ({ allowTaskCreation })
     * @returns {string|null}
     */
    _applyTaskCreationGate(content, variant, options = {}) {
        if (typeof content !== 'string') return content;
        if (options.allowTaskCreation !== false) return content;
        // Variants without task rules already explain that task management is off.
        if (variant === 'titles-only' || variant === 'none') return content;

        let gated = content.replace(
            /^### .*Task Management Is Disabled.*\n[\s\S]*?(?=^### )/m,
            ''
        );
        gated = gated
            .replace(/^.*(?:automatic task management is disabled|do not create or manage tasks|never create or manage tasks).*\n?/gmi, '')
            .replace(/^\*\*Tasks\?\*\*\n?/gm, '');
        const creationStart = gated.search(/^### .*STOP BEFORE YOU EDIT\/WRITE ANY FILE.*$/m);
        if (creationStart !== -1) {
            const planStart = gated.indexOf(PLAN_ACCURACY_HEADING, creationStart);
            const endMarkerStart = gated.lastIndexOf(this.getSectionEndMarker());
            const creationEnd = planStart !== -1 ? planStart : endMarkerStart;
            if (creationEnd > creationStart) {
                gated = gated.slice(0, creationStart) + gated.slice(creationEnd);
            }
        }

        const endMarker = this.getSectionEndMarker();
        const endIdx = gated.lastIndexOf(endMarker);
        if (endIdx === -1) return gated + TASK_CREATION_DISABLED_BLOCK;

        return gated.slice(0, endIdx) + TASK_CREATION_DISABLED_BLOCK + gated.slice(endIdx);
    }

    /**
     * Strip the CAS:STATUS marker lines from a template — and, when the status
     * feature is disabled for the agent, the marked content too. Markers live
     * ONLY in the template files; generated instruction files never carry them.
     * @param {string} template
     * @param {boolean} includeStatus
     * @returns {string}
     */
    _filterStatusContent(template, includeStatus) {
        if (typeof template !== 'string' || !template.includes('CAS:STATUS:')) return template;
        const out = [];
        let inStatusBlock = false;
        for (const line of template.split('\n')) {
            if (line.includes('<!-- CAS:STATUS:START -->')) { inStatusBlock = true; continue; }
            if (line.includes('<!-- CAS:STATUS:END -->')) { inStatusBlock = false; continue; }
            if (!inStatusBlock || includeStatus) {
                // Every full/titles-only static template has exactly one product
                // status bullet. Replace that weak enumerated example with the
                // shared dynamic-catalog contract while leaving bootstrap/table
                // status blocks untouched. Claude does not use this method.
                if (includeStatus && line.includes('- **Work-phase status**')) {
                    out.push(TERMINAL_STATUS_POLICY);
                } else {
                    out.push(line);
                }
            }
        }
        return out.join('\n');
    }

    _addPlanAccuracyPolicy(template) {
        if (typeof template !== 'string' || template.includes(PLAN_ACCURACY_HEADING)) return template;
        const endMarker = this.getSectionEndMarker();
        if (!template.includes(endMarker)) return template;
        return template.replace(endMarker, `${PLAN_ACCURACY_POLICY}\n\n${endMarker}`);
    }

    _applySessionCommunicationPolicy(template, includeSessionCommunication) {
        if (typeof template !== 'string' || !includeSessionCommunication) return template;
        const heading = '### Session communication';
        if (template.includes(heading)) return template;
        const endMarker = this.getSectionEndMarker();
        if (!template.includes(endMarker)) return template;
        const policy = `${heading}\n\nUse session communication only when the user asks, or when the current work genuinely depends on one focused answer from another active session. Never call \`list_sessions\` after the current request is complete. It excludes finished, unused, and long-idle sessions; from its results, never contact a session whose status indicates done, pushed, completed, finished, or otherwise final. Use \`list_sessions\` to inspect the remaining sessions' goal, current activity, status, project, and agent, then \`send_session_message\` with \`message_type: "request"\` for one focused question. When an incoming session request arrives, answer only that question, send the answer to its supplied source id with \`message_type: "response"\` and its supplied \`reply_to_request_id\`, then continue the task you were already doing without creating or switching tasks or changing your goal. The sent response is shown inside the request card; do not add a separate confirmation or summary for that coordination turn. Treat an incoming response as context, not another request. Do not poll proactively, and never send transcripts.\n\n`;
        return template.replace(endMarker, `${policy}${endMarker}`);
    }

    _sessionCommunicationOnlyTemplate() {
        return this._applySessionCommunicationPolicy(
            `${this.getSectionStartMarker()}\n\n${this.getSectionEndMarker()}`,
            true
        );
    }

    _addTerminalStatusPolicy(template) {
        if (typeof template !== 'string' || template.includes('set_terminal_status')) return template;
        const endMarker = this.getSectionEndMarker();
        if (!template.includes(endMarker)) return template;
        return template.replace(
            endMarker,
            `### Work-phase status\n\n${TERMINAL_STATUS_POLICY}\n\n${endMarker}`
        );
    }

    /**
     * Enable the task system for this agent
     * @param {string} [variant='full'] - which instruction variant to write
     * @param {object} [options={}] - section-level options (e.g. { includeStatus })
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async enableTaskSystem(variant = 'full', options = {}) {
        try {
            console.log(`[${this.getAgentId()}] Enabling task system...`);

            // Add instruction section
            const mdResult = await this.addInstructionSection(variant, options);
            if (!mdResult.success) {
                return mdResult;
            }

            // Add MCP server
            const mcpResult = await this.addMcpServer();
            if (!mcpResult.success) {
                return mcpResult;
            }

            return {
                success: true,
                message: `Task system enabled for ${this.getDisplayName()}`
            };
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error enabling task system:`, error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Disable the task system for this agent
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async disableTaskSystem() {
        try {
            console.log(`[${this.getAgentId()}] Disabling task system...`);

            // Remove MCP first: malformed config must fail before instructions
            // disappear while the persisted level still truthfully remains On.
            const mcpResult = await this.removeMcpServer();
            if (!mcpResult.success) {
                return mcpResult;
            }

            const mdResult = await this.removeInstructionSection();
            if (!mdResult.success) {
                // Keep the previously persisted On state operational when the
                // second half of cleanup fails.
                await this.addMcpServer();
                return mdResult;
            }

            return {
                success: true,
                message: `Task system disabled for ${this.getDisplayName()}`
            };
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error disabling task system:`, error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Add the CodeAgentSwarm section to the instructions file
     * @param {string} [variant='full'] - which instruction variant to write
     * @param {object} [options={}] - section-level options (e.g. { includeStatus })
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async addInstructionSection(variant = 'full', options = {}) {
        try {
            const template = await this.loadTemplate(variant, options);
            if (!template) {
                return { success: false, message: 'Could not load template' };
            }

            const filePath = this.getGlobalInstructionsPath();
            const dirPath = path.dirname(filePath);

            // Ensure directory exists
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            let content = '';
            if (fs.existsSync(filePath)) {
                content = fs.readFileSync(filePath, 'utf8');

                // If section already exists, don't add again
                if (content.includes(this.getSectionStartMarker())) {
                    return { success: true, message: 'Section already exists' };
                }
            } else {
                // Create new file with header
                content = this.getNewFileHeader();
            }

            // Add the section at the end
            content = content.trimEnd() + '\n\n' + template + '\n';
            fs.writeFileSync(filePath, content, 'utf8');

            return { success: true, message: 'Section added successfully' };
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error adding instruction section:`, error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove the CodeAgentSwarm section from the instructions file
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async removeInstructionSection() {
        try {
            const filePath = this.getGlobalInstructionsPath();

            if (!fs.existsSync(filePath)) {
                return { success: true, message: 'Instructions file does not exist' };
            }

            let content = fs.readFileSync(filePath, 'utf8');

            // Find and remove the section using regex with markers
            const startMarker = this._escapeRegex(this.getSectionStartMarker());
            const endMarker = this._escapeRegex(this.getSectionEndMarker());
            const regex = new RegExp(
                `\\n*${startMarker}[\\s\\S]*?${endMarker}\\n*`,
                'g'
            );

            const newContent = content.replace(regex, '\n\n');

            if (newContent === content) {
                return { success: true, message: 'Section not found (already removed)' };
            }

            const leftover = newContent.trim();
            if (!leftover || this._isInstructionScaffold(leftover)) {
                // Privacy Off must not leave a CAS-only prompt behind. If we
                // created this file, delete it so Grok's rules look like they
                // did before integration.
                fs.rmSync(filePath, { force: true });
                return { success: true, message: 'Section removed successfully' };
            }

            fs.writeFileSync(filePath, leftover + '\n', 'utf8');
            return { success: true, message: 'Section removed successfully' };
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error removing instruction section:`, error);
            return { success: false, message: error.message };
        }
    }

    /**
     * Update the CodeAgentSwarm section if content has changed
     * @param {string} [variant='full'] - which instruction variant to write
     * @param {object} [options={}] - section-level options (e.g. { includeStatus })
     * @returns {Promise<{success: boolean, updated: boolean, message: string}>}
     */
    async updateInstructionSection(variant = 'full', options = {}) {
        try {
            const template = await this.loadTemplate(variant, options);
            if (!template) {
                return { success: false, updated: false, message: 'Could not load template' };
            }

            const filePath = this.getGlobalInstructionsPath();

            if (!fs.existsSync(filePath)) {
                // File doesn't exist, add the section
                const result = await this.addInstructionSection(variant, options);
                return { ...result, updated: result.success };
            }

            let content = fs.readFileSync(filePath, 'utf8');

            if (!content.includes(this.getSectionStartMarker())) {
                // Section doesn't exist, add it
                const result = await this.addInstructionSection(variant, options);
                return { ...result, updated: result.success };
            }

            // Extract current section
            const startIdx = content.indexOf(this.getSectionStartMarker());
            const endIdx = content.indexOf(this.getSectionEndMarker());

            if (endIdx === -1) {
                // Malformed section, re-add
                const result = await this.addInstructionSection(variant, options);
                return { ...result, updated: result.success };
            }

            const currentSection = content.substring(
                startIdx,
                endIdx + this.getSectionEndMarker().length
            );

            // Compare with template
            if (currentSection.trim() === template.trim()) {
                return { success: true, updated: false, message: 'Section is up to date' };
            }

            // Update the section
            content = content.substring(0, startIdx) +
                      template +
                      content.substring(endIdx + this.getSectionEndMarker().length);

            fs.writeFileSync(filePath, content, 'utf8');
            return { success: true, updated: true, message: 'Section updated' };
        } catch (error) {
            console.error(`[${this.getAgentId()}] Error updating instruction section:`, error);
            return { success: false, updated: false, message: error.message };
        }
    }

    /**
     * Get the header for a new instructions file
     * @returns {string}
     */
    getNewFileHeader() {
        return `# ${this.getDisplayName()} Global Configuration

This file contains global instructions for all ${this.getDisplayName()} sessions across all projects.

`;
    }

    /**
     * True when leftover instruction text is only the header CAS writes for a
     * brand-new file. Used so Privacy Off can delete a file we created instead
     * of leaving an empty global prompt.
     * @param {string} content
     * @returns {boolean}
     */
    _isInstructionScaffold(content) {
        const trimmed = typeof content === 'string' ? content.trim() : '';
        if (!trimmed) return true;
        const name = this._escapeRegex(this.getDisplayName());
        return new RegExp(
            `^# ${name} Global Configuration\\s+This file contains global instructions for all ${name} sessions across all projects\\.?$`
        ).test(trimmed);
    }

    /**
     * Escape special regex characters in a string
     * @param {string} string
     * @returns {string}
     */
    _escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

module.exports = AgentConfigStrategy;
module.exports.TASK_CREATION_DISABLED_BLOCK = TASK_CREATION_DISABLED_BLOCK;
