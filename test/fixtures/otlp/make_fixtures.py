"""Record real OTLP/HTTP protobuf requests from the official OpenTelemetry Python SDK.

Emits exactly what the README tells an agent to emit, sends it to a capture server on a
random local port, and saves each request body as test/fixtures/otlp/<signal>.bin.
npm test decodes those files, so the decoder is checked against the real exporter's bytes.

Not run by npm test. To regenerate (needs opentelemetry-sdk + opentelemetry-exporter-otlp-proto-http):
    pip install --target /tmp/otel-py opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
    PYTHONPATH=/tmp/otel-py python3 test/fixtures/otlp/make_fixtures.py
    PYTHONPATH=/tmp/otel-py python3 test/fixtures/otlp/make_fixtures.py delta   # only metrics-delta.bin
"""
import json, logging, os, sys, threading

# "delta": metrics exported with delta temporality, as OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
# does (each point is the increase since the last export). Writes metrics-delta.bin only.
DELTA = sys.argv[1:] == ["delta"]
if DELTA:
    os.environ["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = "delta"
from http.server import BaseHTTPRequestHandler, HTTPServer

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.trace import Status, StatusCode

HERE = os.path.dirname(os.path.abspath(__file__))
captured = {}


class Capture(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        captured.setdefault(self.path, []).append((self.headers.get("content-type"), body))
        self.send_response(200)
        self.send_header("content-type", "application/x-protobuf")
        self.end_headers()

    def log_message(self, *a):
        pass


server = HTTPServer(("127.0.0.1", 0), Capture)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"

# --- the README snippet, with the endpoint pointed at the capture server ---
resource = Resource.create({"service.name": "fixture-agent", "service.version": "1.2.3"})
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{base}/v1/traces")))
tracer = tracer_provider.get_tracer("fixture-agent")

reader = PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{base}/v1/metrics"), export_interval_millis=3_600_000)
meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
heartbeat = meter_provider.get_meter("fixture-agent").create_counter("agent.heartbeat")

logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{base}/v1/logs")))
log = logging.getLogger("fixture-agent")
log.addHandler(LoggingHandler(level=logging.WARNING, logger_provider=logger_provider))
log.propagate = False

heartbeat.add(1)
heartbeat.add(1)

# A finished job: model call with token use, a tool call, and something waiting on a person.
with tracer.start_as_current_span("invoke_agent daily", attributes={"job.name": "daily", "gen_ai.operation.name": "invoke_agent"}) as job:
    with tracer.start_as_current_span("chat claude-sonnet-5-5", attributes={
        "job.name": "daily", "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5-5", "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 340,
    }):
        pass
    with tracer.start_as_current_span("execute_tool xero_lookup", attributes={
        "job.name": "daily", "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "xero_lookup",
    }):
        pass
    job.add_event("waiting", {"waiting.id": "bill-42", "waiting.title": "Approve supplier bill", "url.full": "https://chat.google.com/room/FIXTURE/thread-1"})

# A failed job: the exception's type is what the panel shows; its message must never be stored.
# Same keys as the SDK's record_exception (type, message, stacktrace, escaped), written by hand so
# no file path from this machine ends up in the fixture.
with tracer.start_as_current_span("invoke_agent weekly", attributes={"job.name": "weekly", "gen_ai.operation.name": "invoke_agent"},
                                  record_exception=False, set_status_on_exception=False) as job:
    job.set_status(Status(StatusCode.ERROR, "PermissionError: SECRET-MESSAGE customer Acme owes R 18 400"))
    job.add_event("exception", {"exception.type": "PermissionError", "exception.message": "SECRET-MESSAGE customer Acme owes R 18 400",
                                "exception.stacktrace": "Traceback (most recent call last):\nPermissionError: SECRET-MESSAGE", "exception.escaped": "False"})

# An error log: severity and exception type only; the body must never be stored.
# (Built by hand so the recorded code.file.path is neutral, not this machine's home folder.)
err = TimeoutError("SECRET-LOG-BODY investor term sheet")
log.handle(logging.LogRecord("fixture-agent", logging.ERROR, "make_fixtures.py", 1,
                             "SECRET-LOG-BODY sync failed for investor@example.com", None, (TimeoutError, err, None)))

tracer_provider.force_flush()
reader.force_flush()
logger_provider.force_flush()

index = os.path.join(HERE, "fixtures.json")
expected = {}
if DELTA:
    with open(index) as f:
        expected = json.load(f)
for path, reqs in captured.items():
    signal = path.rsplit("/", 1)[-1]
    if DELTA:
        if signal != "metrics":
            continue
        signal = "metrics-delta"
    content_type, body = reqs[0]
    with open(os.path.join(HERE, f"{signal}.bin"), "wb") as f:
        f.write(body)
    expected[signal] = {"content_type": content_type, "bytes": len(body), "requests": len(reqs)}
with open(index, "w") as f:
    json.dump(expected, f, indent=1)
print(json.dumps(expected))
tracer_provider.shutdown(); meter_provider.shutdown(); logger_provider.shutdown()
server.shutdown()
