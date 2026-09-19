# codex-agent-monitor

A read-only terminal dashboard for the shared Codex CLI daemon. It groups root sessions and recursively spawned agents, shows live thread status and available task/model metadata, and leaves existing Codex terminals in control.

```text
CODEX AGENT MONITOR · 1 active · connected
▾ my-project                                  ● ACTIVE
  model: gpt-6-astra · effort: high · 4s ago
  “Refactor candidate search and run the tests”
└─ Peirce (explorer)                            ○ IDLE · last turn: completed
     model: gpt-5.6-terra · effort: high · 12s ago
     “Task unavailable”
```

## Requirements and installation

Tested on **Ubuntu 20.04.6 LTS**, Node.js **22.16.0**, and standalone **Codex CLI/app-server 0.155.1**. Requires Node.js 20 or newer, npm for building, a UTF-8 terminal, and a user-owned running shared Codex daemon.

Runtime dependencies are `ws` for WebSocket framing and `zod` for parsing protocol data. TypeScript and type declarations are project-local build dependencies. No system packages or Codex settings are changed.

```bash
cd ~/codex-agent-monitor
npm ci --ignore-scripts
npm run build
./bin/codex-agent-monitor
```

The local installation is linked at `~/.local/bin/codex-agent-monitor`. To install elsewhere, create a symlink from a user-owned PATH directory to this project's `bin/codex-agent-monitor`. Keep the project directory in place.

```bash
codex-agent-monitor
codex-agent-monitor doctor
codex-agent-monitor --refresh 10
```

## Controls

| Key | Action |
| --- | --- |
| Up/Down or j/k | Select and scroll agents |
| Page Up/Page Down | Move through longer lists or details |
| Space | Collapse/expand the selected root or subagent |
| d, Enter | Show task, original assignment when available, IDs and other details |
| d, Left, Escape | Leave details |
| a | Toggle recent unloaded roots |
| u | Hide/show unloaded agents, retaining ancestors of loaded agents |
| r | Reconcile immediately |
| q or Ctrl+C | Exit and restore terminal mode/cursor |

The default view includes loaded roots and their descendants, including unloaded descendants. Discovery seeds all loaded threads plus 20 recent root candidates. Ancestors of loaded children are resolved even when older. Sessions discovered during this run remain available until archived/deleted. `a` shows the retained recent history, not every session ever created.

## Architecture and discovery

```text
Codex terminals ── shared app-server daemon ── codex-agent-monitor
                        Unix WebSocket
```

The installed CLI is `~/.local/bin/codex`, linked to its user-local standalone package. `codex app-server daemon version` confirmed both CLI and daemon version 0.155.1. This is a shared daemon, not an app-server started by the monitor.

The monitor resolves `CODEX_HOME`, falling back to `~/.codex`, then connects to `app-server-control/app-server-control.sock` beneath it. This location was verified against the installed daemon. Overrides:

```bash
codex-agent-monitor --codex-home /path/to/codex-home
codex-agent-monitor --socket /path/to/control.sock
CODEX_AGENT_MONITOR_SOCKET=/path/to/control.sock codex-agent-monitor
```

The transport is WebSocket over a Unix socket, with compression disabled because the installed server rejects its negotiation. `codex app-server proxy` is a raw byte proxy, not a newline JSON-RPC client transport.

The monitor sends `initialize`, `initialized`, and only these read methods:

- `thread/loaded/list`: paginated daemon-wide loaded IDs.
- `thread/list`: recent threads and descendants using `ancestorThreadId`, with `useStateDbOnly:true` to avoid rollout scan-and-repair.
- `thread/read` with `includeTurns:false`: authoritative status and metadata.
- `thread/turns/list`: latest/first turn metadata and recorded assignments.

The request allowlist is enforced in `src/protocol.ts`. No start, resume, subscription, unsubscribe, archive, settings, turn, approval, or daemon-management requests are implemented. The monitor does not answer server requests, read authentication files, or access SQLite/rollouts directly. Disconnecting it closes only its own socket.

