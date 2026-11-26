"""Report a long-running agent to Modisa (the always-on-top panel for agents on this machine).

    from modisa import Agent
    agent = Agent("finance-agent")
    agent.start("Billing, collections and supplier bills", heartbeat=60, timer=False)  # long-running process
    ...in its main loop: agent.heartbeat()                # timer=False: a hung loop shows "not responding"
    with agent.job("daily", "morning run") as job:        # job_start / job_end; failure = exception type only
        agent.step("Matching payments")
        agent.waiting("bill-42", "Approve supplier bill", "https://chat.google.com/...")
        job.summary = "3 reminders sent"
    agent.resolved("bill-42")
    agent.waiting_set([("bill-43", "Approve supplier bill", link)])  # the full open list; replaces it
    agent.error("Xero sign-in expired")

Keep titles and messages short and free of names, amounts and email text: they are stored by
the panel, shown in desktop notifications and on any machine the panel is shared with.

Never raises and never blocks: events are queued and posted to the local Modisa daemon
(127.0.0.1) by a background thread; if it isn't running they're dropped. MODISA_DISABLE=1
(or Agent(..., enabled=False)) turns everything off, e.g. in tests. Standard library only:
copy this file into the agent's repo.
"""
import atexit, contextlib, json, os, queue, threading, time, urllib.request


class _Job:
    summary = ""


class Agent:
    def __init__(self, agent, port=None, enabled=None):
        self.agent = agent
        self.enabled = (os.environ.get("MODISA_DISABLE", "") in ("", "0")) if enabled is None else bool(enabled)
        if not self.enabled:
            return
        try:
            with open(os.path.join(os.environ.get("MODISA_HOME") or os.path.expanduser("~/.modisa"), "config.json")) as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
        self._url = f"http://127.0.0.1:{int(port or os.environ.get('MODISA_PORT') or cfg.get('port') or 47615)}/agent"
        self._q = queue.Queue(maxsize=500)
        threading.Thread(target=self._pump, daemon=True).start()
        atexit.register(self._flush)  # short cron runs: give the last events up to a second

    def _send(self, event, **fields):
        if not self.enabled:
            return
        try:
            self._q.put_nowait(dict(fields, agent=self.agent, event=event, ts=time.time()))
        except Exception:
            pass  # queue full: drop

    def _pump(self):
        while True:
            body = json.dumps(self._q.get()).encode()
            try:
                req = urllib.request.Request(self._url, data=body, headers={"content-type": "application/json"})
                urllib.request.urlopen(req, timeout=1).close()
            except Exception:
                pass  # daemon down: drop
            self._q.task_done()

    def _flush(self, seconds=1.0):
        end = time.time() + seconds
        while self._q.unfinished_tasks and time.time() < end:
            time.sleep(0.02)

    def start(self, description="", heartbeat=60, name=None, timer=True):
        """heartbeat: seconds between heartbeats (0 = none). timer=False: call heartbeat() yourself."""
        self._send("start", description=description, heartbeat=heartbeat, name=name or self.agent, cwd=os.getcwd())
        if self.enabled and timer and heartbeat and heartbeat > 0:
            def beat():
                while True:
                    time.sleep(heartbeat)
                    self.heartbeat()
            threading.Thread(target=beat, daemon=True).start()

    def heartbeat(self): self._send("heartbeat")
    def step(self, text): self._send("step", text=str(text))
    def waiting(self, id, title, link=""): self._send("waiting", id=str(id), title=str(title), link=str(link or ""))
    def resolved(self, id): self._send("resolved", id=str(id))
    def error(self, message): self._send("error", message=str(message))
    def schedule(self, items): self._send("schedule", schedule=[{"job": j, "next_run": t} for j, t in items])

    def waiting_set(self, items):
        """The complete list of what's waiting on a human, as (id, title, link) tuples."""
        try:
            self._send("waiting_set", items=[{"id": str(i), "title": str(t), "link": str(l or "")} for i, t, l in items])
        except Exception:
            pass

    @contextlib.contextmanager
    def job(self, name, detail=""):
        """Reports job_start/job_end around the block. The block's own exceptions pass through;
        only their type name is reported (messages can hold names and amounts)."""
        handle = _Job()
        self._send("job_start", job=name, detail=str(detail))
        try:
            yield handle
        except BaseException as e:
            if isinstance(e, SystemExit) and e.code in (0, None):  # sys.exit() inside a job is a normal end
                self._send("job_end", job=name, result="ok", summary=str(handle.summary or ""))
            else:
                self._send("job_end", job=name, result="error", summary=type(e).__name__)
            raise
        self._send("job_end", job=name, result="ok", summary=str(handle.summary or ""))
