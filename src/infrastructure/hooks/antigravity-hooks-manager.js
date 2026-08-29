const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { hasOwnedMcpRuntime } = require('../config/mcp-entry-ownership');

/**
 * AntigravityHooksManager - Hook + MCP management for Antigravity CLI (`agy`).
 *
 * Antigravity does NOT merge hooks into a shared settings.json like Gemini.
 * CodeAgentSwarm's entire integration is delivered as a single installed PLUGIN:
 *
 *   ~/.gemini/antigravity-cli/plugins/codeagentswarm/
 *     ├── plugin.json        (required: { name, version, description })
 *     ├── hooks.json         (PreToolUse / PostToolUse / Stop / Notification)
 *     └── mcp_config.json    (codeagentswarm-tasks MCP server)
 *
 * Activated with `agy plugin install <dir>` (registers it in import_manifest.json;
 * a bare directory is inert). Removed with `agy plugin uninstall codeagentswarm`.
 *
 * VERIFIED against agy v1.0.13:
 *  - hooks.json group schema:
 *      { "<group>": { "enabled": true, "PreToolUse":[{ "matcher":"*", "hooks":[{ "type":"command","command":"..." }] }], ... } }
 *  - A PreToolUse hook reads JSON on STDIN:
 *      { toolCall:{ name, args:{ CommandLine, Cwd, ... } }, conversationId, transcriptPath, stepIdx, ... }
 *    and allows/denies via STDOUT: print nothing/exit 0 => ALLOW; print
 *    {"decision":"deny","reason":"..."} => DENY. agy's hook protocol has NO
 *    non-blocking context channel — deny is its only output lever. CodeAgentSwarm
 *    hooks must never block a tool call (a session without the CAS MCP tools cannot
 *    comply with a gate), so CAS deliberately NEVER emits the deny: the installed
 *    title hook is a documented NO-OP, kept only for toggle/reconcile uniformity
 *    across agents.
 *  - matcher "*" fires for every tool (verified) => the title hook sees every tool
 *    (and, being a no-op, does nothing for all of them).
 *  - shell tool name == "run_command".
 */
class AntigravityHooksManager {
    constructor(options = {}) {
        this.isDevMode = options.isDevMode || false;
        // Match WebhookServer ports: Production 45782, Development 45783.
        this.webhookPort = this.isDevMode ? 45783 : 45782;
        this.isWindows = process.platform === 'win32';

        // The single plugin directory that carries our hooks + MCP into agy.
        this.pluginName = 'codeagentswarm';
        this.pluginDir = path.join(
            os.homedir(), '.gemini', 'antigravity-cli', 'plugins', this.pluginName
        );
        // Shared hook scripts dir (same as Claude/Gemini/Codex).
        this.hooksScriptsDir = path.join(os.homedir(), '.codeagentswarm', 'hooks');
        // Path shown by the Privacy panel as "where our config lives" for this agent.
        this.settingsPath = path.join(this.pluginDir, 'hooks.json');
        // Antigravity's launcher recovers the per-session environment from its
        // parent process before starting the shared MCP stdio server.
        this.mcpServerScript = this.isDevMode
            ? path.resolve(__dirname, '..', 'mcp', 'antigravity-mcp-launcher.js')
            : path.join(
                os.homedir(), '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks',
                'src', 'infrastructure', 'mcp', 'antigravity-mcp-launcher.js'
            );
        // CRITICAL: agy loads ACTIVE MCP servers from the GLOBAL ~/.gemini/config/mcp_config.json
        // (and per-workspace .agents/mcp_config.json). A plugin's own mcp_config.json is only
        // recognized as a "component" by `agy plugin install` and is NEVER started — so the task
        // tools (set_terminal_title/create_task/...) must be merged here, or the agent gets
        // "unknown tool name" and, unable to set the title, deadlocks against the title gate.
        this.globalMcpConfigPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');

        // Which CodeAgentSwarm hook groups are currently desired in the plugin.
        // Default all-on; reconcileAgentHooks() flips these per the Privacy toggles
        // by calling the granular install/remove*Hooks methods below, then we
        // rebuild the single plugin to contain exactly the enabled groups.
        this.enabledGroups = new Set(['notifications', 'fileChange', 'titleGate']);

        console.log(`[AntigravityHooksManager] Initialized (${this.isDevMode ? 'DEV' : 'PROD'} mode, port ${this.webhookPort})`);
    }

