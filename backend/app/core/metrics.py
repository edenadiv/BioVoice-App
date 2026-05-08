"""F7.3 — Prometheus metrics surface.

Hand-rolled counter / histogram registry — avoids pulling
`prometheus_client` into the dep tree. The format matches the
text-based exposition spec at
https://prometheus.io/docs/instrumenting/exposition_formats/ which is
all the standard scraper needs.

Usage:

    from app.core.metrics import metrics

    metrics.counter("biovoice_verifications_total", labels={"decision": "ACCEPT"}).inc()
    with metrics.histogram("biovoice_verify_seconds").time():
        result = service.verify(...)

The /metrics route returns the rendered text. F7.3 leaves the route
admin-key-gated by default; uncomment the public exposure when scraping
from a Prometheus instance reachable only on the deployment's private
network.
"""

from __future__ import annotations

from contextlib import contextmanager
import math
import threading
from time import perf_counter


_LABEL_VALUE_RESERVED = ("\\", '"', "\n")


def _escape_label_value(value: str) -> str:
    out = value
    for ch in _LABEL_VALUE_RESERVED:
        out = out.replace(ch, "\\" + ch)
    return out


def _format_labels(labels: dict[str, str] | None) -> str:
    if not labels:
        return ""
    inner = ",".join(f'{k}="{_escape_label_value(str(v))}"' for k, v in sorted(labels.items()))
    return "{" + inner + "}"


class Counter:
    def __init__(self, name: str, help_text: str):
        self.name = name
        self.help = help_text
        self._values: dict[tuple[tuple[str, str], ...], float] = {}
        self._lock = threading.Lock()

    def inc(self, amount: float = 1.0, labels: dict[str, str] | None = None) -> None:
        key = tuple(sorted((labels or {}).items()))
        with self._lock:
            self._values[key] = self._values.get(key, 0.0) + amount

    def render(self) -> str:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} counter"]
        for key, value in self._values.items():
            label_str = _format_labels(dict(key)) if key else ""
            lines.append(f"{self.name}{label_str} {value}")
        return "\n".join(lines)


_DEFAULT_BUCKETS_SECONDS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


class Histogram:
    def __init__(self, name: str, help_text: str, buckets: tuple[float, ...] = _DEFAULT_BUCKETS_SECONDS):
        self.name = name
        self.help = help_text
        self.buckets = tuple(sorted(buckets))
        self._buckets: dict[tuple[tuple[str, str], ...], list[int]] = {}
        self._sums: dict[tuple[tuple[str, str], ...], float] = {}
        self._counts: dict[tuple[tuple[str, str], ...], int] = {}
        self._lock = threading.Lock()

    def observe(self, value: float, labels: dict[str, str] | None = None) -> None:
        key = tuple(sorted((labels or {}).items()))
        with self._lock:
            if key not in self._buckets:
                self._buckets[key] = [0] * len(self.buckets)
                self._sums[key] = 0.0
                self._counts[key] = 0
            for i, edge in enumerate(self.buckets):
                if value <= edge:
                    self._buckets[key][i] += 1
            self._sums[key] += value
            self._counts[key] += 1

    @contextmanager
    def time(self, labels: dict[str, str] | None = None):
        t0 = perf_counter()
        try:
            yield
        finally:
            self.observe(perf_counter() - t0, labels)

    def render(self) -> str:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} histogram"]
        for key in self._buckets:
            base_labels = dict(key)
            cumulative = 0
            for i, edge in enumerate(self.buckets):
                cumulative = self._buckets[key][i]
                merged = {**base_labels, "le": _format_le(edge)}
                lines.append(f"{self.name}_bucket{_format_labels(merged)} {cumulative}")
            inf = {**base_labels, "le": "+Inf"}
            lines.append(f"{self.name}_bucket{_format_labels(inf)} {self._counts[key]}")
            lines.append(f"{self.name}_sum{_format_labels(base_labels) if base_labels else ''} {self._sums[key]}")
            lines.append(f"{self.name}_count{_format_labels(base_labels) if base_labels else ''} {self._counts[key]}")
        return "\n".join(lines)


def _format_le(edge: float) -> str:
    if math.isinf(edge):
        return "+Inf"
    return f"{edge:g}"


class _MetricsRegistry:
    def __init__(self):
        self._counters: dict[str, Counter] = {}
        self._histograms: dict[str, Histogram] = {}
        self._lock = threading.Lock()

    def counter(self, name: str, help_text: str = "") -> Counter:
        with self._lock:
            if name not in self._counters:
                self._counters[name] = Counter(name, help_text or name)
            return self._counters[name]

    def histogram(self, name: str, help_text: str = "") -> Histogram:
        with self._lock:
            if name not in self._histograms:
                self._histograms[name] = Histogram(name, help_text or name)
            return self._histograms[name]

    def render(self) -> str:
        parts: list[str] = []
        for c in self._counters.values():
            parts.append(c.render())
        for h in self._histograms.values():
            parts.append(h.render())
        return "\n".join(parts) + "\n"


metrics = _MetricsRegistry()


# Pre-register the metrics the verification pipeline emits so /metrics
# always shows them (zero-valued series are still useful — Prometheus
# treats absence as missing data otherwise).
metrics.counter(
    "biovoice_verifications_total", "Verification attempts grouped by decision."
)
metrics.histogram(
    "biovoice_verify_seconds", "Wall-clock duration of /verify and /me/verify."
)
metrics.counter(
    "biovoice_logins_total", "Login attempts grouped by outcome."
)
