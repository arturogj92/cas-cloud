#!/usr/bin/env node

/**
 * CodeAgentSwarm Task Management MCP Server (stdio version)
 * Compatible with Claude Code's new MCP system
 */

// ── stdout purity guard (MCP stdio transport) ───────────────────────────────
// stdout is the JSON-RPC channel and MUST contain ONLY protocol frames. Any
// stray console.log — from this server OR any required module (e.g.
// platform-config logging "[Platform] Checking ... Claude paths" at load time) —
// corrupts the stream and breaks strict clients: Antigravity's Go client fails
// with `invalid character 'P' looking for beginning of value` on that line.
// Capture the real stdout writer for protocol frames, then route every
// console.log/info/debug to stderr so nothing else can ever reach stdout.
// (console.error already goes to stderr and is left untouched.)
const { inspect } = require('util');
const writeProtocol = process.stdout.write.bind(process.stdout);
const _toStderr = (...args) =>
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ') + '\n');
console.log = _toStderr;
console.info = _toStderr;
console.debug = _toStderr;

const readline = require('readline');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { writeSandboxProjectRequest } = require('../terminal/sandbox-project-request-store');

// Platform-specific configuration
const platformConfig = require('../platform/platform-config');
  
// Initialize child process logger
const ChildProcessLogger = require('../../shared/logger/child-process-logger');
const childLogger = new ChildProcessLogger('MCP-Server');

// Import our MCP-compatible database manager
// Always use standalone version to avoid native module compatibility issues
let DatabaseManagerMCP;

DatabaseManagerMCP = require('../database/database-mcp-standalone');

// PID lock file path
const PID_FILE = path.join(os.homedir(), '.codeagentswarm', 'mcp-server.pid');

// Example titles that have appeared in tool docs / agent instructions over time.
// Lazy agents copy them verbatim instead of describing their real work — that is
// how terminals ended up titled "Fix Auth Bug" out of nowhere — so the title
// tools reject them with an instructive error and the agent retries with a real
// title. Keep entries lowercase with single spaces (isPlaceholderTitle normalizes).
const PLACEHOLDER_TITLES = new Set([
    'fix auth bug',
]);

function isPlaceholderTitle(title) {
    const normalized = String(title).trim().replace(/\s+/g, ' ').toLowerCase();
    return PLACEHOLDER_TITLES.has(normalized);
}

// Hardcoded copy of the default terminal statuses AGENTS MAY SET, used ONLY as a
// fail-safe when the DB read fails (e.g. the terminal_statuses table is missing).
// The live catalog comes from db.getTerminalStatuses(); this fallback keeps the
// set_terminal_status tool announced/usable so the MCP server never crashes on a
// missing table. App-owned statuses (agent_settable: 0, e.g. 'idle') are absent on
// purpose: they must never be offered to an agent, fallback or not.
// KEEP IN SYNC with database.js / database-mcp-standalone.js.
const DEFAULT_TERMINAL_STATUSES = [
    { status_key: 'needs_input', label: 'Needs input', prompt: 'Set it when you stop because you need an answer or a decision from the user to continue (a question, a design choice, a permission).' },
    { status_key: 'needs_testing', label: 'Needs testing', prompt: 'Set it when you finish the implementation and the work is pending the user testing it manually. Do not set it if there are still things left to implement.' },
    { status_key: 'working', label: 'Working', prompt: 'Set it when you start working on any request and while you are implementing, investigating or fixing something.' },
    { status_key: 'done', label: 'Done', prompt: 'Set it when the work is completely finished: implemented, validated and with its commit/push done when applicable. It is the final state.' }
];

// Header sentence that precedes the per-status lines in the set_terminal_status
// tool description. The per-status prompts remain live DB-owned user content.
const TERMINAL_STATUS_DESCRIPTION_HEADER =
    'Update the agent STATUS: the work phase the current work is in. Keep it up to date as you progress and before EVERY final response, including short read-only follow-ups. The catalog below is live and user-customizable: choose the most specific enabled status whose prompt matches the real outcome. needs_input is ONLY for a user answer or decision required before you can continue; never use it as a generic end-of-turn status. If pushed is available and the code was committed and pushed, use pushed. Available statuses:';

// Per-agent gating model (task #settings-redesign)
// -------------------------------------------------
// The MCP server identifies its CALLER by the CODEAGENTSWARM_AGENT_TYPE env var
// ('claude'|'codex'|'antigravity'|'opencode'), forwarded per-agent by each MCP
// config. Two independent, per-agent gates are read FRESH on every call (never
// cached), fail-safe to ENABLED on any error / absent value:
//   1. Task/kanban tools (TASK_MANAGEMENT_TOOL_NAMES) — hidden + blocked when the
//      caller's kanban is off (per-agent key `task_management_enabled_<agent>`,
//      falling back to the global `task_management_enabled`).
//   2. Terminal-title tools (TITLE_TOOL_NAMES) — hidden + blocked when the
//      caller's dynamic titles are off (per-agent key
//      `terminal_titles_enabled_<agent>`, default true).
//   3. Terminal work-phase status tool (STATUS_TOOL_NAMES) — hidden + blocked when
//      the caller's status feature is off (per-agent key
//      `terminal_status_enabled_<agent>`, default true).
// The base per-agent MCP toggle (`task_mcp_enabled_<agent>`) short-circuits ALL
// THREE: when it is off, tasks, titles AND status are effectively off for that caller.
// When CODEAGENTSWARM_AGENT_TYPE is absent → LEGACY behavior: task tools gated by
// the global key only, title and status tools never gated. `check_active` is never gated.

// Task/kanban tools that are gated behind the "Automatic task management" setting
// (app_settings key `task_management_enabled`, or the per-agent
// `task_management_enabled_<agent>` when a caller agent is known). When the
// setting is OFF these are neither announced by tools/list nor executed by
// tools/call. Implemented as a DENY set (not an allow-list) so terminal tools —
// and any future tool — stay available by default; only tools explicitly listed
// here are hidden.
const TASK_MANAGEMENT_TOOL_NAMES = new Set([
    'create_task',
    'start_task',
    'complete_task',
    'submit_for_testing',
    'list_tasks',
    'search_tasks',
    'find_related_active_tasks',
    'update_task_plan',
    'update_task_implementation',
    'update_task_terminal',
    'update_task_labels',
    'update_task_project',
    'create_project',
    'get_projects',
    'get_project_tasks',
    'create_subtask',
    'get_subtasks',
    'get_task_hierarchy',
    'link_task_to_parent',
    'unlink_task_from_parent',
    'suggest_parent_tasks',
]);

// Returned as a normal tool result (not a JSON-RPC error) when a gated tool is
// called while task management is disabled, so the agent keeps working instead
// of treating it as a protocol failure.
const TASK_MANAGEMENT_DISABLED_MESSAGE =
    'Task management is disabled in CodeAgentSwarm Settings. Do not create, start, or complete tasks — continue the work without task tracking. Agent titles and activity updates still work normally.';

// Task-CREATION tools, gated behind the per-agent "Let the agent create tasks"
// sub-toggle (`task_creation_enabled_<agent>`, default true). This is a STRICTER
// gate layered on top of the kanban one: with kanban on and creation off the
// agent keeps every read/move/update tool (list, search, start, submit, complete,
// update_task_*) and loses only the ability to put NEW items on the board.
// create_task covers subtasks too via its parent_task_id argument, so both entry
// points must be listed.
const TASK_CREATION_TOOL_NAMES = new Set([
    'create_task',
    'create_subtask',
]);

// Returned as a normal tool result (not a JSON-RPC error) when a creation tool is
// called while task creation is disabled, so the agent falls back to an existing
// task instead of treating it as a protocol failure.
const TASK_CREATION_DISABLED_MESSAGE =
    'Task creation is disabled in CodeAgentSwarm Settings for this agent. Do NOT create tasks or subtasks. Use list_tasks or search_tasks to find an existing task on the board and start_task on it; if nothing fits, continue without task tracking and keep this setting invisible unless the user asks about it. Moving, updating and completing existing tasks still works normally.';

// Terminal-title tools gated behind the per-agent "Dynamic terminal titles"
// setting (`terminal_titles_enabled_<agent>`). Same DENY-set shape as the task
// tools. Includes the deprecated update_terminal_title alias so it is gated too.
const TITLE_TOOL_NAMES = new Set([
    'set_terminal_title',
    'update_terminal_activity',
    'update_terminal_title',
]);

// Returned as a normal tool result (not a JSON-RPC error) when a title tool is
// called while dynamic titles are disabled for the caller, so the agent keeps
// working instead of treating it as a protocol failure.
const TITLES_DISABLED_MESSAGE =
    'Dynamic agent titles are disabled in CodeAgentSwarm Settings for this agent. Do not set agent titles or activity — continue the work normally.';

// Work-phase status tool gated behind the per-agent "Terminal work-phase status"
// setting (`terminal_status_enabled_<agent>`). Same DENY-set shape as the title tools.
const STATUS_TOOL_NAMES = new Set([
    'set_terminal_status',
]);

// Returned as a normal tool result (not a JSON-RPC error) when the status tool is
// called while the feature is disabled for the caller, so the agent keeps working.
const STATUS_DISABLED_MESSAGE =
    'The agent work-phase status is disabled in CodeAgentSwarm Settings for this agent. Do not set the agent status — continue the work normally.';

const SESSION_COMMUNICATION_TOOL_NAMES = new Set([
    'list_sessions',
    'send_session_message',
]);

const SESSION_COMMUNICATION_DISABLED_MESSAGE =
    'Session communication is unavailable in this CodeAgentSwarm session. Continue without querying or messaging other sessions.';

class MCPStdioServer {
    constructor() {
        this.db = null;
        this.requestId = 0;
        this.startTime = Date.now();
        this.requestCount = 0;
        this.lastError = null;
        this.pidFile = PID_FILE;
        
        // Allow multiple instances - DO NOT USE LOCK
        // Each terminal needs its own server instance
        this.logError(`🆔 Starting server PID ${process.pid} - Multiple instances allowed`);

        // Log where debug logs are being written for beta testers
        const logLocation = platformConfig.getMcpLogPath();
        this.logError(`📝 Debug logs are being written to: ${logLocation}`);
        this.logError(`📊 Errors will be collected in: ${path.join(logLocation, 'mcp-errors.json')}`);

        this.logError('🚀 Starting MCP STDIO Server at', new Date().toISOString());
        
        // Setup error handlers BEFORE anything else
        process.on('uncaughtException', (error) => {
            this.logError('❌ Uncaught Exception:', error.message);
            this.logError('Stack:', error.stack);
            this.lastError = error;
            // Try to stay alive
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            this.logError('❌ Unhandled Rejection at:', promise);
            this.logError('Reason:', reason);
            this.lastError = reason;
        });
        
        // Setup readline interface for JSON-RPC communication
        // IMPORTANT: Do NOT set output to stdout - it can cause readline to write
        // unexpected characters that confuse MCP clients (especially Codex CLI)
        this.rl = readline.createInterface({
            input: process.stdin,
            terminal: false
        });
        
        this.rl.on('line', async (line) => {
            await this.handleMessage(line);
        });
        
        this.rl.on('error', (error) => {
            this.logError('❌ Readline error:', error.message);
            this.lastError = error;
        });
        
        this.rl.on('close', () => {
            this.logError('⚠️ Readline interface closed');
            this.shutdown();
        });
        
        // Initialize database
        this.initDatabase();
        
        // Handle process termination
        process.on('SIGINT', () => {
            this.logError('⚠️ Received SIGINT signal');
            this.shutdown();
        });
        
        process.on('SIGTERM', () => {
            this.logError('⚠️ Received SIGTERM signal');
            this.shutdown();
        });
        
        // Log status periodically
        this.statusInterval = setInterval(() => {
            const uptime = Math.floor((Date.now() - this.startTime) / 1000);
            this.logError(`📊 MCP Server Status: Uptime ${uptime}s, Requests: ${this.requestCount}, Last error: ${this.lastError ? this.lastError.message : 'none'}`);
        }, 60000); // Every minute
    }

