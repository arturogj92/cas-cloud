import { NativeModule, requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

type WatchEvents = { onWatchEvent(event: unknown): void };

declare class WatchNativeModule extends NativeModule<WatchEvents> {
  publishStateAsync(payload: Record<string, unknown>): Promise<void>;
  sendResultAsync(payload: Record<string, unknown>): Promise<void>;
  pendingEventsAsync(): Promise<unknown[]>;
  acknowledgeEventAsync(eventId: string): Promise<void>;
}

const native = requireOptionalNativeModule<WatchNativeModule>('CodeAgentSwarmWatch');

export const watchBridge = {
  available: Boolean(native),
  publishState: (payload: Record<string, unknown>) => native?.publishStateAsync(payload) ?? Promise.resolve(),
  sendResult: (payload: Record<string, unknown>) => native?.sendResultAsync(payload) ?? Promise.resolve(),
  pendingEvents: () => native?.pendingEventsAsync() ?? Promise.resolve([]),
  acknowledge: (eventId: string) => native?.acknowledgeEventAsync(eventId) ?? Promise.resolve(),
  subscribe(listener: (event: unknown) => void): EventSubscription | null {
    return native?.addListener('onWatchEvent', listener) ?? null;
  },
};
