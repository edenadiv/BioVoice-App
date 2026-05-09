// F3.1 — AudioWorkletProcessor that captures Float32 PCM and posts it to
// the main thread for accumulation. Replaces the deprecated
// ScriptProcessorNode path in lib/audio.ts. Lives under /public/ so Vite
// serves it verbatim — AudioWorklet.addModule() must fetch it as a real
// network resource, not a bundled module.
//
// The renderer batches inputs into ~85 ms windows (mirrors the 4096-frame
// cadence the old ScriptProcessor used at 48 kHz) before posting, so the
// main thread sees one transferable per batch instead of 128-sample bursts
// every 2.6 ms. That keeps the Map<Float32Array> allocator pressure off the
// hot path during 3 s recordings.

const TARGET_BATCH_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(TARGET_BATCH_FRAMES);
    this._offset = 0;
  }

  process(inputs) {
    // `inputs` is `Float32Array[][]` keyed by [input][channel]. We connect a
    // single mono input → inputs[0][0] is the channel we care about. When
    // the source disconnects (recorder.stop()) the input goes empty; return
    // false so the renderer drops the node. Otherwise return true to keep
    // pulling samples.
    const input = inputs[0];
    if (!input || input.length === 0) {
      this._flush();
      return false;
    }
    const channel = input[0];
    if (!channel || channel.length === 0) {
      // Idle frame — keep the node alive.
      return true;
    }

    let read = 0;
    while (read < channel.length) {
      const space = TARGET_BATCH_FRAMES - this._offset;
      const take = Math.min(space, channel.length - read);
      this._buffer.set(channel.subarray(read, read + take), this._offset);
      this._offset += take;
      read += take;
      if (this._offset === TARGET_BATCH_FRAMES) {
        this._flush();
      }
    }
    return true;
  }

  _flush() {
    if (this._offset === 0) return;
    // Copy into a fresh buffer of exactly the filled length so the main
    // thread receives a complete Float32Array even on a partial flush.
    const out = new Float32Array(this._offset);
    out.set(this._buffer.subarray(0, this._offset));
    this.port.postMessage({ type: "chunk", samples: out }, [out.buffer]);
    this._offset = 0;
  }
}

registerProcessor("biovoice-recorder", RecorderProcessor);
