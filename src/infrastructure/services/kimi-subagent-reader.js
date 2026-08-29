/**
 * Kimi Subagent Reader
 *
 * Reads one delegated (child) kimi agent straight out of kimi's own on-disk
 * session store, so a subagent row in Chat can be drilled into.
 *
 * ── Where the child lives ───────────────────────────────────────────────────
 * kimi's ACP stream announces a delegation as an ordinary `Agent` tool call and
 * never puts the child's identity on the wire. The transcript does record it:
 * the MAIN agent's wire.jsonl carries the matching tool result, whose output
 * text starts with `agent_id: agent-N`, and that N names a sibling directory:
 *
 *   <sessionDir>/agents/main/wire.jsonl       the parent's event stream
 *   <sessionDir>/agents/agent-N/wire.jsonl    the child's, same format
 *
 * `sessionDir` comes from ~/.kimi-code/session_index.jsonl, which
 * kimi-conversation-reader.js already knows how to locate.
 *
 * The result output also carries `status: completed` for a finished child; a
 * BACKGROUND task instead reports `task_id: ...` + `status: running` with the
 * same `agent_id:` line, so the extraction works for both.
 *
 * Wire lines are undocumented and heterogeneous (config.update, step.begin,
 * usage.record...), so every parse here is tolerant: an unknown or corrupt line
 * is skipped, never thrown over.
 */

const fs = require('fs');
const path = require('path');

const { getDataRoot, extractText } = require('./kimi-conversation-reader');
const {
    MAX_CHAT_IMAGE_BYTES,
    contentImageAttachments
} = require('../agent-drivers/chat-attachments');

const NOT_FOUND_MESSAGE = 'Subagent conversation not found on disk';
const DETAIL_FALLBACK_CHARS = 120;

/** Parse one JSONL line, or null when blank/corrupt. */
function parseLine(line) {
    const trimmed = String(line == null ? '' : line).trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch (_err) {
        return null;
    }
}

/** Read a file as JSONL lines; a missing/unreadable file reads as empty. */
function readLines(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8').split('\n');
    } catch (_err) {
        return [];
    }
}

/**
 * The directory kimi stores a session in, or null.
 *
 * Deleted sessions stay in the index as tombstones (`{sessionId, deleted:true}`,
 * no sessionDir) and a session can be re-indexed, so the LAST entry carrying a
 * directory wins.
 *
 * @param {string} sessionId ACP session id (`session_<uuid>`).
 * @param {string} [indexPath] Defaults to the reader's session_index.jsonl.
 * @returns {string|null}
 */
function resolveSessionDir(sessionId, indexPath) {
    if (!sessionId) return null;
    const file = indexPath || path.join(getDataRoot(), 'session_index.jsonl');
    let resolved = null;
    for (const line of readLines(file)) {
        const entry = parseLine(line);
        if (!entry || entry.sessionId !== sessionId) continue;
        if (entry.deleted || !entry.sessionDir) continue;
        resolved = entry.sessionDir;
    }
    return resolved;
}

/**
 * Which child agent a parent's `Agent` tool call spawned.
 *
 * @param {string[]} lines The MAIN agent's wire.jsonl lines.
 * @param {string} toolCallId kimi's own `tool_...` id (no turn prefix).
 * @returns {{agentId: string, finished: boolean}|null}
 */
function extractAgentIdFromWire(lines, toolCallId) {
    for (const line of lines || []) {
        const parsed = parseLine(line);
        if (!parsed || parsed.type !== 'context.append_loop_event') continue;
        const event = parsed.event;
        if (!event || event.type !== 'tool.result' || event.toolCallId !== toolCallId) continue;
        const output = event.result && typeof event.result.output === 'string' ? event.result.output : '';
        const match = output.match(/\bagent_id:\s*(agent-[\w-]+)/);
        if (!match) continue;
        return { agentId: match[1], finished: /\bstatus:\s*completed\b/.test(output) };
    }
    return null;
}

