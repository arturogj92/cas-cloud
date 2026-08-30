const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_REWRITE_BYTES = 10 * 1024 * 1024;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function projectSlug(projectPath) {
  const name = path.basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'project';
  const digest = crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 8);
  return `${name}-${digest}`;
}

function previewPrefix(lease) {
  return `/${lease.projectSlug}/${lease.id}`;
}

function normalizePublicOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('Preview public origin must be a valid HTTP or HTTPS origin');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Preview public origin must contain only an HTTP or HTTPS origin');
  }
  return origin.origin;
}

function rewritePreviewText(value, origin, proxyBase) {
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value
    .replace(new RegExp(escapedOrigin, 'g'), proxyBase)
    .replace(/\b(href|src|action)=(['"])\/(?!\/)/gi, `$1=$2${proxyBase}/`)
    .replace(/\b(url\(\s*['"]?)\/(?!\/)/gi, `$1${proxyBase}/`)
    .replace(/\b((?:from|import)\s*\(?\s*['"])\/(?!\/)/g, `$1${proxyBase}/`)
    .replace(/\b((?:fetch|new URL)\s*\(\s*['"])\/(?!\/)/g, `$1${proxyBase}/`)
    .replace(/(sourceMappingURL=)\/(?!\/)/g, `$1${proxyBase}/`);
}

function canConnect(port, host = '127.0.0.1', timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canConnectSocket(socketPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function hasWildcardListener(port) {
  if (process.platform !== 'linux') return false;
  const expectedPort = Number(port).toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows;
    try {
      rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1);
    } catch {
      continue;
    }
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [address, portHex] = fields[1].split(':');
      if (portHex === expectedPort && /^0+$/.test(address)) return true;
    }
  }
  return false;
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function childEnvironment(lease) {
  const allowed = [
    'COLORTERM', 'FORCE_COLOR', 'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'NO_COLOR',
    'PATH', 'SHELL', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USER',
    'COREPACK_HOME', 'NVM_BIN', 'NVM_DIR', 'PNPM_HOME',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  ];
  const environment = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return {
    ...environment,
    BROWSER: 'none',
    HOST: '127.0.0.1',
    PORT: String(lease.port),
    CAS_PREVIEW_BASE_PATH: `${previewPrefix(lease)}/`,
  };
}

function stripRoutingCookie(value) {
  if (!value) return value;
  return value.split(';')
    .map((part) => part.trim())
    .filter((part) => !part.startsWith('cas_preview='))
    .join('; ');
}

function proxyHeaders(request, lease, targetPath) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && name !== 'host' && name !== 'content-length') headers[name] = value;
  }
  const prefix = previewPrefix(lease);
  const upstreamOrigin = `http://127.0.0.1:${lease.port}`;
  headers.host = `127.0.0.1:${lease.port}`;
  headers['x-forwarded-host'] = request.headers.host || '';
  headers['x-forwarded-proto'] = new URL(lease.publicOrigin).protocol.slice(0, -1);
  headers['x-forwarded-prefix'] = prefix;
  headers['accept-encoding'] = 'identity';
  if (request.headers.origin) headers.origin = upstreamOrigin;
  if (request.headers.referer) headers.referer = `${upstreamOrigin}${targetPath}`;
  const cookie = stripRoutingCookie(request.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  return headers;
}

function parseCookies(value) {
  return String(value || '').split(';').reduce((cookies, entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return cookies;
    cookies[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
    return cookies;
  }, {});
}

class EphemeralPreviewService {
  constructor({
    root,
    publicOrigin,
    ttlMs = DEFAULT_TTL_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    now = Date.now,
    spawnImpl = spawn,
    logger = console,
  } = {}) {
    if (!root) throw new Error('EphemeralPreviewService requires a project root');
    if (!publicOrigin) throw new Error('EphemeralPreviewService requires a public origin');
    this.root = fs.realpathSync(root);
    this.publicOrigin = normalizePublicOrigin(publicOrigin);
    this.ttlMs = ttlMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.now = now;
    this.spawn = spawnImpl;
    this.logger = logger;
    this.leases = new Map();
    this.tombstones = new Map();
  }

  prune() {
    const current = this.now();
    for (const [id, stoppedAt] of this.tombstones) {
      if (stoppedAt + TOMBSTONE_TTL_MS <= current) this.tombstones.delete(id);
    }
  }

  resolveLease(id) {
    const lease = this.leases.get(id);
    if (lease && lease.expiresAt <= this.now()) {
      this.stopLease(id, 'expired').catch((error) => this.logger.error?.(error));
      return { expired: true };
    }
    if (lease) return { lease };
    if (this.tombstones.has(id)) return { expired: true };
    return null;
  }

  publicLease(lease) {
    return {
      id: lease.id,
      project: lease.projectSlug,
      cwd: lease.cwd,
      port: lease.port,
      command: lease.command,
      createdAt: lease.createdAt,
      expiresAt: lease.expiresAt,
      url: `${this.publicOrigin}${previewPrefix(lease)}/`,
    };
  }

  async startLease({ cwd, port, command }) {
    this.prune();
    const resolvedCwd = fs.realpathSync(path.resolve(cwd || ''));
    if (!isInside(this.root, resolvedCwd)) {
      throw new Error(`Preview projects must be inside ${this.root}`);
    }
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) {
      throw new Error('Preview port must be an integer from 1024 to 65535');
    }
    if (!Array.isArray(command) || !command.length || !command[0]
      || command.some((value) => typeof value !== 'string')) {
      throw new Error('Preview command is required after --');
    }
    if ([...this.leases.values()].some((lease) => lease.port === numericPort)) {
      throw new Error(`Port ${numericPort} already belongs to an active preview`);
    }
    if (await canConnect(numericPort)) {
      throw new Error(`Port ${numericPort} is already in use; refusing to adopt an unmanaged process`);
    }

    const createdAt = this.now();
    const lease = {
      id: crypto.randomBytes(18).toString('base64url'),
      projectSlug: projectSlug(resolvedCwd),
      cwd: resolvedCwd,
      port: numericPort,
      command: [...command],
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      publicOrigin: this.publicOrigin,
      child: null,
      timer: null,
      stopping: false,
      spawnError: null,
    };
    const child = this.spawn(command[0], command.slice(1), {
      cwd: resolvedCwd,
      detached: process.platform !== 'win32',
      env: childEnvironment(lease),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lease.child = child;
    this.leases.set(lease.id, lease);
    const log = (stream, chunk) => {
      const output = String(chunk).trimEnd();
      if (output) this.logger[stream]?.(`[preview ${lease.projectSlug}/${lease.id.slice(0, 8)}] ${output}`);
    };
    child.stdout?.on('data', (chunk) => log('log', chunk));
    child.stderr?.on('data', (chunk) => log('error', chunk));
    child.once('error', (error) => {
      lease.spawnError = error;
      this.logger.error?.(`[preview ${lease.id.slice(0, 8)}] ${error.message}`);
    });
    child.once('close', () => {
      if (lease.timer) clearTimeout(lease.timer);
      if (this.leases.get(lease.id) === lease) this.leases.delete(lease.id);
      this.tombstones.set(lease.id, this.now());
    });

    const deadline = this.now() + this.readyTimeoutMs;
    while (this.now() < deadline) {
      if (lease.spawnError || child.exitCode !== null || child.signalCode !== null
        || !this.leases.has(lease.id)) break;
      if (await canConnect(numericPort)) {
        if (hasWildcardListener(numericPort)) {
          await this.stopLease(lease.id, 'unsafe wildcard listener');
          throw new Error(`Preview command must bind 127.0.0.1, not a wildcard address, on port ${numericPort}`);
        }
        lease.timer = setTimeout(() => {
          this.stopLease(lease.id, 'expired').catch((error) => this.logger.error?.(error));
        }, Math.max(0, lease.expiresAt - this.now()));
        lease.timer.unref?.();
        return this.publicLease(lease);
      }
      await delay(150);
    }

    await this.stopLease(lease.id, 'startup failed');
    if (lease.spawnError) throw new Error(`Could not start preview command: ${lease.spawnError.message}`);
    throw new Error(`Preview command did not listen on 127.0.0.1:${numericPort} within ${this.readyTimeoutMs} ms`);
  }

  async stopLease(id, reason = 'stopped') {
    const lease = this.leases.get(id);
    if (!lease) return false;
    if (lease.stopping) return true;
    lease.stopping = true;
    if (lease.timer) clearTimeout(lease.timer);
    this.logger.log?.(`[preview ${lease.projectSlug}/${lease.id.slice(0, 8)}] ${reason}; terminating process group`);
    signalProcessGroup(lease.child, 'SIGTERM');
    let forceTimer;
    const exited = await Promise.race([
      new Promise((resolve) => {
        if (lease.child.exitCode !== null || lease.child.signalCode !== null) resolve(true);
        else lease.child.once('close', () => resolve(true));
      }),
      new Promise((resolve) => {
        forceTimer = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    clearTimeout(forceTimer);
    if (!exited) signalProcessGroup(lease.child, 'SIGKILL');
    this.leases.delete(id);
    this.tombstones.set(id, this.now());
    return true;
  }

  async stopAll(reason = 'service stopping') {
    await Promise.all([...this.leases.keys()].map((id) => this.stopLease(id, reason)));
  }

  list() {
    this.prune();
    return [...this.leases.values()].flatMap((lease) => {
      const resolved = this.resolveLease(lease.id);
      return resolved?.lease ? [this.publicLease(resolved.lease)] : [];
    });
  }

  resolveRequest(request) {
    this.prune();
    const requestUrl = new URL(request.url, 'http://preview.internal');
    const segments = requestUrl.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const resolved = this.resolveLease(segments[1]);
      if (resolved?.lease && resolved.lease.projectSlug === segments[0]) {
        const rest = `/${segments.slice(2).join('/')}`;
        return { lease: resolved.lease, targetPath: `${rest}${requestUrl.search}` };
      }
      if (resolved?.expired) return resolved;
    }

    const referer = request.headers.referer;
    if (referer) {
      try {
        const refererSegments = new URL(referer).pathname.split('/').filter(Boolean);
        const resolved = this.resolveLease(refererSegments[1]);
        if (resolved?.lease && resolved.lease.projectSlug === refererSegments[0]) {
          return { lease: resolved.lease, targetPath: `${requestUrl.pathname}${requestUrl.search}` };
        }
        if (resolved?.expired) return resolved;
      } catch {
        // Invalid referrers fall through to the routing cookie.
      }
    }

    const cookieId = parseCookies(request.headers.cookie).cas_preview;
    const resolved = this.resolveLease(cookieId);
    if (resolved?.lease) return { lease: resolved.lease, targetPath: `${requestUrl.pathname}${requestUrl.search}` };
    if (resolved?.expired) return resolved;
    return null;
  }
}

function copyResponseHeaders(upstream, response, lease, rewritten) {
  const prefix = previewPrefix(lease);
  const upstreamOrigin = `http://127.0.0.1:${lease.port}`;
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || (rewritten && name === 'content-length')) continue;
    if (name === 'location' && typeof value === 'string') {
      response.setHeader(name, value.startsWith('/') ? `${prefix}${value}` : value.replace(upstreamOrigin, prefix));
    } else if (name === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value])
        .filter((cookie) => !/^cas_preview=/i.test(String(cookie)))
        .map((cookie) => String(cookie).replace(/Path=\//i, `Path=${prefix}/`));
      if (cookies.length) response.setHeader(name, cookies);
    } else {
      response.setHeader(name, value);
    }
  }
  const remainingSeconds = Math.max(0, Math.ceil((lease.expiresAt - Date.now()) / 1000));
  const secure = new URL(lease.publicOrigin).protocol === 'https:' ? '; Secure' : '';
  response.appendHeader('set-cookie', `cas_preview=${lease.id}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${remainingSeconds}`);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
}

function proxyHttp(request, response, resolved) {
  const { lease, targetPath } = resolved;
  const prefix = previewPrefix(lease);
  const upstreamOrigin = `http://127.0.0.1:${lease.port}`;
  const upstreamRequest = http.request({
    hostname: '127.0.0.1',
    port: lease.port,
    method: request.method,
    path: targetPath,
    headers: proxyHeaders(request, lease, targetPath),
  }, (upstream) => {
    const contentType = String(upstream.headers['content-type'] || '');
    const rewritten = /(?:text\/|javascript|json|xml)/i.test(contentType) && !upstream.headers['content-encoding'];
    response.statusCode = upstream.statusCode || 502;
    copyResponseHeaders(upstream, response, lease, rewritten);
    if (!rewritten || request.method === 'HEAD' || [204, 304].includes(upstream.statusCode)) {
      upstream.pipe(response);
      return;
    }
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    upstream.on('data', (chunk) => {
      total += chunk.length;
      if (total <= MAX_REWRITE_BYTES) chunks.push(chunk);
      else tooLarge = true;
    });
    upstream.on('end', () => {
      if (response.destroyed) return;
      if (tooLarge) response.destroy(new Error('Preview response exceeded rewrite limit'));
      else response.end(rewritePreviewText(Buffer.concat(chunks).toString(), upstreamOrigin, prefix));
    });
  });
  upstreamRequest.setTimeout(30_000, () => upstreamRequest.destroy(new Error('Preview upstream timed out')));
  upstreamRequest.on('error', (error) => {
    if (response.headersSent) response.destroy(error);
    else {
      response.statusCode = 502;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(`Could not reach the preview process: ${error.message}`);
    }
  });
  request.pipe(upstreamRequest);
}

function proxyUpgrade(request, socket, head, resolved) {
  const { lease, targetPath } = resolved;
  const upstreamRequest = http.request({
    hostname: '127.0.0.1',
    port: lease.port,
    method: request.method,
    path: targetPath,
    headers: { ...proxyHeaders(request, lease, targetPath), connection: 'Upgrade', upgrade: request.headers.upgrade },
  });
  upstreamRequest.once('upgrade', (upstream, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`];
    for (let index = 0; index < upstream.rawHeaders.length; index += 2) {
      lines.push(`${upstream.rawHeaders[index]}: ${upstream.rawHeaders[index + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstreamRequest.once('response', (upstream) => {
    socket.end(`HTTP/1.1 ${upstream.statusCode || 502} Preview upgrade rejected\r\nConnection: close\r\n\r\n`);
  });
  upstreamRequest.once('error', () => socket.destroy());
  upstreamRequest.end();
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_CONTROL_BODY_BYTES) request.destroy(new Error('Control request is too large'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new Error('Control request must contain valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function createPreviewServers(service, {
  listenHost = '127.0.0.1',
  listenPort = 41820,
  socketPath = '/run/cas-preview.sock',
} = {}) {
  const publicServer = http.createServer((request, response) => {
    const resolved = service.resolveRequest(request);
    if (resolved?.expired) {
      response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('This development preview has expired. Start it again from CAS Cloud.');
    } else if (!resolved) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Development preview not found.');
    } else {
      proxyHttp(request, response, resolved);
    }
  });
  publicServer.on('upgrade', (request, socket, head) => {
    const resolved = service.resolveRequest(request);
    if (!resolved || resolved.expired) {
      socket.end(`HTTP/1.1 ${resolved?.expired ? 410 : 404} Preview unavailable\r\nConnection: close\r\n\r\n`);
      return;
    }
    proxyUpgrade(request, socket, head, resolved);
  });

  const controlServer = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://control.internal');
      if (request.method === 'GET' && requestUrl.pathname === '/leases') {
        sendJson(response, 200, { leases: service.list() });
      } else if (request.method === 'POST' && requestUrl.pathname === '/leases') {
        sendJson(response, 201, { lease: await service.startLease(await readJson(request)) });
      } else if (request.method === 'DELETE' && requestUrl.pathname.startsWith('/leases/')) {
        const id = decodeURIComponent(requestUrl.pathname.slice('/leases/'.length));
        const stopped = await service.stopLease(id, 'stopped by user');
        sendJson(response, stopped ? 200 : 404, { stopped });
      } else {
        sendJson(response, 404, { error: 'Not found' });
      }
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });

  async function listen() {
    if (fs.existsSync(socketPath)) {
      if (await canConnectSocket(socketPath)) throw new Error(`Preview control socket is already active: ${socketPath}`);
      fs.unlinkSync(socketPath);
    }
    await new Promise((resolve, reject) => controlServer.once('error', reject).listen(socketPath, resolve));
    fs.chmodSync(socketPath, 0o600);
    try {
      await new Promise((resolve, reject) => publicServer.once('error', reject).listen(listenPort, listenHost, resolve));
    } catch (error) {
      await new Promise((resolve) => controlServer.close(resolve));
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      throw error;
    }
    return { listenHost, listenPort, socketPath };
  }

  async function close() {
    await service.stopAll();
    await Promise.all([publicServer, controlServer].map((server) => new Promise((resolve) => server.close(resolve))));
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  }

  return { publicServer, controlServer, listen, close };
}

module.exports = {
  DEFAULT_TTL_MS,
  EphemeralPreviewService,
  createPreviewServers,
  normalizePublicOrigin,
  previewPrefix,
  projectSlug,
  rewritePreviewText,
};
