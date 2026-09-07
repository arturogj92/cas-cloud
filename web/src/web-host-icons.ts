import type { RuntimeHost } from './protocol';

export const WEB_HOST_ICON_IDS = ['vps', 'mac', 'windows', 'linux', 'desktop', 'laptop', 'cloud', 'mini-pc', 'home-lab', 'nas'] as const;
export type WebHostIconId = typeof WEB_HOST_ICON_IDS[number];
export type WebHostIcons = Record<string, WebHostIconId>;

export const WEB_HOST_ICONS_KEY = 'cas.mobile.web-host-icons.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultWebHostIcon(host: Pick<RuntimeHost, 'kind' | 'platform'>): WebHostIconId {
  if (host.kind === 'cloud') return 'vps';
  if (host.platform === 'darwin') return 'mac';
  if (host.platform === 'win32') return 'windows';
  if (host.platform === 'linux') return 'linux';
  return 'desktop';
}

export function loadWebHostIcons(storage: Pick<StorageLike, 'getItem'>): WebHostIcons {
  try {
    const value = JSON.parse(storage.getItem(WEB_HOST_ICONS_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, WebHostIconId] => (
      Boolean(entry[0]) && WEB_HOST_ICON_IDS.includes(entry[1] as WebHostIconId)
    )));
  } catch {
    return {};
  }
}

export function saveWebHostIcon(storage: StorageLike, current: WebHostIcons, runtimeId: string, icon: WebHostIconId) {
  const next = { ...current, [runtimeId]: icon };
  storage.setItem(WEB_HOST_ICONS_KEY, JSON.stringify(next));
  return next;
}

export function webHostIcon(host: RuntimeHost, icons: WebHostIcons): WebHostIconId {
  return icons[host.runtimeId] || defaultWebHostIcon(host);
}
