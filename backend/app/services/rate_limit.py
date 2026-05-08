"""F2.2 — login rate-limiting service.

Enforces "N failed attempts in M seconds → lockout for K seconds" against
`/auth/login`. Keyed by (user_id, source IP) so a misbehaving client can't
lock out other users on the same network and a single bad actor on shared
infrastructure can't lock out the whole organisation.

Persisted via the `LoginRateLimitStore` Protocol (SQLite in production,
in-memory dict in tests). Rolling counts are pruned on the fly when checked
so the table doesn't grow without bound.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol


class LoginRateLimited(PermissionError):
    """Raised when (user_id, ip) is locked out. Carries the wait time in
    seconds so the route can set HTTP `Retry-After`."""

    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__(
            f"Too many failed login attempts. Try again in {retry_after_seconds} seconds."
        )
        self.retry_after_seconds = retry_after_seconds


class LoginRateLimitStore(Protocol):
    def record_login_failure(self, user_id: str, ip: str, when: datetime) -> None: ...

    def count_recent_login_failures(
        self, user_id: str, ip: str, since: datetime
    ) -> int: ...

    def set_login_lockout(
        self, user_id: str, ip: str, locked_until: datetime
    ) -> None: ...

    def get_login_lockout(self, user_id: str, ip: str) -> datetime | None: ...

    def clear_login_state(self, user_id: str, ip: str) -> None: ...


@dataclass(slots=True)
class RateLimitConfig:
    window_seconds: int
    max_attempts: int
    lockout_seconds: int


class LoginRateLimiter:
    """Counts failures and enforces lockouts. Stateless beyond the store."""

    def __init__(self, store: LoginRateLimitStore, config: RateLimitConfig) -> None:
        self.store = store
        self.config = config

    def check(self, user_id: str, ip: str, now: datetime | None = None) -> None:
        """Raise `LoginRateLimited` if the (user_id, ip) pair is currently
        locked out. Should be called BEFORE the expensive `verify` call so
        brute-force attempts pay no model cost."""
        now = now or datetime.now(timezone.utc)
        locked_until = self.store.get_login_lockout(user_id, ip)
        if locked_until is None:
            return
        if now < locked_until:
            wait = max(1, int((locked_until - now).total_seconds()))
            raise LoginRateLimited(wait)
        # Lockout has elapsed; clear state so a fresh attempt is unencumbered.
        self.store.clear_login_state(user_id, ip)

    def record_failure(
        self, user_id: str, ip: str, now: datetime | None = None
    ) -> None:
        """Record a failed attempt. If this tips the (user_id, ip) over the
        budget, set a lockout deadline."""
        now = now or datetime.now(timezone.utc)
        self.store.record_login_failure(user_id, ip, now)
        since = now - timedelta(seconds=self.config.window_seconds)
        recent = self.store.count_recent_login_failures(user_id, ip, since)
        if recent >= self.config.max_attempts:
            locked_until = now + timedelta(seconds=self.config.lockout_seconds)
            self.store.set_login_lockout(user_id, ip, locked_until)

    def record_success(self, user_id: str, ip: str) -> None:
        """Successful login → reset state for this pair so legitimate users
        don't carry stale failure counts forward."""
        self.store.clear_login_state(user_id, ip)
