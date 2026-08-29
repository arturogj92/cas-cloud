/**
 * Opencode Conversation Reader
 *
 * Reads and parses opencode CLI conversation history from its local SQLite
 * database. Drop-in sibling of codex-conversation-reader.js and
 * antigravity-conversation-reader.js: exposes hasConversationsForProject etc.
 * and fails safe (never throws → returns false/empty).
 *
 * ── On-disk layout (verified on opencode v1.17.13) ──────────────────────────
 * A single WAL-mode SQLite database at:
 *   (XDG_DATA_HOME || ~/.local/share)/opencode/opencode.db
 *
 * Relevant tables:
 *   session(id TEXT PK, project_id, parent_id, slug, directory, title, agent,
 *           model, time_created INTEGER ms, time_updated INTEGER ms,
 *           time_archived INTEGER NULL)
 *     - parent_id is NON-NULL for subagent/child sessions → excluded here.
 *     - directory is the cwd the session ran in (== projectPath).
 *     - time_archived may not exist in older DBs → queried defensively.
 *   message(id TEXT PK, session_id, time_created ms, data TEXT = JSON
 *           {"role":"user"|"assistant", ...})
 *   part(id TEXT PK, message_id, session_id, time_created ms, data TEXT = JSON
 *        {"type":"text","text":"..."}; other types: reasoning, step-*, tool)
 *
 * better-sqlite3 is a native Electron module, so it is lazy-loaded inside a
 * guarded opener that unit tests can replace via __setDatabaseOpenerForTests.
 * The db path is resolved at call time (env may change) and every public method
 * opens/queries/closes the db, returning its empty/false fallback on ANY error.
 */

const path = require('path');
const os = require('os');

/**
 * Default database opener. Kept as a named reference so the test seam can reset
 * back to it. Lazy-requires better-sqlite3 so plain-node consumers (Jest) that
 * inject a fake never touch the native module.
 * @param {string} dbPath
 * @returns {object} better-sqlite3 Database instance (readonly)
 */
const defaultDatabaseOpener = (dbPath) => {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true, fileMustExist: true });
};

let _openDatabase = defaultDatabaseOpener;

/**
 * Test seam: inject a fake db opener. Passing null (or nothing) restores the
 * real better-sqlite3 opener.
 * @param {((dbPath: string) => object)|null} fn
 */
function __setDatabaseOpenerForTests(fn) {
    _openDatabase = fn || defaultDatabaseOpener;
}

/**
 * Resolves the opencode SQLite database path. Honors XDG_DATA_HOME, defaulting
 * to ~/.local/share. Resolved at call time so env overrides (and tests) apply.
 * @returns {string}
 */
function getDbPath() {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'opencode', 'opencode.db');
}

/**
 * Toggles a single trailing path separator, so directory lookups match whether
 * the project path was stored with or without it. Pure helper.
 * @param {string} p
 * @returns {string}
 */
function toggleTrailingSlash(p) {
    if (typeof p !== 'string') return p;
    return p.endsWith('/') ? p.replace(/\/+$/, '') : `${p}/`;
}

/**
 * Opens the db, runs `fn(db)`, and always closes it. Returns `fallback` on any
 * error (native module missing, missing file, malformed query). Never throws.
 * @template T
 * @param {(db: object) => T} fn
 * @param {T} fallback
 * @returns {T}
 */
function withDb(fn, fallback) {
    let db;
    try {
        db = _openDatabase(getDbPath());
    } catch (error) {
        console.error('[Opencode] Failed to open database:', error.message);
        return fallback;
    }
    try {
        return fn(db);
    } catch (error) {
        console.error('[Opencode] Query error:', error.message);
        return fallback;
    } finally {
        try {
            if (db && typeof db.close === 'function') db.close();
        } catch {
            // closing a readonly db should not fail; ignore if it does
        }
    }
}

/**
 * Queries top-level (parent_id IS NULL) sessions, most-recent first. Tries the
 * `time_archived IS NULL` predicate first and retries without it when the column
 * is absent (older DBs), so it stays compatible across opencode versions.
 * @param {object} db
 * @param {{ directory?: string|null, limit?: number }} options
 * @returns {Array<object>} raw session rows
 */
function selectSessionRows(db, { directory = null, limit = 200 } = {}) {
    const columns = 'SELECT id, title, directory, time_created, time_updated FROM session WHERE ';
    const orderLimit = ' ORDER BY time_updated DESC LIMIT ?';

    const where = ['parent_id IS NULL'];
    const params = [];
    if (directory != null) {
        where.push('(directory = ? OR directory = ?)');
        params.push(directory, toggleTrailingSlash(directory));
    }

    try {
        const sql = columns + [...where, 'time_archived IS NULL'].join(' AND ') + orderLimit;
        return db.prepare(sql).all(...params, limit);
    } catch {
        // Older DBs may not have a time_archived column — retry without it.
        const sql = columns + where.join(' AND ') + orderLimit;
        return db.prepare(sql).all(...params, limit);
    }
}

/**
 * Maps a raw session row to the reader's session object shape (mirrors the
 * codex reader's field names so the search service + main.js consume them
 * interchangeably). The synthetic `filePath` (dbPath#sessionId) gives the
 * history index a unique per-conversation key — opencode has no per-session file.
 * @param {object} row
 * @param {string} dbPath
 * @returns {object}
 */
