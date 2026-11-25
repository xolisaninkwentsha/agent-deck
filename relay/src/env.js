// The Worker's variables and secrets → the relay config. Plain JavaScript with no Workers imports,
// so the tests run it in Node. Errors name the variable and never quote its value.
import { normalizeNumber } from './ids.js';

const BILLING = ['off', 'trial', 'on'];

// Workers hand secrets over as strings and [vars] as strings or numbers. Blank means unset.
function raw(env, name) {
  const v = env ? env[name] : undefined;
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function required(env, name) {
  const v = raw(env, name);
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
}

const isRate = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function amount(env, name, fallback) {
  const v = raw(env, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!isRate(n)) throw new Error(`${name} must be a number of 0 or more`);
  return n;
}

function rates(env) {
  const v = raw(env, 'RATES_JSON');
  if (v === undefined) return { default: 0 };
  let parsed;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new Error('RATES_JSON is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !isRate(parsed.default)) {
    throw new Error('RATES_JSON must be an object whose "default" is a number of 0 or more');
  }
  for (const value of Object.values(parsed)) {
    if (!isRate(value)) throw new Error('RATES_JSON rates must all be numbers of 0 or more');
  }
  return parsed;
}

export function parseEnv(env) {
  const graphVersion = required(env, 'GRAPH_VERSION');
  const whatsapp = {
    token: required(env, 'WA_TOKEN'),
    phoneNumberId: required(env, 'WA_PHONE_NUMBER_ID'),
    appSecret: required(env, 'WA_APP_SECRET'),
    verifyToken: required(env, 'WA_VERIFY_TOKEN'),
    graphVersion,
  };
  const botNumber = normalizeNumber(required(env, 'BOT_NUMBER'));
  if (!botNumber) throw new Error('BOT_NUMBER must be a phone number with its country code');
  const billing = raw(env, 'BILLING') ?? 'off';
  if (!BILLING.includes(billing)) throw new Error('BILLING must be off, trial or on');
  return {
    botNumber,
    billing,
    trialMicroUsd: amount(env, 'TRIAL_MICRO_USD', 0),
    rates: rates(env),
    markupPercent: amount(env, 'MARKUP_PERCENT', 0),
    hourlyCap: amount(env, 'HOURLY_CAP', 60),
    codeTtlMs: 600000,
    windowMs: 86400000,
    template: { name: raw(env, 'TEMPLATE_NAME') ?? 'agent_deck_needs_you', lang: raw(env, 'TEMPLATE_LANG') ?? 'en' },
    whatsapp,
  };
}
