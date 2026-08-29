/**
 * title-gate-script.js
 *
 * Single source of truth for the CodeAgentSwarm PreToolUse title hook script body,
 * shared VERBATIM by BOTH agents:
 *   - Claude Code  (PreToolUse, matcher "")   -> hooks-manager.js
 *   - OpenAI Codex (PreToolUse, matcher "*")  -> codex-hooks-manager.js
 *
 * The hook is a NON-BLOCKING REMINDER. While the terminal is untitled it prints a
 * `hookSpecificOutput.additionalContext` JSON reminding the agent to call
 * set_terminal_title (then update_terminal_activity); it NEVER prints a
 * permissionDecision, so it can NEVER block a tool call. It is CAS-ONLY: with no
 * CODEAGENTSWARM_CURRENT_QUADRANT and no CODEAGENTSWARM_TERMINAL_ID it exits 0 and
 * prints nothing.
 *
 * ── WHY IT MUST NEVER DENY ───────────────────────────────────────────────────
 * A session where the codeagentswarm-tasks MCP server is NOT connected (e.g. Claude
 * Code launched inside an IDE like IntelliJ with the CAS env vars inherited from a
 * CAS-spawned shell) has NO set_terminal_title tool to call — the tool simply does
 * not exist in that session. A deny gate there traps the user forever: it keeps
 * blocking every tool call while the agent has no way to satisfy the gate. The
 * product rule is that CAS hooks NEVER block the user. (The previous DENY design ate
 * the first 8 tool calls / 90s in exactly that scenario before its caps gave up.)
 *
 * ── HOW CLAUDE CODE CONSUMES THE OUTPUT ──────────────────────────────────────
 * On PreToolUse, `hookSpecificOutput.additionalContext` is injected into the model's
 * context next to the tool results, and the tool call proceeds through the normal
 * permission flow (no bypass, no block). Older Claude Code versions and Codex simply
 * ignore the unknown field -> worst case the reminder is dropped, never a block.
 * Plain (non-JSON) stdout is NOT injected into the model on PreToolUse (only
 * SessionStart/UserPromptSubmit inject plain stdout), which is why the reminder is
 * delivered through the JSON channel.
 *
 * ── ROOT-CAUSE FIX (A): key the title on a STABLE terminal id ────────────────
 * The title marker is keyed on CODEAGENTSWARM_TERMINAL_ID — a stable id frozen at shell
 * spawn that main.js also writes under (it resolves the terminal object on every
 * set_terminal_title). Because both sides use the same frozen id, a CAS renumber
 * (quadrant 7 -> 9) can never desync the reminder — a titled terminal is never falsely
 * nagged after a renumber. Terminals spawned before this env var existed fall back to
 * the (mutable) quadrant key. The resilience layers below are defense-in-depth on top.
 *
 * Protocol (identical for Claude Code and Codex):
 *   - STDIN: a JSON object with `tool_name` and `session_id`.
 *   - REMIND: print the additionalContext JSON on stdout, exit 0.
 *   - SILENT: print nothing, exit 0.
 * The script never emits any permission/decision field under ANY state.
 *
 * ── FAIL-SILENT BY CONSTRUCTION ──────────────────────────────────────────────
 * The REMINDER is printed ONLY in the clean, unambiguous case:
 *     in CAS  AND  no title for this terminal  AND  no recent title anywhere
 *     AND  a usable session id  AND  the per-session caps are persistable
 *     AND  still within BOTH the invocation cap and the time cap.
 * EVERY other path — and every error/uncertainty (malformed/empty/huge stdin,
 * missing tool_name, state dir missing/unwritable, corrupt/unreadable markers,
 * clock/glob/stat failures, clock skew) — stays SILENT (exit 0). When in doubt, be
 * silent. There is no code path that can emit a permissionDecision.
 *
 * The three windows below no longer bound BLOCKING (there is none); they now bound
 * NAGGING / context spam, so the reminder is not repeated forever:
 *   (G) GRACE: if ANY *.title was written within GRACE_SECONDS, the agent just set a
 *       title -> the only reason OUR <key>.title looks missing is the stale-quadrant
 *       renumber, so stay silent immediately (instant renumber recovery, no false nag).
 *   (I) INVOCATION cap: remind on at most the first INVOCATION_CAP gated calls of a
 *       session, then stay silent (bounds nagging even if timestamps misbehave).
 *   (T) TIME cap: once a session has been reminded for TIME_CAP_SECONDS, never remind
 *       it again.
 * Whichever trips first wins. Caps are keyed on session_id (stable across renumber).
 *
 * Dependency-free (no jq). Always exits 0.
 */

