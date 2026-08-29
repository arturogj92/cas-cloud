/**
 * windows-process-ports
 *
 * Windows equivalent of the `ps` + `lsof` pair used on mac/linux: lists the
 * processes that are LISTENING on a loopback port, together with their full
 * command line. It is the discovery half of the Antigravity quota reader, whose
 * language server only answers on 127.0.0.1 on an ephemeral port.
 *
 * Two strategies, tried in order:
 *   1. PowerShell (`Get-NetTCPConnection` + `Get-CimInstance Win32_Process`),
 *      joined INSIDE PowerShell so one spawn returns everything as JSON. This is
 *      the only path that yields the full command line, and therefore the only
 *      one that can recover the desktop app's `--csrf_token`.
 *   2. `netstat -ano` + `tasklist` when PowerShell is unavailable or blocked.
 *      Gives image names only (no command line, so no CSRF token), which is
 *      still enough to reach the `agy` CLI language server.
 *
 * Both parsers are locale-independent: `netstat` translates the "LISTENING"
 * state on non-English Windows, so listening sockets are recognised by their
 * `0.0.0.0:0` / `[::]:0` foreign address instead of by that word.
 *
 * Everything degrades to an empty list and NEVER throws.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Shelling out must stay bounded: this runs on the quota poller and on window
// focus, so a hung console can never stall the UI.
const COMMAND_TIMEOUT_MS = 6000;
// Command lines are long; the whole payload still fits comfortably here.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * PowerShell that emits `{"items":[{pid, command, ports:[...]}]}` for every
 * process listening on loopback. Processes WITHOUT a loopback socket are
 * dropped inside PowerShell so the payload stays small.
 *
 * Written as one line on purpose: it travels base64-encoded through
 * `-EncodedCommand`, which sidesteps every layer of Windows argument quoting.
 * Note `$procId` rather than `$pid` — `$pid` is a PowerShell automatic variable.
 */
const POWERSHELL_SCRIPT = [
    '$ErrorActionPreference = "SilentlyContinue";',
    '$byPid = @{};',
    'foreach ($c in (Get-NetTCPConnection -State Listen)) {',
    '  if ($c.LocalAddress -eq "127.0.0.1" -or $c.LocalAddress -eq "::1") {',
    '    $procId = [int]$c.OwningProcess;',
    '    if (-not $byPid.ContainsKey($procId)) { $byPid[$procId] = New-Object System.Collections.ArrayList };',
    '    [void]$byPid[$procId].Add([int]$c.LocalPort);',
    '  }',
    '};',
    '$items = foreach ($p in (Get-CimInstance Win32_Process)) {',
    '  $procId = [int]$p.ProcessId;',
    '  if ($byPid.ContainsKey($procId)) {',
    '    [pscustomobject]@{ pid = $procId; command = [string]$p.CommandLine; ports = @($byPid[$procId]) }',
    '  }',
    '};',
    'ConvertTo-Json -InputObject @{ items = @($items) } -Compress -Depth 4'
].join(' ');

/**
 * Base64/UTF-16LE encoding of the script, as `-EncodedCommand` expects.
 * @param {string} script
 * @returns {string}
 */
