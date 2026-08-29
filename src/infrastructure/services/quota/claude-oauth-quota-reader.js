/**
 * ClaudeOAuthQuotaReader
 *
 * Reads Claude Code usage quota straight from Anthropic's OAuth usage endpoint,
 * using the same OAuth access token the CLI already stored on this machine. This
 * unlocks the rich data the statusLine cache can't give us: the plan tier, the
 * per-model weekly limits (e.g. Fable), and always-fresh percentages.
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <accessToken>
 *   anthropic-beta: oauth-2025-04-20
 *   User-Agent: claude-code/<version>   (required — omitting risks a 429 bucket)
 *
 * The credential lives in the OS keychain on macOS ("Claude Code-credentials")
 * or in ~/.claude/.credentials.json elsewhere, both holding the same JSON shape
 * `{ claudeAiOauth: { accessToken, subscriptionType, rateLimitTier } }`.
 *
 * Both the credential read and the HTTPS GET are injectable via the constructor
 * so unit tests need neither the Keychain nor the network. Every entry point
 * degrades to null and never throws.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');

const USAGE_HOSTNAME = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const FALLBACK_VERSION = '2.1.0';
const REQUEST_TIMEOUT_MS = 8 * 1000;
const CREDENTIAL_READ_STATUS = Object.freeze({
    PRESENT: 'present',
    ABSENT: 'absent',
    UNREADABLE: 'unreadable'
});

function credentialRead(status, credentials = null) {
    return { status, credentials };
}

/**
 * Parse the credential store without collapsing a confirmed logout into a transient read error.
 * A syntactically valid store with no usable Claude OAuth entry means logged out; an empty or
 * malformed store can be an in-progress rewrite and therefore remains unreadable.
 * @param {string} raw
 * @returns {{status:string, credentials:object|null}}
 */
function credentialStateFromRaw(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return credentialRead(CREDENTIAL_READ_STATUS.UNREADABLE);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_err) {
        return credentialRead(CREDENTIAL_READ_STATUS.UNREADABLE);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return credentialRead(CREDENTIAL_READ_STATUS.UNREADABLE);
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'claudeAiOauth')
        || parsed.claudeAiOauth === null) {
        return credentialRead(CREDENTIAL_READ_STATUS.ABSENT);
    }
    const oauth = parsed.claudeAiOauth;
    if (typeof oauth !== 'object' || Array.isArray(oauth)) {
        return credentialRead(CREDENTIAL_READ_STATUS.UNREADABLE);
    }
    if (!Object.prototype.hasOwnProperty.call(oauth, 'accessToken')
        || oauth.accessToken === null
        || oauth.accessToken === '') {
        return credentialRead(CREDENTIAL_READ_STATUS.ABSENT);
    }
    if (typeof oauth.accessToken !== 'string') {
        return credentialRead(CREDENTIAL_READ_STATUS.UNREADABLE);
    }
    return credentialRead(CREDENTIAL_READ_STATUS.PRESENT, oauth);
}

function isConfirmedKeychainAbsence(error, stderr) {
    if (Number(error && error.code) === 44) return true;
    const message = `${stderr || ''}\n${error && error.message ? error.message : ''}`.toLowerCase();
    return message.includes('specified item could not be found')
        || message.includes('item not found in the keychain');
}

function isConfirmedCredentialFileAbsence(error) {
    return Boolean(error && error.code === 'ENOENT');
}

/**
 * Read the newest installed Claude Code version string, for the User-Agent.
 * Versions live as dir names under ~/.local/share/claude/versions/. Falls back
 * to a constant when the directory is missing or unreadable.
 * @returns {string} e.g. 'claude-code/2.1.5'
 */
