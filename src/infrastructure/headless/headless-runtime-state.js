const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SUPPORTED_AGENTS } = require('../agent-drivers/driver-chat-manager');

const FORMAT = 1;
const MAX_SESSIONS = 50;

function text(value, max) {
  return typeof value === 'string' && value.length ? value.slice(0, max) : null;
}

function runtimeStatePath({ env = process.env, dataPath } = {}) {
  const overridden = text(env.CAS_CLI_STATE, 4096);
  if (overridden && !path.isAbsolute(overridden)) throw new Error('CAS_CLI_STATE must be absolute');
  if (overridden) return overridden;
  if (!path.isAbsolute(dataPath || '')) throw new Error('CAS CLI runtime state directory must be absolute');
  return path.join(dataPath, 'cas-cli-runtime-state.json');
}

function compactProject(project) {
  if (!project || typeof project !== 'object') return null;
  const projectId = text(project.projectId, 128);
  const projectPath = text(project.path, 4096);
  if (!projectId || !projectPath || !path.isAbsolute(projectPath)) return null;
  return {
    projectId,
    name: text(project.name, 120),
    path: projectPath,
  };
}

function compactActivityHistory(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 50).flatMap((row) => {
    const activity = text(row?.activity, 1000);
    if (!activity) return [];
    return [{
      activity,
      createdAt: text(row.createdAt, 64),
      taskId: text(row.taskId, 128),
    }];
  });
}

function compactSession(session) {
  const agent = text(session?.agent, 32);
  const threadId = text(session?.threadId, 500);
  const cwd = text(session?.cwd, 4096);
  if (!SUPPORTED_AGENTS.includes(agent) || !threadId || !cwd || !path.isAbsolute(cwd)) return null;
  if (session.supportsResume === false || session.state === 'stopped') return null;
  return {
    agent,
    threadId,
    terminalUuid: text(session.terminalUuid, 500),
    terminalOrder: Number.isSafeInteger(session.terminalOrder) && session.terminalOrder > 0
      ? session.terminalOrder
      : null,
    cwd,
    accountId: text(session.accountId, 128) || 'current',
    model: text(session.model, 300),
    effort: text(session.effort, 100),
    serviceTier: text(session.serviceTier, 100),
    permissionMode: text(session.permissionMode, 100),
    interactionMode: text(session.interactionMode, 100),
    supportsResume: true,
    title: text(session.title, 300),
    goal: text(session.goal, 1000),
    activity: text(session.activity, 1000),
    activityHistory: compactActivityHistory(session.activityHistory),
    workStatus: text(session.workStatus, 100),
    lastActivityAt: Number.isSafeInteger(session.lastActivityAt) ? session.lastActivityAt : null,
    needsAttention: session.needsAttention === true,
    attentionVersion: Number.isSafeInteger(session.attentionVersion) ? session.attentionVersion : 0,
    minimized: session.minimized === true,
    project: compactProject(session.project),
  };
}

function normalizeState(raw) {
  if (!raw || raw.format !== FORMAT || typeof raw.runtimeId !== 'string') {
    throw new Error('CAS CLI runtime state is invalid');
  }
  if (!['starting', 'ready', 'degraded', 'stopping'].includes(raw.status)) {
    throw new Error('CAS CLI runtime state is invalid');
  }
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .slice(0, MAX_SESSIONS)
    .map(compactSession)
    .filter(Boolean);
  return {
    format: FORMAT,
    runtimeId: raw.runtimeId.slice(0, 128),
    cliVersion: text(raw.cliVersion, 64) || 'unknown',
    status: raw.status,
    pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
    updatedAt: text(raw.updatedAt, 64) || new Date(0).toISOString(),
    busySessions: Number.isSafeInteger(raw.busySessions) && raw.busySessions >= 0
      ? raw.busySessions
      : 0,
    sessions,
  };
}

function readRuntimeState(filePath) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('CAS CLI runtime state is invalid');
  }
}

function runtimeUpdateLockPath(filePath) {
  return `${filePath}.update-lock`;
}

function runtimeUpdateLocked(lockPath) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error('invalid lock');
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ESRCH') {
      try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
      return false;
    }
    return true;
  }
}

class HeadlessRuntimeState {
  constructor({ filePath, runtimeId, cliVersion }) {
    if (!path.isAbsolute(filePath || '')) throw new Error('CAS CLI runtime state path must be absolute');
    this.filePath = filePath;
    this.runtimeId = runtimeId;
    this.cliVersion = cliVersion;
  }

  loadSessions() {
    const state = readRuntimeState(this.filePath);
    return state?.runtimeId === this.runtimeId ? state.sessions : [];
  }

  write(status, sessions, busySessionIds = new Set()) {
    const source = Array.from(sessions || []);
    const compact = source.map(compactSession).filter(Boolean).slice(0, MAX_SESSIONS);
    const busySessions = source.filter((session) => (
      session?.currentTurn?.state === 'running' || busySessionIds.has?.(session?.sessionId)
    )).length;
    const value = normalizeState({
      format: FORMAT,
      runtimeId: this.runtimeId,
      cliVersion: this.cliVersion,
      status,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      busySessions,
      sessions: compact,
    });
    const directory = path.dirname(this.filePath);
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      throw new Error('CAS CLI runtime state could not be written');
    }
    return value;
  }
}

module.exports = {
  HeadlessRuntimeState,
  readRuntimeState,
  runtimeStatePath,
  runtimeUpdateLocked,
  runtimeUpdateLockPath,
};
