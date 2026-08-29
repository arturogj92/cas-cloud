/**
 * Claude Project Path Resolver
 *
 * Claude Code stores each conversation under ~/.claude/projects/<encoded-cwd>/,
 * where <encoded-cwd> is the working directory with every non-alphanumeric
 * character replaced by a dash (letter case preserved).
 *
 * The subtlety that breaks resume + conversation history: Claude derives that
 * folder from process.cwd(), which the kernel resolves to the PHYSICAL path —
 * symlinks followed and the canonical on-disk letter case. CodeAgentSwarm, by
 * contrast, stores whatever path the user typed / the dialog returned, which may
 * differ by:
 *   - a symlink anywhere in the path (corporate home redirects, iCloud
 *     CloudStorage, external volumes, even /var -> /private/var), or
 *   - letter case (only impactful when ~/.claude lives on a case-sensitive
 *     volume; a normal case-insensitive macOS volume folds case for free).
 *
 * When the app-stored path encodes to a different folder name than Claude's, an
 * exact-string lookup misses: the resume gate silently downgrades to a fresh
 * session and the history modal shows nothing.
 *
 * This module centralises the encoding plus a tolerant lookup that mirrors what
 * Claude actually does (realpath) and degrades gracefully on case-sensitive
 * volumes (case-insensitive scan).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The per-conversation git-worktree feature seats a terminal inside
 *   <repoRoot>/.codeagentswarm/worktrees/<slug>
 * so Claude records THAT as the conversation's cwd. For history/grouping we want
 * such a conversation to be attributed to its PARENT repo, not to surface as a
 * brand-new "project" named after the worktree slug.
 */
// Matches the worktree path segment in a real filesystem path (POSIX or Windows
// separators), e.g. ".../.codeagentswarm/worktrees/<slug>".
const WORKTREE_PATH_SEGMENT_RE = /[\\/]\.codeagentswarm[\\/]worktrees[\\/]/;
// Encoded form of "/.codeagentswarm/worktrees/": encodeProjectPath turns every
// non-alphanumeric char into a dash, so Claude's on-disk folder for a worktree cwd
// is "<encodedParentRepo>--codeagentswarm-worktrees-<encodedSlug>". The parent
// repo's encoded folder name is therefore a clean prefix before this marker.
const ENCODED_WORKTREE_MARKER = '--codeagentswarm-worktrees-';

/**
 * If `p` is inside a per-conversation worktree
 * (".../.codeagentswarm/worktrees/<slug>"), return the PARENT repo root by
 * stripping from that segment onward. Any other path is returned unchanged.
 * @param {string} p
 * @returns {string}
 */
function normalizeWorktreePath(p) {
    if (!p) return p;
    const s = String(p);
    const m = s.match(WORKTREE_PATH_SEGMENT_RE);
    if (!m) return p;
    return s.slice(0, m.index);
}

/**
 * Given an ENCODED ~/.claude/projects/<dir> folder name, if it encodes a worktree
 * cwd, return the encoded folder name of its PARENT repo; otherwise null. Lets the
 * directory pre-filter attribute a worktree's folder to its parent project without
 * a (lossy) decode of the encoded name.
 * @param {string} encodedDirName
 * @returns {string|null}
 */
function parentEncodedNameOfWorktreeDir(encodedDirName) {
    if (!encodedDirName) return null;
    const idx = encodedDirName.indexOf(ENCODED_WORKTREE_MARKER);
    return idx > 0 ? encodedDirName.slice(0, idx) : null;
}

/**
 * Encode a project path to the directory name Claude Code uses.
 * Example macOS:   "/Users/me/Dev/app"  -> "-Users-me-Dev-app"
 * Example Windows: "C:\\Users\\me\\app" -> "C--Users-me-app" (no leading dash)
 * @param {string} projectPath
 * @returns {string}
 */
