/**
 * Antigravity Conversation Search Service
 *
 * Searches and retrieves conversation history from the Antigravity CLI (`agy`).
 * Drop-in sibling of gemini-conversation-search-service.js and
 * codex-conversation-search-service.js: a default-exported class exposing
 *   - getRecentConversations(limit, recentProjectPaths, selectedProjectPath)
 *   - getConversationContent(conversationId, projectDir)
 * with the SAME result shapes those services return so main.js consumes them
 * interchangeably.
 *
 * Storage (verified on agy v1.0.13):
 *   - Conversation ids come from ~/.gemini/antigravity-cli/conversations/<id>.db
 *     (filename stem = id) and ~/.gemini/antigravity-cli/brain/<id>/ folders.
 *   - The rendered content is the clean JSONL transcript at
 *     ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl
 *     (transcript_full.jsonl = untruncated). Each line is a JSON step object:
 *       { step_index, source, type, status, created_at, content?, thinking? }
 *     type ∈ { USER_INPUT, PLANNER_RESPONSE, RUN_COMMAND,
 *              CONVERSATION_HISTORY, CHECKPOINT }.
 *
 * We never decode the protobuf blobs inside the .db files — ids + mtime only.
 * All JSONL parsing skips malformed lines and fails safe (returns []/null).
 */

const fs = require('fs');
const path = require('path');
const reader = require('./antigravity-conversation-reader');
const { safePreviewString } = require('../../shared/utils/preview-string');
const { buildRecentProjectMatcher, normalizeWorktreePath } = require('./claude-project-path-resolver');

// Antigravity truncates transcript.jsonl deliberately, so it stays small.
// transcript_full.jsonl can grow; cap how large a transcript we will slurp into
// memory at once (mirrors the spirit of the Codex OOM guard) and how many
// messages we materialise per conversation.
const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_MESSAGES_PER_CONVERSATION = 5000;

/**
 * Strips the Antigravity USER_INPUT wrapper to the clean user text.
 *
 * USER_INPUT content looks like:
 *   "<USER_REQUEST>\n...actual text...\n</USER_REQUEST>\n
 *    <ADDITIONAL_METADATA>\n...\n</ADDITIONAL_METADATA>\n
 *    <USER_SETTINGS_CHANGE>\n...\n</USER_SETTINGS_CHANGE>"
 *
 * @param {*} content
 * @returns {string} clean user text ('' when none / not a string)
 */
function stripUserRequest(content) {
    if (typeof content !== 'string') return '';

    // Preferred: the explicit <USER_REQUEST>...</USER_REQUEST> wrapper.
    const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
    let text = match ? match[1] : content;

    // Remove the metadata / system blocks Antigravity appends to user turns,
    // plus any stray wrapper tags left when the wrapper was malformed.
    text = text
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .replace(/<\/?USER_REQUEST>/gi, '')
        .replace(/<\/?ADDITIONAL_METADATA>/gi, '')
        .replace(/<\/?USER_SETTINGS_CHANGE>/gi, '');

    return text.trim();
}

class AntigravityConversationSearchService {
    /**
     * Picks the transcript file to read for a conversation. Prefers the
     * untruncated full transcript for content, the small truncated one for
     * previews. Skips files larger than MAX_TRANSCRIPT_BYTES unless it is the
     * only option.
     * @param {string} conversationId
     * @param {boolean} preferFull
     * @returns {string|null}
     */
    pickTranscript(conversationId, preferFull) {
        const full = reader.getFullTranscriptPath(conversationId);
        const truncated = reader.getTranscriptPath(conversationId);
        const order = preferFull ? [full, truncated] : [truncated, full];

        for (const file of order) {
            try {
                const stat = fs.statSync(file);
                if (stat.isFile() && stat.size <= MAX_TRANSCRIPT_BYTES) return file;
            } catch {
                // missing — try next
            }
        }
        // Last resort: return whichever exists even if oversized (we line-cap anyway).
        for (const file of order) {
            try {
                if (fs.statSync(file).isFile()) return file;
            } catch {
                // missing — try next
            }
        }
        return null;
    }

