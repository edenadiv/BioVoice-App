// Main app — operator kiosk with three pages (Console / DeepfakeLab /
// Profiles). Demo modes + Welcome / Enroll / Processing / Verify /
// Deepfake animation screens were removed in the strip pass; real
// enrolment lives in EnrollModal (popped from ProfilesPage) and real
// verification in VerificationOverlay (popped from ConsoleScreen).

import React, { useCallback, useEffect, useState } from "react";
import { useMicrophone, useSilentAudio } from "./audio.jsx";
import { ConsoleScreen } from "./console.jsx";
import { Sidebar, DeepfakeLab, IdentifyScreen, LogsScreen, UserSettingsPage, ProfilesPage } from "./more-screens.jsx";
import { VerificationOverlay } from "./console-ext.jsx";
import { AppStateProvider, useDerivedCounts, useProfiles } from "./lib/session";

function AppShell() {
  const [page, setPage] = useState('console');
  const [overlayProfile, setOverlayProfile] = useState(null);
  const [selectedProfileId, setSelectedProfileId] = useState(null);

  const profiles = useProfiles();
  const { verifyCount, threatCount } = useDerivedCounts();

  // Keep selectedProfileId valid as profiles list changes.
  useEffect(() => {
    if (profiles.length === 0) { setSelectedProfileId(null); return; }
    if (!selectedProfileId || !profiles.some(p => p.id === selectedProfileId)) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  const mic = useMicrophone();
  const silent = useSilentAudio();
  const audio = mic.state === 'live' ? mic : silent;
  const startMic = useCallback(() => mic.start(), [mic]);
  useEffect(() => { startMic(); }, []);

  // Keyboard shortcuts — V verifies the selected profile, E opens enrollment.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'v') {
        const p = profiles.find(p => p.id === selectedProfileId) ?? profiles[0];
        if (p) setOverlayProfile(p);
      } else if (k === 'e') {
        setPage('profiles');
      } else if (k === '1') setPage('console');
      else if (k === '2') setPage('identify');
      else if (k === '3') setPage('logs');
      else if (k === '4') setPage('lab');
      else if (k === '5') setPage('profiles');
      else if (k === '6') setPage('settings');
      else if (k === 'escape') setOverlayProfile(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [profiles, selectedProfileId]);

  const runVerification = useCallback((profile) => setOverlayProfile(profile), []);

  let body;
  switch (page) {
    case 'identify':
      body = <IdentifyScreen profiles={profiles}/>; break;
    case 'logs':
      body = <LogsScreen profiles={profiles}/>; break;
    case 'lab':
      body = <DeepfakeLab audio={audio} profiles={profiles}/>; break;
    case 'profiles':
      body = <ProfilesPage profiles={profiles} audio={audio}/>; break;
    case 'settings':
      body = <UserSettingsPage/>; break;
    default:
      body = <ConsoleScreen
        audio={audio} micState={mic.state} micStart={startMic}
        profiles={profiles} verifyCount={verifyCount} threatCount={threatCount}
        selectedProfileId={selectedProfileId}
        onSelectProfile={setSelectedProfileId}
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
    const compactMql = window.matchMedia("(max-width: 1439px)");
    const tabletMql = window.matchMedia("(max-width: 1023px)");
    const mobileMql = window.matchMedia("(max-width: 767px)");
    const apply = () => {
      document.body.classList.toggle("biovoice-compact", compactMql.matches);
      document.body.classList.toggle("biovoice-tablet", tabletMql.matches);
      document.body.classList.toggle("biovoice-mobile", mobileMql.matches);
    };
    apply();
    compactMql.addEventListener("change", apply);
    tabletMql.addEventListener("change", apply);
    mobileMql.addEventListener("change", apply);
    return () => {
      compactMql.removeEventListener("change", apply);
      tabletMql.removeEventListener("change", apply);
      mobileMql.removeEventListener("change", apply);
    };
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
