"""F6.2 — thin wrapper around the audit-log storage methods.

Routes call `AuditService.record(...)` rather than poking the store
directly so we can add cross-cutting behaviour (structured logging in
F7.2, alerting in F7.3) without touching every call site.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol


class AuditStore(Protocol):
    def add_audit_event(
        self,
        *,
        action: str,
        actor: str | None = None,
        ip: str | None = None,
        target: str | None = None,
        metadata: dict | None = None,
        when: datetime | None = None,
    ) -> int: ...

    def list_audit_events(
        self,
        *,
        since: datetime | None = None,
        limit: int = 200,
    ) -> list[dict]: ...


class AuditService:
    def __init__(self, store: AuditStore):
        self.store = store

    def record(
        self,
        action: str,
        *,
        actor: str | None = None,
        ip: str | None = None,
        target: str | None = None,
        metadata: dict | None = None,
    ) -> int:
        return self.store.add_audit_event(
            action=action,
            actor=actor,
            ip=ip,
            target=target,
            metadata=metadata,
            when=datetime.now(timezone.utc),
        )

    def recent(self, *, since: datetime | None = None, limit: int = 200) -> list[dict]:
        return self.store.list_audit_events(since=since, limit=limit)
