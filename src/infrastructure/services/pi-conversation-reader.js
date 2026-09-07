const fs = require('fs');
const os = require('os');
const path = require('path');

function getAgentDir(env = process.env) { return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'); }
function getDataRoot(env = process.env) {
  return env.PI_CODING_AGENT_SESSION_DIR || path.join(getAgentDir(env), 'sessions');
}
function readSession(file) {
  const stat = fs.statSync(file);
  if (stat.size > 64 * 1024 * 1024) throw new Error('Pi session exceeds the history reader limit (64 MiB)');
  const entries = fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
  const header = entries[0];
  if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') throw new Error('Invalid Pi session');
  const nodes = new Map(entries.slice(1).filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const branch = [];
  let entry = entries[entries.length - 1];
  const seen = new Set();
  while (entry?.id && entry.type !== 'session' && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.push(entry);
    entry = nodes.get(entry.parentId);
  }
  branch.reverse();
  return { header, entries, branch, stat };
}
function sessionFiles(root = getDataRoot()) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
      if (entry.isDirectory()) {
        for (const child of fs.readdirSync(file, { withFileTypes: true })) {
          if (child.isFile() && child.name.endsWith('.jsonl')) files.push(path.join(file, child.name));
        }
      }
    }
  } catch (_) {}
  return files;
}
function textContent(content) {
  return typeof content === 'string' ? content : (content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}
function getAllSessions(limit = 2000, root = getDataRoot()) {
  // ponytail: bounded full transcript scans; cache header summaries if large histories become slow.
  return sessionFiles(root).flatMap((filePath) => {
    try {
      const { header, entries, branch, stat } = readSession(filePath);
      const name = [...entries].reverse().find((entry) => entry.type === 'session_info' && entry.name)?.name;
      const user = branch.find((entry) => entry.message?.role === 'user');
      return [{ sessionId: header.id, projectPath: header.cwd, title: name || textContent(user?.message?.content),
        timestamp: stat.mtimeMs, updatedAt: stat.mtimeMs, createdAt: Date.parse(header.timestamp) || stat.birthtimeMs, filePath }];
    } catch (_) { return []; }
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}
function getSessionsForProject(cwd) {
  if (!cwd) return [];
  const key = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return getAllSessions(Number.MAX_SAFE_INTEGER).filter((session) => key(session.projectPath) === key(cwd));
}
function findSession(id, root) { return getAllSessions(Number.MAX_SAFE_INTEGER, root).find((entry) => entry.sessionId === id) || null; }
function getSessionMessages(id) {
  const session = findSession(id);
  if (!session) return [];
  return readSession(session.filePath).branch.filter((entry) => entry.type === 'message').map((entry) => entry.message);
}
module.exports = {
  getAgentDir, getDataRoot, readSession, sessionFiles, textContent, getAllSessions, getSessionsForProject, findSession, getSessionMessages,
  getSessionWorkDir: (id) => findSession(id)?.projectPath || null,
  hasConversationsForProject: (cwd) => getSessionsForProject(cwd).length > 0,
  enumerateSessionsForIndex: () => getAllSessions(),
};
