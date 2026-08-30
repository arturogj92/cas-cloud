const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  readRuntimeState,
  runtimeStatePath,
  runtimeUpdateLocked,
  runtimeUpdateLockPath,
} = require('./headless-runtime-state');
const { appDataPath } = require('./headless-runtime');

function runCommand(command, args, { env = process.env, timeoutMs } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed${result.stderr?.trim() ? `: ${result.stderr.trim().slice(-500)}` : ''}`);
  }
  return result;
}

function acquireRuntimeUpdateLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporary = `${lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    try {
      fs.linkSync(temporary, lockPath);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (runtimeUpdateLocked(lockPath)) return null;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return null;
}

function subprocessEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key)) delete clean[key];
  }
  return clean;
}

function installRoot(env = process.env) {
  const root = env.CAS_CLI_INSTALL_ROOT
    || path.join(os.homedir(), '.local', 'share', 'codeagentswarm-cloud');
  if (!path.isAbsolute(root)) throw new Error('CAS_CLI_INSTALL_ROOT must be absolute');
  return root;
}

function installedVersion(prefix) {
  const installed = [
    ['@codeagentswarm/cas-cloud', path.join(prefix, 'node_modules', '@codeagentswarm', 'cas-cloud', 'package.json')],
    ['codeagentswarm', path.join(prefix, 'node_modules', 'codeagentswarm', 'package.json')],
  ].find(([, manifestPath]) => fs.existsSync(manifestPath));
  try {
    if (!installed) throw new Error('missing manifest');
    const [packageName, manifestPath] = installed;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== packageName
      || typeof manifest.version !== 'string'
      || manifest.version.length > 64
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(manifest.version || '')) {
      throw new Error('invalid manifest');
    }
    return manifest.version;
  } catch (_) {
    throw new Error('The staged CAS CLI package is invalid');
  }
}

