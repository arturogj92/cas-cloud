/**
 * GrokQuotaReader
 *
 * Reads SuperGrok / Grok Build weekly usage via the same billing endpoint the
 * official CLI polls (see `billing: fetched credits config` in ~/.grok/logs and
 * the `/usage` slash command):
 *
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   Authorization: Bearer <OIDC access token from ~/.grok/auth.json>
 *   x-grok-client-mode: cli
 *
 * Verified 2026-07-27 against grok 0.2.112 + a live SuperGrok account. The
 * payload carries:
 *   config.creditUsagePercent          0..100 used of the weekly pool
 *   config.currentPeriod.{type,start,end}  USAGE_PERIOD_TYPE_WEEKLY + ISO bounds
 *   config.productUsage[]              per-product rows (e.g. GrokBuild @ 13%)
 *   config.prepaidBalance / onDemand*  API prepaid (usually 0 for SuperGrok)
 *
 * Auth is OIDC against https://auth.x.ai (token endpoint /oauth2/token). The
 * CLI stores the session under ~/.grok/auth.json as a map keyed by
 * `${issuer}::${client_id}`; each entry holds `key` (access token JWT),
 * `refresh_token`, `expires_at` (ISO), `oidc_client_id`, `oidc_issuer`.
 *
 * All I/O is injectable so unit tests need neither the filesystem nor the
 * network. Every entry point degrades to null and never throws.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');

const DEFAULT_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const DEFAULT_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_SKEW_MS = 60 * 1000;

function getGrokHome() {
    const override = (process.env.GROK_HOME || '').trim();
    return override || path.join(os.homedir(), '.grok');
}

function getAuthPath() {
    return path.join(getGrokHome(), 'auth.json');
}

function getBillingUrl() {
    const override = (process.env.GROK_BILLING_URL || '').trim();
    return override || DEFAULT_BILLING_URL;
}

function getTokenUrl() {
    const override = (process.env.GROK_OAUTH_TOKEN_URL || '').trim();
    return override || DEFAULT_TOKEN_URL;
}

/**
 * Load the CLI's OAuth session from ~/.grok/auth.json.
 * @returns {Promise<{accessToken:string, refreshToken:string|null, expiresAtMs:number|null, clientId:string|null, entryKey:string, rawEntry:object, rawFile:object}|null>}
 */
function defaultLoadCredentials() {
    return new Promise((resolve) => {
        try {
            const authPath = getAuthPath();
            if (!fs.existsSync(authPath)) return resolve(null);
            const rawFile = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            if (!rawFile || typeof rawFile !== 'object') return resolve(null);

            // Prefer the entry that looks most like a live OIDC session (has key + refresh).
            let best = null;
            for (const [entryKey, entry] of Object.entries(rawFile)) {
                if (!entry || typeof entry !== 'object') continue;
                const accessToken = typeof entry.key === 'string' && entry.key.trim()
                    ? entry.key.trim()
                    : (typeof entry.access_token === 'string' ? entry.access_token.trim() : '');
                if (!accessToken) continue;
                const refreshToken = typeof entry.refresh_token === 'string' && entry.refresh_token.trim()
                    ? entry.refresh_token.trim()
                    : null;
                let expiresAtMs = null;
                if (typeof entry.expires_at === 'string') {
                    const parsed = Date.parse(entry.expires_at);
                    if (!Number.isNaN(parsed)) expiresAtMs = parsed;
                } else if (typeof entry.expires_at === 'number') {
                    // Heuristic: seconds vs ms.
                    expiresAtMs = entry.expires_at < 1e11 ? entry.expires_at * 1000 : entry.expires_at;
                }
                const clientId = typeof entry.oidc_client_id === 'string'
                    ? entry.oidc_client_id
                    : (entryKey.includes('::') ? entryKey.split('::').pop() : null);
                const candidate = {
                    accessToken,
                    refreshToken,
                    expiresAtMs,
                    clientId,
                    entryKey,
                    rawEntry: entry,
                    rawFile
                };
                // Prefer SuperGrok / session auth over API-key-only entries.
                if (!best || (refreshToken && !best.refreshToken) || (entry.auth_mode === 'oidc')) {
                    best = candidate;
                }
            }
            resolve(best);
        } catch (_err) {
            resolve(null);
        }
    });
}

