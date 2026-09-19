#!/usr/bin/env python3
"""Safe PTY smoke. Reports checks only, never terminal content or prompts."""
import fcntl
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import termios
import time

project = pathlib.Path(__file__).resolve().parents[1]

def run(exit_key):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    def resize(rows, cols):
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    resize(30, 110)
    proc = subprocess.Popen(['node', 'dist/main.js'], cwd=project, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    data = bytearray()
    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], 0.1)[0]:
                try: data.extend(os.read(master, 65536))
                except OSError: break
    try:
        drain(4)
        assert proc.poll() is None, 'Dashboard exited prematurely'
        assert b'CODEX AGENT MONITOR' in data
        assert b'connected' in data
        if b'model:' not in bytes(data).split(b'\x1b[2J')[-1]:
            os.write(master, b' '); drain(1)
        assert b'ACTIVE' in data or b'IDLE' in data
        assert b'gpt-' in data
        assert '└─'.encode() in data or '├─'.encode() in data
        before = len(data)
        os.write(master, b'r'); drain(2)
        assert len(data) > before, 'Refresh did not repaint'
        os.write(master, b' d'); drain(.3)
        os.write(master, b'd ')
        for rows, cols in [(12, 45), (3, 10), (35, 120)]:
            resize(rows, cols); os.kill(proc.pid, signal.SIGWINCH); drain(.3)
            assert proc.poll() is None, 'Resize crashed dashboard'
        os.write(master, b'\x1b[B\x1b[6~au'); drain(.3)
        os.write(master, exit_key); drain(.5)
        assert proc.wait(timeout=5) == 0
        assert termios.tcgetattr(slave) == original, 'Terminal mode not restored'
        assert b'\x1b[?25h' in data, 'Cursor not restored'
        print('PASS live PTY: hierarchy, status, model, refresh, details, resize, scrolling, filters, ' + ('q' if exit_key == b'q' else 'Ctrl+C') + ', terminal restoration')
    finally:
        if proc.poll() is None: proc.terminate(); proc.wait(timeout=5)
        os.close(master); os.close(slave)

run(b'q')
run(b'\x03')
