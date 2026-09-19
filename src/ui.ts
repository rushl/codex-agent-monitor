import readline from 'node:readline';
import type { MonitorStore } from './store.js';
import { colorMode, effortStyle, normalizeState, paint, stateStyle, stateSymbol, styles, type ColorMode, type TextStyle } from './style.js';

type Agent = MonitorStore['agents'] extends Map<string, infer Value> ? Value : never;
type Key = readline.Key;
type Span = { text: string; style?: TextStyle };
type Line = { spans: Span[]; id: string | null };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clearScreen = '\x1b[H\x1b[2J';
const hideCursor = '\x1b[?25l';
const showCursor = '\x1b[?25h';
const resetStyle = '\x1b[0m';

// Store fields may contain prompt or workspace text. Keep it inert before it
// is measured, styled, or written to the terminal.
function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))?/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMultiline(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\ufeff]/g, '');
}

function cellWidth(grapheme: string): number {
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  if ((code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

function widthOf(value: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(value)) width += cellWidth(segment);
  return width;
}

function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + widthOf(span.text), 0);
}

function clipSpans(spans: readonly Span[], width: number): Span[] {
  if (width <= 0) return [];
  if (spansWidth(spans) <= width) return [...spans];
  if (width === 1) return [{ text: '…' }];
  const clipped: Span[] = [];
  let used = 0;
  let finalStyle: TextStyle | undefined;
  outer: for (const span of spans) {
    let text = '';
    for (const { segment } of segmenter.segment(span.text)) {
      const next = cellWidth(segment);
      if (used + next > width - 1) {
        if (text) clipped.push({ text, style: span.style });
        finalStyle = span.style;
        break outer;
      }
      text += segment;
      used += next;
    }
    if (text) clipped.push({ text, style: span.style });
  }
  clipped.push({ text: '…', style: finalStyle });
  return clipped;
}

function renderSpans(spans: readonly Span[], width: number, mode: ColorMode): string {
  const clipped = clipSpans(spans, width);
  const content = clipped.map(span => paint(span.text, span.style, mode)).join('');
  return content + ' '.repeat(Math.max(0, width - spansWidth(clipped)));
}

function isUnloaded(agent: Agent): boolean {
  return normalizeState(agent.status) === 'notLoaded';
}

function isActive(agent: Agent): boolean {
  return normalizeState(agent.status) === 'active';
}

function displayStatus(agent: Agent): string {
  return (clean(agent.status) || 'unknown').toUpperCase();
}

function age(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
}

function title(agent: Agent): string {
  if (agent.parentId) return clean(agent.nickname) || clean(agent.role) || clean(agent.name) || agent.id.slice(0, 8);
  return clean(agent.name) || clean(agent.cwd).split('/').filter(Boolean).at(-1) || agent.id.slice(0, 8);
}

function task(agent: Agent): string {
  return clean(agent.prompt) || clean(agent.spawnPrompt) || 'Task unavailable';
}

function valueSpans(label: string, value: string, valueStyle?: TextStyle): Span[] {
  return [{ text: `${label}:`, style: styles.fieldLabel }, { text: ' ' }, { text: value, style: valueStyle }];
}

