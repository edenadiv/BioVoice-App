"""SQLite-backed persistence for speakers and verification results."""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import sqlite3
from threading import Lock
from uuid import uuid4

from app.models import ReferenceSampleRecord, SessionRecord, SpeakerRecord, VerificationRecord


class SQLiteStore:
    def __init__(self, database_path: Path, reference_samples_path: Path):
        self.database_path = Path(database_path)
        self.reference_samples_path = Path(reference_samples_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.reference_samples_path.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._connection = sqlite3.connect(self.database_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    embedding_json TEXT NOT NULL,
                    sample_embeddings_json TEXT NOT NULL DEFAULT '[]',
                    enrolled_at TEXT NOT NULL,
                    sample_count INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS verification_results (
                    result_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    decision TEXT NOT NULL,
                    similarity_score REAL NOT NULL,
                    deepfake_score REAL NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    metadata_json TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(user_id)
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
                    last_seen_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
                    FOREIGN KEY (user_id) REFERENCES users(user_id)
                );

                CREATE TABLE IF NOT EXISTS reference_samples (
                    sample_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(user_id)
                );

                -- F2.3 — daily monotonic counter for session-id (VRF-YYYYMMDD-NNNNN).
                CREATE TABLE IF NOT EXISTS verification_seq (
                    day TEXT PRIMARY KEY,
                    last_value INTEGER NOT NULL DEFAULT 0
                );
                """
            )
        self._ensure_user_columns()
        self._backfill_sample_embeddings()
        self._ensure_session_columns()

    def _ensure_session_columns(self) -> None:
        """F2.1 — bring legacy `sessions` rows up to the new schema by adding
        `expires_at` and `last_seen_at` columns when missing. Old rows get
        epoch defaults; AuthService treats those as expired and forces the
        client to log in again."""
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(sessions)").fetchall()
        }
        with self._connection:
            if "expires_at" not in columns:
                self._connection.execute(
                    "ALTER TABLE sessions ADD COLUMN expires_at TEXT NOT NULL "
                    "DEFAULT '1970-01-01T00:00:00+00:00'"
                )
            if "last_seen_at" not in columns:
                self._connection.execute(
                    "ALTER TABLE sessions ADD COLUMN last_seen_at TEXT NOT NULL "
                    "DEFAULT '1970-01-01T00:00:00+00:00'"
                )

    def _ensure_user_columns(self) -> None:
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(users)").fetchall()
        }
        if "sample_embeddings_json" not in columns:
            with self._connection:
                self._connection.execute(
                    "ALTER TABLE users ADD COLUMN sample_embeddings_json TEXT NOT NULL DEFAULT '[]'"
                )

    def _backfill_sample_embeddings(self) -> None:
        rows = self._connection.execute(
            """
            SELECT user_id, embedding_json, sample_embeddings_json
            FROM users
            """
        ).fetchall()
        updates: list[tuple[str, str]] = []
        for row in rows:
            if row["sample_embeddings_json"] and row["sample_embeddings_json"] != "[]":
                continue
            updates.append((json.dumps([json.loads(row["embedding_json"])]), row["user_id"]))

        if not updates:
            return

        with self._lock, self._connection:
            self._connection.executemany(
                """
                UPDATE users
                SET sample_embeddings_json = ?
                WHERE user_id = ?
                """,
                updates,
            )

    def put_speaker(self, record: SpeakerRecord) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO users (
                    user_id,
                    embedding_json,
                    sample_embeddings_json,
                    enrolled_at,
                    sample_count
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    embedding_json = excluded.embedding_json,
                    sample_embeddings_json = excluded.sample_embeddings_json,
                    enrolled_at = excluded.enrolled_at,
                    sample_count = excluded.sample_count
                """,
                (
                    record.user_id,
                    json.dumps(record.embedding),
                    json.dumps(record.sample_embeddings),
                    record.enrolled_at.isoformat(),
                    record.sample_count,
                ),
            )

    def get_speaker(self, user_id: str) -> SpeakerRecord | None:
        cursor = self._connection.execute(
            """
            SELECT user_id, embedding_json, sample_embeddings_json, enrolled_at, sample_count
            FROM users
            WHERE user_id = ?
            """,
            (user_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return SpeakerRecord(
            user_id=row["user_id"],
            embedding=json.loads(row["embedding_json"]),
            sample_embeddings=json.loads(row["sample_embeddings_json"]),
            enrolled_at=datetime.fromisoformat(row["enrolled_at"]),
            sample_count=int(row["sample_count"]),
        )

    def list_users(self) -> list[SpeakerRecord]:
        cursor = self._connection.execute(
            """
            SELECT user_id, embedding_json, sample_embeddings_json, enrolled_at, sample_count
            FROM users
            ORDER BY lower(user_id) ASC
            """
        )
        return [
            SpeakerRecord(
                user_id=row["user_id"],
                embedding=json.loads(row["embedding_json"]),
                sample_embeddings=json.loads(row["sample_embeddings_json"]),
                enrolled_at=datetime.fromisoformat(row["enrolled_at"]),
                sample_count=int(row["sample_count"]),
            )
            for row in cursor.fetchall()
        ]

    def save_reference_sample(
        self,
        user_id: str,
        audio_bytes: bytes,
        original_filename: str,
        source: str,
    ) -> ReferenceSampleRecord:
        sample_id = str(uuid4())
        suffix = Path(original_filename).suffix or ".wav"
        user_directory = self.reference_samples_path / user_id
        user_directory.mkdir(parents=True, exist_ok=True)
        file_path = user_directory / f"{sample_id}{suffix}"
        file_path.write_bytes(audio_bytes)
        record = ReferenceSampleRecord(
            sample_id=sample_id,
            user_id=user_id,
            file_path=str(file_path),
            original_filename=original_filename,
            source=source,
        )
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO reference_samples (
                    sample_id,
                    user_id,
                    file_path,
                    original_filename,
                    source,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    record.sample_id,
                    record.user_id,
                    record.file_path,
                    record.original_filename,
                    record.source,
                    record.created_at.isoformat(),
                ),
            )
        return record

    def list_reference_samples(self, user_id: str) -> list[ReferenceSampleRecord]:
        cursor = self._connection.execute(
            """
            SELECT sample_id, user_id, file_path, original_filename, source, created_at
            FROM reference_samples
            WHERE user_id = ?
            ORDER BY created_at DESC
            """,
            (user_id,),
        )
        return [
            ReferenceSampleRecord(
                sample_id=row["sample_id"],
                user_id=row["user_id"],
                file_path=row["file_path"],
                original_filename=row["original_filename"],
                source=row["source"],
                created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in cursor.fetchall()
        ]

    def get_reference_sample(self, user_id: str, sample_id: str) -> ReferenceSampleRecord | None:
        cursor = self._connection.execute(
            """
            SELECT sample_id, user_id, file_path, original_filename, source, created_at
            FROM reference_samples
            WHERE user_id = ? AND sample_id = ?
            """,
            (user_id, sample_id),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return ReferenceSampleRecord(
            sample_id=row["sample_id"],
            user_id=row["user_id"],
            file_path=row["file_path"],
            original_filename=row["original_filename"],
            source=row["source"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    def next_verification_seq(self, day: str) -> int:
        """Atomic per-day monotonic counter for session-ids (F2.3).

        Uses SQLite's INSERT … ON CONFLICT … DO UPDATE … RETURNING to bump
        the row in a single statement, holding the connection lock so
        concurrent verifications don't race.
        """
        with self._lock, self._connection:
            row = self._connection.execute(
                """
                INSERT INTO verification_seq (day, last_value)
                VALUES (?, 1)
                ON CONFLICT(day) DO UPDATE SET last_value = last_value + 1
                RETURNING last_value
                """,
                (day,),
            ).fetchone()
        return int(row["last_value"])

    def add_result(self, record: VerificationRecord) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO verification_results (
                    result_id,
                    user_id,
                    decision,
                    similarity_score,
                    deepfake_score,
                    message,
                    created_at,
                    metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.result_id,
                    record.user_id,
                    record.decision,
                    record.similarity_score,
                    record.deepfake_score,
                    record.message,
                    record.created_at.isoformat(),
                    json.dumps(record.metadata or {}),
                ),
            )

    def get_result(self, result_id: str) -> VerificationRecord | None:
        row = self._connection.execute(
            """
            SELECT
                result_id,
                user_id,
                decision,
                similarity_score,
                deepfake_score,
                message,
                created_at,
                metadata_json
            FROM verification_results
            WHERE result_id = ?
            """,
            (result_id,),
        ).fetchone()
        if row is None:
            return None
        return VerificationRecord(
            result_id=row["result_id"],
            user_id=row["user_id"],
            decision=row["decision"],
            similarity_score=float(row["similarity_score"]),
            deepfake_score=float(row["deepfake_score"]),
            message=row["message"],
            created_at=datetime.fromisoformat(row["created_at"]),
            metadata=json.loads(row["metadata_json"]) if row["metadata_json"] else {},
        )

    def list_results(self) -> list[VerificationRecord]:
        cursor = self._connection.execute(
            """
            SELECT
                result_id,
                user_id,
                decision,
                similarity_score,
                deepfake_score,
                message,
                created_at,
                metadata_json
            FROM verification_results
            ORDER BY created_at DESC
            """
        )
        return [
            VerificationRecord(
                result_id=row["result_id"],
                user_id=row["user_id"],
                decision=row["decision"],
                similarity_score=float(row["similarity_score"]),
                deepfake_score=float(row["deepfake_score"]),
                message=row["message"],
                created_at=datetime.fromisoformat(row["created_at"]),
                metadata=json.loads(row["metadata_json"]) if row["metadata_json"] else {},
            )
            for row in cursor.fetchall()
        ]

    def put_session(self, record: SessionRecord) -> None:
        # F2.1 — UPSERT semantics. AuthService.get_session bumps last_seen_at
        # + expires_at on every authenticated request and re-puts; refresh
        # rotates the token (insert new + delete old) so primary-key conflict
        # only happens if the same token is re-stored, which is the bump path.
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO sessions (session_token, user_id, created_at, expires_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_token) DO UPDATE SET
                    expires_at = excluded.expires_at,
                    last_seen_at = excluded.last_seen_at
                """,
                (
                    record.session_token,
                    record.user_id,
                    record.created_at.isoformat(),
                    record.expires_at.isoformat(),
                    record.last_seen_at.isoformat(),
                ),
            )

    def get_session(self, session_token: str) -> SessionRecord | None:
        cursor = self._connection.execute(
            """
            SELECT session_token, user_id, created_at, expires_at, last_seen_at
            FROM sessions
            WHERE session_token = ?
            """,
            (session_token,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return SessionRecord(
            session_token=row["session_token"],
            user_id=row["user_id"],
            created_at=datetime.fromisoformat(row["created_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
            last_seen_at=datetime.fromisoformat(row["last_seen_at"]),
        )

    def delete_session(self, session_token: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM sessions WHERE session_token = ?",
                (session_token,),
            )
