// CodeAgentSwarm Pi extension — owned integration; preserves other Pi extensions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// Pi supplies this module to extensions at runtime; it is not an app dependency.
// eslint-disable-next-line import/no-unresolved
import { VERSION } from '@earendil-works/pi-coding-agent';

export default async function codeagentswarm(pi) {
  const [major, minor, patch] = VERSION.split('.').map(Number);
  if (!(major > 0 || minor > 85 || (minor === 85 && patch >= 1))) throw new Error('Pi 0.85.1 or newer is required. Update Pi in Settings.');
  // The same extension can be discovered globally and explicitly by Chat.
  const key = Symbol.for('codeagentswarm.pi.extension');
  if (globalThis[key]) return;
  globalThis[key] = true;
  const inChat = process.env.CODEAGENTSWARM_DRIVER_CHAT === '1';
  const configDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const managedTools = new Set();
  if (process.platform === 'win32') {
    pi.on('session_start', () => {
      // Replace only Bash; preserve the user's other tools and extension tools.
      pi.setActiveTools(pi.getActiveTools().map((name) => name === 'bash' ? 'powershell' : name));
    });
  }

  if (inChat) {
    pi.on('tool_call', async (event, ctx) => {
      if (managedTools.has(event.toolName) || ['read', 'grep', 'find', 'ls'].includes(event.toolName)) return;
      const accepted = await ctx.ui.confirm('CodeAgentSwarm approval', JSON.stringify({
        toolName: event.toolName, toolCallId: event.toolCallId, input: event.input,
      }));
      if (!accepted) return { block: true, reason: 'The user declined this action.' };
    });
  }

  const ready = () => pi.registerCommand('__codeagentswarm_ready', { description: 'Internal Swarm integration check', handler: async () => {} });
  const file = path.join(configDir, 'mcp.json');
  if (!fs.existsSync(file)) return ready();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const descriptor = config?.mcpServers?.['codeagentswarm-tasks'];
  if (!descriptor) return ready();
  const server = path.join(os.homedir(), '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks', 'src', 'infrastructure', 'mcp', 'mcp-stdio-server.js');
  // Never pass Swarm session identity to an entry owned by another application.
  const canonical = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (descriptor.command !== 'node' || descriptor.args?.length !== 1 || typeof descriptor.args[0] !== 'string' || canonical(descriptor.args[0]) !== canonical(server)) return ready();
  if (!fs.existsSync(server)) throw new Error('CodeAgentSwarm MCP runtime is missing; repair the Pi integration in Settings.');
  const child = spawn(process.execPath, [server], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  function fail(error) {
    closed = true;
    for (const request of pending.values()) request.finish(error);
  }
  child.once('error', fail);
  child.once('exit', () => fail(new Error('CodeAgentSwarm MCP disconnected')));
  function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
      fail(new Error('CodeAgentSwarm MCP response exceeded 32 MiB'));
      child.kill();
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (request) request.finish(message.error ? new Error(message.error.message) : null, message.result);
      } catch (_) {}
    }
  });
  function request(method, params, signal, timeout = 30000) {
    if (closed) return Promise.reject(new Error('CodeAgentSwarm MCP is not connected'));
    if (signal?.aborted) return Promise.reject(new Error('Tool call cancelled'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const cancel = () => {
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'User cancelled' } });
        finish(new Error('Tool call cancelled'));
      };
      const timer = setTimeout(() => finish(new Error(`CodeAgentSwarm MCP timed out: ${method}`)), timeout);
      const finish = (error, result) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(result);
      };
      pending.set(id, { finish });
      signal?.addEventListener('abort', cancel, { once: true });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  const stop = () => { fail(new Error('Pi session closed')); child.kill(); };
  pi.on('session_shutdown', stop);
  process.once('exit', () => child.kill());
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codeagentswarm-pi', version: '1.0.0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let cursor;
    do {
      const result = await request('tools/list', cursor ? { cursor } : {});
      for (const tool of result.tools || []) {
        const name = `mcp__codeagentswarm_tasks__${tool.name}`;
        managedTools.add(name);
        pi.registerTool({
          name, label: tool.name, description: tool.description || tool.name,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          async execute(_id, args, signal) {
            const result = await request('tools/call', { name: tool.name, arguments: args }, signal, 300000);
            if (result.isError) throw new Error((result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n') || 'CodeAgentSwarm tool failed');
            return { content: result.content || [], details: {} };
          },
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    ready();
  } catch (error) { stop(); throw error; }
}
