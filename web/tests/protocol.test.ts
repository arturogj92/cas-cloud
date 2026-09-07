import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRuntimeEnvelope,
  newlyAttentiveSessions,
  sessionAlertCopy,
  emptyRuntimeCache,
  parsePairingUri,
  pairingInputFromUrl,
  normalizePairingCode,
  normalizeRuntimeProvider,
  previewHttpUrl,
  relayWebSocketUrl,
  sortSessionsByRecentActivity,
  sortSessionsByTerminalOrder,
} from '../src/protocol';

test('validates pairing links at the trust boundary', () => {
  const token = 'a'.repeat(43);
  const key = 'A'.repeat(43);
  assert.deepEqual(
    parsePairingUri(`codeagentswarm://pair?relay=https%3A%2F%2Frelay.example.com&backend=https%3A%2F%2Fapi.example.com&runtime=runtime-1&token=${token}&key=${key}&v=2`),
    {
      relayOrigin: 'https://relay.example.com',
      backendOrigin: 'https://api.example.com',
      runtimeId: 'runtime-1',
      pairingToken: token,
      desktopPublicKey: key,
    },
  );
  assert.equal(relayWebSocketUrl('https://relay.example.com', 'runtime-1'), 'wss://relay.example.com/api/mobile/ws?runtime=runtime-1');
  assert.equal(
    previewHttpUrl('https://relay.example.com', 'runtime:1', 'share-1', '/dashboard?tab=live'),
    'https://relay.example.com/preview/runtime%3A1/share-1/dashboard?tab=live',
  );
  assert.throws(
    () => parsePairingUri(`codeagentswarm://pair?relay=http%3A%2F%2Fevil.example.com&backend=https%3A%2F%2Fapi.example.com&runtime=runtime-1&token=${token}&key=${key}&v=2`),
    /not secure/,
  );
});

test('accepts a full pairing URI carried by the HTTPS QR and rejects relay-resolved short codes', () => {
  const pairing = `codeagentswarm://pair?relay=https%3A%2F%2Frelay.example.com&backend=https%3A%2F%2Fapi.example.com&runtime=runtime-1&token=${'a'.repeat(43)}&key=${'A'.repeat(43)}&v=2`;
  assert.deepEqual(
    pairingInputFromUrl(`https://codeagentswarm-mobile.pages.dev/?pairing=${encodeURIComponent(pairing)}`),
    { kind: 'uri', uri: pairing },
  );
  assert.deepEqual(
    pairingInputFromUrl('codeagentswarm://pair?relay=https%3A%2F%2Frelay.example.com'),
    { kind: 'uri', uri: 'codeagentswarm://pair?relay=https%3A%2F%2Frelay.example.com' },
  );
  assert.equal(pairingInputFromUrl('https://codeagentswarm-mobile.pages.dev/?pair=7K9D-M2QF'), null);
  assert.equal(pairingInputFromUrl(`http://example.com/?pairing=${encodeURIComponent(pairing)}`), null);
  assert.equal(pairingInputFromUrl('https://codeagentswarm-mobile.pages.dev/'), null);
});

test('normalizes human-friendly pairing codes without ambiguous characters', () => {
  assert.equal(normalizePairingCode('7k9d m2qf'), '7K9D-M2QF');
  assert.throws(() => normalizePairingCode('7K9I-M2QF'), /not valid/);
});

test('keeps cached messages when a reconnect omits history, but accepts authoritative empty chats', () => {
  const session = { sessionId: 'chat', items: [{ itemId: 'answer', itemType: 'assistant_message', content: { assistant_text: 'Still reading this' } }] };
  const current = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome', runtimeId: 'host', reset: true, latestSeq: 1,
    snapshot: { sessions: [session, { sessionId: 'closed' }] },
  }).cache;
  const reset = (runtimeId: string, hasEarlierHistory: boolean, features = ['session-subscriptions']) => applyRuntimeEnvelope(current, {
    kind: 'welcome', runtimeId, reset: true, latestSeq: 10,
    features,
    snapshot: { truncated: true, sessions: [{ sessionId: 'chat', state: 'ready', items: [], hasEarlierHistory }] },
  }).cache;

  const resumed = reset('host', true);
  assert.equal(resumed.sessions[0].items, current.sessions[0].items);
  assert.equal(resumed.sessions[0].state, 'ready');
  assert.equal(resumed.lastSeq, 10);
  assert.equal(resumed.sessions.length, 1, 'closed sessions must not be resurrected');
  assert.deepEqual(reset('host', false).sessions[0].items, []);
  assert.deepEqual(reset('different-host', true).sessions[0].items, []);
  assert.deepEqual(reset('host', true, []).sessions[0].items, [], 'legacy hosts still trigger history loading');
  const updated = applyRuntimeEnvelope(resumed, {
    kind: 'welcome', runtimeId: 'host', reset: true, latestSeq: 11,
    snapshot: { sessions: [{ ...session, items: [{ itemId: 'answer', content: { assistant_text: 'Fresh answer' } }] }] },
  }).cache;
  assert.equal(updated.sessions[0].items[0].content.assistant_text, 'Fresh answer');
});

