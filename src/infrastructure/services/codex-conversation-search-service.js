/**
 * Codex Conversation Search Service
 * Searches and retrieves conversation history from Codex CLI
 *
 * Codex stores sessions in ~/.codex/sessions/YEAR/MONTH/DAY/ as JSONL files.
 * Directory structure: ~/.codex/sessions/2026/01/18/rollout-*.jsonl
 *
 * Each JSONL file contains:
 * - First line: session_meta with payload containing session info
 *   Format: {"type":"session_meta","payload":{"id":"uuid","cwd":"/path","timestamp":"..."}}
 * - Subsequent lines: session events (user input, assistant messages, tool calls)
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { readFirstLine } = require('./codex-conversation-reader');
const { safePreviewString } = require('../../shared/utils/preview-string');
const { findNormalizedMatch, matchesNormalized } = require('../../shared/utils/normalized-text-search');
const { normalizeWorktreePath, buildRecentProjectMatcher } = require('./claude-project-path-resolver');
const { contentImageAttachments, MAX_CHAT_IMAGE_BYTES } = require('../agent-drivers/chat-attachments');

const STREAM_HIGH_WATER_MARK = 64 * 1024;
const HISTORY_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_PAGE_MAX_SCAN_BYTES = 256 * 1024 * 1024;
const HISTORY_PAGE_MAX_EVENT_BYTES = Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + (64 * 1024);
const CODEX_INPUT_IMAGE_MARKER = Buffer.from('"input_image"');
const CODEX_IMAGE_URL_MARKER = Buffer.from('"image_url"');
const MAX_LINES_FOR_FIRST_USER_MESSAGE = 100;
const MAX_MESSAGES_PER_SESSION = 5000;
// Keep in sync with the "20+" cap indicator in the history modal's pill.
const MAX_SEARCH_MATCHES_PER_FILE = 20;

/**
 * Stream a JSONL file line-by-line without loading it into memory.
 * Replaces `fs.readFileSync(path, 'utf8').split('\n')` which was OOM-crashing
 * V8 on multi-hundred-MB Codex sessions (see commit 9399e4f for the sibling fix
 * in codex-conversation-reader.js).
 *
 * @param {string} filePath
 * @param {(line: string, lineNumber: number) => boolean|void} onLine
 *        Returning `false` stops the stream early.
 * @param {{ skipFirstLine?: boolean, maxLines?: number }} [options]
 * @returns {Promise<void>}
 */
function streamJsonlLines(filePath, onLine, options = {}) {
    const { skipFirstLine = false, maxLines = Infinity } = options;

    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, {
            encoding: 'utf8',
            highWaterMark: STREAM_HIGH_WATER_MARK
        });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        let lineNumber = 0;
        let processed = 0;
        let stopped = false;

        const stop = () => {
            if (stopped) return;
            stopped = true;
            rl.close();
            stream.destroy();
        };

        rl.on('line', (line) => {
            if (stopped) return;
            lineNumber++;
            if (skipFirstLine && lineNumber === 1) return;
            if (processed >= maxLines) {
                stop();
                return;
            }
            processed++;
            try {
                if (onLine(line, lineNumber) === false) stop();
            } catch {
                // Per-line parse errors are non-fatal for streaming.
            }
        });

        rl.on('close', () => resolve());
        rl.on('error', reject);
        stream.on('error', reject);
    });
}

class CodexConversationSearchService {
    constructor() {
        this.codexDir = path.join(os.homedir(), '.codex');
        this.sessionsDir = path.join(this.codexDir, 'sessions');
    }

    normalizeString(str) {
        return str ? str.normalize('NFD').replace(/\p{Diacritic}/gu, '') : '';
    }