    toUnixPath(filePath) {
        return filePath.replace(/\\/g, '/');
    }

    // ============================================================
    // agy binary resolution
    // ============================================================
    getAgyPath() {
        try {
            const installer = require('../services/antigravity-cli-installer');
            return installer.getAgyPath() || 'agy';
        } catch (e) {
            return 'agy';
        }
    }

    // ============================================================
    // Webhook hook commands (Stop -> claude_finished, Notification -> confirmation_needed)
    // Agent-agnostic: identical plumbing to the Gemini manager.
    // ============================================================
    buildHookCommand(eventType, tool = '') {
        return this.isWindows
            ? this.buildWindowsHookCommand(eventType, tool)
            : this.buildUnixHookCommand(eventType, tool);
    }

    buildUnixHookCommand(eventType, tool = '') {
        // Post to THIS instance's webhook port (injected into the PTY env by CodeAgentSwarm);
        // the fallbacks keep the legacy dev-first (45783) / prod (45782) behaviour for older builds.
        const devPort = `\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}`;
        const prodPort = `\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}`;
        // Outside a CodeAgentSwarm terminal (no quadrant env) both commands must
        // stay silent — these hooks live in the agent's global config and fire in
        // every session on the machine. Driver-backed Chat children
        // (CODEAGENTSWARM_DRIVER_CHAT) are silent too: the chat driver already
        // reports turn ends and permission requests itself (task #12330).
        if (eventType === 'claude_finished') {
            return `sh -c '[ -n "$CODEAGENTSWARM_CURRENT_QUADRANT" ] && [ -z "$CODEAGENTSWARM_DRIVER_CHAT" ] && [ -z "$CODEAGENTSWARM_COMMIT_MODE" ] && (curl -X POST http://127.0.0.1:${devPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT})\\"}" --silent --fail 2>/dev/null || curl -X POST http://127.0.0.1:${prodPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT})\\"}" --silent --fail 2>/dev/null) || true'`;
        }
        return `sh -c '[ -n "$CODEAGENTSWARM_CURRENT_QUADRANT" ] && [ -z "$CODEAGENTSWARM_DRIVER_CHAT" ] && (curl -X POST http://127.0.0.1:${devPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT})\\",\\"tool\\":\\"${tool}\\"}" --silent --fail 2>/dev/null || curl -X POST http://127.0.0.1:${prodPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT})\\",\\"tool\\":\\"${tool}\\"}" --silent --fail 2>/dev/null) || true'`;
    }

    buildWindowsHookCommand(eventType, tool = '') {
        const scriptPath = this.toUnixPath(path.join(this.hooksScriptsDir, 'webhook-notifier.ps1'));
        const base = `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}" -EventType "${eventType}"`;
        return tool ? `${base} -Tool "${tool}"` : base;
    }

    // Antigravity file-change hook (feeds FileChangeTracker -> the diff viewer).
    // agy's PostToolUse payload has toolCall:null, so we capture at PreToolUse on the
    // write tools, where toolCall.args.TargetFile + CodeContent are present (verified
    // against agy v1.0.13). The shared edit-write-hook expects Claude's tool_input
    // shape, so Antigravity needs its own script.
    getFileChangeScriptPath() {
        return this.isWindows
            ? path.join(this.hooksScriptsDir, 'agy-file-change-hook.ps1')
            : path.join(this.hooksScriptsDir, 'agy-file-change-hook.sh');
    }

