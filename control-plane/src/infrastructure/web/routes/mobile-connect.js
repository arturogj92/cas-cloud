const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { compactAlert, isExpoPushToken, sendExpoPush } = require('../../mobile/mobile-push');

const RUNTIME_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ACCESS_TTL_SECONDS = 60 * 60;
const DEVICE_TOKEN_VERSION = 1;
const MAX_VOICE_NOTE_MS = 5 * 60 * 1000;
const GROQ_DAILY_ALERT_SECONDS = 6 * 60 * 60;
const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// ponytail: one-successor grace covers reload races; add rotation history only if clients need longer replay windows.
const REFRESH_REPLAY_GRACE_MS = 30_000;
const RECONNECT_TRIGGERS = ['boot', 'pair', 'resume', 'close', 'heartbeat_timeout', 'command_timeout', 'online', 'manual', 'retry'];
const RECONNECT_TIMEOUT_PHASES = ['socket', 'welcome'];
const MOBILE_PLATFORMS = ['ios', 'android', 'web'];
const MOBILE_CHANNELS = ['development', 'production'];
const RUNTIME_PHASES = ['booting', 'unpaired', 'connecting', 'confirming', 'online', 'offline', 'error'];
const SESSION_OPEN_STAGES = ['requested', 'rendered'];
const SESSION_OPEN_SOURCES = ['row', 'notification', 'history', 'created', 'shortcut'];
const DESKTOP_CLIENTS = ['desktop', 'cas-cloud'];
const DESKTOP_PLATFORMS = ['darwin', 'linux', 'win32'];
const DESKTOP_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,6})?)?$/;
const MOBILE_COMMAND_TYPES = [
  'attachment.abort', 'attachment.begin', 'attachment.chunk', 'attachment.read',
  'coordination.message', 'coordination.peers.replace', 'coordination.sessions', 'coordination.transcript',
  'history.list', 'history.older', 'preview.close', 'preview.create',
  'question.respond', 'reference.resolve', 'request.respond', 'session.configure',
  'session.create', 'session.minimize', 'session.models', 'session.read',
  'session.restore', 'session.resume', 'session.status', 'session.stop',
  'turn.interrupt', 'turn.send',
];
const MAX_RECONNECT_PHASE_MS = 600_000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_RECONNECT_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_TELEMETRY_VERSION_CHARS = 64;

const boundedInteger = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const optionalShortText = (value) => value === undefined
  || (typeof value === 'string' && value.length > 0 && value.length <= MAX_TELEMETRY_VERSION_CHARS);

const randomRefreshToken = () => crypto.randomBytes(32).toString('base64url');
const hashRefreshToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const nextRefreshTokenFor = (secret, token) => crypto
  .createHmac('sha256', secret)
  .update('mobile-refresh-v1\0')
  .update(token)
  .digest('base64url');
const relayGroupIdFor = (secret, userId) => crypto
  .createHmac('sha256', secret)
  .update('relay-group-v1\0')
  .update(String(userId))
  .digest('base64url');
const logRef = (value) => value
  ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10)
  : undefined;
const audit = (event, fields = {}) => console.info('[mobile-connect]', JSON.stringify({ event, ...fields }));

const audioExtension = (mimeType) => ({
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
}[mimeType]);