function getClaudeUserAgent() {
    let version = FALLBACK_VERSION;
    try {
        const versionsDir = path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
        const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
            .filter(e => e.isDirectory() || e.isFile())
            .map(e => e.name)
            .filter(Boolean)
            .sort();
        if (entries.length > 0) {
            version = entries[entries.length - 1];
        }
    } catch (_err) {
        // Directory absent/unreadable — keep the fallback version.
    }
    return `claude-code/${version}`;
}

/**
 * Read the OAuth store while preserving the difference between a confirmed logout and an
 * unreadable/transient store. Never throws.
 * @returns {Promise<{status:string, credentials:object|null}>}
 */
function defaultReadCredentialState() {
    return new Promise((resolve) => {
        if (process.platform === 'darwin') {
            // A SPECIFIC named keychain item — not a scan.
            execFile(
                'security',
                ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
                { timeout: 5000 },
                (err, stdout, stderr) => {
                    if (err) {
                        return resolve(credentialRead(
                            isConfirmedKeychainAbsence(err, stderr)
                                ? CREDENTIAL_READ_STATUS.ABSENT
                                : CREDENTIAL_READ_STATUS.UNREADABLE
                        ));
                    }
                    resolve(credentialStateFromRaw(String(stdout || '').trim()));
                }
            );
            return;
        }

        const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
        fs.readFile(credPath, 'utf8', (error, raw) => {
            if (error) {
                return resolve(credentialRead(
                    isConfirmedCredentialFileAbsence(error)
                        ? CREDENTIAL_READ_STATUS.ABSENT
                        : CREDENTIAL_READ_STATUS.UNREADABLE
                ));
            }
            resolve(credentialStateFromRaw(raw));
        });
    });
}

/**
 * Backwards-compatible loader used by the quota reader. AccountWatcher consumes the richer state
 * above; quota reads still need only the credential or null.
 * @returns {Promise<object|null>}
 */
async function defaultLoadCredentials() {
    const result = await defaultReadCredentialState();
    return result.status === CREDENTIAL_READ_STATUS.PRESENT ? result.credentials : null;
}

/**
 * Default HTTPS GET for the usage endpoint. Resolves to { status, body } where
 * body is the parsed JSON (or null). Never rejects — network/parse errors
 * resolve to { status: 0, body: null }.
 * @param {string} accessToken
 * @param {string} userAgent
 * @returns {Promise<{ status: number, body: object|null }>}
 */
function defaultFetchUsage(accessToken, userAgent) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const options = {
            hostname: USAGE_HOSTNAME,
            path: USAGE_PATH,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-beta': OAUTH_BETA,
                'Content-Type': 'application/json',
                'User-Agent': userAgent
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let body = null;
                try {
                    body = JSON.parse(data);
                } catch (_err) {
                    body = null;
                }
                finish({ status: res.statusCode || 0, body });
            });
            res.on('error', () => finish({ status: 0, body: null }));
        });

        req.on('error', () => finish({ status: 0, body: null }));
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            finish({ status: 0, body: null });
            req.destroy(new Error('Claude usage request timed out'));
        });
        req.end();
    });
}

/**
 * Map the endpoint's severity to our value object's severity. The value object
 * only knows 'normal'/'critical', so 'warning' and 'normal' both map to normal.
 * @param {string|undefined} severity
 * @returns {'critical'|'normal'}
 */
function mapSeverity(severity) {
    return severity === 'critical' ? 'critical' : 'normal';
}

/**
 * Map a single `limits[]` entry into a QuotaSnapshot window, or null.
 * `percent` is USED percent (0-100), so remainingFraction = 1 - percent/100.
 * @param {object|null} limit
 * @returns {object|null}
 */
