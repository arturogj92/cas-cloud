/**
 * A deliberately tiny markdown reader for streamed assistant text.
 *
 * Two properties matter more than completeness:
 *  - **Stream safe**: half-written syntax (an open fence, a dangling `**`) is
 *    rendered as-is instead of throwing away the tail of the message.
 *  - **XSS safe by construction**: it never emits HTML. Every block carries
 *    plain text that the renderer puts into React elements as text nodes, so
 *    markup inside an agent reply can never become markup on screen.
 *
 * Supported: paragraphs, ATX headings (1-4), fenced code, ordered/unordered
 * lists, GFM tables, `**bold**`, `` `code` ``, Markdown links and bare web
 * URLs. Explicit local images and source links are classified here, but never
 * opened by the renderer without the main-process resolver. Nothing nests.
 */

const FENCE_MARKER = '```';
const MAX_HEADING_LEVEL = 4;
const HEADING_PATTERN = /^(#{1,4})\s+(.*)$/;
const UNORDERED_ITEM_PATTERN = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\s*(\d+)[.)]\s+(.*)$/;
const BARE_LOCAL_IMAGE_PATTERN = /^(?:\/|[a-z]:[\\/])[^\s<>"'`,;!?]+/i;
const LOCAL_IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|gif)$/i;
const CODEX_FILE_CITATION_PREFIX = ':codex-file-citation{';

/**
 * An inline run of text inside a paragraph, heading or list item.
 * @typedef {Object} InlineSpan
 * @property {'text'|'bold'|'code'|'link'|'image'|'source'|'html'|'file'} type
 * @property {string} text
 * @property {string} [url] Normalized http(s) target for links.
 * @property {string} [path] Local path target, before session resolution.
 * @property {string} [alt] Local image alt text.
 * @property {number} [line] Optional one-based source line.
 * @property {number} [column] Optional one-based source column.
 */

/**
 * @typedef {Object} MarkdownBlock
 * @property {'paragraph'|'images'|'code'|'list'|'heading'|'table'} type
 * @property {InlineSpan[]} [spans] Paragraph / heading content.
 * @property {InlineSpan[][]} [items] List items, one span array each.
 * @property {boolean} [ordered] List numbering.
 * @property {number} [start] First visible number of an ordered list.
 * @property {string} [language] Code fence language, `''` when unset.
 * @property {string} [text] Raw code text.
 * @property {boolean} [closed] Whether the closing code fence has arrived.
 * @property {number} [level] Heading level, 1-4.
 * @property {InlineSpan[][]} [headers] Table heading cells.
 * @property {InlineSpan[][][]} [rows] Table body rows.
 * @property {Array<'left'|'center'|'right'|null>} [alignments] Column alignment.
 */

/**
 * Split markdown text into renderable blocks.
 *
 * @param {string} text Markdown, possibly mid-stream.
 * @returns {MarkdownBlock[]} Empty when there is nothing to render.
 */
