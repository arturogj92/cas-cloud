/**
 * QuotaSnapshot value object
 *
 * Normalized quota model that ALL quota readers (Claude statusLine, Codex
 * rollout, Antigravity language server) return, so the navbar stays agnostic
 * of the source. Pure data helpers — no I/O, no native modules.
 */

// Severity threshold: a window at/below this remaining fraction is 'critical'.
const QUOTA_CRITICAL_THRESHOLD = 0.15;

// A snapshot older than this is considered stale (the ring dims, never lies).
const FRESHNESS_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Clamp a number into the 0..1 range.
 * @param {number} value
 * @returns {number}
 */
function clampFraction(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/**
 * Build a normalized quota window.
 * @param {object} params
 * @param {string} params.key - '5h' | 'weekly' | 'weekly_scoped'
 * @param {string} [params.label] - human-readable window label
 * @param {number} params.remainingFraction - 0..1 (1 = full)
 * @param {number|null} [params.resetsAt] - epoch ms, or null
 * @param {string|null} [params.model] - per-model scope, or null
 * @returns {object} window with derived `severity`
 */
function makeWindow({ key, label = null, remainingFraction, resetsAt = null, model = null }) {
    const clamped = clampFraction(remainingFraction);
    const severity = clamped <= QUOTA_CRITICAL_THRESHOLD ? 'critical' : 'normal';
    return {
        key,
        label,
        remainingFraction: clamped,
        resetsAt: resetsAt != null ? resetsAt : null,
        model,
        severity
    };
}

// Canonical window order for the popover, so every provider reads the same way.
// Each reader pushes windows in whatever order its source happens to return them
// (Claude's OAuth `limits[]`, Antigravity's `groups[].buckets[]`, Codex's
// primary/secondary), which left the 5-hour bar on top for one agent and at the
// bottom for the next. Normalizing here fixes every reader at once.
const WINDOW_KEY_RANK = { '5h': 0, weekly: 1 };

/**
 * Sort windows into the canonical order: account-level before per-model, and
 * shortest window first (5h before weekly). Stable for anything else.
 * @param {Array<object>} windows
 * @returns {Array<object>} a new, sorted array
 */
function sortWindows(windows) {
    const rank = (w) => {
        const scope = w && w.model ? 2 : 0; // per-model windows always last
        const key = WINDOW_KEY_RANK[w && w.key] != null ? WINDOW_KEY_RANK[w.key] : 1;
        return scope + key;
    };
    return windows.slice().sort((a, b) => rank(a) - rank(b));
}

/**
 * Build a normalized quota snapshot.
 * @param {object} params
 * @param {string} params.agent - 'claude' | 'codex' | 'antigravity'
 * @param {string} params.provider - 'anthropic' | 'openai' | 'google'
 * @param {string|null} [params.plan] - 'Max' | 'Plus' | 'Pro' | null
 * @param {Array<object>} params.windows - windows built with makeWindow
 * @param {number} [params.fetchedAt] - epoch ms (defaults to now)
 * @param {string|null} [params.source] - 'statusline' | 'rollout' | 'language-server'
 * @returns {object} snapshot with derived `tightest` and `stale`
 */
function makeSnapshot({ agent, provider, plan = null, windows: rawWindows = [], fetchedAt = Date.now(), source = null }) {
    // Canonical order so every provider's popover block reads the same way.
    const windows = sortWindows(rawWindows);

    // tightest = the window with the LEAST remaining fraction (drives the ring).
    // Per-model scoped windows (e.g. a single model like Fable being capped) are
    // EXCLUDED: the ring should reflect the account-level usage (5h / weekly), not
    // one model hitting its own sub-limit. Per-model windows still show in the popover.
    const ringWindows = windows.filter((w) => !w.model);
    const tightestPool = ringWindows.length ? ringWindows : windows;
    let tightest = null;
    for (const win of tightestPool) {
        if (!tightest || win.remainingFraction < tightest.remainingFraction) {
            tightest = win;
        }
    }

    const tightestSummary = tightest
        ? {
            remainingFraction: tightest.remainingFraction,
            severity: tightest.severity,
            resetsAt: tightest.resetsAt
        }
        : null;

    const stale = (Date.now() - fetchedAt) > FRESHNESS_TTL_MS;

    return {
        agent,
        provider,
        plan,
        windows,
        tightest: tightestSummary,
        fetchedAt,
        source,
        stale
    };
}

module.exports = {
    makeWindow,
    makeSnapshot,
    sortWindows,
    clampFraction,
    QUOTA_CRITICAL_THRESHOLD,
    FRESHNESS_TTL_MS
};
