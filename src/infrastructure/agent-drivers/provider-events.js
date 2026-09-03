/**
 * Canonical, agent-agnostic event vocabulary shared by every agent driver.
 *
 * Drivers (Codex today, Claude/OpenCode/Antigravity/Kimi later) translate their
 * native protocol into these events so the rest of the app never has to know
 * which agent produced a message.
 *
 * Shared event vocabulary emitted by every provider driver.
 */

const crypto = require('crypto');
const { normalizeProviderErrorEvent } = require('../../shared/provider-error-presentation');

/**
 * Every canonical event type a driver may emit.
 * @type {ReadonlyArray<string>}
 */
const PROVIDER_EVENT_TYPES = Object.freeze([
  'session.state.changed',
  'session.config.updated',
  'session.commands.updated',
  'session.exited',
  'thread.started',
  'thread.token-usage.updated',
  'turn.started',
  'turn.completed',
  'turn.diff.updated',
  'item.started',
  'item.updated',
  'item.completed',
  'content.delta',
  'request.opened',
  'request.resolved',
  'question.opened',
  'question.resolved',
  'account.rate-limits.updated',
  'runtime.warning',
  'runtime.error'
]);

/**
 * Kinds of incremental text streams carried by `content.delta`.
 * @type {ReadonlyArray<string>}
 */
const CONTENT_STREAM_KINDS = Object.freeze([
  'assistant_text',
  'reasoning_text',
  'reasoning_summary_text',
  'plan_text',
  'command_output',
  'file_change_output',
  'unknown'
]);

/**
 * Canonical timeline item types, agent-independent.
 * @type {ReadonlyArray<string>}
 */
const CANONICAL_ITEM_TYPES = Object.freeze([
  'user_message',
  'assistant_message',
  'reasoning',
  'plan',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'dynamic_tool_call',
  'collab_agent_tool_call',
  'web_search',
  'image_view',
  'review_entered',
  'review_exited',
  'context_compaction',
  'error',
  'unknown'
]);

/**
 * Lifecycle status of a timeline item.
 * @type {ReadonlyArray<string>}
 */
const ITEM_STATUSES = Object.freeze(['inProgress', 'completed', 'failed', 'declined']);

/**
 * Terminal states of a turn.
 * @type {ReadonlyArray<string>}
 */
const TURN_STATES = Object.freeze(['completed', 'failed', 'interrupted', 'cancelled']);

/**
 * Kinds of user-facing requests an agent can open (approvals, questions...).
 * @type {ReadonlyArray<string>}
 */
const REQUEST_TYPES = Object.freeze([
  'command_execution_approval',
  'file_read_approval',
  'file_change_approval',
  'apply_patch_approval',
  'exec_command_approval',
  'tool_user_input',
  'unknown'
]);

/**
 * Execution context for a canonical event. Unknown is fail-open in the
 * renderer so old transcripts and providers without child metadata remain
 * visible as normal main-agent work.
 * @type {ReadonlyArray<string>}
 */
const EXECUTION_ORIGINS = Object.freeze(['main', 'subagent', 'unknown']);

const PROVIDER_EVENT_TYPE_SET = new Set(PROVIDER_EVENT_TYPES);

/**
 * @typedef {Object} ProviderEventRaw
 * @property {string} source Where the event came from, e.g. 'codex.app-server.notification'.
 * @property {string} method Native method name.
 * @property {Object} [payload] Native params, untouched.
 */

/**
 * The envelope every canonical event uses.
 * @typedef {Object} ProviderEvent
 * @property {string} eventId UUID assigned by {@link createProviderEvent}.
 * @property {string} provider Provider id, e.g. 'codex'.
 * @property {string} type One of {@link PROVIDER_EVENT_TYPES}.
 * @property {string} [threadId] Conversation/thread the event belongs to.
 * @property {string} [turnId] Turn the event belongs to.
 * @property {string} [itemId] Timeline item the event belongs to.
 * @property {string} [requestId] User-facing request the event belongs to.
 * @property {'main'|'subagent'|'unknown'} executionOrigin Execution context
 *   that produced the event.
 * @property {string|null} createdAt ISO timestamp assigned by {@link createProviderEvent},
 *   or null when restored provider history has no original time.
 * @property {Object} payload Type-specific payload, see the payload typedefs.
 * @property {ProviderEventRaw} [raw] Passthrough of the native notification.
 */

/**
 * @typedef {Object} SessionStateChangedPayload
 * @property {'starting'|'ready'|'running'|'stopped'|'error'} state
 * @property {string} [reason]
 */

