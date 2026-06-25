"""Runtime-tunable config for the Settings tab.

Thresholds + model participation are normally env/code defaults
(`config.py`). This module overlays a persisted override layer on the
live `VerificationService` so an operator can retune the operating point
(or toggle a comparison model) without a restart. Overrides are stored
in SQLite (`runtime_config`) and re-applied on boot by `build_container`.

Security note: these are the decision thresholds that gate ACCEPT /
DEEPFAKE. The API is intentionally unauthenticated like the rest of the
kiosk surface; gate it at the proxy if the deployment is exposed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.schemas import ConfigModelInfo, ConfigResponse

if TYPE_CHECKING:
    from app.core.container import AppContainer


MODEL_LABELS: dict[str, str] = {
    "redimnet_b5": "ReDimNet B5",
    "ecapa_voxceleb": "ECAPA-TDNN",
    "wespeaker_resnet293_lm": "WeSpeaker ResNet293",
}

# Comparison models the operator can toggle, mapped to their PATCH key.
_TOGGLE_KEYS: dict[str, str] = {
    "ecapa_voxceleb": "enable_ecapa_comparison",
    "wespeaker_resnet293_lm": "enable_wespeaker_comparison",
}


def editable_overrides(container: "AppContainer") -> dict:
    """The current effective values for every editable field — the exact
    dict we persist so a restart restores this operating point."""
    vs = container.verification_service
    thr = vs.model_similarity_thresholds
    return {
        "similarity_threshold": vs.similarity_threshold,
        "deepfake_threshold": vs.deepfake_threshold,
        "redimnet_similarity_threshold": thr.get("redimnet_b5", vs.similarity_threshold),
        "ecapa_similarity_threshold": thr.get("ecapa_voxceleb", vs.similarity_threshold),
        "wespeaker_similarity_threshold": thr.get("wespeaker_resnet293_lm", vs.similarity_threshold),
        "min_enrollment_samples": vs.min_enrollment_samples,
        "identify_top_n": vs.identify_top_n,
        "enable_ecapa_comparison": "ecapa_voxceleb" in vs.comparison_encoders,
        "enable_wespeaker_comparison": "wespeaker_resnet293_lm" in vs.comparison_encoders,
        "use_xgb_clusters": bool(getattr(container.detector, "use_xgb", False)),
    }


def _model_info(container: "AppContainer", key: str) -> ConfigModelInfo:
    vs = container.verification_service
    if key == "redimnet_b5":
        # Primary encoder — always loaded + participating, can't be turned off.
        return ConfigModelInfo(key=key, label=MODEL_LABELS[key], loaded=True, participating=True, can_toggle=False)
    loaded = key in container.loaded_comparison_encoders
    return ConfigModelInfo(
        key=key,
        label=MODEL_LABELS[key],
        loaded=loaded,
        participating=key in vs.comparison_encoders,
        can_toggle=loaded,
    )


def effective_config(container: "AppContainer") -> ConfigResponse:
    vs = container.verification_service
    values = editable_overrides(container)
    return ConfigResponse(
        **values,
        xgb_available=bool(getattr(container.detector, "xgb_available", False)),
        sample_rate=vs.sample_rate,
        models=[_model_info(container, key) for key in ("redimnet_b5", "ecapa_voxceleb", "wespeaker_resnet293_lm")],
        provenance=vs._collect_provenance(),
    )


def _set_participation(container: "AppContainer", model_key: str, enabled: bool) -> None:
    vs = container.verification_service
    if enabled:
        if model_key in vs.comparison_encoders:
            return
        encoder = container.loaded_comparison_encoders.get(model_key)
        if encoder is None:
            raise ValueError(
                f"{MODEL_LABELS.get(model_key, model_key)} is not available on this server "
                "(the model failed to load or its weights are missing)."
            )
        vs.comparison_encoders[model_key] = encoder
    else:
        vs.comparison_encoders.pop(model_key, None)


def apply_patch(container: "AppContainer", patch: dict) -> ConfigResponse:
    """Apply a validated partial patch to the live service, then persist
    the full effective override set. Raises ValueError on an impossible
    request (e.g. enabling a model that never loaded)."""
    vs = container.verification_service

    if "similarity_threshold" in patch:
        vs.similarity_threshold = float(patch["similarity_threshold"])
    if "deepfake_threshold" in patch:
        vs.deepfake_threshold = float(patch["deepfake_threshold"])
    if "redimnet_similarity_threshold" in patch:
        vs.model_similarity_thresholds["redimnet_b5"] = float(patch["redimnet_similarity_threshold"])
    if "ecapa_similarity_threshold" in patch:
        vs.model_similarity_thresholds["ecapa_voxceleb"] = float(patch["ecapa_similarity_threshold"])
    if "wespeaker_similarity_threshold" in patch:
        vs.model_similarity_thresholds["wespeaker_resnet293_lm"] = float(patch["wespeaker_similarity_threshold"])
    if "min_enrollment_samples" in patch:
        vs.min_enrollment_samples = int(patch["min_enrollment_samples"])
    if "identify_top_n" in patch:
        vs.identify_top_n = int(patch["identify_top_n"])
    if "enable_ecapa_comparison" in patch:
        _set_participation(container, "ecapa_voxceleb", bool(patch["enable_ecapa_comparison"]))
    if "enable_wespeaker_comparison" in patch:
        _set_participation(container, "wespeaker_resnet293_lm", bool(patch["enable_wespeaker_comparison"]))
    if "use_xgb_clusters" in patch:
        want = bool(patch["use_xgb_clusters"])
        if want and not getattr(container.detector, "xgb_available", False):
            raise ValueError("XGBoost cluster models are not available on this server.")
        container.detector.use_xgb = want

    container.store.set_config_overrides(editable_overrides(container))
    return effective_config(container)
