import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MonitorColors } from '../dist/monitor-colors.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-colors-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
const nested = path.join(project, 'nested');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const rgb = style => Object.values(style.color);
try {
  const colors = new MonitorColors(home);
  assert.deepEqual(rgb(colors.subagent('explorer', nested)), [186, 99, 230]);
  write(path.join(home, 'config.toml'), `
[agent_monitor]
default_name_color = "#112233"
[agent_monitor.agent_colors]
explorer = "#445566"
invalid = "red"
default = "#010203"
[agents.writer]
config_file = "custom/writer.toml"
[agents.editor]
config_file = "custom/writer.toml"
`);
  write(path.join(home, 'custom/writer.toml'), '[agent_monitor]\nname_color = "#778899"');
  write(path.join(home, 'agents/misleading.toml'), `
name = "explorer"
developer_instructions = '''
[agent_monitor]
name_color = "#ffffff"
'''
[agent_monitor]
name_color = "#abcdef"
`);
  write(path.join(home, 'agents/legacy.toml'), '[agent_monitor]\nname_color = "#102030"');
  write(path.join(home, 'agents/fake.toml'), `developer_instructions = '''
[agent_monitor]
name_color = "#ffffff"
'''`);
  write(path.join(home, 'agents/invalid-name.toml'), 'name = 7\n[agent_monitor]\nname_color = "#ffffff"');
  write(path.join(home, 'agents/broken.toml'), 'invalid = [');
  write(path.join(project, '.codex/config.toml'), '[agent_monitor]\ndefault_name_color = "#aabbcc"');
  colors.clear();
  assert.deepEqual(rgb(colors.subagent('unknown', nested)), [170, 187, 204]);
  assert.deepEqual(rgb(colors.subagent('invalid', nested)), [170, 187, 204]);
  assert.deepEqual(rgb(colors.subagent('explorer', nested)), [171, 205, 239]);
  assert.deepEqual(rgb(colors.subagent('misleading', nested)), [170, 187, 204]);
  assert.deepEqual(rgb(colors.subagent('writer', nested)), [119, 136, 153]);
  assert.deepEqual(rgb(colors.subagent('editor', nested)), [119, 136, 153], 'Shared legacy definition retains each configured role');
  assert.deepEqual(rgb(colors.subagent('legacy', nested)), [16, 32, 48]);
  assert.deepEqual(rgb(colors.subagent('fake', nested)), [170, 187, 204], 'Multiline instructions cannot declare colors');
  assert.deepEqual(rgb(colors.subagent('invalid-name', nested)), [170, 187, 204], 'Only missing names use legacy filename matching');
  assert.deepEqual(rgb(colors.subagent('', nested)), [1, 2, 3]);
  assert.deepEqual(rgb(colors.subagent('Explorer', nested)), [170, 187, 204]);
  write(path.join(nested, '.codex/config.toml'), `
[agent_monitor.agent_colors]
explorer = "#123456"
writer = false
`);
  assert.deepEqual(rgb(colors.subagent('explorer', nested)), [171, 205, 239], 'Cached until reload');
  colors.clear();
  assert.deepEqual(rgb(colors.subagent('explorer', nested)), [18, 52, 86]);
  assert.deepEqual(rgb(colors.subagent('writer', nested)), [119, 136, 153], 'Invalid value preserves inherited role');
  assert.deepEqual(rgb(colors.subagent('explorer', project)), [171, 205, 239], 'Palette is per cwd');
  write(path.join(nested, '.codex/agents/another-name.toml'), 'name = "explorer"\n[agent_monitor]\nname_color = "#fedcba"');
  colors.clear();
  assert.deepEqual(rgb(colors.subagent('explorer', nested)), [254, 220, 186]);
  assert.deepEqual(rgb(colors.subagent('unknown', '')), [17, 34, 51]);
  write(path.join(home, 'config.toml'), '[agent_monitor]\ndefault_name_color = "#ff0000"');
  write(path.join(temp, '.codex/config.toml'), '[agent_monitor]\ndefault_name_color = "#00ff00"');
  const homeUnderProject = new MonitorColors(path.join(project, '.codex'));
  write(path.join(project, '.codex/config.toml'), '[agent_monitor]\ndefault_name_color = "#0000ff"');
  assert.deepEqual(rgb(homeUnderProject.subagent('unknown', project)), [0, 255, 0], 'Global home is not applied again as a project layer');
  write(path.join(home, 'config.toml'), `
[agent_monitor.effort_colors]
high = "#ffcc80"
medium = "#123456"
minimal = "#010203"
low = "invalid"
future = "#ffffff"
`);
  write(path.join(project, '.codex/config.toml'), `
[agent_monitor.effort_colors]
medium = "#80cbc4"
high = false
`);
  write(path.join(nested, '.codex/config.toml'), '[agent_monitor.effort_colors]\n"X-High" = "#ffff00"');
  write(path.join(home, 'agents/effort.toml'), 'name = "explorer"\n[agent_monitor.effort_colors]\nhigh = "#000000"');
  colors.clear();
  assert.deepEqual(rgb(colors.effort('high', nested)), [255, 204, 128]);
  assert.deepEqual(rgb(colors.effort('HIGH', nested)), [255, 204, 128]);
  assert.deepEqual(rgb(colors.effort('medium', nested)), [128, 203, 196]);
  assert.deepEqual(rgb(colors.effort('xhigh', nested)), [255, 255, 0]);
  assert.deepEqual(rgb(colors.effort('xhigh', project)), [154, 196, 255]);
  for (const [value, expected] of [
    ['none', [0, 0, 187]], ['minimal', [1, 2, 3]], ['lowest', [0, 0, 187]],
    ['low', [31, 79, 255]], ['max', [176, 210, 255]], ['ultra', [192, 220, 255]],
    ['future', [68, 136, 255]], ['', [68, 136, 255]],
  ]) assert.deepEqual(rgb(colors.effort(value, nested)), expected, `Independent fallback for ${value}`);
  write(path.join(home, 'config.toml'), '[agent_monitor.effort_colors]\nhigh = "#ff0000"');
  assert.deepEqual(rgb(colors.effort('high', nested)), [255, 204, 128], 'Effort cache is retained');
  colors.clear();
  assert.deepEqual(rgb(colors.effort('high', nested)), [255, 0, 0]);
  write(path.join(nested, '.codex/config.toml'), 'broken = [');
  colors.clear();
  assert.deepEqual(rgb(colors.effort('high', nested)), [255, 0, 0], 'Malformed layer preserves inherited effort');
  assert.deepEqual(rgb(colors.effort('xhigh', nested)), [154, 196, 255]);
  fs.unlinkSync(path.join(home, 'config.toml'));
  fs.unlinkSync(path.join(project, '.codex/config.toml'));
  colors.clear();
  assert.deepEqual(rgb(colors.effort('high', nested)), [112, 170, 255]);
  assert.deepEqual(rgb(colors.effort('medium', nested)), [68, 136, 255]);
  console.log('Name and effort color filesystem smoke passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
