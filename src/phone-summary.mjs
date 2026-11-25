// Turns a held Claude Code prompt into the short, secret-masked text sent to a phone.
import { describeApproval } from './state.mjs';

export const LIMITS = { detail: 300, plan: 900, question: 1000 };

const MASK = '••••';
const QUOTED_OR_BARE = `("[^"]*"|'[^']*'|[^\\s"']+)`;

// Applied in order; each replaces the secret part and keeps the label.
const MASKS = [
  // Authorization header values and bare Bearer tokens
  [/\b(authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+)[^\s"']+/gi, `$1${MASK}`],
  // Cookie / Set-Cookie headers: the whole value
  [/\b((?:set-)?cookie\s*:\s*)[^"'\r\n]+/gi, `$1${MASK}`],
  // X-Api-Key: x, X-Auth-Token: x (Authorization is handled above)
  [/\b(?!authorization\b)([\w-]*(?:token|key|secret|password|pass|auth)[\w-]*\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
  // curl -u user:pass, --user user:pass
  [/(\s(?:-u|--user)(?:=|\s+))[^\s"':]+:[^\s"']+/g, `$1${MASK}`],
  // mysql -phunter2 (attached only; "-p 8080" is a port)
  [/(\s-p)(?!rint\b|rune\b|erm\b|ath\b)[^\s"'-][^\s"']*/g, `$1${MASK}`],
  // --token=x, --password x
  [new RegExp(`(--(?:token|key|secret|password|pass|pwd|auth|api-key)(?:=|\\s+))${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // API_KEY=x, DB_PASSWORD="x"
  [new RegExp(`(\\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASS|PWD|AUTH)[A-Za-z0-9_]*=)${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // JSON "api_key": "x" (also shell-escaped \"api_key\": \"x\", and bare numbers)
  [/(\\?"[^"\\]*(?:key|token|secret|password)[^"\\]*\\?"\s*:\s*)(?:(\\?")[^"\\]*(\\?")|[^\s,}\]"\\]+)/gi,
    (_, label, q1, q2) => (q1 === undefined ? `${label}${MASK}` : `${label}${q1}${MASK}${q2}`)],
  // scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // JWTs
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, MASK],
];

export function maskSecrets(text) {
  let out = String(text ?? '');
  for (const [re, to] of MASKS) out = out.replace(re, to);
  // Long opaque runs that mix letters and digits look like keys.
  return out.replace(/[A-Za-z0-9_-]{24,}/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? MASK : run));
}

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Detail is built from fields that are safe to show; mask first, then cut, so a cut never leaves half a secret.
function detailFor(toolName, input) {
  if (toolName === 'Bash' || toolName === 'PowerShell') return cut(maskSecrets(input.command || ''), LIMITS.detail);
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') return cut(input.file_path || '', LIMITS.detail);
  if (toolName === 'WebFetch') return cut(maskSecrets(input.url || ''), LIMITS.detail);
  if (toolName === 'ExitPlanMode') return cut(input.plan || '', LIMITS.plan);
  if (toolName === 'AskUserQuestion') return '';
  return cut(`fields: ${Object.keys(input).join(', ')}`, LIMITS.detail);
}

export function phoneSummary({ toolName, toolInput, project, questions }) {
  const input = toolInput || {};
  const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'approval';
  return {
    kind,
    project,
    title: describeApproval(toolName, input).title,
    detail: detailFor(toolName, input),
    questions: kind === 'question'
      ? (questions || []).map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: !!q.multiSelect,
        options: (q.options || []).map((o) => o.label),
      }))
      : [],
  };
}
