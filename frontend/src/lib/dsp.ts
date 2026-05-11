// Pure-JS DSP for the operator console's LiveFeatures panel.
// All four functions are pure (input Float32Array / number[] →
// number) so they're easy to unit-test against synthetic signals.
// No FFT — autocorrelation is faster than FFT for the lags we care
// about and avoids pulling in a transform library.

const PITCH_VOICING_THRESHOLD = 0.3; // normalised autocorr peak — below this we call it silence
const PITCH_MIN_HZ = 80;
const PITCH_MAX_HZ = 400;

const PRE_EMPHASIS_ALPHA = 0.97;
const FORMANT_BANDWIDTH_MAX_HZ = 600;
const FORMANT_MIN_HZ = 90;

// ---------------------------------------------------------------------
// Pitch — Boersma-style autocorrelation in the time domain.
// ---------------------------------------------------------------------

function applyHann(samples: Float32Array): Float32Array {
  const n = samples.length;
  const out = new Float32Array(n);
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    out[i] = samples[i] * w;
  }
  return out;
}

function autocorrAt(samples: Float32Array, lag: number): number {
  const n = samples.length;
  let s = 0;
  const limit = n - lag;
  for (let i = 0; i < limit; i++) s += samples[i] * samples[i + lag];
  return s;
}

/** Returns the dominant pitch in Hz, or 0 if the input is silent / unvoiced. */
export function pitchAutocorrelation(samples: Float32Array, sampleRate: number): number {
  if (samples.length < 64) return 0;
  const windowed = applyHann(samples);
  const r0 = autocorrAt(windowed, 0);
  if (r0 < 1e-8) return 0;

  const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
  const maxLag = Math.min(windowed.length - 2, Math.floor(sampleRate / PITCH_MIN_HZ));

  let bestLag = 0;
  let bestNormalised = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = autocorrAt(windowed, lag) / r0;
    if (r > bestNormalised) {
      bestNormalised = r;
      bestLag = lag;
    }
  }
  if (bestNormalised < PITCH_VOICING_THRESHOLD) return 0;

  // Parabolic interpolation around the peak for sub-sample resolution.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const r1 = autocorrAt(windowed, bestLag - 1);
    const r2 = bestNormalised * r0;
    const r3 = autocorrAt(windowed, bestLag + 1);
    const denom = r1 - 2 * r2 + r3;
    if (Math.abs(denom) > 1e-12) {
      refinedLag = bestLag + (0.5 * (r1 - r3)) / denom;
    }
  }
  return sampleRate / refinedLag;
}

// ---------------------------------------------------------------------
// Formants — Levinson-Durbin LPC + Durand-Kerner root finding.
// ---------------------------------------------------------------------

function preEmphasise(samples: Float32Array, alpha: number): Float32Array {
  const n = samples.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  out[0] = samples[0];
  for (let i = 1; i < n; i++) out[i] = samples[i] - alpha * samples[i - 1];
  return out;
}

function applyHamming(samples: Float32Array): Float32Array {
  const n = samples.length;
  const out = new Float32Array(n);
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = samples[i] * w;
  }
  return out;
}

/** Levinson-Durbin recursion (MATLAB convention).
 * Returns LPC coefficients a = [1, a_1, ..., a_p] satisfying the
 * polynomial A(z) = 1 + a_1·z^-1 + ... + a_p·z^-p, whose roots inside
 * the unit circle are the formant poles. */
function levinsonDurbin(autocorr: Float64Array, order: number): Float64Array {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  if (autocorr[0] < 1e-12) return a;
  let error = autocorr[0];
  const work = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    // k = -(R[i] + Σ_{j=1..i-1} a[j]·R[i-j]) / error
    let k = -autocorr[i];
    for (let j = 1; j < i; j++) k -= a[j] * autocorr[i - j];
    k /= error;
    // |k| > 1 means numerical instability — abandon higher orders.
    if (!Number.isFinite(k) || Math.abs(k) >= 1) break;
    work[i] = k;
    for (let j = 1; j < i; j++) work[j] = a[j] + k * a[i - j];
    for (let j = 1; j <= i; j++) a[j] = work[j];
    error *= 1 - k * k;
    if (error < 1e-12) break;
  }
  return a;
}

type Complex = { re: number; im: number };

function cAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}
function cSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}
function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function cDiv(a: Complex, b: Complex): Complex {
  const denom = b.re * b.re + b.im * b.im;
  if (denom < 1e-30) return { re: 0, im: 0 };
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
}
function cAbs(a: Complex): number {
  return Math.sqrt(a.re * a.re + a.im * a.im);
}
function cArg(a: Complex): number {
  return Math.atan2(a.im, a.re);
}

/** Evaluate polynomial p(z) where coeffs are [a_0, a_1, ..., a_n] (z^0 first). */
function polyEval(coeffs: Float64Array, z: Complex): Complex {
  let acc: Complex = { re: 0, im: 0 };
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = cAdd(cMul(acc, z), { re: coeffs[i], im: 0 });
  }
  return acc;
}

