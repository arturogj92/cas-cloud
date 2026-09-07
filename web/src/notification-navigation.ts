import { hostScopedId, splitHostScopedId } from './host-scope';

type NotificationResponse = {
  notification?: {
    request?: {
      content?: {
        data?: Record<string, unknown>;
      };
    };
  };
};

export function notificationSessionId(response: unknown): string | null {
  const candidate = response as NotificationResponse | null | undefined;
  const data = candidate?.notification?.request?.content?.data;
  const value = data?.sessionId;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return null;
  if (!Object.prototype.hasOwnProperty.call(data, 'runtimeId')) return value;
  const runtimeId = data?.runtimeId;
  if (typeof runtimeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(runtimeId)) return null;
  const scoped = splitHostScopedId(value);
  if (scoped) return scoped.runtimeId === runtimeId ? value : null;
  return hostScopedId(runtimeId, value);
}
