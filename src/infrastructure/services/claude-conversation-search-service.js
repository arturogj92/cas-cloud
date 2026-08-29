/**
 * Claude Conversation Search Service
 * Searches and retrieves conversation history from Claude Code
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { createReadStream } = require('fs');
const readline = require('readline');
const { safePreviewString } = require('../../shared/utils/preview-string');
const { findNormalizedMatch, matchesNormalized } = require('../../shared/utils/normalized-text-search');
const { buildRecentProjectMatcher, normalizeWorktreePath, parentEncodedNameOfWorktreeDir } = require('./claude-project-path-resolver');
const claudeBgAgents = require('./cli-agents/claude-bg-agents');

class ClaudeConversationSearchService {
    constructor() {
        this.claudeDir = path.join(os.homedir(), '.claude');
        this.historyFile = path.join(this.claudeDir, 'history.jsonl');
        this.projectsDir = path.join(this.claudeDir, 'projects');
    }

    /**
     * Get recent conversations by scanning project directories
     * @param {number} limit - Number of conversations to retrieve (default 200)
     * @param {Array<string>} recentProjectPaths - Optional array of recent project paths to filter by
     * @param {string} selectedProjectPath - Optional: return up to `limit` conversations of this
     *   project ONLY. Overrides recentProjectPaths; matching is tolerant (case/symlink/worktree).
     * @returns {Promise<Array>} Array of conversation objects
     */
    async getRecentConversations(limit = 200, recentProjectPaths = null, selectedProjectPath = null, onProgress = null) {
        const startTime = Date.now();
        const timings = {};

        try {
            try {
                await fsPromises.access(this.projectsDir);
            } catch {
                return [];
            }

            // A selected project OVERRIDES the recent-projects filter: the resume panel
            // fetches with its project FIXED, and that project may not even be among the
            // 20 most recent. Scoping the directory scan to that single project also makes
            // the lookup tolerant (the matcher folds case/symlink/worktree divergence)
            // and cheap (only that project's files are read).
            const effectiveRecentPaths = selectedProjectPath
                ? [normalizeWorktreePath(selectedProjectPath)]
                : recentProjectPaths;

            // Debug logging
            console.log('[Conversation Search] Starting search with filter:', {
                hasFilter: !!effectiveRecentPaths,
                filterCount: effectiveRecentPaths ? effectiveRecentPaths.length : 0,
                filterPaths: effectiveRecentPaths ? effectiveRecentPaths.slice(0, 5) : []
            });

            const t1 = Date.now();

            // Get all project directories (async, single call with withFileTypes)
            const dirEntries = await fsPromises.readdir(this.projectsDir, { withFileTypes: true });
            let projectDirs = dirEntries.filter(e => e.isDirectory()).map(e => e.name);

            // 🚀 Filter directories by recentProjectPaths before scanning files
            // AND sort by recency so most recently opened projects are scanned first.
            // This ensures early batch results contain the most relevant conversations,
            // reducing visual jumping when partial results stream to the UI.
            // Built once when filtering by recent projects; reused both to filter
            // the on-disk folders here AND to filter each conversation by its
            // recorded working directory below (both need the same tolerance).
            let recentMatcher = null;
            if (effectiveRecentPaths && effectiveRecentPaths.length > 0) {
                // Match on-disk project folders against recent projects tolerating
                // symlink + letter-case divergence: Claude derives its folder from
                // process.cwd() (symlinks resolved, canonical case), which may differ
                // from the app-stored path. An exact-string filter would drop such a
                // project's folder, hiding all its conversations. See task #11664.
                recentMatcher = buildRecentProjectMatcher(effectiveRecentPaths);
                const matcher = recentMatcher;
                const beforeCount = projectDirs.length;
                projectDirs = projectDirs.filter(dir => matcher.matches(dir));

                // Sort by recency: most recently opened projects first
                projectDirs.sort((a, b) =>
                    (matcher.recencyOf(a) ?? Infinity) - (matcher.recencyOf(b) ?? Infinity));

                console.log(`[Directory Filter] Reduced from ${beforeCount} to ${projectDirs.length} directories (sorted by recency)`);
            }

            // 🚀 Collect all file entries first, then batch stat them async
            const allFileEntries = [];
            const UUID_JSONL_REGEX = /^[0-9a-f-]{36}\.jsonl$/;
            for (const projectDir of projectDirs) {
                const projectPath = path.join(this.projectsDir, projectDir);
                try {
                    const dirFiles = await fsPromises.readdir(projectPath);
                    for (const file of dirFiles) {
                        if (file.endsWith('.jsonl') && UUID_JSONL_REGEX.test(file)) {
                            allFileEntries.push({
                                filePath: path.join(projectPath, file),
                                sessionId: file.replace('.jsonl', ''),
                                projectDir
                            });
                        }
                    }
                } catch {
                    // Skip directories that can't be read
                }
            }

            // 🚀 Batch stat files async (100 per batch to avoid fd exhaustion)
            const STAT_BATCH_SIZE = 100;
            const allFiles = [];
            for (let i = 0; i < allFileEntries.length; i += STAT_BATCH_SIZE) {
                const batch = allFileEntries.slice(i, i + STAT_BATCH_SIZE);
                const statResults = await Promise.all(
                    batch.map(async (entry) => {
                        try {
                            const stats = await fsPromises.stat(entry.filePath);
                            return { ...entry, stats };
                        } catch { return null; }
                    })
                );
                allFiles.push(...statResults.filter(Boolean));
            }

            timings.scanDirectories = Date.now() - t1;
            console.log(`[Parallel Processing] Processing ${allFiles.length} files in parallel batches`);
            console.log(`⏱️  [TIMING] Directory scan: ${timings.scanDirectories}ms`);

            const t2 = Date.now();

            // 🚀 INDEX-BACKED PROCESSING
            // Parsing the content of EVERY file on every open is O(total
            // conversations) — ~6s cold for a few thousand files, the reported
            // ~15s on slower/cold disks. Instead we keep a persistent metadata
            // index keyed by file path: files whose (mtime,size) are unchanged
            // are served from the index with ZERO file I/O, and only new/changed
            // files are parsed. So the expensive full parse happens ONCE (cold
            // index, masked by the instant get-index skeleton + per-batch
            // onProgress); every later open — even after an app restart or with a
            // cold OS file cache — reads metadata straight from SQLite and opens
            // near-instantly. The store degrades to a no-op if better-sqlite3 is
            // unavailable, in which case every file is a "miss" and we behave
            // exactly like before (zero regression).
            const ConversationIndexStore = require('./conversation-index-store');
            if (!this._indexStore) {
                this._indexStore = ConversationIndexStore.getShared();
            }
            const indexStore = this._indexStore;
            const indexedMap = indexStore.getIndexedMap('claude');

            // Newest first so per-batch onProgress streams the most recent
            // conversations to the UI first (downstream sorting is unchanged).
            allFiles.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

            const BATCH_SIZE = 50;
            const conversations = [];
            const rowsToUpsert = [];

            // Turn parsed/cached file info into a UI conversation object (or null
            // if it should be hidden). Identical shape/filters to the old path.
            const buildConversation = (entry, fileInfo) => {
                const { sessionId, projectDir, stats } = entry;
                if (!fileInfo.firstUserMessage || fileInfo.firstUserMessage.trim() === '') return null;
                if (fileInfo.firstUserMessage.startsWith('Generate a git commit message')) return null;
                // A conversation run inside a per-conversation worktree records its cwd as
                // <repo>/.codeagentswarm/worktrees/<slug>. Attribute it to the PARENT repo so
                // it matches the registered project and groups/displays under it instead of
                // appearing as a separate project named after the worktree slug. No-op for
                // every normal (non-worktree) path.
                const rawProjectSource = fileInfo.workingDirectory || this.decodeProjectPath(projectDir);
                const projectPathResolved = normalizeWorktreePath(rawProjectSource);
                if (effectiveRecentPaths && effectiveRecentPaths.length > 0 && !fileInfo.workingDirectory) return null;
                if (recentMatcher && !recentMatcher.matchesProjectPath(projectPathResolved)) return null;
                const projectName = this.extractProjectName(projectPathResolved);
                // Flag conversations that ran inside a per-conversation worktree so the
                // history can mark them. The raw cwd contains ".codeagentswarm/worktrees/"
                // (so normalize changes it); for cache hits the cwd is already normalized,
                // so we also fall back to the on-disk encoded folder name, which keeps the
                // worktree marker. No-op (false) for every normal path.
                const isWorktree = (projectPathResolved !== rawProjectSource)
                    || parentEncodedNameOfWorktreeDir(projectDir) !== null;
                // "Updated" = the LAST real message, not file mtime: Claude Code
                // appends small metadata lines (ai-title/mode/permission-mode)
                // whenever a session is reopened/resumed, which bumps mtime and
                // made days-old conversations claim they were updated "just now".
                const lastActivityMs = fileInfo.lastMessageTs || stats.mtimeMs;
                return {
                    sessionId,
                    projectPath: projectPathResolved,
                    projectName,
                    projectDir,
                    isWorktree,
                    displayText: fileInfo.firstUserMessage || 'Untitled conversation',
                    display: fileInfo.firstUserMessage || 'Untitled conversation',
                    timestamp: lastActivityMs,
                    createdAt: stats.birthtimeMs,
                    updatedAt: lastActivityMs,
                    relativeTime: this.getRelativeTime(lastActivityMs),
                    parentSessionIds: fileInfo.parentSessionIds,
                    isContinuation: fileInfo.isContinuation
                };
            };

            // Partition the scanned files into cache-hits (free) and misses
            // (new or changed -> must parse). A file is a hit ONLY if BOTH its
            // mtime AND size are unchanged, so any edit/append/continuation is
            // re-parsed and the row updated — nothing goes stale, nothing is lost.
            const toParse = [];
            for (const entry of allFiles) {
                const row = indexedMap.get(entry.filePath);
                if (row && row.mtime_ms === entry.stats.mtimeMs && row.size_bytes === entry.stats.size) {
                    const conv = buildConversation(entry, this._fileInfoFromRow(row));
                    if (conv) conversations.push(conv);
                } else {
                    toParse.push(entry);
                }
            }

            console.log(`[Index] ${conversations.length} from cache, ${toParse.length} to (re)parse`);

            // Parse every miss (new/changed files) in parallel batches. We do NOT
            // cap this: capping risked older conversations being briefly missing
            // from search on the very first build. The full parse is a ONE-TIME
            // cost (cold index); once indexed, misses ≈ 0 so opens are instant.
            // The instant skeleton (get-index) + per-batch onProgress keep the UI
            // responsive while this runs the first time.
            for (let i = 0; i < toParse.length; i += BATCH_SIZE) {
                const batch = toParse.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(
                    batch.map(async (entry) => {
                        try {
                            const fileInfo = await this.parseConversationFile(entry.filePath, entry.sessionId);
                            // Tail-scan for the last real message time (see
                            // buildConversation for why mtime is not enough).
                            fileInfo.lastMessageTs = await this._readLastMessageTimestamp(entry.filePath, entry.stats.size);
                            rowsToUpsert.push(this._buildIndexRow(entry, fileInfo));
                            return buildConversation(entry, fileInfo);
                        } catch (error) {
                            console.error(`Error processing file ${entry.sessionId}:`, error);
                            return null;
                        }
                    })
                );
                const validResults = results.filter(r => r !== null);
                conversations.push(...validResults);
                if (onProgress && validResults.length > 0) {
                    onProgress(validResults);
                }
            }

            // Persist newly parsed metadata so the next open is instant.
            indexStore.upsertMany(rowsToUpsert);

            timings.fileProcessing = Date.now() - t2;
            console.log(`⏱️  [TIMING] File processing (parallel): ${timings.fileProcessing}ms`);

            const groupingStartedAt = Date.now();

            // ✅ OPTIMIZED: Group chains without reading files again
            const grouped = await this.groupConversationChainsOptimized(conversations);

            timings.grouping = Date.now() - groupingStartedAt;
            console.log(`⏱️  [TIMING] Grouping chains: ${timings.grouping}ms`);

            // Hide sessions that are currently running as background agents.
            // They can't be resumed with `claude -r <id>` (Claude rejects the
            // double-resume and exits 1, and the TUI swallows the error), so they
            // must not appear in the resume list. Interactive sessions resume fine
            // and stay visible. Best-effort: on any failure this keeps everything.
            const backgroundSessionIds = await this.getBackgroundAgentSessionIds();
            const visibleConversations = this.excludeActiveSessions(grouped, backgroundSessionIds);
            if (backgroundSessionIds.size > 0) {
                const hidden = grouped.length - visibleConversations.length;
                if (hidden > 0) {
                    console.log(`[Live Filter] Hid ${hidden} running background agent(s) from the resume list`);
                }
            }

            // Group by project first
            const byProject = new Map();
            for (const conv of visibleConversations) {
                const projectPath = conv.projectPath || 'unknown';
                if (!byProject.has(projectPath)) {
                    byProject.set(projectPath, []);
                }
                byProject.get(projectPath).push(conv);
            }

            let result;

            if (selectedProjectPath) {
                // The scan was scoped to the selected project via effectiveRecentPaths,
                // so every visible conversation already belongs to it. No exact-key
                // lookup here: the recorded cwd may differ from the app-stored path by
                // case/symlink/worktree and byProject keys would miss.
                result = [...visibleConversations]
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, limit);
                console.log(`[LIMIT] Selected project "${selectedProjectPath.split('/').pop()}": ${result.length} of ${visibleConversations.length} conversations`);
            } else {
                // Apply limit PER PROJECT (40 max per project) to ensure all projects are represented
                // Then apply global limit (200)
                const limitPerProject = 40;
                const perProjectResults = [];

                for (const [projectPath, convs] of byProject) {
                    // convs already sorted by timestamp desc from groupConversationChainsOptimized
                    const projectConvs = convs.slice(0, limitPerProject);
                    perProjectResults.push(...projectConvs);
                }

                // Sort combined results by timestamp desc and apply global limit
                result = perProjectResults
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, limit);

                console.log(`[LIMIT] ${byProject.size} projects, ${limitPerProject}/project max, ${result.length} total (limit ${limit})`);
            }

            timings.total = Date.now() - startTime;
            console.log(`⏱️  [TIMING SUMMARY] Total: ${timings.total}ms | Scan: ${timings.scanDirectories}ms | Process: ${timings.fileProcessing}ms | Group: ${timings.grouping}ms`);
            console.log(`⏱️  [PERFORMANCE] Processed ${allFiles.length} files, ${byProject.size} projects, returned ${result.length} conversations in ${timings.total}ms`);

            return result;

        } catch (error) {
            console.error('Error reading conversation history:', error);
            return [];
        }
    }

    /**
     * Extract text content from message content (handles different formats)
     * @param {*} content - Message content (string, array, or object)
     * @returns {string} Extracted text content
     */
    extractTextContent(content) {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            const textBlock = content.find(block => block.type === 'text');
            return textBlock?.text || '';
        }

        if (content && typeof content === 'object' && content.text) {
            return content.text;
        }

        return '';
    }

    /**
     * Parse conversation file in a SINGLE pass to extract all needed information
     * This replaces multiple file reads (getFirstUserMessage, getWorkingDirectory, extractParentSessionIds)
     * @param {string} filePath - Path to conversation file
     * @param {string} sessionId - Current session ID
     * @returns {Promise<Object>} Object with all extracted info
     */
    async parseConversationFile(filePath, sessionId) {
        const startTime = Date.now();
        let linesRead = 0;

        const info = {
            firstUserMessage: null,
            workingDirectory: null,
            parentSessionIds: new Set(),
            isContinuation: false
        };

        try {
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            let firstUserFound = false;
            const MAX_LINES_TO_READ = 300; // 🚀 Límite para capturar parent sessionIds

            for await (const line of rl) {
                linesRead++;
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);

                        // Extract working directory (only from first line typically)
                        if (!info.workingDirectory && entry.cwd) {
                            info.workingDirectory = entry.cwd;
                        }

                        // Extract parent sessionIds (all lines that have different sessionId)
                        if (entry.sessionId && entry.sessionId !== sessionId) {
                            info.parentSessionIds.add(entry.sessionId);
                        }

                        // Extract first user message (skip sidechain messages)
                        if (!firstUserFound &&
                            entry.isSidechain !== true &&
                            entry.message?.role === 'user') {

                            const textContent = this.extractTextContent(entry.message.content);

                            if (textContent) {
                                // Cap + flatten BEFORE substring to break V8 SlicedString
                                // amplification (200+ conversations × multi-KB textContent
                                // accumulated to >100 MB on heavy users in v1.4.2).
                                const safeContent = safePreviewString(textContent);
                                info.firstUserMessage = safeContent
                                    .substring(0, 100)
                                    .replace(/\n/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim();

                                // Detect if this is a continuation conversation. We check
                                // on the capped string — the marker is short and always
                                // appears at the start, so it survives the 8 KB cap.
                                if (safeContent.includes('This session is being continued from a previous conversation')) {
                                    info.isContinuation = true;
                                }

                                firstUserFound = true;
                            }
                        }

                        // 🚀 EARLY EXIT: Stop reading after MAX_LINES if we have essential info
                        if (linesRead >= MAX_LINES_TO_READ && info.workingDirectory && firstUserFound) {
                            rl.close(); // Close stream to stop reading
                            fileStream.destroy(); // Destroy file stream
                            break;
                        }

                    } catch (e) {
                        // Skip invalid JSON lines
                    }
                }
            }

            const elapsed = Date.now() - startTime;

            // Log slow files (>30ms con Early Exit debería ser raro)
            if (elapsed > 30) {
                console.log(`⚠️  [SLOW FILE] ${sessionId.substring(0, 8)}: ${elapsed}ms (${linesRead} lines read)`);
            }

            return {
                ...info,
                parentSessionIds: Array.from(info.parentSessionIds)
            };

        } catch (error) {
            console.error('Error parsing conversation file:', error);
            return {
                firstUserMessage: null,
                workingDirectory: null,
                parentSessionIds: [],
                isContinuation: false
            };
        }
    }

    /**
     * Reconstruct the parseConversationFile() shape from a persisted index row,
     * so cache hits flow through EXACTLY the same downstream code as fresh parses.
     * Files indexed as "no user message" (has_user_message = 0) come back with a
     * null firstUserMessage and are skipped by buildConversation — without ever
     * re-reading the file.
     */
    _fileInfoFromRow(row) {
        let parentSessionIds = [];
        try { parentSessionIds = JSON.parse(row.parent_session_ids || '[]'); } catch (_) {}
        return {
            firstUserMessage: row.has_user_message ? row.display_text : null,
            workingDirectory: row.project_path || null,
            parentSessionIds,
            isContinuation: !!row.is_continuation,
            // timestamp_ms persists the last-message time computed at parse time
            // (falls back to mtime for files where no timestamped message exists).
            lastMessageTs: row.timestamp_ms || null
        };
    }

    /**
     * Build a persistent index row from a scanned file entry + its parsed info.
     */
    _buildIndexRow(entry, fileInfo) {
        const ConversationIndexStore = require('./conversation-index-store');
        // Persist the PARENT repo for worktree conversations so the indexed
        // project_path/project_name stay consistent with the live display path
        // (see buildConversation). No-op for normal paths.
        const normalizedWorkingDir = normalizeWorktreePath(fileInfo.workingDirectory || '');
        const projectPathResolved = normalizedWorkingDir || this.decodeProjectPath(entry.projectDir);
        return ConversationIndexStore.buildRow({
            filePath: entry.filePath,
            agent: 'claude',
            sessionId: entry.sessionId,
            projectDir: entry.projectDir,
            projectPath: normalizedWorkingDir,
            projectName: this.extractProjectName(projectPathResolved),
            displayText: fileInfo.firstUserMessage || '',
            hasUserMessage: !!(fileInfo.firstUserMessage && fileInfo.firstUserMessage.trim()),
            parentSessionIds: fileInfo.parentSessionIds,
            isContinuation: fileInfo.isContinuation,
            mtimeMs: entry.stats.mtimeMs,
            sizeBytes: entry.stats.size,
            timestampMs: fileInfo.lastMessageTs || entry.stats.mtimeMs
        });
    }

    /**
     * Timestamp (epoch ms) of the LAST real message in a transcript, found by
     * scanning the file backwards in chunks. Claude Code appends small metadata
     * lines (ai-title / mode / permission-mode) every time a session is
     * reopened, so file mtime can claim a days-old conversation was updated
     * "just now". Returns null when no timestamped user/assistant entry is
     * found within the scanned tail (caller falls back to mtime).
     */
    async _readLastMessageTimestamp(filePath, fileSize) {
        const CHUNK_SIZE = 64 * 1024;
        const MAX_SCAN_BYTES = 1024 * 1024;
        if (!fileSize) return null;
        let fileHandle;
        try {
            fileHandle = await fsPromises.open(filePath, 'r');
            let position = fileSize;
            // First (possibly partial) line of the later chunk, carried so lines
            // cut at a chunk boundary are reassembled on the next iteration.
            let carry = '';
            while (position > 0 && (fileSize - position) < MAX_SCAN_BYTES) {
                const readSize = Math.min(CHUNK_SIZE, position);
                position -= readSize;
                const buffer = Buffer.alloc(readSize);
                await fileHandle.read(buffer, 0, readSize, position);
                const lines = (buffer.toString('utf8') + carry).split('\n');
                carry = position > 0 ? lines.shift() : '';
                for (let i = lines.length - 1; i >= 0; i--) {
                    const ts = this._messageTimestampFromLine(lines[i]);
                    if (ts) return ts;
                }
            }
            return null;
        } catch (_) {
            return null;
        } finally {
            if (fileHandle) await fileHandle.close().catch(() => {});
        }
    }

    _messageTimestampFromLine(line) {
        const trimmed = (line || '').trim();
        if (!trimmed || !trimmed.includes('"timestamp"')) return null;
        try {
            const entry = JSON.parse(trimmed);
            if (!entry.timestamp) return null;
            if (entry.type !== 'user' && entry.type !== 'assistant') return null;
            const ms = new Date(entry.timestamp).getTime();
            return Number.isNaN(ms) ? null : ms;
        } catch (_) {
            return null;
        }
    }

    /**
     * Get working directory from first line of conversation file
     * @param {string} filePath - Path to conversation file
     * @returns {Promise<string|null>} Working directory or null
     */
    async getWorkingDirectory(filePath) {
        try {
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);
                        // The cwd field contains the real project path
                        if (entry.cwd) {
                            return entry.cwd;
                        }
                    } catch (e) {
                        // Skip invalid lines
                    }
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Get first user message from conversation file
     * @param {string} filePath - Path to conversation file
     * @returns {Promise<string>} First user message or empty string
     */
    async getFirstUserMessage(filePath) {
        try {
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);

                        // Skip sidechain messages (warmup and other internal conversations)
                        if (entry.isSidechain === true) {
                            continue;
                        }

                        if (entry.message && entry.message.role === 'user') {
                            const content = entry.message.content;
                            let textContent = '';

                            // Handle different content formats
                            if (typeof content === 'string') {
                                textContent = content;
                            } else if (Array.isArray(content)) {
                                // Extract text from array format: [{"type":"text","text":"..."}]
                                const textBlock = content.find(block => block.type === 'text');
                                if (textBlock && textBlock.text) {
                                    textContent = textBlock.text;
                                }
                            } else if (content && typeof content === 'object' && content.text) {
                                // Handle object format: {"type":"text","text":"..."}
                                textContent = content.text;
                            }

                            // Clean and limit text
                            if (textContent) {
                                return textContent
                                    .substring(0, 100)
                                    .replace(/\n/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim();
                            }
                        }
                    } catch (e) {
                        // Skip invalid lines
                    }
                }
            }

            return '';
        } catch (error) {
            return '';
        }
    }

    /**
     * Normalize string by removing accents/diacritics
     * @param {string} str - String to normalize
     * @returns {string} Normalized string without accents
     */
    normalizeString(str) {
        if (!str) return '';
        // NFD = Normalization Form Canonical Decomposition
        // Separates base characters from combining diacritical marks
        // Then we remove all diacritical marks using Unicode property escape
        return str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    }

    /**
     * Search conversations by title/display text
     * @param {string} query - Search query
     * @param {Array<string>} recentProjectPaths - Optional array of recent project paths to filter by
     * @param {number} limit - Max results
     * @returns {Promise<Array>} Matching conversations
     */
    async searchByTitle(query, recentProjectPaths = null, limit = 50) {
        try {
            // Get all conversations (not just recent 20), filtered by recent projects
            // Note: getRecentConversations already applies grouping
            const allConversations = await this.getRecentConversations(2000, recentProjectPaths);
            const normalizedQuery = this.normalizeString(query.toLowerCase());

            const results = allConversations
                .filter(conv => {
                    const display = (conv.displayText || conv.display || '');
                    const normalizedDisplay = this.normalizeString(display.toLowerCase());
                    return normalizedDisplay.includes(normalizedQuery);
                })
                .slice(0, limit);

            // Return results (chain info already included from getRecentConversations)
            return results;
        } catch (error) {
            console.error('Error searching by title:', error);
            return [];
        }
    }

    /**
     * Search in conversation content (deep search)
     * Only searches in visible conversations (after resume chain filtering)
     * @param {string} query - Search query
     * @param {Object} options - Search options
     * @returns {Promise<Array>} Conversations with matches
     */
    async searchInContent(query, options = {}) {
        const { limit = 50, recentProjectPaths = null } = options;
        const normalizedQuery = this.normalizeString(query.toLowerCase());

        try {
            // FIRST: Get all visible conversations (with resume chain filtering already applied)
            // This ensures we only search in conversations that would actually be shown
            const visibleConversations = await this.getRecentConversations(2000, recentProjectPaths);

            console.log(`[Search] Searching in ${visibleConversations.length} visible conversations`);

            // SECOND: Search only in the visible conversations
            const results = [];
            for (const conv of visibleConversations) {
                const filePath = path.join(this.projectsDir, conv.projectDir, `${conv.sessionId}.jsonl`);

                // Search for query in this file
                const matches = await this.searchInFile(filePath, normalizedQuery, query);

                if (matches.length > 0) {
                    results.push({
                        ...conv, // Keep all existing conversation data (already filtered)
                        matches,
                        relevanceScore: matches.length,
                        hasContentMatch: true
                    });

                    // Stop if we have enough results
                    if (results.length >= limit) {
                        break;
                    }
                }
            }

            // Sort by relevance and timestamp
            const sorted = results.sort((a, b) => {
                if (b.relevanceScore !== a.relevanceScore) {
                    return b.relevanceScore - a.relevanceScore;
                }
                return b.timestamp - a.timestamp;
            });

            console.log(`[Search] Found ${sorted.length} matches`);

            return sorted;

        } catch (error) {
            console.error('Error searching in content:', error);
            return [];
        }
    }

    /**
     * Search for query in a conversation file
     * @param {string} filePath - Path to .jsonl file
     * @param {string} normalizedQuery - Normalized (accent-free) lowercase search query
     * @param {string} originalQuery - Original query for snippet extraction
     * @param {Object} options - { wholeWord } to only match whole words
     * @returns {Promise<Array>} Array of matches with snippets
     */
    async searchInFile(filePath, normalizedQuery, originalQuery = null, options = {}) {
        const matches = [];
        const queryForSnippet = originalQuery || normalizedQuery;
        const wholeWord = options.wholeWord === true;

        try {
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            let lineNumber = 0;
            for await (const line of rl) {
                lineNumber++;
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);

                        // Search in user messages
                        if (entry.message && entry.message.role === 'user') {
                            const content = entry.message.content;
                            let textContent = '';

                            // Handle different content formats
                            if (typeof content === 'string') {
                                textContent = content;
                            } else if (Array.isArray(content)) {
                                // Extract text from array format
                                textContent = content
                                    .filter(c => c.type === 'text')
                                    .map(c => c.text)
                                    .join(' ');
                            } else if (content && typeof content === 'object' && content.text) {
                                textContent = content.text;
                            }

                            if (textContent) {
                                const normalizedContent = this.normalizeString(textContent.toLowerCase());
                                if (matchesNormalized(normalizedContent, normalizedQuery, wholeWord)) {
                                    matches.push({
                                        content: this.extractSnippet(textContent, queryForSnippet, wholeWord),
                                        lineNumber,
                                        messageType: 'user'
                                    });
                                }
                            }
                        }

                        // Search in assistant messages
                        if (entry.message && entry.message.role === 'assistant') {
                            const content = entry.message.content;
                            let textContent = '';

                            if (Array.isArray(content)) {
                                textContent = content
                                    .filter(c => c.type === 'text')
                                    .map(c => c.text)
                                    .join(' ');
                            } else if (typeof content === 'string') {
                                textContent = content;
                            }

                            if (textContent) {
                                const normalizedContent = this.normalizeString(textContent.toLowerCase());
                                if (matchesNormalized(normalizedContent, normalizedQuery, wholeWord)) {
                                    matches.push({
                                        content: this.extractSnippet(textContent, queryForSnippet, wholeWord),
                                        lineNumber,
                                        messageType: 'assistant'
                                    });
                                }
                            }
                        }

                        // Limit matches per file to avoid huge results. Keep in sync
                        // with the "20+" cap indicator in the history modal's pill.
                        if (matches.length >= 20) {
                            break;
                        }
                    } catch (e) {
                        // Skip invalid JSON lines
                    }
                }
            }
        } catch (error) {
            console.error('Error searching in file:', error);
        }

        return matches;
    }

    /**
     * Extract snippet around the match
     * @param {string} content - Full content
     * @param {string} query - Search query
     * @returns {string} Snippet with match highlighted
     */
    extractSnippet(content, query, wholeWord = false) {
        // findNormalizedMatch maps the normalized-space match back to
        // ORIGINAL indices — normalization deletes chars (e.g. backticks are
        // \p{Diacritic}), so a raw indexOf on the normalized string lands the
        // snippet far away from the real match in code-heavy messages.
        const match = findNormalizedMatch(content, query, { wholeWord });

        if (!match) return content.substring(0, 100);

        const start = Math.max(0, match.start - 50);
        const end = Math.min(content.length, match.end + 50);

        let snippet = content.substring(start, end);

        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';

        return snippet;
    }

    /**
     * Encode project path to directory name
     * Example macOS: "/Users/example/Development/..." -> "-Users-example-Development-..."
     * Example Windows: "C:\Users\Usuario\..." -> "C--Users-Usuario-..." (no leading dash)
     * @param {string} projectPath - Full project path
     * @returns {string} Encoded directory name
     */
    encodeProjectPath(projectPath) {
        if (!projectPath) return '';

        const isWindows = process.platform === 'win32';

        if (isWindows) {
            // Windows: Just replace all special characters with dashes
            // C:\Users\name\... → C--Users-name-...
            return projectPath
                .normalize('NFD')
                .replace(/[^a-zA-Z0-9]/g, '-');
        } else {
            // macOS/Linux: Original encoding with leading dash
            const normalizedPath = projectPath
                .replace(/\\/g, '/')  // Normalize backslashes to forward slashes
                .replace(/^([A-Za-z]):/, '$1');  // Remove colon from drive letter if present

            return '-' + normalizedPath
                .normalize('NFD')
                .replace(/^\//, '')
                .replace(/[^a-zA-Z0-9]/g, '-');
        }
    }

    /**
     * Decode project directory name to path
     * Example macOS: "-Users-example-Development-..." -> "/Users/example/Development/..."
     * Example Windows: "C--Users-Usuario-..." -> "C:\Users\Usuario\..."
     * @param {string} dirName - Directory name
     * @returns {string} Decoded path
     */
    decodeProjectPath(dirName) {
        const isWindows = process.platform === 'win32';

        if (isWindows) {
            // Windows paths start with drive letter like "C--Users-..."
            // Match pattern: letter followed by double dash
            const windowsMatch = dirName.match(/^([A-Za-z])--(.*)$/);
            if (windowsMatch) {
                const driveLetter = windowsMatch[1];
                const pathPart = windowsMatch[2].replace(/-/g, '\\');
                return `${driveLetter}:\\${pathPart}`;
            }
            // Fallback: just replace dashes with backslashes
            return dirName.replace(/-/g, '\\');
        }

        // macOS/Linux: Original decoding
        if (!dirName.startsWith('-')) {
            return dirName;
        }

        // Remove leading dash and replace remaining dashes with slashes
        return '/' + dirName.substring(1).replace(/-/g, '/');
    }

    /**
     * Extract project name from path
     * @param {string} projectPath - Full project path
     * @returns {string} Project name
     */
    extractProjectName(projectPath) {
        if (!projectPath) return 'Unknown';

        // Handle both Unix (/) and Windows (\) path separators
        const normalizedPath = projectPath.replace(/\\/g, '/');
        const parts = normalizedPath.split('/').filter(p => p);
        return parts[parts.length - 1] || 'Unknown';
    }

    /**
     * Get relative time string
     * @param {number} timestamp - Timestamp in milliseconds
     * @returns {string} Relative time string
     */
    getRelativeTime(timestamp) {
        if (!timestamp) return 'Unknown';

        const now = Date.now();
        const diff = now - timestamp;

        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 60) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;

        const date = new Date(timestamp);
        return date.toLocaleDateString();
    }

    /**
     * Get full conversation content
     * @param {string} sessionId - Session ID
     * @param {string} projectDir - Project directory name
     * @returns {Promise<Array>} Array of messages
     */
    async getConversationContent(sessionId, projectDir) {
        const messages = [];

        try {
            const filePath = path.join(this.projectsDir, projectDir, `${sessionId}.jsonl`);

            if (!fs.existsSync(filePath)) {
                console.warn('Conversation file not found:', filePath);
                return [];
            }

            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);

                        // Skip sidechain messages (warmup and other internal conversations)
                        if (entry.isSidechain === true) {
                            continue;
                        }

                        // Extract user messages
                        if (entry.message && entry.message.role === 'user') {
                            let textContent = '';

                            // Handle different content formats
                            if (typeof entry.message.content === 'string') {
                                textContent = entry.message.content;
                            } else if (Array.isArray(entry.message.content)) {
                                // Extract text from array format: [{"type":"text","text":"..."}]
                                textContent = entry.message.content
                                    .filter(c => c.type === 'text')
                                    .map(c => c.text)
                                    .join('\n\n');
                            } else if (entry.message.content && typeof entry.message.content === 'object' && entry.message.content.text) {
                                // Handle object format: {"type":"text","text":"..."}
                                textContent = entry.message.content.text;
                            }

                            if (textContent) {
                                messages.push({
                                    role: 'user',
                                    content: textContent,
                                    timestamp: entry.timestamp
                                });
                            }
                        }

                        // Extract assistant messages
                        if (entry.message && entry.message.role === 'assistant') {
                            let textContent = '';

                            if (Array.isArray(entry.message.content)) {
                                textContent = entry.message.content
                                    .filter(c => c.type === 'text')
                                    .map(c => c.text)
                                    .join('\n\n');
                            } else if (typeof entry.message.content === 'string') {
                                textContent = entry.message.content;
                            }

                            if (textContent) {
                                messages.push({
                                    role: 'assistant',
                                    content: textContent,
                                    timestamp: entry.timestamp
                                });
                            }
                        }
                    } catch (e) {
                        // Skip invalid JSON lines
                    }
                }
            }

            return messages;
        } catch (error) {
            console.error('Error reading conversation content:', error);
            return [];
        }
    }

    /**
     * Extract parent sessionIds from a conversation file
     * When a conversation is resumed (claude -r), Claude Code copies some messages
     * from the original conversation, and those messages keep their original sessionId.
     * @param {string} filePath - Path to conversation file
     * @param {string} currentSessionId - The sessionId of the current file
     * @returns {Promise<Array<string>>} Array of parent sessionIds
     */
    async extractParentSessionIds(filePath, currentSessionId) {
        const parentSessionIds = new Set();

        try {
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);

                        // Check if this message has a sessionId
                        if (entry.sessionId) {
                            // If the sessionId is different from the current file's sessionId,
                            // it's a parent session
                            if (entry.sessionId !== currentSessionId) {
                                parentSessionIds.add(entry.sessionId);
                            }
                        }
                    } catch (e) {
                        // Skip invalid lines
                    }
                }
            }

            return Array.from(parentSessionIds);
        } catch (error) {
            console.error('Error extracting parent sessionIds:', error);
            return [];
        }
    }

    /**
     * Check if a conversation is a continuation (compact)
     * @param {string} filePath - Path to conversation file
     * @returns {Promise<boolean>} True if it's a continuation
     */
    async isContinuation(filePath) {
        try {
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const entry = JSON.parse(line);

                        // Skip sidechain messages (warmup and other internal conversations)
                        if (entry.isSidechain === true) {
                            continue;
                        }

                        if (entry.message && entry.message.role === 'user') {
                            const content = entry.message.content;
                            let textContent = '';

                            if (typeof content === 'string') {
                                textContent = content;
                            } else if (Array.isArray(content)) {
                                const textBlock = content.find(block => block.type === 'text');
                                if (textBlock && textBlock.text) {
                                    textContent = textBlock.text;
                                }
                            }

                            // Check if first user message contains continuation text
                            if (textContent.includes('This session is being continued from a previous conversation')) {
                                return true;
                            }
                            return false; // First user message doesn't have continuation text
                        }
                    } catch (e) {
                        // Skip invalid lines
                    }
                }
            }

            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * ✅ OPTIMIZED: Group conversations without reading files
     * Uses parentSessionIds already extracted during initial scan
     * @param {Array} conversations - Conversations with parentSessionIds already populated
     * @returns {Array} Filtered conversations with only latest resumes
     */
    groupConversationChainsOptimized(conversations) {
        // Sort by timestamp descending (newest first)
        const sorted = [...conversations].sort((a, b) => b.timestamp - a.timestamp);

        // Build map of sessionId -> conversation for quick lookup
        const convMap = new Map(sorted.map(c => [c.sessionId, c]));

        // Build map of parent -> children relationships
        const parentToChildren = new Map();

        // Build relationships using already-extracted parent IDs
        for (const conv of sorted) {
            const parentIds = conv.parentSessionIds || [];

            if (parentIds.length > 0) {
                // Map each parent to this child
                for (const parentId of parentIds) {
                    if (!parentToChildren.has(parentId)) {
                        parentToChildren.set(parentId, []);
                    }
                    parentToChildren.get(parentId).push(conv);
                }
            }
        }

        // Filter out conversations that are parents (have been resumed)
        const filtered = sorted.filter(conv => {
            return !parentToChildren.has(conv.sessionId);
        });

        // Calculate actual createdAt and add chain metadata
        const result = filtered.map(conv => {
            const parentIds = conv.parentSessionIds || [];
            let actualCreatedAt = conv.createdAt;

            // If this is a resume, find the oldest parent's creation date
            if (parentIds.length > 0) {
                for (const parentId of parentIds) {
                    const parent = convMap.get(parentId);
                    if (parent && parent.createdAt < actualCreatedAt) {
                        actualCreatedAt = parent.createdAt;
                    }
                }

                console.log(`[Resume Chain] Using parent createdAt for ${conv.sessionId.substring(0, 8)}: ${new Date(actualCreatedAt).toISOString()}`);
            }

            return {
                ...conv,
                createdAt: actualCreatedAt,
                isChain: parentIds.length > 0,
                chainCount: parentIds.length + 1,
                relatedSessions: parentIds
            };
        });

        return result.sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Parse the sessionIds of running BACKGROUND agents from the output of
     * `claude agents --json`. Only `kind === 'background'` sessions are returned:
     * those can't be resumed with `claude -r` (Claude rejects the double-resume
     * and exits 1). Interactive sessions resume fine and must stay visible.
     * Returns an empty Set on malformed/unexpected output so the caller safely
     * falls back to showing all conversations.
     * @param {string} jsonString - stdout of `claude agents --json`
     * @returns {Set<string>} sessionIds of running background agents
     */
    parseBackgroundAgentSessionIds(jsonString) {
        return claudeBgAgents.parseBackgroundAgentSessionIds(jsonString);
    }

    /**
     * Remove conversations that are currently running (their sessionId is in
     * `activeSessionIds`). A running session cannot be resumed with
     * `claude -r <id>` — Claude rejects the double-resume and exits 1 — so it
     * must not appear in the resume list. When the set is empty (e.g. the agents
     * query failed or is unsupported) every conversation is kept.
     * @param {Array} conversations
     * @param {Set<string>} activeSessionIds
     * @returns {Array} conversations that are safe to resume
     */
    excludeActiveSessions(conversations, activeSessionIds) {
        if (!activeSessionIds || activeSessionIds.size === 0) {
            return conversations;
        }
        return conversations.filter(conv => !activeSessionIds.has(conv.sessionId));
    }

    /**
     * Query Claude Code for the sessions that are currently running as
     * BACKGROUND agents via `claude agents --json`, so they can be hidden from
     * the resume list (they can't be resumed with `claude -r`). Interactive
     * sessions are intentionally kept visible. Best-effort: any failure (older
     * CLI without the `agents` subcommand, timeout, non-JSON output) resolves to
     * an empty Set, which makes the caller fall back to showing every conversation.
     * @returns {Promise<Set<string>>} sessionIds of running background agents
     */
    async getBackgroundAgentSessionIds() {
        return claudeBgAgents.getBackgroundAgentSessionIds();
    }

    /**
     * Group conversations into chains (resume relationships)
     * Filters out parent conversations that have been resumed,
     * showing only the most recent resume of each chain.
     * @param {Array} conversations - Array of conversation objects
     * @returns {Array} Filtered conversations with only latest resumes
     * @deprecated Use groupConversationChainsOptimized() instead
     */
    async groupConversationChains(conversations) {
        // Sort by timestamp descending (newest first)
        const sorted = [...conversations].sort((a, b) => b.timestamp - a.timestamp);

        // Build map of sessionId -> conversation for quick lookup
        const convMap = new Map();
        for (const conv of sorted) {
            convMap.set(conv.sessionId, conv);
        }

        // Build map of parent -> children relationships
        const parentToChildren = new Map(); // parentSessionId -> [child conversations]
        const conversationParents = new Map(); // sessionId -> [parent sessionIds]

        // Extract parent sessionIds for each conversation
        for (const conv of sorted) {
            const filePath = path.join(this.projectsDir, conv.projectDir, `${conv.sessionId}.jsonl`);
            const parentIds = await this.extractParentSessionIds(filePath, conv.sessionId);

            if (parentIds.length > 0) {
                conversationParents.set(conv.sessionId, parentIds);

                // Map each parent to this child
                for (const parentId of parentIds) {
                    if (!parentToChildren.has(parentId)) {
                        parentToChildren.set(parentId, []);
                    }
                    parentToChildren.get(parentId).push(conv);
                }
            }
        }

        // Filter out conversations that are parents (have been resumed)
        const filtered = [];
        for (const conv of sorted) {
            const hasChildren = parentToChildren.has(conv.sessionId);

            if (hasChildren) {
                // This conversation has been resumed, skip it
                const children = parentToChildren.get(conv.sessionId);
                console.log(`[Resume Chain] Hiding parent ${conv.sessionId.substring(0, 8)} (has ${children.length} resume(s))`);
                continue;
            }

            // This conversation is either:
            // 1. A standalone conversation (never resumed)
            // 2. The latest resume in a chain
            const parentIds = conversationParents.get(conv.sessionId) || [];
            const isResume = parentIds.length > 0;

            // If this is a resume, get the createdAt from the oldest parent
            let actualCreatedAt = conv.createdAt;
            if (isResume && parentIds.length > 0) {
                // Find the oldest parent in the chain
                let oldestCreatedAt = conv.createdAt;

                for (const parentId of parentIds) {
                    const parentConv = convMap.get(parentId);
                    if (parentConv && parentConv.createdAt < oldestCreatedAt) {
                        oldestCreatedAt = parentConv.createdAt;
                    }
                }

                actualCreatedAt = oldestCreatedAt;
                console.log(`[Resume Chain] Using parent createdAt for ${conv.sessionId.substring(0, 8)}: ${new Date(oldestCreatedAt).toISOString()}`);
            }

            filtered.push({
                ...conv,
                createdAt: actualCreatedAt, // Use parent's creation date
                isChain: isResume,
                chainCount: isResume ? parentIds.length + 1 : 1, // Count parents + self
                relatedSessions: parentIds
            });
        }

        return filtered.sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Build command to open conversation in terminal
     * @param {string} sessionId - Session ID
     * @param {string} projectPath - Project path
     * @returns {Object} Command info
     */
    buildOpenCommand(sessionId, projectPath) {
        return {
            command: 'claude -r',
            cwd: projectPath,
            sessionId
        };
    }
}

module.exports = ClaudeConversationSearchService;
