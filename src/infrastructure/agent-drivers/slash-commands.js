/**
 * Shared slash-command normalization and human-readable structured output.
 *
 * Providers disagree on the argument-hint field (`argumentHint` in Claude,
 * `input.hint` in ACP), so the renderer only ever sees this small contract:
 * `{ name, description, argumentHint, aliases, source }`.
 */

function normalizeSlashCommand(command, source = 'provider') {
  if (!command || typeof command.name !== 'string') return null;
  const name = command.name.trim().replace(/^\/+/, '');
  if (!name) return null;
  const inputHint = command.input && typeof command.input.hint === 'string'
    ? command.input.hint
    : '';
  return {
    name,
    description: typeof command.description === 'string' ? command.description.trim() : '',
    argumentHint: typeof command.argumentHint === 'string'
      ? command.argumentHint.trim()
      : inputHint.trim(),
    aliases: Array.isArray(command.aliases)
      ? command.aliases
        .filter((alias) => typeof alias === 'string' && alias.trim())
        .map((alias) => alias.trim().replace(/^\/+/, ''))
      : [],
    source
  };
}

function normalizeSlashCommands(commands, source = 'provider') {
  const seen = new Set();
  return (Array.isArray(commands) ? commands : [])
    .map((command) => normalizeSlashCommand(command, source))
    .filter((command) => {
      if (!command || seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
}

function formatNumber(value) {
  return Number.isFinite(Number(value))
    ? new Intl.NumberFormat('en-US').format(Number(value))
    : null;
}

function formatDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function formatClaudeUsage(usage = {}) {
  const session = usage.session || {};
  const lines = ['Claude usage'];
  if (usage.subscription_type) lines.push(`Plan: ${usage.subscription_type}`);
  if (Number.isFinite(session.total_cost_usd)) {
    lines.push(`Session cost: $${session.total_cost_usd.toFixed(4)}`);
  }
  const models = Object.entries(session.model_usage || {});
  if (models.length) {
    lines.push('', 'Session tokens:');
    for (const [model, values] of models) {
      const input = formatNumber(values && values.inputTokens);
      const output = formatNumber(values && values.outputTokens);
      const parts = [input && `${input} input`, output && `${output} output`].filter(Boolean);
      lines.push(`- ${model}${parts.length ? `: ${parts.join(', ')}` : ''}`);
    }
  }
  const windows = usage.rate_limits || {};
  const labels = {
    five_hour: '5-hour window',
    seven_day: '7-day window',
    seven_day_oauth_apps: '7-day OAuth apps',
    seven_day_opus: '7-day Opus',
    seven_day_sonnet: '7-day Sonnet'
  };
  const availableWindows = Object.entries(labels)
    .map(([key, label]) => [key, label, windows[key]])
    .filter(([, , value]) => value && typeof value === 'object');
  if (availableWindows.length) {
    lines.push('', 'Rate limits:');
    for (const [, label, value] of availableWindows) {
      const utilization = Number.isFinite(value.utilization) ? `${value.utilization}% used` : 'usage unavailable';
      const reset = formatDate(value.resets_at);
      lines.push(`- ${label}: ${utilization}${reset ? ` · resets ${reset}` : ''}`);
    }
  } else if (usage.rate_limits_available === false) {
    lines.push('Plan rate limits are not available for this authentication mode.');
  }
  const modelWindows = Array.isArray(windows.model_scoped) ? windows.model_scoped : [];
  if (modelWindows.length && availableWindows.length === 0) {
    lines.push('', 'Rate limits:');
  }
  for (const value of modelWindows) {
    if (!value || typeof value !== 'object') continue;
    const utilization = Number.isFinite(value.utilization)
      ? `${value.utilization}% used`
      : 'usage unavailable';
    const reset = formatDate(value.resets_at);
    lines.push(
      `- ${value.display_name || 'Model window'}: ${utilization}${reset ? ` · resets ${reset}` : ''}`
    );
  }
  const extra = windows.extra_usage;
  if (extra && extra.is_enabled) {
    const used = formatNumber(extra.used_credits);
    const limit = formatNumber(extra.monthly_limit);
    const currency = typeof extra.currency === 'string' && extra.currency
      ? ` ${extra.currency.toUpperCase()}`
      : '';
    const value = used && limit
      ? `${used} of ${limit}${currency}`
      : Number.isFinite(extra.utilization)
        ? `${extra.utilization}% used`
        : 'enabled';
    lines.push('', `Extra usage: ${value}`);
  }
  return lines.join('\n');
}

function formatCodexUsage(tokenUsage = {}, rateLimitResult = {}) {
  const lines = ['Codex usage'];
  const summary = tokenUsage.summary || {};
  const lifetime = formatNumber(summary.lifetimeTokens);
  const peak = formatNumber(summary.peakDailyTokens);
  if (lifetime) lines.push(`Lifetime tokens: ${lifetime}`);
  if (peak) lines.push(`Peak daily tokens: ${peak}`);
  if (Number.isFinite(summary.currentStreakDays)) {
    lines.push(`Current streak: ${summary.currentStreakDays} day${summary.currentStreakDays === 1 ? '' : 's'}`);
  }
  const buckets = rateLimitResult.rateLimitsByLimitId
    || (rateLimitResult.rateLimits ? { codex: rateLimitResult.rateLimits } : {});
  const entries = Object.entries(buckets || {});
  if (entries.length) {
    lines.push('', 'Rate limits:');
    for (const [name, snapshot] of entries) {
      const windows = [
        ['Primary', snapshot && snapshot.primary],
        ['Secondary', snapshot && snapshot.secondary]
      ].filter(([, window]) => window);
      if (!windows.length) {
        lines.push(`- ${name}: unavailable`);
        continue;
      }
      for (const [label, window] of windows) {
        const reset = formatDate(window.resetsAt);
        lines.push(`- ${name} ${label.toLowerCase()}: ${window.usedPercent}% used${reset ? ` · resets ${reset}` : ''}`);
      }
    }
  }
  if (lines.length === 1) lines.push('No usage data has been reported by this account yet.');
  return lines.join('\n');
}

function formatMcpServers(servers = []) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return 'MCP servers\nNo MCP servers are configured for this session.';
  }
  return [
    'MCP servers',
    ...servers.map((server) => {
      const name = server.name || 'Unnamed server';
      const status = server.status
        || server.authStatus
        || (server.serverInfo ? 'connected' : 'configured');
      const tools = Array.isArray(server.tools)
        ? server.tools.length
        : server.tools && typeof server.tools === 'object'
          ? Object.keys(server.tools).length
          : 0;
      const error = server.error ? ` · ${server.error}` : '';
      return `- ${name}: ${status} · ${tools} tool${tools === 1 ? '' : 's'}${error}`;
    })
  ].join('\n');
}

function parseSlashCommand(commandLine) {
  const match = typeof commandLine === 'string'
    ? commandLine.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    : null;
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

module.exports = {
  normalizeSlashCommand,
  normalizeSlashCommands,
  parseSlashCommand,
  formatClaudeUsage,
  formatCodexUsage,
  formatMcpServers
};