    initDatabase() {
        try {
            // Force MCP to use the same database path as Electron app
            const electronDbPath = platformConfig.getDatabasePath();
            process.env.CODEAGENTSWARM_DB_PATH = electronDbPath;

            this.db = new DatabaseManagerMCP();
            this.logError('Database initialized successfully using Electron database:', electronDbPath);
        } catch (error) {
            this.logError('Failed to initialize database:', error.message);
            process.exit(1);
        }
    }

    acquireLock() {
        try {
            // Ensure the directory exists
            const lockDir = path.dirname(this.pidFile);
            if (!fs.existsSync(lockDir)) {
                fs.mkdirSync(lockDir, { recursive: true });
            }

            // Check if PID file exists
            if (fs.existsSync(this.pidFile)) {
                const existingPid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                
                // Check if process is still running
                if (this.isProcessRunning(existingPid)) {
                    this.logError(`Process ${existingPid} is already running`);
                    return false;
                } else {
                    this.logError(`Removing stale PID file for process ${existingPid}`);
                    fs.unlinkSync(this.pidFile);
                }
            }

            // Write our PID to the file
            fs.writeFileSync(this.pidFile, process.pid.toString());
            this.logError(`Lock acquired with PID ${process.pid}`);
            return true;
        } catch (error) {
            this.logError('Failed to acquire lock:', error.message);
            return false;
        }
    }

    isProcessRunning(pid) {
        try {
            // Send signal 0 to check if process exists
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return false;
        }
    }

    releaseLock() {
        try {
            if (fs.existsSync(this.pidFile)) {
                const storedPid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
                if (storedPid === process.pid) {
                    fs.unlinkSync(this.pidFile);
                    this.logError(`Lock released for PID ${process.pid}`);
                }
            }
        } catch (error) {
            this.logError('Failed to release lock:', error.message);
        }
    }

    logActivity(activity) {
        // Log ALL MCP activity to a separate file for complete tracking
        try {
            const fs = require('fs');
            const path = require('path');
            // Use same directory structure as error logs
            const logDir = platformConfig.getMcpLogPath();

            // Create directory if it doesn't exist
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            // Activity log file (JSON lines format for easy parsing)
            const dateStr = new Date().toISOString().split('T')[0];
            const activityFile = path.join(logDir, `mcp-activity-${dateStr}.jsonl`);

            // Append activity as a single JSON line
            fs.appendFileSync(activityFile, JSON.stringify(activity) + '\n', 'utf8');

            // Also maintain a summary file with statistics
            this.updateActivityStats(logDir, activity);

        } catch (e) {
            // Silent fail - don't break the server
            console.error('[MCP Activity Logger Error]', e.message);
        }
    }

    updateActivityStats(logDir, activity) {
        try {
            const fs = require('fs');
            const path = require('path');
            const statsFile = path.join(logDir, 'mcp-stats.json');

            let stats = {
                totalRequests: 0,
                successfulRequests: 0,
                failedRequests: 0,
                methodCounts: {},
                errorCounts: {},
                avgDuration: {},
                slowestOperations: [],
                lastUpdated: new Date().toISOString()
            };

            // Load existing stats
            if (fs.existsSync(statsFile)) {
                try {
                    stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
                } catch (e) {
                    // Reset stats if corrupted
                }
            }

            // Update stats based on activity type
            if (activity.type === 'response') {
                stats.totalRequests++;

                if (activity.success) {
                    stats.successfulRequests++;
                } else {
                    stats.failedRequests++;
                    const errorKey = `${activity.errorCode}: ${activity.errorMessage}`;
                    stats.errorCounts[errorKey] = (stats.errorCounts[errorKey] || 0) + 1;
                }

                // Track method usage
                if (activity.method) {
                    stats.methodCounts[activity.method] = (stats.methodCounts[activity.method] || 0) + 1;

                    // Track average duration
                    if (activity.duration) {
                        if (!stats.avgDuration[activity.method]) {
                            stats.avgDuration[activity.method] = { total: 0, count: 0, avg: 0 };
                        }
                        stats.avgDuration[activity.method].total += activity.duration;
                        stats.avgDuration[activity.method].count++;
                        stats.avgDuration[activity.method].avg =
                            stats.avgDuration[activity.method].total / stats.avgDuration[activity.method].count;

                        // Track slowest operations
                        if (activity.duration > 500) {
                            stats.slowestOperations.push({
                                method: activity.method,
                                duration: activity.duration,
                                timestamp: activity.timestamp,
                                params: activity.params
                            });

                            // Keep only top 20 slowest
                            stats.slowestOperations.sort((a, b) => b.duration - a.duration);
                            stats.slowestOperations = stats.slowestOperations.slice(0, 20);
                        }
                    }
                }
            }

            stats.lastUpdated = new Date().toISOString();

            // Write updated stats
            fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf8');

        } catch (e) {
            // Silent fail
        }
    }

    summarizeResult(result) {
        // Create a summary of the result for logging without including sensitive data
        if (!result) return 'null';

        if (typeof result === 'object') {
            if (Array.isArray(result)) {
                return `Array[${result.length}]`;
            }

            // Summarize common result types
            if (result.id && result.title) {
                return `{id: ${result.id}, title: "${result.title.substring(0, 30)}..."}`;
            }

            if (result.tasks) {
                return `{tasks: Array[${result.tasks.length}]}`;
            }

            // Generic object summary
            const keys = Object.keys(result);
            return `{keys: [${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}]}`;
        }

        if (typeof result === 'string' && result.length > 100) {
            return result.substring(0, 100) + '...';
        }

        return String(result);
    }

