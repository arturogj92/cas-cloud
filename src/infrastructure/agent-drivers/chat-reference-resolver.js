/**
 * Main-process resolver for explicit local references in Chat Markdown.
 *
 * Image/source previews receive only a local path hint. Source files stay
 * inside the active driver's cwd. Images may also come from the system temp
 * directory because agents place visual evidence there; every root and target
 * is still realpathed, containment is checked after symlink resolution, and
 * the bounded read happens through an opened file handle. HTML launching is a
 * separate, absolute-path action that validates a regular .html/.htm file and
 * passes its canonical path to the system's default browser without reading
 * it. Every failure is a small fallback object, never an IPC exception or an
 * unbounded filesystem disclosure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MAX_CHAT_IMAGE_BYTES } = require('./chat-attachments');

const MAX_CHAT_REFERENCE_IMAGE_BYTES = MAX_CHAT_IMAGE_BYTES;
const MAX_CHAT_REFERENCE_SOURCE_BYTES = 512 * 1024;
const MAX_CHAT_REFERENCE_EXCERPT_LINES = 12;
const MAX_CHAT_REFERENCE_EXCERPT_BYTES = 8 * 1024;

const IMAGE_FORMATS = Object.freeze({
  '.png': { mimeType: 'image/png', magic: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  '.jpg': { mimeType: 'image/jpeg', magic: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  '.jpeg': { mimeType: 'image/jpeg', magic: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  '.webp': { mimeType: 'image/webp', magic: (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
  '.gif': { mimeType: 'image/gif', magic: (bytes) => bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') }
});

function baseResult(reference, reason = 'unavailable') {
  return {
    success: false,
    kind: reference && ['source', 'html', 'file'].includes(reference.kind) ? reference.kind : 'image',
    path: typeof reference?.path === 'string' ? reference.path : '',
    ...(Number.isSafeInteger(reference?.line) ? { line: reference.line } : {}),
    ...(Number.isSafeInteger(reference?.column) ? { column: reference.column } : {}),
    reason
  };
}

function isAbsoluteFilesystemPath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

async function openInDefaultBrowser(targetPath) {
  const { shell } = require('electron');
  const error = await shell.openPath(targetPath);
  if (error) throw new Error(error);
  return { success: true };
}

function hasUnsupportedScheme(value) {
  return /^(?:[a-z][a-z0-9+.-]*):\/\//i.test(value)
    || /^(?:javascript|data|mailto|file):/i.test(value)
    || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value));
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Resolve and realpath one target below a session root.
 * @param {string} root
 * @param {string} requested
 * @returns {Promise<{root: string, target: string}|null>}
 */
async function resolveContainedTarget(root, requested) {
  if (typeof root !== 'string' || !root.trim() || typeof requested !== 'string') return null;
  const value = requested.trim();
  if (!value || /[\u0000\r\n]/.test(value) || hasUnsupportedScheme(value)) return null;
  try {
    const realRoot = await fs.promises.realpath(root);
    const candidate = path.resolve(realRoot, value);
    const realTarget = await fs.promises.realpath(candidate);
    if (!isContained(realRoot, realTarget)) return null;
    return { root: realRoot, target: realTarget };
  } catch (_) {
    return null;
  }
}

/**
 * Read a bounded regular file from a handle. The size check happens before
 * allocation and a second cap check protects against a file growing between
 * stat and read.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer|null>}
 */
async function readBoundedFile(filePath, maxBytes) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const result = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const read = await handle.read(result, offset, result.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== result.length || offset > maxBytes) return null;
    return result;
  } catch (_) {
    return null;
  } finally {
    try { await handle?.close(); } catch (_) { /* best effort */ }
  }
}

function decodeUtf8(buffer) {
  if (!buffer || buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return null;
  }
}

function uniqueRoots(values) {
  const seen = new Set();
  const roots = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const key = value;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(value);
  }
  return roots;
}

function grokSessionEncodings(root) {
  const encodings = new Set();
  for (const value of [root, path.resolve(root || '.')]) {
    if (typeof value !== 'string' || !value) continue;
    encodings.add(encodeURIComponent(value));
    encodings.add(encodeURIComponent(value.replace(/\\/g, '/')));
  }
  return [...encodings];
}

