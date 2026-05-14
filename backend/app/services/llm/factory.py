"""LLM provider factory."""

from __future__ import annotations

from app.services.llm.base import LLMClient


def build_llm_client(*, provider: str, api_key: str, model: str, base_url: str | None) -> LLMClient:
    name = provider.lower().strip()
    if name == "anthropic":
        from app.services.llm.anthropic_client import AnthropicClient

        return AnthropicClient(api_key=api_key, model=model, base_url=base_url)
    # Add openai / ollama adapters here when needed.
    raise ValueError(f"Unknown LLM provider: {provider!r}")