function encodePowerShellCommand(script) {
    return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * Parse the JSON emitted by POWERSHELL_SCRIPT into the common shape.
 * Tolerates an empty/garbled payload by returning an empty list.
 * @param {string} stdout
 * @returns {Array<{pid: string, command: string, ports: number[]}>}
 */
function parsePowerShellOutput(stdout) {
    try {
        const parsed = JSON.parse(String(stdout || '').trim());
        const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
        const result = [];
        for (const item of items) {
            if (!item || item.pid == null) continue;
            // A single port comes back as a bare number, not a one-element array.
            const rawPorts = Array.isArray(item.ports)
                ? item.ports
                : (item.ports == null ? [] : [item.ports]);
            const ports = rawPorts
                .map((port) => parseInt(port, 10))
                .filter((port) => Number.isFinite(port));
            if (ports.length === 0) continue;
            result.push({
                pid: String(item.pid),
                command: typeof item.command === 'string' ? item.command : '',
                ports
            });
        }
        return result;
    } catch (_err) {
        return [];
    }
}

/**
 * Parse `netstat -ano`, keeping only loopback sockets in the LISTENING state.
 *
 * The state word is localized on non-English Windows, so it is NOT matched.
 * A listening TCP row is identified structurally instead: 5 columns, and a
 * foreign address of `0.0.0.0:0` or `[::]:0`.
 * @param {string} stdout
 * @returns {Object<string, number[]>} pid -> loopback ports
 */
function parseNetstatOutput(stdout) {
    const byPid = {};
    for (const rawLine of String(stdout || '').split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('TCP')) continue;

        const columns = line.split(/\s+/);
        if (columns.length < 5) continue;

        const [, localAddress, foreignAddress, , pid] = columns;
        if (!/:0$/.test(foreignAddress)) continue;
        if (!/^\d+$/.test(pid)) continue;

        // `127.0.0.1:51721` or `[::1]:51721` — take the port after the LAST colon.
        const separator = localAddress.lastIndexOf(':');
        if (separator === -1) continue;
        const host = localAddress.slice(0, separator);
        const port = parseInt(localAddress.slice(separator + 1), 10);
        if (!Number.isFinite(port)) continue;
        if (host !== '127.0.0.1' && host !== '[::1]') continue;

        if (!byPid[pid]) byPid[pid] = [];
        if (!byPid[pid].includes(port)) byPid[pid].push(port);
    }
    return byPid;
}

/**
 * Parse `tasklist /FO CSV /NH` into pid -> image name. The image name stands in
 * for the command line in the fallback path, so a CSRF token cannot be
 * recovered there — only the token-less `agy` CLI server is reachable.
 * @param {string} stdout
 * @returns {Object<string, string>} pid -> image name
 */
function parseTasklistOutput(stdout) {
    const byPid = {};
    for (const rawLine of String(stdout || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // "agy.exe","12345","Console","1","12,345 K"
        const match = line.match(/^"([^"]*)","(\d+)"/);
        if (!match) continue;
        byPid[match[2]] = match[1];
    }
    return byPid;
}

/**
 * List every process listening on a loopback port, with its command line.
 *
 * `runProc` is injectable so tests need neither PowerShell nor netstat.
 * @param {object} [deps]
 * @param {(cmd: string, args: string[], options?: object) => Promise<{stdout: string}>} [deps.runProc]
 * @returns {Promise<Array<{pid: string, command: string, ports: number[]}>>}
 */
async function listLoopbackListeners({ runProc } = {}) {
    const exec = runProc || execFileAsync;
    const options = {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true // never flash a console window at the user
    };

    try {
        const { stdout } = await exec(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-EncodedCommand',
                encodePowerShellCommand(POWERSHELL_SCRIPT)
            ],
            options
        );
        // An empty result is legitimate (nothing listening on loopback), so it is
        // NOT retried through the fallback — that only runs when PowerShell
        // itself could not run.
        return parsePowerShellOutput(stdout);
    } catch (_err) {
        // PowerShell missing, blocked by policy, or timed out — try netstat.
    }

    return listLoopbackListenersViaNetstat(exec, options);
}

/**
 * Fallback discovery: `netstat -ano` for the ports, `tasklist` for the names.
 * Never throws.
 * @param {(cmd: string, args: string[], options?: object) => Promise<{stdout: string}>} exec
 * @param {object} options
 * @returns {Promise<Array<{pid: string, command: string, ports: number[]}>>}
 */
async function listLoopbackListenersViaNetstat(exec, options) {
    let portsByPid = {};
    try {
        const { stdout } = await exec('netstat', ['-ano'], options);
        portsByPid = parseNetstatOutput(stdout);
    } catch (_err) {
        return [];
    }

    const pids = Object.keys(portsByPid);
    if (pids.length === 0) return [];

    let namesByPid = {};
    try {
        const { stdout } = await exec('tasklist', ['/FO', 'CSV', '/NH'], options);
        namesByPid = parseTasklistOutput(stdout);
    } catch (_err) {
        // Names are best-effort: without them nothing can be classified, but an
        // empty command still produces a well-formed (ignored) entry.
    }

    return pids.map((pid) => ({
        pid,
        command: namesByPid[pid] || '',
        ports: portsByPid[pid]
    }));
}

module.exports = {
    listLoopbackListeners,
    // Exported for unit tests.
    encodePowerShellCommand,
    parsePowerShellOutput,
    parseNetstatOutput,
    parseTasklistOutput,
    POWERSHELL_SCRIPT
};