    buildFileChangeHookCommand() {
        const p = this.toUnixPath(this.getFileChangeScriptPath());
        return this.isWindows
            ? `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${p}"`
            : p;
    }

    // ============================================================
    // Title-gate script (agy dialect) — intentional NO-OP, never blocks
    // ============================================================
    getTitleGateScriptPath() {
        return this.isWindows
            ? path.join(this.hooksScriptsDir, 'agy-title-gate.ps1')
            : path.join(this.hooksScriptsDir, 'agy-title-gate.sh');
    }

    titleGateHookCommand() {
        const p = this.toUnixPath(this.getTitleGateScriptPath());
        return this.isWindows
            ? `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${p}"`
            : p;
    }

    getBashTitleGateScript() {
        return `#!/bin/bash
# agy-title-gate.sh - CodeAgentSwarm PreToolUse title hook for Antigravity (NO-OP).
# Auto-generated by CodeAgentSwarm - Do not edit manually.
#
# CodeAgentSwarm hooks must NEVER block a tool call: a session where the
# codeagentswarm-tasks MCP server is not connected has no set_terminal_title
# tool to call, so blocking would trap the user. Antigravity's hook protocol
# offers no non-blocking output channel (its only verdict rejects the tool),
# so this hook intentionally does nothing. It stays installed so the Privacy
# toggle and the boot reconciler keep a uniform surface across agents.
cat > /dev/null 2>&1
exit 0
`;
    }

    getPowerShellTitleGateScript() {
        return `# agy-title-gate.ps1 - CodeAgentSwarm PreToolUse title hook for Antigravity (NO-OP).
# Auto-generated by CodeAgentSwarm - Do not edit manually.
#
# CodeAgentSwarm hooks must NEVER block a tool call: a session where the
# codeagentswarm-tasks MCP server is not connected has no set_terminal_title
# tool to call, so blocking would trap the user. Antigravity's hook protocol
# offers no non-blocking output channel (its only verdict rejects the tool),
# so this hook intentionally does nothing. It stays installed so the Privacy
# toggle and the boot reconciler keep a uniform surface across agents.
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::In.ReadToEnd() | Out-Null } catch {}
exit 0
`;
    }

    // File-change hook (agy dialect). PreToolUse on write_to_file/create_file: pull
    // TargetFile + CodeContent from toolCall.args, read the pre-edit content off disk,
    // and POST a file_edited event to the webhook. Emits NO decision (never blocks).
    getBashFileChangeScript() {
        return `#!/bin/bash
# agy-file-change-hook.sh - CodeAgentSwarm Antigravity PreToolUse file-change tracker.
# Auto-generated by CodeAgentSwarm - Do not edit manually.
# Post to THIS instance's webhook port (injected into the PTY env by CodeAgentSwarm);
# the fallbacks keep the legacy dev-first (45783) / prod (45782) behaviour for older builds.
WEBHOOK_PORT_DEV="\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}"
WEBHOOK_PORT_PROD="\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}"
# The plugin loads in every agy session on the machine. Outside a CodeAgentSwarm
# terminal (no quadrant env) stay silent — posting as terminal 0 paints phantom
# file-change badges inside the app.
[ -z "\${CODEAGENTSWARM_CURRENT_QUADRANT:-}" ] && exit 0
TERM_ID="\$CODEAGENTSWARM_CURRENT_QUADRANT"
payload="\$(cat 2>/dev/null)" || exit 0
command -v jq >/dev/null 2>&1 || exit 0
filePath="\$(printf '%s' "\$payload" | jq -r '.toolCall.args.TargetFile // .toolCall.args.AbsolutePath // empty' 2>/dev/null)"
[ -z "\$filePath" ] && exit 0
newContent="\$(printf '%s' "\$payload" | jq -r '.toolCall.args.CodeContent // .toolCall.args.Content // empty' 2>/dev/null)"
toolName="\$(printf '%s' "\$payload" | jq -r '.toolCall.name // "write_to_file"' 2>/dev/null)"
originalContent=""
[ -f "\$filePath" ] && originalContent="\$(cat "\$filePath" 2>/dev/null)"
TMP="\$(mktemp)"
trap 'rm -f "\$TMP"' EXIT
jq -n --arg t "\$TERM_ID" --arg tn "\$toolName" --arg fp "\$filePath" --arg nc "\$newContent" --arg oc "\$originalContent" '{type:"file_edited",terminalId:\$t,toolName:\$tn,filePath:\$fp,content:\$nc,originalContent:\$oc,newContent:\$nc}' > "\$TMP" 2>/dev/null
curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_DEV/webhook" -H "Content-Type: application/json" -d @"\$TMP" --silent --output /dev/null --max-time 2 2>/dev/null || curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_PROD/webhook" -H "Content-Type: application/json" -d @"\$TMP" --silent --output /dev/null --max-time 2 2>/dev/null || true
exit 0
`;
    }

