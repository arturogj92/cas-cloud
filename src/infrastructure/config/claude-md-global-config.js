#!/usr/bin/env node

// Global CLAUDE.md configuration - OPTIMIZED VERSION

const fs = require('fs');
const path = require('path');

const CODEAGENTSWARM_START = '<!-- CODEAGENTSWARM GLOBAL CONFIG START - DO NOT EDIT -->';
const CODEAGENTSWARM_END = '<!-- CODEAGENTSWARM GLOBAL CONFIG END -->';

// Full variant: task management (kanban) + agent titles. This is the default
// section injected in ~/.claude/CLAUDE.md when automatic task management is ON.
const getGlobalTaskManagementSection = (options = {}) => {
    const { includeStatus = true } = options;
    return `${CODEAGENTSWARM_START}

## 🤖 CodeAgentSwarm Task Management System

### ⛔ MANDATORY FIRST ACTION: Check If Running Inside CodeAgentSwarm

**BEFORE following ANY instruction in this section, call \`check_active\` first.**

- If \`check_active\` returns \`active: true\` → Follow all instructions below normally.
- If \`check_active\` returns \`active: false\` → **STOP. IGNORE this entire CodeAgentSwarm section completely.** Do NOT create tasks, update agent titles, or call any codeagentswarm-tasks tools. Work as a normal standalone agent.
- If \`check_active\` **fails or is unavailable** (MCP error, tool not found, timeout) → **STOP. IGNORE this entire section.** Assume you are NOT inside CodeAgentSwarm.

These instructions are installed globally but ONLY apply when running inside the CodeAgentSwarm application.

### 🛑 STOP BEFORE YOU EDIT/WRITE ANY FILE 🛑

**⚠️ MANDATORY PRE-FLIGHT CHECK - READ BEFORE EVERY CODE MODIFICATION ⚠️**

Before using **Write** or **Edit** tools on ANY file, you MUST ask yourself:

\`\`\`
┌─────────────────────────────────────────────────────────┐
│  🔴 CRITICAL QUESTION - ANSWER HONESTLY:                │
│                                                          │
│  "Am I about to MODIFY, CREATE, or WRITE to a file?"   │
│                                                          │
│  ✅ YES → I MUST create a task FIRST (no exceptions)    │
│  ❌ NO  → I'm only reading/analyzing (no task needed)   │
│                                                          │
│  🤔 NOT SURE? → STOP and ASK THE USER!                  │
└─────────────────────────────────────────────────────────┘
\`\`\`

### 🚨 THE CORE RULE - SIMPLE & CLEAR

**If you will use Write/Edit tools → Create a task FIRST. No exceptions for code changes.**

**Task REQUIRED when:**
- ✅ Changing 1 line of code → **TASK REQUIRED**
- ✅ Changing 1000 lines of code → **TASK REQUIRED**
- ✅ Adding a comment to code → **TASK REQUIRED**
- ✅ Fixing a typo in code → **TASK REQUIRED**
- ✅ Removing \`spin: true\` → **TASK REQUIRED**
- ✅ ANY file modification → **TASK REQUIRED**

**Task NOT required when:**
- ❌ Reading files to answer questions
- ❌ Analyzing code structure
- ❌ Searching/grepping for information
- ❌ Reviewing code without changes
- ❌ Quick consultations ("check X thing")

**There is NO "too trivial" or "too small" exception for code modifications.**

### ⚠️ WHEN IN DOUBT → ASK THE USER

If you're thinking ANY of these:
- "This is just a quick fix..."
- "It's only one line..."
- "This is too small for a task..."
- "Should I create a task for this?"

**STOP IMMEDIATELY and ask the user:**
- "Should I create a task for this change?"
- "This modifies code - should I track it as a task?"

**Never assume. Always ask when uncertain.**

### 🔍 Common Mistakes That Are FORBIDDEN

❌ **"It's just removing one property, I'll skip the task"**
✅ **WRONG.** Creating task is MANDATORY regardless of size.

❌ **"I already made the change, I'll create the task after"**
✅ **WRONG.** Task MUST be created BEFORE any Write/Edit.

❌ **"The user asked for a quick fix, no time for tasks"**
✅ **WRONG.** Task system adds <10 seconds. Always required.

❌ **"I'm just fixing a typo, surely that doesn't need a task"**
✅ **WRONG.** If it modifies a file, it needs a task. No exceptions.

### ✅ CORRECT WORKFLOW - MEMORIZE THIS ORDER

\`\`\`
1. User requests code change
2. 🛑 STOP - About to modify files?
3. ✅ YES → MANDATORY SEQUENCE:
   a) find_related_active_tasks
   b) create_task (if no match found)
   c) start_task
   d) update_terminal_title
   e) update_task_plan
   f) NOW you can use Write/Edit tools
   g) update_task_implementation
   h) complete_task
\`\`\`

**NEVER SKIP STEPS 3a-3e. NEVER.**

### 🎯 Task Creation Guidelines - Simple & Clear

**✅ ALWAYS CREATE A TASK when you will:**
- Write or modify ANY code file (.js, .jsx, .ts, .py, .css, .html, etc.)
- Create or edit configuration files that change behavior
- Write, modify, or fix tests
- Make database schema or migration changes
- Implement features, fix bugs, or refactor code
- Add or modify documentation as part of implementation

**❌ NEVER CREATE A TASK for:**
- Reading/analyzing code without modifications
- Git operations (commit, push, pull, status, branch, merge)
- Installing dependencies (npm install, pip install)
- Starting/stopping servers (npm start, npm test, npm run dev)
- Answering questions or explaining how code works
- Running database queries for investigation only (SELECT)
- Using gh commands (pr create, release, etc.)

**🎯 Simple Rule:**
- **CHANGING files = Task**
- **READING files = No task**
- **When in doubt** → If you'll use Write or Edit tools = Create task

### 📋 Mandatory Task System Workflow

**When starting work:**

1. **Check for existing tasks** using \`find_related_active_tasks\`
   - Similarity >70% → Use existing task automatically
   - Similarity 50-70% → Ask user
   - Similarity <50% → Create new task

2. **Create task if needed** using \`create_task\`
   - Terminal ID: AUTO-DETECTED from \`CODEAGENTSWARM_CURRENT_QUADRANT\`
   - Project: AUTO-DETECTED from CLAUDE.md "Project Name:" field

3. **Start the task** using \`start_task\` before any work
   - **🔄 CRITICAL:** \`start_task\` ALWAYS moves tasks to \`in_progress\` status
   - Works for ANY status: \`pending\`, \`in_testing\`, OR \`completed\`
   - **Resuming work?** Just call \`start_task\` - it automatically returns task to \`in_progress\`
   - **No exceptions:** Always use \`start_task\` when beginning work, regardless of current status

4. **Update agent title** using \`update_terminal_title\` IMMEDIATELY

5. **Update the plan** using \`update_task_plan\` with detailed steps

6. **Testing Flow** - \`complete_task\` ONCE → \`in_testing\` (NEVER directly to \`completed\`)

### 🚨 Agent Titles: General Title + Current Activity (PRODUCT-FOCUSED)

# ⛔ CRITICAL: there are TWO levels, and BOTH are product-focused ⛔

CodeAgentSwarm shows two different things per agent:
1. **General title** = the sticky tab label. It describes, at the FEATURE / functionality
   level, what this agent is working on (the goal/feature). Keep it a bit high-level so
   the context stays clear at a glance — name the feature, NOT a low-level step or file,
   and NOT a work PHASE (testing, e2e, validating, reviewing, deploying). Running the e2e
   suite for a settings redesign is titled "Settings Redesign", never "Settings E2E Tests".
   Derive it from the **first user request** that established this conversation's
   functionality and set it ONCE per conversation. It stays stable across follow-ups,
   new turns, tasks, reviews, tests, validation, finishing, and context compaction.
2. **Current activity** = the product-focused step you are doing RIGHT NOW. Example:
   "Implementing the analytics tracking backend". It is shown only when the user hovers
   the agent, and it accumulates as the activity log behind the clock button.

## 📢 THE RULE

**🚦 FIRST ACTION in a new conversation:** set the GENERAL title from the first user
request. On later turns, do NOT call \`set_terminal_title\`; update activity instead.

**📍 ALWAYS leave a CURRENT SUMMARY before acting.** Right after the title, call
\`update_terminal_activity\` with your first product-focused step, BEFORE running any other
tool. If an agent has no activity yet, set one before you do anything else — so at every
moment the user can see what each agent is doing. Never start working with no activity set.

**First request → set the title ONCE. Every turn → update the ACTIVITY.**

- ✅ Keep the title from the first user request. Refining, extending, fixing, reviewing,
  validating, or finishing that request changes the activity, not the title.
- ✅ RADICAL topic change → NEW general title, MANDATORY. When the user switches this
  agent to a completely different topic (e.g. from "Minimize Agents" to preparing
  a release), call \`set_terminal_title\` again with \`replace_existing=true\`. Updating only the
  activity and leaving the old title is WRONG: the tab would keep describing work that
  is no longer happening.
- ✅ Update the activity every time your focus moves to a new step. This is what the user
  sees on hover, and it never thrashes the tab.
- ❌ Do NOT keep changing the general title every few minutes. A title that jumps from
  "Promo Video" to "Editing WordPress" to "Rendering" is exactly what we are fixing.

**🌍 LANGUAGE:** Write the general title, the GOAL and the activity in the SAME language the
user is speaking (Spanish if the user writes in Spanish, English if English, etc.). Only
the app's own static UI stays in English; these agent-written labels follow the user.

**🔧 THE TWO TOOLS:**
\`\`\`
# 1) ONCE on the conversation's first request - the sticky tab title
mcp__codeagentswarm-tasks__set_terminal_title(
    title="Promo Video",
    long_title="Promotional video for the Twitter launch"
)

# 2) OFTEN as you work - the current product-focused step (hover + activity log)
mcp__codeagentswarm-tasks__update_terminal_activity(
    activity="Recording the app screen capture"
)
mcp__codeagentswarm-tasks__update_terminal_activity(
    activity="Editing the WordPress landing embed"
)
\`\`\`

**📝 HOW EACH ONE WORKS:**
- **\`set_terminal_title(title, long_title)\`**: TWO arguments, both shown to the user, and
  you must ALWAYS pass both. \`title\` is a short (max 6 words), PRODUCT-level label shown
  in the tab. \`long_title\` is the **GOAL**: one sentence on what this agent is FOR — the
  outcome the work aims at, not the step you are on. The user reads it in the hover under
  the title, labelled GOAL, and it is the ONLY place that answers "why does this agent
  exist"; six words cannot carry that. Repeated calls preserve the first title. Pass
  \`replace_existing=true\` only after the user pivots to completely different functionality.
  \`\`\`
  ✅ title="Orden notificación"
     long_title="Que las notificaciones no salgan antes de que cambie el status del agente"
  ✅ title="Minimize Agents"
     long_title="Add the ability to minimize agents and restore them later"
  ❌ long_title="Orden notificación"        ← only repeats the title: DISCARDED, no goal shown
  ❌ long_title="Working on: Promo Video"   ← filler: DISCARDED, no goal shown
  ❌ long_title omitted                     ← the app invents filler and shows NO goal
  \`\`\`
- **\`update_terminal_activity(activity)\`**: one short sentence about what you are doing now,
  framed at the PRODUCT / feature level (what it achieves for the user), NOT in technical or
  internal terms. Avoid jargon like handler, function, class, module, hook, refactor. Bad:
  "Investigating the cost of the output handler per agent" or "Editing renderer.js". Good:
  "Investigating why agents feel slow" or "Implementing the export button". Call it often.
  It does NOT change the tab.
- **DEPRECATED \`update_terminal_title\`**: still works (it sets the general title and also
  records the long_title as an activity), but prefer the two tools above.

## 🎯 WORKFLOW

### ✅ WHEN CREATING/STARTING A TASK:
\`\`\`
1. find_related_active_tasks(...)        ← Check first
2. create_task(...)                      ← If needed
3. start_task(task_id=123)
4. set_terminal_title(                    ← only if this conversation has no title
     title="Minimize Agents",
     long_title="Add the ability to minimize and restore agents"
   )
5. update_task_plan(...)
6. update_terminal_activity(activity="Adding the minimize button to the header")
7. ...keep calling update_terminal_activity as your focus moves to new steps...
\`\`\`

**🚨 CRITICAL:** starting another task in the same conversation does not justify retitling it.

### ✅ WITHOUT A TASK (research/investigation):
\`\`\`
1. set_terminal_title(
     title="Analyze Auth",
     long_title="Understanding how the authentication system works"
   )                                       ← general title, ONCE
2. update_terminal_activity(activity="Reading the JWT middleware")  ← as you go
3. Read files, analyze, answer...
\`\`\`

### ✅ SAME GOAL, NEW STEP → update the ACTIVITY (not the title):
\`\`\`
# The general title stays "Minimize Agents"
update_terminal_activity(activity="Implementing restore-from-minimized")
update_terminal_activity(activity="Persisting minimized state across restarts")
\`\`\`

### ✅ THE ORIGINAL GOAL EXPANDS → keep the title and update ACTIVITY:
\`\`\`
# The user expanded the same feature; the first title remains "Minimize Agents":
update_terminal_activity(activity="Adding restore from the tray")
\`\`\`

### ✅ RADICAL TOPIC CHANGE → set a NEW general title (mandatory):
\`\`\`
# The agent was doing "Minimize Agents" and the user pivots completely:
User: "leave that, now let's prepare the release notes"
set_terminal_title(
  title="Release Notes",
  long_title="Preparing the release notes for the next version",
  replace_existing=true
)
update_terminal_activity(activity="Drafting the release notes")
# ❌ WRONG: calling only update_terminal_activity here — the tab would still
# read "Minimize Agents" while the agent works on something else.
\`\`\`

## ⚠️ WHEN TO USE WHICH

- **General title (set_terminal_title):** once per conversation from the first request.
  Replace only after a radical functionality pivot, with \`replace_existing=true\`.
- **Current activity (update_terminal_activity):** every time you move to a new product
  step. Call it freely - it never disturbs the tab.

### 🏁 When FINISHING a task:
- Send a final \`update_terminal_activity\` summarizing what was accomplished
  (e.g. "Finished minimize/restore for agents") BEFORE \`complete_task\`.
- You normally do NOT need to change the general title at the end - it already
  describes the goal.

## 🎯 WHY THIS MATTERS

1. **Clarity:** the tab gives a stable, at-a-glance answer to "what is this agent for?"
2. **No thrash:** the title stops jumping every few minutes, so it is easy to follow.
3. **Detail on demand:** the current step is one hover away, and the full log is behind the
   clock button, without cluttering the tab.

## 📋 CORRECT EXAMPLES

**Example 1 - Feature with a task:**
\`\`\`
User: "I want an option to minimize agents"
Agent:
  ✅ find_related_active_tasks(...) → create_task(...) → start_task(task_id=42)
  ✅ set_terminal_title(title="Minimize Agents",
       long_title="Add the ability to minimize and restore agents")   ← ONCE
  ✅ update_task_plan(...)
  ✅ update_terminal_activity(activity="Adding the minimize button to the header")
  ✅ update_terminal_activity(activity="Wiring the minimize action in the renderer")

User: "also let me reopen the minimized ones"
Agent:
  ✅ update_terminal_activity(activity="Implementing restore for minimized agents")
     ← same general title, just a new activity
\`\`\`

**Example 2 - Promo video (the title stays put):**
\`\`\`
User: "let's make a promo video for Twitter"
Agent:
  ✅ set_terminal_title(title="Promo Video",
       long_title="Promotional video for the Twitter launch")            ← ONCE
  ✅ update_terminal_activity(activity="Recording the app screen capture")
  ✅ update_terminal_activity(activity="Editing the WordPress landing embed")
  ✅ update_terminal_activity(activity="Adding captions and music")
# The tab still reads "Promo Video" the whole time.
\`\`\`

**Example 3 - Research without a task:**
\`\`\`
User: "how does routing work?"
Agent:
  ✅ set_terminal_title(title="Analyze Routing",
       long_title="Understanding the routing and middleware setup")
  ✅ update_terminal_activity(activity="Reading the Express route definitions")
  ✅ Answer...
\`\`\`

## ❌ INCORRECT

**Bad 1 - Changing the general title for every step (the old anti-pattern):**
\`\`\`
set_terminal_title(title="Promo Video")
set_terminal_title(title="Editing WordPress")   ← ❌ this is a STEP, use update_terminal_activity
set_terminal_title(title="Rendering")           ← ❌ the tab now jumps around
\`\`\`

**Bad 2 - Technical/file-level activity instead of product-level:**
\`\`\`
update_terminal_activity(activity="Editing renderer.js line 200")             ← ❌ file term
update_terminal_activity(activity="Investigating the output handler cost")    ← ❌ internal jargon
✅ update_terminal_activity(activity="Implementing the minimize button")
✅ update_terminal_activity(activity="Investigating why agents feel slow")
\`\`\`

**Bad 3 - Never setting a general title:**
\`\`\`
# Only calling update_terminal_activity, so the tab never gets a product label.
✅ Set the title ONCE from the first user request so the tab is meaningful.
\`\`\`

**Bad 4 - Radical topic change but the title never changes:**
\`\`\`
# Title: "Promo Video". The user then says: "now let's debug the login crash"
update_terminal_activity(activity="Debugging the login crash")   ← ❌ tab still says "Promo Video"
✅ set_terminal_title(title="Login Crash", long_title="Debugging the crash when logging in", replace_existing=true)
✅ update_terminal_activity(activity="Reproducing the login crash")
\`\`\`

**Bad 5 - Title names a work PHASE instead of the feature:**
\`\`\`
# Working on the settings redesign, now validating it with the e2e suite:
set_terminal_title(title="Settings E2E Tests")   ← ❌ testing is a STEP of the redesign
✅ set_terminal_title(title="Settings Redesign")  ← the feature stays the title
✅ update_terminal_activity(activity="Running the e2e suite for the settings redesign")
# Same for "Reviewing X", "Deploying X", "Validating X" — phases are ACTIVITIES, not titles.
\`\`\`

${includeStatus ? `### 🚦 Agent STATUS: the work-phase badge

Alongside the title and the activity there is a third signal: the agent STATUS — which
PHASE the current work is in. It is shown as a colored badge on the agent, so the user
can scan all agents at a glance without reading anything.

**Keep it up to date with \`set_terminal_status\`:**
\`\`\`
mcp__codeagentswarm-tasks__set_terminal_status(status="working")        ← when you start working
mcp__codeagentswarm-tasks__set_terminal_status(status="needs_input")    ← you stop to ask the user something
mcp__codeagentswarm-tasks__set_terminal_status(status="needs_testing")  ← done implementing, pending the user's manual test
mcp__codeagentswarm-tasks__set_terminal_status(status="done")           ← fully finished
mcp__codeagentswarm-tasks__set_terminal_status(status="clear")          ← remove the badge
\`\`\`

Rules:
- Set \`working\` when you START working on a request, and update the status at EVERY
  phase change — especially when you STOP (to ask, to hand over for testing, or because
  you finished). An agent that says "working" while it is
  actually waiting for the user is worse than no status.
- The exact list of statuses and when to use each one lives in the TOOL's own
  description — read it there; the user can customize the catalog.
- The user can also set a status by hand from the UI; you can still update it afterwards
  as the work moves on.
- The status complements (never replaces) the title and the activity.

` : ''}## 🚨 FINAL REMINDER

