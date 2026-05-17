import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { explainAudio, type ModelCAM } from "../lib/api";
import { decodeFileToBuffer, playSalient, type SalientPlayback } from "../lib/explainAudio";

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

export function ExplainTab({ wavFile, open, matchUserId }: ExplainTabProps) {
  const [cams, setCams] = useState<ModelCAM[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const playbackRef = useRef<SalientPlayback | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !wavFile) return;
    let cancelled = false;
    setCams(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const file = wavFile instanceof File ? wavFile : new File([wavFile], "probe.wav", { type: "audio/wav" });
        const [result, buffer] = await Promise.all([
          explainAudio(file, matchUserId ?? undefined),
          decodeFileToBuffer(wavFile),
        ]);
        if (cancelled) return;
        bufferRef.current = buffer;
        setCams(result);
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

  const handlePlay = useCallback((cam: ModelCAM) => {
    if (!bufferRef.current || cam.salientSegments.length === 0) return;
    playbackRef.current?.stop();
    const pb = playSalient(bufferRef.current, cam.salientSegments);
    playbackRef.current = pb;
    setPlayingKey(cam.modelKey);
    void pb.promise.then(() => {
      setPlayingKey((current) => (current === cam.modelKey ? null : current));
    });
  }, []);

  const handlePlayOriginal = useCallback(() => {
    if (!bufferRef.current) return;
    playbackRef.current?.stop();
    const pb = playSalient(bufferRef.current, null);
    playbackRef.current = pb;
    setPlayingKey("__original__");
    void pb.promise.then(() => {
      setPlayingKey((current) => (current === "__original__" ? null : current));
    });
  }, []);

  if (!open) return null;

  return (
    <aside style={panelStyle}>
      <header style={headerStyle}>
        Grad-CAM{matchUserId ? ` · vs ${matchUserId}` : ""}
        {bufferRef.current && (
          <button
            type="button"
            style={origBtnStyle}
            onClick={handlePlayOriginal}
          >
            {playingKey === "__original__" ? "■ stop" : "▶ original"}
          </button>
        )}
      </header>
      {loading && <div style={mutedStyle}>Computing attribution…</div>}
      {error && <div style={errorStyle}>{error}</div>}
      {cams?.map((cam) => (
        <CamRow
          key={cam.modelKey}
          cam={cam}
          playing={playingKey === cam.modelKey}
          onPlay={() => handlePlay(cam)}
        />
      ))}
      {cams && cams.length === 0 && <div style={mutedStyle}>No explainable models loaded.</div>}
    </aside>
  );
}

interface CamRowProps {
  cam: ModelCAM;
  playing: boolean;
  onPlay: () => void;
}

function CamRow({ cam, playing, onPlay }: CamRowProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawHeatmap(canvas, cam);
  }, [cam]);

  const durationMs = cam.frameTimesMs[cam.frameTimesMs.length - 1] ?? 0;
  const totalSalientMs = cam.salientSegments.reduce((acc, s) => acc + (s.endMs - s.startMs), 0);
  const pct = durationMs > 0 ? Math.round((100 * totalSalientMs) / durationMs) : 0;
  const canPlay = cam.salientSegments.length > 0;

  return (
    <div style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={modelNameStyle}>{MODEL_LABELS[cam.modelKey] ?? cam.modelKey}</span>
        <span style={mutedStyle}>thr {cam.threshold.toFixed(2)}</span>
      </div>
      <canvas ref={canvasRef} width={240} height={80} style={canvasStyle} />
      <div style={rowFooterStyle}>
        <button
          type="button"
          style={canPlay ? playBtnStyle : playBtnDisabledStyle}
          onClick={onPlay}
          disabled={!canPlay}
        >
          {playing ? "■ stop" : "▶ play salient"}
        </button>
        <span style={mutedStyle}>
          {cam.salientSegments.length} seg · {pct}% of clip
        </span>
      </div>
      {cam.salientSegments.length > 0 && (
        <ul style={segListStyle}>
          {cam.salientSegments.map((s, i) => (
            <li key={i} style={segItemStyle}>
              {(s.startMs / 1000).toFixed(2)}s – {(s.endMs / 1000).toFixed(2)}s
              <span style={mutedStyle}> · peak {s.peak.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function drawHeatmap(canvas: HTMLCanvasElement, cam: ModelCAM) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const T = cam.heatmap.length;
  const F = cam.heatmap[0]?.length ?? 0;
  if (T === 0 || F === 0) return;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const fIdx = Math.floor(((H - 1 - y) / H) * F);
    for (let x = 0; x < W; x++) {
      const tIdx = Math.floor((x / W) * T);
      const v = cam.heatmap[tIdx][fIdx] ?? 0;
      const [r, g, b] = ramp(v);
      const o = (y * W + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const thrY = Math.floor((1 - cam.threshold) * H);
  ctx.strokeStyle = "rgba(126, 240, 255, 0.6)";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, thrY);
  ctx.lineTo(W, thrY);
  ctx.stroke();
  ctx.setLineDash([]);
}

function ramp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  const r = Math.floor(255 * Math.min(1, 1.5 * x));
  const g = Math.floor(255 * Math.max(0, Math.min(1, 1.5 * x - 0.5)));
  const b = Math.floor(255 * Math.max(0, 0.4 - x));
  return [r, g, b];
}

const panelStyle: CSSProperties = {
  width: 280,
  padding: 14,
  background: "rgba(8, 14, 24, 0.7)",
  border: "1px solid rgba(126, 240, 255, 0.18)",
  borderRadius: 12,
  display: "flex",
  flexDirection: "column",
  gap: 14,
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

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const rowHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 11,
};

const modelNameStyle: CSSProperties = {
  fontWeight: 600,
  color: "#e7f8ff",
};

const canvasStyle: CSSProperties = {
  width: "100%",
  height: 80,
  borderRadius: 6,
  display: "block",
};

const rowFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 10,
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
  gap: 2,
  maxHeight: 96,
  overflowY: "auto",
};

const segItemStyle: CSSProperties = {
  color: "#cfe9ff",
};

const mutedStyle: CSSProperties = {
  color: "#6f8aa3",
  fontSize: 10,
};

const errorStyle: CSSProperties = {
  color: "#ff7aa8",
  fontSize: 11,
};
