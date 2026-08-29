/** Detects and installs Cursor Agent using Cursor's official installer. */
const { dialog } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamingExec } = require('./streaming-exec');
const vcredistRuntime = require('./vcredist-runtime');

const INSTALL_SH_URL = 'https://cursor.com/install';
const INSTALL_PS1_URL = 'https://cursor.com/install?win32=true';

class CursorCliInstaller {
  constructor({ fetchImpl = globalThis.fetch, streamingExecImpl = streamingExec } = {}) {
    this.installInProgress = false;
    this.lastError = null;
    this.fetchImpl = fetchImpl;
    this.streamingExecImpl = streamingExecImpl;
  }

  getLastError() {
    return this.lastError;
  }

  getNativeInstallPath() {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA
        || path.win32.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local');
      return path.win32.join(localAppData, 'cursor-agent', 'cursor-agent.cmd');
    }
    return path.join(os.homedir(), '.local', 'bin', 'cursor-agent');
  }

  getUnixCommonPaths() {
    return [...new Set([
      this.getNativeInstallPath(),
      '/usr/local/bin/cursor-agent',
      '/usr/bin/cursor-agent',
      '/opt/homebrew/bin/cursor-agent',
    ])];
  }

  getPossiblePaths() {
    if (process.platform !== 'win32') return [];
    const root = path.win32.dirname(this.getNativeInstallPath());
    return [
      this.getNativeInstallPath(),
      path.win32.join(root, 'cursor-agent.exe'),
    ];
  }

  getCursorAgentPath() {
    if (this._resolvedComputed) return this._resolved;
    this._resolvedComputed = true;
    const known = process.platform === 'win32' ? this.getPossiblePaths() : this.getUnixCommonPaths();
    const onPath = [];
    try {
      const command = process.platform === 'win32' ? 'where.exe cursor-agent' : 'which -a cursor-agent';
      onPath.push(...execSync(command, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 })
        .split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    } catch (_) {}
    this._resolved = [...new Set([...known, ...onPath])].find((candidate) => this._isUsableBinary(candidate)) || null;
    return this._resolved;
  }

  invalidateCache() {
    this._resolvedComputed = false;
    this._resolved = null;
  }

  _isUsableBinary(candidate) {
    try {
      if (process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(candidate)) return false;
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size === 0) return false;
      if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  isInstalled() {
    return this.getCursorAgentPath() !== null;
  }

  getInstallCommand() {
    return process.platform === 'win32'
      ? `irm '${INSTALL_PS1_URL}' | iex`
      : `curl ${INSTALL_SH_URL} -fsS | bash`;
  }

  _runCommand(command, options, onProgress) {
    return new Promise((resolve) => {
      this.streamingExecImpl(command, options, (error, stdout, stderr) => {
        resolve({ error, output: String(stderr || stdout || '').trim() });
      }, onProgress);
    });
  }

  async _runWindowsInstaller(onProgress) {
    onProgress('Downloading the official Cursor Agent installer…');
    const response = await this.fetchImpl(INSTALL_PS1_URL, { headers: { accept: 'text/plain' } });
    if (!response.ok) throw new Error(`Cursor installer download returned HTTP ${response.status}`);
    const script = await response.text();
    if (!script.trim()) throw new Error('Cursor installer download was empty');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-agent-install-'));
    const scriptPath = path.join(tempDir, 'install.ps1');
    fs.writeFileSync(scriptPath, script, 'utf8');
    try {
      return await this._runCommand('powershell.exe', {
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        timeout: 300000,
        shell: false,
        windowsHide: true,
      }, onProgress);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async install(_mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) return false;

    this.installInProgress = true;
    this.lastError = null;
    onStage('checking');
    try {
      onStage('installing');
      // Defender blocks the vendor's download-pipe-execute one-liner in some
      // environments. Download over HTTPS in Node, then run that same official
      // script as a local PowerShell file.
      if (process.platform === 'win32') {
        onProgress('Checking the Microsoft Visual C++ runtime required by Cursor Agent…');
        if (!await vcredistRuntime.ensureInstalled()) {
          this.lastError = `Microsoft Visual C++ Redistributable could not be installed: ${vcredistRuntime.getLastError() || 'unknown error'}`;
          return false;
        }
      }
      const result = process.platform === 'win32'
        ? await this._runWindowsInstaller(onProgress)
        : await this._runCommand(this.getInstallCommand(), { timeout: 300000, shell: '/bin/bash' }, onProgress);
      this.invalidateCache();
      if (this.isInstalled()) {
        onStage('verifying');
        return true;
      }
      this.lastError = result.output || result.error?.message || 'cursor-agent was not found after installation';
      return false;
    } catch (error) {
      this.lastError = error.message;
      return false;
    } finally {
      this.installInProgress = false;
    }
  }

  async ensureInstalled(mainWindow) {
    if (this.isInstalled()) return true;
    const detail = `Install the official Cursor Agent now with:\n${this.getInstallCommand()}`;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Install', 'Cancel'], defaultId: 0, cancelId: 1,
      title: 'Install Cursor Agent', message: 'Cursor Agent is not installed', detail,
    });
    return response === 0 ? this.install(mainWindow) : false;
  }
}

const installer = new CursorCliInstaller();

module.exports = {
  CursorCliInstaller,
  installer,
  isInstalled: () => installer.isInstalled(),
  getCursorAgentPath: () => installer.getCursorAgentPath(),
  getNativeInstallPath: () => installer.getNativeInstallPath(),
  getPossiblePaths: () => installer.getPossiblePaths(),
  getInstallCommand: () => installer.getInstallCommand(),
  invalidateCache: () => installer.invalidateCache(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
};
