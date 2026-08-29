const MOBILE_PAIRING_EVENT = 'mobile-pairing:event';
const { PRODUCTION_MOBILE_WEB_ORIGIN } = require('./mobile-build-channel');

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
  relayClient.on('status', (status) => broadcast({ type: 'status', status }));
  relayClient.on('event', (event) => broadcast({ type: 'relay', event }));

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
      return {
        success: true,
        expiresAt: pairing.expiresAt,
        pairingCode: pairing.pairingCode,
        webUrl: mobileWebOrigin,
        keepAvailable: getKeepAvailable() === true,
        qrDataUrl
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