function encodeProjectPath(projectPath) {
    if (!projectPath) return '';

    const isWindows = process.platform === 'win32';

    if (isWindows) {
        // Windows: replace every special character with a dash.
        // C:\Users\name\... -> C--Users-name-...
        return projectPath
            .normalize('NFD')
            .replace(/[^a-zA-Z0-9]/g, '-');
    }

    // macOS/Linux: leading dash, drive-letter colon stripped for safety.
    const normalizedPath = projectPath
        .replace(/\\/g, '/')              // normalise backslashes
        .replace(/^([A-Za-z]):/, '$1');   // strip drive-letter colon if present

    return '-' + normalizedPath
        .normalize('NFD')                 // decomposed form for macOS consistency
        .replace(/^\//, '')               // drop leading slash
        .replace(/[^a-zA-Z0-9]/g, '-');   // any non-alphanumeric -> dash
}

/**
 * Build the set of encoded directory names a project path could map to.
 * Includes both the literal path AND its realpath (symlinks resolved +
 * canonical case), because Claude's process.cwd() resolves both. The literal
 * is kept too so we still match sessions created without resolution.
 * @param {string} projectPath
 * @returns {string[]} ordered, de-duplicated candidate directory names
 */
function getCandidateEncodedNames(projectPath) {
    const candidates = [];
    if (!projectPath) return candidates;

    const literal = encodeProjectPath(projectPath);
    if (literal) candidates.push(literal);

    try {
        if (fs.existsSync(projectPath)) {
            // .native returns the OS-canonical path: symlinks followed and the
            // real on-disk letter case, exactly what Claude's process.cwd() sees.
            const real = fs.realpathSync.native(projectPath);
            const realEncoded = encodeProjectPath(real);
            if (realEncoded && !candidates.includes(realEncoded)) {
                candidates.push(realEncoded);
            }
        }
    } catch (_) {
        // Path not accessible (permissions, race) — fall back to literal only.
    }

    return candidates;
}

/**
 * Resolve the actual ~/.claude/projects/<dir> that holds a project's
 * conversations, tolerating symlink and letter-case divergence.
 *
 * Resolution order (most precise first):
 *   1. Direct existence of any candidate encoding. On a case-insensitive volume
 *      this already folds case; the realpath candidate covers symlinks.
 *   2. Case-insensitive scan of the projects directory — needed only when
 *      ~/.claude itself lives on a case-sensitive volume.
 *
 * @param {string} projectsDir absolute path to ~/.claude/projects
 * @param {string} projectPath the app-stored project path
 * @returns {string|null} absolute path to the matching directory, or null
 */
function resolveProjectConversationsDir(projectsDir, projectPath) {
    if (!projectsDir || !projectPath) return null;

    try {
        if (!fs.existsSync(projectsDir)) return null;
    } catch (_) {
        return null;
    }

    const candidates = getCandidateEncodedNames(projectPath);
    if (candidates.length === 0) return null;

    // 1) Direct hit (handles case-insensitive FS + realpath-resolved symlink).
    for (const name of candidates) {
        const dir = path.join(projectsDir, name);
        try {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                return dir;
            }
        } catch (_) { /* keep trying */ }
    }

    // 2) Case-insensitive scan (case-sensitive ~/.claude volumes).
    let entries;
    try {
        entries = fs.readdirSync(projectsDir);
    } catch (_) {
        return null;
    }
    const lowerCandidates = new Set(candidates.map(c => c.toLowerCase()));
    for (const entry of entries) {
        if (lowerCandidates.has(entry.toLowerCase())) {
            const dir = path.join(projectsDir, entry);
            try {
                if (fs.statSync(dir).isDirectory()) return dir;
            } catch (_) { /* keep scanning */ }
        }
    }

    return null;
}

/**
 * Matcher for filtering an already-listed set of ~/.claude/projects/* directory
 * names against a set of recent project paths, preserving recency order.
 * Used by the conversation-history modal, which lists every project folder once
 * and needs to keep only those belonging to the user's recent projects.
 *
 * @param {string[]} recentProjectPaths ordered most-recent-first
 * @returns {{ matches(dirName: string): boolean, recencyOf(dirName: string): number|undefined }}
 */