    getPowerShellFileChangeScript() {
        return `# agy-file-change-hook.ps1 - CodeAgentSwarm Antigravity PreToolUse file-change tracker.
# Auto-generated by CodeAgentSwarm - Do not edit manually.
\$ErrorActionPreference = 'SilentlyContinue'
# Outside a CodeAgentSwarm terminal (no quadrant env) stay silent.
if (-not \$env:CODEAGENTSWARM_CURRENT_QUADRANT) { exit 0 }
\$termId = \$env:CODEAGENTSWARM_CURRENT_QUADRANT
try { \$payload = [Console]::In.ReadToEnd() } catch { exit 0 }
try { \$o = \$payload | ConvertFrom-Json } catch { exit 0 }
\$a = \$o.toolCall.args
if (-not \$a) { exit 0 }
\$filePath = \$a.TargetFile; if (-not \$filePath) { \$filePath = \$a.AbsolutePath }
if (-not \$filePath) { exit 0 }
\$newContent = \$a.CodeContent; if (-not \$newContent) { \$newContent = \$a.Content }
\$toolName = \$o.toolCall.name; if (-not \$toolName) { \$toolName = 'write_to_file' }
\$originalContent = ''
if (Test-Path -LiteralPath \$filePath) { try { \$originalContent = Get-Content -LiteralPath \$filePath -Raw } catch {} }
\$body = @{ type='file_edited'; terminalId=\$termId; toolName=\$toolName; filePath=\$filePath; content=\$newContent; originalContent=\$originalContent; newContent=\$newContent } | ConvertTo-Json -Compress
# Post to THIS instance's webhook port when CodeAgentSwarm injected it; otherwise fall
# back to the legacy dev-first (45783) / prod (45782) probe for older builds.
\$ports = if ((\$casPort = \$env:CODEAGENTSWARM_WEBHOOK_PORT -as [int])) { @(\$casPort) } else { @(45783,45782) }
foreach (\$port in \$ports) {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:\$port/webhook" -Method Post -ContentType 'application/json' -Body \$body -TimeoutSec 2 | Out-Null; break } catch {}
}
exit 0
`;
    }

    ensureTitleGateScripts() {
        try {
            if (!fs.existsSync(this.hooksScriptsDir)) {
                fs.mkdirSync(this.hooksScriptsDir, { recursive: true });
            }
            const write = (name, content, exec) => {
                const p = path.join(this.hooksScriptsDir, name);
                fs.writeFileSync(p, content);
                if (exec) { try { fs.chmodSync(p, 0o755); } catch (e) { /* non-fatal */ } }
            };
            write('agy-title-gate.sh', this.getBashTitleGateScript(), true);
            write('agy-title-gate.ps1', this.getPowerShellTitleGateScript(), false);
            write('agy-file-change-hook.sh', this.getBashFileChangeScript(), true);
            write('agy-file-change-hook.ps1', this.getPowerShellFileChangeScript(), false);
            return { success: true };
        } catch (error) {
            console.error('[AntigravityHooksManager] Failed to write hook scripts:', error);
            return { success: false, error: error.message };
        }
    }

