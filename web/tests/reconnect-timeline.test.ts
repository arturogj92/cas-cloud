import assert from 'node:assert/strict';
import test from 'node:test';

import { commandTimelinePayload, reconnectTimelinePayload, sessionOpenTimelinePayload } from '../src/reconnect-timeline';

const trace = (overrides: Partial<Parameters<typeof reconnectTimelinePayload>[0]> = {}) => ({
  trigger: 'resume',
  platform: 'ios',
  totalMs: 1840,
  refreshMs: 320,
  socketMs: 610,
  helloMs: 910,
  attempts: 2,
  reset: true,
  snapshotBytes: 48213,
  ...overrides,
});

test('a measured reconnection reports every phase the backend accepts', () => {
  assert.deepEqual(reconnectTimelinePayload(trace()), {
    event: 'reconnect.timeline',
    trigger: 'resume',
    platform: 'ios',
    totalMs: 1840,
    refreshMs: 320,
    socketMs: 610,
    helloMs: 910,
    attempts: 2,
    reset: true,
    snapshotBytes: 48213,
  });
});

test('a clock jump or a huge snapshot stays inside the contract ranges', () => {
  const payload = reconnectTimelinePayload(trace({
    totalMs: 9_000_000,
    refreshMs: -50,
    socketMs: Number.NaN,
    helloMs: 12.6,
    attempts: 500,
    snapshotBytes: 99 * 1024 * 1024,
  }));

  assert.equal(payload.totalMs, 600_000);
  assert.equal(payload.refreshMs, 0);
  assert.equal(payload.socketMs, 0);
  assert.equal(payload.helloMs, 13);
  assert.equal(payload.attempts, 100);
  assert.equal(payload.snapshotBytes, 10 * 1024 * 1024);
});

test('a desktop that reports its build time adds a clamped desktopMs', () => {
  assert.equal(reconnectTimelinePayload(trace({ desktopMs: 742.4 })).desktopMs, 742);
  assert.equal(reconnectTimelinePayload(trace({ desktopMs: 9_000_000 })).desktopMs, 600_000);
});

test('a desktop that does not report its build time omits desktopMs instead of sending zero', () => {
  const payload = reconnectTimelinePayload(trace());

  assert.equal('desktopMs' in payload, false);
  assert.equal(reconnectTimelinePayload(trace({ desktopMs: Number.NaN })).desktopMs, undefined);
});

test('an unknown trigger or platform falls back instead of being rejected as invalid', () => {
  const payload = reconnectTimelinePayload(trace({ trigger: 'teleport', platform: 'macos', reset: false }));

  assert.equal(payload.trigger, 'manual');
  assert.equal(payload.platform, 'web');
  assert.equal(payload.reset, false);
});

test('attributes reconnects to the mobile build, desktop build and channel', () => {
  const payload = reconnectTimelinePayload(trace({
    trigger: 'pair',
    mobileVersion: '1.0',
    mobileBuild: '42',
    desktopVersion: '2.2.0',
    channel: 'production',
  }));

  assert.deepEqual({
    mobileVersion: payload.mobileVersion,
    mobileBuild: payload.mobileBuild,
    desktopVersion: payload.desktopVersion,
    channel: payload.channel,
  }, {
    mobileVersion: '1.0',
    mobileBuild: '42',
    desktopVersion: '2.2.0',
    channel: 'production',
  });
});

test('measures command acknowledgement separately from command completion', () => {
  assert.deepEqual(commandTimelinePayload({
    platform: 'ios',
    commandType: 'turn.send',
    totalMs: 640,
    ackMs: 180,
    attempts: 2,
    success: true,
    mobileVersion: '1.0',
    mobileBuild: '42',
    desktopVersion: '2.2.0',
    channel: 'production',
  }), {
    event: 'command.timeline',
    platform: 'ios',
    commandType: 'turn.send',
    totalMs: 640,
    ackMs: 180,
    attempts: 2,
    success: true,
    mobileVersion: '1.0',
    mobileBuild: '42',
    desktopVersion: '2.2.0',
    channel: 'production',
  });
});

test('measures session navigation without session content or identifiers', () => {
  assert.deepEqual(sessionOpenTimelinePayload({
    navigationId: '7c4ac4d8-213e-4a91-a5d1-8c49b6efeabe',
    stage: 'rendered',
    source: 'row',
    platform: 'ios',
    totalMs: 184,
    connectionPhase: 'online',
    hostPhase: 'online',
    cached: true,
    mobileVersion: '1.0.1',
    mobileBuild: '78',
    desktopVersion: '2.3.0',
    channel: 'production',
  }), {
    event: 'session.open.timeline',
    navigationId: '7c4ac4d8-213e-4a91-a5d1-8c49b6efeabe',
    stage: 'rendered',
    source: 'row',
    platform: 'ios',
    totalMs: 184,
    connectionPhase: 'online',
    hostPhase: 'online',
    cached: true,
    mobileVersion: '1.0.1',
    mobileBuild: '78',
    desktopVersion: '2.3.0',
    channel: 'production',
  });
});