- Set the **general title AND GOAL once per conversation**, from the first user request.
  Follow-ups never retitle; a radical functionality pivot uses \`replace_existing=true\`.
- Keep the **current activity** flowing with \`update_terminal_activity\` (product-level),
  one short sentence per step.
${includeStatus ? `- Keep the **status badge** honest with \`set_terminal_status\` at every phase change.
` : ''}- The tab should stay stable; the hover + clock-button log carry the detail.

**MEMORIZE:**
${includeStatus ? `1. **First request → \`set_terminal_title(title, long_title)\` once + \`set_terminal_status(status="working")\`**
2. **New step → \`update_terminal_activity\` (product step)**
3. **Phase changed (waiting / testing / done) → \`set_terminal_status\`**
4. **Radical functionality pivot → \`set_terminal_title(..., replace_existing=true)\`**
5. **🏁 Finishing → final \`update_terminal_activity\` summary + \`set_terminal_status\` → \`complete_task\`**` : `1. **First request → \`set_terminal_title(title, long_title)\` once**
2. **New step → \`update_terminal_activity\` (product step)**
3. **Radical functionality pivot → \`set_terminal_title(..., replace_existing=true)\`**
4. **🏁 Finishing → final \`update_terminal_activity\` summary → \`complete_task\`**`}

