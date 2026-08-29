/**
 * opencode CLI Installer Service
 * Detects and installs the SST opencode CLI (https://opencode.ai).
 * Uses npm global install of the official `opencode-ai` package.
 *
 * Installation methods:
 * - npm install -g opencode-ai
 * - curl -fsSL https://opencode.ai/install | bash   (manual fallback)
 *
 * Mirrors codex-cli-installer.js. opencode ships as a Node package (no native
 * VC++ runtime needed), so the Windows VC-redist bootstrap used by Codex is omitted.
 */

const { dialog } = require('electron');
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodeRuntime = require('./node-runtime');
const { streamingExec } = require('./streaming-exec');

class OpencodeCliInstaller {
  constructor() {
    this.installInProgress = false;
    this.lastError = null;
    // Official SST opencode npm package
    this.packageName = 'opencode-ai';
  }

  getLastError() {
    return this.lastError;
  }

  /**
   * Check if opencode CLI is installed
   * @returns {boolean}
   */
  isInstalled(env = process.env) {
    if (process.platform !== 'win32') {
      // On macOS/Linux, first check common npm global paths directly
      // (Electron apps may not have full PATH from shell config)
      const commonPaths = this.getUnixCommonPaths();
      for (const p of commonPaths) {
        try {
          if (fs.existsSync(p)) {
            console.log(`[OpencodeInstaller] Found opencode at: ${p}`);
            return true;
          }
        } catch (e) {
          // Ignore access errors
        }
      }

      // Fallback: check if 'opencode' command exists in PATH
      try {
        execSync('which opencode', { env, stdio: 'pipe' });
        return true;
      } catch (e) {
        return false;
      }
    }

    // Windows: Check multiple possible locations
    return this.checkInstallationPaths();
  }

