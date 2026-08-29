/**
 * Todo-list parser.
 *
 * Every coding agent has a checklist tool, and every one of them ships it in a
 * different envelope: Claude's `TodoWrite` nests `{todos: [{content, status}]}`
 * under the tool input, Codex's `update_plan` uses `{plan: [{step, status}]}`,
 * ACP agents (Grok, Kimi, opencode) push `{entries: [{content, status}]}` in a
 * `plan` session update, and print-mode agents bury it inside free-form tool
 * parameters.
 *
 * This module collapses all of them into one shape:
 *
 *     [{ step: string, status: 'pending'|'in_progress'|'completed' }]
 *
 * It is deliberately permissive and total: it walks a bounded set of known
 * container keys, accepts the many spellings each provider uses for the step
 * text and the step status, and returns `[]` for anything it does not
 * recognize. Being shape-driven rather than provider-driven means an agent we
 * have never seen still renders its checklist as long as it sends *some* array
 * of steps.
 *
 * Pure and dependency-free: it is required by the main-process drivers *and*
 * bundled into the renderer's chat panel.
 */

/** Canonical statuses, in display order. */
const TODO_STATUSES = Object.freeze(['pending', 'in_progress', 'completed']);

/** Keys whose value may hold the array of steps, most specific first. */
const LIST_KEYS = Object.freeze([
  'entries',
  'todos',
  'todo_list',
  'todoList',
  'plan',
  'steps',
  'items',
  'tasks',
  'checklist'
]);

/** Keys that may wrap the container holding the list, searched in order. */
const CONTAINER_KEYS = Object.freeze([
  'input',
  'arguments',
  'args',
  'parameters',
  'params',
  'data',
  'toolInfo',
  'tool_info',
  'output',
  'result'
]);

/** Keys that may hold one step's text, most specific first. */
const STEP_TEXT_KEYS = Object.freeze([
  'step',
  'subject',
  'content',
  'text',
  'title',
  'task',
  'label',
  'name',
  'description',
  'activeForm'
]);

/** Keys that may hold one step's status. */
const STATUS_KEYS = Object.freeze(['status', 'state']);

/** Keys whose boolean value means "this step is done". */
const DONE_FLAG_KEYS = Object.freeze(['completed', 'done', 'checked', 'finished']);

/** Provider status spelling -> canonical status. */
const STATUS_ALIASES = Object.freeze({
  pending: 'pending',
  todo: 'pending',
  not_started: 'pending',
  notstarted: 'pending',
  queued: 'pending',
  open: 'pending',
  waiting: 'pending',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  'in-progress': 'in_progress',
  active: 'in_progress',
  running: 'in_progress',
  current: 'in_progress',
  started: 'in_progress',
  doing: 'in_progress',
  working: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  finished: 'completed',
  success: 'completed',
  succeeded: 'completed'
});

/** How deep the container walk may recurse before giving up. */
const MAX_DEPTH = 4;

/** Hard cap on rendered steps, so a runaway agent cannot freeze the panel. */
const MAX_STEPS = 200;

/**
 * Extract a normalized checklist from any provider payload.
 *
 * @param {*} source A canonical item payload, its `data`, a tool input, or the
 *   raw array of steps itself.
 * @returns {Array<{step: string, status: string}>} Empty when `source` holds no
 *   recognizable checklist.
 */
function parseTodoEntries(source) {
  const list = findStepList(source, 0);
  if (!list) return [];

  const entries = [];
  for (const raw of list) {
    const entry = normalizeEntry(raw);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_STEPS) break;
  }
  return entries;
}

/**
 * Summarize a checklist for the collapsed header.
 *
 * @param {Array<{step: string, status: string}>} entries
 * @returns {{total: number, completed: number, inProgress: number, pending: number, current: string}}
 */
function summarizeTodoEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const completed = list.filter((entry) => entry.status === 'completed').length;
  const inProgress = list.filter((entry) => entry.status === 'in_progress').length;
  const active = list.find((entry) => entry.status === 'in_progress')
    || list.find((entry) => entry.status === 'pending');
  return {
    total: list.length,
    completed,
    inProgress,
    pending: list.length - completed - inProgress,
    current: active ? active.step : ''
  };
}

/**
 * Depth-first walk for the first array that actually looks like a checklist.
 * @param {*} source
 * @param {number} depth
 * @returns {Array<*>|null}
 */
function findStepList(source, depth) {
  if (Array.isArray(source)) return looksLikeStepList(source) ? source : null;
  if (!source || typeof source !== 'object' || depth >= MAX_DEPTH) return null;

  for (const key of LIST_KEYS) {
    const value = source[key];
    if (Array.isArray(value) && looksLikeStepList(value)) return value;
  }
  for (const key of CONTAINER_KEYS) {
    const nested = findStepList(source[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * An array qualifies when at least one member yields a step.
 *
 * The check keeps plain string arrays (`['step one', 'step two']`) while
 * rejecting the unrelated arrays that share these key names, such as a
 * `content` array of message blocks or a `steps` array of numbers.
 *
 * @param {Array<*>} value
 * @returns {boolean}
 */
function looksLikeStepList(value) {
  return value.length > 0 && value.some((item) => normalizeEntry(item) !== null);
}

/**
 * @param {*} raw One member of a candidate step list.
 * @returns {{step: string, status: string}|null} Null when it carries no text.
 */
function normalizeEntry(raw) {
  if (typeof raw === 'string') {
    const step = raw.trim();
    return step ? { step, status: 'pending' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const step = firstText(raw, STEP_TEXT_KEYS);
  if (!step) return null;
  return { step, status: normalizeStatus(raw) };
}

/**
 * @param {Object} source
 * @param {ReadonlyArray<string>} keys
 * @returns {string} `''` when no key holds usable text.
 */
function firstText(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * @param {Object} raw One step object.
 * @returns {string} A canonical status, defaulting to `'pending'`.
 */
function normalizeStatus(raw) {
  const label = firstText(raw, STATUS_KEYS).toLowerCase().replace(/\s+/g, '_');
  if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, label)) {
    return STATUS_ALIASES[label];
  }
  for (const key of DONE_FLAG_KEYS) {
    if (raw[key] === true) return 'completed';
  }
  return 'pending';
}

module.exports = {
  MAX_STEPS,
  TODO_STATUSES,
  parseTodoEntries,
  summarizeTodoEntries
};
