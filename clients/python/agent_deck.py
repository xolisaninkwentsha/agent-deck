"""Report a long-running agent to Agent Deck (the always-on-top panel for agents on this machine).

    from agent_deck import Deck
    deck = Deck("finance-agent")
    deck.start("Billing, collections and supplier bills", heartbeat=60)  # long-running process only
    with deck.job("daily", "morning run") as job:
        deck.step("Matching payments")
        deck.waiting("bill-42", "Approve supplier bill 42", "https://chat.google.com/...")
        job.summary = "3 reminders sent"
    deck.resolved("bill-42"); deck.error("Xero sign-in expired")

Never raises and never blocks: events are queued and posted to the local Agent Deck daemon
(127.0.0.1) by a background thread; if the daemon isn't running they're dropped.
Standard library only. Copy this file into the agent's repo.
"""
import atexit, contextlib, json, os, queue, threading, time, urllib.request


class _Job:
    summary = ""


class Deck:
    def __init__(self, agent, port=None):
        self.agent, self._q = agent, queue.Queue(maxsize=500)
        try:
            with open(os.path.join(os.environ.get("AGENT_DECK_HOME") or os.path.expanduser("~/.agent-deck"), "config.json")) as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
        self._url = f"http://127.0.0.1:{int(port or os.environ.get('AGENT_DECK_PORT') or cfg.get('port') or 47615)}/agent"
        threading.Thread(target=self._pump, daemon=True).start()
        atexit.register(self._flush)  # short cron runs: give the last events up to a second

    def _send(self, event, **fields):
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

    def start(self, description="", heartbeat=60, name=None):
        self._send("start", description=description, heartbeat=heartbeat, name=name or self.agent, cwd=os.getcwd())
        if heartbeat and heartbeat > 0:
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

    @contextlib.contextmanager
    def job(self, name, detail=""):
        """Reports job_start/job_end around the block. The block's own exceptions pass through."""
        handle = _Job()
        self._send("job_start", job=name, detail=str(detail))
        try:
            yield handle
        except BaseException as e:
            if isinstance(e, SystemExit) and e.code in (0, None):  # sys.exit() inside a job is a normal end
                self._send("job_end", job=name, result="ok", summary=str(handle.summary or ""))
            else:
                self._send("job_end", job=name, result="error", summary=f"{type(e).__name__}: {e}"[:300])
            raise
        self._send("job_end", job=name, result="ok", summary=str(handle.summary or ""))
