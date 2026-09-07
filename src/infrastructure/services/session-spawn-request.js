// Shared by MCP and both authenticated host bridges; never accept launch commands or paths.
function validateSessionSpawnRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.user_requested !== true) {
    throw new Error('spawn_session requires an explicit user request (user_requested: true)');
  }
  const allowed = ['user_requested', 'agent', 'model', 'effort', 'prompt'];
  if (Object.keys(body).some(key => !allowed.includes(key))
    || typeof body.agent !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(body.agent)
    || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000
    || ['model', 'effort'].some(key => body[key] !== undefined && (
      typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 200
      || /[\x00-\x1f\x7f]/.test(body[key])
    ))) {
    throw new Error('Session details are invalid');
  }
  return {
    agent: body.agent,
    initialPrompt: body.prompt.trim(),
    ...(body.model !== undefined ? { model: body.model.trim(), strictModel: true } : {}),
    ...(body.effort !== undefined ? { effort: body.effort.trim() } : {}),
  };
}

module.exports = { validateSessionSpawnRequest };
