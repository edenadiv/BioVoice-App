import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import { getSession, listResults, listSpeakers } from "./api";
import { deriveProfile, type Profile } from "./profileVisual";
import { useResultsPolling } from "./useResultsPolling";
import type { Session, Speaker, VerificationResult, SpoofGenerationResult } from "../types";

export const SESSION_STORAGE_KEY = "biovoice_session_token";

type FlowIntent = "enroll" | "verify" | null;

export type AppState = {
  session: Session | null;
  speakers: Speaker[];
  results: VerificationResult[];
  lastVerification: VerificationResult | null;
  lastSpoof: SpoofGenerationResult | null;
  flow: {
    intent: FlowIntent;
    pendingPromise: Promise<unknown> | null;
    pendingError: string | null;
  };
  health: "unknown" | "ready" | "error";
};

const initialState: AppState = {
  session: null,
  speakers: [],
  results: [],
  lastVerification: null,
  lastSpoof: null,
  flow: { intent: null, pendingPromise: null, pendingError: null },
  health: "unknown",
};

type Action =
  | { type: "set-session"; session: Session | null }
  | { type: "set-speakers"; speakers: Speaker[] }
  | { type: "set-results"; results: VerificationResult[] }
  | { type: "prepend-result"; result: VerificationResult }
  | { type: "set-last-verification"; result: VerificationResult | null }
  | { type: "set-last-spoof"; spoof: SpoofGenerationResult | null }
  | { type: "set-flow"; intent: FlowIntent; promise: Promise<unknown> | null }
  | { type: "set-flow-error"; error: string | null }
  | { type: "set-health"; health: AppState["health"] }
  | { type: "logout" };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "set-session":
      return { ...state, session: action.session };
    case "set-speakers":
      return { ...state, speakers: action.speakers };
    case "set-results":
      return { ...state, results: action.results };
    case "prepend-result":
      return {
        ...state,
        results: [action.result, ...state.results].slice(0, 200),
      };
    case "set-last-verification":
      return { ...state, lastVerification: action.result };
    case "set-last-spoof":
      return { ...state, lastSpoof: action.spoof };
    case "set-flow":
      return {
        ...state,
        flow: {
          intent: action.intent,
          pendingPromise: action.promise,
          pendingError: action.promise ? null : state.flow.pendingError,
        },
      };
    case "set-flow-error":
      return {
        ...state,
        flow: { ...state.flow, pendingError: action.error, pendingPromise: null },
      };
    case "set-health":
      return { ...state, health: action.health };
    case "logout":
      return { ...initialState, speakers: state.speakers, results: state.results, health: state.health };
    default:
      return state;
  }
}

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<((action: Action) => void) | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Stable callback for the polling hook.
  const onResults = useCallback((results: VerificationResult[]) => {
    dispatch({ type: "set-results", results });
  }, []);
  useResultsPolling(onResults, 5000);

  // Initial speaker load — refreshed elsewhere after enrollment mutations.
  useEffect(() => {
    let alive = true;
    listSpeakers()
      .then((speakers) => {
        if (alive) {
          dispatch({ type: "set-speakers", speakers });
          dispatch({ type: "set-health", health: "ready" });
        }
      })
      .catch(() => {
        if (alive) dispatch({ type: "set-health", health: "error" });
      });
    return () => {
      alive = false;
    };
  }, []);

  // Restore session from localStorage on mount.
  useEffect(() => {
    const token = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!token) return;
    let alive = true;
    getSession(token)
      .then((session) => {
        if (alive) dispatch({ type: "set-session", session });
      })
      .catch(() => {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Refetch results once now (the polling loop also covers this, but a fresh
  // mount can render zeros for ~5 s otherwise — kick a single immediate fetch).
  useEffect(() => {
    let alive = true;
    listResults()
      .then((results) => {
        if (alive) dispatch({ type: "set-results", results });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(StateContext);
  if (ctx === null) throw new Error("useAppState must be used within <AppStateProvider>");
  return ctx;
}

export function useAppDispatch(): (action: Action) => void {
  const ctx = useContext(DispatchContext);
  if (ctx === null) throw new Error("useAppDispatch must be used within <AppStateProvider>");
  return ctx;
}

// Convenience selector — many components want the visual-augmented profile list.
export function useProfiles(): Profile[] {
  const { speakers } = useAppState();
  return useMemo(() => speakers.map(deriveProfile), [speakers]);
}

// Derived counters for the console.
export function useDerivedCounts(): { verifyCount: number; threatCount: number } {
  const { results } = useAppState();
  return useMemo(() => {
    let verifyCount = 0;
    let threatCount = 0;
    for (const r of results) {
      if (r.decision === "ACCEPT") verifyCount += 1;
      else if (r.decision === "DEEPFAKE") threatCount += 1;
    }
    return { verifyCount, threatCount };
  }, [results]);
}
