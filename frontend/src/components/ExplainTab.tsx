import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FC, ReactNode } from "react";
import { camFaithfulness, embedAudio, explainAudio, type CamFaithfulness, type CamFaithModel, type ExplainResult, type ModelCAM, type ExplainModelKey } from "../lib/api";
import { complementSegments, decodeFileToBuffer, playSalient, playSegment, sliceBufferToFloat32, type SalientPlayback } from "../lib/explainAudio";
import { useEmbeddingProjection } from "../hooks/useEmbeddingProjection";
import { projectPCA3 } from "../lib/pca";
import { nearestByCosine, type CosineMatch } from "../lib/embeddingMatch";
import { InfoButton } from "./InfoButton";
// EmbeddingConstellation is the Dashboard's voice-space visual (untyped .jsx);
// its props infer as `null` from JS defaults, so type it loosely here.
import { EmbeddingConstellation as EmbeddingConstellationImpl } from "../console-ext.jsx";
const EmbeddingConstellation = EmbeddingConstellationImpl as unknown as FC<Record<string, unknown>>;

type HeatZonePoint = { point: [number, number, number]; label: string; peak: number; color?: string };

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
  // Faithfulness check — mask the clip to each model's salient region and
  // re-run, to prove the Grad-CAM marks what the model actually used.
  const [faith, setFaith] = useState<CamFaithfulness | null>(null);
  const [faithLoading, setFaithLoading] = useState(false);
  const [faithError, setFaithError] = useState<string | null>(null);
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
    setFaith(null);
    setFaithError(null);
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

  // Play an arbitrary set of bands (salient region for "retain", its
  // complement for "delete"), gated over the full clip so the playhead still
  // tracks the spectrogram.
  const handlePlayBands = useCallback((key: string, segments: { startMs: number; endMs: number; peak: number }[]) => {
    if (!bufferRef.current || segments.length === 0) return;
    if (playingKey === key) { stopPlayback(); return; }
    startPlayback(key, playSalient(bufferRef.current, segments, { onTick: setPlayheadMs }));
  }, [playingKey, startPlayback, stopPlayback]);

  const runFaithfulness = useCallback(async () => {
    if (!wavFile) return;
    setFaithLoading(true);
    setFaithError(null);
    setFaith(null);
    try {
      const file = wavFile instanceof File ? wavFile : new File([wavFile], "probe.wav", { type: "audio/wav" });
      setFaith(await camFaithfulness(file, matchUserId ?? undefined));
    } catch (err) {
      setFaithError(err instanceof Error ? err.message : "Faithfulness check failed");
    } finally {
      setFaithLoading(false);
    }
  }, [wavFile, matchUserId]);

  if (!open) return null;

  const cams = result?.cams ?? [];
  const activeCam = cams.find((c) => c.modelKey === activeModel) ?? cams[0] ?? null;
  const durationMs = result?.durationMs ?? 0;
  const pctOf = (ms: number) => (durationMs > 0 ? (100 * ms) / durationMs : 0);
  // The redimnet variant carries the embeddings for the voice-space scatter.
  const faithModel = faith?.models.find((m) => m.modelKey === "redimnet_b5" && m.originalEmbedding.length > 0) ?? null;

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

      {result && cams.length > 0 && (
        <FaithfulnessPanel
          faith={faith}
          loading={faithLoading}
          error={faithError}
          onRun={runFaithfulness}
          durationMs={durationMs}
          playingKey={playingKey}
          canPlay={!!bufferRef.current}
          onPlayBands={handlePlayBands}
        />
      )}

      {result && faithModel ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "#d67cff" }}>
            Voice space · masked vs full
            <InfoButton k="explain.voicespace" />
          </div>
          <FaithScatter
            size={Math.max(260, Math.min(panelWidth - 28, 340))}
            targetId={matchUserId ?? faithModel.targetUserId}
            profiles={projection.profiles}
            model={faithModel}
          />
          <div style={mutedStyle}>
            centre = <span style={{ color: "#d67cff" }}>{matchUserId ?? faithModel.targetUserId ?? "target"}</span> · closer = more like them.{" "}
            <span style={{ color: "#7ef0ff" }}>full</span> · <span style={{ color: "#ffb24a" }}>delete</span> · <span style={{ color: "#6ee7a8" }}>retain·CAM</span> · <span style={{ color: "#9aa7b8" }}>retain·rnd</span> · <span style={{ color: "#52708a" }}>other speakers</span>. retain·CAM inside retain·rnd = the +margin.
          </div>
        </div>
      ) : result && (projection.profiles.length > 0 || heatZones.length > 0) ? (
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
      ) : null}

      {result && cams.length === 0 && <div style={mutedStyle}>No explainable models loaded.</div>}
    </aside>
  );
}

function cosUnit(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na * nb);
  return den ? (d / den + 1) / 2 : 0; // map to 0..1, matching the backend
}

interface FaithScatterProps {
  size: number;
  targetId: string | null;
  profiles: { userId: string; centroidRaw: number[] }[];
  model: CamFaithModel;
}