    // ============================================================
    // Plugin assembly
    // ============================================================
    buildHooksJson() {
        const group = { enabled: true };
        // Both the title hook and the file-change tracker are PreToolUse hooks (agy's
        // PostToolUse payload has toolCall:null, so file writes must be captured at
        // PreToolUse). Multiple PreToolUse entries are allowed; neither the file-change
        // hook nor the title hook emits any decision at all, so the tool call always
        // proceeds through agy's normal flow.
        const preToolUse = [];
        if (this.enabledGroups.has('titleGate')) {
            preToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: this.titleGateHookCommand() }] });
        }
        if (this.enabledGroups.has('fileChange')) {
            const fc = this.buildFileChangeHookCommand();
            preToolUse.push({ matcher: 'write_to_file', hooks: [{ type: 'command', command: fc }] });
            preToolUse.push({ matcher: 'create_file', hooks: [{ type: 'command', command: fc }] });
        }
        if (preToolUse.length) group.PreToolUse = preToolUse;
        if (this.enabledGroups.has('notifications')) {
            group.Stop = [
                { hooks: [{ type: 'command', command: this.buildHookCommand('claude_finished') }] }
            ];
            group.Notification = [
                { matcher: '*', hooks: [{ type: 'command', command: this.buildHookCommand('confirmation_needed', '{{tool}}') }] }
            ];
        }
        return { [this.pluginName]: group };
    }

    buildMcpConfigJson() {
        return {
            mcpServers: {
                'codeagentswarm-tasks': {
                    type: 'stdio',
                    command: 'node',
                    args: [this.mcpServerScript],
                    // The launcher adds only a validated per-session capability.
                    env: { CODEAGENTSWARM_AGENT_TYPE: 'antigravity' }
                }
            }
        };
    }

    // Merge the codeagentswarm-tasks server into agy's GLOBAL mcp_config.json (preserving
    // any other servers the user has). This is what actually makes the task tools available.
    ensureGlobalMcpServer() {
        try {
            const dir = path.dirname(this.globalMcpConfigPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            let cfg = {};
            try {
                if (fs.existsSync(this.globalMcpConfigPath)) {
                    const raw = fs.readFileSync(this.globalMcpConfigPath, 'utf8').trim();
                    if (raw) cfg = JSON.parse(raw);
                }
            } catch (error) {
                return {
                    success: false,
                    error: `Invalid Antigravity MCP config; file left untouched: ${error.message}`
                };
            }
            if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
            const existing = cfg.mcpServers['codeagentswarm-tasks'];
            if (existing && !hasOwnedMcpRuntime(existing)) {
                return { success: false, error: "MCP key 'codeagentswarm-tasks' belongs to the user; refusing to overwrite it" };
            }
            cfg.mcpServers['codeagentswarm-tasks'] = {
                // The launcher adds only a validated per-session capability.
                type: 'stdio', command: 'node', args: [this.mcpServerScript], env: { CODEAGENTSWARM_AGENT_TYPE: 'antigravity' }
            };
            fs.writeFileSync(this.globalMcpConfigPath, JSON.stringify(cfg, null, 2));
            return { success: true };
        } catch (error) {
            console.error('[AntigravityHooksManager] Failed to write global MCP config:', error);
            return { success: false, error: error.message };
        }
    }

    removeGlobalMcpServer() {
        try {
            if (!fs.existsSync(this.globalMcpConfigPath)) return { success: true };
            const raw = fs.readFileSync(this.globalMcpConfigPath, 'utf8').trim();
            if (!raw) return { success: true };
            const cfg = JSON.parse(raw);
            if (cfg.mcpServers && cfg.mcpServers['codeagentswarm-tasks']) {
                const existing = cfg.mcpServers['codeagentswarm-tasks'];
                if (!hasOwnedMcpRuntime(existing)) {
                    return { success: true, preserved: true };
                }
                delete cfg.mcpServers['codeagentswarm-tasks'];
                fs.writeFileSync(this.globalMcpConfigPath, JSON.stringify(cfg, null, 2));
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    buildPluginJson() {
        let version = '1.0.0';
        try {
            version = JSON.parse(fs.readFileSync(
                path.join(__dirname, '..', '..', '..', 'package.json'),
                'utf8'
            )).version || '1.0.0';
        } catch (e) { /* fall back */ }
        return {
            name: this.pluginName,
            version,
            description: 'CodeAgentSwarm integration: task tools, Agent title gate, finished/confirmation notifications, and file-change tracking for the diff viewer.'
        };
    }

    writePluginFiles({ includeMcp = true } = {}) {
        if (!fs.existsSync(this.pluginDir)) {
            fs.mkdirSync(this.pluginDir, { recursive: true });
        }
        fs.writeFileSync(
            path.join(this.pluginDir, 'plugin.json'),
            JSON.stringify(this.buildPluginJson(), null, 2)
        );
        fs.writeFileSync(
            path.join(this.pluginDir, 'hooks.json'),
            JSON.stringify(this.buildHooksJson(), null, 2)
        );
        if (includeMcp) {
            fs.writeFileSync(
                path.join(this.pluginDir, 'mcp_config.json'),
                JSON.stringify(this.buildMcpConfigJson(), null, 2)
            );
        }
    }

    // ============================================================
    // agy plugin CLI
    // ============================================================
    runAgyPlugin(args) {
        // Under the e2e harness (sandbox HOME, agy not authenticated) a real
        // `agy plugin` subprocess hangs to its timeout and would stall
        // get-hooks-status / the Privacy toggle. The plugin FILES are still
        // written by _applyPlugin; agy registration is not asserted in e2e, so
        // skip the subprocess there. E2E_NO_RELOAD is always set by the harness.
        if (process.env.E2E_NO_RELOAD || process.env.CODEAGENTSWARM_SKIP_AGY_PLUGIN) {
            return Promise.resolve({ ok: true, stdout: '', stderr: '', error: null, skipped: true });
        }
        return new Promise((resolve) => {
            const agy = this.getAgyPath();
            execFile(agy, ['plugin', ...args], { timeout: 12000, windowsHide: true }, (error, stdout, stderr) => {
                resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error ? error.message : null });
            });
        });
    }

    isPluginInstalled() {
        try {
            return fs.existsSync(path.join(this.pluginDir, 'plugin.json'));
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // Public lifecycle
    // ============================================================
    // Rebuild the single plugin so it contains exactly the currently-enabled hook
    // groups, then (re)install it into agy. Idempotent (uninstall + install).
    // With every group off the plugin has no reason to exist: it is uninstalled
    // and its directory removed (same contract as opencode), so disabling the
    // Privacy toggles leaves ~/.gemini clean. The GLOBAL mcp_config entry is
    // governed by the MCP-connection toggle (AntigravityConfigStrategy), never
    // written from here.
    async _applyPlugin() {
        try {
            if (this.enabledGroups.size === 0) {
                await this.runAgyPlugin(['uninstall', this.pluginName]);
                try {
                    if (fs.existsSync(this.pluginDir)) {
                        fs.rmSync(this.pluginDir, { recursive: true, force: true });
                    }
                } catch (e) { /* non-fatal */ }
                return { success: true, installed: false, removed: true };
            }
            this.ensureTitleGateScripts();
            this.writePluginFiles({ includeMcp: true });
            await this.runAgyPlugin(['uninstall', this.pluginName]);
            const res = await this.runAgyPlugin(['install', this.pluginDir]);
            if (!res.ok) {
                // The files are on disk; agy will pick them up once available.
                return { success: true, installed: false, warning: res.error || res.stderr };
            }
            return { success: true, installed: true };
        } catch (error) {
            console.error('[AntigravityHooksManager] Error applying plugin:', error);
            return { success: false, error: error.message };
        }
    }

    async installHooks() {
        this.enabledGroups = new Set(['notifications', 'fileChange', 'titleGate']);
        return this._applyPlugin();
    }

    async removeHooks() {
        try {
            await this.runAgyPlugin(['uninstall', this.pluginName]);
            this.removeGlobalMcpServer();
            try {
                if (fs.existsSync(this.pluginDir)) {
                    fs.rmSync(this.pluginDir, { recursive: true, force: true });
                }
            } catch (e) { /* non-fatal */ }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ── Granular hook groups (mirror Claude/Gemini) so reconcileAgentHooks() can
    //    honor each Privacy toggle independently. Each flips the desired-set and
    //    rebuilds the single plugin. ──────────────────────────────────────────
    async installNotificationsHooks() { this.enabledGroups.add('notifications'); return this._applyPlugin(); }
    async removeNotificationsHooks()  { this.enabledGroups.delete('notifications'); return this._applyPlugin(); }
    async installFileChangeHooks()    { this.enabledGroups.add('fileChange'); return this._applyPlugin(); }
    async removeFileChangeHooks()     { this.enabledGroups.delete('fileChange'); return this._applyPlugin(); }
    async installTitleGateHooks()     { this.enabledGroups.add('titleGate'); return this._applyPlugin(); }
    async removeTitleGateHooks()      { this.enabledGroups.delete('titleGate'); return this._applyPlugin(); }

    // ── Status readers (used by the Privacy panel via HookSystemPreferences).
    //    Read the installed plugin's hooks.json from disk — fast, no subprocess. ──
    _readPluginHookGroups() {
        try {
            const p = path.join(this.pluginDir, 'hooks.json');
            if (!fs.existsSync(p)) return null;
            const j = JSON.parse(fs.readFileSync(p, 'utf8'));
            return (j && j[this.pluginName]) || null;
        } catch (e) {
            return null;
        }
    }

    async hasTitleGateHooks() {
        const g = this._readPluginHookGroups();
        // The title-gate is the wildcard PreToolUse entry.
        return !!(g && Array.isArray(g.PreToolUse) && g.PreToolUse.some(e => e && e.matcher === '*'));
    }

    async hasFileChangeHooks() {
        const g = this._readPluginHookGroups();
        // File-change is captured by PreToolUse entries matching the write tools.
        return !!(g && Array.isArray(g.PreToolUse) && g.PreToolUse.some(
            e => e && (e.matcher === 'write_to_file' || e.matcher === 'create_file')
        ));
    }

    async hasNotificationsHooks() {
        const g = this._readPluginHookGroups();
        const hasStop = !!(g && Array.isArray(g.Stop) && g.Stop.length);
        const hasNotif = !!(g && Array.isArray(g.Notification) && g.Notification.length);
        return hasStop || hasNotif;
    }

    async checkHooksStatus() {
        // Read registration from disk (import_manifest.json) instead of shelling
        // out to `agy plugin list` — fast, never blocks get-hooks-status, and safe
        // under the e2e sandbox where agy would hang.
        let registered = false;
        try {
            const manifestPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'import_manifest.json');
            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                registered = Array.isArray(manifest.imports)
                    && manifest.imports.some(i => i && i.name === this.pluginName);
            }
        } catch (e) { /* treat as not registered */ }
        return {
            installed: this.isPluginInstalled() && registered,
            pluginPresent: this.isPluginInstalled(),
            registered,
            pluginDir: this.pluginDir
        };
    }

    async ensureFullConfiguration() {
        const hooksResult = await this.installHooks();
        return { success: hooksResult.success, hooks: hooksResult };
    }

    // No legacy schema to migrate (plugin-based from day one).
    async migrateLegacySchema() {
        return { success: true, migrated: false };
    }
}

module.exports = AntigravityHooksManager;
