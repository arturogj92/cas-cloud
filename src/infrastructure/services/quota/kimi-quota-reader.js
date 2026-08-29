/**
 * KimiQuotaReader
 *
 * Reads Kimi Code subscription usage from Moonshot's first-party usage endpoint,
 * using the same OAuth access token the CLI stored on this machine:
 *
 *   GET {KIMI_CODE_BASE_URL || https://api.kimi.com/coding/v1}/usages
 *   Authorization: Bearer <accessToken>
 *
 * This is the endpoint Kimi's own /usage TUI command calls (fetchManagedUsage in
 * packages/oauth/src/managed-usage.ts), so reading the token file + Bearer-calling it
 * is a Moonshot-sanctioned pattern, not a hack. Kimi's quota model maps cleanly onto
 * our windows: quota refreshes every 7 DAYS from the subscription date ('weekly') and
 * there is a rolling 5-HOUR rate window on top ('5h').
 *
 * Two traps this reader is built around (both verified against kimi-code source):
 *  1. The credentials FILENAME is derived, not fixed: default is credentials/kimi-code.json
 *     but it becomes kimi-code-env-<sha256> when KIMI_CODE_BASE_URL / the OAuth host are
 *     customized. So after the exact-name lookup fails we scan credentials/*.json
 *     (never the mcp/ subdir — those are MCP OAuth tokens).
 *  2. Field spelling in the /usages payload genuinely drifts; Moonshot's own parser is
 *     deliberately loose (name/title, used/remaining, resetAt/reset_at/reset_time/
 *     resetTime). We parse with the same tolerance.
 *
 * Token wire format on disk is snake_case: { access_token, refresh_token,
 * expires_at (unix SECONDS), ... }. Files are plaintext JSON, mode 0600.
 *
 * All I/O is injectable via the constructor so unit tests need neither the filesystem
 * nor the network. Every entry point degrades to null and never throws.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const REQUEST_TIMEOUT_MS = 8000; // matches Kimi's own fetchManagedUsage default

// OAuth refresh, extracted verbatim from the Kimi CLI binary (KIMI_CODE_FLOW_CONFIG):
//   POST {oauthHost}/api/oauth/token  (application/x-www-form-urlencoded)
//     client_id, grant_type=refresh_token, refresh_token
//   -> 200 { access_token, refresh_token (ROTATES), expires_in, scope, token_type }
// The access token lives only ~15 min (expires_in 900), so without a refresh the quota
// would vanish minutes after the user last ran Kimi. We refresh with the SAME client_id
// the CLI uses and write the rotated token back (see persistRefreshedCredentials) so the
// CLI stays in sync — the server rotates the refresh_token, so NOT writing it back would
// eventually invalidate the CLI's copy and log the user out of Kimi.
const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const REFRESH_SKEW_MS = 60 * 1000; // refresh when the token is expired or within 60s of it

function getKimiDataRoot() {
    const override = (process.env.KIMI_CODE_HOME || '').trim();
    return override || path.join(os.homedir(), '.kimi-code');
}

function getBaseUrl() {
    const override = (process.env.KIMI_CODE_BASE_URL || '').trim();
    return (override || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getOAuthHost() {
    const override = (process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || '').trim();
    return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, '');
}

/**
 * Default credential loader: read the CLI's OAuth token from
 * $KIMI_CODE_HOME/credentials/. Resolves to { accessToken, refreshToken, expiresAt,
 * filePath, raw } or null. `refreshToken`/`filePath`/`raw` let the reader refresh an
 * expired token and write the rotated one back to the very file it came from. Never throws.
 * @returns {Promise<{accessToken: string, refreshToken: string|null, expiresAt: number|null, filePath: string, raw: object}|null>}
 */
function defaultLoadCredentials() {
    return new Promise((resolve) => {
        try {
            const credDir = path.join(getKimiDataRoot(), 'credentials');
            if (!fs.existsSync(credDir)) return resolve(null);

            // Exact default name first, then any endpoint-derived sibling.
            const candidates = [];
            const defaultFile = path.join(credDir, 'kimi-code.json');
            if (fs.existsSync(defaultFile)) candidates.push(defaultFile);
            for (const entry of fs.readdirSync(credDir)) {
                const full = path.join(credDir, entry);
                if (entry.endsWith('.json') && full !== defaultFile) {
                    try {
                        if (fs.statSync(full).isFile()) candidates.push(full);
                    } catch (_err) { /* unreadable entry — skip */ }
                }
            }

            for (const file of candidates) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                    const accessToken = parsed && typeof parsed.access_token === 'string' && parsed.access_token.trim()
                        ? parsed.access_token.trim()
                        : null;
                    if (!accessToken) continue;
                    const refreshToken = parsed && typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim()
                        ? parsed.refresh_token.trim()
                        : null;
                    const expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : null;
                    return resolve({ accessToken, refreshToken, expiresAt, filePath: file, raw: parsed });
                } catch (_err) {
                    // Corrupt/foreign JSON — try the next candidate.
                }
            }
            resolve(null);
        } catch (_err) {
            resolve(null);
        }
    });
}