/** Durand-Kerner / Weierstrass: simultaneous root-finding for a degree-n polynomial. */
function findRoots(coeffs: Float64Array, maxIter = 200): Complex[] {
  const n = coeffs.length - 1;
  if (n <= 0) return [];
  const roots: Complex[] = [];
  // Initial guesses on a circle of radius 0.9 — keeps us inside the
  // unit disk where formants live for stable LPC.
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n + 0.4;
    roots.push({ re: 0.9 * Math.cos(angle), im: 0.9 * Math.sin(angle) });
  }
  const leading = coeffs[n];
  if (Math.abs(leading) < 1e-12) return roots;
  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      let denom: Complex = { re: leading, im: 0 };
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        denom = cMul(denom, cSub(roots[i], roots[j]));
      }
      const delta = cDiv(polyEval(coeffs, roots[i]), denom);
      roots[i] = cSub(roots[i], delta);
      const m = cAbs(delta);
      if (m > maxDelta) maxDelta = m;
    }
    if (maxDelta < 1e-9) break;
  }
  return roots;
}

/**
 * Returns [F1, F2, F3] in Hz. Any unfound formant is returned as 0
 * (e.g. on silence or short windows).
 */
export function formantsLPC(
  samples: Float32Array,
  sampleRate: number,
  order = 12,
): [number, number, number] {
  if (samples.length < order * 2) return [0, 0, 0];
  const pre = preEmphasise(samples, PRE_EMPHASIS_ALPHA);
  const win = applyHamming(pre);
  // Autocorrelation 0..order
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = 0; i < win.length - lag; i++) s += win[i] * win[i + lag];
    r[lag] = s;
  }
  if (r[0] < 1e-12) return [0, 0, 0];
  const a = levinsonDurbin(r, order);

  // Reverse coefficients so index = power of z (Durand-Kerner expects z^0 first).
  const coeffs = new Float64Array(order + 1);
  for (let i = 0; i <= order; i++) coeffs[i] = a[order - i];

  const roots = findRoots(coeffs);
  type Candidate = { freq: number; bandwidth: number };
  const candidates: Candidate[] = [];
  for (const root of roots) {
    if (root.im < 1e-9) continue; // skip real / negative-imag duplicates
    const mag = cAbs(root);
    if (mag <= 0 || mag >= 1) continue;
    const freq = (sampleRate / (2 * Math.PI)) * Math.abs(cArg(root));
    if (freq < FORMANT_MIN_HZ || freq > sampleRate / 2 - 50) continue;
    const bandwidth = -(sampleRate / Math.PI) * Math.log(mag);
    if (bandwidth > FORMANT_BANDWIDTH_MAX_HZ) continue;
    candidates.push({ freq, bandwidth });
  }
  candidates.sort((x, y) => x.freq - y.freq);
  const f1 = candidates[0]?.freq ?? 0;
  const f2 = candidates[1]?.freq ?? 0;
  const f3 = candidates[2]?.freq ?? 0;
  return [f1, f2, f3];
}

// ---------------------------------------------------------------------
// Jitter — cycle-to-cycle relative absolute period difference.
// ---------------------------------------------------------------------

/**
 * Computes the canonical "jitter (local)" metric: the mean absolute
 * difference between adjacent glottal-cycle periods, divided by the
 * mean period, expressed as a percentage. Empty / single-period
 * buffers return 0.
 */
export function jitterPercent(periodSamples: number[]): number {
  if (periodSamples.length < 2) return 0;
  let sum = 0;
  for (const p of periodSamples) sum += p;
  const mean = sum / periodSamples.length;
  if (mean < 1e-12) return 0;
  let diffSum = 0;
  for (let i = 1; i < periodSamples.length; i++) {
    diffSum += Math.abs(periodSamples[i] - periodSamples[i - 1]);
  }
  return ((diffSum / (periodSamples.length - 1)) / mean) * 100;
}

// ---------------------------------------------------------------------
// SNR — VAD-gated power ratio (no magic offsets).
// ---------------------------------------------------------------------

/**
 * Computes 10·log10(P_voiced / P_unvoiced). Returns 0 if either bucket
 * is empty (insufficient information rather than a misleading number).
 * Caller supplies the VAD mask (one bool per sample); we don't compute
 * VAD here because the recorder already maintains it.
 */
export function snrFromVad(samples: Float32Array, vadMask: boolean[]): number {
  const n = Math.min(samples.length, vadMask.length);
  if (n === 0) return 0;
  let signalSum = 0;
  let signalCount = 0;
  let noiseSum = 0;
  let noiseCount = 0;
  for (let i = 0; i < n; i++) {
    const sq = samples[i] * samples[i];
    if (vadMask[i]) {
      signalSum += sq;
      signalCount++;
    } else {
      noiseSum += sq;
      noiseCount++;
    }
  }
  if (signalCount === 0 || noiseCount === 0) return 0;
  const signalPower = signalSum / signalCount;
  const noisePower = noiseSum / noiseCount;
  if (noisePower < 1e-15) return 0;
  return 10 * Math.log10(signalPower / noisePower);
}
