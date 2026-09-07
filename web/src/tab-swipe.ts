export type MobileTab = 'sessions' | 'projects' | 'kanban' | 'history';

export const TAB_SWIPE_SLOP = 12;

export function isTabSwipeGesture(tab: MobileTab, dx: number, dy: number) {
  if (Math.abs(dx) <= TAB_SWIPE_SLOP || Math.abs(dx) <= Math.abs(dy)) return false;
  if (tab !== 'sessions' && tab !== 'history') return false;
  return tab === 'sessions' ? dx < 0 : dx > 0;
}

export function tabDragOffset(tab: MobileTab, width: number, dx: number) {
  if (tab !== 'sessions' && tab !== 'history') return 0;
  const origin = tab === 'history' ? -width : 0;
  return Math.max(-width, Math.min(0, origin + dx));
}

export function settledTab(tab: MobileTab, dx: number, velocityX: number, width: number): MobileTab {
  if (tab !== 'sessions' && tab !== 'history') return tab;
  const committed = Math.abs(dx) >= width * .22 || Math.abs(velocityX) >= .42;
  if (!committed) return tab;
  if (tab === 'sessions' && dx < 0) return 'history';
  if (tab === 'history' && dx > 0) return 'sessions';
  return tab;
}
