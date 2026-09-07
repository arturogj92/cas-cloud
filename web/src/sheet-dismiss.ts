export const SHEET_DISMISS_DISTANCE = 88;
export const SHEET_DISMISS_VELOCITY = 1.1;

export function shouldDismissSheet(dy: number, vy: number) {
  return dy > SHEET_DISMISS_DISTANCE || vy > SHEET_DISMISS_VELOCITY;
}