  /**
   * Get common installation paths for Unix systems (macOS/Linux)
   * @returns {string[]}
   */
  getUnixCommonPaths() {
    const home = os.homedir();
    const paths = [];

    // Static paths (no expansion needed)
    const staticPaths = [
      '/usr/local/bin/opencode',
      '/usr/bin/opencode',
      '/opt/homebrew/bin/opencode',
      `${home}/.opencode/bin/opencode`, // official curl installer location
      `${home}/.volta/bin/opencode`,
      `${home}/.local/share/pnpm/opencode`,
      `${home}/Library/pnpm/opencode`,
      `${home}/.yarn/bin/opencode`,
      `${home}/.asdf/shims/opencode`,
      `${home}/.local/bin/opencode`,
    ];
    paths.push(...staticPaths);

    // nvm: check all installed node versions
    const nvmVersionsDir = `${home}/.nvm/versions/node`;
    try {
      if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir);
        versions.forEach(v => {
          paths.push(`${nvmVersionsDir}/${v}/bin/opencode`);
        });
      }
    } catch (e) { /* ignore */ }

    // fnm: check all installed node versions
    const fnmVersionsDir = `${home}/.fnm/node-versions`;
    try {
      if (fs.existsSync(fnmVersionsDir)) {
        const versions = fs.readdirSync(fnmVersionsDir);
        versions.forEach(v => {
          paths.push(`${fnmVersionsDir}/${v}/installation/bin/opencode`);
        });
      }
    } catch (e) { /* ignore */ }

    return paths;
  }

  /**
   * Check if opencode exists in known installation paths (Windows)
   * @returns {boolean}
   */
  checkInstallationPaths() {
    const paths = this.getPossiblePaths();

    console.log(`[OpencodeInstaller] Checking ${paths.length} possible opencode paths...`);

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          console.log(`[OpencodeInstaller] Found opencode at: ${p}`);
          return true;
        }
      } catch (e) {
        // Ignore access errors
      }
    }

    // Last resort: check if 'opencode' is in PATH using where.exe
    console.log('[OpencodeInstaller] Checking PATH via where.exe...');
    try {
      const result = execSync('where.exe opencode', {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 5000
      });
      const firstPath = result.split('\n')[0].trim();
      if (firstPath) {
        console.log(`[OpencodeInstaller] Found opencode in PATH: ${firstPath}`);
        return true;
      }
    } catch (e) {
      // Not in PATH
    }

    console.log('[OpencodeInstaller] opencode not found in any location');
    return false;
  }

  /**
   * Get the path to opencode CLI executable
   * @returns {string|null}
   */
  getOpencodePath() {
    if (process.platform !== 'win32') {
      try {
        execSync('which opencode', { stdio: 'pipe' });
        return 'opencode';
      } catch (e) {
        return null;
      }
    }

    // First check all known paths
    const paths = this.getPossiblePaths();
    for (const p of paths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Last resort: direct where.exe check
    try {
      const result = execSync('where.exe opencode', {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 5000
      });
      const firstPath = result.split('\n')[0].trim();
      if (firstPath && fs.existsSync(firstPath)) {
        return firstPath;
      }
    } catch (e) {
      // Not found
    }

    return null;
  }

  /**
   * Resolve the BEST opencode binary to LAUNCH when more than one is installed.
   *
   * "opencode" is two different products that share the executable name: the NEW
   * SST build (opencode.ai, npm `opencode-ai`, versions >= 1.x — reads
   * ~/.config/opencode/opencode.json) and the LEGACY `opencode-ai/opencode`
   * (Charm/Homebrew, 0.0.x — ignores that config and defaults to a provider with no
   * base URL). A bare `which opencode` resolves by PATH order, so a user with BOTH
   * can silently launch the broken 0.0.x. This returns the absolute path of an SST
   * (>= 1.x) binary when a CONFLICT exists, so the launch prefers it.
   *
   * Returns null when there is no conflict (0 or 1 opencode on PATH) or no SST build
   * among them, so callers fall back to the plain `opencode` command (PATH default)
   * — keeping the common single-install case, and the unit tests, unchanged. Windows
   * already resolves through getPossiblePaths(), so this is a macOS/Linux concern.
   *
   * Cached: probing `--version` is a subprocess and this is on the per-terminal
   * spawn path.
   * @returns {string|null}
   */
  resolveBestPath() {
    if (this._bestPathComputed) return this._bestPath;
    this._bestPathComputed = true;
    this._bestPath = this._computeBestPath();
    return this._bestPath;
  }

  _computeBestPath() {
    if (process.platform === 'win32') return null;
    let candidates = [];
    try {
      // `which -a` lists every opencode on PATH in PATH order.
      const out = execSync('which -a opencode', { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
      candidates = [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))];
    } catch (e) {
      return null; // none on PATH
    }
    if (candidates.length < 2) return null; // no conflict -> use the PATH default
    for (const p of candidates) {
      const major = this._majorVersionOf(p);
      if (major != null && major >= 1) {
        console.log(`[OpencodeInstaller] Multiple opencode binaries on PATH; preferring SST v${major}.x at: ${p}`);
        return p;
      }
    }
    return null; // no SST among them -> leave the PATH default
  }

  _majorVersionOf(binPath) {
    try {
      const out = execFileSync(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 });
      const m = String(out).match(/(\d+)\.\d+\.\d+/);
      return m ? parseInt(m[1], 10) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get possible installation paths for opencode CLI on Windows
   * @returns {string[]}
   */
  getPossiblePaths() {
    if (process.platform !== 'win32') return [];

    const userProfile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');

    const paths = [
      // 0. CodeAgentSwarm bundled Portable Node (installed globally via our nodeRuntime)
      path.join(appData, 'CodeAgentSwarm', 'runtime', 'node', 'opencode.cmd'),
      path.join(appData, 'CodeAgentSwarm', 'runtime', 'node', 'opencode.exe'),
      path.join(appData, 'CodeAgentSwarm', 'runtime', 'node', 'node_modules', '.bin', 'opencode.cmd'),

      // 1. npm global installation
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.exe'),

      // 2. pnpm global installation
      path.join(localAppData, 'pnpm', 'opencode.cmd'),
      path.join(localAppData, 'pnpm', 'opencode.exe'),

      // 3. yarn global installation
      path.join(localAppData, 'Yarn', 'bin', 'opencode.cmd'),
      path.join(localAppData, 'Yarn', 'bin', 'opencode.exe'),

      // 4. Volta (Node version manager)
      path.join(userProfile, '.volta', 'bin', 'opencode.exe'),
      path.join(userProfile, '.volta', 'bin', 'opencode.cmd'),

      // 5. Local bin / official installer
      path.join(userProfile, '.local', 'bin', 'opencode'),
      path.join(userProfile, '.local', 'bin', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),

      // 6. Scoop package manager
      path.join(userProfile, 'scoop', 'shims', 'opencode.exe'),
      path.join(userProfile, 'scoop', 'apps', 'opencode', 'current', 'opencode.exe'),

      // 7. Chocolatey package manager
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'opencode.exe'),
    ];

    // 8. nvm-windows: Check all installed Node versions
    const nvmPath = process.env.NVM_HOME || path.join(appData, 'nvm');
    if (fs.existsSync(nvmPath)) {
      try {
        const versions = fs.readdirSync(nvmPath).filter(v => v.startsWith('v'));
        for (const version of versions) {
          paths.push(path.join(nvmPath, version, 'opencode.cmd'));
          paths.push(path.join(nvmPath, version, 'opencode.exe'));
        }
      } catch (e) {
        // Ignore errors reading nvm directory
      }
    }

    // 9. fnm (Fast Node Manager)
    const fnmPath = path.join(localAppData, 'fnm');
    if (fs.existsSync(fnmPath)) {
      try {
        const nodeVersionsPath = path.join(fnmPath, 'node-versions');
        if (fs.existsSync(nodeVersionsPath)) {
          const versions = fs.readdirSync(nodeVersionsPath);
          for (const version of versions) {
            paths.push(path.join(nodeVersionsPath, version, 'installation', 'opencode.cmd'));
            paths.push(path.join(nodeVersionsPath, version, 'installation', 'opencode.exe'));
          }
        }
      } catch (e) {
        // Ignore errors reading fnm directory
      }
    }

    return paths;
  }

  /**
   * Install opencode CLI using npm
   * @param {BrowserWindow} mainWindow - Main window for progress dialog
   * @returns {Promise<boolean>} True if installation successful
   */
  async install(mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) {
      console.log('[OpencodeInstaller] Installation already in progress');
      this.lastError = 'Installation is still running from a previous click. Please wait.';
      return false;
    }

    this.installInProgress = true;
    this.lastError = null;
    console.log('[OpencodeInstaller] Starting opencode CLI installation...');
    onStage('checking');

    // Show progress dialog
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Installing opencode',
        message: 'Installing opencode globally via npm...\n\nThis may take a few moments.',
        buttons: [],
        noLink: true
      }).catch(() => {});
    }

    try {
      const isWindows = process.platform === 'win32';
      const baseEnv = options.env || process.env;

      // Bootstrap Node.js runtime on Windows if host has no npm. No-op on hosts with Node.
      const nodeReady = await nodeRuntime.ensureInstalled(0, baseEnv);
      if (!nodeReady) {
        this.installInProgress = false;
        const detail = nodeRuntime.getLastError ? nodeRuntime.getLastError() : null;
        this.lastError = detail
          ? `Node.js/npm is unavailable: ${detail}`
          : `Node.js/npm was not found on PATH: ${baseEnv.PATH || '(empty)'}`;
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Node.js Runtime Required',
            message: `Could not bootstrap Node.js runtime.\n\n${detail ? `Error: ${detail}` : 'Unknown reason.'}\n\nAs a workaround, install Node.js manually from https://nodejs.org/ and retry.`,
            buttons: ['OK']
          });
        }
        return false;
      }

      const installEnv = nodeRuntime.getEnvWithNode(baseEnv);
      const npmCommand = await nodeRuntime.resolveNpmPath(installEnv);
      if (!npmCommand) {
        this.installInProgress = false;
        this.lastError = `npm could not be resolved after checking PATH: ${installEnv.PATH || '(empty)'}`;
        return false;
      }

      const bundledNodeDir = isWindows && nodeRuntime.getNodeDir ? nodeRuntime.getNodeDir() : null;
      const args = ['install', '--global'];
      if (bundledNodeDir) args.push('--prefix', bundledNodeDir);
      args.push(this.packageName);
      console.log(`[OpencodeInstaller] Running: ${npmCommand} ${args.join(' ')}`);

      return new Promise((resolve) => {
        onStage('installing');
        onProgress(`$ ${npmCommand} ${args.join(' ')}`);
        streamingExec(npmCommand, {
          args,
          shell: false,
          windowsHide: true,
          timeout: 300000, // 5 minute timeout
          maxBuffer: 50 * 1024 * 1024, // 50 MB — npm install can emit a lot of output
          env: installEnv
        }, async (error, stdout, stderr) => {
          this.installInProgress = false;

          if (error) {
            console.error('[OpencodeInstaller] Installation error:', error.message);
            console.error('[OpencodeInstaller] stderr:', stderr);
            this.lastError = `npm install failed: ${error.message}\n`
              + `Stdout: ${(stdout || '').slice(-1000)}\n`
              + `Stderr: ${(stderr || '').slice(-1000)}`;

            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'opencode Installation Failed',
                message: `Failed to install opencode automatically.\n\nError: ${error.message}\n\nPlease install manually by running:\nnpm install -g ${this.packageName}\n\nOr:\ncurl -fsSL https://opencode.ai/install | bash`,
                buttons: ['OK'],
              });
            }

            resolve(false);
            return;
          }

          console.log('[OpencodeInstaller] Installation output:', stdout);

          // Wait a moment for installation to complete
          await this.sleep(2000);

          // Prepend bundled Node to process.env.PATH so isInstalled() + subsequent
          // terminals can resolve `opencode`.
          try {
            nodeRuntime.applyToProcessEnv();
          } catch (e) { /* non-fatal */ }

          // Verify installation
          onStage('verifying');
          const installed = this.isInstalled(installEnv);

          if (installed) {
            console.log('[OpencodeInstaller] opencode CLI installed successfully!');

            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'opencode Installed',
                message: 'opencode has been installed successfully.\n\nYou can now use opencode in CodeAgentSwarm.\n\nNote: configure a provider/model first (e.g. run `opencode` and use /connect, or set a model in ~/.config/opencode/opencode.json).',
                buttons: ['OK'],
              });
            }

            resolve(true);
          } else {
            console.error('[OpencodeInstaller] Installation verification failed');
            this.lastError = `npm install exited OK but '${this.packageName}' binary not found afterward.\n`
              + `Stdout tail: ${(stdout || '').slice(-400)}\n`
              + `Stderr tail: ${(stderr || '').slice(-400)}`;

            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'Installation Verification Failed',
                message: `opencode installation could not be verified.\n\nPlease try installing manually:\nnpm install -g ${this.packageName}\n\nOr:\ncurl -fsSL https://opencode.ai/install | bash`,
                buttons: ['OK'],
              });
            }

            resolve(false);
          }
        }, onProgress);
      });

    } catch (error) {
      console.error('[OpencodeInstaller] Installation error:', error);
      this.lastError = error && error.message ? error.message : String(error);
      this.installInProgress = false;
      return false;
    }
  }

  /**
   * Ensure opencode CLI is installed - installs if not found
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>} True if opencode CLI is available
   */
  async ensureInstalled(mainWindow) {
    if (this.isInstalled()) {
      console.log('[OpencodeInstaller] opencode CLI is already installed');
      return true;
    }

    console.log('[OpencodeInstaller] opencode CLI not found - attempting installation...');

    if (mainWindow && !mainWindow.isDestroyed()) {
      const response = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Install opencode',
        message: 'opencode is not installed.\n\nWould you like to install it now?\n\nThis will run: npm install -g ' + this.packageName,
        buttons: ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });

      if (response.response === 1) {
        console.log('[OpencodeInstaller] User cancelled installation');
        return false;
      }
    }

    const success = await this.install(mainWindow);
    return this.isInstalled() || success;
  }

  /**
   * Helper: Sleep for specified milliseconds
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
const installer = new OpencodeCliInstaller();

module.exports = {
  OpencodeCliInstaller,
  installer,
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
  isInstalled: (env) => installer.isInstalled(env),
  getOpencodePath: () => installer.getOpencodePath(),
  resolveBestPath: () => installer.resolveBestPath(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  getLastError: () => installer.getLastError(),
};
