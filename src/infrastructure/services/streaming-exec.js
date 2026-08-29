const { spawn } = require('child_process');
const { quoteForCmd } = require('../platform/windows-direct-spawn');

function createLineReader(onLine) {
  let pending = '';

  return {
    push(chunk) {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach((line) => onLine(line));
    },
    flush() {
      if (pending) onLine(pending);
      pending = '';
    },
  };
}

/**
 * Execute a shell command with exec-compatible completion while exposing stdout
 * and stderr line-by-line. This keeps the installers' existing timeout/buffer
 * behaviour but lets the renderer show useful progress during long commands.
 *
 * @param {string} command
 * @param {Object} options
 * @param {Function} callback Receives (error, stdout, stderr), like child_process.exec.
 * @param {Function} onLine Receives each raw stdout/stderr line as it arrives.
 * @returns {import('child_process').ChildProcess}
 */
function streamingExec(command, options = {}, callback = () => {}, onLine = () => {}) {
  const maxBuffer = options.maxBuffer || 1024 * 1024;
  const args = Array.isArray(options.args) ? options.args : [];
  const isWindowsShim = process.platform === 'win32'
    && options.shell === false
    && /\.(cmd|bat)$/i.test(command);
  const spawnCommand = isWindowsShim
    ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe')
    : command;
  const spawnArgs = isWindowsShim
    ? ['/d', '/s', '/c', `"${[command, ...args].map(quoteForCmd).join(' ')}"`]
    : args;
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell === undefined ? true : options.shell,
    windowsHide: options.windowsHide,
    windowsVerbatimArguments: isWindowsShim,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  let child;
  try {
    child = spawn(spawnCommand, spawnArgs, spawnOptions);
  } catch (error) {
    error.command = command;
    error.args = [...args];
    error.cwd = options.cwd || process.cwd();
    error.stdout = '';
    error.stderr = '';
    queueMicrotask(() => callback(error, '', ''));
    return null;
  }

  let stdout = '';
  let stderr = '';
  let completed = false;
  let forcedError = null;
  let timeoutId = null;
  const stdoutLines = createLineReader(onLine);
  const stderrLines = createLineReader(onLine);

  const finish = (error) => {
    if (completed) return;
    completed = true;
    if (timeoutId) clearTimeout(timeoutId);
    stdoutLines.flush();
    stderrLines.flush();
    if (error) {
      error.command = command;
      error.args = [...args];
      error.cwd = options.cwd || process.cwd();
      error.stdout = stdout;
      error.stderr = stderr;
    }
    callback(error, stdout, stderr);
  };

  const enforceBuffer = () => {
    if (Buffer.byteLength(stdout) <= maxBuffer && Buffer.byteLength(stderr) <= maxBuffer) return;
    forcedError = new Error(`Command output exceeded maxBuffer of ${maxBuffer} bytes`);
    forcedError.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    child.kill();
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    stdoutLines.push(chunk);
    enforceBuffer();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    stderrLines.push(chunk);
    enforceBuffer();
  });

  child.on('error', (error) => finish(error));
  child.on('close', (code, signal) => {
    if (forcedError) return finish(forcedError);
    if (code === 0) return finish(null);
    const error = new Error(`Command failed with exit code ${code}${signal ? ` (${signal})` : ''}: ${command}`);
    error.code = code;
    error.signal = signal;
    error.killed = child.killed;
    finish(error);
  });

  if (options.timeout > 0) {
    timeoutId = setTimeout(() => {
      forcedError = new Error(`Command timed out after ${options.timeout}ms: ${command}`);
      forcedError.code = 'ETIMEDOUT';
      forcedError.killed = true;
      child.kill();
    }, options.timeout);
  }

  return child;
}

module.exports = { streamingExec };