test('hydrates a snapshot, applies ordered streaming events and detects gaps', () => {
  const welcome = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-1',
    latestSeq: 4,
    reset: true,
    desktop: { client: 'cas-cli', headless: true, platform: 'linux' },
    capabilities: ['providers.list', 'provider.login.start'],
    snapshot: {
      computerName: '  Arturo’s MacBook Pro  ',
      sessions: [{
        sessionId: 'session-1',
        agent: 'codex',
        accountId: 'work',
        accountLabel: 'Work',
        effort: 'high',
        serviceTier: 'standard',
        minimized: true,
        resumed: true,
        hasEarlierHistory: true,
        state: 'running',
        items: [],
        pendingRequests: [],
        pendingQuestions: [],
        lastSeq: 4,
      }],
      projects: [{
        name: 'CodeAgentSwarm',
        path: '/work/codeagentswarm',
        worktreeEligible: true,
        worktreeEligibilityReason: 'ignored-when-eligible',
        useWorktreeByDefault: false,
      }],
      projectRoots: [{ rootId: 'root-1', name: 'Team projects', path: '/private/root' }],
      availableAgents: ['codex', 'claude', 'unsupported'],
      quotas: [{
        agent: 'codex',
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        plan: 'Plus',
        windows: [{ key: '5h', label: '5-hour window', remainingFraction: 0.42, resetsAt: 1775860000000 }],
        tightest: { remainingFraction: 0.42, severity: 'normal', resetsAt: 1775860000000 },
        fetchedAt: 1775850000000,
        source: 'app-server',
        stale: false,
      }],
    },
  });
  assert.equal(welcome.gap, false);
  assert.equal(welcome.cache.sessions[0]?.agent, 'codex');
  assert.equal(welcome.cache.sessions[0]?.accountId, 'work');
  assert.equal(welcome.cache.sessions[0]?.accountLabel, 'Work');
  assert.equal(welcome.cache.sessions[0]?.minimized, true);
  assert.equal(welcome.cache.sessions[0]?.resumed, true);
  assert.equal(welcome.cache.sessions[0]?.hasEarlierHistory, true);
  assert.equal(welcome.cache.projects[0]?.name, 'CodeAgentSwarm');
  assert.equal(welcome.cache.projects[0]?.worktreeEligible, true);
  assert.equal(welcome.cache.projects[0]?.worktreeEligibilityReason, 'ignored-when-eligible');
  assert.equal(welcome.cache.projects[0]?.useWorktreeByDefault, false);
  assert.deepEqual(welcome.cache.projectRoots, [{ rootId: 'root-1', name: 'Team projects' }]);
  assert.deepEqual(welcome.cache.availableAgents, ['codex', 'claude']);
  assert.equal(welcome.cache.quotas[0]?.agent, 'codex');
  assert.equal(welcome.cache.quotas[0]?.accountId, 'work');
  assert.equal(welcome.cache.quotas[0]?.accountLabel, 'Work');
  assert.equal(welcome.cache.quotas[0]?.windows[0]?.remainingFraction, 0.42);
  assert.equal(welcome.cache.computerName, 'Arturo’s MacBook Pro');
  assert.equal(welcome.cache.hostKind, 'cloud');
  assert.equal(welcome.cache.hostPlatform, 'linux');
  assert.deepEqual(welcome.cache.capabilities, ['providers.list', 'provider.login.start']);

  const started = applyRuntimeEnvelope(welcome.cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 5,
    sessionId: 'session-1',
    event: {
      type: 'item.started',
      provider: 'codex',
      turnId: 'turn-1',
      itemId: 'answer-1',
      payload: { itemType: 'assistant_message', status: 'inProgress' },
    },
  });
  const streamed = applyRuntimeEnvelope(started.cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 6,
    sessionId: 'session-1',
    event: {
      type: 'content.delta',
      provider: 'codex',
      turnId: 'turn-1',
      itemId: 'answer-1',
      payload: { streamKind: 'assistant_text', delta: 'Hola' },
    },
  });
  assert.equal(streamed.cache.sessions[0]?.items[0]?.content.assistant_text, 'Hola');

  const completed = applyRuntimeEnvelope(streamed.cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 7,
    sessionId: 'session-1',
    event: { type: 'turn.completed', turnId: 'turn-1', payload: { state: 'interrupted' } },
  });
  assert.equal(completed.cache.sessions[0]?.items[0]?.status, 'completed');

  const identified = applyRuntimeEnvelope(completed.cache, {
    kind: 'session.identity.updated',
    runtimeId: 'runtime-1',
    seq: 8,
    sessionId: 'session-1',
    identity: {
      title: 'Acceso móvil remoto',
      goal: 'Manejar los agentes desde el móvil',
      activity: 'Sincronizando sesiones',
      activityHistory: [
        { activity: 'Sincronizando sesiones', createdAt: '2026-08-13T08:00:00.000Z', taskId: 12577 },
        { activity: 'Revisando el historial', createdAt: '2026-08-13T07:55:00.000Z' },
      ],
      workStatus: 'working',
      needsAttention: true,
      minimized: false,
      terminalOrder: 50,
      project: { name: 'CodeAgentSwarm', path: '/work/codeagentswarm', icon: 'emoji:🐝' },
    },
  });
  assert.equal(identified.cache.sessions[0]?.title, 'Acceso móvil remoto');
  assert.equal(identified.cache.sessions[0]?.terminalOrder, 50);
  assert.equal(identified.cache.sessions[0]?.needsAttention, true);
  assert.equal(identified.cache.sessions[0]?.minimized, false);
  assert.deepEqual(identified.cache.sessions[0]?.activityHistory, [
    { activity: 'Sincronizando sesiones', createdAt: '2026-08-13T08:00:00.000Z', taskId: 12577 },
    { activity: 'Revisando el historial', createdAt: '2026-08-13T07:55:00.000Z', taskId: null },
  ]);
  assert.equal(identified.cache.sessions[0]?.project?.icon, 'emoji:🐝');

  const configured = applyRuntimeEnvelope(identified.cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 9,
    sessionId: 'session-1',
    event: { type: 'session.config.updated', payload: { effort: 'low', serviceTier: 'fast' } },
  });
  assert.equal(configured.cache.sessions[0]?.effort, 'low');
  assert.equal(configured.cache.sessions[0]?.serviceTier, 'fast');

  const booleanReasoning = applyRuntimeEnvelope(configured.cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 10,
    sessionId: 'session-1',
    event: { type: 'session.config.updated', payload: { effort: false } },
  });
  assert.equal(booleanReasoning.cache.sessions[0]?.effort, false);

  const advanced = applyRuntimeEnvelope(booleanReasoning.cache, {
    kind: 'cursor.advanced',
    runtimeId: 'runtime-1',
    seq: 12,
  });
  assert.equal(advanced.gap, false);
  assert.equal(advanced.cache.lastSeq, 12);

  const gap = applyRuntimeEnvelope(advanced.cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 14,
    sessionId: 'session-1',
    event: { type: 'turn.completed', payload: { state: 'completed' } },
  });
  assert.equal(gap.gap, true);
  assert.equal(gap.cache.lastSeq, 12);
});

