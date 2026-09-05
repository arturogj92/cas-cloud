/**
 * CodexQuotaReader
 *
 * Reads OpenAI Codex CLI usage quota from the newest rollout file. Codex writes
 * `rate_limits` into the JSONL rollout on every token_count event; the last such
 * line reflects the current quota. No credentials needed — pure file reads.
 *
 * Rollouts live under ~/.codex/sessions/YEAR/MONTH/DAY/rollout-*.jsonl.
 *
 * This module has NO app-DB / native-module dependency: it reads files and maps
 * them into a QuotaSnapshot. Every entry point degrades to null and never throws.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');
const { readFirstLine } = require('../codex-conversation-reader');

// Codex's longest known account window is seven days. Looking back one extra
// day finds a concurrently-written general record without trawling an entire
// multi-year session archive every time the navbar refreshes.
const ACCOUNT_LIMIT_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const QUOTA_TAIL_CHUNK_BYTES = 256 * 1024;
const QUOTA_TAIL_MAX_SCAN_BYTES = 32 * 1024 * 1024;
const QUOTA_EVENT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * @returns {string} the Codex sessions directory (~/.codex/sessions).
 */
function getSessionsDir() {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return path.join(codexHome, 'sessions');
}

/**
 * Recursively collect rollout-*.jsonl files under a directory.
 * Codex nests them as sessions/YEAR/MONTH/DAY/rollout-*.jsonl.
 * @param {string} dir
 * @returns {string[]}
 */
function findRolloutFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) return files;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...findRolloutFiles(fullPath));
            } else if (
                entry.isFile() &&
                entry.name.startsWith('rollout-') &&
                entry.name.endsWith('.jsonl')
            ) {
                files.push(fullPath);
            }
        }
    } catch (_err) {
        // Ignore unreadable directories — degrade gracefully.
    }
    return files;
}

/**
 * Find the most recently modified rollout file, or null.
 * @returns {string|null}
 */
function findNewestRollout() {
    const files = findRolloutFiles(getSessionsDir());
    if (files.length === 0) return null;
    let newest = null;
    let newestMtime = -Infinity;
    for (const file of files) {
        try {
            const mtime = fs.statSync(file).mtimeMs;
            if (mtime > newestMtime) {
                newestMtime = mtime;
                newest = file;
            }
        } catch (_err) {
            // Skip files we cannot stat.
        }
    }
    return newest;
}

/**
 * Sort rollout files from most to least recently modified.
 * Unreadable files sort last and are skipped later by readCandidatesFromFile().
 * @returns {Array<{ file: string, mtimeMs: number }>}
 */
