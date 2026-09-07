export const SESSION_ACTIONS_WIDTH = 152;
export const SESSION_SWIPE_SLOP = 10;
export const SESSION_SWIPE_AXIS_RATIO = 1;
export const SESSION_CLOSE_SWIPE_THRESHOLD = 220;
export const SESSION_SCROLL_PRESS_COOLDOWN_MS = 150;

export function isSessionSwipeGesture(dx: number, dy: number) {
  return Math.abs(dx) > SESSION_SWIPE_SLOP && Math.abs(dx) > Math.abs(dy) * SESSION_SWIPE_AXIS_RATIO;
}

export function shouldOpenSessionActions(dx: number, revealed: boolean) {
  return revealed ? dx < SESSION_ACTIONS_WIDTH / 2 : dx < -SESSION_ACTIONS_WIDTH / 2;
}

export function isSessionCloseArmed(offset: number) {
  return offset <= -SESSION_CLOSE_SWIPE_THRESHOLD;
}

export function shouldOpenSessionAfterScroll(scrolling: boolean, scrollEndedAt: number, now = Date.now()) {
  return !scrolling && now - scrollEndedAt > SESSION_SCROLL_PRESS_COOLDOWN_MS;
}
