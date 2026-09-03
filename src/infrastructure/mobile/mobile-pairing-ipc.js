const MOBILE_PAIRING_EVENT = 'mobile-pairing:event';
const { PRODUCTION_MOBILE_WEB_ORIGIN } = require('./mobile-build-channel');

// The relay keeps one five-minute pairing per runtime in durable storage, so a pairing
// created ahead of time stays scannable across desktop reconnects. Refreshing it while
// it still has two minutes left keeps a ready QR for the moment the user opens the modal.
const WARM_PAIRING_MIN_REMAINING_MS = 2 * 60_000;
const WARM_PAIRING_CHECK_INTERVAL_MS = 30_000;
const WARM_PAIRING_SERVE_MIN_REMAINING_MS = 15_000;

function pairingPayload(pairing, mobileWebOrigin = PRODUCTION_MOBILE_WEB_ORIGIN) {
  const credentials = new URL('codeagentswarm://pair');
  credentials.searchParams.set('relay', new URL(pairing.relayOrigin).origin);
  credentials.searchParams.set('backend', new URL(pairing.backendOrigin).origin);
  credentials.searchParams.set('runtime', pairing.runtimeId);
  credentials.searchParams.set('token', pairing.pairingToken);
  credentials.searchParams.set('key', pairing.desktopPublicKey);
  credentials.searchParams.set('v', '2');
  const payload = new URL(mobileWebOrigin);
  payload.searchParams.set('pairing', credentials.toString());
  return payload.toString();
}

function registerMobilePairingIpc({
  ipcMain,
  BrowserWindow,
  relayClient,
  mobileWebOrigin = PRODUCTION_MOBILE_WEB_ORIGIN,
  getKeepAvailable = () => null,
  setKeepAvailable = () => false,
  createQrDataUrl = (payload, options) => require('qrcode').toDataURL(payload, options)
}) {
  const broadcast = (message) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(MOBILE_PAIRING_EVENT, message);
    }
  };
  const buildPairing = async () => {
    const pairing = await relayClient.createPairing();
    const qrDataUrl = await createQrDataUrl(
      pairingPayload(pairing, mobileWebOrigin),
      {
        scale: 8,
        margin: 4,
        errorCorrectionLevel: 'L',
        color: { dark: '#111827', light: '#ffffff' }
      }
    );
    return { expiresAt: pairing.expiresAt, pairingCode: pairing.pairingCode, qrDataUrl };
  };

  let warm = null;
  let warming = null;
  const warmPairing = () => {
    if (warming || relayClient.status !== 'online') return warming;
    // A pairing already shown to the user must not be replaced early: the relay only keeps
    // one per runtime, so a replacement would silently invalidate the QR on screen.
    const remaining = warm ? warm.expiresAt - Date.now() : 0;
    if (warm && (warm.served ? remaining > 0 : remaining > WARM_PAIRING_MIN_REMAINING_MS)) return null;
    warming = buildPairing()
      .then((result) => { warm = result; }, () => {})
      .finally(() => { warming = null; });
    return warming;
  };
  const warmTimer = setInterval(warmPairing, WARM_PAIRING_CHECK_INTERVAL_MS);
  warmTimer.unref?.();

  relayClient.on('status', (status) => {
    broadcast({ type: 'status', status });
    if (status?.status === 'online') void warmPairing();
  });
  relayClient.on('event', (event) => {
    if (event?.kind === 'pair.scanned') warm = null;
    broadcast({ type: 'relay', event });
  });

  ipcMain.handle('mobile-pairing:status', () => ({
      success: true,
      ...relayClient.getStatus(),
      keepAvailable: getKeepAvailable() === true
    }));
  ipcMain.handle('mobile-pairing:keep-available', (event, { enabled } = {}) => {
    if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid availability setting' };
    try {
      return { success: true, keepAvailable: setKeepAvailable(enabled) === true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('mobile-pairing:devices', async () => {
    try {
      return { success: true, devices: await relayClient.listDevices() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('mobile-pairing:revoke', async (event, { id } = {}) => {
    try {
      await relayClient.revokeDevice(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('mobile-pairing:create', async () => {
    try {
      if (getKeepAvailable() == null) setKeepAvailable(true);
      if (warming) await warming;
      if (!warm || warm.expiresAt - Date.now() < WARM_PAIRING_SERVE_MIN_REMAINING_MS) warm = await buildPairing();
      warm.served = true;
      return {
        success: true,
        expiresAt: warm.expiresAt,
        pairingCode: warm.pairingCode,
        webUrl: mobileWebOrigin,
        keepAvailable: getKeepAvailable() === true,
        qrDataUrl: warm.qrDataUrl
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle('mobile-pairing:confirm', async (event, { pairingId, accept } = {}) => {
    try {
      await relayClient.confirmPairing(pairingId, accept);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  MOBILE_PAIRING_EVENT,
  pairingPayload,
  registerMobilePairingIpc
};
