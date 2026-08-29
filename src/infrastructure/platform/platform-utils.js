/**
 * Platform Utilities Module
 * Centralizes all platform-specific operations and utilities
 * using Strategy Pattern for cross-platform compatibility
 */

const { execSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

/**
 * Platform-specific operation strategies
 */
const platformOperations = {
  darwin: {
    /**
     * Kill a process and its children
     */
    killProcessTree(pid) {
      try {
        execSync(`pkill -TERM -P ${pid}`, { stdio: 'ignore' });
      } catch (e) {
        // Process might already be dead, ignore
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        // Ignore
      }
    },

    /**
     * Get hardware-based machine ID
     */
    getMachineId() {
      try {
        // Try to get hardware UUID
        const uuidOutput = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep UUID', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        });
        const match = uuidOutput.match(/"UUID"\s*=\s*"([^"]+)"/);
        if (match && match[1]) {
          return match[1];
        }
      } catch (e) {
        // Fallback to serial number
        try {
          const serialOutput = execSync('ioreg -l | grep IOPlatformSerialNumber', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          });
          const match = serialOutput.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
          if (match && match[1]) {
            return crypto.createHash('sha256').update(match[1]).digest('hex');
          }
        } catch (e2) {
          // Final fallback
          return crypto.createHash('sha256').update(os.hostname()).digest('hex');
        }
      }
      return crypto.createHash('sha256').update(os.hostname()).digest('hex');
    },

    /**
     * Open file location in Finder
     */
    showInFileManager(filePath) {
      execSync(`open -R "${filePath}"`);
    },

    /**
     * Get log viewer command
     */
    getLogViewCommand(logPath) {
      return `tail -f "${logPath}"`;
    },

    /**
     * Get file manager open command
     */
    getFileManagerOpenCommand(dirPath) {
      return `open "${dirPath}"`;
    }
  },

  win32: {
    /**
     * Kill a process and its children
     */
    killProcessTree(pid) {
      try {
        // Use taskkill to kill process tree
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch (e) {
        // Process might already be dead, ignore
      }
    },

    /**
     * Get hardware-based machine ID
     */
    getMachineId() {
      try {
        // Use WMIC to get motherboard serial number
        const output = execSync('wmic csproduct get UUID', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        });

        const lines = output.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length > 1 && lines[1]) {
          return lines[1];
        }
      } catch (e) {
        // Fallback to machine GUID
        try {
          const output = execSync('reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          });
          const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/);
          if (match && match[1]) {
            return match[1].trim();
          }
        } catch (e2) {
          // Final fallback
          return crypto.createHash('sha256').update(os.hostname()).digest('hex');
        }
      }
      return crypto.createHash('sha256').update(os.hostname()).digest('hex');
    },

    /**
     * Open file location in Explorer
     */
    showInFileManager(filePath) {
      execSync(`explorer /select,"${filePath}"`);
    },

    /**
     * Get log viewer command
     */
    getLogViewCommand(logPath) {
      return `Get-Content -Path "${logPath}" -Wait -Tail 10`;
    },

    /**
     * Get file manager open command
     */
    getFileManagerOpenCommand(dirPath) {
      return `explorer "${dirPath}"`;
    }
  },

  linux: {
    /**
     * Kill a process and its children
     */
    killProcessTree(pid) {
      try {
        execSync(`pkill -TERM -P ${pid}`, { stdio: 'ignore' });
      } catch (e) {
        // Process might already be dead, ignore
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        // Ignore
      }
    },

    /**
     * Get hardware-based machine ID
     */
    getMachineId() {
      try {
        // Try systemd machine-id
        const machineId = execSync('cat /etc/machine-id', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        if (machineId) {
          return machineId;
        }
      } catch (e) {
        // Fallback to DMI product UUID
        try {
          const uuid = execSync('cat /sys/class/dmi/id/product_uuid', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          }).trim();
          if (uuid) {
            return uuid;
          }
        } catch (e2) {
          // Final fallback
          return crypto.createHash('sha256').update(os.hostname()).digest('hex');
        }
      }
      return crypto.createHash('sha256').update(os.hostname()).digest('hex');
    },

    /**
     * Open file location in file manager
     */
    showInFileManager(filePath) {
      try {
        execSync(`xdg-open "$(dirname "${filePath}")"`);
      } catch (e) {
        console.error('Could not open file manager:', e);
      }
    },

    /**
     * Get log viewer command
     */
    getLogViewCommand(logPath) {
      return `tail -f "${logPath}"`;
    },

    /**
     * Get file manager open command
     */
    getFileManagerOpenCommand(dirPath) {
      return `xdg-open "${dirPath}"`;
    }
  }
};

