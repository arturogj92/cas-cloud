const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TOKEN = /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/;
const RUNTIME_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TITLE = 80;
const MAX_BODY = 160;

function isExpoPushToken(value) {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

function compactAlert({ title, body, sessionId, runtimeId } = {}) {
  const compactTitle = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE) : '';
  return {
    title: compactTitle || 'CodeAgentSwarm',
    body: typeof body === 'string' && body.trim()
      ? body.trim().slice(0, MAX_BODY)
      : 'A session needs your attention',
    sessionId: typeof sessionId === 'string' ? sessionId.trim().slice(0, 128) : undefined,
    runtimeId: typeof runtimeId === 'string' && RUNTIME_ID.test(runtimeId) ? runtimeId : undefined,
  };
}

async function sendExpoPush({
  tokens,
  title,
  body,
  sessionId,
  runtimeId,
  fetchImpl = fetch,
} = {}) {
  const unique = [...new Set((tokens || []).filter(isExpoPushToken))];
  if (!unique.length) return { sent: 0 };
  const alert = compactAlert({ title, body, sessionId, runtimeId });
  const messages = unique.map((to) => ({
    to,
    title: alert.title,
    body: alert.body,
    sound: 'default',
    priority: 'high',
    channelId: 'session-alerts',
    data: {
      ...(alert.sessionId ? { sessionId: alert.sessionId } : {}),
      ...(alert.runtimeId ? { runtimeId: alert.runtimeId } : {}),
    },
  }));
  const response = await fetchImpl(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages),
  });
  if (!response.ok) {
    throw Object.assign(new Error('Expo push delivery failed'), { status: 502 });
  }
  return { sent: unique.length };
}

module.exports = {
  EXPO_PUSH_URL,
  compactAlert,
  isExpoPushToken,
  sendExpoPush,
};
