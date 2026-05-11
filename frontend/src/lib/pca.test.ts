import { describe, expect, it } from "vitest";
import { fitPCA3, projectPCA3 } from "./pca";

function makeCluster(center: number[], n: number, spread: number, seed: number): number[][] {
  let s = seed;
  const rand = () => {
    s = Math.imul(s + 0x6d2b79f5, 1) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const points: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = center.map((c) => c + (rand() * 2 - 1) * spread);
    points.push(p);
  }
  return points;
}

function distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

describe("fitPCA3 + projectPCA3", () => {
  it("returns a zero basis for empty input", () => {
    const pca = fitPCA3([]);
    expect(pca.basis[0]).toEqual([]);
    expect(projectPCA3([0, 1, 2], pca)).toEqual([0, 0, 0]);
  });

  it("separates synthetic 3-cluster gaussian in 50-d", () => {
    // Three cluster centers far apart along three different axes so the
    // PCA basis has clear principal directions to discover.
    const D = 50;
    const center1 = Array(D).fill(0);
    const center2 = Array(D).fill(0);
    const center3 = Array(D).fill(0);
    center1[0] = 6;
    center2[1] = 6;
    center3[2] = 6;
    const c1 = makeCluster(center1, 60, 0.5, 11);
    const c2 = makeCluster(center2, 60, 0.5, 22);
    const c3 = makeCluster(center3, 60, 0.5, 33);
    const pca = fitPCA3([...c1, ...c2, ...c3], { seed: 1 });

    const projC1 = c1.map((p) => projectPCA3(p, pca));
    const projC2 = c2.map((p) => projectPCA3(p, pca));
    const projC3 = c3.map((p) => projectPCA3(p, pca));

    const meanProj = (xs: [number, number, number][]) => {
      const sum = [0, 0, 0];
      for (const x of xs) {
        sum[0] += x[0];
        sum[1] += x[1];
        sum[2] += x[2];
      }
      return [sum[0] / xs.length, sum[1] / xs.length, sum[2] / xs.length];
    };
    const m1 = meanProj(projC1);
    const m2 = meanProj(projC2);
    const m3 = meanProj(projC3);

    expect(distance(m1, m2)).toBeGreaterThan(3);
    expect(distance(m1, m3)).toBeGreaterThan(3);
    expect(distance(m2, m3)).toBeGreaterThan(3);
  });

  it("eigenvalues are non-increasing", () => {
    const D = 20;
    const cluster = makeCluster(Array(D).fill(0).map((_, i) => i), 80, 1.0, 99);
    const pca = fitPCA3(cluster, { seed: 2 });
    expect(pca.eigenvalues[0]).toBeGreaterThanOrEqual(pca.eigenvalues[1]);
    expect(pca.eigenvalues[1]).toBeGreaterThanOrEqual(pca.eigenvalues[2]);
  });

  it("centers projections — projecting the mean gives ~zero", () => {
    const D = 16;
    const cluster = makeCluster(Array(D).fill(0).map((_, i) => i / 4), 100, 0.7, 7);
    const pca = fitPCA3(cluster, { seed: 3 });
    const projectedMean = projectPCA3(pca.mean, pca);
    expect(Math.abs(projectedMean[0])).toBeLessThan(1e-6);
    expect(Math.abs(projectedMean[1])).toBeLessThan(1e-6);
    expect(Math.abs(projectedMean[2])).toBeLessThan(1e-6);
  });
});
