"""Grad-CAM faithfulness verdict logic (routes._faith_verdict).

The masking + CAM math is covered in test_explain.py; here we pin the
random-baseline decision that turns sufficiency/necessity margins into a
FAITHFUL / WEAK / UNFAITHFUL / NO_SALIENCE verdict.
"""

from __future__ import annotations

from app.api.routes import _faith_verdict, _FAITH_MARGIN


def test_verdict_faithful_when_beats_random_on_both():
    # CAM region carries more identity than random (suff) AND removing it hurts
    # more than removing a random region (nec).
    assert _faith_verdict("alice", True, suff=0.06, nec=0.05) == "faithful"


def test_verdict_weak_when_only_sufficiency_beats_random():
    # Localises what to keep, but removing it is no worse than random — the
    # common honest outcome for speaker ID (identity is distributed).
    assert _faith_verdict("idan1", True, suff=0.06, nec=0.0) == "weak"


def test_verdict_weak_when_only_necessity_beats_random():
    assert _faith_verdict("idan1", True, suff=0.0, nec=0.06) == "weak"


def test_verdict_unfaithful_when_no_better_than_chance():
    # Neither margin clears the threshold — the CAM's region is no more
    # identity-bearing than a random region of the same size.
    assert _faith_verdict("alice", True, suff=0.0, nec=-0.01) == "unfaithful"


def test_verdict_no_salience_without_target_or_untestable():
    assert _faith_verdict(None, True, suff=0.5, nec=0.5) == "no_salience"
    assert _faith_verdict("alice", False, suff=0.5, nec=0.5) == "no_salience"


def test_margin_is_a_small_positive_threshold():
    # Just below the margin is not enough; at/above it counts.
    assert _faith_verdict("alice", True, _FAITH_MARGIN - 0.001, 0.0) == "unfaithful"
    assert _faith_verdict("alice", True, _FAITH_MARGIN, 0.0) == "weak"
