/**
 * Spawned Process Registry
 *
 * Tracks every OS process CodeAgentSwarm itself spawns (the terminal PTYs and
 * their agent children), so that exit cleanup can terminate OUR processes and
 * ONLY our processes.
 *
 * Why this exists (bug #12076, reported by a user on 1.9.0):
 * quitting the app used to run `pkill -f "claude"`, which matches the command
 * line of EVERY process on the machine. Any `claude` the user was running on
 * their own — another terminal, a background agent — was killed too. Cleanup
 * must be scoped by PID (bounded by what we spawned) and never by process name
 * (unbounded, hits processes we did not create and have no right to touch).
 */

const platformUtils = require('./platform-utils');

/**
 * A PID is only safe to signal if it is a real, positive process id.
 *
 * This guard is load-bearing, not defensive noise: `process.kill(0, ...)` and
 * `kill -TERM -1` are wildcards that signal the whole process group / every
 * process the user owns. A stray 0, -1, undefined or NaN reaching the kill call
 * would reintroduce a far worse version of the very bug this module fixes.
 */
function isKillablePid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

class SpawnedProcessRegistry {
  constructor() {
    this.processes = new Map();
  }

  /**
   * Track a process we spawned. Safe to call with anything; non-PIDs are ignored.
   * @param {number} pid
   * @param {{killDescendants?: boolean}} [options]
   */
  register(pid, { killDescendants = true } = {}) {
    if (!isKillablePid(pid)) return;
    this.processes.set(pid, { killDescendants });
  }

  /**
   * Stop tracking a process (it exited on its own, or we killed it).
   * @param {number} pid
   */
  unregister(pid) {
    this.processes.delete(pid);
  }

  /**
   * PIDs currently tracked as alive-and-ours.
   * @returns {number[]}
   */
  getTrackedPids() {
    return Array.from(this.processes.keys());
  }

  /**
   * Whether a PID is still running.
   *
   * Signal 0 performs the permission/existence check without delivering a
   * signal. EPERM means the process exists but belongs to someone else, which
   * still counts as alive.
   * @param {number} pid
   */
  isAlive(pid) {
    if (!isKillablePid(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  /**
   * Stop one tracked process using its ownership boundary.
   * @param {number} pid
   * @returns {boolean}
   */
  kill(pid) {
    const tracked = this.processes.get(pid);
    if (!tracked || !this.isAlive(pid)) return false;
    try {
      if (tracked.killDescendants) {
        platformUtils.killProcessTree(pid);
      } else {
        process.kill(pid, 'SIGKILL');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Kill every tracked process, including descendants only when the app owns
   * the whole tree, then forget them.
   *
   * This is the app's exit cleanup. It is deliberately the ONLY kill performed
   * on quit: no name matching, no wildcards, nothing that can reach a process
   * CodeAgentSwarm did not spawn.
   * @returns {number[]} the PIDs that were still alive and got killed
   */
  killAll() {
    const killed = [];

    for (const pid of this.processes.keys()) {
      if (this.kill(pid)) killed.push(pid);
    }

    this.processes.clear();
    return killed;
  }
}

module.exports = new SpawnedProcessRegistry();
module.exports.SpawnedProcessRegistry = SpawnedProcessRegistry;
