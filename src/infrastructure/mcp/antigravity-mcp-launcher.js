#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_CAPABILITY_BYTES = 16 * 1024;
const MAX_ANCESTOR_DEPTH = 2;
const SESSION_ENV_KEYS = [
  'CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED',
  'CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED',
  'CODEAGENTSWARM_SESSION_BRIDGE_PORT',
  'CODEAGENTSWARM_SESSION_BRIDGE_TOKEN',
  'CODEAGENTSWARM_TERMINAL_ID',
];

function capabilityDir(baseDir = os.homedir()) {
  return path.join(baseDir, '.codeagentswarm', 'session-communication');
}

function capabilityPath(pid, baseDir) {
  return path.join(capabilityDir(baseDir), `antigravity-${pid}.json`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function validEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  if (Object.keys(env).sort().join('\0') !== [...SESSION_ENV_KEYS].sort().join('\0')) return false;
  if (env.CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED !== '1') return false;
  if (!['0', '1'].includes(env.CODEAGENTSWARM_SESSION_COMMUNICATION_SEND_ENABLED)) return false;
  const port = Number(env.CODEAGENTSWARM_SESSION_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const token = env.CODEAGENTSWARM_SESSION_BRIDGE_TOKEN;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(env.CODEAGENTSWARM_TERMINAL_ID || '');
}

function secureOwnedStat(stat) {
  if (!stat || !stat.isFile()) return false;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
  return process.platform === 'win32' || (stat.mode & 0o077) === 0;
}

function ownedDirectory(stat) {
  return Boolean(stat && stat.isDirectory()
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid()));
}

function registerAntigravityCapability(pid, sourceEnv, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const env = Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, sourceEnv && sourceEnv[key]]));
  if (!validEnv(env)) return null;

  const baseDir = options.baseDir || os.homedir();
  const dir = capabilityDir(baseDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!ownedDirectory(fs.lstatSync(dir))) throw new Error('Unsafe Antigravity capability directory');
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);

  const registrationId = crypto.randomUUID();
  const record = {
    version: 1,
    registrationId,
    pid,
    appPid: process.pid,
    createdAt: Date.now(),
    env,
  };
  const target = capabilityPath(pid, baseDir);
  const temporary = `${target}.${registrationId}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return { pid, registrationId, baseDir };
}

function readAntigravityCapability(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const baseDir = options.baseDir || os.homedir();
  const dir = capabilityDir(baseDir);
  const target = capabilityPath(pid, baseDir);
  const alive = options.isProcessAlive || isAlive;
  try {
    const dirStat = fs.lstatSync(dir);
    if (!ownedDirectory(dirStat)) return null;
    if (process.platform !== 'win32' && (dirStat.mode & 0o077) !== 0) return null;

    const stat = fs.lstatSync(target);
    if (!secureOwnedStat(stat) || stat.size < 2 || stat.size > MAX_CAPABILITY_BYTES) return null;
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    const keys = Object.keys(record || {}).sort().join('\0');
    if (keys !== ['appPid', 'createdAt', 'env', 'pid', 'registrationId', 'version'].sort().join('\0')) return null;
    if (record.version !== 1 || record.pid !== pid) return null;
    if (!Number.isInteger(record.appPid) || record.appPid <= 0 || !alive(record.appPid) || !alive(pid)) return null;
    if (!Number.isSafeInteger(record.createdAt) || record.createdAt <= 0) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.registrationId || '')) return null;
    return validEnv(record.env) ? { ...record.env } : null;
  } catch (_) {
    return null;
  }
}

function unregisterAntigravityCapability(handle) {
  if (!handle || !Number.isInteger(handle.pid) || !handle.registrationId) return false;
  const target = capabilityPath(handle.pid, handle.baseDir || os.homedir());
  try {
    const stat = fs.lstatSync(target);
    if (!secureOwnedStat(stat) || stat.size < 2 || stat.size > MAX_CAPABILITY_BYTES) return false;
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (record.registrationId !== handle.registrationId) return false;
    fs.unlinkSync(target);
    return true;
  } catch (_) {
    return false;
  }
}

function windowsParentPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId`,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1000,
      maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parentPid = Number(String(output).trim());
    return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
  } catch (_) {
    return null;
  }
}

function capabilityCandidatePids(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const requestedDepth = Number.isInteger(options.maxAncestorDepth)
    ? options.maxAncestorDepth
    : (process.platform === 'win32' ? MAX_ANCESTOR_DEPTH : 0);
  const maxDepth = Math.max(0, Math.min(MAX_ANCESTOR_DEPTH, requestedDepth));
  const parentPidOf = options.parentPidOf
    || (process.platform === 'win32' ? windowsParentPid : null);
  const candidates = [];
  const seen = new Set();
  let candidate = pid;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (!Number.isInteger(candidate) || candidate <= 0 || seen.has(candidate)) break;
    candidates.push(candidate);
    seen.add(candidate);
    if (!parentPidOf) break;
    candidate = parentPidOf(candidate);
  }
  return candidates;
}

async function waitForAntigravityCapability(pid, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 25;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let ancestorCandidates = null;
  do {
    const direct = readAntigravityCapability(pid, options);
    if (direct) return direct;
    if (ancestorCandidates === null) {
      ancestorCandidates = capabilityCandidatePids(pid, options).slice(1);
    }
    for (const candidate of ancestorCandidates) {
      const env = readAntigravityCapability(candidate, options);
      if (env) return env;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs)));
  } while (true);
  return null;
}

module.exports = {
  capabilityDir,
  capabilityPath,
  registerAntigravityCapability,
  readAntigravityCapability,
  unregisterAntigravityCapability,
  capabilityCandidatePids,
  waitForAntigravityCapability,
};

if (require.main === module) {
  waitForAntigravityCapability(process.ppid)
    .then((env) => {
      if (env) Object.assign(process.env, env);
      const MCPStdioServer = require('./mcp-stdio-server');
      new MCPStdioServer();
    });
}
