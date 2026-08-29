const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_FILES = 100;
const MAX_SEARCH_RESULTS = 100;

function relativePath(value, { allowRoot = true } = {}) {
  if (typeof value !== 'string' || value.length > 1024 || /[\0-\x1f\x7f]/.test(value)
    || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) throw new Error('Choose a valid relative workspace path');
  const parts = value.split('/');
  if (parts.some((part) => part === '..' || !part) || (!allowRoot && value === '.')) throw new Error('Choose a valid relative workspace path');
  return parts.filter((part) => part !== '.').join('/') || '.';
}

async function contained(projectPath, requested = '.') {
  const root = await fs.realpath(projectPath);
  const target = await fs.realpath(path.join(root, relativePath(requested)));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('The workspace path is outside the project');
  return { root, target };
}

function publicPath(root, target) { return path.relative(root, target).split(path.sep).join('/') || '.'; }

async function list(projectPath, { relativePath: requested = '.' } = {}) {
  const { root, target } = await contained(projectPath, requested);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return { entries: entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
    relative: publicPath(root, path.join(target, entry.name)), type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  })), truncated: entries.length > MAX_LIST_ENTRIES };
}

async function read(projectPath, { relativePath: requested } = {}) {
  const { root, target } = await contained(projectPath, requested);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('The workspace path is not a file');
  if (stat.size > MAX_FILE_BYTES) throw new Error('The workspace file is too large');
  return { relative: publicPath(root, target), content: await fs.readFile(target, 'utf8'), truncated: false };
}

async function search(projectPath, { query, relativePath: requested = '.' } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Enter a search query');
  const { root, target } = await contained(projectPath, requested);
  const queue = [target]; const results = []; let files = 0;
  while (queue.length && files < MAX_SEARCH_FILES && results.length < MAX_SEARCH_RESULTS) {
    const directory = queue.shift();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (results.length >= MAX_SEARCH_RESULTS || files >= MAX_SEARCH_FILES) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { queue.push(file); continue; }
      if (!entry.isFile()) continue;
      files += 1;
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null || text.includes('\0')) continue;
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.includes(query)) results.push({ relative: publicPath(root, file), line: index + 1, text: line.slice(0, 1000) });
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  return { results, truncated: queue.length > 0 || files >= MAX_SEARCH_FILES || results.length >= MAX_SEARCH_RESULTS };
}

async function git(projectPath, args) {
  const { stdout } = await run('git', args, { cwd: await fs.realpath(projectPath), encoding: 'utf8', maxBuffer: MAX_RESULT_BYTES });
  return { text: stdout.slice(0, MAX_RESULT_BYTES), truncated: false };
}

async function branchName(projectPath, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('Choose a valid Git branch');
  }
  const name = value.trim();
  await git(projectPath, ['check-ref-format', '--branch', name]);
  return name;
}

async function gitSwitch(projectPath, { branchName: value } = {}) {
  const name = await branchName(projectPath, value);
  await git(projectPath, ['switch', name]);
  return gitBranches(projectPath);
}

async function gitCreate(projectPath, { branchName: value } = {}) {
  const name = await branchName(projectPath, value);
  await git(projectPath, ['switch', '-c', name]);
  return gitBranches(projectPath);
}

const gitBranches = (projectPath) => git(projectPath, ['for-each-ref', '--format=%(HEAD)%(refname:short)', 'refs/heads']);

module.exports = {
  list, read, search, relativePath,
  gitStatus: (projectPath) => git(projectPath, ['status', '--short', '--branch']),
  gitDiff: (projectPath) => git(projectPath, ['diff', '--no-ext-diff', '--no-color']),
  gitLog: (projectPath) => git(projectPath, ['log', '--no-color', '--format=%H%x09%s%x09%ct', '-n', '50']),
  gitBranches,
  gitSwitch,
  gitCreate,
};
