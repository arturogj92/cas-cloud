const fs = require('fs');
const path = require('path');

const OWNED_SOURCE_RUNTIME = path.resolve(__dirname, '..', 'mcp', 'mcp-stdio-server.js');
const OWNED_SOURCE_LAUNCHER = path.resolve(__dirname, '..', 'mcp', 'antigravity-mcp-launcher.js');
const WORKTREE_MARKER = '/.codeagentswarm/worktrees/';
const SOURCE_APP_SUFFIX = '/src/infrastructure/mcp/mcp-stdio-server.js';
const SOURCE_RUNTIME_SUFFIX = '/codeagentswarm-app/src/infrastructure/mcp/mcp-stdio-server.js';
const SOURCE_LAUNCHER_SUFFIX = '/codeagentswarm-app/src/infrastructure/mcp/antigravity-mcp-launcher.js';
const STANDALONE_LAUNCHER_SUFFIX = '/src/infrastructure/mcp/antigravity-mcp-launcher.js';
const SOURCE_CHECKOUT_SUFFIXES = [SOURCE_RUNTIME_SUFFIX, SOURCE_LAUNCHER_SUFFIX];

function normalizeRuntimePath(value) {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasStaleSiblingWorktreeRuntime(text) {
  const sourceRuntime = normalizeRuntimePath(OWNED_SOURCE_RUNTIME);
  if (!sourceRuntime.endsWith(SOURCE_APP_SUFFIX)) return false;
  const appRoot = sourceRuntime.slice(0, -SOURCE_APP_SUFFIX.length);
  const markerIndex = appRoot.indexOf(WORKTREE_MARKER);
  const repositoryRoots = markerIndex === -1
    ? [appRoot, appRoot.slice(0, appRoot.lastIndexOf('/'))]
    : [appRoot.slice(0, markerIndex)];
  const siblingPrefixes = [...new Set(repositoryRoots.filter(Boolean)
    .map((root) => normalizeRuntimePath(`${root}${WORKTREE_MARKER}`)))];
  const suffixes = [
    SOURCE_RUNTIME_SUFFIX,
    SOURCE_LAUNCHER_SUFFIX,
    SOURCE_APP_SUFFIX,
    STANDALONE_LAUNCHER_SUFFIX,
  ];
  return siblingPrefixes.some((siblingPrefix) => suffixes.some((suffix) => {
    const start = text.indexOf(siblingPrefix);
    if (start === -1) return false;
    const end = text.indexOf(suffix, start + siblingPrefix.length);
    if (end === -1) return false;
    const isBoundary = (value) => !value || /[\s"'\[\]{},]/.test(value);
    if (!isBoundary(text[start - 1]) || !isBoundary(text[end + suffix.length])) return false;
    const worktreeName = text.slice(start + siblingPrefix.length, end);
    if (!worktreeName || worktreeName.includes('/')) return false;
    return !fs.existsSync(text.slice(start, end + suffix.length));
  }));
}

function hasStaleSourceCheckoutRuntime(text) {
  const candidates = [text.trim(), ...[...text.matchAll(/["']([^"']+)["']/g)].map(match => match[1])];
  return candidates.some((candidate) => {
    if (candidate.includes(WORKTREE_MARKER)) return false;
    const ownedPaths = [OWNED_SOURCE_RUNTIME, OWNED_SOURCE_LAUNCHER].map(normalizeRuntimePath);
    if (ownedPaths.some(owned => candidate !== owned && candidate.includes(owned))) return false;
    if (!SOURCE_CHECKOUT_SUFFIXES.some(suffix => candidate.endsWith(suffix))) return false;
    if (!/^(?:[a-z]:\/|\/)/i.test(candidate)) return false;
    const withoutRoot = candidate.replace(/^[a-z]:\//i, '').replace(/^\/+/, '');
    if (/[a-z]:\//i.test(withoutRoot)) return false;
    return !fs.existsSync(candidate);
  });
}

function hasOwnedMcpRuntime(value, seen = new Set()) {
  if (typeof value === 'string') {
    const text = normalizeRuntimePath(value);
    const sourceRuntime = normalizeRuntimePath(OWNED_SOURCE_RUNTIME);
    const sourceLauncher = normalizeRuntimePath(OWNED_SOURCE_LAUNCHER);
    return text.includes('/.codeagentswarm/mcp-servers/codeagentswarm-tasks/')
      || text === sourceRuntime
      || text === sourceLauncher
      || text.includes(`"${sourceRuntime}"`)
      || text.includes(`"${sourceLauncher}"`)
      || hasStaleSiblingWorktreeRuntime(text)
      || hasStaleSourceCheckoutRuntime(text);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(child => hasOwnedMcpRuntime(child, seen));
}

module.exports = { hasOwnedMcpRuntime, OWNED_SOURCE_RUNTIME, OWNED_SOURCE_LAUNCHER };
