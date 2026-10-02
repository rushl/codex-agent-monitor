#!/usr/bin/env python3
"""Verify configured tree/detail name and effort colors in a real PTY."""
import fcntl
import os
import pathlib
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

project = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='monitor-name-colors-') as temp:
    home = pathlib.Path(temp) / 'home'
    definitions = home / 'agents'
    definitions.mkdir(parents=True)
    config_text = ('[agent_monitor]\ndefault_name_color = "#112233"\n'
                   '[agent_monitor.effort_colors]\nhigh = "#ffcc80"\nmedium = "#80cbc4"\n')
    (home / 'config.toml').write_text(config_text)
    definition = definitions / 'explorer.toml'
    for mode, prefix in [('truecolor', '\x1b[1;38;2;128;203;196m'),
                         ('256', '\x1b[1;38;5;152m'), ('none', '')]:
        definition.write_text('name = "explorer"\n[agent_monitor]\nname_color = "#80cbc4"\n')
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 180, 0, 0))
        env = dict(os.environ, CODEX_HOME=str(home), MONITOR_FIXTURE_CWD=temp,
                   CODEX_AGENT_MONITOR_COLOR=mode)
        proc = subprocess.Popen(['node', 'scripts/ui-fixture.mjs'], cwd=project, env=env,
                                stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        buffer = bytearray()

        def frame(key=None):
            if key:
                os.write(master, key)
            end = time.monotonic() + .35
            while time.monotonic() < end:
                if select.select([master], [], [], .05)[0]:
                    buffer.extend(os.read(master, 65536))
            return bytes(buffer).split(b'\x1b[2J')[-1].decode('utf8', 'replace')

        def styled(raw, text, style=prefix):
            expected = f'{style}{text}' + ('\x1b[0m' if style else '')
            assert expected in raw, f'{mode}: missing styled {text!r}'

        def effort_prefix(rgb, palette):
            return {'truecolor': f'\x1b[1;38;2;{rgb}m',
                    '256': f'\x1b[1;38;5;{palette}m', 'none': ''}[mode]

        try:
            raw = frame()
            if mode == 'truecolor':
                styled(raw, 'root-alpha', '\x1b[1;38;2;255;255;255m')
            raw = frame(b' ')
            styled(raw, 'high', effort_prefix('255;204;128', 223))
            styled(raw, 'medium', effort_prefix('128;203;196', 152))
            styled(raw, 'low', effort_prefix('31;79;255', 69))
            styled(raw, 'xhigh', effort_prefix('154;196;255', 153))
            styled(raw, 'child-idle')
            styled(raw, ' (explorer)')
            if mode == 'truecolor':
                styled(raw, '› ', '\x1b[1;38;2;186;99;230m')
                styled(raw, 'gpt-fixture', '\x1b[1;38;2;221;221;221m')
            if mode == 'none':
                assert '\x1b[38;' not in raw and '\x1b[1;' not in raw
            raw = frame(b'd')
            styled(raw, 'high', effort_prefix('255;204;128', 223))
            frame(b'd')
            frame(b'j')
            raw = frame(b'd')
            styled(raw, 'medium', effort_prefix('128;203;196', 152))
            styled(raw, 'child-idle')
            styled(raw, 'explorer')
            assert raw.count(f'{prefix}child-idle') >= 2, 'Name and nickname must share color'
            definition.write_text('name = "explorer"\n[agent_monitor]\nname_color = "#ff0000"\n')
            (home / 'config.toml').write_text(
                '[agent_monitor]\ndefault_name_color = "#112233"\n'
                '[agent_monitor.effort_colors]\nhigh = "#ff0000"\nmedium = "#112233"\n')
            raw = frame(b'r')
            styled(raw, 'medium', effort_prefix('17;34;51', 23))
            changed = {'truecolor': '\x1b[1;38;2;255;0;0m', '256': '\x1b[1;38;5;196m', 'none': ''}[mode]
            styled(raw, 'child-idle', changed)
            definition.unlink()
            raw = frame(b'r')
            fallback = {'truecolor': '\x1b[1;38;2;17;34;51m', '256': '\x1b[1;38;5;23m', 'none': ''}[mode]
            styled(raw, 'child-idle', fallback)
            styled(raw, 'explorer', fallback)
            (home / 'config.toml').unlink()
            raw = frame(b'r')
            original_color = {'truecolor': '\x1b[1;38;2;186;99;230m', '256': '\x1b[1;38;5;177m', 'none': ''}[mode]
            styled(raw, 'medium', effort_prefix('68;136;255', 75))
            styled(raw, 'child-idle', original_color)
            styled(raw, 'explorer', original_color)
            raw = frame(b'd')
            styled(raw, 'high', effort_prefix('112;170;255', 111))
            styled(raw, 'medium', effort_prefix('68;136;255', 75))
            styled(raw, 'child-idle', original_color)
            styled(raw, ' (explorer)', original_color)
            if mode == 'none':
                assert '\x1b[38;' not in raw and '\x1b[1;' not in raw
            frame(b'k')
            raw = frame(b'd')
            styled(raw, 'high', effort_prefix('112;170;255', 111))
            frame(b'q')
            proc.wait(timeout=3)
            assert proc.returncode == 0
            assert termios.tcgetattr(slave) == original, 'Terminal mode not restored'
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(master)
            os.close(slave)
        (home / 'config.toml').write_text(config_text)
print('Configured name and effort color PTY smoke passed for truecolor, 256, and none')