/**
 * Grok (and other xAI session tools) write generated rasters under
 * `~/.grok/sessions/<urlencoded-cwd>/<session-id>/images/N.jpg`, not the
 * Chat session cwd. Image resolution may look there after the project root.
 * @param {string} root
 * @param {string} [home]
 * @returns {Promise<string[]>}
 */
async function grokSessionImageRoots(root, home) {
  const homedir = typeof home === 'string' && home.trim() ? home : os.homedir();
  const sessionsRoot = path.join(homedir, '.grok', 'sessions');
  const ranked = [];
  for (const encoded of grokSessionEncodings(root)) {
    const cwdRoot = path.join(sessionsRoot, encoded);
    let entries;
    try {
      entries = await fs.promises.readdir(cwdRoot, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(cwdRoot, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.promises.stat(sessionDir)).mtimeMs;
      } catch (_) { /* newest-first ranking is best-effort */ }
      ranked.push({ sessionDir, mtimeMs });
    }
  }
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ranked.map((entry) => entry.sessionDir);
}

function displayRelativePath(primaryRoot, contained, requested) {
  if (contained.root && isContained(contained.root, contained.target)
    && primaryRoot && isContained(primaryRoot, contained.target)) {
    return path.relative(primaryRoot, contained.target).split(path.sep).join('/');
  }
  const requestedPath = typeof requested === 'string' ? requested.trim() : '';
  if (requestedPath && !isAbsoluteFilesystemPath(requestedPath)) {
    return requestedPath.replace(/\\/g, '/');
  }
  return path.basename(contained.target);
}

async function resolveImage(root, reference, options = {}) {
  const fallback = (reason) => baseResult(reference, reason);
  const extraRoots = Array.isArray(options.extraRoots) ? options.extraRoots : [];
  const temporaryRoots = isAbsoluteFilesystemPath(reference.path)
    ? (Array.isArray(options.temporaryRoots)
        ? options.temporaryRoots
        : [os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])])
    : [];
  const grokRoots = await grokSessionImageRoots(root, options.homedir);
  const roots = uniqueRoots([
    root,
    ...extraRoots,
    ...temporaryRoots,
    ...grokRoots
  ]);
  let lastReason = 'outside-root-or-missing';
  for (const candidateRoot of roots) {
    const contained = await resolveContainedTarget(candidateRoot, reference.path);
    if (!contained) continue;
    const extension = path.extname(contained.target).toLowerCase();
    const format = IMAGE_FORMATS[extension];
    if (!format) {
      lastReason = 'unsupported-image';
      continue;
    }
    const bytes = await readBoundedFile(contained.target, MAX_CHAT_REFERENCE_IMAGE_BYTES);
    if (!bytes) {
      lastReason = 'missing-or-oversized';
      continue;
    }
    if (!format.magic(bytes)) {
      lastReason = 'mime-mismatch';
      continue;
    }
    let primaryReal = root;
    try {
      if (typeof root === 'string' && root.trim()) primaryReal = await fs.promises.realpath(root);
    } catch (_) { /* display path falls back to the requested hint */ }
    return {
      success: true,
      kind: 'image',
      path: reference.path,
      relativePath: displayRelativePath(primaryReal, contained, reference.path),
      mimeType: format.mimeType,
      sizeBytes: bytes.length,
      dataUrl: `data:${format.mimeType};base64,${bytes.toString('base64')}`
    };
  }
  return fallback(lastReason);
}

async function resolveSource(root, reference) {
  const fallback = (reason) => baseResult(reference, reason);
  const contained = await resolveContainedTarget(root, reference.path);
  if (!contained) return fallback('outside-root-or-missing');
  const bytes = await readBoundedFile(contained.target, MAX_CHAT_REFERENCE_SOURCE_BYTES);
  if (!bytes) return fallback('missing-or-oversized');
  const text = decodeUtf8(bytes);
  if (text === null) return fallback('binary-or-invalid-utf8');
  const lines = text.split(/\r?\n/);
  const requestedLine = reference.line === undefined ? 1 : reference.line;
  const requestedColumn = reference.column;
  if (!Number.isSafeInteger(requestedLine) || requestedLine < 1 || requestedLine > lines.length) {
    return fallback('invalid-line');
  }
  if (requestedColumn !== undefined && (!Number.isSafeInteger(requestedColumn) || requestedColumn < 1)) {
    return fallback('invalid-column');
  }
  const startLine = Math.max(1, requestedLine - Math.floor((MAX_CHAT_REFERENCE_EXCERPT_LINES - 1) / 2));
  const endLine = Math.min(lines.length, startLine + MAX_CHAT_REFERENCE_EXCERPT_LINES - 1);
  const excerpt = lines.slice(startLine - 1, endLine).join('\n').slice(0, MAX_CHAT_REFERENCE_EXCERPT_BYTES);
  return {
    success: true,
    kind: 'source',
    path: reference.path,
    relativePath: path.relative(contained.root, contained.target).split(path.sep).join('/'),
    line: reference.line,
    ...(requestedColumn !== undefined ? { column: requestedColumn } : {}),
    startLine,
    endLine,
    totalLines: lines.length,
    excerpt,
    ...(reference.includeContent === true ? { content: text } : {})
  };
}

