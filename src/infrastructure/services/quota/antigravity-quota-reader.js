/**
 * AntigravityQuotaReader
 *
 * Reads Google Antigravity usage quota from its local loopback language server.
 * The quota summary is a plain POST with an empty body:
 *
 *   POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
 *   Content-Type: application/json, body {}
 *
 * There are TWO sources of that server, and we try BOTH:
 *   1. The Antigravity DESKTOP APP language server — PERSISTENT: it is up
 *      whenever the app runs, even while idle, so it is the reliable path. It
 *      requires an `X-Codeium-Csrf-Token` header, whose value is on the process
 *      command line (`--csrf_token=<tok>`).
 *   2. The `agy` CLI language server — TRANSIENT: only up WHILE agy is
 *      generating. It needs NO CSRF token.
 *
 * Discovery is per-platform, because it needs the process table joined with each
 * process's listening loopback sockets:
 *   - mac/linux: `ps -ax -o pid=,command=` plus `lsof` per candidate pid.
 *   - Windows:   `windows-process-ports.js` (PowerShell, netstat fallback).
 * Windows classification is deliberately LOOSER than mac's: any process whose
 * command line looks Antigravity-related becomes a candidate, and every endpoint
 * is retried WITHOUT the CSRF token when the first attempt fails. Getting the
 * app-vs-CLI split wrong there would otherwise silently yield no quota.
 *
 * Every entry point degrades to null and NEVER throws.
 *
 * Discovery and the https call are injectable so tests need neither a real
 * process table nor real network.
 */
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { makeWindow, makeSnapshot } = require('../../../domain/value-objects/quota-snapshot');
const { listLoopbackListeners } = require('./windows-process-ports');

const execFileAsync = promisify(execFile);

// The language-server RPC that returns the quota summary.
const QUOTA_PATH =
    '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const REQUEST_TIMEOUT_MS = 4000;

// Windows discovery costs a PowerShell spawn (~0.3-0.7s), and quota refreshes on
// EVERY window focus as well as on the 90s poller. This TTL keeps focus churn
// from spawning a console every time the user comes back to the app; it is short
// enough that a freshly started agy is picked up by the next poll.
const WINDOWS_DISCOVERY_TTL_MS = 25 * 1000;

class AntigravityQuotaReader {
    constructor() {
        // Windows-only short-lived discovery cache: { at, endpoints }.
        this._discoveryCache = null;
    }

    /**
     * Lowercase a command line and turn Windows backslashes into forward
     * slashes, so one set of path predicates works on every platform.
     * @param {string} value
     * @returns {string}
     */
    _normalizePath(value) {
        return String(value == null ? '' : value).replace(/\\/g, '/').toLowerCase();
    }

    /**
     * The executable part of a command line. Windows quotes paths that contain
     * spaces (`"C:\Program Files\x\agy.exe" --flag`), so a quoted head is read
     * up to its closing quote instead of being split on whitespace.
     * @param {string} command
     * @returns {string}
     */
    _executableOf(command) {
        const raw = String(command == null ? '' : command).trim();
        if (!raw) return '';
        if (raw[0] === '"') {
            const closing = raw.indexOf('"', 1);
            return closing === -1 ? raw.slice(1) : raw.slice(1, closing);
        }
        return raw.split(/\s+/)[0] || '';
    }

    /**
     * True when the process command line is the Antigravity DESKTOP-APP language
     * server (persistent, needs a CSRF token): a `language_server` command scoped
     * to the antigravity app data dir / install path. Separator- and
     * case-insensitive, so it matches both
     * `/Applications/Antigravity.app/...` and
     * `C:\Users\x\AppData\Local\Programs\Antigravity\...`.
     * @param {string} command
     * @returns {boolean}
     */
    _isAppLanguageServer(command) {
        if (typeof command !== 'string') return false;
        const normalized = this._normalizePath(command);
        if (!normalized.includes('language_server')) return false;
        return (
            /--app_data_dir[ =]\S*antigravity/.test(normalized) ||
            normalized.includes('/antigravity')
        );
    }

