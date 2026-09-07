import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfilledHostRuntimeIds,
  hostScopedId,
  mergeHostHistory,
  scopeHostHistory,
  splitHostScopedId,
  unscopedCommand,
  withoutHostHistory,
} from '../src/host-scope';

test('routes session, project and history commands without mixing PC and Cloud', () => {
  const pcSession = hostScopedId('pc', 'same-session');
  const cloudSession = hostScopedId('cloud', 'same-session');
  assert.notEqual(pcSession, cloudSession);
  assert.deepEqual(splitHostScopedId(cloudSession), { runtimeId: 'cloud', value: 'same-session' });

  assert.deepEqual(unscopedCommand({
    type: 'session.create',
    payload: { agent: 'codex', cwd: hostScopedId('pc', '/work/app') },
  }), {
    runtimeId: 'pc',
    command: { type: 'session.create', payload: { agent: 'codex', cwd: '/work/app' } },
  });

  assert.deepEqual(unscopedCommand({ type: 'session.stop', sessionId: cloudSession }), {
    runtimeId: 'cloud',
    command: { type: 'session.stop', sessionId: 'same-session', payload: undefined },
  });

  assert.deepEqual(unscopedCommand({
    type: 'tasks.list', runtimeId: 'cloud', payload: { projectId: 'project-1', limit: 50 },
  }), {
    runtimeId: 'cloud',
    command: { type: 'tasks.list', payload: { projectId: 'project-1', limit: 50 } },
  });

  assert.throws(() => unscopedCommand({
    type: 'session.stop', runtimeId: 'pc', sessionId: cloudSession,
  }), /mixes two hosts/);

  assert.throws(() => unscopedCommand({
    type: 'session.resume',
    sessionId: pcSession,
    payload: { historyId: hostScopedId('cloud', 'history-1') },
  }), /mixes two hosts/);
});

test('scopes legacy history to its original host before resume', () => {
  const conversation = scopeHostHistory({
    id: 'history-1',
    sessionId: 'session-1',
    agent: 'codex',
    title: 'Legacy conversation',
    projectPath: '/work/app',
    projectDir: 'app',
    projectName: 'App',
    timestamp: 10,
  }, {
    runtimeId: 'pc',
    name: 'Windows workstation',
    kind: 'desktop',
    phase: 'online',
  });

  assert.deepEqual(splitHostScopedId(conversation.id), { runtimeId: 'pc', value: 'history-1' });
  assert.deepEqual(splitHostScopedId(conversation.sessionId), { runtimeId: 'pc', value: 'session-1' });
  assert.deepEqual(splitHostScopedId(conversation.projectPath), { runtimeId: 'pc', value: '/work/app' });
  assert.equal(conversation.hostRuntimeId, 'pc');
});

test('refreshes online history without deleting offline hosts and forgets only one host', () => {
  const pc = scopeHostHistory({
    id: 'pc-history', sessionId: 'pc-session', agent: 'codex', title: 'PC', projectPath: '/pc',
    projectDir: 'pc', projectName: 'PC', timestamp: 20,
  }, { runtimeId: 'pc', name: 'PC', kind: 'desktop', phase: 'offline' });
  const staleCloud = scopeHostHistory({
    id: 'cloud-old', sessionId: 'cloud-session', agent: 'kimi', title: 'Old cloud', projectPath: '/cloud',
    projectDir: 'cloud', projectName: 'Cloud', timestamp: 10,
  }, { runtimeId: 'cloud', name: 'Cloud', kind: 'cloud', phase: 'online' });
  const freshCloud = scopeHostHistory({
    id: 'cloud-new', sessionId: 'cloud-session', agent: 'kimi', title: 'Fresh cloud', projectPath: '/cloud',
    projectDir: 'cloud', projectName: 'Cloud', timestamp: 30,
  }, { runtimeId: 'cloud', name: 'Cloud', kind: 'cloud', phase: 'online' });

  const merged = mergeHostHistory([pc, staleCloud], [freshCloud], ['cloud']);
  assert.deepEqual(merged.map((conversation) => conversation.title), ['Fresh cloud', 'PC']);
  assert.deepEqual(withoutHostHistory(merged, 'cloud').map((conversation) => conversation.title), ['PC']);
});

test('marks only hosts that answered history.list as refreshed', () => {
  assert.deepEqual(fulfilledHostRuntimeIds([
    { status: 'fulfilled', value: { runtimeId: 'pc' } },
    { status: 'rejected', reason: new Error('offline') },
  ]), ['pc']);
});
