/**
 * Kimi Code CLI Installer Service
 * Detects and installs Moonshot's Kimi Code CLI (https://moonshotai.github.io/kimi-code/).
 *
 * Installation methods:
 * - curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash   (official, no Node needed)
 * - irm https://code.kimi.com/kimi-code/install.ps1 | iex          (Windows)
 * - npm install -g @moonshot-ai/kimi-code                          (needs Node >= 22.19.0)
 *
 * ============================ THE LINEAGE TRAP ============================
 * "Kimi" is TWO different products from the same team, and the naming is inverted
 * relative to what you would guess:
 *
 *   MoonshotAI/kimi-code  -> TypeScript, MIT, data in ~/.kimi-code, versions 0.x
 *                            npm `@moonshot-ai/kimi-code`, binary `kimi`.   <-- WE TARGET THIS
 *   MoonshotAI/kimi-cli   -> Python, Apache-2.0, data in ~/.kimi, versions 1.4x
 *                            pip `kimi-cli`, binaries `kimi` AND `kimi-cli`. Legacy,
 *                            being wound down, but has ~3x the GitHub stars, so blogs
 *                            and search results send users to it.
 *
 * Both claim the `kimi` command. Worse, the pip package literally named `kimi-code` is an
 * EMPTY alias meta-package (`Requires-Dist: kimi-cli==1.49.0`) whose console script is
 * `kimi-code` -> the PYTHON agent. So the command name tells you nothing.
 *
 * => Detection must NEVER key on the command name. We identify the lineage the same
 *    way Moonshot's own installer does: sniffing the first 4096 bytes for the
 *    `kimi_cli` marker that every Python shim carries (no subprocess — the real
 *    binary takes 1.7-4.5s just to answer --version, measured on v0.26.0).
 *
 * Also note the official installer MUTATES the user's system: it walks $PATH, sniffs each
 * `kimi` for the `kimi_cli` marker, renames the first Python shim to `kimi-legacy` and
 * deletes later duplicates. A cached absolute path can therefore be invalidated underneath
 * us, which is why isInstalled()/getKimiPath() re-probe rather than trusting a stored path.
 * =========================================================================
 */

const { dialog } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodeRuntime = require('./node-runtime');
const { streamingExec } = require('./streaming-exec');

class KimiCliInstaller {
  constructor() {
    this.installInProgress = false;
    this.lastError = null;
    // Official npm package (the TypeScript lineage). Only used for the npm fallback.
    this.packageName = '@moonshot-ai/kimi-code';
  }

  getLastError() {
    return this.lastError;
  }

  /**
   * Default install location of the official script: ${KIMI_INSTALL_DIR}/bin/kimi,
   * where KIMI_INSTALL_DIR defaults to ~/.kimi-code.
   *
   * This path matters more than for other agents: install.sh appends the bin dir to the
   * user's SHELL RC, and a GUI-launched Electron app does not inherit shell-rc PATH. So a
   * PATH-only detector misses a perfectly good install. Probe the real path first.
   * @returns {string}
   */
  getNativeInstallPath() {
    const home = os.homedir();
    const base = process.env.KIMI_INSTALL_DIR || path.join(home, '.kimi-code');
    return process.platform === 'win32'
      ? path.join(base, 'bin', 'kimi.exe')
      : path.join(base, 'bin', 'kimi');
  }

  /**
   * Check if a usable (TypeScript-lineage) Kimi Code CLI is installed.
   * @returns {boolean}
   */
  isInstalled(env = process.env) {
    return this.getKimiPath(env) !== null;
  }

  /**
   * Whether the ONLY thing we can find is the deprecated Python kimi-cli.
   * Used to show an honest message ("you have the legacy CLI") instead of a bare
   * "not installed", since the legacy project is the one most users land on first.
   * @returns {boolean}
   */
  hasOnlyLegacyInstall() {
    if (this.getKimiPath() !== null) return false;
    return this._legacyCandidates().length > 0;
  }

