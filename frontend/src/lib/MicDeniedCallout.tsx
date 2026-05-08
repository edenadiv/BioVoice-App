// Y-20 — inline "Microphone access required" callout with a Retry button.
// Consumers render this when their `useVoiceRecorder().state === 'denied'`.

type MicDeniedCalloutProps = {
  onRetry: () => void;
  context?: "enroll" | "verify" | "lab";
};

export function MicDeniedCallout({ onRetry, context = "enroll" }: MicDeniedCalloutProps) {
  const verb = context === "verify" ? "verify" : context === "lab" ? "use the lab" : "enrol";
  return (
    <div
      style={{
        padding: "16px 18px",
        borderRadius: 12,
        background: "rgba(255,85,119,0.08)",
        border: "1px solid rgba(255,85,119,0.45)",
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "rgba(255,85,119,0.15)",
          border: "1px solid rgba(255,85,119,0.45)",
          color: "#ff7aa8",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          fontSize: 16,
        }}
        aria-hidden="true"
      >
        🎙
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>Microphone access required</div>
        <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 6, lineHeight: 1.5 }}>
          BioVoice needs your microphone to {verb}. Open this site's permissions in
          your browser, allow the microphone, then click <strong>Retry</strong>.
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onRetry}
          style={{ marginTop: 10, padding: "8px 16px", fontSize: 11 }}
        >
          ↺ &nbsp;Retry
        </button>
      </div>
    </div>
  );
}