function findRolloutsByRecency() {
    return findRolloutFiles(getSessionsDir()).map((file) => {
        let mtimeMs = -Infinity;
        try {
            mtimeMs = fs.statSync(file).mtimeMs;
        } catch (_err) {
            // Leave unreadable files at the end.
        }
        return { file, mtimeMs };
    }).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Capitalize a plan_type string ('plus' -> 'Plus'), or null.
 * @param {string|null|undefined} plan
 * @returns {string|null}
 */
function capitalizePlan(plan) {
    if (!plan || typeof plan !== 'string') return null;
    return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * Derive the window key + label from window_minutes.
 * NEVER assumes 5h — honors the actual window_minutes.
 * @param {number|null|undefined} minutes
 * @returns {{ key: string, label: string }}
 */
function windowKeyAndLabel(minutes) {
    if (typeof minutes !== 'number' || Number.isNaN(minutes)) {
        return { key: 'weekly', label: 'Weekly window' };
    }
    if (minutes <= 300) {
        const hours = minutes / 60;
        const hoursLabel = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
        return { key: '5h', label: `${hoursLabel}-hour window` };
    }
    if (minutes === 10080) {
        return { key: 'weekly', label: 'Weekly window' };
    }
    const days = minutes / 1440;
    const daysLabel = Number.isInteger(days) ? String(days) : days.toFixed(1);
    return { key: 'weekly', label: `${daysLabel}-day window` };
}

/**
 * Read used-percent from either a rollout bucket (`used_percent`) or the
 * app-server `/status` payload (`usedPercent`).
 * @param {object} bucket
 * @returns {number|null}
 */
function usedPercentOf(bucket) {
    if (typeof bucket.used_percent === 'number') return bucket.used_percent;
    if (typeof bucket.usedPercent === 'number') return bucket.usedPercent;
    return null;
}

/**
 * Reset epoch-ms from rollout (`resets_at` seconds) or app-server (`resetsAt`
 * seconds).
 * @param {object} bucket
 * @returns {number|null}
 */
function resetsAtOf(bucket) {
    const raw = typeof bucket.resets_at === 'number'
        ? bucket.resets_at
        : (typeof bucket.resetsAt === 'number' ? bucket.resetsAt : null);
    if (raw == null) return null;
    return raw > 1e12 ? raw : raw * 1000;
}

/**
 * Map a single rate_limits bucket into a QuotaSnapshot window, or null.
 * @param {object|null} bucket - { used_percent|usedPercent, window_minutes, resets_at|resetsAt }
 * @returns {object|null}
 */
function bucketToWindow(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    const usedPercent = usedPercentOf(bucket);
    if (usedPercent == null) return null;
    const minutes = typeof bucket.window_minutes === 'number'
        ? bucket.window_minutes
        : (typeof bucket.windowMinutes === 'number' ? bucket.windowMinutes : null);
    const { key, label } = windowKeyAndLabel(minutes);
    return makeWindow({
        key,
        label,
        remainingFraction: 1 - usedPercent / 100,
        resetsAt: resetsAtOf(bucket)
    });
}

/**
 * Pick the account-wide Codex bucket from an app-server rateLimits payload.
 * `/status` and `account/rateLimits/read` report either a single pair of
 * windows or a map keyed by limit id; the navbar is the `codex` account.
 * @param {object|null} rateLimits
 * @returns {object|null}
 */
function pickLiveAccountLimits(rateLimits) {
    if (!rateLimits || typeof rateLimits !== 'object') return null;
    const byId = rateLimits.rateLimitsByLimitId;
    if (byId && typeof byId === 'object') {
        if (byId.codex && typeof byId.codex === 'object') return byId.codex;
        const first = Object.entries(byId).find(([id, value]) => (
            value && typeof value === 'object' && (value.primary || value.secondary) && isAccountWideLimit(value, id)
        ));
        if (first) return first[1];
    }
    if (rateLimits.primary || rateLimits.secondary) {
        // A bare primary/secondary pair (Chat /status) is the account window.
        // A named model bucket must not drive the navbar ring.
        if (rateLimits.limit_id || rateLimits.limit_name || rateLimits.limitId || rateLimits.limitName) {
            return isAccountWideLimit(rateLimits) ? rateLimits : null;
        }
        return rateLimits;
    }
    if (rateLimits.rateLimits && typeof rateLimits.rateLimits === 'object') {
        return pickLiveAccountLimits(rateLimits.rateLimits);
    }
    return null;
}

/**
 * Build a QuotaSnapshot from a live Codex app-server rate-limit payload
 * (the same numbers `/status` prints). Never throws; returns null on junk.
 * @param {object|null} rateLimits
 * @param {object} [meta]
 * @returns {object|null}
 */
function snapshotFromLiveRateLimits(rateLimits, meta = {}) {
    try {
        const account = pickLiveAccountLimits(rateLimits);
        if (!account) return null;
        const windows = [];
        const primary = bucketToWindow(account.primary);
        if (primary) windows.push(primary);
        const secondary = bucketToWindow(account.secondary);
        if (secondary) windows.push(secondary);
        if (windows.length === 0) return null;
        return makeSnapshot({
            agent: meta.agent || 'codex',
            provider: meta.provider || 'openai',
            plan: capitalizePlan(account.plan_type || account.planType) || meta.plan || null,
            windows,
            fetchedAt: Date.now(),
            source: meta.source || 'app-server'
        });
    } catch (_err) {
        return null;
    }
}

/**
 * Extract the rate_limits object from a parsed rollout line, wherever it lives.
 * @param {object} parsed
 * @returns {object|null}
 */
function extractRateLimits(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.rate_limits && typeof parsed.rate_limits === 'object') {
        return parsed.rate_limits;
    }
    if (parsed.payload && parsed.payload.rate_limits && typeof parsed.payload.rate_limits === 'object') {
        return parsed.payload.rate_limits;
    }
    return null;
}

/**
 * Codex can emit a separate rate-limit record for a particular model. Those
 * records have a model-facing limit_name (for example GPT-5.3-Codex-Spark),
 * while the account-wide allowance is the canonical "codex" limit and has no
 * model name. The navbar represents the account, so model limits must not
 * replace it merely because their rollout file was written a moment later.
 * @param {object} rateLimits
 * @returns {boolean}
 */
function isAccountWideLimit(rateLimits, fallbackId = '') {
    if (!rateLimits || typeof rateLimits !== 'object') return false;
    const rawId = rateLimits.limit_id ?? rateLimits.limitId ?? fallbackId;
    const rawName = rateLimits.limit_name ?? rateLimits.limitName;
    const limitId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
    const limitName = typeof rawName === 'string' ? rawName.trim() : '';
    if (limitId) return limitId === 'codex';
    return !limitName;
}

/**
 * A stored account-wide record is usable only while at least one of its windows
 * still belongs to the active rate-limit period. This prevents an old general
 * record from permanently hiding a current model-only quota.
 * @param {object} snapshot
 * @returns {boolean}
 */
function hasActiveWindow(snapshot) {
    const now = Date.now();
    return Boolean(snapshot && Array.isArray(snapshot.windows) && snapshot.windows.some((window) => (
        typeof window.resetsAt !== 'number' || window.resetsAt > now
    )));
}

class CodexQuotaReader {
    /**
     * Parse the newest rate-limit event and the newest account-wide event in one
     * rollout. A single Codex session can alternate both record types.
     * @param {string} filePath
     * @param {string|null} knownSessionId
     * @returns {Promise<{
     *   newest: { snapshot: object, accountWide: boolean },
     *   accountWide: { snapshot: object, accountWide: boolean }|null
     * }|null>}
     */
    async readCandidatesFromFile(filePath, knownSessionId = null, { since = null } = {}) {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            let sessionId = knownSessionId;
            if (!sessionId) {
                try {
                    const firstLine = JSON.parse(readFirstLine(filePath));
                    if (firstLine.type === 'session_meta' && typeof firstLine.payload?.id === 'string') {
                        sessionId = firstLine.payload.id;
                    }
                } catch (_err) { /* malformed metadata does not invalidate quota */ }
            }

            const stat = await fs.promises.stat(filePath);
            const handle = await fs.promises.open(filePath, 'r');
            let windowEnd = stat.size;
            let scannedBytes = 0;
            let carry = Buffer.alloc(0);
            let skippingOversizedEvent = false;
            let newest = null;
            let accountWide = null;
            const parseLine = (line) => {
                if (line.length === 0 || line.length > QUOTA_EVENT_MAX_BYTES ||
                    line.indexOf('"rate_limits"') === -1) return false;
                try {
                    const parsed = JSON.parse(line.toString('utf8'));
                    const rateLimits = extractRateLimits(parsed);
                    if (!rateLimits) return false;
                    if (since && parsed.timestamp && Date.parse(parsed.timestamp) < since) {
                        // Scanning backwards: everything further up predates the
                        // binding too, so stop with whatever newer records were found.
                        return true;
                    }

                    const windows = [];
                    const primary = bucketToWindow(rateLimits.primary);
                    if (primary) windows.push(primary);
                    const secondary = bucketToWindow(rateLimits.secondary);
                    if (secondary) windows.push(secondary);
                    if (windows.length === 0) return false;

                    const candidate = {
                        snapshot: makeSnapshot({
                            agent: 'codex',
                            provider: 'openai',
                            plan: capitalizePlan(rateLimits.plan_type),
                            windows,
                            fetchedAt: parsed.timestamp
                                ? Date.parse(parsed.timestamp) || Date.now()
                                : Date.now(),
                            source: 'rollout'
                        }),
                        accountWide: isAccountWideLimit(rateLimits)
                    };
                    if (!newest) newest = candidate;
                    if (!accountWide && candidate.accountWide) accountWide = candidate;
                    return Boolean(newest && accountWide);
                } catch (_err) {
                    return false;
                }
            };

            // ponytail: 32 MiB covers the measured 22.47 MiB worst case; add a
            // persisted byte index only if Codex starts separating these events further.
            let done = false;
            try {
                while (windowEnd > 0 && scannedBytes < QUOTA_TAIL_MAX_SCAN_BYTES && !done) {
                    const bytesToRead = Math.min(
                        QUOTA_TAIL_CHUNK_BYTES,
                        QUOTA_TAIL_MAX_SCAN_BYTES - scannedBytes,
                        windowEnd
                    );
                    const start = windowEnd - bytesToRead;
                    const buffer = Buffer.allocUnsafe(bytesToRead);
                    let bytesRead = 0;
                    while (bytesRead < buffer.length) {
                        const result = await handle.read(
                            buffer,
                            bytesRead,
                            buffer.length - bytesRead,
                            start + bytesRead
                        );
                        if (result.bytesRead === 0) break;
                        bytesRead += result.bytesRead;
                    }
                    if (bytesRead === 0) break;

                    scannedBytes += bytesRead;
                    const chunk = buffer.subarray(0, bytesRead);
                    const firstNewline = chunk.indexOf(10);
                    if (firstNewline === -1) {
                        if (!skippingOversizedEvent) {
                            if (chunk.length + carry.length > QUOTA_EVENT_MAX_BYTES) {
                                carry = Buffer.alloc(0);
                                skippingOversizedEvent = true;
                            } else {
                                carry = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
                            }
                        }
                    } else {
                        const lastNewline = chunk.lastIndexOf(10);
                        const rightPart = chunk.subarray(lastNewline + 1);
                        if (!skippingOversizedEvent &&
                            rightPart.length + carry.length <= QUOTA_EVENT_MAX_BYTES) {
                            done = parseLine(
                                carry.length > 0 ? Buffer.concat([rightPart, carry]) : rightPart
                            );
                        }
                        carry = Buffer.alloc(0);
                        skippingOversizedEvent = false;

                        for (let lineEnd = lastNewline; lineEnd > firstNewline && !done;) {
                            const previousNewline = chunk.lastIndexOf(10, lineEnd - 1);
                            done = parseLine(chunk.subarray(previousNewline + 1, lineEnd));
                            lineEnd = previousNewline;
                        }

                        if (start === 0) {
                            if (!done) done = parseLine(chunk.subarray(0, firstNewline));
                        } else {
                            carry = chunk.subarray(0, firstNewline);
                        }
                    }
                    windowEnd = start;
                }
                if (!done && windowEnd === 0 && carry.length > 0 && !skippingOversizedEvent) {
                    parseLine(carry);
                }
            } finally {
                await handle.close();
            }

            if (!accountWide && windowEnd > 0) return null;
            return newest ? { newest, accountWide, sessionId } : null;
        } catch (_err) {
            return null;
        }
    }

    /**
     * Parse a rollout file into a QuotaSnapshot, or null. Never throws.
     * Reads lines and iterates from the END — the last rate_limits line is current.
     * @param {string} filePath
     * @returns {Promise<object|null>}
     */
    async readFromFile(filePath) {
        const candidates = await this.readCandidatesFromFile(filePath);
        return candidates ? candidates.newest.snapshot : null;
    }

    /**
     * Read the current account-wide Codex quota, or null. Model-specific rollouts
     * are retained only as a fallback when no active account-wide record exists.
     * @returns {Promise<object|null>}
     */
    async getQuota() {
        try {
            const files = findRolloutsByRecency();
            const accountLookbackCutoff = Date.now() - ACCOUNT_LIMIT_LOOKBACK_MS;
            let newestFallback = null;

            for (const { file, mtimeMs } of files) {
                const candidates = await this.readCandidatesFromFile(file);
                if (!candidates) continue;
                if (
                    candidates.accountWide &&
                    hasActiveWindow(candidates.accountWide.snapshot)
                ) {
                    return candidates.accountWide.snapshot;
                }
                if (!newestFallback) {
                    newestFallback = candidates.newest.snapshot;
                }
                if (mtimeMs < accountLookbackCutoff) {
                    break;
                }
            }

            return newestFallback;
        } catch (_err) {
            return null;
        }
    }

    async getQuotas(accountForSession, activeBindings = null, bindingSince = null) {
        if (typeof accountForSession !== 'function') {
            const snapshot = await this.getQuota();
            return snapshot ? [snapshot] : [];
        }
        try {
            const accountLookbackCutoff = Date.now() - ACCOUNT_LIMIT_LOOKBACK_MS;
            const hasBindingCatalog = activeBindings && typeof activeBindings === 'object';
            const bindingEntries = hasBindingCatalog
                ? Object.entries(activeBindings).filter(([sessionId, accountId]) => (
                    typeof sessionId === 'string' && typeof accountId === 'string'
                ))
                : [];

            if (hasBindingCatalog) {
                if (bindingEntries.length === 0) {
                    const snapshot = await this.getQuota();
                    return snapshot ? [{ ...snapshot, accountId: 'current' }] : [];
                }
                const boundFilesByAccount = new Map();
                for (const { file, mtimeMs } of findRolloutsByRecency()) {
                    if (mtimeMs < accountLookbackCutoff) continue;
                    const name = path.basename(file);
                    const binding = bindingEntries.find(([sessionId]) => name.includes(sessionId));
                    if (!binding) continue;
                    const [sessionId, accountId] = binding;
                    if (!boundFilesByAccount.has(accountId)) boundFilesByAccount.set(accountId, []);
                    boundFilesByAccount.get(accountId).push({ file, sessionId });
                }

                const boundSnapshots = [];
                for (const [accountId, files] of boundFilesByAccount) {
                    let fallback = null;
                    for (const { file, sessionId } of files) {
                        // Records older than the binding belong to whoever drove the
                        // conversation before the account switch.
                        const since = bindingSince && typeof bindingSince === 'object'
                            ? bindingSince[sessionId]
                            : null;
                        const candidates = await this.readCandidatesFromFile(file, sessionId, {
                            since: Number.isFinite(since) ? since : null
                        });
                        if (!candidates) continue;
                        if (candidates.accountWide && hasActiveWindow(candidates.accountWide.snapshot)) {
                            boundSnapshots.push({ ...candidates.accountWide.snapshot, accountId });
                            fallback = null;
                            break;
                        }
                        if (!fallback) fallback = { ...candidates.newest.snapshot, accountId };
                    }
                    if (fallback) boundSnapshots.push(fallback);
                }
                return boundSnapshots;
            }

            const snapshots = new Map();
            const fallbacks = new Map();
            for (const { file, mtimeMs } of findRolloutsByRecency()) {
                const candidates = await this.readCandidatesFromFile(file);
                const accountId = candidates?.sessionId
                    ? accountForSession(candidates.sessionId)
                    : null;
                if (accountId && !snapshots.has(accountId)) {
                    if (candidates.accountWide && hasActiveWindow(candidates.accountWide.snapshot)) {
                        snapshots.set(accountId, {
                            ...candidates.accountWide.snapshot,
                            accountId
                        });
                    } else if (!fallbacks.has(accountId)) {
                        fallbacks.set(accountId, { ...candidates.newest.snapshot, accountId });
                    }
                }
                if (mtimeMs < accountLookbackCutoff) break;
            }
            for (const [accountId, snapshot] of fallbacks) {
                if (!snapshots.has(accountId)) snapshots.set(accountId, snapshot);
            }
            return Array.from(snapshots.values());
        } catch (_err) {
            return [];
        }
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new CodexQuotaReader();
    }
    return instance;
}

module.exports = {
    CodexQuotaReader,
    getInstance,
    getSessionsDir,
    findNewestRollout,
    isAccountWideLimit,
    snapshotFromLiveRateLimits,
    pickLiveAccountLimits
};
