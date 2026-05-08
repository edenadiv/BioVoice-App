import { useEffect, useRef, useState } from "react";
import { AudioRecorder } from "./AudioRecorder";
import { Panel } from "./Panel";

type AuthRecordingFormProps = {
  title: string;
  subtitle: string;
  actionLabel: string;
  usernameLabel: string;
  usernamePlaceholder: string;
  onSubmit: (payload: { userId: string; file: File }) => Promise<string | void>;
  busy?: boolean;
  helperText?: string;
  statusMessage?: string | null;
  errorMessage?: string | null;
  initialUserId?: string;
  readOnlyUserId?: boolean;
  steps?: string[];
  allowUpload?: boolean;
  idleMicLabel?: string;
};

export function AuthRecordingForm({
  title,
  subtitle,
  actionLabel,
  usernameLabel,
  usernamePlaceholder,
  onSubmit,
  busy = false,
  helperText,
  statusMessage,
  errorMessage,
  initialUserId = "",
  readOnlyUserId = false,
  steps = [],
  allowUpload = true,
  idleMicLabel,
}: AuthRecordingFormProps) {
  const [userId, setUserId] = useState(initialUserId);
  const [file, setFile] = useState<File | null>(null);
  const [localStatus, setLocalStatus] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setUserId(initialUserId);
  }, [initialUserId]);

  async function handleSubmit() {
    if (!userId.trim() || !file || busy) {
      return;
    }

    setLocalError(null);
    setLocalStatus("Uploading recording...");
    try {
      const message = await onSubmit({ userId: userId.trim(), file });
      setLocalStatus(message || "Request completed.");
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Request failed");
      setLocalStatus("");
    }
  }

  return (
    <Panel className="auth-card" title={title} subtitle={subtitle}>
      <div className="record-zone" aria-label={`${title} audio controls`}>
        <div className="form-stack">
          <label className="field">
            <span>{usernameLabel}</span>
            <input
              className="field-input"
              type="text"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder={usernamePlaceholder}
              autoComplete="off"
              readOnly={readOnlyUserId}
            />
          </label>

          {allowUpload ? (
            <label className="field">
              <span>Audio sample</span>
              <input
                ref={fileInputRef}
                className="field-input"
                type="file"
                accept="audio/wav,.wav"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          ) : null}

          <AudioRecorder
            label={actionLabel.toLowerCase().replace(/\s+/g, "-")}
            onRecordingReady={(wavFile) => setFile(wavFile)}
            onStatusChange={(status) => setLocalStatus(status)}
            idleLabel={idleMicLabel}
          />
        </div>

        <div className="record-actions">
          {allowUpload ? (
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
              Upload WAV
            </button>
          ) : null}
          <button className="primary-button" type="button" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? "Working..." : actionLabel}
          </button>
        </div>

        {helperText ? <p className="panel-note">{helperText}</p> : null}
        {file ? <p className="panel-note">Selected file: {file.name}</p> : null}
        {statusMessage ? <p className="panel-note">{statusMessage}</p> : null}
        {localStatus ? <p className="panel-note">{localStatus}</p> : null}
        {errorMessage || localError ? <p className="error-text">{errorMessage || localError}</p> : null}

        {steps.length > 0 ? (
          <ul className="step-list">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