function mapSessionRow(row, dbPath) {
    return {
        sessionId: row.id,
        title: row.title || '',
        projectPath: row.directory || '',
        projectDir: row.directory || '',
        timestamp: row.time_updated,
        createdAt: row.time_created,
        updatedAt: row.time_updated,
        agent: 'opencode',
        isOpencode: true,
        filePath: `${dbPath}#${row.id}`
    };
}

/**
 * True when at least one top-level opencode session exists.
 * @returns {boolean}
 */
function hasConversations() {
    return withDb((db) => selectSessionRows(db, { limit: 1 }).length > 0, false);
}

/**
 * True when at least one top-level opencode session ran in `projectPath`.
 * Matches with and without a trailing separator. Rejects the sandbox/empty path.
 * @param {string} projectPath
 * @returns {boolean}
 */
function hasConversationsForProject(projectPath) {
    if (!projectPath || projectPath === '__sandbox__') return false;
    return withDb(
        (db) => selectSessionRows(db, { directory: projectPath, limit: 1 }).length > 0,
        false
    );
}

/**
 * All top-level opencode sessions, most-recent first, capped at `limit`.
 * @param {number} limit
 * @returns {Array<object>}
 */
function getAllSessions(limit = 200) {
    const dbPath = getDbPath();
    return withDb(
        (db) => selectSessionRows(db, { limit }).map(row => mapSessionRow(row, dbPath)),
        []
    );
}

/**
 * Top-level opencode sessions for a project, most-recent first.
 * @param {string} projectPath
 * @param {number} limit
 * @returns {Array<object>}
 */
function getSessionsForProject(projectPath, limit = 200) {
    if (!projectPath || projectPath === '__sandbox__') return [];
    const dbPath = getDbPath();
    return withDb(
        (db) => selectSessionRows(db, { directory: projectPath, limit }).map(row => mapSessionRow(row, dbPath)),
        []
    );
}

/**
 * The directory a session ran in (`session.directory`), or null.
 *
 * opencode resumes `--session <id>` from anywhere (its store is one global db,
 * not keyed by cwd), so a wrong launch dir does not fail loudly — the agent just
 * reads and writes the WRONG checkout. That silence is why this lookup matters:
 * the terminal must be born in the recorded directory. Sub-sessions are excluded
 * for the same reason as everywhere else (parent_id IS NOT NULL = subagent).
 * @param {string} sessionId
 * @returns {string|null}
 */
function getSessionWorkDir(sessionId) {
    if (!sessionId) return null;
    return withDb((db) => {
        const row = db
            .prepare('SELECT directory FROM session WHERE id = ? AND parent_id IS NULL')
            .get(sessionId);
        return (row && row.directory) || null;
    }, null);
}

/**
 * Newest top-level opencode session for a project, or null.
 * @param {string} projectPath
 * @returns {object|null}
 */
function getLatestSessionForProject(projectPath) {
    const sessions = getSessionsForProject(projectPath, 1);
    return sessions.length > 0 ? sessions[0] : null;
}

/**
 * Ordered messages for a session as [{ role, content, timestamp }]. `role` comes
 * from message.data JSON; `content` is the concatenation of that message's `part`
 * rows whose data.type === 'text'. Non-text parts and unparseable rows are
 * skipped; messages with no text are omitted (nothing to render).
 * @param {string} sessionId
 * @returns {Array<{role: string, content: string, timestamp: number}>}
 */
function getSessionMessages(sessionId) {
    if (!sessionId) return [];
    return withDb((db) => {
        const messageRows = db
            .prepare('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created')
            .all(sessionId);
        const partRows = db
            .prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created')
            .all(sessionId);

        // Concatenate the text parts of each message, keyed by message_id.
        const textByMessage = new Map();
        for (const part of partRows) {
            let parsed;
            try {
                parsed = JSON.parse(part.data);
            } catch {
                continue; // skip unparseable part rows
            }
            if (!parsed || parsed.type !== 'text' || typeof parsed.text !== 'string') continue;
            const prev = textByMessage.get(part.message_id);
            textByMessage.set(part.message_id, prev ? `${prev}\n${parsed.text}` : parsed.text);
        }

        const messages = [];
        for (const message of messageRows) {
            const content = textByMessage.get(message.id);
            if (!content) continue; // message has no rendered text (e.g. tool-only turn)

            let role;
            try {
                role = JSON.parse(message.data).role;
            } catch {
                role = null;
            }

            messages.push({
                role: role || 'assistant',
                content,
                timestamp: message.time_created
            });
        }
        return messages;
    }, []);
}

/**
 * Text of the first user message in a session, used as a display fallback when
 * the session title is auto-generated. '' when none.
 * @param {string} sessionId
 * @returns {string}
 */
function getFirstUserText(sessionId) {
    const firstUser = getSessionMessages(sessionId).find(m => m.role === 'user');
    return firstUser ? firstUser.content : '';
}

module.exports = {
    getDbPath,
    hasConversations,
    hasConversationsForProject,
    getAllSessions,
    getSessionsForProject,
    getSessionWorkDir,
    getLatestSessionForProject,
    getSessionMessages,
    getFirstUserText,
    __setDatabaseOpenerForTests
};
