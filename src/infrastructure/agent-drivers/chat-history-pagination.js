const DEFAULT_HISTORY_PAGE_SIZE = 120;
const { parseSessionCoordinationPrompt } = require('../../shared/parsers/session-coordination-message');

function conversationTimestampMs(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

function normalizeConversationMessages(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const role = message?.role === 'assistant' ? 'assistant_message' : (
      message?.role === 'user' ? 'user_message' : null
    );
    const text = [message?.content, message?.text, message?.displayText]
      .find((value) => typeof value === 'string' && value.trim());
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    return role && (text || attachments.length) && !(role === 'user_message' && text && parseSessionCoordinationPrompt(text))
      ? [{ role, text: text || '', attachments, timestamp: message.timestamp }]
      : [];
  });
}

function findConversationAnchor(messages, anchor) {
  const role = anchor?.role === 'assistant_message' || anchor?.role === 'assistant'
    ? 'assistant_message'
    : (anchor?.role === 'user_message' || anchor?.role === 'user' ? 'user_message' : null);
  const text = typeof anchor?.text === 'string' ? anchor.text.trim() : '';
  if (!role || !text) return null;
  const anchorTimestamp = conversationTimestampMs(anchor.timestamp);
  let match = null;
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate.role !== role) continue;
    if (Number.isFinite(anchorTimestamp) && conversationTimestampMs(candidate.timestamp) !== anchorTimestamp) continue;
    const candidateText = candidate.text.trim();
    if (candidateText !== text && !candidateText.startsWith(text) && !text.startsWith(candidateText)) continue;
    if (Number.isFinite(anchorTimestamp)) return index;
    if (match !== null) return null;
    match = index;
  }
  return match;
}

function pageConversationMessages(messages, {
  before,
  anchor,
  knownCount = 0,
  limit = DEFAULT_HISTORY_PAGE_SIZE
} = {}) {
  const normalized = normalizeConversationMessages(messages);
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_HISTORY_PAGE_SIZE;
  const anchorIndex = findConversationAnchor(normalized, anchor);
  const end = Number.isSafeInteger(before)
    ? Math.max(0, Math.min(before, normalized.length))
    : (anchorIndex ?? Math.max(0, normalized.length - Math.max(0, Number(knownCount) || 0)));
  const start = Math.max(0, end - safeLimit);
  return {
    messages: normalized.slice(start, end).map((message, offset) => ({
      ...message,
      index: start + offset
    })),
    nextCursor: start > 0 ? start : null,
    hasMore: start > 0
  };
}

function conversationMessagesToEvents(messages, { provider, threadId } = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const rawTimestamp = message.timestamp;
    const timestampMs = conversationTimestampMs(rawTimestamp);
    const createdAt = Number.isFinite(timestampMs)
      ? new Date(timestampMs).toISOString()
      : null;
    const itemId = `history-page:${threadId || 'conversation'}:${message.index}`;
    return {
      eventId: itemId,
      provider: provider || 'history',
      threadId,
      type: 'item.completed',
      itemId,
      createdAt,
      payload: {
        itemType: message.role,
        status: 'completed',
        historical: true,
        data: {
          text: message.text,
          ...(message.attachments?.length ? { attachments: message.attachments } : {})
        }
      }
    };
  });
}

module.exports = {
  DEFAULT_HISTORY_PAGE_SIZE,
  conversationTimestampMs,
  normalizeConversationMessages,
  findConversationAnchor,
  pageConversationMessages,
  conversationMessagesToEvents
};
