"""Provider-agnostic LLM types.

Adding a provider:
  1. Implement `LLMClient.chat` for the new SDK.
  2. Map provider exceptions to `LLMTransportError` / `LLMResponseError`.
  3. Register it in `factory.build_llm_client`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable


class LLMError(Exception):
    """Base for all provider errors."""


class LLMTransportError(LLMError):
    """Network or API-level failure (5xx, timeout, auth)."""


class LLMResponseError(LLMError):
    """Provider returned malformed or unusable content."""


@dataclass(slots=True)
class ImagePart:
    data: bytes
    media_type: str  # image/png | image/jpeg | image/webp | image/gif


@dataclass(slots=True)
class ToolDef:
    name: str
    description: str
    parameters: dict = field(default_factory=lambda: {"type": "object", "properties": {}})


@dataclass(slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict


# Returns a JSON-serializable string to feed back to the model.
ToolHandler = Callable[[ToolCall], str]


@dataclass(slots=True)
class LLMResponse:
    text: str
    stop_reason: str  # "end_turn" | "max_tokens" | "tool_use_exhausted" | provider-specific


class LLMClient(ABC):
    """Provider adapter. Owns the tool-use loop internally."""

    @abstractmethod
    def chat(
        self,
        *,
        system: str,
        user_prompt: str,
        image: ImagePart | None = None,
        tools: list[ToolDef] | None = None,
        force_tool: str | None = None,
        tool_handler: ToolHandler | None = None,
        max_tool_rounds: int = 3,
        max_tokens: int = 512,
    ) -> LLMResponse:
        """Send a single user turn, run any tool loop, return final text."""