function switchCurrent(currentPath, target) {
  const temporary = `${currentPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.symlinkSync(target, temporary);
  try {
    fs.renameSync(temporary, currentPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function systemctlArgs(env, action) {
  const scope = env.CAS_CLI_SYSTEMD_SCOPE || 'user';
  if (!['user', 'system'].includes(scope)) throw new Error('CAS_CLI_SYSTEMD_SCOPE must be user or system');
  const service = env.CAS_CLI_SERVICE || 'cas-cli.service';
  if (!/^[A-Za-z0-9_.@:-]{1,128}$/.test(service)) throw new Error('CAS_CLI_SERVICE is invalid');
  return [...(scope === 'user' ? ['--user'] : []), action, service];
}

async function defaultWaitForHealthy({ env, commandEnv, version, run, timeoutMs }) {
  const statePath = runtimeStatePath({
    env,
    dataPath: appDataPath({ env }),
  });
  const systemctl = env.CAS_CLI_SYSTEMCTL || '/usr/bin/systemctl';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let state = null;
    try { state = readRuntimeState(statePath); } catch (_) {}
    if (state?.status === 'degraded' && state.cliVersion === version) {
      throw new Error(`CAS Cloud ${version} could not restore every session`);
    }
    if (state?.status === 'ready' && state.cliVersion === version) {
      const args = systemctlArgs(env, 'is-active');
      run(systemctl, [...args.slice(0, -1), '--quiet', args[args.length - 1]], {
        env: commandEnv,
        timeoutMs: 30_000,
      });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`CAS Cloud ${version} did not become healthy`);
}

async function updateInstallation({
  env = process.env,
  run = runCommand,
  waitForHealthy = defaultWaitForHealthy,
  output = console.log,
} = {}) {
  const root = installRoot(env);
  const statePath = runtimeStatePath({
    env,
    dataPath: appDataPath({ env }),
  });
  const state = readRuntimeState(statePath);
  if (!state || state.status !== 'ready') return { updated: false, reason: 'runtime-unavailable' };
  if (state.busySessions > 0) {
    output(`CAS Cloud update deferred: ${state.busySessions} session${state.busySessions === 1 ? '' : 's'} still running.`);
    return { updated: false, reason: 'busy' };
  }

  const currentPath = path.join(root, 'current');
  if (!fs.existsSync(currentPath) || !fs.lstatSync(currentPath).isSymbolicLink()) {
    throw new Error(`CAS_CLI_INSTALL_ROOT has no managed current symlink: ${currentPath}`);
  }
  const previousTarget = fs.readlinkSync(currentPath);
  const previousRoot = fs.realpathSync(currentPath);
  const previousVersion = installedVersion(previousRoot);
  const releasesRoot = path.join(root, 'releases');
  const stage = path.join(releasesRoot, `.staging-${process.pid}-${crypto.randomUUID()}`);
  const npm = env.CAS_CLI_NPM || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const spec = env.CAS_CLI_UPDATE_SPEC || '@codeagentswarm/cas-cloud@latest';
  const commandEnv = subprocessEnv(env);
  const installSeconds = Number(env.CAS_CLI_UPDATE_INSTALL_TIMEOUT_SECONDS || 600);
  const installTimeoutMs = Number.isFinite(installSeconds) && installSeconds >= 60 && installSeconds <= 1200
    ? installSeconds * 1000
    : 600_000;
  const updateLockPath = runtimeUpdateLockPath(statePath);
  let releaseUpdateLock = null;
  if (typeof spec !== 'string' || !spec.trim() || spec.length > 4096) throw new Error('CAS_CLI_UPDATE_SPEC is invalid');
  fs.mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });

  try {
    run(npm, [
      'install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', spec,
    ], { env: commandEnv, timeoutMs: installTimeoutMs });
    const version = installedVersion(stage);
    const stagedBin = path.join(stage, 'node_modules', '.bin', 'cas-cli');
    const reportedVersion = run(stagedBin, ['--version'], { env: commandEnv, timeoutMs: 30_000 }).stdout.trim();
    if (reportedVersion !== version) throw new Error('The staged CAS CLI binary reports the wrong version');
    if (version === previousVersion) {
      fs.rmSync(stage, { recursive: true, force: true });
      output(`CAS Cloud ${version} is already current.`);
      return { updated: false, reason: 'current', version };
    }
    releaseUpdateLock = acquireRuntimeUpdateLock(updateLockPath);
    if (!releaseUpdateLock) return { updated: false, reason: 'update-running' };
    const latestState = readRuntimeState(statePath);
    if (!latestState || latestState.status !== 'ready' || latestState.busySessions > 0) {
      output('CAS Cloud update deferred: a session started while the update was staged.');
      return { updated: false, reason: 'busy' };
    }

    const releaseRoot = path.join(releasesRoot, version);
    if (fs.existsSync(releaseRoot)) {
      fs.rmSync(stage, { recursive: true, force: true });
      if (installedVersion(releaseRoot) !== version) throw new Error('The existing CAS CLI release is invalid');
    } else {
      fs.renameSync(stage, releaseRoot);
    }
    switchCurrent(currentPath, releaseRoot);
    const systemctl = env.CAS_CLI_SYSTEMCTL || '/usr/bin/systemctl';
    try {
      run(systemctl, systemctlArgs(env, 'restart'), { env: commandEnv, timeoutMs: 120_000 });
      const seconds = Number(env.CAS_CLI_UPDATE_HEALTH_TIMEOUT_SECONDS || 1500);
      const timeoutMs = Number.isFinite(seconds) && seconds >= 1 && seconds <= 1800 ? seconds * 1000 : 1_500_000;
      await waitForHealthy({ env, commandEnv, version, run, timeoutMs });
    } catch (error) {
      switchCurrent(currentPath, previousTarget);
      try {
        run(systemctl, systemctlArgs(env, 'restart'), { env: commandEnv, timeoutMs: 120_000 });
      } catch (rollbackError) {
        throw new Error(`CAS Cloud ${version} failed; the old release was restored but could not restart: ${rollbackError.message}`);
      }
      throw new Error(`CAS Cloud ${version} failed health checks and was rolled back: ${error.message}`);
    }
    output(`CAS Cloud updated from ${previousVersion} to ${version}.`);
    return { updated: true, previousVersion, version };
  } finally {
    releaseUpdateLock?.();
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = {
  defaultWaitForHealthy,
  installRoot,
  updateInstallation,
};
