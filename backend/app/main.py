"""FastAPI application entrypoint for the BioVoice web backend."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes import router
from app.core.container import build_container
from app.core.config import settings
from app.core.logging_setup import configure_logging

# F7.2 — set up structured (JSON) logging before any module-level
# logger.getLogger() side effects fire. Honour BIOVOICE_LOG_FORMAT=plain
# for human-readable local dev.
configure_logging()


# P1 — when the production image is built (Dockerfile stage 1 puts the
# Vite bundle into /app/frontend_dist), serve the SPA from FastAPI on
# the same port as the API. Skipped automatically in local dev — the
# directory just doesn't exist when uvicorn runs from `backend/`.
def _resolve_frontend_dist() -> Path | None:
    override = os.environ.get("BIOVOICE_FRONTEND_DIST")
    if override:
        path = Path(override)
        return path if path.is_dir() else None
    # Container path first, then a repo-relative path for `pnpm build`
    # followed by `uvicorn app.main:app` from `backend/`.
    for candidate in (Path("/app/frontend_dist"), Path(__file__).resolve().parents[2] / "frontend" / "dist"):
        if candidate.is_dir():
            return candidate
    return None


def _mount_spa(app: FastAPI, dist_dir: Path) -> None:
    """Mount the built React UI at `/`.

    `StaticFiles(html=True)` already serves `index.html` for `/`, but
    a single-page app expects ANY unmatched non-API route (e.g.
    `/profiles`) to also yield `index.html` so React Router can take
    over. We add an exception handler on 404s under the static mount
    that does exactly that — only when the original request accepts
    HTML, otherwise 404 stays 404 (so JSON clients hitting
    `/non/existent` still see a real error).
    """
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="spa")
    index_html = dist_dir / "index.html"

    @app.exception_handler(StarletteHTTPException)
    async def _spa_fallback(request, exc):
        if (
            exc.status_code == 404
            and request.method == "GET"
            and "text/html" in request.headers.get("accept", "")
            and index_html.exists()
        ):
            return FileResponse(index_html)
        # Non-SPA 404s — preserve the original status + detail as JSON
        # rather than re-raising (re-raise escapes TestClient + clients
        # that don't unwrap Starlette exceptions).
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


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
    dist_dir = _resolve_frontend_dist()
    if dist_dir is not None:
        _mount_spa(app, dist_dir)
    return app


app = create_app()