  /**
   * Common install locations on Unix. The native script path is first: it is both the
   * documented default and the one an Electron app is most likely to miss via PATH.
   * @returns {string[]}
   */
  getUnixCommonPaths() {
    const home = os.homedir();
    const paths = [this.getNativeInstallPath()];

    const staticPaths = [
      '/usr/local/bin/kimi',
      '/usr/bin/kimi',
      '/opt/homebrew/bin/kimi',
      `${home}/.local/bin/kimi`,
      `${home}/.volta/bin/kimi`,
      `${home}/.local/share/pnpm/kimi`,
      `${home}/Library/pnpm/kimi`,
      `${home}/.yarn/bin/kimi`,
      `${home}/.asdf/shims/kimi`,
    ];
    paths.push(...staticPaths);

    // nvm: check all installed node versions (npm channel)
    const nvmVersionsDir = `${home}/.nvm/versions/node`;
    try {
      if (fs.existsSync(nvmVersionsDir)) {
        fs.readdirSync(nvmVersionsDir).forEach(v => {
          paths.push(`${nvmVersionsDir}/${v}/bin/kimi`);
        });
      }
    } catch (e) { /* ignore */ }

    // fnm
    const fnmVersionsDir = `${home}/.fnm/node-versions`;
    try {
      if (fs.existsSync(fnmVersionsDir)) {
        fs.readdirSync(fnmVersionsDir).forEach(v => {
          paths.push(`${fnmVersionsDir}/${v}/installation/bin/kimi`);
        });
      }
    } catch (e) { /* ignore */ }

    return [...new Set(paths)];
  }

  /**
   * Possible install paths on Windows.
   * @returns {string[]}
   */
  getPossiblePaths() {
    if (process.platform !== 'win32') return [];

    const userProfile = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');

    return [...new Set([
      this.getNativeInstallPath(),
      path.join(userProfile, '.kimi-code', 'bin', 'kimi.exe'),
      path.join(appData, 'npm', 'kimi.cmd'),
      path.join(appData, 'npm', 'kimi.exe'),
      path.join(appData, 'npm', 'kimi'),
    ])];
  }

  /**
   * Resolve the path of a TypeScript-lineage `kimi`, or null.
   *
   * Every candidate is content-sniffed, because the Python legacy CLI installs the
   * SAME `kimi` command and would otherwise be launched silently. Cached anyway:
   * this sits on the per-terminal spawn path.
   * @returns {string|null}
   */
  getKimiPath(env = process.env) {
    if (this._resolvedComputed) return this._resolved;
    this._resolvedComputed = true;
    this._resolved = this._computeKimiPath(env);
    return this._resolved;
  }

  /**
   * Drop the cached resolution. The official installer renames/removes `kimi` binaries on
   * PATH, so a path resolved before an install can be stale afterwards.
   */
  invalidateCache() {
    this._resolvedComputed = false;
    this._resolved = null;
  }

