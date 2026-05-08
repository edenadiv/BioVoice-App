import { useEffect, useReducer } from "react";
import { AppWindow } from "./components/AppWindow";
import { getSession } from "./lib/api";
import {
  flowReducer,
  initialFlowState,
  SESSION_STORAGE_KEY,
  type Screen,
} from "./lib/flowState";
import { DeepfakeResultScreen } from "./screens/DeepfakeResultScreen";
import { EnrollScreen } from "./screens/EnrollScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { ProcessingScreen } from "./screens/ProcessingScreen";
import { ShowcaseScreen } from "./screens/ShowcaseScreen";
import { TestLabScreen } from "./screens/TestLabScreen";
import { VerifyResultScreen } from "./screens/VerifyResultScreen";

const TITLES: Record<Screen, string> = {
  home: "BioVoice",
  login: "BioVoice — Login",
  enroll: "BioVoice — Enrollment",
  processing: "BioVoice — Processing",
  deepfake_result: "BioVoice — Security Check",
  verify_result: "BioVoice — Verification Result",
  test_lab: "BioVoice — Test Lab",
  showcase: "BioVoice — Showcase",
};

function isShowcase() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("showcase") === "1";
}

export default function App() {
  const showcase = isShowcase();
  const [state, dispatch] = useReducer(
    flowReducer,
    showcase ? { ...initialFlowState, screen: "showcase" } : initialFlowState,
  );

  useEffect(() => {
    if (showcase) return;
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
  }, [showcase]);

  return (
    <AppWindow title={TITLES[state.screen]}>
      {state.screen === "showcase" ? <ShowcaseScreen /> : null}
      {state.screen === "home" ? <HomeScreen state={state} dispatch={dispatch} /> : null}
      {state.screen === "login" ? <LoginScreen state={state} dispatch={dispatch} /> : null}
      {state.screen === "enroll" ? <EnrollScreen state={state} dispatch={dispatch} /> : null}
      {state.screen === "processing" ? <ProcessingScreen state={state} dispatch={dispatch} /> : null}
      {state.screen === "deepfake_result" ? <DeepfakeResultScreen state={state} dispatch={dispatch} /> : null}
      {state.screen === "verify_result" ? <VerifyResultScreen state={state} dispatch={dispatch} /> : null}
      {state.screen === "test_lab" ? <TestLabScreen state={state} dispatch={dispatch} /> : null}
    </AppWindow>
  );
}