// (G) If SOME .title was written this recently, treat the terminal as just-titled.
const GRACE_SECONDS = 120;
// (T) After a session has been reminded this long, stop reminding it (kept SHORT).
const TIME_CAP_SECONDS = 90;
// Remind on at most this many gated calls per session. The reminder is repeated
// context text, not a gate, so a few repetitions are enough; more is context spam.
const INVOCATION_CAP = 3;
// find(1) takes minutes; GRACE_SECONDS/60 is the -mmin window for the grace check.
const GRACE_MINUTES = GRACE_SECONDS / 60;

// Reminder text intentionally contains NO double quotes, NO single quotes/apostrophes
// and NO backslashes, so it embeds safely inside the single-quoted string literals
// below in BOTH bash and PowerShell. It carries NO permissionDecision — it can only
// ever remind, never block.
const NUDGE_JSON =
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"CodeAgentSwarm: this agent has no title yet. Call set_terminal_title with a short feature-level title, then update_terminal_activity with your first step. On Grok, these are MCP tools: search_tool then use_tool with codeagentswarm-tasks__set_terminal_title. This is a non-blocking reminder - the tool call proceeds normally. If the codeagentswarm-tasks MCP tools are not available in this session, ignore this reminder."}}';

// ---- Work-phase STATUS reminder (titled terminals only) ------------------------
// Fires when the agent is calling REAL work tools while the terminal status is
// missing or resting (needs_testing / done / needs_input / ...): actively using
// tools means it is de facto working, so the badge should say working. This is
// the Codex/mid-turn counterpart of the Claude-only UserPromptSubmit status nudge.
// Same fail-silent rules: any ambiguity -> silent, and NEVER a permissionDecision.

// If the .status marker changed this recently, the agent set it deliberately
// (e.g. needs_input right before asking) -> do not second-guess it yet.
const STATUS_GRACE_SECONDS = 120;
const STATUS_GRACE_MINUTES = STATUS_GRACE_SECONDS / 60;
// Remind at most this many times per EPISODE: per session, per resting value AND
// per marker mtime (the counter file name embeds the .status file's mtime, so
// every new status set re-arms the cap). A session-lifetime cap proved too weak:
// long sessions that flip working->done every turn exhausted their 2 'done'
// reminders in the first hour and the badge could then lie all day.
const STATUS_INVOCATION_CAP = 2;

// Same quoting constraints as NUDGE_JSON: no quotes, apostrophes or backslashes.
const STATUS_NUDGE_JSON =
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"CodeAgentSwarm: the agent status is not set to working right now. If you are actively working, call set_terminal_status with status working; when you stop again, set the matching status (needs_input, needs_testing, done). This is a non-blocking reminder - the tool call proceeds normally."}}';

/**
 * Bash reminder script (macOS/Linux). Returned with a trailing newline.
 */
