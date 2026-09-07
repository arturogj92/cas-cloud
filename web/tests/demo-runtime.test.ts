import assert from 'node:assert/strict';
import test from 'node:test';

import { completeDemoTurn, createDemoRuntimeState, runDemoCommand } from '../src/demo-runtime';

test('the review demo covers every mobile agent with realistic interactive data', () => {
  const now = Date.parse('2026-08-16T18:00:00.000Z');
  const state = createDemoRuntimeState(now);

  assert.equal(state.phase, 'online');
  assert.deepEqual(
    new Set(state.sessions.map((session) => session.agent)),
    new Set(['claude', 'codex', 'antigravity', 'opencode', 'kimi', 'grok']),
  );
  assert.ok(state.sessions.some((session) => session.items.some((item) => item.itemType === 'plan')));
  assert.ok(state.sessions.some((session) => session.pendingQuestions.length));
  assert.ok(state.projects.some((project) => project.icon?.startsWith('emoji:')));
  assert.ok(state.quotas.length >= 2);
});

test('the review demo can send, answer, change status and create a session without a desktop', () => {
  const now = Date.parse('2026-08-16T18:00:00.000Z');
  let state = createDemoRuntimeState(now);
  const sessionId = state.sessions[0].sessionId;

  state = runDemoCommand(state, {
    type: 'turn.send',
    sessionId,
    payload: { text: 'Is the 1.0 release ready?', commandId: 'demo-turn-1' },
  }, now).state;
  assert.equal(state.sessions[0].state, 'running');
  assert.equal(state.sessions[0].items.at(-2)?.itemType, 'user_message');
  assert.equal(state.sessions[0].items.at(-1)?.status, 'inProgress');

  state = completeDemoTurn(state, sessionId, 'Is the 1.0 release ready?', now + 900, 'demo-turn-1');
  assert.equal(state.sessions[0].state, 'ready');
  assert.match(state.sessions[0].items.at(-1)?.content.assistant_text || '', /release/i);

  state = runDemoCommand(state, {
    type: 'session.status',
    sessionId,
    payload: { status: 'needs_testing' },
  }, now + 1_000).state;
  assert.equal(state.sessions[0].workStatus, 'needs_testing');

  state = runDemoCommand(state, {
    type: 'question.respond',
    sessionId,
    payload: { requestId: state.sessions[0].pendingQuestions[0].requestId },
  }, now + 1_100).state;
  assert.equal(state.sessions[0].pendingQuestions.length, 0);

  const created = runDemoCommand(state, {
    type: 'session.create',
    payload: {
      agent: 'grok',
      cwd: '/Users/reviewer/Development/codeagentswarm',
      initialPrompt: 'Review the demo flow',
      clientRequestId: 'demo-client-request',
    },
  }, now + 1_200);
  assert.equal(created.result?.sessionId, 'demo-demo-client-request');
  assert.equal(created.state.sessions[0].agent, 'grok');
  assert.match(created.state.sessions[0].items[0]?.data?.text as string, /Review the demo flow/);

  const continued = runDemoCommand(created.state, {
    type: 'session.handoff',
    sessionId: created.state.sessions[0].sessionId,
    payload: { targetAgent: 'claude' },
  }, now + 1_300);
  assert.equal(continued.result?.success, true);
  assert.equal(continued.state.sessions[0].agent, 'claude');
  assert.equal(continued.state.sessions[0].items.length, created.state.sessions[0].items.length);
});

test('an interrupted demo turn cannot append a delayed response', () => {
  const now = Date.parse('2026-08-16T18:00:00.000Z');
  const initial = createDemoRuntimeState(now);
  const sessionId = initial.sessions[0].sessionId;
  let state = runDemoCommand(initial, {
    type: 'turn.send',
    sessionId,
    payload: { text: 'Continue the release', commandId: 'stale-turn' },
  }, now).state;
  state = runDemoCommand(state, { type: 'turn.interrupt', sessionId }, now + 100).state;
  const itemCount = state.sessions[0].items.length;

  state = completeDemoTurn(state, sessionId, 'Continue the release', now + 900, 'stale-turn');

  assert.equal(state.sessions[0].state, 'ready');
  assert.equal(state.sessions[0].items.length, itemCount);
  assert.equal(state.sessions[0].items.some((item) => item.status === 'inProgress'), false);
  assert.equal(state.sessions[0].activity, 'Turn interrupted');
});

test('a replacement demo turn settles the previous work', () => {
  const now = Date.parse('2026-08-16T18:00:00.000Z');
  const initial = createDemoRuntimeState(now);
  const sessionId = initial.sessions[0].sessionId;
  let state = runDemoCommand(initial, {
    type: 'turn.send',
    sessionId,
    payload: { text: 'First message', commandId: 'first-turn' },
  }, now).state;
  state = runDemoCommand(state, {
    type: 'turn.send',
    sessionId,
    payload: { text: 'Second message', commandId: 'second-turn' },
  }, now + 100).state;

  assert.equal(state.sessions[0].items.filter((item) => item.status === 'inProgress').length, 1);
  state = completeDemoTurn(state, sessionId, 'First message', now + 850, 'first-turn');
  assert.equal(state.sessions[0].currentTurn?.turnId, 'second-turn');
  state = completeDemoTurn(state, sessionId, 'Second message', now + 950, 'second-turn');
  assert.equal(state.sessions[0].items.some((item) => item.status === 'inProgress'), false);
});


test('every advertised demo agent keeps its identity when creating a session', () => {
  const state = createDemoRuntimeState();
  for (const agent of state.availableAgents) {
    const created = runDemoCommand(state, {
      type: 'session.create',
      payload: { agent, cwd: state.projects[0].path, clientRequestId: `demo-${agent}` },
    });
    assert.equal(created.state.sessions[0].agent, agent);
  }
});
