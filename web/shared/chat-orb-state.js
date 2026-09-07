const TOOL_STATES = Object.freeze({
  reasoning: 'solving',
  plan: 'solving',
  file_change: 'solving',
  file_read: 'searching',
  search: 'searching',
  subagent: 'weaving',
});

const ITEM_STATES = Object.freeze({
  reasoning: 'solving',
  plan: 'solving',
  file_change: 'solving',
  web_search: 'searching',
  collab_agent_tool_call: 'weaving',
  assistant_message: 'weaving',
});

const SEARCH_TOOLS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);

function orbStateForActivity(activity) {
  if (!activity) return 'solving';
  if (activity.kind === 'assistant') return 'weaving';
  if (activity.tool) return TOOL_STATES[activity.tool] || 'solving';
  if (activity.itemType === 'dynamic_tool_call') {
    return SEARCH_TOOLS.has(activity.data && activity.data.name) ? 'searching' : 'solving';
  }
  return ITEM_STATES[activity.itemType] || 'solving';
}

function orbStateForActivities(activities) {
  const rows = Array.isArray(activities) ? activities : [];
  const live = rows.findLast((activity) => (
    activity && (activity.status === 'running' || activity.status === 'inProgress')
  ));
  return orbStateForActivity(live || rows.at(-1));
}

module.exports = { orbStateForActivity, orbStateForActivities };
