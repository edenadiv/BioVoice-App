"""GET /metrics/summary — JSON snapshot the Console panel reads.

Replaces the panel's old hardcoded `11ms / 62/s / 14d` decoration with
real values from the live metrics registry."""

from __future__ import annotations

import math

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes
from app.core.metrics import metrics


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def test_summary_has_expected_shape(client: TestClient):
    """All five fields are present + correctly typed."""
    resp = client.get("/metrics/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) >= {
        "verifications_total",
        "throughput_per_sec",
        "uptime_sec",
        "cold_start_at",
        "p50_verify_ms",
    }
    assert isinstance(body["verifications_total"], int)
    assert isinstance(body["throughput_per_sec"], (int, float))
    assert isinstance(body["uptime_sec"], int)
    assert isinstance(body["cold_start_at"], str)
    # p50_verify_ms is null until the histogram has observations.
    assert body["p50_verify_ms"] is None or isinstance(body["p50_verify_ms"], (int, float))


def test_summary_reflects_recorded_verifications(client: TestClient):
    """After incrementing the verifications counter + recording a few
    histogram observations, the summary surfaces non-zero values."""
    counter = metrics.counter("biovoice_verifications_total")
    histogram = metrics.histogram("biovoice_verify_seconds")

    # Snapshot baseline so this test doesn't depend on global ordering.
    baseline = client.get("/metrics/summary").json()
    base_total = baseline["verifications_total"]

    counter.inc(labels={"decision": "ACCEPT"})
    counter.inc(labels={"decision": "ACCEPT"})
    counter.inc(labels={"decision": "REJECT"})
    histogram.observe(0.42)
    histogram.observe(0.51)
    histogram.observe(0.39)

    after = client.get("/metrics/summary").json()
    assert after["verifications_total"] == base_total + 3
    # p50 lands in one of the histogram buckets ≤ 0.5 s.
    assert after["p50_verify_ms"] is not None
    assert 0 < after["p50_verify_ms"] <= 1000


def test_summary_uptime_is_monotonic(client: TestClient):
    """Two consecutive calls — uptime never decreases."""
    first = client.get("/metrics/summary").json()
    second = client.get("/metrics/summary").json()
    assert second["uptime_sec"] >= first["uptime_sec"]
    assert math.isfinite(second["throughput_per_sec"])
