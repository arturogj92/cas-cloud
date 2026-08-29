/**
 * Claude background-agent detection helper.
 *
 * A Claude Code session that is currently running as a *background agent*
 * cannot be resumed with `claude -r <id>`: Claude rejects the double-resume,
 * prints "Open claude agents to attach to it, or run: claude --resume <id>
 * --fork-session" and exits 1. The TUI swallows that message, so the user only
 * sees "Process exited with code: 1".
 *
 * These helpers query `claude agents --json` and extract the sessionIds that
 * are currently live as background agents, so callers can either hide them from
 * the resume list or transparently switch to `--fork-session`.
 *
 * Best-effort: any failure (older CLI without the `agents` subcommand, timeout,
 * non-JSON output) resolves to an empty Set, which makes callers fall back to
 * the normal (non-fork) behaviour.
 */

/**
 * Parse the stdout of `claude agents --json` into the set of sessionIds that
 * are running as BACKGROUND agents. Interactive sessions are intentionally
 * excluded (they resume fine).
 * @param {string} jsonString - stdout of `claude agents --json`
 * @returns {Set<string>} sessionIds of running background agents
 */
function parseBackgroundAgentSessionIds(jsonString) {
    const ids = new Set();
    let parsed;
    try {
        parsed = JSON.parse(jsonString);
    } catch {
        return ids;
    }
    if (!Array.isArray(parsed)) {
        return ids;
    }
    for (const agent of parsed) {
        if (agent && agent.kind === 'background' && typeof agent.sessionId === 'string') {
            ids.add(agent.sessionId);
        }
    }
    return ids;
}

/**
 * Query Claude Code for the sessions that are currently running as BACKGROUND
 * agents via `claude agents --json`. Best-effort: any failure resolves to an
 * empty Set so callers keep working (they just won't fork).
 * @returns {Promise<Set<string>>} sessionIds of running background agents
 */
async function getBackgroundAgentSessionIds() {
    let claudePath = 'claude';
    try {
        claudePath = require('../claude-code-installer').getClaudePath() || 'claude';
    } catch {
        // Installer not available: fall back to PATH lookup of `claude`.
    }

    try {
        const { execFile } = require('child_process');
        const stdout = await new Promise((resolve, reject) => {
            execFile(
                claudePath,
                ['agents', '--json'],
                { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
                (error, out) => (error ? reject(error) : resolve(out))
            );
        });
        return parseBackgroundAgentSessionIds(stdout);
    } catch (error) {
        console.warn('[Claude BG Agents] Could not list background agents:', error.message);
        return new Set();
    }
}

/**
 * Whether a specific sessionId is currently running as a background agent.
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function isSessionRunningAsBackgroundAgent(sessionId) {
    if (!sessionId) {
        return false;
    }
    const ids = await getBackgroundAgentSessionIds();
    return ids.has(sessionId);
}

module.exports = {
    parseBackgroundAgentSessionIds,
    getBackgroundAgentSessionIds,
    isSessionRunningAsBackgroundAgent
};
