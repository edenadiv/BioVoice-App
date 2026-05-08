"""Simple in-memory persistence for tests."""

from __future__ import annotations

from app.models import ReferenceSampleRecord, SessionRecord, SpeakerRecord, VerificationRecord


class MemoryStore:
    def __init__(self):
        self._speakers: dict[str, SpeakerRecord] = {}
        self._results: list[VerificationRecord] = []
        self._reference_samples: list[ReferenceSampleRecord] = []
        self._sessions: dict[str, SessionRecord] = {}

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

    def put_session(self, record: SessionRecord) -> None:
        self._sessions[record.session_token] = record

    def get_session(self, session_token: str) -> SessionRecord | None:
        return self._sessions.get(session_token)

    def delete_session(self, session_token: str) -> None:
        self._sessions.pop(session_token, None)