/**
 * GET the billing credits config. Resolves { status, body }; never rejects.
 * @param {string} accessToken
 */
function defaultFetchBilling(accessToken) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(getBillingUrl());
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
                'Accept': 'application/json',
                // The CLI sends this; without it some deployments return HTML.
                'x-grok-client-mode': 'cli',
                'User-Agent': 'CodeAgentSwarm-GrokQuotaReader/1.0'
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
 * Merge a refreshed OIDC token into the auth.json entry (pure, no I/O).
 */
function mergeRefreshedEntry(existing, tokens, responseBody) {
    const base = (existing && typeof existing === 'object') ? { ...existing } : {};
    base.key = tokens.accessToken;
    if (tokens.refreshToken) base.refresh_token = tokens.refreshToken;
    if (tokens.expiresAtMs != null) base.expires_at = new Date(tokens.expiresAtMs).toISOString();
    if (responseBody && typeof responseBody.token_type === 'string') {
        base.token_type = responseBody.token_type;
    }
    if (responseBody && typeof responseBody.scope === 'string') {
        base.scope = responseBody.scope;
    }
    return base;
}

/**
 * Intentionally a NO-OP for disk writes.
 *
 * Writing rotated OIDC tokens back into ~/.grok/auth.json races the live CLI
 * (single-use/rotating refresh tokens → invalid_grant and silent logout mid
 * session — same class as clawdbot-openclaw 401 refresh_token_reused). Weekly
 * SuperGrok quota does not need a refreshed token persisted: if the access
 * token is expired we still try an in-memory refresh for THIS poll only and
 * never touch the user's auth store (Opus review §3.4).
 */
function persistRefreshedCredentials(_cred, _responseBody, _tokens) {
    // no-op — keep process-local only
}

/**
 * OIDC refresh_token grant against auth.x.ai. Never throws.
 * @param {{refreshToken:string|null, clientId:string|null, entryKey?:string, rawEntry?:object, rawFile?:object}} cred
 */
