# F7.5 — multi-stage Dockerfile for the BioVoice backend.
#
# Stage 1 builds the Python wheel + installs the [model] extra against
# Python 3.12 (TTS pin requirement — F1.4). Stage 2 copies the
# resulting site-packages into a slim runtime image. Final image
# weighs ~1.4 GB with the TTS extras included; ~700 MB without.
#
# Build:
#   docker build -f Dockerfile -t biovoice-backend:latest backend
#
# Build with the spoof / TTS extras:
#   docker build --build-arg INSTALL_EXTRAS=model,spoof \
#       -f Dockerfile -t biovoice-backend:latest backend
#
# Model weights (aasist.pt, redimnet_b5.pt) MUST be mounted at runtime
# under /app/backend/models — see docs/deployment.md for the procedure.

# -----------------------------------------------------------------------------
# Build stage — install deps + compile.
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS build

ARG INSTALL_EXTRAS=model

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pyproject.toml ./
COPY app ./app
COPY scripts ./scripts

RUN pip install --upgrade pip && \
    pip install --prefix=/install --no-build-isolation -e ".[${INSTALL_EXTRAS}]"

# -----------------------------------------------------------------------------
# Runtime stage — slim image, app + deps, no compilers.
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# Non-root operator account. The kiosk never needs root at runtime.
RUN groupadd --system biovoice --gid 10000 && \
    useradd  --system biovoice --gid biovoice --uid 10000 --create-home --shell /bin/bash

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Bring in the compiled site-packages from the build stage.
COPY --from=build /install /usr/local

WORKDIR /app
COPY app /app/app
COPY scripts /app/scripts

# Mountable volumes:
#   /app/data       persistent SQLite + reference samples (use a host volume)
#   /app/models     pre-bundled ML weights (aasist.pt, redimnet_b5.pt)
RUN mkdir -p /app/data /app/models && \
    chown -R biovoice:biovoice /app

USER biovoice

# F7.4 — readiness lives at /readyz (deep check); /health is liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail http://127.0.0.1:8000/readyz || exit 1

# F7.2 — JSON logs by default; flip BIOVOICE_LOG_FORMAT=plain for dev.
ENV BIOVOICE_LOG_FORMAT=json \
    LOG_LEVEL=INFO

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
