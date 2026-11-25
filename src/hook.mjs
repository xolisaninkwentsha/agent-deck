#!/usr/bin/env node
// Claude Code runs this for each hook event: node hook.mjs <observe|decide>
// It forwards the event to the local daemon (starting it if needed) and, for
// "decide" hooks, prints the daemon's answer so Claude Code can act on it.
// It never blocks Claude Code on failure: any error means "no opinion".
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.AGENT_DECK_HOME || path.join(os.homedir(), '.agent-deck');
const mode = process.argv[2] === 'decide' ? 'decide' : 'observe';

let port = 47615;
try { port = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).port || port; } catch {}
if (process.env.AGENT_DECK_PORT) port = Number(process.env.AGENT_DECK_PORT);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function post(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

function startDaemon() {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const out = fs.openSync(path.join(HOME, 'daemon.out'), 'a');
    const child = spawn(process.execPath, [path.join(HERE, 'daemon.mjs')], {
      detached: true, stdio: ['ignore', out, out], env: process.env,
    });
    child.unref();
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const body = {
    mode,
    event: input.hook_event_name,
    input,
    meta: {
      ts: Date.now(),
      pid: process.ppid,
      tmuxPane: process.env.TMUX_PANE || null,
      termProgram: process.env.TERM_PROGRAM || null,
    },
  };
  // Decide hooks may wait for a person; observe hooks should be quick.
  const timeout = mode === 'decide' ? 590000 : 4000;
  let res;
  try {
    res = await post(body, timeout);
  } catch (e) {
    if (e.code !== 'ECONNREFUSED') return;
    startDaemon();
    for (let i = 0; i < 15 && !res; i++) {
      await sleep(100);
      try { res = await post(body, timeout); } catch {}
    }
  }
  if (mode === 'decide' && res && res.output) process.stdout.write(JSON.stringify(res.output));
}

main().catch(() => {}).finally(() => process.exit(0));