    logError(message, ...args) {
        // Log to stderr so it doesn't interfere with JSON-RPC communication
        console.error('[MCP Server]', message, ...args);

        // ALWAYS write logs to file for debugging and beta testing
        try {
            const fs = require('fs');
            const path = require('path');

            // Use Application Support directory for logs (cross-platform)
            const logDir = platformConfig.getMcpLogPath();

            // Create logs directory if it doesn't exist
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            // Create daily log files
            const dateStr = new Date().toISOString().split('T')[0];
            const logFile = path.join(logDir, `mcp-server-${dateStr}.log`);

            // Format the message with timestamp
            const timestamp = new Date().toISOString();
            const formattedArgs = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg, null, 2);
                    } catch (e) {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ');

            const logEntry = `[${timestamp}] ${message} ${formattedArgs}\n`;

            // Append to log file
            fs.appendFileSync(logFile, logEntry, 'utf8');

            // Log rotation: Keep only last 7 days of logs to prevent disk space issues
            const files = fs.readdirSync(logDir);
            const now = Date.now();
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

            files.forEach(file => {
                if (file.startsWith('mcp-server-') && file.endsWith('.log')) {
                    const filePath = path.join(logDir, file);
                    const stats = fs.statSync(filePath);
                    if (stats.mtime.getTime() < sevenDaysAgo) {
                        fs.unlinkSync(filePath);
                    }
                }
            });

        } catch (e) {
            // Silent fail - don't break the server if logging fails
            // But at least try to log to stderr
            console.error('[MCP Logger Error]', e.message);
        }
    }
    
    generateShortTitle(fullTitle) {
        // Generate a 6-word title from a longer task title
        if (!fullTitle) return '';

        // If already 6 words or less, return as is
        const words = fullTitle.split(' ').filter(w => w.length > 0);
        if (words.length <= 6) {
            return fullTitle;
        }

        // Common words to filter out
        const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'been'];

        // Filter out stop words and keep important words
        const importantWords = words.filter(word => {
            const lowerWord = word.toLowerCase();
            return !stopWords.includes(lowerWord) && lowerWord.length > 2;
        });

        // If we have 6 or more important words, take the first 6
        if (importantWords.length >= 6) {
            return importantWords.slice(0, 6).join(' ');
        }

        // Otherwise, take the first word and up to 5 important words
        const result = [];
        if (words.length > 0) {
            result.push(words[0]); // Always include first word (usually a verb)
        }

        // Add remaining important words
        for (const word of importantWords.slice(0, 5)) {
            if (!result.includes(word)) {
                result.push(word);
            }
        }

        return result.slice(0, 6).join(' ');
    }

    generateLongTitle(fullTitle) {
        // Generate a longer title from a short title
        // This is a FALLBACK - agents should ALWAYS provide long_title themselves
        if (!fullTitle) return '';

        const words = fullTitle.split(' ').filter(w => w.length > 0);

        // For short titles (≤6 words), add a simple prefix to make it different
        // This is intentionally simple - Claude should provide detailed long_title
        if (words.length <= 6) {
            return `Working on: ${fullTitle}`;
        }

        // For longer titles, reduce to 6 words by removing stop words
        const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with'];
        const importantWords = words.filter(word => {
            const lowerWord = word.toLowerCase();
            return !stopWords.includes(lowerWord) || words.indexOf(word) < 6;
        });

        if (importantWords.length >= 5) {
            return importantWords.slice(0, 6).join(' ');
        }

        return words.slice(0, 6).join(' ');
    }

    async handleMessage(line) {
        const startTime = Date.now();
        let activityEntry = {
            timestamp: new Date().toISOString(),
            type: 'request',
            raw: line.length > 1000 ? line.substring(0, 1000) + '...' : line,
            duration: null,
            success: false
        };

        try {
            this.requestCount++;

            // Log incoming message for debugging (truncate if too long)
            const truncatedLine = line.length > 200 ? line.substring(0, 200) + '...' : line;
            this.logError('📥 Received message:', truncatedLine);

            const message = JSON.parse(line);
            activityEntry.method = message.method;
            activityEntry.id = message.id;
            activityEntry.params = message.params;

            // Log ALL activity to a separate file for complete tracking
            this.logActivity(activityEntry);

            const response = await this.processRequest(message);

            if (response) {
                writeProtocol(JSON.stringify(response) + '\n');
                this.logError('📤 Sent response for method:', message.method || 'unknown');

                // Log successful response
                const duration = Date.now() - startTime;
                this.logActivity({
                    timestamp: new Date().toISOString(),
                    type: 'response',
                    id: response.id,
                    method: message.method,
                    success: !response.error,
                    duration: duration,
                    hasError: !!response.error,
                    errorCode: response.error?.code,
                    errorMessage: response.error?.message,
                    resultSummary: this.summarizeResult(response.result)
                });

                // Track slow operations
                if (duration > 1000) {
                    this.logError(`⚠️ SLOW OPERATION: ${message.method} took ${duration}ms`);
                }
            }
        } catch (error) {
            this.logError('❌ Error handling message:', error.message);
            this.logError('Stack:', error.stack);
            this.lastError = error;

            // Log failed request
            activityEntry.success = false;
            activityEntry.error = {
                message: error.message,
                stack: error.stack
            };
            activityEntry.duration = Date.now() - startTime;
            this.logActivity(activityEntry);

            const errorResponse = {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: 'Parse error: ' + error.message
                }
            };
            writeProtocol(JSON.stringify(errorResponse) + '\n');
        }
    }

    async processRequest(message) {
        const { jsonrpc, id, method, params } = message;
        
        try {
            let result = null;
            
            // Handle MCP notifications (messages without 'id' field)
            // Per MCP spec, notifications don't require a response
            if (method && method.startsWith('notifications/')) {
                this.logError(`📢 Received notification: ${method} (no response required)`);
                return null; // Return null to indicate no response should be sent
            }

            switch (method) {
                case 'initialize':
                    result = this.handleInitialize(params);
                    break;
                    
                case 'tasks/create':
                    result = await this.createTask(params);
                    break;
                    
                case 'tasks/update_status':
                    result = await this.updateTaskStatus(params);
                    break;
                    
                case 'tasks/get_all':
                    result = await this.getAllTasks(params);
                    break;
                    
                case 'tasks/get_current':
                    result = await this.getCurrentTask(params);
                    break;
                    
                case 'tasks/delete':
                    result = await this.deleteTask(params);
                    break;
                    
                case 'tasks/update':
                    result = await this.updateTask(params);
                    break;
                    
                case 'tasks/update_order':
                    result = await this.updateTasksOrder(params);
                    break;
                    
                case 'tasks/update_plan':
                    result = await this.updateTaskPlan(params);
                    break;
                    
                case 'tasks/update_implementation':
                    result = await this.updateTaskImplementation(params);
                    break;
                    
                case 'tools/list':
                    result = this.listTools();
                    break;
                    
                case 'tools/call':
                    result = await this.callTool(params);
                    break;
                    
                case 'get_working_directory':
                    result = await this.getWorkingDirectory(params);
                    break;
                    
                case 'resources/list':
                    result = this.listResources();
                    break;
                    
                case 'resources/read':
                    result = await this.readResource(params);
                    break;
                    
                case 'prompts/list':
                    result = this.listPrompts();
                    break;
                    
                case 'prompts/get':
                    result = await this.getPrompt(params);
                    break;
                    
                default:
                    throw new Error(`Unknown method: ${method}`);
            }
            
            return {
                jsonrpc: '2.0',
                id,
                result
            };
            
        } catch (error) {
            // Enhanced error logging for beta testing
            this.logError(`❌ ERROR -32000 OCCURRED`);
            this.logError(`   Method: ${method}`);
            this.logError(`   Params: ${JSON.stringify(params, null, 2)}`);
            this.logError(`   Error Message: ${error.message}`);
            this.logError(`   Stack Trace: ${error.stack}`);

            // Also log to a special error file for easy collection
            try {
                const fs = require('fs');
                const path = require('path');

                const errorLogDir = platformConfig.getMcpLogPath();
                const errorFile = path.join(errorLogDir, 'mcp-errors.json');
                const errorEntry = {
                    timestamp: new Date().toISOString(),
                    method,
                    params,
                    error: {
                        message: error.message,
                        stack: error.stack,
                        code: -32000
                    },
                    systemInfo: {
                        platform: process.platform,
                        nodeVersion: process.version,
                        pid: process.pid
                    }
                };

                // Read existing errors or create new array
                let errors = [];
                if (fs.existsSync(errorFile)) {
                    try {
                        const content = fs.readFileSync(errorFile, 'utf8');
                        errors = JSON.parse(content);
                    } catch (e) {
                        errors = [];
                    }
                }

                // Add new error and keep only last 100 errors
                errors.unshift(errorEntry);
                if (errors.length > 100) {
                    errors = errors.slice(0, 100);
                }

                // Write back to file
                fs.writeFileSync(errorFile, JSON.stringify(errors, null, 2), 'utf8');

            } catch (logError) {
                // Silent fail for error logging
                console.error('[MCP Error Logger Failed]', logError.message);
            }

            return {
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32000,
                    message: error.message
                }
            };
        }
    }

    // MCP protocol versions this server can speak, oldest -> newest. Our wire
    // surface (initialize, tools/list, tools/call, notifications) is identical
    // across all of these revisions, so we can safely answer with whichever one
    // the client asked for.
    static get SUPPORTED_PROTOCOL_VERSIONS() {
        return ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    }

    handleInitialize(params) {
        // Negotiate the protocol version per the MCP spec: "If the server
        // supports the requested protocol version, it MUST respond with the
        // same version. Otherwise, the server MUST respond with another
        // protocol version it supports (SHOULD be the latest)."
        //
        // We used to hardcode '2024-11-05'. Lenient hosts (Claude Code, Codex)
        // request that exact version and were happy, but stricter/newer hosts
        // (e.g. Antigravity, which requests '2025-11-25') treated the downgraded
        // answer as incompatible and immediately closed stdin, so the server
        // shut down right after `initialize` (the "✗ error" + "Readline
        // interface closed" symptom). Echoing a compatible version fixes that
        // without changing anything for the older hosts.
        const supported = MCPStdioServer.SUPPORTED_PROTOCOL_VERSIONS;
        const latest = supported[supported.length - 1];
        const requested = params && typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : null;
        const protocolVersion = supported.includes(requested) ? requested : latest;

        return {
            protocolVersion,
            capabilities: {
                tools: {},
                resources: {},
                prompts: {}
            },
            serverInfo: {
                name: 'CodeAgentSwarm Task Manager',
                version: '1.0.0'
            }
        };
    }

    // Task management methods
    async createTask(params) {
        const { title, description, terminal_id, project, parent_task_id, labels, images } = params;
        
        if (!title) {
            throw new Error('Title is required');
        }
        
        // Auto-detect terminal if not provided
        let actualTerminalId = terminal_id;
        if (actualTerminalId === undefined || actualTerminalId === null) {
            const envTerminalId = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
            if (envTerminalId) {
                actualTerminalId = parseInt(envTerminalId);
                this.logError(`Auto-detected terminal ID: ${actualTerminalId}`);
            }
        }
        
        // If parent_task_id is provided, try to inherit project from parent
        let actualProject = project;
        if (parent_task_id && !actualProject) {
            try {
                const parentTask = this.db.getTaskById(parent_task_id);
                if (parentTask && parentTask.project) {
                    actualProject = parentTask.project;
                    this.logError(`Inherited project "${actualProject}" from parent task #${parent_task_id}`);
                }
            } catch (e) {
                // Ignore error, use provided project or null
            }
        }
        
        const result = await this.db.createTask(title, description, actualTerminalId, actualProject, parent_task_id, labels, images);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            id: result.taskId,
            title,
            description,
            terminal_id: actualTerminalId,
            project: actualProject || null,
            parent_task_id: parent_task_id || null,
            images: images || [],
            status: 'pending'
        };
    }

    async updateTaskStatus(params) {
        const { task_id, status } = params;
        
        if (!task_id || !status) {
            throw new Error('task_id and status are required');
        }
        
        if (!['pending', 'in_progress', 'in_testing', 'completed'].includes(status)) {
            throw new Error('Invalid status. Must be pending, in_progress, in_testing, or completed');
        }
        
        const result = this.db.updateTaskStatus(task_id, status);

        if (!result.success) {
            throw new Error(result.error);
        }

        // Only notify when task actually completes, not when moving to testing
        // Testing is an intermediate state that requires manual approval
        if (status === 'completed') {
            this.notifyTaskCompletion(task_id);
        }

        return {
            task_id,
            status,
            updated: true
        };
    }

    async getAllTasks(params) {
        const { limit, offset } = params || {};
        const tasks = await this.db.getAllTasks(limit, offset);
        return { tasks };
    }

    async getCurrentTask(params) {
        const { terminal_id } = params;

        // Auto-detect terminal if not provided (consistent with createTask)
        let actualTerminalId = terminal_id;
        if (actualTerminalId === undefined || actualTerminalId === null) {
            const envTerminalId = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
            if (envTerminalId) {
                actualTerminalId = parseInt(envTerminalId);
                this.logError(`Auto-detected terminal ID for getCurrentTask: ${actualTerminalId}`);
            } else {
                // If cannot auto-detect, return null instead of throwing error
                this.logError('Warning: No terminal_id provided and CODEAGENTSWARM_CURRENT_QUADRANT not set for getCurrentTask');
                return { task: null };
            }
        }

        try {
            const task = this.db.getCurrentTask(actualTerminalId);
            return { task };
        } catch (e) {
            // If method doesn't exist or fails, return null gracefully
            this.logError(`getCurrentTask failed: ${e.message}`);
            return { task: null };
        }
    }

    async deleteTask(params) {
        const { task_id } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        const result = this.db.deleteTask(task_id);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            deleted: true
        };
    }

    async updateTask(params) {
        const { task_id, title, description } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        const result = this.db.updateTask(task_id, title, description);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            title,
            description,
            updated: true
        };
    }

    async updateTasksOrder(params) {
        const { taskOrders } = params;
        
        if (!taskOrders || !Array.isArray(taskOrders)) {
            throw new Error('taskOrders array is required');
        }
        
        const result = await this.db.updateTasksOrder(taskOrders);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            updated: true,
            taskCount: taskOrders.length
        };
    }

    async updateTaskPlan(params) {
        const { task_id, plan } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        const result = this.db.updateTaskPlan(task_id, plan);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            plan,
            updated: true
        };
    }

    async updateTaskImplementation(params) {
        const { task_id, implementation } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        const result = this.db.updateTaskImplementation(task_id, implementation);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            implementation,
            updated: true
        };
    }

    async updateTaskTerminal(params) {
        const { task_id, terminal_id } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        if (terminal_id === undefined || terminal_id === null) {
            throw new Error('terminal_id is required (use empty string to unassign)');
        }
        
        const result = this.db.updateTaskTerminal(task_id, terminal_id);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            terminal_id,
            updated: true
        };
    }
    
    async updateTaskLabels(params) {
        const { task_id, labels } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        if (!Array.isArray(labels)) {
            throw new Error('labels must be an array');
        }
        
        const result = this.db.updateTaskLabels(task_id, labels);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            labels,
            updated: true
        };
    }
    
    async updateTaskImages(params) {
        const { task_id, images } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        if (!Array.isArray(images)) {
            throw new Error('images must be an array');
        }
        
        const result = this.db.updateTaskImages(task_id, images);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            images,
            updated: true
        };
    }
    
    // Helper: append a notification to the shared notifications file.
    // Shared by the general-title and the current-activity updates so the
    // read/write + bounding logic lives in one place (DRY).
    _appendNotification(notification) {
        const os = require('os');
        const fs = require('fs');
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
                notifications = JSON.parse(fs.readFileSync(notificationFile, 'utf8'));
            } catch (e) {
                // Invalid JSON, start fresh
                notifications = [];
            }
        }

        notifications.push(notification);

        // Keep only last 100 notifications, but reduce to 50 when limit is reached
        if (notifications.length > 100) {
            notifications = notifications.slice(-50);
        }

        fs.writeFileSync(notificationFile, JSON.stringify(notifications, null, 2));
        return notificationFile;
    }

    // Stamp the terminal-nudge-state marker (<key>.title / <key>.activity) the moment a
    // title/activity is ACCEPTED, so the PreToolUse title gate unblocks on the agent's
    // VERY NEXT tool call. Without this the marker only appears when the renderer's 10s
    // notification poll lets main.js process the update, so the gate kept denying tools
    // for up to 10 seconds AFTER the agent had already set a title. Keyed exactly like
    // the gate script reads it: the stable CODEAGENTSWARM_TERMINAL_ID when present
    // (renumber-proof), plus the raw quadrant env as legacy fallback. Best-effort and
    // idempotent: main.js still writes the same markers when the poll runs.
    // content: undefined -> timestamp (title/activity markers, mtime is the signal);
    // a string -> written verbatim (the .status marker stores the CURRENT status key
    // so the UserPromptSubmit nudge can remind the agent to flip back to 'working');
    // null -> the marker files are removed (status cleared).
    _stampNudgeMarker(kind, content) {
        try {
            const os = require('os');
            const fs = require('fs');
            const stateDir = path.join(os.homedir(), '.codeagentswarm', 'terminal-nudge-state');
            fs.mkdirSync(stateDir, { recursive: true });
            const value = content !== undefined && content !== null ? String(content) : String(Date.now());
            const files = [];
            const tid = process.env.CODEAGENTSWARM_TERMINAL_ID;
            if (tid) {
                const safeTid = String(tid).replace(/[^A-Za-z0-9_-]/g, '_');
                if (safeTid) files.push(path.join(stateDir, `${safeTid}.${kind}`));
            }
            const quadrant = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
            if (quadrant && /^[0-9]+$/.test(quadrant)) {
                files.push(path.join(stateDir, `${quadrant}.${kind}`));
            }
            for (const file of files) {
                if (content === null) fs.rmSync(file, { force: true });
                else fs.writeFileSync(file, value);
            }
        } catch (e) {
            // Best-effort: the renderer poll still stamps the markers within ~10s.
        }
    }

    // Resolve the current terminal id (1-based) from the environment.
    _getCurrentTerminalId() {
        const terminalId = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
        if (!terminalId) {
            throw new Error('Cannot detect current terminal. CODEAGENTSWARM_CURRENT_QUADRANT not set');
        }
        return parseInt(terminalId);
    }

    // Resolve the current task for a terminal (or null) without throwing.
    _getCurrentTask(terminalId) {
        try {
            return this.db.getCurrentTask(terminalId) || null;
        } catch (e) {
            return null;
        }
    }

    // Set the GENERAL terminal title: the sticky tab label that represents the
    // product-level goal of what this terminal is working on. Set it ONCE at the
    // start of work; call it again only to refine when the overall functionality
    // changes, or to replace it when the terminal pivots to a radically different
    // topic. It does NOT represent the current step — use update_terminal_activity
    // for that.
    async setTerminalTitle(params) {
        const { title, long_title } = params;

        if (!title) {
            throw new Error('title is required');
        }

        if (isPlaceholderTitle(title)) {
            throw new Error(`"${title}" looks like example text copied from the tool documentation, not a real title. Call the tool again with a title that describes the ACTUAL feature or goal you are working on in this agent (max 6 words).`);
        }

        // Generate short title (6 words) from provided title
        const shortTitle = this.generateShortTitle(title);

        const terminalId = this._getCurrentTerminalId();
        const currentTask = this._getCurrentTask(terminalId);
        const taskId = currentTask ? currentTask.id : null;

        // Use provided long_title; else fall back to the task title; else generate one
        let longTitle = long_title;
        if (!longTitle && currentTask && currentTask.title) {
            longTitle = currentTask.title;
            this.logError(`Using task title as long_title: "${longTitle}"`);
        }
        if (!longTitle) {
            // Filler. The renderer DISCARDS it (see terminal-goal.js), so the user
            // gets no GOAL row at all — log it loudly enough to spot an agent that
            // never learned to pass the argument.
            longTitle = this.generateLongTitle(title);
            this.logError(`⚠️ No long_title provided by the agent — generated filler "${longTitle}", so this agent will show NO goal. Agents should always pass long_title.`);
        }

        try {
            const newNotification = {
                type: 'terminal_title_update',
                terminal_id: terminalId,
                // STABLE, renumber-proof id (frozen at terminal spawn, survives MCP
                // reconnect). main.js routes by this when present so the title lands on
                // the right tab even after a renumber; terminal_id (quadrant) is only a
                // legacy fallback. See task #11795.
                terminal_uuid: process.env.CODEAGENTSWARM_TERMINAL_ID || null,
                title: shortTitle,
                long_title: longTitle,
                task_id: taskId,
                timestamp: new Date().toISOString(),
                processed: false
            };

            const notificationFile = this._appendNotification(newNotification);

            // Unblock the PreToolUse title gate immediately (see _stampNudgeMarker).
            this._stampNudgeMarker('title');

            this.logError(`✅ General terminal title set: "${shortTitle}" (short) | "${longTitle}" (long) for terminal ${terminalId}`);
            this.logError(`📁 Notification written to: ${notificationFile}`);

            return {
                terminal_id: terminalId,
                title: shortTitle,
                long_title: longTitle,
                task_id: taskId,
                updated: true
            };
        } catch (error) {
            throw new Error(`Failed to set terminal title: ${error.message}`);
        }
    }

    // Record the CURRENT product-focused ACTIVITY for this terminal. Call it
    // often, whenever the focus moves to a new step (described in product terms,
    // not file terms). It is shown on hover and accumulated as the activity log.
    // It does NOT change the sticky tab title.
    async updateTerminalActivity(params) {
        const { activity } = params;

        if (!activity || !activity.trim()) {
            throw new Error('activity is required');
        }

        const activityText = activity.trim();
        const terminalId = this._getCurrentTerminalId();
        const currentTask = this._getCurrentTask(terminalId);
        const taskId = currentTask ? currentTask.id : null;

        try {
            const newNotification = {
                type: 'terminal_activity_update',
                terminal_id: terminalId,
                // STABLE, renumber-proof id (see set_terminal_title). Routed by main.js
                // when present; terminal_id (quadrant) is the legacy fallback. Task #11795.
                terminal_uuid: process.env.CODEAGENTSWARM_TERMINAL_ID || null,
                activity: activityText,
                task_id: taskId,
                timestamp: new Date().toISOString(),
                processed: false
            };

            const notificationFile = this._appendNotification(newNotification);

            // Keep the activity-staleness nudge fresh without waiting for the poll.
            this._stampNudgeMarker('activity');

            this.logError(`✅ Agent activity updated: "${activityText}" for agent ${terminalId}`);
            this.logError(`📁 Notification written to: ${notificationFile}`);

            return {
                terminal_id: terminalId,
                activity: activityText,
                task_id: taskId,
                updated: true
            };
        } catch (error) {
            throw new Error(`Failed to update agent activity: ${error.message}`);
        }
    }

    // Read the terminal status catalog from the DB, falling back to the hardcoded
    // defaults when the DB read fails (e.g. the terminal_statuses table is missing)
    // so the status tool never crashes the MCP server.
    _getAvailableTerminalStatuses() {
        try {
            if (this.db && typeof this.db.getTerminalStatuses === 'function') {
                const statuses = this.db.getTerminalStatuses();
                if (Array.isArray(statuses) && statuses.length > 0) {
                    // DISABLED statuses (enabled: 0) are not offered to agents: they
                    // are hidden from the tool description AND rejected as inputs.
                    // Same treatment for APP-OWNED ones (agent_settable: 0, e.g.
                    // 'idle'): the app derives them from facts it already has, so an
                    // agent claiming one could only be guessing. Rows without either
                    // column (pre-migration DB) count as enabled and agent-settable.
                    const offered = statuses.filter(s =>
                        (s.enabled === undefined || s.enabled === null || s.enabled === 1) &&
                        (s.agent_settable === undefined || s.agent_settable === null || s.agent_settable === 1)
                    );
                    if (offered.length > 0) return offered;
                }
            }
        } catch (e) {
            this.logError(`Failed to read agent statuses, using defaults: ${e.message}`);
        }
        return DEFAULT_TERMINAL_STATUSES;
    }

    // Build the set_terminal_status tool description dynamically from the catalog:
    // a header sentence, one line per status ("- '<key>' (<label>): <prompt>"), and
    // the 'clear' hint. Built fresh so custom/edited statuses show up automatically.
    _buildStatusToolDescription() {
        const statuses = this._getAvailableTerminalStatuses();
        const lines = statuses.map(s => `- '${s.status_key}' (${s.label}): ${s.prompt}`);
        return `${TERMINAL_STATUS_DESCRIPTION_HEADER}\n${lines.join('\n')}\nUse 'clear' to remove the status.`;
    }

    // Build the set_terminal_status tool definition. Kept as a method (not a static
    // literal) so the description reflects the live, possibly user-edited catalog.
    buildStatusToolDefinition() {
        return {
            name: 'set_terminal_status',
            description: this._buildStatusToolDescription(),
            inputSchema: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        description: 'The status key (e.g. working, needs_testing) or clear to remove it.'
                    }
                },
                required: ['status']
            }
        };
    }

    // Record the current STATUS of this terminal (the phase the work is in). Mirrors
    // updateTerminalActivity: writes a `terminal_status_update` notification stamped
    // with the stable terminal_uuid (renumber-proof routing). 'clear' removes the
    // status (status: null). Invalid keys return an error result listing the valid
    // ones instead of throwing, so the agent can retry.
    async setTerminalStatus(params) {
        const { status } = params;

        if (!status || !String(status).trim()) {
            throw new Error('status is required');
        }

        const statusKey = String(status).trim();
        const isClear = statusKey === 'clear';

        // Validate against the catalog (fail-safe to the hardcoded defaults on DB error).
        const validKeys = this._getAvailableTerminalStatuses().map(s => s.status_key);
        if (!isClear && !validKeys.includes(statusKey)) {
            return {
                error: `Invalid status "${statusKey}". Use one of: ${validKeys.join(', ')} (or "clear" to remove the status).`,
                valid_statuses: validKeys,
                updated: false
            };
        }

        const terminalId = this._getCurrentTerminalId();
        const resolvedStatus = isClear ? null : statusKey;

        try {
            const newNotification = {
                type: 'terminal_status_update',
                terminal_id: terminalId,
                // STABLE, renumber-proof id (see set_terminal_title). Routed by main.js
                // when present; terminal_id (quadrant) is the legacy fallback. Task #11795.
                terminal_uuid: process.env.CODEAGENTSWARM_TERMINAL_ID || null,
                status: resolvedStatus,
                task_id: null,
                timestamp: new Date().toISOString(),
                processed: false
            };

            const notificationFile = this._appendNotification(newNotification);

            // Record the current status in the nudge marker (content = status key)
            // so the UserPromptSubmit nudge knows when to remind about 'working'.
            this._stampNudgeMarker('status', resolvedStatus);

            this.logError(`✅ Agent status set: "${resolvedStatus}" for agent ${terminalId}`);
            this.logError(`📁 Notification written to: ${notificationFile}`);

            return {
                terminal_id: terminalId,
                status: resolvedStatus,
                updated: true
            };
        } catch (error) {
            throw new Error(`Failed to set agent status: ${error.message}`);
        }
    }

    // DEPRECATED backward-compatible alias for older CLAUDE.md installs and
    // in-flight sessions. Sets the general title AND, when long_title is given,
    // records it as a current activity so the new hover/log still get populated.
    async updateTerminalTitle(params) {
        const { title, long_title } = params;
        const result = await this.setTerminalTitle({ title, long_title });

        // Map the detailed description onto a product activity entry too, so the
        // hover + activity log keep working for legacy callers.
        const activityText = long_title || title;
        if (activityText) {
            try {
                await this.updateTerminalActivity({ activity: activityText });
            } catch (e) {
                // Non-fatal: the general title was still set
            }
        }

        return result;
    }

    // Project management methods
    async createProject(params) {
        const { name, color } = params;
        
        if (!name) {
            throw new Error('Project name is required');
        }
        
        const result = await this.db.createProject(name, color);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            id: result.projectId,
            name: result.name,
            color: result.color,
            created: true
        };
    }
    
    async getProjects(params) {
        const { limit = null, offset = 0 } = params || {};
        const projects = await this.db.getProjects(limit, offset);
        return { projects };
    }
    
    async getProjectTasks(params) {
        const { project_name, limit = null, offset = 0 } = params;

        if (!project_name) {
            throw new Error('project_name is required');
        }

        const tasks = await this.db.getTasksByProject(project_name, limit, offset);
        return { tasks };
    }

    async updateTaskProject(params) {
        const { task_id, project } = params;

        if (!task_id) {
            throw new Error('task_id is required');
        }

        if (project === undefined) {
            throw new Error('project is required (use empty string or null to unassign)');
        }

        const result = this.db.updateTaskProject(task_id, project);

        if (!result.success) {
            throw new Error(result.error);
        }

        return {
            task_id,
            project: project || null,
            updated: true
        };
    }

    async checkActive() {
        const isActive = !!process.env.CODEAGENTSWARM_ACTIVE_SESSION;

        if (isActive) {
            const quadrant = process.env.CODEAGENTSWARM_CURRENT_QUADRANT || 'unknown';
            return {
                active: true,
                quadrant: parseInt(quadrant) || 0,
                message: 'Running inside CodeAgentSwarm. Follow all CodeAgentSwarm instructions.'
            };
        }

        return {
            active: false,
            message: 'NOT running inside CodeAgentSwarm. IGNORE all CodeAgentSwarm task management instructions. Work as a normal standalone agent. Do NOT create tasks, update agent titles, or call any other codeagentswarm-tasks tools.'
        };
    }

    async requestSandboxToProject() {
        if (!process.env.CODEAGENTSWARM_ACTIVE_SESSION) {
            return {
                requested: false,
                error: 'This action is only available inside an active CodeAgentSwarm session.'
            };
        }

        const terminalId = this._getCurrentTerminalId();
        const terminalUuid = process.env.CODEAGENTSWARM_TERMINAL_ID;
        if (!terminalUuid) {
            return {
                requested: false,
                error: 'Cannot safely identify this agent. Reopen the session and try again.'
            };
        }
        this._writeSandboxProjectRequest({
            terminalId,
            terminalUuid
        });

        return {
            requested: true,
            terminal_id: terminalId,
            message: 'Opened the Sandbox project form. The user must choose the destination and confirm it in CodeAgentSwarm.'
        };
    }

    _writeSandboxProjectRequest(request) {
        return writeSandboxProjectRequest(request);
    }

    // Subtask management methods
    async createSubtask(params) {
        const { title, description, parent_task_id, terminal_id, project } = params;
        
        if (!title) {
            throw new Error('Title is required');
        }
        
        if (!parent_task_id) {
            throw new Error('parent_task_id is required for subtasks');
        }
        
        // Auto-detect terminal if not provided
        let actualTerminalId = terminal_id;
        if (actualTerminalId === undefined || actualTerminalId === null) {
            const envTerminalId = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
            if (envTerminalId) {
                actualTerminalId = parseInt(envTerminalId);
            }
        }
        
        // Inherit project from parent if not provided
        let actualProject = project;
        if (!actualProject) {
            try {
                const parentTask = await this.db.getTaskById(parent_task_id);
                if (parentTask && parentTask.project) {
                    actualProject = parentTask.project;
                    this.logError(`Inherited project "${actualProject}" from parent task #${parent_task_id}`);
                }
            } catch (e) {
                // Ignore error
            }
        }
        
        const result = await this.db.createTask(title, description, actualTerminalId, actualProject, parent_task_id);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            id: result.taskId,
            title,
            description,
            terminal_id: actualTerminalId,
            project: actualProject || null,
            parent_task_id,
            status: 'pending',
            created: true
        };
    }

    async getSubtasks(params) {
        const { parent_task_id, limit = null, offset = 0 } = params;
        
        if (!parent_task_id) {
            throw new Error('parent_task_id is required');
        }
        
        const subtasks = this.db.getSubtasks(parent_task_id, limit, offset);
        return { subtasks };
    }

    async linkTaskToParent(params) {
        const { task_id, parent_task_id } = params;
        
        if (!task_id || !parent_task_id) {
            throw new Error('task_id and parent_task_id are required');
        }
        
        const result = this.db.linkTaskToParent(task_id, parent_task_id);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            parent_task_id,
            linked: true
        };
    }

    async unlinkTaskFromParent(params) {
        const { task_id } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        const result = this.db.unlinkTaskFromParent(task_id);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            task_id,
            unlinked: true
        };
    }

    async getTaskHierarchy(params) {
        const { task_id } = params;
        
        if (!task_id) {
            throw new Error('task_id is required');
        }
        
        const hierarchy = await this.db.getTaskHierarchy(task_id);
        
        if (!hierarchy) {
            throw new Error('Task not found');
        }
        
        return { hierarchy };
    }

    async suggestParentTasks(params) {
        const { title, description, limit = 5 } = params;
        
        if (!title) {
            throw new Error('title is required');
        }
        
        // Get recent tasks that could be parents (last 30 days)
        const recentTasks = await this.db.getRecentTasks(30);
        
        // Calculate similarity scores for each task
        const scoredTasks = recentTasks.map(task => {
            const score = this.calculateSimilarityScore(
                title, 
                description || '',
                task.title,
                task.description || '',
                task.plan || '',
                task.implementation || ''
            );
            
            return {
                ...task,
                similarity_score: score,
                reason: this.generateSuggestionReason(title, description, task, score)
            };
        });
        
        // Filter out tasks with very low scores and sort by score
        const suggestions = scoredTasks
            .filter(task => task.similarity_score > 0.3) // Increased minimum to 30% similarity
            .sort((a, b) => b.similarity_score - a.similarity_score)
            .slice(0, limit);
        
        return { 
            suggestions,
            message: suggestions.length > 0 
                ? `Found ${suggestions.length} potential parent task(s)` 
                : 'No suitable parent tasks found'
        };
    }
    
    calculateSimilarityScore(newTitle, newDesc, taskTitle, taskDesc, taskPlan, taskImpl) {
        // Normalize strings for comparison
        const normalize = (str) => str.toLowerCase().trim();
        
        // Extract keywords (words longer than 3 characters, excluding common words)
        const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'where', 'what', 'which', 'how']);
        
        // Also exclude overly generic verbs from keyword matching
        const genericVerbs = new Set(['fix', 'add', 'update', 'improve', 'change', 'modify', 'edit', 'create', 'make', 'build']);
        
        const extractKeywords = (text) => {
            return text
                .toLowerCase()
                .split(/\W+/)
                .filter(word => word.length > 3 && !stopWords.has(word) && !genericVerbs.has(word));
        };
        
        // Give more weight to description when extracting keywords
        const newKeywords = new Set([
            ...extractKeywords(newTitle),
            ...extractKeywords(newDesc),
            ...extractKeywords(newDesc) // Count description twice for more weight
        ]);
        
        const taskKeywords = new Set([
            ...extractKeywords(taskTitle),
            ...extractKeywords(taskDesc),
            ...extractKeywords(taskDesc), // Count description twice
            ...extractKeywords(taskPlan),
            ...extractKeywords(taskImpl)
        ]);
        
        // Calculate keyword overlap
        let matchCount = 0;
        for (const keyword of newKeywords) {
            if (taskKeywords.has(keyword)) {
                matchCount++;
            }
        }
        
        // Base score from keyword overlap
        const keywordScore = newKeywords.size > 0 
            ? matchCount / Math.max(newKeywords.size, taskKeywords.size)
            : 0;
        
        // Bonus points for specific patterns
        let bonusScore = 0;
        let factorCount = 0; // Count how many factors match
        
        // Check for related action verbs (reduced weight for generic ones)
        const actionPatterns = [
            // Generic patterns - very low weight
            { parent: 'implement', child: ['fix', 'add', 'enhance'], weight: 0.05 },
            { parent: 'create', child: ['add', 'setup'], weight: 0.05 },
            
            // More specific patterns - higher weight
            { parent: 'implement authentication', child: ['fix auth', 'fix login'], weight: 0.2 },
            { parent: 'create database', child: ['fix schema', 'add table'], weight: 0.2 },
            { parent: 'build api', child: ['fix endpoint', 'add route'], weight: 0.2 },
            
            // Spanish patterns
            { parent: 'implementar', child: ['arreglar', 'añadir'], weight: 0.05 },
            { parent: 'hacer', child: ['arreglar', 'mejorar'], weight: 0.05 }
        ];
        
        // Check if the action verb is used WITH context
        let verbMatchFound = false;
        for (const pattern of actionPatterns) {
            const parentWords = pattern.parent.split(' ');
            const parentVerb = parentWords[0];
            const parentContext = parentWords.slice(1).join(' ');
            
            if (normalize(taskTitle).includes(parentVerb)) {
                for (const childPhrase of pattern.child) {
                    if (normalize(newTitle).includes(childPhrase)) {
                        // Only give bonus if there's also keyword overlap
                        if (matchCount > 0) {
                            bonusScore += pattern.weight;
                            verbMatchFound = true;
                            factorCount++;
                        }
                        break;
                    }
                }
            }
        }
        
        // Check for component/feature references (higher weight for specific components)
        const componentWords = [
            'auth', 'database', 'api', 'backend', 'frontend', 'server', 'client', 
            'login', 'user', 'task', 'subtask', 'kanban', 'terminal', 'mcp', 'notification',
            'hook', 'claude', 'agent', 'swarm', 'quadrant', 'layout', 'diff', 'commit',
            'push', 'git', 'scroll', 'wizard', 'install', 'dmg', 'electron', 'react', 'sqlite', 'permission'
        ];
        
        let componentMatches = 0;
        for (const component of componentWords) {
            // Check in both title AND description
            const inNewContent = (normalize(newTitle).includes(component) || normalize(newDesc).includes(component));
            const inTaskContent = (normalize(taskTitle).includes(component) || normalize(taskDesc).includes(component));
            
            if (inNewContent && inTaskContent) {
                bonusScore += 0.25; // Increased from 0.15
                componentMatches++;
                factorCount++;
            }
        }
        
        // Check if task mentions bugs/fixes and new task is about fixing
        if ((normalize(taskTitle).includes('bug') || normalize(taskDesc).includes('bug')) &&
            (normalize(newTitle).includes('fix') || normalize(newTitle).includes('arreglar'))) {
            // Only if there's also component match
            if (componentMatches > 0) {
                bonusScore += 0.2;
                factorCount++;
            }
        }
        
        // Check for continuation patterns in description
        const continuationWords = ['continuar', 'continue', 'seguir', 'more', 'additional', 'also', 'furthermore'];
        for (const word of continuationWords) {
            if (normalize(newDesc).includes(word)) {
                bonusScore += 0.1;
                factorCount++;
                break;
            }
        }
        
        // Require at least 2 matching factors for any suggestion
        if (factorCount < 2 && keywordScore < 0.5) {
            return 0; // Not enough evidence for relationship
        }
        
        // Final score is combination of keyword match and bonus points
        return Math.min(1.0, keywordScore + bonusScore);
    }
    
    generateSuggestionReason(newTitle, newDesc, task, score) {
        const reasons = [];
        
        if (score > 0.7) {
            reasons.push('High similarity in keywords and context');
        } else if (score > 0.5) {
            reasons.push('Moderate similarity found');
        } else {
            reasons.push('Some related keywords detected');
        }
        
        // Check for specific relationships
        const lowerNewTitle = newTitle.toLowerCase();
        const lowerTaskTitle = task.title.toLowerCase();
        
        if (lowerNewTitle.includes('fix') && lowerTaskTitle.includes('implement')) {
            reasons.push('Fixing issues in implemented feature');
        }
        
        if (lowerNewTitle.includes('test') && !lowerTaskTitle.includes('test')) {
            reasons.push('Adding tests to existing functionality');
        }
        
        if (lowerNewTitle.includes('improve') || lowerNewTitle.includes('enhance')) {
            reasons.push('Enhancement of existing feature');
        }
        
        if (task.status === 'in_testing' || task.status === 'completed') {
            const hoursSinceUpdate = (Date.now() - new Date(task.updated_at).getTime()) / (1000 * 60 * 60);
            if (hoursSinceUpdate < 24) {
                reasons.push(`Recently ${task.status} (${Math.round(hoursSinceUpdate)} hours ago)`);
            }
        }
        
        return reasons.join('. ');
    }

    // MCP Tools
    // ── Per-agent gating helpers ─────────────────────────────────────────────
    // All read the DB fresh on every call (never cached) so flipping a toggle in
    // Settings takes effect immediately on already-open sessions, and all fail
    // SAFE to enabled on any read error.

    // The caller agent id from CODEAGENTSWARM_AGENT_TYPE, or null when absent
    // (legacy: no per-agent env → global-only task gate, title tools never gated).
    getCallerAgentId() {
        const v = process.env.CODEAGENTSWARM_AGENT_TYPE;
        return v ? String(v).trim().toLowerCase() : null;
    }

    // Read a boolean-ish setting: null/undefined → null (caller decides fallback);
    // otherwise disabled ONLY when exactly false / 'false'. Read error → null.
    _readBoolSettingOrNull(key) {
        try {
            const value = this.db.getSetting(key);
            if (value === null || value === undefined) return null;
            return !(value === false || value === 'false');
        } catch (error) {
            return null;
        }
    }

    // The caller's base MCP-connection intent. No caller agent → true (legacy).
    // Reads the per-agent MCP key, falling back to the legacy fused per-agent key.
    isMcpEnabledForCaller() {
        const agent = this.getCallerAgentId();
        if (!agent) return true;
        const mcp = this._readBoolSettingOrNull(`task_mcp_enabled_${agent}`);
        if (mcp !== null) return mcp;
        const fused = this._readBoolSettingOrNull(`task_system_enabled_${agent}`);
        if (fused !== null) return fused;
        return true;
    }

    // Whether task/kanban tools are effective for the caller. MCP off → false.
    // With a known caller, the per-agent kanban key wins; otherwise fall back to
    // the global `task_management_enabled` (the legacy behavior).
    isTaskManagementEnabled() {
        if (!this.isMcpEnabledForCaller()) return false;
        const agent = this.getCallerAgentId();
        if (agent) {
            const perAgent = this._readBoolSettingOrNull(`task_management_enabled_${agent}`);
            if (perAgent !== null) return perAgent;
        }
        const global = this._readBoolSettingOrNull('task_management_enabled');
        return global === null ? true : global;
    }

    // Whether the caller may CREATE tasks. Kanban off → false (the creation tools
    // are already gone with the rest). Otherwise the per-agent creation key decides,
    // defaulting to true so existing installs are unaffected. No caller agent →
    // legacy behavior: the global key if present, else true.
    isTaskCreationEnabledForCaller() {
        if (!this.isTaskManagementEnabled()) return false;
        const agent = this.getCallerAgentId();
        if (agent) {
            const perAgent = this._readBoolSettingOrNull(`task_creation_enabled_${agent}`);
            if (perAgent !== null) return perAgent;
        }
        const global = this._readBoolSettingOrNull('task_creation_enabled');
        return global === null ? true : global;
    }

    // Whether terminal-title tools are effective for the caller. MCP off → false.
    // No caller agent → true (legacy: title tools were never gated).
    isTitlesEnabledForCaller() {
        if (!this.isMcpEnabledForCaller()) return false;
        const agent = this.getCallerAgentId();
        if (!agent) return true;
        const perAgent = this._readBoolSettingOrNull(`terminal_titles_enabled_${agent}`);
        return perAgent === null ? true : perAgent;
    }

    // Whether the terminal work-phase status tool is effective for the caller.
    // MCP off → false. No caller agent → true (legacy: status tool never gated).
    isStatusEnabledForCaller() {
        if (!this.isMcpEnabledForCaller()) return false;
        const agent = this.getCallerAgentId();
        if (!agent) return true;
        const perAgent = this._readBoolSettingOrNull(`terminal_status_enabled_${agent}`);
        return perAgent === null ? true : perAgent;
    }

    getSessionCommunicationConfig() {
        const port = Number.parseInt(process.env.CODEAGENTSWARM_SESSION_BRIDGE_PORT, 10);
        const enabled = process.env.CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED === '1';
        const token = process.env.CODEAGENTSWARM_SESSION_BRIDGE_TOKEN;
        const sessionId = process.env.CODEAGENTSWARM_TERMINAL_ID;
        if (!enabled || !Number.isInteger(port) || port < 1 || port > 65535 || !token || !sessionId) {
            return null;
        }
        return { port, token, sessionId };
    }

    isSessionCommunicationEnabled() {
        return this.getSessionCommunicationConfig() !== null;
    }

    _sessionCommunicationRequest(method, pathname, body = null) {
        const config = this.getSessionCommunicationConfig();
        if (!config) return Promise.reject(new Error(SESSION_COMMUNICATION_DISABLED_MESSAGE));
        const payload = body === null ? null : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const request = http.request({
                host: '127.0.0.1',
                port: config.port,
                path: pathname,
                method,
                headers: {
                    Authorization: `Bearer ${config.token}`,
                    'X-CodeAgentSwarm-Session-Id': config.sessionId,
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
                timeout: 5000,
            }, (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { text += chunk; });
                response.on('end', () => {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`Session bridge returned HTTP ${response.statusCode}`));
                        return;
                    }
                    try { resolve(text ? JSON.parse(text) : {}); }
                    catch { reject(new Error('Session bridge returned invalid JSON')); }
                });
            });
            request.on('timeout', () => request.destroy(new Error('Session bridge request timed out')));
            request.on('error', reject);
            if (payload) request.write(payload);
            request.end();
        });
    }

    async listSessions() {
        return this._sessionCommunicationRequest('GET', '/session-communication/sessions');
    }

    async sendSessionMessage({ target_session_id, message, message_type = 'request', reply_to_request_id = '' }) {
        if (!target_session_id || !message) throw new Error('target_session_id and message are required');
        if (!['request', 'response'].includes(message_type)) {
            throw new Error('message_type must be request or response');
        }
        if (message_type === 'response' && !reply_to_request_id) {
            throw new Error('reply_to_request_id is required for responses');
        }
        if (message_type === 'request' && reply_to_request_id) {
            throw new Error('reply_to_request_id is only valid for responses');
        }
        return this._sessionCommunicationRequest('POST', '/session-communication/messages', {
            target_session_id,
            message,
            message_type,
            ...(reply_to_request_id ? { reply_to_request_id } : {}),
        });
    }

    listTools() {
        let tools = this.buildToolDefinitions();
        if (!this.isTaskManagementEnabled()) {
            // Hide task/kanban tools; terminal + check_active tools stay announced.
            tools = tools.filter(tool => !TASK_MANAGEMENT_TOOL_NAMES.has(tool.name));
        } else if (!this.isTaskCreationEnabledForCaller()) {
            // Kanban on, creation off: keep every read/move tool, drop only the two
            // that put NEW items on the board.
            tools = tools.filter(tool => !TASK_CREATION_TOOL_NAMES.has(tool.name));
        }
        if (!this.isTitlesEnabledForCaller()) {
            // Hide title tools; check_active always remains.
            tools = tools.filter(tool => !TITLE_TOOL_NAMES.has(tool.name));
        }
        if (!this.isStatusEnabledForCaller()) {
            // Hide the status tool; check_active always remains.
            tools = tools.filter(tool => !STATUS_TOOL_NAMES.has(tool.name));
        }
        if (!this.isSessionCommunicationEnabled()) {
            tools = tools.filter(tool => !SESSION_COMMUNICATION_TOOL_NAMES.has(tool.name));
        }
        return { tools };
    }

    buildToolDefinitions() {
        return [
                {
                    name: 'create_task',
                    description: 'Create a new task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'Task title' },
                            description: { type: 'string', description: 'Task description' },
                            terminal_id: { type: 'number', description: 'Agent ID (1-based, optional — auto-detected from environment)' },
                            project: { type: 'string', description: 'Project name (optional, defaults to CodeAgentSwarm)' },
                            parent_task_id: { type: 'number', description: 'Parent task ID to create this as a subtask (optional)' },
                            labels: { 
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Array of label strings for the task (optional)'
                            }
                        },
                        required: ['title']
                    }
                },
                {
                    name: 'start_task',
                    description: 'Start working on a task (mark as in_progress)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' }
                        },
                        required: ['task_id']
                    }
                },
                {
                    name: 'complete_task',
                    description: 'Move task to testing (first call) or to completed (second call after manual approval and 30-second minimum testing period)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' }
                        },
                        required: ['task_id']
                    }
                },
                {
                    name: 'submit_for_testing',
                    description: 'Submit a task for testing (mark as in_testing)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' }
                        },
                        required: ['task_id']
                    }
                },
                {
                    name: 'list_tasks',
                    description: 'List all tasks with pagination support',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            status: { type: 'string', enum: ['pending', 'in_progress', 'in_testing', 'completed'], description: 'Filter by status' },
                            limit: { type: 'number', description: 'Maximum number of tasks to return (default: 20)', default: 20 },
                            offset: { type: 'number', description: 'Number of tasks to skip for pagination (default: 0)', default: 0 }
                        }
                    }
                },
                {
                    name: 'search_tasks',
                    description: 'Search for tasks by keywords in title, description, plan, or implementation',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query to find in task fields' },
                            status: { type: 'string', enum: ['pending', 'in_progress', 'in_testing', 'completed'], description: 'Optional: filter by status' },
                            recent_only: { type: 'boolean', description: 'Optional: only search tasks updated in last 48 hours (default: true)' },
                            limit: { type: 'number', description: 'Optional: maximum number of results (default: 20)' }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'find_related_active_tasks',
                    description: 'Find similar tasks that are currently active (in_progress or in_testing) to avoid creating duplicates',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'Title of the task to find similar ones' },
                            description: { type: 'string', description: 'Optional: description to improve similarity matching' }
                        },
                        required: ['title']
                    }
                },
                {
                    name: 'update_task_plan',
                    description: 'Update the plan for a task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' },
                            plan: { type: 'string', description: 'Task plan' }
                        },
                        required: ['task_id', 'plan']
                    }
                },
                {
                    name: 'update_task_implementation',
                    description: 'Update the implementation details for a task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' },
                            implementation: { type: 'string', description: 'Implementation details including modified files and summary' }
                        },
                        required: ['task_id', 'implementation']
                    }
                },
                {
                    name: 'update_task_terminal',
                    description: 'Update the agent ID associated with a task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' },
                            terminal_id: { type: 'string', description: 'Agent ID (1-based) or empty string to unassign' }
                        },
                        required: ['task_id', 'terminal_id']
                    }
                },
                {
                    name: 'update_task_labels',
                    description: 'Update the labels for a task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' },
                            labels: { 
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Array of label strings for the task'
                            }
                        },
                        required: ['task_id', 'labels']
                    }
                },
                {
                    name: 'set_terminal_title',
                    description: 'Set the GENERAL agent title AND the agent GOAL — pass BOTH arguments, because the user sees them together. `title` is the sticky Agent tab label at the FEATURE level (e.g. "Promo video for Twitter", "Minimize agents"); `long_title` is one sentence on what this agent is FOR, shown in the hover under the title. Keep the title high-level: name the feature, not a low-level step or work phase. Set it once at the start, then only refine it when the overall goal changes. Use update_terminal_activity for the current step. LANGUAGE: write BOTH in the SAME language the user is speaking.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            title: {
                                type: 'string',
                                description: 'Short, product-level general title (max 6 words) describing the ACTUAL work in this agent. NEVER copy example or placeholder text from documentation — placeholder titles are rejected. Shown in the Agent tab and almost never changes.'
                            },
                            long_title: {
                                type: 'string',
                                description: 'The agent GOAL: one sentence saying what this agent is FOR — the outcome the work is aiming at, not the current step. ALWAYS provide it: the user reads it in the Agent hover, labelled GOAL, under the short title. Write the real goal in the user\'s language. Do NOT restate the title or prefix it with "Working on:".'
                            }
                        },
                        // long_title is NOT in `required` on purpose: some agent clients
                        // validate the schema locally and would REJECT the whole call,
                        // leaving the terminal with no title at all — worse than a
                        // missing goal. The description carries the "always provide it"
                        // weight instead, and the server keeps its fallback chain.
                        required: ['title']
                    }
                },
                {
                    name: 'update_terminal_activity',
                    description: 'Record the CURRENT product-focused ACTIVITY for this agent. Call this OFTEN when the focus moves to a new step. Frame it at the PRODUCT level, not in technical terms. Bad: "Editing renderer.js". Good: "Implementing the minimize button". It appears in the Agent hover and activity log without changing the sticky title. If the overall goal changes, also call set_terminal_title. LANGUAGE: use the SAME language as the user.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            activity: {
                                type: 'string',
                                description: 'Product-focused description of what you are doing right now (one short sentence, e.g., "Implementing the WordPress embed").'
                            }
                        },
                        required: ['activity']
                    }
                },
                // Built dynamically so the description reflects the live (possibly
                // user-edited) terminal status catalog from the DB.
                this.buildStatusToolDefinition(),
                {
                    name: 'request_sandbox_to_project',
                    description: 'Use only when the user explicitly asks to turn the current Sandbox into a real project. Opens CodeAgentSwarm\'s confirmation form for the user to choose the project name, destination path, and Git option. This tool does not create project files, move source files, or run Git.',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                },
                // NOTE: the deprecated update_terminal_title tool is intentionally NOT
                // announced here anymore. Its documented example title ("Fix Auth Bug")
                // kept being copied verbatim by agents onto real terminal tabs. The
                // tools/call handler still accepts it for old installs / in-flight
                // sessions whose instructions reference it.
                {
                    name: 'create_project',
                    description: 'Create a new project',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Project name' },
                            color: { type: 'string', description: 'Project color in hex format (optional)' }
                        },
                        required: ['name']
                    }
                },
                {
                    name: 'get_projects',
                    description: 'Get all projects with pagination support',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            limit: { type: 'number', description: 'Maximum number of projects to return (optional)' },
                            offset: { type: 'number', description: 'Number of projects to skip for pagination (optional)' }
                        }
                    }
                },
                {
                    name: 'get_project_tasks',
                    description: 'Get all tasks for a specific project with pagination support',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            project_name: { type: 'string', description: 'Project name' },
                            limit: { type: 'number', description: 'Maximum number of tasks to return (optional)' },
                            offset: { type: 'number', description: 'Number of tasks to skip for pagination (optional)' }
                        },
                        required: ['project_name']
                    }
                },
                {
                    name: 'create_subtask',
                    description: 'Create a subtask under a parent task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'Subtask title' },
                            description: { type: 'string', description: 'Subtask description' },
                            parent_task_id: { type: 'number', description: 'Parent task ID' },
                            terminal_id: { type: 'number', description: 'Agent ID (optional, auto-detected)' },
                            project: { type: 'string', description: 'Project name (optional, inherited from parent)' }
                        },
                        required: ['title', 'parent_task_id']
                    }
                },
                {
                    name: 'get_subtasks',
                    description: 'Get all subtasks of a parent task with pagination support',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            parent_task_id: { type: 'number', description: 'Parent task ID' },
                            limit: { type: 'number', description: 'Maximum number of subtasks to return (optional)' },
                            offset: { type: 'number', description: 'Number of subtasks to skip for pagination (optional)' }
                        },
                        required: ['parent_task_id']
                    }
                },
                {
                    name: 'link_task_to_parent',
                    description: 'Link an existing task to a parent task (make it a subtask)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID to link' },
                            parent_task_id: { type: 'number', description: 'Parent task ID' }
                        },
                        required: ['task_id', 'parent_task_id']
                    }
                },
                {
                    name: 'unlink_task_from_parent',
                    description: 'Unlink a task from its parent (make it standalone)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID to unlink' }
                        },
                        required: ['task_id']
                    }
                },
                {
                    name: 'get_task_hierarchy',
                    description: 'Get a task with all its subtasks recursively',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' }
                        },
                        required: ['task_id']
                    }
                },
                {
                    name: 'suggest_parent_tasks',
                    description: 'Suggest potential parent tasks for a new task based on semantic analysis',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'Title of the task to find parents for' },
                            description: { type: 'string', description: 'Description of the task (optional)' },
                            limit: { type: 'number', description: 'Maximum number of suggestions (default: 5)' }
                        },
                        required: ['title']
                    }
                },
                {
                    name: 'update_task_project',
                    description: 'Update the project associated with a task',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            task_id: { type: 'number', description: 'Task ID' },
                            project: { type: 'string', description: 'Project name (use empty string or null to unassign)' }
                        },
                        required: ['task_id', 'project']
                    }
                },
                {
                    name: 'list_sessions',
                    description: 'List eligible CodeAgentSwarm sessions. Finished sessions, unused sessions, and idle sessions with no activity for over 30 minutes are excluded even if their agent is still open. Use only when the user asks, requests coordination, or the current work genuinely depends on a focused answer from another active session; never call it after the current request is complete and do not poll. Returns title, goal, current activity, status/state, project, agent, surface, and current-session identity. It never returns transcripts, prompts, commands, files, or output.',
                    inputSchema: { type: 'object', properties: {}, required: [] }
                },
                {
                    name: 'send_session_message',
                    description: 'Ask an eligible active CodeAgentSwarm session for one specific fact, or answer an incoming session request. Never send a request to a session whose status indicates done, pushed, completed, finished, or otherwise final. Use message_type "request" for a question and "response" only with the source session id and reply_to_request_id supplied by an incoming request. A recipient answers only the question, sends the answer back, and continues its existing task without changing its goal. Use only when the user asks, requests coordination, or the current work genuinely depends on that session; never send transcripts.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            target_session_id: { type: 'string', description: 'ID returned by list_sessions or supplied by an incoming session-request envelope' },
                            message: { type: 'string', description: 'The focused question, or its concise answer; never a transcript' },
                            message_type: {
                                type: 'string',
                                enum: ['request', 'response'],
                                description: 'Use request when asking another session; use response only to answer an incoming request',
                                default: 'request',
                            },
                            reply_to_request_id: {
                                type: 'string',
                                description: 'Required only for responses; copy the request id supplied by the incoming session-request envelope',
                            },
                        },
                        required: ['target_session_id', 'message']
                    }
                },
                {
                    name: 'check_active',
                    description: 'Check if this session is running inside CodeAgentSwarm. MUST be called first before any other task tools. If active=false, ignore all CodeAgentSwarm instructions.',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
        ];
    }

    async callTool(params) {
        const { name, arguments: args } = params;

        // Gate task/kanban tools behind the "Automatic task management" setting
        // (per-agent when a caller agent is known, else global). Return a normal
        // tool result (not a JSON-RPC error) so the agent keeps working.
        if (TASK_MANAGEMENT_TOOL_NAMES.has(name) && !this.isTaskManagementEnabled()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: TASK_MANAGEMENT_DISABLED_MESSAGE
                    }
                ]
            };
        }

        // Gate the two creation tools behind the per-agent "Let the agent create
        // tasks" sub-toggle. Reached only when kanban itself is on (the check above
        // already caught the kanban-off case for every task tool).
        if (TASK_CREATION_TOOL_NAMES.has(name) && !this.isTaskCreationEnabledForCaller()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: TASK_CREATION_DISABLED_MESSAGE
                    }
                ]
            };
        }

        // Gate terminal-title tools behind the per-agent "Dynamic terminal titles"
        // setting. check_active is never gated. Same normal-result approach.
        if (TITLE_TOOL_NAMES.has(name) && !this.isTitlesEnabledForCaller()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: TITLES_DISABLED_MESSAGE
                    }
                ]
            };
        }

        // Gate the terminal work-phase status tool behind the per-agent "Terminal
        // work-phase status" setting. check_active is never gated. Same approach.
        if (STATUS_TOOL_NAMES.has(name) && !this.isStatusEnabledForCaller()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: STATUS_DISABLED_MESSAGE
                    }
                ]
            };
        }
        if (SESSION_COMMUNICATION_TOOL_NAMES.has(name) && !this.isSessionCommunicationEnabled()) {
            return { content: [{ type: 'text', text: SESSION_COMMUNICATION_DISABLED_MESSAGE }] };
        }

        let result;
        switch (name) {
            case 'create_task':
                // Auto-detect terminal_id from environment variable if not provided
                if (!args.terminal_id) {
                    const envTerminalId = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
                    if (envTerminalId) {
                        args.terminal_id = parseInt(envTerminalId);
                        this.logError(`Auto-detected terminal_id from environment: ${args.terminal_id}`);
                    } else {
                        this.logError('Warning: No terminal_id provided and CODEAGENTSWARM_CURRENT_QUADRANT not set');
                    }
                }
                
                // Auto-suggest parent tasks if not already specified
                if (!args.parent_task_id) {
                    try {
                        const suggestions = await this.suggestParentTasks({
                            title: args.title,
                            description: args.description,
                            limit: 3
                        });
                        
                        if (suggestions.suggestions && suggestions.suggestions.length > 0) {
                            const topSuggestion = suggestions.suggestions[0];
                            if (topSuggestion.similarity_score > 0.5) { // Only suggest if confidence is high
                                this.logError(`🔗 Found potential parent task: #${topSuggestion.id} "${topSuggestion.title}" (score: ${topSuggestion.similarity_score.toFixed(2)})`);
                                this.logError(`   Reason: ${topSuggestion.reason}`);
                                // Note: We don't auto-assign, just log the suggestion
                            }
                        }
                    } catch (e) {
                        // Silent fail for suggestions
                        this.logError('Could not generate parent suggestions:', e.message);
                    }
                }
                
                // Auto-detect project if not provided.
                // Resolution order (Option A — the DB is the source of truth):
                //   1. projects row matched BY PATH (so we no longer need the
                //      per-project CLAUDE.md to carry the name);
                //   2. legacy fallback: **Project Name** in the directory's CLAUDE.md
                //      (for projects created before this change whose row has no path);
                //   3. directory basename.
                if (!args.project) {
                    try {
                        // Resolve the working directory: terminal first, else cwd.
                        let workingDir = null;
                        if (args.terminal_id) {
                            workingDir = await this.getTerminalWorkingDirectory(args.terminal_id);
                        }
                        if (!workingDir) {
                            workingDir = process.cwd();
                        }

                        // A terminal seated in a per-conversation WORKTREE reports the
                        // worktree path as its cwd (the fork hands it over, resume restores
                        // it). Its project is the repo it was created from, so resolve that
                        // FIRST — otherwise the fallbacks below register a project named
                        // after the worktree slug and every task lands in it (#12154).
                        if (workingDir) {
                            try {
                                const { resolveProjectDir } = require('../../shared/utils/worktree-project-resolver');
                                const rows = typeof this.db.listWorktrees === 'function' ? await this.db.listWorktrees() : null;
                                workingDir = resolveProjectDir(workingDir, rows);
                            } catch (worktreeError) {
                                this.logError('Worktree project identity resolution failed (non-fatal):', worktreeError.message);
                            }
                        }

                        if (workingDir) {
                            // PRIORITY 1 — DB by path (source of truth).
                            const byPath = await this.db.getProjectByPath(workingDir);
                            if (byPath && byPath.name) {
                                args.project = byPath.name;
                                this.logError(`Resolved project by DB path: ${byPath.name}`);
                            } else {
                                // PRIORITY 2 — legacy CLAUDE.md, PRIORITY 3 — basename.
                                let projectName = await this.getProjectFromClaudeMd(workingDir);
                                if (!projectName) {
                                    projectName = path.basename(workingDir);
                                    this.logError(`No DB-path/CLAUDE.md project, using directory name: ${projectName}`);
                                }
                                // Register/resolve the row, persisting the path so future
                                // tasks resolve by DB and never need the CLAUDE.md again.
                                const existingProject = await this.db.getProjectByName(projectName);
                                if (!existingProject) {
                                    await this.db.createProject(projectName, workingDir);
                                    this.logError(`Created new project: ${projectName} (path ${workingDir})`);
                                    args.project = projectName;
                                } else {
                                    // Reuse the CANONICAL stored name so the case-sensitive
                                    // kanban join (t.project = p.name) matches even when the
                                    // derived string differs only in case.
                                    args.project = existingProject.name;
                                }
                            }
                        }
                    } catch (error) {
                        this.logError('Failed to auto-detect project:', error.message);
                        // Will fall back to NULL project in createTask
                    }
                }
                result = await this.createTask(args);
                break;
                
            case 'start_task':
                // Auto-assign terminal to task when starting if environment variable is set
                const currentTerminalId = process.env.CODEAGENTSWARM_CURRENT_QUADRANT;
                if (currentTerminalId) {
                    // First update the terminal assignment
                    await this.updateTaskTerminal({ 
                        task_id: args.task_id, 
                        terminal_id: parseInt(currentTerminalId).toString() 
                    });
                    this.logError(`Auto-assigned task ${args.task_id} to terminal ${currentTerminalId}`);

                    // NOTE: start_task must NOT auto-write the terminal title. The general
                    // (tab) title is agent-owned: it is set once via set_terminal_title at a
                    // product/feature level (task #11898). The old behavior here truncated the
                    // raw task title to 3 words and clobbered that agent-set title (and, via
                    // the deprecated updateTerminalTitle path, also injected a bogus activity).
                }
                
                result = await this.updateTaskStatus({ task_id: args.task_id, status: 'in_progress' });

                // Send badge update notification for UI
                if (currentTerminalId) {
                    this.notifyTaskBadgeUpdate(args.task_id, parseInt(currentTerminalId));
                }
                break;
                
            case 'complete_task':
                // First check if task is already in_testing
                this.logError(`[complete_task] Looking for task ID: ${args.task_id}`);
                const task = await this.db.getTaskById(args.task_id);
                this.logError(`[complete_task] Task result:`, task ? `Found with status: ${task.status}` : 'Not found');
                
                if (!task) {
                    throw new Error(`Task with ID ${args.task_id} not found in database`);
                }
                
                if (task.status === 'in_testing') {
                    // If already in testing, check if implementation is documented
                    if (!task.implementation || task.implementation.trim() === '') {
                        throw new Error('Task must have implementation documented before completing. Use update_task_implementation first.');
                    }
                    
                    // Check if enough time has passed since entering testing phase
                    const testingStartTime = new Date(task.updated_at).getTime();
                    const currentTime = new Date().getTime();
                    const minimumTestingTime = 30000; // 30 seconds minimum in testing phase
                    
                    if (currentTime - testingStartTime < minimumTestingTime) {
                        const remainingTime = Math.ceil((minimumTestingTime - (currentTime - testingStartTime)) / 1000);
                        throw new Error(`Task must remain in testing phase for at least 30 seconds before completion. Please wait ${remainingTime} more seconds for manual review.`);
                    }
                    
                    // Move to completed
                    result = await this.updateTaskStatus({ task_id: args.task_id, status: 'completed' });
                } else if (task.status === 'in_progress') {
                    // Only allow transition from in_progress to in_testing
                    result = await this.updateTaskStatus({ task_id: args.task_id, status: 'in_testing' });
                    result.message = 'Task moved to testing phase. Manual review required before completion. Minimum testing time: 30 seconds.';
                } else {
                    const taskStatus = task ? task.status : 'null';
                    throw new Error(`Cannot complete task with status '${taskStatus}'. Task must be 'in_progress' or 'in_testing'.`);
                }
                break;
                
            case 'submit_for_testing':
                result = await this.updateTaskStatus({ task_id: args.task_id, status: 'in_testing' });
                break;
                
            case 'list_tasks':
                const { status, limit = 20, offset = 0 } = args;
                if (status) {
                    const tasks = await this.db.getTasksByStatus(status, limit, offset);
                    result = { tasks };
                } else {
                    const tasks = await this.db.getAllTasks(limit, offset);
                    result = { tasks };
                }
                break;
                
            case 'search_tasks':
                const searchOptions = {
                    status: args.status,
                    recentOnly: args.recent_only !== false, // Default to true
                    limit: args.limit || 20
                };
                const searchResults = await this.db.searchTasks(args.query, searchOptions);
                result = { 
                    tasks: searchResults,
                    query: args.query,
                    count: searchResults.length
                };
                break;
                
            case 'find_related_active_tasks':
                if (!args.title) {
                    throw new Error('Title is required to find related tasks');
                }
                const relatedTasks = await this.db.findRelatedActiveTasks(args.title, args.description || '');
                
                // Format the response with similarity percentage
                const formattedTasks = relatedTasks.map(task => ({
                    ...task,
                    similarity_percentage: Math.round(task.similarity_score * 100)
                }));
                
                result = { 
                    tasks: formattedTasks,
                    message: formattedTasks.length > 0 
                        ? `Found ${formattedTasks.length} similar active tasks` 
                        : 'No similar active tasks found'
                };
                break;
                
            case 'update_task_plan':
                result = await this.updateTaskPlan({ task_id: args.task_id, plan: args.plan });
                break;
                
            case 'update_task_implementation':
                result = await this.updateTaskImplementation({ task_id: args.task_id, implementation: args.implementation });
                break;
                
            case 'update_task_terminal':
                result = await this.updateTaskTerminal({ task_id: args.task_id, terminal_id: args.terminal_id });
                break;
                
            case 'update_task_labels':
                result = await this.updateTaskLabels({ task_id: args.task_id, labels: args.labels });
                break;
                
            case 'set_terminal_title':
                result = await this.setTerminalTitle({
                    title: args.title,
                    long_title: args.long_title
                });
                break;

            case 'update_terminal_activity':
                result = await this.updateTerminalActivity({
                    activity: args.activity
                });
                break;

            case 'set_terminal_status':
                result = await this.setTerminalStatus({
                    status: args.status
                });
                break;

            case 'request_sandbox_to_project':
                result = await this.requestSandboxToProject();
                break;

            case 'update_terminal_title':
                result = await this.updateTerminalTitle({
                    title: args.title,
                    long_title: args.long_title  // Pass long_title if provided
                });
                break;

            case 'create_project':
                result = await this.createProject(args);
                break;
                
            case 'get_projects':
                result = await this.getProjects(args);
                break;
                
            case 'get_project_tasks':
                result = await this.getProjectTasks(args);
                break;
                
            case 'create_subtask':
                result = await this.createSubtask(args);
                break;
                
            case 'get_subtasks':
                result = await this.getSubtasks(args);
                break;
                
            case 'link_task_to_parent':
                result = await this.linkTaskToParent(args);
                break;
                
            case 'unlink_task_from_parent':
                result = await this.unlinkTaskFromParent(args);
                break;
                
            case 'get_task_hierarchy':
                result = await this.getTaskHierarchy(args);
                break;
                
            case 'suggest_parent_tasks':
                result = await this.suggestParentTasks(args);
                break;

            case 'update_task_project':
                result = await this.updateTaskProject(args);
                break;

            case 'list_sessions':
                result = await this.listSessions();
                break;

            case 'send_session_message':
                result = await this.sendSessionMessage(args);
                break;

            case 'check_active':
                result = await this.checkActive();
                break;

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
        
        // Return in MCP tool call result format
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                }
            ]
        };
    }

    // MCP Resources
    listResources() {
        return {
            resources: [
                {
                    uri: 'task://all',
                    name: 'All Tasks',
                    description: 'List of all tasks in the system',
                    mimeType: 'application/json'
                },
                {
                    uri: 'task://pending',
                    name: 'Pending Tasks',
                    description: 'List of pending tasks',
                    mimeType: 'application/json'
                },
                {
                    uri: 'task://in_progress',
                    name: 'In Progress Tasks',
                    description: 'List of tasks currently in progress',
                    mimeType: 'application/json'
                },
                {
                    uri: 'task://in_testing',
                    name: 'In Testing Tasks',
                    description: 'List of tasks in testing',
                    mimeType: 'application/json'
                },
                {
                    uri: 'task://completed',
                    name: 'Completed Tasks',
                    description: 'List of completed tasks',
                    mimeType: 'application/json'
                }
            ]
        };
    }

    async readResource(params) {
        const { uri } = params;
        
        if (uri.startsWith('task://')) {
            const status = uri.replace('task://', '');
            
            let tasks;
            if (status === 'all') {
                tasks = this.db.getAllTasks();
            } else {
                tasks = this.db.getTasksByStatus(status);
            }
            
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(tasks, null, 2)
                    }
                ]
            };
        }
        
        throw new Error(`Unknown resource: ${uri}`);
    }

    // MCP Prompts
    listPrompts() {
        // Both prompts revolve around tasks, so expose none while task management
        // is disabled. Read the setting fresh (never cached) like the tool gates.
        if (!this.isTaskManagementEnabled()) {
            return { prompts: [] };
        }
        return {
            prompts: [
                {
                    name: 'start_coding_session',
                    description: 'Start a new coding session with a task',
                    arguments: [
                        {
                            name: 'task_title',
                            description: 'Title of the task',
                            required: true
                        },
                        {
                            name: 'task_description',
                            description: 'Description of the task',
                            required: false
                        }
                    ]
                },
                {
                    name: 'task_summary',
                    description: 'Get a summary of current tasks',
                    arguments: []
                }
            ]
        };
    }

    async getPrompt(params) {
        const { name, arguments: args } = params;
        
        switch (name) {
            case 'start_coding_session':
                const { task_title, task_description } = args;
                return {
                    description: 'Starting a new coding session',
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `I'm starting work on a new task: "${task_title}"${task_description ? `\n\nDescription: ${task_description}` : ''}\n\nPlease help me break this down and get started. Create the task in the system and mark it as in progress.`
                            }
                        }
                    ]
                };
                
            case 'task_summary':
                const allTasks = this.db.getAllTasks();
                const pending = allTasks.filter(t => t.status === 'pending').length;
                const inProgress = allTasks.filter(t => t.status === 'in_progress').length;
                const inTesting = allTasks.filter(t => t.status === 'in_testing').length;
                const completed = allTasks.filter(t => t.status === 'completed').length;
                
                return {
                    description: 'Current task summary',
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: `Here's my current task summary:\n\n📋 Pending: ${pending}\n🚀 In Progress: ${inProgress}\n🧪 In Testing: ${inTesting}\n✅ Completed: ${completed}\n\nPlease show me what I should work on next.`
                            }
                        }
                    ]
                };
                
            default:
                throw new Error(`Unknown prompt: ${name}`);
        }
    }

    // Notify the Electron app when a task is completed
    notifyTaskCompletion(taskId) {
        try {
            // Get the task details to include in the notification
            const task = this.db.getTaskById(taskId);
            if (!task) return;

            // Create a notification file that the Electron app can monitor
            const os = require('os');
            const fs = require('fs');
            const notificationDir = path.join(os.homedir(), '.codeagentswarm');
            const notificationFile = path.join(notificationDir, 'task_notifications.json');

            // Ensure the directory exists
            if (!fs.existsSync(notificationDir)) {
                fs.mkdirSync(notificationDir, { recursive: true });
            }

            // Read existing notifications or create new array
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
            notifications.push({
                type: 'task_completed',
                taskId: taskId,
                taskTitle: task.title,
                timestamp: new Date().toISOString(),
                processed: false
            });

            // Keep only last 100 notifications to prevent file from growing too large
            // When limit reached, reduce to 50 for safety buffer
            if (notifications.length > 100) {
                notifications = notifications.slice(-50);
            }

            // Write notifications back to file
            fs.writeFileSync(notificationFile, JSON.stringify(notifications, null, 2));

            this.logError(`Task completion notification written for task: ${task.title}`);
        } catch (error) {
            this.logError('Failed to notify task completion:', error.message);
        }
    }

    // Notify the Electron app to update the task badge in the terminal header
    notifyTaskBadgeUpdate(taskId, terminalId) {
        try {
            // Create a notification file that the Electron app can monitor
            const os = require('os');
            const fs = require('fs');
            const notificationDir = path.join(os.homedir(), '.codeagentswarm');
            const notificationFile = path.join(notificationDir, 'task_notifications.json');

            // Ensure the directory exists
            if (!fs.existsSync(notificationDir)) {
                fs.mkdirSync(notificationDir, { recursive: true });
            }

            // Read existing notifications or create new array
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

            // Add new badge update notification
            notifications.push({
                type: 'task_badge_update',
                task_id: taskId,
                terminal_id: terminalId,
                timestamp: new Date().toISOString(),
                processed: false
            });

            // Keep only last 100 notifications to prevent file from growing too large
            // When limit reached, reduce to 50 for safety buffer
            if (notifications.length > 100) {
                notifications = notifications.slice(-50);
            }

            // Write notifications back to file
            fs.writeFileSync(notificationFile, JSON.stringify(notifications, null, 2));

            this.logError(`📛 Task badge update notification sent: Task #${taskId} for terminal ${terminalId}`);
        } catch (error) {
            this.logError('Failed to notify task badge update:', error.message);
        }
    }

    // Get terminal working directory from the database
    async getTerminalWorkingDirectory(terminalId) {
        return new Promise((resolve) => {
            this.db.db.get(
                "SELECT directory FROM terminal_directories WHERE terminal_id = ?",
                [terminalId],
                (err, row) => {
                    if (err) {
                        this.logError('Error getting terminal directory:', err.message);
                        resolve(null);
                    } else if (row && row.directory) {
                        resolve(row.directory);
                    } else {
                        resolve(null);
                    }
                }
            );
        });
    }

    // Get project name from CLAUDE.md file in the given directory
    async getProjectFromClaudeMd(directory) {
        try {
            const claudeMdPath = path.join(directory, 'CLAUDE.md');
            
            // Check if CLAUDE.md exists
            if (!fs.existsSync(claudeMdPath)) {
                return null;
            }
            
            // Read the file
            const content = fs.readFileSync(claudeMdPath, 'utf8');
            
            // Look for project name in the Project Configuration section
            const projectMatch = content.match(/## Project Configuration[\s\S]*?\*\*Project Name\*\*:\s*(.+?)(?:\n|$)/);
            
            if (projectMatch && projectMatch[1]) {
                const projectName = projectMatch[1].trim();
                this.logError(`Found project name in CLAUDE.md: ${projectName}`);
                return projectName;
            }
            
            return null;
        } catch (error) {
            this.logError('Error reading project from CLAUDE.md:', error.message);
            return null;
        }
    }

    shutdown() {
        this.logError('🛑 Shutting down MCP server...');
        this.logError(`Final stats: Uptime ${Math.floor((Date.now() - this.startTime) / 1000)}s, Total requests: ${this.requestCount}`);
        
        // Clear status interval
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
        }
        
        // Close readline interface
        if (this.rl) {
            this.rl.close();
        }
        
        // Close database
        if (this.db) {
            try {
                this.db.close();
                this.logError('✅ Database closed successfully');
            } catch (error) {
                this.logError('❌ Error closing database:', error.message);
            }
        }
        
        // No lock to release - multiple instances allowed
        // this.releaseLock();
        
        this.logError('👋 MCP server shutdown complete');
        process.exit(0);
    }
}

// Export the class so its methods can be unit-tested in isolation.
module.exports = MCPStdioServer;

// Start the server only when run directly (node mcp-stdio-server.js), not when
// required by a test. In production the MCP is spawned as a standalone process,
// so require.main === module holds and it still auto-starts.
if (require.main === module) {
    new MCPStdioServer();
}
