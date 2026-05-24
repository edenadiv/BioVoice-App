from __future__ import annotations

from pathlib import Path

import pytest

from app.services.speaker_encoder import (
    EcapaSpeakerEncoder,
    WeSpeakerResNet293SpeakerEncoder,
    list_supported_speaker_models,
)


def test_supported_speaker_models_include_optional_backends():
    models = {model.key: model for model in list_supported_speaker_models()}

    assert "redimnet_b5" in models
    assert "ecapa_voxceleb" in models
    assert "wespeaker_resnet293_lm" in models
    assert models["redimnet_b5"].active is True
    assert models["ecapa_voxceleb"].active is False
    assert models["wespeaker_resnet293_lm"].active is False


def test_ecapa_loader_fails_cleanly_without_optional_dependency(monkeypatch: pytest.MonkeyPatch):
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("speechbrain"):
            raise ImportError("speechbrain missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    with pytest.raises(RuntimeError, match="SpeechBrain is not installed"):
        EcapaSpeakerEncoder()


def test_wespeaker_loader_fails_cleanly_without_optional_dependency(monkeypatch: pytest.MonkeyPatch):
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "onnxruntime":
            raise ImportError("onnxruntime missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    with pytest.raises(RuntimeError, match="onnxruntime is not installed"):
        WeSpeakerResNet293SpeakerEncoder(model_dir=Path("backend/models/wespeaker_resnet293_lm"))


def test_wespeaker_loader_reports_missing_checkpoint():
    with pytest.raises(RuntimeError, match="ONNX checkpoint missing"):
        WeSpeakerResNet293SpeakerEncoder(model_dir=Path("backend/models/wespeaker_missing"))
