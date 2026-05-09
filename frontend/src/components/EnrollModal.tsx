// Operator-driven enrolment modal.
//
// Flow:
//  1. Operator types a user ID (lowercase letters / digits / - / _).
//  2. Picks a microphone from the device list (or sticks with the
//     browser default).
//  3. Captures samples by either:
//       a. Pressing "Start recording" → speaks → presses "Stop". No
//          time limit; live waveform + level meter + elapsed timer.
//       b. Pressing "Upload audio" → picks one or more files. mp3 /
//          m4a / wav / ogg are decoded in-browser to 16 kHz mono WAV
//          before posting.
//  4. Each sample posts to /enroll. Backend's quality gate scores it;
//     the row in the captured-samples list shows the verdict + reason.
//  5. Once ≥ 3 samples are accepted, the "Done" button enables. The
//     operator presses it whenever they're satisfied — no fixed cap.
//
// Backend min: `min_enrollment_samples = 3` (config.py). The modal
// surfaces that as the floor for enabling Done; nothing stops the
// operator from adding more.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { enrollSpeaker, type EnrollResult } from "../lib/api";
import {
  decodeAudioFileToWav,
  listAudioInputs,
  requestMicPermission,
  useVoiceRecorder,
  type AudioInputDevice,
} from "../lib/audio";
import { useRefreshSpeakers } from "../lib/session";

const MIN_ACCEPTED_FOR_DONE = 3;
const USER_ID_PATTERN = /^[a-z0-9_-]{2,32}$/;

type Quality = NonNullable<EnrollResult["quality"]>;

type Sample = {
  id: string;
  source: "record" | "upload";
  durationSec: number;
  accepted: boolean;
  quality: Quality | null;
  message: string;
  fileName: string;
};

interface EnrollModalProps {
  onClose: () => void;
  audio?: { samples?: Uint8Array; level?: number }; // unused — overlay parity with parent
}