// Radial similarity map: target speaker at the centre, everything else placed
// at radius ∝ (1 − similarity-to-target). Closer = more like the speaker.
// Distances come straight from the measured cosines, so it can't contradict
// the margins and always renders — no shared multi-speaker PCA basis (which
// breaks on mixed embedding dims / a single enrolled speaker).
function FaithScatter({ size, targetId, profiles, model }: FaithScatterProps) {
  const dim = model.originalEmbedding.length;
  const target = profiles.find((p) => p.userId === targetId && p.centroidRaw.length === dim) ?? null;

  const variants = [
    { label: "full", color: "#7ef0ff", sim: model.originalSimilarity },
    { label: "delete", color: "#ffb24a", sim: model.deleteCam },
    { label: "retain·CAM", color: "#6ee7a8", sim: model.retainCam },
    { label: "retain·rnd", color: "#9aa7b8", sim: model.retainRandom },
  ].filter((v) => v.sim > 0);
  const others = target
    ? profiles
        .filter((p) => p.userId !== targetId && p.centroidRaw.length === dim)
        .map((p) => ({ label: p.userId, color: "#52708a", sim: cosUnit(target.centroidRaw, p.centroidRaw) }))
    : [];

  const items = [...variants, ...others];
  if (items.length === 0) return null;
  const maxD = Math.max(0.05, ...items.map((it) => 1 - it.sim));
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 36;
  const placed = items.map((it, i) => {
    const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
    const r = ((1 - it.sim) / maxD) * R;
    return { ...it, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

  return (
    <svg width={size} height={size} style={{ display: "block", margin: "0 auto" }}>
      {[0.5, 1].map((f) => (
        <circle key={f} cx={cx} cy={cy} r={R * f} fill="none" stroke="rgba(126,240,255,0.12)" />
      ))}
      {placed.map((p, i) => (
        <line key={`l${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke={p.color} strokeOpacity={0.25} />
      ))}
      <circle cx={cx} cy={cy} r={6} fill="#d67cff" />
      <text x={cx + 9} y={cy + 4} fill="#d67cff" fontSize={11} fontFamily="JetBrains Mono, monospace">{targetId ?? "target"}</text>
      {placed.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={5} fill={p.color} />
          <text x={p.x + 7} y={p.y + 4} fill={p.color} fontSize={10} fontFamily="JetBrains Mono, monospace">
            {p.label} {(p.sim * 100).toFixed(0)}%
          </text>
        </g>
      ))}
    </svg>
  );
}

const VERDICT_META: Record<string, { label: string; color: string; note: string }> = {
  faithful: { label: "FAITHFUL", color: "#6ee7a8", note: "the salient region beats a random region on both sufficiency and necessity" },
  weak: { label: "WEAK", color: "#ffd27a", note: "the salient region beats random on one axis — honest for speaker ID, where identity is distributed" },
  unfaithful: { label: "UNFAITHFUL", color: "#ff7aa8", note: "the salient region is no more identity-bearing than a random region of equal size" },
  no_salience: { label: "NO SALIENCE", color: "#6f8aa3", note: "no target speaker / region to test" },
};

interface FaithfulnessPanelProps {
  faith: CamFaithfulness | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
  durationMs: number;
  playingKey: string | null;
  canPlay: boolean;
  onPlayBands: (key: string, segments: { startMs: number; endMs: number; peak: number }[]) => void;
}

// Random-baseline faithfulness: keep the top-30% most-salient frames and
// compare their identity content to a random 30% (sufficiency); compare
// removing them to removing a random 30% (necessity).
function FaithfulnessPanel({ faith, loading, error, onRun, durationMs, playingKey, canPlay, onPlayBands }: FaithfulnessPanelProps) {
  return (
    <div style={faithWrapStyle}>
      <div style={faithHeaderStyle}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          Attribution check · vs random
          <InfoButton k="explain.faithfulness" />
        </span>
        <button type="button" style={loading ? { ...faithRunBtnStyle, opacity: 0.5, cursor: "wait" } : faithRunBtnStyle} onClick={onRun} disabled={loading}>
          {loading ? "running…" : faith ? "↻ re-run" : "▶ run test"}
        </button>
      </div>
      {error && <div style={errorStyle}>{error}</div>}
      {!faith && !loading && !error && (
        <div style={mutedStyle}>
          Does the Grad-CAM's top-30% carry more identity than a random 30%? cam vs rnd, scored against the speaker centroid. ▶ plays the kept / removed audio.
        </div>
      )}
      {faith && faith.models.length === 0 && (
        <div style={mutedStyle}>No speaker-model attribution available to test.</div>
      )}
      {faith && faith.models.map((m) => (
        <FaithModelCard
          key={m.modelKey}
          model={m}
          durationMs={durationMs}
          playingKey={playingKey}
          canPlay={canPlay}
          onPlayBands={onPlayBands}
        />
      ))}
    </div>
  );
}

function signedPts(margin: number): string {
  return `${margin >= 0 ? "+" : "−"}${Math.abs(margin * 100).toFixed(1)}`;
}

interface FaithModelCardProps {
  model: CamFaithModel;
  durationMs: number;
  playingKey: string | null;
  canPlay: boolean;
  onPlayBands: (key: string, segments: { startMs: number; endMs: number; peak: number }[]) => void;
}

function FaithModelCard({ model, durationMs, playingKey, canPlay, onPlayBands }: FaithModelCardProps) {
  const meta = VERDICT_META[model.verdict] ?? VERDICT_META.no_salience;
  const target = model.targetUserId ?? "—";
  const retainSegs = model.retainSegments;
  const deleteSegs = complementSegments(retainSegs, durationMs);

  const playBtn = (key: string, segs: { startMs: number; endMs: number; peak: number }[]) =>
    canPlay && segs.length > 0 ? (
      <button
        type="button"
        style={playingKey === key ? faithPlayActiveStyle : faithPlayStyle}
        onClick={() => onPlayBands(key, segs)}
        title="play this masked audio"
      >
        {playingKey === key ? "■" : "▶"}
      </button>
    ) : (
      <span style={{ width: 22 }} />
    );

  // cam vs random row: similarity-to-centroid for the CAM-chosen region and a
  // random region of equal size, plus the margin (CAM − random) that drives
  // the verdict. A positive margin (green) = the CAM beat chance.
  const row = (
    label: string,
    camSim: number,
    rndSim: number,
    margin: number,
    play: ReactNode,
  ) => (
    <div style={faithRowStyle}>
      <span style={faithRowLabelStyle}>{label}</span>
      <span className="num-mono" style={{ flex: 1, minWidth: 0, color: "#cfe9ff" }}>
        {(camSim * 100).toFixed(1)}
        <span style={{ color: "#6f8aa3" }}> / {(rndSim * 100).toFixed(1)} rnd</span>
      </span>
      <span className="num-mono" style={{ color: margin >= 0.02 ? "#6ee7a8" : margin <= -0.02 ? "#ff7aa8" : "#ffd27a", fontWeight: 600 }}>
        {signedPts(margin)}
      </span>
      {play}
    </div>
  );
  return (
    <div style={faithCardStyle}>
      <div style={faithCardHeadStyle}>
        <span>{(MODEL_LABELS[model.modelKey] ?? model.modelKey).split(" · ")[0]}</span>
        <span style={{ ...verdictBadgeStyle, color: meta.color, borderColor: meta.color }}>{meta.label}</span>
      </div>
      <div style={mutedStyle}>
        kept {model.coveragePct.toFixed(0)}% · vs {target} · whole clip {(model.originalSimilarity * 100).toFixed(1)}%
      </div>
      <div style={{ ...mutedStyle, fontSize: 11 }}>cam / random · margin (cam−rnd)</div>
      {row("RETAIN", model.retainCam, model.retainRandom, model.sufficiencyMargin, playBtn(`faith:retain:${model.modelKey}`, retainSegs))}
      {row("DELETE", model.deleteCam, model.deleteRandom, model.necessityMargin, playBtn(`faith:delete:${model.modelKey}`, deleteSegs))}
      <div style={mutedStyle}>
        suff {signedPts(model.sufficiencyMargin)} · nec {signedPts(model.necessityMargin)} · {meta.note}
      </div>
    </div>
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

const faithWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  paddingTop: 4,
  borderTop: "1px solid rgba(126, 240, 255, 0.12)",
};

const faithHeaderStyle: CSSProperties = {
  fontSize: 13,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#d67cff",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const faithRunBtnStyle: CSSProperties = {
  background: "rgba(214, 124, 255, 0.12)",
  border: "1px solid rgba(214, 124, 255, 0.45)",
  color: "#e9b8ff",
  padding: "3px 10px",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 12,
  letterSpacing: "0.04em",
  cursor: "pointer",
  textTransform: "none",
};

const faithCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "10px 12px",
  background: "rgba(8, 14, 24, 0.55)",
  border: "1px solid rgba(126, 240, 255, 0.14)",
  borderRadius: 8,
};

const faithCardHeadStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 14,
  letterSpacing: "0.08em",
  color: "#7ef0ff",
};

const verdictBadgeStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.1em",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid",
  background: "rgba(0,0,0,0.25)",
};

const faithRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
};

const faithRowLabelStyle: CSSProperties = {
  width: 64,
  flexShrink: 0,
  color: "#6f8aa3",
  fontSize: 11,
  letterSpacing: "0.08em",
};

const faithPlayStyle: CSSProperties = {
  width: 22,
  flexShrink: 0,
  background: "rgba(126, 240, 255, 0.1)",
  border: "1px solid rgba(126, 240, 255, 0.35)",
  color: "#7ef0ff",
  borderRadius: 5,
  fontFamily: "inherit",
  fontSize: 11,
  lineHeight: 1.4,
  cursor: "pointer",
  padding: 0,
};

const faithPlayActiveStyle: CSSProperties = {
  ...faithPlayStyle,
  background: "rgba(255, 200, 90, 0.16)",
  border: "1px solid rgba(255, 200, 90, 0.6)",
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
