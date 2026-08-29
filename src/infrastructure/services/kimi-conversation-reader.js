/**
 * Kimi Conversation Reader
 *
 * Reads Kimi Code CLI conversation history from the local filesystem. All facts
 * below were verified against a real ~/.kimi-code produced by kimi-code v0.26.0:
 *
 *   ~/.kimi-code/session_index.jsonl
 *       one JSON object per line: { sessionId, sessionDir, workDir } — the global
 *       index across ALL working directories (cheapest possible enumeration).
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/state.json
 *       { createdAt, updatedAt (ISO strings), title, isCustomTitle, workDir, agents }
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl
 *       the main agent's event stream (transcript). Also carries request traces.
 *
 * workDirKey = `wd_<slug>_<sha256(normalizedWorkDir).slice(0,12)>` (confirmed against
 * real on-disk data), but we never need to COMPUTE it: session_index.jsonl already
 * maps sessionId -> sessionDir + workDir.
 *
 * The whole store is plain JSON/JSONL — no sqlite, no native modules. Everything
 * here is sync fs with small files and per-file mtime caching (the codex-reader
 * lesson: never readFileSync entire large files just for metadata).
 *
 * NOTE on wire.jsonl message shapes: the event format is not publicly documented,
 * so extraction is defensive — we recognize objects carrying role+content in the
 * common shapes ({role, content}, {message:{role, content}}, typed events) and
 * skip everything else. Unknown shapes degrade to fewer messages, never a throw.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Cap how much of a wire.jsonl we scan for messages: transcripts carry tool schemas
// and request traces that can grow large; 8 MB of tail is plenty for the history UI.
const WIRE_SCAN_BYTE_CAP = 8 * 1024 * 1024;
const MAX_FIRST_USER_SCAN_LINES = 200;

/** Module-level cache: stateJsonPath -> { mtimeMs, session } */
const stateCache = new Map();

function getDataRoot() {
    const override = (process.env.KIMI_CODE_HOME || '').trim();
    return override || path.join(os.homedir(), '.kimi-code');
}

function getSessionIndexPath() {
    return path.join(getDataRoot(), 'session_index.jsonl');
}

function getSessionsDir() {
    return path.join(getDataRoot(), 'sessions');
}

/**
 * Read the global session index. Falls back to scanning sessions/<wd>/<sid>/ dirs
 * when the index file is missing (e.g. wiped by the user but sessions kept).
 * @returns {Array<{sessionId: string, sessionDir: string, workDir: string}>}
 */
