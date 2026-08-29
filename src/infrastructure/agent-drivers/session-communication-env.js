const SESSION_COMMUNICATION_ENV_KEYS = Object.freeze([
  'CODEAGENTSWARM_SESSION_COMMUNICATION_ENABLED',
  'CODEAGENTSWARM_SESSION_BRIDGE_PORT',
  'CODEAGENTSWARM_SESSION_BRIDGE_TOKEN',
]);

function mergeSessionCommunicationEnv(baseEnv = {}, sessionEnv = {}) {
  const env = { ...baseEnv };
  for (const key of SESSION_COMMUNICATION_ENV_KEYS) delete env[key];
  return { ...env, ...sessionEnv };
}

module.exports = { SESSION_COMMUNICATION_ENV_KEYS, mergeSessionCommunicationEnv };
