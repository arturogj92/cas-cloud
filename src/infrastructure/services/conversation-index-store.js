/**
 * ConversationIndexStore
 * -----------------------
 * A small, dedicated, rebuildable SQLite cache of conversation METADATA
 * (title / first user message, working directory, mtime, size, ...) keyed by
 * absolute file path.
 *
 * Why it exists:
 *   Listing recent conversations used to re-parse the content of EVERY history
 *   file on every open (O(total conversations), ~6s cold for Claude with a few
 *   thousand files, the reported ~15s on slower/cold disks). The expensive part
 *   is opening + streaming each .jsonl. This store persists what we already
 *   extracted, so subsequent opens parse ONLY files whose (mtime,size) changed.
 *   After the first build, listing is just a stat-scan + indexed query (tens of ms),
 *   and it survives app restarts / cold OS file cache because the titles live in
 *   SQLite, not in the (uncached) files.
 *
 * It is a CACHE: safe to delete at any time; it self-heals by re-indexing.
 * Lives in its OWN database file so it can never corrupt or bloat the tasks DB,
 * and so the MCP standalone DB never needs to know about it.
 *
 * Robustness: if better-sqlite3 cannot be loaded (e.g. native module mismatch),
 * the store reports `available === false` and every method is a safe no-op, so
 * callers transparently fall back to their previous parse-everything behaviour.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Try electron's userData dir; fall back to ~/.codeagentswarm (MCP/standalone).
function resolveDefaultDbPath() {
    try {
        const { app } = require('electron');
        if (app && app.getPath) {
            return path.join(app.getPath('userData'), 'conversation-index.db');
        }
    } catch (_) { /* not in electron */ }
    const dir = path.join(os.homedir(), '.codeagentswarm');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return path.join(dir, 'conversation-index.db');
}

// Bump this whenever the parsing/normalization logic that fills the cached rows
// changes, so the version-mismatch handshake in _initSchema() blows the stale
// cache and the next launch re-parses every file with the new logic.
//   v1 -> v2: normalizeWorktreePath now attributes a per-conversation worktree
//   cwd ("<repo>/.codeagentswarm/worktrees/<slug>") to the PARENT repo, so the
//   stored project_path/project_name changed for worktree conversations. v1 rows
//   were written BEFORE that fix and hold a stale/empty project_path for those
//   conversations, which made them get hidden from history after a restart (the
//   search service drops rows whose cached workingDirectory is empty). Bumping to
//   v2 clears those rows so they are re-parsed with the parent-repo path and
//   surface again.
//   v2 -> v3: timestamp_ms now stores the LAST real message time (tail-scan of
//   the transcript) instead of file mtime for Claude conversations. Claude Code
//   appends metadata lines (ai-title/mode/permission-mode) on every session
//   reopen, so mtime made old conversations look updated "just now". v2 rows
//   hold mtime-based timestamps; blow the cache so they are recomputed.
const CURRENT_SCHEMA_VERSION = 3;

