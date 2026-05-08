"""FastAPI application entrypoint for the BioVoice web backend."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.container import build_container
from app.core.config import settings
from app.core.logging_setup import configure_logging

# F7.2 — set up structured (JSON) logging before any module-level
# logger.getLogger() side effects fire. Honour BIOVOICE_LOG_FORMAT=plain
# for human-readable local dev.
configure_logging()

logger = logging.getLogger(__name__)


def _maybe_seed_demo(container) -> None:
    """If BIOVOICE_SEED_DEMO=1 and the store is empty, enrol bundled demo users.

    Idempotent at the seed-script level — safe to call on every boot. The
    env-var gate keeps real deployments honest (no surprise mock data in prod).
    """
    if os.environ.get("BIOVOICE_SEED_DEMO") != "1":
        return
    service = container.verification_service
    if service.list_users():
        logger.info("seed_demo: store is non-empty, skipping")
        return
    try:
        from backend.scripts.seed_demo import seed_demo_users  # type: ignore
    except ImportError:
        # Fallback when the package is installed without the scripts/ dir on
        # sys.path — import via runtime path manipulation.
        import importlib.util
        from pathlib import Path

        seed_path = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
        spec = importlib.util.spec_from_file_location("seed_demo_runtime", seed_path)
        if spec is None or spec.loader is None:
            logger.warning("seed_demo: cannot locate seed_demo.py at %s", seed_path)
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.seed_demo_users(service)
        return
    seed_demo_users(service)


def create_app() -> FastAPI:
    app = FastAPI(title="BioVoice API", version="0.1.0")
    container = build_container(settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.container = container
    app.include_router(router)
    # F6 — admin surface (delete, audit, threshold tuning). The
    # require_admin_key dependency on the router rejects every call when
    # BIOVOICE_ADMIN_API_KEY is unset, so adding it to the app is safe in
    # all environments.
    from app.api.admin_routes import admin_router  # local import to avoid cycle
    app.include_router(admin_router)
    _maybe_seed_demo(container)
    return app


app = create_app()
