import { useEffect, useMemo, useRef, useState } from "react";
import type { Speaker } from "../types";
import { AudioRecorder } from "./AudioRecorder";
import { Panel } from "./Panel";

type RecordPanelProps = {
  mode: "enroll" | "verify";
  speakers: Speaker[];
  onSubmit: (payload: { userId: string; file: File }) => Promise<string | void>;
  busy?: boolean;
  id?: string;
};

export function RecordPanel({ mode, speakers, onSubmit, busy = false, id }: RecordPanelProps) {
  const title = mode === "enroll" ? "Enroll a speaker" : "Verify identity";
  const subtitle =
    mode === "enroll"
      ? "Record or upload 3 clean WAV samples to build a stronger speaker profile."
      : "Verification unlocks after 3 enrollment samples for the selected speaker.";

  const [userId, setUserId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localStatus, setLocalStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const steps = useMemo(
    () =>
      mode === "enroll"
        ? [
            "Capture 3 clean enrollment samples",
            "Backend stores each embedding separately",
            "A centroid reference is built from the sample set",
          ]
        : [
            "Capture a fresh verification sample",
            "Backend compares it to the enrollment sample set",
            "Run spoof check before speaker match",
          ],
    [mode],
  );

  useEffect(() => {
    if (mode === "verify" && !userId && speakers.length > 0) {
      setUserId(speakers[0].userId);
    }
  }, [mode, speakers, userId]);

  async function handleSubmit() {
    if (!userId.trim() || !file || busy) {
      return;
    }

    setError(null);
    setLocalStatus(mode === "enroll" ? "Enrolling speaker..." : "Verifying speaker...");
    try {
      const message = await onSubmit({ userId: userId.trim(), file });
      setLocalStatus(message || (mode === "enroll" ? "Enrollment sent." : "Verification finished."));
      if (mode === "enroll") {
        setUserId("");
      }
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setLocalStatus("");
    }
  }

  return (
    <Panel id={id} title={title} subtitle={subtitle}>
      <div className="record-zone" aria-label={`${mode} audio controls`}>
        <div className="form-stack">
          <label className="field">
            <span>{mode === "enroll" ? "User ID" : "Speaker"}</span>
            {mode === "enroll" ? (
              <input
                className="field-input"
                type="text"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="Enter a unique user identifier"
                autoComplete="off"
              />
            ) : (
              <select className="field-input" value={userId} onChange={(event) => setUserId(event.target.value)}>
                <option value="">Select enrolled speaker</option>
                {speakers.map((speaker) => (
                  <option key={speaker.userId} value={speaker.userId}>
                    {speaker.userId} ({speaker.sampleCount})
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="field">
            <span>Audio file</span>
            <input
              ref={fileInputRef}
              className="field-input"
              type="file"
              accept="audio/wav,.wav"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <AudioRecorder
            label={mode}
            onRecordingReady={(wavFile) => setFile(wavFile)}
            onStatusChange={(statusMessage) => setLocalStatus(statusMessage)}
          />
        </div>

        <div className="record-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload WAV
          </button>
          <button className="primary-button" type="button" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? "Working..." : mode === "enroll" ? "Enroll speaker" : "Verify speaker"}
          </button>
        </div>

        {file ? <p className="panel-note">Selected file: {file.name}</p> : null}
        {localStatus ? <p className="panel-note">{localStatus}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        <ul className="step-list">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
