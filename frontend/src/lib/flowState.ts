import type { Decision, ReferenceSample, Session, VerificationResult } from "../types";

export type Screen =
  | "home"
  | "login"
  | "enroll"
  | "processing"
  | "deepfake_result"
  | "verify_result"
  | "test_lab"
  | "showcase";

export type Intent = "enroll" | "verify";

export type AnalysisDetails = {
  voice_naturalness: number;
  spectral_consistency: number;
  temporal_patterns: number;
  artifact_detection: number;
};

export type FlowState = {
  screen: Screen;
  intent: Intent;
  userId: string;
  sampleIndex: number;
  audioFile: File | null;
  pendingPromise: Promise<unknown> | null;
  pendingError: string | null;
  session: Session | null;
  referenceSamples: ReferenceSample[];
  lastDeepfakeScore: number | null;
  lastDeepfakeDetails: AnalysisDetails | null;
  lastDecision: Decision | null;
  lastVerification: VerificationResult | null;
};

export const initialFlowState: FlowState = {
  screen: "home",
  intent: "verify",
  userId: "",
  sampleIndex: 0,
  audioFile: null,
  pendingPromise: null,
  pendingError: null,
  session: null,
  referenceSamples: [],
  lastDeepfakeScore: null,
  lastDeepfakeDetails: null,
  lastDecision: null,
  lastVerification: null,
};

export type FlowAction =
  | { type: "navigate"; screen: Screen }
  | { type: "set-intent"; intent: Intent }
  | { type: "set-user"; userId: string }
  | { type: "set-sample-index"; sampleIndex: number }
  | { type: "set-audio"; audioFile: File | null }
  | { type: "set-pending"; promise: Promise<unknown> | null; error?: string | null }
  | { type: "set-session"; session: Session | null }
  | { type: "set-reference-samples"; samples: ReferenceSample[] }
  | { type: "set-deepfake"; score: number; details: AnalysisDetails | null }
  | { type: "set-verification"; result: VerificationResult }
  | { type: "logout" }
  | { type: "reset-flow" };

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "navigate":
      return { ...state, screen: action.screen };
    case "set-intent":
      return { ...state, intent: action.intent };
    case "set-user":
      return { ...state, userId: action.userId };
    case "set-sample-index":
      return { ...state, sampleIndex: action.sampleIndex };
    case "set-audio":
      return { ...state, audioFile: action.audioFile };
    case "set-pending":
      return {
        ...state,
        pendingPromise: action.promise,
        pendingError: action.error ?? null,
      };
    case "set-session":
      return { ...state, session: action.session };
    case "set-reference-samples":
      return { ...state, referenceSamples: action.samples };
    case "set-deepfake":
      return {
        ...state,
        lastDeepfakeScore: action.score,
        lastDeepfakeDetails: action.details,
      };
    case "set-verification":
      return {
        ...state,
        lastVerification: action.result,
        lastDecision: action.result.decision,
      };
    case "logout":
      return {
        ...initialFlowState,
        screen: "home",
      };
    case "reset-flow":
      return {
        ...state,
        intent: "verify",
        sampleIndex: 0,
        audioFile: null,
        pendingPromise: null,
        pendingError: null,
        lastDeepfakeScore: null,
        lastDeepfakeDetails: null,
        lastDecision: null,
        lastVerification: null,
      };
    default:
      return state;
  }
}

export const SESSION_STORAGE_KEY = "biovoice_session_token";
