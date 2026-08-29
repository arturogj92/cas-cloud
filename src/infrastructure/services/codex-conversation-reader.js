/**
 * Codex Conversation Reader
 *
 * Reads and parses Codex CLI conversation history from the local filesystem.
 *
 * Codex stores sessions in ~/.codex/sessions/YEAR/MONTH/DAY/ as JSONL files.
 * Directory structure: ~/.codex/sessions/2026/01/18/rollout-*.jsonl
 *
 * Each JSONL file contains:
 * - First line: session_meta with payload containing session info
 *   Format: {"type":"session_meta","payload":{"id":"uuid","cwd":"/path","timestamp":"..."}}
 * - Subsequent lines: session events (user input, assistant messages, tool calls)
 *
 * The reader streams files line by line and caches parsed metadata keyed by
 * (path, mtimeMs) so subsequent calls only re-open files that actually changed.
 * This is critical: a previous version called fs.readFileSync on every JSONL
 * just to read the first line, which loaded ~GBs into V8's heap and crashed
 * the process every time a Codex terminal was opened.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safePreviewString } = require('../../shared/utils/preview-string');

const READ_CHUNK_SIZE = 8 * 1024;       // 8 KB read buffer
// Hard ceiling on the first-line read. Codex session_meta lines are at most
// ~15 KB even in 0.130 (which inlines base_instructions). Keeping this small
// guards against any future Codex CLI format change that could grow the line
// unbounded — multiplying ~MB-sized first lines across thousands of rollouts
// is a fast path to V8 heap exhaustion on heavy users.
const FIRST_LINE_BYTE_CAP = 64 * 1024;  // 64 KB
const MAX_LINES_FOR_USER_MESSAGE = 100;

/**
 * Module-level cache: filePath → { mtimeMs, metadata, firstUserMessage }
 * Invalidated automatically by mtime change.
 * `firstUserMessage === undefined` means it has not been computed yet (lazy);
 * `null` means it was computed and is genuinely absent.
 */
const sessionMetadataCache = new Map();

function getSessionsDir() {
    return path.join(os.homedir(), '.codex', 'sessions');
}

/**
 * Reads the first line of a file using fixed-size sync reads, stopping as soon
 * as a `\n` is encountered. Caps at 1 MB if no newline is ever found, to avoid
 * reading pathologically large lines.
 *
 * Replaces the old `fs.readFileSync(file, 'utf8').split('\n')[0]` pattern, which
 * loaded entire multi-MB files into V8 just to grab the first line.
 *
 * @param {string} filePath
 * @returns {string} first line without trailing newline; '' for empty files
 */
function readFirstLine(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
        let line = '';

        while (line.length < FIRST_LINE_BYTE_CAP) {
            const bytesRead = fs.readSync(fd, buf, 0, READ_CHUNK_SIZE, null);
            if (bytesRead === 0) break; // EOF
            const chunk = buf.toString('utf8', 0, bytesRead);
            const nlIdx = chunk.indexOf('\n');
            if (nlIdx !== -1) {
                line += chunk.substring(0, nlIdx);
                return line;
            }
            line += chunk;
        }
        return line.length > FIRST_LINE_BYTE_CAP
            ? line.substring(0, FIRST_LINE_BYTE_CAP)
            : line;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Recursively find all JSONL files in a directory.
 * Codex uses nested date structure: sessions/YEAR/MONTH/DAY/rollout-*.jsonl
 * @param {string} dir
 * @param {boolean} [throwOnError=false]
 * @returns {Array<string>}
 */
function findAllJsonlFiles(dir, throwOnError = false) {
    const files = [];
    if (!fs.existsSync(dir)) return files;

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...findAllJsonlFiles(fullPath, throwOnError));
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(fullPath);
            }
        }
    } catch (err) {
        if (throwOnError) throw err;
        console.error(`[Codex] Error reading directory ${dir}:`, err.message);
    }
    return files;
}