    isSystemOrInstructionMessage(text) {
        if (!text || typeof text !== 'string') return true;

        const trimmed = text.trim();
        if (!trimmed) return true;

        return trimmed.startsWith('<environment_context>') ||
            trimmed.startsWith('<environment>') ||
            trimmed.startsWith('<image') ||
            trimmed.startsWith('<turn_aborted>') ||
            trimmed.startsWith('<permissions instructions>') ||
            trimmed.startsWith('<INSTRUCTIONS>') ||
            trimmed.startsWith('<collaboration_mode>') ||
            trimmed.startsWith('<apps_instructions>') ||
            trimmed.startsWith('<skills_instructions>') ||
            trimmed.startsWith('<plugins_instructions>') ||
            trimmed.startsWith('<recommended_plugins>') ||
            trimmed.startsWith('<?xml') ||
            trimmed.startsWith('# AGENTS.md') ||
            trimmed.startsWith('# CLAUDE.md') ||
            trimmed.startsWith('# Instructions') ||
            trimmed.includes('instructions for /Users/');
    }

    extractTextFromContentArray(contentArray) {
        if (!Array.isArray(contentArray) || contentArray.length === 0) {
            return null;
        }

        const textParts = contentArray
            .filter(item =>
                item &&
                typeof item.text === 'string' &&
                ['input_text', 'output_text', 'text'].includes(item.type)
            )
            .map(item => item.text.trim())
            .filter(Boolean);

        if (textParts.length === 0) {
            return null;
        }

        return textParts.join('\n\n');
    }

    extractMessageFromEvent(event) {
        if (!event || typeof event !== 'object') {
            return null;
        }

        let role = null;
        let text = null;
        let attachments = [];

        if (event.type === 'response_item' && event.payload?.type === 'message') {
            const payloadRole = event.payload.role;
            if (payloadRole === 'user' || payloadRole === 'assistant') {
                role = payloadRole;
                text = this.extractTextFromContentArray(event.payload.content);
                attachments = contentImageAttachments(event.payload.content);
            }
        } else if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
            role = 'user';
            text = typeof event.payload.message === 'string' ? event.payload.message : null;
        } else if (event.type === 'user_input' ||
            event.type === 'user_turn' ||
            event.type === 'user_message') {
            role = 'user';
            text = event.payload?.content || event.content || event.message || event.text;
        } else if (event.type === 'assistant_message' ||
            event.type === 'agent_response' ||
            event.type === 'model_response') {
            role = 'assistant';
            text = event.payload?.content || event.content || event.message || event.text;
        }

        if (typeof text !== 'string' && attachments.length === 0) {
            return null;
        }

        const trimmed = typeof text === 'string' ? text.trim() : '';
        if ((!trimmed && attachments.length === 0) || (trimmed && this.isSystemOrInstructionMessage(trimmed))) {
            return null;
        }

