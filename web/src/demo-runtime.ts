import {
  normalizeSession,
  type MobileRuntimeState,
  type RuntimeCommand,
  type RuntimeHistoryConversation,
  type RuntimeItem,
  type RuntimeProject,
  type RuntimeSession,
  type RuntimeShortcut,
} from './protocol';

const AGENTS = ['codex', 'claude', 'opencode', 'kimi', 'antigravity', 'grok', 'cursor', 'pi'] as const;

const PROJECTS: RuntimeProject[] = [
  { projectId: '1', name: 'CodeAgentSwarm', path: '/Users/reviewer/Development/codeagentswarm', color: '#b100ca', worktreeEligible: true, useWorktreeByDefault: true, hostRuntimeId: 'codeagentswarm-review-demo' },
  { projectId: '2', name: 'Atlas Portal', path: '/Users/reviewer/Development/atlas-portal', icon: 'emoji:🚀', color: '#2563eb', worktreeEligible: true, useWorktreeByDefault: true, hostRuntimeId: 'codeagentswarm-review-demo' },
  { projectId: '3', name: 'Storefront', path: '/Users/reviewer/Development/storefront', icon: 'lucide:shopping-bag', color: '#b45309', worktreeEligible: true, useWorktreeByDefault: false, hostRuntimeId: 'codeagentswarm-review-demo' },
];

/** Mirrors the desktop navbar shortcut chips so the wide web demo can start an agent in one tap. */
const SHORTCUTS: RuntimeShortcut[] = [
  { shortcutId: 'demo-shortcut-release', name: 'Release', projectPath: PROJECTS[0].path, projectName: PROJECTS[0].name, color: PROJECTS[0].color, agent: 'claude', useWorktree: null },
  { shortcutId: 'demo-shortcut-dashboard', name: 'Dashboard', projectPath: PROJECTS[1].path, projectName: PROJECTS[1].name, color: PROJECTS[1].color, icon: PROJECTS[1].icon, agent: 'codex', useWorktree: null },
  { shortcutId: 'demo-shortcut-checkout', name: 'Checkout', projectPath: PROJECTS[2].path, projectName: PROJECTS[2].name, color: PROJECTS[2].color, icon: PROJECTS[2].icon, agent: 'antigravity', useWorktree: true },
];

const STATUS = {
  needs_input: { key: 'needs_input', label: 'Needs input', color: '#f97316' },
  needs_testing: { key: 'needs_testing', label: 'Needs testing', color: '#3b82f6' },
  working: { key: 'working', label: 'Working', color: '#fbbf24' },
  done: { key: 'done', label: 'Done', color: '#22c55e' },
  pushed: { key: 'pushed', label: 'Pushed', color: '#14b8a6' },
  reviewing: { key: 'reviewing', label: 'Reviewing', color: '#a78bfa' },
};

function makeSession(input: Partial<RuntimeSession> & Pick<RuntimeSession, 'sessionId'>) {
  const session = normalizeSession(input);
  if (!session) throw new Error(`Invalid demo session ${input.sessionId}`);
  return session;
}

function itemId(prefix: string, now: number) {
  return `demo-${prefix}-${now}`;
}

function settleTurnItems(items: RuntimeItem[], turnId: string | null | undefined, now: number) {
  if (!turnId) return items;
  return items.map((item) => item.turnId === turnId && item.status === 'inProgress'
    ? { ...item, status: 'completed', endedAtMs: now }
    : item);
}

function updateSession(state: MobileRuntimeState, sessionId: string, update: (session: RuntimeSession) => RuntimeSession) {
  return {
    ...state,
    sessions: state.sessions.map((session) => session.sessionId === sessionId ? update(session) : session),
  };
}

function demoReply(prompt: string) {
  const normalized = prompt.toLocaleLowerCase();
  if (normalized.includes('release') || normalized.includes('app store') || normalized.includes('1.0')) {
    return 'The **1.0 release** is ready for the final review pass.\n\n- Build metadata is consistent.\n- App Review has a complete demo path.\n- The remaining step is validating the signed archive before submission.';
  }
  if (normalized.includes('test')) {
    return 'The focused checks are green. I would run the native iOS flow once more before uploading the archive.';
  }
  if (normalized.includes('status')) {
    return 'Everything in this sample workspace is synchronized. The active release task is **Working** and the finished UI pass is **Done**.';
  }
  return 'I reviewed that in the sample workspace. The main flow is consistent, the mobile state is up to date, and there are no blocking issues in this demo.';
}

