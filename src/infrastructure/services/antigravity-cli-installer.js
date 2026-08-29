/**
 * Antigravity CLI Installer Service
 *
 * Detects and installs Google's Antigravity CLI (`agy`), the official
 * successor to Gemini CLI (Gemini CLI was shut down 2026-06-18).
 *
 * Unlike Gemini (npm `@google/gemini-cli`), Antigravity ships as a single
 * native Go binary installed via an official bootstrapper script:
 *   - macOS/Linux: curl -fsSL https://antigravity.google/cli/install.sh | bash
 *                  -> installs to ~/.local/bin/agy
 *   - Windows:     install.ps1 -> %LOCALAPPDATA%\agy\bin\agy.exe, and adds that
 *                  dir to the User PATH (verified on Windows 11 ARM64).
 *                  We do NOT run the documented `irm …/install.ps1 | iex`
 *                  one-liner: Windows Defender's ML flags that process shape as
 *                  Trojan:Win32/Commando.A!ml and blocks the spawn. Instead the
 *                  script is downloaded over HTTPS and run via powershell -File.
 *
 * So detection is just a couple of well-known paths + a PATH fallback, and
 * install is a single scripted command. No node runtime / npm shim hunting.
 */

const { dialog } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { streamingExec } = require('./streaming-exec');

const INSTALL_SH_URL = 'https://antigravity.google/cli/install.sh';
const INSTALL_PS1_URL = 'https://antigravity.google/cli/install.ps1';

// The agy binary is ~180 MB (windows_amd64 is the largest at ~183 MB), so on a
// slow home connection the download alone can exceed 5 minutes. 15 minutes
// keeps the hard stop for a truly hung install without killing legitimate ones.
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

class AntigravityCliInstaller {
  constructor() {
    this.installInProgress = false;
    this.lastError = null;
  }

  getLastError() {
    return this.lastError;
  }

