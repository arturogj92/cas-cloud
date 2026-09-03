const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_CLONES = 2;
const MAX_QUEUE = 20;
const ICON_PATTERN = /^(?:emoji:.{1,16}|lucide:[a-z0-9-]{1,80})$/u;

function runtimeError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function randomId() {
  return crypto.randomBytes(18).toString('base64url');
}

function legacyProjectId(runtimeId, projectPath) {
  return crypto.createHash('sha256').update(`${runtimeId}\0${projectPath}`).digest('base64url').slice(0, 32);
}

function requestHash(type, value) {
  return crypto.createHash('sha256').update(JSON.stringify([type, value])).digest('hex');
}

function contained(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRelativePath(value, { allowRoot = true } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    throw runtimeError('invalid_relative_directory', 'Choose a valid relative project directory');
  }
  if (/[\0-\x1f\x7f]/.test(value)
    || path.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || /^[/\\]{2}/.test(value)
    || value.includes('\\')) {
    throw runtimeError('invalid_relative_directory', 'Choose a valid relative project directory');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '..') || (!allowRoot && value === '.')) {
    throw runtimeError('invalid_relative_directory', 'Choose a valid relative project directory');
  }
  return parts.filter((part) => part !== '.').join('/') || '.';
}

function validateCloneChildName(value) {
  const relative = validateRelativePath(value, { allowRoot: false });
  if (relative.includes('/') || relative === '.') {
    throw runtimeError('invalid_relative_directory', 'The clone destination must be a direct child of its configured root');
  }
  return relative;
}

function validateGitUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || value.startsWith('-') || /[\0-\x20\x7f]/.test(value)) {
    throw runtimeError('invalid_git_url', 'Choose a valid remote Git URL');
  }
  if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch (_) {
      throw runtimeError('invalid_git_url', 'Choose a valid remote Git URL');
    }
    const https = parsed.protocol === 'https:';
    if (!['https:', 'ssh:'].includes(parsed.protocol)
      || !parsed.hostname
      || !parsed.pathname || parsed.pathname === '/'
      || parsed.search || parsed.hash
      || (https && (parsed.username || parsed.password))
      || parsed.password) {
      throw runtimeError('invalid_git_url', 'Choose a valid remote Git URL');
    }
    return value;
  }
  if (value.includes('://')) throw runtimeError('invalid_git_url', 'Choose a valid remote Git URL');
  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)
    && !value.startsWith(':') && !value.includes('::')) {
    return value;
  }
  throw runtimeError('invalid_git_url', 'Choose a valid remote Git URL');
}

function cloneDirectoryName(url) {
  const pathname = url.includes('://') ? new URL(url).pathname : url.slice(url.indexOf(':') + 1);
  const leaf = pathname.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/i, '') || 'repository';
  const sanitized = leaf.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  if (!sanitized) throw runtimeError('invalid_relative_directory', 'The repository name cannot form a project directory');
  return sanitized;
}

class HeadlessProjectRegistry {
  constructor({
    database,
    runtimeId,
    initialProjectPaths = [],
    projectRoots = [],
    spawnImpl = spawn,
    onProjectsChanged = () => {},
    onOperation = () => {},
    maxConcurrentClones = MAX_CLONES,
    stopTimeoutMs = 2_000,
  }) {
    if (!database?.db) throw new Error('HeadlessProjectRegistry requires a SQLite database');
    this.database = database;
    this.db = database.db;
    this.runtimeId = runtimeId;
    this.spawnImpl = spawnImpl;
    this.onProjectsChanged = onProjectsChanged;
    this.onOperation = onOperation;
    this.maxConcurrentClones = maxConcurrentClones;
    this.stopTimeoutMs = stopTimeoutMs;
    this.stopping = false;
    this.running = new Map();
    this.queue = [];
    this.destinations = new Map();
    this._initializeSchema();
    this._recoverOperations();
    const changed = this._reconcile(projectRoots, initialProjectPaths);
    if (changed) this._bumpRevision(false);
  }