/**
 * Default HTTPS GET for /usages. Resolves to { status, body } and never rejects.
 * @param {string} accessToken
 * @returns {Promise<{status:number, body:object|null}>}
 */
function defaultFetchUsage(accessToken) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(`${getBaseUrl()}/usages`);
        } catch (_err) {
            return resolve({ status: 0, body: null });
        }

        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: 'GET',
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(data); } catch (_err) { body = null; }
                resolve({ status: res.statusCode || 0, body });
            });
        });

        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
        req.on('error', () => resolve({ status: 0, body: null }));
        req.end();
    });
}

/**
 * Merge a refreshed OAuth token into the on-disk credential object, PURELY (no I/O).
 * Every field the CLI wrote that we don't understand is preserved; only the token fields
 * are updated. `existing` is the latest file content, `responseBody` the /api/oauth/token
 * payload, `tokens` the values already parsed from it.
 * @returns {object} the object to persist
 */
function mergeRefreshedCredentials(existing, responseBody, tokens) {
    const base = (existing && typeof existing === 'object') ? existing : {};
    const body = (responseBody && typeof responseBody === 'object') ? responseBody : {};
    const merged = {
        ...base,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt
    };
    if (typeof body.expires_in === 'number') merged.expires_in = body.expires_in;
    if (typeof body.scope === 'string') merged.scope = body.scope;
    if (typeof body.token_type === 'string') merged.token_type = body.token_type;
    return merged;
}

/**
 * Write the rotated token back to the credential file ATOMICALLY (temp + rename, mode 0600),
 * re-reading the latest content first so we preserve any field the CLI added and never clobber
 * a token it wrote since we loaded. Best-effort: a failure here must never break the quota read
 * or corrupt the file (the original stays intact until the rename succeeds). Never throws.
 */