test('requests a fresh snapshot when project management outgrows the cached project shape', () => {
  const cache = {
    ...emptyRuntimeCache(),
    runtimeId: 'runtime-1',
    lastSeq: 7,
    projects: [{ name: 'CodeAgentSwarm', path: '/work/codeagentswarm' }],
  };
  const replay = applyRuntimeEnvelope(cache, {
    kind: 'welcome',
    runtimeId: 'runtime-1',
    latestSeq: 7,
    reset: false,
    capabilities: ['projects.list', 'project.create', 'tasks.list', 'task.create'],
  });
  assert.equal(replay.gap, true);
});

test('normalizes only supported CAS Cloud providers', () => {
  assert.deepEqual(normalizeRuntimeProvider({
    id: 'codex',
    name: 'Codex',
    installed: true,
    version: '1.2.3',
    login: { mode: 'cli', status: { known: true, loggedIn: false } },
  }), {
    id: 'codex',
    name: 'Codex',
    installed: true,
    version: '1.2.3',
    login: { mode: 'cli', status: { known: true, loggedIn: false, detail: undefined } },
  });
  assert.equal(normalizeRuntimeProvider({ id: 'unknown' }), null);
});

test('keeps legacy desktop runtimes usable when the welcome omits available agents', () => {
  const welcome = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-legacy-agents',
    latestSeq: 0,
    reset: true,
    snapshot: {},
  });

  assert.deepEqual(welcome.cache.availableAgents, [
    'claude', 'codex', 'antigravity', 'opencode', 'kimi', 'grok', 'cursor', 'pi',
  ]);
});

