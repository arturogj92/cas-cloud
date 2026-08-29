const { getRegistry } = require('./cli-agent-registry');
const { getInstance: getClaudeStrategy } = require('./claude-code-strategy');
const { getInstance: getCodexStrategy } = require('./codex-cli-strategy');
const { getInstance: getAntigravityStrategy } = require('./antigravity-cli-strategy');
const { getInstance: getOpencodeStrategy } = require('./opencode-cli-strategy');
const { getInstance: getKimiStrategy } = require('./kimi-cli-strategy');
const { getInstance: getGrokStrategy } = require('./grok-cli-strategy');
const { getInstance: getCursorStrategy } = require('./cursor-cli-strategy');

function initializeCliAgentRegistry() {
  const registry = getRegistry();
  registry.register('claude', getClaudeStrategy());
  registry.register('codex', getCodexStrategy());
  registry.register('antigravity', getAntigravityStrategy());
  registry.register('opencode', getOpencodeStrategy());
  registry.register('kimi', getKimiStrategy());
  registry.register('grok', getGrokStrategy());
  registry.register('cursor', getCursorStrategy());
  return registry;
}

module.exports = { initializeCliAgentRegistry };