  _computeKimiPath(env = process.env) {
    for (const candidate of this._allCandidates(env)) {
      if (this._isSupportedLineage(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** Every `kimi` we can find, known paths first, then PATH order. */
  _allCandidates(env = process.env) {
    const known = (process.platform === 'win32' ? this.getPossiblePaths() : this.getUnixCommonPaths())
      .filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

    const onPath = [];
    try {
      const cmd = process.platform === 'win32' ? 'where.exe kimi' : 'which -a kimi';
      const out = execSync(cmd, { env, stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
      onPath.push(...out.split('\n').map(s => s.trim()).filter(Boolean));
    } catch (e) { /* nothing on PATH */ }

    return [...new Set([...known, ...onPath])];
  }

  /** Candidates that ARE resolvable but belong to the deprecated Python lineage. */
  _legacyCandidates() {
    return this._allCandidates().filter(p => this._isLegacyShim(p));
  }

  /**
   * True when the binary belongs to the TypeScript kimi-code lineage.
   *
   * Detection is a CONTENT SNIFF, not a subprocess: the deprecated Python kimi-cli
   * installs pip console-script shims whose first bytes import `kimi_cli`, and
   * Moonshot's own install.sh/install.ps1 identify legacy shims by exactly that
   * marker in the first 4096 bytes. Anything without the marker (the 150+ MB
   * single binary, or the npm wrapper) is the supported lineage.
   *
   * Why not `--version`? The kimi binary takes 1.7-4.5 SECONDS to answer it
   * (measured on v0.26.0, even with KIMI_CODE_NO_AUTO_UPDATE=1) — a probe with a
   * timeout is flaky detection, and this sits on the per-terminal spawn path where
   * a multi-second subprocess is a known launch tarpit.
   */
  _isSupportedLineage(binPath) {
    const head = this._readHead(binPath);
    if (head === null) return false; // unreadable — do not claim it
    if (head.includes('kimi_cli')) {
      console.log(`[KimiInstaller] Ignoring legacy Python kimi-cli shim at: ${binPath}`);
      return false;
    }
    return true;
  }

  /** True when the binary is a deprecated Python kimi-cli shim. */
  _isLegacyShim(binPath) {
    const head = this._readHead(binPath);
    return head !== null && head.includes('kimi_cli');
  }

  /** First 4096 bytes of a file as latin1 (same window install.sh sniffs), or null. */
  _readHead(binPath) {
    let fd;
    try {
      fd = fs.openSync(binPath, 'r');
      const buf = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buf, 0, 4096, 0);
      return buf.toString('latin1', 0, bytes);
    } catch (e) {
      return null;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (e) { /* ignore */ }
      }
    }
  }

  /**
   * The command shown to the user / run to install. The official script is preferred over
   * npm because it ships a single binary and needs no Node at all.
   * @returns {string}
   */
  getInstallCommand() {
    if (process.platform === 'win32') {
      return 'powershell -NoProfile -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"';
    }
    return 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
  }

  /**
   * npm install of the TypeScript lineage. This is the ONLY route on platforms Moonshot
   * ships no prebuilt binary for — notably Windows on ARM, where the official installer
   * fails with `platform win32-arm64 arm64 not found in manifest` (confirmed on win2,
   * 2026-07-19). Needs Node >= 22.19.0.
   * @returns {string}
   */
  getNpmInstallCommand() {
    return `npm install -g ${this.packageName}`;
  }

  /** Node >= 22.19.0 is required by the npm package. Returns {ok, version} (version may be null). */
  _detectNode(env = process.env) {
    try {
      const raw = execSync('node --version', {
        encoding: 'utf8',
        timeout: 10000,
        shell: process.platform === 'win32' ? undefined : '/bin/bash',
        env,
      }).trim();
      const m = raw.match(/v?(\d+)\.(\d+)\.(\d+)/);
      if (!m) return { ok: false, version: raw || null };
      const major = Number(m[1]);
      const minor = Number(m[2]);
      const ok = major > 22 || (major === 22 && minor >= 19);
      return { ok, version: raw };
    } catch (e) {
      return { ok: false, version: null };
    }
  }

  /** Keep the tail of a captured stream so a huge log doesn't blow up the modal. */
  _tail(text, max = 2000) {
    const s = String(text || '').trim();
    return s.length > max ? `…${s.slice(-max)}` : s;
  }

  /**
   * Run one install command through streamingExec, streaming lines to onProgress and
   * capturing the REAL failure text. Kimi's official installer prints its fatal error
   * (e.g. "not found in manifest") to STDOUT, not stderr, so we must fall back to stdout
   * when stderr is empty — otherwise the modal shows only the generic exec message.
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
          env: runOptions.env,
        },
        (error, stdout, stderr) => {
          if (error) {
            const real = this._tail(stderr) || this._tail(stdout) || error.message;
            resolve({ ok: false, output: real });
            return;
          }
          console.log('[KimiInstaller] Install output:', String(stdout).slice(-500));
          resolve({ ok: true, output: '' });
        },
        onProgress
      );
    });
  }

  /**
   * Install the Kimi Code CLI. Tries the official installer first; if it can't produce a
   * working binary (the win-arm64 case), auto-falls back to `npm install -g` when a
   * new-enough Node is present.
   * @param {BrowserWindow} mainWindow
   * @returns {Promise<boolean>}
   */
  async install(mainWindow, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    if (this.installInProgress) {
      console.log('[KimiInstaller] Install already in progress');
      return false;
    }
    this.installInProgress = true;
    this.lastError = null;
    onStage('checking');

    try {
      const installEnv = options.env || process.env;
      // 1) Official single-binary installer (preferred: no Node needed).
      onStage('installing');
      let official;
      if (process.platform === 'win32') {
        // Defender flags the `irm … | iex` one-liner as malware and blocks the
        // spawn — see windows-install-script.js. Download + run -File instead.
        let winScriptPath = null;
        try {
          const { planWindowsPs1Install } = require('./windows-install-script');
          const plan = await planWindowsPs1Install('https://code.kimi.com/kimi-code/install.ps1', 'kimi-install.ps1');
          winScriptPath = plan.scriptPath;
          console.log(`[KimiInstaller] Installing with: ${plan.command} ${plan.args.join(' ')}`);
          official = await this._runCommand(plan.command, onProgress, { args: plan.args, shell: false, env: installEnv });
        } catch (downloadErr) {
          official = { ok: false, output: `Download of the Kimi installer script failed: ${downloadErr.message}` };
        } finally {
          if (winScriptPath) { try { fs.unlinkSync(winScriptPath); } catch (e) { /* ignore */ } }
        }
      } else {
        const officialCommand = this.getInstallCommand();
        console.log(`[KimiInstaller] Installing with: ${officialCommand}`);
        official = await this._runCommand(officialCommand, onProgress, { env: installEnv });
      }
      // The installer renames/removes other `kimi` binaries, so any resolved path is stale.
      this.invalidateCache();

      if (this.isInstalled(installEnv)) {
        onStage('verifying');
        return true;
      }
      if (!official.ok) this.lastError = official.output;

      // 2) Fallback to npm when the official installer couldn't provide a binary for this
      //    platform (Windows on ARM has no published binary). Only when Node supports it.
      const node = this._detectNode(installEnv);
      if (node.ok) {
        onProgress('');
        onProgress('==> Official installer did not provide a binary for this platform. Falling back to npm…');
        onStage('installing');
        const npmCommand = await nodeRuntime.resolveNpmPath(installEnv);
        const npm = npmCommand
          ? await this._runCommand(npmCommand, onProgress, {
            args: ['install', '--global', this.packageName],
            env: installEnv,
            shell: false,
          })
          : { ok: false, output: `npm was not found on PATH: ${installEnv.PATH || '(empty)'}` };
        this.invalidateCache();
        if (this.isInstalled(installEnv)) {
          onStage('verifying');
          return true;
        }
        if (!npm.ok) {
          this.lastError = `Official installer:\n${official.output || '(no output)'}\n\nnpm fallback:\n${npm.output || '(no output)'}`;
        }
      } else {
        const detail = node.version
          ? `Node ${node.version} is too old (npm install needs Node >= 22.19).`
          : 'Node was not found (npm install needs Node >= 22.19).';
        onProgress('');
        onProgress(`==> ${detail} Skipping npm fallback — use the manual npm command after installing Node.`);
        this.lastError = `${official.output || 'Kimi Code CLI was not installed.'}\n\n${detail}`;
      }

      this.lastError = this.lastError || 'Kimi Code CLI was not found after installation';
      return false;
    } catch (e) {
      this.lastError = e.message;
      console.error('[KimiInstaller] Install threw:', e);
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

    const legacyOnly = this.hasOnlyLegacyInstall();
    const detail = legacyOnly
      ? 'Found the deprecated Python "kimi-cli" instead of Kimi Code CLI. They share the `kimi` command but are different products. Installing Kimi Code CLI will rename the old one to `kimi-legacy` so both stay available.'
      : 'Kimi Code CLI is required to run this agent.';

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install Kimi Code CLI',
      message: 'Kimi Code CLI is not installed',
      detail: `${detail}\n\nInstall it now with:\n${this.getInstallCommand()}`,
    });

    if (response !== 0) return false;
    return this.install(mainWindow);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
const installer = new KimiCliInstaller();

module.exports = {
  KimiCliInstaller,
  isInstalled: (env) => installer.isInstalled(env),
  hasOnlyLegacyInstall: () => installer.hasOnlyLegacyInstall(),
  getKimiPath: () => installer.getKimiPath(),
  getNativeInstallPath: () => installer.getNativeInstallPath(),
  getInstallCommand: () => installer.getInstallCommand(),
  invalidateCache: () => installer.invalidateCache(),
  install: (mainWindow, options) => installer.install(mainWindow, options),
  ensureInstalled: (mainWindow) => installer.ensureInstalled(mainWindow),
  getLastError: () => installer.getLastError(),
};
