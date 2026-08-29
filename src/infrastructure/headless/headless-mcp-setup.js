const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentConfigRegistry } = require('../config/agent-config-registry');

async function setupHeadlessMcp({
  serverSource,
  launcherSource,
  home = os.homedir(),
  registry = new AgentConfigRegistry(),
} = {}) {
  if (!serverSource || !launcherSource) throw new Error('CAS Cloud MCP assets are missing');
  const runtimeDir = path.join(home, '.codeagentswarm', 'mcp-servers', 'codeagentswarm-tasks', 'src', 'infrastructure', 'mcp');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  for (const [source, name] of [[serverSource, 'mcp-stdio-server.js'], [launcherSource, 'antigravity-mcp-launcher.js']]) {
    if (!fs.existsSync(source)) throw new Error(`CAS Cloud MCP asset is missing: ${name}`);
    const target = path.join(runtimeDir, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
  }
  const result = await registry.enableMcpForAll();
  const failures = Object.entries(result.results || {})
    .filter(([, value]) => value?.success === false)
    .map(([agent, value]) => ({ agent, message: value.message || 'MCP setup failed' }));
  return { runtimeDir, agents: registry.getAllIds(), failures };
}

module.exports = { setupHeadlessMcp };
