// Record real OTLP/HTTP JSON requests from the official OpenTelemetry JS SDK (the Python
// exporter only speaks protobuf). Emits the same telemetry as make_fixtures.py, plus a waiting
// item sent as a log event, sends it to a capture server on a random local port, and saves each
// request body as test/fixtures/otlp/<signal>.json. npm test posts those files to the receiver.
//
// Not run by npm test. To regenerate (the packages stay outside this repo):
//   npm install --prefix /tmp/otel-js @opentelemetry/api@1.10 @opentelemetry/exporter-trace-otlp-http \
//     @opentelemetry/exporter-metrics-otlp-http @opentelemetry/exporter-logs-otlp-http
//   node test/fixtures/otlp/make_json_fixtures.mjs /tmp/otel-js
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) { console.error('usage: make_json_fixtures.mjs <dir with node_modules/@opentelemetry>'); process.exit(2); }
const require = createRequire(path.resolve(process.argv[2]) + '/');
const { trace, context, SpanStatusCode, SeverityNumber } = require('@opentelemetry/api');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { TracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { LoggerProvider, BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');

const captured = {};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    (captured[req.url] ||= []).push({ type: req.headers['content-type'], encoding: req.headers['content-encoding'] || '', body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const resource = resourceFromAttributes({ 'service.name': 'fixture-agent-js', 'service.version': '1.2.3' });
const tracerProvider = new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) })] });
const tracer = tracerProvider.getTracer('fixture-agent-js');
const reader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }), exportIntervalMillis: 3_600_000 });
const meterProvider = new MeterProvider({ resource, readers: [reader] });
const heartbeat = meterProvider.getMeter('fixture-agent-js').createCounter('agent.heartbeat');
const loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }) })] });
const logger = loggerProvider.getLogger('fixture-agent-js');

heartbeat.add(1);
heartbeat.add(1);

const child = (parent, name, attributes) => tracer.startSpan(name, { attributes }, trace.setSpan(context.active(), parent)).end();

// A finished job: model call with token use, a tool call, and something waiting on a person.
const daily = tracer.startSpan('invoke_agent daily', { attributes: { 'job.name': 'daily', 'gen_ai.operation.name': 'invoke_agent' } });
child(daily, 'chat claude-sonnet-5-5', {
  'job.name': 'daily', 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic',
  'gen_ai.request.model': 'claude-sonnet-5-5', 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 340,
});
child(daily, 'execute_tool xero_lookup', { 'job.name': 'daily', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'xero_lookup' });
daily.addEvent('waiting', { 'waiting.id': 'bill-42', 'waiting.title': 'Approve supplier bill', 'url.full': 'https://chat.google.com/room/FIXTURE/thread-1' });
daily.end();

// A failed job: the exception's type is what the panel shows; its message must never be stored.
const weekly = tracer.startSpan('invoke_agent weekly', { attributes: { 'job.name': 'weekly', 'gen_ai.operation.name': 'invoke_agent' } });
weekly.addEvent('exception', { 'exception.type': 'PermissionError', 'exception.message': 'SECRET-MESSAGE customer Acme owes R 18 400', 'exception.stacktrace': 'PermissionError: SECRET-MESSAGE\n    at job (agent.js:1:1)' });
weekly.setStatus({ code: SpanStatusCode.ERROR, message: 'PermissionError: SECRET-MESSAGE customer Acme owes R 18 400' });
weekly.end();

// Something waiting on a person, sent as a log event; and an error log (type only, never the body).
logger.emit({ eventName: 'approval.requested', severityNumber: SeverityNumber.INFO, attributes: { 'approval.id': 'draft-7', 'approval.title': 'Send draft to investor', link: 'https://chat.google.com/room/FIXTURE/thread-2' } });
logger.emit({ severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', body: 'SECRET-LOG-BODY sync failed for investor@example.com', attributes: { 'exception.type': 'TimeoutError', 'exception.message': 'SECRET-LOG-BODY investor term sheet' } });

await tracerProvider.forceFlush();
await reader.forceFlush();
await loggerProvider.forceFlush();

const index = path.join(HERE, 'fixtures.json');
const expected = JSON.parse(fs.readFileSync(index, 'utf8'));
for (const [url, reqs] of Object.entries(captured)) {
  const signal = url.split('/').pop();
  const { type, encoding, body } = reqs[0];
  fs.writeFileSync(path.join(HERE, `${signal}.json`), body);
  expected[`${signal}.json`] = { content_type: type, content_encoding: encoding, bytes: body.length, requests: reqs.length };
}
fs.writeFileSync(index, JSON.stringify(expected, null, 1));
console.log(JSON.stringify(expected));
await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()]);
server.close();
