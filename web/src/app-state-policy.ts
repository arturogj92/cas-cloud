import type { ConnectionPhase } from './protocol';

export type RuntimeActivity = { active: boolean; delayMs: number };

/** Maps native lifecycle states to transport activity. Null leaves the current socket untouched. */
export function runtimeActivityForAppState(state: string, platform: string): RuntimeActivity | null {
  if (state === 'active') return { active: true, delayMs: 0 };
  if (state === 'background') return { active: platform === 'web', delayMs: platform === 'android' ? 1_500 : 0 };
  return null;
}

/** Automatic synchronization is quiet; only a confirmed foreground outage merits a banner. */
export function connectionNoticeEligible(phase: ConnectionPhase, foreground: boolean): boolean {
  return foreground && (phase === 'offline' || phase === 'error');
}