test('timestamps an assistant item when its first text arrives before item.started', () => {
  const cache = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-1',
    latestSeq: 0,
    reset: true,
    snapshot: {
      sessions: [{ sessionId: 'session-1', state: 'running', items: [], pendingRequests: [], pendingQuestions: [] }],
      projects: [],
    },
  }).cache;
  const streamed = applyRuntimeEnvelope(cache, {
    kind: 'session.event',
    runtimeId: 'runtime-1',
    seq: 1,
    sessionId: 'session-1',
    event: {
      type: 'content.delta',
      itemId: 'answer-1',
      createdAt: '2026-08-17T20:00:00.000Z',
      payload: { streamKind: 'assistant_text', delta: 'Hola' },
    },
  });
  assert.equal(streamed.cache.sessions[0]?.items[0]?.startedAtMs, Date.parse('2026-08-17T20:00:00.000Z'));
});

test('normalizes todo items received from the desktop runtime', () => {
  const cache = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-todos',
    latestSeq: 1,
    reset: true,
    snapshot: {
      sessions: [{
        sessionId: 'session-1',
        items: [{
          itemId: 'plan-1',
          itemType: 'plan',
          content: {},
          todos: [
            { step: 'Inspect the flow', status: 'completed' },
            { step: 'Render the checklist', status: 'in_progress' },
            { step: 'Verify mobile', status: 'unknown' },
            { status: 'pending' },
          ],
        }],
      }],
    },
  }).cache;

  assert.deepEqual(cache.sessions[0]?.items[0]?.todos, [
    { step: 'Inspect the flow', status: 'completed' },
    { step: 'Render the checklist', status: 'in_progress' },
    { step: 'Verify mobile', status: 'pending' },
  ]);
});

test('updates account quota without disturbing live sessions', () => {
  const hydrated = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-quota',
    latestSeq: 0,
    reset: true,
    snapshot: { sessions: [{ sessionId: 'session-1', agent: 'claude' }] },
  }).cache;

  const updated = applyRuntimeEnvelope(hydrated, {
    kind: 'quota.updated',
    runtimeId: 'runtime-quota',
    seq: 1,
    snapshots: [{
      agent: 'claude',
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'anthropic',
      plan: 'Max',
      windows: [{ key: 'weekly', remainingFraction: 0.51 }],
      tightest: { remainingFraction: 0.51, severity: 'normal' },
      fetchedAt: Date.now(),
    }],
  });

  assert.equal(updated.gap, false);
  assert.equal(updated.cache.sessions[0], hydrated.sessions[0]);
  assert.equal(updated.cache.sessions[0]?.sessionId, 'session-1');
  assert.equal(updated.cache.quotas[0]?.agent, 'claude');
  assert.equal(updated.cache.quotas[0]?.accountId, 'work');
  assert.equal(updated.cache.quotas[0]?.accountLabel, 'Work');
});

