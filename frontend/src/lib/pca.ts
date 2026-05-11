// Pure-JS Principal Component Analysis for projecting 192-d ReDimNet
// embeddings into the 3-d cluster space rendered by
// EmbeddingConstellation. Top-3 eigenvectors via power iteration with
// deflation on the d×d sample-covariance matrix. No deps.
//
// Math overview:
//   1. Center every input vector by subtracting the per-dimension mean.
//   2. Build the d×d covariance C = (1/(n-1)) · Σ xᵀx over centered xs.
//   3. Power-iterate to extract the top eigenvalue / eigenvector.
//   4. Deflate C ← C − λ · v vᵀ and repeat for the next two components.
//   5. Project a query vector q via projected = (q − mean) · [v1 v2 v3].
//
// Power iteration is overkill at d=192 with only ~30 vectors (rank ≤ 30
// → only ~30 non-zero eigenvalues), but it's stable, branch-free, and
// runs in well under 100ms for the kiosk's enrolment scale.

export type PCA3 = {
  mean: number[];
  // basis[i] is the i-th principal component (length d). Three rows.
  basis: [number[], number[], number[]];
  eigenvalues: [number, number, number];
};

const POWER_ITER_MAX = 400;
const POWER_ITER_TOL = 1e-9;

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function vectorL2(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

function normalize(a: number[]): number[] {
  const n = vectorL2(a);
  if (n < 1e-15) return a.map(() => 0);
  return a.map((v) => v / n);
}

// Mulberry32 — deterministic PRNG so tests are reproducible.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnit(d: number, rng: () => number): number[] {
  const v = new Array<number>(d);
  for (let i = 0; i < d; i++) v[i] = rng() * 2 - 1;
  return normalize(v);
}

// Multiply C · v in-place where C is provided as a flat row-major d×d
// array. Allocates the output for clarity; called O(iter) times so the
// extra allocation isn't worth squeezing out.
function matVec(c: Float64Array, d: number, v: number[]): number[] {
  const out = new Array<number>(d);
  for (let i = 0; i < d; i++) {
    let s = 0;
    const row = i * d;
    for (let j = 0; j < d; j++) s += c[row + j] * v[j];
    out[i] = s;
  }
  return out;
}

function powerIterate(c: Float64Array, d: number, rng: () => number): { vec: number[]; val: number } {
  let v = randomUnit(d, rng);
  let lambda = 0;
  for (let iter = 0; iter < POWER_ITER_MAX; iter++) {
    const w = matVec(c, d, v);
    const norm = vectorL2(w);
    if (norm < 1e-15) {
      // Subspace exhausted — return zero direction so the caller can
      // pad the basis without dividing by 0 downstream.
      return { vec: v.map(() => 0), val: 0 };
    }
    const vNew = w.map((x) => x / norm);
    if (Math.abs(norm - lambda) < POWER_ITER_TOL * Math.max(1, norm)) {
      return { vec: vNew, val: norm };
    }
    v = vNew;
    lambda = norm;
  }
  return { vec: v, val: lambda };
}

function deflate(c: Float64Array, d: number, vec: number[], val: number): void {
  for (let i = 0; i < d; i++) {
    const row = i * d;
    const vi = vec[i];
    for (let j = 0; j < d; j++) {
      c[row + j] -= val * vi * vec[j];
    }
  }
}

/** Fit a 3-component PCA to a list of d-dimensional vectors. */
export function fitPCA3(vectors: number[][], options: { seed?: number } = {}): PCA3 {
  if (vectors.length === 0) {
    return { mean: [], basis: [[], [], []], eigenvalues: [0, 0, 0] };
  }
  const d = vectors[0].length;
  const n = vectors.length;
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < d; i++) mean[i] += v[i];
  }
  for (let i = 0; i < d; i++) mean[i] /= n;

  // Build covariance in a Float64Array for tight numeric loops.
  const c = new Float64Array(d * d);
  const denom = Math.max(1, n - 1);
  for (const v of vectors) {
    for (let i = 0; i < d; i++) {
      const ci = v[i] - mean[i];
      const row = i * d;
      for (let j = 0; j < d; j++) {
        c[row + j] += (ci * (v[j] - mean[j])) / denom;
      }
    }
  }

  const rng = makeRng(options.seed ?? 0xb1ef00d);
  const components: number[][] = [];
  const eigenvalues: number[] = [];
  for (let k = 0; k < 3; k++) {
    const { vec, val } = powerIterate(c, d, rng);
    components.push(vec);
    eigenvalues.push(val);
    if (val > 0) deflate(c, d, vec, val);
  }
  return {
    mean,
    basis: [components[0], components[1], components[2]],
    eigenvalues: [eigenvalues[0], eigenvalues[1], eigenvalues[2]],
  };
}

/** Project a single d-dimensional vector through the fitted basis. */
export function projectPCA3(vector: number[], pca: PCA3): [number, number, number] {
  if (pca.basis[0].length === 0) return [0, 0, 0];
  const centered = vector.map((v, i) => v - (pca.mean[i] ?? 0));
  return [
    dotProduct(centered, pca.basis[0]),
    dotProduct(centered, pca.basis[1]),
    dotProduct(centered, pca.basis[2]),
  ];
}
