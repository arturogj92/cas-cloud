// A resumed conversation can contain many provider events per user turn
// (reasoning, commands, edits, MCP calls, and assistant messages). Keep one
// shared bound across every driver so switching providers never changes how
// far back the user can scroll.
const CHAT_HISTORY_EVENT_LIMIT = 2000;

module.exports = {
  CHAT_HISTORY_EVENT_LIMIT
};
