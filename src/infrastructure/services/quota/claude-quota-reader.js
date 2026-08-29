/**
 * ClaudeQuotaReader
 *
 * Reads Claude Code usage quota from the cache written by our statusLine hook
 * (`~/.codeagentswarm/quota/claude.json`). Claude Code feeds a status JSON to
 * its statusLine command on stdin; that JSON carries `rate_limits.five_hour`
 * and `rate_limits.seven_day` (Pro/Max only, after the first API response).
 * Our hook script snapshots the `rate_limits` object to disk, and this reader
 * maps it into a QuotaSnapshot. No credentials needed — pure file reads.
 *
 * This module has NO app-DB / native-module dependency: it reads a file and
 * maps it into a QuotaSnapshot. Every entry point degrades to null and never
 * throws.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');

/**
 * @returns {string} the default cache path (~/.codeagentswarm/quota/claude.json).
 */
function getDefaultCachePath() {
    return path.join(os.homedir(), '.codeagentswarm', 'quota', 'claude.json');
}

/**
 * Map a single rate_limits bucket into a QuotaSnapshot window, or null.
 * @param {object|null} bucket - { used_percentage, resets_at }
 * @param {string} key - '5h' | 'weekly'
 * @param {string} label - human-readable window label
 * @returns {object|null}
 */
function bucketToWindow(bucket, key, label) {
    if (!bucket || typeof bucket !== 'object') return null;
    if (typeof bucket.used_percentage !== 'number') return null;
    const resetsAt = typeof bucket.resets_at === 'number'
        ? bucket.resets_at * 1000
        : null;
    return makeWindow({
        key,
        label,
        remainingFraction: 1 - bucket.used_percentage / 100,
        resetsAt
    });
}

class ClaudeQuotaReader {
    /**
     * @param {object} [options]
     * @param {string} [options.cachePath] - override the cache file path (for tests).
     */
    constructor(options = {}) {
        this.cachePath = options.cachePath || getDefaultCachePath();
        this.cacheDir = options.cacheDir || path.dirname(this.cachePath);
    }

    /**
     * Read the current Claude quota from the statusLine cache, or null. Never throws.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null if unavailable.
     */
    async getQuota() {
        return this._read(this.cachePath);
    }

    async getQuotas() {
        try {
            return fs.readdirSync(this.cacheDir)
                .filter((name) => /^claude(?:-[A-Za-z0-9._-]+)?\.json$/.test(name))
                .map((name) => this._read(path.join(this.cacheDir, name)))
                .filter(Boolean);
        } catch (_err) {
            return [];
        }
    }

    _read(cachePath) {
        try {
            if (!fs.existsSync(cachePath)) return null;

            let parsed;
            try {
                parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            } catch (_err) {
                return null; // garbage cache — degrade gracefully
            }

            const rateLimits = parsed && typeof parsed === 'object'
                ? parsed.rate_limits
                : null;
            if (!rateLimits || typeof rateLimits !== 'object') return null;

            const windows = [];
            const fiveHour = bucketToWindow(rateLimits.five_hour, '5h', '5-hour window');
            if (fiveHour) windows.push(fiveHour);
            const weekly = bucketToWindow(rateLimits.seven_day, 'weekly', 'Weekly');
            if (weekly) windows.push(weekly);
            if (windows.length === 0) return null;

            const fetchedAt = typeof parsed.fetchedAt === 'number'
                ? parsed.fetchedAt
                : Date.now();

            return {
                ...makeSnapshot({
                    agent: 'claude',
                    provider: 'anthropic',
                    plan: null,
                    windows,
                    fetchedAt,
                    source: 'statusline'
                }),
                accountId: typeof parsed.accountId === 'string' ? parsed.accountId : 'current',
                accountLabel: typeof parsed.accountLabel === 'string' ? parsed.accountLabel : null
            };
        } catch (_err) {
            return null;
        }
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new ClaudeQuotaReader();
    }
    return instance;
}

module.exports = {
    ClaudeQuotaReader,
    getInstance,
    getDefaultCachePath
};
