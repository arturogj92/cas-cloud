/**
 * Grok Conversation Reader
 *
 * Reads Grok Build CLI conversation history from the local filesystem. All facts
 * below were verified against a real ~/.grok produced by grok v0.2.x:
 *
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/summary.json
 *       { info: { id, cwd }, session_summary, generated_title,
 *         created_at, updated_at, last_active_at (ISO strings), num_messages, ... }
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl
 *       one event per line, `type` in system/user/assistant/reasoning/tool_result.
 *       user/assistant `content` is a STRING or an ARRAY of {type:'text', text}.
 *
 * There is no global index file (only a `session_search.sqlite` we deliberately do
 * not touch), so enumeration is a two-level readdir: the encoded-cwd folders, then
 * the session-id folders inside them. `summary.json` is the per-session anchor —
 * a directory without one is not a countable session.
 *
 * The whole store is plain JSON/JSONL — no sqlite, no native modules. Everything
 * here is sync fs with small files and per-file mtime caching (the codex-reader
 * lesson: never readFileSync entire large files just for metadata).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
// Worktree → parent fold so hasConversationsForProject / getSessionsForProject
// treat a session recorded inside `.codeagentswarm/worktrees/<slug>` as belonging
// to the parent repo. Without this, resume/session-detection on a monorepo path
// (or the reverse: project=worktree vs stored parent) misses Grok sessions on
// every platform, including win2 where the same layout is used.
const { normalizeWorktreePath } = require('./claude-project-path-resolver');

// Cap how much of a chat_history.jsonl we scan for messages: transcripts carry tool
// results that can grow large; 8 MB of tail is plenty for the history UI.
const HISTORY_SCAN_BYTE_CAP = 8 * 1024 * 1024;
const MAX_FIRST_USER_SCAN_LINES = 200;

// Not a session directory: Grok's full-text index lives alongside the cwd folders.
const NON_SESSION_ENTRIES = new Set(['session_search.sqlite']);

/** Module-level cache: summaryJsonPath -> { mtimeMs, session } */
const summaryCache = new Map();

function getDataRoot() {
    const override = (process.env.GROK_HOME || '').trim();
    return override || path.join(os.homedir(), '.grok');
}

function getSessionsDir() {
    return path.join(getDataRoot(), 'sessions');
}

/**
 * Decode a `<encodeURIComponent(cwd)>` folder name back to a path, or null.
 * @param {string} name
 * @returns {string|null}
 */
function decodeCwdFolder(name) {
    try {
        const decoded = decodeURIComponent(name);
        return decoded && decoded !== name ? decoded : (decoded || null);
    } catch (_err) {
        return null;
    }
}

/**
 * Enumerate every session directory on disk.
 * @returns {Array<{sessionId: string, sessionDir: string, workDir: string|null}>}
 */
function readSessionIndex() {
    const entries = [];
    const seen = new Set();
    const sessionsDir = getSessionsDir();

    try {
        if (!fs.existsSync(sessionsDir)) return entries;
        for (const cwdEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!cwdEntry.isDirectory() || NON_SESSION_ENTRIES.has(cwdEntry.name)) continue;
            const cwdPath = path.join(sessionsDir, cwdEntry.name);
            const workDir = decodeCwdFolder(cwdEntry.name);

            let children;
            try {
                children = fs.readdirSync(cwdPath, { withFileTypes: true });
            } catch (_err) { continue; }

            for (const sEntry of children) {
                if (!sEntry.isDirectory() || seen.has(sEntry.name)) continue;
                const sessionDir = path.join(cwdPath, sEntry.name);
                // summary.json is the anchor: a directory without one is not a session.
                if (!fs.existsSync(path.join(sessionDir, 'summary.json'))) continue;
                seen.add(sEntry.name);
                entries.push({ sessionId: sEntry.name, sessionDir, workDir });
            }
        }
    } catch (_err) { /* nothing readable */ }

    return entries;
}

/**
 * Parse an ISO date string (or epoch number) into epoch ms, or null.
 */
