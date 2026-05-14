"""Anthropic Messages API adapter."""

from __future__ import annotations

import base64
import json

import anthropic

from app.services.llm.base import (
    ImagePart,
    LLMClient,
    LLMResponse,
    LLMResponseError,
    LLMTransportError,
    ToolCall,
    ToolDef,
    ToolHandler,
)


class AnthropicClient(LLMClient):
    def __init__(self, *, api_key: str, model: str, base_url: str | None = None) -> None:
        self._client = anthropic.Anthropic(
            api_key=api_key,
            **({"base_url": base_url} if base_url else {}),
        )
        self._model = model

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
        messages: list[dict] = [{"role": "user", "content": _build_user_content(user_prompt, image)}]
        api_tools = [_to_anthropic_tool(t) for t in tools] if tools else None

        for round_index in range(max_tool_rounds):
            tool_choice = self._tool_choice(force_tool, round_index, api_tools)
            try:
                response = self._client.messages.create(
                    model=self._model,
                    max_tokens=max_tokens,
                    system=system,
                    messages=messages,
                    **({"tools": api_tools} if api_tools else {}),
                    **({"tool_choice": tool_choice} if tool_choice else {}),
                )
            except anthropic.APIError as exc:
                raise LLMTransportError(str(exc)) from exc

            if response.stop_reason != "tool_use":
                return LLMResponse(text=_extract_text(response.content), stop_reason=response.stop_reason)

            if tool_handler is None:
                raise LLMResponseError("Model invoked a tool but no handler was provided")

            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": _handle_tool_calls(response.content, tool_handler)})

        return LLMResponse(text="", stop_reason="tool_use_exhausted")

    @staticmethod
    def _tool_choice(force_tool: str | None, round_index: int, api_tools: list[dict] | None) -> dict | None:
        if api_tools is None:
            return None
        if force_tool and round_index == 0:
            return {"type": "tool", "name": force_tool}
        return {"type": "auto"}


def _build_user_content(text: str, image: ImagePart | None) -> list[dict]:
    parts: list[dict] = []
    if image is not None:
        parts.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.media_type,
                    "data": base64.b64encode(image.data).decode(),
                },
            }
        )
    parts.append({"type": "text", "text": text})
    return parts


def _to_anthropic_tool(tool: ToolDef) -> dict:
    return {"name": tool.name, "description": tool.description, "input_schema": tool.parameters}


def _extract_text(content: list) -> str:
    return "".join(block.text for block in content if getattr(block, "type", None) == "text")


def _handle_tool_calls(content: list, handler: ToolHandler) -> list[dict]:
    results: list[dict] = []
    for block in content:
        if getattr(block, "type", None) != "tool_use":
            continue
        call = ToolCall(id=block.id, name=block.name, arguments=dict(block.input or {}))
        try:
            result_str = handler(call)
        except Exception as exc:  # tool failures must not crash the loop
            result_str = json.dumps({"error": str(exc)})
        results.append({"type": "tool_result", "tool_use_id": call.id, "content": result_str})
    return results
