// Cosine matching over raw 192-d speaker embeddings. Used by the Explain
// orb to find which enrolled speaker a Grad-CAM salient region is closest
// to — computed in the full embedding space (not the PCA(3) projection),
// so the answer matches the verification pipeline's notion of similarity.

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Element-wise mean of equal-length vectors. Returns [] when given no
// vectors. Used to collapse a clip's salient-region embeddings into one
// representative point before matching.
export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) out[i] += v[i] ?? 0;
  }
  for (let i = 0; i < dim; i += 1) out[i] /= vectors.length;
  return out;
}

export type CosineCandidate = { userId: string; vector: number[] };
export type CosineMatch = { userId: string; similarity: number };

// Nearest candidate to `query` by cosine similarity. Returns null when
// there are no candidates or the query is empty.
export function nearestByCosine(
  query: number[],
  candidates: CosineCandidate[],
): CosineMatch | null {
  if (query.length === 0 || candidates.length === 0) return null;
  let best: CosineMatch | null = null;
  for (const c of candidates) {
    const similarity = cosineSimilarity(query, c.vector);
    if (best === null || similarity > best.similarity) {
      best = { userId: c.userId, similarity };
    }
  }
  return best;
}
