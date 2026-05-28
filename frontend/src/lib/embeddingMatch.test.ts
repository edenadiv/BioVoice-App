import { describe, it, expect } from "vitest";
import { cosineSimilarity, meanVector, nearestByCosine } from "./embeddingMatch";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction (scale-invariant)", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it("returns 0 when a vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("meanVector", () => {
  it("averages element-wise", () => {
    expect(meanVector([[2, 4], [4, 8]])).toEqual([3, 6]);
  });

  it("returns [] for no vectors", () => {
    expect(meanVector([])).toEqual([]);
  });

  it("returns the single vector unchanged", () => {
    expect(meanVector([[1, 2, 3]])).toEqual([1, 2, 3]);
  });
});

describe("nearestByCosine", () => {
  const candidates = [
    { userId: "alice", vector: [1, 0, 0] },
    { userId: "bob", vector: [0, 1, 0] },
    { userId: "carol", vector: [0.9, 0.1, 0] },
  ];

  it("picks the closest candidate by direction", () => {
    const match = nearestByCosine([1, 0.05, 0], candidates);
    expect(match?.userId).toBe("alice");
    expect(match?.similarity).toBeGreaterThan(0.9);
  });

  it("prefers carol when the query leans slightly off-axis toward her", () => {
    const match = nearestByCosine([0.8, 0.2, 0], candidates);
    expect(match?.userId).toBe("carol");
  });

  it("returns null with no candidates", () => {
    expect(nearestByCosine([1, 0, 0], [])).toBeNull();
  });

  it("returns null with an empty query", () => {
    expect(nearestByCosine([], candidates)).toBeNull();
  });
});