/**
 * Validate and open one absolute HTML reference in the system's default
 * browser. Unlike previews, this action does not read file contents; the main
 * process only accepts an existing regular .html/.htm file before opening it.
 * @param {{reference?: Object}} options
 * @param {Object} [reference]
 * @returns {Promise<Object>}
 */
async function openChatHtmlReference(options = {}, reference) {
  const input = reference || options.reference || options;
  const normalized = input && typeof input === 'object' ? input : {};
  const fallback = (reason) => baseResult({ ...normalized, kind: 'html' }, reason);
  if (normalized.kind !== 'html' || typeof normalized.path !== 'string') {
    return fallback('invalid-reference');
  }
  const requested = normalized.path.trim();
  if (!requested || /[\u0000\r\n]/.test(requested) || !isAbsoluteFilesystemPath(requested)) {
    return fallback('invalid-path');
  }
  let targetPath;
  try {
    targetPath = await fs.promises.realpath(requested);
    const extension = path.extname(targetPath).toLowerCase();
    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile() || !['.html', '.htm'].includes(extension)) return fallback('invalid-html-file');
    // Launch the canonical target returned by realpath. This keeps the
    // validation and the process launch on the same non-symlink path, so a
    // link swap cannot redirect the browser to a different file after validation.
    await module.exports.openInDefaultBrowser(targetPath);
  } catch (_) {
    return fallback('open-failed');
  }
  return {
    success: true,
    kind: 'html',
    path: normalized.path,
    targetPath
  };
}

/** Validate and open a cited file contained by the live Chat session root. */
async function openChatFileReference(options = {}, reference) {
  const input = reference || options.reference || options;
  const root = options.root || options.cwd || options.projectRoot;
  const normalized = input && typeof input === 'object' ? input : {};
  const fallback = (reason) => baseResult({ ...normalized, kind: 'file' }, reason);
  if (normalized.kind !== 'file' || typeof normalized.path !== 'string') {
    return fallback('invalid-reference');
  }
  const contained = await resolveContainedTarget(root, normalized.path);
  if (!contained) return fallback('outside-root-or-missing');
  try {
    const stat = await fs.promises.stat(contained.target);
    if (!stat.isFile()) return fallback('invalid-file');
    await module.exports.openInDefaultBrowser(contained.target);
  } catch (_) {
    return fallback('open-failed');
  }
  return { success: true, kind: 'file', path: normalized.path, targetPath: contained.target };
}

/**
 * Resolve an image or source reference against a session's effective cwd.
 * @param {{root?: string, cwd?: string, projectRoot?: string, reference?: Object}} options
 * @param {Object} [reference]
 * @returns {Promise<Object>}
 */
async function resolveChatReference(options = {}, reference) {
  const input = reference || options.reference || options;
  const root = options.root || options.cwd || options.projectRoot;
  const normalized = input && typeof input === 'object' ? input : {};
  if (!normalized.path || (normalized.kind !== 'source' && normalized.kind !== 'image')) {
    return baseResult(normalized, 'invalid-reference');
  }
  return normalized.kind === 'source'
    ? resolveSource(root, normalized)
    : resolveImage(root, normalized, options);
}

module.exports = {
  IMAGE_FORMATS,
  MAX_CHAT_REFERENCE_IMAGE_BYTES,
  MAX_CHAT_REFERENCE_SOURCE_BYTES,
  MAX_CHAT_REFERENCE_EXCERPT_LINES,
  MAX_CHAT_REFERENCE_EXCERPT_BYTES,
  resolveChatReference,
  resolveContainedTarget,
  readBoundedFile,
  openChatHtmlReference,
  openChatFileReference,
  openInDefaultBrowser
};
