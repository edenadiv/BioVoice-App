// Display-only mirror of `backend/app/core/config.py:11-12`
// (similarity_threshold = 0.75, deepfake_threshold = 0.50).
// The actual decision lives on the server — read `result.decision` from the
// VerificationResponse, never re-derive `accepted = sim >= 0.75 && df >= 0.5`
// on the client. These constants exist only for gauge markers and threshold
// labels in the UI.

export const SIM_THRESHOLD = 0.75;
export const DF_THRESHOLD = 0.5;
