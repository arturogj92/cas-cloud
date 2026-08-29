/**
 * Platform Configuration Module
 * Centralizes all platform-specific paths, configurations, and settings
 * using Strategy Pattern to avoid scattered if/else statements
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Get all possible Claude Code installation paths on Windows
 * Ordered by priority (most common first)
 * @returns {string[]} Array of possible paths
 */
function getClaudeInstallationPaths() {
  if (process.platform !== 'win32') return [];

  const userProfile = process.env.USERPROFILE || os.homedir();
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const programData = process.env.ProgramData || 'C:\\ProgramData';

  const paths = [
    // 1. Native installer (recommended by Anthropic)
    path.join(userProfile, '.local', 'bin', 'claude.exe'),

    // 2. npm global installation
    path.join(appData, 'npm', 'claude.cmd'),
    path.join(appData, 'npm', 'claude.exe'),

    // 3. Scoop package manager
    path.join(userProfile, 'scoop', 'shims', 'claude.exe'),
    path.join(userProfile, 'scoop', 'apps', 'claude', 'current', 'claude.exe'),

    // 4. Chocolatey package manager
    path.join(programData, 'chocolatey', 'bin', 'claude.exe'),

    // 5. Alternative local installations
    path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
    path.join(localAppData, 'claude', 'claude.exe'),

    // 6. Volta (Node version manager)
    path.join(userProfile, '.volta', 'bin', 'claude.exe'),

    // 7. pnpm global
    path.join(localAppData, 'pnpm', 'claude.cmd'),
    path.join(localAppData, 'pnpm', 'claude.exe'),
  ];

  // 8. nvm-windows: Check all installed Node versions
  const nvmPath = process.env.NVM_HOME || path.join(appData, 'nvm');
  if (fs.existsSync(nvmPath)) {
    try {
      const versions = fs.readdirSync(nvmPath).filter(v => v.startsWith('v'));
      for (const version of versions) {
        paths.push(path.join(nvmPath, version, 'claude.cmd'));
        paths.push(path.join(nvmPath, version, 'claude.exe'));
      }
    } catch (e) {
      // Ignore errors reading nvm directory
    }
  }

  // 9. fnm (Fast Node Manager)
  const fnmPath = path.join(localAppData, 'fnm');
  if (fs.existsSync(fnmPath)) {
    try {
      const nodeVersionsPath = path.join(fnmPath, 'node-versions');
      if (fs.existsSync(nodeVersionsPath)) {
        const versions = fs.readdirSync(nodeVersionsPath);
        for (const version of versions) {
          paths.push(path.join(nodeVersionsPath, version, 'installation', 'claude.cmd'));
          paths.push(path.join(nodeVersionsPath, version, 'installation', 'claude.exe'));
        }
      }
    } catch (e) {
      // Ignore errors reading fnm directory
    }
  }

  return paths;
}

/**
 * Try to find Claude using where.exe command (last resort)
 * @returns {string|null} Path to claude or null
 */
function findClaudeViaWhere() {
  if (process.platform !== 'win32') return null;

  try {
    const { execSync } = require('child_process');
    const result = execSync('where.exe claude', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    const firstPath = result.split('\n')[0].trim();
    if (firstPath && fs.existsSync(firstPath)) {
      console.error(`[Platform] Claude found via where.exe: ${firstPath}`);
      return firstPath;
    }
  } catch (e) {
    // where.exe failed, claude not in PATH
  }
  return null;
}

/**
 * Detect native Claude Code installation on Windows
 * Returns the path to claude.exe if found, null otherwise
 * Uses a fallback system checking multiple installation methods
 */
function detectNativeClaudeExe() {
  if (process.platform !== 'win32') return null;

  // First, check all known installation paths
  const possiblePaths = getClaudeInstallationPaths();

  console.error(`[Platform] Checking ${possiblePaths.length} possible Claude paths...`);

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        console.error(`[Platform] ✓ Claude found at: ${p}`);
        return p;
      }
    } catch (e) {
      // Ignore access errors
    }
  }

  // Last resort: try where.exe to find claude in PATH
  console.error('[Platform] Checking PATH via where.exe...');
  const whereResult = findClaudeViaWhere();
  if (whereResult) {
    return whereResult;
  }

  console.error('[Platform] ✗ Claude not found in any known location');
  return null;
}

// Detect Native Claude at module load time (can be refreshed later)
let nativeClaudePath = detectNativeClaudeExe();

if (process.platform === 'win32') {
  console.error(`[Platform] Native Claude: ${nativeClaudePath || 'Not installed'}`);
}

/**
 * Refresh the cached native Claude path
 * Call this after installing Claude Code to update the cache
 * @returns {string|null} The new path or null if not found
 */
function refreshNativeClaudePath() {
  nativeClaudePath = detectNativeClaudeExe();
  console.error(`[Platform] Refreshed Native Claude path: ${nativeClaudePath || 'Not installed'}`);
  return nativeClaudePath;
}

/**
 * Platform-specific configuration strategies
 */