function defaultRefreshCredentials(cred) {
    return new Promise((resolve) => {
        if (!cred || !cred.refreshToken || !cred.clientId) return resolve(null);
        let url;
        try {
            url = new URL(getTokenUrl());
        } catch (_err) {
            return resolve(null);
        }
        const form = new URLSearchParams({
            client_id: cred.clientId,
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
                // OIDC returns access_token; some xAI responses may reuse "key".
                const accessToken = (typeof body.access_token === 'string' && body.access_token.trim())
                    || (typeof body.key === 'string' && body.key.trim())
                    || '';
                const refreshToken = (typeof body.refresh_token === 'string' && body.refresh_token.trim())
                    || cred.refreshToken;
                const expiresIn = Number(body.expires_in);
                if (!accessToken) return resolve(null);
                const expiresAtMs = Number.isFinite(expiresIn) && expiresIn > 0
                    ? Date.now() + expiresIn * 1000
                    : Date.now() + 60 * 60 * 1000;
                const tokens = { accessToken, refreshToken, expiresAtMs };
                persistRefreshedCredentials(cred, body, tokens);
                resolve({
                    ...cred,
                    accessToken,
                    refreshToken,
                    expiresAtMs,
                    rawEntry: mergeRefreshedEntry(cred.rawEntry, tokens, body)
                });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(form);
        req.end();
    });
}

function toNum(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    if (value && typeof value === 'object' && value.val !== undefined) {
        return toNum(value.val);
    }
    return null;
}

function parseIsoMs(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

/**
 * Map the billing response into a weekly QuotaSnapshot window + plan label.
 * @param {object} body
 * @returns {{windows: Array, plan: string|null}|null}
 */
function bodyToWindowsAndPlan(body) {
    if (!body || typeof body !== 'object') return null;
    const config = (body.config && typeof body.config === 'object') ? body.config : body;

    // Prefer product-specific GrokBuild % when present; fall back to account %.
    let usedPercent = null;
    const products = Array.isArray(config.productUsage) ? config.productUsage : [];
    for (const row of products) {
        if (!row || typeof row !== 'object') continue;
        const product = String(row.product || row.name || '').toLowerCase();
        if (product.includes('grokbuild') || product.includes('grok_build') || product === 'grok') {
            usedPercent = toNum(row.usagePercent ?? row.usage_percent ?? row.percent);
            if (usedPercent !== null) break;
        }
    }
    if (usedPercent === null) {
        usedPercent = toNum(config.creditUsagePercent ?? config.credit_usage_percent ?? body.creditUsagePercent);
    }
    if (usedPercent === null) return null;

    const remainingFraction = 1 - (usedPercent / 100);
    const period = (config.currentPeriod && typeof config.currentPeriod === 'object')
        ? config.currentPeriod
        : {};
    const resetsAt = parseIsoMs(period.end)
        || parseIsoMs(config.billingPeriodEnd)
        || parseIsoMs(config.billing_period_end);

    const periodType = String(period.type || config.billingCycle || '').toUpperCase();
    const isMonthly = periodType.includes('MONTH');
    const key = isMonthly ? 'weekly' : 'weekly'; // closed vocab: 'weekly' covers multi-day pools
    const label = isMonthly ? 'Monthly' : 'Weekly';

    const windows = [
        makeWindow({
            key,
            label,
            remainingFraction,
            resetsAt,
            model: null
        })
    ];

    // Plan / tier label.
    let plan = null;
    const tier = body.subscriptionTier
        || config.subscriptionTier
        || body.subscription_tier
        || config.subscription_tier
        || body.tier
        || config.tier;
    if (typeof tier === 'string' && tier.trim()) {
        // SuperGrok → SuperGrok, x_premium_plus → X Premium Plus
        plan = tier.trim()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .replace(/Xai/g, 'xAI');
        if (/supergrok/i.test(tier) && !/super\s*grok/i.test(plan)) {
            plan = tier.replace(/supergrok/i, 'SuperGrok').replace(/_/g, ' ');
        }
    } else if (products.some((p) => /grokbuild/i.test(String(p && p.product)))) {
        plan = 'SuperGrok';
    }

    return { windows, plan };
}

class GrokQuotaReader {
    /**
     * @param {object} [options]
     * @param {() => Promise<object|null>} [options.loadCredentials]
     * @param {(token: string) => Promise<{status:number, body:object|null}>} [options.fetchBilling]
     * @param {(cred: object) => Promise<object|null>} [options.refreshCredentials]
     */
    constructor(options = {}) {
        this.loadCredentials = options.loadCredentials || defaultLoadCredentials;
        this.fetchBilling = options.fetchBilling || defaultFetchBilling;
        this.refreshCredentials = options.refreshCredentials || defaultRefreshCredentials;
    }

    _isExpiredOrSoon(expiresAtMs) {
        if (typeof expiresAtMs !== 'number' || expiresAtMs <= 0) return false;
        return expiresAtMs <= Date.now() + REFRESH_SKEW_MS;
    }

    /**
     * @returns {Promise<object|null>} QuotaSnapshot or null
     */
    async getQuota() {
        try {
            let cred = await this.loadCredentials();
            if (!cred || !cred.accessToken) return null;

            let didRefresh = false;
            if (this._isExpiredOrSoon(cred.expiresAtMs)) {
                if (!cred.refreshToken) return null;
                const refreshed = await this.refreshCredentials(cred);
                if (!refreshed || !refreshed.accessToken) return null;
                cred = refreshed;
                didRefresh = true;
            }

            let { status, body } = await this.fetchBilling(cred.accessToken);
            if (status === 401 && !didRefresh && cred.refreshToken) {
                const refreshed = await this.refreshCredentials(cred);
                if (refreshed && refreshed.accessToken) {
                    cred = refreshed;
                    ({ status, body } = await this.fetchBilling(cred.accessToken));
                }
            }
            if (status !== 200 || !body) return null;

            const mapped = bodyToWindowsAndPlan(body);
            if (!mapped || !mapped.windows.length) return null;

            return makeSnapshot({
                agent: 'grok',
                provider: 'xai',
                plan: mapped.plan,
                windows: mapped.windows,
                fetchedAt: Date.now(),
                source: 'billing-api'
            });
        } catch (_err) {
            return null;
        }
    }
}

let instance = null;

function getInstance() {
    if (!instance) instance = new GrokQuotaReader();
    return instance;
}

module.exports = {
    GrokQuotaReader,
    getInstance,
    bodyToWindowsAndPlan,
    mergeRefreshedEntry,
    DEFAULT_BILLING_URL,
    DEFAULT_TOKEN_URL
};
