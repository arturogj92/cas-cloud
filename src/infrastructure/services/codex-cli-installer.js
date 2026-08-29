/**
 * Codex CLI Installer Service
 * Automatically detects and installs OpenAI Codex CLI
 * Uses npm global install for the official OpenAI Codex CLI
 *
 * Installation methods:
 * - npm install -g @openai/codex
 * - brew install --cask codex (macOS)
 */

const { dialog } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodeRuntime = require('./node-runtime');
const vcredistRuntime = require('./vcredist-runtime');
const { streamingExec } = require('./streaming-exec');

class CodexCliInstaller {
  constructor() {
    this.installInProgress = false;
    this.lastError = null;
    // Official Codex CLI package name
    this.packageName = '@openai/codex';
  }

  getLastError() {
    return this.lastError;
  }

  /**
   * Check if Codex CLI is installed
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
            console.log(`[CodexInstaller] Found Codex at: ${p}`);
            return true;
          }
        } catch (e) {
          // Ignore access errors
        }
      }

      // Fallback: check if 'codex' command exists in PATH
      try {
        execSync('which codex', { env, stdio: 'pipe' });
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
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      '/opt/homebrew/bin/codex',
      `${home}/.volta/bin/codex`,
      `${home}/.local/share/pnpm/codex`,
      `${home}/Library/pnpm/codex`,
      `${home}/.yarn/bin/codex`,
      `${home}/.asdf/shims/codex`,
      `${home}/.local/bin/codex`,
    ];
    paths.push(...staticPaths);

    // nvm: check all installed node versions
    const nvmVersionsDir = `${home}/.nvm/versions/node`;
    try {
      if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir);
        versions.forEach(v => {
          paths.push(`${nvmVersionsDir}/${v}/bin/codex`);
        });
      }
    } catch (e) { /* ignore */ }

    // fnm: check all installed node versions
    const fnmVersionsDir = `${home}/.fnm/node-versions`;
    try {
      if (fs.existsSync(fnmVersionsDir)) {
        const versions = fs.readdirSync(fnmVersionsDir);
        versions.forEach(v => {
          paths.push(`${fnmVersionsDir}/${v}/installation/bin/codex`);
        });
      }
    } catch (e) { /* ignore */ }

    return paths;
  }

  /**
   * Check if Codex exists in known installation paths
   * @returns {boolean}
   */
  checkInstallationPaths() {
    const paths = this.getPossiblePaths();

    console.log(`[CodexInstaller] Checking ${paths.length} possible Codex paths...`);

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          console.log(`[CodexInstaller] Found Codex at: ${p}`);
          return true;
        }
      } catch (e) {
        // Ignore access errors
      }
    }

    // Last resort: check if 'codex' is in PATH using where.exe
    console.log('[CodexInstaller] Checking PATH via where.exe...');
    try {
      const result = execSync('where.exe codex', {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 5000
      });
      const firstPath = result.split('\n')[0].trim();
      if (firstPath) {
        console.log(`[CodexInstaller] Found Codex in PATH: ${firstPath}`);
        return true;
      }
    } catch (e) {
      // Not in PATH
    }

    console.log('[CodexInstaller] Codex not found in any location');
    return false;
  }

  /**
   * Get the path to Codex CLI executable
   * Checks all known paths and falls back to where.exe
   * @returns {string|null}
   */
  getCodexPath() {
    if (process.platform !== 'win32') {
      // On Unix, check if codex exists
      try {
        execSync('which codex', { stdio: 'pipe' });
        return 'codex';
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
      const result = execSync('where.exe codex', {
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
   * Get possible installation paths for Codex CLI on Windows
   * Includes all known installation methods with fallbacks
   * @returns {string[]}
   */
  getPossiblePaths() {
    if (process.platform !== 'win32') return [];

    const userProfile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');

    const paths = [
      // 0. CodeAgentSwarm bundled Portable Node (installed globally via our nodeRuntime)
      path.join(appData, 'CodeAgentSwarm', 'runtime', 'node', 'codex.cmd'),
      path.join(appData, 'CodeAgentSwarm', 'runtime', 'node', 'codex.exe'),
      path.join(appData, 'CodeAgentSwarm', 'runtime', 'node', 'node_modules', '.bin', 'codex.cmd'),

      // 1. npm global installation
      path.join(appData, 'npm', 'codex.cmd'),
      path.join(appData, 'npm', 'codex.exe'),

      // 2. pnpm global installation
      path.join(localAppData, 'pnpm', 'codex.cmd'),
      path.join(localAppData, 'pnpm', 'codex.exe'),

      // 3. yarn global installation
      path.join(localAppData, 'Yarn', 'bin', 'codex.cmd'),
      path.join(localAppData, 'Yarn', 'bin', 'codex.exe'),

      // 4. Volta (Node version manager)
      path.join(userProfile, '.volta', 'bin', 'codex.exe'),
      path.join(userProfile, '.volta', 'bin', 'codex.cmd'),

      // 5. Local bin
      path.join(userProfile, '.local', 'bin', 'codex'),
      path.join(userProfile, '.local', 'bin', 'codex.exe'),

      // 6. Scoop package manager
      path.join(userProfile, 'scoop', 'shims', 'codex.exe'),
      path.join(userProfile, 'scoop', 'apps', 'codex', 'current', 'codex.exe'),

      // 7. Chocolatey package manager
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'codex.exe'),
    ];

    // 8. nvm-windows: Check all installed Node versions
    const nvmPath = process.env.NVM_HOME || path.join(appData, 'nvm');
    if (fs.existsSync(nvmPath)) {
      try {
        const versions = fs.readdirSync(nvmPath).filter(v => v.startsWith('v'));
        for (const version of versions) {
          paths.push(path.join(nvmPath, version, 'codex.cmd'));
          paths.push(path.join(nvmPath, version, 'codex.exe'));
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
            paths.push(path.join(nodeVersionsPath, version, 'installation', 'codex.cmd'));
            paths.push(path.join(nodeVersionsPath, version, 'installation', 'codex.exe'));
          }
        }
      } catch (e) {
        // Ignore errors reading fnm directory
      }
    }

    return paths;
  }

  /**
   * Install Codex CLI using npm
   * @param {BrowserWindow} mainWindow - Main window for progress dialog
   * @returns {Promise<boolean>} True if installation successful
   */
  async install(mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) {
      console.log('[CodexInstaller] Installation already in progress');
      this.lastError = 'Installation is still running from a previous click. Please wait.';
      return false;
    }

    this.installInProgress = true;
    this.lastError = null;
    console.log('[CodexInstaller] Starting Codex CLI installation...');
    onStage('checking');

    // Show progress dialog
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Installing Codex CLI',
        message: 'Installing Codex CLI globally via npm...\n\nThis may take a few moments.',
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
        const detail = nodeRuntime.getLastError
          ? nodeRuntime.getLastError()
          : null;
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
      console.log(`[CodexInstaller] Running: ${npmCommand} ${args.join(' ')}`);

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
            console.error('[CodexInstaller] Installation error:', error.message);
            console.error('[CodexInstaller] stderr:', stderr);
            this.lastError = `npm install failed: ${error.message}\n`
              + `Stdout: ${(stdout || '').slice(-1000)}\n`
              + `Stderr: ${(stderr || '').slice(-1000)}`;

            // Notify user of failure
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Codex CLI Installation Failed',
                message: `Failed to install Codex CLI automatically.\n\nError: ${error.message}\n\nPlease install manually by running:\nnpm install -g ${this.packageName}\n\nOr on macOS:\nbrew install --cask codex`,
                buttons: ['OK'],
              });
            }

            resolve(false);
            return;
          }

          console.log('[CodexInstaller] Installation output:', stdout);

          // Wait a moment for installation to complete
          await this.sleep(2000);

          // Prepend bundled Node to process.env.PATH so isInstalled() + subsequent
          // terminals can resolve `codex`.
          try {
            nodeRuntime.applyToProcessEnv();
          } catch (e) { /* non-fatal */ }

          // On Windows, Codex ships a compiled Rust binary that links against
          // Microsoft's VC++ runtime. Fresh Windows ARM64 installs often lack
          // this runtime, and launching `codex` crashes with STATUS_DLL_NOT_FOUND
          // (exit code -1073741515 / 0xC0000135). Install it silently so users
          // don't hit the crash. Best-effort — does not block install success.
          if (isWindows) {
            try {
              const vcredistOk = await vcredistRuntime.ensureInstalled();
              if (!vcredistOk) {
                console.warn('[CodexInstaller] VC++ Redistributable install failed (non-fatal):',
                  vcredistRuntime.getLastError());
              }
            } catch (e) {
              console.warn('[CodexInstaller] VC++ Redistributable threw (non-fatal):', e);
            }
          }

          // Verify installation
          onStage('verifying');
          const installed = this.isInstalled(installEnv);

          if (installed) {
            console.log('[CodexInstaller] Codex CLI installed successfully!');

            // Notify user of success
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Codex CLI Installed',
                message: 'Codex CLI has been installed successfully.\n\nYou can now use Codex CLI features in CodeAgentSwarm.\n\nNote: You may need to authenticate with OpenAI by running `codex login`.',
                buttons: ['OK'],
              });
            }

            resolve(true);
          } else {
            console.error('[CodexInstaller] Installation verification failed');
            console.error('[CodexInstaller] npm stdout:', stdout);
            console.error('[CodexInstaller] npm stderr:', stderr);
            this.lastError = `npm install exited OK but '${this.packageName}' binary not found afterward.\n`
              + `Stdout tail: ${(stdout || '').slice(-400)}\n`
              + `Stderr tail: ${(stderr || '').slice(-400)}`;

            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'Installation Verification Failed',
                message: `Codex CLI installation could not be verified.\n\nPlease try installing manually:\nnpm install -g ${this.packageName}\n\nOr on macOS:\nbrew install --cask codex`,
                buttons: ['OK'],
              });
            }

            resolve(false);
          }
        }, onProgress);
      });

    } catch (error) {
      console.error('[CodexInstaller] Installation error:', error);
      this.lastError = error && error.message ? error.message : String(error);
      this.installInProgress = false;
      return false;
    }
  }

  /**
   * Ensure Codex CLI is installed - installs if not found
   * Main entry point for the installer
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>} True if Codex CLI is available
   */
  async ensureInstalled(mainWindow) {
    // Check if already installed
    if (this.isInstalled()) {
      console.log('[CodexInstaller] Codex CLI is already installed');
      return true;
    }

    console.log('[CodexInstaller] Codex CLI not found - attempting installation...');

    // Ask user for confirmation before installing
    if (mainWindow && !mainWindow.isDestroyed()) {
      const response = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Install Codex CLI',
        message: 'Codex CLI is not installed.\n\nWould you like to install it now?\n\nThis will run: npm install -g ' + this.packageName,
        buttons: ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });

      if (response.response === 1) {
        console.log('[CodexInstaller] User cancelled installation');
        return false;
      }
    }

    // Install
    const success = await this.install(mainWindow);

    // Return final installation status
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
const installer = new CodexCliInstaller();

module.exports = {
  CodexCliInstaller,
  installer,
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
  isInstalled: (env) => installer.isInstalled(env),
  getCodexPath: () => installer.getCodexPath(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  getLastError: () => installer.getLastError(),
};
