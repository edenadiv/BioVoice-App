import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { COMPONENT_INFO } from "../lib/componentInfo";

// A small circular "i" button placed in a panel header. Clicking it toggles a
// popover with a detailed description of that panel/visualization. Click
// outside or press Esc to dismiss. Content comes from lib/componentInfo by key.
export function InfoButton({
  k,
  align = "right",
  size = 24,
}: {
  k: string;
  align?: "left" | "right";
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const info = COMPONENT_INFO[k];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!info) return null;

  return (
    <span ref={wrapRef} style={wrapStyle} className="biovoice-info">
      <button
        type="button"
        aria-label={`About ${info.title}`}
        aria-expanded={open}
        title={`About ${info.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={btnStyle(size, open)}
      >
        i
      </button>
      {open && (
        <div role="dialog" aria-label={info.title} style={popoverStyle(align)} onClick={(e) => e.stopPropagation()}>
          <div style={titleStyle}>{info.title}</div>
          <div style={bodyStyle}>
            {info.body.map((line, i) =>
              line.startsWith("• ") ? (
                <div key={i} style={bulletStyle}>
                  <span style={bulletDotStyle}>›</span>
                  <span>{line.slice(2)}</span>
                </div>
              ) : (
                <p key={i} style={paraStyle}>
                  {line}
                </p>
              ),
            )}
          </div>
          <button type="button" onClick={() => setOpen(false)} style={closeStyle}>
            close
          </button>
        </div>
      )}
    </span>
  );
}

const wrapStyle: CSSProperties = { position: "relative", display: "inline-flex", flexShrink: 0 };

const btnStyle = (size: number, open: boolean): CSSProperties => ({
  width: size,
  height: size,
  minWidth: size,
  minHeight: size,
  padding: 0,
  display: "grid",
  placeItems: "center",
  borderRadius: "50%",
  border: `1px solid ${open ? "rgba(126,240,255,0.6)" : "var(--line-2)"}`,
  background: open ? "rgba(126,240,255,0.12)" : "transparent",
  color: open ? "var(--teal-2)" : "var(--ink-mute)",
  cursor: "pointer",
  fontFamily: "Instrument Serif, JetBrains Mono, serif",
  fontStyle: "italic",
  fontSize: Math.round(size * 0.62),
  lineHeight: 1,
  transition: "all 160ms",
});

const popoverStyle = (align: "left" | "right"): CSSProperties => ({
  position: "absolute",
  top: "calc(100% + 8px)",
  [align]: 0,
  zIndex: 80,
  width: 300,
  maxWidth: "min(300px, 80vw)",
  maxHeight: 360,
  overflowY: "auto",
  padding: 14,
  background: "rgba(8, 14, 24, 0.97)",
  border: "1px solid rgba(126, 240, 255, 0.28)",
  borderRadius: 12,
  boxShadow: "0 18px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(126,240,255,0.06)",
  backdropFilter: "blur(10px)",
  textAlign: "left",
  cursor: "default",
});

const titleStyle: CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--teal-2)",
  marginBottom: 8,
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const paraStyle: CSSProperties = {
  margin: 0,
  fontFamily: "Sora, sans-serif",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--ink)",
};

const bulletStyle: CSSProperties = {
  display: "flex",
  gap: 7,
  fontFamily: "Sora, sans-serif",
  fontSize: 13,
  lineHeight: 1.45,
  color: "var(--ink-mute)",
};

const bulletDotStyle: CSSProperties = { color: "var(--teal-2)", flexShrink: 0 };

const closeStyle: CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "5px 0",
  background: "transparent",
  border: "1px solid var(--line-2)",
  borderRadius: 7,
  color: "var(--ink-mute)",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  cursor: "pointer",
};
