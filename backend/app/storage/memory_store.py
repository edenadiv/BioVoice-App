"""Simple in-memory persistence for the first web prototype."""

from __future__ import annotations

from dataclasses import replace

from app.models import SpeakerRecord, VerificationRecord


class MemoryStore:
    def __init__(self):
        self._speakers: dict[str, SpeakerRecord] = {}
        self._results: list[VerificationRecord] = []

    def put_speaker(self, record: SpeakerRecord) -> None:
        self._speakers[record.user_id] = record

    def get_speaker(self, user_id: str) -> SpeakerRecord | None:
        return self._speakers.get(user_id)

    def list_users(self) -> list[SpeakerRecord]:
        return sorted(self._speakers.values(), key=lambda item: item.user_id.lower())

    def add_result(self, record: VerificationRecord) -> None:
        self._results.append(record)

    def list_results(self) -> list[VerificationRecord]:
        return list(self._results)

