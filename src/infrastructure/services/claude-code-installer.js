/**
 * Claude Code Installer Service
 * Automatically detects and installs Claude Code silently
 * Uses the official Anthropic installer
 */

const { dialog } = require('electron');
const { execSync } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const gitRuntime = require('./git-runtime');
const { streamingExec } = require('./streaming-exec');

/**
 * Download a URL to a file using Node's built-in https (handles redirects).
 * Does NOT rely on curl being on PATH — bulletproof on Windows portable apps.
 */
function downloadViaHttps(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl, redirectsLeft) => {
      const request = https.get(currentUrl, (response) => {
        const status = response.statusCode;
        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          response.resume();
          return attempt(response.headers.location, redirectsLeft - 1);
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${status} from ${currentUrl}`));
        }
        const file = fs.createWriteStream(destPath);
        response.pipe(file);
        response.on('error', (error) => {
          file.destroy();
          reject(error);
        });
        response.on('aborted', () => {
          file.destroy();
          reject(new Error(`Download aborted from ${currentUrl}`));
        });
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', reject);
      request.setTimeout(60_000, () => {
        request.destroy(new Error(`Download timed out from ${currentUrl}`));
      });
    };
    attempt(url, maxRedirects);
  });
}

/**
 * Build a PATH string guaranteed to contain Windows System32 (where powershell,
 * curl, and other tools that install.cmd may need live) even when process.env.PATH
 * is bare in an Electron portable context.
 */
function augmentedWindowsPath(basePath = process.env.PATH) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return [
    path.join(sysRoot, 'System32'),
    sysRoot,
    path.join(sysRoot, 'System32', 'Wbem'),
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    basePath || ''
  ].filter(Boolean).join(path.delimiter);
}

class ClaudeCodeInstaller {
  constructor() {
    this.platformConfig = null;
    this.installInProgress = false;
    this.lastError = null;
  }

  /** Return the last install error (message + partial stderr), null if none. */
  getLastError() {
    return this.lastError;
  }

  /**
   * Lazy load platform config to avoid circular dependencies
   */
  getPlatformConfig() {
    if (!this.platformConfig) {
      this.platformConfig = require('../platform/platform-config');
    }
    return this.platformConfig;
  }

  /**
   * Check if Claude Code is installed
   * @returns {boolean}
   */
  isInstalled(env = process.env) {
    if (process.platform !== 'win32') {
      // On macOS/Linux, first check common install paths directly.
      // Electron apps launched from Finder/Dock inherit a minimal PATH
      // (no ~/.zshrc / ~/.bash_profile), so `which claude` fails even when
      // Claude is installed in user-level locations like ~/.local/bin
      // or ~/.claude/local/bin. Mirror the defensive scan that gemini-
      // and codex-cli-installer already do.
      const commonPaths = this.getUnixCommonPaths();
      for (const p of commonPaths) {
        try {
          if (fs.existsSync(p)) {
            console.log(`[ClaudeInstaller] Found Claude at: ${p}`);
            return true;
          }
        } catch (e) {
          // Ignore access errors
        }
      }

      // Fallback: check PATH via `which`
      try {
        execSync('which claude', { env, stdio: 'pipe' });
        return true;
      } catch (e) {
        return false;
      }
    }

    // Windows: Check multiple possible locations
    return this.checkInstallationPaths();
  }

  /**
   * Get common installation paths for Claude on Unix systems (macOS/Linux).
   * Covers the official Anthropic native installer, package managers, and
   * Node-version-manager layouts. Used to defeat Electron's minimal PATH
   * when launched from Finder/Dock.
   * @returns {string[]}
   */
  getUnixCommonPaths() {
    const home = os.homedir();
    const paths = [];

    const staticPaths = [
      // Official Anthropic native installer (curl -fsSL claude.ai/install.sh | bash)
      `${home}/.local/bin/claude`,
      `${home}/.claude/local/bin/claude`,
      `${home}/.claude/local/claude`,
      // System-wide
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/opt/homebrew/bin/claude',
      // Package managers / runtime managers
      `${home}/.volta/bin/claude`,
      `${home}/.local/share/pnpm/claude`,
      `${home}/Library/pnpm/claude`,
      `${home}/.yarn/bin/claude`,
      `${home}/.asdf/shims/claude`,
      // npm global with custom prefix
      `${home}/.npm-global/bin/claude`,
    ];
    paths.push(...staticPaths);

    // nvm: scan all installed node versions
    const nvmVersionsDir = `${home}/.nvm/versions/node`;
    try {
      if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir);
        versions.forEach(v => {
          paths.push(`${nvmVersionsDir}/${v}/bin/claude`);
        });
      }
    } catch (e) { /* ignore */ }

    // fnm: scan all installed node versions
    const fnmVersionsDir = `${home}/.fnm/node-versions`;
    try {
      if (fs.existsSync(fnmVersionsDir)) {
        const versions = fs.readdirSync(fnmVersionsDir);
        versions.forEach(v => {
          paths.push(`${fnmVersionsDir}/${v}/installation/bin/claude`);
        });
      }
    } catch (e) { /* ignore */ }

    return paths;
  }

  /**
   * Check if Claude exists in known installation paths
   * @returns {boolean}
   */
  checkInstallationPaths() {
    const paths = this.getPossiblePaths();

    console.log(`[ClaudeInstaller] Checking ${paths.length} possible Claude paths...`);

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          console.log(`[ClaudeInstaller] ✓ Found Claude at: ${p}`);
          return true;
        }
      } catch (e) {
        // Ignore access errors
      }
    }

    // Last resort: check if 'claude' is in PATH using where.exe
    console.log('[ClaudeInstaller] Checking PATH via where.exe...');
    try {
      const result = execSync('where.exe claude', {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 5000
      });
      const firstPath = result.split('\n')[0].trim();
      if (firstPath) {
        console.log(`[ClaudeInstaller] ✓ Found Claude in PATH: ${firstPath}`);
        return true;
      }
    } catch (e) {
      // Not in PATH
    }

    console.log('[ClaudeInstaller] ✗ Claude not found in any location');
    return false;
  }

  /**
   * Get the path to Claude Code executable
   * Checks all known paths and falls back to where.exe
   * @returns {string|null}
   */
  getClaudePath() {
    if (process.platform !== 'win32') {
      // On Unix, prefer the first concrete path that exists so callers
      // (terminals, MCP) can spawn the binary even when PATH is minimal.
      const commonPaths = this.getUnixCommonPaths();
      for (const p of commonPaths) {
        try {
          if (fs.existsSync(p)) return p;
        } catch (e) { /* ignore */ }
      }
      // Fallback to the bare command name (relies on PATH).
      return 'claude';
    }

    // First check all known paths
    const paths = this.getPossiblePaths();
    for (const p of paths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Try platform config (which also has where.exe fallback)
    const platformPath = this.getPlatformConfig().getNativeClaudePath();
    if (platformPath) {
      return platformPath;
    }

    // Last resort: direct where.exe check
    try {
      const result = execSync('where.exe claude', {
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
   * Get possible installation paths for Claude Code on Windows
   * Includes all known installation methods with fallbacks
   * @returns {string[]}
   */
  getPossiblePaths() {
    if (process.platform !== 'win32') return [];

    const userProfile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
    const programData = process.env.ProgramData || 'C:\\ProgramData';

    const paths = [
      // 1. Native installer (recommended by Anthropic)
      path.join(userProfile, '.local', 'bin', 'claude.exe'),

      // 2. npm global installation
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(appData, 'npm', 'claude.exe'),

      // 3. Scoop package manager
      path.join(userProfile, 'scoop', 'shims', 'claude.exe'),
      path.join(userProfile, 'scoop', 'apps', 'claude', 'current', 'claude.exe'),

      // 4. Chocolatey package manager
      path.join(programData, 'chocolatey', 'bin', 'claude.exe'),

      // 5. Alternative local installations
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(localAppData, 'claude', 'claude.exe'),

      // 6. Volta (Node version manager)
      path.join(userProfile, '.volta', 'bin', 'claude.exe'),

      // 7. pnpm global
      path.join(localAppData, 'pnpm', 'claude.cmd'),
      path.join(localAppData, 'pnpm', 'claude.exe'),
    ];

    // 8. nvm-windows: Check all installed Node versions
    const nvmPath = process.env.NVM_HOME || path.join(appData, 'nvm');
    if (fs.existsSync(nvmPath)) {
      try {
        const versions = fs.readdirSync(nvmPath).filter(v => v.startsWith('v'));
        for (const version of versions) {
          paths.push(path.join(nvmPath, version, 'claude.cmd'));
          paths.push(path.join(nvmPath, version, 'claude.exe'));
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
            paths.push(path.join(nodeVersionsPath, version, 'installation', 'claude.cmd'));
            paths.push(path.join(nodeVersionsPath, version, 'installation', 'claude.exe'));
          }
        }
      } catch (e) {
        // Ignore errors reading fnm directory
      }
    }

    return paths;
  }

  buildInstallPlan(installScript) {
    if (process.platform === 'win32') {
      return {
        url: 'https://claude.ai/install.cmd',
        command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', `"${installScript}"`],
      };
    }
    return {
      url: 'https://claude.ai/install.sh',
      command: '/bin/bash',
      args: [installScript],
    };
  }

  /**
   * Install Claude Code silently (no prompts)
   * @param {BrowserWindow} mainWindow - Main window for notification
   * @returns {Promise<boolean>} True if installation successful
   */
  async install(mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) {
      console.log('[ClaudeInstaller] Installation already in progress');
      this.lastError = 'Installation is still running from a previous click. Please wait (can take 60-180s for first-time setup: downloading Portable Git ~45 MB + Claude install script + Claude binary).';
      return false;
    }

    this.installInProgress = true;
    // Clear stale error from previous attempts so the caller sees current state.
    this.lastError = null;
    console.log('[ClaudeInstaller] Starting silent Claude Code installation...');
    onStage('checking');

    try {
      const tempDir = os.tmpdir();
      const installScript = path.join(tempDir, process.platform === 'win32' ? 'install-claude.cmd' : 'install-claude.sh');
      const plan = this.buildInstallPlan(installScript);

      try {
        console.log(`[ClaudeInstaller] Downloading ${plan.url} via https...`);
        await downloadViaHttps(plan.url, installScript);
        console.log(`[ClaudeInstaller] Downloaded to ${installScript}`);
      } catch (downloadErr) {
        console.error('[ClaudeInstaller] Download failed:', downloadErr);
        this.lastError = `Download of the Claude installer failed: ${downloadErr.message}`;
        this.installInProgress = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Claude Code Installation Failed',
            message: `Could not download the Claude Code installer.\n\nError: ${downloadErr.message}\n\nCheck your internet connection and try again.`,
            buttons: ['OK'],
          });
        }
        return false;
      }

      let bundledBashPath = null;
      if (process.platform === 'win32') {
        try {
          bundledBashPath = await gitRuntime.ensureInstalled();
        } catch (gitErr) {
          console.error('[ClaudeInstaller] Could not bootstrap Portable Git:', gitErr);
          this.lastError = `Could not install Git for Windows (required by Claude installer): ${gitErr.message}`;
          this.installInProgress = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'error',
              title: 'Git for Windows Required',
              message: `Claude Code requires git-bash. Auto-install failed: ${gitErr.message}\n\nPlease install Git for Windows manually from https://git-scm.com/downloads/win`,
              buttons: ['OK']
            });
          }
          return false;
        }
      }

      return new Promise((resolve) => {
        console.log(`[ClaudeInstaller] Running: ${plan.command} ${plan.args.join(' ')}`);
        onStage('installing');
        onProgress(`$ ${plan.command} ${plan.args.join(' ')}`);

        const baseEnv = options.env || process.env;
        const spawnEnv = {
          ...baseEnv,
          ...(process.platform === 'win32' ? { PATH: augmentedWindowsPath(baseEnv.PATH) } : {}),
        };
        if (bundledBashPath) {
          spawnEnv.CLAUDE_CODE_GIT_BASH_PATH = bundledBashPath;
          console.log(`[ClaudeInstaller] Using bundled bash.exe at ${bundledBashPath}`);
        }

        streamingExec(plan.command, {
          args: plan.args,
          shell: false,
          windowsHide: true,
          timeout: 180000, // 3 minute timeout (git download can be slow)
          maxBuffer: 50 * 1024 * 1024, // 50 MB — install.cmd can emit a lot of output
          env: spawnEnv
        }, async (error, stdout, stderr) => {
          // Clean up install script
          try {
            if (fs.existsSync(installScript)) {
              fs.unlinkSync(installScript);
            }
          } catch (e) {
            // Ignore cleanup errors
          }

          this.installInProgress = false;

          if (error) {
            console.error('[ClaudeInstaller] Installation error:', error.message);
            console.error('[ClaudeInstaller] stderr:', stderr);
            this.lastError = `Claude installer failed: ${error.message}\nStdout: ${(stdout || '').slice(-1000)}\nStderr: ${(stderr || '').slice(-1000)}`;

            // Notify user of failure
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Claude Code Installation Failed',
                message: `Failed to install Claude Code automatically.\n\n${this.lastError}\n\nPlease install manually from https://claude.ai/install`,
                buttons: ['OK'],
              });
            }

            resolve(false);
            return;
          }

          console.log('[ClaudeInstaller] Installation output:', stdout);

          // Wait a moment for installation to complete
          await this.sleep(2000);

          // Verify installation
          onStage('verifying');
          const installed = process.platform === 'win32'
            ? this.checkInstallationPaths()
            : this.isInstalled(spawnEnv);

          if (installed) {
            console.log('[ClaudeInstaller] Claude Code installed successfully!');

            // Refresh platform config cache so app detects the new installation
            try {
              const platformConfig = this.getPlatformConfig();
              if (platformConfig.refreshNativeClaudePath) {
                platformConfig.refreshNativeClaudePath();
                console.log('[ClaudeInstaller] Platform config cache refreshed');
              }
            } catch (e) {
              console.warn('[ClaudeInstaller] Could not refresh platform config:', e.message);
            }

            // Export CLAUDE_CODE_GIT_BASH_PATH to process.env so all terminals
            // spawned after this point inherit it. Claude CLI requires this at
            // runtime when git-bash isn't on the system PATH.
            try {
              if (gitRuntime.applyToProcessEnv()) {
                console.log(`[ClaudeInstaller] Exposed CLAUDE_CODE_GIT_BASH_PATH=${process.env.CLAUDE_CODE_GIT_BASH_PATH}`);
              }
            } catch (e) {
              console.warn('[ClaudeInstaller] Could not export git bash env var:', e.message);
            }

            // Notify user of success (only if window available)
            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Claude Code Installed',
                message: 'Claude Code has been installed automatically.\n\nYou can now use all features of CodeAgentSwarm.',
                buttons: ['OK'],
              });
            }

            resolve(true);
          } else {
            console.error('[ClaudeInstaller] Installation verification failed');
            console.error('[ClaudeInstaller] install.cmd stdout:', stdout);
            console.error('[ClaudeInstaller] install.cmd stderr:', stderr);
            this.lastError = `Claude installer exited OK but the binary was not found afterward.\n`
              + `Stdout tail: ${(stdout || '').slice(-400)}\n`
              + `Stderr tail: ${(stderr || '').slice(-400)}`;

            if (mainWindow && !mainWindow.isDestroyed()) {
              dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'Installation Verification Failed',
                message: 'Claude Code installation could not be verified.\n\nPlease restart the application or install manually.',
                buttons: ['OK'],
              });
            }

            resolve(false);
          }
        }, onProgress);
      });

    } catch (error) {
      console.error('[ClaudeInstaller] Installation error:', error);
      this.lastError = error && error.message ? error.message : String(error);
      this.installInProgress = false;
      return false;
    }
  }

  /**
   * Ensure Claude Code is installed - installs silently if not found
   * Main entry point for the installer
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>} True if Claude Code is available
   */
  async ensureInstalled(mainWindow) {
    // Check if already installed
    if (this.isInstalled()) {
      console.log('[ClaudeInstaller] Claude Code is already installed');
      return true;
    }

    console.log('[ClaudeInstaller] Claude Code not found - installing automatically...');

    // Install silently (no prompts)
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
const installer = new ClaudeCodeInstaller();

module.exports = {
  ClaudeCodeInstaller,
  installer,
  // Shared by installers that must avoid download-pipe-execute command lines
  // (Windows Defender flags those shapes; see antigravity-cli-installer.js).
  downloadViaHttps,
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
  isInstalled: (env) => installer.isInstalled(env),
  getClaudePath: () => installer.getClaudePath(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  getLastError: () => installer.getLastError(),
};
