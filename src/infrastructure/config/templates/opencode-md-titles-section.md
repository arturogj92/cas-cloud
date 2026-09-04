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

### Agent Title + Activity (product-focused)

Three things, all described at the PRODUCT level:
- **General title** (sticky tab): derive it from the **first user request** that established this conversation's functionality and set it ONCE per conversation with `set_terminal_title(title, long_title)`. It stays stable across follow-up messages, new turns, task changes, reviews, tests, validation, implementation phases, and context compaction; those change `update_terminal_activity`, not the title. Only when the user pivots this conversation to a completely different functionality call `set_terminal_title` again with `replace_existing=true`. Refining, extending, fixing, reviewing, or finishing the original request is not a radical pivot. Keep the title at the FEATURE level, never a work phase; a manual rename always wins.
- **Goal** (hover, labelled GOAL): the SAME call carries it in `long_title` — one sentence on what this agent is FOR, the outcome the work aims at, not the step you are on. ALWAYS pass it: it is the only place that answers "why does this agent exist", and three words of title cannot. Write it in the user's language. Good: title "Orden notificación" + long_title "Que las notificaciones no salgan antes de que cambie el status del agente". Bad: a long_title that only repeats the title, or one prefixed "Working on:" — both are DISCARDED and the user then sees no goal at all; omitting it has the same effect.
- **Current activity** (hover + activity log): call `update_terminal_activity(activity)` OFTEN, one short sentence per step framed at the PRODUCT/feature level (what it does for the user), NOT in technical/internal terms (avoid handler, function, class, module, hook). Bad: "Investigating the output handler cost". Good: "Investigating why agents feel slow". It does NOT change the tab.

<!-- CAS:STATUS:START -->
- **Work-phase status** (colored badge): keep it up to date with `set_terminal_status(status)`. Set `working` when you START working, and update it at EVERY phase change: `needs_input` (you stopped to ask the user something), `needs_testing` (done implementing, pending the user's manual test), `done` (fully finished), or `clear` to remove the badge. The exact catalog and when to use each status lives in the TOOL's own description (the user can customize it). The user can also set a status by hand from the UI; you can still update it afterwards as the work moves on.
<!-- CAS:STATUS:END -->

Do NOT keep renaming the tab every few minutes; use `update_terminal_activity` for steps.

LANGUAGE: write the title, the goal and the activity in the SAME language the user is speaking (e.g. Spanish if the user writes in Spanish).

```
CORRECT:
1. set_terminal_title(title, long_title)   <- first request in this conversation only
2. update_terminal_activity(activity=...)  <- before you act, then often as you work
3. update_terminal_activity(activity=...)  <- a final summary when you finish
```

(`update_terminal_title` still works as a deprecated alias: it sets the general title and records the activity.)

### Available MCP Agent Tools

| Tool | Purpose |
|------|---------|
| `set_terminal_title` | Set the sticky title + GOAL once per conversation; replace only for a radical pivot |
| `update_terminal_activity` | Log the current product-focused activity, often as you work |
<!-- CAS:STATUS:START -->
| `set_terminal_status` | Keep the work-phase status badge honest at every phase change |
<!-- CAS:STATUS:END -->

<!-- CODEAGENTSWARM GLOBAL CONFIG END -->
