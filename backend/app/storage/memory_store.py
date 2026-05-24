"""Simple in-memory persistence for tests."""

from __future__ import annotations

from datetime import datetime

from app.models import ReferenceSampleRecord, SpeakerRecord, VerificationRecord


class MemoryStore:
    def __init__(self):
        self._speakers: dict[str, SpeakerRecord] = {}
        self._results: list[VerificationRecord] = []
        self._reference_samples: list[ReferenceSampleRecord] = []
        self._verification_seq: dict[str, int] = {}
        # Soft-deleted profiles (op-driven, surfaced via DELETE /users/{id})
        self._deleted_users: list[dict] = []

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
            audio_bytes=audio_bytes,
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

    # Profile soft-delete (backs DELETE /users/{user_id}) ------------------

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
        return True

    def list_deleted_users(self) -> list[dict]:
        return list(reversed(self._deleted_users))
