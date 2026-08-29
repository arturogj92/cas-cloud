// Logger wrapper for child processes (MCP server, webhook server, etc.)
const EventEmitter = require('events');

class ChildProcessLogger extends EventEmitter {
  constructor(sourceName) {
    super();
    this.sourceName = sourceName;
    this.enabled = process.env.ENABLE_DEBUG_LOGS === 'true' || process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
    this.intercepted = false;
    
    // Don't intercept automatically - allow tests to control this
    // this.interceptConsole();
  }

  interceptConsole() {
    if (this.intercepted) return; // Prevent double interception
    this.intercepted = true;
    
    // Store original console methods
    this.originalConsole = {
      log: console.log.bind ? console.log.bind(console) : console.log,
      error: console.error.bind ? console.error.bind(console) : console.error,
      warn: console.warn.bind ? console.warn.bind(console) : console.warn,
      info: console.info.bind ? console.info.bind(console) : console.info,
      debug: console.debug.bind ? console.debug.bind(console) : console.debug
    };

    const self = this;
    
    console.log = function(...args) {
      self.log('log', args);
      if (self.originalConsole && self.originalConsole.log) {
        self.originalConsole.log(...args);
      }
    };

    console.error = function(...args) {
      self.log('error', args);
      if (self.originalConsole && self.originalConsole.error) {
        self.originalConsole.error(...args);
      }
    };

    console.warn = function(...args) {
      self.log('warn', args);
      if (self.originalConsole && self.originalConsole.warn) {
        self.originalConsole.warn(...args);
      }
    };

    console.info = function(...args) {
      self.log('info', args);
      if (self.originalConsole && self.originalConsole.info) {
        self.originalConsole.info(...args);
      }
    };

    console.debug = function(...args) {
      self.log('debug', args);
      if (self.originalConsole && self.originalConsole.debug) {
        self.originalConsole.debug(...args);
      }
    };
  }

  log(level, args) {
    if (!this.enabled) return;

    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');

    // Emit log event that parent process can listen to
    this.emit('log', {
      source: this.sourceName,
      level,
      message,
      args,
      timestamp: new Date()
    });

    // If this is a spawned process with IPC, send to parent
    if (process.send) {
      process.send({
        type: 'log',
        data: {
          source: this.sourceName,
          level,
          message,
          timestamp: new Date().toISOString()
        }
      });
    }
  }
}

module.exports = ChildProcessLogger;