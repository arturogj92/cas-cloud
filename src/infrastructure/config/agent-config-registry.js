/**
 * AgentConfigRegistry - Registry for managing all agent configuration strategies
 *
 * This class provides a central point to:
 * - Register agent config strategies (Claude, Codex, future agents)
 * - Enable/disable task system for ALL agents at once
 * - Query task system status across agents
 * - Update instruction files for all registered agents
 */

const ClaudeConfigStrategy = require('./claude-config-strategy');
const CodexConfigStrategy = require('./codex-config-strategy');
const AntigravityConfigStrategy = require('./antigravity-config-strategy');
const OpencodeConfigStrategy = require('./opencode-config-strategy');
const KimiConfigStrategy = require('./kimi-config-strategy');
const GrokConfigStrategy = require('./grok-config-strategy');
const CursorConfigStrategy = require('./cursor-config-strategy');

class AgentConfigRegistry {
    constructor({ isDevMode = false } = {}) {
        this.agents = new Map();
        this.defaultAgent = 'claude';

        // Auto-register known agents
        this._registerDefaultAgents({ isDevMode });
    }

    /**
     * Register default agents (Claude, Codex, Antigravity, opencode)
     * @private
     */
    _registerDefaultAgents({ isDevMode = false } = {}) {
        this.register('claude', new ClaudeConfigStrategy());
        this.register('codex', new CodexConfigStrategy());
        this.register('antigravity', new AntigravityConfigStrategy({ isDevMode }));
        this.register('opencode', new OpencodeConfigStrategy());
        this.register('kimi', new KimiConfigStrategy());
        this.register('grok', new GrokConfigStrategy());
        this.register('cursor', new CursorConfigStrategy());
    }

    /**
     * Register an agent config strategy
     * @param {string} id - Agent identifier (e.g., 'claude', 'codex')
     * @param {AgentConfigStrategy} strategy - The config strategy instance
     */
    register(id, strategy) {
        this.agents.set(id, strategy);
        console.log(`[AgentConfigRegistry] Registered agent: ${id}`);
    }

    /**
     * Get an agent config strategy by ID
     * @param {string} id - Agent identifier
     * @returns {AgentConfigStrategy|null}
     */
    get(id) {
        return this.agents.get(id) || null;
    }

    /**
     * Get the default agent config strategy
     * @returns {AgentConfigStrategy}
     */
    getDefault() {
        return this.agents.get(this.defaultAgent);
    }

    /**
     * Get all registered agent strategies
     * @returns {Array<AgentConfigStrategy>}
     */
    getAll() {
        return Array.from(this.agents.values());
    }

    /**
     * Get all registered agent IDs
     * @returns {Array<string>}
     */
    getAllIds() {
        return Array.from(this.agents.keys());
    }

    /**
     * Check if task system is enabled for a specific agent
     * @param {string} agentId - Agent identifier
     * @returns {boolean}
     */
    isTaskSystemEnabledFor(agentId) {
        const agent = this.get(agentId);
        if (!agent) {
            console.warn(`[AgentConfigRegistry] Unknown agent: ${agentId}`);
            return false;
        }
        return agent.isTaskSystemEnabled();
    }

