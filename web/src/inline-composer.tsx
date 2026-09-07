'use dom';

import { useEffect, useRef, useState, type Ref } from 'react';
import { useDOMImperativeHandle, type DOMImperativeFactory } from 'expo/dom';
import { appendMobileAttachment, createMobileAttachment, MAX_MOBILE_ATTACHMENTS, MAX_MOBILE_FILE_BYTES, MAX_MOBILE_ATTACHMENTS_BYTES, type MobileAttachment } from './mobile-attachments';
import { attachmentOrdinal, readInlineComposer, type AttachmentPart, type InlineDraft } from './inline-attachments';

export interface InlineComposerRef {
  focus: () => void;
  blur: () => void;
  insert: (attachments: MobileAttachment[], editSingle?: boolean) => void;
  submit: (suffix?: string) => void;
}

export default function InlineComposer({ ref, label, placeholder, editable, desktop, native, color, accent, surface,
  onChange, onSubmit, onEdit, onError, onFocus, onReady,
}: {
  ref: Ref<InlineComposerRef>;
  dom?: import('expo/dom').DOMProps;
  label: string;
  placeholder: string;
  editable: boolean;
  desktop: boolean;
  native: boolean;
  color: string;
  accent: string;
  surface: string;
  onChange: (text: string, parts: AttachmentPart[], attachments: MobileAttachment[] | null) => Promise<void>;
  onSubmit: (text: string, attachments: MobileAttachment[]) => Promise<boolean>;
  onEdit: (attachment: MobileAttachment) => Promise<MobileAttachment | null>;
  onError: (message: string) => Promise<void>;
  onFocus: () => Promise<void>;
  onReady: () => Promise<InlineDraft>;
}) {
  const input = useRef<HTMLDivElement>(null);
  const catalog = useRef(new Map<string, MobileAttachment>());
  const savedRange = useRef<Range | null>(null);
  const editing = useRef(false);
  const sequence = useRef(0);
  const sending = useRef(false);
  const restoreFocusAfterSend = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastAttachments = useRef<MobileAttachment[]>([]);
  const [ready, setReady] = useState(false);
  const reportError = (message: string) => { setError(message); void onError(message); };
  const snapshot = () => readInlineComposer(input.current!, catalog.current);
  const remember = () => {
    // Native WebKit can change selection/focus behind the image editor.
    if (editing.current) return;
    const selection = window.getSelection();
    if (selection?.rangeCount && input.current?.contains(selection.anchorNode) && input.current.contains(selection.focusNode)) {
      savedRange.current = selection.getRangeAt(0).cloneRange();
    }
  };
  const range = () => {
    const root = input.current!;
    const current = savedRange.current;
    if (current && root.contains(current.startContainer) && root.contains(current.endContainer)) {
      const next = current.cloneRange();
      const start = (next.startContainer instanceof Element ? next.startContainer : next.startContainer.parentElement)?.closest('[data-attachment]');
      const end = (next.endContainer instanceof Element ? next.endContainer : next.endContainer.parentElement)?.closest('[data-attachment]');
      if (start) next.setStartBefore(start);
      if (end) next.setEndAfter(end);
      return next;
    }
    const next = document.createRange();
    next.selectNodeContents(root);
    next.collapse(false);
    if (root.lastChild instanceof HTMLElement && root.lastChild.dataset.tail) next.setStartBefore(root.lastChild);
    next.collapse(true);
    return next;
  };
  const select = (next: Range) => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(next);
    savedRange.current = next.cloneRange();
  };
  const publish = () => {
    const root = input.current!;
    // Undo can restore an older layout-only tail alongside the current one.
    root.querySelectorAll('[data-tail]').forEach((tail) => { if (tail !== root.lastChild) tail.remove(); });
    if (!(root.lastChild instanceof HTMLElement && root.lastChild.dataset.tail)) {
      const tail = document.createElement('br');
      tail.dataset.tail = 'true';
      root.append(tail);
    }
    const draft = snapshot();
    root.dataset.empty = String(!draft.text);
    root.querySelectorAll<HTMLElement>('[data-attachment]').forEach((node) => {
      const index = draft.ids.indexOf(node.dataset.attachment!);
      if (index < 0) { node.remove(); return; }
      const number = node.querySelector('[data-number]')!;
      const ordinal = String(attachmentOrdinal(draft.attachments, index));
      if (number.textContent !== ordinal) number.textContent = ordinal;
    });
    // Retain bytes for browser undo, bounded by the existing draft byte budget.
    let retainedBytes = [...catalog.current.values()].reduce((sum, item) => sum + item.sizeBytes, 0);
    for (const [id, item] of catalog.current) {
      if (retainedBytes <= MAX_MOBILE_ATTACHMENTS_BYTES) break;
      if (!draft.ids.includes(id)) { catalog.current.delete(id); retainedBytes -= item.sizeBytes; }
    }
    remember();
    const changed = draft.attachments.length !== lastAttachments.current.length
      || draft.attachments.some((attachment, index) => attachment !== lastAttachments.current[index]);
    lastAttachments.current = draft.attachments;
    void onChange(draft.plainText, draft.parts, changed ? draft.attachments : null);
  };
  const selectAfter = (node: Node, textCaret = true) => {
    const next = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) next.setStart(node, node.textContent!.length);
    else if (textCaret) {
      // WebKit paints a caret at the left edge for an element-only boundary.
      // Keep it in real text after the atom; submission trims the trailing space.
      if (node.nextSibling?.nodeType !== Node.TEXT_NODE) node.parentNode!.insertBefore(document.createTextNode(' '), node.nextSibling);
      const text = node.nextSibling!;
      if (!text.textContent) text.textContent = ' ';
      next.setStart(text, 0);
    } else next.setStartAfter(node);
    next.collapse(true);
    select(next);
  };
  const insertNode = (node: Node, textCaret = true) => {
    const next = range();
    next.deleteContents();
    next.insertNode(node);
    selectAfter(node, textCaret);
  };
  const edit = async (id: string) => {
    const attachment = catalog.current.get(id);
    if (!attachment || attachment.type !== 'image') return;
    remember();
    const chip = input.current!.querySelector<HTMLElement>(`[data-attachment="${id}"]`)!;
    const atom = document.createRange();
    atom.selectNode(chip);
    const current = range();
    // iOS selects the atom when tapping its preview. Editing is not replacement.
    if (current.compareBoundaryPoints(Range.START_TO_START, atom) === 0
      && current.compareBoundaryPoints(Range.END_TO_END, atom) === 0) selectAfter(chip);
    editing.current = true;
    input.current?.blur();
    const updated = await onEdit(attachment);
    if (!updated || !catalog.current.has(id)) return;
    try {
      appendMobileAttachment(snapshot().attachments.filter((item) => item !== attachment), createMobileAttachment(updated));
      catalog.current.set(id, updated);
      chip.querySelector('img')!.src = updated.dataUrl;
      chip.title = updated.name;
      chip.querySelector('.cas-inline-preview')!.setAttribute('aria-label', `Edit ${updated.name}`);
      chip.querySelector('.cas-inline-remove')!.setAttribute('aria-label', `Remove ${updated.name}`);
      publish();
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not update the image'); }
  };
  const insert = (items: MobileAttachment[], editSingle = false, restoring = false) => {
    if (!restoring && (!editable || sending.current)) return;
    setError('');
    let inserted = '';
    for (const item of items) {
      try {
        const attachment = createMobileAttachment(item);
        const selection = range();
        const draft = snapshot();
        const retained = draft.attachments.filter((_, index) => selection.collapsed
          || !selection.intersectsNode(input.current!.querySelector(`[data-attachment="${draft.ids[index]}"]`)!));
        appendMobileAttachment(retained, attachment);
        const id = String(++sequence.current);
        const chip = document.createElement('span');
        chip.className = 'cas-inline-attachment';
        chip.contentEditable = 'false';
        chip.dataset.attachment = id;
        chip.title = attachment.name;
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'cas-inline-preview';
        const video = attachment.mimeType.startsWith('video/');
        preview.setAttribute('aria-label', `${attachment.type === 'image' ? 'Edit' : video ? 'Video' : 'File'} ${attachment.name}`);
        if (attachment.type === 'image') {
          const image = document.createElement('img');
          image.src = attachment.dataUrl;
          image.alt = '';
          image.draggable = false;
          preview.append(image);
          preview.onclick = () => { void edit(id); };
        } else {
          preview.textContent = video ? '▶' : attachment.type === 'audio' ? '♪' : '▤';
          preview.onclick = () => { window.alert(attachment.name); };
        }
        const number = document.createElement('span');
        number.dataset.number = 'true';
        number.className = 'cas-inline-number';
        preview.append(number);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'cas-inline-remove';
        remove.setAttribute('aria-label', `Remove ${attachment.name}`);
        remove.textContent = '×';
        remove.onclick = (event) => { event.stopPropagation(); chip.remove(); publish(); };
        chip.append(preview, remove);
        // Save bytes only once, outside the editable DOM and its clipboard HTML.
        catalog.current.set(id, attachment);
        insertNode(chip, !restoring);
        inserted = id;
      } catch (error) { reportError(error instanceof Error ? error.message : 'Could not attach the file'); break; }
    }
    if (!restoring) publish();
    if (editSingle && items.length === 1 && inserted) void edit(inserted);
  };
  const submit = async (suffix = '') => {
    if (!editable || sending.current) return;
    const draft = snapshot();
    const text = [draft.text.trimEnd(), suffix].filter(Boolean).join(' ');
    if (!text.trim() && !draft.attachments.length) return;
    restoreFocusAfterSend.current = !native && document.activeElement === input.current;
    sending.current = true;
    setBusy(true);
    // Consume the DOM draft before crossing the native bridge or saving the outbox.
    // Keep the actual nodes (including attachment handlers) for a rejected send.
    const nodes = Array.from(input.current!.childNodes);
    const selection = savedRange.current;
    input.current!.replaceChildren();
    savedRange.current = null;
    publish();
    if (native) input.current!.blur();
    let accepted = false;
    try {
      accepted = await onSubmit(text, draft.attachments);
      if (accepted) catalog.current.clear();
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not queue the message'); }
    finally {
      if (!accepted) {
        input.current!.replaceChildren(...nodes);
        savedRange.current = selection;
        publish();
      }
      sending.current = false;
      setBusy(false);
    }
  };
  // Expo's bridge type accepts any JSON argument; this component exposes the
  // narrower, serializable attachment API to its native caller.
  useDOMImperativeHandle(ref as Ref<DOMImperativeFactory>, () => ({
    focus: () => { const next = range(); input.current?.focus(); select(next); editing.current = false; },
    blur: () => { remember(); input.current?.blur(); },
    insert: (items, editSingle) => insert(items as MobileAttachment[], editSingle === true),
    submit: (suffix) => { void submit(typeof suffix === 'string' ? suffix : ''); },
  }));
  useEffect(() => {
    let mounted = true;
    void onReady().then((draft) => {
      if (!mounted) return;
      for (const part of draft.parts) {
        if ('text' in part) insertNode(document.createTextNode(part.text));
        else if (draft.attachments[part.index]) insert([draft.attachments[part.index]], false, true);
      }
      const last = draft.parts[draft.parts.length - 1];
      if (last && 'index' in last) {
        const text = document.createTextNode(' ');
        insertNode(text);
        const next = range(); next.setStart(text, 0); next.collapse(true); select(next);
      }
      publish();
      setReady(true);
    });
    document.addEventListener('selectionchange', remember);
    return () => { mounted = false; document.removeEventListener('selectionchange', remember); };
  }, []);
  useEffect(() => {
    if (ready && desktop) input.current?.focus();
  }, [ready, desktop]);
  useEffect(() => {
    const root = input.current!;
    // React's beforeInput polyfill does not expose WebKit's native inputType.
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault(); remember(); select(range());
        document.execCommand('insertHTML', false, '\n');
        publish();
        // Synchronize iOS's keyboard caret with the DOM position after the newline.
        if (native) select(range());
      }
      if (event.inputType === 'deleteContentBackward') {
        remember();
        const next = range();
        if (!next.collapsed || (next.startContainer.nodeType === Node.TEXT_NODE && next.startOffset > 0)) return;
        let node = next.startContainer;
        let previous: Node | null = node.childNodes[next.startOffset - 1] || null;
        while (!previous && node !== root) { previous = node.previousSibling; node = node.parentNode!; }
        while (previous?.nodeType === Node.TEXT_NODE && !previous.textContent) previous = previous.previousSibling;
        // iOS can move the caret across a noneditable attachment without deleting it.
        if (previous instanceof HTMLElement && previous.dataset.attachment) {
          event.preventDefault();
          next.selectNode(previous); select(next);
          document.execCommand('delete'); publish();
        }
      }
    };
    root.addEventListener('beforeinput', beforeInput);
    return () => root.removeEventListener('beforeinput', beforeInput);
  });
  useEffect(() => {
    if (busy || !restoreFocusAfterSend.current) return;
    restoreFocusAfterSend.current = false;
    // Restore only after React has made the editor focusable again.
    if (input.current && (document.activeElement === document.body || document.activeElement === input.current)) {
      input.current.focus();
      select(range());
    }
  }, [busy]);
  const pasteFiles = async (files: File[]) => {
    remember();
    const insertionRange = range();
    try {
      const items: MobileAttachment[] = [];
      for (const file of files.slice(0, MAX_MOBILE_ATTACHMENTS)) {
        if (file.size > MAX_MOBILE_FILE_BYTES) throw new Error('Attachment is too large. Keep it under 20 MB.');
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
          reader.readAsDataURL(file);
        });
        const attachment = createMobileAttachment({ name: file.name, type: file.type.startsWith('image/') ? 'image' : 'file', mimeType: file.type || 'application/octet-stream', dataUrl });
        appendMobileAttachment(items, attachment);
        items.push(attachment);
      }
      savedRange.current = insertionRange;
      insert(items, items.length === 1 && !snapshot().attachments.length);
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not paste the file'); }
  };
  return <>
    <style>{`
      html, body { margin: 0; padding: 0; background: transparent; }
      .cas-inline-composer { box-sizing: border-box; min-width: 0; width: 100%; min-height: ${desktop ? 68 : 42}px; max-height: 140px; padding: ${desktop ? '16px' : '10px 7px'}; overflow-y: auto; font: 16px/normal -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: ${color}; white-space: pre-wrap; overflow-wrap: anywhere; outline: none; caret-color: ${accent}; }
      .cas-inline-composer[data-empty="true"]::before { content: attr(data-placeholder); color: ${color}; opacity: .45; pointer-events: none; position: absolute; }
      .cas-inline-attachment { display: inline-block; position: relative; vertical-align: middle; width: 36px; height: 28px; margin: 0 4px; user-select: all; }
      .cas-inline-attachment button { padding: 0; cursor: pointer; font: inherit; color: ${accent}; background: ${surface}; border: 1px solid ${accent}; }
      .cas-inline-preview { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; overflow: hidden; line-height: 1 !important; }
      .cas-inline-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .cas-inline-number { position: absolute; bottom: 0; right: 4px; min-width: 12px; padding: 0 1px; border-radius: 8px; font-size: 10px; line-height: 12px; color: ${surface}; background: ${accent}; }
      .cas-inline-remove { position: absolute; right: 0; top: -3px; width: 14px; height: 14px; border-radius: 50%; font-size: 12px !important; line-height: 10px !important; }
      .cas-inline-remove::after { content: ''; position: absolute; inset: -5px; }
      .cas-inline-attachment button:focus-visible { outline: 2px solid ${accent}; outline-offset: 2px; }
    `}</style>
    {error ? <div role="alert" style={{ padding: '4px 7px', font: '12px/16px sans-serif', color }}>{error}</div> : null}
    <div ref={input} className="cas-inline-composer" role="textbox" aria-label={label} aria-multiline="true"
      data-placeholder={placeholder} contentEditable={ready && editable && !busy} suppressContentEditableWarning
      onFocus={() => { void onFocus(); }} onInput={publish}
      onKeyDown={(event) => {
        if (!native && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }}
      onPaste={(event) => {
        event.preventDefault(); remember();
        const files = Array.from(event.clipboardData.files);
        if (files.length) { void pasteFiles(files); return; }
        insertNode(document.createTextNode(event.clipboardData.getData('text/plain'))); publish();
      }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void pasteFiles(Array.from(event.dataTransfer.files)); } }}
    />
  </>;
}
