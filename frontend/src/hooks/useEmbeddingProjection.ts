import { useEffect, useMemo, useRef, useState } from "react";
import { getUserEmbeddings } from "../lib/api";
import { fitPCA3, projectPCA3, type PCA3 } from "../lib/pca";
import { deriveProfile } from "../lib/profileVisual";
import type { UserEmbedding } from "../types";

export type ProjectedProfile = {
  userId: string;
  centroid: [number, number, number];
  samples: Array<[number, number, number]>;
  color1: string;
  color2: string;
  initials: string;
  sampleCount: number;
  enrolledAt: string;
};

export type EmbeddingProjectionState = {
  loading: boolean;
  error: Error | null;
  basis: PCA3 | null;
  profiles: ProjectedProfile[];
  refresh: () => void;
};

/**
 * V3 — fetches every enrolled profile's centroid + per-sample 192-d
 * embeddings from `GET /users/embeddings`, fits a 3-component PCA over
 * the union, and returns ready-to-render 3-d coordinates.
 *
 * The PCA basis is the same for centroids and live-point projections —
 * `useLiveEmbedding` must consume `state.basis` so the live point
 * lives in the same projected space as the clusters it's compared
 * against.
 *
 * Caller passes `refreshKey` (e.g. `profilesCount`) so the projection
 * re-fits whenever the enrolment set changes.
 */
export function useEmbeddingProjection(refreshKey: unknown = 0): EmbeddingProjectionState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [embeddings, setEmbeddings] = useState<UserEmbedding[]>([]);
  const [tick, setTick] = useState(0);
  const lastKey = useRef(refreshKey);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUserEmbeddings()
      .then((rows) => {
        if (cancelled) return;
        setEmbeddings(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick, refreshKey]);

  const { basis, profiles } = useMemo(() => {
    if (embeddings.length === 0) {
      return { basis: null as PCA3 | null, profiles: [] as ProjectedProfile[] };
    }
    // Fit PCA over centroids ∪ all per-sample embeddings — gives a basis
    // that captures both inter-speaker and intra-speaker variance.
    const allVectors: number[][] = [];
    for (const emb of embeddings) {
      allVectors.push(emb.centroid);
      for (const sample of emb.samples) allVectors.push(sample);
    }
    const fitted = fitPCA3(allVectors, { seed: 0xc0ffee });
    const projected: ProjectedProfile[] = embeddings.map((emb) => {
      const visual = deriveProfile({
        userId: emb.userId,
        sampleCount: emb.sampleCount,
        enrolledAt: emb.enrolledAt,
      });
      return {
        userId: emb.userId,
        centroid: projectPCA3(emb.centroid, fitted),
        samples: emb.samples.map((s) => projectPCA3(s, fitted)),
        color1: visual.color1,
        color2: visual.color2,
        initials: visual.initials,
        sampleCount: emb.sampleCount,
        enrolledAt: emb.enrolledAt,
      };
    });
    return { basis: fitted, profiles: projected };
  }, [embeddings]);

  if (lastKey.current !== refreshKey) {
    lastKey.current = refreshKey;
  }

  return {
    loading,
    error,
    basis,
    profiles,
    refresh: () => setTick((t) => t + 1),
  };
}