export function createDemoHistory(now = Date.now()): RuntimeHistoryConversation[] {
  return [
    ['codex', 'Prepare the App Store release', PROJECTS[0], 26 * 60_000],
    ['claude', 'Polish the mobile pairing flow', PROJECTS[0], 3 * 60 * 60_000],
    ['antigravity', 'Audit the dashboard accessibility', PROJECTS[1], 24 * 60 * 60_000],
    ['opencode', 'Improve checkout performance', PROJECTS[2], 2 * 24 * 60 * 60_000],
    ['kimi', 'Document the deployment runbook', PROJECTS[0], 5 * 24 * 60 * 60_000],
    ['grok', 'Trace the API latency spike', PROJECTS[1], 9 * 24 * 60 * 60_000],
  ].map(([agent, title, project, age], index) => ({
    id: `demo-history-${agent}`,
    sessionId: `demo-history-session-${agent}`,
    agent: String(agent),
    title: String(title),
    projectPath: (project as RuntimeProject).path,
    projectDir: `demo-project-${index}`,
    projectName: (project as RuntimeProject).name,
    timestamp: now - Number(age),
  }));
}

export function createDemoRuntimeState(now = Date.now()): MobileRuntimeState {
  const shared = {
    clientRequestId: null,
    threadId: null,
    terminalUuid: null,
    currentTurn: null,
    interactionMode: 'default',
    resumed: false,
    hasEarlierHistory: false,
    attentionVersion: 0,
    tokenUsage: null,
    diff: null,
    pendingRequests: [],
    pendingQuestions: [],
    lastSeq: 0,
  };
  const sessions = [
    makeSession({
      ...shared,
      sessionId: 'demo-release',
      terminalOrder: 1,
      agent: 'codex', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', serviceTier: 'standard', permissionMode: 'auto-accept-edits',
      cwd: PROJECTS[0].path, project: PROJECTS[0], state: 'ready', title: 'Prepare App Store release',
      tokenUsage: { usedTokens: 101_000, maxTokens: 258_000 },
      goal: 'Ship a reviewable and trustworthy iOS 1.0', activity: 'Validating the iOS release candidate',
      activityHistory: [
        { activity: 'Validating the iOS release candidate', createdAt: new Date(now - 2 * 60_000).toISOString(), taskId: 12767 },
        { activity: 'Preparing the App Review demo', createdAt: new Date(now - 14 * 60_000).toISOString(), taskId: 12767 },
      ],
      workStatus: 'working', lastActivityAt: now - 2 * 60_000, needsAttention: false, minimized: false,
      items: [
        { itemId: 'demo-release-user', itemType: 'user_message', status: 'completed', startedAtMs: now - 18 * 60_000, endedAtMs: now - 18 * 60_000, data: { text: 'Prepare the mobile app for App Review', attachments: [
          { type: 'image', name: 'mobile-web-session-list-loading.png', thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==' },
          { type: 'image', name: 'mobile-session-files.png', thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==' },
        ] }, content: {} },
        { itemId: 'demo-release-plan', turnId: 'demo-release-turn', itemType: 'plan', status: 'completed', todos: [
          { step: 'Check the App Store metadata', status: 'completed' },
          { step: 'Add a reviewer-friendly demo', status: 'in_progress' },
          { step: 'Validate and upload build 27', status: 'pending' },
        ], content: {} },
        { itemId: 'demo-release-work', turnId: 'demo-release-turn', itemType: 'command_execution', status: 'completed', title: 'Checked release configuration', detail: 'Version 1.0, privacy answers and review metadata are consistent.', startedAtMs: now - 12 * 60_000, endedAtMs: now - 11 * 60_000, content: {} },
        { itemId: 'demo-release-answer', turnId: 'demo-release-turn', itemType: 'assistant_message', status: 'completed', startedAtMs: now - 10 * 60_000, endedAtMs: now - 9 * 60_000, data: { text: 'The store record is ready. I am adding a self-contained demo so App Review can inspect the real mobile experience without your Mac. The [interactive proposal](https://example.com/interactive-proposal) is ready to review.' }, content: { assistant_text: 'The store record is ready. I am adding a self-contained demo so App Review can inspect the real mobile experience without your Mac. The [interactive proposal](https://example.com/interactive-proposal) is ready to review.' } },
      ],
      pendingQuestions: [{ requestId: 'demo-release-question', questions: [{ id: 'release-scope', header: 'Release scope', question: 'Which channel should receive this build?', options: [{ label: 'App Store 1.0', description: 'Prepare the public release candidate.' }, { label: 'TestFlight only', description: 'Keep the build with internal testers.' }] }] }],
    }),
    makeSession({
      ...shared,
      sessionId: 'demo-pairing', terminalOrder: 2, agent: 'claude', provider: 'claude', model: 'claude-opus-4-1', effort: true, permissionMode: 'acceptEdits',
      cwd: '/Users/reviewer/.codeagentswarm/sandbox', project: { name: 'Sandbox', path: '/Users/reviewer/.codeagentswarm/sandbox', color: '#6b7280' }, sandboxMode: true, state: 'ready', title: 'Mobile pairing experience', goal: 'Make first-time connection obvious and secure',
      activity: 'Review complete', activityHistory: [{ activity: 'Review complete', createdAt: new Date(now - 42 * 60_000).toISOString(), taskId: 12754 }],
      workStatus: 'done', lastActivityAt: now - 42 * 60_000, needsAttention: false, minimized: false,
      items: [
        { itemId: 'demo-pairing-user', itemType: 'user_message', status: 'completed', data: { text: 'Review the QR pairing experience' }, content: {} },
        { itemId: 'demo-pairing-answer', itemType: 'assistant_message', status: 'completed', data: { text: 'The one-time QR, six-digit confirmation and device naming make the security boundary clear without adding friction.' }, content: { assistant_text: 'The one-time QR, six-digit confirmation and device naming make the security boundary clear without adding friction.' } },
      ],
    }),
    makeSession({
      ...shared,
      sessionId: 'demo-accessibility', terminalOrder: 3, agent: 'antigravity', provider: 'antigravity', model: 'gemini-2.5-pro', effort: 'high', permissionMode: 'default',
      cwd: PROJECTS[1].path, project: PROJECTS[1], state: 'ready', title: 'Dashboard accessibility', goal: 'Keep the account dashboard usable with VoiceOver',
      activity: 'Waiting for approval', activityHistory: [{ activity: 'Waiting for approval', createdAt: new Date(now - 58 * 60_000).toISOString(), taskId: 12739 }],
      workStatus: 'needs_input', lastActivityAt: now - 58 * 60_000, needsAttention: false, minimized: false,
      items: [
        { itemId: 'demo-a11y-user', itemType: 'user_message', status: 'completed', data: { text: 'Audit the account dashboard' }, content: {} },
        { itemId: 'demo-a11y-work', itemType: 'tool_use', status: 'completed', title: 'Inspected accessibility tree', detail: 'Found one unlabeled chart control.', content: {} },
      ],
      pendingRequests: [{ requestId: 'demo-a11y-request', requestType: 'permission', detail: 'Apply the accessible label to the revenue chart?' }],
    }),
    makeSession({
      ...shared,
      sessionId: 'demo-checkout', terminalOrder: 4, agent: 'opencode', provider: 'opencode', model: 'minimax-m2.5', effort: 'medium', permissionMode: 'default',
      cwd: PROJECTS[2].path, project: PROJECTS[2], state: 'ready', title: 'Checkout performance', goal: 'Keep checkout interaction under 100 ms',
      activity: 'Ready for device testing', activityHistory: [{ activity: 'Ready for device testing', createdAt: new Date(now - 2 * 60 * 60_000).toISOString(), taskId: 12722 }],
      workStatus: 'needs_testing', lastActivityAt: now - 2 * 60 * 60_000, needsAttention: false, minimized: false,
      items: [{ itemId: 'demo-checkout-answer', itemType: 'assistant_message', status: 'completed', data: { text: 'The cart now updates optimistically and rolls back cleanly if the payment request fails.' }, content: { assistant_text: 'The cart now updates optimistically and rolls back cleanly if the payment request fails.' } }],
    }),
    makeSession({
      ...shared,
      sessionId: 'demo-runbook', terminalOrder: 5, agent: 'kimi', provider: 'kimi', model: 'kimi-k2.5', effort: 'medium', permissionMode: 'default',
      cwd: PROJECTS[0].path, project: PROJECTS[0], state: 'ready', title: 'Deployment runbook', goal: 'Make production releases repeatable',
      activity: 'Changes pushed to develop', activityHistory: [{ activity: 'Changes pushed to develop', createdAt: new Date(now - 3 * 60 * 60_000).toISOString(), taskId: 12698 }],
      workStatus: 'pushed', lastActivityAt: now - 3 * 60 * 60_000, needsAttention: false, minimized: true,
      items: [{ itemId: 'demo-runbook-answer', itemType: 'assistant_message', status: 'completed', data: { text: 'The runbook now covers rollback, secret rotation and post-deploy verification.' }, content: { assistant_text: 'The runbook now covers rollback, secret rotation and post-deploy verification.' } }],
    }),
    makeSession({
      ...shared,
      sessionId: 'demo-api', terminalOrder: 6, agent: 'grok', provider: 'grok', model: 'grok-code-fast-1', effort: 'high', permissionMode: 'default',
      cwd: PROJECTS[1].path, project: PROJECTS[1], state: 'ready', title: 'API latency investigation', goal: 'Explain the p95 latency spike before launch',
      activity: 'Reviewing the trace summary', activityHistory: [{ activity: 'Reviewing the trace summary', createdAt: new Date(now - 5 * 60 * 60_000).toISOString(), taskId: 12681 }],
      workStatus: 'reviewing', lastActivityAt: now - 5 * 60 * 60_000, needsAttention: false, minimized: false,
      items: [{ itemId: 'demo-api-answer', itemType: 'assistant_message', status: 'completed', data: { text: 'The spike comes from one uncached aggregation. The query plan is attached to the investigation and the fix is ready for review.' }, content: { assistant_text: 'The spike comes from one uncached aggregation. The query plan is attached to the investigation and the fix is ready for review.' } }],
    }),
  ];

  return {
    runtimeId: 'codeagentswarm-review-demo',
    computerName: null,
    hostKind: 'desktop',
    hostPlatform: 'unknown',
    capabilities: ['shortcuts.manage', 'session.action', 'projects.list', 'project.directories.list', 'project.create', 'project.update', 'project.unregister', 'tasks.list', 'tasks.search', 'task.create', 'task.update', 'task.delete'],
    availableAgents: [...AGENTS],
    lastSeq: 1,
    sessions,
    projects: PROJECTS,
    shortcuts: SHORTCUTS,
    terminalStatuses: Object.values(STATUS),
    projectRoots: [],
    quotas: [
      { agent: 'codex', accountId: 'current', accountLabel: 'Personal', provider: 'openai', plan: 'Plus', windows: [{ key: '5h', label: '5-hour window', remainingFraction: .64, resetsAt: now + 2 * 60 * 60_000, model: null, severity: 'normal' }, { key: 'weekly', label: 'Weekly', remainingFraction: .78, resetsAt: now + 4 * 24 * 60 * 60_000, model: null, severity: 'normal' }], tightest: { remainingFraction: .64, severity: 'normal', resetsAt: now + 2 * 60 * 60_000 }, fetchedAt: now, source: 'demo', stale: false },
      { agent: 'claude', accountId: 'current', accountLabel: 'Personal', provider: 'anthropic', plan: 'Max', windows: [{ key: 'weekly', label: 'Weekly', remainingFraction: .53, resetsAt: now + 3 * 24 * 60 * 60_000, model: null, severity: 'normal' }], tightest: { remainingFraction: .53, severity: 'normal', resetsAt: now + 3 * 24 * 60 * 60_000 }, fetchedAt: now, source: 'demo', stale: false },
    ],
    phase: 'online',
    challengeCode: null,
    challengeExpiresAt: null,
    error: null,
    hosts: [{ runtimeId: 'codeagentswarm-review-demo', name: 'Review Mac', kind: 'desktop', platform: 'darwin', phase: 'online', error: null, sessionCount: sessions.length, projectCount: PROJECTS.length, capabilities: ['projects.list', 'project.directories.list', 'project.create', 'project.update', 'project.unregister', 'tasks.list', 'tasks.search', 'task.create', 'task.update', 'task.delete'], availableAgents: [...AGENTS] }],
  };
}

export function completeDemoTurn(state: MobileRuntimeState, sessionId: string, prompt: string, now = Date.now(), turnId?: string) {
  return updateSession(state, sessionId, (session) => {
    if (turnId && session.currentTurn?.turnId !== turnId) return session;
    return {
      ...session,
      state: 'ready',
      currentTurn: null,
      activity: 'Ready for your next message',
      lastActivityAt: now,
      items: [
        ...settleTurnItems(session.items, session.currentTurn?.turnId, now),
        {
          itemId: itemId('assistant', now),
          itemType: 'assistant_message',
          status: 'completed',
          startedAtMs: now,
          endedAtMs: now,
          data: { text: demoReply(prompt) },
          content: { assistant_text: demoReply(prompt) },
        },
      ],
    };
  });
}

export function runDemoCommand(state: MobileRuntimeState, command: RuntimeCommand, now = Date.now()): {
  state: MobileRuntimeState;
  result?: Record<string, unknown>;
} {
  if (command.type === 'history.list') return { state, result: { conversations: createDemoHistory(now) } };
  if (command.type === 'history.older') return { state, result: { items: [], nextCursor: null, hasMore: false } };
  if (command.type === 'tasks.list') {
    const tasks = [
    { id: 12771, title: 'Validate private relay on iPhone', description: 'Check Desktop and CAS Cloud hosts.', plan: '', implementation: '', status: 'in_progress', labels: ['mobile', 'relay'], parentTaskId: null, sortOrder: 0, createdAt: '', updatedAt: '' },
    { id: 12772, title: 'Polish project editor', description: 'Keep creation usable on narrow screens.', plan: '', implementation: '', status: 'pending', labels: ['ui'], parentTaskId: null, sortOrder: 1, createdAt: '', updatedAt: '' },
    { id: 12773, title: 'Test Windows host', description: '', plan: '', implementation: '', status: 'in_testing', labels: ['windows'], parentTaskId: null, sortOrder: 2, createdAt: '', updatedAt: '' },
    { id: 12768, title: 'Add relay project commands', description: '', plan: '', implementation: '', status: 'completed', labels: ['backend'], parentTaskId: null, sortOrder: 3, createdAt: '', updatedAt: '' },
    ];
    const query = String(command.payload?.query || '').toLowerCase();
    const matches = tasks.filter((task) => `${task.title} ${task.description} ${task.labels.join(' ')} ${task.id}`.toLowerCase().includes(query));
    const counts = Object.fromEntries(['pending', 'in_progress', 'in_testing', 'completed'].map((status) => [status, matches.filter((task) => task.status === status).length]));
    const filtered = matches.filter((task) => !command.payload?.status || task.status === command.payload.status);
    const offset = Number(command.payload?.cursor || 0);
    const limit = Number(command.payload?.limit || 25);
    return { state, result: { tasks: filtered.slice(offset, offset + limit), counts, nextCursor: filtered.length > offset + limit ? String(offset + limit) : null } };
  }
  if (command.type === 'session.models') {
    const session = state.sessions.find((candidate) => candidate.sessionId === command.sessionId);
    const modelId = session?.model || 'default';
    return { state, result: {
      models: [{
        id: modelId,
        name: modelId === 'gpt-5.6-sol' ? 'GPT-5.6 Sol' : 'Default',
        current: true,
        ...(session?.agent === 'codex' ? { capabilities: { optionDescriptors: [
          { id: 'effort', label: 'Reasoning', currentValue: session.effort || 'high', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
          { id: 'serviceTier', label: 'Speed', currentValue: session.serviceTier || 'standard', options: [{ id: 'standard', label: 'Standard' }, { id: 'fast', label: 'Fast' }] },
        ] } } : {}),
      }],
      permissionModes: [{ id: 'default', label: 'Ask when needed' }, { id: 'auto-accept-edits', label: 'Accept edits' }],
    } };
  }
  if (command.type === 'shortcuts.replace') {
    const shortcuts = Array.isArray(command.payload?.shortcuts)
      ? command.payload.shortcuts.flatMap((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const shortcut = value as Record<string, unknown>;
        const project = PROJECTS.find((candidate) => candidate.path === shortcut.projectPath);
        if (!project || typeof shortcut.name !== 'string' || typeof shortcut.agent !== 'string') return [];
        return [{
          shortcutId: `demo-shortcut-${index}`,
          name: shortcut.name,
          projectPath: project.path,
          projectName: project.name,
          color: project.color,
          agent: shortcut.agent,
          useWorktree: typeof shortcut.useWorktree === 'boolean' ? shortcut.useWorktree : null,
        }];
      })
      : state.shortcuts;
    return { state: { ...state, shortcuts }, result: { success: true } };
  }

  if (command.type === 'session.create' || command.type === 'session.resume') {
    const payload = command.payload || {};
    const history = createDemoHistory(now).find((entry) => entry.id === payload.historyId);
    const clientRequestId = typeof payload.clientRequestId === 'string' ? payload.clientRequestId : String(payload.historyId || now);
    const sessionId = `demo-${clientRequestId}`;
    const agent = typeof payload.agent === 'string' && AGENTS.includes(payload.agent as typeof AGENTS[number]) ? payload.agent : history?.agent || 'codex';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : history?.projectPath || PROJECTS[0].path;
    const project = PROJECTS.find((candidate) => candidate.path === cwd) || { name: cwd.split('/').pop() || 'Project', path: cwd, color: '#7f5af0' };
    const prompt = typeof payload.initialPrompt === 'string' && payload.initialPrompt.trim() ? payload.initialPrompt.trim() : history?.title || 'Continue this conversation';
    const created = makeSession({
      sessionId, clientRequestId, terminalOrder: 1, agent, provider: agent, threadId: null, terminalUuid: null,
      cwd, project, model: null, effort: null, serviceTier: null, permissionMode: 'default', interactionMode: 'default',
      state: 'ready', title: history?.title || prompt.slice(0, 64), goal: 'Explore a realistic mobile agent workflow', activity: 'Ready for your next message',
      activityHistory: [{ activity: 'Session created from mobile', createdAt: new Date(now).toISOString(), taskId: null }],
      workStatus: 'working', lastActivityAt: now, needsAttention: false, attentionVersion: 0, minimized: false, resumed: command.type === 'session.resume', hasEarlierHistory: false,
      currentTurn: null, tokenUsage: null, diff: null,
      items: [
        { itemId: itemId('created-user', now), itemType: 'user_message', status: 'completed', data: { text: prompt }, content: {} },
        { itemId: itemId('created-assistant', now), itemType: 'assistant_message', status: 'completed', data: { text: demoReply(prompt) }, content: { assistant_text: demoReply(prompt) } },
      ],
      pendingRequests: [], pendingQuestions: [], lastSeq: 0,
    });
    return { state: { ...state, sessions: [created, ...state.sessions] }, result: { sessionId, reused: false } };
  }

  if (!command.sessionId) return { state };
  const sessionId = command.sessionId;
  const payload = command.payload || {};
  if (command.type === 'turn.send') {
    const prompt = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!prompt) return { state };
    const turnId = typeof payload.commandId === 'string' ? payload.commandId : itemId('turn', now);
    return {
      state: updateSession(state, sessionId, (session) => ({
        ...session,
        state: 'running',
        currentTurn: { turnId, state: 'running' },
        workStatus: 'working',
        activity: 'Reviewing your message',
        lastActivityAt: now,
        items: [...settleTurnItems(session.items, session.currentTurn?.turnId, now),
          { itemId: itemId('user', now), turnId, itemType: 'user_message', status: 'completed', startedAtMs: now, endedAtMs: now, data: { text: prompt, ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments } : {}) }, content: {} },
          { itemId: itemId('work', now), turnId, itemType: 'reasoning', status: 'inProgress', startedAtMs: now, title: 'Reviewing the workspace', detail: 'Checking the sample project and release state.', content: {} },
        ],
      })),
      result: { accepted: true },
    };
  }
  if (command.type === 'session.status') return { state: updateSession(state, sessionId, (session) => ({ ...session, workStatus: typeof payload.status === 'string' && payload.status !== 'clear' ? payload.status : null, lastActivityAt: now })) };
  if (command.type === 'session.handoff') {
    const source = state.sessions.find((session) => session.sessionId === sessionId);
    const targetAgent = typeof payload.targetAgent === 'string' ? payload.targetAgent : '';
    if (!source || !targetAgent || targetAgent === source.agent) return { state };
    const continued = {
      ...source,
      sessionId: itemId('handoff', now),
      agent: targetAgent,
      provider: targetAgent,
      title: source.title || `Continued in ${targetAgent}`,
      activity: 'Conversation continued from another LLM',
      lastActivityAt: now,
      items: [...source.items],
    };
    return { state: { ...state, sessions: [continued, ...state.sessions] }, result: { success: true, sessionId: continued.sessionId } };
  }
  if (command.type === 'session.action') {
    if (payload.action === 'fork') {
      const source = state.sessions.find((session) => session.sessionId === sessionId);
      if (!source) return { state };
      const fork = { ...source, sessionId: `demo-fork-${now}`, terminalOrder: state.sessions.length + 1, title: `FORKED - ${source.title || 'Conversation'}`, minimized: false };
      return { state: { ...state, sessions: [...state.sessions, fork] } };
    }
    if (payload.action === 'rename' && typeof payload.title === 'string') {
      const title = payload.title.trim();
      return { state: updateSession(state, sessionId, (session) => ({ ...session, title: title || session.title })) };
    }
    if (payload.action === 'resetTitle') {
      return { state: updateSession(state, sessionId, (session) => ({ ...session, title: session.project?.name || 'Conversation' })) };
    }
    if (payload.action === 'generateTitle') {
      return { state: updateSession(state, sessionId, (session) => ({ ...session, title: 'Generated conversation title' })) };
    }
    if (payload.action === 'promoteSandbox') {
      return { state: updateSession(state, sessionId, (session) => ({ ...session, sandboxMode: false, project: PROJECTS[0], cwd: PROJECTS[0].path })) };
    }
  }
  if (command.type === 'session.minimize') return { state: updateSession(state, sessionId, (session) => ({ ...session, minimized: true })) };
  if (command.type === 'session.restore') return { state: updateSession(state, sessionId, (session) => ({ ...session, minimized: false })) };
  if (command.type === 'session.stop') return { state: updateSession(state, sessionId, (session) => ({ ...session, state: 'stopped', items: settleTurnItems(session.items, session.currentTurn?.turnId, now), currentTurn: null, workStatus: null, activity: 'Conversation closed', lastActivityAt: now })) };
  if (command.type === 'session.read') return { state: updateSession(state, sessionId, (session) => ({ ...session, needsAttention: false })) };
  if (command.type === 'turn.interrupt') return { state: updateSession(state, sessionId, (session) => ({ ...session, state: 'ready', items: settleTurnItems(session.items, session.currentTurn?.turnId, now), currentTurn: null, activity: 'Turn interrupted', lastActivityAt: now })) };
  if (command.type === 'request.respond') return { state: updateSession(state, sessionId, (session) => ({ ...session, pendingRequests: session.pendingRequests.filter((request) => request.requestId !== payload.requestId) })) };
  if (command.type === 'question.respond') return { state: updateSession(state, sessionId, (session) => ({ ...session, pendingQuestions: session.pendingQuestions.filter((question) => question.requestId !== payload.requestId) })) };
  if (command.type === 'session.configure') {
    const configId = typeof payload.configId === 'string' ? payload.configId : '';
    const key = configId === 'reasoning' ? 'effort' : configId === 'permission' ? 'permissionMode' : configId;
    return { state: updateSession(state, sessionId, (session) => key ? { ...session, [key]: payload.value } : session) };
  }
  return { state };
}