function parseMarkdownBlocks(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const lines = text.split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let listItems = null;
  let listOrdered = false;
  let listStart = 1;

  /** Flush the paragraph buffer into a block. */
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(...splitParagraphImageBlocks(parseInlineSpans(paragraph.join(' '))));
    paragraph = [];
  };

  /** Flush the list buffer into a block. */
  const flushList = () => {
    if (listItems === null) return;
    blocks.push({
      type: 'list',
      ordered: listOrdered,
      items: listItems,
      ...(listOrdered ? { start: listStart } : {})
    });
    listItems = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const table = readTable(lines, index);
    if (table) {
      flushParagraph();
      flushList();
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    if (line.trimStart().startsWith(FENCE_MARKER)) {
      flushParagraph();
      flushList();
      const fence = readFencedCode(lines, index);
      blocks.push(fence.block);
      index = fence.nextIndex;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      // Keep the list open: a blank line between items is a loose list, not a
      // new list. Closing it here restarted <ol> numbering at 1 per item.
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        level: Math.min(heading[1].length, MAX_HEADING_LEVEL),
        spans: parseInlineSpans(heading[2])
      });
      continue;
    }

    const item = matchListItem(line);
    if (item) {
      flushParagraph();
      if (listItems === null || listOrdered !== item.ordered) {
        flushList();
        listItems = [];
        listOrdered = item.ordered;
        listStart = item.start ?? 1;
      }
      listItems.push(parseInlineSpans(item.text));
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Images are visual evidence, not words in a sentence. Split them into their
 * own block while keeping adjacent images together as a small gallery.
 *
 * @param {InlineSpan[]} spans
 * @returns {MarkdownBlock[]}
 */
function splitParagraphImageBlocks(spans) {
  if (!spans.some((span) => span.type === 'image')) {
    return [{ type: 'paragraph', spans }];
  }

  const blocks = [];
  let prose = [];
  const flushProse = () => {
    if (!prose.length) return;
    const trimmed = trimSpanWhitespace(prose);
    if (trimmed.some((span) => span.type !== 'text' || /[^\s,;.]/.test(span.text))) {
      blocks.push({ type: 'paragraph', spans: trimmed });
    }
    prose = [];
  };

  for (let index = 0; index < spans.length;) {
    if (spans[index].type !== 'image') {
      prose.push(spans[index]);
      index += 1;
      continue;
    }

    flushProse();
    const images = [spans[index]];
    index += 1;
    while (index < spans.length) {
      const separator = spans[index];
      const following = spans[index + 1];
      if (separator.type === 'text' && /^[\s,;·|]*$/.test(separator.text)
          && following?.type === 'image') {
        images.push(following);
        index += 2;
        continue;
      }
      break;
    }
    blocks.push({ type: 'images', spans: images });
  }
  flushProse();

  // Agents occasionally place the colon after the Markdown image
  // (`See this ![shot](...) : explanation`). Once the media becomes a block,
  // keep that punctuation with the sentence that introduces it.
  for (let index = 1; index < blocks.length - 1; index += 1) {
    if (blocks[index].type !== 'images'
        || blocks[index - 1].type !== 'paragraph'
        || blocks[index + 1].type !== 'paragraph') continue;
    const nextSpans = blocks[index + 1].spans;
    const first = nextSpans[0];
    if (first?.type !== 'text') continue;
    const colon = /^\s*:\s*/.exec(first.text);
    if (!colon) continue;
    const previousSpans = blocks[index - 1].spans;
    const last = previousSpans[previousSpans.length - 1];
    if (last?.type === 'text') last.text = `${last.text}:`;
    else previousSpans.push({ type: 'text', text: ':' });
    first.text = first.text.slice(colon[0].length);
    blocks[index + 1].spans = trimSpanWhitespace(nextSpans);
  }

  return blocks;
}

/** @param {InlineSpan[]} spans @returns {InlineSpan[]} */
function trimSpanWhitespace(spans) {
  const result = spans.map((span) => ({ ...span }));
  if (result[0]?.type === 'text') result[0].text = result[0].text.replace(/^\s+/, '');
  const last = result[result.length - 1];
  if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '');
  return result.filter((span) => span.type !== 'text' || span.text !== '');
}

/**
 * Parse a GFM-style table when `startIndex` points at a header whose following
 * row is a valid delimiter. HTML remains ordinary cell text because every cell
 * is passed through the same text-only inline parser as paragraphs.
 *
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {{block: MarkdownBlock, nextIndex: number}|null}
 */
function readTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) return null;
  const headers = splitTableRow(lines[startIndex]);
  const delimiters = splitTableRow(lines[startIndex + 1]);
  if (!headers || !delimiters || headers.length !== delimiters.length) return null;

  const alignments = [];
  for (const delimiter of delimiters) {
    const compact = delimiter.replace(/\s+/g, '');
    if (!/^:?-{3,}:?$/.test(compact)) return null;
    alignments.push(
      compact.startsWith(':') && compact.endsWith(':')
        ? 'center'
        : compact.endsWith(':')
          ? 'right'
          : compact.startsWith(':')
            ? 'left'
            : null
    );
  }

  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].trim() !== '') {
    const cells = splitTableRow(lines[index]);
    if (!cells) break;
    rows.push(headers.map((_, column) => parseInlineSpans(cells[column] || '')));
    index += 1;
  }

  return {
    block: {
      type: 'table',
      alignments,
      headers: headers.map(parseInlineSpans),
      rows
    },
    nextIndex: index - 1
  };
}

/**
 * Split one table row, respecting escaped pipes and inline-code spans.
 * A row needs at least one actual pipe; leading/trailing pipes are optional.
 *
 * @param {string} line
 * @returns {string[]|null}
 */
function splitTableRow(line) {
  if (typeof line !== 'string' || !line.includes('|')) return null;
  const trimmed = line.trim();
  const body = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '');
  const cells = [];
  let cell = '';
  let escaped = false;
  let inCode = false;

  for (const character of body) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') {
      inCode = !inCode;
      cell += character;
      continue;
    }
    if (character === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}

