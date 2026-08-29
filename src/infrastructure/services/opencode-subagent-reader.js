/**
 * Opencode Subagent Reader
 *
 * Reads one delegated (child) opencode session straight out of opencode's own
 * SQLite database, so a subagent row in Chat can be drilled into.
 *
 * ── Why the database ────────────────────────────────────────────────────────
 * opencode's ACP stream announces a delegation as an ordinary tool call whose
 * arguments carry `subagent_type` and `description` — and nothing else. The
 * child's session id, which is the only thing that can address it, never
 * crosses the wire. It IS in the db though: the task tool creates a
 * `session` row with `parent_id = <parent ses_id>`, `agent = <subagent_type>`
 * and `title = "<description> (@<subagent_type> subagent)"`.
 *
 * Layout (same db as opencode-conversation-reader.js, whose `getDbPath()` this
 * module reuses):
 *   session(id, parent_id, title, agent, time_created)
 *   message(id, session_id, time_created, data JSON {role})
 *   part(id, message_id, session_id, time_created, time_updated,
 *        data JSON {type:'text'|'step-start'|'step-finish'|'tool', text?})
 *
 * better-sqlite3 is a native Electron module, so it is lazy-required inside the
 * opener and the opener is injectable: plain-node consumers (Jest) exercise the
 * pure helpers with a fake db instead of loading the wrong ABI.
 */

const { getDbPath } = require('./opencode-conversation-reader');

const NOT_FOUND_MESSAGE = 'Subagent conversation not found on disk';

/**
 * Default readonly opener. Lazy-requires better-sqlite3 for the reason above.
 * @param {string} dbPath
 * @returns {object} better-sqlite3 Database instance (readonly)
 */
const defaultDatabaseOpener = (dbPath) => {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true, fileMustExist: true });
};

/**
 * Every child session of one parent, oldest first.
 * @param {object} db Open (readonly) database.
 * @param {string} parentSessionId Parent `ses_...` id.
 * @returns {Array<{id: string, title: string, agent: string, timeCreated: number}>}
 */
function listChildren(db, parentSessionId) {
    const rows = db
        .prepare('SELECT id, title, agent, time_created FROM session WHERE parent_id = ? ORDER BY time_created ASC')
        .all(parentSessionId);
    return rows.map((row) => ({
        id: row.id,
        title: row.title || '',
        agent: row.agent || '',
        timeCreated: row.time_created
    }));
}

/**
 * Which child session a parent's subagent tool call refers to.
 *
 * ponytail: the match is a heuristic on the title opencode composes for a
 * delegated session (`"<description> (@<type> subagent)"`), disambiguated by
 * the tool call's spawn ordinal — the ACP tool call carries no child session
 * id, so there is nothing exact to match on. If this ever picks the wrong
 * sibling, the upgrade path is reading the tool part's metadata out of the
 * parent's own `part` rows, which do record the child id.
 *
 * @param {Array<{id: string, title: string, agent: string}>} children
 * @param {{agentType?: string, description?: string, ordinal?: number}} target
 * @returns {{id: string, title: string, agent: string}|null}
 */
function matchChild(children, { agentType, description, ordinal } = {}) {
    const list = Array.isArray(children) ? children : [];
    const expectedTitle = agentType && description
        ? `${description} (@${agentType} subagent)`
        : '';
    const candidates = expectedTitle
        ? list.filter((row) => row.title === expectedTitle)
        : list.filter((row) => !agentType || row.agent === agentType);
    if (candidates.length === 0) return null;
    const index = Number.isInteger(ordinal) && ordinal >= 0 && ordinal < candidates.length
        ? ordinal
        : candidates.length - 1;
    return candidates[index];
}

/**
 * The child's conversation as bare canonical events, oldest first.
 *
 * ponytail: text only. Tool parts, reasoning and the step-* bookkeeping are
 * dropped — the drill-down exists to read what the subagent said. Map the tool
 * parts too the day someone misses them.
 *
 * @param {object} db Open (readonly) database.
 * @param {string} childSessionId
 * @returns {Object[]} Bare `item.completed` events for the timeline.
 */
function readChildEvents(db, childSessionId) {
    const rows = db
        .prepare(
            'SELECT m.data AS message, p.data AS part, p.id AS partId '
            + 'FROM part p JOIN message m ON m.id = p.message_id '
            + 'WHERE p.session_id = ? ORDER BY p.time_created ASC, p.id ASC'
        )
        .all(childSessionId);

    const events = [];
    rows.forEach((row, index) => {
        let message;
        let part;
        try {
            message = JSON.parse(row.message);
            part = JSON.parse(row.part);
        } catch {
            return; // a corrupt row is not worth failing the whole read over
        }
        if (!part || part.type !== 'text' || typeof part.text !== 'string' || !part.text) return;
        const role = message && message.role === 'user' ? 'user' : 'assistant';
        events.push({
            type: 'item.completed',
            itemId: `oc-${row.partId || index}`,
            payload: {
                itemType: role === 'user' ? 'user_message' : 'assistant_message',
                status: 'completed',
                title: role === 'user' ? 'User message' : 'Assistant message',
                data: { text: part.text },
                historical: true
            }
        });
    });
    return events;
}

/**
 * How far the child's transcript has got, for the poll's freshness check.
 * @param {object} db Open (readonly) database.
 * @param {string} childSessionId
 * @returns {{count: number, maxUpdated: number}}
 */
function latestStamp(db, childSessionId) {
    const row = db
        .prepare('SELECT COUNT(*) AS n, MAX(time_updated) AS t FROM part WHERE session_id = ?')
        .get(childSessionId);
    return {
        count: (row && row.n) || 0,
        maxUpdated: (row && row.t) || 0
    };
}

/**
 * Resolve one subagent tool call to its child session and read it.
 *
 * @param {{parentSessionId: string, agentType?: string, description?: string,
 *   ordinal?: number, known?: {cursorCount?: number, cursorUpdated?: number},
 *   openDb?: (dbPath: string) => object}} params
 * @returns {{agentId: string, agentType: string, description: string,
 *   events: Object[], cursorCount: number, cursorUpdated: number}
 *   | {agentId: string, unchanged: true}}
 * @throws {Error} `Subagent conversation not found on disk` when the database
 *   cannot be read or no child session matches.
 */
function openChildConversation({
    parentSessionId,
    agentType,
    description,
    ordinal,
    known,
    openDb
} = {}) {
    let db;
    try {
        db = (openDb || defaultDatabaseOpener)(getDbPath());
    } catch (error) {
        throw new Error(NOT_FOUND_MESSAGE);
    }
    try {
        const child = matchChild(
            listChildren(db, parentSessionId),
            { agentType, description, ordinal }
        );
        if (!child) throw new Error(NOT_FOUND_MESSAGE);

        const stamp = latestStamp(db, child.id);
        if (known && known.cursorCount === stamp.count && known.cursorUpdated === stamp.maxUpdated) {
            return { agentId: child.id, unchanged: true };
        }
        return {
            agentId: child.id,
            agentType: child.agent || agentType || '',
            description: description || '',
            events: readChildEvents(db, child.id),
            cursorCount: stamp.count,
            cursorUpdated: stamp.maxUpdated
        };
    } finally {
        try {
            if (db && typeof db.close === 'function') db.close();
        } catch {
            // closing a readonly db should not fail; ignore if it does
        }
    }
}

module.exports = {
    listChildren,
    matchChild,
    readChildEvents,
    latestStamp,
    openChildConversation
};
