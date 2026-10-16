#!/usr/bin/env python3
"""Claude Code status line for Acode.

Claude Code pipes a JSON document to stdin on every update (see
https://code.claude.com/docs/en/statusline.md). This script

  1. writes the parts Acode shows (model, context, cost, rate limits) to
     ~/Library/Application Support/Acode/usage/<session_id>.json, which the app watches;
  2. prints the status line inside Claude Code itself: one summary line, then one line per
     running subagent of the session with its model.

It must never break Claude Code: every step is guarded and the exit code is always 0.
Standard library only; runs on the macOS system python3.
"""
import json
import os
import re
import sys
import tempfile
import time

USAGE_DIR = os.path.expanduser("~/Library/Application Support/Acode/usage")
PRUNE_AFTER_SECONDS = 7 * 24 * 3600
# Subagents: same "running" rule as src/main/claude/subagents.ts.
AGENT_QUIET_SECONDS = 10 * 60
AGENT_TAIL_BYTES = 256 * 1024
AGENT_LIMIT = 8
PARENT_TAIL_BYTES = 1024 * 1024


def pct(value):
    """Rounded percentage or None."""
    try:
        if value is None:
            return None
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def window(obj, key):
    """{usedPercent, resetsAt(ms)} for a rate-limit window, or None when absent."""
    win = (obj or {}).get(key)
    if not isinstance(win, dict):
        return None
    used = pct(win.get("used_percentage"))
    resets = win.get("resets_at")
    try:
        resets_ms = int(float(resets)) * 1000 if resets is not None else None
    except (TypeError, ValueError):
        resets_ms = None
    if used is None and resets_ms is None:
        return None
    return {"usedPercent": used, "resetsAt": resets_ms}


def safe_session_id(value):
    if not isinstance(value, str) or not value:
        return None
    if any(ch in value for ch in "/\\\0") or value in (".", ".."):
        return None
    return value


