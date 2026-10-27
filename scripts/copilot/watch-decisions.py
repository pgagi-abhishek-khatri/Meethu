#!/usr/bin/env python3
"""Pretty-prints copilot-decisions.jsonl lines as they are appended: tail -n0 -F FILE | python3 -u watch-decisions.py"""
import json
import sys

for line in sys.stdin:
    try:
        r = json.loads(line)
    except ValueError:
        continue
    kind = r.get("type")
    if kind == "decision":
        d = r["decision"]
        extra = ""
        if d["kind"] == "run":
            needs = "+".join(k for k, v in (d.get("needs") or {}).items() if v)
            extra = " %s %s/%s %s" % (d.get("trigger"), d.get("deliverable"), d.get("tier"), needs)
        print(
            "D1 %s%s | %dms call, %dms after speech, %s tok | text: %s | why: %s"
            % (d["kind"].upper(), extra, r["callMs"], r.get("reactionMs") or 0, r["inputTokens"], r["newText"][:110], "; ".join(d["reasons"])[:150]),
            flush=True,
        )
    elif kind == "summary":
        print("SUMMARY (%d chars): %s" % (r["chars"], r["text"][:200]), flush=True)
    elif kind in ("session_start", "session_end"):
        print("--- %s ---" % kind, flush=True)
