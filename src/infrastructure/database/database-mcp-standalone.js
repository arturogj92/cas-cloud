// Standalone version of database-mcp.js that uses sqlite3 CLI
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Import platform modules for cross-platform compatibility
const platformConfig = require('../platform/platform-config');
const platformUtils = require('../platform/platform-utils');

// Default catalog of terminal statuses (the PHASE the current work is in).
// Seeded into the terminal_statuses table only when it is empty, so future user
// edits are never clobbered. Labels and prompts are English (the prompt is
// injected into the set_terminal_status MCP tool description; users translate or
// reword it from Settings > Terminal Statuses).
// sort_order doubles as the TAB priority when "sort tabs by status" is on (tabbed
// mode): attention-first (needs_input) at the top, in-progress/finished at the bottom.
// KEEP IN SYNC with database.js and the renderer's TERMINAL_STATUS_FALLBACK_CATALOG.
// `agent_settable: 0` marks a status the APP owns: hidden from the
// set_terminal_status tool description and rejected as an agent input, while the
// manual dropdown and Settings still offer it. KEEP IN SYNC with database.js.
const DEFAULT_TERMINAL_STATUSES = [
  { status_key: 'needs_input', label: 'Needs input', color: '#f97316', icon: 'message-circle-question', sort_order: 1, is_default: 1, agent_settable: 1, prompt: 'Set it when you stop because you need an answer or a decision from the user to continue (a question, a design choice, a permission).' },
  { status_key: 'needs_testing', label: 'Needs testing', color: '#3b82f6', icon: 'flask-conical', sort_order: 2, is_default: 1, agent_settable: 1, prompt: 'Set it when you finish the implementation and the work is pending the user testing it manually. Do not set it if there are still things left to implement.' },
  { status_key: 'working', label: 'Working', color: '#fbbf24', icon: 'hammer', sort_order: 3, is_default: 1, agent_settable: 1, prompt: 'Set it when you start working on any request and while you are implementing, investigating or fixing something.' },
  { status_key: 'done', label: 'Done', color: '#22c55e', icon: 'circle-check', sort_order: 4, is_default: 1, agent_settable: 1, prompt: 'Set it when the work is completely finished: implemented, validated and with its commit/push done when applicable. It is the final state.' },
  { status_key: 'idle', label: 'Idle', color: '#6b7280', icon: 'circle-dashed', sort_order: 5, is_default: 1, agent_settable: 0, prompt: 'Set by the app on an agent that has just been opened and has not been given any work yet. Agents cannot set this status; it clears itself as soon as you send the agent something.' }
];

// The status the app seeds on a freshly opened terminal nobody has written to yet,
// plus the one-shot marker for the migration that back-fills it into catalogs
// created before it existed. KEEP IN SYNC with database.js.
const IDLE_TERMINAL_STATUS_KEY = 'idle';
const IDLE_STATUS_SEEDED_SETTING = 'terminal_status_idle_seeded';

// The first shipped catalog ordered the defaults working-first (working=1 … done=6).
// The tab-sort feature (#12083) reordered them attention-first; a user who never
// reordered still carries this exact arrangement. KEEP IN SYNC with database.js.
const LEGACY_DEFAULT_SORT_ORDER = {
  working: 1,
  needs_input: 2,
  needs_testing: 3,
  pending_commit: 4,
  blocked: 5,
  done: 6
};

// Legacy SPANISH factory prompts from the first shipped catalog. A default status
// still carrying one VERBATIM was never edited by the user, so it can be safely
// upgraded to the English wording. KEEP IN SYNC with database.js.
const LEGACY_DEFAULT_PROMPTS = {
    idle: 'Set by the app when an agent is resting without an explicit work status, including after a reply finishes. It does not mean the work is complete or that user input is required. Agents cannot set this status.',
  working: 'Ponlo al empezar a trabajar en cualquier petición y mientras estés implementando, investigando o arreglando algo.',
  needs_input: 'Ponlo cuando pares porque necesites una respuesta o decisión del usuario para continuar (una pregunta, una elección de diseño, un permiso).',
  needs_testing: 'Ponlo cuando termines la implementación y el trabajo quede pendiente de que el usuario lo pruebe a mano. No lo pongas si aún quedan cosas por implementar.',
  pending_commit: 'Ponlo cuando el usuario ya haya validado el trabajo y solo falte commitear o pushear.',
  blocked: 'Ponlo cuando no puedas avanzar por algo externo que no dependa de ti ni del usuario: CI rota, una dependencia caída, permisos que fallan, un bug de terceros.',
  done: 'Ponlo cuando el trabajo esté completamente terminado: implementado, validado y con su commit/push hecho si tocaba. Es el estado final.'
};

// 'blocked' and 'pending_commit' were RETIRED from the default catalog on
// 2026-07-16 (4 statuses are enough). Existing installs still carry them, so a
// boot migration deletes each one — but ONLY while it is a pristine, enabled
// factory row: label, color and prompt (English, or the legacy Spanish factory
// wording) all untouched. Any user edit or a deliberate disable keeps the row.
// KEEP IN SYNC with database.js.
const RETIRED_DEFAULT_TERMINAL_STATUSES = [
  {
    status_key: 'blocked',
    label: 'Blocked',
    color: '#ef4444',
    prompt_en: 'Set it when you cannot make progress due to something external that does not depend on you or the user: broken CI, a dependency that is down, failing permissions, a third-party bug.',
    prompt_es: LEGACY_DEFAULT_PROMPTS.blocked
  },
  {
    status_key: 'pending_commit',
    label: 'Pending commit/push',
    color: '#a78bfa',
    prompt_en: 'Set it when the user has already validated the work and only the commit or push remains.',
    prompt_es: LEGACY_DEFAULT_PROMPTS.pending_commit
  }
];

/**
 * Find the sqlite3 executable path
 * On Windows, checks our custom installation first, then system PATH
 * On other platforms, uses system sqlite3
 * @returns {string} Path to sqlite3 executable
 */
