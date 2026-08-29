/**
 * Grok Build CLI Installer Service
 * Detects and installs xAI's Grok Build CLI (https://x.ai/cli).
 *
 * Installation methods:
 * - curl -fsSL https://x.ai/cli/install.sh | bash     (official, no Node needed)
 * - irm https://x.ai/cli/install.ps1 | iex            (Windows)
 *
 * Detection is a pure EXISTENCE + EXECUTABLE-BIT probe, deliberately without a
 * `--version` subprocess:
 *  - the installer drops a single ~100 MB native binary (a symlink at
 *    ~/.grok/bin/grok -> ../downloads/grok-<platform>) and PATHs it via the shell
 *    rc, which a GUI-launched Electron app never inherits — so the native path is
 *    probed FIRST;
 *  - unlike Kimi there is no competing product claiming the `grok` command, so no
 *    content sniff is needed to disambiguate lineage;
 *  - this sits on the per-terminal spawn path, where a multi-second subprocess is a
 *    known launch tarpit.
 */

const { dialog } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { streamingExec } = require('./streaming-exec');

class GrokCliInstaller {
  constructor() {
    this.installInProgress = false;
    this.lastError = null;
  }

  getLastError() {
    return this.lastError;
  }

  /**
   * Default install location of the official script: ${GROK_HOME}/bin/grok,
   * where GROK_HOME defaults to ~/.grok.
   * @returns {string}
   */
  getNativeInstallPath() {
    const base = (process.env.GROK_HOME || '').trim() || path.join(os.homedir(), '.grok');
    return process.platform === 'win32'
      ? path.join(base, 'bin', 'grok.exe')
      : path.join(base, 'bin', 'grok');
  }

  /**
   * Check if the Grok Build CLI is installed.
   * @returns {boolean}
   */
  isInstalled() {
    return this.getGrokPath() !== null;
  }

  /**
   * Common install locations on Unix. The native script path is first: it is both the
   * documented default and the one an Electron app is most likely to miss via PATH.
   * @returns {string[]}
   */
  getUnixCommonPaths() {
    const home = os.homedir();
    return [...new Set([
      this.getNativeInstallPath(),
      '/usr/local/bin/grok',
      '/usr/bin/grok',
      '/opt/homebrew/bin/grok',
      `${home}/.local/bin/grok`,
      `${home}/.grok/bin/grok`,
    ])];
  }

  /**
   * Possible install paths on Windows.
   * @returns {string[]}
   */
  getPossiblePaths() {
    if (process.platform !== 'win32') return [];

    const userProfile = process.env.USERPROFILE || os.homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');

    return [...new Set([
      this.getNativeInstallPath(),
      path.join(userProfile, '.grok', 'bin', 'grok.exe'),
      path.join(localAppData, 'Grok', 'grok.exe'),
      path.join(localAppData, 'Programs', 'Grok', 'grok.exe'),
    ])];
  }

  /**
   * Resolve the path of a usable `grok`, or null. Cached: this sits on the
   * per-terminal spawn path.
   * @returns {string|null}
   */
  getGrokPath() {
    if (this._resolvedComputed) return this._resolved;
    this._resolvedComputed = true;
    this._resolved = this._computeGrokPath();
    return this._resolved;
  }

  /**
   * Drop the cached resolution (the installer may create the binary after we probed).
   */
  invalidateCache() {
    this._resolvedComputed = false;
    this._resolved = null;
  }

