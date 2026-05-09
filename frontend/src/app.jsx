// Main app — expert-default with sidebar nav, multi-page, settings + shortcuts.

import React, { useCallback, useEffect, useState } from "react";
import { useMicrophone, useSyntheticAudio } from "./audio.jsx";
import {
  WelcomeScreen, EnrollScreen, ProcessingScreen, VerifyScreen, DeepfakeScreen,
} from "./screens.jsx";
import { ConsoleScreen, SettingsPanel } from "./console.jsx";
import { Sidebar, DeepfakeLab, UserSettingsPage, ProfilesPage } from "./more-screens.jsx";
import { VerificationOverlay } from "./console-ext.jsx";
import { AdminScreen } from "./admin-screen.jsx";
import { AppStateProvider, useAppState, useDerivedCounts, useProfiles } from "./lib/session";

const DEFAULT_SETTINGS = {
  matchThr: 0.75, antiSpoofThr: 0.50, aggressive: true,
  maxAttempts: 3, challenge: true, twoFactor: false,
  input: 'Booth mic · Shure MV7', gain: 0.65, denoise: true,
  notifySound: true, notifyDesktop: true, notifyEmail: false,
};

const DEMO_ORDER = ['welcome', 'enroll', 'process_enroll', 'verify', 'deepfake'];
const DEMO_DWELLS = { welcome: 6000, enroll: 5500, process_enroll: 5800, verify: 7000, deepfake: 7000 };