### 📝 Task Plan Management

**Each task MUST have a detailed plan:**

1. Use \`update_task_plan\` with numbered steps including:
   - Files to modify/create
   - Dependencies/prerequisites
   - Success criteria

2. Before completion, MANDATORY:
   - Verify all plan points completed
   - Document using \`update_task_implementation\`
   - Include: modified files, summary, functionality

3. If plan incomplete:
   - Continue working OR
   - Update plan and create new task for pending

### 🧪 Testing Flow - NEVER Direct to Completed

**All tasks MUST go through testing:**

\`\`\`
pending → in_progress → in_testing → [USER APPROVAL] → completed
\`\`\`

1. **First \`complete_task\`** → Moves to \`in_testing\`
2. **STOP and WAIT** for user approval
3. **User says "mark as completed"** → Second \`complete_task\`
4. **NEVER** auto-complete from testing

### 🤔 Task Continuation Decision

**When user provides new instructions:**

1. **Analyze if related to current task**
2. **If related:** Continue with same task; record the new step with \`update_terminal_activity\`
3. **If unrelated (radical topic change):** Ask about new task creation, and set a NEW
   general title with \`set_terminal_title\` — the old title no longer describes this agent
4. **If clarification:** Answer without new task; keep the activity fresh

**CRITICAL:** The general title reflects the agent's CURRENT topic.
- Same goal, new steps → update the ACTIVITY, keep the title
- Radically different topic → set a NEW general title (never leave a stale one)

**🎯 IMPORTANT: Fixing Issues During Development**
- **When something doesn't work during task development** (tests fail, feature broken, etc.):
  - ✅ **CONTINUE with the SAME TASK** - Don't create a new one
  - ✅ Fix the issues as part of the current development cycle
  - ✅ Update the task plan if needed to reflect additional work
  - ❌ **DON'T** create a new task for "fixing" what you just built
  - **Example:** Working on "Add pagination" task → pagination doesn't work → FIX IT in the same task
  - **Rationale:** Issues found during development are part of the development process

### 💪 Task Scope & Completion Standards

**When working on a task, complete it FULLY before finishing:**

**✅ COMPLETE in the SAME task:**
- The main requested feature or bug fix
- ALL bugs discovered while implementing
- Tests for the new functionality
- Error handling and edge cases
- Code cleanup needed for the change
- Running tests and fixing any failures
- Basic documentation if feature is self-contained

**❌ DON'T stop prematurely:**
- Don't mark complete if tests fail - fix them first
- Don't stop at "partial implementation" - finish the feature
- Don't leave broken functionality - make it work completely
- Don't create separate tasks for test failures you caused

**🎯 Example - "Add user login" request:**

**✅ Good (ONE complete task):**
1. Create login form
2. Add backend endpoint
3. Discover validation bug → Fix it immediately
4. Add authentication logic
5. Add error messages
6. Write tests
7. Tests fail → Debug and fix
8. Verify everything works
9. Mark as complete

**❌ Bad (fragmenting work):**
- Task 1: "Create form" → Complete
- Task 2: "Add backend" → Complete
- Task 3: "Fix validation bug" → Complete
- Task 4: "Add tests" → Complete
- Task 5: "Fix test failures" → Complete

**💡 Key principle:** One logical feature = One complete task (including all fixes needed to make it work)

### 🚧 Scope Boundaries - When to STOP and Create New Task

**⛔ STOP current task and create NEW when:**

1. **User explicitly requests something different**
   - "Now add X feature"
   - "Also implement Y"
   - "While you're at it, do Z"

2. **You finished the original request and want to improve/add more**
   - "This works, but I could also add..."
   - "While I'm here, I should improve..."
   - "This would be a good time to refactor..."

3. **The work is a separate feature**, even if related
   - Original: "Fix login bug"
   - Extra: "Add password reset" ← NEW TASK

4. **Switching from implementation to enhancements**
   - Original: "Implement sprites"
   - Extra: "Balance gameplay" ← NEW TASK

**🚨 RED FLAGS (mean you need NEW TASK):**
- Thinking "While I'm at it..."
- Thinking "This would be good to add..."
- More than 8-10 agent title updates
- Working on the task for >30 minutes on unrelated improvements
- User requests something while you're working

**✅ CONTINUE same task when:**
- Fixing bugs that prevent YOUR feature from working
- Adding missing pieces YOUR feature needs to work
- Within the original request scope
- User is clarifying/adjusting the current request

**📋 Real Example Analysis:**

\`\`\`
❌ BAD - One task with scope creep:
06:00 - Implement ninja sprites ✅ (original)
06:11 - Fix sprite bugs ✅ (needed for sprites)
06:12 - Add Peasant character ❌ (NEW FEATURE → should be new task)
06:15 - Add Samurai character ❌ (NEW FEATURE → should be new task)
06:18 - Improve arrows ❌ (ENHANCEMENT → should be new task)
06:20 - Adjust speeds ❌ (BALANCING → should be new task)
06:22 - Improve enemies ❌ (ENHANCEMENT → should be new task)

✅ GOOD - Proper task separation:
Task 1: "Implement ninja sprites" (06:00-06:11)
  - Implement sprites
  - Fix animation bugs

Task 2: "Add character variants" (06:12-06:15)
  - Add Peasant with attack
  - Add Samurai Archer

Task 3: "Balance gameplay mechanics" (06:18-06:22)
  - Improve arrow visuals
  - Adjust movement/projectile speeds
  - Enhance enemy behavior
\`\`\`

### 🔄 Reopen vs New Task Rules

**Continue with current task when:**
- **🚨 Issues found DURING development** (tests fail, feature broken)
- **🚨 Something doesn't work while implementing**
- Fixing bugs in the code you JUST wrote
- Adjusting implementation during active development
- Tests need fixing for current feature

**Reopen existing task when:**
- Continuing same feature/bug <24h old
- Bug in just-completed work (task already in testing/completed)
- Direct adjustments to recent work

**Create new task when:**
- Different feature/scope
- >24h since last related work
- User explicitly requests new task
- Bug in OLD code (not related to current development)

### Available MCP Task Tools

**Core:**
- \`create_task\` - Auto-detects agent/project
- \`start_task\` - Mark in_progress
- \`complete_task\` - First: testing, Second: completed
- \`update_terminal_title\` - MANDATORY immediately
- \`update_task_plan\` - Detailed steps
- \`update_task_implementation\` - Document changes

**Search & Management:**
- \`find_related_active_tasks\` - Find similar (>70% auto-use)
- \`search_tasks\` - Keyword search
- \`list_tasks(limit, offset)\` - With pagination
- \`update_task_terminal\` - Change assignment
- \`update_task_project\` - Change task project

**Subtasks & Projects:**
- \`create_subtask\` - Under parent task
- \`suggest_parent_tasks\` - AI suggestions
- \`get_task_hierarchy\` - Full tree
- \`create_project\` - With color
- \`get_project_tasks\` - By project

### 🔗 Subtask System

**Use subtasks when:**
- Breaking complex tasks into pieces
- Adding to existing tasks (even completed)
- Fixing bugs in completed features
- Grouping related work

**Features:**
- Auto-inherit project from parent
- AI-powered parent suggestions
- Can create under completed parents
- Nested hierarchy support

### 📊 Project Organization

Tasks auto-organize by project:
1. Read CLAUDE.md "Project Name:" field
2. Fallback to directory name
3. Unique color per project
4. Filter with \`get_project_tasks\`

### Pagination Best Practices

Avoid token limits:
- Use status filters: \`list_tasks(status="pending", limit=10)\`
- Start small: \`limit=10\` or \`limit=20\`
- Paginate: \`list_tasks(limit=20, offset=20)\`

## 📚 Documentation

**Documentation guidelines:**
- Create appropriate markdown files for documentation
- Update after: features, architecture, DB changes, bugs

## Quick Decision Guide

**Need a Task?**
- Modifying code? → YES
- Just reading? → NO
- Running commands? → NO
- Creating new? → YES

**Agent Title?**
- Set it from the first user request, once per conversation
- Follow-up work changes activity, never the title
- Radical functionality pivot → replace with \`replace_existing=true\`

**Task Continuation?**
- Same work <24h → Continue
- Different scope → New task
- Unsure → Ask user

${CODEAGENTSWARM_END}`;
};

