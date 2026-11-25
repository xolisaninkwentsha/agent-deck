// Decodes OTLP/HTTP export requests (traces, metrics, logs) from protobuf or JSON into one
// plain shape. No dependencies: a minimal protobuf wire reader with the field numbers of
// opentelemetry-proto (checked against the official 1.45 descriptors). Unknown fields are
// skipped. Log bodies and status messages are never decoded: Agent Deck keeps metadata only.

const MAX_DEPTH = 8;

// ---------- protobuf wire format ----------
function* fields(buf) {
  let p = 0;
  const varint = () => {
    let result = 0n, shift = 0n, b;
    do {
      if (p >= buf.length) throw new Error('truncated varint');
      b = buf[p++];
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80 && shift < 70n);
    return result;
  };
  while (p < buf.length) {
    const tag = Number(varint());
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) yield { field, wire, value: varint() };
    else if (wire === 1) { if (p + 8 > buf.length) throw new Error('truncated fixed64'); yield { field, wire, value: buf.subarray(p, p + 8) }; p += 8; }
    else if (wire === 2) {
      const len = Number(varint());
      if (len < 0 || p + len > buf.length) throw new Error('truncated bytes');
      yield { field, wire, value: buf.subarray(p, p + len) }; p += len;
    } else if (wire === 5) { if (p + 4 > buf.length) throw new Error('truncated fixed32'); yield { field, wire, value: buf.subarray(p, p + 4) }; p += 4; }
    else throw new Error(`unsupported wire type ${wire}`);
  }
}
const str = (b) => Buffer.from(b).toString('utf8');
const hex = (b) => Buffer.from(b).toString('hex');
const nanosToMs = (b) => Number(Buffer.from(b).readBigUInt64LE(0) / 1000000n);
const dbl = (b) => Buffer.from(b).readDoubleLE(0);
const i64 = (v) => Number(BigInt.asIntN(64, v));

function anyValue(buf, depth) {
  if (depth > MAX_DEPTH) return null;
  for (const f of fields(buf)) {
    switch (f.field) {
      case 1: return str(f.value);
      case 2: return f.value !== 0n;
      case 3: return i64(f.value);
      case 4: return dbl(f.value);
      case 5: { const out = []; for (const g of fields(f.value)) if (g.field === 1) out.push(anyValue(g.value, depth + 1)); return out; }
      case 6: return keyValues(f.value, 1, depth + 1);
      case 7: return hex(f.value);
      default: break; // e.g. string_value_strindex: no string table in these requests
    }
  }
  return null;
}
function keyValue(buf, depth) {
  let key = null, value = null;
  for (const f of fields(buf)) {
    if (f.field === 1) key = str(f.value);
    else if (f.field === 2) value = anyValue(f.value, depth);
  }
  return [key, value];
}
// Repeated KeyValue at `field` of a message -> plain object.
function keyValues(buf, field, depth = 0) {
  const out = {};
  for (const f of fields(buf)) {
    if (f.field !== field) continue;
    const [k, v] = keyValue(f.value, depth);
    if (k !== null) out[k] = v;
  }
  return out;
}
const resourceOf = (buf) => keyValues(buf, 1);

function span(buf) {
  const s = { traceId: '', spanId: '', parentSpanId: '', name: '', kind: 0, start: 0, end: 0, attrs: {}, events: [], status: { code: 0 } };
  for (const f of fields(buf)) {
    switch (f.field) {
      case 1: s.traceId = hex(f.value); break;
      case 2: s.spanId = hex(f.value); break;
      case 4: s.parentSpanId = hex(f.value); break;
      case 5: s.name = str(f.value); break;
      case 6: s.kind = Number(f.value); break;
      case 7: s.start = nanosToMs(f.value); break;
      case 8: s.end = nanosToMs(f.value); break;
      case 9: { const [k, v] = keyValue(f.value, 0); if (k !== null) s.attrs[k] = v; break; }
      case 11: {
        const ev = { name: '', time: 0, attrs: {} };
        for (const g of fields(f.value)) {
          if (g.field === 1) ev.time = nanosToMs(g.value);
          else if (g.field === 2) ev.name = str(g.value);
          else if (g.field === 3) { const [k, v] = keyValue(g.value, 0); if (k !== null) ev.attrs[k] = v; }
        }
        s.events.push(ev);
        break;
      }
      case 15: for (const g of fields(f.value)) if (g.field === 3) s.status.code = Number(g.value); break; // message (2) not read
      default: break;
    }
  }
  return s;
}