    /**
     * Extract the CSRF token from a desktop-app language-server command line
     * (`--csrf_token=<tok>` or `--csrf_token <tok>`). Null when absent.
     * Runs on the RAW command line — the token is case-sensitive.
     * @param {string} command
     * @returns {string|null}
     */
    _extractCsrfToken(command) {
        const match = String(command || '').match(/--csrf_token[ =]"?([^\s"]+)/);
        return match ? match[1] : null;
    }

    /**
     * True when the process is the real `agy` CLI binary. Only the EXECUTABLE is
     * inspected, so a command that merely CONTAINS the substring "agy" (e.g.
     * `/bin/zsh -c legacy-thing`) is not matched. Windows launcher extensions
     * (.exe/.cmd/.bat) are accepted.
     * @param {string} command
     * @returns {boolean}
     */
    _isAgyCli(command) {
        if (typeof command !== 'string') return false;
        const exe = this._normalizePath(this._executableOf(command));
        return /(^|\/)agy(\.exe|\.cmd|\.bat)?$/.test(exe);
    }

    /**
     * Loose Windows-only net: anything mentioning antigravity or a language
     * server is worth probing, even when it matches neither strict predicate.
     * The netstat fallback only knows image names (`language_server_x64.exe`),
     * and the exact Windows binary layout is not pinned down, so this keeps an
     * unexpected shape from silently yielding no quota at all.
     * @param {string} command
     * @returns {boolean}
     */
    _looksAntigravityRelated(command) {
        if (typeof command !== 'string') return false;
        const normalized = this._normalizePath(command);
        return normalized.includes('antigravity') || normalized.includes('language_server');
    }

    /**
     * Read the loopback ports a pid is listening on, via lsof (mac/linux).
     * Never throws.
     * @param {string|number} pid
     * @param {(cmd: string, args: string[]) => Promise<{stdout: string}>} exec
     * @returns {Promise<number[]>}
     */
    async _listPorts(pid, exec) {
        const ports = new Set();
        try {
            const { stdout } = await exec('lsof', [
                '-nP',
                '-iTCP',
                '-sTCP:LISTEN',
                '-a',
                '-p',
                String(pid)
            ]);
            const matches = (stdout || '').matchAll(/127\.0\.0\.1:(\d+)/g);
            for (const match of matches) {
                const port = parseInt(match[1], 10);
                if (Number.isFinite(port)) ports.add(port);
            }
        } catch (_err) {
            // pid not inspectable — skip.
        }
        return Array.from(ports);
    }

    /**
     * Discover the language-server endpoints, classified into the persistent
     * desktop-APP servers (with their CSRF token) and the transient agy-CLI
     * servers. Never throws.
     *
     * `runProc` is injectable so tests use neither the real process table nor
     * real shells; `platform` is injectable so the Windows path is testable off
     * Windows. Injecting `runProc` also bypasses the Windows discovery cache, so
     * tests never leak state into each other.
     * @param {object} [deps]
     * @param {(cmd: string, args: string[], options?: object) => Promise<{stdout: string}>} [deps.runProc]
     * @param {string} [deps.platform]
     * @returns {Promise<{ app: Array<{port:number, csrfToken:string|null}>, cli: Array<{port:number}> }>}
     */
    async discoverEndpoints({ runProc, platform } = {}) {
        try {
            const currentPlatform = platform || process.platform;
            if (currentPlatform === 'win32') {
                return this._discoverWindowsEndpoints({ runProc });
            }
            return this._discoverUnixEndpoints({ runProc });
        } catch (_err) {
            return { app: [], cli: [] };
        }
    }

    /**
     * mac/linux discovery: scan `ps`, classify, then read each candidate's
     * listening loopback ports with `lsof`.
     * @param {object} deps
     * @returns {Promise<{app: Array<object>, cli: Array<object>}>}
     */
    async _discoverUnixEndpoints({ runProc }) {
        const exec = runProc || execFileAsync;

        let psOut = '';
        try {
            const { stdout } = await exec('ps', ['-ax', '-o', 'pid=,command=']);
            psOut = stdout || '';
        } catch (_err) {
            // ps unavailable — no quota.
            return { app: [], cli: [] };
        }

        const appProcs = []; // { pid, csrfToken }
        const cliProcs = []; // { pid }
        for (const rawLine of psOut.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            const parsed = line.match(/^(\d+)\s+(.*)$/);
            if (!parsed) continue;
            const pid = parsed[1];
            const command = parsed[2];

            if (this._isAppLanguageServer(command)) {
                appProcs.push({ pid, csrfToken: this._extractCsrfToken(command) });
            } else if (this._isAgyCli(command)) {
                cliProcs.push({ pid });
            }
        }

        const app = [];
        for (const proc of appProcs) {
            const ports = await this._listPorts(proc.pid, exec);
            for (const port of ports) app.push({ port, csrfToken: proc.csrfToken });
        }
        const cli = [];
        for (const proc of cliProcs) {
            const ports = await this._listPorts(proc.pid, exec);
            for (const port of ports) cli.push({ port });
        }
        return { app, cli };
    }

    /**
     * Windows discovery: one shell-out returns every loopback listener with its
     * command line already attached, so there is no per-pid second call.
     * Cached for a short TTL unless `runProc` is injected.
     * @param {object} deps
     * @returns {Promise<{app: Array<object>, cli: Array<object>}>}
     */
    async _discoverWindowsEndpoints({ runProc }) {
        const useCache = !runProc;
        if (useCache && this._discoveryCache) {
            const age = Date.now() - this._discoveryCache.at;
            if (age >= 0 && age < WINDOWS_DISCOVERY_TTL_MS) {
                return this._discoveryCache.endpoints;
            }
        }

        const listeners = await listLoopbackListeners({ runProc });
        const app = [];
        const cli = [];
        for (const listener of listeners) {
            if (!listener || !Array.isArray(listener.ports)) continue;
            const command = listener.command || '';

            if (this._isAppLanguageServer(command)) {
                const csrfToken = this._extractCsrfToken(command);
                for (const port of listener.ports) app.push({ port, csrfToken });
            } else if (this._isAgyCli(command) || this._looksAntigravityRelated(command)) {
                // The loose bucket keeps its token when it happens to carry one;
                // every endpoint is retried without a token anyway.
                const csrfToken = this._extractCsrfToken(command);
                for (const port of listener.ports) cli.push({ port, csrfToken });
            }
        }

        const endpoints = { app, cli };
        if (useCache) this._discoveryCache = { at: Date.now(), endpoints };
        return endpoints;
    }

    /**
     * Drop the Windows discovery cache so the next read re-scans. Called when
     * cached endpoints stopped answering (agy restarted on a new ephemeral port).
     */
    _invalidateDiscoveryCache() {
        this._discoveryCache = null;
    }

    /**
     * POST {} to the quota RPC on a loopback port and return the parsed JSON.
     * Accepts the self-signed localhost cert (rejectUnauthorized:false). The
     * `X-Codeium-Csrf-Token` header is sent only when a token is supplied (the
     * desktop-app server requires it; the agy CLI server does not).
     * @param {number} port
     * @param {string|null} [csrfToken]
     * @returns {Promise<object>}
     */
    fetchQuota(port, csrfToken) {
        return new Promise((resolve, reject) => {
            const body = '{}';
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            };
            if (csrfToken) headers['X-Codeium-Csrf-Token'] = csrfToken;
            const req = https.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: QUOTA_PATH,
                    method: 'POST',
                    rejectUnauthorized: false,
                    timeout: REQUEST_TIMEOUT_MS,
                    headers
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (err) {
                            reject(err);
                        }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy(new Error('Antigravity quota request timed out'));
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * Map the language-server response into a QuotaSnapshot, or null. Never throws.
     * Uses the FIRST group whose displayName includes "Gemini" — the primary
     * Antigravity quota.
     * @param {object} json
     * @returns {object|null}
     */
    mapResponse(json) {
        try {
            const groups =
                json && json.response && Array.isArray(json.response.groups)
                    ? json.response.groups
                    : null;
            if (!groups) return null;

            const geminiGroup = groups.find(
                (group) =>
                    group &&
                    typeof group.displayName === 'string' &&
                    group.displayName.includes('Gemini')
            );
            if (!geminiGroup || !Array.isArray(geminiGroup.buckets)) return null;

            const windows = [];
            for (const bucket of geminiGroup.buckets) {
                if (!bucket || typeof bucket !== 'object') continue;
                windows.push(
                    makeWindow({
                        key: bucket.window === '5h' ? '5h' : 'weekly',
                        label: bucket.displayName || null,
                        remainingFraction: bucket.remainingFraction,
                        resetsAt: bucket.resetTime
                            ? Date.parse(bucket.resetTime)
                            : null
                    })
                );
            }
            if (windows.length === 0) return null;

            return makeSnapshot({
                agent: 'antigravity',
                provider: 'google',
                plan: null,
                windows,
                fetchedAt: Date.now(),
                source: 'language-server'
            });
        } catch (_err) {
            return null;
        }
    }

    /**
     * Read the current Antigravity quota, or null if no server responds. Tries
     * the persistent desktop-APP servers first (with their CSRF token), then the
     * transient agy-CLI servers, and retries every endpoint WITHOUT a token when
     * the tokened attempt fails. Never throws. Discovery and the fetcher are
     * injectable for testing.
     * @param {object} [deps]
     * @param {() => Promise<{app: Array<{port:number, csrfToken:string|null}>, cli: Array<{port:number}>}>} [deps.discover]
     * @param {(port: number, csrfToken?: string|null) => Promise<object>} [deps.fetchQuota]
     * @returns {Promise<object|null>}
     */
    async getQuota({ discover, fetchQuota } = {}) {
        const doDiscover = discover || (() => this.discoverEndpoints());
        const doFetch = fetchQuota || ((port, csrfToken) => this.fetchQuota(port, csrfToken));
        try {
            const endpoints = await doDiscover();
            const app = endpoints && Array.isArray(endpoints.app) ? endpoints.app : [];
            const cli = endpoints && Array.isArray(endpoints.cli) ? endpoints.cli : [];
            // Desktop APP first: persistent and reliable (even while idle).
            const candidates = [...app, ...cli];

            for (const endpoint of candidates) {
                if (!endpoint) continue;
                const token = endpoint.csrfToken || null;
                // With the token when we have one, then without: a server that
                // rejects (or ignores) the header still gets a fair chance.
                const attempts = token ? [token, null] : [null];
                for (const attempt of attempts) {
                    try {
                        const json = await doFetch(endpoint.port, attempt);
                        const snapshot = this.mapResponse(json);
                        if (snapshot) return snapshot;
                    } catch (_err) {
                        // This attempt did not respond — try the next one.
                    }
                }
            }

            // Cached endpoints that answer nothing are stale (agy restarted on a
            // new ephemeral port), so force a re-scan on the next read.
            if (candidates.length > 0) this._invalidateDiscoveryCache();
            return null;
        } catch (_err) {
            return null;
        }
    }
}

// Singleton instance
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new AntigravityQuotaReader();
    }
    return instance;
}

module.exports = {
    AntigravityQuotaReader,
    getInstance,
    WINDOWS_DISCOVERY_TTL_MS
};
