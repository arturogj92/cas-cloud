export type QuotaPickSnapshot = {
  agent: string;
  windows: unknown[];
  remainingFraction?: number;
};

export function featuredQuota<T extends { agent: string; windows: unknown[] }>(
  snapshots: T[],
  pinnedAgent: string | null,
  tightest: (list: T[]) => T | null,
) {
  if (pinnedAgent) {
    const pinned = snapshots.find((snapshot) => snapshot.agent === pinnedAgent && snapshot.windows.length);
    if (pinned) return pinned;
  }
  return tightest(snapshots);
}
