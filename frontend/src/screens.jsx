// Common chrome bar reused by every page (Console, ProfilesPage,
// DeepfakeLab, the EnrollModal). The five demo screens that used to
// live here (Welcome / Enroll / Processing / Verify / Deepfake) were
// deleted with the demo modes — real enrolment lives in
// components/EnrollModal.tsx and real verification in
// console-ext.jsx:VerificationOverlay.

import React, { useEffect, useRef, useState } from "react";
import {
  BrandMark, PartnerCrest,
} from "./visuals.jsx";
import { LiveClock, ThreatLevel } from "./console-ext.jsx";

function Chrome({ status = "SYSTEM ONLINE", statusKind = "good", subtitle, screenName = "" }) {
  const time = useClock();
  const sessionStart = useRef(Date.now() - 47 * 60 * 1000).current;
  return (
    <>
      <div className="chrome-top">
        <div className="left">
          <div className="wordmark">
            <div className="mark"><BrandMark size={48}/></div>
            <div>
              <div className="name"><b>BIO</b>VOICE</div>
              <div className="sub">Voice Biometric Authentication</div>
            </div>
          </div>
        </div>
        <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'nowrap' }}>
          <ThreatLevel level="amber"/>
          <LiveClock sessionStart={sessionStart}/>
          <div className="partner">
            <div className="stack" style={{ alignItems: 'flex-end' }}>
              <div className="l1">INCD</div>
            </div>
            <div className="crest"><PartnerCrest size={32}/></div>
          </div>
        </div>
      </div>
      <div className="chrome-bottom">
        <div className="left" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span className={`pill ${statusKind}`}><span className="dot"></span>{status}</span>
          {subtitle && <span className="label-mono" style={{ fontSize: 10 }}>{subtitle}</span>}
        </div>
        <div className="right" style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {screenName && <span className="label-mono" style={{ fontSize: 10 }}>SCREEN · {screenName}</span>}
          <span className="label-mono" style={{ fontSize: 10 }}>NODE · TLV-01</span>
          <span className="num-mono" style={{ fontSize: 12, color: 'var(--ink)', letterSpacing: '0.18em' }}>
            {time}
          </span>
        </div>
      </div>
    </>
  );
}

function useClock() {
  const [t, setT] = useState(() => fmtTime(new Date()));
  useEffect(() => {
    const id = setInterval(() => setT(fmtTime(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

function fmtTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh} : ${mm} : ${ss}`;
}

export { Chrome };