  _computeGrokPath() {
    for (const candidate of this._allCandidates()) {
      if (this._isUsableBinary(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** Every `grok` we can find, known paths first, then PATH order. */
  _allCandidates() {
    const known = (process.platform === 'win32' ? this.getPossiblePaths() : this.getUnixCommonPaths())
      .filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

    const onPath = [];
    try {
      const cmd = process.platform === 'win32' ? 'where.exe grok' : 'which -a grok';
      const out = execSync(cmd, { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
      onPath.push(...out.split('\n').map(s => s.trim()).filter(Boolean));
    } catch (e) { /* nothing on PATH */ }

    return [...new Set([...known, ...onPath])];
  }

  /**
   * True when the candidate is a real, non-empty, executable file (or a symlink to
   * one — the official installer links bin/grok at downloads/grok-<platform>).
   * No subprocess: existence + the exec bit is all we can cheaply know, and it is
   * enough because nothing else installs a `grok` command.
   */
  _isUsableBinary(binPath) {
    try {
      const stat = fs.statSync(binPath); // follows symlinks
      if (!stat.isFile() || stat.size === 0) return false;
    } catch (e) {
      return false;
    }
    if (process.platform === 'win32') return true;
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * The command shown to the user / run to install.
   * @returns {string}
   */
  getInstallCommand() {
    if (process.platform === 'win32') {
      return 'powershell -NoProfile -Command "irm https://x.ai/cli/install.ps1 | iex"';
    }
    return 'curl -fsSL https://x.ai/cli/install.sh | bash';
  }

  /** Keep the tail of a captured stream so a huge log doesn't blow up the modal. */
  _tail(text, max = 2000) {
    const s = String(text || '').trim();
    return s.length > max ? `…${s.slice(-max)}` : s;
  }

  /**
   * Run one install command through streamingExec, streaming lines to onProgress and
   * capturing the REAL failure text (installers commonly print fatal errors to
   * STDOUT, so fall back to stdout when stderr is empty).
   * @returns {Promise<{ok: boolean, output: string}>}
   */
  _runCommand(command, onProgress, runOptions = {}) {
    return new Promise((resolve) => {
      streamingExec(
        command,
        {
          timeout: 300000,
          shell: runOptions.shell === undefined
            ? (process.platform === 'win32' ? undefined : '/bin/bash')
            : runOptions.shell,
          args: runOptions.args,
        },
        (error, stdout, stderr) => {
          if (error) {
            const real = this._tail(stderr) || this._tail(stdout) || error.message;
            resolve({ ok: false, output: real });
            return;
          }
          console.log('[GrokInstaller] Install output:', String(stdout).slice(-500));
          resolve({ ok: true, output: '' });
        },
        onProgress
      );
    });
  }

  /**
   * Install the Grok Build CLI with the official script. Fails GRACEFULLY (returns
   * false + lastError) on platforms xAI ships no binary for, instead of throwing.
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>}
   */
  async install(mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) {
      console.log('[GrokInstaller] Install already in progress');
      return false;
    }
    this.installInProgress = true;
    this.lastError = null;
    onStage('checking');

    try {
      onStage('installing');
      let result;
      if (process.platform === 'win32') {
        // Defender flags the `irm … | iex` one-liner as malware and blocks the
        // spawn — see windows-install-script.js. Download + run -File instead.
        let winScriptPath = null;
        try {
          const { planWindowsPs1Install } = require('./windows-install-script');
          const plan = await planWindowsPs1Install('https://x.ai/cli/install.ps1', 'grok-install.ps1');
          winScriptPath = plan.scriptPath;
          console.log(`[GrokInstaller] Installing with: ${plan.command} ${plan.args.join(' ')}`);
          result = await this._runCommand(plan.command, onProgress, { args: plan.args, shell: false });
        } catch (downloadErr) {
          result = { ok: false, output: `Download of the Grok installer script failed: ${downloadErr.message}` };
        } finally {
          if (winScriptPath) { try { fs.unlinkSync(winScriptPath); } catch (e) { /* ignore */ } }
        }
      } else {
        const command = this.getInstallCommand();
        console.log(`[GrokInstaller] Installing with: ${command}`);
        result = await this._runCommand(command, onProgress);
      }
      // The installer creates ~/.grok/bin/grok, so any earlier resolution is stale.
      this.invalidateCache();

      if (this.isInstalled()) {
        onStage('verifying');
        return true;
      }

      this.lastError = result.output || 'Grok Build CLI was not found after installation';
      return false;
    } catch (e) {
      this.lastError = e.message;
      console.error('[GrokInstaller] Install threw:', e);
      return false;
    } finally {
      this.installInProgress = false;
    }
  }

  /**
   * Ensure the CLI is installed, prompting the user if it is not.
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>}
   */
  async ensureInstalled(mainWindow) {
    if (this.isInstalled()) return true;

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install Grok Build CLI',
      message: 'Grok Build CLI is not installed',
      detail: `Grok Build CLI is required to run this agent.\n\nInstall it now with:\n${this.getInstallCommand()}`,
    });

    if (response !== 0) return false;
    return this.install(mainWindow);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
const installer = new GrokCliInstaller();

module.exports = {
  GrokCliInstaller,
  isInstalled: () => installer.isInstalled(),
  getGrokPath: () => installer.getGrokPath(),
  getNativeInstallPath: () => installer.getNativeInstallPath(),
  getInstallCommand: () => installer.getInstallCommand(),
  invalidateCache: () => installer.invalidateCache(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
  getLastError: () => installer.getLastError(),
};
