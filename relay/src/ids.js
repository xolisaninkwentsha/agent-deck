// Ids, hashing and phone-number helpers. Web-standard APIs only.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Rejection sampling: drop bytes at or above the largest multiple of the alphabet size.
function randomString(length, alphabet) {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function newCode() {
  return randomString(8, CODE_ALPHABET);
}

export function newRef() {
  return randomString(12, CODE_ALPHABET.toLowerCase());
}

const CODE_RE = new RegExp(`(?<![A-Z0-9])([${CODE_ALPHABET}]{4})[- ]?([${CODE_ALPHABET}]{4})(?![A-Z0-9])`, 'i');

export function findCode(text) {
  const m = CODE_RE.exec(String(text ?? ''));
  return m ? (m[1] + m[2]).toUpperCase() : null;
}

export async function sha256Hex(s) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeNumber(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/\(\s*0\s*\)/g, '').replace(/[\s\-.()[\]]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) return null;
  if (s.startsWith('0')) return null; // no country code starts with 0
  return /^\d{8,15}$/.test(s) ? s : null;
}

export function maskNumber(digits) {
  const d = String(digits);
  return '+' + d.slice(0, 2) + '•'.repeat(Math.max(0, d.length - 6)) + d.slice(-4);
}
