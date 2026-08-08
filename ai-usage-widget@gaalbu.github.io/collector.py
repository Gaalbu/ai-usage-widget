#!/usr/bin/env python3
"""Fetch Claude Code and Codex limits without exposing credentials."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import selectors
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any

VERSION = "0.1.0"
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_BETA = "oauth-2025-04-20"
CACHE_MAX_AGE_SECONDS = 30 * 60
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_CACHE_BYTES = 256 * 1024


class CollectorError(RuntimeError):
    pass


def _reset_label(timestamp: Any) -> str | None:
    if not timestamp:
        return None
    try:
        if isinstance(timestamp, str):
            parsed = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        else:
            parsed = dt.datetime.fromtimestamp(float(timestamp), tz=dt.timezone.utc)
        local = parsed.astimezone()
        now = dt.datetime.now().astimezone()
        if local.date() == now.date():
            return f"resets today at {local:%H:%M}"
        if local.date() == (now + dt.timedelta(days=1)).date():
            return f"resets tomorrow at {local:%H:%M}"
        return f"resets {local:%a %H:%M}"
    except (TypeError, ValueError, OSError):
        return None


def _window(label: str, used: Any, reset: Any = None) -> dict[str, Any] | None:
    try:
        percent = max(0.0, min(100.0, float(used)))
    except (TypeError, ValueError):
        return None
    return {
        "label": label,
        "usedPercent": percent,
        "resetLabel": _reset_label(reset),
    }


def parse_claude_usage(payload: dict[str, Any]) -> list[dict[str, Any]]:
    labels = {
        "five_hour": "5-hour window",
        "seven_day": "7-day window",
        "seven_day_sonnet": "7-day Sonnet",
        "seven_day_opus": "7-day Opus",
    }
    windows = []
    for key, label in labels.items():
        value = payload.get(key)
        if not isinstance(value, dict):
            continue
        item = _window(
            label,
            value.get("utilization", value.get("used_percentage")),
            value.get("resets_at"),
        )
        if item:
            windows.append(item)
    return windows


def _read_claude_token() -> str:
    config_dir = pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")).expanduser()
    credentials = config_dir / ".credentials.json"
    try:
        payload = json.loads(credentials.read_text(encoding="utf-8"))
        token = payload.get("claudeAiOauth", {}).get("accessToken")
    except (OSError, json.JSONDecodeError) as error:
        raise CollectorError("Claude credentials not found; run `claude auth login`") from error
    if not token:
        raise CollectorError("Claude OAuth login not found; run `claude auth login`")
    return token


def collect_claude(timeout: float = 15) -> dict[str, Any]:
    token = _read_claude_token()
    request = urllib.request.Request(
        CLAUDE_USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": CLAUDE_BETA,
            "User-Agent": f"ai-usage-widget/{VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise CollectorError("Claude usage response was unexpectedly large")
            payload = json.loads(body)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise CollectorError("Claude login expired; open Claude Code to refresh it") from error
        if error.code == 429:
            raise CollectorError("Claude usage is temporarily rate-limited") from error
        raise CollectorError(f"Claude usage request failed (HTTP {error.code})") from error
    except (urllib.error.URLError, TimeoutError, UnicodeError, json.JSONDecodeError) as error:
        raise CollectorError("Claude usage service is unavailable") from error

    windows = parse_claude_usage(payload)
    if not windows:
        raise CollectorError("Claude returned no supported usage windows")
    return {"status": "ok", "windows": windows}


def parse_codex_usage(payload: dict[str, Any]) -> list[dict[str, Any]]:
    buckets = payload.get("rateLimitsByLimitId")
    if not isinstance(buckets, dict) or not buckets:
        fallback = payload.get("rateLimits")
        buckets = {fallback.get("limitId", "codex"): fallback} if isinstance(fallback, dict) else {}

    windows = []
    for bucket_name, bucket in buckets.items():
        if not isinstance(bucket, dict):
            continue
        display_name = bucket.get("limitName") or ("Codex" if bucket_name == "codex" else bucket_name)
        for window_name in ("primary", "secondary"):
            value = bucket.get(window_name)
            if not isinstance(value, dict):
                continue
            duration = value.get("windowDurationMins")
            if duration:
                duration = int(duration)
                if duration % 10080 == 0:
                    period = f"{duration // 10080}-week"
                elif duration % 1440 == 0:
                    period = f"{duration // 1440}-day"
                elif duration % 60 == 0:
                    period = f"{duration // 60}-hour"
                else:
                    period = f"{duration}-minute"
                label = f"{period} window"
            else:
                label = window_name.capitalize()
            if len(buckets) > 1:
                label = f"{display_name} · {label}"
            item = _window(label, value.get("usedPercent"), value.get("resetsAt"))
            if item:
                windows.append(item)
    return windows


def _codex_command() -> str:
    override = os.environ.get("CODEX_BIN")
    if override:
        return override
    command = shutil.which("codex")
    if command:
        return command
    fallback = pathlib.Path("~/.local/bin/codex").expanduser()
    if fallback.is_file():
        return str(fallback)
    raise CollectorError("Codex CLI not found in PATH")


def collect_codex(timeout: float = 15) -> dict[str, Any]:
    messages = [
        {
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "ai_usage_widget",
                    "title": "AI Usage Widget",
                    "version": VERSION,
                }
            },
        },
        {"method": "initialized", "params": {}},
        {"method": "account/rateLimits/read", "id": 2, "params": {}},
    ]
    try:
        process = subprocess.Popen(
            [_codex_command(), "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except OSError as error:
        raise CollectorError("Could not start the Codex app-server") from error

    selector = None
    try:
        assert process.stdin is not None and process.stdout is not None
        for message in messages:
            process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()

        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        response = None
        while time.monotonic() < deadline:
            if not selector.select(timeout=min(0.5, max(0, deadline - time.monotonic()))):
                continue
            line = process.stdout.readline(MAX_RESPONSE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_RESPONSE_BYTES:
                raise CollectorError("Codex usage response was unexpectedly large")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == 2:
                response = message
                break
    finally:
        if selector is not None:
            selector.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    if response is None:
        raise CollectorError("Codex usage request timed out")
    if response.get("error"):
        raise CollectorError("Codex rejected the usage request; run `codex login`")
    windows = parse_codex_usage(response.get("result", {}))
    if not windows:
        raise CollectorError("Codex returned no usage windows")
    return {"status": "ok", "windows": windows}


def collect_all() -> dict[str, Any]:
    cached = _read_cache()
    now = int(time.time())
    providers = {}
    cache_providers = {}
    for name, collector in (("claude", collect_claude), ("codex", collect_codex)):
        previous = _fresh_cached_provider(cached, name, now)
        try:
            current = collector()
            providers[name] = current
            cache_providers[name] = {
                "cachedAt": now,
                "windows": current.get("windows", []),
            }
        except CollectorError as error:
            if previous:
                providers[name] = {
                    "status": "stale",
                    "message": str(error),
                    "windows": previous["windows"],
                }
                cache_providers[name] = previous
            else:
                providers[name] = {"status": "error", "message": str(error), "windows": []}
        except Exception:
            message = f"Unexpected {name.title()} collector error"
            if previous:
                providers[name] = {
                    "status": "stale",
                    "message": message,
                    "windows": previous["windows"],
                }
                cache_providers[name] = previous
            else:
                providers[name] = {"status": "error", "message": message, "windows": []}
    result = {"version": 1, "updatedAt": now, "providers": providers}
    _write_cache({"version": 2, "providers": cache_providers})
    return result


def _fresh_cached_provider(
    cached: dict[str, Any], name: str, now: float
) -> dict[str, Any]:
    providers = cached.get("providers")
    if not isinstance(providers, dict):
        return {}
    previous = providers.get(name)
    if not isinstance(previous, dict):
        return {}
    windows = previous.get("windows")
    if not isinstance(windows, list) or not windows:
        return {}
    try:
        cached_at = float(previous.get("cachedAt", cached.get("updatedAt")))
    except (TypeError, ValueError):
        return {}
    age = now - cached_at
    if age < 0 or age > CACHE_MAX_AGE_SECONDS:
        return {}
    return {"cachedAt": int(cached_at), "windows": windows}


def _cache_path() -> pathlib.Path:
    root = pathlib.Path(os.environ.get("XDG_CACHE_HOME", "~/.cache")).expanduser()
    return root / "ai-usage-widget" / "usage.json"


def _read_cache() -> dict[str, Any]:
    path = _cache_path()
    descriptor = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_CACHE_BYTES:
            return {}
        with os.fdopen(descriptor, encoding="utf-8") as stream:
            descriptor = None
            payload = json.load(stream)
        return payload if isinstance(payload, dict) else {}
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        return {}
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _write_cache(payload: dict[str, Any]) -> None:
    path = _cache_path()
    temporary = None
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent_metadata = path.parent.lstat()
        if not stat.S_ISDIR(parent_metadata.st_mode):
            return
        if stat.S_IMODE(parent_metadata.st_mode) & 0o077:
            path.parent.chmod(0o700)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=path.parent, prefix=".usage.", suffix=".tmp"
        )
        temporary = pathlib.Path(temporary_name)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    except OSError:
        # Caching is best-effort; a read-only home must not break live usage.
        pass
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")
    args = parser.parse_args()
    print(json.dumps(collect_all(), indent=2 if args.pretty else None, separators=None if args.pretty else (",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
