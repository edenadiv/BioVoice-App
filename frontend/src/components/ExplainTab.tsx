import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FC } from "react";
import { embedAudio, explainAudio, type ExplainResult, type ModelCAM, type ExplainModelKey } from "../lib/api";
import { decodeFileToBuffer, playSalient, playSegment, sliceBufferToFloat32, type SalientPlayback } from "../lib/explainAudio";
import { useEmbeddingProjection } from "../hooks/useEmbeddingProjection";
import { projectPCA3 } from "../lib/pca";
import { nearestByCosine, type CosineMatch } from "../lib/embeddingMatch";
import { InfoButton } from "./InfoButton";
// EmbeddingConstellation is the Dashboard's voice-space visual (untyped .jsx);
// its props infer as `null` from JS defaults, so type it loosely here.
import { EmbeddingConstellation as EmbeddingConstellationImpl } from "../console-ext.jsx";
const EmbeddingConstellation = EmbeddingConstellationImpl as unknown as FC<Record<string, unknown>>;

type HeatZonePoint = { point: [number, number, number]; label: string; peak: number };

interface ExplainTabProps {
  wavFile: File | Blob | null;
  open: boolean;
  matchUserId?: string | null;
  panelWidth?: number;
  specWidth?: number;
  specHeight?: number;
  /** "tabs" = one heatmap at a time (compact). "grid" = every model's
   *  Grad-CAM spectrogram side by side for comparison. */
  layout?: "tabs" | "grid";
}

const MODEL_LABELS: Record<string, string> = {
  aasist: "AASIST · anti-spoof",
  redimnet_b5: "ReDimNet · speaker",
  ecapa_voxceleb: "ECAPA · speaker",
};

const SPEC_W = 600;
const SPEC_H = 180;
// Compact per-model tile dimensions used in grid layout.
const GRID_SPEC_W = 440;
const GRID_SPEC_H = 150;