function AppShell() {
  // mode = expert (default sidebar/multi-page) | live | self | auto (linear demo)
  const [mode, setMode] = useState('expert');
  const [page, setPage] = useState('console');
  const [screen, setScreen] = useState('console');
  const [name, setName] = useState('');
  const [overlayProfile, setOverlayProfile] = useState(null);
  const [soundOn, setSoundOn] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const profiles = useProfiles();
  const { verifyCount, threatCount } = useDerivedCounts();
  const { lastVerification } = useAppState();

  const mic = useMicrophone();
  const synth = useSyntheticAudio(true, { variant: 'human' });
  const audio = mic.state === 'live' ? mic : synth;
  const startMic = useCallback(() => mic.start(), [mic]);
  useEffect(() => { startMic(); }, []);

  useEffect(() => {
    if (mode === 'expert') setScreen('console');
    else setScreen('welcome');
  }, [mode]);

  // Auto-loop scheduler (auto mode) — Explain screen removed from rotation per Plan §3.
  useEffect(() => {
    if (mode !== 'auto') return;
    let i = 0;
    setScreen(DEMO_ORDER[0]);
    const tick = () => {
      i = (i + 1) % DEMO_ORDER.length;
      setScreen(DEMO_ORDER[i]);
      tid = setTimeout(tick, DEMO_DWELLS[DEMO_ORDER[i]]);
    };
    let tid = setTimeout(tick, DEMO_DWELLS[DEMO_ORDER[0]]);
    return () => clearTimeout(tid);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'self' || screen === 'welcome') return;
    const id = setTimeout(() => setScreen('welcome'), 60000);
    return () => clearTimeout(id);
  }, [mode, screen]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (mode === 'expert') {
        if (k === 'v' && profiles[0]) runVerification(profiles[0]);
        else if (k === '1') setPage('console');
        else if (k === '2') setPage('lab');
        else if (k === '3') setPage('profiles');
        else if (k === '4') setPage('settings');
        else if (k === '5') setPage('admin');
        else if (k === 'escape') setOverlayProfile(null);
      } else {
        if (k === 'escape') setScreen('welcome');
        else if (k === 'arrowright') {
          const i = DEMO_ORDER.indexOf(screen);
          if (i >= 0 && i < DEMO_ORDER.length - 1) setScreen(DEMO_ORDER[i + 1]);
        } else if (k === 'arrowleft') {
          const i = DEMO_ORDER.indexOf(screen);
          if (i > 0) setScreen(DEMO_ORDER[i - 1]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, screen, page, profiles]);

  // Open the verification overlay (E-17) — the overlay itself drives the real
  // record + auth/login + verify pipeline against the FastAPI backend.
  const runVerification = useCallback((profile) => {
    if (mode === 'expert') {
      setOverlayProfile(profile);
      return;
    }
    setName(profile?.name?.split(' ')[0] || profile?.userId || '');
    setScreen('process_verify');
    setTimeout(() => setScreen('verify'), 4400);
  }, [mode]);

  // Expert mode: page-based
  if (mode === 'expert') {
    let body;
    switch (page) {
      case 'lab':      body = <DeepfakeLab audio={audio} profiles={profiles}/>; break;
      case 'profiles': body = <ProfilesPage profiles={profiles} audio={audio}/>; break;
      case 'settings': body = <UserSettingsPage settings={settings} setSettings={setSettings}/>; break;
      case 'admin':    body = <AdminScreen/>; break;
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
        <SettingsPanel mode={mode} setMode={setMode} soundOn={soundOn} setSoundOn={setSoundOn}/>
        {overlayProfile && (
          <VerificationOverlay
            profile={overlayProfile}
            onClose={() => setOverlayProfile(null)}
          />
        )}
      </>
    );
  }

  // Demo modes: linear
  let body = null;
  switch (screen) {
    case 'welcome':
      body = <WelcomeScreen onStart={() => { startMic(); setScreen('enroll'); }} micState={mic.state} audio={audio}/>; break;
    case 'enroll':
      body = <EnrollScreen onComplete={(n) => { setName(n); setScreen('process_enroll'); }} audio={audio} micState={mic.state} micStart={startMic}/>; break;
    case 'process_enroll':
      body = <ProcessingScreen mode="enroll" audio={audio} onComplete={() => setScreen('verify')}/>; break;
    case 'process_verify':
      body = <ProcessingScreen mode="verify" audio={audio} onComplete={() => setScreen('verify')}/>; break;
    case 'verify':
      // G2 — `verifyResult` was undefined here (a ReferenceError when
      // `lastVerification` is null, e.g. on first paint of demo mode
      // before any real verification has run). Default to 0 — the
      // VerifyScreen renders the gauges from these values, and 0 maps
      // to a sensible "no signal yet" visual instead of crashing.
      body = <VerifyScreen
        name={name}
        similarity={lastVerification?.similarityScore ?? 0}
        dfScore={lastVerification?.deepfakeScore ?? 0}
        samples={audio.samples}
        onNext={() => setScreen('deepfake')}/>; break;
    case 'deepfake':
      body = <DeepfakeScreen audio={audio} onNext={() => setScreen('welcome')}/>; break;
    default:
      body = <WelcomeScreen onStart={() => setScreen('enroll')} micState={mic.state} audio={audio}/>;
  }

  return (
    <>
      {screen !== 'welcome' && (
        <button onClick={() => setScreen('welcome')}
          style={{
            position: 'absolute', top: 140, right: 108, zIndex: 110,
            width: 40, height: 40, borderRadius: '50%',
            border: '1px solid rgba(125,200,255,0.18)',
            background: 'rgba(10,20,34,0.6)', backdropFilter: 'blur(8px)',
            cursor: 'pointer', display: 'grid', placeItems: 'center',
            color: 'var(--ink-mute)',
          }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 7 L8 2 L14 7 V13 H10 V9 H6 V13 H2 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      <SettingsPanel mode={mode} setMode={setMode} soundOn={soundOn} setSoundOn={setSoundOn}/>
      {mode === 'live' && screen !== 'console' && <LiveNav screen={screen} setScreen={setScreen}/>}
      {body}
    </>
  );
}

function LiveNav({ screen, setScreen }) {
  const order = [
    { id: 'welcome', label: 'Attract' }, { id: 'enroll', label: 'Enroll' },
    { id: 'process_enroll', label: 'Process' }, { id: 'verify', label: 'Verify' },
    { id: 'deepfake', label: 'Deepfake' },
  ];
  const idx = order.findIndex(o => o.id === screen);
  const prev = idx > 0 ? order[idx - 1].id : null;
  const next = idx < order.length - 1 ? order[idx + 1].id : order[0].id;
  return (
    <div style={{ position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', zIndex: 100,
      display: 'flex', alignItems: 'center', gap: 8, padding: 8,
      background: 'rgba(10, 20, 34, 0.85)', backdropFilter: 'blur(12px)',
      border: '1px solid rgba(125,200,255,0.18)', borderRadius: 999 }}>
      <button onClick={() => prev && setScreen(prev)} disabled={!prev}
        style={{ background: 'transparent', border: 'none', width: 36, height: 36, borderRadius: '50%',
          color: prev ? '#7ef0ff' : 'rgba(125,200,255,0.25)', cursor: prev ? 'pointer' : 'default',
          display: 'grid', placeItems: 'center' }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2 L4 7 L9 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {order.map(o => (
        <button key={o.id} onClick={() => setScreen(o.id)}
          style={{ background: o.id === screen ? 'linear-gradient(135deg, #3da9fc, #7ef0ff)' : 'transparent',
            border: 'none', color: o.id === screen ? '#04070d' : 'var(--ink-mute)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.18em',
            textTransform: 'uppercase', padding: '8px 14px', borderRadius: 999, cursor: 'pointer',
            fontWeight: o.id === screen ? 600 : 400 }}>{o.label}</button>
      ))}
      <button onClick={() => setScreen(next)}
        style={{ background: 'linear-gradient(135deg, #3da9fc, #7ef0ff)', border: 'none',
          width: 36, height: 36, borderRadius: '50%', color: '#04070d', cursor: 'pointer',
          display: 'grid', placeItems: 'center' }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2 L10 7 L5 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  );
}

// F5.5 — phone breakpoint listener. Toggles a body-level class so the
// responsive.css rules can linearise the kiosk stage on small viewports.
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
