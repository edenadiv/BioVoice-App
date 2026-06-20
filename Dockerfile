# P2 — single deployable image (v1.1.0+).
#
# Builds the React frontend in stage 1, installs the FastAPI backend's
# pinned deps (backend/requirements.txt) in stage 2, and produces a slim
# runtime image in stage 3 that serves both at port 8000. The bundled
# React UI is mounted by `app.main` whenever `/app/frontend_dist` exists.
#
# ML weights (aasist.pt + redimnet_b5.pt) are baked into the image
# under /app/models — operators don't have to mount them separately.
#
# Build:
#   docker build -t biovoice:1.1.0 .
#
# Run:
#   docker run -p 8000:8000 -v biovoice-data:/app/data biovoice:1.1.0
#
# The legacy backend-only build at backend/Dockerfile is still wired
# into docker-compose.yml for the original three-service local stack
# (backend + nginx static + nginx TLS). For ANY new deployment, use
# this top-level Dockerfile.

# -----------------------------------------------------------------------------
# Stage 1 — build the React bundle.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS frontend

WORKDIR /build
RUN corepack enable
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2 — install Python deps from the team's pinned lockfile.
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS backend

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY backend/requirements.txt ./

RUN pip install --upgrade pip setuptools wheel

# Pre-install CPU-only torch/torchaudio/torchcodec wheels — the default
# x86_64 wheels bundle CUDA libs (~2 GB) and, for torchcodec, dlopen
# libnvrtc.so at import time, which doesn't exist in this CPU-only image
# (OSError at runtime, surfaced as a 503 from any endpoint that decodes
# audio through it). The kiosk runs on CPU only. Pinned to match
# requirements.txt exactly so the next step treats them as already satisfied.
RUN pip install --prefix=/install \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.12.1 torchaudio==2.11.0 torchcodec==0.14.0

RUN PYTHONPATH=/install/lib/python3.11/site-packages \
    pip install --prefix=/install -r requirements.txt

# `packaging` gets pulled into the build env's DEFAULT site-packages by the
# setuptools/wheel upgrade above, so the --prefix=/install install treats it
# as already-satisfied and never copies it into /install — the only tree the
# runtime stage keeps. speechbrain imports `packaging` at module load, so
# ECAPA silently fails to enable without this. --ignore-installed forces a
# copy into /install regardless of the build env.
RUN pip install --prefix=/install --ignore-installed "packaging>=23"

# -----------------------------------------------------------------------------
# Stage 3 — slim runtime image, frontend + backend served on one port.
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# Non-root operator account — no ambient root at runtime.
RUN groupadd --system biovoice --gid 10000 && \
    useradd  --system biovoice --gid biovoice --uid 10000 --create-home --shell /bin/bash

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 \
        curl \
        espeak-ng \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Bring in compiled site-packages from the backend stage.
COPY --from=backend /install /usr/local

# `app.core.config.Settings` derives data + model paths from
# `Path(__file__).resolve().parents[3]`. Putting the backend at
# /app/backend/ makes those paths resolve to /app/backend/data and
# /app/backend/models — no env-var overrides needed.
WORKDIR /app/backend
COPY backend/app /app/backend/app
COPY backend/scripts /app/backend/scripts
COPY backend/models /app/backend/models
COPY --from=frontend /build/dist /app/frontend_dist

# Bake the ECAPA-TDNN comparison model into the image so the kiosk runs all
# three speaker models offline (no Hugging Face download at runtime). WeSpeaker
# ResNet293 ONNX weights are already carried in backend/models via Git LFS
# (run `git lfs pull` before building). ReDimNet is the vendored primary.
RUN python scripts/setup_ecapa.py

# Mountable volume:
#   /app/backend/data       persistent SQLite + reference samples
RUN mkdir -p /app/backend/data && \
    chown -R biovoice:biovoice /app

USER biovoice

# Liveness via /health, deep readiness via /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail http://127.0.0.1:8000/readyz || exit 1

# JSON logs by default; flip BIOVOICE_LOG_FORMAT=plain for human-readable dev.
# BIOVOICE_FRONTEND_DIST is honoured by app.main as an override; pinned to the
# baked-in path here so reverse-proxy deployments don't have to re-export it.
# Run all three speaker models by default: ReDimNet (primary) + ECAPA + WeSpeaker,
# fused via majority vote in /verify and /identify. Set either flag to 0 to
# fall back to fewer models.
ENV BIOVOICE_LOG_FORMAT=json \
    LOG_LEVEL=INFO \
    BIOVOICE_FRONTEND_DIST=/app/frontend_dist \
    ENABLE_ECAPA_COMPARISON=1 \
    ENABLE_WESPEAKER_COMPARISON=1

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