/**
 * Read a fenced code block, tolerating a fence that is never closed.
 *
 * @param {string[]} lines All lines of the document.
 * @param {number} openIndex Index of the opening fence.
 * @returns {{block: MarkdownBlock, nextIndex: number}} Block plus the index of
 *   the last consumed line.
 */
function readFencedCode(lines, openIndex) {
  const language = lines[openIndex].trim().slice(FENCE_MARKER.length).trim().split(/\s+/)[0] || '';
  const body = [];

  for (let index = openIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trimStart().startsWith(FENCE_MARKER)) {
      return { block: { type: 'code', language, text: body.join('\n'), closed: true }, nextIndex: index };
    }
    body.push(lines[index]);
  }

  return { block: { type: 'code', language, text: body.join('\n'), closed: false }, nextIndex: lines.length };
}

/**
 * @param {string} line
 * @returns {{ordered: boolean, text: string, start?: number}|null}
 */
function matchListItem(line) {
  const unordered = UNORDERED_ITEM_PATTERN.exec(line);
  if (unordered) return { ordered: false, text: unordered[1] };

  const ordered = ORDERED_ITEM_PATTERN.exec(line);
  if (ordered) return { ordered: true, start: Number(ordered[1]), text: ordered[2] };

  return null;
}

/**
 * Split one line of text into inline spans.
 *
 * Unterminated `**` or `` ` `` markers stay literal, which is what a streaming
 * reply looks like halfway through a word.
 *
 * @param {string} text
 * @returns {InlineSpan[]}
 */
function parseInlineSpans(text) {
  if (typeof text !== 'string' || text === '') return [];

  const spans = [];
  let plain = '';
  let cursor = 0;

  /** Push the buffered plain text as a span. */
  const flushPlain = () => {
    if (plain === '') return;
    spans.push({ type: 'text', text: plain });
    plain = '';
  };

  while (cursor < text.length) {
    const fileCitation = readCodexFileCitationSpan(text, cursor);
    if (fileCitation) {
      flushPlain();
      spans.push(fileCitation.span);
      cursor = fileCitation.nextCursor;
      continue;
    }
    const html = readLocalHtmlSpan(text, cursor);
    if (html) {
      flushPlain();
      spans.push(html.span);
      cursor = html.nextCursor;
      continue;
    }
    const image = readLocalImageSpan(text, cursor);
    if (image) {
      flushPlain();
      spans.push(image.span);
      cursor = image.nextCursor;
      continue;
    }
    const bareImage = readBareLocalImageSpan(text, cursor);
    if (bareImage) {
      flushPlain();
      spans.push(bareImage.span);
      cursor = bareImage.nextCursor;
      continue;
    }
    const link = readLinkSpan(text, cursor);
    if (link) {
      flushPlain();
      spans.push(link.span);
      cursor = link.nextCursor;
      continue;
    }
    const marked = readMarkedSpan(text, cursor);
    if (marked) {
      flushPlain();
      spans.push(marked.span);
      cursor = marked.nextCursor;
      continue;
    }
    plain += text[cursor];
    cursor += 1;
  }

  flushPlain();
  return spans;
}

/**
 * Codex emits this marker for files the host should present to the user. Keep
 * the absolute path out of prose and let the main process validate it on open.
 *
 * @param {string} text
 * @param {number} cursor
 * @returns {{span: InlineSpan, nextCursor: number}|null}
 */
