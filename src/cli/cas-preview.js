#!/usr/bin/env node

const http = require('http');
const os = require('os');
const path = require('path');
const {
  DEFAULT_TTL_MS,
  EphemeralPreviewService,
  createPreviewServers,
} = require('../infrastructure/headless/ephemeral-preview-service');

function defaultSocketPath() {
  if (process.env.CAS_PREVIEW_SOCKET) return path.resolve(process.env.CAS_PREVIEW_SOCKET);
  if (process.env.XDG_RUNTIME_DIR && path.isAbsolute(process.env.XDG_RUNTIME_DIR)) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'cas-preview.sock');
  }
  const identity = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `cas-preview-${identity}.sock`);
}

const DEFAULT_SOCKET = defaultSocketPath();

function help() {
  return `CAS ephemeral development previews

Usage:
  cas-preview start --cwd DIR --port PORT -- COMMAND [ARGS...]
  cas-preview list
  cas-preview stop LEASE_ID
  cas-preview serve [--listen HOST] [--port PORT] [--socket PATH]
                    [--root DIR] [--public-origin URL] [--ttl-seconds N]

Every process started by this service has a hard two-hour TTL by default.
The service refuses to adopt or terminate processes it did not start.`;
}

function takeOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function controlRequest(socketPath, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          reject(new Error(`Preview service returned HTTP ${response.statusCode}`));
          return;
        }
        if ((response.statusCode || 500) >= 400) reject(new Error(value.error || `Preview service returned HTTP ${response.statusCode}`));
        else resolve(value);
      });
    });
    request.once('error', (error) => reject(new Error(`Cannot reach the preview service at ${socketPath}: ${error.message}`)));
    if (payload) request.end(payload);
    else request.end();
  });
}

async function serve(args) {
  const listenHost = takeOption(args, '--listen', '127.0.0.1');
  const listenPort = Number(takeOption(args, '--port', '41820'));
  const socketPath = path.resolve(takeOption(args, '--socket', DEFAULT_SOCKET));
  const root = path.resolve(takeOption(args, '--root', process.env.CAS_PREVIEW_ROOT || process.cwd()));
  const ttlSeconds = Number(takeOption(args, '--ttl-seconds', String(DEFAULT_TTL_MS / 1000)));
  const publicOrigin = takeOption(
    args,
    '--public-origin',
    process.env.CAS_PREVIEW_PUBLIC_ORIGIN || `http://${listenHost}:${listenPort}`,
  );
  if (args.length) throw new Error(`Unknown serve arguments: ${args.join(' ')}`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(listenHost)) {
    throw new Error('Preview service must listen on loopback; place a TLS reverse proxy in front of it');
  }
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Invalid listen port');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('Invalid TTL');

  const service = new EphemeralPreviewService({ root, publicOrigin, ttlMs: ttlSeconds * 1000 });
  const servers = createPreviewServers(service, { listenHost, listenPort, socketPath });
  await servers.listen();
  console.log(`CAS preview service listening on http://${listenHost}:${listenPort}`);
  console.log(`Public origin: ${service.publicOrigin}; root: ${service.root}`);
  console.log(`Control socket: ${socketPath}; TTL: ${ttlSeconds} seconds`);

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}; stopping ephemeral previews`);
    await servers.close();
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => close('SIGTERM').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => close('SIGINT').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }));
}

async function start(args) {
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) throw new Error('Pass the server command after --');
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  const socketPath = path.resolve(takeOption(options, '--socket', DEFAULT_SOCKET));
  const cwd = path.resolve(takeOption(options, '--cwd', process.cwd()));
  const port = Number(takeOption(options, '--port'));
  const json = options.includes('--json');
  if (json) options.splice(options.indexOf('--json'), 1);
  if (options.length) throw new Error(`Unknown start arguments: ${options.join(' ')}`);
  const { lease } = await controlRequest(socketPath, 'POST', '/leases', { cwd, port, command });
  if (json) console.log(JSON.stringify(lease));
  else {
    console.log(lease.url);
    console.log(`Lease: ${lease.id}`);
    console.log(`Expires: ${new Date(lease.expiresAt).toISOString()}`);
  }
}

async function list(args) {
  const socketPath = path.resolve(takeOption(args, '--socket', DEFAULT_SOCKET));
  if (args.length) throw new Error(`Unknown list arguments: ${args.join(' ')}`);
  const { leases } = await controlRequest(socketPath, 'GET', '/leases');
  if (!leases.length) {
    console.log('No active ephemeral previews.');
    return;
  }
  for (const lease of leases) console.log(`${lease.id}\t${new Date(lease.expiresAt).toISOString()}\t${lease.url}`);
}

async function stop(args) {
  const socketPath = path.resolve(takeOption(args, '--socket', DEFAULT_SOCKET));
  const id = args.shift();
  if (!id || args.length) throw new Error('Usage: cas-preview stop LEASE_ID');
  await controlRequest(socketPath, 'DELETE', `/leases/${encodeURIComponent(id)}`);
  console.log(`Stopped preview ${id}.`);
}

async function main(argv = process.argv.slice(2)) {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) throw new Error(`Node.js 20 or newer is required; found ${process.version}`);
  const args = [...argv];
  const command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(help());
    return;
  }
  if (command === 'serve') return serve(args);
  if (command === 'start') return start(args);
  if (command === 'list') return list(args);
  if (command === 'stop') return stop(args);
  throw new Error(`Unknown command: ${command}\n\n${help()}`);
}

if (require.main === module) {
  Promise.resolve(main()).catch((error) => {
    console.error(`cas-preview: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { controlRequest, defaultSocketPath, help, main };
