import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { MonitorStore } from '../dist/store.js';

const allowed = new Set([
  'initialize', 'thread/loaded/list', 'thread/list', 'thread/read', 'thread/turns/list',
]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-agent-monitor-smoke-'));
const socket = path.join(directory, 'app-server.sock');
const server = http.createServer();
const wsServer = new WebSocketServer({ server });
// ws re-emits server listen errors. The listen promise below owns the failure.
wsServer.on('error', () => {});
const threads = new Map();
const loaded = new Set();
const methods = new Map();
const unexpected = [];
let store;

function thread(id, parentId, role, status) {
  const now = Math.floor(Date.now() / 1000);
  const source = parentId
    ? { subAgent: { thread_spawn: {
        parent_thread_id: parentId,
        agent_role: role,
        agent_nickname: `${role}-${id}`,
        agent_path: `/root/${id}`,
      } } }
    : 'cli';
  return {
    id, parentThreadId: parentId, name: parentId ? '' : 'reconnect-fixture',
    cwd: '/tmp/reconnect-fixture', agentRole: role, agentNickname: '',
    model: 'fixture-model', reasoningEffort: 'medium', preview: `Task for ${id}`,
    updatedAt: now, recencyAt: now, ephemeral: false, source,
    status: { type: status, activeFlags: [] },
  };
}

function descendantOf(candidate, ancestorId) {
  const visited = new Set();
  let parentId = candidate.parentThreadId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = threads.get(parentId)?.parentThreadId;
  }
  return false;
}

function reply(method, params) {
  switch (method) {
    case 'initialize': return { userAgent: 'codex-cli/fixture', codexHome: directory };
    case 'thread/loaded/list': return { data: [...loaded], nextCursor: null };
    case 'thread/list': {
      const sourceKinds = params?.sourceKinds ?? [];
      const ancestor = params?.ancestorThreadId;
      const data = [...threads.values()].filter(value => ancestor
        ? descendantOf(value, ancestor)
        : !value.parentThreadId && sourceKinds.includes('cli'));
      return { data, nextCursor: null };
    }
    case 'thread/read': {
      const value = threads.get(params?.threadId);
      if (!value) throw new Error(`Unknown thread ${params?.threadId}`);
      return { thread: value };
    }
    case 'thread/turns/list': return { data: [], nextCursor: null };
    default: throw new Error(`Unexpected RPC ${method}`);
  }
}

wsServer.on('connection', client => {
  client.on('message', bytes => {
    let message;
    try { message = JSON.parse(bytes.toString()); }
    catch { unexpected.push('invalid JSON'); return; }
    if (message.method === 'initialized' && message.id === undefined) return;
    methods.set(message.method, (methods.get(message.method) ?? 0) + 1);
    if (!allowed.has(message.method)) {
      unexpected.push(message.method);
      client.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not allowed' } }));
      return;
    }
    try {
      client.send(JSON.stringify({ id: message.id, result: reply(message.method, message.params) }));
    } catch (error) {
      unexpected.push(error.message);
      client.send(JSON.stringify({ id: message.id, error: { code: -32603, message: 'Fixture error' } }));
    }
  });
});

function notify(method, params) {
  const message = JSON.stringify({ method, params });
  for (const client of wsServer.clients) if (client.readyState === client.OPEN) client.send(message);
}

async function until(label, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  store = new MonitorStore(socket, 60);
  await store.start();
  assert.equal(store.connected, true);
  assert.equal(store.agents.size, 0, 'fixture should start empty');

  for (const [id, parent, role] of [
    ['root', null, ''], ['child', 'root', 'worker'], ['grandchild', 'child', 'explorer'],
  ]) {
    const value = thread(id, parent, role, 'active');
    threads.set(id, value);
    loaded.add(id);
    notify('thread/started', { thread: value });
  }
  const afterStart = store.reconciliations;
  await until('started threads and reconciliation', () => store.agents.size === 3 && store.reconciliations > afterStart);
  assert.equal(store.agents.get('child')?.parentId, 'root');
  assert.equal(store.agents.get('grandchild')?.parentId, 'child');
  assert.equal(store.agents.get('grandchild')?.role, 'explorer');
  for (const value of store.agents.values()) {
    assert.equal(value.status, 'active');
    assert.equal(value.model, 'fixture-model');
    assert.match(value.prompt, /^Task for /);
  }

  for (const value of threads.values()) {
    value.status = { type: 'idle', activeFlags: [] };
    notify('thread/status/changed', { threadId: value.id, status: value.status });
  }
  await until('idle notifications', () => [...store.agents.values()].every(value => value.status === 'idle'));
  for (const client of wsServer.clients) client.terminate();
  await until('disconnect state', () => !store.connected && [...store.agents.values()].every(value => value.status === 'unknown'));
  assert.match(store.connection, /reconnecting/i);
  await until('authoritative reconnect', () => store.connected && [...store.agents.values()].every(value => value.status === 'idle'), 9000);
  assert.equal(store.agents.get('grandchild')?.parentId, 'child');
  assert.deepEqual(unexpected, []);
  for (const method of allowed) assert.ok(methods.get(method) > 0, `${method} should have been requested`);
  console.log('PASS: empty startup, nested spawn, active/idle notifications, disconnect, unknown state, authoritative reconnect');
  console.log(`Read-only RPCs: ${[...methods].map(([method, count]) => `${method}=${count}`).join(', ')}`);
} finally {
  store?.stop();
  for (const client of wsServer.clients) client.terminate();
  await new Promise(resolve => wsServer.close(resolve));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(socket, { force: true });
  await rm(directory, { recursive: true });
}
