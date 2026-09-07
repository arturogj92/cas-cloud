const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeRuntime = require('./node-runtime');
const { streamingExec } = require('./streaming-exec');

const PACKAGE = '@earendil-works/pi-coding-agent';
const MINIMUM_NODE = '22.19.0';

class PiCliInstaller {
  constructor() { this.lastError = null; this.installInProgress = false; }
  getLastError() { return this.lastError; }
  getPiPath(env = process.env) {
    const windows = process.platform === 'win32';
    const candidates = [];
    try {
      candidates.push(...String(execFileSync(windows ? 'where.exe' : '/usr/bin/which',
        windows ? ['pi'] : ['-a', 'pi'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe' }))
        .split(/\r?\n/).filter(Boolean));
    } catch (_) {}
    candidates.push(...this.getPossiblePaths(env));
    return candidates.find((file) => {
      try { return (!windows || /\.(exe|cmd|bat)$/i.test(file)) && fs.statSync(file).isFile(); } catch (_) { return false; }
    }) || null;
  }
  getPossiblePaths(env = process.env) {
    return process.platform === 'win32' ? [
      path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'pi.cmd'),
      path.join(nodeRuntime.getBinDir(), 'pi.cmd'),
    ] : ['/opt/homebrew/bin/pi', '/usr/local/bin/pi', path.join(os.homedir(), '.local', 'bin', 'pi')];
  }
  isInstalled(env) { return Boolean(this.getPiPath(env)); }
  getInstallCommand() { return `npm install -g --ignore-scripts ${PACKAGE}`; }
  async install(_mainWindow, { env = process.env, onProgress = () => {}, onStage = () => {} } = {}) {
    if (this.installInProgress) return false;
    this.installInProgress = true;
    this.lastError = null;
    try {
      onStage('checking');
      if (!await nodeRuntime.ensureInstalled(MINIMUM_NODE, env)) {
        throw new Error(`Pi requires Node.js ${MINIMUM_NODE} or newer with npm. ${nodeRuntime.getLastError() || ''}`);
      }
      const installEnv = nodeRuntime.getEnvWithNode(env);
      const npm = await nodeRuntime.resolveNpmPath(installEnv);
      if (!npm) throw new Error('npm was not found');
      const args = ['install', '-g', '--ignore-scripts', PACKAGE];
      const prefix = nodeRuntime.getNodeDir();
      if (prefix) args.push('--prefix', prefix);
      onStage('installing');
      await this.run(npm, args, installEnv, onProgress);
      nodeRuntime.applyToProcessEnv();
      onStage('verifying');
      const binary = this.getPiPath(installEnv);
      if (!binary) throw new Error('Pi was not found after installation');
      await this.run(binary, ['--version'], installEnv, onProgress);
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    } finally { this.installInProgress = false; }
  }
  run(file, args, env, onProgress) {
    return new Promise((resolve, reject) => streamingExec(file,
      { args, env, shell: false, windowsHide: true, timeout: 300000 },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout), onProgress));
  }
  async ensureInstalled(mainWindow) { return this.isInstalled() || this.install(mainWindow); }
}

module.exports = new PiCliInstaller();
module.exports.PiCliInstaller = PiCliInstaller;
module.exports.PACKAGE = PACKAGE;
