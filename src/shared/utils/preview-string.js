/**
 * Safe preview string utility.
 *
 * Truncates a string to a max char count AND forces V8 to materialize a fresh
 * SeqString. This breaks V8's SlicedString optimisation — without it, a
 * `text.substring(0, N)` over a huge parent string creates a SlicedString
 * that keeps the entire parent alive as long as the slice exists. Storing
 * 200–2000 of those slices in conversation-history result objects pinned
 * gigabytes of user-message content in V8 old-gen and caused the OOM crash
 * we hit when opening the Conversation History modal with heavy Codex history.
 *
 * Buffer round-trip is the most reliable cross-version way to force a flat
 * string: encoding to UTF-8 allocates an independent byte buffer, decoding
 * back creates a brand-new SeqString that has no relationship to the parent.
 */

const DEFAULT_PREVIEW_CHARS = 8 * 1024;

function safePreviewString(text, maxChars = DEFAULT_PREVIEW_CHARS) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const truncated = text.length > maxChars ? text.substring(0, maxChars) : text;
  return Buffer.from(truncated, 'utf8').toString('utf8');
}

module.exports = { safePreviewString, DEFAULT_PREVIEW_CHARS };