// Titles-only variant: injected when the user disables automatic task management
// in Settings but keeps the task system on. It preserves the check_active gate and
// ALL the agent title/activity rules, tells the agent explicitly that task
// tools are unavailable, and never mentions the kanban workflow.
// NOTE: the title/activity prose is intentionally kept in sync with the full
// variant above — if you edit the titles section there, mirror it here.
const getGlobalTitlesOnlySection = () => `${CODEAGENTSWARM_START}

## 🤖 CodeAgentSwarm Agent Titles

### ⛔ MANDATORY FIRST ACTION: Check If Running Inside CodeAgentSwarm

**BEFORE following ANY instruction in this section, call \`check_active\` first.**

- If \`check_active\` returns \`active: true\` → Follow all instructions below normally.
- If \`check_active\` returns \`active: false\` → **STOP. IGNORE this entire CodeAgentSwarm section completely.** Do NOT update agent titles or call any codeagentswarm-tasks tools. Work as a normal standalone agent.
- If \`check_active\` **fails or is unavailable** (MCP error, tool not found, timeout) → **STOP. IGNORE this entire section.** Assume you are NOT inside CodeAgentSwarm.

These instructions are installed globally but ONLY apply when running inside the CodeAgentSwarm application.

### 🚫 Automatic Task Management Is Disabled

**The user turned automatic task management OFF in CodeAgentSwarm Settings.**

- Do NOT create, start, complete, or manage tasks. The task-management tools (tasks, plans, subtasks) are NOT available in this environment.
- Never block work, ask about tasks, or mention the task system — just do the work directly.
- The agent title and activity rules below STILL apply. They are independent of task management and remain mandatory.

### 🚨 Agent Titles: General Title + Current Activity (PRODUCT-FOCUSED)

# ⛔ CRITICAL: there are TWO levels, and BOTH are product-focused ⛔

CodeAgentSwarm shows two different things per agent:
1. **General title** = the sticky tab label. It describes, at the FEATURE / functionality
   level, what this agent is working on (the goal/feature). Keep it a bit high-level so
   the context stays clear at a glance — name the feature, NOT a low-level step or file,
   and NOT a work PHASE (testing, e2e, validating, reviewing, deploying). Running the e2e
   suite for a settings redesign is titled "Settings Redesign", never "Settings E2E Tests".
   Derive it from the **first user request** that established this conversation's
   functionality and set it ONCE per conversation. It stays stable across follow-ups,
   new turns, tasks, reviews, tests, validation, finishing, and context compaction.
2. **Current activity** = the product-focused step you are doing RIGHT NOW. Example:
   "Implementing the analytics tracking backend". It is shown only when the user hovers
   the agent, and it accumulates as the activity log behind the clock button.

## 📢 THE RULE

**🚦 FIRST ACTION in a new conversation:** set the GENERAL title from the first user
request. On later turns, do NOT call \`set_terminal_title\`; update activity instead.

**📍 ALWAYS leave a CURRENT SUMMARY before acting.** Right after the title, call
\`update_terminal_activity\` with your first product-focused step, BEFORE running any other
tool. If an agent has no activity yet, set one before you do anything else — so at every
moment the user can see what each agent is doing. Never start working with no activity set.

**First request → set the title ONCE. Every turn → update the ACTIVITY.**

- ✅ Keep the title from the first user request. Refining, extending, fixing, reviewing,
  validating, or finishing that request changes the activity, not the title.
- ✅ RADICAL topic change → NEW general title, MANDATORY. When the user switches this
  agent to a completely different topic (e.g. from "Minimize Agents" to preparing
  a release), call \`set_terminal_title\` again with \`replace_existing=true\`. Updating only the
  activity and leaving the old title is WRONG: the tab would keep describing work that
  is no longer happening.
- ✅ Update the activity every time your focus moves to a new step. This is what the user
  sees on hover, and it never thrashes the tab.
- ❌ Do NOT keep changing the general title every few minutes. A title that jumps from
  "Promo Video" to "Editing WordPress" to "Rendering" is exactly what we are fixing.

**🌍 LANGUAGE:** Write the general title, the GOAL and the activity in the SAME language the
user is speaking (Spanish if the user writes in Spanish, English if English, etc.). Only
the app's own static UI stays in English; these agent-written labels follow the user.

**🔧 THE TWO TOOLS:**
\`\`\`
# 1) ONCE on the conversation's first request - the sticky tab title
mcp__codeagentswarm-tasks__set_terminal_title(
    title="Promo Video",
    long_title="Promotional video for the Twitter launch"
)

# 2) OFTEN as you work - the current product-focused step (hover + activity log)
mcp__codeagentswarm-tasks__update_terminal_activity(
    activity="Recording the app screen capture"
)
mcp__codeagentswarm-tasks__update_terminal_activity(
    activity="Editing the WordPress landing embed"
)
\`\`\`

**📝 HOW EACH ONE WORKS:**
- **\`set_terminal_title(title, long_title)\`**: TWO arguments, both shown to the user, and
  you must ALWAYS pass both. \`title\` is a short (max 6 words), PRODUCT-level label shown
  in the tab. \`long_title\` is the **GOAL**: one sentence on what this agent is FOR — the
  outcome the work aims at, not the step you are on. The user reads it in the hover under
  the title, labelled GOAL, and it is the ONLY place that answers "why does this agent
  exist"; six words cannot carry that. Repeated calls preserve the first title. Pass
  \`replace_existing=true\` only after the user pivots to completely different functionality.
  \`\`\`
  ✅ title="Orden notificación"
     long_title="Que las notificaciones no salgan antes de que cambie el status del agente"
  ✅ title="Minimize Agents"
     long_title="Add the ability to minimize agents and restore them later"
  ❌ long_title="Orden notificación"        ← only repeats the title: DISCARDED, no goal shown
  ❌ long_title="Working on: Promo Video"   ← filler: DISCARDED, no goal shown
  ❌ long_title omitted                     ← the app invents filler and shows NO goal
  \`\`\`
- **\`update_terminal_activity(activity)\`**: one short sentence about what you are doing now,
  framed at the PRODUCT / feature level (what it achieves for the user), NOT in technical or
  internal terms. Avoid jargon like handler, function, class, module, hook, refactor. Bad:
  "Investigating the cost of the output handler per agent" or "Editing renderer.js". Good:
  "Investigating why agents feel slow" or "Implementing the export button". Call it often.
  It does NOT change the tab.

## 🎯 WORKFLOW

### ✅ ON THE CONVERSATION'S FIRST REQUEST:
\`\`\`
1. set_terminal_title(                    ← once per conversation
     title="Minimize Agents",
     long_title="Add the ability to minimize and restore agents"
   )
2. update_terminal_activity(activity="Adding the minimize button to the header")
3. ...keep calling update_terminal_activity as your focus moves to new steps...
\`\`\`

### ✅ SAME GOAL, NEW STEP → update the ACTIVITY (not the title):
\`\`\`
# The general title stays "Minimize Agents"
update_terminal_activity(activity="Implementing restore-from-minimized")
update_terminal_activity(activity="Persisting minimized state across restarts")
\`\`\`

### ✅ THE ORIGINAL GOAL EXPANDS → keep the title and update ACTIVITY:
\`\`\`
# The user expanded the same feature; the first title remains "Minimize Agents":
update_terminal_activity(activity="Adding restore from the tray")
\`\`\`

### ✅ RADICAL TOPIC CHANGE → set a NEW general title (mandatory):
\`\`\`
# The agent was doing "Minimize Agents" and the user pivots completely:
User: "leave that, now let's prepare the release notes"
set_terminal_title(
  title="Release Notes",
  long_title="Preparing the release notes for the next version",
  replace_existing=true
)
update_terminal_activity(activity="Drafting the release notes")
# ❌ WRONG: calling only update_terminal_activity here — the tab would still
# read "Minimize Agents" while the agent works on something else.
\`\`\`

## ⚠️ WHEN TO USE WHICH

- **General title (set_terminal_title):** once per conversation from the first request.
  Replace only after a radical functionality pivot, with \`replace_existing=true\`.
- **Current activity (update_terminal_activity):** every time you move to a new product
  step. Call it freely - it never disturbs the tab.

### 🏁 When FINISHING a piece of work:
- Send a final \`update_terminal_activity\` summarizing what was accomplished
  (e.g. "Finished minimize/restore for agents").
- You normally do NOT need to change the general title at the end - it already
  describes the goal.

## 🎯 WHY THIS MATTERS

1. **Clarity:** the tab gives a stable, at-a-glance answer to "what is this agent for?"
2. **No thrash:** the title stops jumping every few minutes, so it is easy to follow.
3. **Detail on demand:** the current step is one hover away, and the full log is behind the
   clock button, without cluttering the tab.

## 📋 CORRECT EXAMPLES

**Example 1 - Feature work:**
\`\`\`
User: "I want an option to minimize agents"
Agent:
  ✅ set_terminal_title(title="Minimize Agents",
       long_title="Add the ability to minimize and restore agents")   ← ONCE
  ✅ update_terminal_activity(activity="Adding the minimize button to the header")
  ✅ update_terminal_activity(activity="Wiring the minimize action in the renderer")

User: "also let me reopen the minimized ones"
Agent:
  ✅ update_terminal_activity(activity="Implementing restore for minimized agents")
     ← same general title, just a new activity
\`\`\`

**Example 2 - Promo video (the title stays put):**
\`\`\`
User: "let's make a promo video for Twitter"
Agent:
  ✅ set_terminal_title(title="Promo Video",
       long_title="Promotional video for the Twitter launch")            ← ONCE
  ✅ update_terminal_activity(activity="Recording the app screen capture")
  ✅ update_terminal_activity(activity="Editing the WordPress landing embed")
  ✅ update_terminal_activity(activity="Adding captions and music")
# The tab still reads "Promo Video" the whole time.
\`\`\`

**Example 3 - Research:**
\`\`\`
User: "how does routing work?"
Agent:
  ✅ set_terminal_title(title="Analyze Routing",
       long_title="Understanding the routing and middleware setup")
  ✅ update_terminal_activity(activity="Reading the Express route definitions")
  ✅ Answer...
\`\`\`

## ❌ INCORRECT

**Bad 1 - Changing the general title for every step (the old anti-pattern):**
\`\`\`
set_terminal_title(title="Promo Video")
set_terminal_title(title="Editing WordPress")   ← ❌ this is a STEP, use update_terminal_activity
set_terminal_title(title="Rendering")           ← ❌ the tab now jumps around
\`\`\`

**Bad 2 - Technical/file-level activity instead of product-level:**
\`\`\`
update_terminal_activity(activity="Editing renderer.js line 200")             ← ❌ file term
update_terminal_activity(activity="Investigating the output handler cost")    ← ❌ internal jargon
✅ update_terminal_activity(activity="Implementing the minimize button")
✅ update_terminal_activity(activity="Investigating why agents feel slow")
\`\`\`

**Bad 3 - Never setting a general title:**
\`\`\`
# Only calling update_terminal_activity, so the tab never gets a product label.
✅ Set the title ONCE from the first user request so the tab is meaningful.
\`\`\`

**Bad 4 - Radical topic change but the title never changes:**
\`\`\`
# Title: "Promo Video". The user then says: "now let's debug the login crash"
update_terminal_activity(activity="Debugging the login crash")   ← ❌ tab still says "Promo Video"
✅ set_terminal_title(title="Login Crash", long_title="Debugging the crash when logging in", replace_existing=true)
✅ update_terminal_activity(activity="Reproducing the login crash")
\`\`\`

**Bad 5 - Title names a work PHASE instead of the feature:**
\`\`\`
# Working on the settings redesign, now validating it with the e2e suite:
set_terminal_title(title="Settings E2E Tests")   ← ❌ testing is a STEP of the redesign
✅ set_terminal_title(title="Settings Redesign")  ← the feature stays the title
✅ update_terminal_activity(activity="Running the e2e suite for the settings redesign")
# Same for "Reviewing X", "Deploying X", "Validating X" — phases are ACTIVITIES, not titles.
\`\`\`

## 🚨 FINAL REMINDER

- Set the **general title AND GOAL once per conversation**, from the first user request.
  Follow-ups never retitle; a radical functionality pivot uses \`replace_existing=true\`.
- Keep the **current activity** flowing with \`update_terminal_activity\` (product-level),
  one short sentence per step.
- The tab should stay stable; the hover + clock-button log carry the detail.
- Do NOT create or manage tasks — automatic task management is disabled.

**MEMORIZE:**
1. **First request → \`set_terminal_title(title, long_title)\` once**
2. **New step → \`update_terminal_activity\` (product step)**
3. **Radical functionality pivot → \`set_terminal_title(..., replace_existing=true)\`**
4. **🏁 Finishing → final \`update_terminal_activity\` summary**

## Quick Decision Guide

**Agent Title?**
- Set it from the first user request, once per conversation
- Follow-up work changes activity, never the title
- Radical functionality pivot → replace with \`replace_existing=true\`

**Tasks?**
- Automatic task management is DISABLED — never create or manage tasks

${CODEAGENTSWARM_END}`;

