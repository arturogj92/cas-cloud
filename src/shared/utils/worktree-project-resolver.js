'use strict';

/**
 * Worktree -> parent-repo project identity helpers (task #12044).
 *
 * A per-conversation git worktree lives at `<repo>/.codeagentswarm/worktrees/<slug>` and must NOT
 * mint its own project: its project identity is the repo it was created from. Auto-creating a
 * project named after the worktree folder (e.g. "codeagentswarm-nqzz") produced spurious duplicate
 * projects. These helpers resolve a worktree path to its repo root and recognise the spurious
 * leftovers so a one-shot migration can remove them.
 */

/**
 * Resolve the directory that owns a terminal's PROJECT identity. If `directory` is a known worktree
 * path (exact match against the worktrees table rows), return its repo_root; otherwise return the
 * directory unchanged. Pure + fail-safe: never throws.
 *
 * @param {string} directory - the terminal's working directory
 * @param {Array<{worktree_path?: string, repo_root?: string}>} [worktreeRows] - rows from the worktrees table
 * @returns {string} the repo root for a worktree, else `directory`
 */
function resolveProjectDir(directory, worktreeRows) {
  if (!directory) return directory;
  // A row whose repo_root IS the worktree path carries no identity — it was written by
  // an older build that resolved the repo root from inside the worktree itself (#12154).
  // Trusting it re-creates the very bug this resolver exists to prevent, so such rows
  // are skipped and the path-shape fallback below answers instead.
  const row = Array.isArray(worktreeRows)
    ? worktreeRows.find(w => w && w.worktree_path === directory && w.repo_root && w.repo_root !== directory)
    : null;
  if (row) return row.repo_root;
  return worktreeIdentityDir(directory);
}

/**
 * Path-shape fallback for the same question, with NO database: a worktree lives at
 * `<repo>/.codeagentswarm/worktrees/<slug>` and a GROUP worktree mounts each embedded
 * sub-repo under it, so
 *
 *   <repo>/.codeagentswarm/worktrees/<slug>          -> <repo>
 *   <repo>/.codeagentswarm/worktrees/<slug>/sub/dir  -> <repo>/sub/dir
 *
 * Anything else is returned unchanged. The renderer needs this: it paints a terminal's
 * project badge/color/icon from the directory alone and has no worktrees rows at hand,
 * so without it a terminal seated in a worktree (the fork hands over the worktree cwd)
 * renders as a different project than the repo it belongs to.
 *
 * Pure, cross-platform (handles either separator) and fail-safe: never throws.
 *
 * @param {string} directory
 * @returns {string}
 */
function worktreeIdentityDir(directory) {
  if (!directory || typeof directory !== 'string') return directory;
  try {
    const marker = /[\\/]\.codeagentswarm[\\/]worktrees[\\/]/.exec(directory);
    if (!marker || marker.index <= 0) return directory;
    const repoRoot = directory.slice(0, marker.index);
    const sep = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
    // Everything after the marker is "<slug>[/sub/dir]"; the slug is the worktree's
    // own folder and never part of the identity, the rest mirrors the repo's layout.
    const rest = directory
      .slice(marker.index + marker[0].length)
      .split(/[\\/]/)
      .filter(Boolean)
      .slice(1);
    return rest.length ? repoRoot + sep + rest.join(sep) : repoRoot;
  } catch (_) {
    return directory;
  }
}

/**
 * THE single gate from "the directory a terminal sits in" to "the project NAME it
 * belongs to" (#12214). Resolves conversation worktrees to their parent repo via
 * worktreeIdentityDir, then takes the basename cross-platform (either separator).
 *
 * Contract: '' for empty/non-string input; for non-empty input it never returns
 * '' — when no basename can be extracted (e.g. '/'), it falls back to the
 * directory string itself. Never throws.
 *
 * Every renderer-side surface that names a project from a directory (terminal
 * header/tab colors, badges, pickers, kanban, screenshot overlay) must call this
 * (directly or via TerminalManager._projectNameForDirectory). The source guard in
 * tests/project-identity-single-gate.test.js fails when a raw basename over a
 * terminal directory appears outside this gate.
 *
 * @param {string} directory
 * @returns {string}
 */
function projectNameForDirectory(directory) {
  if (!directory || typeof directory !== 'string') return '';
  try {
    const identity = worktreeIdentityDir(directory) || directory;
    const name = String(identity).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    return name || directory;
  } catch (_) {
    return directory;
  }
}

/**
 * True when a project's path points INSIDE a `.codeagentswarm/worktrees/` tree — i.e. it was
 * spuriously auto-created for a worktree folder instead of the parent repo. Cross-platform
 * (normalises Windows backslashes). A legit project root never lives under that path.
 *
 * @param {{path?: string}} project
 * @returns {boolean}
 */
function isSpuriousWorktreeProject(project) {
  if (!project || !project.path) return false;
  return project.path.replace(/\\/g, '/').includes('/.codeagentswarm/worktrees/');
}

module.exports = { resolveProjectDir, worktreeIdentityDir, projectNameForDirectory, isSpuriousWorktreeProject };