function readSessionIndex() {
    const indexPath = getSessionIndexPath();
    const entries = [];
    const seen = new Set();

    try {
        if (fs.existsSync(indexPath)) {
            const raw = fs.readFileSync(indexPath, 'utf8');
            for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const obj = JSON.parse(trimmed);
                    if (obj && obj.sessionId && obj.sessionDir && !seen.has(obj.sessionId)) {
                        seen.add(obj.sessionId);
                        entries.push({
                            sessionId: obj.sessionId,
                            sessionDir: obj.sessionDir,
                            workDir: obj.workDir || null
                        });
                    }
                } catch (_err) { /* skip malformed line */ }
            }
        }
    } catch (_err) { /* fall through to directory scan */ }

    if (entries.length > 0) return entries;

    // Fallback: enumerate sessions/<workDirKey>/<sessionId>/ directly.
    try {
        const sessionsDir = getSessionsDir();
        if (!fs.existsSync(sessionsDir)) return entries;
        for (const wdEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!wdEntry.isDirectory()) continue;
            const wdPath = path.join(sessionsDir, wdEntry.name);
            let children;
            try {
                children = fs.readdirSync(wdPath, { withFileTypes: true });
            } catch (_err) { continue; }
            for (const sEntry of children) {
                if (!sEntry.isDirectory() || seen.has(sEntry.name)) continue;
                seen.add(sEntry.name);
                entries.push({
                    sessionId: sEntry.name,
                    sessionDir: path.join(wdPath, sEntry.name),
                    workDir: null // resolved lazily from state.json
                });
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
 * Read one session's state.json (mtime-cached). Returns the reader session object
 * or null when unreadable.
 * @param {{sessionId: string, sessionDir: string, workDir: string|null}} indexEntry
 */
function readSessionState(indexEntry) {
    const statePath = path.join(indexEntry.sessionDir, 'state.json');
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(statePath).mtimeMs;
    } catch (_err) {
        return null;
    }

    const cached = stateCache.get(statePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.session;

    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const createdAt = toMs(parsed.createdAt);
        // Prefer the wire.jsonl mtime as the activity timestamp: state.json's updatedAt
        // does not necessarily bump on every message, the transcript file does.
        let activityMs = toMs(parsed.updatedAt);
        try {
            const wirePath = path.join(indexEntry.sessionDir, 'agents', 'main', 'wire.jsonl');
            const wireMtime = fs.statSync(wirePath).mtimeMs;
            if (!activityMs || wireMtime > activityMs) activityMs = wireMtime;
        } catch (_err) { /* no wire file yet */ }

        const session = {
            sessionId: indexEntry.sessionId,
            sessionDir: indexEntry.sessionDir,
            title: typeof parsed.title === 'string' ? parsed.title : '',
            isCustomTitle: !!parsed.isCustomTitle,
            projectPath: parsed.workDir || indexEntry.workDir || null,
            createdAt: createdAt,
            updatedAt: activityMs,
            timestamp: activityMs || createdAt || mtimeMs,
            filePath: statePath
        };
        stateCache.set(statePath, { mtimeMs, session });
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
            timestamp = fs.statSync(path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl')).mtimeMs;
        } catch (_err) {
            try {
                timestamp = fs.statSync(path.join(entry.sessionDir, 'state.json')).mtimeMs;
            } catch (_err2) { /* dead entry */ }
        }
        if (timestamp != null) {
            rows.push({ sessionId: entry.sessionId, timestamp, workDir: entry.workDir });
        }
    }
    return rows;
}

// Comparison key for "same working directory?" — mirrors kimi-code's own
// workspaceRootKey (workdir-key.ts): slash-normalize, strip trailing
// separators, case-fold Windows-shaped paths (drive-letter or UNC; NTFS is
// case-insensitive by default). Kimi records the index workDir NORMALIZED
// (win32.resolve + backslash->forward slash), so on Windows the stored
// `C:/Users/...` must compare equal to the app's backslashed `C:\Users\...`
// terminal path. Shape-based, not process.platform, matching kimi's design
// (consistent folding in tests on any host); POSIX paths never fold. The
// shape is tested BEFORE stripping trailing separators, so a bare drive
// root (`C:\` -> `C:`) cannot escape the case-fold.
const WIN_SHAPED_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;
function workDirCompareKey(p) {
    const slashed = String(p).replace(/\\/g, '/');
    const shaped = WIN_SHAPED_PATH_RE.test(slashed);
    const normalized = slashed.replace(/\/+$/, '');
    return shaped ? normalized.toLowerCase() : normalized;
}

/**
 * Whether any Kimi session exists for the given project path.
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
 * separators ignored), newest-activity first. Same result shape the other
 * agents' getSessionsForProject readers return, so the per-agent branches of
 * the session-detection IPC handlers consume them interchangeably.
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
 * The exact workDir a session was created in, or null. Kimi keys its store by
 * sha256(workDir) and `kimi --session <id>` refuses to start from any other
 * directory, so this is the ONLY valid launch dir for resuming the session.
 * @param {string} sessionId
 * @returns {string|null}
 */
function getSessionWorkDir(sessionId) {
    if (!sessionId) return null;
    for (const entry of readSessionIndex()) {
        if (entry.sessionId !== sessionId) continue;
        if (entry.workDir) return entry.workDir;
        // Directory-scan fallback entries carry workDir:null; state.json has it.
        const session = readSessionState(entry);
        return (session && session.projectPath) || null;
    }
    return null;
}

function findSessionDir(sessionId) {
    if (!sessionId) return null;
    for (const entry of readSessionIndex()) {
        if (entry.sessionId === sessionId) return entry.sessionDir;
    }
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
 * typed parts ({type:'text', text} being the interesting one).
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

/**
 * Map one wire.jsonl event to a {role, content, timestamp} message, or null.
 * Recognizes the common shapes defensively (the format is undocumented).
 */
function eventToMessage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // Shape A: the event IS the message ({role, content}).
    let role = obj.role;
    let content = obj.content;

    // Shape B: nested message object.
    if (!role && obj.message && typeof obj.message === 'object') {
        role = obj.message.role;
        content = obj.message.content;
    }

    // Shape C: typed events ("user_message"/"assistant_message"/"message.user"...).
    if (!role && typeof obj.type === 'string') {
        const t = obj.type.toLowerCase();
        if (t.includes('user') && (obj.text !== undefined || obj.content !== undefined)) {
            role = 'user';
            content = obj.content !== undefined ? obj.content : obj.text;
        } else if (t.includes('assistant') && (obj.text !== undefined || obj.content !== undefined)) {
            role = 'assistant';
            content = obj.content !== undefined ? obj.content : obj.text;
        }
    }

    if (role !== 'user' && role !== 'assistant') return null;
    const text = extractText(content);
    if (!text || !text.trim()) return null;

    return {
        role,
        content: text,
        timestamp: toMs(obj.time || obj.timestamp || obj.created_at || obj.createdAt) || null
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
        const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
        if (!fs.existsSync(wirePath)) return [];

        const messages = [];
        for (const line of readTailLines(wirePath, WIRE_SCAN_BYTE_CAP)) {
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
 * @param {string} sessionId
 * @returns {string|null}
 */
function getFirstUserText(sessionId) {
    try {
        const sessionDir = findSessionDir(sessionId);
        if (!sessionDir) return null;
        const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
        if (!fs.existsSync(wirePath)) return null;

        let scanned = 0;
        for (const line of readTailLines(wirePath, WIRE_SCAN_BYTE_CAP)) {
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
    extractText
};
