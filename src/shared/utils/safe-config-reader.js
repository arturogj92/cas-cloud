/**
 * Safe Config Reader
 *
 * Guards `readFileSync + JSON.parse` of user-controlled config files against
 * V8 heap OOM. A user's `~/.claude.json` or `~/.gemini/settings.json` can
 * grow into the hundreds of MB (history accumulation, duplication bugs,
 * etc.). Reading such a file with the naive pattern allocates the whole
 * content as a V8 string + parsed JS objects, which crashes the Electron
 * main process at boot (EXC_BAD_ACCESS / SIGSEGV inside
 * node::OnFatalError, with `asi` empty because V8 segfaults during the
 * OOM handler itself).
 *
 * This module refuses to read files exceeding `DEFAULT_MAX_SIZE_BYTES`,
 * throwing a typed `ConfigFileTooLargeError` so callers can degrade
 * gracefully instead of crashing the whole process.
 */

const fs = require('fs');

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;

class ConfigFileTooLargeError extends Error {
    constructor(filePath, sizeBytes, maxBytes) {
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
        const maxMB = (maxBytes / 1024 / 1024).toFixed(1);
        super(
            `Refusing to read ${filePath}: ${sizeMB} MB exceeds limit of ${maxMB} MB. ` +
            `Loading would risk an out-of-memory crash in the Electron main process.`
        );
        this.name = 'ConfigFileTooLargeError';
        this.code = 'CONFIG_FILE_TOO_LARGE';
        this.filePath = filePath;
        this.sizeBytes = sizeBytes;
        this.maxBytes = maxBytes;
    }
}

/**
 * Read a config file as UTF-8 text after size-checking it.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {object} [options]
 * @param {number} [options.maxBytes=DEFAULT_MAX_SIZE_BYTES] - Hard cap.
 * @returns {string|null} File content as string, or null if file does not exist.
 * @throws {ConfigFileTooLargeError} If file size exceeds maxBytes.
 */
function safeReadConfigFile(filePath, options = {}) {
    const maxBytes = typeof options.maxBytes === 'number'
        ? options.maxBytes
        : DEFAULT_MAX_SIZE_BYTES;

    if (!fs.existsSync(filePath)) {
        return null;
    }

    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        const maxMB = (maxBytes / 1024 / 1024).toFixed(1);
        console.error(
            `[safe-config-reader] Refusing to read ${filePath}: ${sizeMB} MB exceeds ${maxMB} MB cap. ` +
            `Skipping to prevent V8 out-of-memory crash.`
        );
        throw new ConfigFileTooLargeError(filePath, stat.size, maxBytes);
    }

    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Read and JSON.parse a config file, with size guard.
 *
 * @param {string} filePath - Absolute path.
 * @param {object} [options] - Forwarded to safeReadConfigFile.
 * @returns {any|null} Parsed JSON, or null if file does not exist.
 * @throws {ConfigFileTooLargeError} If file size exceeds maxBytes.
 * @throws {SyntaxError} If content is not valid JSON.
 */
function safeReadJsonFile(filePath, options = {}) {
    const content = safeReadConfigFile(filePath, options);
    return content === null ? null : JSON.parse(content);
}

/**
 * Safely write a config file, refusing to overwrite an existing file that
 * exceeds the size cap.
 *
 * Why: callers often do `read → modify → write` over user-controlled config
 * files. When the matching read failed (file too big) and the caller
 * silently fell back to an empty object, the subsequent write would WIPE
 * the user's data. This guard makes that impossible: if the file on disk
 * is already over the cap, we refuse to write to it. The user keeps their
 * (oversized) data; the specific feature degrades gracefully.
 *
 * @param {string} filePath - Absolute path.
 * @param {string|Buffer} content - Content to write.
 * @param {object} [options]
 * @param {number} [options.maxBytes=DEFAULT_MAX_SIZE_BYTES] - Existing-file cap.
 * @param {string} [options.encoding='utf8'] - Passed to fs.writeFileSync.
 * @throws {ConfigFileTooLargeError} If the existing file on disk is oversized.
 */
function safeWriteConfigFile(filePath, content, options = {}) {
    const maxBytes = typeof options.maxBytes === 'number'
        ? options.maxBytes
        : DEFAULT_MAX_SIZE_BYTES;
    const encoding = options.encoding || 'utf8';

    if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > maxBytes) {
            const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
            const maxMB = (maxBytes / 1024 / 1024).toFixed(1);
            console.error(
                `[safe-config-reader] Refusing to overwrite ${filePath}: existing file is ${sizeMB} MB ` +
                `(exceeds ${maxMB} MB cap). Aborting write to prevent data loss — the read of this ` +
                `oversized file likely returned an empty default, and writing back would wipe the user's data.`
            );
            throw new ConfigFileTooLargeError(filePath, stat.size, maxBytes);
        }
    }

    fs.writeFileSync(filePath, content, encoding);
}

module.exports = {
    safeReadConfigFile,
    safeReadJsonFile,
    safeWriteConfigFile,
    ConfigFileTooLargeError,
    DEFAULT_MAX_SIZE_BYTES,
};
