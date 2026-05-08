import { useEffect, useMemo, useState } from "react";
import {
  enrollSpeaker,
  enrollAuthenticatedSpeaker,
  getSession,
  listResults,
  listSpeakers,
  loginWithVoice,
  logoutSession,
  verifyAuthenticatedSpeaker,
} from "./lib/api";
import { AuthRecordingForm } from "./components/AuthRecordingForm";
import { Panel } from "./components/Panel";
import { ResultCard } from "./components/ResultCard";
import { SimilarityInsights } from "./components/SimilarityInsights";
import { VerificationHistory } from "./components/VerificationHistory";
import type { Session, VerificationResult, Speaker } from "./types";

type Screen = "home" | "register" | "login" | "workspace";

const requiredEnrollmentSamples = 3;
const sessionStorageKey = "biovoice_session_token";

function App() {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [results, setResults] = useState<VerificationResult[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [busyFlow, setBusyFlow] = useState<"register" | "login" | "workspace-enroll" | "workspace-verify" | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [registerMessage, setRegisterMessage] = useState<string | null>(null);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const [nextSpeakers, nextResults] = await Promise.all([listSpeakers(), listResults()]);
        const existingToken = window.localStorage.getItem(sessionStorageKey);
        let restoredSession: Session | null = null;

        if (existingToken) {
          try {
            restoredSession = await getSession(existingToken);
          } catch {
            window.localStorage.removeItem(sessionStorageKey);
          }
        }

        if (!alive) {
          return;
        }

        setSpeakers(nextSpeakers);
        setResults(nextResults);
        setSession(restoredSession);
        if (restoredSession) {
          setSelectedUserId(restoredSession.userId);
          setWorkspaceMessage("Session restored from previous login.");
          setScreen("workspace");
        }
        setStatus("ready");
      } catch (err) {
        if (!alive) {
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err.message : "Unable to load API data");
      }
    }

    void load();
    return () => {
      alive = false;
    };
  }, []);

  const readySpeakers = useMemo(
    () => speakers.filter((speaker) => speaker.sampleCount >= requiredEnrollmentSamples),
    [speakers],
  );

  const activeUserId = session?.userId ?? selectedUserId;
  const activeSpeaker = speakers.find((speaker) => speaker.userId === activeUserId) ?? null;
  const userResults = useMemo(
    () => results.filter((result) => result.userId === activeUserId).slice(0, 6),
    [activeUserId, results],
  );
  const scopedLatestResult: VerificationResult =
    userResults[0] ??
    results[0] ??
    {
      resultId: "demo-result",
      userId: activeUserId,
      decision: "PENDING",
      similarityScore: 0,
      deepfakeScore: 0,
      centroidSimilarity: 0,
      sampleSimilarities: [],
      message: status === "error" ? "Backend unavailable." : "No verification attempt yet.",
      createdAt: new Date().toISOString(),
    };

  async function refreshData() {
    const [nextSpeakers, nextResults] = await Promise.all([listSpeakers(), listResults()]);
    setSpeakers(nextSpeakers);
    setResults(nextResults);
    setStatus("ready");
    setError(null);
    return { nextSpeakers, nextResults };
  }

  async function handleRegister(payload: { userId: string; file: File }) {
    setBusyFlow("register");
    setError(null);
    setLoginMessage(null);
    try {
      const message = await enrollSpeaker(payload.userId, payload.file);
      const { nextSpeakers } = await refreshData();
      const speaker = nextSpeakers.find((item) => item.userId === payload.userId) ?? null;
      setSelectedUserId(payload.userId);
      setRegisterMessage(message);
      if (speaker && speaker.sampleCount >= requiredEnrollmentSamples) {
        setLoginMessage(`Registration complete for ${payload.userId}. Continue to login.`);
        setScreen("login");
      }
      return message;
    } finally {
      setBusyFlow(null);
    }
  }

  async function handleLogin(payload: { userId: string; file: File }) {
    setBusyFlow("login");
    setError(null);
    setRegisterMessage(null);
    try {
      const authResult = await loginWithVoice(payload.userId, payload.file);
      await refreshData();
      setSelectedUserId(payload.userId);
      setSession(authResult.session);
      window.localStorage.setItem(sessionStorageKey, authResult.session.sessionToken);
      setLoginMessage(authResult.verification.message);
      setWorkspaceMessage("Authenticated. You can now add new enrollment samples or run new verification checks.");
      setScreen("workspace");
      return authResult.verification.message;
    } finally {
      setBusyFlow(null);
    }
  }

  async function handleWorkspaceEnroll(payload: { userId: string; file: File }) {
    setBusyFlow("workspace-enroll");
    try {
      if (!session) {
        throw new Error("No active session. Please log in again.");
      }
      const message = await enrollAuthenticatedSpeaker(session.sessionToken, payload.file);
      await refreshData();
      setWorkspaceMessage(message);
      return message;
    } finally {
      setBusyFlow(null);
    }
  }

  async function handleWorkspaceVerify(payload: { userId: string; file: File }) {
    setBusyFlow("workspace-verify");
    try {
      if (!session) {
        throw new Error("No active session. Please log in again.");
      }
      const result = await verifyAuthenticatedSpeaker(session.sessionToken, payload.file);
      await refreshData();
      setWorkspaceMessage(result.message);
      return result.message;
    } finally {
      setBusyFlow(null);
    }
  }

  async function resetToHome() {
    if (session) {
      try {
        await logoutSession(session.sessionToken);
      } catch {
        // Ignore logout failure locally and still clear UI state.
      }
    }
    window.localStorage.removeItem(sessionStorageKey);
    setScreen("home");
    setSelectedUserId("");
    setSession(null);
    setRegisterMessage(null);
    setLoginMessage(null);
    setWorkspaceMessage(null);
  }

  return (
    <main className="app-shell auth-shell">
      {screen === "home" ? (
        <section className="landing-shell">
          <div className="landing-copy">
            <span className="eyebrow">Voice identity platform</span>
            <h1>BioVoice</h1>
            <p>
              BioVoice enrolls a user through three voice samples, authenticates with a fresh live recording,
              then lets the authenticated user submit more samples and inspect verification outcomes from one workspace.
            </p>
            <div className="hero-actions">
              <button className="primary-button" type="button" onClick={() => setScreen("register")}>
                Start registration
              </button>
              <button className="secondary-button" type="button" onClick={() => setScreen("login")}>
                Start login
              </button>
            </div>
          </div>

          <div className="landing-grid">
            <Panel title="How it works" subtitle="Simple product flow instead of a lab dashboard.">
              <div className="auth-summary-grid">
                <div>
                  <strong>Register</strong>
                  <span>Choose a username and record 3 enrollment samples.</span>
                </div>
                <div>
                  <strong>Login</strong>
                  <span>Use one fresh recording to authenticate against the enrolled voice profile.</span>
                </div>
                <div>
                  <strong>Workspace</strong>
                  <span>After a successful login, upload or record more samples and inspect verification result details.</span>
                </div>
              </div>
            </Panel>

            <Panel title="Directory status" subtitle="What the backend currently knows.">
              {status === "error" ? <p className="error-text">{error}</p> : null}
              <div className="list-card">
                {speakers.length === 0 ? (
                  <p className="muted">No registered users yet.</p>
                ) : (
                  speakers.map((speaker) => (
                    <div key={speaker.userId} className="list-row">
                      <div>
                        <strong>{speaker.userId}</strong>
                        <span>{speaker.sampleCount}/{requiredEnrollmentSamples} enrollment samples</span>
                      </div>
                      <span className="muted">
                        {speaker.sampleCount >= requiredEnrollmentSamples ? "Ready to login" : "Still registering"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Panel>
          </div>
        </section>
      ) : null}

      {screen === "register" ? (
        <section className="page-shell">
          <Panel className="page-banner" title="Register" subtitle="This page is record-only. Each user must capture three enrollment samples.">
            <div className="banner-actions">
              <button className="secondary-button" type="button" onClick={() => void resetToHome()}>
                Back to landing
              </button>
            </div>
          </Panel>

          <div className="page-grid">
            <AuthRecordingForm
              title="Enrollment recorder"
              subtitle="Record sample 1, then 2, then 3 for the same username."
              actionLabel="Save enrollment sample"
              usernameLabel="Username"
              usernamePlaceholder="Choose a unique username"
              onSubmit={handleRegister}
              busy={busyFlow === "register"}
              helperText="Upload is disabled here. Registration only accepts fresh recordings."
              statusMessage={registerMessage}
              initialUserId={selectedUserId}
              allowUpload={false}
              idleMicLabel="Ready to capture enrollment"
              steps={["Enter the username once", "Record sample 1", "Record sample 2", "Record sample 3"]}
            />

            <Panel title="Enrollment requirements" subtitle="The system uses all recorded samples to build the user reference.">
              <div className="detail-stack">
                <div className="detail-card">
                  <strong>Three recordings</strong>
                  <span>The backend only unlocks login when the username reaches 3 stored samples.</span>
                </div>
                <div className="detail-card">
                  <strong>Fresh microphone input</strong>
                  <span>Registration is intentionally mic-only so the enrollment set comes from live recordings.</span>
                </div>
                <div className="detail-card">
                  <strong>Auto-forward to login</strong>
                  <span>Once sample 3 is saved, the flow switches to the dedicated login page.</span>
                </div>
              </div>
            </Panel>
          </div>
        </section>
      ) : null}

      {screen === "login" ? (
        <section className="page-shell">
          <Panel className="page-banner" title="Login" subtitle="This page is separate from landing. Authenticate with one fresh voice sample.">
            <div className="banner-actions">
              <button className="secondary-button" type="button" onClick={() => void resetToHome()}>
                Back to landing
              </button>
            </div>
          </Panel>

          <div className="page-grid">
            <AuthRecordingForm
              title="Voice login"
              subtitle="Use the same username you registered. A successful match creates a real app session."
              actionLabel="Authenticate"
              usernameLabel="Username"
              usernamePlaceholder="Enter a registered username"
              onSubmit={handleLogin}
              busy={busyFlow === "login"}
              helperText={
                readySpeakers.length === 0
                  ? "No users are login-ready yet. Complete registration first."
                  : `Ready users: ${readySpeakers.map((speaker) => speaker.userId).join(", ")}`
              }
              statusMessage={loginMessage}
              errorMessage={status === "error" ? error : null}
              initialUserId={selectedUserId}
              allowUpload={false}
              idleMicLabel="Ready for live login sample"
              steps={["Enter username", "Record one fresh sample", "Wait for session creation after verification"]}
            />

            <Panel title="Ready accounts" subtitle="Only users with 3 enrollment samples appear here as ready.">
              <div className="list-card">
                {readySpeakers.length === 0 ? (
                  <p className="muted">No users have completed registration yet.</p>
                ) : (
                  readySpeakers.map((speaker) => (
                    <button
                      key={speaker.userId}
                      className={`user-pick ${selectedUserId === speaker.userId ? "user-pick-active" : ""}`}
                      type="button"
                      onClick={() => setSelectedUserId(speaker.userId)}
                    >
                      <strong>{speaker.userId}</strong>
                      <span>{speaker.sampleCount} enrollment samples stored</span>
                    </button>
                  ))
                )}
              </div>
            </Panel>
          </div>
        </section>
      ) : null}

      {screen === "workspace" ? (
        <section className="page-shell">
          <Panel className="page-banner" title="Workspace" subtitle={session ? `Authenticated as ${session.userId}` : "Authenticated workspace"}>
            <div className="banner-actions">
              <button className="secondary-button" type="button" onClick={() => setScreen("login")}>
                Re-login
              </button>
              <button className="primary-button" type="button" onClick={() => void resetToHome()}>
                Logout
              </button>
            </div>
          </Panel>

          <div className="workspace-grid">
            <AuthRecordingForm
              title="Add enrollment sample"
              subtitle="Upload or record a new sample to strengthen the reference profile."
              actionLabel="Add sample"
              usernameLabel="Username"
              usernamePlaceholder="Authenticated username"
              onSubmit={handleWorkspaceEnroll}
              busy={busyFlow === "workspace-enroll"}
              helperText="Use this when you want to enrich the enrolled reference set."
              statusMessage={workspaceMessage}
              initialUserId={activeUserId}
              readOnlyUserId={true}
              allowUpload={true}
              idleMicLabel="Ready to capture a new enrollment sample"
              steps={[
                "Record or upload a new WAV sample",
                "Save it to the enrolled profile",
                "The backend updates the reference centroid",
              ]}
            />

            <AuthRecordingForm
              title="Run verification"
              subtitle="Upload or record a sample to inspect similarity and spoof screening."
              actionLabel="Verify sample"
              usernameLabel="Username"
              usernamePlaceholder="Authenticated username"
              onSubmit={handleWorkspaceVerify}
              busy={busyFlow === "workspace-verify"}
              helperText="Use this to measure the latest similarity result for the authenticated user."
              statusMessage={workspaceMessage}
              initialUserId={activeUserId}
              readOnlyUserId={true}
              allowUpload={true}
              idleMicLabel="Ready to record a verification sample"
              steps={[
                "Record or upload a sample",
                "Backend runs similarity and deepfake checks",
                "Review the latest result cards below",
              ]}
            />

            <Panel title="Current profile" subtitle="Authenticated user status and enrollment depth.">
              <div className="detail-stack">
                <div className="detail-card">
                  <strong>User</strong>
                  <span>{activeUserId || "No active user"}</span>
                </div>
                <div className="detail-card">
                  <strong>Enrollment set</strong>
                  <span>{activeSpeaker ? `${activeSpeaker.sampleCount} sample(s) currently stored` : "No profile loaded"}</span>
                </div>
                <div className="detail-card">
                  <strong>Session</strong>
                  <span>{session ? `Started ${new Date(session.createdAt).toLocaleString()}` : "No active session"}</span>
                </div>
              </div>
            </Panel>

            <SimilarityInsights result={scopedLatestResult} />
            <ResultCard result={scopedLatestResult} />
            <VerificationHistory results={userResults} />
          </div>
        </section>
      ) : null}
    </main>
  );
}

export default App;
