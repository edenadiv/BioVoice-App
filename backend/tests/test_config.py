"""Tests for runtime settings (E2.2 + future config tweaks)."""

from __future__ import annotations

import importlib
import os
from pathlib import Path

import pytest


@pytest.fixture
def reset_config(monkeypatch):
    """Re-import config after env mutation so the module-level Settings()
    picks up the new env vars. Restores the import cache on teardown."""
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    yield monkeypatch
    monkeypatch.delenv("CORS_ORIGINS", raising=False)


def _fresh_settings():
    from app.core import config as config_mod

    importlib.reload(config_mod)
    return config_mod.Settings()


def test_cors_origins_default_when_env_unset(reset_config):
    settings = _fresh_settings()
    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_origins_single_value_from_env(reset_config):
    reset_config.setenv("CORS_ORIGINS", "http://10.0.0.10:5173")
    settings = _fresh_settings()
    assert settings.cors_origins == ["http://10.0.0.10:5173"]


def test_cors_origins_multiple_values_from_env(reset_config):
    reset_config.setenv("CORS_ORIGINS", "http://localhost:5173, http://10.0.0.10:5173,https://demo.biovoice.app")
    settings = _fresh_settings()
    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://10.0.0.10:5173",
        "https://demo.biovoice.app",
    ]


def test_cors_origins_empty_env_falls_back_to_default(reset_config):
    reset_config.setenv("CORS_ORIGINS", "   ")
    settings = _fresh_settings()
    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_origins_only_commas_falls_back_to_default(reset_config):
    reset_config.setenv("CORS_ORIGINS", " , , ")
    settings = _fresh_settings()
    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_origins_flow_into_fastapi_middleware(reset_config):
    reset_config.setenv("CORS_ORIGINS", "http://10.0.0.10:5173,http://localhost:5173")
    # Re-import everything that reads `settings` so the override propagates.
    from app.core import config as config_mod
    importlib.reload(config_mod)

    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config_mod.settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # The middleware itself stores the origins; verify via the middleware stack.
    cors_layer = next(
        (m for m in app.user_middleware if m.cls is CORSMiddleware),
        None,
    )
    assert cors_layer is not None
    assert "http://10.0.0.10:5173" in cors_layer.kwargs["allow_origins"]
    assert "http://localhost:5173" in cors_layer.kwargs["allow_origins"]


def test_load_env_file_populates_missing_keys_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from app.core import config as config_mod

    env_file = tmp_path / ".env"
    env_file.write_text(
        "ENABLE_ECAPA_COMPARISON=1\n"
        "ENABLE_WESPEAKER_COMPARISON=1\n"
        "CORS_ORIGINS=http://127.0.0.1:5173\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("ENABLE_ECAPA_COMPARISON", raising=False)
    monkeypatch.setenv("ENABLE_WESPEAKER_COMPARISON", "0")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)

    config_mod._load_env_file(env_file)

    assert os.environ["ENABLE_ECAPA_COMPARISON"] == "1"
    assert os.environ["ENABLE_WESPEAKER_COMPARISON"] == "0"
    assert os.environ["CORS_ORIGINS"] == "http://127.0.0.1:5173"