/**
 * Get the current platform operations strategy
 */
function getCurrentOperations() {
  const platform = process.platform;
  const operations = platformOperations[platform];

  if (!operations) {
    console.warn(`Platform ${platform} not explicitly supported, using Linux defaults`);
    return platformOperations.linux;
  }

  return operations;
}

/**
 * Public API - Platform Utilities
 */
class PlatformUtils {
  constructor() {
    this.operations = getCurrentOperations();
    this.platform = process.platform;
  }

  /**
   * Kill a process and all its children
   * @param {number} pid - Process ID to kill
   */
  killProcessTree(pid) {
    this.operations.killProcessTree(pid);
  }

  /**
   * Get a unique hardware-based machine identifier
   * @returns {string} Machine ID
   */
  getMachineId() {
    return this.operations.getMachineId();
  }

  /**
   * Show a file in the system file manager
   * @param {string} filePath - Path to the file
   */
  showInFileManager(filePath) {
    this.operations.showInFileManager(filePath);
  }

  /**
   * Get the command to view logs in real-time
   * @param {string} logPath - Path to log file
   * @returns {string} Command string
   */
  getLogViewCommand(logPath) {
    return this.operations.getLogViewCommand(logPath);
  }

  /**
   * Get the command to open a directory in file manager
   * @param {string} dirPath - Path to directory
   * @returns {string} Command string
   */
  getFileManagerOpenCommand(dirPath) {
    return this.operations.getFileManagerOpenCommand(dirPath);
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
   * Execute a command cross-platform
   *
   * @param {string} command - The command to execute
   * @param {object} options - execSync options
   * @returns {string|Buffer} Command output
   */
  execCommand(command, options = {}) {
    try {
      return execSync(command, {
        encoding: 'utf8',
        ...options
      });
    } catch (error) {
      if (options.ignoreError) {
        return '';
      }
      throw error;
    }
  }

  /**
   * Check if a command exists (cross-platform)
   * Uses 'which' on Unix-like systems and 'where' on Windows
   *
   * @param {string} commandName - Name of the command to check
   * @returns {boolean} True if command exists
   */
  commandExists(commandName) {
    try {
      if (this.isWindows()) {
        execSync(`where ${commandName}`, { stdio: 'pipe' });
        return true;
      } else {
        // macOS/Linux
        execSync(`which ${commandName}`, { stdio: 'pipe' });
        return true;
      }
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the path to a command if it exists
   *
   * @param {string} commandName - Name of the command
   * @returns {string|null} Path to command or null if not found
   */
  getCommandPath(commandName) {
    try {
      if (this.isWindows()) {
        const result = execSync(`where ${commandName}`, { encoding: 'utf8', stdio: 'pipe' });
        // where returns multiple paths, get the first one
        return result.split('\n')[0].trim();
      } else {
        // macOS/Linux
        const result = execSync(`which ${commandName}`, { encoding: 'utf8', stdio: 'pipe' });
        return result.trim();
      }
    } catch (e) {
      return null;
    }
  }
}

// Export singleton instance
module.exports = new PlatformUtils();