  _initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_project_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        runtime_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS runtime_project_roots (
        root_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS runtime_projects (
        project_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        task_project_name TEXT NOT NULL,
        root_id TEXT,
        registered INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (root_id) REFERENCES runtime_project_roots(root_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_project_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS runtime_project_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS runtime_project_operations (
        operation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        root_id TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        project_id TEXT,
        error TEXT,
        created_destination INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO runtime_project_state (singleton, revision) VALUES (1, 0);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(runtime_projects)').all().map((column) => column.name));
    if (!columns.has('display_name')) this.db.exec('ALTER TABLE runtime_projects ADD COLUMN display_name TEXT');
    if (!columns.has('color')) this.db.exec('ALTER TABLE runtime_projects ADD COLUMN color TEXT');
    if (!columns.has('icon')) this.db.exec('ALTER TABLE runtime_projects ADD COLUMN icon TEXT');
    const owner = this.db.prepare('SELECT runtime_id FROM runtime_project_identity WHERE singleton = 1').get();
    if (owner && owner.runtime_id !== this.runtimeId) {
      throw runtimeError('runtime_identity_mismatch', 'The runtime database belongs to a different runtime identity');
    }
    if (!owner) {
      this.db.prepare('INSERT INTO runtime_project_identity (singleton, runtime_id) VALUES (1, ?)').run(this.runtimeId);
    }
  }

  _recoverOperations() {
    const interrupted = this.db.prepare(`
      SELECT operation_id, root_id, created_destination
      FROM runtime_project_operations
      WHERE state IN ('queued', 'running', 'cancelling')
    `).all();
    for (const row of interrupted) this._cleanupRecoveredTemporaryDestination(row);
    this.db.prepare(`
      UPDATE runtime_project_operations
      SET state = 'failed', error = 'host_restarted', updated_at = CURRENT_TIMESTAMP
      WHERE state IN ('queued', 'running', 'cancelling')
    `).run();
  }

  _cleanupRecoveredTemporaryDestination(row) {
    if (!row?.created_destination || !ID_PATTERN.test(row.operation_id || '')) return;
    try {
      const root = this._root(row.root_id);
      this._assertSecureCloneRoot(root);
      const candidate = path.join(root.path, `.cas-clone-${row.operation_id}`);
      if (path.dirname(candidate) !== root.path || !fs.existsSync(candidate)) return;
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) return;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch (_) {}
  }

  _reconcile(projectRoots, initialProjectPaths) {
    let changed = false;
    const roots = [];
    const rootPaths = new Set();
    for (const candidate of projectRoots) {
      const resolved = this._resolveDirectory(candidate, 'Project root');
      if (rootPaths.has(resolved)) continue;
      rootPaths.add(resolved);
      roots.push(resolved);
      const existing = this.db.prepare('SELECT root_id FROM runtime_project_roots WHERE path = ?').get(resolved);
      if (!existing) {
        this.db.prepare('INSERT INTO runtime_project_roots (root_id, path, name) VALUES (?, ?, ?)')
          .run(randomId(), resolved, path.basename(resolved) || 'Projects');
        changed = true;
      }
    }
    const projectPaths = new Set();
    for (const candidate of initialProjectPaths) {
      const resolved = this._resolveDirectory(candidate, 'Project');
      if (projectPaths.has(resolved)) continue;
      projectPaths.add(resolved);
      const root = roots.map((rootPath) => ({ rootPath, relative: path.relative(rootPath, resolved) }))
        .find(({ relative }) => relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)));
      const result = this._registerPath(resolved, root ? this._rootByPath(root.rootPath).root_id : null, { legacy: true });
      if (result.changed) changed = true;
    }
    for (const row of this.db.prepare('SELECT project_id, path FROM runtime_projects WHERE registered = 1').all()) {
      let resolved;
      try { resolved = fs.realpathSync(row.path); } catch (_) { continue; }
      if (resolved === row.path) continue;
      const canonical = this.db.prepare('SELECT project_id FROM runtime_projects WHERE path = ? AND registered = 1').get(resolved);
      if (!canonical || canonical.project_id === row.project_id) continue;
      this.db.prepare('UPDATE runtime_projects SET registered = 0, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?')
        .run(row.project_id);
      changed = true;
    }
    return changed;
  }

  _resolveDirectory(candidate, label) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute directory`);
    let resolved;
    try { resolved = fs.realpathSync(candidate); } catch (_) { throw new Error(`${label} does not exist: ${candidate}`); }
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${candidate}`);
    return resolved;
  }

  _rootByPath(rootPath) {
    return this.db.prepare('SELECT * FROM runtime_project_roots WHERE path = ?').get(rootPath);
  }

  _root(rootId) {
    if (typeof rootId !== 'string' || !ID_PATTERN.test(rootId)) throw runtimeError('invalid_root_id', 'Choose a configured project root');
    const root = this.db.prepare('SELECT * FROM runtime_project_roots WHERE root_id = ?').get(rootId);
    if (!root) throw runtimeError('invalid_root_id', 'Choose a configured project root');
    let resolved;
    try { resolved = fs.realpathSync(root.path); } catch (_) { throw runtimeError('path_not_found', 'The configured project root is unavailable', true); }
    if (resolved !== root.path || !fs.statSync(resolved).isDirectory()) {
      throw runtimeError('path_outside_root', 'The configured project root changed', true);
    }
    return root;
  }

  _containedExisting(root, relativePath) {
    const relative = validateRelativePath(relativePath);
    const joined = path.join(root.path, relative);
    let resolved;
    try { resolved = fs.realpathSync(joined); } catch (_) { throw runtimeError('path_not_found', 'The project directory does not exist'); }
    if (!contained(root.path, resolved)) throw runtimeError('path_symlink_escape', 'The project directory resolves outside its configured root');
    if (!fs.statSync(resolved).isDirectory()) throw runtimeError('path_not_directory', 'The project path is not a directory');
    return resolved;
  }

  _cloneDestination(root, relativePath, url) {
    const relative = validateCloneChildName(relativePath || cloneDirectoryName(url));
    const destination = path.join(root.path, relative);
    if (path.dirname(destination) !== root.path || !contained(root.path, destination)) {
      throw runtimeError('path_outside_root', 'The destination is outside its configured root');
    }
    if (fs.existsSync(destination)) throw runtimeError('destination_exists', 'The clone destination already exists');
    return { destination, relative };
  }

  _assertSecureCloneRoot(root) {
    let stat;
    try { stat = fs.lstatSync(root.path); } catch (_) {
      throw runtimeError('clone_root_insecure', 'The configured clone root is not secure');
    }
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (!stat.isDirectory()
      || (effectiveUid !== null && stat.uid !== effectiveUid)
      || (stat.mode & 0o022) !== 0) {
      throw runtimeError('clone_root_insecure', 'The configured clone root is not secure');
    }
    return stat;
  }

  _ensureTaskProject(projectPath, projectId) {
    const existing = this.database.getProjectByPath(projectPath);
    if (existing) return existing.name;
    const displayName = path.basename(projectPath) || 'Project';
    const candidates = [displayName, `${displayName}-${projectId.slice(0, 6)}`];
    for (const name of candidates) {
      const created = this.database.createProject(name, projectPath);
      if (created.success) return name;
      const byPath = this.database.getProjectByPath(projectPath);
      if (byPath) return byPath.name;
    }
    throw runtimeError('database_unavailable', 'The project catalog could not be updated', true);
  }

  _registerPath(projectPath, rootId, { legacy = false } = {}) {
    const existing = this.db.prepare('SELECT * FROM runtime_projects WHERE path = ?').get(projectPath);
    if (existing) {
      if (existing.registered && (!rootId || existing.root_id === rootId)) return { row: existing, changed: false };
      this.db.prepare(`UPDATE runtime_projects SET registered = 1, root_id = COALESCE(?, root_id), updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`)
        .run(rootId, existing.project_id);
      return { row: this.db.prepare('SELECT * FROM runtime_projects WHERE project_id = ?').get(existing.project_id), changed: true };
    }
    const legacyRow = legacy ? this.database.getProjectByPath(projectPath) : null;
    const projectId = legacyRow ? legacyProjectId(this.runtimeId, projectPath) : randomId();
    const taskProjectName = legacyRow?.name || this._ensureTaskProject(projectPath, projectId);
    this.db.prepare(`
      INSERT INTO runtime_projects (project_id, path, name, task_project_name, root_id, registered)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(projectId, projectPath, path.basename(projectPath) || 'Project', taskProjectName, rootId);
    return { row: this.db.prepare('SELECT * FROM runtime_projects WHERE project_id = ?').get(projectId), changed: true };
  }

  _bumpRevision(publish = true) {
    this.db.prepare('UPDATE runtime_project_state SET revision = revision + 1 WHERE singleton = 1').run();
    const revision = this.getRevision();
    if (publish) this.onProjectsChanged({ revision, projects: this.publicProjects() });
    return revision;
  }

  getRevision() {
    return Number(this.db.prepare('SELECT revision FROM runtime_project_state WHERE singleton = 1').get()?.revision) || 0;
  }

  getRoots() {
    return this.db.prepare('SELECT root_id, name FROM runtime_project_roots ORDER BY created_at, root_id').all()
      .map((root) => ({ rootId: root.root_id, name: String(root.name).slice(0, 200) }));
  }

  listDirectories({ rootId, relativePath = '.' } = {}) {
    const root = this._root(rootId);
    const currentPath = validateRelativePath(relativePath || '.');
    const target = this._containedExisting(root, currentPath);
    const parentPath = currentPath === '.' ? null : path.posix.dirname(currentPath);
    return {
      rootId: root.root_id,
      path: currentPath,
      parentPath: parentPath === '' ? '.' : parentPath,
      directories: fs.readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
        .slice(0, 200)
        .map((entry) => ({
          name: entry.name,
          path: currentPath === '.' ? entry.name : path.posix.join(currentPath, entry.name),
        })),
      locations: this.getRoots(),
    };
  }

  getProjects() {
    return this.db.prepare('SELECT * FROM runtime_projects WHERE registered = 1 ORDER BY created_at, project_id').all()
      .map((row) => ({
        projectId: row.project_id,
        name: String(row.display_name || row.name).slice(0, 200),
        path: row.path,
        taskProjectName: row.task_project_name,
        rootId: row.root_id,
        registered: true,
        sessionCount: 0,
        activity: null,
        status: 'available',
        worktreeEligible: false,
        useWorktreeByDefault: false,
        ...(row.color ? { color: String(row.color).slice(0, 32) } : {}),
        ...(row.icon ? { icon: String(row.icon).slice(0, 500) } : {}),
      }));
  }

  publicProjects() {
    return this.getProjects().map(({ path: _path, taskProjectName: _taskProjectName, rootId: _rootId, ...project }) => project);
  }

  list({ cursor = null, limit = 25 } = {}) {
    const pageSize = Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw runtimeError('invalid_limit', 'Project page size must be between 1 and 100');
    const revision = this.getRevision();
    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error();
        if (decoded.revision !== revision) throw runtimeError('stale_cursor', 'The project list changed; request it again');
        offset = decoded.offset;
      } catch (error) {
        if (error.code === 'stale_cursor') throw error;
        throw runtimeError('invalid_cursor', 'The project cursor is invalid');
      }
    }
    const projects = this.publicProjects();
    const page = projects.slice(offset, offset + pageSize);
    return {
      revision,
      projects: page,
      nextCursor: offset + pageSize < projects.length
        ? Buffer.from(JSON.stringify({ offset: offset + pageSize, revision })).toString('base64url')
        : null,
    };
  }

  resolveProject(projectId) {
    if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId)) throw runtimeError('invalid_project_id', 'Choose a configured remote project');
    const row = this.db.prepare('SELECT * FROM runtime_projects WHERE project_id = ? AND registered = 1').get(projectId);
    if (!row) throw runtimeError('invalid_project_id', 'Choose a configured remote project');
    let resolved;
    try { resolved = fs.realpathSync(row.path); } catch (_) { throw runtimeError('path_not_found', 'The configured project is unavailable', true); }
    if (resolved !== row.path || !fs.statSync(resolved).isDirectory()) throw runtimeError('path_symlink_escape', 'The configured project path changed', true);
    if (row.root_id) {
      const root = this._root(row.root_id);
      if (!contained(root.path, resolved)) throw runtimeError('path_symlink_escape', 'The configured project escapes its root', true);
    }
    return {
      projectId: row.project_id,
      name: row.name,
      path: row.path,
      taskProjectName: row.task_project_name,
      registered: true,
      worktreeEligible: false,
      useWorktreeByDefault: false,
    };
  }

  resolveLegacyPath(projectPath) {
    let resolved;
    try { resolved = fs.realpathSync(projectPath); } catch (_) { throw runtimeError('invalid_project_id', 'Choose a configured remote project'); }
    const row = this.db.prepare('SELECT project_id FROM runtime_projects WHERE path = ? AND registered = 1').get(resolved);
    return row ? this.resolveProject(row.project_id) : null;
  }

  _request(requestId, hash) {
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128 || /[\0-\x1f\x7f]/.test(requestId)) {
      throw runtimeError('invalid_request_id', 'requestId must be 1-128 characters');
    }
    const existing = this.db.prepare('SELECT * FROM runtime_project_requests WHERE request_id = ?').get(requestId);
    if (!existing) return null;
    if (existing.request_hash !== hash) throw runtimeError('idempotency_conflict', 'The request ID was already used for a different request');
    const result = JSON.parse(existing.result_json);
    if (result.operationId) {
      const operation = this.getOperation(result.operationId);
      if (operation) return { operationId: operation.operationId, state: operation.state, ...(operation.projectId ? { projectId: operation.projectId } : {}) };
    }
    return result;
  }

  _recordRequest(requestId, hash, result) {
    this.db.prepare('INSERT INTO runtime_project_requests (request_id, request_hash, result_json) VALUES (?, ?, ?)')
      .run(requestId, hash, JSON.stringify(result));
    return result;
  }

  register({ rootId, relativePath, requestId }) {
    const hash = requestHash('register', { rootId, relativePath });
    const duplicate = this._request(requestId, hash);
    if (duplicate) return duplicate;
    const root = this._root(rootId);
    const projectPath = this._containedExisting(root, relativePath);
    const registered = this._registerPath(projectPath, root.root_id);
    const revision = registered.changed ? this._bumpRevision() : this.getRevision();
    return this._recordRequest(requestId, hash, { projectId: registered.row.project_id, revision, registered: true });
  }

  unregister({ projectId, requestId }) {
    const hash = requestHash('unregister', { projectId });
    const duplicate = this._request(requestId, hash);
    if (duplicate) return duplicate;
    const project = this.resolveProject(projectId);
    const activeOperation = this.db.prepare(`SELECT operation_id FROM runtime_project_operations WHERE project_id = ? AND state IN ('queued', 'running', 'cancelling')`).get(projectId);
    if (activeOperation) throw runtimeError('project_busy', 'The project is busy');
    this.db.prepare('UPDATE runtime_projects SET registered = 0, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?').run(project.projectId);
    const revision = this._bumpRevision();
    return this._recordRequest(requestId, hash, { projectId: project.projectId, revision, registered: false });
  }

  update({ projectId, displayName, color, icon, requestId }) {
    const patch = {
      ...(displayName !== undefined ? { displayName: String(displayName || '').trim().slice(0, 120) } : {}),
      ...(color !== undefined ? { color: String(color || '').trim().slice(0, 32) } : {}),
      ...(icon !== undefined ? { icon } : {}),
    };
    if (!Object.keys(patch).length || (patch.displayName !== undefined && !patch.displayName)
      || (patch.icon !== undefined && patch.icon !== null && (typeof patch.icon !== 'string' || !ICON_PATTERN.test(patch.icon)))) {
      throw runtimeError('invalid_project_update', 'Project changes are invalid');
    }
    const hash = requestHash('update', { projectId, ...patch });
    const duplicate = this._request(requestId, hash);
    if (duplicate) return duplicate;
    const project = this.resolveProject(projectId);
    this.db.prepare(`UPDATE runtime_projects
      SET display_name = COALESCE(?, display_name), color = COALESCE(?, color), icon = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?`).run(
        patch.displayName ?? null,
        patch.color ?? null,
        patch.icon === undefined ? this.db.prepare('SELECT icon FROM runtime_projects WHERE project_id = ?').get(projectId)?.icon || null : patch.icon,
        project.projectId,
      );
    const revision = this._bumpRevision();
    return this._recordRequest(requestId, hash, { projectId: project.projectId, revision, updated: true });
  }

  clone({ rootId, url, relativePath, displayName, color, icon, requestId }) {
    const normalizedUrl = validateGitUrl(url);
    const root = this._root(rootId);
    this._assertSecureCloneRoot(root);
    const normalizedRelative = validateCloneChildName(relativePath || cloneDirectoryName(normalizedUrl));
    const appearance = {
      ...(displayName !== undefined ? { displayName: String(displayName || '').trim().slice(0, 120) } : {}),
      ...(color !== undefined ? { color: String(color || '').trim().slice(0, 32) } : {}),
      ...(icon !== undefined ? { icon } : {}),
    };
    if ((appearance.displayName !== undefined && !appearance.displayName)
      || (appearance.icon !== undefined && appearance.icon !== null
        && (typeof appearance.icon !== 'string' || !ICON_PATTERN.test(appearance.icon)))) {
      throw runtimeError('invalid_project_update', 'Project changes are invalid');
    }
    const hash = requestHash('clone', { rootId, url: normalizedUrl, relativePath: normalizedRelative, ...appearance });
    const duplicate = this._request(requestId, hash);
    if (duplicate) return duplicate;
    const destinationInfo = this._cloneDestination(root, normalizedRelative, normalizedUrl);
    if (this.destinations.has(destinationInfo.destination)) throw runtimeError('destination_exists', 'A clone already owns this destination');
    if (this.queue.length >= MAX_QUEUE) throw runtimeError('clone_queue_full', 'The clone queue is full', true);
    const operationId = randomId();
    this.db.prepare(`
      INSERT INTO runtime_project_operations (operation_id, request_id, state, root_id, destination_path)
      VALUES (?, ?, 'queued', ?, ?)
    `).run(operationId, requestId, rootId, destinationInfo.destination);
    const result = this._recordRequest(requestId, hash, { operationId, state: 'queued' });
    const operation = {
      operationId,
      requestId,
      rootId,
      url: normalizedUrl,
      appearance,
      destination: destinationInfo.destination,
      temporaryDestination: null,
      temporaryIdentity: null,
      child: null,
      cancelRequested: false,
    };
    this.destinations.set(destinationInfo.destination, operationId);
    this.queue.push(operation);
    this._emitOperation(operationId, requestId, 'queued');
    this._drain();
    return result;
  }

  getOperation(operationId) {
    const row = this.db.prepare('SELECT * FROM runtime_project_operations WHERE operation_id = ?').get(operationId);
    return row ? {
      operationId: row.operation_id,
      requestId: row.request_id,
      type: 'clone',
      state: row.state,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.error ? { error: row.error } : {}),
    } : null;
  }

  cancelClone({ operationId, requestId }) {
    if (typeof operationId !== 'string' || !ID_PATTERN.test(operationId)) throw runtimeError('operation_not_found', 'The clone operation was not found');
    const hash = requestHash('clone.cancel', { operationId });
    const duplicate = this._request(requestId, hash);
    if (duplicate) return duplicate;
    const operation = this.getOperation(operationId);
    if (!operation) throw runtimeError('operation_not_found', 'The clone operation was not found');
    if (!['queued', 'running', 'cancelling'].includes(operation.state)) throw runtimeError('operation_not_cancellable', 'The clone operation cannot be cancelled');
    const queuedIndex = this.queue.findIndex((entry) => entry.operationId === operationId);
    if (queuedIndex >= 0) {
      const [queued] = this.queue.splice(queuedIndex, 1);
      this._finish(queued, 'cancelled', 'cancelled');
      return this._recordRequest(requestId, hash, { operationId, state: 'cancelled' });
    }
    const running = this.running.get(operationId);
    if (!running) throw runtimeError('operation_not_cancellable', 'The clone operation cannot be cancelled');
    running.cancelRequested = true;
    this.db.prepare("UPDATE runtime_project_operations SET state = 'cancelling', updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?").run(operationId);
    this._emitOperation(operationId, running.requestId, 'cancelling');
    try { running.child.kill('SIGTERM'); } catch (_) {}
    const timer = setTimeout(() => {
      if (this.running.has(operationId)) {
        try { running.child.kill('SIGKILL'); } catch (_) {}
      }
    }, 3000);
    timer.unref?.();
    return this._recordRequest(requestId, hash, { operationId, state: 'cancelling' });
  }

  _drain() {
    if (this.stopping) return;
    while (this.running.size < this.maxConcurrentClones && this.queue.length) {
      const operation = this.queue.shift();
      this._startClone(operation);
    }
  }

  _startClone(operation) {
    let root;
    let destination;
    try {
      root = this._root(operation.rootId);
      this._assertSecureCloneRoot(root);
      ({ destination } = this._cloneDestination(
        root,
        path.relative(root.path, operation.destination).split(path.sep).join('/'),
        operation.url,
      ));
      if (destination !== operation.destination) return this._finish(operation, 'failed', 'clone_failed');
      operation.temporaryDestination = path.join(root.path, `.cas-clone-${operation.operationId}`);
      if (path.dirname(operation.temporaryDestination) !== root.path) {
        return this._finish(operation, 'failed', 'clone_failed');
      }
      fs.mkdirSync(operation.temporaryDestination, { mode: 0o700 });
      this.db.prepare("UPDATE runtime_project_operations SET created_destination = 1, updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?")
        .run(operation.operationId);
      const temporaryRealPath = fs.realpathSync(operation.temporaryDestination);
      const temporaryStat = fs.lstatSync(operation.temporaryDestination);
      operation.temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
      if (temporaryRealPath !== operation.temporaryDestination
        || fs.realpathSync(path.dirname(operation.temporaryDestination)) !== root.path
        || !temporaryStat.isDirectory()
        || (temporaryStat.mode & 0o777) !== 0o700) {
        return this._finish(operation, 'failed', 'path_symlink_escape');
      }
    } catch (error) {
      return this._finish(operation, 'failed', error?.code === 'EEXIST'
        ? 'destination_exists'
        : (error?.code === 'clone_root_insecure' ? error.code : 'clone_failed'));
    }
    this.db.prepare("UPDATE runtime_project_operations SET state = 'running', updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?")
      .run(operation.operationId);
    this.running.set(operation.operationId, operation);
    this._emitOperation(operation.operationId, operation.requestId, 'running');
    let child;
    try {
      child = this.spawnImpl('git', ['-c', 'protocol.file.allow=never', 'clone', '--', operation.url, operation.temporaryDestination], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' },
      });
    } catch (_) {
      return this._finish(operation, 'failed', 'git_not_found');
    }
    operation.child = child;
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8192); });
    child.once('error', (error) => {
      this._finish(operation, 'failed', error.code === 'ENOENT' ? 'git_not_found' : 'clone_failed');
    });
    child.once('close', (code, signal) => {
      if (!this.running.has(operation.operationId)) return;
      if (operation.cancelRequested || signal) return this._finish(operation, 'cancelled', 'cancelled');
      if (code !== 0) {
        const auth = /auth|permission denied|publickey|credential|could not read username/i.test(stderr);
        return this._finish(operation, 'failed', auth ? 'git_auth_failed' : 'clone_failed');
      }
      try {
        const currentRoot = this._root(operation.rootId);
        this._assertSecureCloneRoot(currentRoot);
        const temporaryStat = fs.lstatSync(operation.temporaryDestination);
        if (currentRoot.path !== root.path
          || fs.realpathSync(operation.temporaryDestination) !== operation.temporaryDestination
          || temporaryStat.dev !== operation.temporaryIdentity?.dev
          || temporaryStat.ino !== operation.temporaryIdentity?.ino
          || fs.existsSync(operation.destination)) {
          return this._finish(operation, 'failed', fs.existsSync(operation.destination) ? 'destination_exists' : 'path_symlink_escape');
        }
        fs.renameSync(operation.temporaryDestination, operation.destination);
        const resolved = fs.realpathSync(operation.destination);
        if (resolved !== operation.destination
          || path.dirname(resolved) !== root.path
          || !fs.statSync(resolved).isDirectory()) {
          return this._finish(operation, 'failed', 'path_symlink_escape');
        }
        const registered = this._registerPath(resolved, root.root_id);
        if (Object.keys(operation.appearance).length) {
          this.db.prepare(`UPDATE runtime_projects
            SET display_name = COALESCE(?, display_name), color = COALESCE(?, color), icon = ?, updated_at = CURRENT_TIMESTAMP
            WHERE project_id = ?`).run(
            operation.appearance.displayName ?? null,
            operation.appearance.color ?? null,
            operation.appearance.icon === undefined ? registered.row.icon || null : operation.appearance.icon,
            registered.row.project_id,
          );
        }
        const revision = registered.changed || Object.keys(operation.appearance).length
          ? this._bumpRevision() : this.getRevision();
        this.db.prepare(`UPDATE runtime_project_operations SET state = 'succeeded', project_id = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?`)
          .run(registered.row.project_id, operation.operationId);
        this.running.delete(operation.operationId);
        this.destinations.delete(operation.destination);
        this._emitOperation(operation.operationId, operation.requestId, 'succeeded', { projectId: registered.row.project_id, revision });
        this._drain();
      } catch (error) {
        this._finish(operation, 'failed', error?.code === 'clone_root_insecure' ? error.code : 'clone_failed');
      }
    });
  }

  _cleanupTemporaryDestination(operation) {
    const row = this.db.prepare('SELECT created_destination FROM runtime_project_operations WHERE operation_id = ?').get(operation.operationId);
    if (!row?.created_destination || !operation.temporaryDestination || !fs.existsSync(operation.temporaryDestination)) return;
    if (path.basename(operation.temporaryDestination) !== `.cas-clone-${operation.operationId}`) return;
    let stat;
    try { stat = fs.lstatSync(operation.temporaryDestination); } catch (_) { return; }
    if (stat.dev !== operation.temporaryIdentity?.dev || stat.ino !== operation.temporaryIdentity?.ino) return;
    fs.rmSync(operation.temporaryDestination, { recursive: true, force: true });
  }

  _finish(operation, state, error = null, { cleanup = true } = {}) {
    this.running.delete(operation.operationId);
    this.destinations.delete(operation.destination);
    if (cleanup && state !== 'succeeded') this._cleanupTemporaryDestination(operation);
    this.db.prepare('UPDATE runtime_project_operations SET state = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?')
      .run(state, error, operation.operationId);
    this._emitOperation(operation.operationId, operation.requestId, state, error ? {
      error: { code: error, message: error, retryable: false },
    } : {});
    this._drain();
  }

  _emitOperation(operationId, requestId, state, extra = {}) {
    this.onOperation({ operationId, requestId, type: 'clone', state, revision: this.getRevision(), ...extra });
  }

  async stop() {
    this.stopping = true;
    for (const operation of this.queue.splice(0)) this._finish(operation, 'cancelled', 'cancelled');
    await Promise.all(Array.from(this.running.values()).map((operation) => new Promise((resolve) => {
      operation.cancelRequested = true;
      const child = operation.child;
      if (!child) {
        this._finish(operation, 'cancelled', 'cancelled');
        resolve();
        return;
      }
      let forceTimer;
      let abandonTimer;
      const done = () => {
        clearTimeout(forceTimer);
        clearTimeout(abandonTimer);
        resolve();
      };
      child.once('close', done);
      try { child.kill('SIGTERM'); } catch (_) {}
      forceTimer = setTimeout(() => {
        if (!this.running.has(operation.operationId)) return done();
        try { child.kill('SIGKILL'); } catch (_) {}
        abandonTimer = setTimeout(() => {
          if (this.running.has(operation.operationId)) {
            this._finish(operation, 'cancelled', 'cancelled');
          }
          done();
        }, this.stopTimeoutMs);
      }, this.stopTimeoutMs);
    })));
  }
}

module.exports = {
  HeadlessProjectRegistry,
  contained,
  runtimeError,
  validateGitUrl,
  validateCloneChildName,
  validateRelativePath,
};