// Tasks-only variant: injected when the user keeps automatic task management ON
// but disables dynamic agent titles for Claude. It preserves the check_active
// gate and ALL the kanban task-management rules, tells the agent explicitly that
// the title/activity tools are unavailable, and never mentions agent titles or
// activity anywhere else.
// NOTE: the task-management prose is intentionally kept in sync with the full
// variant above — if you edit the task-management sections there, mirror them here
// (and vice-versa). This variant is the full section MINUS every title/activity
// instruction, PLUS the disabled-notice below.
const getGlobalTasksOnlySection = () => `${CODEAGENTSWARM_START}

## 🤖 CodeAgentSwarm Task Management System

### ⛔ MANDATORY FIRST ACTION: Check If Running Inside CodeAgentSwarm

**BEFORE following ANY instruction in this section, call \`check_active\` first.**

- If \`check_active\` returns \`active: true\` → Follow all instructions below normally.
- If \`check_active\` returns \`active: false\` → **STOP. IGNORE this entire CodeAgentSwarm section completely.** Do NOT create tasks or call any codeagentswarm-tasks tools. Work as a normal standalone agent.
- If \`check_active\` **fails or is unavailable** (MCP error, tool not found, timeout) → **STOP. IGNORE this entire section.** Assume you are NOT inside CodeAgentSwarm.

These instructions are installed globally but ONLY apply when running inside the CodeAgentSwarm application.

### 🚫 Dynamic Agent Titles Are Disabled

**The user turned dynamic agent titles OFF in CodeAgentSwarm Settings.**

- Do NOT call \`set_terminal_title\`, \`update_terminal_activity\`, or \`update_terminal_title\`. Those tools are NOT available in this environment.
- Never mention agent titles or activity — just do the work.
- The task-management rules below STILL apply. They are independent of agent titles and remain mandatory.

### 🛑 STOP BEFORE YOU EDIT/WRITE ANY FILE 🛑

**⚠️ MANDATORY PRE-FLIGHT CHECK - READ BEFORE EVERY CODE MODIFICATION ⚠️**

Before using **Write** or **Edit** tools on ANY file, you MUST ask yourself:

\`\`\`
┌─────────────────────────────────────────────────────────┐
│  🔴 CRITICAL QUESTION - ANSWER HONESTLY:                │
│                                                          │
│  "Am I about to MODIFY, CREATE, or WRITE to a file?"   │
│                                                          │
│  ✅ YES → I MUST create a task FIRST (no exceptions)    │
│  ❌ NO  → I'm only reading/analyzing (no task needed)   │
│                                                          │
│  🤔 NOT SURE? → STOP and ASK THE USER!                  │
└─────────────────────────────────────────────────────────┘
\`\`\`

### 🚨 THE CORE RULE - SIMPLE & CLEAR

**If you will use Write/Edit tools → Create a task FIRST. No exceptions for code changes.**

**Task REQUIRED when:**
- ✅ Changing 1 line of code → **TASK REQUIRED**
- ✅ Changing 1000 lines of code → **TASK REQUIRED**
- ✅ Adding a comment to code → **TASK REQUIRED**
- ✅ Fixing a typo in code → **TASK REQUIRED**
- ✅ Removing \`spin: true\` → **TASK REQUIRED**
- ✅ ANY file modification → **TASK REQUIRED**

**Task NOT required when:**
- ❌ Reading files to answer questions
- ❌ Analyzing code structure
- ❌ Searching/grepping for information
- ❌ Reviewing code without changes
- ❌ Quick consultations ("check X thing")

**There is NO "too trivial" or "too small" exception for code modifications.**

### ⚠️ WHEN IN DOUBT → ASK THE USER

If you're thinking ANY of these:
- "This is just a quick fix..."
- "It's only one line..."
- "This is too small for a task..."
- "Should I create a task for this?"

**STOP IMMEDIATELY and ask the user:**
- "Should I create a task for this change?"
- "This modifies code - should I track it as a task?"

**Never assume. Always ask when uncertain.**

### 🔍 Common Mistakes That Are FORBIDDEN

❌ **"It's just removing one property, I'll skip the task"**
✅ **WRONG.** Creating task is MANDATORY regardless of size.

❌ **"I already made the change, I'll create the task after"**
✅ **WRONG.** Task MUST be created BEFORE any Write/Edit.

❌ **"The user asked for a quick fix, no time for tasks"**
✅ **WRONG.** Task system adds <10 seconds. Always required.

❌ **"I'm just fixing a typo, surely that doesn't need a task"**
✅ **WRONG.** If it modifies a file, it needs a task. No exceptions.

### ✅ CORRECT WORKFLOW - MEMORIZE THIS ORDER

\`\`\`
1. User requests code change
2. 🛑 STOP - About to modify files?
3. ✅ YES → MANDATORY SEQUENCE:
   a) find_related_active_tasks
   b) create_task (if no match found)
   c) start_task
   d) update_task_plan
   e) NOW you can use Write/Edit tools
   f) update_task_implementation
   g) complete_task
\`\`\`

**NEVER SKIP STEPS 3a-3d. NEVER.**

### 🎯 Task Creation Guidelines - Simple & Clear

**✅ ALWAYS CREATE A TASK when you will:**
- Write or modify ANY code file (.js, .jsx, .ts, .py, .css, .html, etc.)
- Create or edit configuration files that change behavior
- Write, modify, or fix tests
- Make database schema or migration changes
- Implement features, fix bugs, or refactor code
- Add or modify documentation as part of implementation

**❌ NEVER CREATE A TASK for:**
- Reading/analyzing code without modifications
- Git operations (commit, push, pull, status, branch, merge)
- Installing dependencies (npm install, pip install)
- Starting/stopping servers (npm start, npm test, npm run dev)
- Answering questions or explaining how code works
- Running database queries for investigation only (SELECT)
- Using gh commands (pr create, release, etc.)

**🎯 Simple Rule:**
- **CHANGING files = Task**
- **READING files = No task**
- **When in doubt** → If you'll use Write or Edit tools = Create task

### 📋 Mandatory Task System Workflow

**When starting work:**

1. **Check for existing tasks** using \`find_related_active_tasks\`
   - Similarity >70% → Use existing task automatically
   - Similarity 50-70% → Ask user
   - Similarity <50% → Create new task

2. **Create task if needed** using \`create_task\`
   - Terminal ID: AUTO-DETECTED from \`CODEAGENTSWARM_CURRENT_QUADRANT\`
   - Project: AUTO-DETECTED from CLAUDE.md "Project Name:" field

3. **Start the task** using \`start_task\` before any work
   - **🔄 CRITICAL:** \`start_task\` ALWAYS moves tasks to \`in_progress\` status
   - Works for ANY status: \`pending\`, \`in_testing\`, OR \`completed\`
   - **Resuming work?** Just call \`start_task\` - it automatically returns task to \`in_progress\`
   - **No exceptions:** Always use \`start_task\` when beginning work, regardless of current status

4. **Update the plan** using \`update_task_plan\` with detailed steps

5. **Testing Flow** - \`complete_task\` ONCE → \`in_testing\` (NEVER directly to \`completed\`)

### 📝 Task Plan Management

**Each task MUST have a detailed plan:**

1. Use \`update_task_plan\` with numbered steps including:
   - Files to modify/create
   - Dependencies/prerequisites
   - Success criteria

2. Before completion, MANDATORY:
   - Verify all plan points completed
   - Document using \`update_task_implementation\`
   - Include: modified files, summary, functionality

3. If plan incomplete:
   - Continue working OR
   - Update plan and create new task for pending

### 🧪 Testing Flow - NEVER Direct to Completed

**All tasks MUST go through testing:**

\`\`\`
pending → in_progress → in_testing → [USER APPROVAL] → completed
\`\`\`

1. **First \`complete_task\`** → Moves to \`in_testing\`
2. **STOP and WAIT** for user approval
3. **User says "mark as completed"** → Second \`complete_task\`
4. **NEVER** auto-complete from testing

### 🤔 Task Continuation Decision

**When user provides new instructions:**

1. **Analyze if related to current task**
2. **If related:** Continue with same task
3. **If unrelated:** Ask about new task creation
4. **If clarification:** Answer without new task

**🎯 IMPORTANT: Fixing Issues During Development**
- **When something doesn't work during task development** (tests fail, feature broken, etc.):
  - ✅ **CONTINUE with the SAME TASK** - Don't create a new one
  - ✅ Fix the issues as part of the current development cycle
  - ✅ Update the task plan if needed to reflect additional work
  - ❌ **DON'T** create a new task for "fixing" what you just built
  - **Example:** Working on "Add pagination" task → pagination doesn't work → FIX IT in the same task
  - **Rationale:** Issues found during development are part of the development process

### 💪 Task Scope & Completion Standards

**When working on a task, complete it FULLY before finishing:**

**✅ COMPLETE in the SAME task:**
- The main requested feature or bug fix
- ALL bugs discovered while implementing
- Tests for the new functionality
- Error handling and edge cases
- Code cleanup needed for the change
- Running tests and fixing any failures
- Basic documentation if feature is self-contained

**❌ DON'T stop prematurely:**
- Don't mark complete if tests fail - fix them first
- Don't stop at "partial implementation" - finish the feature
- Don't leave broken functionality - make it work completely
- Don't create separate tasks for test failures you caused

**🎯 Example - "Add user login" request:**

**✅ Good (ONE complete task):**
1. Create login form
2. Add backend endpoint
3. Discover validation bug → Fix it immediately
4. Add authentication logic
5. Add error messages
6. Write tests
7. Tests fail → Debug and fix
8. Verify everything works
9. Mark as complete

**❌ Bad (fragmenting work):**
- Task 1: "Create form" → Complete
- Task 2: "Add backend" → Complete
- Task 3: "Fix validation bug" → Complete
- Task 4: "Add tests" → Complete
- Task 5: "Fix test failures" → Complete

**💡 Key principle:** One logical feature = One complete task (including all fixes needed to make it work)

### 🚧 Scope Boundaries - When to STOP and Create New Task

**⛔ STOP current task and create NEW when:**

1. **User explicitly requests something different**
   - "Now add X feature"
   - "Also implement Y"
   - "While you're at it, do Z"

2. **You finished the original request and want to improve/add more**
   - "This works, but I could also add..."
   - "While I'm here, I should improve..."
   - "This would be a good time to refactor..."

3. **The work is a separate feature**, even if related
   - Original: "Fix login bug"
   - Extra: "Add password reset" ← NEW TASK

4. **Switching from implementation to enhancements**
   - Original: "Implement sprites"
   - Extra: "Balance gameplay" ← NEW TASK

**🚨 RED FLAGS (mean you need NEW TASK):**
- Thinking "While I'm at it..."
- Thinking "This would be good to add..."
- Working on the task for >30 minutes on unrelated improvements
- User requests something while you're working

**✅ CONTINUE same task when:**
- Fixing bugs that prevent YOUR feature from working
- Adding missing pieces YOUR feature needs to work
- Within the original request scope
- User is clarifying/adjusting the current request

**📋 Real Example Analysis:**

\`\`\`
❌ BAD - One task with scope creep:
06:00 - Implement ninja sprites ✅ (original)
06:11 - Fix sprite bugs ✅ (needed for sprites)
06:12 - Add Peasant character ❌ (NEW FEATURE → should be new task)
06:15 - Add Samurai character ❌ (NEW FEATURE → should be new task)
06:18 - Improve arrows ❌ (ENHANCEMENT → should be new task)
06:20 - Adjust speeds ❌ (BALANCING → should be new task)
06:22 - Improve enemies ❌ (ENHANCEMENT → should be new task)

✅ GOOD - Proper task separation:
Task 1: "Implement ninja sprites" (06:00-06:11)
  - Implement sprites
  - Fix animation bugs

Task 2: "Add character variants" (06:12-06:15)
  - Add Peasant with attack
  - Add Samurai Archer

Task 3: "Balance gameplay mechanics" (06:18-06:22)
  - Improve arrow visuals
  - Adjust movement/projectile speeds
  - Enhance enemy behavior
\`\`\`

### 🔄 Reopen vs New Task Rules

**Continue with current task when:**
- **🚨 Issues found DURING development** (tests fail, feature broken)
- **🚨 Something doesn't work while implementing**
- Fixing bugs in the code you JUST wrote
- Adjusting implementation during active development
- Tests need fixing for current feature

**Reopen existing task when:**
- Continuing same feature/bug <24h old
- Bug in just-completed work (task already in testing/completed)
- Direct adjustments to recent work

**Create new task when:**
- Different feature/scope
- >24h since last related work
- User explicitly requests new task
- Bug in OLD code (not related to current development)

### Available MCP Task Tools

**Core:**
- \`create_task\` - Auto-detects agent/project
- \`start_task\` - Mark in_progress
- \`complete_task\` - First: testing, Second: completed
- \`update_task_plan\` - Detailed steps
- \`update_task_implementation\` - Document changes

**Search & Management:**
- \`find_related_active_tasks\` - Find similar (>70% auto-use)
- \`search_tasks\` - Keyword search
- \`list_tasks(limit, offset)\` - With pagination
- \`update_task_terminal\` - Change assignment
- \`update_task_project\` - Change task project

**Subtasks & Projects:**
- \`create_subtask\` - Under parent task
- \`suggest_parent_tasks\` - AI suggestions
- \`get_task_hierarchy\` - Full tree
- \`create_project\` - With color
- \`get_project_tasks\` - By project

### 🔗 Subtask System

**Use subtasks when:**
- Breaking complex tasks into pieces
- Adding to existing tasks (even completed)
- Fixing bugs in completed features
- Grouping related work

**Features:**
- Auto-inherit project from parent
- AI-powered parent suggestions
- Can create under completed parents
- Nested hierarchy support

### 📊 Project Organization

Tasks auto-organize by project:
1. Read CLAUDE.md "Project Name:" field
2. Fallback to directory name
3. Unique color per project
4. Filter with \`get_project_tasks\`

### Pagination Best Practices

Avoid token limits:
- Use status filters: \`list_tasks(status="pending", limit=10)\`
- Start small: \`limit=10\` or \`limit=20\`
- Paginate: \`list_tasks(limit=20, offset=20)\`

## 📚 Documentation

**Documentation guidelines:**
- Create appropriate markdown files for documentation
- Update after: features, architecture, DB changes, bugs

## Quick Decision Guide

**Need a Task?**
- Modifying code? → YES
- Just reading? → NO
- Running commands? → NO
- Creating new? → YES

**Task Continuation?**
- Same work <24h → Continue
- Different scope → New task
- Unsure → Ask user

${CODEAGENTSWARM_END}`;