function getBashTitleGateScript() {
    return `#!/bin/bash
# ============================================================================
# title-gate-hook.sh - CodeAgentSwarm PreToolUse NON-BLOCKING title reminder (fail-silent)
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# Reminds the agent to call set_terminal_title early in a session by injecting
# additionalContext. NEVER emits a permission decision, so it can never block a
# tool call. Shared verbatim by Claude Code and OpenAI Codex. CAS-only. ALWAYS
# exits 0. The REMINDER is printed ONLY in the clean unambiguous case; every
# error / ambiguity path stays silent. Dependency-free (no jq).
# ============================================================================
q="\${CODEAGENTSWARM_CURRENT_QUADRANT}"
tid="\${CODEAGENTSWARM_TERMINAL_ID}"
# Not inside CodeAgentSwarm (no quadrant AND no terminal id) -> stay silent.
[ -z "\$q" ] && [ -z "\$tid" ] && exit 0

# Read the hook JSON from stdin (stay silent if it cannot be read).
payload="\$(cat 2>/dev/null)" || exit 0

# Extract tool_name WITHOUT jq. Skip the compliance tools and read-only meta tools
# (substring match; Codex may prefix MCP tool names differently). Reminding on the
# title/activity tools themselves — or on read-only meta tools like ToolSearch/Skill —
# is pure noise; the reminder targets real work tools only.
tool="\$(printf '%s' "\$payload" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"tool_name"[[:space:]]*:[[:space:]]*"//; s/"\$//')"
case "\$tool" in
  *set_terminal_title*|*update_terminal_title*|*update_terminal_activity*|*set_terminal_status*|*check_active*|*ToolSearch*|*Skill*|*search_tool*|*use_tool*)
    exit 0 ;;
esac

state_dir="\$HOME/.codeagentswarm/terminal-nudge-state"

# Key on the STABLE terminal id when present (renumber-proof: id is frozen at spawn and
# is what main.js writes under). Fall back to the (mutable) quadrant only for terminals
# spawned before CODEAGENTSWARM_TERMINAL_ID existed.
if [ -n "\$tid" ]; then
  key="\$(printf '%s' "\$tid" | tr -c 'A-Za-z0-9_-' '_')"
else
  key="\$q"
fi

# (1) This terminal is titled -> the TITLE reminder is done; check the work-phase
# STATUS instead: calling real work tools while the status rests on needs_testing/
# done/needs_input (or is missing) means the badge is lying. Same fail-silent rules.
if [ -f "\$state_dir/\$key.title" ]; then
  # Per-agent Privacy toggle: when the work-phase-status feature is OFF for the
  # calling agent (flag written by main.js), the status reminder is silenced —
  # this branch has no other job, so exit. No agent env var -> do NOT silence.
  if [ -n "\${CODEAGENTSWARM_AGENT_TYPE}" ]; then
    agent_key="\$(printf '%s' "\${CODEAGENTSWARM_AGENT_TYPE}" | tr -c 'A-Za-z0-9_-' '_')"
    [ -f "\$state_dir/status-off-\$agent_key" ] && exit 0
  fi
  # Two cases deserve the reminder while the agent is calling real work tools:
  #   * a LYING badge (says needs_testing/done/... while work is happening), and
  #   * a MISSING badge — an agent that ignored the initial instructions would
  #     otherwise never be reminded again, leaving the terminal with no status for
  #     the whole session (seen live on a brand-new conversation).
  status_file="\$state_dir/\$key.status"
  if [ -f "\$status_file" ]; then
    # Status GRACE: the agent set a status moments ago (deliberate) -> stay silent.
    if [ -n "\$(find "\$status_file" -mmin -${STATUS_GRACE_MINUTES} 2>/dev/null | head -1)" ]; then
      exit 0
    fi
    current_status="\$(cat "\$status_file" 2>/dev/null)"
    [ "\$current_status" = "working" ] && exit 0
    [ -z "\$current_status" ] && current_status="none"
  else
    current_status="none"
  fi
  # Caps: per-session AND per resting status value. No usable session id -> silent.
  sid="\$(printf '%s' "\$payload" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"session_id"[[:space:]]*:[[:space:]]*"//; s/"\$//')"
  [ -z "\$sid" ] && exit 0
  safe_sid="\$(printf '%s' "\$sid" | tr -c 'A-Za-z0-9_.-' '_')"
  [ -z "\$safe_sid" ] && exit 0
  safe_status="\$(printf '%s' "\$current_status" | tr -c 'A-Za-z0-9_-' '_')"
  mkdir -p "\$state_dir" 2>/dev/null
  [ -d "\$state_dir" ] || exit 0
  [ -w "\$state_dir" ] || exit 0
  # Episode id = the marker's mtime, so a NEW status set re-arms the cap (BSD stat
  # first, GNU fallback). With NO status file yet there is nothing to stat: episode 0
  # is the "never set" episode, and the first real set starts a new one.
  if [ -f "\$status_file" ]; then
    episode="\$(stat -f %m "\$status_file" 2>/dev/null || stat -c %Y "\$status_file" 2>/dev/null)"
    case "\$episode" in ''|*[!0-9]*) exit 0 ;; esac
  else
    episode=0
  fi
  scount_file="\$state_dir/.status-count-\$safe_sid-\$safe_status-\$episode"
  if [ -f "\$scount_file" ]; then
    scount="\$(cat "\$scount_file" 2>/dev/null)"
    case "\$scount" in ''|*[!0-9]*) exit 0 ;; esac
  else
    scount=0
  fi
  scount=\$((scount + 1))
  printf '%s' "\$scount" > "\$scount_file" 2>/dev/null || exit 0
  [ "\$scount" -gt ${STATUS_INVOCATION_CAP} ] && exit 0
  printf '%s' '${STATUS_NUDGE_JSON}'
  exit 0
fi

# (G) GRACE: any .title written within the grace window -> stay silent (a title was
# just set; do not nag after a renumber). Instant stale-quadrant renumber recovery.
if [ -n "\$(find "\$state_dir" -maxdepth 1 -name '*.title' -mmin -${GRACE_MINUTES} 2>/dev/null | head -1)" ]; then
  exit 0
fi

# ---- From here a REMINDER is only printed if EVERYTHING below confidently holds; ----
# ---- any failure / ambiguity -> exit 0 (silent). ----

# Need a stable per-session key to apply the caps. No usable session id -> stay silent.
sid="\$(printf '%s' "\$payload" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"session_id"[[:space:]]*:[[:space:]]*"//; s/"\$//')"
[ -z "\$sid" ] && exit 0
safe_sid="\$(printf '%s' "\$sid" | tr -c 'A-Za-z0-9_.-' '_')"
[ -z "\$safe_sid" ] && exit 0

# State dir must exist and be writable so the caps can be persisted. Else stay silent.
mkdir -p "\$state_dir" 2>/dev/null
[ -d "\$state_dir" ] || exit 0
[ -w "\$state_dir" ] || exit 0

# (I) INVOCATION cap bounds the nagging. Corrupt counter -> silent. Unpersistable -> silent.
count_file="\$state_dir/.gate-count-\$safe_sid"
if [ -f "\$count_file" ]; then
  count="\$(cat "\$count_file" 2>/dev/null)"
  case "\$count" in ''|*[!0-9]*) exit 0 ;; esac
else
  count=0
fi
count=\$((count + 1))
printf '%s' "\$count" > "\$count_file" 2>/dev/null || exit 0
[ "\$count" -gt ${INVOCATION_CAP} ] && exit 0

# (T) TIME cap: after this, never remind this session again. No clock -> silent.
# Corrupt marker -> silent. Skew -> silent.
now="\$(date +%s 2>/dev/null)"
case "\$now" in ''|*[!0-9]*) exit 0 ;; esac
seen_file="\$state_dir/.gate-seen-\$safe_sid"
if [ -f "\$seen_file" ]; then
  first="\$(cat "\$seen_file" 2>/dev/null)"
  case "\$first" in ''|*[!0-9]*) exit 0 ;; esac
  elapsed=\$((now - first))
  [ "\$elapsed" -lt 0 ] && exit 0
  [ "\$elapsed" -gt ${TIME_CAP_SECONDS} ] && exit 0
else
  # First gated call for this session: record first-seen. Unpersistable -> silent.
  printf '%s' "\$now" > "\$seen_file" 2>/dev/null || exit 0
fi

# Clean unambiguous case: in CAS, untitled, no recent title, valid session, caps
# persisted, within both caps -> print the non-blocking reminder (context injection).
printf '%s' '${NUDGE_JSON}'
exit 0
`;
}