function buildRecentProjectMatcher(recentProjectPaths) {
    const orderByName = new Map();   // exact encoded name -> recency index
    const orderByLower = new Map();  // lowercased encoded name -> recency index

    (recentProjectPaths || []).forEach((projectPath, index) => {
        for (const name of getCandidateEncodedNames(projectPath)) {
            if (!orderByName.has(name)) orderByName.set(name, index);
            const lower = name.toLowerCase();
            if (!orderByLower.has(lower)) orderByLower.set(lower, index);
        }
    });

    const recencyOf = (dirName) => {
        if (orderByName.has(dirName)) return orderByName.get(dirName);
        const lower = dirName.toLowerCase();
        if (orderByLower.has(lower)) return orderByLower.get(lower);
        // A worktree's on-disk folder belongs to its parent repo: inherit the
        // parent's recency so the worktree's conversations are scanned (and sorted)
        // with the parent project instead of being filtered out as "not recent".
        const parent = parentEncodedNameOfWorktreeDir(dirName);
        if (parent) {
            if (orderByName.has(parent)) return orderByName.get(parent);
            const parentLower = parent.toLowerCase();
            if (orderByLower.has(parentLower)) return orderByLower.get(parentLower);
        }
        return undefined;
    };

    return {
        // Does an on-disk ~/.claude/projects/<dirName> belong to a recent project?
        matches: (dirName) => recencyOf(dirName) !== undefined,
        recencyOf,
        // Does an absolute project path (e.g. the cwd Claude recorded inside a
        // conversation file) belong to a recent project? The matcher already
        // holds both the literal and realpath-resolved encodings of every recent
        // path, so encoding the candidate path and testing membership covers
        // symlink + case divergence in either direction.
        matchesProjectPath: (projectPath) => {
            if (!projectPath) return false;
            return recencyOf(encodeProjectPath(projectPath)) !== undefined;
        }
    };
}

/**
 * Do two absolute paths point at the same project, tolerating the divergences
 * that break exact equality: a symlink in the path, a trailing slash, letter
 * case, OR one path being a per-conversation git worktree of the other.
 *
 * History/search services attribute worktree cwds to their PARENT repo
 * (`normalizeWorktreePath`) for the project label, but the resume selector is
 * often opened with the terminal's raw worktree path as `resumeProjectPath`.
 * Without folding both sides through the worktree identity first, a Grok (or
 * Claude/Kimi/Codex) session born inside
 *   <repo>/.codeagentswarm/worktrees/<slug>
 * never matches the resume filter → "No recent conversations" even though the
 * sessions exist on disk. See task #12253 / Grok Build worktree resume bug.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function projectPathsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    // Worktree identity first: a conversation stored under the parent repo path
    // must match a resume selector opened from any of that repo's worktrees
    // (and vice versa). Only re-compare when at least one side was rewritten so
    // we don't pay a second realpath for the common non-worktree case twice.
    const na = normalizeWorktreePath(a);
    const nb = normalizeWorktreePath(b);
    if ((na !== a || nb !== b) && pathsEqualIgnoringSymlinkAndCase(na, nb)) {
        return true;
    }

    return pathsEqualIgnoringSymlinkAndCase(a, b);
}

/**
 * Symlink / trailing-slash / separator / letter-case equality for two absolute
 * paths. Extracted so projectPathsMatch can apply it to both the raw and the
 * worktree-normalized pair without duplicating the realpath try/catch.
 *
 * Separator folding (`\` → `/`) is REQUIRED on Windows: the resume selector may
 * hold a backslash path from the shell while a conversation's recorded cwd (or
 * a path normalized elsewhere) uses forward slashes — without this, win2 resume
 * empties the list even when the worktree fold is correct. Shape-based
 * case-fold (always lower) is also required because NTFS is case-insensitive
 * and fs.realpathSync does NOT canonicalize TEMP→Temp on win2.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function pathsEqualIgnoringSymlinkAndCase(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    // Slash-normalize + strip trailing separators so `C:\foo` == `C:/foo/`.
    // Do this BEFORE realpath so the cheap string path covers the common case
    // even when neither side exists on disk (unit tests, synthetic fixtures).
    const fold = (p) => {
        const slashed = String(p).replace(/\\/g, '/');
        // Keep a bare drive root (`C:`) from collapsing to empty after trim.
        const trimmed = slashed.replace(/\/+$/, '');
        return trimmed || slashed;
    };
    const fa = fold(a);
    const fb = fold(b);
    if (fa === fb) return true;
    if (fa.toLowerCase() === fb.toLowerCase()) return true;

    try {
        if (fs.existsSync(a) && fs.existsSync(b) &&
            fs.realpathSync.native(a) === fs.realpathSync.native(b)) {
            return true;
        }
    } catch (_) { /* already tried string equality */ }

    return false;
}

