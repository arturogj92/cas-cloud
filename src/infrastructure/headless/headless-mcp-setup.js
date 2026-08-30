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
  const mcp = await registry.enableMcpForAll();
  const mcpFailures = Object.entries(mcp.results || {})
    .filter(([, value]) => value?.success === false)
    .map(([agent, value]) => ({ agent, surface: 'mcp', message: value.message || 'MCP setup failed' }));

  const instructionResults = {};
  for (const agent of registry.getAllIds()) {
    if (mcp.results?.[agent]?.success === false) {
      instructionResults[agent] = {
        success: true,
        skipped: true,
        message: 'Title instructions skipped because the MCP entry is user-owned',
      };
      continue;
    }
    try {
      instructionResults[agent] = await registry.enableInstructionsFor(
        agent,
        'titles-only',
        { includeStatus: true },
      );
    } catch (error) {
      instructionResults[agent] = { success: false, message: error.message };
    }
  }
  const instructionFailures = Object.entries(instructionResults)
    .filter(([, value]) => value?.success === false)
    .map(([agent, value]) => ({
      agent,
      surface: 'instructions',
      message: value.message || 'Title instruction setup failed',
    }));
  const failures = [...mcpFailures, ...instructionFailures];
  return {
    runtimeDir,
    agents: registry.getAllIds(),
    failures,
    mcpFailures,
    instructionFailures,
  };
}

module.exports = { setupHeadlessMcp };