    /**
     * Check if task system is enabled for ANY agent
     * @returns {boolean}
     */
    isTaskSystemEnabledForAny() {
        for (const agent of this.agents.values()) {
            if (agent.isTaskSystemEnabled()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if task system is enabled for ALL agents
     * @returns {boolean}
     */
    isTaskSystemEnabledForAll() {
        for (const agent of this.agents.values()) {
            if (!agent.isTaskSystemEnabled()) {
                return false;
            }
        }
        return true;
    }

    /**
     * Enable task system for a specific agent
     * @param {string} agentId - Agent identifier
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async enableTaskSystemFor(agentId, variant = 'full', options = {}) {
        const agent = this.get(agentId);
        if (!agent) {
            return { success: false, message: `Unknown agent: ${agentId}` };
        }
        return agent.enableTaskSystem(variant, options);
    }

    /**
     * Disable task system for a specific agent
     * @param {string} agentId - Agent identifier
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async disableTaskSystemFor(agentId) {
        const agent = this.get(agentId);
        if (!agent) {
            return { success: false, message: `Unknown agent: ${agentId}` };
        }
        return agent.disableTaskSystem();
    }

    /**
     * Enable task system for ALL registered agents
     * @returns {Promise<{success: boolean, results: Object, message: string}>}
     */
    async enableTaskSystemForAll(variant = 'full') {
        const results = {};
        let allSuccess = true;

        for (const [id, agent] of this.agents) {
            console.log(`[AgentConfigRegistry] Enabling task system for ${id}...`);
            const result = await agent.enableTaskSystem(variant);
            results[id] = result;
            if (!result.success) {
                allSuccess = false;
            }
        }

        return {
            success: allSuccess,
            results,
            message: allSuccess
                ? 'Task system enabled for all agents'
                : 'Some agents failed to enable task system'
        };
    }

    /**
     * Disable task system for ALL registered agents
     * @returns {Promise<{success: boolean, results: Object, message: string}>}
     */
    async disableTaskSystemForAll() {
        const results = {};
        let allSuccess = true;

        for (const [id, agent] of this.agents) {
            console.log(`[AgentConfigRegistry] Disabling task system for ${id}...`);
            const result = await agent.disableTaskSystem();
            results[id] = result;
            if (!result.success) {
                allSuccess = false;
            }
        }

        return {
            success: allSuccess,
            results,
            message: allSuccess
                ? 'Task system disabled for all agents'
                : 'Some agents failed to disable task system'
        };
    }

    /**
     * Update instruction files for ALL registered agents
     * Only updates agents that have task system enabled
     * @returns {Promise<{success: boolean, results: Object}>}
     */
    async updateAllInstructionFiles(variant = 'full') {
        const results = {};
        let allSuccess = true;

        for (const [id, agent] of this.agents) {
            // Only update if task system is enabled for this agent
            if (agent.isTaskSystemEnabled()) {
                console.log(`[AgentConfigRegistry] Updating instruction file for ${id}...`);
                const result = await agent.updateInstructionSection(variant);
                results[id] = result;
                if (!result.success) {
                    allSuccess = false;
                }
            } else {
                results[id] = { success: true, updated: false, message: 'Task system disabled, skipped' };
            }
        }

        return { success: allSuccess, results };
    }

    /**
     * Ensure instruction files exist for agents whose task system is enabled.
     * This is called during app startup — it MUST respect per-agent intent so a
     * user who disabled one agent in the Privacy panel does not get it silently
     * re-injected on the next launch.
     *
     * @param {boolean|function(string):boolean} enabledArg
     *   - boolean: legacy form — applies the same decision to every agent.
     *   - predicate (agentId)=>boolean: per-agent form — only injects agents the
     *     predicate returns true for. This is the form the boot path uses so each
     *     agent's persisted toggle is honored independently.
     * @param {string|function(string):string} [variantArg='full'] - which
     *   instruction variant to write. May be a string applied to every agent, or
     *   a per-agent resolver (agentId)=>variant. A resolved variant of 'none'
     *   removes the instruction section instead of writing one.
     * @param {object|function(string):object} [optionsArg=undefined] - section-level
     *   options (e.g. { includeStatus }). May be a plain object applied to every
     *   agent, or a per-agent resolver (agentId)=>options.
     * @returns {Promise<{success: boolean, results: Object}>}
     */
    async ensureAllInstructionFiles(enabledArg, variantArg = 'full', optionsArg = undefined) {
        const isEnabled = typeof enabledArg === 'function'
            ? enabledArg
            : () => !!enabledArg;
        const resolveVariant = typeof variantArg === 'function'
            ? variantArg
            : () => variantArg;
        const resolveOptions = typeof optionsArg === 'function'
            ? optionsArg
            : () => (optionsArg || {});

        const results = {};
        let allSuccess = true;

        for (const [id, agent] of this.agents) {
            if (!isEnabled(id)) {
                console.log(`[AgentConfigRegistry] Task system disabled for ${id}, removing any legacy instruction section...`);
                const removal = await agent.removeInstructionSection();
                results[id] = {
                    ...removal,
                    updated: removal.success && !/not found|does not exist/i.test(removal.message || '')
                };
                if (!removal.success) allSuccess = false;
                continue;
            }
            const variant = resolveVariant(id);
            const options = resolveOptions(id);
            let result;
            if (variant === 'none') {
                // No section for this agent's current toggles — remove any existing one.
                console.log(`[AgentConfigRegistry] Variant 'none' for ${id}, removing instruction section...`);
                const removal = await agent.removeInstructionSection();
                result = {
                    ...removal,
                    // Treat an actual removal as an update; a "not found" removal is a no-op.
                    updated: removal.success && !/not found|does not exist/i.test(removal.message || '')
                };
            } else {
                console.log(`[AgentConfigRegistry] Ensuring instruction file for ${id}...`);
                result = await agent.updateInstructionSection(variant, options);
            }
            results[id] = result;
            if (!result.success) {
                allSuccess = false;
                console.error(`[AgentConfigRegistry] Failed to ensure instruction file for ${id}:`, result.message);
            } else if (result.updated) {
                console.log(`[AgentConfigRegistry] ✅ ${id} instruction file updated`);
            } else {
                console.log(`[AgentConfigRegistry] ✓ ${id} instruction file is up to date`);
            }
        }

        return { success: allSuccess, results };
    }

    /**
     * Apply a specific instruction variant to a single agent. A variant of 'none'
     * removes the section entirely; otherwise the section is written/updated.
     * @param {string} agentId
     * @param {string} variant - 'full' | 'titles-only' | 'tasks-only' | 'none'
     * @param {object} [options={}] - section-level options (e.g. { includeStatus })
     * @returns {Promise<{success: boolean, message?: string, updated?: boolean}>}
     */
    async applyInstructionVariantFor(agentId, variant, options = {}) {
        const agent = this.get(agentId);
        if (!agent) {
            return { success: false, message: `Unknown agent: ${agentId}` };
        }
        if (variant === 'none') {
            return agent.removeInstructionSection();
        }
        return agent.updateInstructionSection(variant, options);
    }

    /**
     * Add an instruction section for one agent without replacing an existing
     * CAS-owned variant. Headless setup uses this so a titles-only bootstrap
     * never downgrades Desktop's full task-management instructions.
     * @param {string} agentId
     * @param {string} [variant='full']
     * @param {object} [options={}]
     * @returns {Promise<{success: boolean, message?: string}>}
     */
    async enableInstructionsFor(agentId, variant = 'full', options = {}) {
        const agent = this.get(agentId);
        if (!agent) {
            return { success: false, message: `Unknown agent: ${agentId}` };
        }
        return agent.addInstructionSection(variant, options);
    }

    /**
     * Add the MCP server entry for a single agent (does NOT touch its instruction file).
     * @param {string} agentId
     * @returns {Promise<{success: boolean, message?: string}>}
     */
    async enableMcpFor(agentId) {
        const agent = this.get(agentId);
        if (!agent) {
            return { success: false, message: `Unknown agent: ${agentId}` };
        }
        return agent.addMcpServer();
    }

    /**
     * Remove the MCP server entry for a single agent (does NOT touch its instruction file).
     * @param {string} agentId
     * @returns {Promise<{success: boolean, message?: string}>}
     */
    async disableMcpFor(agentId) {
        const agent = this.get(agentId);
        if (!agent) {
            return { success: false, message: `Unknown agent: ${agentId}` };
        }
        return agent.removeMcpServer();
    }

    /**
     * Enable instruction sections for ALL agents (does NOT touch MCP entries).
     * Use when the user wants tasks/title rules but no auto-loaded MCP tools.
     * @param {string} [variant='full'] - which instruction variant to write
     * @returns {Promise<{success: boolean, results: Object, message: string}>}
     */
    async enableInstructionsForAll(variant = 'full') {
        return this._applyToAll('addInstructionSection', 'Instruction sections enabled for all agents', [variant]);
    }

    /**
     * Remove instruction sections for ALL agents (does NOT touch MCP entries).
     * Use when the user wants the MCP tools available but no auto-injected rules.
     * @returns {Promise<{success: boolean, results: Object, message: string}>}
     */
    async disableInstructionsForAll() {
        return this._applyToAll('removeInstructionSection', 'Instruction sections disabled for all agents');
    }

    /**
     * Add MCP server entries for ALL agents (does NOT touch instruction files).
     * @returns {Promise<{success: boolean, results: Object, message: string}>}
     */
    async enableMcpForAll() {
        return this._applyToAll('addMcpServer', 'MCP server enabled for all agents');
    }

    /**
     * Remove MCP server entries for ALL agents (does NOT touch instruction files).
     * Note: instruction sections become useless without MCP tools — caller should
     * also disable instructions for a coherent state.
     * @returns {Promise<{success: boolean, results: Object, message: string}>}
     */
    async disableMcpForAll() {
        return this._applyToAll('removeMcpServer', 'MCP server disabled for all agents');
    }

    /**
     * Inventory of every CAS modification surface across registered agents.
     * Used by the Privacy & Integrations panel to render live status.
     * @returns {{agents: Object<string, {instructions: {path: string, active: boolean}, mcp: {path: string, active: boolean}}>}}
     */
    getModificationsStatus() {
        const agents = {};
        for (const [id, agent] of this.agents) {
            agents[id] = {
                displayName: agent.getDisplayName(),
                iconPath: agent.getIconPath(),
                instructions: {
                    path: agent.getGlobalInstructionsPath(),
                    active: agent.hasInstructionSection()
                },
                mcp: {
                    path: agent.getMcpConfigPath(),
                    active: agent.hasMcpServer()
                }
            };
        }
        return { agents };
    }

    /**
     * Internal helper: invoke the same method on every registered agent and
     * aggregate results. Used by the granular *ForAll methods above.
     * @private
     */
    async _applyToAll(methodName, successMessage, args = []) {
        const results = {};
        let allSuccess = true;

        for (const [id, agent] of this.agents) {
            const result = await agent[methodName](...args);
            results[id] = result;
            if (!result.success) {
                allSuccess = false;
            }
        }

        return {
            success: allSuccess,
            results,
            message: allSuccess ? successMessage : `Some agents failed: ${methodName}`
        };
    }

    /**
     * Get status summary for all agents
     * @returns {Object} Map of agent ID to status info
     */
    getStatusSummary() {
        const summary = {};

        for (const [id, agent] of this.agents) {
            summary[id] = {
                displayName: agent.getDisplayName(),
                instructionsFile: agent.getInstructionsFileName(),
                settingsPath: agent.getSettingsPath(),
                taskSystemEnabled: agent.isTaskSystemEnabled(),
                hasInstructionSection: agent.hasInstructionSection(),
                hasMcpServer: agent.hasMcpServer()
            };
        }

        return summary;
    }
}

// Export singleton instance
let instance = null;

function getAgentConfigRegistry(options) {
    if (!instance) {
        instance = new AgentConfigRegistry(options);
    }
    return instance;
}

module.exports = {
    AgentConfigRegistry,
    getAgentConfigRegistry
};