    /**
     * Maps a single transcript step object to a chat message, or null to skip.
     *   USER_INPUT        -> { role:'user',      content: <stripped> }
     *   PLANNER_RESPONSE  -> { role:'assistant', content, thinking? }
     *   RUN_COMMAND       -> { role:'tool',      content }
     *   CONVERSATION_HISTORY / CHECKPOINT / unknown -> skipped (context markers)
     * @param {object} step
     * @returns {{role:string, content:string, timestamp:*, thinking?:string}|null}
     */
    mapStepToMessage(step) {
        if (!step || typeof step !== 'object') return null;

        const timestamp = step.created_at || null;

        switch (step.type) {
            case 'USER_INPUT': {
                const content = stripUserRequest(step.content);
                if (!content) return null;
                return { role: 'user', content, timestamp };
            }
            case 'PLANNER_RESPONSE': {
                const content = typeof step.content === 'string' ? step.content : '';
                const message = { role: 'assistant', content, timestamp };
                if (typeof step.thinking === 'string' && step.thinking.trim()) {
                    message.thinking = step.thinking;
                }
                // Skip genuinely empty assistant turns that carry no reasoning either.
                if (!content.trim() && !message.thinking) return null;
                return message;
            }
            case 'RUN_COMMAND': {
                const content = typeof step.content === 'string' ? step.content : '';
                return { role: 'tool', content, timestamp };
            }
            case 'CONVERSATION_HISTORY':
            case 'CHECKPOINT':
            default:
                // Context / truncation markers and unknown types are not rendered.
                return null;
        }
    }

