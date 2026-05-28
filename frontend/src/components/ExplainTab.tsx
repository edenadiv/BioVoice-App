import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { explainAudio, type ExplainResult, type ModelCAM, type ExplainModelKey } from "../lib/api";
import { decodeFileToBuffer, playSalient, playSegment, type SalientPlayback } from "../lib/explainAudio";

interface ExplainTabProps {
  wavFile: File | Blob | null;
  open: boolean;
  matchUserId?: string | null;
}

const MODEL_LABELS: Record<string, string> = {
  aasist: "AASIST · anti-spoof",
  redimnet_b5: "ReDimNet · speaker",
  ecapa_voxceleb: "ECAPA · speaker",
};

const SPEC_W = 600;
const SPEC_H = 180;

export function ExplainTab({ wavFile, open, matchUserId }: ExplainTabProps) {
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [activeModel, setActiveModel] = useState<ExplainModelKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const playbackRef = useRef<SalientPlayback | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !wavFile) return;
    let cancelled = false;
    setResult(null);
    setActiveModel(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const file = wavFile instanceof File ? wavFile : new File([wavFile], "probe.wav", { type: "audio/wav" });
        const [res, buffer] = await Promise.all([
          explainAudio(file, matchUserId ?? undefined),
          decodeFileToBuffer(wavFile),
        ]);
        if (cancelled) return;
        bufferRef.current = buffer;
        setResult(res);
        setActiveModel(res.cams[0]?.modelKey ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Explain failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, wavFile, matchUserId]);

  useEffect(() => {
    return () => {
      playbackRef.current?.stop();
    };
  }, []);

  const startPlayback = useCallback((key: string, pb: SalientPlayback) => {
    playbackRef.current?.stop();
    playbackRef.current = pb;
    setPlayingKey(key);
    void pb.promise.then(() => {
      setPlayingKey((cur) => (cur === key ? null : cur));
      setPlayheadMs((cur) => (cur !== null ? null : cur));
    });
  }, []);

  const stopPlayback = useCallback(() => {
    playbackRef.current?.stop();
    setPlayingKey(null);
    setPlayheadMs(null);
  }, []);

  const handlePlayOriginal = useCallback(() => {
    if (!bufferRef.current) return;
    if (playingKey === "__original__") { stopPlayback(); return; }
    startPlayback("__original__", playSalient(bufferRef.current, null, { onTick: setPlayheadMs }));
  }, [playingKey, startPlayback, stopPlayback]);

  const handlePlaySalient = useCallback((cam: ModelCAM) => {
    if (!bufferRef.current || cam.salientSegments.length === 0) return;
    const key = `salient:${cam.modelKey}`;
    if (playingKey === key) { stopPlayback(); return; }
    startPlayback(key, playSalient(bufferRef.current, cam.salientSegments, { onTick: setPlayheadMs }));
  }, [playingKey, startPlayback, stopPlayback]);

  const handlePlaySegment = useCallback((startMs: number, endMs: number, key: string) => {
    if (!bufferRef.current) return;
    if (playingKey === key) { stopPlayback(); return; }
    startPlayback(key, playSegment(bufferRef.current, startMs, endMs, { onTick: setPlayheadMs }));
  }, [playingKey, startPlayback, stopPlayback]);

  if (!open) return null;

  const cams = result?.cams ?? [];
  const activeCam = cams.find((c) => c.modelKey === activeModel) ?? cams[0] ?? null;
  const durationMs = result?.durationMs ?? 0;
  const pctOf = (ms: number) => (durationMs > 0 ? (100 * ms) / durationMs : 0);

  return (
    <aside style={panelStyle}>
      <header style={headerStyle}>
        <span>Grad-CAM{matchUserId ? ` · vs ${matchUserId}` : ""}</span>
        {bufferRef.current && (
          <button type="button" style={origBtnStyle} onClick={handlePlayOriginal}>
            {playingKey === "__original__" ? "■ stop" : "▶ original"}
          </button>
        )}
      </header>

      {loading && <div style={mutedStyle}>Computing attribution…</div>}
      {error && <div style={errorStyle}>{error}</div>}

      {activeCam && result && (
        <>
          <div style={tabsStyle}>
            {cams.map((cam) => {
              const on = cam.modelKey === activeCam.modelKey;
              return (
                <button
                  key={cam.modelKey}
                  type="button"
                  style={on ? tabActiveStyle : tabStyle}
                  onClick={() => setActiveModel(cam.modelKey)}
                  title={MODEL_LABELS[cam.modelKey] ?? cam.modelKey}
                >
                  {(MODEL_LABELS[cam.modelKey] ?? cam.modelKey).split(" · ")[0]}
                </button>
              );
            })}
          </div>

          <SpectrogramOverlay
            spectrogram={result.spectrogram}
            cam={activeCam}
            durationMs={durationMs}
            playheadMs={playheadMs}
            activePlayKey={playingKey}
            onPlaySegment={handlePlaySegment}
            pctOf={pctOf}
          />

          <div style={rowFooterStyle}>
            <button
              type="button"
              style={activeCam.salientSegments.length > 0 ? playBtnStyle : playBtnDisabledStyle}
              onClick={() => handlePlaySalient(activeCam)}
              disabled={activeCam.salientSegments.length === 0}
            >
              {playingKey === `salient:${activeCam.modelKey}` ? "■ stop" : "▶ play salient"}
            </button>
            <span style={mutedStyle}>
              {activeCam.salientSegments.length} seg ·{" "}
              {Math.round(
                activeCam.salientSegments.reduce((a, s) => a + pctOf(s.endMs - s.startMs), 0),
              )}
              % of clip · thr {activeCam.threshold.toFixed(2)}
            </span>
          </div>

          {activeCam.salientSegments.length > 0 && (
            <ul style={segListStyle}>
              {activeCam.salientSegments.map((s, i) => {
                const key = `seg:${activeCam.modelKey}:${i}`;
                return (
                  <li key={i}>
                    <button
                      type="button"
                      style={playingKey === key ? segBtnActiveStyle : segBtnStyle}
                      onClick={() => handlePlaySegment(s.startMs, s.endMs, key)}
                    >
                      {playingKey === key ? "■" : "▶"} {(s.startMs / 1000).toFixed(2)}s – {(s.endMs / 1000).toFixed(2)}s
                      <span style={mutedStyle}> · peak {s.peak.toFixed(2)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {result && cams.length === 0 && <div style={mutedStyle}>No explainable models loaded.</div>}
    </aside>
  );
}

interface OverlayProps {
  spectrogram: number[][];
  cam: ModelCAM;
  durationMs: number;
  playheadMs: number | null;
  activePlayKey: string | null;
  onPlaySegment: (startMs: number, endMs: number, key: string) => void;
  pctOf: (ms: number) => number;
}

function SpectrogramOverlay({ spectrogram, cam, durationMs, playheadMs, activePlayKey, onPlaySegment, pctOf }: OverlayProps) {
  const specRef = useRef<HTMLCanvasElement | null>(null);
  const heatRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (specRef.current) drawSpectrogram(specRef.current, spectrogram);
  }, [spectrogram]);

  useEffect(() => {
    if (heatRef.current) drawHeatmap(heatRef.current, cam);
  }, [cam]);

  return (
    <div style={specWrapStyle}>
      <canvas ref={specRef} width={SPEC_W} height={SPEC_H} style={layerStyle} />
      <canvas ref={heatRef} width={SPEC_W} height={SPEC_H} style={layerStyle} />
      {/* Clickable salient bands over the time axis. */}
      {cam.salientSegments.map((s, i) => {
        const key = `seg:${cam.modelKey}:${i}`;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onPlaySegment(s.startMs, s.endMs, key)}
            title={`${(s.startMs / 1000).toFixed(2)}s – ${(s.endMs / 1000).toFixed(2)}s · click to play`}
            style={{
              ...bandStyle,
              left: `${pctOf(s.startMs)}%`,
              width: `${pctOf(s.endMs - s.startMs)}%`,
              ...(activePlayKey === key ? bandActiveStyle : null),
            }}
          />
        );
      })}
      {playheadMs !== null && durationMs > 0 && (
        <div style={{ ...playheadStyle, left: `${Math.min(100, Math.max(0, pctOf(playheadMs)))}%` }} />
      )}
      <div style={axisStyle}>
        <span>0.00s</span>
        <span>{(durationMs / 1000).toFixed(2)}s</span>
      </div>
    </div>
  );
}

function drawSpectrogram(canvas: HTMLCanvasElement, grid: number[][]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const T = grid.length;
  const F = grid[0]?.length ?? 0;
  if (T === 0 || F === 0) {
    ctx.clearRect(0, 0, W, H);
    return;
  }
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const fIdx = Math.floor(((H - 1 - y) / H) * F);
    for (let x = 0; x < W; x++) {
      const tIdx = Math.floor((x / W) * T);
      const v = grid[tIdx][fIdx] ?? 0;
      const [r, g, b] = specRamp(v);
      const o = (y * W + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawHeatmap(canvas: HTMLCanvasElement, cam: ModelCAM) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const T = cam.heatmap.length;
  const F = cam.heatmap[0]?.length ?? 0;
  ctx.clearRect(0, 0, W, H);
  if (T === 0 || F === 0) return;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const fIdx = Math.floor(((H - 1 - y) / H) * F);
    for (let x = 0; x < W; x++) {
      const tIdx = Math.floor((x / W) * T);
      const v = cam.heatmap[tIdx][fIdx] ?? 0;
      const [r, g, b] = hotRamp(v);
      const o = (y * W + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      // Alpha by activation → low activation stays transparent so the
      // spectrogram shows through; bright regions = where the model looked.
      img.data[o + 3] = Math.floor(Math.max(0, Math.min(1, v)) ** 0.75 * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Spectrogram base: dark navy → teal → cyan.
function specRamp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  return [Math.floor(8 + 30 * x), Math.floor(20 + 170 * x), Math.floor(36 + 200 * x)];
}

// Heatmap overlay: warm orange → red → white, contrasts with the teal base.
function hotRamp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  const r = 255;
  const g = Math.floor(220 * Math.max(0, 1 - x) + 40 * x);
  const b = Math.floor(60 * Math.max(0, 1 - 1.4 * x));
  return [r, g, b];
}

const panelStyle: CSSProperties = {
  width: 340,
  padding: 14,
  background: "rgba(8, 14, 24, 0.7)",
  border: "1px solid rgba(126, 240, 255, 0.18)",
  borderRadius: 12,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  fontFamily: "JetBrains Mono, monospace",
  color: "#cfe9ff",
};

const headerStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#7ef0ff",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const origBtnStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(126, 240, 255, 0.4)",
  color: "#7ef0ff",
  padding: "3px 8px",
  borderRadius: 5,
  fontFamily: "inherit",
  fontSize: 9,
  letterSpacing: "0.06em",
  cursor: "pointer",
  textTransform: "none",
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

const tabStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(126, 240, 255, 0.25)",
  color: "#8fb4cc",
  padding: "4px 10px",
  borderRadius: 999,
  fontFamily: "inherit",
  fontSize: 10,
  cursor: "pointer",
};

const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  background: "rgba(126, 240, 255, 0.14)",
  border: "1px solid rgba(126, 240, 255, 0.6)",
  color: "#7ef0ff",
};

const specWrapStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: SPEC_H,
  borderRadius: 8,
  overflow: "hidden",
  border: "1px solid rgba(126, 240, 255, 0.15)",
};

const layerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
};

const bandStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 14,
  background: "rgba(126, 240, 255, 0.10)",
  border: "1px solid rgba(126, 240, 255, 0.45)",
  borderRadius: 3,
  padding: 0,
  cursor: "pointer",
};

const bandActiveStyle: CSSProperties = {
  background: "rgba(255, 200, 90, 0.22)",
  border: "1px solid rgba(255, 200, 90, 0.8)",
};

const playheadStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 14,
  width: 2,
  background: "#ffffff",
  boxShadow: "0 0 8px rgba(255,255,255,0.8)",
  pointerEvents: "none",
};

const axisStyle: CSSProperties = {
  position: "absolute",
  left: 4,
  right: 4,
  bottom: 1,
  display: "flex",
  justifyContent: "space-between",
  fontSize: 8,
  color: "#6f8aa3",
  pointerEvents: "none",
};

const rowFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 10,
  gap: 8,
};

const playBtnStyle: CSSProperties = {
  background: "rgba(126, 240, 255, 0.12)",
  border: "1px solid rgba(126, 240, 255, 0.4)",
  color: "#7ef0ff",
  padding: "4px 10px",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 10,
  cursor: "pointer",
  flexShrink: 0,
};

const playBtnDisabledStyle: CSSProperties = {
  ...playBtnStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const segListStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  fontSize: 10,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  maxHeight: 110,
  overflowY: "auto",
};

const segBtnStyle: CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "rgba(125, 200, 255, 0.04)",
  border: "1px solid rgba(126, 240, 255, 0.18)",
  color: "#cfe9ff",
  padding: "4px 8px",
  borderRadius: 5,
  fontFamily: "inherit",
  fontSize: 10,
  cursor: "pointer",
};

const segBtnActiveStyle: CSSProperties = {
  ...segBtnStyle,
  background: "rgba(255, 200, 90, 0.12)",
  border: "1px solid rgba(255, 200, 90, 0.5)",
  color: "#ffe6b0",
};

const mutedStyle: CSSProperties = {
  color: "#6f8aa3",
  fontSize: 10,
};

const errorStyle: CSSProperties = {
  color: "#ff7aa8",
  fontSize: 11,
};
