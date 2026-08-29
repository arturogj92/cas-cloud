/**
 * Conversation Fork Service
 *
 * Branches a conversation for ANY supported CLI agent by copying its native
 * on-disk session artifacts under a new session id, leaving the original
 * untouched. Used by the `fork-conversation` IPC handler.
 *
 * Per-agent storage (verified against real installs):
 *   claude      ~/.claude/projects/<encoded>/<uuid>.jsonl
 *   codex       ~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl
 *   kimi        ~/.kimi-code/sessions/<wdKey>/<sessionId>/ + session_index.jsonl
 *   grok        ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/
 *   antigravity ~/.gemini/antigravity-cli/conversations/<uuid>.db + brain/<uuid>/
 *   opencode    SQLite ~/.local/share/opencode/opencode.db (session/message/part)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newUuid() {
    return crypto.randomUUID();
}

/**
 * Opencode-style ids: prefix + ~26 alphanumeric chars
 * (e.g. ses_04d7e1480ffeWSsuxvuQOpbGWt, msg_..., prt_...).
 */
function newPrefixedId(prefix) {
    const hex = crypto.randomBytes(8).toString('hex'); // 16
    const tail = crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
    return `${prefix}${hex}${tail}`;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {{ skip?: (name: string, fullPath: string) => boolean }} [opts]
 */
function copyDirRecursive(src, dest, opts = {}) {
    const skip = typeof opts.skip === 'function' ? opts.skip : () => false;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            if (skip(entry.name, from)) continue;
            copyDirRecursive(from, to, opts);
        } else if (entry.isFile()) {
            if (skip(entry.name, from)) continue;
            fs.copyFileSync(from, to);
        }
    }
}

/**
 * Stream-copy a text file while replacing every occurrence of `from` with `to`.
 * Used for Codex rollouts where the session id appears in session_meta (and rarely elsewhere).
 */
function copyFileReplacing(src, dest, from, to) {
    const content = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dest, content.split(from).join(to), 'utf8');
}

/**
 * Binary-safe replace of a fixed-length token (e.g. UUID) across a file.
 * Only valid when from.length === to.length (UUIDs always are).
 */
function replaceAllInFileBinary(filePath, from, to) {
    if (from.length !== to.length) {
        throw new Error(`binary replace requires equal lengths (${from.length} vs ${to.length})`);
    }
    const buf = fs.readFileSync(filePath);
    const fromBuf = Buffer.from(from, 'utf8');
    const toBuf = Buffer.from(to, 'utf8');
    let idx = 0;
    let hits = 0;
    while (idx < buf.length) {
        const at = buf.indexOf(fromBuf, idx);
        if (at === -1) break;
        toBuf.copy(buf, at);
        hits++;
        idx = at + toBuf.length;
    }
    if (hits > 0) fs.writeFileSync(filePath, buf);
    return hits;
}

/**
 * Recursively rewrite a fixed-length id inside every file under dir.
 */
function replaceAllInTreeBinary(dir, from, to) {
    if (!fs.existsSync(dir)) return 0;
    let hits = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) hits += replaceAllInTreeBinary(full, from, to);
        else if (entry.isFile()) {
            try {
                hits += replaceAllInFileBinary(full, from, to);
            } catch { /* skip unreadable */ }
        }
    }
    return hits;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Locate a Claude session JSONL. Claude encodes the *resolved* project path
 * (macOS `/tmp` → `/private/tmp`), so a blind encode of the app's projectPath
 * often misses the file. Prefer realpath, then fall back to scanning projects/.
 */
function findClaudeSessionFile(sessionId, projectPath) {
    const ClaudeService = require('./claude-conversation-search-service');
    const claudeService = new ClaudeService();
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const candidates = [];

    if (projectPath) {
        candidates.push(projectPath);
        try {
            candidates.push(fs.realpathSync(projectPath));
        } catch { /* path may not exist anymore */ }
    }

    for (const p of candidates) {
        const encoded = claudeService.encodeProjectPath(p);
        const file = path.join(projectsRoot, encoded, `${sessionId}.jsonl`);
        if (fs.existsSync(file)) return file;
    }

    // Last resort: scan projects/*/<sessionId>.jsonl (Claude itself indexes this way).
    try {
        if (!fs.existsSync(projectsRoot)) return null;
        for (const dir of fs.readdirSync(projectsRoot)) {
            const file = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
            if (fs.existsSync(file)) return file;
        }
    } catch { /* ignore */ }
    return null;
}

