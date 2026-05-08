import type { Dispatch } from "react";
import { Button } from "../components/Button";
import type { FlowAction, FlowState } from "../lib/flowState";

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function HomeScreen({ state, dispatch }: Props) {
  const greeting = state.session ? `Welcome back, ${state.session.userId}.` : "Voice biometric authentication.";

  return (
    <>
      <div className="bv-page-header">
        <h1>BioVoice</h1>
        <p>{greeting} Pick a flow to begin.</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        <Button
          variant="primary"
          size="lg"
          block
          onClick={() => {
            dispatch({ type: "set-intent", intent: "enroll" });
            dispatch({ type: "set-sample-index", sampleIndex: 0 });
            dispatch({ type: "navigate", screen: "enroll" });
          }}
        >
          New User Enrollment
        </Button>

        <Button
          variant="ghost"
          size="lg"
          block
          onClick={() => {
            dispatch({ type: "set-intent", intent: "verify" });
            dispatch({ type: "navigate", screen: "login" });
          }}
        >
          Voice Login
        </Button>

        <Button
          variant="ghost"
          size="lg"
          block
          onClick={() => dispatch({ type: "navigate", screen: "test_lab" })}
        >
          Open Test Lab
        </Button>
      </div>

      <p className="muted" style={{ marginTop: "auto", fontSize: 12 }}>
        Visit <a href="?showcase=1">?showcase=1</a> for the design-system review surface.
      </p>
    </>
  );
}
