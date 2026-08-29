/**
 * Newline-delimited JSON-RPC framing.
 *
 * Agent CLIs that speak JSON-RPC over stdio emit one JSON object per line, but
 * stdout chunks never respect those boundaries: a chunk can hold several
 * messages, half a message, or both. This module is the pure framing layer -
 * it owns no state, the caller carries the remainder between chunks.
 */

const LINE_SEPARATOR = '\n';
const CARRIAGE_RETURN = '\r';

/**
 * @typedef {Object} JsonRpcChunkResult
 * @property {Object[]} messages Fully parsed JSON objects, in arrival order.
 * @property {string|string[]} remainder Partial trailing line to feed into the next call.
 * @property {string[]} invalidLines Raw lines that were not a JSON object.
 */

/**
 * Split and parse a stdout chunk of newline-delimited JSON-RPC messages.
 *
 * Never throws: unparseable lines and non-object JSON values are reported in
 * `invalidLines` so the caller can surface them as warnings.
 *
 * @param {string|string[]} remainder Carry-over partial line from the previous chunk.
 * @param {string} chunk New utf8 data.
 * @returns {JsonRpcChunkResult}
 */
function parseJsonRpcChunk(remainder, chunk) {
  const chunkText = typeof chunk === 'string' ? chunk : String(chunk || '');
  const remainderParts = Array.isArray(remainder)
    ? remainder
    : (remainder ? [remainder] : []);
  if (!chunkText.includes(LINE_SEPARATOR)) {
    // Mutate this private accumulator: copying it per chunk makes large JSON
    // responses quadratic again.
    if (chunkText) remainderParts.push(chunkText);
    return {
      messages: [],
      remainder: remainderParts.length ? remainderParts : '',
      invalidLines: []
    };
  }

  const lines = chunkText.split(LINE_SEPARATOR);
  if (remainderParts.length) {
    if (lines[0]) remainderParts.push(lines[0]);
    lines[0] = remainderParts.join('');
  }
  const nextRemainder = lines.pop();

  const messages = [];
  const invalidLines = [];

  for (const rawLine of lines) {
    const line = stripCarriageReturn(rawLine);
    if (!line.trim()) continue;

    const parsed = parseObjectLine(line);
    if (parsed === undefined) {
      invalidLines.push(line);
    } else {
      messages.push(parsed);
    }
  }

  return { messages, remainder: nextRemainder, invalidLines };
}

/**
 * Remove the CR of a CRLF line ending, if present.
 * @param {string} line
 * @returns {string}
 */
function stripCarriageReturn(line) {
  return line.endsWith(CARRIAGE_RETURN) ? line.slice(0, -1) : line;
}

/**
 * Parse a single line, accepting JSON objects only.
 * @param {string} line
 * @returns {Object|undefined} The object, or undefined when invalid.
 */
function parseObjectLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return undefined;
  }
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  return isObject ? value : undefined;
}

module.exports = { parseJsonRpcChunk };
