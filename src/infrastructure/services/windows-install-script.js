/**
 * Windows Defender's ML classifier flags the `powershell -Command "irm <url> | iex"`
 * process shape (the one-liner most CLI vendors document) as
 * Trojan:Win32/Commando.A!ml — Severe — and BLOCKS the spawn with "Access is
 * denied" (reproduced against a real Windows 11 VM on 2026-08-15; see
 * docs/diagnostics/agy-windows-install-defender-block.md). The user-visible
 * symptom is an install that fails instantly with no output.
 *
 * So installers must never run a download-pipe-execute command line. This
 * helper downloads the vendor's official install.ps1 over HTTPS from Node and
 * returns a plain `powershell -File <script>` invocation for streamingExec
 * (shell: false — no cmd.exe hop either).
 */
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

/**
 * @param {string} url        The vendor's official install.ps1 URL.
 * @param {string} tmpFileName Temp file name for the downloaded script.
 * @returns {Promise<{command: string, args: string[], scriptPath: string}>}
 */
async function planWindowsPs1Install(url, tmpFileName) {
  const { downloadViaHttps } = require('./claude-code-installer');
  const extension = path.extname(tmpFileName) || '.ps1';
  const base = path.basename(tmpFileName, extension);
  const scriptPath = path.join(os.tmpdir(), `${base}-${process.pid}-${crypto.randomUUID()}${extension}`);
  try {
    await downloadViaHttps(url, scriptPath);
  } catch (error) {
    try { fs.unlinkSync(scriptPath); } catch (_) { /* no partial file was created */ }
    throw error;
  }
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return {
    command: path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    scriptPath,
  };
}

module.exports = { planWindowsPs1Install };