/**
 * Parses session metadata from the first line of a JSONL file.
 * Format: {"type":"session_meta","payload":{"id":"...","cwd":"...","timestamp":"..."}}
 * @param {string} firstLine
 * @returns {object|null}
 */
function parseSessionMetadata(firstLine) {
    try {
        const parsed = JSON.parse(firstLine);
        if (parsed.type === 'session_meta' && parsed.payload) {
            return {
                sessionId: parsed.payload.id || null,
                cwd: parsed.payload.cwd || null,
                timestamp: parsed.payload.timestamp || null,
                model: parsed.payload.model || null
            };
        }
        return {
            sessionId: parsed.session_id || parsed.id || null,
            cwd: parsed.cwd || parsed.project_path || parsed.workingDirectory || null,
            timestamp: parsed.timestamp || null,
            model: parsed.model || null
        };
    } catch {
        return null;
    }
}

/**
 * Tries to extract a user message text from a single JSONL event line.
 * Returns null if the line is not a user message or is filtered context.
 * @param {string} line
 * @returns {string|null}
 */
function parseUserMessageLine(line) {
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        return null;
    }

    let text = null;

    if (event.type === 'response_item' &&
        event.payload?.type === 'message' &&
        event.payload?.role === 'user') {
        const contentArray = event.payload?.content;
        if (Array.isArray(contentArray) && contentArray.length > 0) {
            const textContent = contentArray.find(c => c.type === 'input_text');
            if (textContent?.text) text = textContent.text;
        }
    }

    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
        text = event.payload?.message;
    }

    if (text && typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed.startsWith('<environment_context>') ||
            trimmed.startsWith('<environment>') ||
            trimmed.startsWith('<recommended_plugins>') ||
            trimmed.startsWith('<?xml') ||
            trimmed.startsWith('<INSTRUCTIONS>') ||
            trimmed.startsWith('# AGENTS.md') ||
            trimmed.startsWith('# CLAUDE.md') ||
            trimmed.startsWith('# Instructions') ||
            trimmed.includes('instructions for /Users/')) {
            return null;
        }
        if (trimmed.length > 0) return trimmed;
    }
    return null;
}

/**
 * Streams a JSONL file line-by-line (skipping the first line, which is meta)
 * and returns the first user message text, stopping as soon as one is found
 * or after MAX_LINES_FOR_USER_MESSAGE lines, whichever comes first.
 * @param {string} filePath
 * @returns {string|null}
 */
