import { describe, it, expect } from "vitest";
import { complementSegments, sliceBufferToFloat32 } from "./explainAudio";

// AudioBuffer isn't available in happy-dom; stub the two members the
// function uses. 1000 Hz sample rate => 1 sample per millisecond.
function stubBuffer(sampleRate: number, data: number[]): AudioBuffer {
  const ch = new Float32Array(data);
  return { sampleRate, getChannelData: () => ch } as unknown as AudioBuffer;
}

describe("sliceBufferToFloat32", () => {
  it("slices by [startMs, endMs] at the buffer sample rate", () => {
    const buf = stubBuffer(1000, Array.from({ length: 1000 }, (_, i) => i));
    const slice = sliceBufferToFloat32(buf, 100, 300);
    expect(slice.length).toBe(200);
    expect(slice[0]).toBe(100);
    expect(slice[slice.length - 1]).toBe(299);
  });

  it("clamps the end to the buffer length", () => {
    const buf = stubBuffer(1000, Array.from({ length: 100 }, (_, i) => i));
    const slice = sliceBufferToFloat32(buf, 50, 5000);
    expect(slice.length).toBe(50);
    expect(slice[0]).toBe(50);
  });

  it("returns empty for a zero-width or inverted range", () => {
    const buf = stubBuffer(1000, Array.from({ length: 100 }, (_, i) => i));
    expect(sliceBufferToFloat32(buf, 80, 80).length).toBe(0);
    expect(sliceBufferToFloat32(buf, 90, 50).length).toBe(0);
  });
});

describe("complementSegments", () => {
  const seg = (startMs: number, endMs: number) => ({ startMs, endMs, peak: 1 });

  it("returns the gaps between salient bands across the clip", () => {
    const out = complementSegments([seg(200, 500), seg(700, 800)], 1000);
    expect(out.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 200],
      [500, 700],
      [800, 1000],
    ]);
  });

  it("is the whole clip when there are no salient bands", () => {
    expect(complementSegments([], 1000)).toEqual([{ startMs: 0, endMs: 1000, peak: 0 }]);
  });

  it("merges overlapping bands and drops empty gaps", () => {
    const out = complementSegments([seg(0, 400), seg(300, 600)], 600);
    expect(out).toEqual([]);
  });
});