export function startUI(store: MonitorStore, onQuit: () => void): () => void {
  const output = process.stdout;
  const input = process.stdin;
  const rawBefore = input.isRaw;
  const mode = colorMode();
  const expansion = new Map<string, boolean>();
  const seenRoots = new Set<string>();
  let activeOnly = false;
  let hideUnloaded = false;
  let detail = false;
  let detailScroll = 0;
  let selectedId: string | null = null;
  let scroll = 0;
  let renderedIds: string[] = [];
  let renderedRootIds = new Set<string>();
  let closed = false;
  let pending = false;

  function descendantSourceFingerprints(): Map<string, string> {
    const agents = [...store.agents.values()];
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const children = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const agent of agents) {
      if (agent.parentId && byId.has(agent.parentId) && agent.parentId !== agent.id) {
        const siblings = children.get(agent.parentId) ?? [];
        siblings.push(agent);
        children.set(agent.parentId, siblings);
      } else roots.push(agent);
    }

    const reachable = new Set<string>();
    const pendingAgents = [...roots];
    while (pendingAgents.length) {
      const agent = pendingAgents.pop();
      if (!agent || reachable.has(agent.id)) continue;
      reachable.add(agent.id);
      pendingAgents.push(...(children.get(agent.id) ?? []));
    }
    const candidateRoots = [...roots, ...agents.filter(agent => !reachable.has(agent.id))];
    const result = new Map<string, string>();
    for (const root of candidateRoots) {
      const descendants: string[] = [];
      const visited = new Set<string>([root.id]);
      const pendingDescendants = [...(children.get(root.id) ?? [])];
      while (pendingDescendants.length) {
        const descendant = pendingDescendants.pop();
        if (!descendant || visited.has(descendant.id)) continue;
        visited.add(descendant.id);
        descendants.push(JSON.stringify([
          descendant.id,
          descendant.parentId,
          descendant.name,
          descendant.cwd,
          descendant.role,
          descendant.nickname,
          descendant.model,
          descendant.effort,
          descendant.prompt,
          descendant.spawnPrompt,
          descendant.promptSource,
          descendant.status,
          descendant.flags,
          descendant.lastActivity,
          descendant.lastTurnStatus,
        ]));
        pendingDescendants.push(...(children.get(descendant.id) ?? []));
      }
      descendants.sort();
      result.set(root.id, JSON.stringify(descendants));
    }
    return result;
  }

  let descendantSources = descendantSourceFingerprints();
  let descendantSourcesReady = store.reconciliations > 0;

  function onStoreChange(): void {
    const next = descendantSourceFingerprints();
    if (!descendantSourcesReady || store.reconciliations === 0) {
      descendantSources = next;
      descendantSourcesReady = store.reconciliations > 0;
      scheduleRender();
      return;
    }
    for (const [rootId, fingerprint] of next) {
      const previous = descendantSources.get(rootId);
      if (previous !== undefined && fingerprint !== previous) expansion.set(rootId, true);
    }
    descendantSources = next;
    scheduleRender();
  }

  function rows(): Line[] {
    const agents = [...store.agents.values()];
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const children = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const agent of agents) {
      if (agent.parentId && byId.has(agent.parentId) && agent.parentId !== agent.id) {
        const siblings = children.get(agent.parentId) ?? [];
        siblings.push(agent);
        children.set(agent.parentId, siblings);
      } else roots.push(agent);
    }
    const order = (a: Agent, b: Agent): number => b.lastActivity - a.lastActivity;
    roots.sort(order);
    for (const siblings of children.values()) siblings.sort(order);

    const reachableFromRoot = new Set<string>();
    const pendingRoots = [...roots];
    while (pendingRoots.length) {
      const agent = pendingRoots.pop();
      if (!agent || reachableFromRoot.has(agent.id)) continue;
      reachableFromRoot.add(agent.id);
      pendingRoots.push(...(children.get(agent.id) ?? []));
    }
    const cycleRoots = agents.filter(agent => !reachableFromRoot.has(agent.id));
    const candidateRoots = [...roots, ...cycleRoots];
    renderedRootIds = new Set(candidateRoots.map(agent => agent.id));
    for (const root of candidateRoots) {
      if (seenRoots.has(root.id)) continue;
      seenRoots.add(root.id);
      if (!expansion.has(root.id)) expansion.set(root.id, false);
    }

    const includeMemo = new Map<string, boolean>();
    function include(agent: Agent, ancestors = new Set<string>()): boolean {
      const cached = includeMemo.get(agent.id);
      if (cached !== undefined) return cached;
      if (ancestors.has(agent.id)) return false;
      const next = new Set(ancestors);
      next.add(agent.id);
      const directMatch = (!hideUnloaded || !isUnloaded(agent)) && (!activeOnly || isActive(agent));
      const descendantMatch = (children.get(agent.id) ?? []).some(child => include(child, next));
      const result = directMatch || descendantMatch;
      includeMemo.set(agent.id, result);
      return result;
    }

    function matchingDescendants(agent: Agent, ancestors = new Set<string>()): number {
      if (ancestors.has(agent.id)) return 0;
      const next = new Set(ancestors);
      next.add(agent.id);
      let count = 0;
      for (const child of children.get(agent.id) ?? []) {
        if (!include(child, next)) continue;
        count += 1 + matchingDescendants(child, next);
      }
      return count;
    }

    const lines: Line[] = [];
    const visible = new Set<string>();
    const contentWidth = Math.max(1, (output.columns || 80) - 2);
    function add(agent: Agent, prefix: string, branch: string, ancestors: Set<string>, root: boolean): void {
      if (visible.has(agent.id) || ancestors.has(agent.id)) return;
      visible.add(agent.id);
      const next = new Set(ancestors);
      next.add(agent.id);
      const descendants = (children.get(agent.id) ?? []).filter(child => include(child, next));
      const expanded = expansion.get(agent.id) ?? !root;
      const label = title(agent);
      const role = agent.parentId && clean(agent.role) && clean(agent.role) !== label ? ` (${clean(agent.role)})` : '';
      const state = displayStatus(agent);
      const currentStateStyle = stateStyle(agent.status);
      const left: Span[] = [
        { text: `${prefix}${branch}${expanded ? '▾ ' : '▸ '}` },
        { text: stateSymbol(agent.status), style: currentStateStyle },
        { text: ' ' },
        { text: label, style: root ? styles.rootName : styles.subagentName },
      ];
      if (role) left.push({ text: role, style: styles.subagentName });
      if (root && !expanded) {
        const count = matchingDescendants(agent);
        if (count > 0) left.push({ text: ` · ${count} matching descendant${count === 1 ? '' : 's'}`, style: styles.fieldLabel });
      }
      lines.push({ spans: clipSpans(left, contentWidth), id: agent.id });

      if (!expanded) return;
      const continuation = branch ? `${prefix}${branch.startsWith('└') ? '   ' : '│  '}` : '  ';
      const metadata: Span[] = [
        { text: continuation },
        ...valueSpans('model', clean(agent.model) || 'unknown', root ? styles.model : styles.subagentModel),
        { text: '  ·  ' },
        ...valueSpans('effort', clean(agent.effort) || 'unknown', effortStyle(agent.effort)),
        { text: '  ·  ' },
        ...valueSpans('state', state, currentStateStyle),
        { text: '  ·  ' },
        ...valueSpans('last used', age(agent.lastActivity), styles.timestamp),
      ];
      lines.push({ spans: metadata, id: null });
      lines.push({ spans: [{ text: continuation }, ...valueSpans('task', `“${task(agent)}”`)], id: null });
      const childPrefix = branch ? continuation : '';
      descendants.forEach((child, index) => {
        lines.push({ spans: [{ text: `${childPrefix}│` }], id: null });
        add(child, childPrefix, index === descendants.length - 1 ? '└─ ' : '├─ ', next, false);
      });
    }

    const displayRoots = candidateRoots.filter((root, index) =>
      candidateRoots.findIndex(candidate => candidate.id === root.id) === index && include(root));
    displayRoots.forEach((root, index) => {
      if (index > 0) lines.push({ spans: [], id: null });
      add(root, '', '', new Set(), true);
      if (index < displayRoots.length - 1 && expansion.get(root.id) === true) {
        lines.push({ spans: [], id: null });
      }
    });
    return lines;
  }

  function detailLines(agent: Agent, width: number): Line[] {
    const fields: Array<{ label: string; value: string; style?: TextStyle }> = [
      { label: 'name', value: title(agent), style: agent.parentId ? styles.subagentName : styles.rootName },
      { label: 'state', value: displayStatus(agent), style: stateStyle(agent.status) },
      { label: 'role', value: clean(agent.role), style: styles.subagentName },
      { label: 'nickname', value: clean(agent.nickname), style: styles.subagentName },
      { label: 'model', value: clean(agent.model), style: agent.parentId ? styles.subagentModel : styles.model },
      { label: 'effort', value: clean(agent.effort), style: effortStyle(agent.effort) },
      { label: 'thread ID', value: clean(agent.id) },
      { label: 'parent ID', value: clean(agent.parentId) },
      { label: 'cwd', value: clean(agent.cwd) },
      { label: 'last activity', value: age(agent.lastActivity), style: styles.timestamp },
      { label: 'last turn', value: clean(agent.lastTurnStatus), style: stateStyle(agent.lastTurnStatus) },
      { label: 'task source', value: clean(agent.promptSource) },
      { label: 'flags', value: agent.flags.map(clean).filter(Boolean).join(', ') },
      { label: 'current task', value: cleanMultiline(agent.prompt) },
      { label: 'spawn assignment', value: cleanMultiline(agent.spawnPrompt) },
    ];
    const lines: Line[] = [];
    for (const field of fields) {
      if (!field.value) continue;
      if (field.label === 'current task') {
        lines.push({ spans: [{ text: 'current task:', style: styles.fieldLabel }], id: null });
        let firstContentLine = true;
        for (const sourceLine of field.value.split('\n')) {
          let rest = sourceLine;
          do {
            const room = Math.max(1, width - (firstContentLine ? 2 : 0));
            let part = '';
            let used = 0;
            for (const { segment } of segmenter.segment(rest)) {
              const next = cellWidth(segment);
              if (used + next > room) {
                if (!part) part = segment;
                break;
              }
              part += segment;
              used += next;
            }
            lines.push({
              spans: firstContentLine
                ? [{ text: '>', style: styles.detailMarker }, { text: ` ${part}`, style: field.style }]
                : [{ text: part, style: field.style }],
              id: null,
            });
            rest = rest.slice(part.length);
            firstContentLine = false;
          } while (rest);
        }
        continue;
      }
      const firstRoom = Math.max(1, width - widthOf(`${field.label}: `));
      let first = true;
      for (const sourceLine of field.value.split('\n')) {
        let rest = sourceLine;
        do {
          const room = first ? firstRoom : Math.max(1, width - 2);
          let part = '';
          let used = 0;
          for (const { segment } of segmenter.segment(rest)) {
            const next = cellWidth(segment);
            if (used + next > room) {
              if (!part) part = segment;
              break;
            }
            part += segment;
            used += next;
          }
          lines.push({
            spans: first
              ? [{ text: `${field.label}:`, style: styles.fieldLabel }, { text: ' ' }, { text: part, style: field.style }]
              : [{ text: '  ' }, { text: part, style: field.style }],
            id: null,
          });
          rest = rest.slice(part.length);
          first = false;
        } while (rest);
      }
    }
    return lines;
  }

  function render(): void {
    if (closed) return;
    const width = Math.max(1, output.columns || 80);
    const height = Math.max(1, output.rows || 24);
    const gutterWidth = Math.min(2, width);
    const contentWidth = Math.max(0, width - gutterWidth);
    const agents = [...store.agents.values()];
    const active = agents.filter(isActive).length;
    const viewMode = activeOnly ? 'ACTIVE ONLY' : 'ALL AGENTS';
    const unloadedMode = hideUnloaded ? 'UNLOADED HIDDEN' : 'UNLOADED SHOWN';
    const connection = store.connected ? 'connected' : clean(store.connection) || 'disconnected';
    const header: Span[] = [
      { text: 'CODEX AGENT MONITOR', style: styles.rootName },
      { text: `  ·  ${active} active  ·  ${connection}` },
    ];
    const modes: Span[] = [
      { text: 'view:', style: styles.fieldLabel },
      { text: ' ' },
      { text: viewMode, style: styles.model },
      { text: '  ·  ' },
      { text: 'unloaded:', style: styles.fieldLabel },
      { text: ' ' },
      { text: unloadedMode, style: styles.model },
    ];
    const warning = clean(store.warning);
    const body = rows();
    renderedIds = [...new Set(body.flatMap(line => line.id ? [line.id] : []))];
    if (!selectedId || !renderedIds.includes(selectedId)) selectedId = renderedIds[0] ?? null;
    const headerHeight = height >= 5 ? 3 : height >= 4 ? 2 : 1;
    const footerHeight = height >= 2 ? 1 : 0;
    const bodyHeight = Math.max(0, height - headerHeight - footerHeight);
    const selectedRow = body.findIndex(line => line.id === selectedId);
    if (selectedRow >= 0 && selectedRow < scroll) scroll = selectedRow;
    if (selectedRow >= scroll + bodyHeight) scroll = selectedRow - bodyHeight + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - bodyHeight)));
    const lines: string[] = [renderSpans(header, width, mode)];
    if (headerHeight >= 2) {
      if (warning) modes.push({ text: '  ·  ' }, { text: warning, style: stateStyle('unknown') });
      lines.push(renderSpans(modes, width, mode));
    }
    if (headerHeight === 3) lines.push(' '.repeat(width));
    if (bodyHeight > 0 && detail && selectedId) {
      const selected = store.agents.get(selectedId);
      const all = selected ? detailLines(selected, contentWidth) : [];
      detailScroll = Math.max(0, Math.min(detailScroll, Math.max(0, all.length - bodyHeight)));
      for (const line of all.slice(detailScroll, detailScroll + bodyHeight)) {
        lines.push(`${' '.repeat(gutterWidth)}${renderSpans(line.spans, contentWidth, mode)}`);
      }
    } else if (bodyHeight > 0 && !body.length) {
      const message = activeOnly ? 'No active Codex agents. Press a to show all agents.' : 'No visible Codex sessions. Press u to show unloaded agents, or r to refresh.';
      lines.push(`${' '.repeat(gutterWidth)}${renderSpans([{ text: message }], contentWidth, mode)}`);
    } else if (bodyHeight > 0) {
      for (const line of body.slice(scroll, scroll + bodyHeight)) {
        const selected = line.id !== null && line.id === selectedId;
        const marker = renderSpans(selected ? [{ text: '› ', style: styles.selectedMarker }] : [], gutterWidth, mode);
        lines.push(`${marker}${renderSpans(line.spans, contentWidth, mode)}`);
      }
    }
    while (lines.length < height - footerHeight) lines.push(' '.repeat(width));
    const footer = detail
      ? '↑↓ scroll  d/← back  q quit  Ctrl+C quit'
      : `a ${activeOnly ? 'show all' : 'active only'}  u ${hideUnloaded ? 'show unloaded' : 'hide unloaded'}  Space expand  Enter/d details  r refresh  ↑↓ select  q quit`;
    if (footerHeight) lines.push(renderSpans([{ text: footer, style: styles.fieldLabel }], width, mode));
    output.write(clearScreen + lines.join('\n'));
  }

  function scheduleRender(): void {
    if (pending || closed) return;
    pending = true;
    setImmediate(() => { pending = false; render(); });
  }

  function quit(): void {
    cleanup();
    onQuit();
  }

  function onKey(value: string, key: Key): void {
    if (key.ctrl && key.name === 'c') return quit();
    if (key.name === 'q') return quit();
    if (key.name === 'r') { void store.refresh().catch(() => scheduleRender()); return; }
    if (detail) {
      if (key.name === 'd' || key.name === 'left' || key.name === 'escape') { detail = false; return scheduleRender(); }
      if (key.name === 'up' || key.name === 'k') detailScroll--;
      if (key.name === 'down' || key.name === 'j') detailScroll++;
      if (key.name === 'pageup') detailScroll -= Math.max(1, (output.rows || 24) - 4);
      if (key.name === 'pagedown') detailScroll += Math.max(1, (output.rows || 24) - 4);
      detailScroll = Math.max(0, detailScroll);
      return scheduleRender();
    }
    if (key.name === 'a') activeOnly = !activeOnly;
    if (key.name === 'u') hideUnloaded = !hideUnloaded;
    if ((key.name === 'd' || key.name === 'return') && selectedId) { detail = true; detailScroll = 0; }
    if ((key.name === 'space' || value === ' ') && selectedId) {
      const root = renderedRootIds.has(selectedId);
      const expanded = expansion.get(selectedId) ?? !root;
      expansion.set(selectedId, !expanded);
    }
    const current = selectedId ? renderedIds.indexOf(selectedId) : -1;
    if ((key.name === 'up' || key.name === 'k') && current > 0) selectedId = renderedIds[current - 1] ?? null;
    if ((key.name === 'down' || key.name === 'j') && current < renderedIds.length - 1) selectedId = renderedIds[current + 1] ?? null;
    if (key.name === 'pageup') selectedId = renderedIds[Math.max(0, current - Math.max(1, Math.floor((output.rows || 24) / 3)))] ?? selectedId;
    if (key.name === 'pagedown') selectedId = renderedIds[Math.min(renderedIds.length - 1, current + Math.max(1, Math.floor((output.rows || 24) / 3)))] ?? selectedId;
    scheduleRender();
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    store.off('change', onStoreChange);
    output.off('resize', scheduleRender);
    input.off('keypress', onKey);
    process.off('SIGINT', quit);
    if (input.isTTY) input.setRawMode(Boolean(rawBefore));
    input.pause();
    output.write(`${resetStyle}${showCursor}\n`);
  }

  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  output.write(hideCursor);
  store.on('change', onStoreChange);
  output.on('resize', scheduleRender);
  input.on('keypress', onKey);
  process.on('SIGINT', quit);
  render();
  return cleanup;
}
