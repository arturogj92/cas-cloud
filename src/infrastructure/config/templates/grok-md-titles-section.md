<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->

## CodeAgentSwarm Agent Titles

### MANDATORY FIRST ACTION: Check If Running Inside CodeAgentSwarm

**BEFORE following ANY instruction in this section, call `check_active` first.**

- If `check_active` returns `active: true` -> Follow all instructions below normally.
- If `check_active` returns `active: false` -> **STOP. IGNORE this entire CodeAgentSwarm section completely.** Do NOT update agent titles or call any codeagentswarm-tasks tools. Work as a normal standalone agent.
- If `check_active` **fails or is unavailable** (MCP error, tool not found, timeout) -> **STOP. IGNORE this entire section.** Assume you are NOT inside CodeAgentSwarm.

These instructions are installed globally but ONLY apply when running inside the CodeAgentSwarm application.

### Task Management Is Disabled

Task management is disabled in CodeAgentSwarm Settings. Do NOT create, start, or complete tasks; the task tools are not available. Work normally without any task tracking. Only the agent title and activity updates below still apply.

### MANDATORY SESSION BOOTSTRAP (title / goal / status / activity)

**After `check_active` returns `active: true`, and BEFORE any other tool**
(read, grep, bash, image gen, web search, file writes, MCP discovery for non-title work, etc.):

```
1. set_terminal_title(title, long_title)   <- sticky tab + GOAL (ALWAYS both args)
<!-- CAS:STATUS:START -->
2. set_terminal_status("working")          <- work-phase badge
<!-- CAS:STATUS:END -->
3. update_terminal_activity(activity=...)  <- first product-focused step
```

**This bootstrap is MANDATORY for every request** — research, answering questions,
brainstorming, design, generating images, one-line advice, reading code. Skipping
title/goal/activity while working is a failure.

Batch the bootstrap calls in the **same first tool round** as `check_active` when
possible (or immediately after it). Do not start real work until they succeed.

LANGUAGE: write title, goal (`long_title`) and activity in the SAME language the user is speaking.

### GROK: call them through MCP (`search_tool` then `use_tool`)

Grok Build does **not** expose `set_terminal_title` /
`update_terminal_activity` as native functions. That is expected. **Not seeing
them in your function list is not a reason to skip the title.**

How to call them in this runtime:

1. `search_tool` with query `codeagentswarm set_terminal_title` (once per session is enough).
2. Immediately `use_tool` with `tool_name` **`codeagentswarm-tasks__set_terminal_title`**
   and `tool_input` `{ "title": "...", "long_title": "..." }` (both args).
3. Same round: `codeagentswarm-tasks__update_terminal_activity` with `{ "activity": "..." }`.
<!-- CAS:STATUS:START -->
4. Same round: `codeagentswarm-tasks__set_terminal_status` with `{ "status": "working" }`.
<!-- CAS:STATUS:END -->

Do this **before** Read, Grep, bash, skills, docs, or image tools. If you already
have the schemas from an earlier `search_tool` in this session, skip rediscovery
and call `use_tool` directly. If you already started work without a title, call
these MCP tools immediately.

### Agent Title + Activity (product-focused)