function numberPoint(buf) {
  const p = { attrs: {}, start: 0, time: 0, value: null };
  for (const f of fields(buf)) {
    if (f.field === 7) { const [k, v] = keyValue(f.value, 0); if (k !== null) p.attrs[k] = v; }
    else if (f.field === 2) p.start = nanosToMs(f.value);
    else if (f.field === 3) p.time = nanosToMs(f.value);
    else if (f.field === 4) p.value = dbl(f.value);
    else if (f.field === 6) p.value = Number(Buffer.from(f.value).readBigInt64LE(0));
  }
  return p;
}
function histogramPoint(buf) {
  const p = { attrs: {}, start: 0, time: 0, value: null, count: 0 };
  for (const f of fields(buf)) {
    if (f.field === 9) { const [k, v] = keyValue(f.value, 0); if (k !== null) p.attrs[k] = v; }
    else if (f.field === 2) p.start = nanosToMs(f.value);
    else if (f.field === 3) p.time = nanosToMs(f.value);
    else if (f.field === 4) p.count = Number(Buffer.from(f.value).readBigUInt64LE(0));
    else if (f.field === 5) p.value = dbl(f.value);
  }
  return p;
}
function metric(buf) {
  // temporality: 0 unspecified, 1 delta (each point is the change since the last export), 2 cumulative
  const m = { name: '', unit: '', kind: '', monotonic: false, temporality: 0, points: [] };
  for (const f of fields(buf)) {
    if (f.field === 1) m.name = str(f.value);
    else if (f.field === 3) m.unit = str(f.value);
    else if (f.field === 5 || f.field === 7 || f.field === 9) {
      m.kind = f.field === 5 ? 'gauge' : f.field === 7 ? 'sum' : 'histogram';
      for (const g of fields(f.value)) {
        if (g.field === 1) m.points.push(f.field === 9 ? histogramPoint(g.value) : numberPoint(g.value));
        else if (g.field === 2 && f.field !== 5) m.temporality = Number(g.value);
        else if (g.field === 3 && f.field === 7) m.monotonic = g.value !== 0n;
      }
    }
  }
  return m;
}
function logRecord(buf) {
  const r = { time: 0, severity: 0, severityText: '', attrs: {}, traceId: '', spanId: '', eventName: '' };
  for (const f of fields(buf)) {
    switch (f.field) {
      case 1: r.time = nanosToMs(f.value); break;
      case 11: if (!r.time) r.time = nanosToMs(f.value); break;
      case 2: r.severity = Number(f.value); break;
      case 3: r.severityText = str(f.value); break;
      case 6: { const [k, v] = keyValue(f.value, 0); if (k !== null) r.attrs[k] = v; break; }
      case 9: r.traceId = hex(f.value); break;
      case 10: r.spanId = hex(f.value); break;
      case 12: r.eventName = str(f.value); break;
      default: break; // 5 = body: never read
    }
  }
  return r;
}

// Export*ServiceRequest: repeated Resource{Spans,Metrics,Logs} (1) -> resource (1) + repeated Scope* (2) -> items (2).
function decodeProto(buf, item) {
  const out = [];
  for (const f of fields(buf)) {
    if (f.field !== 1) continue;
    const group = { resource: {}, items: [] };
    for (const g of fields(f.value)) {
      if (g.field === 1) group.resource = resourceOf(g.value);
      else if (g.field === 2) for (const h of fields(g.value)) if (h.field === 2) group.items.push(item(h.value));
    }
    out.push(group);
  }
  return out;
}

