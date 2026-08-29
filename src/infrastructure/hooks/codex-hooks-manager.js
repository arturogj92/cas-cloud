/**
 * CodexHooksManager - Hook management for OpenAI Codex CLI
 *
 * IMPORTANT: Codex has a DIFFERENT config format than Claude/Gemini (TOML, not JSON),
 * but as of Codex CLI 0.142 it DOES have a full hooks system (the `hooks` feature flag
 * is stable + true), including PreToolUse. We use it for two things:
 *
 *  1. `notify` mechanism (TOML `notify` key): desktop notifications.
 *      - notify receives JSON as argv[1], not environment variables.
 *      - Supported events: agent-turn-complete, approval-requested.
 *      - agent-turn-complete -> Claude's Stop / Gemini's AfterAgent
 *      - approval-requested  -> Claude's Notification / Gemini's Notification
 *
 *  2. `[[hooks.PreToolUse]]` TITLE REMINDER (matcher "*"): a non-blocking nudge
 *      shared verbatim with Claude Code. While the terminal is untitled the script
 *      prints a Claude-shaped additionalContext JSON and NEVER a permissionDecision;
 *      if Codex ignores the field the hook is a silent no-op — it can never block.
 *      CAS-only: the script no-ops outside a CodeAgentSwarm terminal.
 *
 * Codex still has NO file-change tracking (no PostToolUse snapshot/compare) — those
 * methods remain no-ops so the cross-agent service can call them uniformly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeReadConfigFile } = require('../../shared/utils/safe-config-reader');
const titleGateScript = require('./title-gate-script');

/**
 * Insert or replace the TOML `notify` line in a Codex config.toml body.
 * Pure + line-anchored so it also HEALS a malformed value: an older CAS version
 * once wrote `notify = [...]"]` (a stray trailing `"]`), which broke
 * `codex app-server` config loading (`unexpected key or value, expected newline`).
 * The previous array-only regex (/notify\s*=\s*\[.*?\]/) stopped at the FIRST `]`
 * and left the stray token behind; replacing the WHOLE line fixes it. Codex always
 * writes notify on a single line, so a line-anchored match is both correct and safe.
 * @param {string} existingContent - current config.toml body ('' if none)
 * @param {Array<string>} notifyValue - the notify command array
 * @returns {string} the updated config body
 */
function upsertCodexNotifyLine(existingContent, notifyValue) {
    const notifyLine = `notify = ${JSON.stringify(notifyValue)}`;
    const content = existingContent || '';
    const notifyLineRe = /^[ \t]*notify[ \t]*=.*$/m;
    if (notifyLineRe.test(content)) {
        return content.replace(notifyLineRe, notifyLine);
    }
    // No notify line yet: insert after the leading comment/blank block.
    const lines = content.split('\n');
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) { insertIndex = i; break; }
        insertIndex = i + 1;
    }
    lines.splice(insertIndex, 0, notifyLine);
    return lines.join('\n');
}

class CodexHooksManager {
    constructor(options = {}) {
        this.configPath = path.join(os.homedir(), '.codex', 'config.toml');
        this.isDevMode = options.isDevMode || false;
        // Use same ports as other agents for webhook server
        this.webhookPort = this.isDevMode ? 45783 : 45782;
        this.hooksScriptsDir = path.join(os.homedir(), '.codeagentswarm', 'hooks');
        this.isWindows = process.platform === 'win32';

        console.log(`[CodexHooksManager] Initialized (${this.isDevMode ? 'DEV' : 'PROD'} mode, port ${this.webhookPort}, platform: ${this.isWindows ? 'Windows' : 'Unix'})`);
    }

    /**
     * Convert Windows paths to Unix format for shell compatibility
     * @param {string} filePath - Path to convert
     * @returns {string} - Path with forward slashes
     */
    toUnixPath(filePath) {
        return filePath.replace(/\\/g, '/');
    }

    /**
     * Ensure hooks scripts directory exists
     */
    async ensureHooksDirectory() {
        if (!fs.existsSync(this.hooksScriptsDir)) {
            fs.mkdirSync(this.hooksScriptsDir, { recursive: true });
            console.log('[CodexHooksManager] Created hooks directory:', this.hooksScriptsDir);
        }
    }