/**
 * Live provider configuration learned after the session handshake. Providers
 * may publish this after `startSession` has already returned, so renderers must
 * treat it as newer than persisted launch metadata.
 * @typedef {Object} SessionConfigUpdatedPayload
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [permissionMode]
 * @property {string} [interactionMode]
 */

/**
 * @typedef {Object} SessionExitedPayload
 * @property {string} [reason]
 * @property {'graceful'|'error'} exitKind
 * @property {number} [exitCode]
 */

/**
 * @typedef {Object} ThreadStartedPayload
 * @property {string} providerThreadId
 */

/**
 * @typedef {Object} TokenUsage
 * @property {number} usedTokens
 * @property {number} [totalProcessedTokens]
 * @property {number} [maxTokens]
 * @property {number} [inputTokens]
 * @property {number} [cachedInputTokens]
 * @property {number} [outputTokens]
 * @property {number} [reasoningOutputTokens]
 */

/**
 * @typedef {Object} ThreadTokenUsageUpdatedPayload
 * @property {TokenUsage} usage
 */

/**
 * `turn.started` carries no payload fields; the turn id lives in the envelope.
 * @typedef {Object} TurnStartedPayload
 */

/**
 * @typedef {Object} TurnCompletedPayload
 * @property {'completed'|'failed'|'interrupted'|'cancelled'} state
 * @property {string} [errorMessage]
 * @property {string|number|Object} [errorCode]
 */

/**
 * @typedef {Object} TurnDiffUpdatedPayload
 * @property {string} unifiedDiff
 */

/**
 * Shared payload of `item.started`, `item.updated` and `item.completed`.
 * @typedef {Object} ItemPayload
 * @property {string} itemType One of {@link CANONICAL_ITEM_TYPES}.
 * @property {'inProgress'|'completed'|'failed'|'declined'} [status]
 * @property {string} [title]
 * @property {string} [detail]
 * @property {Object} [data]
 * @property {SubagentInfo} [data.subagent] Present on `collab_agent_tool_call`
 *   items: who the delegated work went to, so the panel can name it while it
 *   runs. Providers that cannot tell delegation apart simply omit it.
 */

/**
 * Identity of a delegated agent, as carried on `data.subagent`.
 * @typedef {Object} SubagentInfo
 * @property {string} [agentType] Named agent the provider delegated to, when
 *   it reports one (e.g. `'code-reviewer'`).
 * @property {string} [description] Short one-line description of the delegated
 *   work, shown after the name.
 * @property {boolean} [background] True when the delegation outlives the turn
 *   that launched it, so the row must not be force-closed at `turn.completed`.
 */

/**
 * @typedef {Object} ContentDeltaPayload
 * @property {string} streamKind One of {@link CONTENT_STREAM_KINDS}.
 * @property {string} delta
 * @property {number} [contentIndex]
 * @property {number} [summaryIndex]
 */

/**
 * @typedef {Object} RequestOpenedPayload
 * @property {string} requestType One of {@link REQUEST_TYPES}.
 * @property {string} [detail]
 * @property {Object} [args]
 */

/**
 * @typedef {Object} RequestResolvedPayload
 * @property {string} requestType One of {@link REQUEST_TYPES}.
 * @property {string} [decision]
 */

/**
 * One structured question the agent asks the user. Unlike a permission request
 * this is never auto-approved: only the user can produce the answer.
 * @typedef {Object} CanonicalQuestion
 * @property {string} id Answer key. Claude uses the question TEXT, Codex the
 *   native question id.
 * @property {string} header Short chip label for the question.
 * @property {string} question Full prompt shown to the user.
 * @property {Array<{label: string, description: string}>} options Selectable
 *   answers; may be empty when the question is free-text only.
 * @property {boolean} multiSelect True when several options can be picked.
 * @property {boolean} allowsFreeText True when a custom ("Other") answer is
 *   permitted.
 * @property {boolean} allowsNote True when a free-text comment can be attached
 *   to the answer (Claude only).
 * @property {boolean} secret True when the typed value must never be echoed.
 */

