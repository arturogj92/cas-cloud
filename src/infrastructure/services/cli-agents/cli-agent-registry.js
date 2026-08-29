/**
 * CLI Agent Registry
 *
 * Singleton registry that manages all available CLI agents.
 * Provides factory methods to get agent strategies by name.
 */
class CliAgentRegistry {
    constructor() {
        /**
         * Map of agent name to strategy instance
         * @type {Map<string, CliAgentStrategy>}
         */
        this.agents = new Map();

        /**
         * Name of the default agent
         * @type {string}
         */
        this.defaultAgent = 'claude';
    }

    /**
     * Register a new CLI agent strategy
     * @param {string} name - Unique identifier for the agent
     * @param {CliAgentStrategy} strategy - Strategy instance
     */
    register(name, strategy) {
        if (!name || typeof name !== 'string') {
            throw new Error('Agent name must be a non-empty string');
        }
        if (!strategy) {
            throw new Error('Strategy instance is required');
        }
        this.agents.set(name, strategy);
        console.log(`[CliAgentRegistry] Registered agent: ${name}`);
    }

    /**
     * Unregister a CLI agent
     * @param {string} name - Agent name to remove
     * @returns {boolean} True if agent was removed
     */
    unregister(name) {
        const existed = this.agents.has(name);
        this.agents.delete(name);
        if (existed) {
            console.log(`[CliAgentRegistry] Unregistered agent: ${name}`);
        }
        return existed;
    }

    /**
     * Get a CLI agent strategy by name
     * @param {string} name - Agent name
     * @returns {CliAgentStrategy|null} Strategy instance or default if not found
     */
    get(name) {
        if (this.agents.has(name)) {
            return this.agents.get(name);
        }
        console.warn(`[CliAgentRegistry] Agent '${name}' not found, returning default`);
        return this.getDefault();
    }

    /**
     * Check if an agent is registered
     * @param {string} name - Agent name
     * @returns {boolean}
     */
    has(name) {
        return this.agents.has(name);
    }

    /**
     * Get all registered agent strategies
     * @returns {CliAgentStrategy[]}
     */
    getAll() {
        return Array.from(this.agents.values());
    }

    /**
     * Get all registered agent names
     * @returns {string[]}
     */
    getNames() {
        return Array.from(this.agents.keys());
    }

    /**
     * Get the default agent strategy
     * @returns {CliAgentStrategy|null}
     */
    getDefault() {
        return this.agents.get(this.defaultAgent) || null;
    }

    /**
     * Set the default agent
     * @param {string} name - Agent name to set as default
     */
    setDefault(name) {
        if (!this.agents.has(name)) {
            throw new Error(`Cannot set default to unregistered agent: ${name}`);
        }
        this.defaultAgent = name;
        console.log(`[CliAgentRegistry] Default agent set to: ${name}`);
    }

    /**
     * Get all available agents with their metadata
     * @returns {Array<{name: string, displayName: string, icon: string, installed: boolean}>}
     */
    getAvailableAgents() {
        return this.getAgentMetadata().map(agent => ({
            ...agent,
            installed: this.get(agent.name).isInstalled()
        }));
    }

    /** Metadata safe for startup/UI reads: deliberately performs no installation probes. */
    getAgentMetadata() {
        return this.getAll().map(agent => ({
            name: agent.getName(),
            displayName: agent.getDisplayName(),
            icon: agent.getIcon(),
            supportsResume: agent.supportsResume(),
            supportsTurboMode: agent.supportsTurboMode()
        }));
    }

    /**
     * Get only installed agents
     * @returns {CliAgentStrategy[]}
     */
    getInstalledAgents() {
        return this.getAll().filter(agent => agent.isInstalled());
    }

    /**
     * Install all registered agents
     * @param {BrowserWindow} mainWindow - Electron main window for dialogs
     * @returns {Promise<Object>} Results for each agent
     */
    async installAllAgents(mainWindow) {
        const results = {};
        for (const [name, agent] of this.agents) {
            try {
                results[name] = await agent.ensureInstalled(mainWindow);
            } catch (error) {
                console.error(`[CliAgentRegistry] Failed to install ${name}:`, error);
                results[name] = false;
            }
        }
        return results;
    }

    /**
     * Initialize hooks for all registered agents
     * @param {Object} options - Options to pass to hooks managers
     * @returns {Promise<Object>} Hooks managers by agent name
     */
    async initializeAllHooks(options = {}) {
        const hooksManagers = {};
        for (const [name, agent] of this.agents) {
            try {
                const manager = agent.getHooksManager(options);
                await manager.installHooks();
                hooksManagers[name] = manager;
                console.log(`[CliAgentRegistry] Initialized hooks for: ${name}`);
            } catch (error) {
                console.error(`[CliAgentRegistry] Failed to initialize hooks for ${name}:`, error);
                hooksManagers[name] = null;
            }
        }
        return hooksManagers;
    }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton registry instance
 * @returns {CliAgentRegistry}
 */
function getRegistry() {
    if (!instance) {
        instance = new CliAgentRegistry();
    }
    return instance;
}

/**
 * Reset the singleton instance (mainly for testing)
 */
function resetRegistry() {
    instance = null;
}

module.exports = {
    CliAgentRegistry,
    getRegistry,
    resetRegistry
};
