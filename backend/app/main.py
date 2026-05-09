"""FastAPI application entrypoint for the BioVoice web backend."""

from __future__ import annotations

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
    return app


app = create_app()
