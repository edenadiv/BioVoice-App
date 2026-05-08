"""F7.2 — structured logging setup.

Emits one JSON line per log event. Common fields: `ts`, `level`,
`logger`, `event`, plus any `extra={...}` keys the call site passed.
Configures the root logger so every existing `logging.getLogger(...)`
call automatically inherits the JSON format — no per-module changes
required.

Why hand-rolled instead of `structlog`: keeps the dependency surface
small (json + logging are stdlib) and the format predictable. If we
later need bound loggers / context propagation, the migration to
structlog is a one-file change.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    """One JSON object per record. Extra fields propagate via the LogRecord
    `__dict__` (set via `logger.info(..., extra={...})`)."""

    DEFAULT_KEYS = {
        "name", "msg", "args", "levelname", "levelno", "pathname",
        "filename", "module", "exc_info", "exc_text", "stack_info",
        "lineno", "funcName", "created", "msecs", "relativeCreated",
        "thread", "threadName", "processName", "process", "message",
        "taskName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        # Surface any custom keys the caller stashed via `extra={...}`.
        for key, value in record.__dict__.items():
            if key in self.DEFAULT_KEYS or key.startswith("_"):
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    """Configure the root logger once at process start. Safe to call
    multiple times — clears existing handlers first.

    Set `BIOVOICE_LOG_FORMAT=plain` for human-readable output during
    local dev. Anything else (or unset) → JSON.
    """
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    fmt = os.environ.get("BIOVOICE_LOG_FORMAT", "json").lower()

    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(stream=sys.stdout)
    if fmt == "plain":
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    else:
        handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)