Thread lifecycle/status notifications update the display immediately. A reconciliation runs every 15 seconds by default, minimum configurable interval 2 seconds. Task history is cached for idle threads for up to 60 seconds; active threads are refreshed each reconciliation. Missing events therefore do not leave status indefinitely stale. On connection loss, statuses become unknown and the monitor retries every 3 seconds without starting or restarting anything.

## Data meaning and limitations

| Displayed data | Source and meaning |
| --- | --- |
| Active, idle, notLoaded, systemError | Live `thread/read` status or daemon status notifications. A persisted relationship never implies active work. |
| Unknown | Connection lost, failed read, or unavailable status. Cached metadata may remain visible. |
| Last turn completed/interrupted/failed | Recorded turn result. This does **not** mean the agent is permanently finished. `notLoaded` is never relabeled completed. |
| Parent and tree depth | Protocol `parentThreadId`, with `source.subAgent.thread_spawn.parent_thread_id` fallback; tree depth follows these edges. Forks are not treated as spawned children. |
| Role and nickname | Protocol fields, falling back to matching spawn-source fields. |
| Model and effort | Current configured values for loaded threads; latest persisted values for unloaded threads. Not per-turn model execution telemetry. |
| Task | Latest turn's user input when available, recorded spawn/follow-up assignment, then session preview. Details identify the source. |
| Original assignment | Matching recorded parent `collabAgentToolCall` with `spawnAgent`. First child input is used only as a historical task fallback, labeled separately because it may contain inherited context. |
| Activity age | Protocol timestamps plus locally observed turn/item notifications; not a precise CPU-activity or execution-duration measurement. |

Some newer path-based subagents on 0.155.1 expose **no assignment text**: their preview is empty, their turns have no user message, and the parent records only `subAgentActivity`. That item contains an agent ID/path and lifecycle kind, not the prompt. These agents show `Task unavailable`. The monitor does not invent a task from reasoning or assistant output. Older recorded spawn calls do provide assignment text.

Prompt reconstruction is intentionally bounded to the latest parent turn and first/latest child turns. An assignment recorded only in an older parent turn may therefore be absent. Empty or unsupported history retains the preview. Archived agents are excluded. Internal review, compaction, memory-consolidation and unrecognized subagent source kinds are excluded; explicit thread-spawn agents are included recursively.

The protocol is experimental. Only 0.155.1 was tested; unknown additive fields are tolerated, but older versions lacking these read methods may provide partial results or a warning. Only the shared local Unix endpoint is supported. Embedded or separately hosted app-servers are outside this daemon's view. A missing daemon is diagnosed without changing the environment.

## Diagnostics and verification

`codex-agent-monitor doctor` or `--debug` prints versions, endpoint, connection outcome, counts and warnings, then exits. It prints no credentials, task text, or prompt-bearing server error messages. `--once` gives a prompt-free JSON snapshot including thread IDs, parent IDs, statuses and model metadata.

Practical smoke checks:

```bash
npm run build
node scripts/smoke-live.mjs
python3 scripts/smoke-terminal.py
node scripts/smoke-reconnect.mjs
```

The live script expects existing sessions/subagents and never creates them. The PTY script exercises the real dashboard and daemon but retains captured terminal contents only in memory. The reconnect script uses a temporary local fixture server, never restarts your daemon, and checks empty state, nested discovery, status events, disconnection and recovery.

For a real transition check, keep the monitor open and ask another Codex terminal: `Use one explorer to identify this project's entry point, then report its name.` Watch the root become active, the child appear beneath it, and the child return to idle. The monitor does not initiate this work. Task text may remain unavailable for the newer agent format described above.

## Investigation references

The local protocol was generated with `codex app-server generate-json-schema --experimental --out protocol`. Generated schemas and downloaded source are ignored by Git; runtime operation does not need them.

- [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [0.155.1 agents overview discovery and notification handling](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/tui/src/app/agents_overview_threads.rs)
- [0.155.1 Unix socket transport](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-transport/src/transport/unix_socket.rs)
- [0.155.1 official remote client handshake](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-client/src/remote.rs)

## Uninstall

Remove the `~/.local/bin/codex-agent-monitor` symlink, then remove this project directory if no longer needed. All dependencies and build output are inside the project. No daemon, service, Codex configuration, or system installation needs to be reverted.
