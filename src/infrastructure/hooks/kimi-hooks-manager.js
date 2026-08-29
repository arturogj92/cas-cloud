/**
 * KimiHooksManager - Hook management for Moonshot's Kimi Code CLI
 *
 * Kimi Code has a full lifecycle hooks system in ~/.kimi-code/config.toml using FLAT
 * `[[hooks]]` array-of-tables syntax (unlike Codex's nested [[hooks.PreToolUse]] and
 * unlike Claude's settings.json). Verified against the kimi-code source schema:
 *
 *   [[hooks]]
 *   event   = "PreToolUse"        # required, one of 16 events
 *   matcher = "Write|Edit"        # optional regex; omit = match all
 *   command = "/bin/bash '...'"   # required
 *   timeout = 30                  # optional, SECONDS, 1..600 (default 30)
 *
 * Hook I/O contract (verified): stdin is snake_case JSON
 * ({"hook_event_name": "...", "session_id": "...", "cwd": "...", plus tool fields);
 * exit 0 = allow, exit 2 = block (stderr is the reason), any OTHER failure = fail-open.
 * Stdout may carry Claude-shaped `{"hookSpecificOutput": {...}}` (camelCase).
 *
 * What we install (three independently toggleable groups):
 *  1. notifications — [[hooks]] on Stop + PermissionRequest -> a script that POSTs
 *     claude_finished / confirmation_needed to the CAS webhook server. Kimi's
 *     `Notification` event is deliberately NOT hooked: unlike Claude Code, where it
 *     means "Claude needs you", every kimi notification is a background-task
 *     lifecycle message (task.completed/failed/killed/lost) injected into the
 *     agent's OWN context (sink=context, source_kind=background_task) — verified in
 *     the 0.29.0 binary, whose only two Notification trigger sites are the
 *     background/subagent task notifiers. Treating it as a confirmation raised a
 *     false "needs your confirmation" toast + needs_input badge every time a
 *     subagent finished (task #12193). Real approvals arrive as PermissionRequest.
 *  2. titleGate — [[hooks]] on PreToolUse -> the SHARED non-blocking title reminder
 *     (title-gate-script.js, same body as Claude/Codex). Kimi clones Claude's stdin
 *     field names (tool_name, session_id) and consumes hookSpecificOutput, so the
 *     script ports verbatim. It NEVER emits a permissionDecision -> can never block
 *     (the agy deadlock lesson).
 *  3. fileChange — [[hooks]] on PostToolUse matcher "Write|Edit" -> the same
 *     edit-write transform Claude uses. Kimi's tool names are Claude-compatible
 *     (verified from a real wire.jsonl: Read/Write/Edit/Bash/...), and the hook
 *     degrades to a silent no-op if the payload shape differs.
 *
 * All config edits are STRUCTURAL: we only ever add/remove [[hooks]] tables whose
 * command carries one of OUR script names; user-authored hooks and every other
 * section are preserved byte-for-byte. checkHooksStatus is a pure disk read (no
 * subprocess), per the e2e-sandbox rule.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeReadConfigFile } = require('../../shared/utils/safe-config-reader');
const titleGateScript = require('./title-gate-script');

class KimiHooksManager {
    constructor(options = {}) {
        const dataRoot = (process.env.KIMI_CODE_HOME || '').trim() || path.join(os.homedir(), '.kimi-code');
        this.configPath = path.join(dataRoot, 'config.toml');
        this.isDevMode = options.isDevMode || false;
        this.webhookPort = this.isDevMode ? 45783 : 45782;
        this.hooksScriptsDir = path.join(os.homedir(), '.codeagentswarm', 'hooks');
        this.isWindows = process.platform === 'win32';

        // Exposed for HookSystemPreferences status rows.
        this.settingsPath = this.configPath;

        console.log(`[KimiHooksManager] Initialized (${this.isDevMode ? 'DEV' : 'PROD'} mode, config: ${this.configPath})`);
    }

    /** Substrings that uniquely identify OUR [[hooks]] tables (in their command). */
    static get GATE_TAG() { return 'title-gate-hook'; }
    static get NOTIFY_TAG() { return 'kimi-notify-hook'; }
    static get FILECHANGE_TAG() { return 'kimi-edit-write-hook'; }

    toUnixPath(filePath) {
        return filePath.replace(/\\/g, '/');
    }

    async ensureHooksDirectory() {
        if (!fs.existsSync(this.hooksScriptsDir)) {
            fs.mkdirSync(this.hooksScriptsDir, { recursive: true });
        }
    }

    async ensureConfigDirectory() {
        const configDir = path.dirname(this.configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
    }

    // ============================================================
    // Hook scripts on disk
    // ============================================================

    /**
     * Write the shared title-gate script (same body as Claude/Codex) and return its path.
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
     * The notification script: one script for both notification events. It reads
     * the snake_case stdin JSON, maps the event to a CAS webhook payload, and always
     * exits 0. CAS-ONLY: outside a CodeAgentSwarm terminal it prints nothing and exits.
     * Dependency-free (sed, no jq).
     */
    getUnixNotifyScript() {
        return `#!/bin/bash
# ============================================================================
# kimi-notify-hook.sh
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# Kimi Code lifecycle hook: maps Stop / PermissionRequest events to
# CodeAgentSwarm desktop notifications. Always exits 0 (fail-open).
#
# Notification is IGNORED on purpose: in Kimi it only ever carries background-task
# lifecycle news for the agent's own context, never a request for the user.
# ============================================================================

TERM_ID="\${CODEAGENTSWARM_CURRENT_QUADRANT:-}"
[ -z "$TERM_ID" ] && exit 0

# Driver-backed Chat receives the authoritative turn/permission events straight
# from the ACP driver. This global hook would double-report: Stop fires at every
# INTERNAL turn end (incl. background-task wake turns) and PermissionRequest
# fires even when the driver auto-approves — a false needs_input while working.
if [ -n "\${CODEAGENTSWARM_DRIVER_CHAT:-}" ]; then
    exit 0
fi

INPUT=$(head -c 65536)

# hook_event_name is snake_case in Kimi's stdin JSON
EVENT=$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
[ -z "$TOOL" ] && TOOL="kimi-action"

case "$EVENT" in
  Stop)
    BODY="{\\"type\\":\\"claude_finished\\",\\"terminalId\\":\\"$TERM_ID\\",\\"agent\\":\\"kimi\\"}"
    ;;
  PermissionRequest)
    BODY="{\\"type\\":\\"confirmation_needed\\",\\"terminalId\\":\\"$TERM_ID\\",\\"agent\\":\\"kimi\\",\\"tool\\":\\"$TOOL\\"}"
    ;;
  *)
    exit 0
    ;;
esac

# Post to THIS instance's webhook port (injected by CodeAgentSwarm); the fallbacks keep the
# legacy dev-first (45783) / prod (45782) behaviour for terminals opened outside the app.
curl -X POST "http://127.0.0.1:\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}/webhook" -H "Content-Type: application/json" \\
  -d "$BODY" --silent --fail --max-time 2 >/dev/null 2>&1 || \\
curl -X POST "http://127.0.0.1:\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}/webhook" -H "Content-Type: application/json" \\
  -d "$BODY" --silent --max-time 2 >/dev/null 2>&1 || true

exit 0
`;
    }

    getWindowsNotifyScript() {
        return `# ============================================================================
# kimi-notify-hook.ps1
# Auto-generated by CodeAgentSwarm - Do not edit manually
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'
try {
    $terminalId = $env:CODEAGENTSWARM_CURRENT_QUADRANT
    if (-not $terminalId) { exit 0 }

    # Driver-backed Chat: the ACP driver already reports turn ends and permission
    # requests; this global hook must not double-report them.
    if ($env:CODEAGENTSWARM_DRIVER_CHAT) { exit 0 }

    $inputJson = [Console]::In.ReadToEnd()
    if (-not $inputJson) { exit 0 }
    $data = $inputJson | ConvertFrom-Json

    $eventName = $data.hook_event_name
    $tool = if ($data.tool_name) { $data.tool_name } else { 'kimi-action' }

    # Every other event, Notification included, falls through to the no-op default:
    # in Kimi a Notification is background-task news for the agent's own context,
    # never a request for the user.
    switch ($eventName) {
        'Stop' { $payload = @{ type = 'claude_finished'; terminalId = "$terminalId"; agent = 'kimi' } }
        'PermissionRequest' { $payload = @{ type = 'confirmation_needed'; terminalId = "$terminalId"; agent = 'kimi'; tool = "$tool" } }
        default { exit 0 }
    }
    $body = $payload | ConvertTo-Json -Compress

    # Post to THIS instance's webhook port when CodeAgentSwarm injected it; otherwise fall
    # back to the legacy dev-first (45783) / prod (45782) probe for older builds.
    $ports = if (($casPort = $env:CODEAGENTSWARM_WEBHOOK_PORT -as [int])) { @($casPort) } else { @(45783, 45782) }
    foreach ($port in $ports) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/webhook" -Method POST -ContentType 'application/json' -Body $body -TimeoutSec 2 -ErrorAction Stop | Out-Null
            exit 0
        } catch { continue }
    }
} catch { }
exit 0
`;
    }

    /**
     * File-change script: identical transform to Claude's edit-write hook (Kimi's tool
     * payload is Claude-shaped). If jq is missing or fields are absent, it exits 0.
     */
    getUnixFileChangeScript() {
        return `#!/bin/bash
# ============================================================================
# kimi-edit-write-hook.sh
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PostToolUse hook (matcher Write|Edit): posts a file_edited event so the
# CodeAgentSwarm diff viewer tracks Kimi's file changes. Always exits 0.
# ============================================================================

TERM_ID="\${CODEAGENTSWARM_CURRENT_QUADRANT:-}"
[ -z "$TERM_ID" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

TMP=$(mktemp)
trap "rm -f '$TMP'" EXIT

jq -c "{
    type: \\"file_edited\\",
    terminalId: \\"$TERM_ID\\",
    toolName: .tool_name,
    filePath: .tool_input.file_path,
    content: (.tool_input.content // null),
    oldString: (.tool_input.old_string // null),
    newString: (.tool_input.new_string // null),
    originalContent: (.tool_response.returnDisplay.originalContent // null),
    newContent: (.tool_response.returnDisplay.newContent // null)
}" > "$TMP" 2>/dev/null || exit 0

# Drop payloads with no file path (unexpected shape) instead of confusing the tracker.
grep -q '"filePath":null' "$TMP" && exit 0

# Post to THIS instance's webhook port (injected by CodeAgentSwarm); the fallbacks keep the
# legacy dev-first (45783) / prod (45782) behaviour for terminals opened outside the app.
curl -X POST "http://127.0.0.1:\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}/webhook" -H "Content-Type: application/json" \\
  -d @"$TMP" --silent --fail --max-time 2 >/dev/null 2>&1 || \\
curl -X POST "http://127.0.0.1:\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}/webhook" -H "Content-Type: application/json" \\
  -d @"$TMP" --silent --max-time 2 >/dev/null 2>&1 || true

exit 0
`;
    }

    getWindowsFileChangeScript() {
        return `# ============================================================================
# kimi-edit-write-hook.ps1
# Auto-generated by CodeAgentSwarm - Do not edit manually
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'
try {
    $terminalId = $env:CODEAGENTSWARM_CURRENT_QUADRANT
    if (-not $terminalId) { exit 0 }

    $inputJson = [Console]::In.ReadToEnd()
    if (-not $inputJson) { exit 0 }
    $data = $inputJson | ConvertFrom-Json
    if (-not $data.tool_input.file_path) { exit 0 }

    $payload = [ordered]@{
        type            = 'file_edited'
        terminalId      = "$terminalId"
        toolName        = $data.tool_name
        filePath        = $data.tool_input.file_path
        content         = $data.tool_input.content
        oldString       = $data.tool_input.old_string
        newString       = $data.tool_input.new_string
        originalContent = $data.tool_response.returnDisplay.originalContent
        newContent      = $data.tool_response.returnDisplay.newContent
    }
    $body = $payload | ConvertTo-Json -Compress -Depth 10

    # Post to THIS instance's webhook port when CodeAgentSwarm injected it; otherwise fall
    # back to the legacy dev-first (45783) / prod (45782) probe for older builds.
    $ports = if (($casPort = $env:CODEAGENTSWARM_WEBHOOK_PORT -as [int])) { @($casPort) } else { @(45783, 45782) }
    foreach ($port in $ports) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/webhook" -Method POST -ContentType 'application/json' -Body $body -TimeoutSec 2 -ErrorAction Stop | Out-Null
            exit 0
        } catch { continue }
    }
} catch { }
exit 0
`;
    }

    /** Write a group's script file(s) to disk. */
    _writeScript(baseName, unixBody, windowsBody) {
        if (this.isWindows) {
            const p = path.join(this.hooksScriptsDir, `${baseName}.ps1`);
            fs.writeFileSync(p, windowsBody);
            return p;
        }
        const p = path.join(this.hooksScriptsDir, `${baseName}.sh`);
        fs.writeFileSync(p, unixBody, { mode: 0o755 });
        return p;
    }

    /** The TOML `command` string that runs one of our scripts. */
    _commandFor(baseName) {
        const scriptName = this.isWindows ? `${baseName}.ps1` : `${baseName}.sh`;
        const scriptPath = this.toUnixPath(path.join(this.hooksScriptsDir, scriptName));
        if (this.isWindows) {
            return `powershell.exe -ExecutionPolicy Bypass -File '${scriptPath}'`;
        }
        return `/bin/bash '${scriptPath}'`;
    }

    // ============================================================
    // Structural TOML block handling
    // ============================================================

    /**
     * Build the [[hooks]] tables for one group.
     * @param {string} group - 'notifications' | 'titleGate' | 'fileChange'
     * @returns {string}
     */
    _buildGroupBlock(group) {
        const table = (event, command, { matcher = null, timeout = 30 } = {}) => {
            const lines = ['[[hooks]]', `event = ${JSON.stringify(event)}`];
            if (matcher) lines.push(`matcher = ${JSON.stringify(matcher)}`);
            lines.push(`command = ${JSON.stringify(command)}`);
            lines.push(`timeout = ${timeout}`);
            return lines.join('\n');
        };

        if (group === 'notifications') {
            const cmd = this._commandFor('kimi-notify-hook');
            // No Notification table: see the class header. Configs written by older
            // builds shed theirs on the next install, because _installGroup strips
            // every table carrying our tag before rewriting the group.
            return [
                table('Stop', cmd, { timeout: 5 }),
                table('PermissionRequest', cmd, { timeout: 5 }),
            ].join('\n\n');
        }
        if (group === 'titleGate') {
            return table('PreToolUse', this._commandFor('title-gate-hook'), { timeout: 30 });
        }
        if (group === 'fileChange') {
            return table('PostToolUse', this._commandFor('kimi-edit-write-hook'), { matcher: 'Write|Edit', timeout: 10 });
        }
        throw new Error(`Unknown hook group: ${group}`);
    }

    _tagFor(group) {
        if (group === 'notifications') return KimiHooksManager.NOTIFY_TAG;
        if (group === 'titleGate') return KimiHooksManager.GATE_TAG;
        if (group === 'fileChange') return KimiHooksManager.FILECHANGE_TAG;
        throw new Error(`Unknown hook group: ${group}`);
    }

    /**
     * Remove OUR [[hooks]] tables carrying `tag` from raw TOML, structurally: a flat
     * [[hooks]] table runs from its header to the next [table]/[[table]] header or EOF.
     * Everything else is preserved byte-for-byte.
     */
    _stripBlocks(content, tag) {
        if (!content) return '';
        const lines = content.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            if (lines[i].trim() === '[[hooks]]') {
                let j = i + 1;
                const group = [lines[i]];
                while (j < lines.length) {
                    const t = lines[j].trim();
                    if (t.startsWith('[')) break;
                    group.push(lines[j]);
                    j++;
                }
                if (group.join('\n').includes(tag)) {
                    i = j;
                    if (i < lines.length && lines[i].trim() === '') i++;
                    continue;
                }
            }
            out.push(lines[i]);
            i++;
        }
        return out.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    _hasBlocks(content, tag) {
        return !!content && content.includes('[[hooks]]') && content.includes(tag);
    }

    /**
     * Idempotently (re)write one group's [[hooks]] tables into config.toml.
     */
    async _installGroup(group, writeScripts) {
        try {
            await this.ensureHooksDirectory();
            await this.ensureConfigDirectory();
            writeScripts();

            let content = '';
            const existing = safeReadConfigFile(this.configPath);
            if (existing !== null) content = existing;

            content = this._stripBlocks(content, this._tagFor(group));
            content = content.replace(/\s*$/, '');

            const block = this._buildGroupBlock(group);
            content = content.length ? `${content}\n\n${block}\n` : `${block}\n`;

            fs.writeFileSync(this.configPath, content, 'utf8');
            return { success: true };
        } catch (error) {
            console.error(`[KimiHooksManager] Error installing ${group}:`, error);
            return { success: false, error: error.message };
        }
    }

    async _removeGroup(group) {
        try {
            const existing = safeReadConfigFile(this.configPath);
            if (existing === null) return { success: true };
            const tag = this._tagFor(group);
            if (!existing.includes(tag)) return { success: true };

            let content = this._stripBlocks(existing, tag);
            content = content.replace(/\s*$/, '');
            content = content.length ? `${content}\n` : '';

            fs.writeFileSync(this.configPath, content, 'utf8');
            return { success: true };
        } catch (error) {
            console.error(`[KimiHooksManager] Error removing ${group}:`, error);
            return { success: false, error: error.message };
        }
    }

    async _hasGroup(group) {
        try {
            const content = safeReadConfigFile(this.configPath);
            return this._hasBlocks(content, this._tagFor(group));
        } catch (error) {
            return false;
        }
    }

    // ============================================================
    // Granular hook groups (contract required by HookSystemPreferences —
    // the has* methods are called UNGUARDED, all must exist)
    // ============================================================

    async installNotificationsHooks() {
        return this._installGroup('notifications', () =>
            this._writeScript('kimi-notify-hook', this.getUnixNotifyScript(), this.getWindowsNotifyScript()));
    }

    async removeNotificationsHooks() {
        return this._removeGroup('notifications');
    }

    async hasNotificationsHooks() {
        return this._hasGroup('notifications');
    }

    async installTitleGateHooks() {
        return this._installGroup('titleGate', () => this.createTitleGateScript());
    }

    async removeTitleGateHooks() {
        return this._removeGroup('titleGate');
    }

    async hasTitleGateHooks() {
        return this._hasGroup('titleGate');
    }

    async installFileChangeHooks() {
        return this._installGroup('fileChange', () =>
            this._writeScript('kimi-edit-write-hook', this.getUnixFileChangeScript(), this.getWindowsFileChangeScript()));
    }

    async removeFileChangeHooks() {
        return this._removeGroup('fileChange');
    }

    async hasFileChangeHooks() {
        return this._hasGroup('fileChange');
    }

    // ============================================================
    // Aggregate operations
    // ============================================================

    async installHooks() {
        const notif = await this.installNotificationsHooks();
        const gate = await this.installTitleGateHooks();
        const files = await this.installFileChangeHooks();
        const ok = notif.success && gate.success && files.success;
        return ok ? { success: true } : { success: false, error: notif.error || gate.error || files.error };
    }

    async removeHooks() {
        const notif = await this.removeNotificationsHooks();
        const gate = await this.removeTitleGateHooks();
        const files = await this.removeFileChangeHooks();
        const ok = notif.success && gate.success && files.success;
        return ok ? { success: true } : { success: false, error: notif.error || gate.error || files.error };
    }

    /**
     * Status snapshot. PURE DISK READ — no subprocess — so it can never hang the
     * e2e sandbox (skill gotcha 4).
     */
    async checkHooksStatus() {
        const hasNotifyHook = await this.hasNotificationsHooks();
        const hasFileChangeTracking = await this.hasFileChangeHooks();
        const hasTitleGate = await this.hasTitleGateHooks();
        return {
            installed: hasNotifyHook,
            hasNotifyHook,
            hasFileChangeTracking,
            hasTitleGate,
            hasPreToolHook: hasTitleGate,
            hasPostToolHook: hasFileChangeTracking,
            settingsPath: this.configPath,
        };
    }

    /**
     * Boot-time reconciliation: make sure the script FILES exist for every group that
     * config.toml references (the config may point at scripts wiped by a reinstall).
     */
    async ensureHookScripts() {
        try {
            await this.ensureHooksDirectory();
            if (await this.hasTitleGateHooks()) this.createTitleGateScript();
            if (await this.hasNotificationsHooks()) {
                this._writeScript('kimi-notify-hook', this.getUnixNotifyScript(), this.getWindowsNotifyScript());
            }
            if (await this.hasFileChangeHooks()) {
                this._writeScript('kimi-edit-write-hook', this.getUnixFileChangeScript(), this.getWindowsFileChangeScript());
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Install everything (used by the boot reconciler / first-run flow).
     */
    async ensureFullConfiguration() {
        return this.installHooks();
    }
}

module.exports = KimiHooksManager;
