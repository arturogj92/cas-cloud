const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CHAT_ATTACHMENTS = 8;
const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_AUDIO_BYTES = 20 * 1024 * 1024;
const DATA_URL_HEADER_PATTERN = /^data:((?:image|audio)\/[a-z0-9.+-]+);base64$/i;

const MEDIA_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/x-m4a': '.m4a'
};

/**
 * The file extension for an image mime type.
 *
 * Derived from the subtype rather than looked up in a closed map: a photo
 * picked from the macOS library arrives as `image/heic`, and a map covering
 * only png/jpeg/webp/gif wrote those bytes to a `.png`, handing the agent a
 * file whose extension lies about its contents. The subtype is already
 * constrained to `[a-z0-9.+-]` by DATA_URL_HEADER_PATTERN, so it is a safe
 * file name; only the two irregular spellings need the map.
 *
 * @param {string} mimeType
 * @returns {string}
 */
function mediaExtension(mimeType) {
  if (MEDIA_EXTENSIONS[mimeType]) return MEDIA_EXTENSIONS[mimeType];
  const subtype = String(mimeType || '').split('/')[1];
  return subtype ? `.${subtype.replace(/\+xml$/, '')}` : '.bin';
}

function safeAttachmentName(value, fallback, maxBytes = 255) {
  const basename = typeof value === 'string'
    ? path.posix.basename(value.trim().replace(/\\/g, '/'))
    : '';
  const name = (basename || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '') || fallback;
  const encoded = Buffer.from(name);
  return encoded.length <= maxBytes
    ? name
    : encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/g, '');
}

function parseMediaDataUrl(dataUrl, includeBase64 = false) {
  if (typeof dataUrl !== 'string') return null;

  const separator = dataUrl.indexOf(',');
  if (separator < 0 || separator > 128) return null;

  const header = dataUrl.slice(0, separator).match(DATA_URL_HEADER_PATTERN);
  if (!header) return null;

  let encodedLength = 0;
  let padding = 0;
  let sawPadding = false;

  // Validate in a loop instead of matching the full payload with a regular
  // expression. Very large data URLs can otherwise overflow V8's regexp stack
  // before we get a chance to enforce the image size limit.
  for (let index = separator + 1; index < dataUrl.length; index += 1) {
    const code = dataUrl.charCodeAt(index);
    const whitespace = code === 9 || code === 10 || code === 13 || code === 32;
    if (whitespace) continue;

    if (code === 61) {
      sawPadding = true;
      padding += 1;
      encodedLength += 1;
      if (padding > 2) return null;
      continue;
    }

    const alphaNumeric = (
      (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    );
    if (!alphaNumeric && code !== 43 && code !== 47) return null;
    if (sawPadding) return null;
    encodedLength += 1;
  }

  if (encodedLength === 0 || encodedLength % 4 === 1) return null;

  const sizeBytes = Math.floor((encodedLength * 3) / 4) - padding;
  return {
    mimeType: header[1].toLowerCase(),
    sizeBytes,
    base64: includeBase64
      ? dataUrl.slice(separator + 1).replace(/\s/g, '')
      : null
  };
}

/**
 * Validate and copy renderer-provided attachments before they reach a driver.
 * Images travel as data URLs so every provider can receive the same payload;
 * ordinary files stay local and are represented by an absolute path.
 */
function normalizeChatAttachments(input) {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`You can attach up to ${MAX_CHAT_ATTACHMENTS} files per message`);
  }

  return input.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      throw new Error('Invalid chat attachment');
    }

    if (attachment.type === 'image' || attachment.type === 'audio') {
      const parsed = parseMediaDataUrl(attachment.dataUrl);
      if (!parsed || !parsed.mimeType.startsWith(`${attachment.type}/`)) {
        throw new Error(`Invalid ${attachment.type} attachment`);
      }

      const maximum = attachment.type === 'image' ? MAX_CHAT_IMAGE_BYTES : MAX_CHAT_AUDIO_BYTES;
      if (parsed.sizeBytes > maximum) {
        throw new Error(`${attachment.type === 'image' ? 'Images' : 'Audio files'} must be ${maximum / (1024 * 1024)} MB or smaller`);
      }
      return {
        type: attachment.type,
        name: safeAttachmentName(attachment.name, attachment.type),
        mimeType: parsed.mimeType,
        sizeBytes: parsed.sizeBytes,
        ...(attachment.type === 'audio' && Number.isFinite(attachment.durationMs)
          ? { durationMs: Math.max(0, attachment.durationMs) }
          : {}),
        dataUrl: attachment.dataUrl
      };
    }

    if (attachment.type === 'file') {
      const filePath = typeof attachment.path === 'string'
        ? attachment.path.trim()
        : '';
      if (!filePath || !path.isAbsolute(filePath)) {
        throw new Error('Attached files must have a readable local path');
      }
      return {
        type: 'file',
        name: safeAttachmentName(attachment.name || filePath, 'file'),
        path: filePath,
        mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : '',
        sizeBytes: Number.isFinite(attachment.sizeBytes)
          ? Math.max(0, attachment.sizeBytes)
          : 0,
        ...(attachment.transient === true ? { transient: true } : {})
      };
    }

    throw new Error('Unsupported chat attachment type');
  });
}

