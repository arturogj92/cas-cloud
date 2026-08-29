const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeReadConfigFile, safeWriteConfigFile } = require('../../shared/utils/safe-config-reader');
const titleGateScript = require('./title-gate-script');

// STEALTH MODE v2: Security improvement - hooks now use external scripts
// to prevent SOC/EDR systems from flagging file content in process args
// Fixed: pipe consumption bug - now uses temp file for multi-port fallback
class HooksManager {
    constructor(options = {}) {
        this.settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        // Use different ports for dev vs production to match WebhookServer
        // Production: 45782, Development: 45783
        this.isDevMode = options.isDevMode || false;
        this.webhookPort = this.isDevMode ? 45783 : 45782;
        this.hooksScriptsDir = path.join(os.homedir(), '.codeagentswarm', 'hooks');
        this.isWindows = process.platform === 'win32';
        // After this many minutes without an activity update, the UserPromptSubmit nudge
        // reminds the agent to refresh its terminal activity.
        this.titleNudgeStaleMinutes = 10;

        console.log(`[HooksManager] Initialized (${this.isDevMode ? 'DEV' : 'PROD'} mode, port ${this.webhookPort}, platform: ${this.isWindows ? 'Windows' : 'Unix'})`);

        // Define CodeAgentSwarm hooks with correct format
        // Notification hook with multiple matchers to exclude idle_prompt
        this.codeAgentSwarmHooks = {
            "Notification": [
                {
                    "matcher": "permission_prompt",
                    "hooks": [{
                        "type": "command",
                        "command": this.buildHookCommand('confirmation_needed', '{{tool}}')
                    }]
                },
                {
                    "matcher": "elicitation_dialog",
                    "hooks": [{
                        "type": "command",
                        "command": this.buildHookCommand('confirmation_needed', '{{tool}}')
                    }]
                }
            ],
            "Stop": [{
                "hooks": [{
                    "type": "command",
                    "command": this.buildHookCommand('claude_finished')
                }]
            }],
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [{
                        "type": "command",
                        "command": this.getPreToolUseScript()
                    }]
                },
                // TITLE REMINDER (matcher "" = all tools): non-blocking. While this
                // terminal has no title it injects an additionalContext reminder to
                // call set_terminal_title; it never emits a permissionDecision so it
                // can never block. CAS-only (the script no-ops when the CAS env vars are
                // absent). Independent of the file-change toggle — see
                // installTitleGateHooks() / reconcileAgentHooks.
                {
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": this.getTitleGateScript()
                    }]
                },
                // ASK-USER-QUESTION DETECTOR (task #12030): when the agent shows its
                // multiple-choice question selector, the Stop hook does NOT fire (the
                // turn stays open while it waits), so without this the app never learns
                // the agent stopped and the status badge sits on "Working". PreToolUse is
                // the only reliable signal, so it fires the same confirmation_needed
                // webhook as the Notification hooks (renderer flips the badge to
                // needs_input). FIRE-AND-FORGET on purpose: PreToolUse gates the tool, so
                // the command backgrounds the curl and exits 0 immediately — it can never
                // delay the selector nor surface an error, even with the app closed.
                // Belongs to the NOTIFICATIONS feature (not file-change): see
                // installAskUserQuestionHook() / installNotificationsHooks().
                {
                    "matcher": "AskUserQuestion",
                    "hooks": [{
                        "type": "command",
                        "command": this.buildAskUserQuestionHookCommand()
                    }]
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "Edit|Write",
                    "hooks": [{
                        "type": "command",
                        "command": this.buildFileChangeHookCommand()
                    }]
                },
                {
                    "matcher": "Bash",
                    "hooks": [{
                        "type": "command",
                        "command": this.getPostToolUseScript()
                    }]
                }
            ],
            // Non-blocking nudge: at session start, remind the agent to set the terminal
            // title + current activity before anything else, so terminals always show what
            // they are doing. Plain stdout from a SessionStart hook is injected as context.
            "SessionStart": [
                {
                    "hooks": [{
                        "type": "command",
                        "command": this.getSessionStartCommand()
                    }]
                }
            ],
            // Non-blocking re-nudge: on every user prompt, if this terminal still has no
            // title, or its activity has gone stale, the script prints a one-line reminder
            // (injected as context). It is SILENT once the title is set and the activity is
            // fresh, so a compliant terminal is never bothered. This is what makes the
            // soft SessionStart nudge reliable: an agent that missed it gets reminded again.
            "UserPromptSubmit": [
                {
                    "hooks": [{
                        "type": "command",
                        "command": this.getUserPromptSubmitScript()
                    }]
                }
            ]
        };

        // Define CodeAgentSwarm MCP permissions
        this.codeAgentSwarmMCPPermissions = [
            "mcp__codeagentswarm-tasks__*",
            "mcp__codeagentswarm-tasks__create_task",
            "mcp__codeagentswarm-tasks__start_task",
            "mcp__codeagentswarm-tasks__complete_task",
            "mcp__codeagentswarm-tasks__submit_for_testing",
            "mcp__codeagentswarm-tasks__list_tasks",
            "mcp__codeagentswarm-tasks__search_tasks",
            "mcp__codeagentswarm-tasks__update_task_plan",
            "mcp__codeagentswarm-tasks__update_task_implementation",
            "mcp__codeagentswarm-tasks__update_task_terminal",
            "mcp__codeagentswarm-tasks__update_terminal_title",
            "mcp__codeagentswarm-tasks__set_terminal_title",
            "mcp__codeagentswarm-tasks__update_terminal_activity",
            "mcp__codeagentswarm-tasks__create_project",
            "mcp__codeagentswarm-tasks__get_projects",
            "mcp__codeagentswarm-tasks__get_project_tasks",
            "mcp__codeagentswarm-tasks__create_subtask",
            "mcp__codeagentswarm-tasks__get_subtasks",
            "mcp__codeagentswarm-tasks__link_task_to_parent",
            "mcp__codeagentswarm-tasks__unlink_task_from_parent",
            "mcp__codeagentswarm-tasks__get_task_hierarchy",
            "mcp__codeagentswarm-tasks__suggest_parent_tasks"
        ];
    }

    /**
     * Convert Windows paths to Unix format for shell compatibility
     * Shell interpreters (bash, sh) cannot execute paths with backslashes
     * @param {string} filePath - Path to convert
     * @returns {string} - Path with forward slashes (C:\Users\... → C:/Users/...)
     */
    toUnixPath(filePath) {
        return filePath.replace(/\\/g, '/');
    }

    /**
     * Get the path to PreToolUse script (platform-specific)
     */
    getPreToolUseScript() {
        if (this.isWindows) {
            return `powershell.exe -ExecutionPolicy Bypass -File "${this.toUnixPath(path.join(this.hooksScriptsDir, 'bash-pre-snapshot.ps1'))}"`;
        }
        return this.toUnixPath(path.join(this.hooksScriptsDir, 'bash-pre-snapshot.sh'));
    }

    /**
     * Get the path to PostToolUse script (platform-specific)
     */
    getPostToolUseScript() {
        if (this.isWindows) {
            return `powershell.exe -ExecutionPolicy Bypass -File "${this.toUnixPath(path.join(this.hooksScriptsDir, 'bash-post-compare.ps1'))}"`;
        }
        return this.toUnixPath(path.join(this.hooksScriptsDir, 'bash-post-compare.sh'));
    }

    /**
     * SessionStart nudge command. Prints a one-line reminder to stdout, which Claude Code
     * injects as context at session start (non-blocking). The message intentionally uses
     * NO quotes/apostrophes/parentheses so the same text is safe inside `echo "..."` (sh)
     * and `Write-Output '...'` (PowerShell). The phrase "set its title and current activity"
     * is the marker matched by isCodeAgentSwarmHook() for de-duplication — it must appear
     * in BOTH message variants. The command branches at RUNTIME on the per-agent
     * status-off flag (written by main.js from the Privacy toggle) so a toggle needs no
     * hook reinstall; SessionStart is a Claude Code hook, so it reads the fixed
     * `status-off-claude` flag.
     *
     * The hook lives in the GLOBAL ~/.claude/settings.json, so it fires for every
     * `claude` session on the machine — including ones launched outside CodeAgentSwarm.
     * Outside a CAS terminal (no CODEAGENTSWARM_CURRENT_QUADRANT and no
     * CODEAGENTSWARM_TERMINAL_ID) the command MUST stay silent, same as the
     * UserPromptSubmit nudge script, or every native Claude Code session opens with a
     * CodeAgentSwarm reminder about tools it may not even have (feedback #df75e30d).
     */
    getSessionStartCommand() {
        // NOTE: the phrase "set its title and current activity" is the marker
        // isCodeAgentSwarmHook() matches to de-duplicate this hook across restarts.
        // It must appear in BOTH message variants. The command branches at RUNTIME
        // on the per-agent status-off flag (written by main.js from the Privacy
        // toggle) so a toggle needs no hook reinstall.
        const fullMsg = 'CodeAgentSwarm: before anything else in this agent, set its title and current activity, and its work-phase status. Call set_terminal_title once with the feature-level title, then update_terminal_activity with your first step, and set_terminal_status with status=working when you start working. Update the status at every phase change (needs_input, needs_testing, done). A manual rename always wins.';
        const noStatusMsg = 'CodeAgentSwarm: before anything else in this agent, set its title and current activity. Call set_terminal_title once with the feature-level title, then update_terminal_activity with your first step. A manual rename always wins.';
        if (this.isWindows) {
            return `powershell.exe -Command "if ((-not $env:CODEAGENTSWARM_CURRENT_QUADRANT) -and (-not $env:CODEAGENTSWARM_TERMINAL_ID)) { exit 0 }; $flag = Join-Path $env:USERPROFILE '.codeagentswarm/terminal-nudge-state/status-off-claude'; if (Test-Path $flag) { Write-Output '${noStatusMsg}' } else { Write-Output '${fullMsg}' }"`;
        }
        return `sh -c 'if [ -z "$CODEAGENTSWARM_CURRENT_QUADRANT" ] && [ -z "$CODEAGENTSWARM_TERMINAL_ID" ]; then exit 0; fi; if [ -f "$HOME/.codeagentswarm/terminal-nudge-state/status-off-claude" ]; then echo "${noStatusMsg}"; else echo "${fullMsg}"; fi'`;
    }

    /**
     * UserPromptSubmit nudge command: points at the title-nudge script written to disk by
     * ensureHookScripts(). The script is SILENT unless the terminal needs a title or a fresh
     * activity, so it is safe to run on every prompt. The path 'title-nudge-hook' is the
     * marker matched by isCodeAgentSwarmHook() for de-duplication.
     */
    getUserPromptSubmitScript() {
        if (this.isWindows) {
            return `powershell.exe -ExecutionPolicy Bypass -File "${this.toUnixPath(path.join(this.hooksScriptsDir, 'title-nudge-hook.ps1'))}"`;
        }
        return this.toUnixPath(path.join(this.hooksScriptsDir, 'title-nudge-hook.sh'));
    }

    /**
     * Bash title-nudge script (UserPromptSubmit). Reminds the agent, ONLY when needed, to
     * set the terminal title and keep its activity fresh. Reads the per-terminal state files
     * written by main.js (terminal-nudge-state.js). Keys on the STABLE terminal id
     * (<id>.title / <id>.activity) exactly like the title reminder — falling back to the (mutable)
     * quadrant for terminals spawned before CODEAGENTSWARM_TERMINAL_ID existed — so a titled
     * terminal is never falsely nagged after a CAS renumber. Silent when titled + fresh.
     */
    getBashTitleNudgeScript() {
        const staleMinutes = this.titleNudgeStaleMinutes;
        return `#!/bin/bash
# ============================================================================
# title-nudge-hook.sh - CodeAgentSwarm UserPromptSubmit nudge
# Reminds the agent to set a terminal title and keep its activity fresh.
# Stdout is injected as context by Claude Code. Silent when nothing is needed.
# State files are written by main.js via terminal-nudge-state.js.
# ============================================================================
q="\${CODEAGENTSWARM_CURRENT_QUADRANT}"
tid="\${CODEAGENTSWARM_TERMINAL_ID}"
# Not inside CodeAgentSwarm (no quadrant AND no terminal id) -> stay silent.
[ -z "\$q" ] && [ -z "\$tid" ] && exit 0
state_dir="\$HOME/.codeagentswarm/terminal-nudge-state"
# Key on the STABLE terminal id when present (renumber-proof, same as the gate);
# fall back to the (mutable) quadrant only for older terminals without the id.
if [ -n "\$tid" ]; then
  key="\$(printf '%s' "\$tid" | tr -c 'A-Za-z0-9_-' '_')"
else
  key="\$q"
fi
title_file="\$state_dir/\$key.title"
activity_file="\$state_dir/\$key.activity"
status_file="\$state_dir/\$key.status"
# Per-agent Privacy toggle (this script is Claude-only: UserPromptSubmit is a Claude Code hook).
status_off_flag="\$state_dir/status-off-claude"
if [ ! -f "\$title_file" ]; then
  if [ -f "\$status_off_flag" ]; then
    echo "CodeAgentSwarm: this agent still has no title. Before doing anything else, call set_terminal_title with a short feature-level title, then update_terminal_activity with what you are about to do."
  else
    echo "CodeAgentSwarm: this agent still has no title. Before doing anything else, call set_terminal_title with a short feature-level title, then update_terminal_activity with what you are about to do, and set_terminal_status with status=\\"working\\"."
  fi
elif [ -z "\$(find "\$activity_file" -mmin -${staleMinutes} 2>/dev/null)" ]; then
  echo "CodeAgentSwarm: your agent activity is stale. Call update_terminal_activity with what you are doing right now so the Agent tab keeps showing your current status."
fi
# Work-phase STATUS nudge (independent of the title/activity ones): the user just
# sent a prompt, so a resting status (needs_testing/done/needs_input/...) is about
# to be wrong. The .status file's CONTENT is the current status key. Silenced when
# the status feature is off for Claude (title/activity nudges are unaffected).
if [ ! -f "\$status_off_flag" ] && [ -f "\$title_file" ]; then
  if [ ! -f "\$status_file" ]; then
    echo "CodeAgentSwarm: this agent has no work-phase status yet. If you are starting to work, call set_terminal_status with status=\\"working\\" and keep it updated at every phase change."
  else
    current_status="\$(cat "\$status_file" 2>/dev/null)"
    if [ -n "\$current_status" ] && [ "\$current_status" != "working" ]; then
      echo "CodeAgentSwarm: the user just sent a prompt while this agent's status is '\$current_status'. If you are going to work on it, call set_terminal_status with status=\\"working\\" NOW; and when you stop again (asking something, handing over for testing, or finished) set the matching status before ending your turn."
    fi
  fi
fi
exit 0
`;
    }

    /**
     * PowerShell title-nudge script (UserPromptSubmit). Windows counterpart of
     * getBashTitleNudgeScript().
     */
    getPowerShellTitleNudgeScript() {
        const staleMinutes = this.titleNudgeStaleMinutes;
        return `# ============================================================================
# title-nudge-hook.ps1 - CodeAgentSwarm UserPromptSubmit nudge
# Reminds the agent to set a terminal title and keep its activity fresh.
# Stdout is injected as context by Claude Code. Silent when nothing is needed.
# ============================================================================
$q = $env:CODEAGENTSWARM_CURRENT_QUADRANT
$tid = $env:CODEAGENTSWARM_TERMINAL_ID
# Not inside CodeAgentSwarm (no quadrant AND no terminal id) -> stay silent.
if ((-not $q) -and (-not $tid)) { exit 0 }
$stateDir = Join-Path $env:USERPROFILE '.codeagentswarm\\terminal-nudge-state'
# Key on the STABLE terminal id when present (renumber-proof, same as the gate); else quadrant.
if ($tid) { $key = ($tid -replace '[^A-Za-z0-9_-]', '_') } else { $key = $q }
$titleFile = Join-Path $stateDir ($key + '.title')
$activityFile = Join-Path $stateDir ($key + '.activity')
$statusFile = Join-Path $stateDir ($key + '.status')
# Per-agent Privacy toggle (this script is Claude-only: UserPromptSubmit is a Claude Code hook).
$statusOffFlag = Join-Path $stateDir 'status-off-claude'
if (-not (Test-Path $titleFile)) {
  if (Test-Path $statusOffFlag) {
    Write-Output 'CodeAgentSwarm: this agent still has no title. Before doing anything else, call set_terminal_title with a short feature-level title, then update_terminal_activity with what you are about to do.'
  } else {
    Write-Output 'CodeAgentSwarm: this agent still has no title. Before doing anything else, call set_terminal_title with a short feature-level title, then update_terminal_activity with what you are about to do, and set_terminal_status with status="working".'
  }
} elseif ((-not (Test-Path $activityFile)) -or (((Get-Date) - (Get-Item $activityFile).LastWriteTime).TotalMinutes -gt ${staleMinutes})) {
  Write-Output 'CodeAgentSwarm: your agent activity is stale. Call update_terminal_activity with what you are doing right now so the Agent tab keeps showing your current status.'
}
# Work-phase STATUS nudge (independent): the user just sent a prompt, so a resting
# status is about to be wrong. The .status file's CONTENT is the current status key.
# Silenced when the status feature is off for Claude (title/activity nudges unaffected).
if ((-not (Test-Path $statusOffFlag)) -and (Test-Path $titleFile)) {
  if (-not (Test-Path $statusFile)) {
    Write-Output 'CodeAgentSwarm: this agent has no work-phase status yet. If you are starting to work, call set_terminal_status with status="working" and keep it updated at every phase change.'
  } else {
    $currentStatus = (Get-Content $statusFile -Raw -ErrorAction SilentlyContinue)
    if ($currentStatus) { $currentStatus = $currentStatus.Trim() }
    if ($currentStatus -and ($currentStatus -ne 'working')) {
      Write-Output ("CodeAgentSwarm: the user just sent a prompt while this agent's status is '" + $currentStatus + "'. If you are going to work on it, call set_terminal_status with status=""working"" NOW; and when you stop again (asking something, handing over for testing, or finished) set the matching status before ending your turn.")
    }
  }
}
exit 0
`;
    }

    /**
     * Path to the PreToolUse title-gate script (platform-specific). This is the
     * non-blocking PreToolUse reminder that nudges the agent to set a title (it never denies).
     */
    getTitleGateScript() {
        if (this.isWindows) {
            return `powershell.exe -ExecutionPolicy Bypass -File "${this.toUnixPath(path.join(this.hooksScriptsDir, 'title-gate-hook.ps1'))}"`;
        }
        return this.toUnixPath(path.join(this.hooksScriptsDir, 'title-gate-hook.sh'));
    }

    /**
     * Bash title-gate script body (shared with Codex via title-gate-script.js).
     * Kept as an instance method so tests and ensureHookScripts() have one entry point.
     */
    getBashTitleGateScript() {
        return titleGateScript.getBashTitleGateScript();
    }

    /**
     * PowerShell title-gate script body (Windows counterpart of getBashTitleGateScript()).
     */
    getPowerShellTitleGateScript() {
        return titleGateScript.getPowerShellTitleGateScript();
    }

    buildHookCommand(eventType, tool = '') {
        if (this.isWindows) {
            return this.buildWindowsHookCommand(eventType, tool);
        }
        return this.buildUnixHookCommand(eventType, tool);
    }

    /**
     * Build hook command for Unix/macOS systems
     * Uses sh -c with curl
     * Posts to CODEAGENTSWARM_WEBHOOK_PORT, falling back to the legacy dev (45783) /
     * prod (45782) ports when the env var is absent
     */
    buildUnixHookCommand(eventType, tool = '') {
        // Use sh -c with explicit variable evaluation to ensure it works across all shells.
        // Both curls target CODEAGENTSWARM_WEBHOOK_PORT — the port of THIS instance's webhook
        // server, injected into the PTY env at spawn. When it is set (a CodeAgentSwarm
        // terminal), both go to the correct port and the second is just a retry. When it is
        // absent (a terminal opened outside CodeAgentSwarm, or spawned by an older build), the
        // fallbacks reproduce the legacy dev-first (45783) / prod (45782) behaviour byte for byte.
        const devPort = `\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}`;
        const prodPort = `\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}`;

        // For claude_finished events, check if we're in commit mode and skip notification if so
        if (eventType === 'claude_finished') {
            return `sh -c '[ -z "$CODEAGENTSWARM_COMMIT_MODE" ] && (curl -X POST http://127.0.0.1:${devPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\"}" --silent --fail 2>/dev/null || curl -X POST http://127.0.0.1:${prodPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\"}" --silent --fail 2>/dev/null) || true'`;
        } else if (eventType === 'confirmation_needed') {
            return `sh -c '(curl -X POST http://127.0.0.1:${devPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\",\\"tool\\":\\"${tool}\\"}" --silent --fail 2>/dev/null || curl -X POST http://127.0.0.1:${prodPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\",\\"tool\\":\\"${tool}\\"}" --silent --fail 2>/dev/null) || true'`;
        } else {
            return `sh -c '(curl -X POST http://127.0.0.1:${devPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\"}" --silent --fail 2>/dev/null || curl -X POST http://127.0.0.1:${prodPort}/webhook -H "Content-Type: application/json" -d "{\\"type\\":\\"${eventType}\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\"}" --silent --fail 2>/dev/null) || true'`;
        }
    }

    /**
     * Build hook command for Windows systems
     * Invokes a dedicated PowerShell script file via -File to avoid the quoting
     * problems that occur when cmd.exe parses an inline -Command containing
     * nested double quotes (e.g. "0") and escaped quotes in JSON bodies (\"type\":...).
     * Always exits with code 0 to prevent Claude Code from reporting hook errors.
     */
    buildWindowsHookCommand(eventType, tool = '') {
        const scriptPath = this.toUnixPath(path.join(this.hooksScriptsDir, 'webhook-notifier.ps1'));
        const base = `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}" -EventType "${eventType}"`;
        if (tool) {
            return `${base} -Tool "${tool}"`;
        }
        return base;
    }

    /**
     * Build the PreToolUse[AskUserQuestion] command (task #12030). Unlike the
     * Notification/Stop commands, a PreToolUse hook BLOCKS the tool until it exits,
     * and this one runs right before the question selector is shown to the user —
     * so on Unix the curl is backgrounded inside a subshell and the command exits 0
     * immediately: zero added latency, and a hung/failed webhook can never block the
     * app or the user. --max-time caps the orphaned curls so they die on their own.
     * On Windows it reuses webhook-notifier.ps1 (TimeoutSec 2, always exits 0) —
     * the same gating pattern the Bash pre-snapshot hook already uses there.
     */
    buildAskUserQuestionHookCommand() {
        if (this.isWindows) {
            return this.buildWindowsHookCommand('confirmation_needed', 'AskUserQuestion');
        }
        // See buildUnixHookCommand: post to THIS instance's port (env), legacy dev/prod fallbacks.
        const devPort = `\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}`;
        const prodPort = `\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}`;
        const body = `{\\"type\\":\\"confirmation_needed\\",\\"terminalId\\":\\"$(echo \${CODEAGENTSWARM_CURRENT_QUADRANT:-0})\\",\\"tool\\":\\"AskUserQuestion\\"}`;
        return `sh -c '( (curl -X POST http://127.0.0.1:${devPort}/webhook -H "Content-Type: application/json" -d "${body}" --silent --fail --max-time 3 || curl -X POST http://127.0.0.1:${prodPort}/webhook -H "Content-Type: application/json" -d "${body}" --silent --fail --max-time 3) >/dev/null 2>&1 & ) ; exit 0'`;
    }

    /**
     * Build hook command for file change tracking (PostToolUse hook)
     * Receives JSON via stdin with tool_name, tool_input.file_path, tool_input.content, etc.
     */
    buildFileChangeHookCommand() {
        if (this.isWindows) {
            return this.buildWindowsFileChangeHookCommand();
        }
        return this.buildUnixFileChangeHookCommand();
    }

    /**
     * Unix/macOS version of file change hook
     * Uses external script for stealth - no sensitive data visible in process arguments
     * This prevents SOC/EDR systems from flagging the curl command as data exfiltration
     */
    buildUnixFileChangeHookCommand() {
        // Use external script for maximum stealth
        // Only the script path appears in process list, no file contents visible
        const scriptPath = path.join(os.homedir(), '.codeagentswarm', 'hooks', 'edit-write-hook.sh');
        return this.toUnixPath(scriptPath);
    }

    /**
     * Windows version of file change hook
     * Uses PowerShell to parse JSON and send webhook (no jq dependency)
     */
    buildWindowsFileChangeHookCommand() {
        // Use external PowerShell script for better reliability
        // The inline command approach has issues with quote escaping in Windows
        const scriptPath = path.join(os.homedir(), '.codeagentswarm', 'hooks', 'edit-write-hook.ps1');
        return `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath.replace(/\\/g, '/')}"`;
    }

    /**
     * Copy the Claude quota statusLine script from the bundled hooks/ folder into
     * ~/.codeagentswarm/hooks/. Unlike the other hook scripts this one is a real file
     * shipped with the app (not generated inline), so it is copied rather than written.
     * The .sh copy is made executable; ClaudeStatuslineManager references this exact path.
     * @param {string} scriptName - e.g. 'quota-statusline.sh' or 'quota-statusline.ps1'
     */
    deployQuotaStatuslineScript(scriptName) {
        // hooks-manager.js lives at src/infrastructure/hooks/, so the bundled hooks/
        // folder is three levels up from __dirname.
        const src = path.join(__dirname, '..', '..', '..', 'hooks', scriptName);
        const dest = path.join(this.hooksScriptsDir, scriptName);
        fs.copyFileSync(src, dest);
        if (scriptName.endsWith('.sh')) {
            fs.chmodSync(dest, '755');
        }
    }

    /**
     * Ensure hook scripts directory exists and scripts are created/updated
     * Called before installing hooks to ensure scripts are available
     */
    async ensureHookScripts() {
        try {
            // Create hooks directory if it doesn't exist
            if (!fs.existsSync(this.hooksScriptsDir)) {
                fs.mkdirSync(this.hooksScriptsDir, { recursive: true });
            }

            if (this.isWindows) {
                // Windows: Create PowerShell scripts
                const preScriptPath = path.join(this.hooksScriptsDir, 'bash-pre-snapshot.ps1');
                fs.writeFileSync(preScriptPath, this.getPowerShellPreSnapshotScript());

                const postScriptPath = path.join(this.hooksScriptsDir, 'bash-post-compare.ps1');
                fs.writeFileSync(postScriptPath, this.getPowerShellPostCompareScript());

                // Webhook notifier used by Notification / Stop hooks.
                // Replaces the fragile inline -Command that broke under cmd.exe quote parsing.
                const webhookScriptPath = path.join(this.hooksScriptsDir, 'webhook-notifier.ps1');
                fs.writeFileSync(webhookScriptPath, this.getPowerShellWebhookNotifierScript());

                // Edit/Write file-change tracker.
                // Referenced by buildWindowsFileChangeHookCommand() and registered under the
                // PostToolUse Edit|Write matcher in codeAgentSwarmHooks. Must be written to
                // disk here — without this, Windows users lose file-change tracking because
                // the hook points at a non-existent .ps1.
                const editWriteScriptPath = path.join(this.hooksScriptsDir, 'edit-write-hook.ps1');
                fs.writeFileSync(editWriteScriptPath, this.getWindowsFileChangeHookScript());

                // UserPromptSubmit nudge: reminds the agent to set a title and keep its
                // activity fresh, reading the per-terminal state files written by main.js.
                const titleNudgeScriptPath = path.join(this.hooksScriptsDir, 'title-nudge-hook.ps1');
                fs.writeFileSync(titleNudgeScriptPath, this.getPowerShellTitleNudgeScript());

                // PreToolUse title reminder: non-blocking nudge to set a title (never denies).
                const titleGateScriptPath = path.join(this.hooksScriptsDir, 'title-gate-hook.ps1');
                fs.writeFileSync(titleGateScriptPath, this.getPowerShellTitleGateScript());

                // Claude quota statusLine script (COPIED from the bundled hooks/ folder, not
                // generated). Claude Code runs it once per render; it snapshots rate_limits to
                // disk so ClaudeQuotaReader can surface the usage quota. ClaudeStatuslineManager
                // installs it into ~/.claude/settings.json and resolves this exact path.
                this.deployQuotaStatuslineScript('quota-statusline.ps1');

                console.log('[HooksManager] PowerShell hook scripts created/updated in', this.hooksScriptsDir);
            } else {
                // macOS/Linux: Create bash scripts
                const preScriptPath = path.join(this.hooksScriptsDir, 'bash-pre-snapshot.sh');
                fs.writeFileSync(preScriptPath, this.getBashPreSnapshotScript());
                fs.chmodSync(preScriptPath, '755');

                const postScriptPath = path.join(this.hooksScriptsDir, 'bash-post-compare.sh');
                fs.writeFileSync(postScriptPath, this.getBashPostCompareScript());
                fs.chmodSync(postScriptPath, '755');

                // STEALTH: Create edit-write-hook.sh for file change tracking
                // This script uses pipes instead of command-line arguments for stealth
                const editWriteScriptPath = path.join(this.hooksScriptsDir, 'edit-write-hook.sh');
                fs.writeFileSync(editWriteScriptPath, this.getUnixFileChangeHookScript());
                fs.chmodSync(editWriteScriptPath, '755');

                // UserPromptSubmit nudge: reminds the agent to set a title and keep its
                // activity fresh, reading the per-terminal state files written by main.js.
                const titleNudgeScriptPath = path.join(this.hooksScriptsDir, 'title-nudge-hook.sh');
                fs.writeFileSync(titleNudgeScriptPath, this.getBashTitleNudgeScript());
                fs.chmodSync(titleNudgeScriptPath, '755');

                // PreToolUse title reminder: non-blocking nudge to set a title (never denies).
                const titleGateScriptPath = path.join(this.hooksScriptsDir, 'title-gate-hook.sh');
                fs.writeFileSync(titleGateScriptPath, this.getBashTitleGateScript());
                fs.chmodSync(titleGateScriptPath, '755');

                // Claude quota statusLine script (COPIED from the bundled hooks/ folder, not
                // generated). Claude Code runs it once per render; it snapshots rate_limits to
                // disk so ClaudeQuotaReader can surface the usage quota. ClaudeStatuslineManager
                // installs it into ~/.claude/settings.json and resolves this exact path.
                this.deployQuotaStatuslineScript('quota-statusline.sh');

                console.log('[HooksManager] Bash hook scripts created/updated in', this.hooksScriptsDir);
            }

            return { success: true };
        } catch (error) {
            console.error('[HooksManager] Failed to create hook scripts:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Generate bash-pre-snapshot.sh script content
     * This script captures file state BEFORE a Bash command modifies it
     */
    getBashPreSnapshotScript() {
        return `#!/bin/bash
# ============================================================================
# bash-pre-snapshot.sh
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PreToolUse hook: Captures file state BEFORE Bash command modifies it
# ============================================================================

# Try both ports for dev/prod compatibility
WEBHOOK_PORT_DEV="\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}"
WEBHOOK_PORT_PROD="\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}"
TERM_ID="\${CODEAGENTSWARM_CURRENT_QUADRANT:-0}"

# Helper function to send webhook - tries both ports
send_webhook() {
    local data="\$1"
    curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_DEV/webhook" -H "Content-Type: application/json" -d "\$data" --silent --fail --max-time 2 2>/dev/null || \\
    curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_PROD/webhook" -H "Content-Type: application/json" -d "\$data" --silent --max-time 2 2>/dev/null
}

# Optional debug logging — OFF unless CODEAGENTSWARM_HOOK_DEBUG is set. Without this guard
# the log grows on every Bash/Edit/Write across all terminals (it once reached ~5 GB).
DEBUG_LOG="\$HOME/.codeagentswarm/hooks/debug.log"
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] PRE-SNAPSHOT called" >> "\$DEBUG_LOG"

# Read JSON from stdin to temp file
TMP=$(mktemp)
trap "rm -f '\$TMP'" EXIT
cat > "\$TMP"

# DEBUG: Log input (only when CODEAGENTSWARM_HOOK_DEBUG is set)
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] PRE Input: $(cat \$TMP)" >> "\$DEBUG_LOG"

# Extract command and cwd from JSON
CMD=$(jq -r '.tool_input.command // ""' "\$TMP" 2>/dev/null)
CWD=$(jq -r '.cwd // ""' "\$TMP" 2>/dev/null)

[ -z "\$CMD" ] && exit 0

# ============================================================================
# Detect target file based on command pattern
# ============================================================================
detect_target_file() {
    local cmd="\$1"
    local file=""

    # sed -i: Get the file argument (last arg that looks like a path)
    if echo "\$cmd" | grep -qE "sed\\s+-i"; then
        # Strip any trailing && or ; commands first
        local sed_cmd=\$(echo "\$cmd" | sed 's/[;&|].*\$//')
        # Get the last argument
        local last_arg=\$(echo "\$sed_cmd" | awk '{print \$NF}')
        # Check if it looks like a file path (contains / or .)
        if echo "\$last_arg" | grep -qE "/|\\.[a-zA-Z]+\$"; then
            file="\$last_arg"
        fi
    fi

    # echo/printf ... > file or >> file (BSD sed compatible, first line only)
    if [ -z "\$file" ] && echo "\$cmd" | head -1 | grep -qE "(echo|printf).*>"; then
        # Get first line, then extract file path after > or >>
        file=\$(echo "\$cmd" | head -1 | sed 's/.*>>[[:space:]]*//' | sed 's/.*>[[:space:]]*//' | awk '{print \$1}' | sed 's/[;&|].*//')
    fi

    # cat ... > file (BSD sed compatible, first line only for heredoc support)
    if [ -z "\$file" ] && echo "\$cmd" | head -1 | grep -qE "cat.*>"; then
        # Get first line only (handles heredoc), then extract file path after > or >>
        file=\$(echo "\$cmd" | head -1 | sed 's/.*>>[[:space:]]*//' | sed 's/.*>[[:space:]]*//' | awk '{print \$1}' | sed 's/[;&|].*//')
    fi

    # cp source dest
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "^cp\\s"; then
        file=$(echo "\$cmd" | awk '{print \$NF}')
    fi

    # mv source dest (return both separated by newline)
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "^mv\\s"; then
        local args=$(echo "\$cmd" | sed 's/^mv\\s\\+\\(-[^[:space:]]*\\s\\+\\)*//')
        local src=$(echo "\$args" | awk '{print \$1}')
        local dst=$(echo "\$args" | awk '{print \$2}')
        [ -n "\$src" ] && echo "\$src"
        [ -n "\$dst" ] && echo "\$dst"
        return
    fi

    # rm file
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "^rm\\s"; then
        file=$(echo "\$cmd" | sed 's/^rm\\s\\+\\(-[^[:space:]]*\\s\\+\\)*//' | awk '{print \$1}')
    fi

    # tee file
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "tee\\s"; then
        file=$(echo "\$cmd" | grep -oE "tee\\s+(-a\\s+)?[^[:space:];|&]+" | awk '{print \$NF}')
    fi

    # Clean quotes
    file=$(echo "\$file" | sed "s/^['\\"']//; s/['\\"']\$//")
    echo "\$file"
}

# ============================================================================
# Resolve relative path to absolute
# ============================================================================
resolve_path() {
    local file="\$1"
    local cwd="\$2"

    [ -z "\$file" ] && return

    # Skip variables and wildcards
    echo "\$file" | grep -qE '[\$*?]' && return

    # Resolve path
    case "\$file" in
        /*) echo "\$file" ;;
        *)  echo "\$cwd/\$file" ;;
    esac
}

# ============================================================================
# Main
# ============================================================================
FILES=$(detect_target_file "\$CMD")
[ -z "\$FILES" ] && exit 0

# Build JSON with file contents
JSON_FILES="{"
FIRST=true

while IFS= read -r file; do
    [ -z "\$file" ] && continue

    FULL_PATH=$(resolve_path "\$file" "\$CWD")
    [ -z "\$FULL_PATH" ] && continue

    # Normalize path
    if [ -d "$(dirname "\$FULL_PATH")" ]; then
        FULL_PATH=$(cd "$(dirname "\$FULL_PATH")" 2>/dev/null && pwd)/$(basename "\$FULL_PATH")
    fi

    # Read content if file exists
    if [ -f "\$FULL_PATH" ]; then
        CONTENT=$(jq -Rs . < "\$FULL_PATH" 2>/dev/null)
    else
        CONTENT="null"
    fi

    # Add to JSON
    if [ "\$FIRST" = true ]; then
        FIRST=false
    else
        JSON_FILES="\$JSON_FILES,"
    fi

    # Escape the path for JSON
    ESCAPED_PATH=$(echo "\$FULL_PATH" | jq -Rs . | sed 's/^"//;s/"$//')
    JSON_FILES="\$JSON_FILES\\"\$ESCAPED_PATH\\":\$CONTENT"

done <<< "\$FILES"

JSON_FILES="\$JSON_FILES}"

# DEBUG: Log what we're sending (only when CODEAGENTSWARM_HOOK_DEBUG is set)
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] PRE Sending - Files: \$JSON_FILES" >> "\$DEBUG_LOG"

# Send snapshot to webhook (tries both ports)
CMD_ESCAPED=$(echo "\$CMD" | jq -Rs .)
WEBHOOK_DATA="{\\"type\\":\\"bash_pre_snapshot\\",\\"terminalId\\":\\"\$TERM_ID\\",\\"command\\":\$CMD_ESCAPED,\\"cwd\\":\\"\$CWD\\",\\"files\\":\$JSON_FILES}"
CURL_RESP=$(send_webhook "\$WEBHOOK_DATA" 2>&1)
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] PRE Curl resp: \$CURL_RESP" >> "\$DEBUG_LOG"

exit 0
`;
    }

    /**
     * Generate bash-post-compare.sh script content
     * This script compares file state AFTER a Bash command executes
     */
    getBashPostCompareScript() {
        return `#!/bin/bash
# ============================================================================
# bash-post-compare.sh
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PostToolUse hook: Compares file state AFTER Bash command executes
# ============================================================================

# Try both ports for dev/prod compatibility
WEBHOOK_PORT_DEV="\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}"
WEBHOOK_PORT_PROD="\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}"
TERM_ID="\${CODEAGENTSWARM_CURRENT_QUADRANT:-0}"

# Helper function to send webhook - tries both ports
send_webhook() {
    local data="\$1"
    curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_DEV/webhook" -H "Content-Type: application/json" -d "\$data" --silent --fail --max-time 2 2>/dev/null || \\
    curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_PROD/webhook" -H "Content-Type: application/json" -d "\$data" --silent --max-time 2 2>/dev/null
}

# Optional debug logging — OFF unless CODEAGENTSWARM_HOOK_DEBUG is set. The POST input
# includes the full tool_response (command stdout), so this is the heaviest writer; keeping
# it gated stops the log from growing unbounded (it once reached ~5 GB).
DEBUG_LOG="\$HOME/.codeagentswarm/hooks/debug.log"
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] POST-COMPARE called" >> "\$DEBUG_LOG"

# Read JSON from stdin to temp file
TMP=$(mktemp)
trap "rm -f '\$TMP'" EXIT
cat > "\$TMP"

# DEBUG: Log input (only when CODEAGENTSWARM_HOOK_DEBUG is set)
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] POST Input: $(cat \$TMP)" >> "\$DEBUG_LOG"

# Extract command and cwd from JSON
CMD=$(jq -r '.tool_input.command // ""' "\$TMP" 2>/dev/null)
CWD=$(jq -r '.cwd // ""' "\$TMP" 2>/dev/null)

[ -z "\$CMD" ] && exit 0

# ============================================================================
# Detect target file based on command pattern (same as pre-snapshot)
# ============================================================================
detect_target_file() {
    local cmd="\$1"
    local file=""

    # sed -i: Get the file argument (last arg that looks like a path)
    if echo "\$cmd" | grep -qE "sed\\s+-i"; then
        local sed_cmd=\$(echo "\$cmd" | sed 's/[;&|].*\$//')
        local last_arg=\$(echo "\$sed_cmd" | awk '{print \$NF}')
        if echo "\$last_arg" | grep -qE "/|\\.[a-zA-Z]+\$"; then
            file="\$last_arg"
        fi
    fi

    # echo/printf ... > (BSD sed compatible, first line only)
    if [ -z "\$file" ] && echo "\$cmd" | head -1 | grep -qE "(echo|printf).*>"; then
        file=\$(echo "\$cmd" | head -1 | sed 's/.*>>[[:space:]]*//' | sed 's/.*>[[:space:]]*//' | awk '{print \$1}' | sed 's/[;&|].*//')
    fi

    # cat ... > (BSD sed compatible, first line only for heredoc)
    if [ -z "\$file" ] && echo "\$cmd" | head -1 | grep -qE "cat.*>"; then
        file=\$(echo "\$cmd" | head -1 | sed 's/.*>>[[:space:]]*//' | sed 's/.*>[[:space:]]*//' | awk '{print \$1}' | sed 's/[;&|].*//')
    fi

    # cp
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "^cp\\s"; then
        file=$(echo "\$cmd" | awk '{print \$NF}')
    fi

    # mv
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "^mv\\s"; then
        local args=$(echo "\$cmd" | sed 's/^mv\\s\\+\\(-[^[:space:]]*\\s\\+\\)*//')
        local src=$(echo "\$args" | awk '{print \$1}')
        local dst=$(echo "\$args" | awk '{print \$2}')
        [ -n "\$src" ] && echo "\$src"
        [ -n "\$dst" ] && echo "\$dst"
        return
    fi

    # rm
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "^rm\\s"; then
        file=$(echo "\$cmd" | sed 's/^rm\\s\\+\\(-[^[:space:]]*\\s\\+\\)*//' | awk '{print \$1}')
    fi

    # tee
    if [ -z "\$file" ] && echo "\$cmd" | grep -qE "tee\\s"; then
        file=$(echo "\$cmd" | grep -oE "tee\\s+(-a\\s+)?[^[:space:];|&]+" | awk '{print \$NF}')
    fi

    file=$(echo "\$file" | sed "s/^['\\"']//; s/['\\"']\$//")
    echo "\$file"
}

resolve_path() {
    local file="\$1"
    local cwd="\$2"

    [ -z "\$file" ] && return
    echo "\$file" | grep -qE '[\$*?]' && return

    case "\$file" in
        /*) echo "\$file" ;;
        *)  echo "\$cwd/\$file" ;;
    esac
}

# ============================================================================
# Main
# ============================================================================
FILES=$(detect_target_file "\$CMD")
[ -z "\$FILES" ] && exit 0

# Build JSON with current file contents
JSON_FILES="{"
FIRST=true

while IFS= read -r file; do
    [ -z "\$file" ] && continue

    FULL_PATH=$(resolve_path "\$file" "\$CWD")
    [ -z "\$FULL_PATH" ] && continue

    # Normalize path
    if [ -d "$(dirname "\$FULL_PATH")" ]; then
        FULL_PATH=$(cd "$(dirname "\$FULL_PATH")" 2>/dev/null && pwd)/$(basename "\$FULL_PATH")
    fi

    # Read current content (after command executed)
    if [ -f "\$FULL_PATH" ]; then
        CONTENT=$(jq -Rs . < "\$FULL_PATH" 2>/dev/null)
    else
        CONTENT="null"  # File was deleted or doesn't exist
    fi

    if [ "\$FIRST" = true ]; then
        FIRST=false
    else
        JSON_FILES="\$JSON_FILES,"
    fi

    ESCAPED_PATH=$(echo "\$FULL_PATH" | jq -Rs . | sed 's/^"//;s/"$//')
    JSON_FILES="\$JSON_FILES\\"\$ESCAPED_PATH\\":\$CONTENT"

done <<< "\$FILES"

JSON_FILES="\$JSON_FILES}"

# DEBUG: Log what we're sending (only when CODEAGENTSWARM_HOOK_DEBUG is set)
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] POST Sending - Files: \$JSON_FILES" >> "\$DEBUG_LOG"

# Send to webhook to compare with pre-snapshot (tries both ports)
CMD_ESCAPED=$(echo "\$CMD" | jq -Rs .)
WEBHOOK_DATA="{\\"type\\":\\"bash_post_compare\\",\\"terminalId\\":\\"\$TERM_ID\\",\\"command\\":\$CMD_ESCAPED,\\"files\\":\$JSON_FILES}"
CURL_RESP=$(send_webhook "\$WEBHOOK_DATA" 2>&1)
[ -n "\$CODEAGENTSWARM_HOOK_DEBUG" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] POST Curl resp: \$CURL_RESP" >> "\$DEBUG_LOG"

exit 0
`;
    }

    /**
     * Generate Unix/macOS edit-write-hook.sh script content
     * STEALTH VERSION: Uses pipes and stdin to avoid exposing file contents in process arguments
     * This prevents SOC/EDR systems from flagging as data exfiltration
     */
    getUnixFileChangeHookScript() {
        return `#!/bin/bash
# ============================================================================
# edit-write-hook.sh
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PostToolUse hook: Tracks file changes from Edit|Write tools
# STEALTH: Uses temp file to avoid exposing data in process arguments
# ============================================================================

# Try both ports for dev/prod compatibility
WEBHOOK_PORT_DEV="\${CODEAGENTSWARM_WEBHOOK_PORT:-45783}"
WEBHOOK_PORT_PROD="\${CODEAGENTSWARM_WEBHOOK_PORT:-45782}"
TERM_ID="\${CODEAGENTSWARM_CURRENT_QUADRANT:-0}"

# Create temp file for stealth data transfer
# Data is stored in file, never appears in process arguments
TMP=$(mktemp)
trap "rm -f '\$TMP'" EXIT

# Transform JSON and save to temp file
# Extract fields from both Claude Code (tool_input) and Gemini CLI (tool_response.returnDisplay)
jq -c "{
    type: \\"file_edited\\",
    terminalId: \\"\$TERM_ID\\",
    toolName: .tool_name,
    filePath: .tool_input.file_path,
    content: (.tool_input.content // null),
    oldString: (.tool_input.old_string // null),
    newString: (.tool_input.new_string // null),
    originalContent: (.tool_response.returnDisplay.originalContent // null),
    newContent: (.tool_response.returnDisplay.newContent // null)
}" > "\$TMP" 2>/dev/null

# Try dev port first, then prod port
# Using @file syntax keeps data out of process arguments
curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_DEV/webhook" \\
    -H "Content-Type: application/json" \\
    -d @"\$TMP" \\
    --silent --fail --max-time 2 2>/dev/null || \\
curl -X POST "http://127.0.0.1:\$WEBHOOK_PORT_PROD/webhook" \\
    -H "Content-Type: application/json" \\
    -d @"\$TMP" \\
    --silent --max-time 2 2>/dev/null || true

exit 0
`;
    }

    /**
     * Generate Windows PowerShell edit-write-hook.ps1 script content.
     *
     * Referenced by buildWindowsFileChangeHookCommand() (line 202) and registered
     * under the PostToolUse Edit|Write matcher. Until this script is actually written
     * to disk by ensureHookScripts(), the Edit/Write file-change tracking hook on
     * Windows points at a non-existent .ps1 and silently fails — Windows users lose
     * file-change tracking entirely.
     *
     * Mirrors the behaviour of getUnixFileChangeHookScript():
     *   - reads the Claude Code / Gemini CLI hook JSON from stdin
     *   - extracts file_path, content, old_string, new_string, originalContent,
     *     newContent from tool_input / tool_response.returnDisplay
     *   - posts a `file_edited` event to this instance's webhook port
     *     (CODEAGENTSWARM_WEBHOOK_PORT, else the legacy 45783 then 45782 probe)
     *   - swallows all errors and exits 0
     */
    getWindowsFileChangeHookScript() {
        return `# ============================================================================
# edit-write-hook.ps1
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PostToolUse hook: Tracks file changes from Edit|Write tools (Windows version)
# Posts a file_edited event to the local CodeAgentSwarm webhook server.
# Always exits 0 so hook failures never surface to the user.
# ============================================================================

$ErrorActionPreference = 'SilentlyContinue'

try {
    $terminalId = if ($env:CODEAGENTSWARM_CURRENT_QUADRANT) { $env:CODEAGENTSWARM_CURRENT_QUADRANT } else { '0' }

    # Read the full JSON payload from stdin
    $inputJson = [Console]::In.ReadToEnd()
    if (-not $inputJson) { exit 0 }

    $data = $inputJson | ConvertFrom-Json

    $payload = [ordered]@{
        type            = 'file_edited'
        terminalId      = $terminalId
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
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/webhook" \`
                -Method POST \`
                -ContentType 'application/json' \`
                -Body $body \`
                -TimeoutSec 2 \`
                -ErrorAction Stop | Out-Null
            exit 0
        } catch {
            continue
        }
    }
} catch {
    # Intentionally swallow all errors; hook failures must not surface to the user.
}

exit 0
`;
    }

    /**
     * Generate PowerShell pre-snapshot script for Windows
     * This script captures file state BEFORE a Bash command modifies it
     */
    getPowerShellPreSnapshotScript() {
        return `# ============================================================================
# bash-pre-snapshot.ps1
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PreToolUse hook: Captures file state BEFORE Bash command modifies it
# PowerShell version for Windows compatibility
# ============================================================================

$WebhookPort = "${this.webhookPort}"
$TerminalId = if ($env:CODEAGENTSWARM_CURRENT_QUADRANT) { $env:CODEAGENTSWARM_CURRENT_QUADRANT } else { "0" }

# Optional debug logging — OFF unless CODEAGENTSWARM_HOOK_DEBUG is set, so the log can never
# grow unbounded in normal use (it once reached ~5 GB).
$DebugLog = Join-Path $env:USERPROFILE ".codeagentswarm\\hooks\\debug.log"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
function Write-DebugLog($msg) { if ($env:CODEAGENTSWARM_HOOK_DEBUG) { Add-Content -Path $DebugLog -Value "[$Timestamp] $msg" } }
Write-DebugLog "PRE-SNAPSHOT called (PowerShell)"

# Read JSON from stdin
$InputJson = [Console]::In.ReadToEnd()
Write-DebugLog "PRE Input: $InputJson"

try {
    $Data = $InputJson | ConvertFrom-Json
    $Command = $Data.tool_input.command
    $Cwd = $Data.cwd

    if (-not $Command) { exit 0 }

    # Detect target files from command
    function Get-TargetFiles {
        param([string]$Cmd)

        $Files = @()

        # Detect redirection patterns: echo/printf ... > file
        if ($Cmd -match '(?:echo|printf|cat).*?>\\s*([^\\s;&|]+)') {
            $Files += $Matches[1]
        }

        # Detect sed -i patterns
        if ($Cmd -match 'sed\\s+-i.*?\\s+([^\\s;&|]+)$') {
            $Files += $Matches[1]
        }

        # Detect cp command
        if ($Cmd -match '^cp\\s+.*?\\s+([^\\s;&|]+)$') {
            $Files += $Matches[1]
        }

        # Detect mv command (both source and dest)
        if ($Cmd -match '^mv\\s+([^\\s]+)\\s+([^\\s;&|]+)') {
            $Files += $Matches[1]
            $Files += $Matches[2]
        }

        # Detect rm command
        if ($Cmd -match '^rm\\s+(?:-[^\\s]+\\s+)*([^\\s;&|]+)') {
            $Files += $Matches[1]
        }

        # Detect tee command
        if ($Cmd -match 'tee\\s+(?:-a\\s+)?([^\\s;&|]+)') {
            $Files += $Matches[1]
        }

        return $Files | Where-Object { $_ -and $_ -notmatch '[\\$*?]' }
    }

    function Resolve-FilePath {
        param([string]$File, [string]$WorkingDir)

        if (-not $File) { return $null }

        # Remove quotes
        $File = $File -replace "^['\`"]|['\`"]$", ""

        # Resolve path
        if ([System.IO.Path]::IsPathRooted($File)) {
            return $File
        } else {
            return Join-Path $WorkingDir $File
        }
    }

    $TargetFiles = Get-TargetFiles -Cmd $Command
    if (-not $TargetFiles) { exit 0 }

    # Build JSON with file contents
    $FilesHash = @{}
    foreach ($File in $TargetFiles) {
        $FullPath = Resolve-FilePath -File $File -WorkingDir $Cwd
        if (-not $FullPath) { continue }

        try {
            $FullPath = [System.IO.Path]::GetFullPath($FullPath)
        } catch { continue }

        if (Test-Path $FullPath -PathType Leaf) {
            $Content = Get-Content -Path $FullPath -Raw -ErrorAction SilentlyContinue
            $FilesHash[$FullPath] = $Content
        } else {
            $FilesHash[$FullPath] = $null
        }
    }

    Write-DebugLog "PRE Sending - Files: $($FilesHash.Keys -join ', ')"

    # Send to webhook
    $Body = @{
        type = "bash_pre_snapshot"
        terminalId = $TerminalId
        command = $Command
        cwd = $Cwd
        files = $FilesHash
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$WebhookPort/webhook" -Method POST -ContentType "application/json" -Body $Body -TimeoutSec 2 | Out-Null
    } catch {
        Write-DebugLog "PRE Error: $_"
    }

} catch {
    Write-DebugLog "PRE Exception: $_"
}

exit 0
`;
    }

    /**
     * Generate PowerShell post-compare script for Windows
     * This script compares file state AFTER a Bash command executes
     */
    getPowerShellPostCompareScript() {
        return `# ============================================================================
# bash-post-compare.ps1
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# PostToolUse hook: Compares file state AFTER Bash command executes
# PowerShell version for Windows compatibility
# ============================================================================

$WebhookPort = "${this.webhookPort}"
$TerminalId = if ($env:CODEAGENTSWARM_CURRENT_QUADRANT) { $env:CODEAGENTSWARM_CURRENT_QUADRANT } else { "0" }

# Optional debug logging — OFF unless CODEAGENTSWARM_HOOK_DEBUG is set. POST Input includes
# the full tool_response (command stdout), so gating it is what stops the log from reaching GBs.
$DebugLog = Join-Path $env:USERPROFILE ".codeagentswarm\\hooks\\debug.log"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
function Write-DebugLog($msg) { if ($env:CODEAGENTSWARM_HOOK_DEBUG) { Add-Content -Path $DebugLog -Value "[$Timestamp] $msg" } }
Write-DebugLog "POST-COMPARE called (PowerShell)"

# Read JSON from stdin
$InputJson = [Console]::In.ReadToEnd()
Write-DebugLog "POST Input: $InputJson"

try {
    $Data = $InputJson | ConvertFrom-Json
    $Command = $Data.tool_input.command
    $Cwd = $Data.cwd

    if (-not $Command) { exit 0 }

    # Detect target files from command (same as pre-snapshot)
    function Get-TargetFiles {
        param([string]$Cmd)

        $Files = @()

        if ($Cmd -match '(?:echo|printf|cat).*?>\\s*([^\\s;&|]+)') {
            $Files += $Matches[1]
        }

        if ($Cmd -match 'sed\\s+-i.*?\\s+([^\\s;&|]+)$') {
            $Files += $Matches[1]
        }

        if ($Cmd -match '^cp\\s+.*?\\s+([^\\s;&|]+)$') {
            $Files += $Matches[1]
        }

        if ($Cmd -match '^mv\\s+([^\\s]+)\\s+([^\\s;&|]+)') {
            $Files += $Matches[1]
            $Files += $Matches[2]
        }

        if ($Cmd -match '^rm\\s+(?:-[^\\s]+\\s+)*([^\\s;&|]+)') {
            $Files += $Matches[1]
        }

        if ($Cmd -match 'tee\\s+(?:-a\\s+)?([^\\s;&|]+)') {
            $Files += $Matches[1]
        }

        return $Files | Where-Object { $_ -and $_ -notmatch '[\\$*?]' }
    }

    function Resolve-FilePath {
        param([string]$File, [string]$WorkingDir)

        if (-not $File) { return $null }
        $File = $File -replace "^['\`"]|['\`"]$", ""

        if ([System.IO.Path]::IsPathRooted($File)) {
            return $File
        } else {
            return Join-Path $WorkingDir $File
        }
    }

    $TargetFiles = Get-TargetFiles -Cmd $Command
    if (-not $TargetFiles) { exit 0 }

    # Build JSON with current file contents (after command executed)
    $FilesHash = @{}
    foreach ($File in $TargetFiles) {
        $FullPath = Resolve-FilePath -File $File -WorkingDir $Cwd
        if (-not $FullPath) { continue }

        try {
            $FullPath = [System.IO.Path]::GetFullPath($FullPath)
        } catch { continue }

        if (Test-Path $FullPath -PathType Leaf) {
            $Content = Get-Content -Path $FullPath -Raw -ErrorAction SilentlyContinue
            $FilesHash[$FullPath] = $Content
        } else {
            $FilesHash[$FullPath] = $null  # File was deleted or doesn't exist
        }
    }

    Write-DebugLog "POST Sending - Files: $($FilesHash.Keys -join ', ')"

    # Send to webhook to compare with pre-snapshot
    $Body = @{
        type = "bash_post_compare"
        terminalId = $TerminalId
        command = $Command
        files = $FilesHash
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$WebhookPort/webhook" -Method POST -ContentType "application/json" -Body $Body -TimeoutSec 2 | Out-Null
    } catch {
        Write-DebugLog "POST Error: $_"
    }

} catch {
    Write-DebugLog "POST Exception: $_"
}

exit 0
`;
    }

    /**
     * Generate webhook-notifier.ps1 - PowerShell script for Notification/Stop hooks on Windows.
     *
     * Replaces the old inline `powershell.exe -Command "..."` approach, which was
     * broken on Windows: cmd.exe's quote parsing counts every `"` (including escaped
     * `\"` in JSON bodies) as a quote toggle, leaving PowerShell with a mangled
     * script that failed with `Token ')' inesperado` and `$env` stripped to `:`.
     *
     * Invoked as:
     *   powershell.exe -ExecutionPolicy Bypass -NoProfile -File webhook-notifier.ps1
     *     -EventType <type> [-Tool <tool>]
     */
    getPowerShellWebhookNotifierScript() {
        return `# ============================================================================
# webhook-notifier.ps1
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# Sends a webhook notification for Notification / Stop hook events.
# Posts to CODEAGENTSWARM_WEBHOOK_PORT, else probes dev 45783 then prod 45782.
# Always exits 0 so Claude Code / Gemini CLI never reports a hook error.
# ============================================================================

param(
    [Parameter(Mandatory = $true)]
    [string]$EventType,

    [string]$Tool = ''
)

$ErrorActionPreference = 'SilentlyContinue'

try {
    $terminalId = if ($env:CODEAGENTSWARM_CURRENT_QUADRANT) { $env:CODEAGENTSWARM_CURRENT_QUADRANT } else { '0' }

    # Suppress the claude_finished notification while a commit-mode Claude run is active.
    if ($EventType -eq 'claude_finished' -and $env:CODEAGENTSWARM_COMMIT_MODE) {
        exit 0
    }

    # Driver-backed Chat children (CODEAGENTSWARM_DRIVER_CHAT): the chat driver
    # already reports turn ends and permission requests; never double-report.
    if ($env:CODEAGENTSWARM_DRIVER_CHAT) {
        exit 0
    }

    $payload = [ordered]@{
        type       = $EventType
        terminalId = $terminalId
    }
    if ($Tool) {
        $payload.tool = $Tool
    }
    $body = $payload | ConvertTo-Json -Compress

    # Post to THIS instance's webhook port when CodeAgentSwarm injected it; otherwise fall
    # back to the legacy dev-first (45783) / prod (45782) probe for older builds.
    $ports = if (($casPort = $env:CODEAGENTSWARM_WEBHOOK_PORT -as [int])) { @($casPort) } else { @(45783, 45782) }
    foreach ($port in $ports) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/webhook" \`
                -Method POST \`
                -ContentType 'application/json' \`
                -Body $body \`
                -TimeoutSec 2 \`
                -ErrorAction Stop | Out-Null
            exit 0
        } catch {
            continue
        }
    }
} catch {
    # Intentionally swallow all errors; hook failures must not surface to the user.
}

exit 0
`;
    }

    async ensureSettingsDirectory() {
        const settingsDir = path.dirname(this.settingsPath);
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }
    }

    async readSettings() {
        try {
            await this.ensureSettingsDirectory();

            const content = safeReadConfigFile(this.settingsPath);
            if (content === null) {
                return {};
            }
            return JSON.parse(content);
        } catch (error) {
            console.error('Error reading settings:', error);
            return {};
        }
    }

    async writeSettings(settings) {
        try {
            await this.ensureSettingsDirectory();
            // safeWriteConfigFile refuses to overwrite an existing file that
            // is already over the size cap. This prevents data loss when
            // readSettings silently returned {} for an oversized file and a
            // caller built `settings` on top of that empty default.
            safeWriteConfigFile(
                this.settingsPath,
                JSON.stringify(settings, null, 2)
            );
            return true;
        } catch (error) {
            console.error('Error writing settings:', error);
            return false;
        }
    }

    /**
     * Check if a hook entry is a CodeAgentSwarm hook by examining its command
     * @param {Object} hookEntry - A hook entry with matcher and hooks array
     * @returns {boolean} - True if this is a CodeAgentSwarm hook
     */
    isCodeAgentSwarmHook(hookEntry) {
        if (!hookEntry.hooks || !Array.isArray(hookEntry.hooks)) return false;
        return hookEntry.hooks.some(hook => {
            if (!hook.command) return false;
            // Normalize paths for comparison (Windows uses backslashes, Unix uses forward slashes)
            // Also lowercase the command so detection matches the case-insensitive Windows filesystem
            // (Windows can launch hooks via paths like .CodeAgentSwarm/Hooks/...; without
            // lowercasing here `String.prototype.includes` would silently miss them and
            // a duplicate hook would be re-added on every app launch — see CLAUDE.md
            // "Hooks System — CRITICAL: Adding New Hook Scripts").
            const normalizedCommand = this.toUnixPath(hook.command).toLowerCase();
            return (
                normalizedCommand.includes(`localhost:${this.webhookPort}`) ||
                normalizedCommand.includes(`127.0.0.1:${this.webhookPort}`) ||
                normalizedCommand.includes('file_edited') ||
                normalizedCommand.includes('confirmation_needed') ||
                normalizedCommand.includes('claude_finished') ||
                // SessionStart title/activity nudge (marker phrase from getSessionStartCommand)
                normalizedCommand.includes('set its title and current activity') ||
                // UserPromptSubmit title/activity re-nudge (script path is the marker)
                normalizedCommand.includes('title-nudge-hook.sh') ||
                normalizedCommand.includes('title-nudge-hook.ps1') ||
                // PreToolUse title reminder hook (script path is the marker)
                normalizedCommand.includes('title-gate-hook.sh') ||
                normalizedCommand.includes('title-gate-hook.ps1') ||
                // Unix/macOS bash scripts (current)
                normalizedCommand.includes('.codeagentswarm/hooks/bash-pre-snapshot.sh') ||
                normalizedCommand.includes('.codeagentswarm/hooks/bash-post-compare.sh') ||
                normalizedCommand.includes('.codeagentswarm/hooks/edit-write-hook.sh') ||
                // Unix/macOS bash scripts (legacy — registered by older versions,
                // no longer installed by current code but still present in user
                // settings.json from prior installs. Recognize them so cleanup
                // can remove the stale registrations.)
                normalizedCommand.includes('.codeagentswarm/hooks/task-pre-hook.sh') ||
                normalizedCommand.includes('.codeagentswarm/hooks/subagent-start-hook.sh') ||
                normalizedCommand.includes('.codeagentswarm/hooks/subagent-stop-hook.sh') ||
                normalizedCommand.includes('.codeagentswarm/hooks/edit-write-hook-debug.sh') ||
                // Windows PowerShell scripts (current)
                normalizedCommand.includes('.codeagentswarm/hooks/bash-pre-snapshot.ps1') ||
                normalizedCommand.includes('.codeagentswarm/hooks/bash-post-compare.ps1') ||
                normalizedCommand.includes('.codeagentswarm/hooks/edit-write-hook.ps1') ||
                normalizedCommand.includes('.codeagentswarm/hooks/webhook-notifier.ps1') ||
                // Windows PowerShell scripts (legacy — same rationale as the .sh
                // legacy patterns above.)
                normalizedCommand.includes('.codeagentswarm/hooks/task-pre-hook.ps1') ||
                normalizedCommand.includes('.codeagentswarm/hooks/subagent-start-hook.ps1') ||
                normalizedCommand.includes('.codeagentswarm/hooks/subagent-stop-hook.ps1') ||
                normalizedCommand.includes('.codeagentswarm/hooks/edit-write-hook-debug.ps1')
            );
        });
    }

    /**
     * Merge hook arrays intelligently, preserving user hooks and avoiding duplicates
     * @param {Array} existingHooks - Existing hooks array for an event type
     * @param {Array} newHooks - New hooks to add (CodeAgentSwarm hooks)
     * @returns {Array} - Merged hooks array
     */
    mergeHookArrays(existingHooks, newHooks) {
        if (!existingHooks || existingHooks.length === 0) {
            return [...newHooks];
        }

        // Filter out existing CodeAgentSwarm hooks (will be replaced with new ones)
        const userHooks = existingHooks.filter(hook => !this.isCodeAgentSwarmHook(hook));

        // Combine user hooks with new CodeAgentSwarm hooks
        return [...userHooks, ...newHooks];
    }

    async installHooks() {
        try {
            // Ensure hook scripts exist before installing hooks that reference them
            await this.ensureHookScripts();

            const settings = await this.readSettings();
            const existingHooks = settings.hooks || {};

            // Smart merge: preserve user hooks, add/update CodeAgentSwarm hooks
            const mergedHooks = { ...existingHooks };

            for (const [eventType, ourHookArray] of Object.entries(this.codeAgentSwarmHooks)) {
                mergedHooks[eventType] = this.mergeHookArrays(
                    existingHooks[eventType],
                    ourHookArray
                );
            }

            const updatedSettings = {
                ...settings,
                hooks: mergedHooks
            };

            const success = await this.writeSettings(updatedSettings);

            if (success) {
                return { success: true };
            } else {
                return { success: false, error: 'Failed to write settings' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ============================================================
    // Granular hook groups for the Privacy & Integrations panel
    // ============================================================
    // The full set of CodeAgentSwarm hooks splits cleanly into two
    // user-facing features:
    //   - Notifications  →  Notification + Stop event types
    //   - File-change tracking →  PreToolUse + PostToolUse event types
    // The methods below install/remove a subset so each feature can
    // be toggled independently.

    async installNotificationsHooks() {
        const result = await this._installEventGroup(['Notification', 'Stop']);
        // The AskUserQuestion detector rides the notifications toggle (it emits the
        // same confirmation_needed webhook) but lives under PreToolUse, so it needs
        // its own targeted install — _installEventGroup above never touches PreToolUse.
        try { await this.installAskUserQuestionHook(); } catch (e) { /* never fatal */ }
        return result;
    }

    async removeNotificationsHooks() {
        const result = await this._removeEventGroup(['Notification', 'Stop']);
        try { await this.removeAskUserQuestionHook(); } catch (e) { /* never fatal */ }
        return result;
    }

    async installFileChangeHooks() {
        // File-change tracking shares the PreToolUse event type with the title
        // reminder and the AskUserQuestion detector, but each of those has its OWN
        // toggle. Preserve their independent on/off state: _installEventGroup re-adds
        // the whole PreToolUse group (incl. both), so whatever was OFF before must be
        // stripped back out afterwards so this toggle never silently re-enables it.
        const hadGate = await this.hasTitleGateHooks();
        const hadAsk = await this.hasAskUserQuestionHook();
        const result = await this._installEventGroup(['PreToolUse', 'PostToolUse']);
        if (!hadGate) await this.removeTitleGateHooks();
        if (!hadAsk) await this.removeAskUserQuestionHook();
        return result;
    }

    async removeFileChangeHooks() {
        // _removeEventGroup strips ALL CodeAgentSwarm PreToolUse hooks (incl. the title
        // reminder and the AskUserQuestion detector), but those are INDEPENDENT of this
        // toggle. Preserve their prior on/off state: whatever was installed gets
        // re-affirmed after removing the file-change hooks.
        const hadGate = await this.hasTitleGateHooks();
        const hadAsk = await this.hasAskUserQuestionHook();
        const result = await this._removeEventGroup(['PreToolUse', 'PostToolUse']);
        if (hadGate) await this.installTitleGateHooks();
        if (hadAsk) await this.installAskUserQuestionHook();
        return result;
    }

    // PreToolUse title reminder (Claude). Independent of the notifications / file-change
    // toggles: non-blocking, injects a reminder to set a title while the terminal is
    // untitled (never denies). Installed for Claude unconditionally at boot
    // (reconcileAgentHooks). Targeted install/remove so the Bash file-snapshot hook and
    // any user PreToolUse hooks are preserved.
    async installTitleGateHooks() {
        try {
            await this.ensureHookScripts();
            const settings = await this.readSettings();
            const existingHooks = settings.hooks || {};
            const existingPre = existingHooks.PreToolUse || [];
            // Drop any prior gate entry (replace, never duplicate), keep everything else.
            const withoutGate = existingPre.filter(item => !this._isTitleGateHook(item));
            const gateEntry = this.codeAgentSwarmHooks.PreToolUse.find(item => this._isTitleGateHook(item));
            const mergedPre = [...withoutGate, gateEntry];
            const mergedHooks = { ...existingHooks, PreToolUse: mergedPre };
            const success = await this.writeSettings({ ...settings, hooks: mergedHooks });
            return success ? { success: true } : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async removeTitleGateHooks() {
        try {
            const settings = await this.readSettings();
            if (!settings.hooks || !settings.hooks.PreToolUse) return { success: true };
            const filtered = settings.hooks.PreToolUse.filter(item => !this._isTitleGateHook(item));
            if (filtered.length === settings.hooks.PreToolUse.length) return { success: true };
            if (filtered.length === 0) {
                delete settings.hooks.PreToolUse;
            } else {
                settings.hooks.PreToolUse = filtered;
            }
            if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
            const success = await this.writeSettings(settings);
            return success ? { success: true } : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /** True if a PreToolUse hook entry is the CodeAgentSwarm title gate. */
    _isTitleGateHook(item) {
        if (!item || !Array.isArray(item.hooks)) return false;
        return item.hooks.some(hook => {
            if (!hook.command) return false;
            return this.toUnixPath(hook.command).toLowerCase().includes('title-gate-hook');
        });
    }

    /** Whether the title reminder hook is currently installed (Claude settings.json). */
    async hasTitleGateHooks() {
        try {
            const settings = await this.readSettings();
            const pre = settings.hooks?.PreToolUse || [];
            return pre.some(item => this._isTitleGateHook(item));
        } catch (error) {
            return false;
        }
    }

    // PreToolUse AskUserQuestion detector (task #12030). Part of the NOTIFICATIONS
    // feature (it emits confirmation_needed) but hosted under PreToolUse, so it gets
    // the same targeted install/remove treatment as the title reminder to survive the
    // file-change toggle rewriting the PreToolUse group. Fire-and-forget by design —
    // see buildAskUserQuestionHookCommand().
    async installAskUserQuestionHook() {
        try {
            const settings = await this.readSettings();
            const existingHooks = settings.hooks || {};
            const existingPre = existingHooks.PreToolUse || [];
            // Drop any prior entry (replace, never duplicate), keep everything else.
            const withoutAsk = existingPre.filter(item => !this._isAskUserQuestionHook(item));
            const askEntry = this.codeAgentSwarmHooks.PreToolUse.find(item => this._isAskUserQuestionHook(item));
            if (!askEntry) return { success: true }; // defensive: catalog entry missing
            const mergedPre = [...withoutAsk, askEntry];
            const mergedHooks = { ...existingHooks, PreToolUse: mergedPre };
            const success = await this.writeSettings({ ...settings, hooks: mergedHooks });
            return success ? { success: true } : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async removeAskUserQuestionHook() {
        try {
            const settings = await this.readSettings();
            if (!settings.hooks || !settings.hooks.PreToolUse) return { success: true };
            const filtered = settings.hooks.PreToolUse.filter(item => !this._isAskUserQuestionHook(item));
            if (filtered.length === settings.hooks.PreToolUse.length) return { success: true };
            if (filtered.length === 0) {
                delete settings.hooks.PreToolUse;
            } else {
                settings.hooks.PreToolUse = filtered;
            }
            if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
            const success = await this.writeSettings(settings);
            return success ? { success: true } : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /** True if a PreToolUse hook entry is the CodeAgentSwarm AskUserQuestion detector. */
    _isAskUserQuestionHook(item) {
        if (!item || !Array.isArray(item.hooks)) return false;
        return item.hooks.some(hook => {
            if (!hook.command) return false;
            const cmd = this.toUnixPath(hook.command).toLowerCase();
            return cmd.includes('confirmation_needed') && cmd.includes('askuserquestion');
        });
    }

    /** Whether the AskUserQuestion detector is currently installed (Claude settings.json). */
    async hasAskUserQuestionHook() {
        try {
            const settings = await this.readSettings();
            const pre = settings.hooks?.PreToolUse || [];
            return pre.some(item => this._isAskUserQuestionHook(item));
        } catch (error) {
            return false;
        }
    }

    // SessionStart title/activity nudge (Claude only). Always-on part of the task system.
    async installSessionStartHooks() {
        return this._installEventGroup(['SessionStart']);
    }

    async removeSessionStartHooks() {
        return this._removeEventGroup(['SessionStart']);
    }

    // UserPromptSubmit title/activity re-nudge (Claude only). Makes the soft SessionStart
    // nudge reliable: reminds again, on each prompt, until the title is set + activity fresh.
    async installUserPromptSubmitHooks() {
        return this._installEventGroup(['UserPromptSubmit']);
    }

    async removeUserPromptSubmitHooks() {
        return this._removeEventGroup(['UserPromptSubmit']);
    }

    async _installEventGroup(eventTypes) {
        try {
            await this.ensureHookScripts();
            const settings = await this.readSettings();
            const existingHooks = settings.hooks || {};
            const mergedHooks = { ...existingHooks };

            for (const eventType of eventTypes) {
                if (!this.codeAgentSwarmHooks[eventType]) continue;
                mergedHooks[eventType] = this.mergeHookArrays(
                    existingHooks[eventType],
                    this.codeAgentSwarmHooks[eventType]
                );
            }

            const success = await this.writeSettings({ ...settings, hooks: mergedHooks });
            return success
                ? { success: true }
                : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async _removeEventGroup(eventTypes) {
        try {
            const settings = await this.readSettings();
            if (!settings.hooks) return { success: true };

            let modified = false;
            for (const eventType of eventTypes) {
                if (!settings.hooks[eventType]) continue;
                const userHooks = settings.hooks[eventType].filter(
                    hook => !this.isCodeAgentSwarmHook(hook)
                );
                if (userHooks.length === settings.hooks[eventType].length) continue;
                if (userHooks.length === 0) {
                    delete settings.hooks[eventType];
                } else {
                    settings.hooks[eventType] = userHooks;
                }
                modified = true;
            }

            if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
            if (!modified) return { success: true };

            const success = await this.writeSettings(settings);
            return success
                ? { success: true }
                : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Whether desktop notification hooks are currently installed.
     * @returns {Promise<boolean>}
     */
    async hasNotificationsHooks() {
        try {
            const settings = await this.readSettings();
            const notif = settings.hooks?.Notification || [];
            const hasNotif = notif.some(item =>
                item.hooks?.some(hook => hook.command?.includes('confirmation_needed'))
            );
            const hasStop = !!(settings.hooks?.Stop?.some(item =>
                item.hooks?.some(hook => hook.command?.includes('claude_finished'))
            ));
            return hasNotif && hasStop;
        } catch (error) {
            return false;
        }
    }

    /**
     * Whether file-change tracking hooks are currently installed.
     * @returns {Promise<boolean>}
     */
    async hasFileChangeHooks() {
        try {
            const settings = await this.readSettings();
            const post = settings.hooks?.PostToolUse || [];
            const hasEditWrite = post.some(item =>
                item.matcher === 'Edit|Write' &&
                item.hooks?.some(hook => {
                    const cmd = hook.command ? this.toUnixPath(hook.command).toLowerCase() : '';
                    return cmd.includes('file_edited')
                        || cmd.includes('edit-write-hook.sh')
                        || cmd.includes('edit-write-hook.ps1');
                })
            );
            return hasEditWrite;
        } catch (error) {
            return false;
        }
    }

    async removeHooks() {
        try {
            const settings = await this.readSettings();

            if (!settings.hooks) {
                return { success: true };
            }

            // Event types that CodeAgentSwarm uses
            const codeAgentSwarmEventTypes = ['Notification', 'Stop', 'PreToolUse', 'PostToolUse'];
            let modified = false;

            for (const eventType of codeAgentSwarmEventTypes) {
                if (!settings.hooks[eventType]) continue;

                // Filter out only CodeAgentSwarm hooks, preserve user hooks
                const userHooks = settings.hooks[eventType].filter(
                    hook => !this.isCodeAgentSwarmHook(hook)
                );

                if (userHooks.length === 0) {
                    // No user hooks left, remove the event type entirely
                    delete settings.hooks[eventType];
                } else {
                    // Keep user hooks
                    settings.hooks[eventType] = userHooks;
                }
                modified = true;
            }

            // Clean up empty hooks object
            if (Object.keys(settings.hooks).length === 0) {
                delete settings.hooks;
            }

            if (!modified) {
                return { success: true };
            }

            const success = await this.writeSettings(settings);

            if (success) {
                return { success: true };
            } else {
                return { success: false, error: 'Failed to write settings' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async checkHooksStatus() {
        try {
            const settings = await this.readSettings();

            // Check if our hooks are installed with the CORRECT configuration
            // We need to verify not just that they exist, but that they have the right matchers
            const notificationHooks = settings.hooks?.Notification || [];

            // Check for permission_prompt matcher
            const hasPermissionPrompt = notificationHooks.some(item =>
                item.matcher === 'permission_prompt' &&
                item.hooks?.some(hook => hook.command?.includes('confirmation_needed'))
            );

            // Check for elicitation_dialog matcher
            const hasElicitationDialog = notificationHooks.some(item =>
                item.matcher === 'elicitation_dialog' &&
                item.hooks?.some(hook => hook.command?.includes('confirmation_needed'))
            );

            // Both matchers must be present (no wildcard "*")
            const hasCorrectNotificationHooks = hasPermissionPrompt && hasElicitationDialog;

            const hasStopHook = !!(settings.hooks?.Stop?.some(item =>
                item.hooks?.some(hook =>
                    hook.command?.includes('claude_finished')
                )
            ));

            // Check for PostToolUse hook (file change tracking for Edit|Write)
            // Supports both inline command (old) and external script (new stealth version)
            const hasPostToolUseHook = !!(settings.hooks?.PostToolUse?.some(item =>
                item.matcher === 'Edit|Write' &&
                item.hooks?.some(hook => {
                    if (!hook.command) return false;
                    const cmd = this.toUnixPath(hook.command).toLowerCase();
                    // Old inline command had 'file_edited', new stealth version uses script
                    return cmd.includes('file_edited') ||
                           cmd.includes('edit-write-hook.sh') ||
                           cmd.includes('edit-write-hook.ps1');
                })
            ));

            // Check for PreToolUse Bash hook (file change tracking snapshot)
            // Supports both .sh (Unix/macOS) and .ps1 (Windows) scripts
            const hasPreToolUseBashHook = !!(settings.hooks?.PreToolUse?.some(item =>
                item.matcher === 'Bash' &&
                item.hooks?.some(hook => {
                    if (!hook.command) return false;
                    const cmd = this.toUnixPath(hook.command).toLowerCase();
                    return cmd.includes('bash-pre-snapshot.sh') || cmd.includes('bash-pre-snapshot.ps1');
                })
            ));

            // Check for PostToolUse Bash hook (file change tracking compare)
            // Supports both .sh (Unix/macOS) and .ps1 (Windows) scripts
            const hasPostToolUseBashHook = !!(settings.hooks?.PostToolUse?.some(item =>
                item.matcher === 'Bash' &&
                item.hooks?.some(hook => {
                    if (!hook.command) return false;
                    const cmd = this.toUnixPath(hook.command).toLowerCase();
                    return cmd.includes('bash-post-compare.sh') || cmd.includes('bash-post-compare.ps1');
                })
            ));

            const hasBashHooks = hasPreToolUseBashHook && hasPostToolUseBashHook;

            return {
                installed: hasCorrectNotificationHooks && hasStopHook && hasPostToolUseHook && hasBashHooks,
                notificationHook: hasCorrectNotificationHooks,
                stopHook: hasStopHook,
                postToolUseHook: hasPostToolUseHook,
                bashHooks: hasBashHooks,
                settingsPath: this.settingsPath,
                hooks: settings.hooks || {}
            };
        } catch (error) {
            return {
                installed: false,
                error: error.message
            };
        }
    }

    async configureMCPPermissions() {
        try {
            const settings = await this.readSettings();
            
            // Initialize permissions if they don't exist
            if (!settings.permissions) {
                settings.permissions = {
                    allow: [],
                    deny: [],
                    ask: []
                };
            }
            
            // Get current allow list
            const currentAllow = settings.permissions.allow || [];
            
            // Create a Set to avoid duplicates
            const allowSet = new Set(currentAllow);
            
            // Add all CodeAgentSwarm MCP permissions
            this.codeAgentSwarmMCPPermissions.forEach(permission => {
                allowSet.add(permission);
            });
            
            // Update the allow list
            settings.permissions.allow = Array.from(allowSet);
            
            // Write back the updated settings
            const success = await this.writeSettings(settings);
            
            if (success) {

                return { success: true, permissionsAdded: this.codeAgentSwarmMCPPermissions.length };
            } else {
                return { success: false, error: 'Failed to write settings' };
            }
        } catch (error) {
            console.error('Error configuring MCP permissions:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Remove every mcp__codeagentswarm-tasks__* entry from permissions.allow.
     * Counterpart of configureMCPPermissions() — before this, disabling the task
     * system left the allowlist entries behind forever (add-only). User entries
     * and the deny/ask lists are preserved untouched.
     */
    async removeMCPPermissions() {
        try {
            const settings = await this.readSettings();
            const allowList = settings.permissions?.allow;
            if (!Array.isArray(allowList)) return { success: true };

            const filtered = allowList.filter(p => !String(p).startsWith('mcp__codeagentswarm-tasks__'));
            if (filtered.length === allowList.length) return { success: true };

            settings.permissions.allow = filtered;
            const success = await this.writeSettings(settings);
            return success
                ? { success: true, permissionsRemoved: allowList.length - filtered.length }
                : { success: false, error: 'Failed to write settings' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Strip CAS hooks registered under event types the current catalog no longer
     * installs (SubagentStart/SubagentStop from older versions). Nothing reinstalls
     * them, so without this boot-time sweep they lingered in settings.json forever.
     * User hooks under those events are preserved (_removeEventGroup filters by
     * isCodeAgentSwarmHook, which still recognizes the legacy script paths).
     */
    async removeLegacyHooks() {
        return this._removeEventGroup(['SubagentStart', 'SubagentStop']);
    }

    async checkMCPPermissionsStatus() {
        try {
            const settings = await this.readSettings();
            const allowList = settings.permissions?.allow || [];
            
            // Check which permissions are installed
            const installedPermissions = this.codeAgentSwarmMCPPermissions.filter(permission => 
                allowList.includes(permission)
            );
            
            const allInstalled = installedPermissions.length === this.codeAgentSwarmMCPPermissions.length;
            
            return {
                allInstalled,
                installedCount: installedPermissions.length,
                totalRequired: this.codeAgentSwarmMCPPermissions.length,
                missingPermissions: this.codeAgentSwarmMCPPermissions.filter(permission => 
                    !allowList.includes(permission)
                )
            };
        } catch (error) {
            return {
                allInstalled: false,
                error: error.message
            };
        }
    }

    async ensureFullConfiguration() {
        try {
            // Install hooks
            const hooksResult = await this.installHooks();
            if (!hooksResult.success) {
                console.error('Failed to install hooks:', hooksResult.error);
            }
            
            // Configure MCP permissions
            const mcpResult = await this.configureMCPPermissions();
            if (!mcpResult.success) {
                console.error('Failed to configure MCP permissions:', mcpResult.error);
            }
            
            return {
                success: hooksResult.success && mcpResult.success,
                hooks: hooksResult,
                mcp: mcpResult
            };
        } catch (error) {
            console.error('Error ensuring full configuration:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = HooksManager;
