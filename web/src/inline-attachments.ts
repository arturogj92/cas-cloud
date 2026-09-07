import type { MobileAttachment } from './mobile-attachments';

// Use the same per-type numbering as Desktop and the provider-facing prompt.
const { attachmentMarker, attachmentOrdinal } = require('../shared/chat-attachment-markers');
export { attachmentMarker, attachmentOrdinal };

export type AttachmentPart = { text: string } | { index: number };
export type InlineDraft = { parts: AttachmentPart[]; attachments: MobileAttachment[] };

export function attachmentMessageParts(text: string, attachments: Array<{ type: string }>): AttachmentPart[] {
  const parts: AttachmentPart[] = [];
  const markers = new Map(attachments.map((_, index) => [attachmentMarker(attachments, index), index]));
  const used = new Set<number>();
  let cursor = 0;
  for (const match of text.matchAll(/\[\[(?:Image|File|Audio) \d+\]\]/g)) {
    const index = markers.get(match[0]);
    if (index === undefined || used.has(index)) continue;
    if (match.index! > cursor) parts.push({ text: text.slice(cursor, match.index) });
    parts.push({ index });
    used.add(index);
    cursor = match.index! + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  // Older clients sent attachments without inline markers; never hide those.
  attachments.forEach((_, index) => {
    if (!used.has(index)) parts.push({ index });
  });
  return parts;
}

export function readInlineComposer(root: HTMLElement, catalog: Map<string, MobileAttachment>) {
  const attachments: MobileAttachment[] = [];
  const ids: string[] = [];
  let text = '';
  let plainText = '';
  const parts: AttachmentPart[] = [];
  const append = (value: string) => {
    text += value; plainText += value;
    const last = parts[parts.length - 1];
    if (last && 'text' in last) last.text += value;
    else if (value) parts.push({ text: value });
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) { append(node.textContent || ''); return; }
    if (!(node instanceof HTMLElement) || node.dataset.tail) return;
    const id = node.dataset.attachment;
    if (id) {
      const attachment = catalog.get(id);
      if (!attachment || ids.includes(id)) return;
      ids.push(id);
      attachments.push(attachment);
      parts.push({ index: attachments.length - 1 });
      text += attachmentMarker(attachments, attachments.length - 1);
      return;
    }
    if (node.tagName === 'BR') { append('\n'); return; }
    if ((node.tagName === 'DIV' || node.tagName === 'P') && text && !text.endsWith('\n')) append('\n');
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return { text, plainText, attachments, ids, parts };
}
