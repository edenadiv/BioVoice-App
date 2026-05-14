"""FastAPI dependency helpers."""

from fastapi import HTTPException, Request

from app.core.container import AppContainer
from app.services.deepfake_agent import DeepfakeAgent
from app.services.spoof import SpoofGenerationService
from app.services.verification import VerificationService


def get_container(request: Request) -> AppContainer:
    container = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=500, detail="Application container unavailable")
    return container


def get_verification_service(request: Request) -> VerificationService:
    return get_container(request).verification_service


def get_spoof_generation_service(request: Request) -> SpoofGenerationService:
    return get_container(request).spoof_service


def get_deepfake_agent(request: Request) -> DeepfakeAgent:
    agent = get_container(request).deepfake_agent
    if agent is None:
        raise HTTPException(
            status_code=503,
            detail="Deepfake agent unavailable. Set ANTHROPIC_API_KEY (or LLM_API_KEY) in the backend env.",
        )
    return agent
