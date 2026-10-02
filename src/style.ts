export type ColorMode = 'truecolor' | '256' | 'none';

export interface TextStyle {
  readonly color?: Rgb;
  readonly bold?: boolean;
}

interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export type StateKind =
  | 'active'
  | 'idle'
  | 'notLoaded'
  | 'starting'
  | 'stopped'
  | 'failed'
  | 'interrupted'
  | 'completed'
  | 'unknown';

const rgb = (red: number, green: number, blue: number): Rgb => ({ red, green, blue });

export const styles = {
  rootName: { color: rgb(255, 255, 255), bold: true },
  subagentName: { color: rgb(186, 99, 230), bold: true },
  fieldLabel: { color: rgb(119, 119, 119) },
  timestamp: { color: rgb(119, 119, 119) },
  model: { bold: true },
  subagentModel: { color: rgb(221, 221, 221), bold: true },
  detailMarker: { color: rgb(255, 255, 255) },
  selectedMarker: { color: rgb(186, 99, 230), bold: true },
} satisfies Record<string, TextStyle>;

const stateStyles: Record<StateKind, TextStyle> = {
  active: { color: rgb(69, 214, 91), bold: true },
  idle: { color: rgb(153, 153, 153), bold: true },
  notLoaded: { color: rgb(85, 85, 85), bold: true },
  starting: { color: rgb(213, 217, 75), bold: true },
  stopped: { color: rgb(224, 75, 75), bold: true },
  failed: { color: rgb(255, 85, 85), bold: true },
  interrupted: { color: rgb(229, 138, 58), bold: true },
  completed: { color: rgb(82, 199, 165), bold: true },
  unknown: { color: rgb(185, 153, 85), bold: true },
};

const effortStyles = new Map<string, TextStyle>([
  ['none', { color: rgb(0, 0, 187), bold: true }],
  ['minimal', { color: rgb(0, 0, 187), bold: true }],
  ['lowest', { color: rgb(0, 0, 187), bold: true }],
  ['low', { color: rgb(31, 79, 255), bold: true }],
  ['medium', { color: rgb(68, 136, 255), bold: true }],
  ['high', { color: rgb(112, 170, 255), bold: true }],
  ['xhigh', { color: rgb(154, 196, 255), bold: true }],
  ['max', { color: rgb(176, 210, 255), bold: true }],
  ['ultra', { color: rgb(192, 220, 255), bold: true }],
]);

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normalizeState(value: string): StateKind {
  const state = compact(value);
  if (/^(notloaded|unloaded|removed|gone)$/.test(state)) return 'notLoaded';
  if (/^(idle|waiting|inactive|loaded)$/.test(state)) return 'idle';
  if (/^(active|busy|running|inprogress|working)$/.test(state)) return 'active';
  if (/^(starting|initializing|queued|pending)$/.test(state)) return 'starting';
  if (/^(stopped|terminated)$/.test(state)) return 'stopped';
  if (/^(failed|error|systemerror)$/.test(state)) return 'failed';
  if (/^(interrupted|cancelled|canceled|aborted)$/.test(state)) return 'interrupted';
  if (/^(completed|complete|done|succeeded|success)$/.test(state)) return 'completed';
  return 'unknown';
}

export function stateStyle(value: string): TextStyle {
  return stateStyles[normalizeState(value)];
}

export function stateSymbol(value: string): string {
  switch (normalizeState(value)) {
    case 'active': return '●';
    case 'idle': return '○';
    case 'completed': return '✓';
    case 'failed':
    case 'interrupted':
    case 'stopped': return '!';
    case 'notLoaded':
    case 'starting':
    case 'unknown': return '·';
  }
}

export function effortStyle(value: string): TextStyle {
  return effortStyles.get(normalizeEffort(value) ?? '') ?? { color: rgb(68, 136, 255), bold: true };
}

export function normalizeEffort(value: string): string | undefined {
  const effort = compact(value);
  return effortStyles.has(effort) ? effort : undefined;
}

export function colorMode(environment: NodeJS.ProcessEnv = process.env): ColorMode {
  const override = environment.CODEX_AGENT_MONITOR_COLOR?.toLowerCase();
  if (override === 'truecolor' || override === '256' || override === 'none') return override;
  // PuTTY commonly advertises plain xterm without COLORTERM even when truecolor
  // is enabled. The monitor therefore defaults to truecolor. Users of limited
  // terminals can request the deterministic 256-color or unstyled modes.
  return 'truecolor';
}

function ansi256(color: Rgb): number {
  const channel = (value: number): number => Math.round(value / 255 * 5);
  return 16 + 36 * channel(color.red) + 6 * channel(color.green) + channel(color.blue);
}

export function paint(text: string, style: TextStyle | undefined, mode: ColorMode): string {
  if (!text || mode === 'none' || !style || (!style.color && !style.bold)) return text;
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.color) {
    if (mode === 'truecolor') codes.push(`38;2;${style.color.red};${style.color.green};${style.color.blue}`);
    else codes.push(`38;5;${ansi256(style.color)}`);
  }
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}
