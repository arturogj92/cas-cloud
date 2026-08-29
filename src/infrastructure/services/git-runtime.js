/**
 * Git for Windows Bootstrap Service
 *
 * Claude Code's install.cmd requires git-bash (bash.exe from Git for Windows)
 * to be available, either on PATH or via the CLAUDE_CODE_GIT_BASH_PATH env var.
 *
 * On a fresh Windows VM without Git installed, Anthropic's installer aborts with:
 *   "Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win)"
 *
 * This service auto-downloads Portable Git (self-extracting 7z.exe) to
 * %APPDATA%\CodeAgentSwarm\runtime\git\ and exposes the bash.exe path.
 *
 * Note: Git for Windows doesn't ship a Portable ARM64 build, so we always
 * download the x64 portable. On Windows 11 ARM, x64 bash runs via Prism
 * emulation (transparent, no user action).
 */

const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Pinned PortableGit release.
const GIT_VERSION = '2.47.1.2';
const GIT_ARCHIVE_URL = `https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/PortableGit-${GIT_VERSION}-64-bit.7z.exe`;

class GitRuntime {
  constructor() {
    this.runtimeRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'CodeAgentSwarm', 'runtime');
    this.gitDir = path.join(this.runtimeRoot, 'git');
    this.bootstrapInProgress = false;
    this.lastError = null;
  }

  /** Absolute path to bash.exe inside our bundled Git, regardless of presence. */
  getBashPath() {
    return path.join(this.gitDir, 'bin', 'bash.exe');
  }

  /** True if host already has bash.exe resolvable via where.exe. */
  hostHasBash() {
    return new Promise(resolve => {
      if (process.platform !== 'win32') return resolve(false);
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const where = path.join(sysRoot, 'System32', 'where.exe');
      execFile(where, ['bash.exe'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
    });
  }

  /** True if our bundled Git is already extracted and usable. */
  bundledExists() {
    if (process.platform !== 'win32') return false;
    return fs.existsSync(this.getBashPath());
  }

  /** Download a URL to a file path, following redirects. */
  downloadFile(url, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      const attempt = (currentUrl, redirectsLeft) => {
        https.get(currentUrl, (response) => {
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
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        }).on('error', reject);
      };
      attempt(url, maxRedirects);
    });
  }

  /** Run the self-extracting .7z.exe with silent flags to extract into destDir. */
  extractSfx(sfxPath, destDir) {
    return new Promise((resolve, reject) => {
      // -o"<dir>" sets output, -y auto-accepts all prompts
      execFile(sfxPath, [`-o${destDir}`, '-y'], { timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve();
      });
    });
  }

  async downloadAndExtract() {
    fs.mkdirSync(this.runtimeRoot, { recursive: true });
    const sfxPath = path.join(os.tmpdir(), `PortableGit-${GIT_VERSION}.7z.exe`);

    console.log(`[GitRuntime] Downloading ${GIT_ARCHIVE_URL}`);
    await this.downloadFile(GIT_ARCHIVE_URL, sfxPath);

    console.log(`[GitRuntime] Extracting to ${this.gitDir}`);
    if (fs.existsSync(this.gitDir)) {
      fs.rmSync(this.gitDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.gitDir, { recursive: true });
    await this.extractSfx(sfxPath, this.gitDir);

    try { fs.unlinkSync(sfxPath); } catch (e) { /* ignore */ }

    return this.bundledExists();
  }

  /**
   * Ensure git-bash is available. Returns the absolute path to bash.exe if ok,
   * or null on failure.
   */
  async ensureInstalled() {
    if (process.platform !== 'win32') return null;

    if (await this.hostHasBash()) {
      console.log('[GitRuntime] Host already has bash.exe on PATH, skipping bootstrap');
      return null; // null means "use host's, don't override CLAUDE_CODE_GIT_BASH_PATH"
    }

    if (this.bundledExists()) {
      return this.getBashPath();
    }

    if (this.bootstrapInProgress) {
      for (let i = 0; i < 180; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (this.bundledExists()) return this.getBashPath();
      }
      return null;
    }

    this.bootstrapInProgress = true;
    this.lastError = null;
    try {
      const ok = await this.downloadAndExtract();
      return ok ? this.getBashPath() : null;
    } catch (err) {
      console.error('[GitRuntime] Bootstrap failed:', err);
      this.lastError = err && err.message ? err.message : String(err);
      return null;
    } finally {
      this.bootstrapInProgress = false;
    }
  }

  getLastError() {
    return this.lastError;
  }

  /**
   * If we have a bundled bash.exe, export its path via process.env.CLAUDE_CODE_GIT_BASH_PATH
   * so that all child processes spawned by this app (including terminals running `claude`)
   * inherit it. Claude Code at runtime requires this env var on Windows when git-bash
   * isn't on the system PATH.
   */
  applyToProcessEnv() {
    if (process.platform !== 'win32') return false;
    if (!this.bundledExists()) return false;
    process.env.CLAUDE_CODE_GIT_BASH_PATH = this.getBashPath();
    return true;
  }
}

module.exports = new GitRuntime();
