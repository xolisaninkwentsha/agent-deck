// Tailscale identity, for pairing panels across your own machines without copying tokens.
// Only read-only CLI calls (status, whois). Any failure (no Tailscale, timeout, odd output)
// means "unknown", and unknown is always refused.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

// Fixed paths first: hooks start the daemon inside whatever environment a session has.
// On macOS the App Store app keeps its CLI inside the bundle.
const CANDIDATES = ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
export function tailscaleBin() {
  if (process.env.AGENT_DECK_TAILSCALE) return process.env.AGENT_DECK_TAILSCALE; // tests: a fake
  return CANDIDATES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function runJson(args) {
  const bin = tailscaleBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => execFile(bin, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return resolve(null);
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  }));
}

const CACHE_OVERRIDE = process.env.AGENT_DECK_TAILSCALE_CACHE_MS; // tests: "0" (each call asks again)
const ttl = (ms) => (CACHE_OVERRIDE !== undefined ? Number(CACHE_OVERRIDE) || 0 : ms);
const label = (dns) => String(dns || '').split('.')[0]; // "my-macbook.tailnet.ts.net." -> "my-macbook"
export const plainIp = (addr) => String(addr || '').replace(/^::ffff:/, '');

let statusCache = { at: 0, value: null };
// This machine and its peers. Cached for 10 s.
export async function tsStatus(now = Date.now()) {
  if (now - statusCache.at < ttl(10000)) return statusCache.value;
  const j = await runJson(['status', '--json']);
  const value = j?.Self?.ID ? {
    self: { id: j.Self.ID, userId: j.Self.UserID, dns: label(j.Self.DNSName), name: j.Self.HostName, ips: j.Self.TailscaleIPs || [] },
    peers: Object.values(j.Peer || {}).map((p) => ({
      id: p.ID, userId: p.UserID, dns: label(p.DNSName), name: p.HostName, ips: p.TailscaleIPs || [], os: p.OS || '',
      online: Boolean(p.Online), tagged: Array.isArray(p.Tags) && p.Tags.length > 0,
    })),
  } : null;
  statusCache = { at: now, value };
  return value;
}

const whoisCache = new Map(); // ip -> { at, value }
// Who is at this address: one of *your own* devices (same Tailscale user, not a tagged
// server), or null. Cached 30 s when known, 5 s when not.
export async function ownDevice(addr, now = Date.now()) {
  const ip = plainIp(addr);
  const hit = whoisCache.get(ip);
  if (hit && now - hit.at < ttl(hit.value ? 30000 : 5000)) return hit.value;
  const [st, w] = await Promise.all([tsStatus(now), runJson(['whois', '--json', ip])]);
  const node = w?.Node, user = w?.UserProfile;
  const own = st && node && typeof node.StableID === 'string' && node.StableID && user
    && user.ID === st.self.userId && node.User === st.self.userId && !(Array.isArray(node.Tags) && node.Tags.length);
  const value = own ? {
    id: node.StableID, dns: label(node.Name) || String(node.ComputedName || ''),
    name: String(node.Hostinfo?.Hostname || node.ComputedName || label(node.Name)).slice(0, 80), login: String(user.LoginName || '').slice(0, 120),
  } : null;
  whoisCache.set(ip, { at: now, value });
  if (whoisCache.size > 200) whoisCache.delete(whoisCache.keys().next().value);
  return value;
}