// ---------- OTLP/JSON ----------
const pick = (o, ...names) => { if (!o || typeof o !== 'object') return undefined; for (const n of names) if (o[n] !== undefined) return o[n]; return undefined; };
const jsonId = (v) => {
  if (typeof v !== 'string' || !v) return '';
  if (/^[0-9a-f]+$/i.test(v) && (v.length === 32 || v.length === 16)) return v.toLowerCase();
  try { return Buffer.from(v, 'base64').toString('hex'); } catch { return ''; }
};
const jsonMs = (v) => { try { return v == null || v === '' ? 0 : Number(BigInt(String(v).split('.')[0]) / 1000000n); } catch { return 0; } };
const STATUS_NAMES = { STATUS_CODE_UNSET: 0, STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2 };
const enumNum = (v, names) => (typeof v === 'number' ? v : typeof v === 'string' ? (names?.[v] ?? (Number(v) || 0)) : 0);
function jsonAny(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return null;
  if ('stringValue' in v || 'string_value' in v) return String(pick(v, 'stringValue', 'string_value'));
  if ('boolValue' in v || 'bool_value' in v) return Boolean(pick(v, 'boolValue', 'bool_value'));
  if ('intValue' in v || 'int_value' in v) return Number(pick(v, 'intValue', 'int_value'));
  if ('doubleValue' in v || 'double_value' in v) return Number(pick(v, 'doubleValue', 'double_value'));
  const arr = pick(v, 'arrayValue', 'array_value');
  if (arr) return (pick(arr, 'values') || []).map((x) => jsonAny(x, depth + 1));
  const kv = pick(v, 'kvlistValue', 'kvlist_value');
  if (kv) return jsonAttrs(pick(kv, 'values'), depth + 1);
  return null;
}
function jsonAttrs(list, depth = 0) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) if (a && typeof a.key === 'string') out[a.key] = jsonAny(a.value, depth);
  return out;
}
function decodeJson(obj, groupsKey, scopesKey, itemsKey, item) {
  const out = [];
  for (const g of pick(obj, groupsKey, snake(groupsKey)) || []) {
    const group = { resource: jsonAttrs(pick(pick(g, 'resource'), 'attributes')), items: [] };
    for (const sc of pick(g, scopesKey, snake(scopesKey)) || []) for (const it of pick(sc, itemsKey, snake(itemsKey)) || []) group.items.push(item(it));
    out.push(group);
  }
  return out;
}
const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const jsonSpan = (s) => ({
  traceId: jsonId(pick(s, 'traceId', 'trace_id')), spanId: jsonId(pick(s, 'spanId', 'span_id')), parentSpanId: jsonId(pick(s, 'parentSpanId', 'parent_span_id')),
  name: String(pick(s, 'name') || ''), kind: enumNum(pick(s, 'kind')), start: jsonMs(pick(s, 'startTimeUnixNano', 'start_time_unix_nano')), end: jsonMs(pick(s, 'endTimeUnixNano', 'end_time_unix_nano')),
  attrs: jsonAttrs(pick(s, 'attributes')),
  events: (pick(s, 'events') || []).map((e) => ({ name: String(pick(e, 'name') || ''), time: jsonMs(pick(e, 'timeUnixNano', 'time_unix_nano')), attrs: jsonAttrs(pick(e, 'attributes')) })),
  status: { code: enumNum(pick(pick(s, 'status'), 'code'), STATUS_NAMES) },
});
const jsonPoint = (p) => {
  const v = pick(p, 'asDouble', 'as_double') ?? pick(p, 'asInt', 'as_int') ?? pick(p, 'sum');
  return {
    attrs: jsonAttrs(pick(p, 'attributes')), start: jsonMs(pick(p, 'startTimeUnixNano', 'start_time_unix_nano')), time: jsonMs(pick(p, 'timeUnixNano', 'time_unix_nano')),
    value: v == null ? null : Number(v), count: Number(pick(p, 'count')) || 0,
  };
};
const TEMPORALITY_NAMES = { AGGREGATION_TEMPORALITY_UNSPECIFIED: 0, AGGREGATION_TEMPORALITY_DELTA: 1, AGGREGATION_TEMPORALITY_CUMULATIVE: 2 };
const jsonMetric = (m) => {
  const kind = pick(m, 'gauge') ? 'gauge' : pick(m, 'sum') ? 'sum' : pick(m, 'histogram') ? 'histogram' : '';
  const body = kind ? m[kind] : {};
  return {
    name: String(pick(m, 'name') || ''), unit: String(pick(m, 'unit') || ''), kind, monotonic: Boolean(pick(body, 'isMonotonic', 'is_monotonic')),
    temporality: kind === 'gauge' ? 0 : enumNum(pick(body, 'aggregationTemporality', 'aggregation_temporality'), TEMPORALITY_NAMES),
    points: (pick(body, 'dataPoints', 'data_points') || []).map(jsonPoint),
  };
};
const jsonLog = (r) => ({
  time: jsonMs(pick(r, 'timeUnixNano', 'time_unix_nano')) || jsonMs(pick(r, 'observedTimeUnixNano', 'observed_time_unix_nano')),
  severity: enumNum(pick(r, 'severityNumber', 'severity_number')), severityText: String(pick(r, 'severityText', 'severity_text') || ''),
  attrs: jsonAttrs(pick(r, 'attributes')), traceId: jsonId(pick(r, 'traceId', 'trace_id')), spanId: jsonId(pick(r, 'spanId', 'span_id')),
  eventName: String(pick(r, 'eventName', 'event_name') || ''),
});

// ---------- entry point ----------
// signal: 'traces' | 'metrics' | 'logs'; body: Buffer; json: boolean. Throws on a malformed body.
export function decodeOtlp(signal, body, json) {
  if (json) {
    const obj = JSON.parse(body.toString('utf8'));
    if (signal === 'traces') return decodeJson(obj, 'resourceSpans', 'scopeSpans', 'spans', jsonSpan);
    if (signal === 'metrics') return decodeJson(obj, 'resourceMetrics', 'scopeMetrics', 'metrics', jsonMetric);
    return decodeJson(obj, 'resourceLogs', 'scopeLogs', 'logRecords', jsonLog);
  }
  if (signal === 'traces') return decodeProto(body, span);
  if (signal === 'metrics') return decodeProto(body, metric);
  return decodeProto(body, logRecord);
}
