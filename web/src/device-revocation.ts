import type { PendingDeviceRevocation, SavedConnection } from './storage';
import { diagnostic } from './diagnostics';
import { withTimeout } from './promise-timeout';

export function classifyPendingDeviceRevocation(
  revocation: PendingDeviceRevocation,
  connection: SavedConnection | null,
) {
  if (connection?.refreshToken === revocation.refreshToken) return 'discard';
  if (connection?.runtimeId === revocation.replacementRuntimeId) return 'revoke';
  return 'wait';
}

export async function revokeMobileDevice(
  connection: Pick<SavedConnection, 'backendOrigin' | 'refreshToken'> | null,
  fetchImpl: typeof fetch = fetch,
) {
  if (!connection?.refreshToken || !connection.backendOrigin) return true;
  try {
    const response = await withTimeout(fetchImpl(`${connection.backendOrigin}/api/mobile/device`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${connection.refreshToken}` },
    }), 10_000);
    if (!response.ok) {
      diagnostic('device.forget_failed', { status: response.status });
      return false;
    }
    diagnostic('device.forgotten_remote');
    return true;
  } catch {
    diagnostic('device.forget_failed');
    return false;
  }
}