/**
 * Payload of `question.opened`, the structured-input counterpart of
 * `request.opened`.
 *
 * Driver contract: a driver that emits `question.opened` MUST later emit
 * `question.resolved` for the SAME requestId — with `submitted` when the user
 * answered, `declined` when the user refused, `cancelled` when the session or
 * the turn tore the question down, or `expired` when the provider auto-resolved
 * it. A question left open forever leaves an actionable card in the timeline.
 *
 * @typedef {Object} QuestionOpenedPayload
 * @property {string} requestType One of {@link REQUEST_TYPES}, `'tool_user_input'` today.
 * @property {CanonicalQuestion[]} questions One or more questions to answer.
 * @property {number} [expiresAtMs] Absolute epoch ms; present only when the
 *   provider can auto-resolve the question on its own.
 */

/**
 * Payload of `question.resolved`.
 * @typedef {Object} QuestionResolvedPayload
 * @property {string} requestType One of {@link REQUEST_TYPES}.
 * @property {'submitted'|'declined'|'cancelled'|'expired'} decision
 * @property {Object<string, {values: string[], note?: string}>} [answers] Echo
 *   of the canonical answers, only when the decision is `submitted`.
 */

/**
 * @typedef {Object} AccountRateLimitsUpdatedPayload
 * @property {Object} rateLimits
 */

/**
 * @typedef {Object} RuntimeWarningPayload
 * @property {string} message
 * @property {Object} [detail]
 */

/**
 * @typedef {Object} RuntimeErrorPayload
 * @property {string} message
 * @property {'provider_error'|'transport_error'|'usage_limit'|'unknown'} [class]
 * @property {string|number|Object} [code]
 * @property {Object} [detail]
 */

/**
 * @param {string} type
 * @returns {boolean} True when `type` is part of the canonical vocabulary.
 */
function isProviderEventType(type) {
  return PROVIDER_EVENT_TYPE_SET.has(type);
}

/**
 * A driver-produced event before the envelope metadata is attached.
 * @typedef {Object} BareProviderEvent
 * @property {string} type
 * @property {string} [threadId]
 * @property {string} [turnId]
 * @property {string} [itemId]
 * @property {string} [requestId]
 * @property {'main'|'subagent'|'unknown'} [executionOrigin]
 * @property {string|null} [createdAt] Original event time. Explicit null keeps
 *   restored history from inventing the current time.
 * @property {Object} [payload]
 * @property {ProviderEventRaw} [raw]
 */

/**
 * Wrap a bare driver event into a full {@link ProviderEvent} envelope.
 *
 * @param {BareProviderEvent} bareEvent Event as produced by a driver mapper.
 * @param {{ provider: string, threadId?: string, executionOrigin?: string }} context
 *   Provider id plus fallback metadata.
 * @returns {ProviderEvent}
 * @throws {TypeError} When the type is unknown or the provider is missing.
 */
function createProviderEvent(bareEvent, context) {
  const bare = bareEvent || {};
  const ctx = context || {};

  if (!isProviderEventType(bare.type)) {
    throw new TypeError(`Unknown provider event type: ${String(bare.type)}`);
  }
  if (!ctx.provider || typeof ctx.provider !== 'string') {
    throw new TypeError('createProviderEvent requires context.provider');
  }

  const threadId = bare.threadId !== undefined ? bare.threadId : ctx.threadId;
  const executionOrigin = normalizeExecutionOrigin(
    bare.executionOrigin !== undefined ? bare.executionOrigin : ctx.executionOrigin
  );
  const event = {
    eventId: crypto.randomUUID(),
    provider: ctx.provider,
    type: bare.type,
    executionOrigin,
    createdAt: Object.prototype.hasOwnProperty.call(bare, 'createdAt')
      ? bare.createdAt
      : new Date().toISOString(),
    payload: bare.payload || {}
  };

  if (threadId !== undefined) event.threadId = threadId;
  if (bare.turnId !== undefined) event.turnId = bare.turnId;
  if (bare.itemId !== undefined) event.itemId = bare.itemId;
  if (bare.requestId !== undefined) event.requestId = bare.requestId;
  if (bare.raw !== undefined) event.raw = bare.raw;

  return normalizeProviderErrorEvent(event);
}

/**
 * Normalize provenance at the shared event boundary.
 * @param {*} value
 * @returns {'main'|'subagent'|'unknown'}
 */
function normalizeExecutionOrigin(value) {
  return EXECUTION_ORIGINS.includes(value) ? value : 'unknown';
}

module.exports = {
  PROVIDER_EVENT_TYPES,
  CONTENT_STREAM_KINDS,
  CANONICAL_ITEM_TYPES,
  ITEM_STATUSES,
  TURN_STATES,
  REQUEST_TYPES,
  EXECUTION_ORIGINS,
  isProviderEventType,
  normalizeExecutionOrigin,
  createProviderEvent
};