function findSqlite3Path() {
  if (process.platform === 'win32') {
    // Check our custom installation location first
    const appDataPath = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'codeagentswarm')
      : path.join(os.homedir(), 'codeagentswarm');
    const customSqlite3 = path.join(appDataPath, 'bin', 'sqlite3.exe');

    if (fs.existsSync(customSqlite3)) {
      console.error(`[MCP Database] Using custom sqlite3 at: ${customSqlite3}`);
      return `"${customSqlite3}"`;
    }

    // Check system PATH
    try {
      const wherePath = execSync('where sqlite3', { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (wherePath) {
        const firstPath = wherePath.split('\n')[0].trim();
        console.error(`[MCP Database] Using system sqlite3 at: ${firstPath}`);
        return `"${firstPath}"`;
      }
    } catch (e) {
      // Not found in PATH
    }

    // Last resort - hope it's in PATH or will be installed soon
    console.warn('[MCP Database] sqlite3 not found! MCP will wait for app to install it.');
    console.warn('[MCP Database] Expected location:', customSqlite3);
    return 'sqlite3'; // Will fail, but at least we tried
  }

  // On macOS/Linux, sqlite3 should be available in PATH
  return 'sqlite3';
}

class DatabaseManagerMCP {
  constructor() {
    // Find sqlite3 executable path
    this.sqlite3Cmd = findSqlite3Path();

    // Check for environment override (for testing)
    if (process.env.CODEAGENTSWARM_DB_PATH) {
      this.dbPath = process.env.CODEAGENTSWARM_DB_PATH;
      // Ensure parent directory exists
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } else {
      // Use platform-specific path
      const appDataDir = platformConfig.getAppDataPath();

      if (!fs.existsSync(appDataDir)) {
        fs.mkdirSync(appDataDir, { recursive: true });
      }

      this.dbPath = platformConfig.getDatabasePath();
    }

    console.error(`[MCP Database] Using database at: ${this.dbPath}`);
    console.error(`[MCP Database] SQLite command: ${this.sqlite3Cmd}`);

    // Initialize database if needed
    this.initialize();
  }

  // Execute SQL using sqlite3 command line
  execSQL(sql, params = []) {
    try {
      let finalSQL = sql;

      if (params.length > 0) {
        // Replace ? placeholders with properly escaped values
        let paramIndex = 0;
        finalSQL = sql.replace(/\?/g, () => {
          if (paramIndex < params.length) {
            const param = params[paramIndex++];
            if (param === null || param === undefined) {
              return 'NULL';
            } else if (typeof param === 'number') {
              return param;
            } else {
              // Escape single quotes by doubling them
              const escaped = String(param).replace(/'/g, "''");
              return `'${escaped}'`;
            }
          }
          return '?';
        });
      }

      // Use echo and pipe to avoid shell interpretation issues
      // Create a temporary file to avoid command line length limits and escaping issues.
      // The name MUST be unique per process AND per call: several MCP server processes
      // (one per terminal) share os.tmpdir(), and Date.now() alone collides within the
      // same millisecond — a colliding writer makes sqlite3 execute the OTHER caller's
      // statement (seen as spurious UNIQUE-constraint failures while seeding statuses).
      DatabaseManagerMCP._sqlTempCounter = (DatabaseManagerMCP._sqlTempCounter || 0) + 1;
      const tempFile = path.join(
        os.tmpdir(),
        `mcp-sql-${process.pid}-${Date.now()}-${DatabaseManagerMCP._sqlTempCounter}-${Math.random().toString(36).slice(2, 8)}.sql`
      );
      fs.writeFileSync(tempFile, finalSQL);

      let result;
      try {
        // Execute sqlite3 command
        result = platformUtils.execCommand(`${this.sqlite3Cmd} "${this.dbPath}" < "${tempFile}"`, {
          maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });
      } finally {
        // Clean up temp file even when the command fails (a leaked file is harmless
        // now that names are unique, but don't litter tmpdir on every SQL error)
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      return result.trim();
    } catch (error) {
      console.error('[MCP Database] SQL Error:', error.message);
      console.error('[MCP Database] SQL Query:', sql);
      console.error('[MCP Database] SQL Params:', params);
      throw error;
    }
  }

  // Parse SQLite output into objects
  parseRows(output, columns) {
    if (!output) return [];
    
    const lines = output.split('\n').filter(line => line.trim());
    return lines.map(line => {
      const values = line.split('|');
      const obj = {};
      columns.forEach((col, i) => {
        obj[col] = values[i] || null;
      });
      return obj;
    });
  }

  initialize() {
    try {
      // Enable WAL mode for better concurrent access
      // WAL (Write-Ahead Logging) allows multiple readers and one writer
      // This prevents "database is locked" errors when multiple MCP instances run
      this.execSQL('PRAGMA journal_mode = WAL;');
      this.execSQL('PRAGMA busy_timeout = 5000;');

      // Create tables if they don't exist
      // NOTE: terminal_id column REMOVED - task-terminal mappings are now stored in RAM only (main.js)
      // MCP servers communicate mappings via file-based notifications
      const createTables = `
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          plan TEXT,
          implementation TEXT,
          status TEXT DEFAULT 'pending',
          project TEXT,
          labels TEXT DEFAULT '[]',
          images TEXT DEFAULT '[]',
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          parent_task_id INTEGER,
          FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );
        
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          path TEXT UNIQUE,
          display_name TEXT,
          color TEXT NOT NULL,
          icon TEXT DEFAULT NULL,
          last_opened DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

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
        
        CREATE TABLE IF NOT EXISTS terminal_directories (
          terminal_id INTEGER PRIMARY KEY,
          directory TEXT,
          last_used DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS conversation_bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          project_dir TEXT,
          project_name TEXT,
          agent_type TEXT DEFAULT 'claude',
          display_text TEXT,
          custom_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, project_path)
        );

        CREATE TABLE IF NOT EXISTS worktrees (
          session_id TEXT PRIMARY KEY,
          repo_root TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_branch TEXT,
          group_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS terminal_statuses (
          status_key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          color TEXT NOT NULL,
          icon TEXT NOT NULL,
          prompt TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_default INTEGER NOT NULL DEFAULT 0,
          agent_settable INTEGER NOT NULL DEFAULT 1
        );
      `;
      
      // Execute each statement separately
      const statements = createTables.split(';').filter(s => s.trim());
      statements.forEach(stmt => {
        if (stmt.trim()) {
          this.execSQL(stmt);
        }
      });

      // Run migrations
      this.addProjectUpdatedAtColumnIfNeeded();
      this.addIconColumnIfNeeded();
      this.addImagesColumnToTasksIfNeeded();
      this.addLastOpenedColumnToProjectsIfNeeded();
      this.addBaseBranchColumnToWorktreesIfNeeded();
      this.addGroupIdColumnToWorktreesIfNeeded();

      // Seed the terminal status catalog with defaults on first run
      this.addAgentSettableColumnToTerminalStatusesIfNeeded();
      this.seedTerminalStatusesIfEmpty();
      this.addEnabledColumnToTerminalStatusesIfNeeded();
      this.migrateLegacyTerminalStatusPrompts();
      this.migrateDefaultTerminalStatusSortOrderIfPristine();
      this.migrateRetiredDefaultTerminalStatuses();
      this.migrateIdleTerminalStatus();

    } catch (error) {
      console.error('[MCP Database] Failed to initialize:', error.message);
    }
  }

  // Seed the terminal_statuses catalog with the defaults, but ONLY when the table
  // is empty. Idempotent and preserves any user edits/deletions once populated.
  // Mirrors database.js so both implementations stay in parity.
  seedTerminalStatusesIfEmpty() {
    try {
      const result = this.execSQL(`.mode json\nSELECT COUNT(*) AS count FROM terminal_statuses`);
      let count = 0;
      if (result && result.trim() !== '' && result.trim() !== '[]') {
        const rows = JSON.parse(result);
        if (rows && rows.length > 0) {
          count = parseInt(rows[0].count) || 0;
        }
      }

      if (count > 0) {
        return;
      }

      // Single multi-row INSERT (one sqlite3 invocation): the seed is atomic, so a
      // failure can never leave a partial catalog behind (a partial seed passes the
      // count>0 gate forever after and would be missing statuses permanently).
      const placeholders = DEFAULT_TERMINAL_STATUSES.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = DEFAULT_TERMINAL_STATUSES.flatMap(status => [
        status.status_key,
        status.label,
        status.color,
        status.icon,
        status.prompt,
        status.sort_order,
        status.is_default,
        status.agent_settable
      ]);
      this.execSQL(
        `INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default, agent_settable)
         VALUES ${placeholders}`,
        params
      );
      // A catalog seeded from scratch already contains 'idle': keep the back-fill
      // migration from looking at it again.
      this.saveSetting(IDLE_STATUS_SEEDED_SETTING, true);
    } catch (error) {
      console.error('[MCP Database] Error seeding terminal statuses:', error.message);
    }
  }

  // Migration: statuses the APP owns (agent_settable = 0) are offered in the manual
  // dropdown and Settings but hidden from the MCP tool and rejected as agent input.
  // Everything that predates the column stays agent-settable. Mirrors database.js.
  addAgentSettableColumnToTerminalStatusesIfNeeded() {
    try {
      const result = this.execSQL('PRAGMA table_info(terminal_statuses)');
      if (!result || !result.includes('agent_settable')) {
        this.execSQL('ALTER TABLE terminal_statuses ADD COLUMN agent_settable INTEGER NOT NULL DEFAULT 1');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding agent_settable column to terminal_statuses:', error.message);
    }
  }

  // Migration: add 'idle' to catalogs created before it existed (the seed only runs
  // on an EMPTY table). Guarded by a one-shot setting rather than "insert if
  // missing", so a user who deletes it never sees it come back. Runs LAST so the
  // sort-order and retired-defaults migrations still see the catalog shape they
  // were written against. Mirrors database.js.
  migrateIdleTerminalStatus() {
    try {
      if (this.getSetting(IDLE_STATUS_SEEDED_SETTING)) return;

      const idle = DEFAULT_TERMINAL_STATUSES.find(s => s.status_key === IDLE_TERMINAL_STATUS_KEY);
      if (!idle) return;

      const existing = this.getTerminalStatuses() || [];
      if (!existing.some(s => s.status_key === IDLE_TERMINAL_STATUS_KEY)) {
        // Park it after everything the user already has: sort_order doubles as the
        // tab priority, and a terminal with no work assigned belongs last.
        const maxOrder = existing.reduce((max, s) => Math.max(max, parseInt(s.sort_order) || 0), 0);
        this.execSQL(
          `INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default, agent_settable)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [idle.status_key, idle.label, idle.color, idle.icon, idle.prompt, maxOrder + 1, idle.is_default, idle.agent_settable]
        );
      }

      this.saveSetting(IDLE_STATUS_SEEDED_SETTING, true);
    } catch (error) {
      console.error('[MCP Database] Error migrating idle terminal status:', error.message);
    }
  }

  // Migration: upgrade the legacy factory prompts to the English ones.
  // Only default statuses whose prompt is still the legacy string VERBATIM (never
  // edited by the user) are touched. Idempotent. Mirrors database.js.
  migrateLegacyTerminalStatusPrompts() {
    try {
      for (const status of DEFAULT_TERMINAL_STATUSES) {
        const legacy = LEGACY_DEFAULT_PROMPTS[status.status_key];
        if (!legacy) continue;
        this.execSQL(
          `UPDATE terminal_statuses SET prompt = ?
           WHERE status_key = ? AND is_default = 1 AND prompt = ?`,
          [status.prompt, status.status_key, legacy]
        );
      }
    } catch (error) {
      console.error('[MCP Database] Error migrating legacy terminal status prompts:', error.message);
    }
  }

  // Migration: reorder the default statuses to the attention-first priority used by
  // "sort tabs by status" (#12083). ONLY when the six defaults still carry the OLD
  // arrangement VERBATIM (working=1 … done=6). No-op otherwise. Mirrors database.js.
  migrateDefaultTerminalStatusSortOrderIfPristine() {
    try {
      const result = this.execSQL(`.mode json\nSELECT status_key, sort_order FROM terminal_statuses WHERE is_default = 1`);
      let rows = [];
      if (result && result.trim() !== '' && result.trim() !== '[]') {
        rows = JSON.parse(result);
      }
      const current = {};
      for (const row of rows) current[row.status_key] = parseInt(row.sort_order);

      const legacyKeys = Object.keys(LEGACY_DEFAULT_SORT_ORDER);
      const isPristine = legacyKeys.length === rows.length &&
        legacyKeys.every(key => current[key] === LEGACY_DEFAULT_SORT_ORDER[key]);
      if (!isPristine) return;

      for (const status of DEFAULT_TERMINAL_STATUSES) {
        this.execSQL(
          `UPDATE terminal_statuses SET sort_order = ? WHERE status_key = ? AND is_default = 1`,
          [status.sort_order, status.status_key]
        );
      }
    } catch (error) {
      console.error('[MCP Database] Error migrating default terminal status sort order:', error.message);
    }
  }

  // Migration: delete the RETIRED defaults ('blocked', 'pending_commit') from
  // existing catalogs — ONLY while each row is still a pristine, enabled factory
  // row (label, color and prompt untouched, English or legacy Spanish wording).
  // Runs AFTER the sort-order migration on purpose (it needs all six legacy rows
  // to detect a pristine install). Idempotent. Mirrors database.js.
  migrateRetiredDefaultTerminalStatuses() {
    try {
      for (const retired of RETIRED_DEFAULT_TERMINAL_STATUSES) {
        this.execSQL(
          `DELETE FROM terminal_statuses
           WHERE status_key = ? AND is_default = 1 AND enabled = 1
             AND label = ? AND color = ?
             AND prompt IN (?, ?)`,
          [retired.status_key, retired.label, retired.color, retired.prompt_en, retired.prompt_es]
        );
      }
    } catch (error) {
      console.error('[MCP Database] Error migrating retired terminal statuses:', error.message);
    }
  }

  // Migration: statuses can be DISABLED without deleting them (Settings toggle).
  // Mirrors database.js. Guarded + idempotent via PRAGMA table_info.
  addEnabledColumnToTerminalStatusesIfNeeded() {
    try {
      const result = this.execSQL('PRAGMA table_info(terminal_statuses)');
      if (result && !result.includes('enabled')) {
        this.execSQL('ALTER TABLE terminal_statuses ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding enabled column to terminal_statuses:', error.message);
    }
  }

  // Return the whole catalog of terminal statuses ordered by sort_order ASC.
  // Includes DISABLED ones (enabled: 0); the MCP tool filters on `enabled`.
  getTerminalStatuses() {
    try {
      const sql = `SELECT status_key, label, color, icon, prompt, sort_order, is_default, enabled, agent_settable
                   FROM terminal_statuses ORDER BY sort_order ASC`;
      const result = this.execSQL(`.mode json\n${sql}`);

      if (!result || result.trim() === '' || result.trim() === '[]') {
        return [];
      }

      const rows = JSON.parse(result);
      return rows.map(row => ({
        status_key: row.status_key,
        label: row.label,
        color: row.color,
        icon: row.icon,
        prompt: row.prompt,
        sort_order: parseInt(row.sort_order) || 0,
        is_default: parseInt(row.is_default) || 0,
        enabled: row.enabled === undefined || row.enabled === null ? 1 : (parseInt(row.enabled) || 0),
        // Rows from a pre-migration DB have no column: default to agent-settable.
        agent_settable: row.agent_settable === undefined || row.agent_settable === null ? 1 : (parseInt(row.agent_settable) || 0)
      }));
    } catch (error) {
      console.error('[MCP Database] Error getting terminal statuses:', error.message);
      return [];
    }
  }

  // ---- Custom terminal statuses CRUD. Mirrors database.js (Settings UI uses the
  // main implementation; these keep both files in parity per the dual-file rule).
  // status_key is IMMUTABLE once created (terminals/agents reference it).

  _validateTerminalStatusFields({ label, color, icon, prompt }, { partial = false } = {}) {
    if (!partial || label !== undefined) {
      if (!label || !String(label).trim()) return 'label is required';
    }
    if (!partial || color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return 'color must be a #RRGGBB hex value';
    }
    if (!partial || icon !== undefined) {
      if (!icon || !String(icon).trim()) return 'icon is required';
    }
    if (!partial || prompt !== undefined) {
      if (!prompt || !String(prompt).trim()) return 'prompt is required';
    }
    return null;
  }

  _generateTerminalStatusKey(label) {
    const base = String(label).trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'status';
    const taken = new Set(this.getTerminalStatuses().map(s => s.status_key));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
    }
    return `${base}_${Date.now()}`;
  }

  createTerminalStatus({ label, color, icon, prompt }) {
    try {
      const invalid = this._validateTerminalStatusFields({ label, color, icon, prompt });
      if (invalid) return { success: false, error: invalid };
      const statusKey = this._generateTerminalStatusKey(label);
      const rows = this.getTerminalStatuses();
      const next = rows.reduce((max, s) => Math.max(max, s.sort_order), 0) + 1;
      this.execSQL(
        `INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [statusKey, String(label).trim(), color, String(icon).trim(), String(prompt).trim(), next]
      );
      return { success: true, status_key: statusKey };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  updateTerminalStatus(statusKey, fields) {
    try {
      const invalid = this._validateTerminalStatusFields(fields || {}, { partial: true });
      if (invalid) return { success: false, error: invalid };
      const rows = this.getTerminalStatuses();
      // Disabling: keep at least one ENABLED status.
      if (fields && (fields.enabled === 0 || fields.enabled === false)) {
        const otherEnabled = rows.some(s => s.enabled === 1 && s.status_key !== statusKey);
        if (!otherEnabled) return { success: false, error: 'cannot disable the last enabled status' };
      }
      const allowed = ['label', 'color', 'icon', 'prompt', 'sort_order', 'enabled'];
      const sets = [];
      const params = [];
      for (const col of allowed) {
        if (fields && fields[col] !== undefined) {
          sets.push(`${col} = ?`);
          let value = fields[col];
          if (col === 'enabled') value = value ? 1 : 0;
          else if (typeof value === 'string') value = value.trim();
          params.push(value);
        }
      }
      if (sets.length === 0) return { success: false, error: 'nothing to update' };
      if (!rows.some(s => s.status_key === statusKey)) {
        return { success: false, error: `status "${statusKey}" not found` };
      }
      params.push(statusKey);
      this.execSQL(`UPDATE terminal_statuses SET ${sets.join(', ')} WHERE status_key = ?`, params);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Reorder the whole catalog: sort_order becomes the position in orderedKeys
  // (1-based). Mirrors database.js. Drives the tab priority + dropdown + Settings list.
  reorderTerminalStatuses(orderedKeys) {
    try {
      if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) {
        return { success: false, error: 'orderedKeys must be a non-empty array' };
      }
      orderedKeys.forEach((key, index) => {
        this.execSQL('UPDATE terminal_statuses SET sort_order = ? WHERE status_key = ?', [index + 1, key]);
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  deleteTerminalStatus(statusKey) {
    try {
      const rows = this.getTerminalStatuses();
      if (rows.length <= 1) return { success: false, error: 'cannot delete the last status' };
      const target = rows.find(s => s.status_key === statusKey);
      if (!target) {
        return { success: false, error: `status "${statusKey}" not found` };
      }
      // Deleting the only ENABLED status would leave agents/dropdown with nothing.
      if (target.enabled === 1 && !rows.some(s => s.enabled === 1 && s.status_key !== statusKey)) {
        return { success: false, error: 'cannot delete the last enabled status' };
      }
      this.execSQL('DELETE FROM terminal_statuses WHERE status_key = ?', [statusKey]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  restoreDefaultTerminalStatuses() {
    try {
      // Single sqlite3 invocation so the wipe+reseed is atomic (same rationale as
      // the atomic seed in seedTerminalStatusesIfEmpty).
      const placeholders = DEFAULT_TERMINAL_STATUSES.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = DEFAULT_TERMINAL_STATUSES.flatMap(status => [
        status.status_key, status.label, status.color, status.icon,
        status.prompt, status.sort_order, status.is_default, status.agent_settable
      ]);
      this.execSQL(
        `BEGIN;
         DELETE FROM terminal_statuses;
         INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default, agent_settable)
         VALUES ${placeholders};
         COMMIT;`,
        params
      );
      // The restored catalog already carries 'idle': keep the one-shot migration
      // from adding a second copy later.
      this.saveSetting(IDLE_STATUS_SEEDED_SETTING, true);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Migration: Add base_branch column to worktrees table if it doesn't exist.
  // Mirrors database.js so both implementations stay in parity. Guarded +
  // idempotent: only adds the column when PRAGMA table_info doesn't list it.
  addBaseBranchColumnToWorktreesIfNeeded() {
    try {
      const result = this.execSQL("PRAGMA table_info(worktrees)");

      if (result && !result.includes('base_branch')) {
        console.error('[MCP Database] Adding base_branch column to worktrees table...');
        this.execSQL("ALTER TABLE worktrees ADD COLUMN base_branch TEXT");
        console.error('[MCP Database] base_branch column added to worktrees successfully');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding base_branch column to worktrees:', error.message);
    }
  }

  // Migration: Add group_id column to worktrees table if it doesn't exist.
  // Mirrors database.js so both implementations stay in parity. A composite/
  // group worktree is several rows sharing the same group_id; group_id is NULL
  // for a normal single worktree (today's behavior, unchanged). Guarded +
  // idempotent: only adds the column when PRAGMA table_info doesn't list it.
  addGroupIdColumnToWorktreesIfNeeded() {
    try {
      const result = this.execSQL("PRAGMA table_info(worktrees)");

      if (result && !result.includes('group_id')) {
        console.error('[MCP Database] Adding group_id column to worktrees table...');
        this.execSQL("ALTER TABLE worktrees ADD COLUMN group_id TEXT");
        console.error('[MCP Database] group_id column added to worktrees successfully');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding group_id column to worktrees:', error.message);
    }
  }

  // Migration: Add updated_at column to projects table if it doesn't exist
  addProjectUpdatedAtColumnIfNeeded() {
    try {
      // Check if updated_at column exists in projects table
      const result = this.execSQL("PRAGMA table_info(projects)");

      if (result && !result.includes('updated_at')) {
        console.error('[MCP Database] Adding updated_at column to projects table...');
        // SQLite doesn't allow DEFAULT CURRENT_TIMESTAMP in ALTER TABLE
        // So we add column without default, then UPDATE to set values
        this.execSQL("ALTER TABLE projects ADD COLUMN updated_at DATETIME");

        // Initialize updated_at with created_at for existing projects
        this.execSQL("UPDATE projects SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP)");
        console.error('[MCP Database] updated_at column added to projects successfully');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding updated_at column to projects:', error.message);
    }
  }

  // Migration: Add icon column to projects table if it doesn't exist
  addIconColumnIfNeeded() {
    try {
      const result = this.execSQL("PRAGMA table_info(projects)");

      if (result && !result.includes('icon')) {
        console.error('[MCP Database] Adding icon column to projects table...');
        this.execSQL("ALTER TABLE projects ADD COLUMN icon TEXT DEFAULT NULL");
        console.error('[MCP Database] icon column added to projects successfully');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding icon column to projects:', error.message);
    }
  }

  // Legacy standalone databases predate task image attachments.
  addImagesColumnToTasksIfNeeded() {
    try {
      const result = this.execSQL('PRAGMA table_info(tasks)');
      if (result && !result.includes('images')) {
        this.execSQL("ALTER TABLE tasks ADD COLUMN images TEXT DEFAULT '[]'");
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding images column to tasks:', error.message);
    }
  }

  // Legacy standalone databases predate project recency ordering.
  addLastOpenedColumnToProjectsIfNeeded() {
    try {
      const result = this.execSQL('PRAGMA table_info(projects)');
      if (result && !result.includes('last_opened')) {
        this.execSQL('ALTER TABLE projects ADD COLUMN last_opened DATETIME');
      }
    } catch (error) {
      console.error('[MCP Database] Error checking/adding last_opened column to projects:', error.message);
    }
  }

  // Update project icon
  updateProjectIcon(name, icon) {
    try {
      const sql = `UPDATE projects SET icon = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`;
      this.execSQL(sql, [icon || null, name]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Get project icon value by name
  getProjectIcon(name) {
    try {
      const result = this.execSQL(`SELECT icon FROM projects WHERE name = ?`, [name]);
      return result ? result.trim() : null;
    } catch (error) {
      return null;
    }
  }

  // Task management methods
  async createTask(title, description, terminalId, project = null, parentTaskId = null, labels = [], images = []) {
    // NOTE: terminalId parameter is kept for backwards compatibility but not stored in DB
    // Task-terminal mappings are managed via notification system (writeTaskMappingNotification)

    // If parent_task_id is provided, try to inherit project from parent
    let actualProject = project;
    if (parentTaskId && !actualProject) {
      try {
        const parentTask = await this.getTaskById(parentTaskId);
        if (parentTask && parentTask.project) {
          actualProject = parentTask.project;
          console.error(`[MCP] Inherited project "${actualProject}" from parent task #${parentTaskId}`);
        }
      } catch (e) {
        // Ignore error, use provided project or null
      }
    }

    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Combine INSERT and SELECT in a single SQLite session to get the correct ID
        // Using a temporary file to avoid command line escaping issues
        const tempFile = path.join(os.tmpdir(), `mcp_task_${Date.now()}_${attempt}.sql`);
        const labelsJSON = JSON.stringify(labels || []).replace(/'/g, "''");
        const imagesJSON = JSON.stringify(images || []).replace(/'/g, "''");

        // Use BEGIN IMMEDIATE to acquire write lock immediately
        // This prevents multiple processes from incrementing AUTOINCREMENT simultaneously
        const sqlCommands = `
          BEGIN IMMEDIATE TRANSACTION;
          INSERT INTO tasks (title, description, project, parent_task_id, labels, images)
          VALUES ('${(title || '').replace(/'/g, "''")}',
                  '${(description || '').replace(/'/g, "''")}',
                  ${actualProject ? `'${actualProject.replace(/'/g, "''")}'` : 'NULL'},
                  ${parentTaskId || 'NULL'},
                  '${labelsJSON}',
                  '${imagesJSON}');
          SELECT last_insert_rowid();
          COMMIT;
        `;

        fs.writeFileSync(tempFile, sqlCommands);
        const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" < "${tempFile}"`, {
          encoding: 'utf8',
          timeout: 10000  // 10 seconds timeout
        }).trim();

        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }

        const lastId = result.split('\n').pop(); // Get the last line which should be the ID
        const taskId = parseInt(lastId) || 0;

        // Return success with taskId
        if (taskId > 0) {
          return {
            success: true,
            taskId: taskId
          };
        }

        // If we didn't get a valid ID, retry
        throw new Error('Failed to get task ID after creation');

      } catch (error) {
        attempt++;

        // Check if it's a lock error and we should retry
        if (error.message && (
          error.message.includes('database is locked') ||
          error.message.includes('SQLITE_BUSY') ||
          error.message.includes('cannot start a transaction')
        )) {
          if (attempt < maxRetries) {
            // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
            const backoffMs = 100 * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
        }

        // If it's not a lock error or we've exhausted retries, return error
        return {
          success: false,
          error: `Failed after ${attempt} attempts: ${error.message}`
        };
      }
    }

    // Should never reach here, but just in case
    return {
      success: false,
      error: 'Max retries exceeded'
    };
  }

  updateTaskStatus(taskId, status) {
    try {
      const sql = `UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [status, taskId]);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  updateTaskProject(taskId, project) {
    try {
      const sql = `UPDATE tasks SET project = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [project || null, taskId]);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  startTask(taskId, terminalId) {
    return this.updateTaskStatus(taskId, 'in_progress');
  }

  completeTask(taskId) {
    // First time moves to in_testing, second time to completed
    const currentTask = this.getTaskById(taskId);
    if (!currentTask) {
      return { success: false, error: 'Task not found' };
    }
    
    const newStatus = currentTask.status === 'in_testing' ? 'completed' : 'in_testing';
    return this.updateTaskStatus(taskId, newStatus);
  }

  async getAllTasks(limit = null, offset = 0) {
    try {
      // Use JSON mode for better handling of multiline fields
      // NOTE: terminal_id column removed - mappings now in RAM only
      let query = 'SELECT id, title, description, plan, implementation, status, project, labels, images, parent_task_id, sort_order, created_at, updated_at FROM tasks ORDER BY sort_order ASC, created_at DESC';

      // Add pagination if limit is specified
      if (limit !== null && limit > 0) {
        query += ` LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
      }

      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });

      if (!result || result.trim() === '') {
        return [];
      }

      const tasks = JSON.parse(result);

      // Convert numeric fields and handle nulls
      return tasks.map(task => ({
        ...task,
        id: parseInt(task.id),
        sort_order: parseInt(task.sort_order) || 0,
        labels: task.labels ? JSON.parse(task.labels) : [],
        images: task.images ? JSON.parse(task.images) : [],
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : null
      }));
    } catch (error) {
      console.error('[MCP Database] Error getting all tasks:', error.message);
      return [];
    }
  }

  async getTasksByStatus(status, limit = null, offset = 0) {
    try {
      // Use JSON mode for better handling of multiline fields
      // SQLite doesn't support parameterized queries with .mode json directly, so we need to escape the status
      const escapedStatus = status.replace(/'/g, "''");
      let query = `SELECT id, title, description, plan, implementation, status, project, labels, images, parent_task_id, sort_order, created_at, updated_at FROM tasks WHERE status = '${escapedStatus}' ORDER BY sort_order ASC, created_at DESC`;

      // Add pagination if limit is specified
      if (limit !== null && limit > 0) {
        query += ` LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
      }

      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });

      if (!result || result.trim() === '') {
        return [];
      }

      const tasks = JSON.parse(result);

      return tasks.map(task => ({
        ...task,
        id: parseInt(task.id),
        sort_order: parseInt(task.sort_order) || 0,
        labels: task.labels ? JSON.parse(task.labels) : [],
        images: task.images ? JSON.parse(task.images) : [],
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : null
      }));
    } catch (error) {
      console.error('[MCP Database] Error getting tasks by status:', error.message);
      return [];
    }
  }

  async getRecentTasks(days = 30) {
    try {
      // First set the output mode to list with pipe separator
      this.execSQL('.mode list');
      this.execSQL('.separator "|"');
      
      // Only get root tasks (not subtasks) from recent days, limit to 15
      const query = `
        SELECT id, title, description, plan, implementation, status, project, labels, parent_task_id, sort_order, created_at, updated_at
        FROM tasks
        WHERE datetime(updated_at) > datetime('now', '-${days} days')
          AND parent_task_id IS NULL
        ORDER BY updated_at DESC
        LIMIT 15
      `;

      const output = this.execSQL(query);

      if (!output) return [];

      const lines = output.split('\n').filter(line => line.trim());

      return lines.map(line => {
        const values = line.split('|');
        return {
          id: parseInt(values[0]) || 0,
          title: values[1] || '',
          description: values[2] || '',
          plan: values[3] || '',
          implementation: values[4] || '',
          status: values[5] || 'pending',
          project: values[6] || null,
          labels: values[7] ? JSON.parse(values[7]) : [],
          parent_task_id: values[8] ? parseInt(values[8]) : null,
          sort_order: parseInt(values[9] || 0),
          created_at: values[10] || '',
          updated_at: values[11] || ''
        };
      });
    } catch (error) {
      console.error('[MCP Database] Error getting recent tasks:', error.message);
      return [];
    }
  }

  async findRelatedActiveTasks(title, description = '') {
    try {
      // Get all in_progress and in_testing tasks
      const query = `
        SELECT id, title, description, status, project, updated_at
        FROM tasks
        WHERE status IN ('in_progress', 'in_testing')
        ORDER BY updated_at DESC
        LIMIT 50
      `;
      
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      
      if (!result || result.trim() === '') {
        return [];
      }
      
      const activeTasks = JSON.parse(result);
      
      // Calculate similarity scores
      const tasksWithScores = activeTasks.map(task => {
        const score = this.calculateSimilarity(
          title + ' ' + description,
          task.title + ' ' + (task.description || '')
        );

        return {
          ...task,
          id: parseInt(task.id),
          similarity_score: score,
          similarity_percentage: Math.round(score * 100)
        };
      });
      
      // Filter tasks with meaningful similarity (>0.3) and sort by score
      return tasksWithScores
        .filter(task => task.similarity_score > 0.3)
        .sort((a, b) => b.similarity_score - a.similarity_score)
        .slice(0, 5); // Return top 5 most similar
      
    } catch (error) {
      console.error('[MCP Database] Error finding related active tasks:', error.message);
      return [];
    }
  }
  
  calculateSimilarity(text1, text2) {
    // Try to use improved algorithm if available
    try {
      const ImprovedSimilarityCalculator = require('./improved-similarity-algorithm');
      const calculator = new ImprovedSimilarityCalculator();
      const result = calculator.calculateImprovedSimilarity(text1, text2);
      return result.finalScore;
    } catch (error) {
      // Fallback to original algorithm if improved version not available
      console.error('[MCP] Using fallback similarity algorithm');
    }

    // Original algorithm as fallback
    // Normalize texts
    const normalize = (text) => {
      return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ') // Remove punctuation
        .split(/\s+/) // Split by whitespace
        .filter(word => word.length > 2); // Filter out very short words
    };

    const words1 = normalize(text1);
    const words2 = normalize(text2);

    if (words1.length === 0 || words2.length === 0) {
      return 0;
    }

    // Find common words
    const commonWords = words1.filter(word => words2.includes(word));

    // Calculate Jaccard similarity
    const union = new Set([...words1, ...words2]);
    const intersection = commonWords.length;

    // Weighted similarity: give more weight to title matches
    const titleWords1 = normalize(text1.split(' ').slice(0, 5).join(' ')); // Approximate title
    const titleWords2 = normalize(text2.split(' ').slice(0, 5).join(' '));
    const titleCommon = titleWords1.filter(word => titleWords2.includes(word));

    // Calculate final score with title weight
    const jaccardScore = intersection / union.size;
    const titleBoost = titleCommon.length > 0 ? 0.2 : 0;

    return Math.min(1, jaccardScore + titleBoost);
  }

  async searchTasks(searchQuery, options = {}) {
    try {
      // Sanitize search query for SQL LIKE
      const sanitizedQuery = searchQuery.replace(/'/g, "''").toLowerCase();
      
      // Build WHERE clause for searching in multiple fields
      const searchConditions = [
        `LOWER(title) LIKE '%${sanitizedQuery}%'`,
        `LOWER(description) LIKE '%${sanitizedQuery}%'`,
        `LOWER(plan) LIKE '%${sanitizedQuery}%'`,
        `LOWER(implementation) LIKE '%${sanitizedQuery}%'`
      ];
      
      let whereClause = `(${searchConditions.join(' OR ')})`;
      
      // Add status filter if provided
      if (options.status) {
        const escapedStatus = options.status.replace(/'/g, "''");
        whereClause += ` AND status = '${escapedStatus}'`;
      }
      
      // Add time filter for recent tasks (last 48 hours by default)
      if (options.recentOnly !== false) {
        whereClause += ` AND datetime(updated_at) > datetime('now', '-2 days')`;
      }
      
      // Limit results to prevent token overflow
      const limit = options.limit || 20;

      const query = `
        SELECT id, title, description, plan, implementation, status, project, labels, images, parent_task_id, sort_order, created_at, updated_at
        FROM tasks
        WHERE ${whereClause}
        ORDER BY
          CASE
            WHEN status = 'in_testing' THEN 1
            WHEN status = 'in_progress' THEN 2
            WHEN status = 'pending' THEN 3
            WHEN status = 'completed' THEN 4
          END,
          updated_at DESC
        LIMIT ${limit}
      `;

      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });

      if (!result || result.trim() === '') {
        return [];
      }

      const tasks = JSON.parse(result);

      return tasks.map(task => ({
        ...task,
        id: parseInt(task.id),
        sort_order: parseInt(task.sort_order) || 0,
        labels: task.labels ? JSON.parse(task.labels) : [],
        images: task.images ? JSON.parse(task.images) : [],
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : null
      }));
    } catch (error) {
      console.error('[MCP Database] Error searching tasks:', error.message);
      return [];
    }
  }

  async getTaskById(taskId) {
    try {
      // Use JSON mode for better handling of multiline fields
      console.error(`[MCP Database] getTaskById called with ID: ${taskId}`);
      console.error(`[MCP Database] Using database path: ${this.dbPath}`);
      const query = `SELECT id, title, description, plan, implementation, status, project, labels, images, parent_task_id, sort_order, created_at, updated_at FROM tasks WHERE id = ${parseInt(taskId)}`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      
      if (!result || result.trim() === '') {
        console.error(`[MCP Database] No task found with ID ${taskId}`);
        return null;
      }
      
      const tasks = JSON.parse(result);
      
      if (tasks.length === 0) {
        console.error(`[MCP Database] Empty result for task ID ${taskId}`);
        return null;
      }
      
      const task = tasks[0];
      console.error(`[MCP Database] Found task ${taskId} with status: ${task.status}`);
      console.error(`[MCP Database] Raw task object:`, JSON.stringify(task));
      
      // Ensure all fields are present
      const formattedTask = {
        id: parseInt(task.id),
        title: task.title || '',
        description: task.description || '',
        plan: task.plan || null,
        implementation: task.implementation || null,
        status: task.status || 'pending',
        project: task.project || null,
        labels: task.labels ? JSON.parse(task.labels) : [],
        images: task.images ? JSON.parse(task.images) : [],
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : null,
        sort_order: parseInt(task.sort_order) || 0,
        created_at: task.created_at || null,
        updated_at: task.updated_at || null
      };
      
      console.error(`[MCP Database] Formatted task:`, JSON.stringify(formattedTask));
      return formattedTask;
    } catch (error) {
      console.error('[MCP Database] Error getting task by ID:', error.message);
      console.error('[MCP Database] Query was:', `SELECT * FROM tasks WHERE id = ${parseInt(taskId)}`);
      return null;
    }
  }

  updateTaskPlan(taskId, plan) {
    try {
      const sql = `UPDATE tasks SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [plan || '', taskId]);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  updateTaskImplementation(taskId, implementation) {
    try {
      const sql = `UPDATE tasks SET implementation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [implementation || '', taskId]);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  getCurrentTask(terminalId) {
    try {
      // Read task mapping from notifications file
      // Since we're in a separate process, we can't access the RAM map in main.js
      const notificationFile = path.join(os.homedir(), '.codeagentswarm', 'task_notifications.json');

      if (!fs.existsSync(notificationFile)) {
        return null; // No mappings yet
      }

      let notifications = [];
      try {
        const content = fs.readFileSync(notificationFile, 'utf8');
        notifications = JSON.parse(content);
      } catch (e) {
        return null; // Invalid JSON or read error
      }

      // Find the most recent task_terminal_mapping for this terminal
      const mappings = notifications
        .filter(n => n.type === 'task_terminal_mapping' && n.terminal_id === parseInt(terminalId))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      if (mappings.length === 0) {
        return null; // No task assigned to this terminal
      }

      const taskId = mappings[0].task_id;
      if (!taskId) {
        return null; // Terminal unassigned (terminal_id: null)
      }

      // Fetch full task details from DB by ID
      const query = `SELECT * FROM tasks WHERE id = ${parseInt(taskId)}`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" "${query}"`, { encoding: 'utf8' });

      if (!result || result.trim() === '') {
        return null; // Task not found
      }

      // Parse the task (SQLite returns pipe-separated values)
      // Format: id|title|description|plan|implementation|status|sort_order|created_at|updated_at|parent_task_id|project|images|labels|...
      const values = result.trim().split('|');

      // Use .mode json for easier parsing
      const jsonQuery = `SELECT * FROM tasks WHERE id = ${parseInt(taskId)}`;
      const jsonResult = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${jsonQuery}"`, { encoding: 'utf8' });

      if (!jsonResult || jsonResult.trim() === '' || jsonResult.trim() === '[]') {
        return null;
      }

      const tasks = JSON.parse(jsonResult);
      if (!tasks || tasks.length === 0) {
        return null;
      }

      const task = tasks[0];

      return {
        id: parseInt(task.id) || 0,
        title: task.title || '',
        description: task.description || '',
        plan: task.plan || '',
        implementation: task.implementation || '',
        status: task.status || 'pending',
        project: task.project || null,
        labels: task.labels ? JSON.parse(task.labels) : [],
        images: task.images ? JSON.parse(task.images) : [],
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : null,
        sort_order: parseInt(task.sort_order) || 0,
        created_at: task.created_at || '',
        updated_at: task.updated_at || ''
      };
    } catch (error) {
      console.error('[MCP Database] Error in getCurrentTask:', error.message);
      return null;
    }
  }

  updateTaskTerminal(taskId, terminalId) {
    try {
      // NOTE: No longer updating DB column (removed)
      // We ONLY write notification to communicate the mapping to main.js
      // Main.js will update its RAM-based terminalTaskMap
      this.writeTaskMappingNotification(taskId, terminalId);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Write a task-terminal mapping notification
  // This communicates the mapping to main.js since we're in a separate process
  writeTaskMappingNotification(taskId, terminalId) {
    try {
      const notificationDir = path.join(os.homedir(), '.codeagentswarm');
      const notificationFile = path.join(notificationDir, 'task_notifications.json');

      // Ensure directory exists
      if (!fs.existsSync(notificationDir)) {
        fs.mkdirSync(notificationDir, { recursive: true });
      }

      // Read existing notifications
      let notifications = [];
      if (fs.existsSync(notificationFile)) {
        try {
          const content = fs.readFileSync(notificationFile, 'utf8');
          notifications = JSON.parse(content);
        } catch (e) {
          // If file is corrupted, start fresh
          notifications = [];
        }
      }

      // Add new notification
      const parsedTerminalId = terminalId === '' || terminalId === null ? null : parseInt(terminalId);
      const sourceTerminalId = parseInt(process.env.CODEAGENTSWARM_CURRENT_QUADRANT);
      const sourceTerminalUuid = process.env.CODEAGENTSWARM_TERMINAL_ID || null;
      notifications.push({
        type: 'task_terminal_mapping',
        task_id: parseInt(taskId),
        terminal_id: parsedTerminalId,
        source_terminal_uuid: sourceTerminalUuid,
        terminal_uuid: parsedTerminalId === sourceTerminalId ? sourceTerminalUuid : null,
        timestamp: new Date().toISOString(),
        processed: false
      });

      // Keep only last 100 notifications
      if (notifications.length > 100) {
        notifications = notifications.slice(-50);
      }

      // Write back to file
      fs.writeFileSync(notificationFile, JSON.stringify(notifications, null, 2));

    } catch (error) {
      // Don't fail the operation if notification fails
      console.error('[MCP Database] Error writing task mapping notification:', error.message);
    }
  }

  updateTaskLabels(taskId, labels) {
    try {
      const labelsJSON = JSON.stringify(labels || []);
      const sql = `UPDATE tasks SET labels = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [labelsJSON, taskId]);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  updateTaskImages(taskId, images) {
    try {
      const imagesJSON = JSON.stringify(images || []);
      const sql = `UPDATE tasks SET images = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [imagesJSON, taskId]);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  updateTask(taskId, title, description) {
    try {
      const sql = `UPDATE tasks SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      this.execSQL(sql, [title, description || '', taskId]);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  deleteTask(taskId) {
    try {
      const sql = `DELETE FROM tasks WHERE id = ?`;
      this.execSQL(sql, [taskId]);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Bulk delete multiple tasks
  bulkDeleteTasks(taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return { success: true, deletedCount: 0 };
    }
    try {
      const placeholders = taskIds.map(() => '?').join(',');
      const sql = `DELETE FROM tasks WHERE id IN (${placeholders})`;
      this.execSQL(sql, taskIds);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Bulk update status for multiple tasks
  bulkUpdateTaskStatus(taskIds, newStatus) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return { success: true, updatedCount: 0 };
    }
    try {
      const placeholders = taskIds.map(() => '?').join(',');
      const sql = `UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`;
      this.execSQL(sql, [newStatus, ...taskIds]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async updateTasksOrder(taskOrders) {
    try {
      // Update each task's sort order
      for (const order of taskOrders) {
        const sql = `UPDATE tasks SET sort_order = ? WHERE id = ?`;
        this.execSQL(sql, [order.sortOrder, order.taskId]);
      }
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Project management methods
  async createProject(name, projectPath = null, color = null) {
    try {
      // First check if project already exists
      const existingProject = await this.getProjectByName(name);
      if (existingProject) {
        return {
          success: false,
          error: `A project with the name "${name}" already exists. Please choose a different name.`
        };
      }

      // If no color provided, pick from predefined palette
      if (!color) {
        const colors = [
          '#007ACC', '#00C853', '#FF6B6B', '#FFA726', '#AB47BC',
          '#26A69A', '#EC407A', '#7E57C2', '#29B6F6', '#66BB6A'
        ];

        // Spread colors as evenly as possible: pick the least-used one.
        // (A plain "first unused || colors[0]" fallback made every project
        // after the 10th default to #007ACC, the first project's color.)
        const existingProjects = await this.getProjects();
        const usageCount = new Map(colors.map(c => [c, 0]));
        existingProjects.forEach(p => {
          if (usageCount.has(p.color)) {
            usageCount.set(p.color, usageCount.get(p.color) + 1);
          }
        });
        color = colors.reduce((least, c) =>
          usageCount.get(c) < usageCount.get(least) ? c : least, colors[0]);
      }

      // Persist the path so this project can later be resolved BY PATH (which is
      // what lets us stop reading the name out of the per-project CLAUDE.md). A
      // path-less row can't be found by getProjectByPath and risks a duplicate.
      const pathCol = projectPath ? `, path` : '';
      const pathVal = projectPath ? `, '${projectPath.replace(/'/g, "''")}'` : '';

      // Combine INSERT and SELECT in a single SQLite session to get the correct ID
      const tempFile = path.join(os.tmpdir(), `mcp_project_${Date.now()}.sql`);
      const sqlCommands = `
        INSERT INTO projects (name, display_name, color${pathCol})
        VALUES ('${name.replace(/'/g, "''")}',
                '${name.replace(/'/g, "''")}',
                '${color.replace(/'/g, "''")}'${pathVal});
        SELECT last_insert_rowid();
      `;
      
      fs.writeFileSync(tempFile, sqlCommands);
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" < "${tempFile}"`, {
        encoding: 'utf8'
      }).trim();
      
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
      
      const lastId = result.split('\n').pop(); // Get the last line which should be the ID
      
      return {
        success: true,
        projectId: parseInt(lastId) || 0,
        name,
        color
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getProjects(limit = null, offset = 0) {
    try {
      // Use JSON mode for better handling - include task count via LEFT JOIN
      let query = `SELECT
        p.id,
        p.name,
        p.display_name,
        p.color,
        p.path,
        p.created_at,
        p.last_opened,
        COUNT(t.id) as task_count
      FROM projects p
      LEFT JOIN tasks t ON t.project = p.name
      WHERE p.path != '__sandbox__'
      AND p.path NOT LIKE '%/.codeagentswarm/sandbox%'
      GROUP BY p.id
      ORDER BY
        CASE
          WHEN p.last_opened IS NOT NULL THEN p.last_opened
          ELSE p.created_at
        END DESC`;

      // Add pagination if limit is specified
      if (limit !== null && limit > 0) {
        query += ` LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
      }

      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });

      if (!result || result.trim() === '') {
        return [];
      }

      const projects = JSON.parse(result);

      return projects.map(project => ({
        ...project,
        id: parseInt(project.id),
        task_count: parseInt(project.task_count || 0)
      }));
    } catch (error) {
      console.error('[MCP Database] Error getting projects:', error.message);
      return [];
    }
  }

  async getProjectByName(name) {
    try {
      // Use JSON mode for better handling
      const escapedName = name.replace(/'/g, "''");
      const query = `SELECT id, name, display_name, color, created_at FROM projects WHERE name = '${escapedName}' COLLATE NOCASE`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      
      if (!result || result.trim() === '') {
        return null;
      }
      
      const projects = JSON.parse(result);
      
      if (projects.length === 0) return null;
      
      const project = projects[0];
      return {
        ...project,
        id: parseInt(project.id)
      };
    } catch (error) {
      console.error('[MCP Database] Error getting project by name:', error.message);
      return null;
    }
  }

  // Resolve a project by its directory path. Mirrors database.js:getProjectByPath
  // (exact `WHERE path = ?` match). The path passed in comes from the same
  // terminal_directories.directory string the app used to store the project, so
  // raw matching is consistent across both processes. This is what lets the MCP
  // read the project NAME from the DB instead of parsing the per-project CLAUDE.md.
  async getProjectByPath(projectPath) {
    try {
      if (!projectPath) return null;
      const escaped = projectPath.replace(/'/g, "''");
      const query = `SELECT id, name, display_name, color, path, created_at FROM projects WHERE path = '${escaped}'`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return null;
      const projects = JSON.parse(result);
      if (projects.length === 0) return null;
      return { ...projects[0], id: parseInt(projects[0].id) };
    } catch (error) {
      console.error('[MCP Database] Error getting project by path:', error.message);
      return null;
    }
  }

  async getTasksByProject(projectName, limit = null, offset = 0) {
    try {
      // Use JSON mode for better handling of multiline fields
      const escapedProjectName = projectName.replace(/'/g, "''");
      let query = `SELECT id, title, description, plan, implementation, status, project, labels, images, parent_task_id, sort_order, created_at, updated_at FROM tasks WHERE project = '${escapedProjectName}' ORDER BY sort_order ASC, created_at DESC`;

      // Add pagination if limit is specified
      if (limit !== null && limit > 0) {
        query += ` LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
      }

      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });

      if (!result || result.trim() === '') {
        return [];
      }

      const tasks = JSON.parse(result);

      return tasks.map(task => ({
        ...task,
        id: parseInt(task.id),
        sort_order: parseInt(task.sort_order) || 0,
        labels: task.labels ? JSON.parse(task.labels) : [],
        images: task.images ? JSON.parse(task.images) : [],
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : null
      }));
    } catch (error) {
      console.error('[MCP Database] Error getting tasks by project:', error.message);
      return [];
    }
  }

  // Get terminal working directory (for project detection)
  get(sql, params = []) {
    try {
      execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode list"`, { encoding: 'utf8' });
      execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".separator |"`, { encoding: 'utf8' });
      
      const result = this.execSQL(sql, params);
      
      if (!result) return null;
      
      // For simple queries like getting terminal directory
      if (sql.includes('terminal_directories')) {
        const values = result.split('|');
        return {
          terminal_id: parseInt(values[0]), // terminal_directories table still has terminal_id (different table)
          directory: values[1],
          last_used: values[2]
        };
      }
      
      return result;
    } catch (error) {
      console.error('[MCP Database] Error in get():', error.message);
      return null;
    }
  }

  // Compatibility shim
  get db() {
    return {
      get: (sql, params, callback) => {
        try {
          const result = this.get(sql, params);
          callback(null, result);
        } catch (error) {
          callback(error);
        }
      }
    };
  }

  logTaskAction(taskId, action, details) {
    // Not implemented in standalone version
  }

  // Subtask management methods
  
  async createSubtask(title, description, parentTaskId, terminalId) {
    try {
      // Get parent task to inherit project
      const parentTask = this.getTaskById(parentTaskId);
      if (!parentTask) {
        throw new Error('Parent task not found');
      }
      
      const project = parentTask.project;
      
      // Create task with parent_task_id
      return await this.createTask(title, description, terminalId, project, parentTaskId);
    } catch (error) {
      console.error('[MCP Database] Error creating subtask:', error);
      throw error;
    }
  }
  
  getSubtasks(parentTaskId, limit = null, offset = 0) {
    try {
      // Build the query with pagination - SELECT specific columns to avoid schema mismatches
      let query = `.mode list\n.separator |\nSELECT id, title, description, plan, implementation, status, project, labels, images, parent_task_id, sort_order, created_at, updated_at FROM tasks WHERE parent_task_id = ? ORDER BY sort_order ASC, created_at DESC`;

      // Add pagination if limit is specified
      if (limit !== null && limit > 0) {
        query += ` LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
      }

      query += ';';

      const result = this.execSQL(query, [parentTaskId]);

      if (!result) return [];

      const columns = ['id', 'title', 'description', 'plan', 'implementation', 'status', 'project', 'labels', 'images', 'parent_task_id', 'sort_order', 'created_at', 'updated_at'];
      return this.parseRows(result, columns);
    } catch (error) {
      console.error('[MCP Database] Error getting subtasks:', error);
      return [];
    }
  }

  linkTaskToParent(taskId, parentTaskId) {
    try {
      // Check if parent task exists
      const parentResult = this.execSQL('.mode list\nSELECT id FROM tasks WHERE id = ?;', [parentTaskId]);
      if (!parentResult) {
        return { success: false, error: 'Parent task not found' };
      }
      
      // Check for circular dependency
      if (this.wouldCreateCircularDependency(taskId, parentTaskId)) {
        return { success: false, error: 'Cannot create circular dependency' };
      }
      
      this.execSQL('UPDATE tasks SET parent_task_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;', [parentTaskId, taskId]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  unlinkTaskFromParent(taskId) {
    try {
      this.execSQL('UPDATE tasks SET parent_task_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?;', [taskId]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  wouldCreateCircularDependency(taskId, potentialParentId) {
    try {
      // If task and parent are the same, it's circular
      if (taskId === potentialParentId) {
        return true;
      }
      
      // Check if potentialParentId is already a descendant of taskId
      const checkDescendants = (currentId) => {
        const result = this.execSQL('.mode list\nSELECT id FROM tasks WHERE parent_task_id = ?;', [currentId]);
        if (!result) return false;
        
        const childIds = result.split('\n').filter(id => id).map(id => parseInt(id));
        
        for (const childId of childIds) {
          if (childId === potentialParentId) {
            return true;
          }
          if (checkDescendants(childId)) {
            return true;
          }
        }
        return false;
      };
      
      return checkDescendants(taskId);
    } catch (error) {
      // On error, play it safe and prevent the operation
      return true;
    }
  }

  getTaskWithParent(taskId) {
    try {
      // SELECT specific columns explicitly to avoid schema mismatch with t.*
      const result = this.execSQL(`.mode list
.separator |
SELECT
  t.id, t.title, t.description, t.plan, t.implementation, t.status, t.project, t.labels, t.images, t.parent_task_id, t.sort_order, t.created_at, t.updated_at,
  p.id as parent_id,
  p.title as parent_title,
  p.status as parent_status
FROM tasks t
LEFT JOIN tasks p ON t.parent_task_id = p.id
WHERE t.id = ?;`, [taskId]);

      if (!result) return null;

      const columns = ['id', 'title', 'description', 'plan', 'implementation', 'status', 'project', 'labels', 'images', 'parent_task_id', 'sort_order', 'created_at', 'updated_at', 'parent_id', 'parent_title', 'parent_status'];
      const rows = this.parseRows(result, columns);
      return rows[0] || null;
    } catch (error) {
      console.error('[MCP Database] Error getting task with parent:', error);
      return null;
    }
  }

  async getTaskHierarchy(taskId) {
    try {
      const task = await this.getTaskById(taskId);
      
      if (!task) {
        return null;
      }
      
      const getSubtasksRecursive = (parentId) => {
        const subtasks = this.getSubtasks(parentId);
        return subtasks.map(subtask => ({
          ...subtask,
          subtasks: getSubtasksRecursive(subtask.id)
        }));
      };
      
      return {
        ...task,
        subtasks: getSubtasksRecursive(taskId)
      };
    } catch (error) {
      console.error('[MCP Database] Error getting task hierarchy:', error);
      return null;
    }
  }

  // Synchronous version removed - use async getTaskById instead
  // This was causing conflicts with the async version

  /**
   * Get an app setting by key
   * @param {string} key - Setting key
   * @returns {object|null} - Parsed setting value or null
   */
  getSetting(key) {
    try {
      const sql = `SELECT value FROM app_settings WHERE key = '${key.replace(/'/g, "''")}'`;
      const result = this.execSQL(`.mode json\n${sql}`);

      if (!result || result.trim() === '' || result.trim() === '[]') {
        return null;
      }

      const rows = JSON.parse(result);
      if (rows && rows.length > 0 && rows[0].value) {
        // KEEP IN SYNC with database.js getSetting(): setSetting() stores a plain
        // string VERBATIM, so a value like `claude` is NOT valid JSON. Parsing it
        // threw and the read collapsed to null, which callers read as "never set".
        // Fall back to the raw text so bare strings (including the ones already on
        // disk) are readable, while JSON values keep their real type.
        try {
          return JSON.parse(rows[0].value);
        } catch (_parseErr) {
          return rows[0].value;
        }
      }
      return null;
    } catch (error) {
      console.error('[MCP Database] Error getting setting:', key, error.message);
      return null;
    }
  }

  /**
   * Save an app setting
   * @param {string} key - Setting key
   * @param {object} value - Setting value (will be JSON stringified)
   * @returns {object} - { success: boolean, error?: string }
   */
  saveSetting(key, value) {
    try {
      const valueStr = JSON.stringify(value).replace(/'/g, "''");
      const keyEscaped = key.replace(/'/g, "''");
      const sql = `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('${keyEscaped}', '${valueStr}', CURRENT_TIMESTAMP)`;
      this.execSQL(sql);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error saving setting:', key, error.message);
      return { success: false, error: error.message };
    }
  }

  // ─── Conversation Bookmarks ──────────────────────────────────

  addBookmark(sessionId, projectPath, projectDir, projectName, agentType, displayText) {
    try {
      const sql = `INSERT OR IGNORE INTO conversation_bookmarks
        (session_id, project_path, project_dir, project_name, agent_type, display_text)
        VALUES (?, ?, ?, ?, ?, ?)`;
      this.execSQL(sql, [sessionId, projectPath, projectDir || null, projectName || null, agentType || 'claude', displayText || null]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error adding bookmark:', error.message);
      return { success: false, error: error.message };
    }
  }

  removeBookmark(sessionId) {
    try {
      const sql = `DELETE FROM conversation_bookmarks WHERE session_id = ?`;
      this.execSQL(sql, [sessionId]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error removing bookmark:', error.message);
      return { success: false, error: error.message };
    }
  }

  isBookmarked(sessionId) {
    try {
      const sql = `SELECT id FROM conversation_bookmarks WHERE session_id = ?`;
      const result = this.execSQL(sql, [sessionId]);
      return !!result && result.trim().length > 0;
    } catch (error) {
      console.error('[MCP Database] Error checking bookmark:', error.message);
      return false;
    }
  }

  getAllBookmarks() {
    try {
      const query = `SELECT id, session_id, project_path, project_dir, project_name, agent_type, display_text, custom_name, created_at, updated_at FROM conversation_bookmarks ORDER BY created_at DESC`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return [];
      return JSON.parse(result);
    } catch (error) {
      console.error('[MCP Database] Error getting bookmarks:', error.message);
      return [];
    }
  }

  updateBookmarkName(sessionId, projectPath, customName) {
    try {
      const sql = `UPDATE conversation_bookmarks SET custom_name = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?`;
      this.execSQL(sql, [customName || null, sessionId]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error updating bookmark name:', error.message);
      return { success: false, error: error.message };
    }
  }

  searchBookmarks(query) {
    try {
      const pattern = `%${query}%`;
      const escapedPattern = pattern.replace(/'/g, "''");
      const sqlQuery = `SELECT id, session_id, project_path, project_dir, project_name, agent_type, display_text, custom_name, created_at, updated_at FROM conversation_bookmarks WHERE custom_name LIKE '${escapedPattern}' OR display_text LIKE '${escapedPattern}' OR project_name LIKE '${escapedPattern}' ORDER BY created_at DESC`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${sqlQuery}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return [];
      return JSON.parse(result);
    } catch (error) {
      console.error('[MCP Database] Error searching bookmarks:', error.message);
      return [];
    }
  }

  getBookmarkedSessionIds() {
    try {
      this.execSQL('.mode list');
      const result = this.execSQL('SELECT session_id FROM conversation_bookmarks');
      if (!result || result.trim() === '') return [];
      return result.split('\n').filter(line => line.trim()).map(line => line.trim());
    } catch (error) {
      console.error('[MCP Database] Error getting bookmarked session IDs:', error.message);
      return [];
    }
  }

  // ===== Git worktrees (per-conversation) =====
  // Maps a conversation (session_id) to the git worktree created for it, so a
  // resumed conversation can reuse the same worktree.

  saveWorktree(sessionId, { repoRoot, worktreePath, branch, baseBranch, groupId } = {}) {
    try {
      // Upsert: on an existing session_id keep the original created_at and only
      // refresh last_used (a plain INSERT OR REPLACE would reset created_at
      // since it deletes + re-inserts the row).
      // base_branch / group_id use COALESCE so a later upsert WITHOUT them (e.g.
      // the reuse path) preserves the originally-stored values. group_id is null
      // for a normal single worktree (unchanged behavior) and shared across the
      // rows of a composite/group worktree.
      const sql = `INSERT INTO worktrees (session_id, repo_root, worktree_path, branch, base_branch, group_id, last_used)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET
          repo_root = excluded.repo_root,
          worktree_path = excluded.worktree_path,
          branch = excluded.branch,
          base_branch = COALESCE(excluded.base_branch, worktrees.base_branch),
          group_id = COALESCE(excluded.group_id, worktrees.group_id),
          last_used = CURRENT_TIMESTAMP`;
      this.execSQL(sql, [sessionId, repoRoot, worktreePath, branch, baseBranch || null, groupId || null]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error saving worktree:', error.message);
      return { success: false, error: error.message };
    }
  }

  getWorktreeBySession(sessionId) {
    try {
      const escaped = String(sessionId).replace(/'/g, "''");
      const query = `SELECT session_id, repo_root, worktree_path, branch, base_branch, group_id, created_at, last_used FROM worktrees WHERE session_id = '${escaped}'`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return null;
      const rows = JSON.parse(result);
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      console.error('[MCP Database] Error getting worktree by session:', error.message);
      return null;
    }
  }

  listWorktrees() {
    try {
      const query = `SELECT session_id, repo_root, worktree_path, branch, base_branch, group_id, created_at, last_used FROM worktrees ORDER BY last_used DESC`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return [];
      return JSON.parse(result);
    } catch (error) {
      console.error('[MCP Database] Error listing worktrees:', error.message);
      return [];
    }
  }

  deleteWorktree(sessionId) {
    try {
      const sql = `DELETE FROM worktrees WHERE session_id = ?`;
      this.execSQL(sql, [sessionId]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error deleting worktree:', error.message);
      return { success: false, error: error.message };
    }
  }

  touchWorktree(sessionId) {
    try {
      const sql = `UPDATE worktrees SET last_used = CURRENT_TIMESTAMP WHERE session_id = ?`;
      this.execSQL(sql, [sessionId]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error touching worktree:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ===== Composite / group worktrees =====
  // A group = several worktree rows sharing the same group_id: one ROOT
  // (container) row keyed by the conversation's session_id + N synthetic
  // sub-repo child rows. group_id is NULL for a normal single worktree.
  // Mirrors database.js so both implementations stay in parity.

  // Returns every row of a group, ROOT first. Convention: the root is the row
  // whose worktree_path is the ancestor of every member (the group dir), i.e.
  // the shortest path; ordered by path length then created_at so callers can
  // rely on rows[0] being the container/root.
  getWorktreeGroup(groupId) {
    try {
      const escaped = String(groupId).replace(/'/g, "''");
      const query = `SELECT session_id, repo_root, worktree_path, branch, base_branch, group_id, created_at, last_used FROM worktrees WHERE group_id = '${escaped}' ORDER BY LENGTH(worktree_path) ASC, created_at ASC`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return [];
      return JSON.parse(result);
    } catch (error) {
      console.error('[MCP Database] Error getting worktree group:', error.message);
      return [];
    }
  }

  // Returns every row that belongs to a group (group_id IS NOT NULL); the caller
  // groups them by group_id. Single worktrees (NULL group_id) are excluded.
  listWorktreeGroups() {
    try {
      const query = `SELECT session_id, repo_root, worktree_path, branch, base_branch, group_id, created_at, last_used FROM worktrees WHERE group_id IS NOT NULL ORDER BY group_id ASC, LENGTH(worktree_path) ASC, created_at ASC`;
      const result = execSync(`${this.sqlite3Cmd} "${this.dbPath}" ".mode json" "${query}"`, { encoding: 'utf8' });
      if (!result || result.trim() === '') return [];
      return JSON.parse(result);
    } catch (error) {
      console.error('[MCP Database] Error listing worktree groups:', error.message);
      return [];
    }
  }

  // Deletes every row of a group (container + all sub-repo members).
  deleteWorktreeGroup(groupId) {
    try {
      const sql = `DELETE FROM worktrees WHERE group_id = ?`;
      this.execSQL(sql, [groupId]);
      return { success: true };
    } catch (error) {
      console.error('[MCP Database] Error deleting worktree group:', error.message);
      return { success: false, error: error.message };
    }
  }

  close() {
    // Nothing to close when using CLI
  }
}

module.exports = DatabaseManagerMCP;