function persistRefreshedCredentials(cred, responseBody, tokens) {
    try {
        if (!cred || !cred.filePath) return;
        let current = cred.raw && typeof cred.raw === 'object' ? cred.raw : {};
        try { current = JSON.parse(fs.readFileSync(cred.filePath, 'utf8')); } catch (_err) { /* keep the loaded copy */ }
        const merged = mergeRefreshedCredentials(current, responseBody, tokens);
        const dir = path.dirname(cred.filePath);
        const tmp = path.join(dir, `.kimi-code.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
        try {
            fs.renameSync(tmp, cred.filePath);
        } catch (renameErr) {
            try { fs.unlinkSync(tmp); } catch (_e) { /* nothing else to do */ }
            throw renameErr;
        }
    } catch (_err) {
        // Never let a write-back failure surface — the read must still succeed.
    }
}

/**
 * Default OAuth refresh: exchange the stored refresh_token for a fresh access_token and
 * write the rotated token back to disk. Resolves to the new credential object, or null on
 * any failure (never throws). Mirrors the Kimi CLI's own refresh flow exactly.
 * @param {{refreshToken: string|null, filePath?: string, raw?: object}} cred
 * @returns {Promise<{accessToken:string, refreshToken:string, expiresAt:number, filePath?:string, raw?:object}|null>}
 */
function defaultRefreshCredentials(cred) {
    return new Promise((resolve) => {
        if (!cred || !cred.refreshToken) return resolve(null);
        let url;
        try {
            url = new URL(`${getOAuthHost()}/api/oauth/token`);
        } catch (_err) {
            return resolve(null);
        }
        const form = new URLSearchParams({
            client_id: KIMI_CODE_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken
        }).toString();

        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: 'POST',
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(form)
            }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                let body = null;
                try { body = JSON.parse(data); } catch (_err) { return resolve(null); }
                const accessToken = body && typeof body.access_token === 'string' ? body.access_token.trim() : '';
                const refreshToken = body && typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
                const expiresIn = Number(body && body.expires_in);
                if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
                    return resolve(null);
                }
                const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
                const tokens = { accessToken, refreshToken, expiresAt };
                persistRefreshedCredentials(cred, body, tokens);
                resolve({ ...tokens, filePath: cred.filePath, raw: mergeRefreshedCredentials(cred.raw, body, tokens) });
            });
        });

        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(form);
        req.end();
    });
}

/** First non-undefined/null value among the given keys of an object. */
function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
}

/**
 * Coerce a number OR a numeric string to a finite number; else null.
 *
 * The live /usages payload serializes every count as a JSON STRING ("100", "99",
 * "1") — not a number — so a bare `typeof === 'number'` check silently rejected
 * every field and the whole snapshot degraded to null ("no session" in the UI
 * while the user was perfectly logged in). Parse leniently, exactly as Moonshot's
 * own client does.
 */
function toNum(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Duration of a `window` object in SECONDS, honoring Moonshot's real shape
 * `{ duration: 300, timeUnit: "TIME_UNIT_MINUTE" }` (= 5 hours), plus the older
 * seconds/minutes-named aliases. Returns null when no duration is present.
 */
function windowDurationSeconds(windowObj) {
    const explicitSeconds = toNum(pick(windowObj, ['seconds', 'durationSeconds', 'duration_seconds']));
    if (explicitSeconds !== null) return explicitSeconds;
    const explicitMinutes = toNum(pick(windowObj, ['minutes', 'windowMinutes', 'window_minutes']));
    if (explicitMinutes !== null) return explicitMinutes * 60;

    const duration = toNum(pick(windowObj, ['duration']));
    if (duration === null) return null;
    const unit = pick(windowObj, ['timeUnit', 'time_unit', 'unit']);
    if (typeof unit === 'string') {
        const u = unit.toUpperCase();
        if (u.includes('SECOND')) return duration;
        if (u.includes('MINUTE')) return duration * 60;
        if (u.includes('HOUR')) return duration * 3600;
        if (u.includes('DAY')) return duration * 86400;
        if (u.includes('WEEK')) return duration * 604800;
    }
    // A bare `duration` with no unit is seconds per Moonshot's proto default.
    return duration;
}

/** Parse a reset hint that may be an ISO string, epoch seconds, or epoch ms. */
function parseResetsAt(value) {
    if (value == null) return null;
    if (typeof value === 'number') {
        // Heuristic: epoch seconds are ~1e9-1e10; ms are ~1e12-1e13.
        return value < 1e11 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
        const asNum = Number(value);
        if (!Number.isNaN(asNum) && asNum > 0) return asNum < 1e11 ? asNum * 1000 : asNum;
    }
    return null;
}

/**
 * Classify a limit row into one of our window keys by its text/duration hints.
 * Kimi's documented model is a 7-day refresh + a rolling 5-hour window.
 * @returns {'weekly'|'5h'|null}
 */
function classifyWindowKey(row) {
    const detail = row && typeof row.detail === 'object' ? row.detail : {};
    const windowObj = row && typeof row.window === 'object' ? row.window : {};
    const text = [
        pick(row, ['name', 'title', 'label', 'key']),
        pick(detail, ['name', 'title', 'label', 'key']),
        pick(windowObj, ['name', 'title', 'label', 'key', 'unit', 'kind', 'type'])
    ].filter((v) => typeof v === 'string').join(' ').toLowerCase();

    if (/week|7\s*d|7-day|seven/.test(text)) return 'weekly';
    if (/5\s*h|hour|session|rate/.test(text)) return '5h';

    // Numeric duration as a fallback — covers Moonshot's {duration,timeUnit} shape
    // and the seconds/minutes aliases. A 300-minute window (= 5h) lands as '5h'.
    const seconds = windowDurationSeconds(windowObj);
    if (seconds !== null) {
        if (seconds >= 6 * 24 * 3600) return 'weekly';
        if (seconds <= 24 * 3600) return '5h';
    }
    return null;
}

/**
 * Map one /usages `limits[]` row into a QuotaSnapshot window, or null. Tolerates
 * the documented field aliases and both used/limit and remaining/limit shapes.
 * A row that carries used+limit but no recognizable window text still maps —
 * defaulting to 'weekly', Kimi's primary quota window — so a spelling drift
 * upstream degrades the label, never the ring.
 */
function limitToWindow(row) {
    if (!row || typeof row !== 'object') return null;
    const detail = typeof row.detail === 'object' && row.detail !== null ? row.detail : {};

    // Every count arrives as a numeric STRING on the wire — coerce before comparing.
    const used = toNum(pick(row, ['used', 'usedCount', 'used_count']) ?? pick(detail, ['used', 'usedCount', 'used_count']));
    const remaining = toNum(pick(row, ['remaining']) ?? pick(detail, ['remaining']));
    const limit = toNum(pick(row, ['limit', 'total', 'max']) ?? pick(detail, ['limit', 'total', 'max']));

    let remainingFraction = null;
    if (limit !== null && limit > 0) {
        if (remaining !== null) {
            remainingFraction = remaining / limit;
        } else if (used !== null) {
            remainingFraction = 1 - used / limit;
        }
    }
    // Percentage-shaped rows (usedPercent 0-100) as a fallback.
    if (remainingFraction === null) {
        const usedPercent = toNum(pick(row, ['usedPercent', 'used_percent', 'percent']) ?? pick(detail, ['usedPercent', 'used_percent', 'percent']));
        if (usedPercent !== null) remainingFraction = 1 - usedPercent / 100;
    }
    if (remainingFraction === null) return null;

    const key = classifyWindowKey(row) || 'weekly';
    const label = key === 'weekly' ? 'Weekly (7-day)' : '5-hour window';
    const resetsAt = parseResetsAt(
        pick(row, ['resetAt', 'reset_at', 'reset_time', 'resetTime', 'resetsAt']) ??
        pick(detail, ['resetAt', 'reset_at', 'reset_time', 'resetTime', 'resetsAt']) ??
        pick(typeof row.window === 'object' && row.window !== null ? row.window : {}, ['resetAt', 'reset_at', 'reset_time', 'resetTime'])
    );

    return makeWindow({ key, label, remainingFraction, resetsAt, model: null });
}

/** Best-effort plan label from the payload; null when absent. */
function derivePlan(body) {
    const plan = pick(body, ['plan', 'planName', 'plan_name', 'tier', 'membership'])
        ?? pick(typeof body.usage === 'object' && body.usage !== null ? body.usage : {}, ['plan', 'planName', 'plan_name', 'tier']);
    if (typeof plan === 'string' && plan.trim()) {
        const p = plan.trim();
        return p.charAt(0).toUpperCase() + p.slice(1);
    }
    return null;
}

class KimiQuotaReader {
    /**
     * @param {object} [options]
     * @param {() => Promise<object|null>} [options.loadCredentials]
     * @param {(token: string) => Promise<{status:number, body:object|null}>} [options.fetchUsage]
     * @param {(cred: object) => Promise<object|null>} [options.refreshCredentials]
     */
    constructor(options = {}) {
        this.loadCredentials = options.loadCredentials || defaultLoadCredentials;
        this.fetchUsage = options.fetchUsage || defaultFetchUsage;
        this.refreshCredentials = options.refreshCredentials || defaultRefreshCredentials;
    }

    /** True when the token is expired or within REFRESH_SKEW_MS of expiring. */
    _isExpiredOrSoon(expiresAt) {
        if (typeof expiresAt !== 'number' || expiresAt <= 0) return false; // unknown → let the server judge
        return (expiresAt * 1000) <= Date.now() + REFRESH_SKEW_MS;
    }

    /**
     * Read the current Kimi Code quota, or null. Never throws.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null if unavailable.
     */
    async getQuota() {
        try {
            let cred = await this.loadCredentials();
            if (!cred || !cred.accessToken) return null;

            // Kimi's access token lives only ~15 min. If it is expired (or about to be),
            // refresh it with the stored refresh_token BEFORE calling /usages — otherwise the
            // quota would disappear minutes after the user last ran Kimi. Without a
            // refresh_token there is nothing to do but degrade to null.
            let didRefresh = false;
            if (this._isExpiredOrSoon(cred.expiresAt)) {
                if (!cred.refreshToken) return null;
                const refreshed = await this.refreshCredentials(cred);
                if (!refreshed || !refreshed.accessToken) return null;
                cred = refreshed;
                didRefresh = true;
            }

            let { status, body } = await this.fetchUsage(cred.accessToken);
            // A believed-valid token rejected with 401 (clock skew / server-side revoke):
            // refresh once and retry before giving up.
            if (status === 401 && !didRefresh && cred.refreshToken) {
                const refreshed = await this.refreshCredentials(cred);
                if (refreshed && refreshed.accessToken) {
                    cred = refreshed;
                    ({ status, body } = await this.fetchUsage(cred.accessToken));
                }
            }
            if (status !== 200 || !body || typeof body !== 'object') return null;

            const limits = Array.isArray(body.limits) ? body.limits : [];
            const windows = [];
            const seenKeys = new Set();
            const addWindow = (win) => {
                if (win && !seenKeys.has(win.key)) {
                    seenKeys.add(win.key);
                    windows.push(win);
                }
            };

            // The rolling windows (a 5-hour rate window, in practice).
            for (const row of limits) addWindow(limitToWindow(row));

            // Moonshot's top-level `usage` is the account's PRIMARY (weekly) pool,
            // with its own reset separate from the rolling `limits[]`. Surface it too
            // — not merely as a fallback — so the popover shows BOTH the weekly pool
            // and the 5h window, the way Claude/Codex do. Deduped by key so we never
            // list the same window twice.
            if (body.usage && typeof body.usage === 'object') addWindow(limitToWindow(body.usage));
            if (windows.length === 0) return null;

            return makeSnapshot({
                agent: 'kimi',
                provider: 'moonshot',
                plan: derivePlan(body),
                windows,
                fetchedAt: Date.now(),
                source: 'usages-api'
            });
        } catch (_err) {
            return null;
        }
    }
}

// Singleton
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new KimiQuotaReader();
    }
    return instance;
}

module.exports = {
    KimiQuotaReader,
    getInstance,
    mergeRefreshedCredentials
};