        return {
            role,
            content: trimmed,
            timestamp: event.timestamp,
            ...(attachments.length ? { attachments } : {})
        };
    }

    cleanDisplayText(text) {
        if (!text || typeof text !== 'string') {
            return 'Codex Session';
        }

        const withoutRules = text
            .replace(/\r\n/g, '\n')
            .split(/\n[─━]{10,}\n?/)[0]
            .trim();

        const candidateLines = withoutRules
            .split('\n')
            .map(line => line.replace(/^[\s│┃┆┊└├┌┐┘┤┬┴┼>•*`\-]+/, '').trim())
            .filter(Boolean)
            .filter(line => !/^(Called|Ran|Explored|Updated|Created|Modified|Command:|Output:|Chunk ID:|Wall time:|Process exited)/i.test(line));

        let candidate = candidateLines[0] || withoutRules.split('\n').map(line => line.trim()).find(Boolean) || '';
        candidate = candidate.replace(/\s+Called\b.*$/i, '').trim();
        candidate = candidate.replace(/\s+/g, ' ').trim();

        return candidate || 'Codex Session';
    }

    buildDisplayText(text, maxLength = 100) {
        const cleaned = this.cleanDisplayText(text);
        if (cleaned.length <= maxLength) {
            return cleaned;
        }

        return `${cleaned.substring(0, maxLength).trim()}...`;
    }

    appendUniqueMessage(messages, message) {
        if (!message) return;

        const lastMessage = messages[messages.length - 1];
        if (lastMessage &&
            lastMessage.role === message.role &&
            lastMessage.content === message.content) {
            return;
        }

        messages.push(message);
    }

    extractSnippet(content, query, wholeWord = false) {
        // findNormalizedMatch maps the normalized-space match back to
        // ORIGINAL indices — normalization deletes chars (e.g. backticks are
        // \p{Diacritic}), so a raw indexOf on the normalized string lands the
        // snippet far away from the real match in code-heavy messages.
        const match = findNormalizedMatch(content, query, { wholeWord });

        if (!match) {
            return content.substring(0, 100);
        }

        const start = Math.max(0, match.start - 50);
        const end = Math.min(content.length, match.end + 50);

        let snippet = content.substring(start, end);

        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';

        return snippet;
    }

    /**
     * Recursively find all JSONL files in the sessions directory (async)
     * Codex uses nested date structure: sessions/YEAR/MONTH/DAY/rollout-*.jsonl
     * @param {string} dir - Directory to search
     * @returns {Promise<Array<string>>} Array of file paths
     */
    async findAllJsonlFiles(dir) {
        const files = [];

        try {
            await fsPromises.access(dir);
        } catch {
            return files;
        }

        const entries = await fsPromises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // Recurse into subdirectories (YEAR/MONTH/DAY structure)
                const subFiles = await this.findAllJsonlFiles(fullPath);
                files.push(...subFiles);
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(fullPath);
            }
        }

        return files;
    }

    /**
     * Parse Codex session metadata from first line
     * Format: {"type":"session_meta","payload":{"id":"...","cwd":"...","timestamp":"..."}}
     * @param {string} firstLine - First line of JSONL file
     * @returns {object|null} Parsed metadata or null if invalid
     */
    parseSessionMetadata(firstLine) {
        try {
            const parsed = JSON.parse(firstLine);

            // Codex uses type: "session_meta" with nested payload
            if (parsed.type === 'session_meta' && parsed.payload) {
                return {
                    sessionId: parsed.payload.id || null,
                    cwd: parsed.payload.cwd || null,
                    timestamp: parsed.payload.timestamp || null,
                    model: parsed.payload.model || null,
                    parentThreadId: parsed.payload.source?.subagent?.thread_spawn?.parent_thread_id || null
                };
            }

            // Fallback for older/different formats
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
     * Get recent conversations by scanning session files
     * @param {number} limit - Number of conversations to retrieve
     * @param {Array<string>} recentProjectPaths - Optional array of recent project paths to filter by
     * @param {string|null} selectedProjectPath - Optional: return up to `limit` conversations of
     *   this project ONLY. Overrides recentProjectPaths and matches tolerantly
     *   (case/symlink/worktree), so the top-`limit` cut happens WITHIN the project.
     * @returns {Promise<Array>} Array of conversation objects
     */
    async getRecentConversations(limit = 20, recentProjectPaths = null, selectedProjectPath = null) {
        try {
            try {
                await fsPromises.access(this.sessionsDir);
            } catch {
                console.log('[Codex Conversation Search] Sessions directory not found');
                return [];
            }

            console.log('[Codex Conversation Search] Starting recursive session scan');

            // Recursively find all JSONL files in nested date structure (async)
            const jsonlFiles = await this.findAllJsonlFiles(this.sessionsDir);

            if (jsonlFiles.length === 0) {
                console.log('[Codex Conversation Search] No JSONL files found');
                return [];
            }

            console.log(`[Codex Conversation Search] Found ${jsonlFiles.length} JSONL files`);

            const recentPathSet = recentProjectPaths ? new Set(recentProjectPaths) : null;

            // Resume-panel scope: when a project is selected it OVERRIDES recentProjectPaths.
            // The matcher folds case/symlink/worktree once up front (no per-file realpath).
            const scopedMatcher = selectedProjectPath
                ? buildRecentProjectMatcher([normalizeWorktreePath(selectedProjectPath)])
                : null;

            // Process files in parallel batches to avoid fd exhaustion
            const FILE_BATCH_SIZE = 50;

            // PASS 1 (cheap): stat + read session_meta first line + filter by project.
            // We skip the expensive 100-line streamFirstUserMessage here so we don't
            // waste IO on sessions that won't make the top-`limit` cut. For heavy
            // users with thousands of rollouts this is ~5–10× faster than reading
            // every file's first user message just to throw most away after sorting.
            const candidates = [];
            for (let i = 0; i < jsonlFiles.length; i += FILE_BATCH_SIZE) {
                const batch = jsonlFiles.slice(i, i + FILE_BATCH_SIZE);
                const batchMeta = await Promise.all(
                    batch.map(async (filePath) => {
                        try {
                            const stat = await fsPromises.stat(filePath);
                            const firstLine = readFirstLine(filePath);
                            if (!firstLine) return null;

                            const metadata = this.parseSessionMetadata(firstLine);
                            if (!metadata) return null;
                            if (metadata.parentThreadId) return null;

                            // Attribute a worktree cwd to its parent repo so a Codex
                            // conversation run in a worktree matches the registered project
                            // instead of being filtered out. No-op for normal paths.
                            const sessionCwd = normalizeWorktreePath(metadata.cwd);
                            if (scopedMatcher) {
                                // Scoped: keep ONLY this project's sessions, so the
                                // top-`limit` cut below happens within the project.
                                if (!sessionCwd || !scopedMatcher.matchesProjectPath(sessionCwd)) {
                                    return null;
                                }
                            } else if (recentPathSet && sessionCwd && !recentPathSet.has(sessionCwd)) {
                                return null;
                            }

                            return { filePath, stat, metadata };
                        } catch (err) {
                            console.error(`Error reading Codex session metadata ${path.basename(filePath)}:`, err.message);
                            return null;
                        }
                    })
                );
                for (const c of batchMeta) {
                    if (c) candidates.push(c);
                }
            }

            // Sort + truncate BEFORE the expensive pass so we only stream user
            // messages for sessions we'll actually return.
            candidates.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
            const topCandidates = candidates.slice(0, limit);

            // PASS 2 (expensive): stream first user message + build full result
            // only for the top-`limit` sessions.
            const conversations = [];
            for (let i = 0; i < topCandidates.length; i += FILE_BATCH_SIZE) {
                const batch = topCandidates.slice(i, i + FILE_BATCH_SIZE);
                const batchResults = await Promise.all(
                    batch.map(async ({ filePath, stat, metadata }) => {
                        try {
                            const firstUserMessage = await this.streamFirstUserMessage(filePath);

                            let displayText = 'Codex Session';
                            if (firstUserMessage) {
                                displayText = this.buildDisplayText(firstUserMessage);
                            }

                            const sessionId = metadata.sessionId || path.basename(filePath, '.jsonl');
                            // Worktree cwd -> parent repo, so the conversation groups/displays
                            // under the real project, not under the worktree slug. No-op for
                            // normal paths.
                            const sessionCwd = normalizeWorktreePath(metadata.cwd);
                            const projectPath = sessionCwd || 'Other Project';
                            const projectName = sessionCwd ? path.basename(sessionCwd) : 'Codex Session';
                            // Mark conversations that ran inside a per-conversation worktree
                            // (raw cwd held ".codeagentswarm/worktrees/" so normalize changed it).
                            const isWorktree = !!(metadata.cwd && normalizeWorktreePath(metadata.cwd) !== metadata.cwd);

                            let createdAt = stat.birthtime.getTime();
                            if (metadata.timestamp) {
                                const parsed = new Date(metadata.timestamp).getTime();
                                if (!isNaN(parsed)) createdAt = parsed;
                            }

                            return {
                                sessionId,
                                // Filename-form id ("rollout-{uuid}") so the renderer's
                                // mergeConversationsStable can match this result to the
                                // skeleton entry built by `conversation-history:get-index`,
                                // which derives sessionId from the filename to stay fast.
                                // We keep sessionId = metadata.payload.id because the
                                // Resume command (codex resume <id>) requires the
                                // metadata form. See main.js:7045 for the index handler.
                                legacySessionId: path.basename(filePath, '.jsonl'),
                                projectPath,
                                projectName,
                                projectDir: sessionCwd,
                                isWorktree,
                                displayText,
                                display: displayText,
                                timestamp: stat.mtime.getTime(),
                                createdAt,
                                updatedAt: stat.mtime.getTime(),
                                relativeTime: this.getRelativeTime(stat.mtime.getTime()),
                                isCodex: true,
                                isGemini: false,
                                agent: 'codex',
                                filePath
                            };
                        } catch (err) {
                            console.error(`Error parsing Codex session file ${path.basename(filePath)}:`, err.message);
                            return null;
                        }
                    })
                );
                for (const r of batchResults) {
                    if (r) conversations.push(r);
                }
            }

            console.log(`[Codex Conversation Search] Found ${candidates.length} valid sessions, returning top ${conversations.length}`);
            return conversations;

        } catch (error) {
            console.error('Error reading Codex conversation history:', error);
            return [];
        }
    }

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
     * Search sessions by title/content
     * @param {string} query - Search query
     * @param {Array<string>} recentProjectPaths - Optional array of recent project paths
     * @param {number} limit - Maximum results
     * @returns {Promise<Array>}
     */
    async searchByTitle(query, recentProjectPaths = null, limit = 50) {
        const convs = await this.getRecentConversations(2000, recentProjectPaths);
        const normalizedQuery = this.normalizeString(query.toLowerCase());
        return convs
            .filter(c => this.normalizeString((c.displayText || '').toLowerCase()).includes(normalizedQuery))
            .slice(0, limit);
    }

    /**
     * Search within session content
     * @returns {Promise<Array>}
     */
    async searchInContent(query, options = {}) {
        const { limit = 50, recentProjectPaths = null, wholeWord = false } = options;
        const normalizedQuery = this.normalizeString(query.toLowerCase());

        try {
            const visibleConversations = await this.getRecentConversations(2000, recentProjectPaths);
            const results = [];

            for (const conv of visibleConversations) {
                const matches = await this.searchInFile(conv.filePath, normalizedQuery, query, { wholeWord });

                if (matches.length > 0) {
                    results.push({
                        ...conv,
                        matches,
                        relevanceScore: matches.length,
                        hasContentMatch: true
                    });
                }

                if (results.length >= limit) {
                    break;
                }
            }

            return results
                .sort((a, b) => {
                    if (b.relevanceScore !== a.relevanceScore) {
                        return b.relevanceScore - a.relevanceScore;
                    }
                    return b.timestamp - a.timestamp;
                })
                .slice(0, limit);
        } catch (error) {
            console.error('Error searching in Codex content:', error);
            return [];
        }
    }

    async searchInFile(filePath, normalizedQuery, originalQuery = null, options = {}) {
        const matches = [];
        const queryForSnippet = originalQuery || normalizedQuery;
        const wholeWord = options.wholeWord === true;
        let lastMessageKey = null;

        try {
            await streamJsonlLines(filePath, (line, lineNumber) => {
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }

                const message = this.extractMessageFromEvent(event);
                if (!message) return;

                const messageKey = `${message.role}\u0000${message.content}`;
                if (messageKey === lastMessageKey) return;
                lastMessageKey = messageKey;

                const normalizedContent = this.normalizeString(message.content.toLowerCase());
                if (matchesNormalized(normalizedContent, normalizedQuery, wholeWord)) {
                    matches.push({
                        content: this.extractSnippet(message.content, queryForSnippet, wholeWord),
                        lineNumber,
                        role: message.role
                    });
                }

                if (matches.length >= MAX_SEARCH_MATCHES_PER_FILE) return false;
            }, { skipFirstLine: true });
        } catch (error) {
            console.error(`[Codex searchInFile] Error reading ${path.basename(filePath)}:`, error.message);
        }

        return matches;
    }

    /**
     * Get conversation content (messages) for a specific session
     * Used by the Resume modal to show conversation preview
     * @param {string} sessionId - The session ID (UUID or filename)
     * @param {string} projectDir - The project directory (used to find matching session)
     * @returns {Promise<Array>} Array of message objects with role and content
     */
    async getConversationContent(sessionId, projectDir) {
        try {
            console.log('[Codex getConversationContent] Looking for sessionId:', sessionId);
            console.log('[Codex getConversationContent] ProjectDir:', projectDir);

            const jsonlFiles = await this.findAllJsonlFiles(this.sessionsDir);

            if (jsonlFiles.length === 0) {
                console.log('[Codex getConversationContent] No JSONL files found');
                return [];
            }

            // Locate the session file using a chunked first-line read instead of
            // loading every JSONL into memory (was OOM-crashing on ~1 GB of history).
            const targetFilePath = this.findSessionFile(jsonlFiles, sessionId);

            if (!targetFilePath) {
                console.log('[Codex getConversationContent] Session file not found');
                return [];
            }

            console.log('[Codex getConversationContent] Found session file:', targetFilePath);

            const messages = [];
            let lastMessageKey = null;

            await streamJsonlLines(targetFilePath, (line) => {
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }

                const message = this.extractMessageFromEvent(event);
                if (!message) return;

                const messageKey = `${message.role}\u0000${message.content}`;
                if (messageKey === lastMessageKey) return;
                lastMessageKey = messageKey;

                this.appendUniqueMessage(messages, message);

                if (messages.length >= MAX_MESSAGES_PER_SESSION) return false;
            }, { skipFirstLine: true });

            console.log(`[Codex getConversationContent] Found ${messages.length} messages`);
            return messages;

        } catch (error) {
            console.error('[Codex getConversationContent] Error:', error);
            return [];
        }
    }

    /**
     * Read one bounded page from the end of a rollout for Chat restore.
     * The cursor is a byte offset, so even sparse multi-GB histories never
     * require parsing the complete file just to show the latest messages.
     */
    async getConversationContentPage(sessionId, projectDir, { before, limit = 120 } = {}) {
        const jsonlFiles = await this.findAllJsonlFiles(this.sessionsDir);
        const targetFilePath = this.findSessionFile(jsonlFiles, sessionId);
        if (!targetFilePath) {
            return { messages: [], nextCursor: null, hasMore: false };
        }

        const stat = await fsPromises.stat(targetFilePath);
        const end = Number.isSafeInteger(before)
            ? Math.max(0, Math.min(before, stat.size))
            : stat.size;
        let windowEnd = end;
        let scannedBytes = 0;
        let carry = Buffer.alloc(0);
        let skippingOversizedEvent = false;
        let earlierCursor = end > 0 ? end : null;
        const parsedMessages = [];
        const parseLine = (line, offset) => {
            if (line.length === 0 || line.length > HISTORY_PAGE_MAX_EVENT_BYTES) return;
            if (line.length > HISTORY_PAGE_MAX_BYTES &&
                (!line.includes(CODEX_INPUT_IMAGE_MARKER) || !line.includes(CODEX_IMAGE_URL_MARKER))) return;
            try {
                const message = this.extractMessageFromEvent(JSON.parse(line.toString('utf8')));
                if (message) parsedMessages.push({ message, offset });
            } catch {
                // A malformed event must not prevent older pages loading.
            }
        };

        // ponytail: memory stays at one 2 MiB window and one chat-sized base64 image event.
        // Add a rollout byte index if useful messages routinely sit behind 256 MiB.
        const handle = await fsPromises.open(targetFilePath, 'r');
        try {
            while (windowEnd > 0 &&
                scannedBytes < HISTORY_PAGE_MAX_SCAN_BYTES &&
                parsedMessages.length === 0) {
                const bytesToRead = Math.min(
                    HISTORY_PAGE_MAX_BYTES,
                    HISTORY_PAGE_MAX_SCAN_BYTES - scannedBytes,
                    windowEnd
                );
                const start = windowEnd - bytesToRead;
                const buffer = Buffer.allocUnsafe(bytesToRead);
                let bytesRead = 0;
                while (bytesRead < buffer.length) {
                    const result = await handle.read(
                        buffer,
                        bytesRead,
                        buffer.length - bytesRead,
                        start + bytesRead
                    );
                    if (result.bytesRead === 0) break;
                    bytesRead += result.bytesRead;
                }
                if (bytesRead === 0) break;

                scannedBytes += bytesRead;
                const chunk = buffer.subarray(0, bytesRead);
                const firstNewline = chunk.indexOf(10);

                if (firstNewline === -1) {
                    earlierCursor = start > 0 ? start : null;
                    if (!skippingOversizedEvent) {
                        if (chunk.length + carry.length > HISTORY_PAGE_MAX_EVENT_BYTES) {
                            carry = Buffer.alloc(0);
                            skippingOversizedEvent = true;
                        } else {
                            carry = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
                        }
                    }
                } else {
                    const lastNewline = chunk.lastIndexOf(10);
                    const rightPart = chunk.subarray(lastNewline + 1);
                    if (!skippingOversizedEvent &&
                        rightPart.length + carry.length <= HISTORY_PAGE_MAX_EVENT_BYTES) {
                        parseLine(
                            carry.length > 0 ? Buffer.concat([rightPart, carry]) : rightPart,
                            start + lastNewline + 1
                        );
                    }
                    carry = Buffer.alloc(0);
                    skippingOversizedEvent = false;

                    for (let lineEnd = firstNewline; lineEnd < lastNewline;) {
                        const lineStart = lineEnd + 1;
                        lineEnd = chunk.indexOf(10, lineStart);
                        parseLine(
                            chunk.subarray(lineStart, lineEnd),
                            start + lineStart
                        );
                    }

                    if (start === 0) {
                        parseLine(chunk.subarray(0, firstNewline), 0);
                        earlierCursor = null;
                    } else {
                        carry = chunk.subarray(0, firstNewline);
                        earlierCursor = start + firstNewline + 1;
                    }
                }
                windowEnd = start;
            }

            if (windowEnd === 0 && carry.length > 0 && !skippingOversizedEvent) {
                parseLine(carry, 0);
                earlierCursor = null;
            }
        } finally {
            await handle.close();
        }

        parsedMessages.sort((left, right) => left.offset - right.offset);
        const messages = [];
        const messageOffsets = [];
        for (const { message, offset } of parsedMessages) {
            const messageCount = messages.length;
            this.appendUniqueMessage(messages, message);
            if (messages.length > messageCount) messageOffsets.push(offset);
        }

        const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 120;
        const selectedStart = Math.max(0, messages.length - safeLimit);
        const selected = messages.slice(selectedStart);
        const nextCursor = selectedStart > 0
            ? messageOffsets[selectedStart]
            : earlierCursor;
        return {
            messages: selected.map((message, index) => ({
                role: `${message.role}_message`,
                text: message.content,
                timestamp: message.timestamp,
                index: messageOffsets[selectedStart + index],
                ...(message.attachments?.length ? { attachments: message.attachments } : {})
            })),
            nextCursor,
            hasMore: nextCursor !== null
        };
    }

    /**
     * Walks the file list and returns the first path whose session_meta line
     * matches `sessionId`. Uses chunked first-line reads so a giant rollout file
     * costs ~1 KB instead of its full size on disk.
     * @param {Array<string>} jsonlFiles
     * @param {string} sessionId
     * @returns {string|null}
     */
    findSessionFile(jsonlFiles, sessionId) {
        for (const filePath of jsonlFiles) {
            try {
                const baseName = path.basename(filePath, '.jsonl');
                // Cheap match by filename first — avoids any disk read.
                if (baseName === sessionId || baseName.includes(sessionId)) {
                    return filePath;
                }

                const firstLine = readFirstLine(filePath);
                if (!firstLine) continue;

                const metadata = this.parseSessionMetadata(firstLine);
                if (metadata && metadata.sessionId === sessionId) {
                    return filePath;
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    /**
     * Streams the first MAX_LINES_FOR_FIRST_USER_MESSAGE lines after the
     * session_meta line and returns the text of the first user message found,
     * or null if none. Bounded memory regardless of file size.
     * @param {string} filePath
     * @returns {Promise<string|null>}
     */
    async streamFirstUserMessage(filePath) {
        let result = null;
        try {
            await streamJsonlLines(filePath, (line) => {
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }
                const message = this.extractMessageFromEvent(event);
                if (message?.role === 'user') {
                    // Cap + flatten: stops V8 SlicedString from pinning multi-MB
                    // parent strings alive once downstream does substring(0, 100).
                    result = safePreviewString(message.content);
                    return false;
                }
            }, { skipFirstLine: true, maxLines: MAX_LINES_FOR_FIRST_USER_MESSAGE });
        } catch {
            // ignored — caller treats null as "no user message"
        }
        return result;
    }
}

module.exports = CodexConversationSearchService;