/**
 * Locate the ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl transcript.
 *
 * One readdir plus one existsSync per project folder: no file contents are read
 * to FIND it. Shared by every lookup that starts from a session id alone.
 *
 * @param {string} sessionId
 * @param {string} [projectsDir] defaults to ~/.claude/projects
 * @returns {string|null} absolute path to the transcript, or null
 */
function locateSessionTranscript(sessionId, projectsDir) {
    if (!sessionId) return null;
    const root = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return null;

    const fileName = `${sessionId}.jsonl`;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const transcript = path.join(root, entry.name, fileName);
        if (fs.existsSync(transcript)) return transcript;
    }
    return null;
}

/**
 * The transcript file of a Claude conversation, found from its session id alone.
 *
 * Used by the driver-backed chat to replay a resumed conversation's history:
 * the SDK continues the session but never re-emits its past messages, so the
 * timeline has to be rebuilt from the JSONL on disk.
 *
 * @param {string} sessionId
 * @param {string} [projectsDir] defaults to ~/.claude/projects
 * @returns {string|null} absolute path, or null when there is no such session
 */
function findSessionTranscript(sessionId, projectsDir) {
    try {
        return locateSessionTranscript(sessionId, projectsDir);
    } catch (error) {
        console.error('[Claude] findSessionTranscript failed:', error.message);
        return null;
    }
}

/**
 * The directory a Claude conversation ran in, found from its session id alone.
 *
 * Claude files each conversation under ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
 * so the id locates the folder with one readdir + one existsSync per project (no
 * file contents are read to FIND it). The cwd itself is then read from the
 * transcript rather than decoded from the folder name, because that encoding is
 * lossy: every non-alphanumeric character became a dash, so "my-app" and "my/app"
 * encode identically and a decode would guess.
 *
 * Used by the resume path to seat the terminal where the conversation actually
 * lives — including a per-conversation worktree, whose path the history pipeline
 * normalizes away to the parent repo root.
 * @param {string} sessionId
 * @param {string} [projectsDir] defaults to ~/.claude/projects
 * @returns {string|null}
 */
function findSessionCwd(sessionId, projectsDir) {
    try {
        const transcript = locateSessionTranscript(sessionId, projectsDir);
        if (!transcript) return null;

        // Every Claude transcript line carries the cwd; the first one is enough
        // and is bounded, so a huge transcript is never read whole.
        const head = fs.readFileSync(transcript, 'utf8').slice(0, 64 * 1024);
        for (const line of head.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed && parsed.cwd) return parsed.cwd;
            } catch (_) {
                // A truncated final line is expected when the head is capped.
            }
        }
        return null;
    } catch (error) {
        console.error('[Claude] findSessionCwd failed:', error.message);
        return null;
    }
}

module.exports = {
    encodeProjectPath,
    getCandidateEncodedNames,
    resolveProjectConversationsDir,
    buildRecentProjectMatcher,
    projectPathsMatch,
    normalizeWorktreePath,
    parentEncodedNameOfWorktreeDir,
    findSessionCwd,
    findSessionTranscript
};
