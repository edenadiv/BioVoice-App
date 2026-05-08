import { useEffect, useRef, useState } from "react";
import type { ReferenceSample, SpoofGenerationResult } from "../types";
import { Panel } from "./Panel";

type ReferenceMode = "all-samples" | "single-sample" | "upload";

type SpoofStudioProps = {
  userId: string;
  samples: ReferenceSample[];
  busy?: boolean;
  statusMessage?: string | null;
  result?: SpoofGenerationResult | null;
  onSubmit: (payload: {
    text: string;
    language: string;
    referenceSampleId?: string;
    file?: File | null;
  }) => Promise<void>;
};

const languageOptions = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "pl", label: "Polish" },
  { value: "tr", label: "Turkish" },
  { value: "ru", label: "Russian" },
  { value: "nl", label: "Dutch" },
  { value: "cs", label: "Czech" },
  { value: "ar", label: "Arabic" },
  { value: "zh-cn", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "hu", label: "Hungarian" },
  { value: "ko", label: "Korean" },
  { value: "hi", label: "Hindi" },
];

export function SpoofStudio({
  userId,
  samples,
  busy = false,
  statusMessage,
  result,
  onSubmit,
}: SpoofStudioProps) {
  const [text, setText] = useState("This is a generated spoof sample for BioVoice testing.");
  const [language, setLanguage] = useState("en");
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>("all-samples");
  const [referenceSampleId, setReferenceSampleId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [localStatus, setLocalStatus] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (samples.length > 0 && !referenceSampleId) {
      setReferenceSampleId(samples[0].sampleId);
    }
  }, [referenceSampleId, samples]);

  async function handleSubmit() {
    if (!text.trim() || busy) {
      return;
    }

    if (referenceMode === "single-sample" && !referenceSampleId) {
      setLocalError("Choose one saved enrollment sample first.");
      return;
    }

    if (referenceMode === "upload" && !file) {
      setLocalError("Upload a WAV reference sample first.");
      return;
    }

    setLocalError(null);
    setLocalStatus("Generating spoof sample...");
    try {
      await onSubmit({
        text: text.trim(),
        language,
        referenceSampleId: referenceMode === "single-sample" ? referenceSampleId : undefined,
        file: referenceMode === "upload" ? file : null,
      });
      setLocalStatus("Spoof sample generated.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Spoof generation failed");
      setLocalStatus("");
    }
  }

  return (
    <Panel
      className="auth-card"
      title="Spoof generator"
      subtitle={`Generate a cloned speech sample for ${userId} using saved enrollment audio or an uploaded WAV reference.`}
    >
      <div className="record-zone">
        <div className="form-stack">
          <label className="field">
            <span>Text to speak</span>
            <textarea
              className="field-input text-area"
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Enter the sentence the spoof voice should say"
            />
          </label>

          <label className="field">
            <span>Output language</span>
            <select className="field-input" value={language} onChange={(event) => setLanguage(event.target.value)}>
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Reference source</span>
            <select
              className="field-input"
              value={referenceMode}
              onChange={(event) => setReferenceMode(event.target.value as ReferenceMode)}
            >
              <option value="all-samples">All saved enrollment samples</option>
              <option value="single-sample">One saved enrollment sample</option>
              <option value="upload">Upload a custom WAV reference</option>
            </select>
          </label>

          {referenceMode === "single-sample" ? (
            <label className="field">
              <span>Saved enrollment sample</span>
              <select
                className="field-input"
                value={referenceSampleId}
                onChange={(event) => setReferenceSampleId(event.target.value)}
              >
                {samples.length === 0 ? <option value="">No saved samples available</option> : null}
                {samples.map((sample) => {
                  const label = `${sample.originalFilename} - ${new Date(sample.createdAt).toLocaleString()}`;
                  return (
                    <option key={sample.sampleId} value={sample.sampleId}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null}

          {referenceMode === "upload" ? (
            <label className="field">
              <span>Upload reference WAV</span>
              <input
                ref={fileInputRef}
                className="field-input"
                type="file"
                accept="audio/wav,.wav"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          ) : null}
        </div>

        <div className="record-actions">
          {referenceMode === "upload" ? (
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
              Upload WAV
            </button>
          ) : null}
          <button className="primary-button" type="button" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? "Generating..." : "Generate spoof sample"}
          </button>
        </div>

        <p className="panel-note">
          Saved references: {samples.length}. Use all samples for a fuller voice profile or upload a one-off reference clip.
        </p>
        {file ? <p className="panel-note">Selected file: {file.name}</p> : null}
        {statusMessage ? <p className="panel-note">{statusMessage}</p> : null}
        {localStatus ? <p className="panel-note">{localStatus}</p> : null}
        {localError ? <p className="error-text">{localError}</p> : null}

        {result ? (
          <div className="detail-card">
            <strong>Latest spoof sample</strong>
            <span>{result.sourceDescription}</span>
            <span>{`Language: ${result.language} - File: ${result.fileName}`}</span>
            <audio className="audio-preview" controls src={result.audioUrl} />
            <a className="secondary-button audio-download" href={result.audioUrl} download={result.fileName}>
              Download WAV
            </a>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
