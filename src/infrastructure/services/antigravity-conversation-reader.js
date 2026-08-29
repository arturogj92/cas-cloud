/**
 * Antigravity Conversation Reader
 *
 * Reads and parses Antigravity CLI (`agy`) conversation history from the local
 * filesystem. Drop-in sibling of gemini-conversation-reader.js and
 * codex-conversation-reader.js: exports `hasConversationsForProject(projectPath)`
 * returning a boolean, and fails safe (never throws → returns false/empty).
 *
 * ── On-disk layout (verified on agy v1.0.13) ────────────────────────────────
 *  1. Conversation index (one SQLite db per conversation, used ONLY to
 *     enumerate ids + read mtime — the blobs inside are protobuf and are NOT
 *     decoded here):
 *        ~/.gemini/antigravity-cli/conversations/<conversationId>.db (+ -wal/-shm)
 *     The filename stem IS the conversationId.
 *
 *  2. Conversation content (clean JSONL — this is what we render):
 *        ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *        ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl (untruncated)
 *
 * All path resolution happens at call-time (never cached at module load) so that
 * tests overriding `os.homedir()` work, mirroring the Gemini/Codex readers.
 *
 * ── Workspace recovery (added 2026-06-29) ───────────────────────────────────
 * The clean transcript JSONL carries NO workspace/cwd field, but the per-
 * conversation `<id>.db` DOES, via two signals `getConversationWorkspace` reads
 * in order:
 *   1. AUTHORITATIVE — `trajectory_metadata_blob` embeds the registered workspace
 *      as a protobuf `file:///abs/path` URI (present only when the session was
 *      started inside a recognized workspace).
 *   2. FALLBACK — for `default-cli-project` sessions (no registered workspace,
 *      e.g. agy spawned by CodeAgentSwarm inside a project dir) the working
 *      directory is recovered from the dominant `"Cwd"` of the agent's
 *      RUN_COMMAND steps in the `steps` table.
 * Either way the result lets the history list show the real project name and
 * resume open the terminal in the right directory. We do NOT fully decode the
 * protobuf: we scan the blob bytes for `file://` / `"Cwd"` runs and keep the
 * path that resolves to an existing directory under the user's home OR a trusted
 * absolute path outside it (other drives, /Volumes, UNC shares — excluding roots,
 * home ancestors and system trees), discarding the antigravity-cli's own paths
 * and any byte-boundary over-grab. Fully
 * fail-safe: any error (missing db, better-sqlite3 unavailable, malformed blob)
 * returns null and the caller falls back to a generic label.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Root directory Antigravity CLI keeps all of its state under.
 * @returns {string}
 */
