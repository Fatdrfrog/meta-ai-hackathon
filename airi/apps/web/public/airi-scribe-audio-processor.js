/* Convert mono microphone audio to bounded PCM16 chunks for Scribe's manual API. */
class AiriScribeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(4096 * 2);
    this.view = new DataView(this.buffer);
    this.sampleCount = 0;
    this.flushed = false;
    this.port.onmessage = event => {
      if (event.data.type !== "flush") return;
      this.flushed = true;
      if (this.sampleCount) {
        const audioData = this.buffer.slice(0, this.sampleCount * 2);
        this.port.postMessage({ audioData }, [audioData]);
        this.sampleCount = 0;
      }
      this.port.postMessage({ type: "flushed" });
    };
  }

  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    const samples = inputs[0]?.[0];
    if (this.flushed || !samples) return true;
    for (const value of samples) {
      const sample = Math.max(-1, Math.min(1, value));
      this.view.setInt16(
        this.sampleCount * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true
      );
      this.sampleCount += 1;
      if (this.sampleCount === 4096) {
        this.port.postMessage({ audioData: this.buffer }, [this.buffer]);
        this.buffer = new ArrayBuffer(4096 * 2);
        this.view = new DataView(this.buffer);
        this.sampleCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("airi-scribe-audio-processor", AiriScribeAudioProcessor);
