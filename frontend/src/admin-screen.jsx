// F6 frontend — operator admin screen.
//
// Three panels:
//   - Admin key entry (top): persisted to localStorage. Cleared via the
//     "Forget key" button.
//   - Threshold tuner: GET /admin/settings/thresholds → sliders → PUT.
//     Changes are visible immediately on the next /verify call (the
//     backend mirrors them onto the live VerificationService).
//   - Audit log: GET /admin/audit?limit=50, refreshed on demand.
//
// The X-Admin-API-Key header is set per-request from the localStorage
// value. There's no server-side login for admin — the key IS the
// session, rotated via the 90-day policy in backend/README.md §Secrets.

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chrome } from "./screens.jsx";
import { AmbientField } from "./console-ext.jsx";
import {
  adminListAudit,
  adminGetThresholds,
  adminUpdateThresholds,
} from "./lib/api";

const ADMIN_KEY_STORAGE = "biovoice_admin_api_key";

// Threshold knobs surfaced in the UI. Order matches Settings.* in
// backend/app/core/config.py.
const THRESHOLD_KNOBS = [
  { id: "similarity_threshold", label: "Similarity threshold", help: "Min cosine similarity to ACCEPT" },
  { id: "deepfake_threshold", label: "Deepfake threshold", help: "Min AASIST score to NOT flag as synthetic" },
  { id: "voice_naturalness_threshold", label: "Voice naturalness", help: "F4 sub-axis flag threshold" },
  { id: "spectral_consistency_threshold", label: "Spectral consistency", help: "F4 sub-axis flag threshold" },
  { id: "temporal_patterns_threshold", label: "Temporal patterns", help: "F4 sub-axis flag threshold" },
  { id: "artifact_detection_threshold", label: "Artifact detection", help: "F4 sub-axis flag threshold" },
];