function toMs(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Read one session's summary.json (mtime-cached). Returns the reader session object
 * or null when unreadable.
 * @param {{sessionId: string, sessionDir: string, workDir: string|null}} indexEntry
 */
function readSessionState(indexEntry) {
    const summaryPath = path.join(indexEntry.sessionDir, 'summary.json');
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(summaryPath).mtimeMs;
    } catch (_err) {
        return null;
    }

    const cached = summaryCache.get(summaryPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.session;

    try {
        const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        const info = parsed.info && typeof parsed.info === 'object' ? parsed.info : {};
        const createdAt = toMs(parsed.created_at);
        // Prefer the chat_history.jsonl mtime as the activity timestamp: summary.json's
        // last_active_at does not necessarily bump on every message, the transcript does.
        let activityMs = toMs(parsed.last_active_at || parsed.updated_at || parsed.created_at);
        try {
            const historyMtime = fs.statSync(path.join(indexEntry.sessionDir, 'chat_history.jsonl')).mtimeMs;
            if (!activityMs || historyMtime > activityMs) activityMs = historyMtime;
        } catch (_err) { /* no transcript yet */ }

        const title = (typeof parsed.generated_title === 'string' && parsed.generated_title)
            || (typeof parsed.session_summary === 'string' && parsed.session_summary)
            || '';

        const session = {
            sessionId: info.id || indexEntry.sessionId,
            sessionDir: indexEntry.sessionDir,
            title,
            projectPath: info.cwd || indexEntry.workDir || null,
            createdAt,
            updatedAt: activityMs,
            timestamp: activityMs || createdAt || mtimeMs,
            filePath: summaryPath
        };
        summaryCache.set(summaryPath, { mtimeMs, session });
        return session;
    } catch (_err) {
        return null;
    }
}

/**
 * All sessions, newest-activity first.
 * @param {number} limit
 * @returns {Array<object>}
 */
function getAllSessions(limit = 200) {
    const sessions = [];
    for (const entry of readSessionIndex()) {
        const session = readSessionState(entry);
        if (session) sessions.push(session);
    }
    sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return sessions.slice(0, limit);
}

/**
 * FAST enumeration for the history modal's get-index skeleton: id + mtime only,
 * no content reads (the skeleton must stay ~200ms).
 * @returns {Array<{sessionId: string, timestamp: number, workDir: string|null}>}
 */
function enumerateSessionsForIndex() {
    const rows = [];
    for (const entry of readSessionIndex()) {
        let timestamp = null;
        try {
            timestamp = fs.statSync(path.join(entry.sessionDir, 'chat_history.jsonl')).mtimeMs;
        } catch (_err) {
            try {
                timestamp = fs.statSync(path.join(entry.sessionDir, 'summary.json')).mtimeMs;
            } catch (_err2) { /* dead entry */ }
        }
        if (timestamp != null) {
            rows.push({ sessionId: entry.sessionId, timestamp, workDir: entry.workDir });
        }
    }
    return rows;
}

// Comparison key for "same working directory?" — worktree→parent first, then
// slash-normalize, strip trailing separators, case-fold Windows-shaped paths
// (drive-letter or UNC; NTFS is case-insensitive by default). Shape-based, not
// process.platform, so the folding is consistent in tests on any host; POSIX
// paths never case-fold. The shape is tested BEFORE stripping trailing
// separators, so a bare drive root (`C:\` -> `C:`) cannot escape the case-fold.
const WIN_SHAPED_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;
function workDirCompareKey(p) {
    // Attribute worktree cwds to their parent repo so project-level queries
    // (resume gate, latest-session, list-existing-ids) see the same identity
    // the history search service surfaces after normalizeWorktreePath.
    const identity = normalizeWorktreePath(p) || p;
    const slashed = String(identity).replace(/\\/g, '/');
    const shaped = WIN_SHAPED_PATH_RE.test(slashed);
    const normalized = slashed.replace(/\/+$/, '');
    return shaped ? normalized.toLowerCase() : normalized;
}

/**
 * Whether any Grok session exists for the given project path.
 * @param {string} projectPath
 * @returns {boolean}
 */
function hasConversationsForProject(projectPath) {
    if (!projectPath) return false;
    const target = workDirCompareKey(projectPath);
    for (const entry of readSessionIndex()) {
        const wd = entry.workDir || (readSessionState(entry) || {}).projectPath;
        if (wd && workDirCompareKey(wd) === target) return true;
    }
    return false;
}

/**
 * All sessions recorded for a project path (exact workDir match, trailing
 * separators ignored), newest-activity first. Same result shape the other agents'
 * getSessionsForProject readers return, so the per-agent branches of the
 * session-detection IPC handlers consume them interchangeably.
 * @param {string} projectPath
 * @returns {Array<object>}
 */
function getSessionsForProject(projectPath) {
    if (!projectPath) return [];
    const target = workDirCompareKey(projectPath);
    const sessions = [];
    for (const entry of readSessionIndex()) {
        const session = readSessionState(entry);
        if (!session || !session.projectPath) continue;
        if (workDirCompareKey(session.projectPath) !== target) continue;
        sessions.push(session);
    }
    sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return sessions;
}

/**
 * Most recent session id for a project path, or null (used by resume flows).
 * @param {string} projectPath
 * @returns {string|null}
 */
function getLatestSessionIdForProject(projectPath) {
    const sessions = getSessionsForProject(projectPath);
    return sessions.length > 0 ? sessions[0].sessionId : null;
}

/**
 * The exact workDir a session was created in, or null — the launch dir the resume
 * path needs so a conversation born in a worktree does not reopen in the parent
 * checkout. Targeted walk with an EARLY EXIT on the id match: this runs on the
 * terminal-open path, so it must never become a full history enumeration.
 * @param {string} sessionId
 * @returns {string|null}
 */
function getSessionWorkDir(sessionId) {
    if (!sessionId) return null;
    const sessionsDir = getSessionsDir();
    try {
        if (!fs.existsSync(sessionsDir)) return null;
        for (const cwdEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!cwdEntry.isDirectory() || NON_SESSION_ENTRIES.has(cwdEntry.name)) continue;
            const sessionDir = path.join(sessionsDir, cwdEntry.name, sessionId);
            if (!fs.existsSync(path.join(sessionDir, 'summary.json'))) continue;

            // summary.json's info.cwd is authoritative; the encoded folder name is the
            // fallback for a summary we cannot parse.
            const session = readSessionState({ sessionId, sessionDir, workDir: decodeCwdFolder(cwdEntry.name) });
            if (session && session.projectPath) return session.projectPath;
            return decodeCwdFolder(cwdEntry.name);
        }
    } catch (_err) { /* unreadable store */ }
    return null;
}

