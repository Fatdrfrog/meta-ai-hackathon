import type { AudioFormat } from "@elevenlabs/react";

const PCM_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);
const MAX_PCM_CHUNK_BYTES = 4096 * 2;
const FLUSH_TIMEOUT_MS = 1000;

/**
 * The pinned SDK cannot accept an owned stream and only registers microphone
 * cleanup after async permission/worklet setup. Its worklet is not exported.
 * Use its manual PCM transport so this session owns cleanup before each await.
 * The notifications AudioContext is shared and cannot be closed per recording;
 * existing Buffer/base64 helpers are server-only.
 */
export function createScribeMicrophone() {
  let closed = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: AudioWorkletNode | null = null;
  let sendAudio: ((audioBase64: string) => void) | null = null;
  let flushing: Promise<void> | null = null;
  let finishFlush: (() => void) | null = null;

  const stopCapture = () => {
    source?.disconnect();
    source = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  };

  const close = () => {
    closed = true;
    sendAudio = null;
    finishFlush?.();
    if (processor) {
      processor.port.onmessage = null;
      processor.disconnect();
      processor = null;
    }
    stopCapture();
    if (context) {
      void context.close().catch(() => {});
      context = null;
    }
  };

  const assertOpen = () => {
    if (closed) throw new DOMException("Dictation was cancelled", "AbortError");
  };

  const prepare = async () => {
    try {
      assertOpen();
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: { ideal: 16000 },
        },
      });
      if (closed) {
        acquired.getTracks().forEach(track => track.stop());
        assertOpen();
      }
      stream = acquired;
      const sampleRate = acquired.getAudioTracks()[0]?.getSettings().sampleRate;
      const audioContext = new AudioContext(sampleRate ? { sampleRate } : {});
      context = audioContext;
      if (!PCM_SAMPLE_RATES.has(audioContext.sampleRate)) {
        throw new Error(
          "This microphone's sample rate is not supported for dictation."
        );
      }
      await audioContext.audioWorklet.addModule(
        "/airi-scribe-audio-processor.js"
      );
      assertOpen();
      source = audioContext.createMediaStreamSource(acquired);
      processor = new AudioWorkletNode(
        audioContext,
        "airi-scribe-audio-processor"
      );
      processor.port.onmessage = event => {
        if (event.data.type === "flushed") {
          finishFlush?.();
          return;
        }
        if (
          closed ||
          !sendAudio ||
          !(event.data.audioData instanceof ArrayBuffer)
        )
          return;
        const bytes = new Uint8Array(event.data.audioData);
        if (bytes.byteLength > MAX_PCM_CHUNK_BYTES) return;
        sendAudio(btoa(String.fromCharCode(...bytes)));
      };
      source.connect(processor);
      // The processor outputs silence; the sink keeps the capture graph running.
      processor.connect(audioContext.destination);
      if (audioContext.state === "suspended") await audioContext.resume();
      assertOpen();
      return {
        audioFormat: `pcm_${audioContext.sampleRate}` as AudioFormat,
        sampleRate: audioContext.sampleRate,
      };
    } catch (error) {
      close();
      throw error;
    }
  };

  return {
    prepare,
    close,
    stopAndFlush: () => {
      if (flushing) return flushing;
      stopCapture();
      if (closed || !processor) return Promise.resolve();
      flushing = new Promise<void>(resolve => {
        const timeout = setTimeout(() => finishFlush?.(), FLUSH_TIMEOUT_MS);
        finishFlush = () => {
          clearTimeout(timeout);
          finishFlush = null;
          sendAudio = null;
          resolve();
        };
        processor!.port.postMessage({ type: "flush" });
      });
      return flushing;
    },
    sendAudioTo: (send: (audioBase64: string) => void) => {
      if (!closed) sendAudio = send;
    },
  };
}
