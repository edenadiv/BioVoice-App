import { describe, expect, it } from "vitest";
import { formantsLPC, jitterPercent, pitchAutocorrelation, snrFromVad } from "./dsp";

const SR = 16000;

function sine(freq: number, durationSec: number, amplitude = 0.5): Float32Array {
  const n = Math.floor(durationSec * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function whiteNoise(n: number, amplitude: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rand = () => {
    s = Math.imul(s + 0x6d2b79f5, 1) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * (rand() * 2 - 1);
  return out;
}

function impulseTrain(freq: number, durationSec: number): Float32Array {
  const n = Math.floor(durationSec * SR);
  const out = new Float32Array(n);
  const period = SR / freq;
  for (let i = 0; i < n; i++) {
    out[i] = i % Math.round(period) === 0 ? 1.0 : 0.0;
  }
  return out;
}

/** 2nd-order resonator at (f0, bw): biquad with a complex pole pair. */
function applyResonator(input: Float32Array, f0: number, bw: number): Float32Array {
  const r = Math.exp((-Math.PI * bw) / SR);
  const theta = (2 * Math.PI * f0) / SR;
  const a1 = -2 * r * Math.cos(theta);
  const a2 = r * r;
  const out = new Float32Array(input.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const y = input[i] - a1 * y1 - a2 * y2;
    out[i] = y;
    y2 = y1;
    y1 = y;
  }
  return out;
}

describe("pitchAutocorrelation", () => {
  it("recovers 220 Hz from a clean sine", () => {
    const f = pitchAutocorrelation(sine(220, 0.1), SR);
    expect(f).toBeGreaterThan(218);
    expect(f).toBeLessThan(222);
  });

  it("recovers 110 Hz", () => {
    const f = pitchAutocorrelation(sine(110, 0.1), SR);
    expect(f).toBeGreaterThan(108);
    expect(f).toBeLessThan(112);
  });

  it("returns 0 on silence", () => {
    expect(pitchAutocorrelation(new Float32Array(1024), SR)).toBe(0);
  });

  it("returns 0 on white noise", () => {
    // No periodicity → autocorr peak should be below the voicing threshold.
    const f = pitchAutocorrelation(whiteNoise(2048, 0.05, 7), SR);
    expect(f).toBe(0);
  });
});

describe("formantsLPC", () => {
  it("recovers two known resonances within ±80 Hz from white-noise excitation", () => {
    // White noise through two cascaded narrow resonators produces a
    // signal whose LPC poles sit near the resonator centre frequencies.
    // (Impulse trains are too sparse for clean LPC analysis.)
    const src = whiteNoise(Math.floor(0.2 * SR), 0.05, 42);
    const stage1 = applyResonator(src, 700, 80);
    const stage2 = applyResonator(stage1, 1700, 100);
    const [f1, f2] = formantsLPC(stage2, SR, 12);
    expect(Math.abs(f1 - 700)).toBeLessThan(80);
    expect(Math.abs(f2 - 1700)).toBeLessThan(80);
  });

  it("returns zeros for very short input", () => {
    const [f1, f2, f3] = formantsLPC(new Float32Array(8), SR, 12);
    expect(f1).toBe(0);
    expect(f2).toBe(0);
    expect(f3).toBe(0);
  });
});

describe("jitterPercent", () => {
  it("is ~0 for a stable period buffer", () => {
    const stable = Array(20).fill(73);
    expect(jitterPercent(stable)).toBeLessThan(0.01);
  });

  it("rises with cycle-to-cycle perturbation", () => {
    // Alternate periods produce a sharp cycle-to-cycle delta.
    const wobbly = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 70 : 76));
    const j = jitterPercent(wobbly);
    expect(j).toBeGreaterThan(5);
  });

  it("returns 0 for empty / single-element buffers", () => {
    expect(jitterPercent([])).toBe(0);
    expect(jitterPercent([100])).toBe(0);
  });
});

describe("snrFromVad", () => {
  it("computes the expected dB ratio for a known mixture", () => {
    // Voiced segment: sine at amplitude 0.5 → power 0.125.
    // Unvoiced segment: noise at amplitude 0.05 → power ≈ 0.05²/3.
    const voiced = sine(220, 0.1, 0.5);
    const unvoiced = whiteNoise(voiced.length, 0.05, 11);
    const samples = new Float32Array(voiced.length + unvoiced.length);
    samples.set(unvoiced, 0);
    samples.set(voiced, unvoiced.length);
    const mask: boolean[] = [];
    for (let i = 0; i < unvoiced.length; i++) mask.push(false);
    for (let i = 0; i < voiced.length; i++) mask.push(true);
    const snr = snrFromVad(samples, mask);
    // Sanity range: voiced power ≈ 0.125, noise power ≈ 0.000833 → ~22 dB.
    expect(snr).toBeGreaterThan(15);
    expect(snr).toBeLessThan(30);
  });

  it("returns 0 if either bucket is empty", () => {
    const samples = sine(220, 0.05);
    const allTrue = Array(samples.length).fill(true);
    expect(snrFromVad(samples, allTrue)).toBe(0);
    const allFalse = Array(samples.length).fill(false);
    expect(snrFromVad(samples, allFalse)).toBe(0);
  });
});