async function transcribeWithGroq({ apiKey, audio, mimeType, fetchImpl = fetch }) {
  const extension = audioExtension(mimeType);
  if (!extension) throw Object.assign(new Error('Unsupported voice recording format'), { status: 415 });
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), `voice-note.${extension}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  const response = await fetchImpl(GROQ_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw Object.assign(new Error('Voice transcription provider failed'), { status: 502 });
  const result = await response.json();
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!text) throw Object.assign(new Error('No speech was detected'), { status: 422 });
  return text;
}

function createMobileConnectRouter({
  relaySecret,
  relayOrigin,
  deviceStore,
  authMiddleware,
  groqApiKey,
  transcribeAudio = transcribeWithGroq,
  recordGroqUsage = async () => null,
  notifyGroqUsageLimit = async () => false,
  sendPush = sendExpoPush,
}) {
  if (!relaySecret || relaySecret.length < 32) throw new Error('MOBILE_RELAY_SECRET must contain at least 32 characters');
  if (!relayOrigin) throw new Error('MOBILE_RELAY_URL is required');
  if (!deviceStore) throw new Error('Mobile device store is required');
  if (typeof authMiddleware !== 'function') throw new Error('Mobile auth middleware is required');
  const router = express.Router();

  const issueDeviceToken = (device) => jwt.sign(
    {
      role: 'mobile',
      runtimeId: device.runtime_id || device.runtimeId,
      deviceId: device.device_id || device.deviceId,
      deviceName: device.device_name || device.deviceName,
      publicKey: device.public_key || device.publicKey,
      tokenVersion: DEVICE_TOKEN_VERSION,
    },
    relaySecret,
    {
      subject: device.user_id || device.userId,
      issuer: 'codeagentswarm',
      audience: 'codeagentswarm-mobile-relay',
      expiresIn: DEVICE_ACCESS_TTL_SECONDS,
      jwtid: crypto.randomUUID(),
    }
  );

  router.post('/refresh', async (req, res, next) => {
    const refreshToken = req.body?.refreshToken;
    if (!REFRESH_TOKEN.test(refreshToken || '')) {
      audit('refresh.rejected', { reason: 'malformed' });
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    const nextRefreshToken = nextRefreshTokenFor(relaySecret, refreshToken);
    try {
      let device = await deviceStore.rotateRefreshToken(
        hashRefreshToken(refreshToken),
        hashRefreshToken(nextRefreshToken)
      );
      let replayed = false;
      if (!device) {
        device = await deviceStore.findRecentRefreshToken(
          hashRefreshToken(nextRefreshToken),
          new Date(Date.now() - REFRESH_REPLAY_GRACE_MS).toISOString()
        );
        replayed = Boolean(device);
      }
      if (!device) {
        await deviceStore.revokeByRefreshTokens([
          hashRefreshToken(refreshToken),
          hashRefreshToken(nextRefreshToken),
        ]);
        audit('refresh.rejected', { reason: 'revoked_or_replayed' });
        return res.status(401).json({ error: 'Mobile device was revoked' });
      }
      audit(replayed ? 'refresh.replayed' : 'refresh.completed', {
        user: logRef(device.user_id || device.userId),
        runtime: logRef(device.runtime_id || device.runtimeId),
        device: logRef(device.device_id || device.deviceId),
      });
      return res.json({
        deviceToken: issueDeviceToken(device),
        refreshToken: nextRefreshToken,
        expiresIn: DEVICE_ACCESS_TTL_SECONDS,
        expiresAt: Date.now() + DEVICE_ACCESS_TTL_SECONDS * 1000,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/transcribe', express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    let claims;
    try {
      claims = jwt.verify(token || '', relaySecret, {
        issuer: 'codeagentswarm',
        audience: 'codeagentswarm-mobile-relay',
      });
    } catch {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    if (claims.role !== 'mobile' || !claims.sub || !claims.deviceId) {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    const durationMs = Number(req.headers['x-audio-duration-ms']);
    const mimeType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Voice recording is required' });
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_VOICE_NOTE_MS) {
      return res.status(400).json({ error: 'Invalid voice recording duration' });
    }
    if (!audioExtension(mimeType)) return res.status(415).json({ error: 'Unsupported voice recording format' });
    if (!groqApiKey) return res.status(503).json({ error: 'Voice transcription is unavailable' });
    try {
      audit('transcription.started', {
        user: logRef(claims.sub),
        device: logRef(claims.deviceId),
        durationMs,
        sizeBytes: req.body.length,
      });
      const billableSeconds = Math.max(10, Math.ceil(durationMs / 1000));
      const usage = await recordGroqUsage({ billableSeconds });
      if (usage?.shouldAlert) {
        console.warn('[groq-usage]', JSON.stringify({
          event: 'daily_threshold_crossed',
          totalSeconds: usage.totalSeconds,
          thresholdSeconds: GROQ_DAILY_ALERT_SECONDS,
        }));
        const notified = await notifyGroqUsageLimit({
          totalSeconds: usage.totalSeconds,
          thresholdSeconds: GROQ_DAILY_ALERT_SECONDS,
        });
        if (!notified) console.warn('[groq-usage] Daily usage alert could not be delivered');
      }
      const text = await transcribeAudio({ apiKey: groqApiKey, audio: req.body, mimeType });
      audit('transcription.completed', { user: logRef(claims.sub), device: logRef(claims.deviceId) });
      return res.json({ text });
    } catch (error) {
      audit('transcription.failed', {
        user: logRef(claims.sub),
        device: logRef(claims.deviceId),
        status: error.status || 500,
      });
      return next(error);
    }
  });

  router.post('/push-token', async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    let claims;
    try {
      claims = jwt.verify(token || '', relaySecret, {
        issuer: 'codeagentswarm',
        audience: 'codeagentswarm-mobile-relay',
      });
    } catch {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    if (claims.role !== 'mobile' || !claims.sub || !claims.runtimeId || !claims.deviceId) {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    const enabled = req.body?.enabled !== false;
    const pushToken = enabled ? req.body?.token : null;
    const platform = enabled ? req.body?.platform : null;
    if (enabled && (!isExpoPushToken(pushToken) || !['ios', 'android'].includes(platform))) {
      return res.status(400).json({ error: 'Invalid push token' });
    }
    try {
      const saved = await deviceStore.savePushToken({
        userId: claims.sub,
        runtimeId: claims.runtimeId,
        deviceId: claims.deviceId,
        token: pushToken,
        platform,
      });
      if (!saved) return res.status(404).json({ error: 'Mobile device not found' });
      audit(enabled ? 'push.registered' : 'push.disabled', {
        user: logRef(claims.sub),
        runtime: logRef(claims.runtimeId),
        device: logRef(claims.deviceId),
        platform,
      });
      return res.json({ ok: true, enabled });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/device', async (req, res, next) => {
    const refreshToken = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!REFRESH_TOKEN.test(refreshToken || '')) {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    try {
      await deviceStore.revokeByRefreshTokens([
        hashRefreshToken(refreshToken),
        hashRefreshToken(nextRefreshTokenFor(relaySecret, refreshToken)),
      ]);
      audit('device.forgotten');
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/telemetry', async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    let claims;
    try {
      claims = jwt.verify(token || '', relaySecret, {
        issuer: 'codeagentswarm',
        audience: 'codeagentswarm-mobile-relay',
      });
    } catch {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    if (claims.role !== 'mobile' || !claims.sub || !claims.deviceId) {
      return res.status(401).json({ error: 'Invalid mobile credential' });
    }
    const {
      event,
      trigger,
      platform,
      totalMs,
      refreshMs,
      socketMs,
      helloMs,
      attempts,
      reset,
      snapshotBytes,
      desktopMs,
      commandType,
      ackMs,
      success,
      mobileVersion,
      mobileBuild,
      desktopVersion,
      channel,
      phase,
      navigationId,
      stage,
      source,
      connectionPhase,
      hostPhase,
      cached,
    } = req.body || {};
    if (![mobileVersion, mobileBuild, desktopVersion].every(optionalShortText)
      || (channel !== undefined && !MOBILE_CHANNELS.includes(channel))) {
      return res.status(400).json({ error: 'Invalid mobile telemetry metadata' });
    }
    const identity = {
      mobile_version: mobileVersion || null,
      mobile_build: mobileBuild || null,
      desktop_version: desktopVersion || null,
      channel: channel || null,
    };
    const isReconnect = event === 'reconnect.timeline'
      && RECONNECT_TRIGGERS.includes(trigger)
      && MOBILE_PLATFORMS.includes(platform)
      && typeof reset === 'boolean'
      && [totalMs, refreshMs, socketMs, helloMs].every((value) => boundedInteger(value, MAX_RECONNECT_PHASE_MS))
      && boundedInteger(attempts, MAX_RECONNECT_ATTEMPTS)
      && boundedInteger(snapshotBytes, MAX_RECONNECT_SNAPSHOT_BYTES)
      // Optional: only clients paired with a desktop that reports its build time send it.
      && (desktopMs === undefined || boundedInteger(desktopMs, MAX_RECONNECT_PHASE_MS));
    const isCommand = event === 'command.timeline'
      && MOBILE_PLATFORMS.includes(platform)
      && MOBILE_COMMAND_TYPES.includes(commandType)
      && boundedInteger(totalMs, MAX_RECONNECT_PHASE_MS)
      && (ackMs === undefined || boundedInteger(ackMs, MAX_RECONNECT_PHASE_MS))
      && boundedInteger(attempts, MAX_RECONNECT_ATTEMPTS)
      && typeof success === 'boolean';
    const isReconnectTimeout = event === 'reconnect.timeout'
      && RECONNECT_TRIGGERS.includes(trigger)
      && MOBILE_PLATFORMS.includes(platform)
      && RECONNECT_TIMEOUT_PHASES.includes(phase)
      && boundedInteger(totalMs, MAX_RECONNECT_PHASE_MS)
      && boundedInteger(attempts, MAX_RECONNECT_ATTEMPTS);
    const isSessionOpen = event === 'session.open.timeline'
      && UUID.test(navigationId || '')
      && SESSION_OPEN_STAGES.includes(stage)
      && SESSION_OPEN_SOURCES.includes(source)
      && MOBILE_PLATFORMS.includes(platform)
      && boundedInteger(totalMs, MAX_RECONNECT_PHASE_MS)
      && RUNTIME_PHASES.includes(connectionPhase)
      && RUNTIME_PHASES.includes(hostPhase)
      && typeof cached === 'boolean';
    if (!isReconnect && !isCommand && !isReconnectTimeout && !isSessionOpen) {
      return res.status(400).json({ error: 'Invalid mobile telemetry' });
    }
    try {
      if (isSessionOpen) {
        audit('session.open.timeline', {
          user: logRef(claims.sub),
          device: logRef(claims.deviceId),
          runtime: logRef(claims.runtimeId),
          navigationId,
          stage,
          source,
          platform,
          totalMs,
          connectionPhase,
          hostPhase,
          cached,
          mobileBuild,
          desktopVersion,
          channel,
        });
        return res.json({ ok: true });
      }
      if (isReconnectTimeout) {
        audit('reconnect.timeout', {
          user: logRef(claims.sub),
          device: logRef(claims.deviceId),
          trigger,
          platform,
          phase,
          totalMs,
          attempts,
          mobileBuild,
          desktopVersion,
          channel,
        });
        return res.json({ ok: true });
      }
      if (isCommand) {
        await deviceStore.recordCommandTelemetry({
          user_id: claims.sub,
          runtime_id: claims.runtimeId || null,
          device_id: claims.deviceId,
          platform,
          command_type: commandType,
          total_ms: totalMs,
          ack_ms: ackMs === undefined ? null : ackMs,
          attempts,
          success,
          ...identity,
        });
        audit('command.timeline', {
          user: logRef(claims.sub),
          device: logRef(claims.deviceId),
          commandType,
          platform,
          totalMs,
          ackMs,
          attempts,
          success,
        });
        return res.json({ ok: true });
      }
      await deviceStore.recordReconnectTelemetry({
        user_id: claims.sub,
        runtime_id: claims.runtimeId || null,
        device_id: claims.deviceId,
        trigger,
        platform,
        total_ms: totalMs,
        refresh_ms: refreshMs,
        socket_ms: socketMs,
        hello_ms: helloMs,
        desktop_ms: desktopMs === undefined ? null : desktopMs,
        snapshot_bytes: snapshotBytes,
        reset,
        attempts,
        ...identity,
      });
      audit('reconnect.timeline', {
        user: logRef(claims.sub),
        device: logRef(claims.deviceId),
        trigger,
        platform,
        totalMs,
        refreshMs,
        socketMs,
        helloMs,
        reset,
        attempts,
      });
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.use(authMiddleware);

  router.post('/notify', async (req, res, next) => {
    const runtimeId = req.body?.runtimeId;
    if (!RUNTIME_ID.test(runtimeId || '')) return res.status(400).json({ error: 'Invalid runtime id' });
    try {
      const rows = await deviceStore.listPushTokens(req.user.id, runtimeId);
      const tokens = rows.map((row) => row.expo_push_token);
      const alert = compactAlert(req.body);
      const result = await sendPush({
        tokens,
        runtimeId,
        title: alert.title,
        body: alert.body,
        sessionId: alert.sessionId,
      });
      audit('push.sent', {
        user: logRef(req.user.id),
        runtime: logRef(runtimeId),
        sent: result.sent || 0,
      });
      return res.json({ sent: result.sent || 0 });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/desktop-ticket', (req, res) => {
    const runtimeId = req.body?.runtimeId;
    const publicKey = req.body?.publicKey;
    const client = req.body?.client;
    const version = req.body?.version;
    const channel = req.body?.channel;
    const platform = req.body?.platform;
    if (!RUNTIME_ID.test(runtimeId || '')
      || (publicKey !== undefined && !PUBLIC_KEY.test(publicKey || ''))
      || (client !== undefined && !DESKTOP_CLIENTS.includes(client))
      || (version !== undefined && !DESKTOP_VERSION.test(version))
      || (channel !== undefined && !MOBILE_CHANNELS.includes(channel))
      || (platform !== undefined && !DESKTOP_PLATFORMS.includes(platform))) {
      return res.status(400).json({ error: 'Invalid runtime identity' });
    }
    const relayGroupId = relayGroupIdFor(relaySecret, req.user.id);
    const ticket = jwt.sign(
      {
        role: 'desktop',
        runtimeId,
        relayGroupId,
        ...(publicKey ? { publicKey } : {}),
        ...(client ? { client } : {}),
        ...(version ? { version } : {}),
        ...(channel ? { channel } : {}),
        ...(platform ? { platform } : {}),
      },
      relaySecret,
      {
        subject: req.user.id,
        issuer: 'codeagentswarm',
        audience: 'codeagentswarm-relay',
        expiresIn: 120,
        jwtid: require('crypto').randomUUID(),
      }
    );
    audit('desktop.ticket_issued', {
      user: logRef(req.user.id),
      runtime: logRef(runtimeId),
      group: logRef(relayGroupId),
      client,
      version,
      channel,
      platform,
    });
    return res.json({ ticket, relayOrigin, relayGroupId, expiresIn: 120 });
  });

  router.post('/device-token', async (req, res, next) => {
    const runtimeId = req.body?.runtimeId;
    const device = req.body?.device;
    if (!RUNTIME_ID.test(runtimeId || '')
      || !DEVICE_ID.test(device?.id || '')
      || typeof device?.name !== 'string'
      || !device.name.trim()
      || device.name.length > 80
      || /[\u0000-\u001f\u007f]/.test(device.name)
      || !PUBLIC_KEY.test(device?.publicKey || '')) {
      return res.status(400).json({ error: 'Invalid mobile device' });
    }
    try {
      const refreshToken = randomRefreshToken();
      const registered = await deviceStore.upsert({
        userId: req.user.id,
        runtimeId,
        deviceId: device.id,
        deviceName: device.name.trim(),
        publicKey: device.publicKey,
        refreshTokenHash: hashRefreshToken(refreshToken),
      });
      audit('device.paired', {
        user: logRef(req.user.id),
        runtime: logRef(runtimeId),
        device: logRef(device.id),
      });
      return res.json({
        deviceToken: issueDeviceToken(registered),
        refreshToken,
        expiresIn: DEVICE_ACCESS_TTL_SECONDS,
        expiresAt: Date.now() + DEVICE_ACCESS_TTL_SECONDS * 1000,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/devices', async (req, res, next) => {
    try {
      const devices = await deviceStore.list(req.user.id);
      audit('devices.listed', { user: logRef(req.user.id), count: devices.length });
      return res.json({ devices });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/devices/:id', async (req, res, next) => {
    if (!UUID.test(req.params.id || '')) return res.status(400).json({ error: 'Invalid device id' });
    try {
      if (!await deviceStore.revoke(req.user.id, req.params.id)) {
        audit('device.revoke_rejected', { user: logRef(req.user.id), reason: 'not_found' });
        return res.status(404).json({ error: 'Mobile device not found' });
      }
      audit('device.revoked', { user: logRef(req.user.id), record: logRef(req.params.id) });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  createMobileConnectRouter,
  DEVICE_ACCESS_TTL_SECONDS,
  DEVICE_TOKEN_VERSION,
  GROQ_DAILY_ALERT_SECONDS,
  MAX_VOICE_NOTE_MS,
  hashRefreshToken,
  relayGroupIdFor,
  transcribeWithGroq,
};
