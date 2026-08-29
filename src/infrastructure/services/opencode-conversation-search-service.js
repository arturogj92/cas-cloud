/**
 * Opencode Conversation Search Service
 *
 * Searches and retrieves conversation history from the opencode CLI. Drop-in
 * sibling of codex-conversation-search-service.js and
 * antigravity-conversation-search-service.js: a default-exported class exposing
 *   - getRecentConversations(limit, recentProjectPaths, selectedProjectPath)
 *   - searchByTitle(query, recentProjectPaths, limit)
 *   - searchInContent(query, options)
 *   - getConversationContent(sessionId, projectDir)
 * with the SAME result shapes those services return so main.js consumes them
 * interchangeably (+ isOpencode / agent:'opencode').
 *
 * opencode stores its sessions/messages/parts in a single SQLite database — see
 * opencode-conversation-reader.js for the on-disk details. This service maps the
 * reader's session/message objects into the search-service result shape.
 */

const reader = require('./opencode-conversation-reader');
const { safePreviewString } = require('../../shared/utils/preview-string');
const { isConversationTitleWorkDir } = require('../../shared/conversation-title-workdir');
const { normalizeWorktreePath, buildRecentProjectMatcher } = require('./claude-project-path-resolver');

const NEW_SESSION_TITLE = /^New session/i;

class OpencodeConversationSearchService {
    normalizeString(str) {
        return str ? str.normalize('NFD').replace(/\p{Diacritic}/gu, '') : '';
    }

    /**
     * Builds the short display/preview text from raw title text.
     * @param {string} text
     * @param {number} [maxLength]
     * @returns {string}
     */
    buildDisplayText(text, maxLength = 100) {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'opencode Session';
        return cleaned.length <= maxLength
            ? cleaned
            : `${cleaned.substring(0, maxLength).trim()}...`;
    }

    /**
     * Resolves the display text for a session. When the title is opencode's
     * auto-generated "New session - <iso>" placeholder, falls back to the first
     * user message; final fallback is the title itself.
     * @param {object} session - reader session object
     * @returns {string}
     */
    resolveDisplayText(session) {
        const title = session.title || '';
        if (title && !NEW_SESSION_TITLE.test(title)) {
            return this.buildDisplayText(title);
        }

        const firstUserText = reader.getFirstUserText(session.sessionId);
        if (firstUserText) {
            // Cap + flatten before it lands in a result object (V8 SlicedString guard).
            return this.buildDisplayText(safePreviewString(firstUserText));
        }

        return this.buildDisplayText(title || 'opencode Session');
    }

    /**
     * Get recent opencode conversations.
     *
     * @param {number} limit
     * @param {Array<string>|null} recentProjectPaths - accepted, unused. Opencode
     *   uses a single shared/flat store (like Antigravity), so its recent list is
     *   NOT filtered by project. This keeps the loaded list consistent with the
     *   unfiltered get-index skeleton so opencode rows never appear then vanish
     *   (the history "list must not reshuffle" guarantee).
     * @param {string|null} selectedProjectPath - Optional: return ONLY this project's sessions.
     *   Overrides recentProjectPaths and matches tolerantly (case/symlink/worktree). Scoped
     *   calls also scan deeper (cap 2000) because the project's sessions may all sit outside
     *   the newest-200 global window — exactly the case that emptied the resume panel.
     * @returns {Promise<Array<object>>} conversation objects matching the
     *   Claude/Codex/Antigravity search-service shape (+ isOpencode / agent).
     */
    async getRecentConversations(limit = 20, recentProjectPaths = null, selectedProjectPath = null) {
        const startTime = Date.now();
        try {
            const scopedMatcher = selectedProjectPath
                ? buildRecentProjectMatcher([normalizeWorktreePath(selectedProjectPath)])
                : null;
            // When scoped, scan deeper than the default recency window: the selected
            // project's sessions may all be older than the newest 200 global ones.
            const sessions = reader.getAllSessions(scopedMatcher ? Math.max(limit, 2000) : Math.max(limit, 200));
            if (sessions.length === 0) return [];

            const conversations = [];
            for (const session of sessions) {
                try {
                    if (isConversationTitleWorkDir(session.projectPath)) continue;
                    // Opencode uses a single shared/flat store, so we do NOT filter by
                    // project here (matching Antigravity and the unfiltered get-index
                    // scan). Filtering by recentProjectPaths made opencode rows show in
                    // the skeleton and then vanish after load, reshuffling the list.
                    // Worktree cwds are still attributed to their parent repo for the
                    // project label. No-op for normal paths.
                    const sessionCwd = normalizeWorktreePath(session.projectPath);
                    // Drop foreign sessions BEFORE resolveDisplayText: that reads the
                    // first user message and is the expensive part of this loop.
                    if (scopedMatcher && (!sessionCwd || !scopedMatcher.matchesProjectPath(sessionCwd))) continue;

                    const displayText = this.resolveDisplayText(session);
                    const projectPath = sessionCwd || 'Other Project';
                    const projectName = sessionCwd
                        ? sessionCwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
                        : 'opencode Session';
                    // Mark conversations that ran inside a per-conversation worktree
                    // (raw cwd held ".codeagentswarm/worktrees/" so normalize changed it).
                    const isWorktree = !!(session.projectPath && normalizeWorktreePath(session.projectPath) !== session.projectPath);

                    conversations.push({
                        sessionId: session.sessionId,
                        projectPath,
                        projectName,
                        projectDir: sessionCwd,
                        isWorktree,
                        displayText,
                        display: displayText,
                        timestamp: session.timestamp,
                        createdAt: session.createdAt,
                        updatedAt: session.updatedAt,
                        relativeTime: this.getRelativeTime(session.timestamp),
                        isCodex: false,
                        isAntigravity: false,
                        isGemini: false,
                        isOpencode: true,
                        agent: 'opencode',
                        filePath: session.filePath
                    });
                } catch (err) {
                    console.error(`[Opencode] Error building conversation ${session.sessionId}:`, err.message);
                }

                if (conversations.length >= limit) break;
            }

            conversations.sort((a, b) => b.timestamp - a.timestamp);
            console.log(`[Opencode Conversation Search] Found ${conversations.length} conversations in ${Date.now() - startTime}ms`);
            return conversations;
        } catch (error) {
            console.error('Error reading opencode conversation history:', error);
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
        const normalizedQuery = this.normalizeString((query || '').toLowerCase());
        return convs
            .filter(c => this.normalizeString((c.displayText || '').toLowerCase()).includes(normalizedQuery))
            .slice(0, limit);
    }

    /**
     * Content search is not indexed for opencode yet (parity with Antigravity).
     * @returns {Promise<Array>}
     */
    async searchInContent() {
        return [];
    }

    /**
     * Get the messages for a single conversation, for the chat-history UI.
     * Returns the same {role, content, timestamp} shape the Codex service returns.
     *
     * @param {string} sessionId - the opencode session id
     * @param {string|null} projectDir - accepted for signature parity, unused
     *   (the sessionId alone locates the conversation in the db)
     * @returns {Promise<Array<object>>}
     */
    async getConversationContent(sessionId, projectDir = null) {
        try {
            if (!sessionId) return [];
            const messages = reader.getSessionMessages(sessionId);
            console.log(`[Opencode getConversationContent] Found ${messages.length} messages`);
            return messages;
        } catch (error) {
            console.error('[Opencode getConversationContent] Error:', error);
            return [];
        }
    }
}

module.exports = OpencodeConversationSearchService;
