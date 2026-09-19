# Dashboard colors and controls

Run `codex-agent-monitor`. Root sessions start as single collapsed rows, with a blank line below the status summary and between root trees. Expanded root trees have a second blank line beneath their full data block before the next root. Space expands the selected root to show metadata, its task and subagents. Blank connector lines separate parents and children and adjacent subagents, preserving the tree lines. New roots also start collapsed.

A collapsed root automatically expands when any descendant's source display data changes, including nested agents, additions or removals, status, task, model, effort and activity timestamps. Initial loading establishes a baseline. Unchanged refreshes, elapsed-time rendering, filter changes, and root-only updates do not expand it. Manual collapse lasts until the next descendant change; filter choices persist.

Enter or `d` opens details. The `current task:` label occupies its own line; the first task-content line begins with a white `> ` marker. Remaining lines have no marker. Current task and spawn assignment text preserve source line feeds, blank lines and indentation, with tabs expanded to spaces. ANSI escape sequences and unsafe controls are still removed. The compact dashboard keeps task summaries on one line.

`a` switches **ALL AGENTS / ACTIVE ONLY**. Active-only includes ancestors needed to reach active descendants. `u` independently switches unloaded agents on/off, retaining any unloaded ancestor needed to show a relevant descendant. Neither filter expands roots. The header/footer show the current modes, and collapsed rows include descendant counts. “All” means the sessions already discovered by the existing monitor, not an unlimited historical archive.

## Styling

The existing readline/ANSI renderer is retained. Centralized styles apply color separately to labels and values. ANSI control sequences do not count toward terminal width, and external text remains sanitized. Selection uses a marker rather than inverted colors so the palette remains legible on black.

Root names are bold white `#ffffff`; subagent names and roles are purple `#ba63e6`. Labels and activity ages are grey `#777777`. Root model values are bold in the terminal's default foreground; subagent models are bold `#dddddd`, including in details. Task text retains the default foreground and normal weight. State remains visible through the colored icon and expanded metadata field; the duplicate right-aligned state text has been removed.

The installed 0.155.1 thread statuses are:

| Status | Color |
| --- | --- |
| `active` | Bold green `#45d65b` |
| `idle` | Bold grey `#999999` |
| `notLoaded` | Bold dark grey `#555555` |
| `systemError` | Bold red `#ff5555` |
| Monitor `unknown` | Bold muted amber `#b99955` |

Recorded turn outcomes stay distinct from live status: `inProgress` is green, `completed` is cyan-green `#52c7a5`, `interrupted` is orange `#e58a3a`, and `failed` is red `#ff5555`. Semantic aliases use the same styles. Starting is yellow `#d5d94b`; stopped is red `#e04b4b`; cancelled is orange. Symbols use the same colors as their status text.

Reasoning effort is an open, non-empty protocol string, not a closed enum. The installed model catalog advertises these values:

| Effort | Bold blue color |
| --- | --- |
| `low` | `#1f4fff` |
| `medium` | `#4488ff` |
| `high` | `#70aaff` |
| `xhigh` | `#9ac4ff` |
| `max` | `#b0d2ff` |
| `ultra` | `#c0dcff` |

None/minimal aliases use `#0000bb`. Unknown effort strings remain readable and are displayed unchanged; the UI never substitutes or invents an effort level.

PuTTY with 24-bit color enabled can use:

```bash
CODEX_AGENT_MONITOR_COLOR=truecolor codex-agent-monitor
```

Truecolor is the default, including plain `TERM=xterm` sessions where PuTTY does not advertise RGB capability. Use `CODEX_AGENT_MONITOR_COLOR=256` for a reduced xterm palette or `CODEX_AGENT_MONITOR_COLOR=none` to disable color. This application-specific control intentionally takes precedence over inherited `NO_COLOR` or `TERM=dumb` hints. No background color is imposed.

## Smoke checks

```bash
npm run build
python3 scripts/smoke-ui.py
python3 scripts/smoke-terminal.py
codex-agent-monitor doctor
```

The UI smoke uses deterministic in-memory agents and a real PTY, with no Codex connection or model calls. It checks styling, collapsed defaults, filter effects, retained state, nested ancestor paths and resize. The existing terminal smoke uses the real daemon and checks connection, expanded hierarchy, refresh, resize, q, Ctrl+C and terminal restoration. Neither script prints or saves private prompts.
