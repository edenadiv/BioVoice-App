"""F4 / G1 — vendored AASIST anti-spoof model.

Source: https://github.com/clovaai/aasist (MIT licence — see LICENSE in
this directory).

Mirrors the upstream `models/AASIST.py` verbatim with two additions
appended at the file foot:

  - `AASISTModel = Model`  — naming alias to match our service-layer import.
  - `AASIST_CONFIG`        — the model_config dict from upstream
    `config/AASIST.conf` so the consumer doesn't have to ship a JSON
    sidecar.

The checkpoint at `backend/models/aasist.pt` was trained against the
original AASIST architecture (32-channel encoder, 160-d final feature).
If it ever gets swapped for the `AASIST-L` variant, replace
`AASIST_CONFIG.filts` with the smaller widths from upstream's
`AASIST-L.conf`.
"""

from app.vendor.aasist.aasist_model import AASISTModel, AASIST_CONFIG

__all__ = ["AASISTModel", "AASIST_CONFIG"]
