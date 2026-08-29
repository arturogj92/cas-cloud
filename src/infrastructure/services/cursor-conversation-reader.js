/** Reads Cursor Agent sessions from both legacy Chat and ACP storage. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeWorktreePath } = require('./claude-project-path-resolver');

const defaultDatabaseOpener = (dbPath) => {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true, fileMustExist: true });
};
let openDatabase = defaultDatabaseOpener;
const cache = new Map();

function __setDatabaseOpenerForTests(opener) { openDatabase = opener || defaultDatabaseOpener; }
function getDataRoot() { return path.join(os.homedir(), '.cursor', 'chats'); }
function getAcpDataRoot() { return path.join(os.homedir(), '.cursor', 'acp-sessions'); }

function readSessionIndex() {
    const rows = [];
    try {
        if (fs.existsSync(getDataRoot())) {
            for (const project of fs.readdirSync(getDataRoot(), { withFileTypes: true })) {
                if (!project.isDirectory()) continue;
                const projectDir = path.join(getDataRoot(), project.name);
                for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
                    if (!session.isDirectory()) continue;
                    const sessionDir = path.join(projectDir, session.name);
                    const dbPath = path.join(sessionDir, 'store.db');
                    if (fs.existsSync(dbPath)) rows.push({ sessionId: session.name, sessionDir, dbPath, projectHash: project.name });
                }
            }
        }
        if (fs.existsSync(getAcpDataRoot())) {
            for (const session of fs.readdirSync(getAcpDataRoot(), { withFileTypes: true })) {
                if (!session.isDirectory()) continue;
                const sessionDir = path.join(getAcpDataRoot(), session.name);
                const dbPath = path.join(sessionDir, 'store.db');
                if (fs.existsSync(dbPath)) rows.push({
                    sessionId: session.name,
                    sessionDir,
                    dbPath,
                    metaPath: path.join(sessionDir, 'meta.json'),
                    isAcp: true,
                });
            }
        }
    } catch (_) {}
    return rows;
}

function withDb(dbPath, fn, fallback) {
    let db;
    try {
        db = openDatabase(dbPath);
        return fn(db);
    } catch (_) {
        return fallback;
    } finally {
        try { db?.close?.(); } catch (_) {}
    }
}

function decodeMeta(value) {
    try {
        const text = String(value || '');
        return JSON.parse(/^[0-9a-f]+$/i.test(text) ? Buffer.from(text, 'hex').toString('utf8') : text);
    } catch (_) {
        return {};
    }
}

function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text).join('\n');
}

function cleanCursorUserText(text) {
    let cleaned = String(text || '');
    let previous;
    do {
        previous = cleaned;
        cleaned = cleaned.replace(
            /^\s*<(user_info|agent_transcripts|session-instructions)\b[^>]*>[\s\S]*?<\/\1>\s*/i,
            ''
        );
    } while (cleaned !== previous);
    const query = cleaned.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    return (query ? query[1] : cleaned).trim();
}

