"""FastAPI application entrypoint for the BioVoice web backend."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.container import build_container
from app.core.config import settings


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
    return app


app = create_app()
