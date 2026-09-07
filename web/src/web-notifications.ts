export type WebSessionAlert = {
  sessionId: string;
  title: string;
  body: string;
};

const OPEN_EVENT = 'cas:web-notification-open';

export async function requestWebNotificationPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  return await Notification.requestPermission() === 'granted';
}

export function showWebSessionNotifications(alerts: WebSessionAlert[]) {
  if (typeof window === 'undefined'
    || typeof document === 'undefined'
    || typeof Notification === 'undefined'
    || Notification.permission !== 'granted'
    || (document.visibilityState === 'visible' && document.hasFocus?.() !== false)) return 0;

  for (const alert of alerts) {
    const notification = new Notification(alert.title, {
      body: alert.body,
      tag: `cas-session-${alert.sessionId}`,
    });
    notification.onclick = () => {
      window.focus();
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { sessionId: alert.sessionId } }));
      notification.close();
    };
  }
  return alerts.length;
}

export function subscribeToWebNotificationResponses(openSession: (sessionId: string) => void) {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId;
    if (typeof sessionId === 'string' && sessionId) openSession(sessionId);
  };
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}