function getBaseDir() {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Directory holding the per-conversation SQLite index files.
 * @returns {string}
 */
function getConversationsDir() {
    return path.join(getBaseDir(), 'conversations');
}

/**
 * Directory holding the per-conversation "brain" folders (transcripts, logs).
 * @returns {string}
 */
function getBrainDir() {
    return path.join(getBaseDir(), 'brain');
}

/**
 * Path to the (truncated, render-ready) transcript JSONL for a conversation.
 * @param {string} conversationId
 * @returns {string}
 */
function getTranscriptPath(conversationId) {
    return path.join(getBrainDir(), conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

/**
 * Path to the full (untruncated) transcript JSONL for a conversation.
 * @param {string} conversationId
 * @returns {string}
 */
function getFullTranscriptPath(conversationId) {
    return path.join(getBrainDir(), conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/**
 * Enumerates every known Antigravity conversation id.
 *
 * Antigravity stores conversations FLAT (not per-project). Ids are derived from
 * two independent sources and unioned so we still find a conversation even if
 * one of the two on-disk artifacts is missing:
 *   - the `<id>.db` files under conversations/ (canonical index)
 *   - the `<id>/` subfolders under brain/ (where the transcript lives)
 *
 * @returns {Array<string>} de-duplicated conversation ids (order unspecified)
 */
function listConversationIds() {
    const ids = new Set();

    try {
        const convDir = getConversationsDir();
        if (fs.existsSync(convDir)) {
            for (const name of fs.readdirSync(convDir)) {
                // The filename stem is the conversationId. Ignore -wal/-shm sidecars.
                if (name.endsWith('.db')) {
                    ids.add(name.slice(0, -'.db'.length));
                }
            }
        }
    } catch (error) {
        console.error('[Antigravity listConversationIds] conversations/ scan error:', error.message);
    }

    try {
        const brainDir = getBrainDir();
        if (fs.existsSync(brainDir)) {
            const entries = fs.readdirSync(brainDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) ids.add(entry.name);
            }
        }
    } catch (error) {
        console.error('[Antigravity listConversationIds] brain/ scan error:', error.message);
    }

    return Array.from(ids);
}

/**
 * Most-recent mtime (ms) across a conversation's known artifacts, used for
 * ordering and as a timestamp fallback. Returns 0 when nothing can be stat'd.
 * @param {string} conversationId
 * @returns {number}
 */
function getConversationMtime(conversationId) {
    const candidates = [
        path.join(getConversationsDir(), `${conversationId}.db`),
        getFullTranscriptPath(conversationId),
        getTranscriptPath(conversationId)
    ];

    let mtime = 0;
    for (const candidate of candidates) {
        try {
            const stat = fs.statSync(candidate);
            if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
        } catch {
            // missing artifact — skip
        }
    }
    return mtime;
}

/**
 * Extracts every `file://` URI embedded in a protobuf blob buffer.
 *
 * Pure (no fs / no sqlite) so it can be unit-tested with crafted buffers.
 * Antigravity stores length-delimited strings, so each URI is normally preceded
 * by its byte length: `<tag><len>file://...`. We try that exact slice first
 * (clean, no trailing tag byte) and fall back to reading the printable run when
 * the length byte is implausible. Callers disambiguate the survivors by which
 * one is a real directory, so over-grabbing here is harmless.
 *
 * @param {Buffer} buffer
 * @returns {Array<string>} de-duplicated `file://...` URIs (order: first-seen)
 */
function extractFileUrisFromBlob(buffer) {
    const uris = [];
    if (!buffer || typeof buffer.indexOf !== 'function') return uris;

    const needle = Buffer.from('file://');
    const isPrintable = (byte) => byte >= 0x20 && byte <= 0x7e;
    const PRINTABLE_URI = /^file:\/\/[\x20-\x7e]+$/;

    let i = 0;
    while ((i = buffer.indexOf(needle, i)) !== -1) {
        let uri = null;

        // Primary: treat the byte right before `file` as a single-byte length.
        const lenByte = i > 0 ? buffer[i - 1] : -1;
        if (lenByte > 0 && lenByte < 128 && i + lenByte <= buffer.length) {
            const candidate = buffer.slice(i, i + lenByte).toString('utf8');
            if (PRINTABLE_URI.test(candidate)) uri = candidate;
        }

        // Fallback: read until the first non-printable byte.
        if (!uri) {
            let end = i;
            while (end < buffer.length && isPrintable(buffer[end])) end++;
            uri = buffer.slice(i, end).toString('utf8');
        }

        if (uri && !uris.includes(uri)) uris.push(uri);
        i += needle.length;
    }

    return uris;
}

/**
 * Converts a `file://` URI to a local absolute path, or null when it is not a
 * local-file URI. Pure helper.
 * @param {string} uri
 * @returns {string|null}
 */
function fileUriToPath(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
    let p = uri.slice('file://'.length);
    try { p = decodeURIComponent(p); } catch { /* keep raw on malformed escapes */ }
    // Windows: the workspace arrives either as a native drive path appended to the
    // scheme (file://C:\dir) or as a proper file URI (file:///C:/dir). A leading
    // slash before the drive letter is a URI artifact — drop it, and normalize to
    // backslashes so the result is a real on-disk path that matches homeDir.
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\//g, '\\');
    // POSIX absolute path (macOS/Linux).
    if (p.startsWith('/')) return p;
    // UNC file URI: file://server/share/... — a HOST component, forward slashes,
    // no drive, no leading slash. agy records a Windows UNC cwd this way when it
    // is launched directly inside one (e.g. \\Mac\Home\... or \\wsl$\Ubuntu\...,
    // which agy stores as file://Mac/Home/... / file://wsl$/Ubuntu/...).
    // Reconstruct the native \\server\share\... path so it matches the project.
    if (/^[^\\/]+[\\/]/.test(p)) return '\\\\' + p.replace(/\//g, '\\');
    return null;
}

/**
 * True when `p` is a real project directory under `homeDir` — i.e. STRICTLY
 * below it. The home dir itself (and anything above it) is rejected: a Cwd of
 * exactly `~` is not a project and would render a nonsensical badge (the user's
 * login name). Pure.
 * @param {string} p
 * @param {string} homeDir
 * @returns {boolean}
 */
function isUnderHome(p, homeDir) {
    return typeof p === 'string'
        && p.startsWith(homeDir + path.sep)
        && p.length > homeDir.length + 1;
}

/**
 * True for a UNC workspace path with at least \\server\share\dir (a real project
 * dir below the share, not the bare share root). A project on a network share
 * (the win2 Parallels `\\Mac\Home\...`, or WSL2 `\\wsl$\Ubuntu\...`) is NOT under
 * the Windows home, so isUnderHome rejects it — but it is still a legitimate
 * workspace, so pickWorkspacePath accepts it via this. Pure.
 * @param {string} p
 * @returns {boolean}
 */
function isUncWorkspace(p) {
    return typeof p === 'string' && /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/][^\\/]/.test(p);
}

/**
 * True for an absolute path we trust as a workspace CANDIDATE even though it is
 * not under the user's home. Projects outside the home are the norm on Windows
 * (D:\proyectos\app, C:\dev\app) and legitimate on macOS (/Volumes/Work/app),
 * and the registered-workspace URI in trajectory_metadata_blob is authoritative —
 * discarding it made getConversationWorkspace return null and degraded History
 * opens to the folder picker (formerly: silently to HOME) while session
 * auto-detection could never attribute those conversations to their project.
 *
 * Trust rules (existence is checked separately by the pickers' isWorkspaceDir):
 *   - UNC paths delegate to isUncWorkspace (server + share + >=1 dir below).
 *   - Only absolute drive (X:\...) or POSIX (/...) paths qualify.
 *   - The home dir itself and any ANCESTOR of it are rejected (covers /, /Users,
 *     C:\, C:\Users — never "the whole users tree" as a project).
 *   - Bare filesystem/drive roots are rejected even on OTHER drives (D:\ alone).
 *   - Well-known system trees are rejected by their top-level component:
 *     drive paths: Windows, Program Files, Program Files (x86), ProgramData
 *     (case-insensitive); POSIX: usr, etc, bin, sbin, System, Library (exact —
 *     note /var, /tmp and /private are deliberately NOT denied: real workspaces
 *     live under them in sandboxes/CI, and a cwd there is honest).
 *   - Drive paths compare case-insensitively (NTFS); POSIX paths exactly.
 * Pure.
 * @param {string} p
 * @param {string} homeDir
 * @returns {boolean}
 */
function isTrustedWorkspacePath(p, homeDir) {
    if (typeof p !== 'string' || !p || typeof homeDir !== 'string' || !homeDir) return false;

    // UNC: reuse the share-depth rule.
    if (/^[\\/]{2}/.test(p)) return isUncWorkspace(p);

    const isDrive = /^[A-Za-z]:[\\/]/.test(p);
    if (!isDrive && !p.startsWith('/')) return false; // relative / non-absolute

    const sep = isDrive ? '\\' : '/';
    const canon = (s) => {
        let x = isDrive ? s.replace(/\//g, '\\') : s;
        x = x.replace(/[\\/]+$/, '');
        return isDrive ? x.toLowerCase() : x;
    };
    const cp = canon(p);
    const ch = canon(homeDir);

    // Bare roots: canon('/') === '' and canon('D:\\') === 'd:'.
    if (cp === '' || /^[a-z]:$/.test(cp)) return false;

    // The home itself, or any ancestor of the home.
    if (cp === ch || ch.startsWith(cp + sep)) return false;

    // System trees, by top-level component.
    const top = (isDrive ? cp.slice(3) : cp.slice(1)).split(sep)[0];
    const denied = isDrive
        ? ['windows', 'program files', 'program files (x86)', 'programdata']
        : ['usr', 'etc', 'bin', 'sbin', 'System', 'Library'];
    if (denied.includes(top)) return false;

    return true;
}

/**
 * Given candidate `file://` URIs from a conversation blob, picks the one that is
 * the conversation's real workspace: a local directory under the user's home, OR
 * a trusted absolute path outside it (another drive, /Volumes, a UNC share),
 * excluding the antigravity-cli's own state tree. When several survive (the blob
 * can repeat the path or include over-grabbed variants) the SHORTEST is the
 * workspace root. Pure: the directory check is injected so it is unit-testable.
 *
 * @param {Array<string>} uris
 * @param {{ homeDir: string, isWorkspaceDir: (path:string)=>boolean }} deps
 * @returns {string|null}
 */
function pickWorkspacePath(uris, { homeDir, isWorkspaceDir }) {
    const candidates = (uris || [])
        .map(fileUriToPath)
        .filter(Boolean)
        // Under the home, OR a trusted absolute workspace outside it (another drive,
        // /Volumes, a UNC share): the registered URI is authoritative, so out-of-home
        // is not a reason to distrust it. isTrustedWorkspacePath delegates UNC to
        // isUncWorkspace and rejects roots / home ancestors / system trees.
        .filter(p => isUnderHome(p, homeDir) || isTrustedWorkspacePath(p, homeDir))
        .filter(p => !p.includes(`${path.sep}.gemini${path.sep}antigravity-cli${path.sep}`))
        .filter(p => isWorkspaceDir(p));

    if (candidates.length === 0) return null;
    // Shortest = workspace root (deeper paths are files within it / over-grabs).
    return candidates.sort((a, b) => a.length - b.length)[0];
}

/**
 * Extracts every `"Cwd":"..."` value embedded in a protobuf step blob.
 *
 * Pure helper. Antigravity's RUN_COMMAND steps serialize their tool args as JSON
 * inside the protobuf `step_payload`, including the working directory the command
 * ran in (`{"CommandLine":"...","Cwd":"/abs/path",...}`). For `default-cli-project`
 * sessions (no registered workspace) this is the only reliable signal of where the
 * conversation actually happened, so we recover the project from the agent's own cwd.
 *
 * @param {Buffer} buffer
 * @returns {Array<string>} every Cwd path found (WITH repetition, so callers can
 *   weight by frequency); JSON escapes are decoded.
 */
function extractCwdPathsFromBlob(buffer) {
    const paths = [];
    if (!buffer) return paths;
    const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
    const re = /"Cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        let raw = m[1];
        // Decode the JSON string escapes (\\, \", \/, \n, ...).
        try { raw = JSON.parse(`"${raw}"`); } catch { /* keep raw on odd escapes */ }
        if (raw) paths.push(raw);
    }
    return paths;
}

/**
 * From a list of candidate directory paths (WITH repetition), picks the dominant
 * workspace: the most-frequently-used existing directory under the user's home
 * (or a trusted absolute path outside it — another drive, /Volumes, a UNC share),
 * excluding the antigravity-cli's own state tree. Ties break toward the SHORTEST
 * path (closest to the project root). Pure: the directory check is injected.
 *
 * @param {Array<string>} paths
 * @param {{ homeDir: string, isWorkspaceDir: (path:string)=>boolean }} deps
 * @returns {string|null}
 */
function pickDominantDir(paths, { homeDir, isWorkspaceDir }) {
    const counts = new Map();
    for (const p of paths || []) {
        // Same trust rule as the registered-URI path (and it now also admits UNC cwds,
        // consistent with pickWorkspacePath). The old under-home-only filter is RELAXED
        // deliberately: the dominance count + the existing-dir check + the root/home-
        // ancestor/system-tree exclusions already bar the classic junk cwds, and the
        // strict filter never protected against the common ones anyway (node_modules
        // and build dirs live under the home/project) while it broke the PRIMARY
        // CodeAgentSwarm flow — agy spawned inside a project on another drive is a
        // default-cli-project session whose ONLY signal is this dominant Cwd.
        if (!isUnderHome(p, homeDir) && !isTrustedWorkspacePath(p, homeDir)) continue;
        if (p.includes(`${path.sep}.gemini${path.sep}antigravity-cli${path.sep}`)) continue;
        counts.set(p, (counts.get(p) || 0) + 1);
    }
    if (counts.size === 0) return null;

    const ranked = [...counts.entries()]
        .filter(([p]) => isWorkspaceDir(p))
        .sort((a, b) => (b[1] - a[1]) || (a[0].length - b[0].length));

    return ranked.length ? ranked[0][0] : null;
}

// Per-session cache so repeated history loads don't re-open the same db. Keyed
// by `${id}:${mtime}` so it self-invalidates if the conversation db changes.
const _workspaceCache = new Map();

/**
 * Resolves the absolute workspace directory a conversation was held in, or null
 * when none was recorded (e.g. the `default-cli-project` corpus). Reads the
 * conversation `<id>.db` readonly. Fully fail-safe.
 *
 * @param {string} conversationId
 * @returns {string|null}
 */
function getConversationWorkspace(conversationId) {
    if (!conversationId) return null;

    const dbPath = path.join(getConversationsDir(), `${conversationId}.db`);
    let cacheKey = conversationId;
    try {
        cacheKey = `${conversationId}:${fs.statSync(dbPath).mtimeMs}`;
    } catch {
        return null; // no db on disk → nothing to resolve
    }
    if (_workspaceCache.has(cacheKey)) return _workspaceCache.get(cacheKey);

    let workspace = null;
    try {
        // Lazy + guarded: better-sqlite3 is a native Electron module. Requiring it
        // at module top would break the plain-node consumers of this reader (Jest,
        // cleanup adapter). If it can't load, we simply fail safe to null.
        const Database = require('better-sqlite3');
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const isWorkspaceDir = (p) => {
            try { return fs.statSync(p).isDirectory(); } catch { return false; }
        };
        const homeDir = os.homedir();
        try {
            // 1) Authoritative: the registered workspace URI (sessions started inside
            //    a recognized workspace carry it in trajectory_metadata_blob).
            const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
            const blob = row && row.data ? row.data : null;
            if (blob) {
                workspace = pickWorkspacePath(extractFileUrisFromBlob(blob), { homeDir, isWorkspaceDir });
            }

            // 2) Fallback: dominant Cwd of the agent's RUN_COMMAND steps. Covers
            //    `default-cli-project` sessions (no registered workspace) — e.g. agy
            //    spawned by CodeAgentSwarm inside a project dir. Bounded scan.
            if (!workspace) {
                const cwdPaths = [];
                const rows = db.prepare('SELECT step_payload FROM steps LIMIT 2000').all();
                for (const r of rows) {
                    if (r && r.step_payload) cwdPaths.push(...extractCwdPathsFromBlob(r.step_payload));
                }
                workspace = pickDominantDir(cwdPaths, { homeDir, isWorkspaceDir });
            }
        } finally {
            db.close();
        }
    } catch (error) {
        // Missing table, locked/unsupported db, native module absent — all non-fatal.
        console.error(`[Antigravity getConversationWorkspace] ${conversationId}:`, error.message);
        workspace = null;
    }

    _workspaceCache.set(cacheKey, workspace);
    return workspace;
}

/**
 * Antigravity sessions that belong to `projectPath`, newest first.
 *
 * Mirrors the Codex/Opencode readers' getSessionsForProject so main.js's
 * session-detection handlers ('bookmarks:get-latest-session' /
 * 'sessions:list-existing-ids') can treat agy like every other agent. Storage
 * is FLAT, so membership is derived per conversation via
 * getConversationWorkspace (registered file:// workspace URI, falling back to
 * the dominant RUN_COMMAND Cwd). Conversations with NO recoverable workspace
 * (chat-only sessions) are not attributable to any project and are skipped.
 *
 * Cost: candidates are ordered by artifact mtime and capped, and
 * getConversationWorkspace caches per id:mtime, so repeated calls (one per
 * Enter keypress) only stat files after the first scan.
 *
 * @param {string} projectPath - absolute project directory
 * @param {object} [options]
 * @param {(id: string) => string|null} [options.resolveWorkspace] - injectable for tests
 * @param {number} [options.limit] - max candidate conversations to inspect
 * @param {boolean} [options.caseInsensitive] - path comparison mode (defaults to true on win32)
 * @returns {Array<{sessionId: string, projectPath: string, projectDir: string, timestamp: number, isAntigravity: true, agent: 'antigravity'}>}
 */
function getSessionsForProject(projectPath, options = {}) {
    try {
        if (!projectPath || projectPath === '__sandbox__') return [];
        const resolveWorkspace = options.resolveWorkspace || getConversationWorkspace;
        const limit = options.limit || 500;
        const caseInsensitive = options.caseInsensitive !== undefined
            ? options.caseInsensitive
            : process.platform === 'win32';
        // Trailing separators are the classic mismatch (agy records `C:\dir\`,
        // the app picked `C:\dir`); Windows paths also compare case-insensitively.
        const normalize = (p) => {
            const stripped = String(p).replace(/[\\/]+$/, '');
            return caseInsensitive ? stripped.toLowerCase() : stripped;
        };
        const target = normalize(projectPath);

        const candidates = listConversationIds()
            .map(id => ({ id, mtime: getConversationMtime(id) }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, limit);

        const sessions = [];
        for (const { id, mtime } of candidates) {
            try {
                const workspace = resolveWorkspace(id);
                if (!workspace || normalize(workspace) !== target) continue;
                sessions.push({
                    sessionId: id,
                    projectPath: workspace,
                    projectDir: workspace,
                    timestamp: mtime,
                    isAntigravity: true,
                    agent: 'antigravity'
                });
            } catch (err) {
                console.error(`[getSessionsForProject Antigravity] ${id}:`, err.message);
            }
        }
        // Candidates were sorted by mtime desc, so sessions are already newest-first.
        return sessions;
    } catch (error) {
        console.error('[getSessionsForProject Antigravity] Error:', error);
        return [];
    }
}

/**
 * Checks if a project has any Antigravity conversation history.
 *
 * ── Project-association heuristic ───────────────────────────────────────────
 * Antigravity CLI stores conversations GLOBALLY (flat), unlike Gemini
 * (~/.gemini/projects/<encoded>/) or Claude (~/.claude/projects/<encoded>/).
 * Verified on agy v1.0.13: the clean transcript JSONL carries NO reliable
 * workspace/cwd field — the only absolute paths present are the antigravity-cli
 * app directories themselves and incidental RUN_COMMAND output paths (test
 * conversations were even created with "no active workspace"). The protobuf
 * blobs in the .db could in theory carry a workspace path, but we are
 * explicitly not decoding protobuf.
 *
 * Antigravity's own resume picker is likewise global, not project-scoped, so the
 * honest answer to "does this project have Antigravity history?" is "does ANY
 * Antigravity conversation exist on this machine?". That is exactly how the user
 * will resume them, so we use it as our heuristic (the documented "fall back to
 * any conversations exist" option).
 *
 * We still reject the sandbox / empty project the same way the Gemini & Codex
 * readers do, and we fail safe to `false` on any error.
 *
 * @param {string} projectPath - The absolute path to the project.
 * @returns {boolean} True if Antigravity conversations exist, false otherwise.
 */
function hasConversationsForProject(projectPath) {
    try {
        if (!projectPath || projectPath === '__sandbox__') {
            return false;
        }
        return listConversationIds().length > 0;
    } catch (error) {
        console.error('[hasConversationsForProject Antigravity] Error:', error);
        return false;
    }
}

module.exports = {
    hasConversationsForProject,
    getBaseDir,
    getConversationsDir,
    getBrainDir,
    getTranscriptPath,
    getFullTranscriptPath,
    listConversationIds,
    getConversationMtime,
    getConversationWorkspace,
    getSessionsForProject,
    // Exported for unit testing the pure extraction helpers.
    extractFileUrisFromBlob,
    fileUriToPath,
    isTrustedWorkspacePath,
    pickWorkspacePath,
    extractCwdPathsFromBlob,
    pickDominantDir
};
