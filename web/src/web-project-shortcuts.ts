export type WebProjectShortcut = {
  shortcutId: string;
  projectPath: string;
  agent: string;
  useWorktree: boolean | null;
};

export type WebShortcutStorage = Pick<Storage, 'getItem' | 'setItem'>;

const KEY_PREFIX = 'cas.mobile.web-project-shortcuts.v1.';
const MAX_SHORTCUTS = 10;

function normalizeShortcut(value: unknown): WebProjectShortcut | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const shortcut = value as Partial<WebProjectShortcut>;
  if (!shortcut.shortcutId?.trim() || !shortcut.projectPath?.trim() || !shortcut.agent?.trim()) return null;
  return {
    shortcutId: shortcut.shortcutId,
    projectPath: shortcut.projectPath,
    agent: shortcut.agent,
    useWorktree: shortcut.useWorktree === true ? true : shortcut.useWorktree === false ? false : null,
  };
}

function normalizeShortcuts(values: readonly unknown[]) {
  return values.flatMap((value) => {
    const shortcut = normalizeShortcut(value);
    return shortcut ? [shortcut] : [];
  }).slice(0, MAX_SHORTCUTS);
}

function key(runtimeId: string) {
  return `${KEY_PREFIX}${encodeURIComponent(runtimeId)}`;
}

export function readWebProjectShortcuts(storage: WebShortcutStorage, runtimeId: string) {
  if (!runtimeId) return null;
  try {
    const saved = storage.getItem(key(runtimeId));
    if (saved === null) return null;
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? normalizeShortcuts(parsed) : null;
  } catch {
    return null;
  }
}

/** Copies the remote catalogue only on first use; later reads are browser-local. */
export function loadWebProjectShortcuts(
  storage: WebShortcutStorage,
  runtimeId: string,
  desktopShortcuts: readonly WebProjectShortcut[],
) {
  const initial = normalizeShortcuts(desktopShortcuts).map((shortcut) => ({
    ...shortcut,
    shortcutId: `web:${shortcut.shortcutId}`,
  }));
  if (!runtimeId) return initial;

  const saved = readWebProjectShortcuts(storage, runtimeId);
  if (saved !== null) return saved;
  try {
    storage.setItem(key(runtimeId), JSON.stringify(initial));
  } catch {
    // A private or full browser store still gets usable in-memory defaults.
  }
  return initial;
}

export function saveWebProjectShortcuts(
  storage: WebShortcutStorage,
  runtimeId: string,
  shortcuts: readonly WebProjectShortcut[],
) {
  const normalized = normalizeShortcuts(shortcuts);
  if (!runtimeId) return normalized;
  try {
    storage.setItem(key(runtimeId), JSON.stringify(normalized));
  } catch {
    // The caller keeps the in-memory value when browser persistence is unavailable.
  }
  return normalized;
}
