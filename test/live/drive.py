"""Run an interactive `claude` in a pty and let other processes drive it (dev tool, see README.md).

usage: python3 -I drive.py <workdir> <cwd> [claude args...]
  <workdir>/cmds/*.json   commands, processed in name order then deleted:
                          {"text": "..."} sends literal text, {"key": "enter|esc|up|down|tab|...", "times": n}
  <workdir>/screen.txt    rendered screen (first line: local time), rewritten every 0.3 s
  <workdir>/raw.log       raw output, with <<<CMD ...>>> markers
  <workdir>/exit          written with claude's exit status when it ends
Needs pexpect (Ubuntu ships it) and pyte (live.sh installs it into test/live/.pylib).
CLAUDE* variables are removed so the session doesn't think it is nested in another one.
"""
import json, os, sys, time, glob
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get('MODISA_LIVE_PYLIB', os.path.join(HERE, '.pylib')))
import pexpect, pyte

work, cwd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
COLS, ROWS = 150, 50
KEYS = {'enter': '\r', 'esc': '\x1b', 'up': '\x1b[A', 'down': '\x1b[B', 'right': '\x1b[C', 'left': '\x1b[D',
        'tab': '\t', 'space': ' ', 'ctrl-c': '\x03', 'backspace': '\x7f', 'shift-tab': '\x1b[Z'}

os.makedirs(os.path.join(work, 'cmds'), exist_ok=True)
env = {k: v for k, v in os.environ.items() if not k.startswith('CLAUDE')}
env['TERM'] = 'xterm-256color'
child = pexpect.spawn('claude', args, cwd=cwd, env=env, dimensions=(ROWS, COLS), encoding='utf-8', codec_errors='replace')
screen = pyte.Screen(COLS, ROWS)
stream = pyte.Stream(screen)
raw = open(os.path.join(work, 'raw.log'), 'a')
last = 0
while True:
    try:
        data = child.read_nonblocking(65536, timeout=0.1)
        raw.write(data); raw.flush(); stream.feed(data)
    except pexpect.TIMEOUT:
        pass
    except pexpect.EOF:
        break
    for f in sorted(glob.glob(os.path.join(work, 'cmds', '*.json'))):
        try:
            c = json.load(open(f))
        except Exception:
            continue  # half-written; next pass
        os.remove(f)
        if 'text' in c:
            child.send(c['text'])
        if 'key' in c:
            for _ in range(int(c.get('times', 1))):
                child.send(KEYS[c['key']]); time.sleep(0.05)
        raw.write(f'\n<<<CMD {json.dumps(c)}>>>\n'); raw.flush()
    if time.time() - last > 0.3:
        last = time.time()
        tmp = os.path.join(work, 'screen.tmp')
        with open(tmp, 'w') as fh:
            fh.write(time.strftime('%H:%M:%S') + '\n' + '\n'.join(l.rstrip() for l in screen.display).rstrip() + '\n')
        os.replace(tmp, os.path.join(work, 'screen.txt'))
child.close()
open(os.path.join(work, 'exit'), 'w').write(str(child.exitstatus))
