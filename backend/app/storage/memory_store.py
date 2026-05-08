"""Simple in-memory persistence for tests."""

from __future__ import annotations

from datetime import datetime

from app.models import ReferenceSampleRecord, SessionRecord, SpeakerRecord, VerificationRecord


class MemoryStore:
    def __init__(self):
        self._speakers: dict[str, SpeakerRecord] = {}
        self._results: list[VerificationRecord] = []
        self._reference_samples: list[ReferenceSampleRecord] = []
        self._verification_seq: dict[str, int] = {}
        self._sessions: dict[str, SessionRecord] = {}
        # F2.2 — login rate-limit state
        self._login_failures: list[tuple[str, str, datetime]] = []  # (user_id, ip, when)
        self._login_lockouts: dict[tuple[str, str], datetime] = {}
        # F6.1 / F6.2 — admin surface
        self._deleted_users: list[dict] = []
        self._audit_log: list[dict] = []
        self._next_audit_id: int = 1

    def put_speaker(self, record: SpeakerRecord) -> None:
        self._speakers[record.user_id] = record

    def get_speaker(self, user_id: str) -> SpeakerRecord | None:
        return self._speakers.get(user_id)

    def list_users(self) -> list[SpeakerRecord]:
        return sorted(self._speakers.values(), key=lambda item: item.user_id.lower())

    def save_reference_sample(
        self,
        user_id: str,
        audio_bytes: bytes,
        original_filename: str,
        source: str,
    ) -> ReferenceSampleRecord:
        record = ReferenceSampleRecord(
            sample_id=f"ref-{len(self._reference_samples) + 1}",
            user_id=user_id,
            file_path=f"memory://{user_id}/{original_filename}",
            original_filename=original_filename,
            source=source,
        )
        self._reference_samples.append(record)
        return record

    def list_reference_samples(self, user_id: str) -> list[ReferenceSampleRecord]:
        return [r for r in self._reference_samples if r.user_id == user_id]

    def add_result(self, record: VerificationRecord) -> None:
        self._results.append(record)

    def list_results(self) -> list[VerificationRecord]:
        return list(self._results)

    def get_result(self, result_id: str) -> VerificationRecord | None:
        for record in self._results:
            if record.result_id == result_id:
                return record
        return None

    def next_verification_seq(self, day: str) -> int:
        # F2.3 — daily monotonic counter for session-ids.
        next_value = self._verification_seq.get(day, 0) + 1
        self._verification_seq[day] = next_value
        return next_value

    def put_session(self, record: SessionRecord) -> None:
        # F2.1 — UPSERT semantics. AuthService refreshes existing rows by
        # re-putting under the same token; rotated tokens insert a new row +
        # explicitly delete the old one.
        self._sessions[record.session_token] = record

    def get_session(self, session_token: str) -> SessionRecord | None:
        return self._sessions.get(session_token)

    def delete_session(self, session_token: str) -> None:
        self._sessions.pop(session_token, None)

    # F2.2 — login rate-limit state -----------------------------------------

    def record_login_failure(self, user_id: str, ip: str, when: datetime) -> None:
        self._login_failures.append((user_id, ip, when))

    def count_recent_login_failures(
        self, user_id: str, ip: str, since: datetime
    ) -> int:
        return sum(
            1
            for u, i, t in self._login_failures
            if u == user_id and i == ip and t >= since
        )

    def set_login_lockout(
        self, user_id: str, ip: str, locked_until: datetime
    ) -> None:
        self._login_lockouts[(user_id, ip)] = locked_until

    def get_login_lockout(self, user_id: str, ip: str) -> datetime | None:
        return self._login_lockouts.get((user_id, ip))

    def clear_login_state(self, user_id: str, ip: str) -> None:
        self._login_failures = [
            (u, i, t) for u, i, t in self._login_failures
            if not (u == user_id and i == ip)
        ]
        self._login_lockouts.pop((user_id, ip), None)

    # F6.1 — soft-delete -----------------------------------------------------

    def soft_delete_speaker(self, user_id: str, *, deleted_by: str | None, deleted_at: datetime) -> bool:
        record = self._speakers.pop(user_id, None)
        if record is None:
            return False
        self._deleted_users.append(
            {
                "user_id": user_id,
                "enrolled_at": record.enrolled_at.isoformat(),
                "deleted_at": deleted_at.isoformat(),
                "deleted_by": deleted_by,
            }
        )
        # Clear any active sessions for the deleted user.
        self._sessions = {
            token: sess for token, sess in self._sessions.items() if sess.user_id != user_id
        }
        return True

    def list_deleted_users(self) -> list[dict]:
        return list(reversed(self._deleted_users))

    # F6.2 — audit log -------------------------------------------------------

    def add_audit_event(
        self,
        *,
        action: str,
        actor: str | None = None,
        ip: str | None = None,
        target: str | None = None,
        metadata: dict | None = None,
        when: datetime | None = None,
    ) -> int:
        from datetime import datetime as _dt
        from datetime import timezone as _tz

        ts = (when or _dt.now(_tz.utc)).isoformat()
        event_id = self._next_audit_id
        self._next_audit_id += 1
        self._audit_log.append(
            {
                "event_id": event_id,
                "occurred_at": ts,
                "actor": actor,
                "ip": ip,
                "action": action,
                "target": target,
                "metadata": metadata,
            }
        )
        return event_id

    def list_audit_events(
        self,
        *,
        since: datetime | None = None,
        limit: int = 200,
    ) -> list[dict]:
        events = list(reversed(self._audit_log))
        if since is not None:
            since_iso = since.isoformat()
            events = [e for e in events if e["occurred_at"] >= since_iso]
        return events[:limit]

