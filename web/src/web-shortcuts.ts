export type WebShortcutAction =
  | { type: 'new-session' }
  | { type: 'select-index'; index: number }
  | { type: 'select-adjacent'; delta: -1 | 1 }
  | { type: 'focus-search' }
  | { type: 'show-history' }
  | { type: 'escape' };

export const WEB_SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: '⌥ N', label: 'New agent' },
  { keys: '⌥ 1…9', label: 'Switch to agent 1-9' },
  { keys: '⌥ ↑ / ↓', label: 'Previous / next agent' },
  { keys: '⌥ A', label: 'Search sessions' },
  { keys: '⌥ I', label: 'Open History' },
  { keys: 'Esc', label: 'Close / back to list' },
];

type WebShortcutEvent = {
  code: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

// Chrome reserves Cmd/Ctrl + N, W and 1..9, so the page can never see them: Alt is the modifier.
// Alt+letter rewrites `key` on macOS, so every comparison uses the physical `code`.
export function webShortcutAction(event: WebShortcutEvent): WebShortcutAction | null {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (!event.altKey) return event.code === 'Escape' ? { type: 'escape' } : null;
  if (event.code === 'KeyN') return { type: 'new-session' };
  if (event.code === 'KeyA') return { type: 'focus-search' };
  if (event.code === 'KeyI') return { type: 'show-history' };
  if (event.code === 'ArrowUp') return { type: 'select-adjacent', delta: -1 };
  if (event.code === 'ArrowDown') return { type: 'select-adjacent', delta: 1 };
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (digit) return { type: 'select-index', index: Number(digit[1]) - 1 };
  return null;
}
