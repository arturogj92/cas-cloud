/** Cursor subscription usage from the same DashboardService used by Cursor CLI. */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');

const DEFAULT_API_ENDPOINT = 'https://api2.cursor.sh';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function credentialFilePath(platform = process.platform, env = process.env, home = os.homedir()) {
    if (platform === 'win32') {
        return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
    }
    if (platform === 'linux') {
        return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'cursor', 'auth.json');
    }
    return path.posix.join(home, '.cursor', 'auth.json');
}

function runFile(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
        });
    });
}

async function keychainValue(run, service) {
    try {
        const result = await run('/usr/bin/security', [
            'find-generic-password', '-w', '-s', service, '-a', 'cursor-user'
        ]);
        return String(result?.stdout || '').trim() || null;
    } catch {
        return null;
    }
}

async function loadDefaultCredentials(options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const home = (options.homedir || os.homedir)();
    const readFile = options.readFile || fs.readFile;
    const run = options.run || runFile;
    const envAccessToken = String(env.CURSOR_AUTH_TOKEN || '').trim();
    const envApiKey = String(env.CURSOR_API_KEY || '').trim();
    if (envAccessToken) return { accessToken: envAccessToken, apiKey: envApiKey || null };
    if (env.AGENT_CLI_CREDENTIAL_STORE === 'memory') {
        return envApiKey ? { accessToken: null, apiKey: envApiKey } : null;
    }

    if (platform === 'darwin' && env.AGENT_CLI_CREDENTIAL_STORE !== 'file') {
        const accessToken = await keychainValue(run, 'cursor-access-token');
        const apiKey = envApiKey || await keychainValue(run, 'cursor-api-key');
        return accessToken || apiKey ? { accessToken, apiKey } : null;
    }

    try {
        const stored = JSON.parse(await readFile(credentialFilePath(platform, env, home), 'utf8'));
        const accessToken = String(stored.accessToken || stored.access_token || '').trim() || null;
        const apiKey = envApiKey || String(stored.apiKey || stored.api_key || '').trim() || null;
        return accessToken || apiKey ? { accessToken, apiKey } : null;
    } catch {
        return null;
    }
}

function expiresSoon(token, now = Date.now()) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        return Number.isFinite(payload.exp) && payload.exp * 1000 <= now + REFRESH_SKEW_MS;
    } catch {
        return false;
    }
}

async function postJson(url, token, fetchImpl = globalThis.fetch) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{}',
            signal: controller.signal
        });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* invalid response */ }
        return { status: response.status, body };
    } finally {
        clearTimeout(timeout);
    }
}

function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function usedPercent(value, used = null, limit = null, remaining = null) {
    const direct = finite(value);
    if (direct !== null) return direct;
    const cap = finite(limit);
    if (cap === null || cap <= 0) return null;
    const spent = finite(used);
    if (spent !== null) return spent / cap * 100;
    const left = finite(remaining);
    return left === null ? null : (1 - left / cap) * 100;
}

function epochMs(value) {
    const number = finite(value);
    if (number !== null) return number < 1e12 ? number * 1000 : number;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function usageWindow(label, percent, resetsAt, model = null) {
    if (percent === null) return null;
    return makeWindow({
        key: 'monthly',
        label,
        model,
        resetsAt,
        remainingFraction: 1 - percent / 100
    });
}

function mapUsage(body, planBody, fetchedAt) {
    const usage = body?.planUsage;
    if (!usage || typeof usage !== 'object') return null;
    const resetsAt = epochMs(body.billingCycleEnd);
    const included = usedPercent(
        usage.totalPercentUsed,
        usage.totalSpend,
        usage.limit,
        usage.remaining
    );
    const windows = [usageWindow('Included', included, resetsAt)];
    windows.push(usageWindow('Auto', usedPercent(usage.autoPercentUsed, usage.autoSpend, usage.autoLimit), resetsAt, 'Auto'));
    windows.push(usageWindow('API', usedPercent(usage.apiPercentUsed, usage.apiSpend, usage.apiLimit), resetsAt, 'API'));
    const onDemand = body.spendLimitUsage?.overall;
    windows.push(usageWindow('On-Demand', usedPercent(null, onDemand?.used, onDemand?.limit, onDemand?.remaining), resetsAt, 'On-Demand'));
    const present = windows.filter(Boolean);
    if (!present.length) return null;
    return makeSnapshot({
        agent: 'cursor',
        provider: 'cursor',
        plan: planBody?.planInfo?.planName || planBody?.planName || null,
        windows: present,
        fetchedAt,
        source: 'dashboard-service'
    });
}

class CursorQuotaReader {
    constructor(options = {}) {
        const env = options.env || process.env;
        const endpoint = String(env.CURSOR_API_ENDPOINT || DEFAULT_API_ENDPOINT).replace(/\/$/, '');
        const fetchImpl = options.fetch || globalThis.fetch;
        this.now = options.now || Date.now;
        this.loadCredentials = options.loadCredentials || (() => loadDefaultCredentials(options));
        this.fetchService = options.fetchService || ((method, token) =>
            postJson(`${endpoint}/aiserver.v1.DashboardService/${method}`, token, fetchImpl));
        this.exchangeApiKey = options.exchangeApiKey || (async (apiKey) => {
            const result = await postJson(`${endpoint}/auth/exchange_user_api_key`, apiKey, fetchImpl);
            return result.status === 200 ? result.body : null;
        });
    }

    async getQuota() {
        try {
            const credentials = await this.loadCredentials();
            if (!credentials) return null;
            let token = credentials.accessToken;
            let exchanged = false;
            if ((!token || expiresSoon(token, this.now())) && credentials.apiKey) {
                token = (await this.exchangeApiKey(credentials.apiKey))?.accessToken;
                exchanged = true;
            }
            if (!token) return null;

            let [usage, plan] = await Promise.all([
                this.fetchService('GetCurrentPeriodUsage', token),
                this.fetchService('GetPlanInfo', token)
            ]);
            if (usage.status === 401 && credentials.apiKey && !exchanged) {
                token = (await this.exchangeApiKey(credentials.apiKey))?.accessToken;
                if (!token) return null;
                [usage, plan] = await Promise.all([
                    this.fetchService('GetCurrentPeriodUsage', token),
                    this.fetchService('GetPlanInfo', token)
                ]);
            }
            if (usage.status !== 200 || !usage.body) return null;
            return mapUsage(usage.body, plan.status === 200 ? plan.body : null, this.now());
        } catch {
            return null;
        }
    }
}

let instance = null;
function getInstance() {
    if (!instance) instance = new CursorQuotaReader();
    return instance;
}

module.exports = {
    CursorQuotaReader,
    credentialFilePath,
    expiresSoon,
    getInstance,
    loadDefaultCredentials,
    mapUsage
};
