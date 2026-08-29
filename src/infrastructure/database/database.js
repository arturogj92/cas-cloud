const Database = require('better-sqlite3');
const path = require('path');
const { randomUUID } = require('crypto');

// Default catalog of terminal statuses (the PHASE the current work is in).
// Seeded into the terminal_statuses table only when it is empty, so future user
// edits are never clobbered. Labels and prompts are English (the prompt is
// injected into the set_terminal_status MCP tool description; users translate or
// reword it from Settings > Terminal Statuses).
// KEEP IN SYNC with database-mcp-standalone.js.
// sort_order doubles as the TAB priority when "sort tabs by status" is on (tabbed
// mode): the same order drives the manual dropdown, the Settings list AND how the
// tabs group — attention-first (needs_input) at the top, in-progress (working) and
// finished (done) at the bottom. KEEP IN SYNC with database-mcp-standalone.js and the
// renderer's TERMINAL_STATUS_FALLBACK_CATALOG.
// `agent_settable: 0` marks a status the APP owns: it is hidden from the
// set_terminal_status tool description and rejected as an agent input, while the
// manual dropdown and Settings still offer it. 'idle' is the only one today — the
// app knows for a fact when a terminal has just been opened, so asking the model
// to report it would only invite it to lie (see the "no depender del modelo para
// lo obvio" rule the auto-flips already follow).
const DEFAULT_TERMINAL_STATUSES = [
    { status_key: 'needs_input', label: 'Needs input', color: '#f97316', icon: 'message-circle-question', sort_order: 1, is_default: 1, agent_settable: 1, prompt: 'Set it when you stop because you need an answer or a decision from the user to continue (a question, a design choice, a permission).' },
    { status_key: 'needs_testing', label: 'Needs testing', color: '#3b82f6', icon: 'flask-conical', sort_order: 2, is_default: 1, agent_settable: 1, prompt: 'Set it when you finish the implementation and the work is pending the user testing it manually. Do not set it if there are still things left to implement.' },
    { status_key: 'working', label: 'Working', color: '#fbbf24', icon: 'hammer', sort_order: 3, is_default: 1, agent_settable: 1, prompt: 'Set it when you start working on any request and while you are implementing, investigating or fixing something.' },
    { status_key: 'done', label: 'Done', color: '#22c55e', icon: 'circle-check', sort_order: 4, is_default: 1, agent_settable: 1, prompt: 'Set it when the work is completely finished: implemented, validated and with its commit/push done when applicable. It is the final state.' },
    { status_key: 'idle', label: 'Idle', color: '#6b7280', icon: 'circle-dashed', sort_order: 5, is_default: 1, agent_settable: 0, prompt: 'Set by the app on an agent that has just been opened and has not been given any work yet. Agents cannot set this status; it clears itself as soon as you send the agent something.' }
];

// The status the app seeds on a freshly opened terminal that the user has not
// written to yet (see the renderer's _autoWorkingStatusOnOutput). Named here so
// the migration below and the seed stay in step.
const IDLE_TERMINAL_STATUS_KEY = 'idle';
// One-shot marker for the migration that adds 'idle' to catalogs created before
// it existed. Once set, the status is never re-inserted, so a user who deletes it
// keeps it deleted.
const IDLE_STATUS_SEEDED_SETTING = 'terminal_status_idle_seeded';

// The first shipped catalog ordered the defaults working-first (working=1 … done=6).
// The tab-sort feature (#12083) reordered them attention-first. A user who never
// reordered still carries this exact arrangement, so it is safe to migrate them to
// the new order; anyone who reordered (or added/removed defaults) keeps their choice.
// KEEP IN SYNC with database-mcp-standalone.js.
const LEGACY_DEFAULT_SORT_ORDER = {
    working: 1,
    needs_input: 2,
    needs_testing: 3,
    pending_commit: 4,
    blocked: 5,
    done: 6
};