// Public entry point: returns the CLAUDE.md section for the requested mode.
//   includeTaskManagement + includeTitles → full variant
//   titles only (no task management)      → titles-only variant
//   task management only (no titles)      → tasks-only variant
//   neither                               → '' (callers use variant 'none' to
//     remove the section instead of requesting this; returned defensively).
const getGlobalCodeAgentSwarmSection = (options = {}) => {
  const { includeTaskManagement = true, includeTitles = true, includeStatus = true } = options;
  // The status rules live ONLY in the full variant today; Claude's titles-only /
  // tasks-only variants carry no status content, so includeStatus only affects full.
  if (includeTaskManagement && includeTitles) return getGlobalTaskManagementSection({ includeStatus });
  if (!includeTaskManagement && includeTitles) return getGlobalTitlesOnlySection();
  if (includeTaskManagement && !includeTitles) return getGlobalTasksOnlySection();
  return '';
};

// Project-specific minimal configuration
const getProjectClaudeMdSection = (projectName) => `<!-- CODEAGENTSWARM PROJECT CONFIG START - DO NOT EDIT -->

## Project Configuration

**Project Name**: ${projectName}

_This project name is used for task organization in CodeAgentSwarm. All tasks created in this directory will be associated with this project._

_For complete CodeAgentSwarm instructions, see the global CLAUDE.md file at ~/.claude/CLAUDE.md_

<!-- CODEAGENTSWARM PROJECT CONFIG END -->`;