    /**
     * Parses a transcript JSONL file into chat messages. Robust to malformed
     * lines (they are skipped). Bounded by `maxMessages`.
     * @param {string|null} file
     * @param {{ maxMessages?: number }} [options]
     * @returns {Array<object>}
     */
    parseTranscript(file, { maxMessages = Infinity } = {}) {
        const messages = [];
        if (!file) return messages;

        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch {
            return messages;
        }

        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let step;
            try {
                step = JSON.parse(trimmed);
            } catch {
                continue; // skip malformed line
            }

            const message = this.mapStepToMessage(step);
            if (message) {
                messages.push(message);
                if (messages.length >= maxMessages) break;
            }
        }
        return messages;
    }

    /**
     * Single-pass scan of the (small) truncated transcript to derive a title
     * and first/last activity timestamps for the conversation list.
     * @param {string} conversationId
     * @returns {{ title: string|null, createdAt: string|null, updatedAt: string|null }}
     */
    scanForSummary(conversationId) {
        const summary = { title: null, createdAt: null, updatedAt: null };
        const file = this.pickTranscript(conversationId, false);
        if (!file) return summary;

        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch {
            return summary;
        }

        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let step;
            try {
                step = JSON.parse(trimmed);
            } catch {
                continue;
            }
            if (!step || typeof step !== 'object') continue;

            if (step.created_at) {
                if (!summary.createdAt) summary.createdAt = step.created_at;
                summary.updatedAt = step.created_at;
            }
            if (!summary.title && step.type === 'USER_INPUT') {
                const text = stripUserRequest(step.content);
                // Cap + flatten before it lands in a result object (V8 SlicedString guard).
                if (text) summary.title = safePreviewString(text);
            }
        }
        return summary;
    }

    /**
     * Builds the short display/preview text from raw title text.
     * @param {string} text
     * @param {number} [maxLength]
     * @returns {string}
     */
    buildDisplayText(text, maxLength = 100) {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'Antigravity Session';
        return cleaned.length <= maxLength
            ? cleaned
            : `${cleaned.substring(0, maxLength).trim()}...`;
    }

    /**
     * Get recent Antigravity conversations.
     *
     * Antigravity history is global (flat): conversations are not grouped per
     * project on disk, but each one records the workspace it ran in, so a
     * SELECTED project can still narrow the result set. `recentProjectPaths`
     * remains accepted-but-unused (signature parity with the other services).
     *
     * @param {number} limit
     * @param {Array<string>|null} recentProjectPaths - accepted, unused (flat storage)
     * @param {string|null} selectedProjectPath - Optional: return ONLY conversations whose
     *   recorded workspace is this project. Matching is tolerant (case/symlink/worktree);
     *   conversations with no recorded workspace cannot be attributed and are skipped.
     * @returns {Promise<Array<object>>} conversation objects matching the
     *   Gemini/Codex search-service shape (+ isAntigravity / agent:'antigravity').
     */
    async getRecentConversations(limit = 20, recentProjectPaths = null, selectedProjectPath = null) {
        const startTime = Date.now();
        try {
            const ids = reader.listConversationIds();
            if (ids.length === 0) {
                return [];
            }

            // Cheap pass: order by most-recent artifact mtime, keep top `limit`,
            // then only read transcripts for the survivors.
            const scopedMatcher = selectedProjectPath
                ? buildRecentProjectMatcher([normalizeWorktreePath(selectedProjectPath)])
                : null;
            const ordered = ids
                .map(id => ({ id, mtime: reader.getConversationMtime(id) }))
                .sort((a, b) => b.mtime - a.mtime);
            let candidates;
            if (scopedMatcher) {
                // Scoped: walk newest-first and keep only conversations whose recorded
                // workspace matches the selected project. getConversationWorkspace is
                // mtime-cached in the reader, so the extra lookups are cheap on repeats;
                // sessions with no recorded workspace cannot be attributed and are skipped.
                candidates = [];
                for (const c of ordered) {
                    const workspace = reader.getConversationWorkspace(c.id);
                    if (!workspace || !scopedMatcher.matchesProjectPath(normalizeWorktreePath(workspace))) continue;
                    candidates.push(c);
                    if (candidates.length >= limit) break;
                }
            } else {
                candidates = ordered.slice(0, limit);
            }

            const conversations = [];
            for (const { id, mtime } of candidates) {
                try {
                    const summary = this.scanForSummary(id);

                    const createdMs = summary.createdAt ? new Date(summary.createdAt).getTime() : NaN;
                    const updatedMs = summary.updatedAt ? new Date(summary.updatedAt).getTime() : NaN;
                    const createdAt = !isNaN(createdMs) ? createdMs : (mtime || Date.now());
                    const timestamp = !isNaN(updatedMs) ? updatedMs : (mtime || Date.now());

                    const preview = this.buildDisplayText(summary.title || '');

                    // Recover the real workspace from the conversation db so the
                    // history list shows the project (not a generic label) and
                    // resume opens the terminal in that directory. When none was
                    // recorded (e.g. a chat-only default-cli-project session) we
                    // keep the generic label and an EMPTY projectPath: the open
                    // flow then asks the user for a folder. It must NEVER silently
                    // fall back to the home dir (Windows users ended up with their
                    // whole C:\Users\<name> as the "project").
                    const workspace = reader.getConversationWorkspace(id);
                    const projectName = workspace ? path.basename(workspace) : 'Antigravity Session';
                    const projectPath = workspace || '';

                    conversations.push({
                        sessionId: id,
                        conversationId: id,
                        projectPath,
                        projectName,
                        projectDir: workspace || id,
                        displayText: preview,
                        display: preview,
                        timestamp,
                        createdAt,
                        updatedAt: timestamp,
                        relativeTime: this.getRelativeTime(timestamp),
                        isAntigravity: true,
                        isGemini: false,
                        isCodex: false,
                        agent: 'antigravity',
                        filePath: this.pickTranscript(id, false) || reader.getTranscriptPath(id)
                    });
                } catch (err) {
                    console.error(`[Antigravity] Error building conversation ${id}:`, err.message);
                }
            }

            conversations.sort((a, b) => b.timestamp - a.timestamp);
            console.log(`[Antigravity Conversation Search] Found ${conversations.length} conversations in ${Date.now() - startTime}ms`);
            return conversations;
        } catch (error) {
            console.error('Error reading Antigravity conversation history:', error);
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
     * Search conversations by title/preview text.
     * @param {string} query
     * @param {Array<string>|null} recentProjectPaths
     * @param {number} limit
     * @returns {Promise<Array<object>>}
     */
    async searchByTitle(query, recentProjectPaths = null, limit = 50) {
        const convs = await this.getRecentConversations(2000, recentProjectPaths);
        const lowerQuery = (query || '').toLowerCase();
        return convs
            .filter(c => (c.displayText || '').toLowerCase().includes(lowerQuery))
            .slice(0, limit);
    }

    /**
     * Content search is not indexed for Antigravity yet (parity with Gemini).
     * @returns {Promise<Array>}
     */
    async searchInContent() {
        return [];
    }

    /**
     * Get the messages for a single conversation, for the chat-history UI.
     * Returns the same {role, content, timestamp, thinking?} shape the Gemini and
     * Codex services return.
     *
     * @param {string} conversationId - the Antigravity conversation id
     * @param {string|null} projectDir - accepted for signature parity, unused
     *   (the conversationId alone locates the transcript)
     * @returns {Promise<Array<object>>}
     */
    async getConversationContent(conversationId, projectDir = null) {
        try {
            if (!conversationId) return [];

            // Prefer the untruncated transcript so the chat view shows the whole
            // conversation; fall back to the truncated one.
            const file = this.pickTranscript(conversationId, true);
            if (!file) {
                console.log('[Antigravity getConversationContent] No transcript found for', conversationId);
                return [];
            }

            const messages = this.parseTranscript(file, { maxMessages: MAX_MESSAGES_PER_CONVERSATION });
            const deduped = this.dedupeConsecutive(messages);
            console.log(`[Antigravity getConversationContent] Found ${deduped.length} messages`);
            return deduped;
        } catch (error) {
            console.error('[Antigravity getConversationContent] Error:', error);
            return [];
        }
    }

    /**
     * Collapses consecutive identical (role+content) messages.
     * @param {Array<object>} messages
     * @returns {Array<object>}
     */
    dedupeConsecutive(messages) {
        const out = [];
        for (const message of messages) {
            const last = out[out.length - 1];
            if (last && last.role === message.role && last.content === message.content) {
                continue;
            }
            out.push(message);
        }
        return out;
    }
}

module.exports = AntigravityConversationSearchService;
