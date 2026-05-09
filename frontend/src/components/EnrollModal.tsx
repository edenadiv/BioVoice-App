// Operator-driven enrolment modal.
//
// Flow:
//  1. Operator types a user ID (lowercase letters / digits / - / _).
//  2. Press "Record sample" — useVoiceRecorder captures 3 s of mic audio.
//  3. POST /enroll with the WAV; backend scores it (SNR, clipping,
//     speech ratio). If rejected, operator retries; the sample dot
//     stays empty.
//  4. After 3 accepted samples, refresh the speaker list + close.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { enrollSpeaker, type EnrollResult } from "../lib/api";
import { useVoiceRecorder } from "../lib/audio";
import { useRefreshSpeakers } from "../lib/session";

const REQUIRED_SAMPLES = 3;
const RECORD_MS = 3000;
const USER_ID_PATTERN = /^[a-z0-9_-]{2,32}$/;

type Quality = NonNullable<EnrollResult["quality"]>;

interface EnrollModalProps {
  onClose: () => void;
  audio?: { samples?: Uint8Array; level?: number }; // unused — overlay for parity with parent
}

export function EnrollModal({ onClose }: EnrollModalProps) {
  const [userId, setUserId] = useState("");
  const [accepted, setAccepted] = useState(0);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuality, setLastQuality] = useState<Quality | null>(null);
  const stopFiredRef = useRef(false);

  const recorder = useVoiceRecorder({ minMs: 1000, maxMs: RECORD_MS });
  const refreshSpeakers = useRefreshSpeakers();

  const userIdValid = USER_ID_PATTERN.test(userId);

  // Auto-stop the recorder after RECORD_MS once it goes live.
  useEffect(() => {
    if (recorder.state !== "recording") return;
    const id = setTimeout(() => {
      void handleStop();
    }, RECORD_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.state]);

  const handleStart = useCallback(async () => {
    if (!userIdValid) {
      setError("User ID must be 2–32 chars, lowercase letters / digits / - / _.");
      return;
    }
    setError(null);
    setLastQuality(null);
    stopFiredRef.current = false;
    setRecording(true);
    await recorder.start();
  }, [userIdValid, recorder]);

  const handleStop = useCallback(async () => {
    if (stopFiredRef.current) return;
    stopFiredRef.current = true;
    setBusy(true);
    setRecording(false);
    try {
      const rec = await recorder.stop();
      if (!rec) {
        setError(recorder.state === "denied"
          ? "Microphone access denied. Allow it in your browser to enrol."
          : "Recording too short — speak for the full 3 seconds.");
        return;
      }
      const result = await enrollSpeaker(userId, rec.wavFile);
      setLastQuality(result.quality);
      // Backend already rejects unacceptable samples with a 400, so a
      // 200 here means the sample landed. Bump the accepted counter.
      setAccepted(n => {
        const next = n + 1;
        if (next >= REQUIRED_SAMPLES) {
          // Defer the close so the user sees the third dot fill green.
          setTimeout(async () => {
            await refreshSpeakers();
            onClose();
          }, 600);
        }
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.length > 240 ? msg.slice(0, 240) + "…" : msg);
    } finally {
      setBusy(false);
    }
  }, [recorder, userId, onClose, refreshSpeakers]);

  const handleCancel = useCallback(() => {
    if (accepted > 0 && !window.confirm(`Cancel enrolment for "${userId}"? ${accepted}/${REQUIRED_SAMPLES} samples already recorded — they stay on the server but the profile won't be usable until you reach 3 samples.`)) {
      return;
    }
    onClose();
  }, [accepted, userId, onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Enrol new profile" style={overlayStyle}>
      <div style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 11, color: "var(--teal-2)" }}>NEW PROFILE</div>
            <div style={{ fontSize: 28, fontWeight: 200, marginTop: 6 }}>Enrol a voice</div>
            <div style={{ fontSize: 13, color: "var(--ink-mute)", marginTop: 6, maxWidth: 480 }}>
              Capture {REQUIRED_SAMPLES} short samples. Each one is scored on
              SNR, clipping, and speech ratio — bad samples don't count.
            </div>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Close"
            style={{
              width: 36, height: 36, borderRadius: "50%",
              background: "transparent", color: "var(--ink-mute)",
              border: "1px solid rgba(125,200,255,0.18)",
              cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0,
            }}>×</button>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="label-mono" style={{ fontSize: 10, marginBottom: 8 }}>USER ID</div>
          <input
            type="text"
            value={userId}
            onChange={e => setUserId(e.target.value.toLowerCase())}
            disabled={accepted > 0}
            placeholder="alice_demo"
            autoFocus
            style={inputStyle}
          />
          <div className="label-mono" style={{
            fontSize: 9, marginTop: 6,
            color: userId === "" ? "var(--ink-soft)" : userIdValid ? "var(--good)" : "var(--bad)",
          }}>
            {userId === ""
              ? "2–32 chars · lowercase letters / digits / underscore / hyphen"
              : userIdValid ? "✓ valid" : "✗ must match a-z 0-9 _ - (2-32 chars)"}
          </div>
        </div>

        {/* Sample-progress dots */}
        <div style={{ display: "flex", gap: 10, marginBottom: 24, alignItems: "center" }}>
          {Array.from({ length: REQUIRED_SAMPLES }).map((_, i) => (
            <div key={i} style={{
              width: 36, height: 36, borderRadius: "50%",
              border: "2px solid " + (i < accepted ? "rgba(106,255,200,0.5)" : "rgba(125,200,255,0.18)"),
              background: i < accepted ? "rgba(106,255,200,0.12)" : "transparent",
              display: "grid", placeItems: "center",
              color: i < accepted ? "#6affc8" : "var(--ink-soft)",
              fontFamily: "JetBrains Mono, monospace", fontSize: 12,
              transition: "all 240ms cubic-bezier(.2,.8,.2,1)",
            }}>{i < accepted ? "✓" : i + 1}</div>
          ))}
          <span className="label-mono" style={{ fontSize: 10, marginLeft: 10, color: "var(--ink-mute)" }}>
            {accepted}/{REQUIRED_SAMPLES} captured
          </span>
        </div>

        {/* Recording / error / quality */}
        {recording && (
          <div style={{ ...statusStyle, color: "#ff7aa8", borderColor: "rgba(255,85,119,0.35)" }}>
            <span style={{
              display: "inline-block", width: 8, height: 8, marginRight: 8, borderRadius: "50%",
              background: "#ff5577", animation: "pulse 0.8s infinite",
            }}/>
            RECORDING · speak for {RECORD_MS / 1000} s
          </div>
        )}

        {busy && !recording && (
          <div style={{ ...statusStyle, color: "var(--teal-2)", borderColor: "rgba(126,240,255,0.35)" }}>
            Scoring sample…
          </div>
        )}

        {error && (
          <div style={{ ...statusStyle, color: "#ff8080", borderColor: "rgba(255,128,128,0.45)" }}>
            {error}
          </div>
        )}

        {lastQuality && !error && (
          <div style={qualityStyle}>
            <div className="label-mono" style={{ fontSize: 9, marginBottom: 6, color: "var(--ink-mute)" }}>
              LAST SAMPLE QUALITY
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, fontSize: 11 }}>
              <QStat label="SCORE" value={`${lastQuality.score.toFixed(0)}`} pass={lastQuality.acceptable}/>
              <QStat label="SNR dB" value={lastQuality.snr_db.toFixed(1)} pass={lastQuality.snr_db >= 10}/>
              <QStat label="SPEECH" value={`${(lastQuality.speech_ratio * 100).toFixed(0)}%`} pass={lastQuality.speech_ratio >= 0.3}/>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 28, alignItems: "center" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!userIdValid || recording || busy || accepted >= REQUIRED_SAMPLES}
            onClick={handleStart}
            style={{ flex: 1, justifyContent: "center", padding: "14px", fontSize: 13 }}>
            {recording ? "Recording…"
              : busy ? "Processing…"
              : accepted >= REQUIRED_SAMPLES ? "Done"
              : `Record sample ${accepted + 1} / ${REQUIRED_SAMPLES}`}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            style={{
              padding: "14px 22px", fontSize: 13,
              background: "transparent", color: "var(--ink-mute)",
              border: "1px solid rgba(125,200,255,0.18)", borderRadius: 10,
              cursor: busy ? "wait" : "pointer", minHeight: 44,
            }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function QStat({ label, value, pass }: { label: string; value: string; pass: boolean }) {
  return (
    <div>
      <div className="label-mono" style={{ fontSize: 8 }}>{label}</div>
      <div className="num-mono biovoice-numerals" style={{
        fontSize: 16, marginTop: 2,
        color: pass ? "var(--good)" : "var(--bad)",
      }}>{value}</div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 200,
  background: "rgba(4,7,13,0.78)", backdropFilter: "blur(8px)",
  display: "grid", placeItems: "center", padding: 20,
};

const panelStyle: CSSProperties = {
  width: "min(560px, 100%)",
  background: "linear-gradient(180deg, rgba(10,20,34,0.95), rgba(7,11,20,0.92))",
  border: "1px solid rgba(125,200,255,0.18)",
  borderRadius: 18,
  padding: 32,
  color: "var(--ink)",
  boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
};

const inputStyle: CSSProperties = {
  width: "100%", padding: "12px 14px", borderRadius: 10,
  background: "rgba(0,0,0,0.35)", color: "var(--ink)",
  border: "1px solid rgba(125,200,255,0.18)",
  fontFamily: "JetBrains Mono, monospace", fontSize: 14,
  minHeight: 44,
};

const statusStyle: CSSProperties = {
  padding: "12px 16px", borderRadius: 10,
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(125,200,255,0.18)",
  fontFamily: "JetBrains Mono, monospace", fontSize: 12,
  marginBottom: 14,
};

const qualityStyle: CSSProperties = {
  padding: "14px 16px", borderRadius: 10,
  background: "rgba(126,240,255,0.05)",
  border: "1px solid rgba(126,240,255,0.18)",
  marginBottom: 14,
};