test('keeps unrelated session timelines referentially stable', () => {
  const hydrated = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-stable-timeline',
    latestSeq: 0,
    reset: true,
    snapshot: {
      sessions: [
        { sessionId: 'open-chat', items: [{ itemId: 'answer', content: { assistant_text: 'Stable' } }] },
        { sessionId: 'background-chat', items: [] },
      ],
    },
  }).cache;

  const updated = applyRuntimeEnvelope(hydrated, {
    kind: 'session.identity.updated',
    runtimeId: 'runtime-stable-timeline',
    seq: 1,
    sessionId: 'background-chat',
    identity: { activity: 'Still working' },
  }).cache;

  assert.equal(updated.sessions[0], hydrated.sessions[0]);
  assert.equal(updated.sessions[0]?.items, hydrated.sessions[0]?.items);
  assert.notEqual(updated.sessions[1], hydrated.sessions[1]);
});

test('updates project worktree eligibility without reconnecting', () => {
  const hydrated = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-projects',
    latestSeq: 0,
    reset: true,
    snapshot: {
      projects: [{ name: 'Workspace', path: '/work' }],
      availableAgents: ['codex', 'claude'],
    },
  }).cache;

  const updated = applyRuntimeEnvelope(hydrated, {
    kind: 'projects.updated',
    runtimeId: 'runtime-projects',
    seq: 1,
    projects: [{ name: 'Workspace', path: '/work', worktreeEligible: true, useWorktreeByDefault: false }],
  });

  assert.equal(updated.gap, false);
  assert.equal(updated.cache.projects[0]?.worktreeEligible, true);
  assert.equal(updated.cache.projects[0]?.useWorktreeByDefault, false);
  assert.deepEqual(updated.cache.availableAgents, ['codex', 'claude']);
});

test('carries the desktop shortcut catalog from the welcome snapshot and every project update', () => {
  const hydrated = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-shortcuts',
    latestSeq: 0,
    reset: true,
    snapshot: {
      projects: [{ name: 'Workspace', path: '/work' }],
      shortcuts: [
        { shortcutId: '1', name: 'Release', projectPath: '/work', projectName: 'Workspace', color: '#ec407a', agent: 'codex', useWorktree: true },
        { shortcutId: '2', projectPath: '', projectName: 'Gone', agent: 'claude', useWorktree: null },
      ],
    },
  }).cache;

  assert.deepEqual(hydrated.shortcuts, [{
    shortcutId: '1',
    name: 'Release',
    projectPath: '/work',
    projectName: 'Workspace',
    color: '#ec407a',
    agent: 'codex',
    useWorktree: true,
  }]);

  const updated = applyRuntimeEnvelope(hydrated, {
    kind: 'projects.updated',
    runtimeId: 'runtime-shortcuts',
    seq: 1,
    projects: [{ name: 'Workspace', path: '/work' }],
    shortcuts: [{ shortcutId: '3', name: 'Dashboard', projectPath: '/work', projectName: 'Workspace', agent: 'antigravity', useWorktree: false }],
  }).cache;

  assert.deepEqual(updated.shortcuts.map((shortcut) => shortcut.shortcutId), ['3']);
  assert.equal(updated.shortcuts[0]?.useWorktree, false);

  // A desktop that predates the catalog sends no shortcuts at all: the bar just goes empty.
  const legacy = applyRuntimeEnvelope(updated, {
    kind: 'projects.updated',
    runtimeId: 'runtime-shortcuts',
    seq: 2,
    projects: [{ name: 'Workspace', path: '/work' }],
  }).cache;

  assert.deepEqual(legacy.shortcuts, []);
});

test('keeps the desktop terminal order when statuses and activity change', () => {
  const cache = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-order',
    latestSeq: 1,
    reset: true,
    snapshot: {
      sessions: [
        { sessionId: 'second', terminalOrder: 2, workStatus: 'working', lastSeq: 99 },
        { sessionId: 'unknown', workStatus: 'needs_input', lastSeq: 100 },
        { sessionId: 'first', terminalOrder: 1, workStatus: 'done', lastSeq: 1 },
      ],
    },
  }).cache;

  assert.deepEqual(
    sortSessionsByTerminalOrder(cache.sessions).map((session) => session.sessionId),
    ['first', 'second', 'unknown'],
  );
});

test('sorts a status section by the same latest-activity clock shown in the list', () => {
  const cache = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-recent',
    latestSeq: 1,
    reset: true,
    snapshot: {
      sessions: [
        { sessionId: 'old', workStatus: 'pushed', lastActivityAt: 10 },
        { sessionId: 'new', workStatus: 'pushed', lastActivityAt: 30 },
        { sessionId: 'middle', workStatus: 'pushed', lastActivityAt: 20 },
      ],
    },
  }).cache;

  assert.deepEqual(
    sortSessionsByRecentActivity(cache.sessions).map((session) => session.sessionId),
    ['new', 'middle', 'old'],
  );
});

