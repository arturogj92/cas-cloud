const reader = require('./cursor-conversation-reader');
const { normalizeWorktreePath, buildRecentProjectMatcher } = require('./claude-project-path-resolver');
const { isConversationTitleWorkDir } = require('../../shared/conversation-title-workdir');

class CursorConversationSearchService {
    constructor({ supportsChatResume = false } = {}) {
        this.supportsChatResume = supportsChatResume === true;
    }

    buildDisplayText(text, max = 100) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim() || 'Cursor Session';
        return clean.length <= max ? clean : `${clean.slice(0, max).trim()}...`;
    }

    async getRecentConversations(limit = 20, _recentProjectPaths = null, selectedProjectPath = null) {
        const matcher = selectedProjectPath ? buildRecentProjectMatcher([normalizeWorktreePath(selectedProjectPath)]) : null;
        const conversations = [];
        for (const session of reader.getAllSessions(matcher ? 2000 : Math.max(limit, 200))) {
            if (isConversationTitleWorkDir(session.projectPath)) continue;
            const projectPath = normalizeWorktreePath(session.projectPath);
            if (matcher && (!projectPath || !matcher.matchesProjectPath(projectPath))) continue;
            const displayText = this.buildDisplayText(session.title || reader.getFirstUserText(session.sessionId));
            conversations.push({
                sessionId: session.sessionId,
                projectPath: projectPath || 'Other Project',
                projectDir: projectPath || '',
                projectName: projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : 'Cursor Session',
                displayText,
                display: displayText,
                timestamp: session.timestamp,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                relativeTime: this.getRelativeTime(session.timestamp),
                isCursor: true,
                agent: 'cursor',
                supportsChatResume: this.supportsChatResume,
                filePath: session.filePath,
            });
            if (conversations.length >= limit) break;
        }
        return conversations;
    }

    getRelativeTime(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
        return new Date(timestamp).toLocaleDateString();
    }

    async searchByTitle(query, recentProjectPaths = null, limit = 50) {
        const needle = String(query || '').toLocaleLowerCase();
        return (await this.getRecentConversations(2000, recentProjectPaths))
            .filter((conversation) => conversation.displayText.toLocaleLowerCase().includes(needle)).slice(0, limit);
    }

    async searchInContent() { return []; }
    async getConversationContent(sessionId) { return reader.getSessionMessages(sessionId); }
}

module.exports = CursorConversationSearchService;