  /**
   * Candidate absolute paths for the `agy` binary, by platform.
   * @returns {string[]}
   */
  getPossiblePaths() {
    const home = os.homedir();
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const userProfile = process.env.USERPROFILE || home;
      return [
        // Authoritative location used by the official install.ps1 (verified on
        // Windows 11 ARM64): %LOCALAPPDATA%\agy\bin\agy.exe
        path.join(localAppData, 'agy', 'bin', 'agy.exe'),
        // Legacy/fallback guesses kept in case the installer layout changes.
        path.join(localAppData, 'Antigravity', 'agy.exe'),
        path.join(localAppData, 'Antigravity', 'bin', 'agy.exe'),
        path.join(userProfile, '.local', 'bin', 'agy.exe'),
        path.join(userProfile, '.local', 'bin', 'agy'),
      ];
    }
    return [
      path.join(home, '.local', 'bin', 'agy'),
      '/usr/local/bin/agy',
      '/opt/homebrew/bin/agy',
      '/usr/bin/agy',
    ];
  }

  /**
   * Check if Antigravity CLI is installed.
   * @returns {boolean}
   */
  isInstalled() {
    for (const p of this.getPossiblePaths()) {
      try {
        if (fs.existsSync(p)) {
          return true;
        }
      } catch (e) { /* ignore access errors */ }
    }

    // PATH fallback
    try {
      if (process.platform === 'win32') {
        const out = execSync('where.exe agy', { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
        return !!out.split('\n')[0].trim();
      }
      execSync('command -v agy', { stdio: 'pipe', shell: '/bin/bash' });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the absolute path to the `agy` executable, or 'agy' if only on PATH,
   * or null if not found.
   * @returns {string|null}
   */
  getAgyPath() {
    for (const p of this.getPossiblePaths()) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (e) { /* ignore */ }
    }
    try {
      if (process.platform === 'win32') {
        const out = execSync('where.exe agy', { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
        const first = out.split('\n')[0].trim();
        if (first && fs.existsSync(first)) return first;
      } else {
        execSync('command -v agy', { stdio: 'pipe', shell: '/bin/bash' });
        return 'agy';
      }
    } catch (e) { /* not found */ }
    return null;
  }

  /**
   * Install Antigravity CLI via the official bootstrapper script.
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>}
   */
  async install(mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) {
      this.lastError = 'Installation is still running from a previous click. Please wait.';
      return false;
    }
    this.installInProgress = true;
    this.lastError = null;
    onStage('checking');

    const isWindows = process.platform === 'win32';
    // What we tell the user to run by hand: the official documented one-liner.
    const manualCommand = isWindows
      ? `irm ${INSTALL_PS1_URL} | iex`
      : `curl -fsSL ${INSTALL_SH_URL} | bash`;

    let installCommand;
    let installScriptPath = null;
    let execOptions;
    if (isWindows) {
      // Defender flags the documented `irm … | iex` one-liner as malware and
      // blocks the spawn — see windows-install-script.js for the full story.
      const { planWindowsPs1Install } = require('./windows-install-script');
      let plan;
      try {
        plan = await planWindowsPs1Install(INSTALL_PS1_URL, 'antigravity-install.ps1');
      } catch (downloadErr) {
        this.installInProgress = false;
        this.lastError = `Download of the Antigravity installer script failed: ${downloadErr.message}`;
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Antigravity CLI Installation Failed',
            message: `Could not download the Antigravity installer.\n\nError: ${downloadErr.message}\n\nCheck your internet connection and try again.`,
            buttons: ['OK'],
          });
        }
        return false;
      }
      installScriptPath = plan.scriptPath;
      installCommand = plan.command;
      execOptions = {
        args: plan.args,
        shell: false,
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      };
    } else {
      installCommand = `curl -fsSL ${INSTALL_SH_URL} | bash`;
      execOptions = {
        shell: '/bin/bash',
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      };
    }

    console.log(`[AntigravityInstaller] Running: ${installCommand}${execOptions.args ? ' ' + execOptions.args.join(' ') : ''}`);
    onStage('installing');

    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Installing Antigravity CLI',
        message: 'Installing Antigravity CLI (agy)...\n\nThis may take a moment.',
        buttons: [],
        noLink: true
      }).catch(() => {});
    }

    return new Promise((resolve) => {
      streamingExec(installCommand, execOptions, async (error, stdout, stderr) => {
        if (installScriptPath) {
          try { fs.unlinkSync(installScriptPath); } catch (e) { /* ignore */ }
        }
        this.installInProgress = false;

        if (error) {
          console.error('[AntigravityInstaller] Installation error:', error.message);
          this.lastError = `Install failed: ${error.message}\nStderr: ${(stderr || '').slice(0, 400)}`;
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'error',
              title: 'Antigravity CLI Installation Failed',
              message: `Failed to install Antigravity CLI automatically.\n\nError: ${error.message}\n\nPlease install manually by running:\n${manualCommand}`,
              buttons: ['OK'],
            });
          }
          resolve(false);
          return;
        }

        console.log('[AntigravityInstaller] Installation output:', (stdout || '').slice(-400));

        // The installer updates the User PATH via a registry broadcast that does
        // NOT reach this already-running process, so the `where.exe`/PATH fallback
        // can't see `agy` yet. Detection therefore relies on the explicit on-disk
        // paths; retry a few times to absorb any filesystem write lag.
        onStage('verifying');
        let installed = false;
        for (let attempt = 0; attempt < 3 && !installed; attempt++) {
          await this.sleep(1500);
          installed = this.isInstalled();
        }
        if (installed) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Antigravity CLI Installed',
              message: 'Antigravity CLI (agy) has been installed successfully.\n\nThe first time you launch it you will be asked to sign in with Google.',
              buttons: ['OK'],
            });
          }
          resolve(true);
        } else {
          this.lastError = `Install script exited OK but 'agy' was not found afterward.\nStdout tail: ${(stdout || '').slice(-300)}\nStderr tail: ${(stderr || '').slice(-300)}`;
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: 'Installation Verification Failed',
              message: `Antigravity CLI installation could not be verified.\n\nPlease try installing manually:\n${manualCommand}`,
              buttons: ['OK'],
            });
          }
          resolve(false);
        }
      }, onProgress);
    });
  }

  /**
   * Ensure Antigravity CLI is installed - installs if not found.
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>}
   */
  async ensureInstalled(mainWindow) {
    if (this.isInstalled()) {
      return true;
    }

    const isWindows = process.platform === 'win32';
    const cmdForDialog = isWindows
      ? `irm ${INSTALL_PS1_URL} | iex`
      : `curl -fsSL ${INSTALL_SH_URL} | bash`;

    if (mainWindow && !mainWindow.isDestroyed()) {
      const response = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Install Antigravity CLI',
        message: `Antigravity CLI is not installed.\n\nWould you like to install it now?\n\nThis will run:\n${cmdForDialog}`,
        buttons: ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });
      if (response.response === 1) {
        return false;
      }
    }

    const success = await this.install(mainWindow);
    return this.isInstalled() || success;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance (mirrors gemini-cli-installer's shape)
const installer = new AntigravityCliInstaller();

module.exports = {
  AntigravityCliInstaller,
  installer,
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
  isInstalled: () => installer.isInstalled(),
  getAgyPath: () => installer.getAgyPath(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  getLastError: () => installer.getLastError(),
};