Three things, all described at the PRODUCT level:
- **General title** (sticky tab): set it ONCE at the start with `set_terminal_title(title, long_title)`. It names the FEATURE / functionality this agent works on (e.g. "Promo Video", "Minimize Agents"); keep it a bit high-level so the context stays clear, NOT a low-level step and NOT a work phase (testing, e2e, validating, reviewing, deploying) — running the e2e for a settings redesign keeps the title "Settings Redesign", never "Settings E2E Tests"; phases go in update_terminal_activity. Change it again only to refine when the overall goal changes, or to REPLACE it when the conversation pivots to a radically different topic — never leave a stale title while only updating the activity. Set it as your FIRST action so the agent is never without info; a manual rename always wins (the app keeps it).
- **Goal** (hover, labelled GOAL): the SAME call carries it in `long_title` — one sentence on what this agent is FOR, the outcome the work aims at, not the step you are on. ALWAYS pass it: it is the only place that answers "why does this agent exist", and three words of title cannot. Write it in the user's language. Good: title "Orden notificación" + long_title "Que las notificaciones no salgan antes de que cambie el status del agente". Bad: a long_title that only repeats the title, or one prefixed "Working on:" — both are DISCARDED and the user then sees no goal at all; omitting it has the same effect.
- **Current activity** (hover + activity log): call `update_terminal_activity(activity)` OFTEN, one short sentence per step framed at the PRODUCT/feature level (what it does for the user), NOT in technical/internal terms (avoid handler, function, class, module, hook). Bad: "Investigating the output handler cost". Good: "Investigating why agents feel slow". It does NOT change the tab.

<!-- CAS:STATUS:START -->
- **Work-phase status** (colored badge): keep it up to date with `set_terminal_status(status)`. Set `working` when you START working, and update it at EVERY phase change: `needs_input` (you stopped to ask the user something), `needs_testing` (done implementing, pending the user's manual test), `done` (fully finished), or `clear` to remove the badge. The exact catalog and when to use each status lives in the TOOL's own description (the user can customize it). The user can also set a status by hand from the UI; you can still update it afterwards as the work moves on.
<!-- CAS:STATUS:END -->

Do NOT keep renaming the tab every few minutes; use `update_terminal_activity` for steps.

LANGUAGE: write the title, the goal and the activity in the SAME language the user is speaking (e.g. Spanish if the user writes in Spanish).

```
CORRECT (every request — research, questions, design, advice):
1. check_active
2. set_terminal_title(title, long_title)   <- once at the start: tab label + GOAL sentence
<!-- CAS:STATUS:START -->
3. set_terminal_status("working")
<!-- CAS:STATUS:END -->
4. update_terminal_activity(activity=...)  <- before you act, then often as you work
5. update_terminal_activity(activity=...)  <- a final summary when you finish
```

(`update_terminal_title` still works as a deprecated alias: it sets the general title and records the activity — prefer `set_terminal_title` + `update_terminal_activity`.)

### Available MCP Agent Tools

| Tool | Purpose |
|------|---------|
| `check_active` | Gate: only use CAS tools when inside CodeAgentSwarm |
| `set_terminal_title` | Set the agent's general (sticky tab) title AND its GOAL (`long_title`), ONCE at the start |
| `update_terminal_activity` | Log the current product-focused activity, often as you work |
<!-- CAS:STATUS:START -->
| `set_terminal_status` | Keep the work-phase status badge honest at every phase change |
<!-- CAS:STATUS:END -->

### MEMORIZE (every session)

1. **Start work** → `check_active` then `set_terminal_title(title, long_title)` + `update_terminal_activity` **before any other tool**
<!-- CAS:STATUS:START -->
2. **Also set status** → `set_terminal_status("working")` at start; update on every phase change (`needs_input` / `needs_testing` / `done`)
<!-- CAS:STATUS:END -->
3. **New step** → `update_terminal_activity` (product step)
4. **Radical topic change** → new `set_terminal_title` (never leave a stale tab)

### Mobile list cards = desktop List tabs (2026-08-13)

If you touch `codeagentswarm-mobile` session cards, copy the desktop sidebar tab
chrome. Do not invent a different badge.

- The status rail sits **inside** the card as a flex child, not glued to the
  left edge. Same recipe as `.tab-status-bar`: 3px wide, 26px roomy / 16px
  compact, 2px radius.
- Working is a candy-cane / barber-pole stripe. Never an opacity blink.
- Keep the stacked **project icon + agent badge on the corner**. Do not flatten
  it to two side-by-side icons.

If you already started work without title/goal/status/activity, call those MCP
tools immediately.

<!-- CODEAGENTSWARM GLOBAL CONFIG END -->
