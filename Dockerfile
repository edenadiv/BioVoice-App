# P2 — single deployable image (v1.1.0+).
#
# Builds the React frontend in stage 1, installs the FastAPI backend
# (with the [model] extras) in stage 2, and produces a slim runtime
# image in stage 3 that serves both at port 8000. The bundled React UI
# is mounted by `app.main` whenever `/app/frontend_dist` exists.
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
# Stage 2 — install Python deps + backend code.
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS backend

ARG INSTALL_EXTRAS=model

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/scripts ./scripts

RUN pip install --upgrade pip setuptools wheel

# Pre-install CPU-only torch wheels — the default x86_64 wheels bundle
# CUDA libs (~2 GB). The kiosk runs on CPU only; CUDA support would
# bloat the image to ~8 GB without ever being exercised.
RUN pip install --prefix=/install \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch>=2.2,<3" "torchaudio>=2.2,<3"

RUN PYTHONPATH=/install/lib/python3.12/site-packages \
    pip install --prefix=/install --no-build-isolation -e ".[${INSTALL_EXTRAS}]"

# -----------------------------------------------------------------------------
# Stage 3 — slim runtime image, frontend + backend served on one port.
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# Non-root operator account — no ambient root at runtime.
RUN groupadd --system biovoice --gid 10000 && \
    useradd  --system biovoice --gid biovoice --uid 10000 --create-home --shell /bin/bash

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 \
        curl \
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
ENV BIOVOICE_LOG_FORMAT=json \
    LOG_LEVEL=INFO \
    BIOVOICE_FRONTEND_DIST=/app/frontend_dist

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