class ConversationIndexStore {
    /**
     * @param {string} [dbPath] override DB location (tests / benchmarks)
     */
    constructor(dbPath) {
        this.available = false;
        this.db = null;
        this._stmts = {};
        this.dbPath = dbPath || resolveDefaultDbPath();

        try {
            const Database = require('better-sqlite3');
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
            this.db.pragma('synchronous = NORMAL'); // cache data: durability not critical, speed is
            this._initSchema();
            this._prepareStatements();
            this.available = true;
        } catch (err) {
            // Native module missing/mismatched, disk error, etc. Degrade gracefully.
            console.warn('[ConversationIndexStore] Disabled (falling back to live parsing):', err.message);
            this.available = false;
        }
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_index (
                file_path           TEXT PRIMARY KEY,
                agent               TEXT NOT NULL,
                session_id          TEXT,
                legacy_session_id   TEXT,
                project_dir         TEXT,
                project_path        TEXT,
                project_name        TEXT,
                display_text        TEXT,
                has_user_message    INTEGER DEFAULT 0,
                parent_session_ids  TEXT,
                is_continuation     INTEGER DEFAULT 0,
                mtime_ms            REAL NOT NULL,
                size_bytes          INTEGER NOT NULL,
                timestamp_ms        REAL NOT NULL,
                indexed_at          INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_conv_agent_ts
                ON conversation_index(agent, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_conv_session
                ON conversation_index(session_id);
            CREATE TABLE IF NOT EXISTS conversation_index_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        `);

        // Schema version handshake — if we bump the parsing logic, blow the cache.
        const row = this.db.prepare(
            `SELECT value FROM conversation_index_meta WHERE key = 'schema_version'`
        ).get();
        const version = row ? parseInt(row.value, 10) : 0;
        if (version !== CURRENT_SCHEMA_VERSION) {
            this.db.exec('DELETE FROM conversation_index');
            this.db.prepare(
                `INSERT INTO conversation_index_meta(key, value) VALUES('schema_version', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            ).run(String(CURRENT_SCHEMA_VERSION));
        }
    }

    _prepareStatements() {
        this._stmts.upsert = this.db.prepare(`
            INSERT INTO conversation_index (
                file_path, agent, session_id, legacy_session_id, project_dir,
                project_path, project_name, display_text, has_user_message,
                parent_session_ids, is_continuation, mtime_ms, size_bytes,
                timestamp_ms, indexed_at
            ) VALUES (
                @file_path, @agent, @session_id, @legacy_session_id, @project_dir,
                @project_path, @project_name, @display_text, @has_user_message,
                @parent_session_ids, @is_continuation, @mtime_ms, @size_bytes,
                @timestamp_ms, @indexed_at
            )
            ON CONFLICT(file_path) DO UPDATE SET
                agent = excluded.agent,
                session_id = excluded.session_id,
                legacy_session_id = excluded.legacy_session_id,
                project_dir = excluded.project_dir,
                project_path = excluded.project_path,
                project_name = excluded.project_name,
                display_text = excluded.display_text,
                has_user_message = excluded.has_user_message,
                parent_session_ids = excluded.parent_session_ids,
                is_continuation = excluded.is_continuation,
                mtime_ms = excluded.mtime_ms,
                size_bytes = excluded.size_bytes,
                timestamp_ms = excluded.timestamp_ms,
                indexed_at = excluded.indexed_at
        `);
        this._stmts.allByAgent = this.db.prepare(
            `SELECT * FROM conversation_index WHERE agent = ?`
        );
        this._stmts.deleteByPath = this.db.prepare(
            `DELETE FROM conversation_index WHERE file_path = ?`
        );
        this._stmts.searchTitle = this.db.prepare(`
            SELECT * FROM conversation_index
            WHERE agent = ? AND has_user_message = 1 AND display_text LIKE ? ESCAPE '\\'
            ORDER BY timestamp_ms DESC
            LIMIT ?
        `);
    }

    /**
     * Return a Map<file_path, row> for every indexed row of an agent.
     * Cheap: a single query; the agent's index is at most a few thousand rows.
     */
    getIndexedMap(agent) {
        if (!this.available) return new Map();
        const map = new Map();
        try {
            for (const row of this._stmts.allByAgent.all(agent)) {
                map.set(row.file_path, row);
            }
        } catch (err) {
            console.warn('[ConversationIndexStore] getIndexedMap failed:', err.message);
        }
        return map;
    }

    /**
     * Upsert many rows inside a single transaction.
     * @param {Array<Object>} rows already shaped for the columns above
     */
    upsertMany(rows) {
        if (!this.available || !rows || rows.length === 0) return;
        try {
            const tx = this.db.transaction((batch) => {
                for (const r of batch) this._stmts.upsert.run(r);
            });
            tx(rows);
        } catch (err) {
            console.warn('[ConversationIndexStore] upsertMany failed:', err.message);
        }
    }

    /**
     * Remove rows for files that no longer exist on disk.
     * @param {Iterable<string>} filePaths
     */
    deleteMany(filePaths) {
        if (!this.available) return;
        try {
            const tx = this.db.transaction((paths) => {
                for (const p of paths) this._stmts.deleteByPath.run(p);
            });
            tx(Array.from(filePaths));
        } catch (err) {
            console.warn('[ConversationIndexStore] deleteMany failed:', err.message);
        }
    }

    /**
     * Title search straight from the index (diacritic-insensitive matching is
     * approximated by the caller normalizing display_text at write time; here we
     * do a simple LIKE and let the caller refine).
     */
    searchTitle(agent, likePattern, limit = 50) {
        if (!this.available) return [];
        try {
            return this._stmts.searchTitle.all(agent, likePattern, limit);
        } catch (err) {
            console.warn('[ConversationIndexStore] searchTitle failed:', err.message);
            return [];
        }
    }

    /** Build a row object from parsed metadata + stat info. */
    static buildRow({
        filePath, agent, sessionId, legacySessionId = null, projectDir = '',
        projectPath = '', projectName = '', displayText = '', hasUserMessage = false,
        parentSessionIds = [], isContinuation = false, mtimeMs, sizeBytes, timestampMs
    }) {
        return {
            file_path: filePath,
            agent,
            session_id: sessionId || null,
            legacy_session_id: legacySessionId || null,
            project_dir: projectDir || '',
            project_path: projectPath || '',
            project_name: projectName || '',
            display_text: displayText || '',
            has_user_message: hasUserMessage ? 1 : 0,
            parent_session_ids: JSON.stringify(parentSessionIds || []),
            is_continuation: isContinuation ? 1 : 0,
            mtime_ms: mtimeMs,
            size_bytes: sizeBytes,
            timestamp_ms: timestampMs != null ? timestampMs : mtimeMs,
            indexed_at: Date.now()
        };
    }

    close() {
        if (this.db) {
            try { this.db.close(); } catch (_) {}
        }
    }
}

// A single shared instance for the app (lazy). Tests/benchmarks construct their
// own with an explicit dbPath.
let _shared = null;
ConversationIndexStore.getShared = function getShared() {
    if (!_shared) _shared = new ConversationIndexStore();
    return _shared;
};

module.exports = ConversationIndexStore;
