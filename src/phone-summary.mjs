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
  // X-Api-Key: x, X-Auth-Token: x, Authorization-Token: x. Anchored on the keyword plus a bounded suffix, so the name's length can't matter.
  // Only the exact Authorization header is skipped (the first rule masked it, so its scheme word stays); that rule needs a word boundary, so X_Authorization: is masked here.
  [/((?:token|key|secret|password|pass|auth)[\w-]{0,64}\s*:\s*)[^\s"']+/gi,
    (m, label, at, str) => (/^authorization\s*:/i.test(label) && !/\w/.test(str[at - 1] ?? '') ? m : `${label}${MASK}`)],
  // curl -u user:pass, --user user:pass
  [/(\s(?:-u|--user)(?:=|\s+))[^\s"':]+:[^\s"']+/g, `$1${MASK}`],
  // --token=x, --password x
  [new RegExp(`(--(?:token|key|secret|password|pass|pwd|auth|api-key)(?:=|\\s+))${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // API_KEY=x, DB_PASSWORD="x"
  [new RegExp(`((?:TOKEN|KEY|SECRET|PASS|PWD|AUTH)[A-Za-z0-9_]{0,64}=)${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // JSON "api_key": "x" (also shell-escaped \"api_key\": \"x\", escapes inside the value, and bare numbers).
  // A matched label always masks its value. An escaped value ends at the first \" followed by , } ] " or the end
  // (so a secret holding \" isn't cut early), else at the next \", else at whitespace; a plain one at its closing " or whitespace.
  // The first scan is bounded by the masking input cap so many labels can't make it quadratic.
  [/((?:key|token|secret|password)[^"\\]{0,64}\\?"\s*:\s*)(?:(\\")(?:[^]{0,2000}?(?=\\"\s*(?:[,}\]"]|$))|[^]*?(?=\\")|[^\s"']+)(\\")?|(")(?:(?:[^"\\]|\\.)*(")|[^\s"']+)|[^\s,}\]"\\]+)/gi,
    (_, label, escOpen, escClose, open, close) => `${label}${escOpen || open || ''}${MASK}${escClose || close || ''}`],
  // scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // JWTs
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, MASK],
];

// MySQL/MariaDB clients take the password attached to -p ("-phunter2"); elsewhere -p is a port, a flag or a path option.
// A segment (split on | ; && || newline ( $( ) counts when a client name appears in it as a command word; only -p after that word is masked.
const MYSQL_CLIENT = /(?:^|[\s/\\])(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb|mariadb-dump|mariadb-admin|mariadb-import|mariadb-show|mariadb-check)(?:\.exe)?(?=\s|$)/;
const ATTACHED_P = /(\s-p)(?:"[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g;

function maskMysqlPasswords(text) {
  return text.split(/(\|\|?|;|&&|\n|\$\(|\()/).map((seg) => {
    const client = MYSQL_CLIENT.exec(seg);
    if (!client) return seg;
    const at = client.index + client[0].length;
    return seg.slice(0, at) + seg.slice(at).replace(ATTACHED_P, `$1${MASK}`);
  }).join('');
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
