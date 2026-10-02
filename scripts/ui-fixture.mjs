// Deterministic renderer smoke data. No socket connection or model calls.
import { MonitorStore } from '../dist/store.js';
import { startUI } from '../dist/ui.js';

const store = new MonitorStore('/unused', 15);
store.connected = true;
store.connection = 'Connected';
store.reconciliations = 1;
function agent(id, parentId, status, effort, time) {
  return { id, parentId, status, effort, name: id, role: parentId ? 'explorer' : '', nickname: parentId ? id : '',
    agentPath: parentId ? `/root/${id}` : '',
    cwd: '/fixture', model: 'gpt-fixture', prompt: `task for ${id}`, spawnPrompt: '', promptSource: 'fixture',
    flags: [], lastActivity: time, lastTurnStatus: '' };
}
const now = Date.now() / 1000;
const entries = [
  agent('root-alpha', null, 'active', 'high', now),
  agent('child-idle', 'root-alpha', 'idle', 'medium', now - 1),
  agent('child-unloaded', 'root-alpha', 'notLoaded', 'low', now - 2),
  agent('bridge-unloaded', 'root-alpha', 'notLoaded', 'xhigh', now - 3),
  agent('grandchild-active', 'bridge-unloaded', 'active', 'ultra', now - 4),
  agent('root-idle', null, 'idle', 'max', now - 5),
  agent('root-unloaded', null, 'notLoaded', 'low', now - 6),
  agent('root-error', null, 'systemError', 'minimal', now - 7),
];
for (const a of entries) store.agents.set(a.id, a);
store.agents.get('grandchild-active').agentPath = '/root/bridge-unloaded/grandchild-active';
store.agents.get('child-unloaded').agentPath = '';
store.agents.get('root-alpha').prompt = 'First task line\n\n  - indented item\nLast line';
let changes = 0;
process.on('SIGUSR1', () => {
  changes++;
  if (changes === 1) store.agents.get('grandchild-active').model = 'gpt-updated';
  else if (changes === 2) store.agents.set('new-child', agent('new-child', 'root-alpha', 'idle', 'low', now - 10));
  else if (changes === 3) store.agents.delete('new-child');
  else store.agents.get('child-unloaded').agentPath = '/root/recovered-task';
  store.emit('change');
});
process.on('SIGUSR2', () => {
  store.agents.get('root-alpha').lastActivity += 1;
  store.emit('change');
});
store.refresh = async () => {
  store.agents.set('fresh-root', agent('fresh-root', null, 'idle', 'future-level', now - 8));
  store.agents.set('fresh-child', agent('fresh-child', 'fresh-root', 'idle', 'none', now - 9));
  store.emit('change');
};
const cleanup = startUI(store, () => { cleanup(); store.stop(); });
