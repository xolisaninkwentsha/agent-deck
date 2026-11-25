// Per-message pricing (micro-USD), balance reservation and the hourly cap.
const HOUR_MS = 3600000;

export function priceFor(number, config) {
  if (config.billing === 'off') return 0;
  const rates = config.rates || {};
  let rate = rates.default;
  let best = -1;
  for (const key of Object.keys(rates)) {
    if (key === 'default') continue;
    if (key.length > best && String(number).startsWith(key)) {
      best = key.length;
      rate = rates[key];
    }
  }
  return Math.ceil((rate * (100 + config.markupPercent)) / 100);
}

export function reserve(account, price, nowMs, cap) {
  account.sent = (account.sent || []).filter((t) => nowMs - t < HOUR_MS);
  if (account.sent.length >= cap) return { ok: false, reason: 'rate-limited' };
  if (account.balance < price) return { ok: false, reason: 'no-credit' };
  account.balance -= price;
  account.sent.push(nowMs);
  return { ok: true };
}

export function release(account, price) {
  account.balance += price;
  if (account.sent && account.sent.length) account.sent.pop();
}