/** Convert native provider image blocks into the canonical chat attachment shape. */
function contentImageAttachments(content) {
  if (!Array.isArray(content)) return [];

  const attachments = [];
  for (const block of content) {
    if (attachments.length === MAX_CHAT_ATTACHMENTS) break;
    if (!block || !['image', 'input_image'].includes(block.type)) continue;

    const source = block.source && typeof block.source === 'object' ? block.source : {};
    const mimeType = typeof block.mimeType === 'string'
      ? block.mimeType
      : source.type === 'base64' && typeof source.media_type === 'string'
        ? source.media_type
        : '';
    const base64 = typeof block.data === 'string'
      ? block.data
      : source.type === 'base64' && typeof source.data === 'string'
        ? source.data
        : '';
    const dataUrl = typeof block.url === 'string'
      ? block.url
      : typeof block.image_url === 'string'
        ? block.image_url
        : mimeType && base64
          ? `data:${mimeType};base64,${base64}`
          : '';
    if (!dataUrl) continue;

    try {
      attachments.push(normalizeChatAttachments([{
        type: 'image',
        name: block.name || `Image ${attachments.length + 1}`,
        dataUrl
      }])[0]);
    } catch (_) {
      // Invalid provider history is ignored just like any other malformed item.
    }
  }
  return attachments;
}

function splitDataUrl(dataUrl) {
  const parsed = parseMediaDataUrl(dataUrl, true);
  if (!parsed) return null;
  return {
    mimeType: parsed.mimeType,
    base64: parsed.base64
  };
}

function fileReferenceText(attachments) {
  const files = (attachments || []).filter((attachment) => attachment.type === 'file');
  if (!files.length) return '';
  return [
    'Attached local files:',
    ...files.map((file) => `- ${file.path}`)
  ].join('\n');
}

function promptWithFileReferences(text, attachments) {
  const prompt = typeof text === 'string' ? text.trim() : '';
  const references = fileReferenceText(attachments);
  return [prompt, references].filter(Boolean).join('\n\n');
}

/** A private directory for image attachments the caller must clean up itself. */
function createChatImageDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cas-chat-images-'));
}

/**
 * Write media attachments to disk and return them as `file` attachments.
 *
 * Some channels cannot carry an image at all: a print-mode CLI has no inline
 * image payload, and a structured answer travels as plain strings for every
 * provider. Both then reference an absolute path the agent reads itself.
 *
 * @param {Array<Object>} attachments Mixed attachments; non-images pass through.
 * @param {string} directory Where the files are written.
 * @returns {Array<Object>} File attachments, in the input order.
 */
function materializeChatImages(attachments, directory) {
  return (attachments || []).map((attachment, index) => {
    if (attachment.type !== 'image' && attachment.type !== 'audio') return attachment;
    const decoded = splitDataUrl(attachment.dataUrl);
    if (!decoded) throw new Error(`Could not read ${attachment.name}`);
    const extension = mediaExtension(decoded.mimeType);
    const filePath = path.join(
      directory,
      `${Date.now()}-${index}-${crypto.randomUUID()}${extension}`
    );
    fs.writeFileSync(filePath, Buffer.from(decoded.base64, 'base64'));
    return {
      type: 'file',
      name: attachment.name,
      path: filePath,
      mimeType: decoded.mimeType,
      sizeBytes: attachment.sizeBytes
    };
  });
}

/**
 * Fold attachments into a structured answer as extra text values.
 *
 * A question's answers are strings on every provider — Claude comma-joins them,
 * ACP joins them, Codex forwards the array, and Codex drops the comment
 * entirely. So there is no field an image could ride in, and the path is the
 * payload: the agent opens the file itself.
 *
 * The references land on the first answered question because the attachment is
 * made once per card, not once per question; repeating it on every question
 * would say the same thing N times to the model.
 *
 * @param {Object<string, {values: string[], note?: string}>} answers
 * @param {Array<Object>} attachments Already materialized (`file`) attachments.
 * @returns {Object<string, {values: string[], note?: string}>} A new answers map.
 */
function answersWithAttachmentReferences(answers, attachments) {
  const files = (attachments || []).filter((attachment) => attachment && attachment.path);
  if (!files.length) return answers;

  const entries = Object.entries(answers || {});
  const target = entries.find(([, entry]) => Array.isArray(entry?.values) && entry.values.length);
  if (!target) return answers;

  // The name is carried alongside the path because the file on disk is named
  // for uniqueness, not for reading: both the model and the resolved card want
  // "shot.png", not "1754…-0-<uuid>.png".
  const references = files.map((file) => {
    const kind = file.mimeType && file.mimeType.startsWith('image/') ? 'image' : 'file';
    return `Attached ${kind} "${file.name}" at ${file.path}`;
  });
  const [targetId, targetEntry] = target;
  return {
    ...answers,
    [targetId]: { ...targetEntry, values: [...targetEntry.values, ...references] }
  };
}

module.exports = {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_AUDIO_BYTES,
  safeAttachmentName,
  normalizeChatAttachments,
  contentImageAttachments,
  splitDataUrl,
  fileReferenceText,
  promptWithFileReferences,
  createChatImageDirectory,
  materializeChatImages,
  answersWithAttachmentReferences
};
