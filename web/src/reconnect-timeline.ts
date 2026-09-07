const RECONNECT_TRIGGERS = ['boot', 'pair', 'resume', 'close', 'heartbeat_timeout', 'command_timeout', 'online', 'manual', 'retry'];
const MOBILE_PLATFORMS = ['ios', 'android', 'web'];
const MOBILE_CHANNELS = ['development', 'production'];
const RUNTIME_PHASES = ['booting', 'unpaired', 'connecting', 'confirming', 'online', 'offline', 'error'];
const SESSION_OPEN_STAGES = ['requested', 'rendered'];
const SESSION_OPEN_SOURCES = ['row', 'notification', 'history', 'created', 'shortcut'];
const MAX_PHASE_MS = 600_000;
const MAX_ATTEMPTS = 100;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_VERSION_CHARS = 64;

export type ReconnectTrace = {
  trigger: string;
  platform: string;
  totalMs: number;
  refreshMs: number;
  socketMs: number;
  helloMs: number;
  attempts: number;
  reset: boolean;
  snapshotBytes: number;
  /** Desktop-reported time spent building the welcome. Absent when the desktop does not report it. */
  desktopMs?: number;
  mobileVersion?: string;
  mobileBuild?: string;
  desktopVersion?: string;
  channel?: string;
};

export type ReconnectTimelinePayload = ReconnectTrace & { event: 'reconnect.timeline' };

const bounded = (value: number, max: number) => (
  Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0
);

const shortText = (value: unknown) => (
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_VERSION_CHARS) : undefined
);

const buildMetadata = (trace: Pick<ReconnectTrace, 'mobileVersion' | 'mobileBuild' | 'desktopVersion' | 'channel'>) => ({
  ...(shortText(trace.mobileVersion) ? { mobileVersion: shortText(trace.mobileVersion) } : {}),
  ...(shortText(trace.mobileBuild) ? { mobileBuild: shortText(trace.mobileBuild) } : {}),
  ...(shortText(trace.desktopVersion) ? { desktopVersion: shortText(trace.desktopVersion) } : {}),
  ...(MOBILE_CHANNELS.includes(trace.channel || '') ? { channel: trace.channel } : {}),
});

/** Assembles the telemetry body the backend accepts, clamped to its contract ranges. */
export function reconnectTimelinePayload(trace: ReconnectTrace): ReconnectTimelinePayload {
  return {
    event: 'reconnect.timeline',
    trigger: RECONNECT_TRIGGERS.includes(trace.trigger) ? trace.trigger : 'manual',
    platform: MOBILE_PLATFORMS.includes(trace.platform) ? trace.platform : 'web',
    totalMs: bounded(trace.totalMs, MAX_PHASE_MS),
    refreshMs: bounded(trace.refreshMs, MAX_PHASE_MS),
    socketMs: bounded(trace.socketMs, MAX_PHASE_MS),
    helloMs: bounded(trace.helloMs, MAX_PHASE_MS),
    attempts: bounded(trace.attempts, MAX_ATTEMPTS),
    reset: trace.reset === true,
    snapshotBytes: bounded(trace.snapshotBytes, MAX_SNAPSHOT_BYTES),
    // Omitted rather than sent as a fake 0 when the desktop did not report it.
    ...(Number.isFinite(trace.desktopMs) ? { desktopMs: bounded(trace.desktopMs as number, MAX_PHASE_MS) } : {}),
    ...buildMetadata(trace),
  };
}

export type CommandTrace = Pick<ReconnectTrace, 'mobileVersion' | 'mobileBuild' | 'desktopVersion' | 'channel'> & {
  platform: string;
  commandType: string;
  totalMs: number;
  ackMs: number | null;
  attempts: number;
  success: boolean;
};

export function commandTimelinePayload(trace: CommandTrace) {
  return {
    event: 'command.timeline' as const,
    platform: MOBILE_PLATFORMS.includes(trace.platform) ? trace.platform : 'web',
    commandType: shortText(trace.commandType) || 'unknown',
    totalMs: bounded(trace.totalMs, MAX_PHASE_MS),
    ...(Number.isFinite(trace.ackMs) ? { ackMs: bounded(trace.ackMs as number, MAX_PHASE_MS) } : {}),
    attempts: bounded(trace.attempts, MAX_ATTEMPTS),
    success: trace.success === true,
    ...buildMetadata(trace),
  };
}

export type SessionOpenTrace = Pick<ReconnectTrace, 'mobileVersion' | 'mobileBuild' | 'desktopVersion' | 'channel'> & {
  navigationId: string;
  stage: string;
  source: string;
  platform: string;
  totalMs: number;
  connectionPhase: string;
  hostPhase: string;
  cached: boolean;
};

export function sessionOpenTimelinePayload(trace: SessionOpenTrace) {
  return {
    event: 'session.open.timeline' as const,
    navigationId: trace.navigationId,
    stage: SESSION_OPEN_STAGES.includes(trace.stage) ? trace.stage : 'requested',
    source: SESSION_OPEN_SOURCES.includes(trace.source) ? trace.source : 'row',
    platform: MOBILE_PLATFORMS.includes(trace.platform) ? trace.platform : 'web',
    totalMs: bounded(trace.totalMs, MAX_PHASE_MS),
    connectionPhase: RUNTIME_PHASES.includes(trace.connectionPhase) ? trace.connectionPhase : 'error',
    hostPhase: RUNTIME_PHASES.includes(trace.hostPhase) ? trace.hostPhase : 'error',
    cached: trace.cached === true,
    ...buildMetadata(trace),
  };
}