test('keeps the timeline when an existing session is reopened after stop or resume', () => {
  const cache = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome',
    runtimeId: 'runtime-reopen',
    latestSeq: 1,
    reset: true,
    snapshot: {
      sessions: [{
        sessionId: 'session-1',
        state: 'stopped',
        items: [{ itemId: 'mobile-user-1', itemType: 'user_message', data: { text: 'Keep me' }, content: {} }],
      }],
    },
  }).cache;

  const reopened = applyRuntimeEnvelope(cache, {
    kind: 'session.opened',
    runtimeId: 'runtime-reopen',
    seq: 2,
    session: { sessionId: 'session-1', clientRequestId: 'mobile-create-1', agent: 'codex', state: 'ready' },
  });

  assert.equal(reopened.cache.sessions[0]?.state, 'ready');
  assert.equal(reopened.cache.sessions[0]?.clientRequestId, 'mobile-create-1');
  assert.equal(reopened.cache.sessions[0]?.items[0]?.data?.text, 'Keep me');
});

test('detects sessions that just started needing attention', () => {
  const previous = [
    { sessionId: 'old', needsAttention: true, attentionVersion: 1 },
    { sessionId: 'fresh', needsAttention: false, attentionVersion: 0 },
  ];
  const next = [
    { sessionId: 'old', needsAttention: true, attentionVersion: 1 },
    { sessionId: 'fresh', needsAttention: true, attentionVersion: 1 },
    { sessionId: 'new', needsAttention: true, attentionVersion: 1 },
  ];
  assert.deepEqual(
    newlyAttentiveSessions(previous as never, next as never).map((session) => session.sessionId),
    ['fresh', 'new'],
  );

  const agents = ['claude', 'codex', 'antigravity', 'opencode', 'kimi', 'grok', 'cursor', 'pi'];
  const agentSessions = agents.map((agent) => ({ sessionId: agent, agent, needsAttention: true, attentionVersion: 1 }));
  assert.deepEqual(
    newlyAttentiveSessions([], agentSessions as never).map((session) => session.agent),
    agents,
  );
});

test('builds a short system alert from a session without transcript text', () => {
  assert.deepEqual(sessionAlertCopy({ sessionId: 's1', title: 'Fix login' }), {
    sessionId: 's1',
    title: 'Fix login',
    body: 'A session needs your attention',
  });
  assert.equal(sessionAlertCopy({ sessionId: 's2', title: '   ' }).title, 'CodeAgentSwarm');
});


test('streaming replaces only the changed message, including timestamp-only deltas', () => {
  let cache = applyRuntimeEnvelope(emptyRuntimeCache(), {
    kind: 'welcome', runtimeId: 'memo', latestSeq: 0, reset: true,
    snapshot: { sessions: [{ sessionId: 'chat', items: [
      { itemId: 'settled', itemType: 'assistant_message', content: { assistant_text: 'Done' } },
      { itemId: 'streaming', itemType: 'assistant_message', content: {} },
    ] }] },
  }).cache;
  const settled = cache.sessions[0].items[0];
  for (const [index, delta] of ['', 'Hello', ' world'].entries()) {
    const previous = cache.sessions[0].items[1];
    const oldContent = { ...previous.content };
    const oldStartedAt = previous.startedAtMs;
    cache = applyRuntimeEnvelope(cache, {
      kind: 'session.event', runtimeId: 'memo', sessionId: 'chat', seq: index + 1,
      event: { type: 'content.delta', itemId: 'streaming', createdAt: '2026-09-06T00:00:00Z',
        payload: { streamKind: 'assistant_text', delta } },
    }).cache;
    assert.equal(cache.sessions[0].items[0], settled);
    assert.notEqual(cache.sessions[0].items[1], previous);
    assert.deepEqual(previous.content, oldContent);
    assert.equal(previous.startedAtMs, oldStartedAt);
    assert.equal(cache.sessions[0].items[1].startedAtMs, Date.parse('2026-09-06T00:00:00Z'));
  }
  assert.equal(cache.sessions[0].items[1].content.assistant_text, 'Hello world');
});
