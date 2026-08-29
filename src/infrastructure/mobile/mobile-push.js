function attentionPushPayload(session = {}, alert = {}) {
  const title = typeof session.title === 'string' && session.title.trim()
    ? session.title.trim()
    : (typeof alert.title === 'string' && alert.title.trim() ? alert.title.trim() : 'CodeAgentSwarm');
  const body = typeof alert.body === 'string' && alert.body.trim()
    ? alert.body.trim()
    : 'A session needs your attention';
  return {
    sessionId: session.sessionId,
    title,
    body,
  };
}

module.exports = { attentionPushPayload };
