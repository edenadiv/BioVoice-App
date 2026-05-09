"""DELETE /users/{user_id} — public soft-delete (Phase B replacement
for the cookie-gated admin route)."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes
from app.models import SpeakerRecord
from app.storage.memory_store import MemoryStore


@dataclass
class _StubContainer:
    """Minimum surface the DELETE /users/{id} route reads —
    `container.store.soft_delete_speaker(user_id, ...)`."""

    store: MemoryStore


def _build_app() -> tuple[TestClient, MemoryStore]:
    store = MemoryStore()
    app = FastAPI()
    app.state.container = _StubContainer(store=store)
    app.include_router(routes.router)
    return TestClient(app, base_url="https://testserver"), store


def _enrol(store: MemoryStore, user_id: str) -> None:
    """Drop a SpeakerRecord into the store so the test can target a
    real existing user without spinning up the full VerificationService."""
    embedding = [0.1] * 192
    store.put_speaker(
        SpeakerRecord(
            user_id=user_id,
            embedding=embedding,
            sample_embeddings=[embedding, embedding, embedding],
            sample_count=3,
        )
    )


def test_delete_user_returns_204_on_success():
    client, store = _build_app()
    _enrol(store, "alice")
    assert store.get_speaker("alice") is not None

    resp = client.delete("/users/alice")
    assert resp.status_code == 204
    assert resp.content == b""
    assert store.get_speaker("alice") is None


def test_delete_user_returns_404_for_unknown_id():
    client, _ = _build_app()
    resp = client.delete("/users/ghost")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_delete_user_is_idempotent_after_first_deletion():
    """Second DELETE on a now-removed user returns 404 cleanly — no
    500, no crash, no partial state."""
    client, store = _build_app()
    _enrol(store, "bob")

    first = client.delete("/users/bob")
    assert first.status_code == 204

    second = client.delete("/users/bob")
    assert second.status_code == 404


def test_delete_user_does_not_require_authentication():
    """No cookie, no admin header — operator just sends DELETE."""
    client, store = _build_app()
    _enrol(store, "carol")
    resp = client.delete("/users/carol")  # no auth headers, no cookies
    assert resp.status_code == 204


def test_delete_user_moves_row_to_deleted_users_table():
    """Soft delete contract: the user row should be queryable from
    the deleted_users table after deletion (audit trail)."""
    client, store = _build_app()
    _enrol(store, "dave")

    client.delete("/users/dave")
    deleted = store.list_deleted_users()
    assert any(d["user_id"] == "dave" for d in deleted)
    assert all(d["deleted_by"] == "operator" for d in deleted if d["user_id"] == "dave")
