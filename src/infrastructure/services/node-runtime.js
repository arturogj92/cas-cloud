/**
 * Node.js Runtime Bootstrap Service
 *
 * Ensures a usable Node.js runtime (with npm) is available on Windows without
 * requiring the user to install Node manually or have admin privileges.
 *
 * Strategy on Windows:
 *   1. If host has `npm` on PATH → no-op.
 *   2. Else if our bundled portable Node already extracted → no-op.
 *   3. Else download portable Node zip via Node's built-in https module
 *      (does NOT rely on curl being on PATH) and extract via tar.exe from
 *      the absolute SystemRoot path (does NOT rely on tar being on PATH).
 *
 * Using Node's `https` + absolute tool paths makes this robust against
 * Electron portable apps having a minimal process.env.PATH.
 */

const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NODE_VERSION = 'v20.18.0';
const NODE_ARCH_BY_PROCESS = { x64: 'x64', arm64: 'arm64', ia32: 'x86' };

class NodeRuntime {
  constructor() {
    this.runtimeRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'CodeAgentSwarm', 'runtime');
    this.nodeDir = path.join(this.runtimeRoot, 'node');
    this.bootstrapInProgress = false;
    this.lastError = null;
  }

  getBinDir() {
    if (process.platform !== 'win32') return null;
    return this.nodeDir;
  }

  /** Return absolute path to bundled Node dir (prefix for global installs), or null. */
  getNodeDir() {
    if (process.platform !== 'win32') return null;
    return this.bundledExists() ? this.nodeDir : null;
  }

  resolveNpmPath(env = process.env) {
    return new Promise(resolve => {
      const cmd = process.platform === 'win32'
        ? this.getSystemBinaryPath('where.exe')
        : '/usr/bin/which';
      execFile(cmd, ['npm'], { env, timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) { resolve(null); return; }
        const paths = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (process.platform === 'win32') {
          resolve(paths.find(p => /\.cmd$/i.test(p)) || paths.find(p => /\.exe$/i.test(p)) || paths[0] || null);
          return;
        }
        resolve(paths[0] || null);
      });
    });
  }

  async hostHasNpm(env = process.env) {
    return Boolean(await this.resolveNpmPath(env));
  }

  hostHasNodeVersion(minimumMajor, env = process.env) {
    return new Promise(resolve => {
      execFile('node', ['--version'], { env, timeout: 5000, windowsHide: true }, (error, stdout) => {
        const match = !error && String(stdout || '').trim().match(/^v(\d+)/);
        resolve(Boolean(match && Number(match[1]) >= minimumMajor));
      });
    });
  }

  bundledExists() {
    if (process.platform !== 'win32') return false;
    return fs.existsSync(path.join(this.nodeDir, 'npm.cmd'));
  }

  bundledMeetsVersion(minimumMajor = 0) {
    const bundledMajor = Number.parseInt(NODE_VERSION.slice(1), 10);
    return this.bundledExists() && bundledMajor >= minimumMajor;
  }

  /**
   * Resolve a Windows system binary to its absolute path. Does NOT depend on
   * process.env.PATH being correct. Uses %SystemRoot% (set by OS) or a sensible fallback.
   */
  getSystemBinaryPath(binary) {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const candidates = [
      path.join(sysRoot, 'System32', binary),
      path.join(sysRoot, 'SysWOW64', binary),
      path.join(sysRoot, binary)
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return binary; // let the caller's spawn fail with a clearer ENOENT
  }

  /**
   * Download a URL to a file path using Node's built-in https (follows redirects).
   */
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

  /**
   * Extract a zip into destDir using tar.exe at its absolute SystemRoot path.
   * Falls back to PowerShell Expand-Archive if tar.exe isn't available.
   */
  extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const tarPath = this.getSystemBinaryPath('tar.exe');
      execFile(tarPath, ['-xf', zipPath, '-C', destDir], { timeout: 120000, windowsHide: true }, (err) => {
        if (!err) return resolve();
        // Fallback: PowerShell Expand-Archive
        const psPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
        execFile(psPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { timeout: 120000, windowsHide: true }, (err2) => {
          if (err2) return reject(new Error(`Extraction failed. tar error: ${err.message}. PowerShell error: ${err2.message}`));
          resolve();
        });
      });
    });
  }

  async downloadAndExtract() {
    const arch = NODE_ARCH_BY_PROCESS[process.arch] || 'x64';
    const archiveName = `node-${NODE_VERSION}-win-${arch}.zip`;
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`;
    const zipPath = path.join(os.tmpdir(), archiveName);

    fs.mkdirSync(this.runtimeRoot, { recursive: true });

    console.log(`[NodeRuntime] Downloading ${url} → ${zipPath}`);
    await this.downloadFile(url, zipPath);

    console.log(`[NodeRuntime] Extracting ${zipPath} → ${this.runtimeRoot}`);
    await this.extractZip(zipPath, this.runtimeRoot);

    const extractedDir = path.join(this.runtimeRoot, `node-${NODE_VERSION}-win-${arch}`);
    if (fs.existsSync(extractedDir)) {
      if (fs.existsSync(this.nodeDir)) {
        fs.rmSync(this.nodeDir, { recursive: true, force: true });
      }
      fs.renameSync(extractedDir, this.nodeDir);
    }

    try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }

    return this.bundledExists();
  }

  async ensureInstalled(minimumMajor = 0, env = process.env) {
    const hostReady = minimumMajor > 0
      ? await this.hostHasNodeVersion(minimumMajor, env) && await this.hostHasNpm(env)
      : await this.hostHasNpm(env);
    if (process.platform !== 'win32') return hostReady;
    if (hostReady) return true;
    if (this.bundledMeetsVersion(minimumMajor)) return true;

    if (this.bootstrapInProgress) {
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (this.bundledMeetsVersion(minimumMajor)) return true;
      }
      return false;
    }

    this.bootstrapInProgress = true;
    this.lastError = null;
    try {
      await this.downloadAndExtract();
      return this.bundledMeetsVersion(minimumMajor);
    } catch (err) {
      console.error('[NodeRuntime] Bootstrap error:', err);
      this.lastError = err && err.message ? err.message : String(err);
      return false;
    } finally {
      this.bootstrapInProgress = false;
    }
  }

  /** Return the last bootstrap error (or null) — useful for rich error dialogs. */
  getLastError() {
    return this.lastError;
  }

  getEnvWithNode(baseEnv = process.env) {
    const env = { ...baseEnv };
    if (process.platform === 'win32' && this.bundledExists()) {
      env.PATH = `${this.nodeDir}${path.delimiter}${env.PATH || ''}`;
    }
    return env;
  }

  /**
   * Prepend our bundled Node directory to process.env.PATH so any child process
   * spawned by the app (including terminals running `gemini`, `codex`, or `npx`)
   * can resolve those binaries. No-op if host already has Node or we have no bundle.
   * Idempotent: will not double-prepend.
   */
  applyToProcessEnv() {
    if (process.platform !== 'win32') return false;
    if (!this.bundledExists()) return false;
    const currentPath = process.env.PATH || '';
    if (!currentPath.split(path.delimiter).includes(this.nodeDir)) {
      process.env.PATH = `${this.nodeDir}${path.delimiter}${currentPath}`;
    }
    return true;
  }
}

module.exports = new NodeRuntime();