function parseMessages(db) {
    const messages = [];
    const seen = new Set();
    const rows = db.prepare('SELECT rowid, data FROM blobs ORDER BY rowid').all();
    for (const row of rows) {
        const raw = Buffer.isBuffer(row.data) ? row.data.toString('utf8') : String(row.data || '');
        if (!raw.trimStart().startsWith('{')) continue;
        let value;
        try { value = JSON.parse(raw); } catch (_) { continue; }
        if (value.role !== 'user' && value.role !== 'assistant') continue;
        const text = value.role === 'user' ? cleanCursorUserText(extractText(value.content)) : extractText(value.content);
        if (!text) continue;
        const key = `${value.role}\0${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push({ role: value.role, content: text, timestamp: null });
    }
    return messages;
}

function workspaceFromDb(db) {
    const rows = db.prepare('SELECT data FROM blobs ORDER BY rowid LIMIT 20').all();
    for (const row of rows) {
        const raw = Buffer.isBuffer(row.data) ? row.data.toString('utf8') : String(row.data || '');
        let searchable = raw;
        try {
            const value = JSON.parse(raw);
            searchable = extractText(value.content) || raw;
        } catch (_) {}
        const match = searchable.match(/Workspace Path:\s*([^\n<]+)/i);
        if (match) return match[1].trim();
    }
    return null;
}

function readAcpMeta(entry) {
    if (!entry.isAcp || !entry.metaPath) return {};
    try { return JSON.parse(fs.readFileSync(entry.metaPath, 'utf8')); }
    catch (_) { return {}; }
}

function readSessionState(entry) {
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(entry.dbPath).mtimeMs;
        if (entry.metaPath && fs.existsSync(entry.metaPath)) {
            mtimeMs = Math.max(mtimeMs, fs.statSync(entry.metaPath).mtimeMs);
        }
    } catch (_) { return null; }
    const cached = cache.get(entry.dbPath);
    if (cached?.mtimeMs === mtimeMs) return cached.session;
    const session = withDb(entry.dbPath, (db) => {
        const meta = decodeMeta(db.prepare("SELECT value FROM meta WHERE key = '0'").get()?.value);
        const acpMeta = readAcpMeta(entry);
        return {
            sessionId: entry.isAcp ? entry.sessionId : (meta.agentId || entry.sessionId),
            sessionDir: entry.sessionDir,
            title: acpMeta.title || meta.name || '',
            projectPath: acpMeta.cwd || workspaceFromDb(db),
            createdAt: Number(meta.createdAt) || null,
            updatedAt: mtimeMs,
            timestamp: mtimeMs || Number(meta.createdAt) || 0,
            model: meta.lastUsedModel || null,
            filePath: entry.dbPath,
        };
    }, null);
    if (session) cache.set(entry.dbPath, { mtimeMs, session });
    return session;
}

function getAllSessions(limit = 200) {
    return readSessionIndex().map(readSessionState).filter(Boolean)
        .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

function sameProject(left, right) {
    const normalize = (value) => String(normalizeWorktreePath(value) || value || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return normalize(left) === normalize(right);
}

function getSessionsForProject(projectPath) {
    if (!projectPath) return [];
    return getAllSessions(2000).filter((session) => sameProject(session.projectPath, projectPath));
}

function hasConversationsForProject(projectPath) { return getSessionsForProject(projectPath).length > 0; }
function getLatestSessionIdForProject(projectPath) { return getSessionsForProject(projectPath)[0]?.sessionId || null; }
function getSessionWorkDir(sessionId) { return getAllSessions(2000).find((session) => session.sessionId === sessionId)?.projectPath || null; }

function getSessionMessages(sessionId) {
    const entry = readSessionIndex().find((row) => row.sessionId === sessionId);
    return entry ? withDb(entry.dbPath, parseMessages, []).map((message) => (
        message.role === 'user' ? { ...message, content: cleanCursorUserText(message.content) } : message
    )).filter((message) => message.content) : [];
}

function getFirstUserText(sessionId) {
    return getSessionMessages(sessionId).find((message) => message.role === 'user')?.content || '';
}

function enumerateSessionsForIndex() {
    return readSessionIndex().map((entry) => {
        try { return { sessionId: entry.sessionId, timestamp: fs.statSync(entry.dbPath).mtimeMs, workDir: readSessionState(entry)?.projectPath || null }; }
        catch (_) { return null; }
    }).filter(Boolean);
}

module.exports = {
    getDataRoot, getAcpDataRoot, readSessionIndex, readSessionState, getAllSessions, enumerateSessionsForIndex,
    hasConversationsForProject, getSessionsForProject, getLatestSessionIdForProject,
    getSessionWorkDir, getSessionMessages, getFirstUserText, cleanCursorUserText,
    __setDatabaseOpenerForTests,
};
