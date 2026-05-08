import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { concatFloat32, encodeWav } from "../lib/wav";

type AudioRecorderProps = {
  onRecordingReady: (file: File) => void;
  onStatusChange?: (status: string) => void;
  label: string;
  idleLabel?: string;
};

type RecorderRefs = {
  context: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null;
  analyser: AnalyserNode | null;
  chunks: Float32Array[];
};

const initialRefs = (): RecorderRefs => ({
  context: null,
  stream: null,
  source: null,
  processor: null,
  analyser: null,
  chunks: [],
});

export function AudioRecorder({ onRecordingReady, onStatusChange, label, idleLabel = "Mic idle" }: AudioRecorderProps) {
  const refs = useRef<RecorderRefs>(initialRefs());
  const [recording, setRecording] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 20 }, () => 0.14));
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
      void stopRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone recording is not supported in this browser.");
      }
      onStatusChange?.("Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      refs.current = {
        context,
        stream,
        source,
        processor,
        analyser,
        chunks: [],
      };

      processor.onaudioprocess = (event) => {
        refs.current.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(context.destination);
      setRecording(true);
      onStatusChange?.("Recording in progress...");
      beginVisualization(analyser);
    } catch (error) {
      onStatusChange?.(error instanceof Error ? error.message : "Unable to start recording.");
    }
  }

  async function stopRecording(emit = true) {
    const { context, stream, source, processor, analyser, chunks } = refs.current;
    if (!context || !stream || !source || !processor || !analyser) {
      return;
    }

    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    processor.disconnect();
    analyser.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    const sampleRate = context.sampleRate;
    await context.close();

    refs.current = initialRefs();
    setRecording(false);
    setLevels(Array.from({ length: 20 }, () => 0.14));
    onStatusChange?.("Recording stopped.");

    if (!emit || chunks.length === 0) {
      return;
    }

    const merged = concatFloat32(chunks);
    const wavBlob = encodeWav(merged, sampleRate);
    const file = new File([wavBlob], `${label}-${Date.now()}.wav`, { type: "audio/wav" });
    onRecordingReady(file);
  }

  function beginVisualization(analyser: AnalyserNode) {
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(buffer);
      const nextLevels = Array.from({ length: 20 }, (_, index) => {
        const start = Math.floor((index / 20) * buffer.length);
        const end = Math.floor(((index + 1) / 20) * buffer.length);
        const slice = buffer.slice(start, Math.max(end, start + 1));
        const average = slice.reduce((sum, value) => sum + value, 0) / slice.length;
        return Math.max(0.12, average / 255);
      });
      setLevels(nextLevels);
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
  }

  return (
    <div className="recorder-stack">
      <div className="waveform-shell" aria-hidden="true">
        <div className="waveform-bars">
          {levels.map((level, index) => (
            <span
              key={`${label}-${index}`}
              style={{
                "--h": `${Math.max(18, Math.round(level * 108))}px`,
                "--delay": `${index * 40}ms`,
              } as CSSProperties}
            />
          ))}
        </div>
      </div>
      <div className="recorder-row">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            void (recording ? stopRecording() : startRecording());
          }}
        >
          {recording ? "Stop mic" : "Record mic"}
        </button>
        <span className="muted">{recording ? "Microphone live" : idleLabel}</span>
      </div>
    </div>
  );
}