// Unified regex pattern for extracting project name from CLAUDE.md
// Matches: **Project Name**: <name>
const extractProjectNameFromClaudeMd = (content) => {
  if (!content) return null;

  // Match **Project Name**: followed by the name (trimmed)
  // This handles various whitespace scenarios
  const match = content.match(/\*\*Project Name\*\*:\s*(.+?)(?=\r?\n|$)/);

  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
};

// Resolve the project name for a given directory.
// Searches the directory's agent instruction files in priority order
// (CLAUDE.md → GEMINI.md → AGENTS.md) for a **Project Name**: <name> line.
// Falls back to path.basename(directory) when no instruction file yields a name,
// or when reading any of them fails.
// Always returns a string; never null.
const AGENT_INSTRUCTION_FILES = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'];

const getProjectNameForDirectory = (directory) => {
  for (const fileName of AGENT_INSTRUCTION_FILES) {
    try {
      const filePath = path.join(directory, fileName);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const name = extractProjectNameFromClaudeMd(content);
        if (name) return name;
      }
    } catch (error) {
      // Read failure on this file — try the next one, then basename.
    }
  }
  return path.basename(directory);
};

module.exports = {
  CODEAGENTSWARM_START,
  CODEAGENTSWARM_END,
  getGlobalCodeAgentSwarmSection,
  getProjectClaudeMdSection,
  extractProjectNameFromClaudeMd,
  getProjectNameForDirectory
};