export function AdminScreen() {
  const { t } = useTranslation();
  const [adminKey, setAdminKey] = useState(() => window.localStorage.getItem(ADMIN_KEY_STORAGE) || "");
  const [thresholds, setThresholds] = useState(null);     // null until fetched
  const [auditEvents, setAuditEvents] = useState([]);
  const [error, setError] = useState(null);
  const [loadingThresholds, setLoadingThresholds] = useState(false);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);

  const persistKey = useCallback((value) => {
    setAdminKey(value);
    if (value) {
      window.localStorage.setItem(ADMIN_KEY_STORAGE, value);
    } else {
      window.localStorage.removeItem(ADMIN_KEY_STORAGE);
    }
  }, []);

  const refreshThresholds = useCallback(async () => {
    if (!adminKey) return;
    setLoadingThresholds(true);
    setError(null);
    try {
      const next = await adminGetThresholds(adminKey);
      setThresholds(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingThresholds(false);
    }
  }, [adminKey]);

  const refreshAudit = useCallback(async () => {
    if (!adminKey) return;
    setLoadingAudit(true);
    setError(null);
    try {
      const next = await adminListAudit(adminKey, { limit: 50 });
      setAuditEvents(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAudit(false);
    }
  }, [adminKey]);

  // Auto-fetch on key change.
  useEffect(() => {
    if (!adminKey) {
      setThresholds(null);
      setAuditEvents([]);
      return;
    }
    void refreshThresholds();
    void refreshAudit();
  }, [adminKey, refreshThresholds, refreshAudit]);

  const handleSliderChange = (id, value) => {
    setThresholds((prev) => (prev ? { ...prev, [id]: value } : prev));
  };

  const saveThresholds = async () => {
    if (!thresholds || !adminKey) return;
    setSavingThresholds(true);
    setError(null);
    setStatusMessage(null);
    try {
      const next = await adminUpdateThresholds(adminKey, thresholds);
      setThresholds(next);
      setStatusMessage("Thresholds updated.");
      void refreshAudit();  // pick up the threshold.update event
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingThresholds(false);
    }
  };

  return (
    <div className="screen fade-enter">
      <Chrome status="OPERATOR ADMIN · ACCESS GATED" statusKind="warn" subtitle="F6 — privileged surface" screenName="ADMIN" />
      <AmbientField count={28} />

      <div style={{
        position: "absolute", inset: 0, padding: "150px 56px 90px 124px",
        display: "flex", flexDirection: "column", gap: 22, zIndex: 2, overflowY: "auto",
      }}>
        <div>
          <div className="label-mono" style={{ fontSize: 10, color: "var(--warn)" }}>
            {t("nav.settings", "Admin")}
          </div>
          <div style={{ fontSize: 30, fontWeight: 200, marginTop: 4 }}>
            Operator admin
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-mute)", marginTop: 6, maxWidth: 720 }}>
            Tune thresholds and inspect the audit log. Requires the deployment's
            <code style={{ marginInline: 6 }}>BIOVOICE_ADMIN_API_KEY</code>.
            Stored in this browser's localStorage; rotate per the 90-day policy.
          </div>
        </div>

        {/* Admin key entry */}
        <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="label-mono" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
            X-ADMIN-API-KEY
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={adminKey}
              onChange={(e) => persistKey(e.target.value)}
              placeholder="paste admin key (BIOVOICE_ADMIN_API_KEY)"
              style={{
                flex: 1, padding: "10px 12px", borderRadius: 8,
                background: "rgba(0,0,0,0.35)", color: "#dff",
                border: "1px solid rgba(125,200,255,0.18)",
                fontFamily: "JetBrains Mono, monospace", fontSize: 13,
                minHeight: 44,
              }}
            />
            <button
              type="button"
              onClick={() => persistKey("")}
              style={{
                padding: "10px 16px", borderRadius: 8, cursor: "pointer",
                background: "transparent", color: "var(--ink-mute)",
                border: "1px solid rgba(255,255,255,0.18)",
                minHeight: 44,
              }}
            >
              Forget key
            </button>
          </div>
          {!adminKey && (
            <div style={{ fontSize: 12, color: "var(--ink-mute)" }}>
              Paste the deployment's admin key to load thresholds + audit log.
            </div>
          )}
        </div>

        {error && (
          <div className="panel" style={{
            padding: 14, borderColor: "rgba(255,80,80,0.4)", color: "#ff8080",
            fontFamily: "JetBrains Mono, monospace", fontSize: 12,
          }}>
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="panel" style={{
            padding: 12, borderColor: "rgba(126,240,255,0.45)", color: "#7ef0ff",
            fontFamily: "JetBrains Mono, monospace", fontSize: 12,
          }}>
            {statusMessage}
          </div>
        )}

        {adminKey && (
          <div className="biovoice-two-column" style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22, minHeight: 0,
          }}>
            {/* Threshold tuner */}
            <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="label-mono" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
                  THRESHOLDS · F4.4
                </div>
                <button
                  type="button"
                  onClick={refreshThresholds}
                  disabled={loadingThresholds}
                  style={{
                    padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                    background: "transparent", color: "var(--ink-mute)",
                    border: "1px solid rgba(255,255,255,0.18)",
                  }}
                >
                  {loadingThresholds ? "…" : "Refresh"}
                </button>
              </div>
              {!thresholds ? (
                <div style={{ color: "var(--ink-mute)", fontSize: 12 }}>Loading…</div>
              ) : (
                <>
                  {THRESHOLD_KNOBS.map(({ id, label, help }) => (
                    <div key={id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span>{label}</span>
                        <span className="biovoice-numerals" style={{ color: "#7ef0ff", fontFamily: "JetBrains Mono, monospace" }}>
                          {Number(thresholds[id]).toFixed(2)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0} max={1} step={0.01}
                        value={thresholds[id]}
                        onChange={(e) => handleSliderChange(id, Number(e.target.value))}
                        style={{ width: "100%" }}
                        aria-label={label}
                      />
                      <div style={{ fontSize: 10, color: "var(--ink-mute)" }}>{help}</div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={saveThresholds}
                    disabled={savingThresholds}
                    style={{
                      marginTop: 6, padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                      background: "linear-gradient(135deg, rgba(126,240,255,0.18), rgba(61,169,252,0.06))",
                      color: "#7ef0ff",
                      border: "1px solid rgba(126,240,255,0.45)",
                      fontFamily: "JetBrains Mono, monospace", fontSize: 12,
                      letterSpacing: "0.16em", textTransform: "uppercase",
                      minHeight: 44,
                    }}
                  >
                    {savingThresholds ? "Saving…" : "Save thresholds"}
                  </button>
                </>
              )}
            </div>

            {/* Audit log */}
            <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="label-mono" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
                  AUDIT LOG · F6.2 · last 50
                </div>
                <button
                  type="button"
                  onClick={refreshAudit}
                  disabled={loadingAudit}
                  style={{
                    padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                    background: "transparent", color: "var(--ink-mute)",
                    border: "1px solid rgba(255,255,255,0.18)",
                  }}
                >
                  {loadingAudit ? "…" : "Refresh"}
                </button>
              </div>
              <div style={{
                flex: 1, overflowY: "auto", maxHeight: 480,
                fontFamily: "JetBrains Mono, monospace", fontSize: 11,
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                {auditEvents.length === 0 && !loadingAudit && (
                  <div style={{ color: "var(--ink-mute)", fontSize: 12 }}>No events.</div>
                )}
                {auditEvents.map((event) => (
                  <div key={event.event_id} style={{
                    display: "grid", gridTemplateColumns: "120px 1fr",
                    columnGap: 10, padding: "6px 8px",
                    borderBottom: "1px dashed rgba(255,255,255,0.05)",
                  }}>
                    <span style={{ color: "var(--ink-mute)" }} className="biovoice-numerals">
                      {event.occurred_at.replace("T", " ").slice(0, 19)}
                    </span>
                    <span>
                      <span style={{ color: actionColor(event.action) }}>{event.action}</span>
                      {event.target ? <span style={{ color: "var(--ink-mute)" }}> → {event.target}</span> : null}
                      {event.actor && event.actor !== event.target ? (
                        <span style={{ color: "var(--ink-mute)" }}> by {event.actor}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function actionColor(action) {
  if (action.startsWith("login.fail") || action === "user.delete") return "#ff8080";
  if (action.startsWith("login.success")) return "#7ef0ff";
  if (action.startsWith("threshold")) return "#ffc66f";
  return "#cfd";
}
