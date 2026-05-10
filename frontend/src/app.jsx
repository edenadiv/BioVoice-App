// Main app — operator kiosk with three pages (Console / DeepfakeLab /
// Profiles). Demo modes + Welcome / Enroll / Processing / Verify /
// Deepfake animation screens were removed in the strip pass; real
// enrolment lives in EnrollModal (popped from ProfilesPage) and real
// verification in VerificationOverlay (popped from ConsoleScreen).

import React, { useCallback, useEffect, useState } from "react";
import { useMicrophone, useSilentAudio } from "./audio.jsx";
import { ConsoleScreen } from "./console.jsx";
import { Sidebar, DeepfakeLab, IdentifyScreen, ProfilesPage } from "./more-screens.jsx";
import { VerificationOverlay } from "./console-ext.jsx";
import { AppStateProvider, useDerivedCounts, useProfiles } from "./lib/session";

function AppShell() {
  const [page, setPage] = useState('console');
  const [overlayProfile, setOverlayProfile] = useState(null);

  const profiles = useProfiles();
  const { verifyCount, threatCount } = useDerivedCounts();

  const mic = useMicrophone();
  // Visualisations honestly show silence when the mic isn't recording —
  // no synthesised faux-speech.
  const silent = useSilentAudio();
  const audio = mic.state === 'live' ? mic : silent;
  const startMic = useCallback(() => mic.start(), [mic]);
  useEffect(() => { startMic(); }, []);

  // Keyboard shortcuts — number keys jump to a sidebar page.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'v' && profiles[0]) setOverlayProfile(profiles[0]);
      else if (k === '1') setPage('console');
      else if (k === '2') setPage('identify');
      else if (k === '3') setPage('lab');
      else if (k === '4') setPage('profiles');
      else if (k === 'escape') setOverlayProfile(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [profiles]);

  const runVerification = useCallback((profile) => setOverlayProfile(profile), []);

  let body;
  switch (page) {
    case 'identify':
      body = <IdentifyScreen profiles={profiles}/>; break;
    case 'lab':
      body = <DeepfakeLab audio={audio} profiles={profiles}/>; break;
    case 'profiles':
      body = <ProfilesPage profiles={profiles} audio={audio}/>; break;
    default:
      body = <ConsoleScreen
        audio={audio} micState={mic.state} micStart={startMic}
        profiles={profiles} verifyCount={verifyCount} threatCount={threatCount}
        onVerify={runVerification}
        onEnroll={() => setPage('profiles')}
        onShowDetails={() => setPage('lab')}
      />;
  }

  return (
    <>
      {body}
      <Sidebar page={page} setPage={setPage}/>
      {overlayProfile && (
        <VerificationOverlay
          profile={overlayProfile}
          onClose={() => setOverlayProfile(null)}
        />
      )}
    </>
  );
}

// Phone-breakpoint listener — toggles body.biovoice-mobile so
// responsive.css can linearise the kiosk on small viewports.
function useMobileViewportClass() {
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const apply = () => document.body.classList.toggle("biovoice-mobile", mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
}

function AppRoot() {
  useMobileViewportClass();
  return <AppShell />;
}

export default function App() {
  return (
    <AppStateProvider>
      <AppRoot />
    </AppStateProvider>
  );
}