function extractFirstUserMessageFromFile(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
        let pending = '';
        let linesProcessed = 0;
        let isFirstLine = true;

        while (linesProcessed < MAX_LINES_FOR_USER_MESSAGE) {
            const bytesRead = fs.readSync(fd, buf, 0, READ_CHUNK_SIZE, null);
            if (bytesRead === 0) {
                if (pending.length > 0 && !isFirstLine) {
                    const msg = parseUserMessageLine(pending);
                    if (msg) return safePreviewString(msg);
                }
                return null;
            }
            pending += buf.toString('utf8', 0, bytesRead);

            let nlIdx;
            while ((nlIdx = pending.indexOf('\n')) !== -1 &&
                   linesProcessed < MAX_LINES_FOR_USER_MESSAGE) {
                const line = pending.substring(0, nlIdx);
                pending = pending.substring(nlIdx + 1);
                if (isFirstLine) {
                    isFirstLine = false;
                    continue;
                }
                linesProcessed++;
                const msg = parseUserMessageLine(line);
                if (msg) return safePreviewString(msg);
            }
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Returns cached session entry if it matches the current mtime, otherwise null.
 * @param {string} filePath
 * @param {number} mtimeMs
 * @returns {{metadata: object|null, firstUserMessage: string|null|undefined}|null}
 */
function getCachedEntry(filePath, mtimeMs) {
    const cached = sessionMetadataCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    return null;
}

/**
 * Stores or updates the cache entry for a file. Mutates an existing entry
 * when present to allow incremental population (metadata first, user message
 * later).
 * @param {string} filePath
 * @param {number} mtimeMs
 * @param {{metadata?: object|null, firstUserMessage?: string|null}} updates
 */
function setCachedEntry(filePath, mtimeMs, updates) {
    const existing = sessionMetadataCache.get(filePath);
    if (existing && existing.mtimeMs === mtimeMs) {
        Object.assign(existing, updates);
        return;
    }
    sessionMetadataCache.set(filePath, {
        mtimeMs,
        metadata: updates.metadata !== undefined ? updates.metadata : null,
        firstUserMessage: updates.firstUserMessage  // may stay undefined
    });
}

/**
 * Clears the in-memory metadata cache. Exposed primarily for tests and for
 * future use cases (e.g. logout, manual refresh).
 */
function clearCache() {
    sessionMetadataCache.clear();
}

/**
 * Reads metadata for a file, using the cache when fresh.
 * @param {string} filePath
 * @returns {{metadata: object|null, mtimeMs: number, mtime: Date}|null}
 */
function readMetadataCached(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return null;
    }

    const cached = getCachedEntry(filePath, stat.mtimeMs);
    if (cached) return { metadata: cached.metadata, mtimeMs: stat.mtimeMs, mtime: stat.mtime };

    let metadata = null;
    try {
        const firstLine = readFirstLine(filePath);
        if (firstLine) metadata = parseSessionMetadata(firstLine);
    } catch (err) {
        console.error(`[Codex] readFirstLine failed for ${path.basename(filePath)}:`, err.message);
    }
    setCachedEntry(filePath, stat.mtimeMs, { metadata });
    return { metadata, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
}

/**
 * Checks if a project has any Codex conversation history.
 * @param {string} projectPath - Absolute path to the project
 * @returns {boolean}
 */
function hasConversationsForProject(projectPath) {
    try {
        if (!projectPath || projectPath === '__sandbox__') return false;

        const sessionsDir = getSessionsDir();
        if (!fs.existsSync(sessionsDir)) return false;

        const jsonlFiles = findAllJsonlFiles(sessionsDir);
        if (jsonlFiles.length === 0) return false;

        for (const filePath of jsonlFiles) {
            const entry = readMetadataCached(filePath);
            if (entry?.metadata && entry.metadata.cwd === projectPath) return true;
        }
        return false;
    } catch (error) {
        console.error('[hasConversationsForProject Codex] Error:', error);
        return false;
    }
}

/**
 * Gets all Codex sessions, optionally filtered by project path.
 * @param {string|null} projectPath
 * @returns {Array<object>}
 */
function getSessionsForProject(projectPath = null) {
    try {
        const sessionsDir = getSessionsDir();
        if (!fs.existsSync(sessionsDir)) return [];

        const jsonlFiles = findAllJsonlFiles(sessionsDir);
        const sessions = [];

        for (const filePath of jsonlFiles) {
            try {
                const entry = readMetadataCached(filePath);
                if (!entry?.metadata) continue;

                const sessionCwd = entry.metadata.cwd || 'Unknown';
                if (projectPath && sessionCwd !== projectPath) continue;

                const cached = sessionMetadataCache.get(filePath);
                let firstUserMessage = cached?.firstUserMessage;
                if (firstUserMessage === undefined) {
                    firstUserMessage = extractFirstUserMessageFromFile(filePath);
                    setCachedEntry(filePath, entry.mtimeMs, { firstUserMessage });
                }

                const sessionId = entry.metadata.sessionId || path.basename(filePath, '.jsonl');
                let title = 'Codex Session';
                if (firstUserMessage) {
                    title = firstUserMessage.length > 100
                        ? firstUserMessage.substring(0, 100) + '...'
                        : firstUserMessage;
                }

                sessions.push({
                    sessionId,
                    title,
                    projectPath: sessionCwd,
                    projectDir: sessionCwd,
                    timestamp: entry.mtime.getTime(),
                    lastModified: entry.mtime.toISOString(),
                    isCodex: true,
                    isGemini: false,
                    agent: 'codex',
                    filePath
                });
            } catch (error) {
                console.error(`[Codex] Error parsing session file ${path.basename(filePath)}:`, error.message);
                continue;
            }
        }

        sessions.sort((a, b) => b.timestamp - a.timestamp);
        return sessions;
    } catch (error) {
        console.error('[getSessionsForProject Codex] Error:', error);
        return [];
    }
}

/**
 * Gets all Codex sessions for the conversation-history list, capped at `limit`.
 * @param {number} limit
 * @returns {Array<object>}
 */
function getAllSessions(limit = 100) {
    return getSessionsForProject(null).slice(0, limit);
}

/**
 * Depth-first search for the rollout file of ONE session, stopping at the first
 * hit. Codex names every rollout `rollout-<ISO timestamp>-<session uuid>.jsonl`,
 * so the id is in the FILENAME and no file has to be opened to find it.
 *
 * Deliberately not `findAllJsonlFiles` + filter: this runs on the terminal-open
 * path (see session-workdir-resolver), where enumerating every rollout a heavy
 * Codex user has accumulated, on every open, is exactly the per-terminal tarpit
 * we avoid elsewhere. Early exit keeps the common case to a few readdirs.
 * @param {string} dir
 * @param {string} sessionId
 * @param {boolean} [throwOnError=false]
 * @returns {string|null} absolute path of the rollout file, or null
 */
function findSessionFileById(dir, sessionId, throwOnError = false) {
    if (!fs.existsSync(dir)) return null;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        if (throwOnError) throw err;
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
    // Newest first: Codex partitions by YEAR/MONTH/DAY, so a descending walk finds
    // recent sessions (the ones being resumed) with the fewest readdirs.
    subdirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    for (const sub of subdirs) {
        const hit = findSessionFileById(sub, sessionId, throwOnError);
        if (hit) return hit;
    }
    return null;
}

/**
 * Whether Codex has a rollout for this session id.
 * This deliberately does not require a recorded cwd: a valid conversation may
 * outlive its original worktree, which the normal restore flow can recreate.
 * @param {string} sessionId
 * @returns {boolean}
 */
function hasSession(sessionId) {
    try {
        if (!sessionId) return false;
        const sessionsDir = getSessionsDir();
        if (findSessionFileById(sessionsDir, sessionId, true)) return true;

        // Imported/renamed rollouts may not carry their id in the filename.
        return findAllJsonlFiles(sessionsDir, true).some((filePath) => (
            parseSessionMetadata(readFirstLine(filePath))?.sessionId === sessionId
        ));
    } catch (error) {
        console.error('[Codex] hasSession failed:', error.message);
        return true;
    }
}

/**
 * The directory a session was recorded in (`session_meta.payload.cwd`), or null.
 *
 * Resuming a Codex session from any OTHER directory makes its TUI block on
 * "Choose working directory to resume this session" (verified against
 * codex-cli 0.144.6), so this is the directory the terminal must be born in.
 * @param {string} sessionId
 * @returns {string|null}
 */
function getSessionWorkDir(sessionId) {
    try {
        if (!sessionId) return null;
        const sessionsDir = getSessionsDir();
        if (!fs.existsSync(sessionsDir)) return null;

        const byName = findSessionFileById(sessionsDir, sessionId);
        if (byName) {
            const metadata = parseSessionMetadata(readFirstLine(byName));
            if (metadata && metadata.cwd) return metadata.cwd;
        }

        // Fallback for rollouts whose recorded id does NOT match their filename
        // (imported/renamed files): pay the full enumeration only then.
        for (const filePath of findAllJsonlFiles(sessionsDir)) {
            const entry = readMetadataCached(filePath);
            if (entry?.metadata?.sessionId === sessionId && entry.metadata.cwd) {
                return entry.metadata.cwd;
            }
        }
        return null;
    } catch (error) {
        console.error('[Codex] getSessionWorkDir failed:', error.message);
        return null;
    }
}

module.exports = {
    hasConversationsForProject,
    getSessionsForProject,
    getAllSessions,
    getSessionsDir,
    hasSession,
    getSessionWorkDir,
    readFirstLine,
    clearCache
};
