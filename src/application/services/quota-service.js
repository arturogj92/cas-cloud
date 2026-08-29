/**
 * QuotaService
 *
 * Aggregates quota snapshots from every registered CLI agent strategy that
 * declares `supportsQuota()`. A source that is slow, down, or throwing must
 * never break the others, so each read runs through Promise.allSettled and the
 * last-good snapshot per agent is cached (keyed by agent). The navbar reads the
 * cache; the main-process poller drives refresh().
 *
 * No app-DB / native-module dependency: the readers behind the strategies read
 * files / HTTP only.
 */
const { getRegistry } = require('../../infrastructure/services/cli-agents/cli-agent-registry');

// Focus/resume already refresh immediately; this interval is only the visible-window fallback.
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const STRATEGY_TIMEOUT_MS = 10 * 1000;

function readWithTimeout(strategy, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Quota strategy timed out')), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([
        Promise.resolve().then(() => typeof strategy.getQuotas === 'function'
            ? strategy.getQuotas()
            : strategy.getQuota()),
        timeout
    ]).finally(() => clearTimeout(timer));
}

class QuotaService {
    constructor({ strategyTimeoutMs = STRATEGY_TIMEOUT_MS } = {}) {
        // Map<agent:accountId, QuotaSnapshot> — the last successful snapshot per account.
        this._cache = new Map();
        this._strategyTimeoutMs = strategyTimeoutMs;
        this._updatedListeners = [];
    }

    /**
     * Called after the cache changes so the navbar can paint immediately.
     * @param {(snapshots: Array<object>) => void} listener
     */
    onUpdated(listener) {
        if (typeof listener === 'function') this._updatedListeners.push(listener);
    }

    _notifyUpdated() {
        const snapshots = this.getCached();
        for (const listener of this._updatedListeners) {
            try {
                listener(snapshots);
            } catch (_err) {
                // A broken renderer publish must not break the next provider.
            }
        }
    }

    /**
     * Park a live snapshot (Chat / `/status` API) without waiting for the next
     * poll. A snapshot older than what we already have for that agent is ignored,
     * so a later file read cannot roll the ring back to a stale weekly %.
     * @param {object|null} snapshot
     * @returns {object|null} the cached snapshot for that agent after the apply
     */
    applySnapshot(snapshot) {
        if (!snapshot || !snapshot.agent) return null;
        const key = `${snapshot.agent}:${snapshot.accountId || 'current'}`;
        const previous = this._cache.get(key);
        const incomingAt = typeof snapshot.fetchedAt === 'number' ? snapshot.fetchedAt : 0;
        const previousAt = previous && typeof previous.fetchedAt === 'number' ? previous.fetchedAt : 0;
        if (previous && incomingAt < previousAt) return previous;
        this._cache.set(key, { ...snapshot, accountId: snapshot.accountId || 'current' });
        this._notifyUpdated();
        return snapshot;
    }

    /**
     * Refresh quota from all quota-capable strategies.
     * Keeps fulfilled non-null snapshots; a rejected/throwing read is skipped.
     * @returns {Promise<Array<object>>} the cached snapshots after refresh.
     */
    async refresh() {
        let strategies = [];
        try {
            strategies = getRegistry().getAll().filter((strategy) => {
                try {
                    return strategy.supportsQuota();
                } catch (_err) {
                    return false;
                }
            });
        } catch (_err) {
            // Registry unavailable — keep whatever we have cached.
            return this.getCached();
        }

        const results = await Promise.allSettled(
            strategies.map((strategy) => readWithTimeout(strategy, this._strategyTimeoutMs))
        );

        for (const result of results) {
            const snapshots = result.status === 'fulfilled'
                ? (Array.isArray(result.value) ? result.value : [result.value])
                : [];
            for (const snapshot of snapshots) {
                if (!snapshot || !snapshot.agent) continue;
                const key = `${snapshot.agent}:${snapshot.accountId || 'current'}`;
                const previous = this._cache.get(key);
                const incomingAt = typeof snapshot.fetchedAt === 'number' ? snapshot.fetchedAt : 0;
                const previousAt = previous && typeof previous.fetchedAt === 'number' ? previous.fetchedAt : 0;
                // Live Chat / `/status` snapshots are newer than a leftover
                // rollout line. Never roll the ring backwards on a poll.
                if (previous && incomingAt < previousAt) continue;
                this._cache.set(key, { ...snapshot, accountId: snapshot.accountId || 'current' });
            }
            // Rejected reads or null values keep the previous last-good snapshot.
        }

        return this.getCached();
    }

    /**
     * Forget the cached snapshot for one agent.
     *
     * The last-good cache exists so a flaky source doesn't blank the ring, but
     * that guarantee turns into a lie when the underlying ACCOUNT changes: the
     * snapshot then describes someone else's usage. Callers that detect such a
     * change (see ClaudeAccountWatcher) drop the entry first, so the worst case
     * is an empty ring for one refresh instead of confidently wrong numbers.
     * @param {string} agent - e.g. 'claude'
     */
    invalidate(agent, accountId) {
        if (!agent) return;
        if (accountId) this._cache.delete(`${agent}:${accountId}`);
        else for (const key of this._cache.keys()) if (key.startsWith(`${agent}:`)) this._cache.delete(key);
    }

    /**
     * @returns {Array<object>} the cached snapshots (array of QuotaSnapshot).
     */
    getCached() {
        return Array.from(this._cache.values());
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new QuotaService();
    }
    return instance;
}

module.exports = {
    QuotaService,
    getInstance,
    POLL_INTERVAL_MS,
    STRATEGY_TIMEOUT_MS
};
