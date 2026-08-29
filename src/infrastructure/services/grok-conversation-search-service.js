/**
 * Grok Conversation Search Service
 *
 * Searches and retrieves conversation history from the Grok Build CLI. Drop-in
 * sibling of the Codex/Antigravity/opencode/Kimi search services: a default-exported
 * class exposing
 *   - getRecentConversations(limit, recentProjectPaths, selectedProjectPath)
 *   - searchByTitle(query, recentProjectPaths, limit)
 *   - searchInContent(query, options)
 *   - getConversationContent(sessionId, projectDir)
 * with the SAME result shapes so main.js consumes them interchangeably
 * (+ isGrok / agent:'grok').
 *
 * Storage details live in grok-conversation-reader.js (plain JSON/JSONL under
 * ~/.grok). Although Grok stores sessions grouped per working directory, this
 * service treats the list GLOBALLY (project filter accepted but unused), matching
 * the unfiltered get-index skeleton — the lesson from opencode (2026-07-04): a
 * loaded list filtered tighter than the skeleton makes rows appear and then
 * VANISH, breaking the history "no reshuffle" guarantee.
 */

const reader = require('./grok-conversation-reader');
const { safePreviewString } = require('../../shared/utils/preview-string');
const { isConversationTitleWorkDir } = require('../../shared/conversation-title-workdir');
const { normalizeWorktreePath, buildRecentProjectMatcher } = require('./claude-project-path-resolver');

// Grok's auto-generated placeholder title for fresh sessions.
const NEW_SESSION_TITLE = /^(New Session|Untitled)/i;

class GrokConversationSearchService {
    normalizeString(str) {
        return str ? str.normalize('NFD').replace(/\p{Diacritic}/gu, '') : '';
    }

    buildDisplayText(text, maxLength = 100) {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'Grok Session';
        return cleaned.length <= maxLength
            ? cleaned
            : `${cleaned.substring(0, maxLength).trim()}...`;
    }

    /**
     * Resolve the display text for a session. Grok writes generated_title (falling
     * back to session_summary) into summary.json; a placeholder title falls back to
     * the first user message.
     * @param {object} session - reader session object
     * @returns {string}
     */
    resolveDisplayText(session) {
        const title = session.title || '';
        if (title && !NEW_SESSION_TITLE.test(title)) {
            return this.buildDisplayText(title);
        }

        // Pass sessionDir when known — avoids a full sessions/ walk per row.
        const firstUserText = reader.getFirstUserText(session.sessionId, session.sessionDir || null);
        if (firstUserText) {
            // Cap + flatten before it lands in a result object (V8 SlicedString guard).
            return this.buildDisplayText(safePreviewString(firstUserText));
        }

        return this.buildDisplayText(title || 'Grok Session');
    }

    /**
     * Get recent Grok conversations.
     * @param {number} limit
     * @param {Array<string>|null} recentProjectPaths - accepted, unused (see header).
     * @param {string|null} selectedProjectPath - Optional: return ONLY this project's sessions.
     *   Overrides recentProjectPaths and matches tolerantly (case/symlink/worktree). Scoped
     *   calls also scan deeper (cap 2000) because the project's sessions may all sit outside
     *   the newest-200 global window — exactly the case that emptied the resume panel.
     * @returns {Promise<Array<object>>}
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
                    // Attribute worktree cwds to their parent repo for the project label.
                    const sessionCwd = normalizeWorktreePath(session.projectPath);
                    // Drop foreign sessions BEFORE resolveDisplayText: that reads the
                    // first user message and is the expensive part of this loop.
                    if (scopedMatcher && (!sessionCwd || !scopedMatcher.matchesProjectPath(sessionCwd))) continue;

                    const displayText = this.resolveDisplayText(session);
                    const projectPath = sessionCwd || 'Other Project';
                    const projectName = sessionCwd
                        ? sessionCwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
                        : 'Grok Session';
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
                        isOpencode: false,
                        isKimi: false,
                        isGrok: true,
                        agent: 'grok',
                        filePath: session.filePath
                    });
                } catch (err) {
                    console.error(`[Grok] Error building conversation ${session.sessionId}:`, err.message);
                }

                if (conversations.length >= limit) break;
            }

            conversations.sort((a, b) => b.timestamp - a.timestamp);
            console.log(`[Grok Conversation Search] Found ${conversations.length} conversations in ${Date.now() - startTime}ms`);
            return conversations;
        } catch (error) {
            console.error('Error reading Grok conversation history:', error);
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
     */
    async searchByTitle(query, recentProjectPaths = null, limit = 50) {
        const convs = await this.getRecentConversations(2000, recentProjectPaths);
        const normalizedQuery = this.normalizeString((query || '').toLowerCase());
        return convs
            .filter(c => this.normalizeString((c.displayText || '').toLowerCase()).includes(normalizedQuery))
            .slice(0, limit);
    }

    /**
     * Content search is not indexed for Grok yet (parity with Antigravity/opencode/Kimi).
     */
    async searchInContent() {
        return [];
    }

    /**
     * Get the messages for a single conversation, for the chat-history UI.
     * @param {string} sessionId
     * @param {string|null} projectDir - accepted for signature parity, unused
     * @returns {Promise<Array<object>>}
     */
    async getConversationContent(sessionId, projectDir = null) {
        try {
            if (!sessionId) return [];
            const messages = reader.getSessionMessages(sessionId);
            console.log(`[Grok getConversationContent] Found ${messages.length} messages`);
            return messages;
        } catch (error) {
            console.error('[Grok getConversationContent] Error:', error);
            return [];
        }
    }
}

module.exports = GrokConversationSearchService;
