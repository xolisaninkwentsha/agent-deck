// Adds (or removes) Agent Deck's hooks in Claude Code's user settings.
// Always backs the file up first and only touches entries that belong to Agent Deck.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_PATH = path.join(HERE, 'hook.mjs');
const MARK = 'agent-deck';

export function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cmd = (mode) => `${q(process.execPath)} ${q(HOOK_PATH)} ${mode} # ${MARK}`;

// Events we only watch: run in the background so Claude never waits on us.
const OBSERVE = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', '*'],
  ['PostToolUse', '*'],
  ['PostToolUseFailure', '*'],
  ['Notification', null],
  ['Stop', null],
  ['SubagentStart', null],
  ['SubagentStop', null],
  ['TaskCreated', null],
  ['TaskCompleted', null],
  ['SessionEnd', null],
];
// Events the panel can answer: these wait (up to the hold time) for a decision.
const DECIDE = [
  ['PermissionRequest', '*'],
  ['PreToolUse', 'AskUserQuestion'],
];

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARK) && h.command.includes('hook.mjs');

function strip(settings) {
  const hooks = settings.hooks || {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  return settings;
}

function read(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch {
    throw new Error(`${file} isn't valid JSON, so I left it alone. Fix it and run this again.`);
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.agent-deck-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, dest);
  return dest;
}

export function install() {
  const file = settingsPath();
  const settings = strip(read(file));
  const saved = backup(file);
  settings.hooks = settings.hooks || {};
  const add = (event, matcher, handler) => {
    const group = { hooks: [handler] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  };
  for (const [event, matcher] of OBSERVE) add(event, matcher, { type: 'command', command: cmd('observe'), async: true });
  for (const [event, matcher] of DECIDE) add(event, matcher, { type: 'command', command: cmd('decide'), timeout: 600 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, backup: saved };
}

export function uninstall() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return { file, backup: null };
  const saved = backup(file);
  fs.writeFileSync(file, JSON.stringify(strip(read(file)), null, 2) + '\n');
  return { file, backup: saved };
}

export function isInstalled() {
  try {
    const s = read(settingsPath());
    return Object.values(s.hooks || {}).some((groups) => groups.some((g) => (g.hooks || []).some(isOurs)));
  } catch { return false; }
}
