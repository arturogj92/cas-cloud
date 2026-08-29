/**
 * VC++ Redistributable Runtime Bootstrap Service
 *
 * Ensures the Microsoft Visual C++ Redistributable is installed on Windows.
 * Required by Rust-based CLIs (like Codex) that ship compiled binaries
 * linked against the MSVC runtime.
 *
 * Strategy:
 *   1. On non-Windows → no-op.
 *   2. If the correct vcredist is already detected in the registry → no-op.
 *   3. Else download `vc_redist.<arch>.exe` from Microsoft and run it silently
 *      (`/install /passive /norestart`). Microsoft's installer is idempotent:
 *      if a same-or-newer version is present, it exits with success.
 *
 * Microsoft download URLs (official, stable aliases):
 *   - x64   : https://aka.ms/vs/17/release/vc_redist.x64.exe
 *   - arm64 : https://aka.ms/vs/17/release/vc_redist.arm64.exe
 */

const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DOWNLOAD_URLS = {
  x64: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
  arm64: 'https://aka.ms/vs/17/release/vc_redist.arm64.exe'
};

// Exit codes returned by vc_redist.exe that indicate success (installed or
// already present at a compatible version). See MS docs for vcredist.
const SUCCESS_EXIT_CODES = new Set([
  0,      // installed successfully
  1638,   // ERROR_PRODUCT_VERSION — same or newer already installed
  3010    // success, reboot required (non-fatal)
]);

class VcRedistRuntime {
  constructor() {
    this.inProgress = false;
    this.lastError = null;
  }

  getLastError() {
    return this.lastError;
  }

  /** Map Node's process.arch to vc_redist arch slug. */
  getTargetArch() {
    if (process.arch === 'arm64') return 'arm64';
    if (process.arch === 'x64') return 'x64';
    return null; // ia32 / unsupported
  }

  /**
   * Check if vc_redist is already installed via registry marker.
   * `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\<arch>\Installed = 1`
   */
  isAlreadyInstalled(arch) {
    const regKey = `HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\${arch}`;
    return new Promise(resolve => {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const regExe = path.join(sysRoot, 'System32', 'reg.exe');
      execFile(regExe, ['query', regKey, '/v', 'Installed'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(false);
        resolve(/Installed\s+REG_DWORD\s+0x1/i.test(stdout || ''));
      });
    });
  }

  /** Download a URL to destPath using Node https (follows redirects). */
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

  /** Run the downloaded installer silently and resolve based on exit code. */
  runInstaller(installerPath) {
    return new Promise((resolve, reject) => {
      execFile(installerPath, ['/install', '/passive', '/norestart'], {
        timeout: 180000,
        windowsHide: true
      }, (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : 0;
        if (SUCCESS_EXIT_CODES.has(exitCode)) {
          console.log(`[VcRedist] Installer exited with accepted code ${exitCode}`);
          return resolve(exitCode);
        }
        return reject(new Error(
          `vc_redist installer returned exit code ${exitCode}. ` +
          `stderr: ${(stderr || '').slice(0, 200)}`
        ));
      });
    });
  }

  /**
   * Ensure VC++ Redistributable is installed for the current architecture.
   * Returns true on success (installed or already present), false on failure.
   * Never throws — callers can treat as best-effort.
   */
  async ensureInstalled() {
    if (process.platform !== 'win32') return true;

    const arch = this.getTargetArch();
    if (!arch) {
      console.log(`[VcRedist] Unsupported arch ${process.arch}, skipping.`);
      return true;
    }

    if (this.inProgress) {
      console.log('[VcRedist] Install already in progress, waiting...');
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (!this.inProgress) return !this.lastError;
      }
      return false;
    }

    this.inProgress = true;
    this.lastError = null;

    try {
      if (await this.isAlreadyInstalled(arch)) {
        console.log(`[VcRedist] ${arch} runtime already installed, skipping.`);
        return true;
      }

      const url = DOWNLOAD_URLS[arch];
      const installerPath = path.join(os.tmpdir(), `vc_redist.${arch}.exe`);

      console.log(`[VcRedist] Downloading ${url} → ${installerPath}`);
      await this.downloadFile(url, installerPath);

      console.log(`[VcRedist] Running installer silently...`);
      await this.runInstaller(installerPath);

      try { fs.unlinkSync(installerPath); } catch (e) { /* ignore */ }

      console.log(`[VcRedist] ${arch} runtime ready.`);
      return true;
    } catch (err) {
      console.error('[VcRedist] Install failed:', err);
      this.lastError = err && err.message ? err.message : String(err);
      return false;
    } finally {
      this.inProgress = false;
    }
  }
}

module.exports = new VcRedistRuntime();
