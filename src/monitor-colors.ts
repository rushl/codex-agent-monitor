import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { effortStyle, normalizeEffort, styles, type TextStyle } from './style.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(value => ({
  red: Number.parseInt(value.slice(1, 3), 16),
  green: Number.parseInt(value.slice(3, 5), 16),
  blue: Number.parseInt(value.slice(5, 7), 16),
})).optional().catch(undefined);
const monitor = z.object({
  default_name_color: color,
  name_color: color,
  agent_colors: z.record(z.string(), color).catch({}),
  effort_colors: z.record(z.string(), color).catch({}),
}).catch({ agent_colors: {}, effort_colors: {} });
const document = z.object({
  name: z.string().optional(),
  agent_monitor: monitor,
  agents: z.record(z.string(), z.object({
    config_file: z.string().optional().catch(undefined),
  }).catch({})).catch({}),
});
type Palette = { defaultColor: TextStyle; roles: Map<string, TextStyle>; efforts: Map<string, TextStyle> };

function read(file: string): z.infer<typeof document> | undefined {
  try {
    return document.parse(parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function applyLayer(directory: string, palette: Palette): void {
  const config = read(path.join(directory, 'config.toml'));
  const defaultColor = config?.agent_monitor.default_name_color;
  if (defaultColor) palette.defaultColor = { color: defaultColor, bold: true };
  for (const [role, color] of Object.entries(config?.agent_monitor.agent_colors ?? {})) {
    if (color) palette.roles.set(role, { color, bold: true });
  }

  for (const [value, color] of Object.entries(config?.agent_monitor.effort_colors ?? {})) {
    const effort = normalizeEffort(value);
    if (effort && color) palette.efforts.set(effort, { color, bold: true });
  }

  const definitions: Array<{ file: string; configuredRole?: string }> = [];
  try {
    for (const file of fs.readdirSync(path.join(directory, 'agents')).sort()) {
      if (file.endsWith('.toml')) definitions.push({ file: path.join(directory, 'agents', file) });
    }
  } catch { /* An absent or unreadable agent directory has no cosmetic settings. */ }
  for (const [role, agent] of Object.entries(config?.agents ?? {})) {
    if (agent.config_file) definitions.push({ file: path.resolve(directory, agent.config_file), configuredRole: role });
  }
  for (const { file, configuredRole } of definitions) {
    const definition = read(file);
    const color = definition?.agent_monitor.name_color;
    if (!color) continue;
    const role = definition.name ?? configuredRole ?? path.basename(file, '.toml');
    if (role) palette.roles.set(role, { color, bold: true });
  }
}

export class MonitorColors {
  private readonly cache = new Map<string, Palette>();
  private readonly home: string;

  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
    this.home = path.resolve(home);
  }

  clear(): void {
    this.cache.clear();
  }

  subagent(role: string, cwd: string): TextStyle {
    const palette = this.palette(cwd);
    return palette.roles.get(role || 'default') ?? palette.defaultColor;
  }

  effort(value: string, cwd: string): TextStyle {
    const effort = normalizeEffort(value);
    return (effort ? this.palette(cwd).efforts.get(effort) : undefined) ?? effortStyle(value);
  }

  private palette(cwd: string): Palette {
    const key = cwd ? path.resolve(cwd) : '';
    let palette = this.cache.get(key);
    if (!palette) {
      palette = { defaultColor: styles.subagentName, roles: new Map(), efforts: new Map() };
      applyLayer(this.home, palette);
      const directories: string[] = [];
      if (key) {
        let directory = key;
        for (;;) {
          const configDirectory = path.join(directory, '.codex');
          if (configDirectory !== this.home) directories.push(configDirectory);
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
      for (const directory of directories.reverse()) applyLayer(directory, palette);
      this.cache.set(key, palette);
    }
    return palette;
  }
}
