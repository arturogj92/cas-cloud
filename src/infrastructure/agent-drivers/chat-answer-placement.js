/**
 * The one instruction every Chat session adds to its agent.
 *
 * Current models return encrypted reasoning: the block carries a signature and
 * no text, so a conclusion written while thinking reaches nobody. A turn that
 * spends thousands of tokens reasoning and then closes with "the summary is
 * above" leaves the reader a collapsed `Worked for …` and nothing else. See
 * `docs/diagnostics/chat-answer-lost-in-encrypted-reasoning.md`.
 *
 * Each provider injects it through its own channel (Claude appends to the
 * `claude_code` preset, Codex sends `developerInstructions`), so the text lives
 * here rather than in any one driver.
 */
const CHAT_ANSWER_PLACEMENT_PROMPT = [
  'Your reasoning is never shown to the reader in this interface.',
  'Every conclusion, summary, analysis or recommendation must be written in your',
  'message text. Never point at content "above", at earlier steps, or at your own',
  'thinking: if it is not in a message you wrote, the reader cannot see it.'
].join(' ');

/**
 * The same rule for providers with no system-prompt channel of their own.
 *
 * Antigravity's CLI exposes no instructions flag and ACP's `session/new` has no
 * field for one, so those agents receive it as a marked block on the FIRST
 * prompt of a session. Once per session, never per turn: the agent keeps it in
 * its own conversation history from then on, and repeating it would grow every
 * request and clutter the transcript.
 */
const CHAT_ANSWER_PLACEMENT_PREAMBLE = [
  '<session-instructions>',
  CHAT_ANSWER_PLACEMENT_PROMPT,
  '</session-instructions>'
].join('\n');

module.exports = { CHAT_ANSWER_PLACEMENT_PROMPT, CHAT_ANSWER_PLACEMENT_PREAMBLE };
