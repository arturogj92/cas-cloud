const ATTACHMENT_LABELS = {
  image: 'Image',
  audio: 'Audio',
  file: 'File'
};

const COMPOSER_TOKEN_START = 0xE000;

function attachmentOrdinal(attachments, index) {
  const type = attachments[index]?.type;
  let ordinal = 0;
  for (let current = 0; current <= index; current += 1) {
    if (attachments[current]?.type === type) ordinal += 1;
  }
  return ordinal;
}

function attachmentMarker(attachments, index) {
  const type = attachments[index]?.type;
  const label = ATTACHMENT_LABELS[type] || 'Attachment';
  return `[[${label} ${attachmentOrdinal(attachments, index)}]]`;
}

// Keep the provider marker out of the textarea; restore it immediately before send.
function composerAttachmentToken(attachments, index) {
  const token = String.fromCodePoint(COMPOSER_TOKEN_START + index);
  return token.repeat(3);
}

function insertAttachmentMarkers(text, currentAttachments, addedAttachments, start, end = start) {
  const source = typeof text === 'string' ? text : '';
  const before = Array.isArray(currentAttachments) ? currentAttachments : [];
  const added = Array.isArray(addedAttachments) ? addedAttachments : [];
  if (!added.length) return { text: source, cursor: Math.max(0, Math.min(source.length, start || 0)) };

  const insertionStart = Math.max(0, Math.min(source.length, Number.isFinite(start) ? start : source.length));
  const insertionEnd = Math.max(insertionStart, Math.min(source.length, Number.isFinite(end) ? end : insertionStart));
  const all = [...before, ...added];
  const markerTokens = added.map((_, offset) => composerAttachmentToken(all, before.length + offset));
  const markers = markerTokens.join(' ');
  const prefix = source.slice(0, insertionStart);
  const suffix = source.slice(insertionEnd);
  const leading = prefix && !/\s$/.test(prefix) ? ' ' : '';
  const inserted = `${leading}${markers}${suffix && !/^\s/.test(suffix) ? ' ' : ''}`;
  let markerStart = prefix.length + leading.length;
  const ranges = markerTokens.map((token) => {
    const range = { token, start: markerStart, end: markerStart + token.length };
    markerStart = range.end + 1;
    return range;
  });

  return {
    text: `${prefix}${inserted}${suffix}`,
    cursor: prefix.length + inserted.length,
    ranges
  };
}

function replaceOnce(text, search, replacement) {
  const index = text.indexOf(search);
  if (index < 0) return text;
  return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

function removeOnce(text, search) {
  const index = text.indexOf(search);
  if (index < 0) return text;
  let prefix = text.slice(0, index);
  let suffix = text.slice(index + search.length);
  if (!prefix && suffix.startsWith(' ')) suffix = suffix.slice(1);
  else if (!suffix && prefix.endsWith(' ')) prefix = prefix.slice(0, -1);
  else if (prefix.endsWith(' ') && suffix.startsWith(' ')) suffix = suffix.slice(1);
  return `${prefix}${suffix}`;
}

function removeAttachmentMarker(text, attachments, removedIndex) {
  const source = typeof text === 'string' ? text : '';
  const current = Array.isArray(attachments) ? attachments : [];
  if (removedIndex < 0 || removedIndex >= current.length) return source;

  const tokens = current.map((_, index) => `\uFFF9cas-attachment-${index}\uFFFB`);
  let result = source;
  current.forEach((_, index) => {
    result = replaceOnce(result, attachmentMarker(current, index), tokens[index]);
  });

  const remaining = current.filter((_, index) => index !== removedIndex);
  current.forEach((_, index) => {
    if (index === removedIndex) {
      result = removeOnce(result, tokens[index]);
      return;
    }
    const nextIndex = index < removedIndex ? index : index - 1;
    result = replaceOnce(result, tokens[index], attachmentMarker(remaining, nextIndex));
  });

  return result;
}

function ensureAttachmentMarkers(text, attachments) {
  let result = typeof text === 'string' ? text : '';
  const current = Array.isArray(attachments) ? attachments : [];
  current.forEach((_, index) => {
    result = replaceOnce(
      result,
      composerAttachmentToken(current, index),
      attachmentMarker(current, index)
    );
  });
  const missing = current
    .map((_, index) => attachmentMarker(current, index))
    .filter((marker) => !result.includes(marker));
  if (!missing.length) return result;
  return [result.trimEnd(), missing.join(' ')].filter(Boolean).join(' ');
}

// Presentation only: provider text stays unchanged, including unmatched markers.
function sentImageSegments(text, attachments = []) {
  const source = typeof text === 'string' ? text : '';
  const images = new Map();
  attachments.forEach((attachment, index) => {
    if (attachment.type === 'image') images.set(attachmentMarker(attachments, index), index);
  });
  const segments = [];
  let cursor = 0;
  for (const match of source.matchAll(/\[\[Image \d+\]\]/g)) {
    if (!images.has(match[0])) continue;
    if (match.index > cursor) segments.push({ text: source.slice(cursor, match.index) });
    segments.push({ attachmentIndex: images.get(match[0]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor) });
  return segments;
}

module.exports = {
  sentImageSegments,
  attachmentOrdinal,
  attachmentMarker,
  composerAttachmentToken,
  insertAttachmentMarkers,
  removeAttachmentMarker,
  ensureAttachmentMarkers
};