const platformStrategies = {
  darwin: {
    // macOS-specific paths
    appDataPath: () => path.join(os.homedir(), 'Library', 'Application Support', 'codeagentswarm'),
    claudeConfigPath: () => {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      return claudeJsonPath; // Primary config for Claude Code CLI
    },
    mcpLogPath: () => path.join(os.homedir(), 'Library', 'Application Support', 'codeagentswarm', 'mcp-logs'),

    // Icon paths
    appIcon: 'dmg-icon.icns',

    // Application-specific configs
    editorPaths: {
      'cursor': 'Cursor.app',
      'vscode': 'Visual Studio Code.app',
      'sublime': 'Sublime Text.app',
      'atom': 'Atom.app',
      'zed': 'Zed.app'
    },

    // Platform capabilities
    supportsDock: true,
    supportsBadge: true,

    // Shell configuration
    defaultShell: process.env.SHELL || '/bin/bash',
    shellArgs: ['-l']
  },

  win32: {
    // Windows-specific paths
    appDataPath: () => path.join(process.env.APPDATA || os.homedir(), 'codeagentswarm'),
    claudeConfigPath: () => {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      return claudeJsonPath; // Primary config for Claude Code CLI
    },
    mcpLogPath: () => path.join(process.env.APPDATA || os.homedir(), 'codeagentswarm', 'mcp-logs'),

    // Icon paths
    appIcon: 'app-icon.ico', // Multi-resolution ICO (16/24/32/48/64/128/256) for crisp rendering at every size

    // Application-specific configs
    editorPaths: {
      'cursor': 'Cursor.exe',
      'vscode': 'Code.exe',
      'sublime': 'sublime_text.exe',
      'atom': 'atom.exe',
      'zed': 'zed.exe'
    },

    // Platform capabilities
    supportsDock: false,
    supportsBadge: true, // Windows supports badge via setOverlayIcon

    // Shell configuration - Use PowerShell on Windows
    defaultShell: process.env.ComSpec || 'cmd.exe',
    shellArgs: []
  },

  linux: {
    // Linux-specific paths
    appDataPath: () => path.join(os.homedir(), '.config', 'codeagentswarm'),
    claudeConfigPath: () => {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      return claudeJsonPath; // Primary config for Claude Code CLI
    },
    mcpLogPath: () => path.join(os.homedir(), '.config', 'codeagentswarm', 'mcp-logs'),

    // Icon paths
    appIcon: 'icon.png',

    // Application-specific configs
    editorPaths: {
      'cursor': 'cursor',
      'vscode': 'code',
      'sublime': 'subl',
      'atom': 'atom',
      'zed': 'zed'
    },

    // Platform capabilities
    supportsDock: false,
    supportsBadge: false,

    // Shell configuration
    defaultShell: process.env.SHELL || '/bin/bash',
    shellArgs: ['-l']
  }
};

/**
 * Get the current platform strategy
 */
function getCurrentStrategy() {
  const platform = process.platform;
  const strategy = platformStrategies[platform];

  if (!strategy) {
    console.warn(`Platform ${platform} not explicitly supported, using Linux defaults`);
    return platformStrategies.linux;
  }

  return strategy;
}

/**
 * Public API - Platform Configuration
 */
class PlatformConfig {
  constructor() {
    this.strategy = getCurrentStrategy();
    this.platform = process.platform;
  }

  /**
   * Get the main application data directory
   */
  getAppDataPath() {
    return this.strategy.appDataPath();
  }

  /**
   * Get the Claude configuration file path
   */
  getClaudeConfigPath() {
    return this.strategy.claudeConfigPath();
  }

  /**
   * Get the MCP logs directory
   */
  getMcpLogPath() {
    return this.strategy.mcpLogPath();
  }

  /**
   * Get the database path
   */
  getDatabasePath() {
    return path.join(this.getAppDataPath(), 'codeagentswarm.db');
  }

  /**
   * Get the app icon filename (relative to assets/icons/)
   */
  getAppIcon() {
    return this.strategy.appIcon;
  }

  /**
   * Get editor executable name for a given editor
   */
  getEditorExecutable(editorName) {
    return this.strategy.editorPaths[editorName] || editorName;
  }

  /**
   * Check if platform supports macOS dock
   */
  supportsDock() {
    return this.strategy.supportsDock;
  }

  /**
   * Check if platform supports badge counts
   */
  supportsBadge() {
    return this.strategy.supportsBadge;
  }

  /**
   * Get the default shell for PTY
   */
  getDefaultShell() {
    return this.strategy.defaultShell;
  }

  /**
   * Get shell arguments for PTY
   */
  getShellArgs() {
    return this.strategy.shellArgs;
  }

  /**
   * Check if current platform is macOS
   */
  isMac() {
    return this.platform === 'darwin';
  }

  /**
   * Check if current platform is Windows
   */
  isWindows() {
    return this.platform === 'win32';
  }

  /**
   * Check if current platform is Linux
   */
  isLinux() {
    return this.platform === 'linux';
  }

  /**
   * Check if native Claude Code is installed (Windows only)
   */
  hasNativeClaude() {
    return nativeClaudePath !== null;
  }

  /**
   * Get the path to native Claude Code executable (Windows only)
   * Returns null if not installed
   */
  getNativeClaudePath() {
    return nativeClaudePath;
  }

  /**
   * Refresh the cached native Claude path after installation
   * @returns {string|null} The new path or null if not found
   */
  refreshNativeClaudePath() {
    return refreshNativeClaudePath();
  }

  /**
   * Get default directory for file dialogs
   * Returns user home directory
   */
  getDefaultBrowsePath() {
    const homePath = os.homedir();
    console.error(`[Platform] Default browse path: ${homePath}`);
    return homePath;
  }
}

// Export singleton instance
module.exports = new PlatformConfig();