def write_usage(data):
    session_id = safe_session_id(data.get("session_id"))
    if not session_id:
        return
    model = data.get("model") if isinstance(data.get("model"), dict) else {}
    context = data.get("context_window") if isinstance(data.get("context_window"), dict) else {}
    cost = data.get("cost") if isinstance(data.get("cost"), dict) else {}
    limits = data.get("rate_limits") if isinstance(data.get("rate_limits"), dict) else {}
    record = {
        "sessionId": session_id,
        "cwd": data.get("cwd") if isinstance(data.get("cwd"), str) else None,
        "model": {"id": model.get("id"), "displayName": model.get("display_name")},
        "contextWindow": {
            "usedPercent": pct(context.get("used_percentage")),
            "size": context.get("context_window_size"),
            "totalInputTokens": context.get("total_input_tokens"),
            "totalOutputTokens": context.get("total_output_tokens"),
        },
        "cost": {"totalUsd": cost.get("total_cost_usd")},
        "rateLimits": {
            "fiveHour": window(limits, "five_hour"),
            "sevenDay": window(limits, "seven_day"),
            "spendLimit": window(limits, "spend_limit"),
        },
        "updatedAt": int(time.time() * 1000),
    }
    os.makedirs(USAGE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=USAGE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle)
        os.replace(tmp, os.path.join(USAGE_DIR, session_id + ".json"))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def prune():
    """Drops records older than a week. Runs on roughly one call in fifty to keep the hot path cheap."""
    if int(time.time()) % 50 != 0:
        return
    cutoff = time.time() - PRUNE_AFTER_SECONDS
    for name in os.listdir(USAGE_DIR):
        path = os.path.join(USAGE_DIR, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.unlink(path)
        except OSError:
            pass


def status_line(data):
    parts = []
    model = data.get("model") if isinstance(data.get("model"), dict) else {}
    name = model.get("display_name") or model.get("id")
    if name:
        parts.append(str(name))
    context = data.get("context_window") if isinstance(data.get("context_window"), dict) else {}
    ctx = pct(context.get("used_percentage"))
    if ctx is not None:
        parts.append("ctx %d%%" % ctx)
    limits = data.get("rate_limits") if isinstance(data.get("rate_limits"), dict) else {}
    five = window(limits, "five_hour")
    if five and five.get("usedPercent") is not None:
        parts.append("5h %d%%" % five["usedPercent"])
    week = window(limits, "seven_day")
    if week and week.get("usedPercent") is not None:
        parts.append("week %d%%" % week["usedPercent"])
    return " · ".join(parts)


def model_name(model_id):
    """claude-opus-5-5 -> "Opus 5.5"; unknown shapes are returned as they are."""
    if not isinstance(model_id, str) or not model_id:
        return None
    for family in ("fable", "opus", "sonnet", "haiku"):
        marker = family + "-"
        at = model_id.find(marker)
        if at >= 0:
            version = []
            for part in model_id[at + len(marker):].split("-"):
                if part.isdigit() and len(part) <= 2:
                    version.append(part)
                else:
                    break
            label = family.capitalize()
            return label + (" " + ".".join(version) if version else "")
    return model_id


def ends_turn(record):
    """Whether a user or assistant record ends the agent's turn (same rule as subagents.ts)."""
    message = record.get("message") if isinstance(record.get("message"), dict) else {}
    if record.get("type") == "assistant":
        return message.get("stop_reason") == "end_turn"
    if record.get("toolEndsTurn") is True:
        return True
    content = message.get("content")
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        texts = [c.get("text") for c in content if isinstance(c, dict)]
    else:
        texts = []
    return any(isinstance(t, str) and t.startswith("[Request interrupted by user") for t in texts)


def agent_facts(path):
    """(closed, model, last_at) from the tail: the last user/assistant record decides closed."""
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        if size > AGENT_TAIL_BYTES:
            handle.seek(size - AGENT_TAIL_BYTES)
        tail = handle.read().decode("utf-8", "replace")
    closed = None
    last_at = None
    model = None
    for line in reversed(tail.splitlines()):
        if '"assistant"' not in line and '"user"' not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("type") not in ("assistant", "user"):
            continue
        if closed is None:
            closed = ends_turn(record)
            last_at = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
        if record.get("type") == "assistant":
            message = record.get("message") if isinstance(record.get("message"), dict) else {}
            model = message.get("model")
            if model == "<synthetic>":
                model = None
            if model:
                break
    return bool(closed), model, last_at


def is_notification(record):
    if record.get("type") == "queue-operation":
        return record.get("operation") == "enqueue"
    origin = record.get("origin") if isinstance(record.get("origin"), dict) else {}
    return record.get("type") == "user" and origin.get("kind") == "task-notification"


def stopped_agents(parent_transcript):
    """{agent id: latest stop time} from task notifications in the parent transcript tail."""
    stopped = {}
    try:
        size = os.path.getsize(parent_transcript)
        with open(parent_transcript, "rb") as handle:
            if size > PARENT_TAIL_BYTES:
                handle.seek(size - PARENT_TAIL_BYTES)
            tail = handle.read().decode("utf-8", "replace")
    except OSError:
        return stopped
    for line in tail.splitlines():
        if "<task-notification>" not in line:
            continue
        # Only the notification itself; later copies would make a resumed agent look stopped.
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or not is_notification(record):
            continue
        ts = record.get("timestamp")
        if not isinstance(ts, str):
            continue
        for block in line.split("<task-notification>")[1:]:
            agent = re.search(r"<task-id>([A-Za-z0-9_-]+)</task-id>", block)
            status = re.search(r"<status>([a-z_]+)</status>", block)
            if not agent or not status or status.group(1) == "running":
                continue
            if stopped.get(agent.group(1), "") < ts:
                stopped[agent.group(1)] = ts
    return stopped


def running_agents(data, parent_model):
    """Lines for the subagents of this session that are still working."""
    transcript = data.get("transcript_path")
    session_id = safe_session_id(data.get("session_id"))
    if not isinstance(transcript, str) or not session_id:
        return []
    folder = os.path.join(os.path.dirname(os.path.expanduser(transcript)), session_id, "subagents")
    if not os.path.isdir(folder):
        return []
    now = time.time()
    found = []
    for name in os.listdir(folder):
        if not (name.startswith("agent-") and name.endswith(".jsonl")):
            continue
        path = os.path.join(folder, name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if now - mtime >= AGENT_QUIET_SECONDS:
            continue
        found.append((mtime, path))
    found.sort(reverse=True)
    stopped = stopped_agents(os.path.expanduser(transcript)) if found else {}
    lines = []
    for _, path in found[:AGENT_LIMIT]:
        try:
            closed, model, last_at = agent_facts(path)
            if closed:
                continue
            agent_id = os.path.basename(path)[len("agent-"):-len(".jsonl")]
            stopped_at = stopped.get(agent_id)
            if stopped_at is not None and (last_at is None or stopped_at >= last_at):
                continue
            meta = {}
            try:
                with open(path[: -len(".jsonl")] + ".meta.json", encoding="utf-8") as handle:
                    loaded = json.load(handle)
                    meta = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                pass
            if not model and isinstance(meta.get("model"), str) and meta.get("model") != "inherit":
                model = meta.get("model")
            label = model_name(model) or parent_model
            info = os.stat(path)
            started = getattr(info, "st_birthtime", info.st_ctime)
            minutes = max(0, int((now - started) // 60))
            parts = [str(meta.get("agentType") or "agent")]
            if label:
                parts.append(label)
            if isinstance(meta.get("description"), str) and meta.get("description"):
                parts.append(meta["description"])
            parts.append("%dm" % minutes)
            lines.append("  \u2937 " + " \u00b7 ".join(parts))
        except Exception:
            continue
    return lines


def main():
    line = ""
    agents = []
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        if not isinstance(data, dict):
            data = {}
        line = status_line(data)
        try:
            model = data.get("model") if isinstance(data.get("model"), dict) else {}
            agents = running_agents(data, model.get("display_name") or model_name(model.get("id")))
        except Exception:
            agents = []
        try:
            write_usage(data)
            prune()
        except Exception:
            pass
    except Exception:
        pass
    try:
        sys.stdout.write("\n".join([line] + agents) + "\n")
        sys.stdout.flush()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