/**
 * PowerShell reminder script (Windows). Returned with a trailing newline.
 */
function getPowerShellTitleGateScript() {
    return `# ============================================================================
# title-gate-hook.ps1 - CodeAgentSwarm PreToolUse NON-BLOCKING title reminder (fail-silent)
# Auto-generated by CodeAgentSwarm - Do not edit manually
#
# Windows counterpart of title-gate-hook.sh. Reminds the agent to call
# set_terminal_title by injecting additionalContext; NEVER emits a permission
# decision, so it can never block a tool call. CAS-only. ALWAYS exits 0.
# The REMINDER is printed ONLY in the clean unambiguous case; every error /
# ambiguity path stays silent.
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'

$q = $env:CODEAGENTSWARM_CURRENT_QUADRANT
$tid = $env:CODEAGENTSWARM_TERMINAL_ID
# Not inside CodeAgentSwarm (no quadrant AND no terminal id) -> stay silent.
if ((-not $q) -and (-not $tid)) { exit 0 }

$payload = ''
try { $payload = [Console]::In.ReadToEnd() } catch { exit 0 }

$tool = ''
if ($payload -match '"tool_name"\\s*:\\s*"([^"]*)"') { $tool = $Matches[1] }
# Skip the compliance tools and read-only meta tools (ToolSearch/Skill): reminding on
# the title/activity tools themselves or on read-only meta tools is pure noise. Real
# work tools stay reminded until a title is set, so the nudge is preserved.
if ($tool -match 'set_terminal_title|update_terminal_title|update_terminal_activity|set_terminal_status|check_active|ToolSearch|Skill|search_tool|use_tool') {
  exit 0
}

$stateDir = Join-Path $env:USERPROFILE '.codeagentswarm\\terminal-nudge-state'

# Key on the STABLE terminal id when present (renumber-proof); else the quadrant.
if ($tid) { $key = ($tid -replace '[^A-Za-z0-9_-]', '_') } else { $key = $q }

# (1) This terminal is titled -> the TITLE reminder is done; check the work-phase
# STATUS instead (real work tools while the status rests -> remind to set working).
$titled = $false
try { $titled = Test-Path (Join-Path $stateDir ($key + '.title')) } catch { exit 0 }
if ($titled) {
  # Per-agent Privacy toggle: status feature OFF for the calling agent -> the
  # status reminder is silenced. No agent env var -> do NOT silence.
  $agentType = $env:CODEAGENTSWARM_AGENT_TYPE
  if ($agentType) {
    $agentKey = ($agentType -replace '[^A-Za-z0-9_-]', '_')
    $statusOff = $false
    try { $statusOff = Test-Path (Join-Path $stateDir ('status-off-' + $agentKey)) } catch { }
    if ($statusOff) { exit 0 }
  }
  # Two cases deserve the reminder: a LYING badge (needs_testing/done while work is
  # happening) and a MISSING one (an agent that ignored the initial instructions would
  # otherwise never be reminded again for the whole session).
  $statusFile = Join-Path $stateDir ($key + '.status')
  $statusExists = $false
  try { $statusExists = Test-Path $statusFile } catch { exit 0 }
  $currentStatus = 'none'
  $episode = 0
  if ($statusExists) {
    # Status GRACE: the agent set a status moments ago (deliberate) -> stay silent.
    try {
      $age = ((Get-Date) - (Get-Item $statusFile).LastWriteTime).TotalSeconds
      if ($age -lt ${STATUS_GRACE_SECONDS}) { exit 0 }
      $episode = (Get-Item $statusFile).LastWriteTime.ToFileTimeUtc()
    } catch { exit 0 }
    try { $currentStatus = (Get-Content $statusFile -Raw) } catch { exit 0 }
    if ($currentStatus) { $currentStatus = $currentStatus.Trim() }
    if (-not $currentStatus) { $currentStatus = 'none' }
    if ($currentStatus -eq 'working') { exit 0 }
  }
  # Caps: per-session AND per resting status value. No usable session id -> silent.
  $sid = ''
  if ($payload -match '"session_id"\\s*:\\s*"([^"]*)"') { $sid = $Matches[1] }
  if (-not $sid) { exit 0 }
  $safe = ($sid -replace '[^A-Za-z0-9_.-]', '_')
  if (-not $safe) { exit 0 }
  $safeStatus = ($currentStatus -replace '[^A-Za-z0-9_-]', '_')
  try { if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null } } catch { exit 0 }
  if (-not (Test-Path $stateDir)) { exit 0 }
  # Episode id ($episode above) = the marker's mtime, so a NEW status set re-arms the
  # cap; 0 is the "never set" episode.
  $scountFile = Join-Path $stateDir (".status-count-" + $safe + "-" + $safeStatus + "-" + $episode)
  $scount = 0
  if (Test-Path $scountFile) {
    $rawS = ''
    try { $rawS = (Get-Content $scountFile -Raw) } catch { exit 0 }
    if ($rawS -notmatch '^\\s*\\d+\\s*$') { exit 0 }
    $scount = [int]($rawS.Trim())
  }
  $scount = $scount + 1
  try { Set-Content -Path $scountFile -Value $scount -NoNewline -ErrorAction Stop } catch { exit 0 }
  if ($scount -gt ${STATUS_INVOCATION_CAP}) { exit 0 }
  Write-Output '${STATUS_NUDGE_JSON}'
  exit 0
}

# (G) GRACE: any .title written within the grace window -> stay silent (do not nag
# after a renumber). Instant stale-quadrant renumber recovery.
try {
  $cut = (Get-Date).AddSeconds(-${GRACE_SECONDS})
  $recent = Get-ChildItem -Path $stateDir -Filter '*.title' -File |
    Where-Object { $_.LastWriteTime -gt $cut } | Select-Object -First 1
  if ($recent) { exit 0 }
} catch { exit 0 }

# ---- A REMINDER is only printed if EVERYTHING below confidently holds; else silent. ----

# Need a stable per-session key for the caps. No usable session id -> stay silent.
$sid = ''
if ($payload -match '"session_id"\\s*:\\s*"([^"]*)"') { $sid = $Matches[1] }
if (-not $sid) { exit 0 }
$safe = ($sid -replace '[^A-Za-z0-9_.-]', '_')
if (-not $safe) { exit 0 }

# State dir must exist (creatable) so the caps can persist. Else stay silent.
try { if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null } } catch { exit 0 }
if (-not (Test-Path $stateDir)) { exit 0 }

# (I) INVOCATION cap bounds the nagging. Corrupt counter -> silent. Unpersistable -> silent.
$countFile = Join-Path $stateDir (".gate-count-" + $safe)
$count = 0
if (Test-Path $countFile) {
  $raw = ''
  try { $raw = (Get-Content $countFile -Raw) } catch { exit 0 }
  if ($raw -notmatch '^\\s*\\d+\\s*$') { exit 0 }
  $count = [int]($raw.Trim())
}
$count = $count + 1
try { Set-Content -Path $countFile -Value $count -NoNewline -ErrorAction Stop } catch { exit 0 }
if ($count -gt ${INVOCATION_CAP}) { exit 0 }

# (T) TIME cap: after this, never remind this session again. Corrupt marker -> silent.
# Skew -> silent.
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$seenFile = Join-Path $stateDir (".gate-seen-" + $safe)
if (Test-Path $seenFile) {
  $rawSeen = ''
  try { $rawSeen = (Get-Content $seenFile -Raw) } catch { exit 0 }
  if ($rawSeen -notmatch '^\\s*\\d+\\s*$') { exit 0 }
  $first = [long]($rawSeen.Trim())
  $elapsed = $now - $first
  if ($elapsed -lt 0) { exit 0 }
  if ($elapsed -gt ${TIME_CAP_SECONDS}) { exit 0 }
} else {
  try { Set-Content -Path $seenFile -Value $now -NoNewline -ErrorAction Stop } catch { exit 0 }
}

# Clean unambiguous case: in CAS, untitled, no recent title, valid session, caps
# persisted, within both caps -> print the non-blocking reminder (context injection).
Write-Output '${NUDGE_JSON}'
exit 0
`;
}

module.exports = {
    NUDGE_JSON,
    GRACE_SECONDS,
    TIME_CAP_SECONDS,
    INVOCATION_CAP,
    STATUS_NUDGE_JSON,
    STATUS_GRACE_SECONDS,
    STATUS_INVOCATION_CAP,
    getBashTitleGateScript,
    getPowerShellTitleGateScript,
};
