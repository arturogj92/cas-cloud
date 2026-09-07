const reader = require('./pi-conversation-reader');
const { normalizeWorktreePath, buildRecentProjectMatcher } = require('./claude-project-path-resolver');
const { isConversationTitleWorkDir } = require('../../shared/conversation-title-workdir');

class PiConversationSearchService {
  async getRecentConversations(limit = 20, _recentPaths = null, selectedPath = null) {
    const matcher = selectedPath ? buildRecentProjectMatcher([normalizeWorktreePath(selectedPath)]) : null;
    return reader.getAllSessions().filter((session) => !isConversationTitleWorkDir(session.projectPath)
      && (!matcher || matcher.matchesProjectPath(normalizeWorktreePath(session.projectPath)))).slice(0, limit).map((session) => {
      const projectPath = normalizeWorktreePath(session.projectPath);
      const display = String(session.title || 'Pi Session').replace(/\s+/g, ' ').trim().slice(0, 100);
      return { ...session, projectPath, projectDir: projectPath, projectName: projectPath?.split(/[\\/]/).pop() || 'Pi',
        display, displayText: display, relativeTime: new Date(session.timestamp).toLocaleDateString(),
        agent: 'pi', isPi: true, supportsChatResume: true };
    });
  }
  async searchByTitle(query, recentPaths = null, limit = 50) {
    const needle = String(query || '').toLocaleLowerCase();
    return (await this.getRecentConversations(2000, recentPaths)).filter((session) => session.displayText.toLocaleLowerCase().includes(needle)).slice(0, limit);
  }
  async searchInFile(filePath, normalizedQuery, originalQuery, { wholeWord = false } = {}) {
    const { findNormalizedMatch } = require('../../shared/utils/normalized-text-search');
    const matches = [];
    for (const [index, entry] of reader.readSession(filePath).branch.entries()) {
      if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role)) continue;
      const content = reader.textContent(entry.message.content);
      const match = findNormalizedMatch(content, originalQuery || normalizedQuery, { wholeWord });
      if (match) {
        matches.push({ content: content.slice(Math.max(0, match.start - 80), match.end + 120), lineNumber: index + 1, role: entry.message.role });
      }
      if (matches.length >= 20) break;
    }
    return matches;
  }
  async getConversationContent(id) {
    return reader.getSessionMessages(id)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ ...message, content: reader.textContent(message.content) }))
      .filter((message) => message.content.trim());
  }
}

module.exports = PiConversationSearchService;
