import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { loadMobileNotificationsEnabled, type SavedConnection } from './storage';
import { diagnostic } from './diagnostics';
import { withTimeout } from './promise-timeout';
import { sessionAlertCopy, type RuntimeSession } from './protocol';
import { notificationSessionId } from './notification-navigation';
import {
  requestWebNotificationPermission,
  showWebSessionNotifications,
  subscribeToWebNotificationResponses,
} from './web-notifications';

const EXPO_PUSH_TOKEN = /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/;

export function isExpoPushToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

export function pushProjectId(): string | null {
  const expo = Constants as typeof Constants & { easConfig?: { projectId?: string } };
  const extra = expo.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  const fromConfig = extra?.eas?.projectId || expo.easConfig?.projectId;
  const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const value = fromEnv || fromConfig;
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function subscribeToNotificationResponses(
  openSession: (sessionId: string) => void,
  navigationGeneration: () => number = () => 0,
) {
  const initialNavigationGeneration = navigationGeneration();
  const Notifications = await notificationsModule();
  if (!Notifications) {
    return Platform.OS === 'web' ? subscribeToWebNotificationResponses(openSession) : () => {};
  }
  const open = (response: Parameters<typeof notificationSessionId>[0]) => {
    const sessionId = notificationSessionId(response);
    if (sessionId) openSession(sessionId);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(open);
  const last = await Notifications.getLastNotificationResponseAsync();
  if (last) {
    if (navigationGeneration() === initialNavigationGeneration) open(last);
    await Notifications.clearLastNotificationResponseAsync?.();
  }
  return () => subscription.remove();
}

async function notificationsModule() {
  const e2eModule = (globalThis as typeof globalThis & {
    __CAS_E2E_NOTIFICATIONS__?: typeof import('expo-notifications');
  }).__CAS_E2E_NOTIFICATIONS__;
  if (Platform.OS === 'web') return e2eModule || null;
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

let handlerReady = false;
let notificationPermission: Promise<boolean> | null = null;

function ensureNotificationPermission(Notifications: Awaited<ReturnType<typeof notificationsModule>>) {
  if (!Notifications) return Promise.resolve(false);
  if (!notificationPermission) {
    notificationPermission = (async () => {
      const current = await Notifications.getPermissionsAsync() as { granted?: boolean; status?: string };
      const permission = current.granted === true || current.status === 'granted'
        ? current
        : await Notifications.requestPermissionsAsync() as { granted?: boolean; status?: string };
      if (permission.granted !== true && permission.status !== 'granted') {
        diagnostic('push.permission_denied');
        return false;
      }
      return true;
    })().catch(() => false);
  }
  return notificationPermission;
}

export async function prepareLocalNotifications() {
  if (Platform.OS === 'web') return requestWebNotificationPermission();
  const Notifications = await notificationsModule();
  if (!Notifications) return false;
  if (!handlerReady) {
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        const enabled = await loadMobileNotificationsEnabled();
        return {
          shouldShowAlert: enabled,
          shouldShowBanner: enabled,
          shouldShowList: enabled,
          shouldPlaySound: enabled,
          shouldSetBadge: false,
        };
      },
    });
    handlerReady = true;
  }
  await Notifications.setNotificationChannelAsync?.('session-alerts', {
    name: 'Session alerts',
    importance: Notifications.AndroidImportance?.HIGH ?? 4,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#F59E0B',
  }).catch(() => {});
  if (!await ensureNotificationPermission(Notifications)) return false;
  diagnostic('push.local_ready');
  return true;
}

export async function presentSessionAlerts(sessions: RuntimeSession[]) {
  if (!sessions.length) return;
  if (!await loadMobileNotificationsEnabled()) return;
  if (Platform.OS === 'web') {
    const count = showWebSessionNotifications(sessions.map(sessionAlertCopy));
    if (count) diagnostic('push.local_presented', { count });
    return;
  }
  const Notifications = await notificationsModule();
  if (!Notifications) return;
  const ready = await prepareLocalNotifications();
  if (!ready) return;
  for (const session of sessions) {
    const alert = sessionAlertCopy(session);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: alert.title,
        body: alert.body,
        data: { sessionId: alert.sessionId },
        sound: 'default',
      },
      trigger: null,
    }).catch(() => {});
  }
  diagnostic('push.local_presented', { count: sessions.length });
}

export async function registerPushToken(connection: SavedConnection | null) {
  if (!connection?.deviceToken || !connection.backendOrigin || Platform.OS === 'web') return false;
  if (!await loadMobileNotificationsEnabled()) {
    try {
      const response = await withTimeout(fetch(`${connection.backendOrigin}/api/mobile/push-token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.deviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      }), 10_000);
      diagnostic(response.ok ? 'push.disabled' : 'push.disable_failed', response.ok ? undefined : { status: response.status });
    } catch {
      diagnostic('push.disable_failed');
    }
    return false;
  }
  const Notifications = await notificationsModule();
  if (!Notifications) return false;
  const projectId = pushProjectId();
  if (!projectId) {
    diagnostic('push.project_missing');
    return false;
  }
  try {
    await Notifications.setNotificationChannelAsync?.('session-alerts', {
      name: 'Session alerts',
      importance: Notifications.AndroidImportance?.HIGH ?? 4,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#F59E0B',
    }).catch(() => {});
    if (!await ensureNotificationPermission(Notifications)) return false;
    const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenResult?.data;
    if (!isExpoPushToken(token)) {
      diagnostic('push.token_missing');
      return false;
    }
    const response = await withTimeout(fetch(`${connection.backendOrigin}/api/mobile/push-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, token, platform: Platform.OS }),
    }), 10_000);
    if (!response.ok) {
      diagnostic('push.register_failed', { status: response.status });
      return false;
    }
    diagnostic('push.registered', { platform: Platform.OS });
    return true;
  } catch {
    diagnostic('push.register_failed');
    return false;
  }
}