export function EnrollModal({ onClose }: EnrollModalProps) {
  const [userId, setUserId] = useState("");
  const [samples, setSamples] = useState<Sample[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [showWaveform, setShowWaveform] = useState(false);

  const refreshSpeakers = useRefreshSpeakers();
  const recorder = useVoiceRecorder({
    minMs: 800,
    maxMs: null, // operator-controlled
    deviceId: deviceId || undefined,
  });

  const userIdValid = USER_ID_PATTERN.test(userId);
  const acceptedCount = samples.filter((s) => s.accepted).length;
  const canFinish = userIdValid && acceptedCount >= MIN_ACCEPTED_FOR_DONE;

  // -------- Mic device discovery --------
  const reloadDevices = useCallback(async () => {
    const list = await listAudioInputs();
    setDevices(list);
    // If the current selection no longer exists (mic unplugged), drop back
    // to default.
    if (deviceId && !list.some((d) => d.deviceId === deviceId)) {
      setDeviceId("");
    }
  }, [deviceId]);

  useEffect(() => {
    void reloadDevices();
    if (!navigator.mediaDevices?.addEventListener) return;
    const handler = () => void reloadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [reloadDevices]);

  const handleEnableMicLabels = useCallback(async () => {
    const ok = await requestMicPermission();
    if (!ok) {
      setError("Microphone access denied. Allow it in your browser to pick a specific input.");
      return;
    }
    await reloadDevices();
  }, [reloadDevices]);

  // -------- Sample submission --------
  const submitSample = useCallback(
    async (file: File, source: "record" | "upload", durationSec: number) => {
      if (!userIdValid) {
        setError("Type a valid User ID before adding samples.");
        return;
      }
      setBusy(true);
      setError(null);
      const sampleId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      try {
        const result = await enrollSpeaker(userId, file);
        // 200 → backend stored the sample. quality.acceptable is the
        // truth-bit; reason explains why if it isn't.
        const accepted = !!result.quality?.acceptable;
        setSamples((prev) => [
          ...prev,
          {
            id: sampleId,
            source,
            durationSec,
            accepted,
            quality: result.quality ?? null,
            message: result.message ?? (accepted ? "Accepted" : "Sample needs work"),
            fileName: file.name,
          },
        ]);
      } catch (e) {
        // 400 from the quality gate — surface the backend's reason
        // string in the row instead of a global error.
        const msg = e instanceof Error ? e.message : String(e);
        setSamples((prev) => [
          ...prev,
          {
            id: sampleId,
            source,
            durationSec,
            accepted: false,
            quality: null,
            message: msg.length > 200 ? msg.slice(0, 200) + "…" : msg,
            fileName: file.name,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [userId, userIdValid],
  );

  // -------- Recording controls --------
  const handleStart = useCallback(async () => {
    if (!userIdValid) {
      setError("Type a valid User ID before recording.");
      return;
    }
    setError(null);
    setShowWaveform(true);
    await recorder.start();
  }, [recorder, userIdValid]);

  const handleStop = useCallback(async () => {
    setShowWaveform(false);
    const rec = await recorder.stop();
    if (!rec) {
      setError(
        recorder.state === "denied"
          ? "Microphone access denied. Allow it in your browser settings."
          : "Recording too short — speak for at least a second.",
      );
      return;
    }
    await submitSample(rec.wavFile, "record", rec.durationSec);
  }, [recorder, submitSample]);

  // -------- File upload --------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleFilesPicked = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!userIdValid) {
        setError("Type a valid User ID before uploading samples.");
        return;
      }
      for (const file of Array.from(files)) {
        try {
          const wav = await decodeAudioFileToWav(file);
          // Estimate duration from blob byte size: 16-bit mono @ 16 kHz =
          // 32_000 bytes/s. Subtract the 44-byte WAV header.
          const dur = Math.max(0, (wav.size - 44) / 32_000);
          await submitSample(wav, "upload", dur);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(`Couldn't decode "${file.name}": ${msg}`);
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [submitSample, userIdValid],
  );

  // -------- Done / cancel --------
  const handleDone = useCallback(async () => {
    if (!canFinish) return;
    await refreshSpeakers();
    onClose();
  }, [canFinish, refreshSpeakers, onClose]);

  const handleCancel = useCallback(async () => {
    if (
      acceptedCount > 0 &&
      !window.confirm(
        `Cancel? ${acceptedCount} sample${acceptedCount === 1 ? "" : "s"} ` +
          `already stored on the server. The profile won't be usable until ` +
          `it has at least ${MIN_ACCEPTED_FOR_DONE} accepted samples — but ` +
          `you can re-open this modal later to add more.`,
      )
    ) {
      return;
    }
    if (recorder.state === "recording") recorder.cancel();
    await refreshSpeakers();
    onClose();
  }, [acceptedCount, recorder, refreshSpeakers, onClose]);

  const recording = recorder.state === "recording";
  const elapsed = formatElapsed(recorder.durationMs);

  return (
    <div role="dialog" aria-modal="true" aria-label="Enrol new profile" style={overlayStyle}>
      <div style={panelStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <div className="label-mono" style={{ fontSize: 11, color: "var(--teal-2)" }}>NEW PROFILE</div>
            <div style={{ fontSize: 28, fontWeight: 200, marginTop: 6 }}>Enrol a voice</div>
            <div style={{ fontSize: 13, color: "var(--ink-mute)", marginTop: 6, maxWidth: 520 }}>
              Capture or upload as many samples as you like. The backend
              gates each one on SNR, clipping, and speech ratio. Done
              enables once {MIN_ACCEPTED_FOR_DONE} samples are accepted.
            </div>
          </div>
          <button type="button" onClick={handleCancel} aria-label="Close" style={closeBtnStyle}>×</button>
        </div>

        {/* User ID */}
        <Field label="USER ID">
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value.toLowerCase())}
            placeholder="alice_demo"
            autoFocus
            style={inputStyle}
          />
          <Hint
            ok={userIdValid}
            okText="✓ valid"
            badText={
              userId === ""
                ? "2–32 chars · lowercase letters / digits / _ / -"
                : "✗ must match a–z 0–9 _ - (2–32 chars)"
            }
          />
        </Field>

        {/* Mic device picker */}
        <Field label="MICROPHONE">
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              disabled={recording}
              style={{ ...inputStyle, flex: 1, appearance: "none" }}
            >
              <option value="">Browser default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            {devices.every((d) => !d.label || d.label === "Microphone") && (
              <button type="button" onClick={handleEnableMicLabels} style={smallBtnStyle}>
                Enable labels
              </button>
            )}
          </div>
          <Hint
            ok
            okText={
              devices.length === 0
                ? "(no devices found yet — granting mic access reveals them)"
                : `${devices.length} input${devices.length === 1 ? "" : "s"} available`
            }
            badText=""
          />
        </Field>

        {/* Live feedback panel */}
        {showWaveform && (
          <LivePanel
            samples={recorder.samples}
            level={recorder.level}
            elapsed={elapsed}
            captureMode={recorder.state === "recording" ? "live" : "idle"}
          />
        )}

        {/* Recorder state badge — visible debug aid so the operator can see
            exactly where the recorder is in its state machine. */}
        <div style={stateBadgeStyle}>
          <span className="label-mono" style={{ fontSize: 9, color: "var(--ink-mute)" }}>RECORDER</span>
          <span className="label-mono" style={{
            fontSize: 10, padding: "3px 10px", borderRadius: 4,
            background: stateColor(recorder.state).bg,
            color: stateColor(recorder.state).fg,
            border: `1px solid ${stateColor(recorder.state).fg}33`,
            textTransform: "uppercase", letterSpacing: "0.08em",
          }}>{recorder.state}</span>
          {recorder.captureMode && (
            <span className="label-mono" style={{
              fontSize: 9, padding: "3px 8px", borderRadius: 4,
              background: "rgba(126,240,255,0.08)",
              color: "var(--ink-mute)",
              border: "1px solid rgba(126,240,255,0.18)",
              textTransform: "uppercase", letterSpacing: "0.08em",
            }} title={recorder.captureMode}>{shortMime(recorder.captureMode)}</span>
          )}
          {recorder.lastError && (
            <span style={{ fontSize: 10, color: "#ff7aa8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={recorder.lastError}>
              {recorder.lastError}
            </span>
          )}
          {!recorder.lastError && recorder.state === "denied" && (
            <span style={{ fontSize: 10, color: "#ff7aa8" }}>
              → check the mic icon in your browser's address bar
            </span>
          )}
        </div>

        {/* Capture controls */}
        <div style={{ display: "flex", gap: 12, marginTop: 18, marginBottom: 18, alignItems: "stretch" }}>
          {!recording ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!userIdValid || busy}
              onClick={handleStart}
              style={{ ...recordBtnStyle, background: "linear-gradient(180deg, #ff5577, #c8194a)" }}
            >
              <span style={dotStyle("#fff")}/>
              <span>START RECORDING</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={handleStop}
              style={{ ...recordBtnStyle, background: "linear-gradient(180deg, rgba(126,240,255,0.2), rgba(106,255,200,0.15))", border: "1px solid rgba(126,240,255,0.4)" }}
            >
              <span style={{ ...dotStyle("#7eF0FF"), animation: "pulse 0.9s infinite" }}/>
              <span>STOP — {elapsed}</span>
            </button>
          )}

          <button
            type="button"
            className="btn"
            disabled={!userIdValid || busy || recording}
            onClick={handleUploadClick}
            style={uploadBtnStyle}
          >
            <span style={{ fontSize: 16, marginRight: 8 }}>⤴</span>
            <span>UPLOAD AUDIO</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
            multiple
            onChange={(e) => void handleFilesPicked(e.target.files)}
            style={{ display: "none" }}
          />
        </div>

        {/* Errors */}
        {error && <div style={errorStyle}>{error}</div>}
        {busy && !recording && <div style={busyStyle}>Scoring sample…</div>}

        {/* Captured samples list */}
        <div>
          <div className="label-mono" style={{ fontSize: 10, marginBottom: 8, color: "var(--ink-mute)" }}>
            CAPTURED SAMPLES · {acceptedCount} accepted / {samples.length} total · {MIN_ACCEPTED_FOR_DONE} required
          </div>
          {samples.length === 0 ? (
            <div style={emptyListStyle}>
              No samples yet. Press <strong>START RECORDING</strong> or <strong>UPLOAD AUDIO</strong> to add some.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
              {samples.map((s, i) => (
                <SampleRow key={s.id} index={i + 1} sample={s} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", gap: 12, marginTop: 24, alignItems: "center" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canFinish || busy}
            onClick={handleDone}
            style={{
              flex: 1, justifyContent: "center", padding: "14px", fontSize: 13,
              opacity: canFinish ? 1 : 0.5,
            }}
          >
            {canFinish
              ? `DONE · ENROL ${userId} (${acceptedCount}/${MIN_ACCEPTED_FOR_DONE}+)`
              : `Need ${MIN_ACCEPTED_FOR_DONE - acceptedCount} more accepted sample${MIN_ACCEPTED_FOR_DONE - acceptedCount === 1 ? "" : "s"}`}
          </button>
          <button type="button" onClick={handleCancel} disabled={busy} style={cancelBtnStyle}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LivePanel({
  samples,
  level,
  elapsed,
  captureMode,
}: {
  samples: Uint8Array;
  level: number;
  elapsed: string;
  captureMode: "live" | "idle";
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Redraw on every render. The recorder mutates the samples Uint8Array
  // in place (same reference per tick), so a deps-array effect would
  // only fire once. No deps → fires every render, which is exactly the
  // RAF cadence the recorder forces.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const w = c.width = c.clientWidth * window.devicePixelRatio;
    const h = c.height = c.clientHeight * window.devicePixelRatio;
    ctx.clearRect(0, 0, w, h);

    // Background gradient.
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "rgba(7,16,28,0.4)");
    bg.addColorStop(1, "rgba(2,6,12,0.7)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Waveform polyline.
    ctx.strokeStyle = "rgba(126,240,255,0.85)";
    ctx.lineWidth = 1.4 * window.devicePixelRatio;
    ctx.beginPath();
    const sliceW = w / samples.length;
    for (let i = 0; i < samples.length; i += 1) {
      const v = (samples[i] - 128) / 128;
      const y = h / 2 + v * (h / 2) * 0.85;
      const x = i * sliceW;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Center line.
    ctx.strokeStyle = "rgba(126,240,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }); // intentional: redraw every render — see note above

  const levelPct = Math.min(100, level * 250); // RMS → percent (rough)

  return (
    <div style={livePanelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div className="label-mono" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
          LIVE FEEDBACK · 16 kHz mono
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {captureMode === "live" && (
            <span style={{ ...dotStyle("#ff5577"), animation: "pulse 0.9s infinite" }}/>
          )}
          <span className="num-mono biovoice-numerals" style={{ fontSize: 18, color: "var(--teal-2)" }}>
            {elapsed}
          </span>
        </div>
      </div>
      <canvas ref={canvasRef} style={{ width: "100%", height: 88, display: "block", borderRadius: 8 }}/>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <span className="label-mono" style={{ fontSize: 9, color: "var(--ink-mute)", minWidth: 36 }}>LEVEL</span>
        <div style={levelBarTrackStyle}>
          <div style={{
            ...levelBarFillStyle,
            width: `${levelPct}%`,
            background: levelPct > 80
              ? "linear-gradient(90deg, #6affc8, #ff7aa8)"
              : levelPct > 30
                ? "linear-gradient(90deg, #6affc8, #7eF0FF)"
                : "linear-gradient(90deg, #4a8cb8, #6affc8)",
          }}/>
        </div>
        <span className="num-mono" style={{ fontSize: 11, color: "var(--ink-mute)", minWidth: 30, textAlign: "right" }}>
          {levelPct.toFixed(0)}
        </span>
      </div>
    </div>
  );
}

function SampleRow({ index, sample }: { index: number; sample: Sample }) {
  const colour = sample.accepted ? "#6affc8" : "#ff7aa8";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", borderRadius: 8,
      background: sample.accepted ? "rgba(106,255,200,0.06)" : "rgba(255,122,168,0.06)",
      border: `1px solid ${sample.accepted ? "rgba(106,255,200,0.22)" : "rgba(255,122,168,0.22)"}`,
      fontSize: 12,
    }}>
      <span style={{
        width: 24, height: 24, borderRadius: "50%", border: `1.5px solid ${colour}`,
        display: "grid", placeItems: "center", color: colour, fontSize: 12, flexShrink: 0,
      }}>
        {sample.accepted ? "✓" : "✗"}
      </span>
      <span className="label-mono" style={{ color: "var(--ink-mute)", minWidth: 28, fontSize: 10 }}>#{index}</span>
      <span style={{ color: "var(--ink-mute)", fontSize: 10, textTransform: "uppercase", minWidth: 50 }}>
        {sample.source}
      </span>
      <span className="num-mono" style={{ minWidth: 50, color: "var(--ink-mute)", fontSize: 11 }}>
        {sample.durationSec.toFixed(1)}s
      </span>
      {sample.quality ? (
        <>
          <QStat label="SNR" value={`${sample.quality.snr_db.toFixed(0)}dB`} pass={sample.quality.snr_db >= 10}/>
          <QStat label="SPEECH" value={`${(sample.quality.speech_ratio * 100).toFixed(0)}%`} pass={sample.quality.speech_ratio >= 0.3}/>
          <QStat label="SCORE" value={sample.quality.score.toFixed(0)} pass={sample.accepted}/>
        </>
      ) : (
        <span style={{ color: "#ff7aa8", flex: 1, fontSize: 11 }}>{sample.message}</span>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="label-mono" style={{ fontSize: 10, marginBottom: 6, color: "var(--ink-mute)" }}>{label}</div>
      {children}
    </div>
  );
}

function Hint({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <div className="label-mono" style={{
      fontSize: 9, marginTop: 6,
      color: ok ? "var(--ink-mute)" : "var(--bad)",
    }}>
      {ok ? okText : badText}
    </div>
  );
}

function QStat({ label, value, pass }: { label: string; value: string; pass: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 64 }}>
      <span className="label-mono" style={{ fontSize: 8, color: "var(--ink-mute)" }}>{label}</span>
      <span className="num-mono biovoice-numerals" style={{ fontSize: 12, color: pass ? "var(--good)" : "var(--bad)" }}>{value}</span>
    </span>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const overlayStyle: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 200,
  background: "rgba(4,7,13,0.78)", backdropFilter: "blur(8px)",
  display: "grid", placeItems: "center", padding: 20,
};

const panelStyle: CSSProperties = {
  width: "min(680px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: "linear-gradient(180deg, rgba(10,20,34,0.95), rgba(7,11,20,0.92))",
  border: "1px solid rgba(125,200,255,0.18)",
  borderRadius: 18,
  padding: 28,
  color: "var(--ink)",
  boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
};

const headerStyle: CSSProperties = {
  display: "flex", justifyContent: "space-between",
  alignItems: "flex-start", marginBottom: 20,
};

const closeBtnStyle: CSSProperties = {
  width: 36, height: 36, borderRadius: "50%",
  background: "transparent", color: "var(--ink-mute)",
  border: "1px solid rgba(125,200,255,0.18)",
  cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0,
};

const inputStyle: CSSProperties = {
  width: "100%", padding: "11px 14px", borderRadius: 10,
  background: "rgba(0,0,0,0.35)", color: "var(--ink)",
  border: "1px solid rgba(125,200,255,0.18)",
  fontFamily: "JetBrains Mono, monospace", fontSize: 13,
  minHeight: 42,
};

const smallBtnStyle: CSSProperties = {
  padding: "8px 12px", fontSize: 11,
  background: "transparent", color: "var(--teal-2)",
  border: "1px solid rgba(126,240,255,0.3)",
  borderRadius: 8, cursor: "pointer",
  whiteSpace: "nowrap",
};

const livePanelStyle: CSSProperties = {
  padding: 14, borderRadius: 12,
  background: "linear-gradient(180deg, rgba(0,0,0,0.4), rgba(7,11,20,0.6))",
  border: "1px solid rgba(126,240,255,0.25)",
  marginBottom: 6,
  marginTop: 4,
};

const recordBtnStyle: CSSProperties = {
  flex: 1, padding: "16px 20px", fontSize: 13,
  display: "flex", alignItems: "center", justifyContent: "center",
  gap: 10, color: "#fff", border: "none", borderRadius: 10,
  cursor: "pointer", minHeight: 52, fontWeight: 600,
  letterSpacing: "0.06em",
};

const uploadBtnStyle: CSSProperties = {
  padding: "16px 22px", fontSize: 12,
  background: "transparent", color: "var(--teal-2)",
  border: "1px solid rgba(126,240,255,0.35)",
  borderRadius: 10, cursor: "pointer", minHeight: 52,
  display: "flex", alignItems: "center", gap: 4,
  letterSpacing: "0.06em", fontWeight: 600,
};

const cancelBtnStyle: CSSProperties = {
  padding: "14px 22px", fontSize: 12,
  background: "transparent", color: "var(--ink-mute)",
  border: "1px solid rgba(125,200,255,0.18)", borderRadius: 10,
  cursor: "pointer", minHeight: 44,
};

const errorStyle: CSSProperties = {
  padding: "10px 14px", borderRadius: 10,
  background: "rgba(255,128,128,0.08)",
  border: "1px solid rgba(255,128,128,0.35)",
  color: "#ffadad", fontSize: 12, marginBottom: 12,
};

const busyStyle: CSSProperties = {
  padding: "10px 14px", borderRadius: 10,
  background: "rgba(126,240,255,0.05)",
  border: "1px solid rgba(126,240,255,0.25)",
  color: "var(--teal-2)", fontSize: 12, marginBottom: 12,
};

const emptyListStyle: CSSProperties = {
  padding: "16px 18px", borderRadius: 10,
  border: "1px dashed rgba(125,200,255,0.2)",
  color: "var(--ink-mute)", fontSize: 12, textAlign: "center",
};

const levelBarTrackStyle: CSSProperties = {
  flex: 1, height: 8, borderRadius: 4,
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(125,200,255,0.15)",
  overflow: "hidden",
};

const levelBarFillStyle: CSSProperties = {
  height: "100%", borderRadius: 4,
  transition: "width 80ms linear",
};

function dotStyle(colour: string): CSSProperties {
  return {
    display: "inline-block",
    width: 10, height: 10, borderRadius: "50%",
    background: colour, flexShrink: 0,
  };
}

const stateBadgeStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "8px 12px", borderRadius: 8,
  background: "rgba(0,0,0,0.25)",
  border: "1px solid rgba(125,200,255,0.12)",
  marginTop: 12,
};

function shortMime(mime: string): string {
  // "audio/webm;codecs=opus" → "webm/opus"
  // "audio/mp4;codecs=mp4a.40.2" → "mp4/aac"
  // "audio/ogg" → "ogg"
  const lower = mime.toLowerCase();
  if (lower.includes("opus")) return "webm/opus";
  if (lower.includes("mp4a") || lower.includes("aac")) return "mp4/aac";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("webm")) return "webm";
  if (lower.includes("mp4")) return "mp4";
  if (lower.includes("mpeg")) return "mp3";
  return "audio";
}

function stateColor(state: string): { fg: string; bg: string } {
  switch (state) {
    case "recording":   return { fg: "#ff5577", bg: "rgba(255,85,119,0.12)" };
    case "requesting":  return { fg: "#7eF0FF", bg: "rgba(126,240,255,0.12)" };
    case "denied":      return { fg: "#ff7aa8", bg: "rgba(255,122,168,0.12)" };
    case "error":       return { fg: "#ff7aa8", bg: "rgba(255,122,168,0.12)" };
    case "stopped":     return { fg: "#6affc8", bg: "rgba(106,255,200,0.12)" };
    default:            return { fg: "#9ab0c8", bg: "rgba(154,176,200,0.08)" };
  }
}