function readCodexFileCitationSpan(text, cursor) {
  if (!text.startsWith(CODEX_FILE_CITATION_PREFIX, cursor)) return null;
  const end = text.indexOf('}', cursor + CODEX_FILE_CITATION_PREFIX.length);
  if (end === -1) return null;

  const attributes = {};
  const body = text.slice(cursor + CODEX_FILE_CITATION_PREFIX.length, end);
  for (const match of body.matchAll(/([a-z_]+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  if (!attributes.path || !['output', 'source'].includes(attributes.purpose)) return null;

  return {
    span: {
      type: 'file',
      text: attributes.label || attributes.path,
      path: attributes.path,
      purpose: attributes.purpose
    },
    nextCursor: end + 1
  };
}

/**
 * Read an absolute HTML path written in angle brackets. This mirrors the
 * literal emitted by agent plans (`</absolute/path/file.html>`) without
 * treating ordinary HTML-ish prose or web URLs as links.
 *
 * @param {string} text
 * @param {number} cursor
 * @returns {{span: InlineSpan, nextCursor: number}|null}
 */
function readLocalHtmlSpan(text, cursor) {
  if (text[cursor] !== '<') return null;
  const end = text.indexOf('>', cursor + 1);
  if (end <= cursor + 1) return null;
  const target = text.slice(cursor + 1, end).trim();
  const local = parseLocalReferenceTarget(target);
  if (!local || !isAbsolutePath(local.path) || !/\.html?$/i.test(local.path)) return null;
  return {
    span: { type: 'html', text: local.path, path: local.path },
    nextCursor: end + 1
  };
}

function isAbsolutePath(value) {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

/**
 * Read a standalone absolute raster path. Assistant providers often emit a
 * screenshot path as ordinary text (`/tmp/shot.png,`) rather than Markdown.
 * Only the known raster suffixes are classified; the main-process resolver
 * still owns containment, size and magic-byte validation.
 *
 * @param {string} text
 * @param {number} cursor
 * @returns {{span: InlineSpan, nextCursor: number}|null}
 */
function readBareLocalImageSpan(text, cursor) {
  if (cursor > 0 && !/[\s([<{;,.'"`]/.test(text[cursor - 1])) return null;
  const match = BARE_LOCAL_IMAGE_PATTERN.exec(text.slice(cursor));
  if (!match) return null;

  let pathValue = match[0];
  while (/[.)\]}]$/.test(pathValue)) pathValue = pathValue.slice(0, -1);
  if (!LOCAL_IMAGE_EXTENSION_PATTERN.test(pathValue)) return null;

  return {
    span: { type: 'image', text: pathValue, alt: pathValue, path: pathValue },
    nextCursor: cursor + pathValue.length
  };
}

/**
 * Read a Markdown link or a visible http(s) URL. Other protocols stay plain
 * text and can therefore never reach Electron's external-open IPC.
 *
 * @param {string} text
 * @param {number} cursor
 * @returns {{span: InlineSpan, nextCursor: number}|null}
 */
function readLinkSpan(text, cursor) {
  if (text[cursor] === '[') {
    const labelEnd = text.indexOf('](', cursor + 1);
    const destination = labelEnd === -1 ? null : readMarkdownDestination(text, labelEnd + 2);
    const urlEnd = destination ? destination.urlEnd : -1;
    if (labelEnd > cursor + 1 && urlEnd > labelEnd + 2) {
      const target = destination.target.trim();
      const url = normalizeWebUrl(unwrapMarkdownTarget(target));
      if (url) {
        return {
          span: { type: 'link', text: text.slice(cursor + 1, labelEnd), url },
          nextCursor: urlEnd + 1
        };
      }
      const local = parseLocalReferenceTarget(target);
      if (local) {
        const label = text.slice(cursor + 1, labelEnd);
        if (local.line === undefined
          && local.column === undefined
          && isAbsolutePath(local.path)
          && /\.html?$/i.test(local.path)) {
          return {
            span: { type: 'html', text: label, path: local.path },
            nextCursor: urlEnd + 1
          };
        }
        if (local.line === undefined
          && local.column === undefined
          && LOCAL_IMAGE_EXTENSION_PATTERN.test(local.path)) {
          return {
            span: { type: 'image', text: label, alt: label, path: local.path },
            nextCursor: urlEnd + 1
          };
        }
        return {
          span: {
            type: 'source',
            text: label,
            path: local.path,
            ...(local.line !== undefined ? { line: local.line } : {}),
            ...(local.column !== undefined ? { column: local.column } : {})
          },
          nextCursor: urlEnd + 1
        };
      }
    }
  }

  const bare = /^(?:https?:\/\/)[^\s<>"'`]+/i.exec(text.slice(cursor));
  if (!bare) return null;
  let visible = bare[0].replace(/[.,!?;:]+$/, '');
  while (visible.endsWith(')') && !visible.includes('(')) visible = visible.slice(0, -1);
  const url = normalizeWebUrl(visible);
  return url
    ? { span: { type: 'link', text: visible, url }, nextCursor: cursor + visible.length }
    : null;
}

/**
 * Read one Markdown destination, including the angle-bracket form whose path
 * may contain parentheses (e.g. `[shot](</tmp/shot.png>)`).
 * @param {string} text
 * @param {number} start
 * @returns {{target: string, urlEnd: number}|null}
 */
function readMarkdownDestination(text, start) {
  if (text[start] === '<') {
    const targetEnd = text.indexOf('>', start + 1);
    if (targetEnd === -1) return null;
    const urlEnd = text.indexOf(')', targetEnd + 1);
    if (urlEnd === -1) return null;
    return { target: text.slice(start, targetEnd + 1), urlEnd };
  }
  const urlEnd = text.indexOf(')', start);
  return urlEnd === -1 ? null : { target: text.slice(start, urlEnd), urlEnd };
}

/** @param {string} value @returns {string|null} Unwrapped destination. */
function unwrapMarkdownTarget(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const hasOpeningAngle = trimmed.startsWith('<');
  const hasClosingAngle = trimmed.endsWith('>');
  if (hasOpeningAngle !== hasClosingAngle) return null;
  return hasOpeningAngle ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * Read an explicit local Markdown image. Remote and unsupported schemes stay
 * ordinary text, matching the existing safe-link behavior.
 *
 * @param {string} text
 * @param {number} cursor
 * @returns {{span: InlineSpan, nextCursor: number}|null}
 */
function readLocalImageSpan(text, cursor) {
  if (text[cursor] !== '!' || text[cursor + 1] !== '[') return null;
  const labelEnd = text.indexOf('](', cursor + 2);
  const destination = labelEnd === -1 ? null : readMarkdownDestination(text, labelEnd + 2);
  const urlEnd = destination ? destination.urlEnd : -1;
  if (labelEnd < cursor + 2 || urlEnd <= labelEnd + 2) return null;
  const target = destination.target.trim();
  const local = parseLocalReferenceTarget(target);
  if (!local || local.line !== undefined || local.column !== undefined) {
    // Consume a complete but unsupported image as one inert text span. This
    // prevents the generic link parser from turning `![remote](https://…)`
    // into a surprising `!` followed by an active web link.
    return {
      span: { type: 'text', text: text.slice(cursor, urlEnd + 1) },
      nextCursor: urlEnd + 1
    };
  }
  return {
    span: {
      type: 'image',
      text: text.slice(cursor + 2, labelEnd),
      alt: text.slice(cursor + 2, labelEnd),
      path: local.path
    },
    nextCursor: urlEnd + 1
  };
}

/**
 * Classify a link target as a local path and split optional source location.
 * Any URI scheme (including `file:`) remains inert; a Windows drive prefix is
 * the one intentional colon exception.
 *
 * @param {string} value
 * @returns {{path: string, line?: number, column?: number}|null}
 */
function parseLocalReferenceTarget(value) {
  const raw = unwrapMarkdownTarget(value);
  if (!raw) return null;

  let pathValue = raw;
  let line;
  let column;
  const location = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw);
  if (location && location[1] && !/^[a-z]:$/i.test(location[1])) {
    pathValue = location[1];
    line = Number(location[2]);
    if (location[3] !== undefined) column = Number(location[3]);
    if (!Number.isSafeInteger(line) || line < 1) return null;
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  }

  if (!pathValue || /[\u0000\r\n]/.test(pathValue)) return null;
  if (/^(?:[a-z][a-z0-9+.-]*):\/\//i.test(pathValue)) return null;
  if (/^(?:javascript|data|mailto|file):/i.test(pathValue)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathValue) && !/^[a-z]:[\\/]/i.test(pathValue)) return null;
  return {
    path: pathValue,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {})
  };
}

/** @returns {string|null} A canonical web URL, or null for unsafe protocols. */
function normalizeWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Try to read a `**bold**` or `` `code` `` span at `cursor`.
 * @param {string} text
 * @param {number} cursor
 * @returns {{span: InlineSpan, nextCursor: number}|null}
 */
function readMarkedSpan(text, cursor) {
  if (text.startsWith('**', cursor)) {
    const end = text.indexOf('**', cursor + 2);
    if (end > cursor + 1) {
      return {
        span: { type: 'bold', text: text.slice(cursor + 2, end) },
        nextCursor: end + 2
      };
    }
    return null;
  }

  if (text[cursor] === '`') {
    const end = text.indexOf('`', cursor + 1);
    if (end > cursor) {
      return {
        span: { type: 'code', text: text.slice(cursor + 1, end) },
        nextCursor: end + 1
      };
    }
  }

  return null;
}

module.exports = {
  parseMarkdownBlocks,
  parseInlineSpans,
  parseLocalReferenceTarget,
  readLocalHtmlSpan
};