/** A bare `item.completed` timeline event. */
function completedEvent(itemId, payload) {
    return {
        type: 'item.completed',
        itemId,
        payload: { status: 'completed', historical: true, ...payload }
    };
}

/** One-line summary of a tool call's arguments. */
function toolDetail(args) {
    if (args && typeof args === 'object') {
        if (typeof args.description === 'string' && args.description) return args.description;
        if (typeof args.command === 'string' && args.command) return args.command;
    }
    if (args === undefined) return '';
    try {
        return JSON.stringify(args).slice(0, DETAIL_FALLBACK_CHARS);
    } catch (_err) {
        return '';
    }
}

/** Restore Kimi prompt images from its guarded media-originals directory. */
function promptImageAttachments(input, sessionDir) {
    if (!Array.isArray(input) || !sessionDir) return [];
    const mediaRoot = path.resolve(sessionDir, 'media-originals');
    let realMediaRoot;
    try {
        if (fs.lstatSync(mediaRoot).isSymbolicLink()) return [];
        realMediaRoot = fs.realpathSync(mediaRoot);
    } catch (_err) {
        return [];
    }
    const originals = input
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .flatMap((part) => Array.from(
            part.text.matchAll(/uncompressed original is saved at "([^"]+)"/g),
            (match) => match[1]
        ));
    let originalIndex = 0;
    const blocks = [];

    for (const part of input) {
        if (!part || part.type !== 'image_url') continue;
        const storedUrl = part.imageUrl?.url || part.image_url?.url || '';
        if (storedUrl.startsWith('data:')) {
            blocks.push({ type: 'image', url: storedUrl });
            continue;
        }

        const original = originals[originalIndex++];
        if (!original) continue;
        const resolved = path.resolve(original);
        if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) continue;
        try {
            const realFile = fs.realpathSync(resolved);
            if (realFile !== realMediaRoot
                && !realFile.startsWith(`${realMediaRoot}${path.sep}`)) continue;
            const stat = fs.statSync(realFile);
            if (!stat.isFile() || stat.size > MAX_CHAT_IMAGE_BYTES) continue;
            const extension = path.extname(realFile).toLowerCase();
            const mimeType = extension === '.jpg' || extension === '.jpeg'
                ? 'image/jpeg'
                : extension === '.webp' ? 'image/webp' : 'image/png';
            blocks.push({
                type: 'image',
                name: path.basename(realFile),
                url: `data:${mimeType};base64,${fs.readFileSync(realFile).toString('base64')}`
            });
        } catch (_err) { /* missing or invalid media degrades to text-only */ }
    }

    return contentImageAttachments(blocks);
}

/**
 * A child's wire.jsonl folded into bare canonical events, oldest first.
 *
 * Assistant text arrives as a run of `content.part` chunks, so chunks are
 * accumulated and emitted as ONE message. `think` parts are dropped without
 * breaking the run (reasoning interleaves inside a single reply); the events we
 * actually emit — user messages and tool calls — flush it, and unrecognized
 * bookkeeping lines leave it alone.
 *
 * @param {string[]} lines
 * @returns {Object[]}
 */
