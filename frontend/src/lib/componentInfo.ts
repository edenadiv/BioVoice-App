// Central registry of "what is this?" copy for the (i) info buttons placed
// on each major panel/visualization. Keep entries accurate to the real
// pipeline (ReDimNet B5 speaker encoder, Ensemble anti-spoof A01–A16, optional ECAPA /
// WeSpeaker comparison encoders, Grad-CAM explainability). `body` lines
// render as paragraphs; a line starting with "• " renders as a bullet.

export type ComponentInfo = { title: string; body: string[] };

export const COMPONENT_INFO: Record<string, ComponentInfo> = {
  // ---- Console / dashboard ------------------------------------------------
  "console.orb": {
    title: "Voice Orb",
    body: [
      "Live capture indicator. The orb breathes and brightens with the amplitude of the current microphone window, so you can see at a glance that audio is being picked up.",
      "It is a visual cue only — not a model output. Use it to confirm the mic is live and the speaker is at a sensible level before running a verification.",
    ],
  },
  "console.verify": {
    title: "Verify a speaker (1:1)",
    body: [
      "Runs a one-to-one check of the captured voice against the selected enrolled profile.",
      "• Speaker match: cosine similarity between the clip's ReDimNet B5 embedding and the profile's enrolled centroid.",
      "• Liveness / anti-spoof: the ensemble detector (16 ASVspoof5 classifiers, A01–A16) scores how likely the audio is a genuine human vs a synthetic/replayed fake.",
      "The decision is ACCEPT only when the similarity clears the similarity threshold and the clip passes the anti-spoof threshold. Tune both in Settings.",
    ],
  },
  "console.waveform": {
    title: "Waveform",
    body: [
      "Time-domain view of the live microphone window — amplitude over time.",
      "Useful for spotting clipping (bars hitting the ceiling), silence/dropouts, or background noise before you trust a result.",
    ],
  },
  "console.melspec": {
    title: "Mel-Spectrogram",
    body: [
      "The audio as the models effectively see it: a log-mel spectrogram of 80 frequency bands from ~0.5–8 kHz, scrolling in real time.",
      "Brighter cells = more energy at that frequency and moment. Speech shows up as horizontal formant bands; hiss/artifacts appear as flat broadband texture.",
    ],
  },
  "console.embedding": {
    title: "Voice Embedding Space",
    body: [
      "A 3-D map of the 192-dimensional speaker space. Each enrolled clip is encoded by ReDimNet B5, then all vectors are projected to 3-D with PCA so distance is meaningful.",
      "• Dots = individual enrolment samples, colored per speaker.",
      "• Larger rings = each speaker's centroid (their average voiceprint).",
      "• Cyan point = your live mic window, projected through the same basis.",
      "How to read it: the closer two points sit, the more similar the voices. Drag to rotate; switch the encoder (ReDimNet / ECAPA / WeSpeaker) with the buttons below.",
    ],
  },
  "console.pipeline": {
    title: "Inference Pipeline",
    body: [
      "The stages every clip flows through: PCM capture → mel-spectrogram → speaker encoder(s) → ensemble anti-spoof (A01–A16) → fused decision.",
      "Nodes light up as a run progresses, so you can see where time is spent and confirm each stage actually executed.",
    ],
  },
  "console.eventfeed": {
    title: "Live Event Feed",
    body: [
      "A rolling log of recent verification and identification runs as they happen — who was tested, the score, and the ACCEPT/REJECT (or GENUINE/FAKE) outcome.",
      "Full history with audio playback and Grad-CAM is available on the Logs screen.",
    ],
  },
  "console.profiles": {
    title: "Enrolled Profiles",
    body: [
      "The speakers currently enrolled on this node and how many samples each has.",
      "Verification needs at least the minimum enrolment samples (default 3) before a profile becomes usable. Select a profile to target it for a 1:1 verification.",
    ],
  },

  // ---- Identify -----------------------------------------------------------
  "identify.capture": {
    title: "Identify — capture",
    body: [
      "Open-set identification: record or upload a clip and the system ranks it against every enrolled speaker, rather than checking a single chosen profile.",
      "Speak for at least ~1 second of clear speech for a reliable embedding.",
    ],
  },
  "identify.results": {
    title: "Ranked matches",
    body: [
      "The top candidates for the captured voice, ordered by fused speaker similarity across the active encoders.",
      "A match is only considered genuine when its score clears the similarity threshold — a top rank alone does not mean ACCEPT.",
    ],
  },
  "identify.gauge": {
    title: "Fused similarity score",
    body: [
      "The combined cosine similarity of the clip to the best-matching speaker, averaged across the participating encoders (ReDimNet, and optionally ECAPA / WeSpeaker).",
      "The marker shows the current similarity threshold; above it = accept, below = reject.",
    ],
  },

  // ---- Grad-CAM / explainability -----------------------------------------
  "explain.gradcam": {
    title: "Per-model Grad-CAM",
    body: [
      "Explainability overlay: for each model it highlights the regions of the spectrogram that most drove that model's output (Grad-CAM attribution).",
      "• The ensemble detector (A01–A16) does not produce Grad-CAM output — it uses sklearn classifiers with no gradient graph.",
      "• ReDimNet / ECAPA show which time–frequency regions most defined the speaker identity.",
      "Click a highlighted band to play just that slice. WeSpeaker is omitted here — it runs as an ONNX graph with no gradients, so a heatmap can't be computed.",
    ],
  },
  "explain.voicespace": {
    title: "Voice space — closest speaker",
    body: [
      "Places the Grad-CAM evidence into the same 3-D voice map as the enrolled speakers. The model's salient regions are concatenated, embedded with ReDimNet, and projected through the shared PCA basis.",
      "The magenta point is that Grad-CAM embedding; the dashed line connects it to the enrolled speaker it is closest to — measured by true cosine similarity in the full 192-d space, not just on-screen distance.",
    ],
  },

  // ---- Deepfake Lab -------------------------------------------------------
  "lab.generate": {
    title: "Clone generation",
    body: [
      "Clones the chosen target's voice from their enrolled samples (or an uploaded reference WAV) and lets you score it against the live detector — a controlled way to probe how the system holds up against spoofing.",
      "The clone is conditioned on the target's reference audio, so it mimics that specific speaker rather than reading the text in a generic voice.",
    ],
  },
  "lab.engines": {
    title: "Voice-cloning engines",
    body: [
      "The voice-cloning backends available on this server. Both run locally (offline): F5-TTS (flow-matching, fast + natural) and Coqui XTTS-v2 (autoregressive, multilingual).",
      "Each conditions on the target's reference WAV to mimic that specific enrolled speaker. Generic non-cloning TTS was removed — it never resembles the target, so it added nothing to a detection workflow.",
    ],
  },
  "lab.batch": {
    title: "Batch Forge",
    body: [
      "Generates many clone candidates for a target voice and keeps only those that actually resemble it. Each candidate is embedded and scored by cosine similarity to the target's centroid; anything below the keep-threshold is discarded.",
      "It reports requested vs generated vs kept, so you can see how often a given engine produces a convincing match.",
    ],
  },
  "lab.test": {
    title: "Anti-spoof test",
    body: [
      "Drop in any WAV and score it directly with the ensemble anti-spoof detector (16 ASVspoof5 classifiers, A01–A16), independent of enrolment.",
      "Returns the synthetic-vs-genuine probability and the GENUINE/FAKE call at the current deepfake threshold.",
    ],
  },

  // ---- Logs ---------------------------------------------------------------
  "logs.list": {
    title: "Run history",
    body: [
      "Every verification and identification run recorded on this node, newest first.",
      "Open a row to see the full breakdown — per-model scores, the decision, the captured audio, and the Grad-CAM explanation.",
    ],
  },
  "logs.detail": {
    title: "Run detail",
    body: [
      "The complete record for a single run: similarity and anti-spoof scores, per-model contributions, the decision and thresholds in force, plus the captured audio you can replay or re-explain.",
    ],
  },

  // ---- Profiles -----------------------------------------------------------
  "profiles.list": {
    title: "Profiles manager",
    body: [
      "Create, inspect, and remove enrolled speakers. Each profile stores a centroid plus its individual sample embeddings used for matching.",
      "Add samples until a profile reaches the minimum enrolment count; more, varied samples generally improve accuracy.",
    ],
  },

  // ---- Settings -----------------------------------------------------------
  "settings.thresholds": {
    title: "Decision thresholds",
    body: [
      "Tune the cut-offs the decision uses. The similarity threshold sets how close a voice must be to ACCEPT; the deepfake threshold sets how confident the ensemble detector must be to flag audio as FAKE.",
      "Raising similarity reduces false accepts but risks rejecting genuine users; lowering it does the opposite.",
    ],
  },
  "settings.models": {
    title: "Model participation",
    body: [
      "Enable or disable the optional comparison encoders (ECAPA-TDNN, WeSpeaker ResNet293) that run alongside ReDimNet B5 and fuse into the final score.",
      "Toggles only apply to encoders actually loaded on this server; unavailable ones are shown as not loaded.",
    ],
  },

  // ---- Overlays -----------------------------------------------------------
  "verify.overlay": {
    title: "Live verification",
    body: [
      "Records a fresh clip and verifies it 1:1 against the selected profile, then shows the similarity, anti-spoof score, and the ACCEPT/REJECT decision.",
    ],
  },
  "enroll.modal": {
    title: "Enrol a voice",
    body: [
      "Captures samples to build a speaker profile. Record the prompt several times; each clip is encoded by ReDimNet and added to the profile's voiceprint.",
      "Use a quiet room and speak naturally — varied, clean samples make later verification more reliable.",
    ],
  },
};

export type InfoKey = keyof typeof COMPONENT_INFO;
