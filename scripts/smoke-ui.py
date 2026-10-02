#!/usr/bin/env python3
"""Small deterministic PTY smoke for UI colors, filtering and retained state."""
import fcntl
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

project = pathlib.Path(__file__).resolve().parents[1]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 180, 0, 0))
env = dict(os.environ, CODEX_AGENT_MONITOR_COLOR='truecolor')
proc = subprocess.Popen(['node', 'scripts/ui-fixture.mjs'], cwd=project, env=env,
                        stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
buffer = bytearray()

def frame(key=None):
    if key: os.write(master, key)
    end = time.monotonic() + .35
    while time.monotonic() < end:
        if select.select([master], [], [], .05)[0]:
            buffer.extend(os.read(master, 65536))
    raw = bytes(buffer).split(b'\x1b[2J')[-1].decode('utf8', 'replace')
    return raw, re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', raw)

try:
    raw, text = frame()
    assert 'root-alpha' in text and 'root-unloaded' in text
    initial_lines = text.splitlines()
    alpha_line = next(i for i, line in enumerate(initial_lines) if 'root-alpha' in line)
    assert not initial_lines[alpha_line - 1].strip(), 'Missing gap below status summary'
    assert not initial_lines[alpha_line + 1].strip(), 'Missing blank line between root agents'
    assert 'ACTIVE' not in initial_lines[alpha_line], 'Redundant right-side status remains'
    assert 'gpt-fixture' not in text and 'task for' not in text, 'Roots must start compact'
    assert 'child-idle' not in text and 'fresh-child' not in text
    assert '38;2;255;255;255m' in raw, 'Root white'
    assert '38;2;69;214;91m' in raw, 'Active green'
    assert '38;2;85;85;85m' in raw, 'Unloaded grey'
    assert '38;2;255;85;85m' in raw, 'System error red'
    raw, text = frame(b' ')
    assert 'child-idle' in text and 'child-unloaded' in text and 'grandchild-active' in text
    assert 'task: /root/child-idle' in text, 'Subagent task must use canonical reference'
    assert 'task: /root/bridge-unloaded/grandchild-active' in text, 'Nested reference lost'
    assert 'task: Task unavailable' in text, 'Missing reference must have explicit fallback'
    assert '“/root/' not in text and 'child-idle”' not in text and 'grandchild-active”' not in text, 'Subagent task values must not be quoted'
    assert 'task for child' not in text, 'Subagent prompt used in place of reference'
    assert 'task: “First task line - indented item Last line”' in text, 'Root prompt task changed'
    expanded_lines = text.splitlines()
    for child in ['child-idle', 'child-unloaded', 'grandchild-active']:
        child_line = next(i for i, line in enumerate(expanded_lines) if child in line and 'task for' not in line)
        connector = expanded_lines[child_line - 1].strip()
        assert connector and set(connector) <= {'│', ' '}, f'Missing connector gap before {child}'
    next_root = next(i for i, line in enumerate(expanded_lines) if 'root-idle' in line)
    assert not expanded_lines[next_root - 1].strip() and not expanded_lines[next_root - 2].strip(), \
        'Expanded root needs two blank lines before the next root'
    for rgb in ['186;99;230', '119;119;119', '112;170;255', '68;136;255', '31;79;255', '192;220;255']:
        assert f'38;2;{rgb}m' in raw, f'Missing palette color {rgb}'
    assert re.search(r'\x1b\[1[;m]', raw) and 'gpt-fixture' in text
    assert '\x1b[1mgpt-fixture\x1b[0m' in raw, 'Model value not bold'
    assert '\x1b[1;38;2;221;221;221mgpt-fixture\x1b[0m' in raw, 'Subagent model not brightened'
    assert '\x1b[38;2;119;119;119mmodel:\x1b[0m' in raw, 'Label styling leaked into value'
    assert '\x1b[1;38;2;112;170;255mhigh\x1b[0m' in raw, 'Effort value not bold blue'
    assert '\x1b[1;38;2;69;214;91m●\x1b[0m' in raw, 'Active symbol does not match state'
    assert re.search(r'\x1b\[38;2;119;119;119m\d+s ago\x1b\[0m', raw), 'Activity age not grey'
    raw, text = frame(b'r')
    assert 'child-idle' in text, 'Refresh reset expanded root'
    assert 'fresh-root' in text and 'fresh-child' not in text, 'New root not collapsed'
    raw, text = frame(b'u')
    assert 'root-unloaded' not in text and 'child-unloaded' not in text
    assert 'bridge-unloaded' in text and 'grandchild-active' in text, 'Ancestor path lost'
    assert 'child-idle' in text and 'root-idle' in text
    _, retained = frame(b'r')
    assert 'child-unloaded' not in retained and 'child-idle' in retained
    raw, text = frame(b'a')
    assert 'ACTIVE ONLY' in text
    assert 'child-idle' not in text and 'root-idle' not in text
    assert 'grandchild-active' in text and 'bridge-unloaded' in text
    _, retained = frame(b'r')
    assert 'ACTIVE ONLY' in retained and 'root-idle' not in retained
    _, text = frame(b'a')
    assert 'ALL AGENTS' in text and 'root-idle' in text and 'child-unloaded' not in text
    _, text = frame(b'u')
    assert 'child-unloaded' in text and 'root-unloaded' in text
    _, text = frame(b' ')
    assert 'child-idle' not in text
    _, text = frame(b'r')
    assert 'child-idle' not in text, 'Refresh reset manual collapse'
    os.kill(proc.pid, signal.SIGUSR2)
    _, text = frame()
    assert 'child-idle' not in text, 'Root-only change expanded root'
    os.kill(proc.pid, signal.SIGUSR1)
    _, text = frame()
    assert 'child-idle' in text and 'gpt-updated' in text, 'Nested model change did not expand root'
    frame(b' ')
    os.kill(proc.pid, signal.SIGUSR1)
    _, text = frame()
    assert 'new-child' in text, 'New child did not expand root'
    frame(b' ')
    os.kill(proc.pid, signal.SIGUSR1)
    _, text = frame()
    assert 'child-idle' in text and 'new-child' not in text, 'Child removal did not expand root'
    _, text = frame(b'\r')
    assert 'current task:' in text, 'Enter did not open details'
    task_lines = text.splitlines()
    label = next(i for i, line in enumerate(task_lines) if line.strip() == 'current task:')
    assert task_lines[label + 1].lstrip().startswith('> First task line'), 'Task must begin below its label with > '
    first = next(i for i, line in enumerate(task_lines) if 'First task line' in line)
    assert not task_lines[first + 1].strip(), 'Task blank line was flattened or incorrectly prefixed'
    assert 'Last line' in task_lines[first + 3], 'Task line feed was flattened'
    indented = task_lines[first + 2]
    plain = task_lines[first + 3]
    assert indented.lstrip().startswith('- indented item') and '>' not in indented
    assert plain.lstrip().startswith('Last line') and '>' not in plain
    assert 'task source: fixture' in text, 'Root task provenance changed'
    frame(b'd')
    frame(b'\x1b[B')
    _, text = frame(b'\r')
    assert 'task: /root/child-idle' in text and 'task source:' not in text, 'Subagent detail reference or label incorrect'
    assert 'task for child-idle' in text, 'Subagent current task missing from details'
    frame(b'd')
    frame(b'\x1b[B')
    _, text = frame(b'\r')
    assert 'task: Task unavailable' in text, 'Missing detail reference must have explicit fallback'
    frame(b'd')
    frame(b'\x1b[A')
    frame(b'\x1b[A')
    frame(b' ')
    os.kill(proc.pid, signal.SIGUSR1)
    _, text = frame()
    assert 'task: /root/recovered-task' in text, 'Reference arrival did not expand root'
    for rows, cols in [(24, 80), (12, 45), (3, 10), (35, 120)]:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.kill(proc.pid, signal.SIGWINCH)
        _, resized = frame()
        if cols == 80:
            assert 'ALL AGENTS' in resized and 'UNLOADED SHOWN' in resized, 'Filter state clipped at 80 columns'
            assert 'a ' in resized and 'u ' in resized, 'Filter controls clipped at 80 columns'
        assert proc.poll() is None
    frame(b'q')
    assert proc.wait(timeout=5) == 0
    assert termios.tcgetattr(slave) == original
    print('PASS UI PTY: RGB palette, tree spacing, compact roots, canonical and nested task references, missing-reference fallback, path arrival expansion, Enter details, multiline root tasks, filters, resize, q')
finally:
    if proc.poll() is None: proc.terminate(); proc.wait(timeout=5)
    os.close(master); os.close(slave)