function forkClaude(sessionId, projectPath) {
    const sourceFile = findClaudeSessionFile(sessionId, projectPath);
    if (!sourceFile) {
        return { success: false, error: 'Conversation file not found' };
    }

    const newSessionId = newUuid();
    const destFile = path.join(path.dirname(sourceFile), `${newSessionId}.jsonl`);
    // Filename is the session id, but every JSONL line ALSO embeds sessionId.
    // Claude's resume looks up by that id — a blind copy keeps the OLD id and
    // resume reports "No conversation found with session ID: <new>".
    copyFileReplacing(sourceFile, destFile, sessionId, newSessionId);
    return { success: true, newSessionId };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Depth-first search for a rollout file ending in `<sessionId>.jsonl`
 * (same logic as codex-conversation-reader.findSessionFileById, which is private).
 */
function findCodexSessionFile(dir, sessionId) {
    if (!fs.existsSync(dir)) return null;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    const suffix = `${sessionId}.jsonl`;
    const subdirs = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            subdirs.push(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
            return path.join(dir, entry.name);
        }
    }
    subdirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    for (const sub of subdirs) {
        const hit = findCodexSessionFile(sub, sessionId);
        if (hit) return hit;
    }
    return null;
}

function forkCodex(sessionId) {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    const sourceFile = findCodexSessionFile(sessionsDir, sessionId);
    if (!sourceFile) {
        return { success: false, error: 'Codex conversation file not found' };
    }

    const newSessionId = newUuid();
    const now = new Date();
    const y = String(now.getFullYear());
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    const ts = `${y}-${m}-${d}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
    const destDir = path.join(sessionsDir, y, m, d);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, `rollout-${ts}-${newSessionId}.jsonl`);

    // Rewrite embedded session id so `codex resume <newId>` finds THIS file, not the original.
    copyFileReplacing(sourceFile, destFile, sessionId, newSessionId);
    return { success: true, newSessionId };
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

function findKimiSessionEntry(sessionId) {
    const kimi = require('./kimi-conversation-reader');
    const entries = kimi.readSessionIndex();
    return entries.find((e) => e.sessionId === sessionId) || null;
}

function forkKimi(sessionId) {
    const kimi = require('./kimi-conversation-reader');
    const entry = findKimiSessionEntry(sessionId);
    if (!entry || !entry.sessionDir || !fs.existsSync(entry.sessionDir)) {
        return { success: false, error: 'Kimi conversation not found' };
    }

    // Real ids look like session_<uuid>
    const bare = sessionId.startsWith('session_')
        ? sessionId.slice('session_'.length)
        : sessionId;
    const newBare = newUuid();
    const newSessionId = sessionId.startsWith('session_') ? `session_${newBare}` : newBare;

    const parentDir = path.dirname(entry.sessionDir);
    const destDir = path.join(parentDir, newSessionId);
    if (fs.existsSync(destDir)) {
        return { success: false, error: 'Kimi fork destination already exists' };
    }

    copyDirRecursive(entry.sessionDir, destDir);

    // Rewrite state.json paths that embed the old session directory.
    const statePath = path.join(destDir, 'state.json');
    if (fs.existsSync(statePath)) {
        try {
            let raw = fs.readFileSync(statePath, 'utf8');
            raw = raw.split(entry.sessionDir).join(destDir);
            raw = raw.split(sessionId).join(newSessionId);
            fs.writeFileSync(statePath, raw, 'utf8');
        } catch (err) {
            console.warn('[Fork] Kimi state.json rewrite failed:', err.message);
        }
    }

    // Append to the global index so history + resume discover the fork.
    const indexPath = path.join(kimi.getDataRoot(), 'session_index.jsonl');
    const indexLine = JSON.stringify({
        sessionId: newSessionId,
        sessionDir: destDir,
        workDir: entry.workDir || null
    });
    fs.appendFileSync(indexPath, `${indexLine}\n`, 'utf8');

    return { success: true, newSessionId };
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

function findGrokSessionDir(sessionId) {
    const sessionsDir = path.join(os.homedir(), '.grok', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;
    try {
        for (const cwdEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!cwdEntry.isDirectory()) continue;
            const sessionDir = path.join(sessionsDir, cwdEntry.name, sessionId);
            if (fs.existsSync(path.join(sessionDir, 'summary.json'))
                || fs.existsSync(path.join(sessionDir, 'chat_history.jsonl'))) {
                return sessionDir;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function resolveGrokBinary() {
    try {
        const installer = require('./grok-cli-installer');
        const p = installer.getGrokPath && installer.getGrokPath();
        if (p) return p;
    } catch { /* fall through */ }
    return process.env.GROK_PATH || 'grok';
}

function getGrokWorkDir(sourceDir, projectPath) {
    try {
        const summary = JSON.parse(
            fs.readFileSync(path.join(sourceDir, 'summary.json'), 'utf8')
        );
        if (summary.info && summary.info.cwd && fs.existsSync(summary.info.cwd)) {
            return summary.info.cwd;
        }
    } catch { /* ignore */ }
    if (projectPath && fs.existsSync(projectPath)) return projectPath;
    return process.cwd();
}

/**
 * Native Grok fork via CLI. File-copy forks look complete on disk but
 * `grok --resume <copy>` opens a blank chat UI (only system+user lines survive
 * after resume). The CLI's own `--fork-session` preserves the full transcript.
 *
 * MUST be async: never spawnSync on Electron's main process — a 15–120s
 * blocked event loop freezes the app and macOS SIGKILLs it (looks like a crash).
 *
 * Uses --single so the fork materializes and exits (no hanging TUI). Verified
 * live: history keeps assistant/reasoning/tool turns and resume returns FORK_OK.
 */
function forkGrokNative(sessionId, workDir, newSessionId) {
    const { spawn } = require('child_process');
    const bin = resolveGrokBinary();
    const timeoutMs = Number(process.env.FORK_GROK_NATIVE_TIMEOUT_MS) || 45000;

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(payload);
        };

        let child;
        try {
            child = spawn(
                bin,
                [
                    '--resume', sessionId,
                    '--fork-session',
                    '--session-id', newSessionId,
                    // Minimal turn so the CLI exits after writing the forked session.
                    '--single', '.',
                    '--always-approve'
                ],
                {
                    cwd: workDir,
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );
        } catch (err) {
            finish({
                status: null,
                error: String(err && err.message ? err.message : err),
                stderr: '',
                stdout: '',
                method: 'native-single'
            });
            return;
        }

        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }, 1500);
            finish({
                status: null,
                error: `timeout after ${timeoutMs}ms`,
                stderr,
                stdout,
                method: 'native-single'
            });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (err) => {
            finish({
                status: null,
                error: String(err && err.message ? err.message : err),
                stderr,
                stdout,
                method: 'native-single'
            });
        });
        child.on('close', (code) => {
            finish({
                status: code,
                error: null,
                stderr,
                stdout,
                method: 'native-single'
            });
        });
    });
}

function forkGrokFileCopy(sessionId, sourceDir, newSessionId) {
    const parentDir = path.dirname(sourceDir);
    const destDir = path.join(parentDir, newSessionId);
    if (fs.existsSync(destDir)) {
        return { success: false, error: 'Grok fork destination already exists' };
    }

    // Skip lock files from a LIVE source session.
    copyDirRecursive(sourceDir, destDir, {
        skip: (name) => name.endsWith('.lock') || name.endsWith('.lock.tmp')
    });

    try {
        replaceAllInTreeBinary(destDir, sessionId, newSessionId);
    } catch (err) {
        console.warn('[Fork] Grok tree id rewrite failed:', err.message);
        const summaryPath = path.join(destDir, 'summary.json');
        if (fs.existsSync(summaryPath)) {
            try {
                let raw = fs.readFileSync(summaryPath, 'utf8');
                raw = raw.split(sessionId).join(newSessionId);
                fs.writeFileSync(summaryPath, raw, 'utf8');
            } catch { /* ignore */ }
        }
    }
    return { success: true, newSessionId };
}

/**
 * Count non-empty chat_history lines and whether any assistant/reasoning turn survived.
 * Used to decide if a file-copy fork is good enough (fast path) or we need native.
 */
function inspectGrokHistory(sessionDir) {
    const historyPath = path.join(sessionDir, 'chat_history.jsonl');
    if (!fs.existsSync(historyPath)) {
        return { lineCount: 0, hasAssistant: false };
    }
    let lineCount = 0;
    let hasAssistant = false;
    try {
        const raw = fs.readFileSync(historyPath, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            lineCount += 1;
            if (hasAssistant) continue;
            try {
                const o = JSON.parse(line);
                const role = o.role || o.type || '';
                if (role === 'assistant' || role === 'reasoning') hasAssistant = true;
            } catch { /* ignore bad lines */ }
        }
    } catch { /* ignore */ }
    return { lineCount, hasAssistant };
}

function clearGrokLocks(sessionDir) {
    try {
        for (const name of fs.readdirSync(sessionDir)) {
            if (name.endsWith('.lock') || name.endsWith('.lock.tmp')) {
                try { fs.unlinkSync(path.join(sessionDir, name)); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

async function forkGrok(sessionId, projectPath = '') {
    const sourceDir = findGrokSessionDir(sessionId);
    if (!sourceDir) {
        return { success: false, error: 'Grok conversation not found' };
    }

    const workDir = getGrokWorkDir(sourceDir, projectPath);

    // FAST PATH: offline file copy. Verified to preserve assistant/reasoning/tool
    // turns and resume cleanly when locks are skipped and ids rewritten. Native
    // CLI fork (`--fork-session --single .`) runs a full model turn and can take
    // 15–45s, which made the Fork button look dead and spawned piles of hung
    // processes on multi-click. Prefer copy; only escalate to native when the
    // copy is incomplete (e.g. mid-write source with no assistant lines).
    //
    // FORK_GROK_FORCE_NATIVE=1 forces the slow CLI path (debug).
    // FORK_GROK_FORCE_COPY=1 (tests) skips native entirely.
    if (process.env.FORK_GROK_FORCE_NATIVE !== '1') {
        const copy = forkGrokFileCopy(sessionId, sourceDir, newUuid());
        if (copy.success && copy.newSessionId) {
            const dest = findGrokSessionDir(copy.newSessionId);
            if (dest) {
                clearGrokLocks(dest);
                const insp = inspectGrokHistory(dest);
                // Accept copy when history exists. For empty/new chats (only
                // system/user) file-copy is still correct — no need for native.
                if (insp.lineCount >= 1) {
                    console.log(
                        `[Fork] grok file-copy: ${sessionId} → ${copy.newSessionId} ` +
                        `(historyLines=${insp.lineCount}, hasAssistant=${insp.hasAssistant})`
                    );
                    return copy;
                }
                try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
            }
        } else if (!copy.success) {
            console.warn('[Fork] grok file-copy failed:', copy.error);
        }
    }

    if (process.env.FORK_GROK_FORCE_COPY === '1') {
        return forkGrokFileCopy(sessionId, sourceDir, newUuid());
    }

    // SLOW PATH: native CLI fork (async — never spawnSync on Electron main).
    const newSessionId = newUuid();
    try {
        console.log(`[Fork] grok native starting: ${sessionId} → ${newSessionId}`);
        const native = await forkGrokNative(sessionId, workDir, newSessionId);
        const dest = findGrokSessionDir(newSessionId);
        if (native && native.status === 0 && dest) {
            clearGrokLocks(dest);
            const insp = inspectGrokHistory(dest);
            if (insp.lineCount >= 1) {
                console.log(
                    `[Fork] grok native: ${sessionId} → ${newSessionId} ` +
                    `(historyLines=${insp.lineCount})`
                );
                return { success: true, newSessionId };
            }
        }
        console.warn(
            '[Fork] grok native incomplete, last-resort file copy:',
            native && (native.error || `status=${native.status}`)
        );
        if (dest) {
            try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    } catch (err) {
        console.warn('[Fork] grok native failed, last-resort file copy:', err.message);
    }

    return forkGrokFileCopy(sessionId, sourceDir, newUuid());
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

function forkAntigravity(sessionId) {
    const base = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    const convDir = path.join(base, 'conversations');
    const brainDir = path.join(base, 'brain');
    const sourceDb = path.join(convDir, `${sessionId}.db`);
    const sourceBrain = path.join(brainDir, sessionId);

    const hasDb = fs.existsSync(sourceDb);
    const hasBrain = fs.existsSync(sourceBrain);
    if (!hasDb && !hasBrain) {
        return { success: false, error: 'Antigravity conversation not found' };
    }

    // UUIDs are fixed-length → safe binary rewrite of the id inside db blobs +
    // brain transcripts (agy looks up trajectory by conversation id embedded in
    // protobuf/sqlite, not only by filename).
    const newSessionId = newUuid();
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    if (hasDb) {
        const destDb = path.join(convDir, `${newSessionId}.db`);
        try {
            try {
                const Database = require('better-sqlite3');
                const src = new Database(sourceDb, { fileMustExist: true });
                try {
                    src.pragma('wal_checkpoint(TRUNCATE)');
                } finally {
                    src.close();
                }
            } catch {
                // locked / non-sqlite fixture — still copy
            }
            fs.copyFileSync(sourceDb, destDb);
            // Drop any leftover wal/shm for the NEW id so agy doesn't attach a
            // stale journal from a previous run.
            for (const side of [`${destDb}-wal`, `${destDb}-shm`]) {
                try { fs.unlinkSync(side); } catch { /* ok */ }
            }
            replaceAllInFileBinary(destDb, sessionId, newSessionId);
        } catch (err) {
            return { success: false, error: `Antigravity db copy failed: ${err.message}` };
        }
    }

    if (hasBrain) {
        const destBrain = path.join(brainDir, newSessionId);
        copyDirRecursive(sourceBrain, destBrain);
        replaceAllInTreeBinary(destBrain, sessionId, newSessionId);
    }

    return { success: true, newSessionId };
}

// ---------------------------------------------------------------------------
// OpenCode (SQLite)
// ---------------------------------------------------------------------------

/** @type {null|((dbPath: string) => object)} test seam — inject a fake db opener */
let _openOpencodeDatabaseForTests = null;

/**
 * Test seam: inject a fake better-sqlite3 opener for OpenCode forks.
 * Pass null to restore the real opener.
 * @param {((dbPath: string) => object)|null} fn
 */
function __setOpencodeDatabaseOpenerForTests(fn) {
    _openOpencodeDatabaseForTests = fn || null;
}

function openOpencodeDatabase(dbPath) {
    if (_openOpencodeDatabaseForTests) {
        return _openOpencodeDatabaseForTests(dbPath);
    }
    const Database = require('better-sqlite3');
    return new Database(dbPath);
}

/**
 * @param {string} sessionId
 * @param {{ dbPath?: string }} [opts] - optional override used by tests
 */
function forkOpencode(sessionId, opts = {}) {
    const opencodeReader = require('./opencode-conversation-reader');
    const dbPath = opts.dbPath || opencodeReader.getDbPath();

    // When a test injects an opener, skip the on-disk existence check (in-memory fixtures).
    if (!_openOpencodeDatabaseForTests && !fs.existsSync(dbPath)) {
        return { success: false, error: 'OpenCode database not found' };
    }

    let db;
    try {
        db = openOpencodeDatabase(dbPath);
    } catch (err) {
        return { success: false, error: `better-sqlite3 unavailable: ${err.message}` };
    }

    try {
        const session = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
        if (!session) {
            return { success: false, error: 'OpenCode session not found' };
        }

        const newSessionId = newPrefixedId('ses_');
        const now = Date.now();

        // Build INSERT from whatever columns exist on this opencode version.
        const sessionCols = Object.keys(session);
        const newSession = { ...session, id: newSessionId, time_created: now, time_updated: now };
        if (typeof newSession.title === 'string' && newSession.title && !/\(fork\)$/i.test(newSession.title)) {
            newSession.title = `${newSession.title} (fork)`;
        }
        // Fork is always a top-level session (never a child of the original).
        if (Object.prototype.hasOwnProperty.call(newSession, 'parent_id')) {
            newSession.parent_id = null;
        }

        const placeholders = sessionCols.map(() => '?').join(', ');
        db.prepare(
            `INSERT INTO session (${sessionCols.join(', ')}) VALUES (${placeholders})`
        ).run(...sessionCols.map((c) => newSession[c]));

        // Messages
        const messages = db.prepare('SELECT * FROM message WHERE session_id = ?').all(sessionId);
        const messageIdMap = new Map();
        for (const msg of messages) {
            const newMsgId = newPrefixedId('msg_');
            messageIdMap.set(msg.id, newMsgId);
            const cols = Object.keys(msg);
            const copy = { ...msg, id: newMsgId, session_id: newSessionId };
            db.prepare(
                `INSERT INTO message (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            ).run(...cols.map((c) => copy[c]));
        }

        // Parts (FK to message + session)
        const parts = db.prepare('SELECT * FROM part WHERE session_id = ?').all(sessionId);
        for (const part of parts) {
            const newPartId = newPrefixedId('prt_');
            const cols = Object.keys(part);
            const copy = {
                ...part,
                id: newPartId,
                session_id: newSessionId,
                message_id: messageIdMap.get(part.message_id) || part.message_id
            };
            db.prepare(
                `INSERT INTO part (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            ).run(...cols.map((c) => copy[c]));
        }

        // session_message (newer schema; may be empty)
        try {
            const smRows = db.prepare('SELECT * FROM session_message WHERE session_id = ?').all(sessionId);
            for (const row of smRows) {
                const newId = newPrefixedId('sm_');
                const cols = Object.keys(row);
                const copy = { ...row, id: newId, session_id: newSessionId };
                db.prepare(
                    `INSERT INTO session_message (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
                ).run(...cols.map((c) => copy[c]));
            }
        } catch {
            // Table may not exist on older DBs.
        }

        return { success: true, newSessionId };
    } finally {
        try {
            if (db && typeof db.close === 'function') db.close();
        } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fork a conversation for the given agent.
 * Async: Grok native fork must not block Electron's main process.
 *
 * @param {{ sessionId: string, projectPath?: string, agentType?: string }} opts
 * @returns {Promise<{ success: boolean, newSessionId?: string, error?: string, agentType?: string }>}
 */
async function forkConversation({ sessionId, projectPath = '', agentType = 'claude' } = {}) {
    if (!sessionId) {
        return { success: false, error: 'Missing sessionId' };
    }

    const agent = (agentType || 'claude').toLowerCase();

    try {
        let result;
        switch (agent) {
            case 'claude':
                if (!projectPath) {
                    return { success: false, error: 'No project directory selected' };
                }
                result = forkClaude(sessionId, projectPath);
                break;
            case 'codex':
                result = forkCodex(sessionId);
                break;
            case 'kimi':
                result = forkKimi(sessionId);
                break;
            case 'grok':
                result = await forkGrok(sessionId, projectPath);
                break;
            case 'antigravity':
            case 'agy':
                result = forkAntigravity(sessionId);
                break;
            case 'opencode':
                result = forkOpencode(sessionId);
                break;
            default:
                return {
                    success: false,
                    error: `Fork is not supported for agent "${agent}" yet`
                };
        }

        if (result && result.success) {
            console.log(`[Fork] ${agent}: ${sessionId} → ${result.newSessionId}`);
            return { ...result, agentType: agent };
        }
        return { ...(result || { success: false, error: 'Fork failed' }), agentType: agent };
    } catch (error) {
        console.error(`[Fork] ${agent} error:`, error);
        return { success: false, error: error.message || String(error), agentType: agent };
    }
}

module.exports = {
    forkConversation,
    __setOpencodeDatabaseOpenerForTests,
    // Exported for unit tests
    _internal: {
        findCodexSessionFile,
        findKimiSessionEntry,
        findGrokSessionDir,
        forkClaude,
        forkCodex,
        forkKimi,
        forkGrok,
        forkAntigravity,
        forkOpencode,
        newPrefixedId,
        copyDirRecursive,
        copyFileReplacing
    }
};
