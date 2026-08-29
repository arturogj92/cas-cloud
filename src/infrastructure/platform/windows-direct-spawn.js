'use strict';

/**
 * Decide whether a Windows agent command can be spawned DIRECTLY as an .exe
 * (with the working dir set on the process — which natively supports UNC paths
 * like \\Mac\Home\... or \\wsl$\...) instead of through cmd.exe.
 *
 * WHY THIS MATTERS: spawning through cmd.exe forces a `pushd`/mapped-drive dance
 * for a UNC cwd, and the agent then records the EPHEMERAL mapped drive (e.g.
 * `U:\...`) as its workspace instead of the real UNC path. The conversation
 * history matches a conversation to a project by that recorded workspace, so the
 * mapped drive never matches the project (stored as the UNC path) and the agy
 * history shows nothing — while Claude works, because claude.exe is already
 * spawned directly and records the real UNC cwd. agy.exe behaves identically
 * (verified on the win2 ARM VM: agy.exe launches fine with a UNC cwd), so
 * spawning it directly makes its history match exactly like Claude's.
 *
 * .cmd / .bat shims (e.g. an npm-installed `codex`) still need cmd.exe, so for
 * those — or when the executable can't be resolved to a real .exe — we return
 * { mode: 'cmd' } and the caller keeps the existing cmd.exe path.
 *
 * Pure: the executable resolution is injected, so this is unit-testable.
 *
 * @param {string} rawCommand  e.g. "agy --conversation <id> --dangerously-skip-permissions"
 * @param {(token: string) => (string|null)} resolveExe  returns a real .exe abs path or null
 * @returns {{mode:'direct', exePath:string, args:string[]} | {mode:'cmd'}}
 */
function planWindowsAgentSpawn(rawCommand, resolveExe) {
  const trimmed = (rawCommand || '').trim();
  if (!trimmed) return { mode: 'cmd' };

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0];
  const args = tokens.slice(1);

  let exePath = null;
  try { exePath = resolveExe(first); } catch (_) { exePath = null; }

  if (exePath && /\.exe$/i.test(exePath)) {
    return { mode: 'direct', exePath, args };
  }
  return { mode: 'cmd' };
}

/**
 * Remove a leading POSIX `exec ` from an agent command. `exec` is a Unix shell
 * builtin (used on mac/Linux so the agent TUI replaces the wrapper shell); it
 * does not exist on Windows, where cmd.exe fails with "'exec' is not recognized
 * as an internal or external command" and the direct-.exe planner above sees
 * `exec` as the executable and never matches. Only a whole `exec` first token
 * is stripped — `execagy` / `exec.exe` are left alone.
 *
 * @param {string} rawCommand
 * @returns {string}
 */
function stripPosixExecPrefix(rawCommand) {
  if (typeof rawCommand !== 'string') return '';
  return rawCommand.replace(/^\s*exec(?:\s+|$)/, '').trim();
}

/**
 * True only for a REAL, on-disk Windows `.exe` — the one form CreateProcess (and
 * therefore node-pty) can launch DIRECTLY. An npm shim (an extensionless launcher
 * script or a `.cmd`) is not: spawning it directly dies with "%1 is not a valid
 * Win32 application". On win-arm64 there is no native claude.exe (claude installs
 * as an npm shim), so a direct spawn there kills the terminal before any xterm
 * attaches — callers must fall back to the cmd.exe path, which resolves the shim.
 * `exists` is injected so this stays pure/unit-testable.
 *
 * @param {string} p  candidate executable path
 * @param {(p:string)=>boolean} [exists]  existence check; defaults to fs.existsSync
 * @returns {boolean}
 */
function isNativeExe(p, exists) {
  if (!p || typeof p !== 'string' || !/\.exe$/i.test(p)) return false;
  const check = exists || require('fs').existsSync;
  try { return !!check(p); } catch (_) { return false; }
}

/**
 * Quote ONE token of a cmd.exe command line. Whitespace is not the only hazard:
 * cmd also treats & ^ % ( ) < > | as syntax, so an unquoted `C:\dev\foo&bar`
 * makes cmd try to run `bar`. The caller still wraps the WHOLE composed line in
 * one extra pair of quotes (cmd's `/S` rule strips that outer pair) — that is
 * exactly what Node's own `shell: true` does.
 *
 * @param {string} token
 * @returns {string}
 */
function quoteForCmd(token) {
  return /[\s&^%()<>|]/.test(String(token)) ? `"${token}"` : String(token);
}

module.exports = { planWindowsAgentSpawn, stripPosixExecPrefix, isNativeExe, quoteForCmd };