function limitToWindow(limit) {
    if (!limit || typeof limit !== 'object') return null;
    if (typeof limit.percent !== 'number') return null;

    const remainingFraction = 1 - limit.percent / 100;
    const resetsAt = limit.resets_at ? (Date.parse(limit.resets_at) || null) : null;
    const severity = mapSeverity(limit.severity);

    let key = null;
    let label = null;
    let model = null;

    if (limit.kind === 'session') {
        key = '5h';
        label = '5-hour window';
    } else if (limit.kind === 'weekly_all') {
        key = 'weekly';
        label = 'Weekly';
    } else if (limit.kind === 'weekly_scoped') {
        key = 'weekly';
        label = 'Weekly';
        if (limit.scope && limit.scope.model && limit.scope.model.display_name) {
            model = limit.scope.model.display_name;
        }
    } else {
        return null; // unknown kind — ignore
    }

    // makeWindow derives severity from the remaining fraction; the endpoint's
    // severity is authoritative, so override it after building the window.
    const win = makeWindow({ key, label, remainingFraction, resetsAt, model });
    win.severity = severity;
    return win;
}

/**
 * Derive a human-readable plan label from the OAuth credential.
 * @param {object|null} oauth - { rateLimitTier, subscriptionType }
 * @returns {string|null}
 */
function derivePlan(oauth) {
    if (!oauth || typeof oauth !== 'object') return null;

    const tier = typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : '';
    if (tier === 'default_claude_max_20x') return 'Max 20x';
    if (tier === 'default_claude_max_5x') return 'Max 5x';
    if (tier.includes('max')) return 'Max';
    if (tier.includes('pro')) return 'Pro';
    if (tier.includes('free')) return 'Free';

    const sub = oauth.subscriptionType;
    if (typeof sub === 'string' && sub.length > 0) {
        return sub.charAt(0).toUpperCase() + sub.slice(1);
    }
    return null;
}

class ClaudeOAuthQuotaReader {
    /**
     * @param {object} [options]
     * @param {() => Promise<object|null>} [options.loadCredentials] - override credential loader (tests).
     * @param {(token: string, ua: string) => Promise<{status:number, body:object|null}>} [options.fetchUsage] - override HTTPS GET (tests).
     * @param {string} [options.userAgent] - override the User-Agent value (tests).
     */
    constructor(options = {}) {
        this.loadCredentials = options.loadCredentials || defaultLoadCredentials;
        this.fetchUsage = options.fetchUsage || defaultFetchUsage;
        this.userAgent = options.userAgent || getClaudeUserAgent();
    }

    /**
     * Read the current Claude quota from the OAuth usage endpoint, or null.
     * Never throws.
     * @returns {Promise<object|null>} a QuotaSnapshot, or null if unavailable.
     */
    async getQuota() {
        try {
            const oauth = await this.loadCredentials();
            const accessToken = oauth && typeof oauth === 'object' ? oauth.accessToken : null;
            if (!accessToken) return null;

            const { status, body } = await this.fetchUsage(accessToken, this.userAgent);
            if (status !== 200 || !body || typeof body !== 'object') return null;

            const limits = Array.isArray(body.limits) ? body.limits : [];
            const windows = [];
            for (const limit of limits) {
                const win = limitToWindow(limit);
                if (win) windows.push(win);
            }
            if (windows.length === 0) return null;

            return makeSnapshot({
                agent: 'claude',
                provider: 'anthropic',
                plan: derivePlan(oauth),
                windows,
                fetchedAt: Date.now(),
                source: 'oauth'
            });
        } catch (_err) {
            return null;
        }
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new ClaudeOAuthQuotaReader();
    }
    return instance;
}

module.exports = {
    ClaudeOAuthQuotaReader,
    getInstance,
    derivePlan,
    limitToWindow,
    getClaudeUserAgent,
    defaultFetchUsage,
    REQUEST_TIMEOUT_MS,
    CREDENTIAL_READ_STATUS,
    credentialStateFromRaw,
    isConfirmedKeychainAbsence,
    isConfirmedCredentialFileAbsence,
    // Exported so ClaudeAccountWatcher identifies the logged-in account from the
    // exact same credential this reader uses, instead of duplicating the lookup.
    defaultLoadCredentials,
    defaultReadCredentialState
};
