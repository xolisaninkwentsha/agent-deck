// Turns a held Claude Code prompt into the short, secret-masked text sent to a phone.
import { describeApproval } from './state.mjs';

export const LIMITS = { detail: 300, plan: 900, question: 1000 };
// Output is cut to a few hundred characters, so masking beyond this is wasted work (and bounds regex cost).
const MASK_INPUT_MAX = 2000;

const MASK = '••••';
const SECRET_NAME = /token|key|secret|password|pass|auth/i;
const QUOTED_OR_BARE = `("[^"]*"|'[^']*'|[^\\s"']+)`;

// Applied in order; each replaces the secret part and keeps the label.
const MASKS = [
  // Authorization header values and bare Bearer tokens
  [/\b(authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+)[^\s"']+/gi, `$1${MASK}`],
  // Cookie / Set-Cookie headers: the whole value
  [/\b((?:set-)?cookie\s*:\s*)[^"'\r\n]+/gi, `$1${MASK}`],
  // X-Api-Key: x, X-Auth-Token: x (Authorization is handled above). Bounded name, keyword tested in the callback, so it stays linear.
  [/(?<![\w-])([\w-]{1,64})(\s*:\s*)[^\s"']+/g, (m, name, sep) => (SECRET_NAME.test(name) && !/^authorization$/i.test(name) ? `${name}${sep}${MASK}` : m)],
  // curl -u user:pass, --user user:pass
  [/(\s(?:-u|--user)(?:=|\s+))[^\s"':]+:[^\s"']+/g, `$1${MASK}`],
  // --token=x, --password x
  [new RegExp(`(--(?:token|key|secret|password|pass|pwd|auth|api-key)(?:=|\\s+))${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // API_KEY=x, DB_PASSWORD="x"
  [new RegExp(`(\\b[A-Za-z0-9_]{0,64}(?:TOKEN|KEY|SECRET|PASS|PWD|AUTH)[A-Za-z0-9_]{0,64}=)${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // JSON "api_key": "x" (also shell-escaped \"api_key\": \"x\", escapes inside the value, and bare numbers)
  [/(\\?"[^"\\]{0,64}(?:key|token|secret|password)[^"\\]{0,64}\\?"\s*:\s*)(?:(\\")[^]*?(\\")|(")((?:[^"\\]|\\.)*)(")|[^\s,}\]"\\]+)/gi,
    (_, label, e1, e2, p1, _body, p3) => (e1 ? `${label}${e1}${MASK}${e2}` : p1 ? `${label}${p1}${MASK}${p3}` : `${label}${MASK}`)],
  // scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // JWTs
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, MASK],
];

// MySQL/MariaDB clients take the password attached to -p ("-phunter2"); elsewhere -p is a port, a flag or a path option.
const MYSQL_CLIENT = /^\s*(?:\S*\/)?(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb|mariadb-dump)(?=\s)/;

function maskMysqlPasswords(text) {
  return text.split(/(\|\|?|;|&&)/).map((seg) => (MYSQL_CLIENT.test(seg) ? seg.replace(/(\s-p)[^\s"'-][^\s"']*/g, `$1${MASK}`) : seg)).join('');
}

export function maskSecrets(text) {
  let out = maskMysqlPasswords(String(text ?? ''));
  for (const [re, to] of MASKS) out = out.replace(re, to);
  // Long opaque runs that mix letters and digits look like keys.
  return out.replace(/[A-Za-z0-9_-]{24,}/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? MASK : run));
}

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Detail is built from fields that are safe to show; mask first, then cut, so a cut never leaves half a secret.
function detailFor(toolName, input) {
  if (toolName === 'Bash' || toolName === 'PowerShell') return cut(maskSecrets((input.command || '').slice(0, MASK_INPUT_MAX)), LIMITS.detail);
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') return cut(input.file_path || '', LIMITS.detail);
  if (toolName === 'WebFetch') return cut(maskSecrets((input.url || '').slice(0, MASK_INPUT_MAX)), LIMITS.detail);
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