function findSessionDir(sessionId) {
    if (!sessionId) return null;
    const sessionsDir = getSessionsDir();
    try {
        if (!fs.existsSync(sessionsDir)) return null;
        for (const cwdEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!cwdEntry.isDirectory() || NON_SESSION_ENTRIES.has(cwdEntry.name)) continue;
            const sessionDir = path.join(sessionsDir, cwdEntry.name, sessionId);
            if (fs.existsSync(path.join(sessionDir, 'summary.json'))) return sessionDir;
        }
    } catch (_err) { /* unreadable store */ }
    return null;
}

/**
 * Read up to `byteCap` of a file's TAIL as utf8 lines (transcripts append at the
 * end; the oldest content is the least interesting when capped).
 */
function readTailLines(filePath, byteCap) {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - byteCap);
    const fd = fs.openSync(filePath, 'r');
    try {
        const length = stat.size - start;
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, start);
        let text = buf.toString('utf8');
        if (start > 0) {
            // Drop the (probably partial) first line of the tail window.
            const nl = text.indexOf('\n');
            text = nl === -1 ? '' : text.slice(nl + 1);
        }
        return text.split('\n');
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Extract plain text from a content value that may be a string or an array of
 * typed parts ({type:'text', text} being the interesting one). Grok emits BOTH
 * shapes on user/assistant lines, so both must be handled.
 */
function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const part of content) {
            if (typeof part === 'string') parts.push(part);
            else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
        }
        return parts.join('\n');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
}

const GROK_HOST_ENVELOPES = 'session-instructions|user_info|agent_transcripts|system-reminder|system|environment_context';