// The first shipped catalog seeded the default prompts in SPANISH. Since the
// prompts are now user-editable (Settings > Terminal Statuses), the factory copy
// is English. These are the exact legacy strings: a default status still carrying
// one VERBATIM was never touched by the user, so it is safe to upgrade it to the
// English wording. Anything the user edited (or any custom status) is left alone.
// KEEP IN SYNC with database-mcp-standalone.js.
const LEGACY_SPANISH_DEFAULT_PROMPTS = {
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
// KEEP IN SYNC with database-mcp-standalone.js.
const RETIRED_DEFAULT_TERMINAL_STATUSES = [
    {
        status_key: 'blocked',
        label: 'Blocked',
        color: '#ef4444',
        prompt_en: 'Set it when you cannot make progress due to something external that does not depend on you or the user: broken CI, a dependency that is down, failing permissions, a third-party bug.',
        prompt_es: LEGACY_SPANISH_DEFAULT_PROMPTS.blocked
    },
    {
        status_key: 'pending_commit',
        label: 'Pending commit/push',
        color: '#a78bfa',
        prompt_en: 'Set it when the user has already validated the work and only the commit or push remains.',
        prompt_es: LEGACY_SPANISH_DEFAULT_PROMPTS.pending_commit
    }
];

// Try to import electron app, but handle gracefully if not available
let app;
try {
    app = require('electron').app;
} catch (e) {
    // Running outside Electron (e.g., as MCP server))
    app = null;
}

class DatabaseManager {
    constructor(terminalTaskMap = null, options = {}) {
        // Store database in user data directory
        let dbPath;

        // Check if running as MCP server (outside Electron)
        const env = options.env || process.env;
        if (env.CODEAGENTSWARM_DB_PATH) {
            dbPath = env.CODEAGENTSWARM_DB_PATH;
        } else if (options.databasePath) {
            dbPath = options.databasePath;
        } else if (app && app.getPath) {
            dbPath = path.join(app.getPath('userData'), 'codeagentswarm.db');
        } else {
            // Fallback for MCP server mode
            const os = require('os');
            const dataDir = path.join(os.homedir(), '.codeagentswarm');
            if (!require('fs').existsSync(dataDir)) {
                require('fs').mkdirSync(dataDir, { recursive: true });
            }
            dbPath = path.join(dataDir, 'codeagentswarm.db');
        }

        require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
        const existingInstall = require('fs').existsSync(dbPath);
        this.dbPath = dbPath;
        this.db = new Database(dbPath);

        // Enable foreign key constraints
        this.db.pragma('foreign_keys = ON');

        // Enable WAL mode for better concurrent access
        // WAL (Write-Ahead Logging) allows multiple readers and one writer
        // This prevents "database is locked" errors when multiple MCP instances run
        this.db.pragma('journal_mode = WAL');

        // Set busy timeout to 5 seconds for cases where write conflicts still occur
        // This makes SQLite wait instead of immediately returning "database is locked"
        this.db.pragma('busy_timeout = 5000');

        // Store terminal-task mapping (RAM-only, not persisted)
        // If not provided, create an empty Map (for MCP server mode)
        this.terminalTaskMap = terminalTaskMap || new Map();

        // NOTE: terminal_id column has been REMOVED from tasks table
        // Task-terminal mappings are now ONLY stored in RAM (terminalTaskMap)

        this.initialize();

        if (!existingInstall) {
            this.saveSetting('app_theme', 'neon');
            this.saveSetting('initial_workspace_view', 'sidebar');
        }
        if (app && app.getPath && !process.env.CODEAGENTSWARM_DB_PATH) {
            this.ensureAnalyticsInstallIdentity(existingInstall);
        }
    }

    initialize() {

        // Create tables if they don't exist
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS terminal_directories (
                terminal_id INTEGER PRIMARY KEY,
                directory TEXT,
                last_used DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create a table for app settings/preferences
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create tasks table for MCP task management
        // NOTE: terminal_id column REMOVED - mappings now stored in RAM only
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                plan TEXT,
                status TEXT CHECK(status IN ('pending', 'in_progress', 'in_testing', 'completed')) DEFAULT 'pending',
                sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                project TEXT,
                parent_task_id INTEGER,
                FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
            )
        `);
        
        // Create projects table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                display_name TEXT,
                color TEXT NOT NULL,
                icon TEXT DEFAULT NULL,
                path TEXT UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Headless runtime catalog. IDs and registration state are host-owned;
        // the legacy projects table remains the task-board source of truth.
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
            INSERT OR IGNORE INTO runtime_project_state (singleton, revision) VALUES (1, 0)
        `);

        // Create navbar shortcuts table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS navbar_shortcuts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                project_path TEXT NOT NULL,
                project_name TEXT NOT NULL,
                project_color TEXT,
                resume_mode BOOLEAN DEFAULT 0,
                danger_mode BOOLEAN DEFAULT 0,
                use_worktree BOOLEAN DEFAULT NULL,
                view_mode TEXT DEFAULT 'terminal',
                sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create demos_completed table for tracking onboarding tours
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS demos_completed (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_name TEXT NOT NULL UNIQUE,
                completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create conversation_bookmarks table
        this.db.exec(`
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
            )
        `);

        // Create worktrees table (maps a conversation/session to its git worktree
        // so a resumed conversation can reuse the same worktree)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS worktrees (
                session_id TEXT PRIMARY KEY,
                repo_root TEXT NOT NULL,
                worktree_path TEXT NOT NULL,
                branch TEXT NOT NULL,
                base_branch TEXT,
                group_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_used DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create terminal_statuses table: the CATALOG of available statuses (the
        // phase the current work is in), NOT per-terminal state. Seeded with the
        // defaults on first run; user edits survive because seeding only runs when
        // the table is empty.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS terminal_statuses (
                status_key TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                color TEXT NOT NULL,
                icon TEXT NOT NULL,
                prompt TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default INTEGER NOT NULL DEFAULT 0,
                agent_settable INTEGER NOT NULL DEFAULT 1
            )
        `);

        // project_folders table is deprecated - using projects.path instead
        // Drop the table if it exists
        this.dropProjectFoldersTable();
        
        // Add sort_order column if it doesn't exist (migration)
        this.addSortOrderColumnIfNeeded();
        
        // Add plan column if it doesn't exist (migration)
        this.addPlanColumnIfNeeded();
        
        // Add implementation column if it doesn't exist (migration)
        this.addImplementationColumnIfNeeded();
        
        // Update status constraint to include in_testing (migration)
        this.updateStatusConstraintIfNeeded();
        
        // Add project column if it doesn't exist (migration)
        this.addProjectColumnIfNeeded();
        
        // Initialize default project if needed
        // Default project initialization removed - projects are created on demand
        
        // Add display_name column if it doesn't exist (migration)
        this.addDisplayNameColumnIfNeeded();
        
        // Add path column if it doesn't exist (migration)
        this.addPathColumnIfNeeded();
        
        // Enforce path constraints (migration)
        this.enforcePathConstraints();
        
        // Add last_opened column if it doesn't exist (migration)
        this.addLastOpenedColumnIfNeeded();

        // Add updated_at column to projects if it doesn't exist (migration)
        this.addProjectUpdatedAtColumnIfNeeded();
        
        // Add parent_task_id column if it doesn't exist (migration)
        this.addParentTaskIdColumnIfNeeded();
        
        // Add labels column if it doesn't exist (migration)
        this.addLabelsColumnIfNeeded();
        
        // Add images column if it doesn't exist (migration)
        this.addImagesColumnIfNeeded();

        // Add sandbox columns if they don't exist (migration)
        this.addSandboxColumnsIfNeeded();

        // Add agent_type column to shortcuts if it doesn't exist (migration)
        this.addAgentTypeColumnIfNeeded();

        // Add conversation-resume columns to shortcuts if they don't exist (migration)
        this.addConversationColumnsToShortcutsIfNeeded();

        // Add use_worktree column to shortcuts if it doesn't exist (migration)
        this.addWorktreeColumnToShortcutsIfNeeded();

        // Add Terminal/Chat launch preference to shortcuts (migration)
        this.addViewModeColumnToShortcutsIfNeeded();

        // Add base_branch column to worktrees if it doesn't exist (migration)
        this.addBaseBranchColumnToWorktreesIfNeeded();

        // Add group_id column to worktrees if it doesn't exist (migration)
        this.addGroupIdColumnToWorktreesIfNeeded();

        // Add the cleanup columns (size_bytes, size_measured_at, keep_flag) to
        // worktrees if they don't exist (migration)
        this.addCleanupColumnsToWorktreesIfNeeded();

        // Remove terminal_id column if it exists (migration)
        this.removeTerminalIdColumnIfNeeded();

        // Add icon column to projects if it doesn't exist (migration)
        this.addIconColumnIfNeeded();

        // Initialize Sandbox project if needed
        this.initializeSandboxProject();

        // Seed the terminal status catalog with defaults on first run
        this.addAgentSettableColumnToTerminalStatusesIfNeeded();
        this.seedTerminalStatusesIfEmpty();
        this.addEnabledColumnToTerminalStatusesIfNeeded();
        this.migrateLegacyTerminalStatusPrompts();
        this.migrateDefaultTerminalStatusSortOrderIfPristine();
        this.migrateRetiredDefaultTerminalStatuses();
        this.migrateIdleTerminalStatus();

    }

    addSortOrderColumnIfNeeded() {
        try {
            // Check if sort_order column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasSortOrder = columns.some(col => col.name === 'sort_order');
            
            if (!hasSortOrder) {
                this.db.exec("ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0");

                // Initialize sort_order values for existing tasks
                this.initializeSortOrder();
            }
        } catch (error) {
            console.error('Error checking/adding sort_order column:', error);
        }
    }

    initializeSortOrder() {
        try {
            const tasks = this.db.prepare("SELECT id FROM tasks ORDER BY created_at ASC").all();
            tasks.forEach((task, index) => {
                this.db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?").run(index, task.id);
            });
        } catch (error) {
            console.error('Error initializing sort order:', error);
        }
    }

    addPlanColumnIfNeeded() {
        try {
            // Check if plan column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasPlan = columns.some(col => col.name === 'plan');
            
            if (!hasPlan) {
                this.db.exec("ALTER TABLE tasks ADD COLUMN plan TEXT");

            }
        } catch (error) {
            console.error('Error checking/adding plan column:', error);
        }
    }

    addImplementationColumnIfNeeded() {
        try {
            // Check if implementation column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasImplementation = columns.some(col => col.name === 'implementation');
            
            if (!hasImplementation) {
                this.db.exec("ALTER TABLE tasks ADD COLUMN implementation TEXT");

            }
        } catch (error) {
            console.error('Error checking/adding implementation column:', error);
        }
    }

    updateStatusConstraintIfNeeded() {
        try {
            // Check the schema directly instead of doing INSERT/DELETE test
            // This prevents consuming AUTOINCREMENT IDs on every startup
            const schemaInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();

            if (schemaInfo && schemaInfo.sql) {
                const tableSql = schemaInfo.sql;

                // Check if the constraint includes 'in_testing'
                if (tableSql.includes("'in_testing'")) {
                    // Constraint already updated, nothing to do
                    return;
                }

                // If not, we need to recreate the table with the new constraint
                console.log('📝 Updating status constraint to include in_testing...');
                this.simpleTableRecreation();
            }
        } catch (error) {
            console.error('❌ Error checking/updating status constraint:', error);
        }
    }

    recreateTasksTableWithNewConstraint() {
        try {

            this.db.exec('BEGIN TRANSACTION');

            this.db.exec('PRAGMA foreign_keys = OFF');

            this.db.exec(`
                CREATE TABLE tasks_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT,
                    plan TEXT,
                    status TEXT CHECK(status IN ('pending', 'in_progress', 'in_testing', 'completed')) DEFAULT 'pending',
                    sort_order INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    implementation TEXT
                )
            `);

            this.db.exec(`
                INSERT INTO tasks_new (id, title, description, plan, status, sort_order, created_at, updated_at, implementation)
                SELECT id, title, description, plan, status, sort_order, created_at, updated_at, implementation
                FROM tasks
            `);

            this.db.exec('DROP TABLE tasks');
            this.db.exec('ALTER TABLE tasks_new RENAME TO tasks');

            this.db.exec('PRAGMA foreign_keys = ON');

            this.db.exec('COMMIT');

        } catch (error) {

            this.db.exec('ROLLBACK');
            this.db.exec('PRAGMA foreign_keys = ON'); // Re-enable foreign keys even on error
            console.error('❌ Failed to update status constraint:', error);
            throw error;
        }
    }

    simpleTableRecreation() {
        try {
            // First, disable foreign keys
            this.db.exec('PRAGMA foreign_keys = OFF');

            // Get all existing data
            const existingTasks = this.db.prepare("SELECT * FROM tasks").all();

            // Drop the old table
            this.db.exec('DROP TABLE IF EXISTS tasks');

            // Create new table with correct constraint
            this.db.exec(`
                CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT,
                    plan TEXT,
                    status TEXT CHECK(status IN ('pending', 'in_progress', 'in_testing', 'completed')) DEFAULT 'pending',
                    sort_order INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    implementation TEXT,
                    project TEXT,
                    parent_task_id INTEGER,
                    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
                )
            `);

            // Restore data
            if (existingTasks.length > 0) {
                const insertStmt = this.db.prepare(`
                    INSERT INTO tasks (id, title, description, plan, status, sort_order, created_at, updated_at, implementation, project, parent_task_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const task of existingTasks) {
                    insertStmt.run(
                        task.id,
                        task.title,
                        task.description,
                        task.plan,
                        task.status,
                        task.sort_order,
                        task.created_at,
                        task.updated_at,
                        task.implementation,
                        task.project || null,
                        task.parent_task_id || null
                    );
                }
            }

            // Re-enable foreign keys
            this.db.exec('PRAGMA foreign_keys = ON');

        } catch (error) {

            this.db.exec('PRAGMA foreign_keys = ON');
            console.error('❌ Simple table recreation failed:', error);
            throw error;
        }
    }

    addProjectColumnIfNeeded() {
        try {
            // Check if project column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasProject = columns.some(col => col.name === 'project');
            
            if (!hasProject) {
                this.db.exec("ALTER TABLE tasks ADD COLUMN project TEXT");

                // Update existing tasks with default project
                // Tasks without projects remain NULL - will be assigned based on directory

            }
        } catch (error) {
            console.error('Error checking/adding project column:', error);
        }
    }

    // Removed initializeDefaultProject - projects are created on demand based on directory
    
    addDisplayNameColumnIfNeeded() {
        try {
            // Check if display_name column exists
            const columns = this.db.prepare("PRAGMA table_info(projects)").all();
            const hasDisplayName = columns.some(col => col.name === 'display_name');
            
            if (!hasDisplayName) {
                this.db.exec("ALTER TABLE projects ADD COLUMN display_name TEXT");

                // Update existing projects with display_name = name
                this.db.prepare("UPDATE projects SET display_name = name WHERE display_name IS NULL").run();

            }
        } catch (error) {
            console.error('Error checking/adding display_name column:', error);
        }
    }
    
    addPathColumnIfNeeded() {
        try {
            // Check if path column exists
            const columns = this.db.prepare("PRAGMA table_info(projects)").all();
            const hasPath = columns.some(col => col.name === 'path');
            
            if (!hasPath) {
                // First, check if it's truly missing or if the table needs to be recreated
                // Since path is NOT NULL, we need to provide a default value
                this.db.exec("ALTER TABLE projects ADD COLUMN path TEXT");

                // Update existing projects with path = name converted to slug
                const projects = this.db.prepare("SELECT id, name FROM projects WHERE path IS NULL").all();
                const updateStmt = this.db.prepare("UPDATE projects SET path = ? WHERE id = ?");
                
                projects.forEach(project => {
                    const path = project.name.toLowerCase().replace(/\s+/g, '-');
                    updateStmt.run(path, project.id);
                });

            }
        } catch (error) {
            console.error('Error checking/adding path column:', error);
        }
    }
    
    enforcePathConstraints() {
        try {

            // Check current schema
            const columns = this.db.prepare("PRAGMA table_info(projects)").all();
            const pathColumn = columns.find(col => col.name === 'path');
            
            if (!pathColumn || pathColumn.notnull === 0) {

                // Need to recreate table to change NOT NULL constraint
                this.db.exec('BEGIN TRANSACTION');
                
                try {
                    // Create new table with path NOT NULL and UNIQUE
                    this.db.exec(`
                        CREATE TABLE projects_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT UNIQUE NOT NULL,
                            path TEXT UNIQUE NOT NULL,
                            display_name TEXT,
                            color TEXT NOT NULL DEFAULT '#007ACC',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `);
                    
                    // Copy data (only projects with path)
                    this.db.exec(`
                        INSERT INTO projects_new (id, name, path, display_name, color, created_at, updated_at)
                        SELECT id, name, path, display_name, color, created_at, updated_at
                        FROM projects
                        WHERE path IS NOT NULL
                    `);
                    
                    // Drop old table and rename new one
                    this.db.exec('DROP TABLE projects');
                    this.db.exec('ALTER TABLE projects_new RENAME TO projects');
                    
                    this.db.exec('COMMIT');

                } catch (error) {
                    this.db.exec('ROLLBACK');
                    throw error;
                }
            } else {

            }
        } catch (error) {
            console.error('Error updating path column constraint:', error);
        }
    }

    addLastOpenedColumnIfNeeded() {
        try {
            // Check if last_opened column exists
            const columns = this.db.prepare("PRAGMA table_info(projects)").all();
            const hasLastOpened = columns.some(col => col.name === 'last_opened');
            
            if (!hasLastOpened) {
                this.db.exec("ALTER TABLE projects ADD COLUMN last_opened DATETIME");

                // Initialize last_opened with created_at for existing projects
                this.db.prepare("UPDATE projects SET last_opened = created_at WHERE last_opened IS NULL").run();

            }
        } catch (error) {
            console.error('Error checking/adding last_opened column:', error);
        }
    }

    addProjectUpdatedAtColumnIfNeeded() {
        try {
            // Check if updated_at column exists in projects table
            const columns = this.db.prepare("PRAGMA table_info(projects)").all();
            const hasUpdatedAt = columns.some(col => col.name === 'updated_at');

            if (!hasUpdatedAt) {
                console.log('Adding updated_at column to projects table...');
                // SQLite doesn't allow DEFAULT CURRENT_TIMESTAMP in ALTER TABLE
                // So we add column without default, then UPDATE to set values
                this.db.exec("ALTER TABLE projects ADD COLUMN updated_at DATETIME");

                // Initialize updated_at with created_at for existing projects
                this.db.prepare("UPDATE projects SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP)").run();
                console.log('updated_at column added to projects successfully');
            }
        } catch (error) {
            console.error('Error checking/adding updated_at column to projects:', error);
        }
    }

    addParentTaskIdColumnIfNeeded() {
        try {
            // Check if parent_task_id column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasParentTaskId = columns.some(col => col.name === 'parent_task_id');

            if (!hasParentTaskId) {
                this.db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL");

            }
        } catch (error) {
            console.error('Error checking/adding parent_task_id column:', error);
        }
    }
    
    addLabelsColumnIfNeeded() {
        try {
            // Check if labels column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasLabels = columns.some(col => col.name === 'labels');
            
            if (!hasLabels) {
                console.log('Adding labels column to tasks table...');
                this.db.exec("ALTER TABLE tasks ADD COLUMN labels TEXT DEFAULT '[]'");
                console.log('Labels column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding labels column:', error);
        }
    }
    
    addImagesColumnIfNeeded() {
        try {
            // Check if images column exists
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasImages = columns.some(col => col.name === 'images');
            
            if (!hasImages) {
                console.log('Adding images column to tasks table...');
                // Store file paths instead of base64 data
                this.db.exec("ALTER TABLE tasks ADD COLUMN images TEXT DEFAULT '[]'");
                console.log('Images column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding images column:', error);
        }
    }

    addSandboxColumnsIfNeeded() {
        try {
            // Check and add is_sandbox column to terminal_directories
            const terminalDirColumns = this.db.prepare("PRAGMA table_info(terminal_directories)").all();
            const hasIsSandbox = terminalDirColumns.some(col => col.name === 'is_sandbox');

            if (!hasIsSandbox) {
                console.log('Adding is_sandbox column to terminal_directories table...');
                this.db.exec("ALTER TABLE terminal_directories ADD COLUMN is_sandbox BOOLEAN DEFAULT 0");
                console.log('is_sandbox column added successfully');
            }

            // Check and add sandbox-related columns to navbar_shortcuts
            const shortcutsColumns = this.db.prepare("PRAGMA table_info(navbar_shortcuts)").all();
            const hasSandboxMode = shortcutsColumns.some(col => col.name === 'sandbox_mode');
            const hasTempDirectory = shortcutsColumns.some(col => col.name === 'temp_directory');
            const hasAskEachTime = shortcutsColumns.some(col => col.name === 'ask_each_time');

            if (!hasSandboxMode) {
                console.log('Adding sandbox_mode column to navbar_shortcuts table...');
                this.db.exec("ALTER TABLE navbar_shortcuts ADD COLUMN sandbox_mode BOOLEAN DEFAULT 0");
                console.log('sandbox_mode column added successfully');
            }

            if (!hasTempDirectory) {
                console.log('Adding temp_directory column to navbar_shortcuts table...');
                this.db.exec("ALTER TABLE navbar_shortcuts ADD COLUMN temp_directory TEXT");
                console.log('temp_directory column added successfully');
            }

            if (!hasAskEachTime) {
                console.log('Adding ask_each_time column to navbar_shortcuts table...');
                this.db.exec("ALTER TABLE navbar_shortcuts ADD COLUMN ask_each_time BOOLEAN DEFAULT 0");
                console.log('ask_each_time column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding sandbox columns:', error);
        }
    }

    addAgentTypeColumnIfNeeded() {
        try {
            // Check if agent_type column exists in navbar_shortcuts
            const columns = this.db.prepare("PRAGMA table_info(navbar_shortcuts)").all();
            const hasAgentType = columns.some(col => col.name === 'agent_type');

            if (!hasAgentType) {
                console.log('Adding agent_type column to navbar_shortcuts table...');
                this.db.exec("ALTER TABLE navbar_shortcuts ADD COLUMN agent_type TEXT DEFAULT 'claude'");
                console.log('agent_type column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding agent_type column:', error);
        }
    }

    /**
     * Adds the columns that let a navbar shortcut resume a SPECIFIC conversation:
     *   - session_id:    the conversation/session id to resume (null = plain "new session" shortcut)
     *   - project_dir:   the agent's on-disk project dir (kept for fidelity with the resume payload)
     *   - session_label: the conversation title, shown on the shortcut tooltip
     * A shortcut with a non-null session_id behaves as a "conversation shortcut".
     */
    addConversationColumnsToShortcutsIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(navbar_shortcuts)").all();
            const addColumnIfMissing = (name, definition) => {
                if (!columns.some(col => col.name === name)) {
                    console.log(`Adding ${name} column to navbar_shortcuts table...`);
                    this.db.exec(`ALTER TABLE navbar_shortcuts ADD COLUMN ${name} ${definition}`);
                    console.log(`${name} column added successfully`);
                }
            };
            addColumnIfMissing('session_id', 'TEXT');
            addColumnIfMissing('project_dir', 'TEXT');
            addColumnIfMissing('session_label', 'TEXT');
        } catch (error) {
            console.error('Error checking/adding conversation columns:', error);
        }
    }

    /**
     * Adds the use_worktree column to navbar_shortcuts.
     * 3-state on purpose (NULL = "never decided", 0 = "no", 1 = "yes") so a
     * shortcut created BEFORE this feature reads as undecided and triggers the
     * one-time "open in git worktree?" prompt on its first fire. We deliberately
     * do NOT use DEFAULT 0 here: that would mark every existing shortcut as a
     * decided "no" and the prompt would never appear.
     */
    addWorktreeColumnToShortcutsIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(navbar_shortcuts)").all();
            const hasUseWorktree = columns.some(col => col.name === 'use_worktree');

            if (!hasUseWorktree) {
                console.log('Adding use_worktree column to navbar_shortcuts table...');
                this.db.exec("ALTER TABLE navbar_shortcuts ADD COLUMN use_worktree BOOLEAN DEFAULT NULL");
                console.log('use_worktree column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding use_worktree column:', error);
        }
    }

    /** Adds the first-class conversation view used when a shortcut launches. */
    addViewModeColumnToShortcutsIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(navbar_shortcuts)").all();
            const hasViewMode = columns.some(col => col.name === 'view_mode');
            if (!hasViewMode) {
                this.db.exec("ALTER TABLE navbar_shortcuts ADD COLUMN view_mode TEXT DEFAULT 'terminal'");
            }
        } catch (error) {
            console.error('Error checking/adding view_mode column:', error);
        }
    }

    /**
     * Adds the base_branch column to the worktrees table.
     * Stores the branch each worktree was forked from (the main checkout's HEAD
     * at creation time) so the Settings list can show "from <base_branch>" and
     * a merge can target the original branch instead of whatever is checked out.
     * Guarded + idempotent: skips when the column already exists. Nullable on
     * purpose so rows created before this feature keep working.
     */
    addBaseBranchColumnToWorktreesIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(worktrees)").all();
            const hasBaseBranch = columns.some(col => col.name === 'base_branch');

            if (!hasBaseBranch) {
                console.log('Adding base_branch column to worktrees table...');
                this.db.exec("ALTER TABLE worktrees ADD COLUMN base_branch TEXT");
                console.log('base_branch column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding base_branch column:', error);
        }
    }

    /**
     * Adds the group_id column to the worktrees table.
     * A composite/group worktree is several rows sharing the same group_id (one
     * ROOT/container row keyed by the conversation's session_id + N synthetic
     * sub-repo child rows). group_id is NULL for a normal single worktree, so
     * today's single-worktree behavior is unchanged.
     * Guarded + idempotent: skips when the column already exists. Nullable on
     * purpose so rows created before this feature keep working.
     */
    addGroupIdColumnToWorktreesIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(worktrees)").all();
            const hasGroupId = columns.some(col => col.name === 'group_id');

            if (!hasGroupId) {
                console.log('Adding group_id column to worktrees table...');
                this.db.exec("ALTER TABLE worktrees ADD COLUMN group_id TEXT");
                console.log('group_id column added successfully');
            }
        } catch (error) {
            console.error('Error checking/adding group_id column:', error);
        }
    }

    /**
     * Adds the cleanup columns to the worktrees table (Settings > Worktrees).
     *
     *   size_bytes       last measured size of the worktree on disk, in bytes.
     *   size_measured_at when that measurement was taken (epoch ms).
     *   keep_flag        1 when the user PINNED the worktree: it is then never
     *                    pre-selected and never bulk-deleted, even if it is
     *                    merged and clean.
     *
     * Measuring 300+ worktrees takes seconds, so the panel renders from these
     * cached values instantly and only re-measures on demand. All three are
     * nullable/defaulted so pre-existing rows keep working (an unmeasured row
     * shows "-", not a fake 0).
     * Guarded + idempotent: each column is added only when missing.
     */
    addCleanupColumnsToWorktreesIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(worktrees)").all();
            const has = (name) => columns.some(col => col.name === name);

            if (!has('size_bytes')) {
                console.log('Adding size_bytes column to worktrees table...');
                this.db.exec("ALTER TABLE worktrees ADD COLUMN size_bytes INTEGER");
            }
            if (!has('size_measured_at')) {
                console.log('Adding size_measured_at column to worktrees table...');
                this.db.exec("ALTER TABLE worktrees ADD COLUMN size_measured_at INTEGER");
            }
            if (!has('keep_flag')) {
                console.log('Adding keep_flag column to worktrees table...');
                this.db.exec("ALTER TABLE worktrees ADD COLUMN keep_flag INTEGER DEFAULT 0");
            }
            if (!has('scan_state')) {
                console.log('Adding scan_state column to worktrees table...');
                this.db.exec("ALTER TABLE worktrees ADD COLUMN scan_state TEXT");
            }
        } catch (error) {
            console.error('Error checking/adding worktree cleanup columns:', error);
        }
    }

    removeTerminalIdColumnIfNeeded() {
        try {
            // Check if terminal_id column exists in tasks table
            const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
            const hasTerminalId = columns.some(col => col.name === 'terminal_id');

            if (hasTerminalId) {
                console.log('🗑️  Removing terminal_id column from tasks table (migration to RAM-only storage)...');

                // SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
                // IMPORTANT: PRAGMA foreign_keys must be set OUTSIDE of transactions

                try {
                    // Disable foreign keys temporarily (BEFORE transaction)
                    this.db.exec('PRAGMA foreign_keys = OFF');

                    // Start transaction
                    this.db.exec('BEGIN TRANSACTION');

                    // Get all existing data
                    const existingTasks = this.db.prepare("SELECT * FROM tasks").all();

                    // Drop the old table
                    this.db.exec('DROP TABLE IF EXISTS tasks');

                    // Create new table WITHOUT terminal_id column
                    this.db.exec(`
                        CREATE TABLE tasks (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            title TEXT NOT NULL,
                            description TEXT,
                            plan TEXT,
                            status TEXT CHECK(status IN ('pending', 'in_progress', 'in_testing', 'completed')) DEFAULT 'pending',
                            sort_order INTEGER DEFAULT 0,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            implementation TEXT,
                            project TEXT,
                            parent_task_id INTEGER,
                            labels TEXT DEFAULT '[]',
                            images TEXT DEFAULT '[]',
                            FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
                        )
                    `);

                    // Restore data (without terminal_id)
                    if (existingTasks.length > 0) {
                        const insertStmt = this.db.prepare(`
                            INSERT INTO tasks (
                                id, title, description, plan, status, sort_order,
                                created_at, updated_at, implementation, project,
                                parent_task_id, labels, images
                            )
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);

                        for (const task of existingTasks) {
                            insertStmt.run(
                                task.id,
                                task.title,
                                task.description,
                                task.plan,
                                task.status,
                                task.sort_order,
                                task.created_at,
                                task.updated_at,
                                task.implementation,
                                task.project || null,
                                task.parent_task_id || null,
                                task.labels || '[]',
                                task.images || '[]'
                            );
                        }
                    }

                    // Commit transaction
                    this.db.exec('COMMIT');

                    // Re-enable foreign keys (AFTER transaction)
                    this.db.exec('PRAGMA foreign_keys = ON');

                    console.log('✅ terminal_id column removed successfully. Task-terminal mappings now stored in RAM only.');

                } catch (error) {
                    this.db.exec('ROLLBACK');
                    this.db.exec('PRAGMA foreign_keys = ON');
                    console.error('❌ Failed to remove terminal_id column:', error);
                    throw error;
                }
            } else {
                console.log('✅ terminal_id column already removed or never existed.');
            }
        } catch (error) {
            console.error('Error checking/removing terminal_id column:', error);
        }
    }

    addIconColumnIfNeeded() {
        try {
            const columns = this.db.prepare("PRAGMA table_info(projects)").all();
            const hasIcon = columns.some(col => col.name === 'icon');

            if (!hasIcon) {
                this.db.exec("ALTER TABLE projects ADD COLUMN icon TEXT DEFAULT NULL");
                console.log('Added icon column to projects table');
            }
        } catch (error) {
            console.error('Error checking/adding icon column:', error);
        }
    }

    initializeSandboxProject() {
        try {
            // Clean up any old sandbox projects with real paths
            console.log('Cleaning up old sandbox projects...');
            this.db.prepare(`
                DELETE FROM projects
                WHERE path LIKE '%/.codeagentswarm/sandbox%'
                OR (name = 'sandbox' AND path != '__sandbox__')
            `).run();

            // Check if Sandbox project already exists
            const existingSandbox = this.db.prepare(`
                SELECT id FROM projects WHERE name = 'Sandbox'
            `).get();

            if (!existingSandbox) {
                console.log('Creating virtual Sandbox project...');
                this.db.prepare(`
                    INSERT INTO projects (name, display_name, color, path)
                    VALUES ('Sandbox', 'Sandbox', '#6B7280', '__sandbox__')
                `).run();
                console.log('Sandbox project created successfully');
            }
        } catch (error) {
            console.error('Error initializing Sandbox project:', error);
        }
    }

    // Seed the terminal_statuses catalog with the defaults, but ONLY when the
    // table is empty. This makes the seed idempotent and preserves any user edits
    // (or deletions) once the catalog has been populated.
    seedTerminalStatusesIfEmpty() {
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS count FROM terminal_statuses').get();
            if (row && row.count > 0) {
                return;
            }

            const insert = this.db.prepare(`
                INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default, agent_settable)
                VALUES (@status_key, @label, @color, @icon, @prompt, @sort_order, @is_default, @agent_settable)
            `);
            const insertAll = this.db.transaction((statuses) => {
                for (const status of statuses) {
                    insert.run(status);
                }
            });
            insertAll(DEFAULT_TERMINAL_STATUSES);
            // A catalog seeded from scratch already contains 'idle', so the
            // back-fill migration below must not run for it.
            this.setSetting(IDLE_STATUS_SEEDED_SETTING, true);
        } catch (error) {
            console.error('Error seeding terminal statuses:', error);
        }
    }

    // Migration: statuses the APP owns (agent_settable = 0) are offered in the
    // manual dropdown and Settings but hidden from the MCP tool and rejected as
    // agent input. Everything that predates the column stays agent-settable.
    addAgentSettableColumnToTerminalStatusesIfNeeded() {
        try {
            const columns = this.db.prepare('PRAGMA table_info(terminal_statuses)').all();
            if (!columns.some(col => col.name === 'agent_settable')) {
                this.db.exec('ALTER TABLE terminal_statuses ADD COLUMN agent_settable INTEGER NOT NULL DEFAULT 1');
            }
        } catch (error) {
            console.error('Error checking/adding agent_settable column to terminal_statuses:', error);
        }
    }

    // Migration: add the 'idle' status to catalogs created before it existed.
    // The seed only runs on an EMPTY table, so without this every existing install
    // would keep showing 'working' on freshly opened terminals. Guarded by a
    // one-shot setting instead of "insert if missing": that way a user who deletes
    // 'idle' from Settings never sees it come back on the next boot. Runs LAST so
    // the sort-order and retired-defaults migrations still see the catalog they
    // were written against (both bail out on an unexpected row count).
    migrateIdleTerminalStatus() {
        try {
            if (this.getSetting(IDLE_STATUS_SEEDED_SETTING)) return;

            const idle = DEFAULT_TERMINAL_STATUSES.find(s => s.status_key === IDLE_TERMINAL_STATUS_KEY);
            if (!idle) return;

            const exists = this.db.prepare(
                'SELECT 1 FROM terminal_statuses WHERE status_key = ?'
            ).get(IDLE_TERMINAL_STATUS_KEY);

            if (!exists) {
                // Park it after everything the user already has: sort_order doubles as
                // the tab priority, and a terminal with no work assigned belongs last.
                const next = this.db.prepare(
                    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM terminal_statuses'
                ).get();
                this.db.prepare(`
                    INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default, agent_settable)
                    VALUES (@status_key, @label, @color, @icon, @prompt, @sort_order, @is_default, @agent_settable)
                `).run({ ...idle, sort_order: (next && next.next) || idle.sort_order });
            }

            this.setSetting(IDLE_STATUS_SEEDED_SETTING, true);
        } catch (error) {
            console.error('Error migrating idle terminal status:', error);
        }
    }

    // Migration: upgrade the legacy SPANISH factory prompts to the English ones.
    // Only touches default statuses whose prompt is still the legacy string
    // VERBATIM (i.e. the user never edited it), so user wording always wins.
    // Idempotent: once upgraded, no row matches any more.
    migrateLegacyTerminalStatusPrompts() {
        try {
            const update = this.db.prepare(`
                UPDATE terminal_statuses
                SET prompt = @prompt
                WHERE status_key = @status_key AND is_default = 1 AND prompt = @legacy_prompt
            `);
            const migrate = this.db.transaction(() => {
                for (const status of DEFAULT_TERMINAL_STATUSES) {
                    const legacy = LEGACY_SPANISH_DEFAULT_PROMPTS[status.status_key];
                    if (!legacy) continue;
                    update.run({
                        status_key: status.status_key,
                        prompt: status.prompt,
                        legacy_prompt: legacy
                    });
                }
            });
            migrate();
        } catch (error) {
            console.error('Error migrating legacy terminal status prompts:', error);
        }
    }

    // Migration: reorder the default statuses to the attention-first priority used by
    // "sort tabs by status" (#12083). ONLY runs when the six defaults still carry the
    // OLD arrangement VERBATIM (working=1 … done=6) — i.e. the user never reordered.
    // If any default is missing, renamed away, or already reordered, it is a no-op, so
    // a deliberate user ordering always wins. Idempotent: after it runs, the old
    // arrangement no longer matches.
    migrateDefaultTerminalStatusSortOrderIfPristine() {
        try {
            const rows = this.db.prepare(
                'SELECT status_key, sort_order FROM terminal_statuses WHERE is_default = 1'
            ).all();
            const current = {};
            for (const row of rows) current[row.status_key] = row.sort_order;

            const legacyKeys = Object.keys(LEGACY_DEFAULT_SORT_ORDER);
            const isPristine = legacyKeys.length === rows.length &&
                legacyKeys.every(key => current[key] === LEGACY_DEFAULT_SORT_ORDER[key]);
            if (!isPristine) return;

            const update = this.db.prepare(
                'UPDATE terminal_statuses SET sort_order = @sort_order WHERE status_key = @status_key AND is_default = 1'
            );
            const migrate = this.db.transaction(() => {
                for (const status of DEFAULT_TERMINAL_STATUSES) {
                    update.run({ status_key: status.status_key, sort_order: status.sort_order });
                }
            });
            migrate();
        } catch (error) {
            console.error('Error migrating default terminal status sort order:', error);
        }
    }

    // Migration: delete the RETIRED defaults ('blocked', 'pending_commit') from
    // existing catalogs — ONLY while each row is still a pristine, enabled factory
    // row (label, color and prompt untouched, English or legacy Spanish wording).
    // A user edit or a deliberate disable keeps the row forever. Runs AFTER the
    // sort-order migration on purpose: that one needs to see all six legacy rows
    // to detect a pristine install. Idempotent: deleted rows never match again.
    migrateRetiredDefaultTerminalStatuses() {
        try {
            const del = this.db.prepare(`
                DELETE FROM terminal_statuses
                WHERE status_key = @status_key AND is_default = 1 AND enabled = 1
                  AND label = @label AND color = @color
                  AND prompt IN (@prompt_en, @prompt_es)
            `);
            const migrate = this.db.transaction(() => {
                for (const retired of RETIRED_DEFAULT_TERMINAL_STATUSES) del.run(retired);
            });
            migrate();
        } catch (error) {
            console.error('Error migrating retired terminal statuses:', error);
        }
    }

    // Migration: statuses can be DISABLED without deleting them (Settings toggle).
    // A disabled status keeps the user's edits but is not offered to agents nor in
    // the manual dropdown; a terminal already carrying it still renders it.
    addEnabledColumnToTerminalStatusesIfNeeded() {
        try {
            const columns = this.db.prepare('PRAGMA table_info(terminal_statuses)').all();
            if (!columns.some(col => col.name === 'enabled')) {
                this.db.exec('ALTER TABLE terminal_statuses ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
            }
        } catch (error) {
            console.error('Error checking/adding enabled column to terminal_statuses:', error);
        }
    }

    // Return the whole catalog of terminal statuses ordered by sort_order ASC.
    // Includes DISABLED ones (enabled: 0): consumers that must not offer them
    // (MCP tool, manual dropdown) filter on `enabled`; the renderer keeps the
    // full list so an already-set disabled status still shows its color/label.
    getTerminalStatuses() {
        try {
            const stmt = this.db.prepare(`
                SELECT status_key, label, color, icon, prompt, sort_order, is_default, enabled, agent_settable
                FROM terminal_statuses
                ORDER BY sort_order ASC
            `);
            return stmt.all();
        } catch (error) {
            console.error('Error getting terminal statuses:', error);
            return [];
        }
    }

    // ---- Custom terminal statuses CRUD (Settings > Terminal Statuses) ----------
    // The status_key is IMMUTABLE once created: terminals persist it in
    // localStorage and agents reference it through the MCP tool, so edits only
    // touch label/color/icon/prompt/sort_order.

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

    // Derive a unique, stable key from the label: "En revisión de PR" -> "en_revision_de_pr".
    _generateTerminalStatusKey(label) {
        const base = String(label).trim().toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // drop accents
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 40) || 'status';
        const exists = this.db.prepare('SELECT 1 FROM terminal_statuses WHERE status_key = ?');
        if (!exists.get(base)) return base;
        for (let i = 2; i < 100; i++) {
            if (!exists.get(`${base}_${i}`)) return `${base}_${i}`;
        }
        return `${base}_${Date.now()}`;
    }

    createTerminalStatus({ label, color, icon, prompt }) {
        try {
            const invalid = this._validateTerminalStatusFields({ label, color, icon, prompt });
            if (invalid) return { success: false, error: invalid };
            const statusKey = this._generateTerminalStatusKey(label);
            const next = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM terminal_statuses').get();
            this.db.prepare(`
                INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default)
                VALUES (?, ?, ?, ?, ?, ?, 0)
            `).run(statusKey, String(label).trim(), color, String(icon).trim(), String(prompt).trim(), next.next);
            return { success: true, status_key: statusKey };
        } catch (error) {
            console.error('Error creating terminal status:', error);
            return { success: false, error: error.message };
        }
    }

    updateTerminalStatus(statusKey, fields) {
        try {
            const invalid = this._validateTerminalStatusFields(fields || {}, { partial: true });
            if (invalid) return { success: false, error: invalid };
            // Disabling: keep at least one ENABLED status, or agents and the manual
            // dropdown would have nothing to offer.
            if (fields && (fields.enabled === 0 || fields.enabled === false)) {
                const others = this.db.prepare(
                    'SELECT COUNT(*) AS count FROM terminal_statuses WHERE enabled = 1 AND status_key != ?'
                ).get(statusKey);
                if (!others || others.count === 0) {
                    return { success: false, error: 'cannot disable the last enabled status' };
                }
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
            params.push(statusKey);
            const result = this.db.prepare(`UPDATE terminal_statuses SET ${sets.join(', ')} WHERE status_key = ?`).run(...params);
            if (result.changes === 0) return { success: false, error: `status "${statusKey}" not found` };
            return { success: true };
        } catch (error) {
            console.error('Error updating terminal status:', error);
            return { success: false, error: error.message };
        }
    }

    // Reorder the whole catalog: sort_order becomes the position in orderedKeys
    // (1-based). This IS the tab priority when "sort tabs by status" is on, and it
    // also drives the manual dropdown + this Settings list. Keys not present are
    // ignored; any status missing from orderedKeys keeps its previous sort_order.
    reorderTerminalStatuses(orderedKeys) {
        try {
            if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) {
                return { success: false, error: 'orderedKeys must be a non-empty array' };
            }
            const update = this.db.prepare('UPDATE terminal_statuses SET sort_order = ? WHERE status_key = ?');
            const run = this.db.transaction((keys) => {
                keys.forEach((key, index) => update.run(index + 1, key));
            });
            run(orderedKeys);
            return { success: true };
        } catch (error) {
            console.error('Error reordering terminal statuses:', error);
            return { success: false, error: error.message };
        }
    }

    deleteTerminalStatus(statusKey) {
        try {
            // Keep at least one status: an empty catalog would leave the MCP tool
            // with nothing to offer (it would fall back to the hardcoded defaults,
            // silently resurrecting what the user just deleted).
            const count = this.db.prepare('SELECT COUNT(*) AS count FROM terminal_statuses').get();
            if (count && count.count <= 1) return { success: false, error: 'cannot delete the last status' };
            // Same rule for the ENABLED subset: deleting the only enabled status
            // would leave agents and the dropdown with nothing to offer.
            const target = this.db.prepare('SELECT enabled FROM terminal_statuses WHERE status_key = ?').get(statusKey);
            if (target && target.enabled === 1) {
                const others = this.db.prepare(
                    'SELECT COUNT(*) AS count FROM terminal_statuses WHERE enabled = 1 AND status_key != ?'
                ).get(statusKey);
                if (!others || others.count === 0) {
                    return { success: false, error: 'cannot delete the last enabled status' };
                }
            }
            const result = this.db.prepare('DELETE FROM terminal_statuses WHERE status_key = ?').run(statusKey);
            if (result.changes === 0) return { success: false, error: `status "${statusKey}" not found` };
            return { success: true };
        } catch (error) {
            console.error('Error deleting terminal status:', error);
            return { success: false, error: error.message };
        }
    }

    // Wipe the catalog back to the factory defaults (transactional: never leaves
    // a half-restored catalog behind).
    restoreDefaultTerminalStatuses() {
        try {
            const insert = this.db.prepare(`
                INSERT INTO terminal_statuses (status_key, label, color, icon, prompt, sort_order, is_default, agent_settable)
                VALUES (@status_key, @label, @color, @icon, @prompt, @sort_order, @is_default, @agent_settable)
            `);
            const restore = this.db.transaction(() => {
                this.db.prepare('DELETE FROM terminal_statuses').run();
                for (const status of DEFAULT_TERMINAL_STATUSES) insert.run(status);
            });
            restore();
            // The restored catalog already carries 'idle' — keep the one-shot
            // migration from trying to add a second copy later.
            this.setSetting(IDLE_STATUS_SEEDED_SETTING, true);
            return { success: true };
        } catch (error) {
            console.error('Error restoring default terminal statuses:', error);
            return { success: false, error: error.message };
        }
    }

    // Update terminal sandbox mode
    updateTerminalSandboxMode(terminalId, isSandbox) {
        try {
            const stmt = this.db.prepare(`
                UPDATE terminal_directories
                SET is_sandbox = ?
                WHERE terminal_id = ?
            `);

            stmt.run(isSandbox ? 1 : 0, terminalId);
            return { success: true };
        } catch (error) {
            console.error('Error updating terminal sandbox mode:', error);
            return { success: false, error: error.message };
        }
    }

    // Check if a terminal is in sandbox mode
    isTerminalSandbox(terminalId) {
        try {
            const result = this.db.prepare(`
                SELECT is_sandbox FROM terminal_directories
                WHERE terminal_id = ?
            `).get(terminalId);

            return result ? Boolean(result.is_sandbox) : false;
        } catch (error) {
            console.error('Error checking terminal sandbox mode:', error);
            return false;
        }
    }

    // Save or update directory for a terminal
    saveTerminalDirectory(terminalId, directory, options = {}) {
        const { is_sandbox = false, skip_claude_md = false } = options;
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO terminal_directories (terminal_id, directory, is_sandbox, last_used)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `);

            stmt.run(terminalId, directory, is_sandbox ? 1 : 0);

            // If sandbox mode, skip project detection and CLAUDE.md creation
            if (is_sandbox || skip_claude_md) {
                console.log(`[Sandbox] Terminal ${terminalId} saved in sandbox mode, skipping project detection`);
                return { success: true, sandbox: true };
            }

            // A per-conversation WORKTREE must never mint its own project: its project
            // identity is the repo it was created from. resolveProjectDir prefers the
            // worktrees row and falls back to the path shape, so a worktree with NO row
            // (deleted row, created by an older build, a group sub-repo) still resolves
            // instead of registering a project named after its slug (#12154).
            // Fail-safe: any error keeps the directory as the identity.
            let projectDir = directory;
            try {
                const { resolveProjectDir } = require('../../shared/utils/worktree-project-resolver');
                projectDir = resolveProjectDir(directory, this.listWorktrees());
            } catch (worktreeLookupError) {
                console.error('Error resolving worktree repo root for project identity:', worktreeLookupError);
                projectDir = directory;
            }

            // Check if there's a CLAUDE.md with a project in this directory
            const fs = require('fs');
            const path = require('path');
            const { extractProjectNameFromClaudeMd } = require('../config/claude-md-global-config');
            const claudeMdPath = path.join(projectDir, 'CLAUDE.md');

            // Determine project name with correct priority:
            // 1. CLAUDE.md (if exists and has project name)
            // 2. Existing DB entry (if already registered)
            // 3. Directory basename (fallback)
            let projectName = null;

            // Priority 1: Try to extract from CLAUDE.md first
            if (fs.existsSync(claudeMdPath)) {
                try {
                    const content = fs.readFileSync(claudeMdPath, 'utf8');
                    projectName = extractProjectNameFromClaudeMd(content);
                } catch (error) {
                    console.error('Error reading CLAUDE.md for project name:', error);
                }
            }

            // Priority 2: Check if project already exists in DB for this path
            const existingProject = this.getProjectByPath(projectDir);
            if (existingProject) {
                // P0-CORE (Option A groundwork): the DB row is AUTHORITATIVE for the
                // project name. We no longer overwrite projects.name from CLAUDE.md
                // here. That overwrite rewrote the join key (projects.name) WITHOUT
                // updating tasks.project in lockstep, silently detaching every task
                // tagged with the old name — the root cause of the orphaned-task bug.
                // We keep the DB name and only LOG a divergence for diagnostics.
                if (projectName && projectName !== existingProject.name) {
                    console.log(`[Project] CLAUDE.md name "${projectName}" differs from DB name "${existingProject.name}" for ${directory}; keeping DB name (no overwrite — prevents task orphaning).`);
                }
                projectName = existingProject.name;
            }

            // Priority 3: Fallback to directory basename
            if (!projectName) {
                projectName = path.basename(projectDir);
                console.log(`Using directory basename as project name: "${projectName}"`);
            }

            // Create project if it doesn't exist yet
            if (!existingProject) {
                console.log(`Creating new project: "${projectName}" at ${projectDir}`);
                this.createProject(projectName, projectDir);
            }
            
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Get directory for a terminal
    getTerminalDirectory(terminalId) {
        try {
            const stmt = this.db.prepare(`
                SELECT directory FROM terminal_directories
                WHERE terminal_id = ?
            `);
            
            const row = stmt.get(terminalId);
            return row ? row.directory : null;
        } catch (err) {
            return null;
        }
    }

    // Get all terminal directories
    getAllTerminalDirectories() {
        try {
            const stmt = this.db.prepare(`
                SELECT terminal_id, directory FROM terminal_directories
                ORDER BY terminal_id
            `);
            
            const rows = stmt.all();
            const directories = {};
            rows.forEach(row => {
                directories[row.terminal_id] = row.directory;
            });
            return directories;
        } catch (err) {
            return {};
        }
    }

    // Delete directory for a terminal
    deleteTerminalDirectory(terminalId) {
        try {
            const stmt = this.db.prepare(`DELETE FROM terminal_directories WHERE terminal_id = ?`);
            stmt.run(terminalId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Save app setting
    ensureAnalyticsInstallIdentity(existingInstall) {
        const storedOrigin = this.getSetting('analytics_install_origin');
        if (!['fresh', 'legacy'].includes(storedOrigin)) {
            this.saveSetting('analytics_install_origin', existingInstall ? 'legacy' : 'fresh');
        }

        const storedId = this.getSetting('analytics_install_id');
        if (typeof storedId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedId)) {
            this.saveSetting('analytics_install_id', randomUUID());
        }
    }

    saveSetting(key, value) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO app_settings (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `);
            
            stmt.run(key, JSON.stringify(value));
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    getSettingResult(key) {
        try {
            const stmt = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`);
            const row = stmt.get(key);
            if (!row) return { success: true, value: null };
            // setSetting() writes a plain string VERBATIM (it only JSON.stringify's
            // non-strings), so a value like `claude` is NOT valid JSON. Parsing it
            // used to throw and the whole read collapsed to null, which callers
            // read as "never set" and replaced with their default — the navbar
            // quota ring silently forgot the chosen agent on every read. Falling
            // back to the raw text keeps JSON values typed AND makes bare strings
            // readable, including the ones already on disk (no migration needed).
            try {
                return { success: true, value: JSON.parse(row.value) };
            } catch (_parseErr) {
                return { success: true, value: row.value };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Get app setting. Legacy callers intentionally collapse read failures to null.
    getSetting(key) {
        const result = this.getSettingResult(key);
        return result.success ? result.value : null;
    }
    
    // Set app setting
    // NOTE: there are TWO writers for app_settings and they store differently.
    // saveSetting() above always JSON.stringify's (so 'midnight' lands as
    // "midnight"); setSetting() below leaves an already-string value VERBATIM (so
    // 'claude' lands as claude, which is not valid JSON). getSetting() therefore
    // has to read BOTH shapes — do not "simplify" its parse back to a bare
    // JSON.parse, or every string written through this method becomes unreadable
    // and its callers silently fall back to their defaults (task #12213).
    setSetting(key, value) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO app_settings (key, value, updated_at)
                VALUES (?, ?, datetime('now'))
            `);
            const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
            stmt.run(key, valueStr);
            return true;
        } catch (err) {
            console.error('Error setting preference:', err);
            return false;
        }
    }

    // Get user's preferred shell
    getUserShell() {
        const shellSetting = this.getSetting('preferred_shell');
        if (shellSetting && shellSetting.type) {
            if (shellSetting.type === 'system') {
                // Use system default shell
                if (process.platform === 'win32') {
                    return process.env.ComSpec || 'cmd.exe';
                }
                return process.env.SHELL || '/bin/zsh';
            } else if (shellSetting.type === 'custom') {
                return shellSetting.path || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
            } else {
                // For specific shell names, try to find them in common locations
                const shellName = shellSetting.type;
                const commonPaths = [
                    `/bin/${shellName}`,
                    `/usr/bin/${shellName}`,
                    `/usr/local/bin/${shellName}`,
                    `/opt/homebrew/bin/${shellName}`
                ];

                const fs = require('fs');
                for (const path of commonPaths) {
                    if (fs.existsSync(path)) {
                        return path;
                    }
                }

                // If not found, default to system shell
                if (process.platform === 'win32') {
                    return process.env.ComSpec || 'cmd.exe';
                }
                return process.env.SHELL || '/bin/zsh';
            }
        }
        // Default to system shell
        if (process.platform === 'win32') {
            return process.env.ComSpec || 'cmd.exe';
        }
        return process.env.SHELL || '/bin/zsh';
    }

    // Task management methods
    
    // Create a new task
    createTask(title, description, terminalId = null, project = null, parentTaskId = null, labels = []) {
        try {
            // Convert labels array to JSON string
            const labelsJSON = JSON.stringify(labels || []);

            // NOTE: terminalId parameter is kept for backwards compatibility but not stored in DB
            // Task-terminal mappings are managed via terminalTaskMap (RAM only)

            // Use IMMEDIATE transaction to prevent AUTOINCREMENT gaps from concurrent inserts.
            // A caller may already own the transaction (for example an atomic remote mutation).
            const ownsTransaction = !this.db.inTransaction;
            if (ownsTransaction) this.db.prepare('BEGIN IMMEDIATE').run();

            try {
                const stmt = this.db.prepare(`
                    INSERT INTO tasks (title, description, status, project, parent_task_id, labels)
                    VALUES (?, ?, 'pending', ?, ?, ?)
                `);

                // Allow null project for tasks without a project
                const result = stmt.run(title, description, project || null, parentTaskId || null, labelsJSON);

                if (ownsTransaction) this.db.prepare('COMMIT').run();

                return { success: true, taskId: result.lastInsertRowid };
            } catch (err) {
                if (ownsTransaction) this.db.prepare('ROLLBACK').run();
                throw err;
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Get a task by ID with images
    getTaskById(taskId) {
        try {
            const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
            if (task) {
                // Parse labels if they exist
                if (task.labels) {
                    try {
                        task.labels = JSON.parse(task.labels);
                    } catch (e) {
                        task.labels = [];
                    }
                } else {
                    task.labels = [];
                }
                
                // Parse images if they exist
                if (task.images) {
                    try {
                        task.images = JSON.parse(task.images);
                    } catch (e) {
                        task.images = [];
                    }
                } else {
                    task.images = [];
                }
            }
            return task;
        } catch (err) {
            console.error('Error getting task by ID:', err);
            return null;
        }
    }

    // Update task status
    updateTaskStatus(taskId, status) {
        try {
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(status, taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Get all tasks with pagination
    getAllTasks(limit = null, offset = 0) {
        try {
            let query = `
                SELECT * FROM tasks 
                ORDER BY sort_order ASC, created_at DESC
            `;
            
            if (limit !== null) {
                query += ` LIMIT ${limit} OFFSET ${offset}`;
            }
            
            const stmt = this.db.prepare(query);
            const tasks = stmt.all();
            
            // Parse labels JSON for each task
            return tasks.map(task => ({
                ...task,
                labels: task.labels ? JSON.parse(task.labels) : []
            }));
        } catch (err) {
            return [];
        }
    }
    
    // Get total count of tasks
    getTasksCount() {
        try {
            const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM tasks`);
            const result = stmt.get();
            return result ? result.count : 0;
        } catch (err) {
            return 0;
        }
    }

    // Get tasks by status with pagination
    getTasksByStatus(status, limit = null, offset = 0) {
        try {
            let query = `
                SELECT * FROM tasks 
                WHERE status = ?
                ORDER BY sort_order ASC, created_at DESC
            `;
            
            if (limit !== null) {
                query += ` LIMIT ${limit} OFFSET ${offset}`;
            }
            
            const stmt = this.db.prepare(query);
            return stmt.all(status);
        } catch (err) {
            return [];
        }
    }
    
    // Get count of tasks by status
    getTasksCountByStatus(status) {
        try {
            const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = ?`);
            const result = stmt.get(status);
            return result ? result.count : 0;
        } catch (err) {
            return 0;
        }
    }

    // Search tasks by title, description, plan, implementation, or ID
    searchTasks(query, options = {}) {
        try {
            // Backward compatibility: if options is a number, treat it as limit
            if (typeof options === 'number') {
                options = { limit: options };
            }

            // Extract options with defaults
            const {
                status = null,
                recentOnly = false,
                limit = 20
            } = options;

            // If query is a number, search by ID as well
            const isNumeric = !isNaN(query);

            // Build WHERE clauses
            const whereClauses = [];
            const params = [];

            // Search query in title, description, plan, and implementation
            if (isNumeric) {
                whereClauses.push('(title LIKE ? OR description LIKE ? OR plan LIKE ? OR implementation LIKE ? OR id = ?)');
                const searchPattern = `%${query}%`;
                params.push(searchPattern, searchPattern, searchPattern, searchPattern, parseInt(query));
            } else {
                whereClauses.push('(title LIKE ? OR description LIKE ? OR plan LIKE ? OR implementation LIKE ?)');
                const searchPattern = `%${query}%`;
                params.push(searchPattern, searchPattern, searchPattern, searchPattern);
            }

            // Add status filter if provided
            if (status) {
                whereClauses.push('status = ?');
                params.push(status);
            }

            // Add recentOnly filter (last 48 hours)
            if (recentOnly) {
                whereClauses.push("datetime(updated_at) >= datetime('now', '-48 hours')");
            }

            // Build complete query
            const whereClause = whereClauses.join(' AND ');
            const orderBy = isNumeric
                ? 'CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC'
                : 'created_at DESC';

            let sql = `
                SELECT * FROM tasks
                WHERE ${whereClause}
                ORDER BY ${orderBy}
                LIMIT ?
            `;

            // Add ID for ordering if numeric
            if (isNumeric) {
                params.push(parseInt(query));
            }

            // Add limit
            params.push(limit);

            const stmt = this.db.prepare(sql);
            const tasks = stmt.all(...params);

            // Parse labels JSON for each task
            return tasks.map(task => ({
                ...task,
                labels: task.labels ? JSON.parse(task.labels) : []
            }));
        } catch (err) {
            console.error('Error searching tasks:', err);
            return [];
        }
    }

    // Get current task for a terminal (ANY status - badge should persist)
    // NOW USES RAM-BASED MAP instead of DB column terminal_id
    // The mapping is only cleared when a NEW task overrides it (in updateTaskTerminal)
    getCurrentTask(terminalId) {
        try {
            const debugTasks = process.env.DEBUG_TASKS === 'true';

            // Look up task ID in RAM map
            const taskId = this.terminalTaskMap.get(terminalId);

            if (!taskId) {
                return null; // No task assigned to this terminal
            }

            // Fetch full task details from DB by ID (ANY status - not just in_progress)
            const stmt = this.db.prepare(`
                SELECT * FROM tasks
                WHERE id = ?
            `);

            const task = stmt.get(taskId);

            // If task no longer exists (deleted), clean up the map
            if (!task) {
                if (debugTasks) {
                    console.log(`[getCurrentTask] Terminal ${terminalId}: Task ${taskId} not found, cleaning map`);
                }
                this.terminalTaskMap.delete(terminalId);
                return null;
            }

            if (debugTasks) {
                console.log(`[getCurrentTask] Terminal ${terminalId}: Returning task #${task.id}`);
            }

            // Return the task regardless of status
            return task;
        } catch (err) {
            console.error('Error in getCurrentTask:', err);
            return null;
        }
    }

    // Delete a task
    deleteTask(taskId) {
        try {
            // First, get the task to find its images
            const task = this.db.prepare('SELECT images FROM tasks WHERE id = ?').get(taskId);
            
            // Delete associated image files if they exist
            if (task && task.images) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    
                    // Parse images data
                    let images = [];
                    if (typeof task.images === 'string') {
                        try {
                            images = JSON.parse(task.images);
                        } catch (e) {
                            // Not valid JSON, might be old format
                        }
                    }
                    
                    // Images directory
                    const imagesDir = path.join(
                        process.env.HOME || process.env.USERPROFILE,
                        'Library/Application Support/codeagentswarm/task-images'
                    );
                    
                    // Delete each image file associated with this task
                    for (const image of images) {
                        if (image.path) {
                            // New format with file path
                            try {
                                if (fs.existsSync(image.path)) {
                                    fs.unlinkSync(image.path);
                                    console.log(`Deleted image file: ${image.path}`);
                                }
                            } catch (fileErr) {
                                console.error(`Failed to delete image file: ${image.path}`, fileErr);
                            }
                        }
                    }
                    
                    // Also try to delete any files matching the pattern task_${taskId}_*
                    // This covers cases where the image data might be corrupted or in old format
                    if (fs.existsSync(imagesDir)) {
                        const files = fs.readdirSync(imagesDir);
                        const taskPattern = new RegExp(`^task_${taskId}_.*`);
                        
                        files.forEach(file => {
                            if (taskPattern.test(file)) {
                                const filePath = path.join(imagesDir, file);
                                try {
                                    fs.unlinkSync(filePath);
                                    console.log(`Deleted orphaned image file: ${filePath}`);
                                } catch (fileErr) {
                                    console.error(`Failed to delete orphaned image: ${filePath}`, fileErr);
                                }
                            }
                        });
                    }
                } catch (cleanupErr) {
                    // Log but don't fail the task deletion if image cleanup fails
                    console.error('Error cleaning up task images:', cleanupErr);
                }
            }
            
            // Now delete the task from database
            const stmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
            stmt.run(taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Bulk delete multiple tasks
    bulkDeleteTasks(taskIds) {
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return { success: true, deletedCount: 0 };
        }
        try {
            const placeholders = taskIds.map(() => '?').join(',');
            const stmt = this.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`);
            const result = stmt.run(...taskIds);
            return { success: true, deletedCount: result.changes };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Bulk update status for multiple tasks
    bulkUpdateTaskStatus(taskIds, newStatus) {
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return { success: true, updatedCount: 0 };
        }
        try {
            const placeholders = taskIds.map(() => '?').join(',');
            const stmt = this.db.prepare(`UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`);
            const result = stmt.run(newStatus, ...taskIds);
            return { success: true, updatedCount: result.changes };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Update task details
    updateTask(taskId, title, description) {
        try {
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(title, description, taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Update task terminal_id
    // NOW USES RAM-BASED MAP instead of DB column terminal_id
    updateTaskTerminal(taskId, terminalId) {
        try {
            // First, remove this task from any terminal it was previously assigned to
            for (const [tId, tTaskId] of this.terminalTaskMap.entries()) {
                if (tTaskId === taskId) {
                    this.terminalTaskMap.delete(tId);
                }
            }

            // If terminalId is provided and valid, assign task to this terminal
            if (terminalId !== null && terminalId !== '' && terminalId !== undefined) {
                this.terminalTaskMap.set(parseInt(terminalId), parseInt(taskId));
                console.log(`Task ${taskId} assigned to terminal ${terminalId} (RAM only)`);
            } else {
                console.log(`Task ${taskId} unassigned from all terminals (RAM)`);
            }

            // NOTE: We no longer update the DB column terminal_id
            // The mapping is now stored only in RAM (terminalTaskMap)

            return { success: true };
        } catch (err) {
            console.error('Error in updateTaskTerminal:', err);
            return { success: false, error: err.message };
        }
    }

    // Update task images - now saves files to disk and stores paths
    updateTaskImages(taskId, images) {
        try {
            const fs = require('fs');
            const path = require('path');
            const crypto = require('crypto');
            
            // Images directory
            const imagesDir = path.join(
                process.env.HOME || process.env.USERPROFILE,
                'Library/Application Support/codeagentswarm/task-images'
            );
            
            // Ensure directory exists
            if (!fs.existsSync(imagesDir)) {
                fs.mkdirSync(imagesDir, { recursive: true });
            }
            
            // Process each image
            const imagePaths = [];
            for (const image of (images || [])) {
                if (image.data && image.data.startsWith('data:')) {
                    // Extract base64 data
                    const base64Data = image.data.split(',')[1];
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    // Generate unique filename
                    const hash = crypto.createHash('md5').update(base64Data).digest('hex');
                    const ext = image.type ? image.type.split('/')[1] : 'png';
                    const filename = `task_${taskId}_${hash}.${ext}`;
                    const filepath = path.join(imagesDir, filename);
                    
                    // Save file
                    fs.writeFileSync(filepath, buffer);
                    
                    // Store path info
                    imagePaths.push({
                        id: image.id,
                        name: image.name,
                        path: filepath,
                        size: image.size,
                        type: image.type
                    });
                } else if (image.path) {
                    // Already a file path, just store it
                    imagePaths.push(image);
                }
            }
            
            // Save paths to database
            const imagesJSON = JSON.stringify(imagePaths);
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET images = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(imagesJSON, taskId);
            return { success: true, imagePaths };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Update task plan
    updateTaskPlan(taskId, plan) {
        try {
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET plan = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(plan || '', taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Update task implementation
    updateTaskImplementation(taskId, implementation) {
        try {
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET implementation = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(implementation || '', taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
    
    // Update task labels
    updateTaskLabels(taskId, labels) {
        try {
            const labelsJSON = JSON.stringify(labels || []);
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET labels = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(labelsJSON, taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Update task order
    updateTasksOrder(taskOrders) {
        try {
            const updateStmt = this.db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?");
            
            this.db.transaction(() => {
                for (const order of taskOrders) {
                    updateStmt.run(order.sortOrder, order.taskId);
                }
            })();
            
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Update task project
    updateTaskProject(taskId, project) {
        try {
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET project = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            // Allow null project for tasks without a project
            stmt.run(project || null, taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Subtask management methods
    
    // Get subtasks of a parent task
    getSubtasks(parentTaskId) {
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM tasks 
                WHERE parent_task_id = ?
                ORDER BY sort_order ASC, created_at DESC
            `);
            
            return stmt.all(parentTaskId);
        } catch (err) {
            return [];
        }
    }

    // Link a task to a parent (make it a subtask)
    linkTaskToParent(taskId, parentTaskId) {
        try {
            // Check if parent task exists
            const parentStmt = this.db.prepare(`SELECT id FROM tasks WHERE id = ?`);
            const parent = parentStmt.get(parentTaskId);
            
            if (!parent) {
                return { success: false, error: 'Parent task not found' };
            }
            
            // Check for circular dependency
            if (this.wouldCreateCircularDependency(taskId, parentTaskId)) {
                return { success: false, error: 'Cannot create circular dependency' };
            }
            
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET parent_task_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(parentTaskId, taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Unlink a task from its parent (make it a standalone task)
    unlinkTaskFromParent(taskId) {
        try {
            const stmt = this.db.prepare(`
                UPDATE tasks 
                SET parent_task_id = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            
            stmt.run(taskId);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Check if linking would create a circular dependency
    wouldCreateCircularDependency(taskId, potentialParentId) {
        try {
            // If task and parent are the same, it's circular
            if (taskId === potentialParentId) {
                return true;
            }
            
            // Check if potentialParentId is already a descendant of taskId
            const checkDescendants = (currentId) => {
                const stmt = this.db.prepare(`SELECT id FROM tasks WHERE parent_task_id = ?`);
                const children = stmt.all(currentId);
                
                for (const child of children) {
                    if (child.id === potentialParentId) {
                        return true;
                    }
                    if (checkDescendants(child.id)) {
                        return true;
                    }
                }
                return false;
            };
            
            return checkDescendants(taskId);
        } catch (err) {
            // On error, play it safe and prevent the operation
            return true;
        }
    }

    // Get task with its parent info
    getTaskWithParent(taskId) {
        try {
            const stmt = this.db.prepare(`
                SELECT 
                    t.*,
                    p.id as parent_id,
                    p.title as parent_title,
                    p.status as parent_status
                FROM tasks t
                LEFT JOIN tasks p ON t.parent_task_id = p.id
                WHERE t.id = ?
            `);
            
            return stmt.get(taskId);
        } catch (err) {
            return null;
        }
    }

    // Get task hierarchy (task with all its subtasks recursively)
    getTaskHierarchy(taskId) {
        try {
            const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
            
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
        } catch (err) {
            return null;
        }
    }

    // Project management methods
    
    // Create a new project
    createProject(name, path, color = null) {
        try {
            // First check if project already exists
            const existingProject = this.getProjectByName(name);
            if (existingProject) {
                return {
                    success: false,
                    error: `A project with the name "${name}" already exists. Please choose a different name.`
                };
            }
            
            // If no color provided, pick from predefined palette
            if (!color) {
                const colors = [
                    '#007ACC', // Blue
                    '#00C853', // Green
                    '#FF6B6B', // Red
                    '#FFA726', // Orange
                    '#AB47BC', // Purple
                    '#26A69A', // Teal
                    '#EC407A', // Pink
                    '#7E57C2', // Deep Purple
                    '#29B6F6', // Light Blue
                    '#66BB6A'  // Light Green
                ];
                
                // Spread colors as evenly as possible: pick the least-used one.
                // (A plain "first unused || colors[0]" fallback made every project
                // after the 10th default to #007ACC, the first project's color.)
                const existingProjects = this.getProjects();
                const usageCount = new Map(colors.map(c => [c, 0]));
                existingProjects.forEach(p => {
                    if (usageCount.has(p.color)) {
                        usageCount.set(p.color, usageCount.get(p.color) + 1);
                    }
                });
                color = colors.reduce((least, c) =>
                    usageCount.get(c) < usageCount.get(least) ? c : least, colors[0]);
            }
            
            // Path is now required
            if (!path) {
                return { success: false, error: 'Path is required for project creation' };
            }
            
            // Check if another project already uses this path
            const existingProjectWithPath = this.getProjectByPath(path);
            if (existingProjectWithPath) {
                return { 
                    success: false, 
                    error: `Path already used by project "${existingProjectWithPath.name}"` 
                };
            }

            const stmt = this.db.prepare(`
                INSERT INTO projects (name, display_name, color, path)
                VALUES (?, ?, ?, ?)
            `);
            
            const result = stmt.run(name, name, color, path); // display_name defaults to name
            
            return { success: true, projectId: result.lastInsertRowid, name, color };
        } catch (err) {
            console.error('Database error creating project:', err);
            return { success: false, error: err.message };
        }
    }
    
    // Get all projects
    getProjects() {
        try {
            const stmt = this.db.prepare(`
                SELECT
                    p.*,
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
                    END DESC
            `);

            return stmt.all();
        } catch (err) {
            console.error('Error getting projects with task counts:', err);
            return [];
        }
    }
    
    // Update project last opened timestamp
    updateProjectLastOpened(projectPath) {
        try {
            const stmt = this.db.prepare(`
                UPDATE projects 
                SET last_opened = CURRENT_TIMESTAMP 
                WHERE path = ?
            `);
            
            const result = stmt.run(projectPath);
            
            if (result.changes > 0) {

                return { success: true };
            } else {

                return { success: false, error: 'Project not found' };
            }
        } catch (err) {
            console.error('Error updating project last_opened:', err);
            return { success: false, error: err.message };
        }
    }
    
    // Get project by name
    getProjectByName(name) {
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM projects
                WHERE name = ? COLLATE NOCASE
            `);

            return stmt.get(name);
        } catch (err) {
            return null;
        }
    }
    
    // Get project by path
    getProjectByPath(path) {
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM projects
                WHERE path = ?
            `);
            
            return stmt.get(path);
        } catch (err) {
            return null;
        }
    }
    
    // Update project path
    updateProjectPath(name, newPath) {
        try {
            // Check if another project already uses this path
            const existingProject = this.getProjectByPath(newPath);
            if (existingProject && existingProject.name !== name) {
                return { 
                    success: false, 
                    error: `Path already used by project "${existingProject.name}"` 
                };
            }
            
            const stmt = this.db.prepare(`
                UPDATE projects
                SET path = ?, updated_at = CURRENT_TIMESTAMP
                WHERE name = ?
            `);
            
            const result = stmt.run(newPath, name);
            if (result.changes > 0) {
                return { success: true };
            } else {
                return { success: false, error: 'Project not found' };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
    
    // Get tasks by project
    getTasksByProject(projectName, limit = null, offset = 0) {
        try {
            const pagination = Number.isSafeInteger(limit) && limit > 0 ? ' LIMIT ? OFFSET ?' : '';
            const stmt = this.db.prepare(`
                SELECT * FROM tasks
                WHERE project = ?
                ORDER BY sort_order ASC, created_at DESC${pagination}
            `);

            return pagination ? stmt.all(projectName, limit, offset) : stmt.all(projectName);
        } catch (err) {
            return [];
        }
    }

    getDataVersion() {
        return this.db.pragma('data_version', { simple: true });
    }
    
    // Deprecated - project folders are now stored in projects.path
    // addProjectFolder and getProjectFolders removed
    
    // Drop project_folders table migration
    dropProjectFoldersTable() {
        try {
            // Check if table exists
            const tableExists = this.db.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='project_folders'
            `).get();
            
            if (tableExists) {

                this.db.exec('DROP TABLE project_folders');

            }
        } catch (err) {
            console.error('Error dropping project_folders table:', err);
        }
    }
    
    // Update project display name
    updateProjectDisplayName(name, displayName) {
        try {
            const stmt = this.db.prepare(`
                UPDATE projects 
                SET display_name = ?
                WHERE name = ?
            `);
            
            const result = stmt.run(displayName, name);
            if (result.changes > 0) {
                return { success: true };
            } else {
                return { success: false, error: 'Project not found' };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
    
    // Update project color
    updateProjectColor(name, color) {
        try {
            const stmt = this.db.prepare(`
                UPDATE projects 
                SET color = ?
                WHERE name = ?
            `);
            
            const result = stmt.run(color, name);
            if (result.changes > 0) {
                return { success: true };
            } else {
                return { success: false, error: 'Project not found' };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
    
    // Update project icon
    updateProjectIcon(name, icon) {
        try {
            const stmt = this.db.prepare(`
                UPDATE projects
                SET icon = ?, updated_at = CURRENT_TIMESTAMP
                WHERE name = ?
            `);

            const result = stmt.run(icon || null, name);
            if (result.changes > 0) {
                return { success: true };
            } else {
                return { success: false, error: 'Project not found' };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Get project icon value by name
    getProjectIcon(name) {
        try {
            const stmt = this.db.prepare(`SELECT icon FROM projects WHERE name = ?`);
            const row = stmt.get(name);
            return row ? row.icon : null;
        } catch (err) {
            return null;
        }
    }

    // Delete project
    deleteProject(name) {
        try {
            // Don't allow deleting the default project
            // No default project protection needed anymore
            
            const deleteProject = this.db.prepare(`DELETE FROM projects WHERE name = ?`);
            const result = deleteProject.run(name);
            
            if (result.changes === 0) {
                return { success: false, error: 'Project not found' };
            }
            
            return { success: true };
        } catch (err) {
            console.error('Error in deleteProject:', err);
            return { success: false, error: err.message };
        }
    }

    // ========== NAVBAR SHORTCUTS METHODS ==========

    // Get all shortcuts
    //
    // No LIMIT here on purpose. This used to cap at 6 (a leftover from the old responsive
    // navbar), which made the read silently narrower than the write: saveShortcuts() does
    // DELETE-then-INSERT of whatever it is handed, so a user with more rows than the LIMIT
    // got them back short, and the next save wrote that short list back — destroying the
    // rows the read had hidden. How many shortcuts are ALLOWED is a UI decision, enforced
    // by the navbar against shortcutsConfig.maxTerminalShortcuts; the store just returns
    // what is stored.
    getAllShortcuts() {
        try {
            const shortcuts = this.db.prepare(`
                SELECT * FROM navbar_shortcuts
                ORDER BY sort_order ASC, id ASC
            `).all();

            // Convert boolean values from 0/1 to true/false
            return shortcuts.map(s => ({
                ...s,
                resume_mode: Boolean(s.resume_mode),
                danger_mode: Boolean(s.danger_mode),
                sandbox_mode: Boolean(s.sandbox_mode),
                // 3-state: keep NULL ("never decided") distinct from false ("decided no")
                // so the renderer can fire the one-time worktree prompt only when undecided
                use_worktree: (s.use_worktree === null || s.use_worktree === undefined) ? null : Boolean(s.use_worktree),
                view_mode: s.view_mode === 'chat' ? 'chat' : 'terminal',
                agent_type: s.agent_type || 'claude'  // Default to claude if null
            }));
        } catch (err) {
            console.error('Error getting shortcuts:', err);
            return [];
        }
    }

    // Save shortcuts (replace all)
    saveShortcuts(shortcuts) {
        try {
            // Filter out invalid shortcuts before saving
            const validShortcuts = shortcuts.filter(s => {
                // Check for required fields using both possible naming conventions
                // Note: name is optional (icon-only shortcuts use projectName as fallback)
                const hasRequiredFields = s &&
                    (s.project_path || s.projectPath) &&
                    (s.project_name || s.projectName);

                if (!hasRequiredFields) {
                    console.warn('Skipping invalid shortcut:', s);
                    return false;
                }
                return true;
            });

            // Start transaction
            this.db.transaction(() => {
                // Clear existing shortcuts
                this.db.prepare('DELETE FROM navbar_shortcuts').run();

                // Insert new shortcuts
                const stmt = this.db.prepare(`
                    INSERT INTO navbar_shortcuts
                    (name, project_path, project_name, project_color, resume_mode, danger_mode, sandbox_mode, use_worktree, view_mode, agent_type, session_id, project_dir, session_label, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                validShortcuts.forEach((shortcut, index) => {
                    // Handle both naming conventions (snake_case from DB, camelCase from frontend)
                    // use_worktree is 3-state: preserve NULL ("never decided") so the
                    // one-time worktree prompt still fires for undecided shortcuts.
                    const rawWorktree = shortcut.use_worktree !== undefined ? shortcut.use_worktree : shortcut.useWorktree;
                    const worktreeValue = (rawWorktree === undefined || rawWorktree === null) ? null : (rawWorktree ? 1 : 0);
                    stmt.run(
                        shortcut.name,
                        shortcut.project_path || shortcut.projectPath,
                        shortcut.project_name || shortcut.projectName,
                        shortcut.project_color || shortcut.projectColor || '#007ACC',
                        (shortcut.resume_mode !== undefined ? shortcut.resume_mode : shortcut.resumeMode) ? 1 : 0,
                        (shortcut.danger_mode !== undefined ? shortcut.danger_mode : shortcut.turboMode) ? 1 : 0,
                        (shortcut.sandbox_mode !== undefined ? shortcut.sandbox_mode : shortcut.sandboxMode) ? 1 : 0,
                        worktreeValue,                                           // null = undecided, 0/1 = decided
                        (shortcut.view_mode || shortcut.viewMode) === 'chat' ? 'chat' : 'terminal',
                        shortcut.agent_type || shortcut.agentType || 'claude',  // Default to claude
                        shortcut.session_id || shortcut.sessionId || null,       // Conversation to resume (null = plain shortcut)
                        shortcut.project_dir || shortcut.projectDir || null,
                        shortcut.session_label || shortcut.sessionLabel || null, // Conversation title for the tooltip
                        index
                    );
                });
            })();

            return { success: true };
        } catch (err) {
            console.error('Error saving shortcuts:', err);
            return { success: false, error: err.message };
        }
    }

    // Add a single shortcut
    addShortcut(shortcut) {
        try {
            // Validate required fields
            const hasRequiredFields = shortcut && shortcut.name &&
                (shortcut.project_path || shortcut.projectPath) &&
                (shortcut.project_name || shortcut.projectName);

            if (!hasRequiredFields) {
                return { success: false, error: 'Missing required fields' };
            }

            const count = this.db.prepare('SELECT COUNT(*) as count FROM navbar_shortcuts').get().count;
            if (count >= 6) {
                return { success: false, error: 'Maximum 6 shortcuts allowed' };
            }

            const stmt = this.db.prepare(`
                INSERT INTO navbar_shortcuts
                (name, project_path, project_name, project_color, resume_mode, danger_mode, sandbox_mode, view_mode, agent_type, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            // Handle both naming conventions
            const result = stmt.run(
                shortcut.name,
                shortcut.project_path || shortcut.projectPath,
                shortcut.project_name || shortcut.projectName,
                shortcut.project_color || shortcut.projectColor || '#007ACC',
                (shortcut.resume_mode !== undefined ? shortcut.resume_mode : shortcut.resumeMode) ? 1 : 0,
                (shortcut.danger_mode !== undefined ? shortcut.danger_mode : shortcut.turboMode) ? 1 : 0,
                (shortcut.sandbox_mode !== undefined ? shortcut.sandbox_mode : shortcut.sandboxMode) ? 1 : 0,
                (shortcut.view_mode || shortcut.viewMode) === 'chat' ? 'chat' : 'terminal',
                shortcut.agent_type || shortcut.agentType || 'claude',  // Default to claude
                count // Use count as sort order
            );

            return { success: true, id: result.lastInsertRowid };
        } catch (err) {
            console.error('Error adding shortcut:', err);
            return { success: false, error: err.message };
        }
    }

    // Update a shortcut
    updateShortcut(id, shortcut) {
        try {
            const stmt = this.db.prepare(`
                UPDATE navbar_shortcuts
                SET name = ?,
                    project_path = ?,
                    project_name = ?,
                    project_color = ?,
                    resume_mode = ?,
                    danger_mode = ?,
                    sandbox_mode = ?,
                    view_mode = ?,
                    agent_type = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);

            stmt.run(
                shortcut.name,
                shortcut.projectPath,
                shortcut.projectName,
                shortcut.projectColor || '#007ACC',
                shortcut.resumeMode ? 1 : 0,
                shortcut.turboMode ? 1 : 0,
                shortcut.sandboxMode ? 1 : 0,
                shortcut.viewMode === 'chat' ? 'chat' : 'terminal',
                shortcut.agentType || 'claude',  // Default to claude
                id
            );

            return { success: true };
        } catch (err) {
            console.error('Error updating shortcut:', err);
            return { success: false, error: err.message };
        }
    }

    // Delete a shortcut
    deleteShortcut(id) {
        try {
            this.db.prepare('DELETE FROM navbar_shortcuts WHERE id = ?').run(id);

            // Reorder remaining shortcuts
            const remaining = this.db.prepare('SELECT id FROM navbar_shortcuts ORDER BY sort_order, id').all();
            const updateStmt = this.db.prepare('UPDATE navbar_shortcuts SET sort_order = ? WHERE id = ?');

            remaining.forEach((shortcut, index) => {
                updateStmt.run(index, shortcut.id);
            });

            return { success: true };
        } catch (err) {
            console.error('Error deleting shortcut:', err);
            return { success: false, error: err.message };
        }
    }

    // Migrate shortcuts from localStorage (one-time migration)
    migrateShortcutsFromLocalStorage(shortcuts) {
        try {
            // Only migrate if database is empty
            const count = this.db.prepare('SELECT COUNT(*) as count FROM navbar_shortcuts').get().count;
            if (count > 0) {
                return { success: true, message: 'Shortcuts already exist in database' };
            }

            // Save the shortcuts
            return this.saveShortcuts(shortcuts);
        } catch (err) {
            console.error('Error migrating shortcuts:', err);
            return { success: false, error: err.message };
        }
    }

    // ===================================
    // Demos / Tours Management
    // ===================================

    /**
     * Check if a demo/tour has been completed
     * @param {string} demoName - Name of the demo (e.g., 'onboarding-basic-workflow')
     * @returns {boolean}
     */
    isDemoCompleted(demoName) {
        try {
            const stmt = this.db.prepare('SELECT id FROM demos_completed WHERE demo_name = ?');
            const result = stmt.get(demoName);
            return !!result;
        } catch (err) {
            console.error('Error checking demo completion:', err);
            return false;
        }
    }

    /**
     * Mark a demo/tour as completed
     * @param {string} demoName - Name of the demo
     * @returns {object} Result object with success status
     */
    markDemoCompleted(demoName) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO demos_completed (demo_name, completed_at)
                VALUES (?, CURRENT_TIMESTAMP)
            `);
            stmt.run(demoName);
            return { success: true };
        } catch (err) {
            console.error('Error marking demo as completed:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Get list of all completed demos
     * @returns {Array} Array of completed demo names
     */
    getCompletedDemos() {
        try {
            const stmt = this.db.prepare('SELECT demo_name, completed_at FROM demos_completed ORDER BY completed_at DESC');
            return stmt.all();
        } catch (err) {
            console.error('Error getting completed demos:', err);
            return [];
        }
    }

    /**
     * Reset a demo (mark as not completed) - useful for testing
     * @param {string} demoName - Name of the demo
     * @returns {object} Result object with success status
     */
    resetDemo(demoName) {
        try {
            const stmt = this.db.prepare('DELETE FROM demos_completed WHERE demo_name = ?');
            stmt.run(demoName);
            return { success: true };
        } catch (err) {
            console.error('Error resetting demo:', err);
            return { success: false, error: err.message };
        }
    }

    // ─── Conversation Bookmarks ──────────────────────────────────

    addBookmark(sessionId, projectPath, projectDir, projectName, agentType, displayText) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO conversation_bookmarks
                    (session_id, project_path, project_dir, project_name, agent_type, display_text)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run(sessionId, projectPath, projectDir || null, projectName || null, agentType || 'claude', displayText || null);
            return { success: true };
        } catch (err) {
            console.error('Error adding bookmark:', err);
            return { success: false, error: err.message };
        }
    }

    removeBookmark(sessionId) {
        try {
            const stmt = this.db.prepare('DELETE FROM conversation_bookmarks WHERE session_id = ?');
            stmt.run(sessionId);
            return { success: true };
        } catch (err) {
            console.error('Error removing bookmark:', err);
            return { success: false, error: err.message };
        }
    }

    isBookmarked(sessionId) {
        try {
            const row = this.db.prepare('SELECT id FROM conversation_bookmarks WHERE session_id = ?').get(sessionId);
            return !!row;
        } catch (err) {
            console.error('Error checking bookmark:', err);
            return false;
        }
    }

    getAllBookmarks() {
        try {
            const stmt = this.db.prepare('SELECT * FROM conversation_bookmarks ORDER BY created_at DESC');
            return stmt.all();
        } catch (err) {
            console.error('Error getting bookmarks:', err);
            return [];
        }
    }

    updateBookmarkName(sessionId, projectPath, customName) {
        try {
            const stmt = this.db.prepare(`
                UPDATE conversation_bookmarks
                SET custom_name = ?, updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
            `);
            stmt.run(customName || null, sessionId);
            return { success: true };
        } catch (err) {
            console.error('Error updating bookmark name:', err);
            return { success: false, error: err.message };
        }
    }

    searchBookmarks(query) {
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM conversation_bookmarks
                WHERE custom_name LIKE ? OR display_text LIKE ? OR project_name LIKE ?
                ORDER BY created_at DESC
            `);
            const pattern = `%${query}%`;
            return stmt.all(pattern, pattern, pattern);
        } catch (err) {
            console.error('Error searching bookmarks:', err);
            return [];
        }
    }

    getBookmarkedSessionIds() {
        try {
            const rows = this.db.prepare('SELECT session_id FROM conversation_bookmarks').all();
            return rows.map(r => r.session_id);
        } catch (err) {
            console.error('Error getting bookmarked session IDs:', err);
            return [];
        }
    }

    // ===== Git worktrees (per-conversation) =====
    // Maps a conversation (session_id) to the git worktree created for it, so a
    // resumed conversation can reuse the same worktree.

    saveWorktree(sessionId, { repoRoot, worktreePath, branch, baseBranch, groupId } = {}) {
        try {
            // Upsert: on an existing session_id keep the original created_at and
            // only refresh last_used (a plain INSERT OR REPLACE would reset
            // created_at since it deletes + re-inserts the row).
            // base_branch / group_id use COALESCE so a later upsert WITHOUT them
            // (e.g. the reuse path) preserves the originally-stored values.
            // group_id is null for a normal single worktree (unchanged behavior)
            // and shared across the rows of a composite/group worktree.
            const stmt = this.db.prepare(`
                INSERT INTO worktrees (session_id, repo_root, worktree_path, branch, base_branch, group_id, last_used)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id) DO UPDATE SET
                    repo_root = excluded.repo_root,
                    worktree_path = excluded.worktree_path,
                    branch = excluded.branch,
                    base_branch = COALESCE(excluded.base_branch, worktrees.base_branch),
                    group_id = COALESCE(excluded.group_id, worktrees.group_id),
                    last_used = CURRENT_TIMESTAMP
            `);
            stmt.run(sessionId, repoRoot, worktreePath, branch, baseBranch || null, groupId || null);
            return { success: true };
        } catch (err) {
            console.error('Error saving worktree:', err);
            return { success: false, error: err.message };
        }
    }

    getWorktreeBySession(sessionId) {
        try {
            const stmt = this.db.prepare('SELECT * FROM worktrees WHERE session_id = ?');
            const row = stmt.get(sessionId);
            return row || null;
        } catch (err) {
            console.error('Error getting worktree by session:', err);
            return null;
        }
    }

    listWorktrees() {
        try {
            const stmt = this.db.prepare('SELECT * FROM worktrees ORDER BY last_used DESC');
            return stmt.all();
        } catch (err) {
            console.error('Error listing worktrees:', err);
            return [];
        }
    }

    deleteWorktree(sessionId) {
        try {
            const stmt = this.db.prepare('DELETE FROM worktrees WHERE session_id = ?');
            stmt.run(sessionId);
            return { success: true };
        } catch (err) {
            console.error('Error deleting worktree:', err);
            return { success: false, error: err.message };
        }
    }

    touchWorktree(sessionId) {
        try {
            const stmt = this.db.prepare('UPDATE worktrees SET last_used = CURRENT_TIMESTAMP WHERE session_id = ?');
            stmt.run(sessionId);
            return { success: true };
        } catch (err) {
            console.error('Error touching worktree:', err);
            return { success: false, error: err.message };
        }
    }

    // ===== Composite / group worktrees =====
    // A group = several worktree rows sharing the same group_id: one ROOT
    // (container) row keyed by the conversation's session_id + N synthetic
    // sub-repo child rows. group_id is NULL for a normal single worktree.

    /**
     * Returns every row of a group, ROOT first. Convention: the root is the row
     * whose worktree_path is the ancestor of every other member (the group dir),
     * i.e. the shortest path; we order by path length then created_at so callers
     * can rely on rows[0] being the container/root.
     */
    getWorktreeGroup(groupId) {
        try {
            const stmt = this.db.prepare(
                'SELECT * FROM worktrees WHERE group_id = ? ORDER BY LENGTH(worktree_path) ASC, created_at ASC'
            );
            return stmt.all(groupId);
        } catch (err) {
            console.error('Error getting worktree group:', err);
            return [];
        }
    }

    /**
     * Returns every row that belongs to a group (group_id IS NOT NULL). The
     * caller groups them by group_id. Single worktrees (NULL group_id) are
     * excluded. Ordered group_id then root-first within each group.
     */
    listWorktreeGroups() {
        try {
            const stmt = this.db.prepare(
                'SELECT * FROM worktrees WHERE group_id IS NOT NULL ORDER BY group_id ASC, LENGTH(worktree_path) ASC, created_at ASC'
            );
            return stmt.all();
        } catch (err) {
            console.error('Error listing worktree groups:', err);
            return [];
        }
    }

    // ===== Cleanup: cached size + the user's "keep" pin =====

    /**
     * Cache a measured size against a worktree PATH (not a session): a composite
     * worktree is measured once at its container folder, which physically holds
     * every sub-repo, so the size belongs to the path we walked.
     *
     * `bytes` may be null for a directory we failed to measure; the row then
     * reads as unmeasured rather than as a misleading 0.
     */
    setWorktreeSize(worktreePath, bytes) {
        try {
            const size = (typeof bytes === 'number' && isFinite(bytes) && bytes >= 0)
                ? Math.round(bytes)
                : null;
            const stmt = this.db.prepare(
                'UPDATE worktrees SET size_bytes = ?, size_measured_at = ? WHERE worktree_path = ?'
            );
            stmt.run(size, Date.now(), worktreePath);
            return { success: true };
        } catch (err) {
            console.error('Error saving worktree size:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Cache the git state a scan observed for one worktree path: whether the
     * folder still exists, whether it has uncommitted work, and whether its
     * branch is already contained in its base branch.
     *
     * Probing this live for 300+ worktrees costs seconds (one `git status` per
     * worktree), which is why the panel reads it from here and only re-scans on
     * demand. The cache decides what the panel PROPOSES; the delete path always
     * re-verifies against live git before removing anything, so a stale row can
     * never cause data loss.
     */
    setWorktreeScanState(worktreePath, state) {
        try {
            const json = state ? JSON.stringify(state) : null;
            this.db.prepare('UPDATE worktrees SET scan_state = ? WHERE worktree_path = ?')
                .run(json, worktreePath);
            return { success: true };
        } catch (err) {
            console.error('Error saving worktree scan state:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Pin / unpin a worktree so bulk cleanup never touches it.
     *
     * A group is pinned as a UNIT (it is deleted as a unit), so the flag is
     * written to every row sharing the group_id; a single worktree is keyed by
     * its session_id.
     */
    setWorktreeKeep({ sessionId, groupId, keep } = {}) {
        try {
            const value = keep ? 1 : 0;
            if (groupId) {
                this.db.prepare('UPDATE worktrees SET keep_flag = ? WHERE group_id = ?').run(value, groupId);
            } else if (sessionId) {
                this.db.prepare('UPDATE worktrees SET keep_flag = ? WHERE session_id = ?').run(value, sessionId);
            } else {
                return { success: false, error: 'No worktree identified' };
            }
            return { success: true };
        } catch (err) {
            console.error('Error updating worktree keep flag:', err);
            return { success: false, error: err.message };
        }
    }

    /** Deletes every row of a group (container + all sub-repo members). */
    deleteWorktreeGroup(groupId) {
        try {
            const stmt = this.db.prepare('DELETE FROM worktrees WHERE group_id = ?');
            stmt.run(groupId);
            return { success: true };
        } catch (err) {
            console.error('Error deleting worktree group:', err);
            return { success: false, error: err.message };
        }
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = DatabaseManager;
