import { type Dispatch, useState } from "react";
import { loginWithVoice } from "../lib/api";
import { Button } from "../components/Button";
import { Waveform } from "../components/Waveform";
import { type FlowAction, type FlowState, SESSION_STORAGE_KEY } from "../lib/flowState";

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function LoginScreen({ state, dispatch }: Props) {
  const [userId, setUserId] = useState(state.userId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function back() {
    dispatch({ type: "navigate", screen: "home" });
  }

  async function pickWavAndAuth() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/wav,.wav";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !userId.trim()) {
        setError("Pick a WAV and enter your User ID.");
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const promise = loginWithVoice(userId.trim(), file);
        dispatch({ type: "set-user", userId: userId.trim() });
        dispatch({ type: "set-intent", intent: "verify" });
        dispatch({ type: "set-audio", audioFile: file });
        dispatch({ type: "set-pending", promise });
        dispatch({ type: "navigate", screen: "processing" });

        const { session, verification } = await promise;
        window.localStorage.setItem(SESSION_STORAGE_KEY, session.sessionToken);
        dispatch({ type: "set-session", session });
        dispatch({ type: "set-verification", result: verification });
        dispatch({ type: "set-deepfake", score: verification.deepfakeScore, details: null });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
        dispatch({ type: "set-pending", promise: null, error: error });
        dispatch({ type: "navigate", screen: "login" });
      } finally {
        setBusy(false);
      }
    };
    input.click();
  }

  return (
    <>
      <div className="bv-page-header">
        <h1>Voice Login</h1>
        <p>Authenticate with your enrolled voice profile.</p>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
        <span>User ID</span>
        <input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="john_doe_123"
          autoComplete="off"
        />
      </label>

      <div className="bv-card">
        <div className="bv-page-header">
          <h1 style={{ fontSize: 14 }}>Voice sample</h1>
          <p>Live mic capture is owned by Yoav (Y-1). Use a WAV upload here for now.</p>
        </div>
        <Waveform mode="idle" />
      </div>

      {error ? <div className="bv-card bv-card--banner-danger" style={{ padding: 14 }}>{error}</div> : null}

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <Button variant="ghost" onClick={back}>Back</Button>
        <Button variant="primary" onClick={() => void pickWavAndAuth()} disabled={busy} block>
          {busy ? "Authenticating…" : "Authenticate (upload WAV)"}
        </Button>
      </div>
    </>
  );
}