function mapKimiWireToEvents(lines, { main = false, sessionDir = null } = {}) {
    const events = [];
    let pending = null; // { index, chunks: string[] }

    const flush = () => {
        if (!pending) return;
        const text = pending.chunks.join('');
        if (text.trim()) {
            events.push(completedEvent(`kimi-a-${pending.index}`, {
                itemType: 'assistant_message',
                title: 'Assistant message',
                data: { text }
            }));
        }
        pending = null;
    };

    (lines || []).forEach((line, index) => {
        const parsed = parseLine(line);
        if (!parsed) return;

        if (main && (parsed.type === 'turn.prompt' || parsed.type === 'turn.steer')
            && parsed.origin?.kind === 'user') {
            const text = (Array.isArray(parsed.input) ? parsed.input : [])
                .map((part) => part && part.type === 'text' ? part.text : '')
                .filter((part) => part && !/^<(?:session-instructions|system|system-reminder|environment_context)\b/i.test(part.trim()))
                .join('\n');
            const attachments = promptImageAttachments(parsed.input, sessionDir);
            if (!text.trim() && attachments.length === 0) return;
            flush();
            events.push(completedEvent(`kimi-u-${index}`, {
                itemType: 'user_message',
                title: 'User message',
                data: { text, ...(attachments.length ? { attachments } : {}) }
            }));
            return;
        }

        if (parsed.type === 'context.append_message') {
            // Main-session user messages are already represented by turn.prompt
            // or turn.steer. Their context copies also include background-task
            // notifications, so accepting them would duplicate or leak host rows.
            if (main) return;
            const message = parsed.message;
            if (!message || message.role !== 'user') return;
            const text = extractText(message.content);
            if (!text || !text.trim()) return;
            flush();
            events.push(completedEvent(`kimi-u-${index}`, {
                itemType: 'user_message',
                title: 'User message',
                data: { text }
            }));
            return;
        }

        if (parsed.type !== 'context.append_loop_event' || !parsed.event) return;
        const event = parsed.event;

        if (event.type === 'content.part') {
            const part = event.part;
            if (!part || part.type !== 'text' || typeof part.text !== 'string') return;
            if (!pending) pending = { index, chunks: [] };
            pending.chunks.push(part.text);
            return;
        }

        if (event.type === 'tool.call') {
            flush();
            events.push(completedEvent(main && event.toolCallId ? event.toolCallId : `kimi-t-${index}`, {
                itemType: 'dynamic_tool_call',
                title: event.name || 'Tool call',
                detail: toolDetail(event.args),
                data: { name: event.name, input: event.args }
            }));
        }
    });

    flush();
    return events;
}

/** Read the main agent's local transcript for an ACP history fallback. */
function readKimiMainConversation(sessionId) {
    const sessionDir = resolveSessionDir(sessionId);
    if (!sessionDir) return [];
    return mapKimiWireToEvents(
        readLines(path.join(sessionDir, 'agents', 'main', 'wire.jsonl')),
        { main: true, sessionDir }
    );
}

/**
 * Resolve one subagent tool call to its child agent and read its transcript.
 *
 * @param {{sessionId: string, toolCallId: string,
 *   known?: {size: number, mtimeMs: number}}} params
 * @returns {{agentId: string, finished: boolean, events: Object[],
 *   fileSize: number, fileMtimeMs: number}
 *   | {agentId: string, finished: boolean, unchanged: true}}
 * @throws {Error} `Subagent conversation not found on disk`
 */
function openKimiSubagentConversation({ sessionId, toolCallId, known } = {}) {
    const sessionDir = resolveSessionDir(sessionId);
    if (!sessionDir) throw new Error(NOT_FOUND_MESSAGE);

    const child = extractAgentIdFromWire(
        readLines(path.join(sessionDir, 'agents', 'main', 'wire.jsonl')),
        toolCallId
    );
    if (!child) throw new Error(NOT_FOUND_MESSAGE);

    const childWirePath = path.join(sessionDir, 'agents', child.agentId, 'wire.jsonl');
    let stat;
    try {
        stat = fs.statSync(childWirePath);
    } catch (_err) {
        throw new Error(NOT_FOUND_MESSAGE);
    }

    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
        return { agentId: child.agentId, finished: child.finished, unchanged: true };
    }

    return {
        agentId: child.agentId,
        finished: child.finished,
        events: mapKimiWireToEvents(readLines(childWirePath)),
        fileSize: stat.size,
        fileMtimeMs: stat.mtimeMs
    };
}

module.exports = {
    resolveSessionDir,
    extractAgentIdFromWire,
    mapKimiWireToEvents,
    readKimiMainConversation,
    openKimiSubagentConversation
};
