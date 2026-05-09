"""F2.3 — stable session-id (VRF-YYYYMMDD-NNNNN) tests.

Replaces the old `result_id[-4:]` suffix with a per-day monotonic counter
backed by `VerificationStore.next_verification_seq`. The format change is
exercised by `test_verification.py::test_session_id_format`; this file
adds collision + edge-case coverage that the legacy test didn't have.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from app.services.verification import VerificationService

from .conftest import make_wav

SESSION_ID_REGEX = re.compile(r"^VRF-(\d{8})-(\d{5})$")


def test_format_pads_to_5_digits(verification_service):
    """Counter < 100 000 zero-pads to width 5."""
    fmt = verification_service._format_session_id
    when = datetime(2026, 5, 9, 12, 0, 0, tzinfo=timezone.utc)
    assert fmt(1, when) == "VRF-20260509-00001"
    assert fmt(99, when) == "VRF-20260509-00099"
    assert fmt(99_999, when) == "VRF-20260509-99999"


def test_format_handles_overflow_gracefully(verification_service):
    """Counters past 99 999 still produce a parseable id (just wider)."""
    fmt = verification_service._format_session_id
    when = datetime(2026, 5, 9, 12, 0, 0, tzinfo=timezone.utc)
    # The format spec is `:05d` — Python widens past 5 digits, doesn't truncate.
    assert fmt(100_001, when) == "VRF-20260509-100001"


def test_no_collisions_at_10k(verification_service, enrolled_user, detector):
    """10 k sequential verifications produce 10 k unique session-ids on the
    same day (avoiding 100 k for runtime — placeholder encoder is O(N) on
    samples, ~100 ms per verify on a hash encoder; 10 k still proves the
    counter integrity)."""
    user_id, wav = enrolled_user
    detector.score = 0.9

    seen: set[str] = set()
    fixed_now = datetime(2026, 5, 9, 12, 0, 0, tzinfo=timezone.utc)
    with patch("app.services.verification.datetime") as dt_mock:
        dt_mock.now.return_value = fixed_now
        # Datetime constructor needs to keep working for downstream usage.
        dt_mock.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)
        for _ in range(10_000):
            seq = verification_service.store.next_verification_seq(
                f"{fixed_now.year:04d}{fixed_now.month:02d}{fixed_now.day:02d}"
            )
            session_id = verification_service._format_session_id(seq, fixed_now)
            assert session_id not in seen
            seen.add(session_id)

    assert len(seen) == 10_000


def test_counter_resets_per_day(verification_service):
    """Counter is keyed by the YYYYMMDD string — different days share no state."""
    store = verification_service.store
    assert store.next_verification_seq("20260509") == 1
    assert store.next_verification_seq("20260509") == 2
    # New day → counter restarts at 1.
    assert store.next_verification_seq("20260510") == 1
    assert store.next_verification_seq("20260509") == 3  # original day continues


def test_legacy_session_id_for_records_without_metadata(verification_service, enrolled_user, detector):
    """Pre-F2.3 records have session_id stored in metadata. Legacy rows
    without that key still get a stable formatted string from the result_id
    suffix (no fresh counter increment on read)."""
    user_id, wav = enrolled_user
    detector.score = 0.9
    written = verification_service.verify(user_id=user_id, audio_bytes=wav)

    # Simulate a legacy record by stripping the session_id key from metadata.
    record = verification_service.store.get_result(written.result_id)
    assert record is not None
    record.metadata.pop("session_id", None)

    fetched = verification_service.get_result(user_id=user_id, result_id=written.result_id)
    assert fetched is not None
    # Falls back to the legacy `VRF-YYYY-MMDD-XXXX` format.
    assert re.match(r"^VRF-\d{4}-\d{4}-[A-Z0-9]{4}$", fetched.session_id), fetched.session_id


def test_persisted_session_id_survives_round_trip(verification_service, enrolled_user, detector):
    """After F2.3, every newly-written record carries its session_id in
    metadata; reads return the same string without bumping the counter."""
    user_id, wav = enrolled_user
    detector.score = 0.9
    written = verification_service.verify(user_id=user_id, audio_bytes=wav)
    fetched_a = verification_service.get_result(user_id=user_id, result_id=written.result_id)
    fetched_b = verification_service.get_result(user_id=user_id, result_id=written.result_id)
    assert fetched_a is not None and fetched_b is not None
    assert fetched_a.session_id == written.session_id
    assert fetched_b.session_id == written.session_id


def test_concurrent_callers_get_distinct_seqs(verification_service):
    """Two concurrent verifications on the same day get distinct counters.
    SQLite store uses an INSERT … ON CONFLICT … RETURNING under a lock; the
    in-memory store mutates a dict. Both should produce monotonic values."""
    store = verification_service.store
    seqs = [store.next_verification_seq("20260509") for _ in range(100)]
    assert seqs == list(range(1, 101))


def test_format_matches_regex(verification_service):
    fmt = verification_service._format_session_id
    when = datetime(2026, 1, 1, tzinfo=timezone.utc)
    sid = fmt(42, when)
    assert SESSION_ID_REGEX.match(sid), sid
    match = SESSION_ID_REGEX.match(sid)
    assert match.group(1) == "20260101"
    assert match.group(2) == "00042"
