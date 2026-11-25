// Turns Claude Code hook events into a per-session picture:
// status, the step it's on, recent steps, tasks, background work and subagents.
import path from 'node:path';

const MAX_STEPS = 25;

export const STATUS = {
  WORKING: 'working',       // Claude is busy
  APPROVAL: 'approval',     // waiting for a permission decision
  QUESTION: 'question',     // Claude asked a question
  BACKGROUND: 'background', // turn finished, background work still running
  IDLE: 'idle',             // your turn
  ERROR: 'error',
  ENDED: 'ended',
};

const short = (s, n = 90) => {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');

// One readable line for what a tool call is doing.
export function describeTool(tool, input = {}) {
  input = input || {};
  switch (tool) {
    case 'Bash': {
      const what = input.description || input.command;
      return (input.run_in_background ? 'Started in background: ' : 'Running: ') + short(what, 80);
    }
    case 'PowerShell': return 'Running: ' + short(input.description || input.command, 80);
    case 'Edit':
    case 'MultiEdit': return 'Editing ' + base(input.file_path);
    case 'Write': return 'Writing ' + base(input.file_path);
    case 'Read': return 'Reading ' + base(input.file_path);
    case 'NotebookEdit': return 'Editing ' + base(input.notebook_path);
    case 'Grep': return 'Searching for ' + short(input.pattern, 50);
    case 'Glob': return 'Finding files ' + short(input.pattern, 50);
    case 'WebFetch': {
      try { return 'Reading ' + new URL(input.url).host; } catch { return 'Fetching a web page'; }
    }
    case 'WebSearch': return 'Searching the web: ' + short(input.query, 60);
    case 'Agent':
    case 'Task': return 'Subagent: ' + short(input.description || input.subagent_type || 'working', 70);
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate': return 'Updating the task list';
    case 'AskUserQuestion': return 'Asking you a question';
    case 'ExitPlanMode': return 'Proposing a plan';
    case 'Skill': return 'Using skill ' + short(input.skill || input.name, 40);
    default: {
      if (tool && tool.startsWith('mcp__')) {
        const [, server, name] = tool.split('__');
        return `${server}: ${name || 'tool'}`;
      }
      return tool ? `Using ${tool}` : 'Working';
    }
  }
}

// Short summary for an approval card.
export function describeApproval(tool, input = {}) {
  input = input || {};
  if (tool === 'Bash' || tool === 'PowerShell') return { title: `Run ${tool === 'Bash' ? 'command' : 'PowerShell'}`, detail: input.command || '' };
  if (tool === 'Edit' || tool === 'MultiEdit') return { title: 'Edit file', detail: input.file_path || '' };
  if (tool === 'Write') return { title: 'Write file', detail: input.file_path || '' };
  if (tool === 'WebFetch') return { title: 'Fetch web page', detail: input.url || '' };
  if (tool === 'ExitPlanMode') return { title: 'Approve plan', detail: input.plan || '' };
  if (tool && tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    return { title: `${server}: ${name}`, detail: JSON.stringify(input).slice(0, 400) };
  }
  return { title: `Use ${tool}`, detail: JSON.stringify(input).slice(0, 400) };
}

export function newSession(key, input, meta, host) {
  const cwd = input.cwd || '';
  return {
    key,
    id: input.session_id,
    host,
    cwd,
    project: base(cwd) || 'session',
    title: '',
    status: STATUS.IDLE,
    step: 'Started',
    statusTs: 0,
    stepTs: 0,
    steps: [],
    tasks: {},
    todos: null,
    background: [],
    subagents: {},
    pending: null,
    lastMessage: '',
    transcript: input.transcript_path || null, // read by the daemon to spot answers given in the terminal
    source: 'hooks',   // or 'discovered': found in ~/.claude/sessions with no hooks reporting (watch-only)
    name: '',          // Claude Code's own title for the session, when it has one
    pid: meta.pid || null,
    tmuxPane: meta.tmuxPane || null,
    termProgram: meta.termProgram || null,
    startedAt: meta.ts || Date.now(),
    lastAt: meta.ts || Date.now(),
    ended: false,
    dismissed: false,
  };
}

export function todosSummary(todos) {
  const active = todos.find((t) => t.status === 'in_progress');
  return { total: todos.length, done: todos.filter((t) => t.status === 'completed').length, active: active ? short(active.activeForm || active.content, 60) : '' };
}

function setStatus(s, status, ts) {
  if (ts >= s.statusTs) { s.status = status; s.statusTs = ts; }
}

export function setStep(s, text, ts, tool) {
  if (!text) return;
  if (ts >= s.stepTs) { s.step = text; s.stepTs = ts; }
  const last = s.steps[s.steps.length - 1];
  if (!last || last.text !== text) {
    s.steps.push({ ts, text, tool: tool || null });
    s.steps.sort((a, b) => a.ts - b.ts);
    if (s.steps.length > MAX_STEPS) s.steps.splice(0, s.steps.length - MAX_STEPS);
  }
}

// Apply one hook event. Returns true if anything visible changed.
export function applyEvent(s, event, input, meta) {
  const ts = meta.ts || Date.now();
  s.lastAt = Math.max(s.lastAt, ts);
  if (meta.tmuxPane) s.tmuxPane = meta.tmuxPane;
  if (meta.termProgram) s.termProgram = meta.termProgram;
  if (input.cwd && !s.cwd) { s.cwd = input.cwd; s.project = base(input.cwd); }
  if (input.transcript_path) s.transcript = input.transcript_path;
  s.dismissed = false;

  switch (event) {
    case 'SessionStart':
      s.ended = false;
      setStatus(s, STATUS.IDLE, ts);
      setStep(s, input.source === 'resume' ? 'Resumed' : 'Started', ts);
      break;

    case 'UserPromptSubmit': {
      const prompt = short(input.prompt, 70);
      if (!s.title && prompt) s.title = prompt;
      s.lastMessage = '';
      setStatus(s, STATUS.WORKING, ts);
      setStep(s, 'Thinking…', ts);
      break;
    }

    case 'PreToolUse': {
      const tool = input.tool_name;
      setStep(s, describeTool(tool, input.tool_input), ts, tool);
      if (tool !== 'AskUserQuestion' && !s.pending) setStatus(s, STATUS.WORKING, ts);
      if (tool === 'TodoWrite' && Array.isArray(input.tool_input?.todos)) s.todos = todosSummary(input.tool_input.todos);
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool = input.tool_name;
      if (tool === 'Bash' && input.tool_input?.run_in_background) {
        const r = input.tool_response || {};
        const id = r.backgroundTaskId || r.bash_id || r.shellId || input.tool_use_id || `bg-${ts}`;
        if (!s.background.find((b) => b.id === id)) {
          s.background.push({ id, type: 'shell', status: 'running', description: short(input.tool_input.description || '', 80), command: short(input.tool_input.command, 200) });
        }
      }
      if (event === 'PostToolUseFailure') setStep(s, `${describeTool(tool, input.tool_input)} (failed)`, ts, tool);
      if (!s.pending && s.status !== STATUS.ENDED) setStatus(s, STATUS.WORKING, ts);
      break;
    }

    case 'Notification': {
      const type = input.notification_type;
      // Claude Code sends permission_prompt for questions too; keep a question labelled as one.
      if (type === 'permission_prompt' && !s.pending && s.status !== STATUS.QUESTION) {
        setStatus(s, STATUS.APPROVAL, ts);
        setStep(s, short(input.message || 'Needs your permission', 80), ts);
      } else if (type === 'idle_prompt' || type === 'agent_needs_input') {
        if (!s.pending) setStatus(s, s.background.length ? STATUS.BACKGROUND : STATUS.IDLE, ts);
      }
      break;
    }

    case 'Stop': {
      if (Array.isArray(input.background_tasks)) {
        s.background = input.background_tasks.map((b) => ({
          id: b.id, type: b.type || 'task', status: b.status || 'running',
          description: short(b.description || b.name || b.agent_type || '', 80),
          command: b.command ? short(b.command, 200) : '',
        }));
      }
      if (input.last_assistant_message) s.lastMessage = short(input.last_assistant_message, 160);
      const running = s.background.filter((b) => b.status === 'running' || b.status === 'pending');
      setStatus(s, running.length ? STATUS.BACKGROUND : STATUS.IDLE, ts);
      setStep(s, running.length ? `Waiting on ${running.length} background task${running.length > 1 ? 's' : ''}` : 'Done, your turn', ts);
      break;
    }

    case 'StopFailure':
      setStatus(s, STATUS.ERROR, ts);
      setStep(s, 'Stopped with an error: ' + short(input.error || input.message || 'API error', 70), ts);
      break;

    case 'SubagentStart':
      if (input.agent_id) s.subagents[input.agent_id] = { type: input.agent_type || 'subagent', startedAt: ts };
      break;

    case 'SubagentStop':
      if (input.agent_id) delete s.subagents[input.agent_id];
      break;

    case 'TaskCreated':
      if (input.task_id) s.tasks[input.task_id] = { subject: short(input.task_subject, 60), done: false };
      break;

    case 'TaskCompleted':
      if (input.task_id) {
        s.tasks[input.task_id] = { ...(s.tasks[input.task_id] || { subject: short(input.task_subject, 60) }), done: true };
      }
      break;

    case 'SessionEnd':
      s.ended = true;
      s.pending = null;
      setStatus(s, STATUS.ENDED, ts);
      setStep(s, 'Session ended', ts);
      break;

    default:
      return false;
  }
  return true;
}

// Progress for the bar: task list first, then TodoWrite.
export function progressOf(s) {
  const tasks = Object.values(s.tasks || {});
  if (tasks.length) {
    const open = tasks.find((t) => !t.done);
    return { done: tasks.filter((t) => t.done).length, total: tasks.length, label: open ? open.subject : '' };
  }
  if (s.todos && s.todos.total) return { done: s.todos.done, total: s.todos.total, label: s.todos.active };
  return null;
}

// What the widget receives (no internal timestamps it doesn't need).
export function publicView(s) {
  return {
    // Claude Code's own session name reads better than the first prompt (which can be a paste).
    key: s.key, id: s.id, host: s.host, cwd: s.cwd, project: s.project, title: s.name || s.title,
    watchOnly: s.source === 'discovered',
    status: s.status, step: s.step, steps: s.steps.slice(-10), progress: progressOf(s),
    background: s.background, subagents: Object.entries(s.subagents).map(([id, a]) => ({ id, ...a })),
    pending: s.pending ? { ...s.pending, resolve: undefined } : null,
    lastMessage: s.lastMessage, startedAt: s.startedAt, lastAt: s.lastAt,
    canJump: Boolean(s.tmuxPane || s.termProgram), ended: s.ended,
  };
}