export function ExplainTab({ wavFile, open, matchUserId, panelWidth = 340, specWidth = SPEC_W, specHeight = SPEC_H, layout = "tabs" }: ExplainTabProps) {
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [activeModel, setActiveModel] = useState<ExplainModelKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const playbackRef = useRef<SalientPlayback | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [heatZones, setHeatZones] = useState<HeatZonePoint[]>([]);
  // The enrolled speaker the Grad-CAM region embedding sits closest to, by
  // true cosine similarity over the raw 192-d space (not PCA proximity).
  const [nearest, setNearest] = useState<CosineMatch | null>(null);
  // Same enrolled embeddings + deterministic PCA basis the Console
  // constellation uses, so heat-zone points share its coordinate system.
  const projection = useEmbeddingProjection("redimnet_b5", matchUserId ?? "");

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

  // Embed the active model's salient regions and place the result in the
  // voice-space orb, so you can see which enrolled speaker the Grad-CAM
  // evidence sits closest to. The encoder needs ≥1s of speech but single
  // salient segments are shorter, so concatenate the model's salient regions
  // — the exact audio it attended to — into one waveform and embed that once.
  // Fall back to the whole clip when the salient total is too short.
  useEffect(() => {
    const basis = projection.basis;
    const buffer = bufferRef.current;
    if (!open || !result || !basis || !buffer) {
      setHeatZones([]);
      setNearest(null);
      return;
    }
    const cam = result.cams.find((c) => c.modelKey === activeModel) ?? result.cams[0] ?? null;
    if (!cam) {
      setHeatZones([]);
      setNearest(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const sr = buffer.sampleRate;
      const parts = cam.salientSegments.map((s) => sliceBufferToFloat32(buffer, s.startMs, s.endMs));
      const total = parts.reduce((n, p) => n + p.length, 0);
      let waveform: Float32Array;
      if (total >= sr) {
        waveform = new Float32Array(total);
        let off = 0;
        for (const p of parts) {
          waveform.set(p, off);
          off += p.length;
        }
      } else {
        waveform = buffer.getChannelData(0).slice();
      }
      let embedding: number[];
      try {
        const res = await embedAudio(waveform, sr, "redimnet_b5");
        embedding = res.embedding;
      } catch {
        if (!cancelled) {
          setHeatZones([]);
          setNearest(null);
        }
        return;
      }
      if (cancelled) return;
      const peak = cam.salientSegments.reduce((m, s) => Math.max(m, s.peak), 0) || 1;
      setHeatZones([{ point: projectPCA3(embedding, basis), label: "Grad-CAM", peak }]);
      const candidates = projection.profiles.map((p) => ({ userId: p.userId, vector: p.centroidRaw }));
      setNearest(nearestByCosine(embedding, candidates));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, result, activeModel, projection.basis, projection.profiles]);

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
    <aside style={{ ...panelStyle, width: panelWidth }}>
      <header style={headerStyle}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Grad-CAM{matchUserId ? ` · vs ${matchUserId}` : ""}
          <InfoButton k="explain.gradcam" />
        </span>
        {bufferRef.current && (
          <button type="button" style={origBtnStyle} onClick={handlePlayOriginal}>
            {playingKey === "__original__" ? "■ stop" : "▶ original"}
          </button>
        )}
      </header>

      {loading && <div style={mutedStyle}>Computing attribution…</div>}
      {error && <div style={errorStyle}>{error}</div>}

      {/* Grid layout — every model's Grad-CAM spectrogram side by side. */}
      {layout === "grid" && result && cams.length > 0 && (
        <div style={gridStyle}>
          {cams.map((cam) => (
            <ModelCAMTile
              key={cam.modelKey}
              cam={cam}
              spectrogram={result.spectrogram}
              durationMs={durationMs}
              playheadMs={playheadMs}
              playingKey={playingKey}
              onPlaySegment={handlePlaySegment}
              onPlaySalient={handlePlaySalient}
              pctOf={pctOf}
            />
          ))}
        </div>
      )}

      {/* Tabs layout — one heatmap at a time (compact). */}
      {layout === "tabs" && activeCam && result && (
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
            specWidth={specWidth}
            specHeight={specHeight}
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

      {result && (projection.profiles.length > 0 || heatZones.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#d67cff" }}>
            Voice space · heat zones{nearest ? ` · closest ${nearest.userId}` : ""}
            <InfoButton k="explain.voicespace" />
          </div>
          <EmbeddingConstellation
            width={Math.max(280, panelWidth - 28)}
            height={260}
            projectedProfiles={projection.profiles}
            heatZonePoints={heatZones}
            heatZoneTargetId={nearest?.userId ?? matchUserId ?? null}
            matchId={nearest?.userId ?? matchUserId ?? null}
            loading={projection.loading}
          />
          <div style={mutedStyle}>
            {nearest ? (
              <>closest enrolled speaker: <span style={{ color: "#d67cff" }}>{nearest.userId}</span> · {(nearest.similarity * 100).toFixed(1)}% cosine · magenta = Grad-CAM embedding, dashed link → nearest</>
            ) : (
              <>magenta = Grad-CAM embedding · enroll a speaker to compare</>
            )}
          </div>
        </div>
      )}

      {result && cams.length === 0 && <div style={mutedStyle}>No explainable models loaded.</div>}
    </aside>
  );
}

interface TileProps {
  cam: ModelCAM;
  spectrogram: number[][];
  durationMs: number;
  playheadMs: number | null;
  playingKey: string | null;
  onPlaySegment: (startMs: number, endMs: number, key: string) => void;
  onPlaySalient: (cam: ModelCAM) => void;
  pctOf: (ms: number) => number;
}

// One model's Grad-CAM spectrogram as a uniform tile, so every model in
// the grid reads the same way and is easy to compare side by side.
function ModelCAMTile({ cam, spectrogram, durationMs, playheadMs, playingKey, onPlaySegment, onPlaySalient, pctOf }: TileProps) {
  const coverPct = Math.round(cam.salientSegments.reduce((a, s) => a + pctOf(s.endMs - s.startMs), 0));
  const hasSegments = cam.salientSegments.length > 0;
  return (
    <div style={tileStyle}>
      <div style={tileHeaderStyle}>
        <span>{MODEL_LABELS[cam.modelKey] ?? cam.modelKey}</span>
        <button
          type="button"
          style={hasSegments ? tileSalientBtnStyle : { ...tileSalientBtnStyle, opacity: 0.4, cursor: "not-allowed" }}
          onClick={() => onPlaySalient(cam)}
          disabled={!hasSegments}
        >
          {playingKey === `salient:${cam.modelKey}` ? "■ stop" : "▶ salient"}
        </button>
      </div>
      <SpectrogramOverlay
        spectrogram={spectrogram}
        cam={cam}
        durationMs={durationMs}
        playheadMs={playheadMs}
        activePlayKey={playingKey}
        onPlaySegment={onPlaySegment}
        pctOf={pctOf}
        specWidth={GRID_SPEC_W}
        specHeight={GRID_SPEC_H}
      />
      <div style={tileFooterStyle}>
        {cam.salientSegments.length} seg · {coverPct}% of clip · thr {cam.threshold.toFixed(2)}
      </div>
    </div>
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
  specWidth: number;
  specHeight: number;
}

function SpectrogramOverlay({ spectrogram, cam, durationMs, playheadMs, activePlayKey, onPlaySegment, pctOf, specWidth, specHeight }: OverlayProps) {
  const specRef = useRef<HTMLCanvasElement | null>(null);
  const heatRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (specRef.current) drawSpectrogram(specRef.current, spectrogram);
  }, [spectrogram, specWidth, specHeight]);

  useEffect(() => {
    if (heatRef.current) drawHeatmap(heatRef.current, cam);
  }, [cam, specWidth, specHeight]);

  return (
    <div style={{ ...specWrapStyle, height: specHeight }}>
      <canvas ref={specRef} width={specWidth} height={specHeight} style={layerStyle} />
      <canvas ref={heatRef} width={specWidth} height={specHeight} style={layerStyle} />
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
  fontSize: 14,
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
  fontSize: 11,
  letterSpacing: "0.06em",
  cursor: "pointer",
  textTransform: "none",
};

const gridStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  justifyContent: "center",
};

const tileStyle: CSSProperties = {
  flex: "1 1 340px",
  minWidth: 0,
  maxWidth: 480,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  background: "rgba(8, 14, 24, 0.55)",
  border: "1px solid rgba(126, 240, 255, 0.16)",
  borderRadius: 10,
};

const tileHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 14,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "#7ef0ff",
};

const tileSalientBtnStyle: CSSProperties = {
  background: "rgba(126, 240, 255, 0.12)",
  border: "1px solid rgba(126, 240, 255, 0.4)",
  color: "#7ef0ff",
  padding: "3px 9px",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 11,
  letterSpacing: "0.04em",
  cursor: "pointer",
  textTransform: "none",
};

const tileFooterStyle: CSSProperties = {
  fontSize: 12,
  color: "#6f8aa3",
  letterSpacing: "0.02em",
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
  fontSize: 13,
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
  fontSize: 10,
  color: "#6f8aa3",
  pointerEvents: "none",
};

const rowFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 13,
  gap: 8,
};

const playBtnStyle: CSSProperties = {
  background: "rgba(126, 240, 255, 0.12)",
  border: "1px solid rgba(126, 240, 255, 0.4)",
  color: "#7ef0ff",
  padding: "4px 10px",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
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
  fontSize: 13,
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
  fontSize: 13,
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
  fontSize: 13,
};

const errorStyle: CSSProperties = {
  color: "#ff7aa8",
  fontSize: 14,
};