    /**
     * Ensure config directory exists
     */
    async ensureConfigDirectory() {
        const configDir = path.dirname(this.configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
            console.log('[CodexHooksManager] Created config directory:', configDir);
        }
    }

    /**
     * Read Codex config.toml file
     * Uses simple parsing since TOML is straightforward for our needs
     * @returns {Object} Parsed config or empty object
     */
    async readConfig() {
        try {
            await this.ensureConfigDirectory();

            const content = safeReadConfigFile(this.configPath);
            if (content === null) {
                return {};
            }
            return this.parseToml(content);
        } catch (error) {
            console.error('[CodexHooksManager] Error reading config:', error);
            return {};
        }
    }

    /**
     * Splits a TOML table header path on `.` while respecting `"..."` quoted
     * segments. A naive `header.split('.')` mis-parses real-world Codex
     * configs like:
     *   [projects."/Users/example/Projects/my.app"]
     * where the dots INSIDE the quotes are part of a single segment, not
     * separators. Same class of bug we fixed in mcp-sync-service (f62b4dd);
     * this is the equivalent for codex-hooks-manager.
     * @param {string} header
     * @returns {string[]}
     */
    splitTomlTablePath(header) {
        const out = [];
        let current = '';
        let inQuote = false;
        for (let i = 0; i < header.length; i++) {
            const ch = header[i];
            if (ch === '"' && header[i - 1] !== '\\') {
                inQuote = !inQuote;
                current += ch;
            } else if (ch === '.' && !inQuote) {
                if (current.length > 0) out.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.length > 0) out.push(current);
        return out;
    }

    /**
     * Simple TOML parser for Codex config
     * Only handles the subset of TOML we need (flat keys, arrays, tables)
     * @param {string} content - TOML content
     * @returns {Object} Parsed object
     */
    parseToml(content) {
        const result = {};
        let currentTable = result;
        let currentTablePath = [];

        const lines = content.split('\n');

        for (let line of lines) {
            line = line.trim();

            // Skip empty lines and comments
            if (!line || line.startsWith('#')) continue;

            // Table header [section] or [section.subsection].
            // Use splitTomlTablePath so quoted dotted segments stay intact
            // (handles `[projects."/Users/example/my.app"]` correctly).
            const tableMatch = line.match(/^\[([^\]]+)\]$/);
            if (tableMatch) {
                const tablePath = this.splitTomlTablePath(tableMatch[1]);
                currentTablePath = tablePath;
                currentTable = result;

                for (const key of tablePath) {
                    if (!currentTable[key]) {
                        currentTable[key] = {};
                    }
                    currentTable = currentTable[key];
                }
                continue;
            }

            // Key = value pairs
            const kvMatch = line.match(/^([^=]+)=(.*)$/);
            if (kvMatch) {
                const key = kvMatch[1].trim();
                let value = kvMatch[2].trim();

                // Parse the value
                if (value.startsWith('"') && value.endsWith('"')) {
                    // String
                    value = value.slice(1, -1);
                } else if (value.startsWith('[')) {
                    // Array - simple parsing for string arrays
                    try {
                        value = JSON.parse(value.replace(/'/g, '"'));
                    } catch {
                        // Try to parse as TOML array
                        value = this.parseTomlArray(value);
                    }
                } else if (value === 'true') {
                    value = true;
                } else if (value === 'false') {
                    value = false;
                } else if (!isNaN(value)) {
                    value = Number(value);
                }

                currentTable[key] = value;
            }
        }

        return result;
    }

    /**
     * Parse TOML array format
     * @param {string} arrayStr - TOML array string like [ "a", "b" ]
     * @returns {Array}
     */
    parseTomlArray(arrayStr) {
        const match = arrayStr.match(/\[(.*)\]/s);
        if (!match) return [];

        const inner = match[1].trim();
        if (!inner) return [];

        // Split by comma, handling quoted strings
        const items = [];
        let current = '';
        let inQuote = false;

        for (const char of inner) {
            if (char === '"' && current.slice(-1) !== '\\') {
                inQuote = !inQuote;
                current += char;
            } else if (char === ',' && !inQuote) {
                const item = current.trim();
                if (item) {
                    // Remove quotes
                    if (item.startsWith('"') && item.endsWith('"')) {
                        items.push(item.slice(1, -1));
                    } else {
                        items.push(item);
                    }
                }
                current = '';
            } else {
                current += char;
            }
        }

        // Don't forget the last item
        const lastItem = current.trim();
        if (lastItem) {
            if (lastItem.startsWith('"') && lastItem.endsWith('"')) {
                items.push(lastItem.slice(1, -1));
            } else {
                items.push(lastItem);
            }
        }

        return items;
    }

    /**
     * A root-level key line: `key = value` before the first [table] header.
     * Anything else at root level (a dangling `"]`, a stray fragment) means the
     * file is already corrupted and we must not write on top of it.
     */
    static get ROOT_KEY_LINE() { return /^\s*[A-Za-z0-9_-]+\s*=/; }

    /**
     * Build the `notify = [...]` line, rejecting anything that would not
     * round-trip as a TOML array of strings.
     * @param {*} notify - Expected: non-empty array of strings
     * @returns {string}
     */
    buildNotifyLine(notify) {
        const isStringArray = Array.isArray(notify)
            && notify.length > 0
            && notify.every(arg => typeof arg === 'string');

        if (!isStringArray) {
            throw new Error(`notify must be a non-empty array of strings, got ${JSON.stringify(notify)}`);
        }
        return `notify = ${JSON.stringify(notify)}`;
    }

    /**
     * Replace (or insert) the ROOT-level `notify` line, operating on WHOLE
     * LINES. Whole lines are the point: the old regex substitution could consume
     * less than the line held and leave a tail behind — that is how a config
     * ended up with `notify = [...]"]`, which stops Codex from starting. Dropping
     * and re-adding the entire line makes a partial edit impossible, and repairs
     * an already-corrupted line on the way.
     *
     * A `notify` key that sits INSIDE a [table] belongs to that table (it is not
     * ours) and is left untouched.
     *
     * @param {string} content - Current config.toml content
     * @param {string} notifyLine - Line produced by buildNotifyLine()
     * @returns {string}
     */
    upsertRootNotifyLine(content, notifyLine) {
        const { kept, firstNotifyIndex } = this.splitOutRootNotifyLines(content);
        let insertIndex = firstNotifyIndex;

        if (insertIndex === -1) {
            insertIndex = this.findRootInsertIndex(kept);
            // Keep a blank line between our key and the first table header.
            if (kept[insertIndex] !== undefined && kept[insertIndex].trim() !== '') {
                kept.splice(insertIndex, 0, '');
            }
        }

        kept.splice(insertIndex, 0, notifyLine);
        return kept.join('\n');
    }

    /**
     * Drop every ROOT-level `notify` line (a `notify` inside a [table] is not
     * ours and stays). Whole lines only — see upsertRootNotifyLine.
     * @param {string} content
     * @returns {string}
     */
    removeRootNotifyLines(content) {
        return this.splitOutRootNotifyLines(content).kept.join('\n');
    }

    /**
     * Split content into the lines that survive once every ROOT-level `notify`
     * line is dropped, plus the index where the first one used to sit (-1 if
     * there was none) so a replacement can keep its place.
     *
     * @param {string} content
     * @returns {{ kept: string[], firstNotifyIndex: number }}
     */
    splitOutRootNotifyLines(content) {
        const kept = [];
        let firstNotifyIndex = -1;
        let insideTable = false;

        for (const line of content.split('\n')) {
            if (!insideTable && /^\s*\[/.test(line)) {
                insideTable = true;
            }
            if (!insideTable && /^\s*notify\s*=/.test(line)) {
                if (firstNotifyIndex === -1) firstNotifyIndex = kept.length;
                continue;
            }
            kept.push(line);
        }

        return { kept, firstNotifyIndex };
    }

    /**
     * Where a new root-level key must go: after the leading comments/keys but
     * BEFORE the first [table] header (a key written after a header would be
     * parsed as belonging to that table).
     * @param {string[]} lines
     * @returns {number}
     */
    findRootInsertIndex(lines) {
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*\[/.test(lines[i])) {
                // Step back over the blank lines that separate the sections.
                let index = i;
                while (index > 0 && lines[index - 1].trim() === '') index--;
                return index;
            }
        }
        return lines.length;
    }

    /**
     * Last line of defence before touching the user's config: the root level
     * must hold exactly ONE notify line, it must parse back to the array we
     * meant to write, and no other root line may be garbage. Throws otherwise,
     * so a broken result is never written to disk.
     *
     * @param {string} content - Content about to be written
     * @param {string[]} expectedNotify - The notify array we intended to write
     */
    assertRootLevelIsValid(content, expectedNotify) {
        const notifyLines = [];

        for (const line of content.split('\n')) {
            if (/^\s*\[/.test(line)) break; // first table header ends the root level
            if (line.trim() === '' || line.trim().startsWith('#')) continue;

            if (/^\s*notify\s*=/.test(line)) {
                notifyLines.push(line);
            } else if (!CodexHooksManager.ROOT_KEY_LINE.test(line)) {
                throw new Error(`config.toml has a malformed root-level line, refusing to write: ${JSON.stringify(line)}`);
            }
        }

        if (notifyLines.length !== 1) {
            throw new Error(`expected exactly 1 root-level notify line, found ${notifyLines.length}`);
        }

        const match = /^notify = (\[.*\])$/.exec(notifyLines[0]);
        if (!match) {
            throw new Error(`generated notify line is not a clean array assignment: ${JSON.stringify(notifyLines[0])}`);
        }

        let parsed;
        try {
            parsed = JSON.parse(match[1]);
        } catch (error) {
            throw new Error(`generated notify line does not parse as an array: ${JSON.stringify(notifyLines[0])}`);
        }

        if (JSON.stringify(parsed) !== JSON.stringify(expectedNotify)) {
            throw new Error(`generated notify line does not match the intended value: ${JSON.stringify(notifyLines[0])}`);
        }
    }

    /**
     * Write Codex config.toml file
     * Preserves existing content and only updates the notify key
     * @param {Object} config - Config object to write
     * @returns {boolean}
     */
    async writeConfig(config) {
        try {
            await this.ensureConfigDirectory();

            const notifyLine = this.buildNotifyLine(config.notify);

            // Read existing content to preserve it
            const safeExisting = safeReadConfigFile(this.configPath);
            const existingContent = safeExisting !== null ? safeExisting : '';

            const newContent = this.upsertRootNotifyLine(existingContent, notifyLine);
            this.assertRootLevelIsValid(newContent, config.notify);

            if (newContent === existingContent) {
                return true; // already correct — do not rewrite the file
            }

            fs.writeFileSync(this.configPath, newContent, 'utf8');
            console.log('[CodexHooksManager] Config written to:', this.configPath);
            return true;
        } catch (error) {
            console.error('[CodexHooksManager] Error writing config:', error);
            return false;
        }
    }

    /**
     * Create the Codex notify script
     * This script receives JSON as argv[1] and forwards to CodeAgentSwarm webhook
     * @returns {string} Path to the created script
     */
    createNotifyScript() {
        const devPort = 45783;
        const prodPort = 45782;

        if (this.isWindows) {
            return this.createWindowsNotifyScript(devPort, prodPort);
        }
        return this.createUnixNotifyScript(devPort, prodPort);
    }

    /**
     * Create Unix/macOS notify script
     */
    createUnixNotifyScript(devPort, prodPort) {
        const scriptPath = path.join(this.hooksScriptsDir, 'codex-notify.sh');

        const scriptContent = `#!/bin/bash
# CodeAgentSwarm - Codex Notify Hook
# Receives JSON as $1 and forwards to CodeAgentSwarm webhook server
# Handles both agent-turn-complete and approval-requested events

JSON_INPUT="\$1"

if [ -z "$JSON_INPUT" ]; then
    exit 0
fi

# The notify key lives in the GLOBAL ~/.codex/config.toml, so this hook fires in
# every Codex session on the machine. Outside a CodeAgentSwarm terminal (no
# quadrant env) stay silent — posting as terminal 0 shows phantom notifications
# inside the app.
if [ -z "\${CODEAGENTSWARM_CURRENT_QUADRANT:-}" ]; then
    exit 0
fi

# Driver-backed Chat receives the authoritative top-level turn/completed event
# directly from codex app-server. The global notify hook also fires for
# delegated subagents and cannot distinguish them, so it must not announce
# completion for this process.
if [ -n "\${CODEAGENTSWARM_DRIVER_CHAT:-}" ]; then
    exit 0
fi

# Extract event type from JSON
EVENT_TYPE=$(echo "$JSON_INPUT" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)

TERMINAL_ID="\$CODEAGENTSWARM_CURRENT_QUADRANT"

# Build the webhook payload based on event type
if [ "$EVENT_TYPE" = "agent-turn-complete" ]; then
    PAYLOAD="{\\"type\\":\\"claude_finished\\",\\"terminalId\\":\\"$TERMINAL_ID\\",\\"agent\\":\\"codex\\"}"
elif [ "$EVENT_TYPE" = "approval-requested" ]; then
    PAYLOAD="{\\"type\\":\\"confirmation_needed\\",\\"terminalId\\":\\"$TERMINAL_ID\\",\\"agent\\":\\"codex\\",\\"tool\\":\\"codex-action\\"}"
else
    # Unknown event type, forward original JSON
    PAYLOAD="$JSON_INPUT"
fi

# Post to THIS instance's webhook port (injected into the PTY env by CodeAgentSwarm);
# fall back to the legacy dev-first (${devPort}) / prod (${prodPort}) ports for older builds.
curl -X POST "http://127.0.0.1:\${CODEAGENTSWARM_WEBHOOK_PORT:-${devPort}}/webhook" \\
    -H "Content-Type: application/json" \\
    -d "$PAYLOAD" \\
    --silent --fail 2>/dev/null || \\
curl -X POST "http://127.0.0.1:\${CODEAGENTSWARM_WEBHOOK_PORT:-${prodPort}}/webhook" \\
    -H "Content-Type: application/json" \\
    -d "$PAYLOAD" \\
    --silent --fail 2>/dev/null || true

exit 0
`;

        fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
        console.log('[CodexHooksManager] Created Unix notify script:', scriptPath);
        return scriptPath;
    }

    /**
     * Create Windows PowerShell notify script
     */
    createWindowsNotifyScript(devPort, prodPort) {
        const scriptPath = path.join(this.hooksScriptsDir, 'codex-notify.ps1');

        const scriptContent = `# CodeAgentSwarm - Codex Notify Hook (Windows)
# Receives JSON as first argument and forwards to CodeAgentSwarm webhook server

param([string]$JsonInput)

if ([string]::IsNullOrEmpty($JsonInput)) {
    exit 0
}

# The notify key lives in the GLOBAL config.toml, so this fires in every Codex
# session. Outside a CodeAgentSwarm terminal (no quadrant env) stay silent.
if (-not $env:CODEAGENTSWARM_CURRENT_QUADRANT) {
    exit 0
}

# Driver-backed Chat receives the authoritative top-level turn/completed event
# directly from codex app-server. The global hook has no subagent discriminator.
if ($env:CODEAGENTSWARM_DRIVER_CHAT) {
    exit 0
}

$terminalId = $env:CODEAGENTSWARM_CURRENT_QUADRANT

# Parse the JSON to get event type
try {
    $notification = $JsonInput | ConvertFrom-Json
    $eventType = $notification.type
} catch {
    $eventType = "unknown"
}

# Build payload based on event type
if ($eventType -eq "agent-turn-complete") {
    $payload = @{
        type = "claude_finished"
        terminalId = $terminalId
        agent = "codex"
    } | ConvertTo-Json -Compress
} elseif ($eventType -eq "approval-requested") {
    $payload = @{
        type = "confirmation_needed"
        terminalId = $terminalId
        agent = "codex"
        tool = "codex-action"
    } | ConvertTo-Json -Compress
} else {
    $payload = $JsonInput
}

# Post to THIS instance's webhook port when CodeAgentSwarm injected it; otherwise fall
# back to the legacy dev-first (${devPort}) / prod (${prodPort}) probe for older builds.
$ports = if (($casPort = $env:CODEAGENTSWARM_WEBHOOK_PORT -as [int])) { @($casPort) } else { @(${devPort}, ${prodPort}) }
foreach ($port in $ports) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/webhook" -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 2 -ErrorAction Stop
        break
    } catch {}
}

exit 0
`;

        fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
        console.log('[CodexHooksManager] Created Windows notify script:', scriptPath);
        return scriptPath;
    }

    /**
     * Get the notify command for config.toml
     * @returns {Array} Command array for notify config
     */
    getNotifyCommand() {
        const scriptPath = this.createNotifyScript();

        if (this.isWindows) {
            return ['powershell.exe', '-ExecutionPolicy', 'Bypass', '-File', this.toUnixPath(scriptPath)];
        }
        return ['/bin/bash', this.toUnixPath(scriptPath)];
    }

    /**
     * Check if the current notify config is a CodeAgentSwarm hook
     * @param {Array} notifyArray - Current notify config array
     * @returns {boolean}
     */
    isCodeAgentSwarmHook(notifyArray) {
        if (!Array.isArray(notifyArray)) return false;
        return notifyArray.some(arg =>
            arg.includes('.codeagentswarm') ||
            arg.includes('codex-notify')
        );
    }

    /**
     * Install the FULL set of CodeAgentSwarm hooks into Codex CLI config:
     * the `notify` mechanism AND the PreToolUse title reminder.
     */
    async installHooks() {
        const notify = await this.installNotificationsHooks();
        const gate = await this.installTitleGateHooks();
        const success = notify.success !== false && gate.success !== false;
        if (success) {
            console.log('[CodexHooksManager] Hooks installed successfully (notify + title gate)');
        }
        return { success, notify, gate };
    }

    /**
     * Remove the FULL set of CodeAgentSwarm hooks from Codex CLI config.
     */
    async removeHooks() {
        const notify = await this.removeNotificationsHooks();
        const gate = await this.removeTitleGateHooks();
        return { success: notify.success !== false && gate.success !== false, notify, gate };
    }

    /**
     * Install ONLY the `notify` mechanism (desktop notifications).
     */
    async _installNotifyOnly() {
        try {
            await this.ensureHooksDirectory();

            const config = await this.readConfig();

            // Check if there's an existing notify that's not ours
            if (config.notify && !this.isCodeAgentSwarmHook(config.notify)) {
                console.warn('[CodexHooksManager] Existing notify hook found, will be replaced');
                console.warn('[CodexHooksManager] Previous notify:', config.notify);
            }

            // Set our notify command
            config.notify = this.getNotifyCommand();

            const success = await this.writeConfig(config);

            if (success) {
                return { success: true };
            } else {
                return { success: false, error: 'Failed to write config' };
            }
        } catch (error) {
            console.error('[CodexHooksManager] Error installing notify hook:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Remove ONLY the `notify` mechanism (desktop notifications).
     */
    async _removeNotifyOnly() {
        try {
            const config = await this.readConfig();

            if (!config.notify || !this.isCodeAgentSwarmHook(config.notify)) {
                return { success: true };
            }

            // Remove notify by setting to empty array or deleting
            delete config.notify;

            // Read existing content and remove the ROOT-level notify line.
            // Whole-line removal, same reason as in upsertRootNotifyLine: a
            // partial regex match would leave a tail behind and break the TOML.
            const safeContent = safeReadConfigFile(this.configPath);
            if (safeContent !== null) {
                const content = this.removeRootNotifyLines(safeContent);
                fs.writeFileSync(this.configPath, content, 'utf8');
            }

            return { success: true };
        } catch (error) {
            console.error('[CodexHooksManager] Error removing notify hook:', error);
            return { success: false, error: error.message };
        }
    }

    // ============================================================
    // PreToolUse TITLE REMINDER (Codex)
    // ============================================================
    // Codex CLI 0.142 supports a full hooks system. We install a
    // [[hooks.PreToolUse]] block (matcher "*") pointing at the SAME reminder
    // script Claude Code uses (non-blocking: it can only inject context, never deny).
    //
    // IMPORTANT — no comment markers. We identify OUR block STRUCTURALLY (the
    // [[hooks.PreToolUse]] entry whose command contains `title-gate-hook`), NOT
    // by a leading `# ...` comment. A leading comment is unsafe here: another
    // surgical writer of config.toml (mcp-sync's updateCodexQuadrant, which
    // rewrites the [mcp_servers.codeagentswarm-tasks] block on every terminal
    // switch) absorbs a trailing comment that sits between the MCP block and the
    // next [section] and drops it — which would silently corrupt a marker-based
    // gate (breaking both detection and removal). Structural detection survives.

    /** Substring that uniquely identifies OUR PreToolUse block (in its command). */
    static get GATE_TAG() { return 'title-gate-hook'; }

    /**
     * Write the shared title-gate script to disk and return its path.
     */
    createTitleGateScript() {
        if (this.isWindows) {
            const scriptPath = path.join(this.hooksScriptsDir, 'title-gate-hook.ps1');
            fs.writeFileSync(scriptPath, titleGateScript.getPowerShellTitleGateScript());
            return scriptPath;
        }
        const scriptPath = path.join(this.hooksScriptsDir, 'title-gate-hook.sh');
        fs.writeFileSync(scriptPath, titleGateScript.getBashTitleGateScript(), { mode: 0o755 });
        return scriptPath;
    }

    /**
     * The TOML `command` string that runs the gate script for Codex.
     * Single-quotes around the path keep the TOML basic string free of escaping.
     */
    getTitleGateCommandString() {
        const scriptName = this.isWindows ? 'title-gate-hook.ps1' : 'title-gate-hook.sh';
        const scriptPath = this.toUnixPath(path.join(this.hooksScriptsDir, scriptName));
        if (this.isWindows) {
            return `powershell.exe -ExecutionPolicy Bypass -File '${scriptPath}'`;
        }
        return `/bin/bash '${scriptPath}'`;
    }

    /**
     * The [[hooks.PreToolUse]] TOML block (no comment markers, no trailing newline).
     * Its command line carries GATE_TAG so the block is self-identifying.
     */
    buildTitleGateTomlBlock() {
        const cmd = this.getTitleGateCommandString();
        return [
            '[[hooks.PreToolUse]]',
            'matcher = "*"',
            '',
            '[[hooks.PreToolUse.hooks]]',
            'type = "command"',
            `command = ${JSON.stringify(cmd)}`,
            'timeout = 30'
        ].join('\n');
    }

    /**
     * Remove OUR PreToolUse gate block(s) from raw TOML content, identified
     * STRUCTURALLY (a [[hooks.PreToolUse]] entry whose body contains GATE_TAG).
     * User-authored hooks and every other section are preserved byte-for-byte.
     */
    _stripTitleGateBlock(content) {
        if (!content) return '';
        const tag = CodexHooksManager.GATE_TAG;
        const lines = content.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            if (lines[i].trim() === '[[hooks.PreToolUse]]') {
                // Collect this single PreToolUse entry: the header + its
                // [[hooks.PreToolUse.hooks]] sub-tables, stopping at the next
                // [[hooks.PreToolUse]] entry or any other [section] / EOF.
                let j = i + 1;
                const group = [lines[i]];
                while (j < lines.length) {
                    const t = lines[j].trim();
                    if (t === '[[hooks.PreToolUse]]') break;
                    if (t.startsWith('[') && t !== '[[hooks.PreToolUse.hooks]]') break;
                    group.push(lines[j]);
                    j++;
                }
                if (group.join('\n').includes(tag)) {
                    // Drop OUR block, plus a single trailing blank separator line.
                    i = j;
                    if (i < lines.length && lines[i].trim() === '') i++;
                    continue;
                }
            }
            out.push(lines[i]);
            i++;
        }
        // Collapse 3+ consecutive newlines left behind by the removal.
        return out.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    /**
     * Install the PreToolUse title reminder into config.toml. Idempotent:
     * re-installing replaces the existing managed block rather than duplicating it.
     */
    async installTitleGateHooks() {
        try {
            await this.ensureHooksDirectory();
            await this.ensureConfigDirectory();
            this.createTitleGateScript();

            let content = '';
            const existing = safeReadConfigFile(this.configPath);
            if (existing !== null) content = existing;

            content = this._stripTitleGateBlock(content);
            content = content.replace(/\s*$/, ''); // trim trailing whitespace/newlines

            const block = this.buildTitleGateTomlBlock();
            content = content.length ? `${content}\n\n${block}\n` : `${block}\n`;

            fs.writeFileSync(this.configPath, content, 'utf8');
            return { success: true };
        } catch (error) {
            console.error('[CodexHooksManager] Error installing title gate:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Remove the PreToolUse title reminder from config.toml (managed block only).
     */
    async removeTitleGateHooks() {
        try {
            const existing = safeReadConfigFile(this.configPath);
            if (existing === null) return { success: true };
            if (!existing.includes(CodexHooksManager.GATE_TAG)) return { success: true };

            let content = this._stripTitleGateBlock(existing);
            content = content.replace(/\s*$/, '');
            content = content.length ? `${content}\n` : '';

            fs.writeFileSync(this.configPath, content, 'utf8');
            return { success: true };
        } catch (error) {
            console.error('[CodexHooksManager] Error removing title gate:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Whether the managed PreToolUse title gate is present in config.toml.
     * Detected STRUCTURALLY (PreToolUse table + our GATE_TAG in the command),
     * with no dependency on a comment marker that a sibling writer could strip.
     */
    async hasTitleGateHooks() {
        try {
            const content = safeReadConfigFile(this.configPath);
            if (content === null) return false;
            return content.includes('[[hooks.PreToolUse]]')
                && content.includes(CodexHooksManager.GATE_TAG);
        } catch (error) {
            return false;
        }
    }

    // ============================================================
    // Granular hook groups
    // ============================================================
    // Codex only supports notifications (single `notify` mechanism). It has
    // no equivalent for file-change tracking — those methods are no-ops so
    // the cross-agent service can call them uniformly.

    async installNotificationsHooks() {
        return this._installNotifyOnly();
    }

    async removeNotificationsHooks() {
        return this._removeNotifyOnly();
    }

    async installFileChangeHooks() {
        // Codex does not support PreTool/PostTool hooks.
        return { success: true, skipped: true, reason: 'Codex does not support file-change tracking hooks' };
    }

    async removeFileChangeHooks() {
        return { success: true, skipped: true, reason: 'Codex does not support file-change tracking hooks' };
    }

    async hasNotificationsHooks() {
        try {
            const config = await this.readConfig();
            return !!(config.notify && this.isCodeAgentSwarmHook(config.notify));
        } catch (error) {
            return false;
        }
    }

    async hasFileChangeHooks() {
        // Not supported by Codex.
        return false;
    }

    /**
     * Check the status of CodeAgentSwarm hooks in Codex CLI config
     */
    async checkHooksStatus() {
        try {
            const config = await this.readConfig();

            const hasNotifyHook = config.notify && this.isCodeAgentSwarmHook(config.notify);
            // PreToolUse is now supported (Codex CLI 0.142 hooks system) and used for the
            // title reminder. The simple TOML parser does not represent [[array tables]],
            // so detect the reminder from the raw file (marker comment) instead of `config`.
            const hasTitleGate = await this.hasTitleGateHooks();

            return {
                installed: hasNotifyHook,
                hasNotifyHook,
                hasTitleGate,
                // Codex still has NO file-change tracking (no PostToolUse snapshot/compare).
                hasFileChangeTracking: false,
                // PreToolUse IS used now — for the title reminder only.
                hasPreToolHook: hasTitleGate,
                hasPostToolHook: false,
                configPath: this.configPath,
                notify: config.notify || null,
                limitations: [
                    'No file change tracking (no PostToolUse snapshot/compare hook)',
                    'PreToolUse used only for the CodeAgentSwarm title reminder',
                    'notify events: agent-turn-complete and approval-requested'
                ]
            };
        } catch (error) {
            console.error('[CodexHooksManager] Error checking hooks status:', error);
            return {
                installed: false,
                error: error.message
            };
        }
    }

    /**
     * Ensure full configuration is in place
     */
    async ensureFullConfiguration() {
        try {
            const hooksResult = await this.installHooks();
            if (!hooksResult.success) {
                console.error('[CodexHooksManager] Failed to install hooks:', hooksResult.error);
            }

            return {
                success: hooksResult.success,
                hooks: hooksResult
            };
        } catch (error) {
            console.error('[CodexHooksManager] Error ensuring full configuration:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Ensure hook scripts exist
     * For Codex, this just creates the notify script
     */
    async ensureHookScripts() {
        try {
            await this.ensureHooksDirectory();
            this.createNotifyScript();
            this.createTitleGateScript();
            return { success: true };
        } catch (error) {
            console.error('[CodexHooksManager] Error creating hook scripts:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = CodexHooksManager;
module.exports.upsertCodexNotifyLine = upsertCodexNotifyLine;