/**
 * Grok Build (and Chat's first-prompt preamble) wrap the real ask in host
 * envelopes. Those are not user bubbles: drop them and unwrap <user_query>.
 * Image chips are real attachments in Chat; the `[[Image N]]` tokens are not.
 * Grok also injects a `<system-reminder>` skill catalogue on the first Chat
 * turn; that dump must never render as the user's prompt.
 */
function cleanGrokUserText(text) {
    const original = String(text || '');
    let cleaned = original;
    let previous;
    do {
        previous = cleaned;
        cleaned = cleaned.replace(
            new RegExp(`^\\s*<(${GROK_HOST_ENVELOPES})\\b[^>]*>[\\s\\S]*?<\\/\\1>\\s*`, 'i'),
            ''
        );
    } while (cleaned !== previous);
    if (new RegExp(`^\\s*<(${GROK_HOST_ENVELOPES})\\b`, 'i').test(cleaned)) {
        return '';
    }
    const query = cleaned.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    cleaned = query ? query[1] : cleaned;
    cleaned = cleaned.replace(/\[\[Image\s+\d+\]\]/gi, '');
    // Streamed ACP chunks keep their trailing space so adjacent pieces still join.
    // Trim only when an envelope was actually removed.
    if (cleaned === original) return original;
    return cleaned.trim();
}

/**
 * Map one chat_history.jsonl line to a {role, content, timestamp} message, or null.
 * Grok tags each line with `type`; only user/assistant carry chat text (system,
 * reasoning and tool_result are skipped).
 */
function eventToMessage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    const type = typeof obj.type === 'string' ? obj.type : null;
    const role = type === 'user' || type === 'assistant'
        ? type
        : (obj.role === 'user' || obj.role === 'assistant' ? obj.role : null);
    if (!role) return null;

    const raw = extractText(obj.content);
    const text = role === 'user' ? cleanGrokUserText(raw) : raw;
    if (!text || !text.trim()) return null;

    return {
        role,
        content: text,
        timestamp: toMs(obj.timestamp || obj.time || obj.created_at || obj.createdAt) || null
    };
}

/**
 * The messages of one session, oldest first, in the {role, content, timestamp}
 * shape the other agents' search services return.
 * @param {string} sessionId
 * @returns {Array<object>}
 */
function getSessionMessages(sessionId) {
    try {
        const sessionDir = findSessionDir(sessionId);
        if (!sessionDir) return [];
        const historyPath = path.join(sessionDir, 'chat_history.jsonl');
        if (!fs.existsSync(historyPath)) return [];

        const messages = [];
        for (const line of readTailLines(historyPath, HISTORY_SCAN_BYTE_CAP)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = eventToMessage(JSON.parse(trimmed));
                if (msg) messages.push(msg);
            } catch (_err) { /* skip malformed line */ }
        }
        return messages;
    } catch (_err) {
        return [];
    }
}

/**
 * First user message text of a session (for display fallback), or null.
 * Prefer passing `sessionDir` when the caller already has it (search service
 * does) — otherwise we fall back to a store walk. Scanning every session's
 * display title used to call findSessionDir per row → O(n²) (Opus §3.5).
 * @param {string} sessionId
 * @param {string|null} [sessionDir]
 * @returns {string|null}
 */
function getFirstUserText(sessionId, sessionDir = null) {
    try {
        const dir = sessionDir || findSessionDir(sessionId);
        if (!dir) return null;
        const historyPath = path.join(dir, 'chat_history.jsonl');
        if (!fs.existsSync(historyPath)) return null;

        let scanned = 0;
        for (const line of readTailLines(historyPath, HISTORY_SCAN_BYTE_CAP)) {
            if (scanned++ > MAX_FIRST_USER_SCAN_LINES) break;
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = eventToMessage(JSON.parse(trimmed));
                if (msg && msg.role === 'user') return msg.content;
            } catch (_err) { /* skip */ }
        }
        return null;
    } catch (_err) {
        return null;
    }
}

module.exports = {
    getDataRoot,
    readSessionIndex,
    getAllSessions,
    enumerateSessionsForIndex,
    hasConversationsForProject,
    getSessionsForProject,
    getLatestSessionIdForProject,
    getSessionWorkDir,
    getSessionMessages,
    getFirstUserText,
    cleanGrokUserText
};
