"""P1 — backend serves the built React UI on the same port as the API.

The Dockerfile (stage 3) drops the Vite bundle at `/app/frontend_dist`;
in tests we stand up a temp dir with a fake `index.html` + asset and
override the resolver via the `BIOVOICE_FRONTEND_DIST` env var so the
test exercises the real `_mount_spa` code path.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _make_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        encoding="utf-8",
    )
    (dist / "assets").mkdir()
    (dist / "assets" / "app.js").write_text("/* compiled bundle */", encoding="utf-8")
    return dist


def _build_app_with_dist(dist: Path):
    """Re-import app.main so the static mount picks up the env-var override."""
    import importlib

    import app.main as main_mod

    return importlib.reload(main_mod).app


@pytest.fixture
def app_with_spa(tmp_path, monkeypatch):
    dist = _make_dist(tmp_path)
    monkeypatch.setenv("BIOVOICE_FRONTEND_DIST", str(dist))
    app = _build_app_with_dist(dist)
    yield app


@pytest.fixture
def app_without_spa(monkeypatch, tmp_path):
    # Override to a non-existent path so the resolver returns None.
    monkeypatch.setenv("BIOVOICE_FRONTEND_DIST", str(tmp_path / "nope"))
    import importlib
    import app.main as main_mod

    yield importlib.reload(main_mod).app


def test_root_serves_index_html_when_dist_present(app_with_spa):
    client = TestClient(app_with_spa)
    response = client.get("/", headers={"Accept": "text/html"})
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "<div id='root'></div>" in response.text


def test_unknown_spa_route_falls_back_to_index(app_with_spa):
    """React Router routes (e.g. /profiles) must yield index.html so the
    SPA can take over on the client. Pretty-URL deep links must work."""
    client = TestClient(app_with_spa)
    response = client.get("/profiles", headers={"Accept": "text/html"})
    assert response.status_code == 200
    assert "<div id='root'></div>" in response.text


def test_real_asset_path_serves_the_bundle(app_with_spa):
    client = TestClient(app_with_spa)
    response = client.get("/assets/app.js")
    assert response.status_code == 200
    assert "compiled bundle" in response.text


def test_api_routes_still_win_over_spa_fallback(app_with_spa):
    client = TestClient(app_with_spa)
    response = client.get("/health", headers={"Accept": "application/json"})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_json_request_to_unknown_path_still_404s(app_with_spa):
    """SPA fallback only kicks in for HTML-accepting GETs. A JSON client
    hitting a typo'd endpoint still gets a real 404 — we don't silently
    return HTML."""
    client = TestClient(app_with_spa)
    response = client.get("/api/nonexistent", headers={"Accept": "application/json"})
    assert response.status_code == 404


def test_no_static_mount_when_dist_missing(app_without_spa):
    """Local dev (uvicorn without `pnpm build`) should not serve a SPA —
    just the API surface. `/` should yield a 404 from FastAPI rather
    than an opaque 500 from a missing mount."""
    client = TestClient(app_without_spa)
    response = client.get("/", headers={"Accept": "text/html"})
    # No static mount → no `/` route → 404. The exception handler
    # short-circuit only triggers when a dist exists.
    assert response.status_code == 404
