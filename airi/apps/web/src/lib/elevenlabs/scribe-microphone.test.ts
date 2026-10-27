/** @jest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createScribeMicrophone } from "./scribe-microphone";

const getUserMedia = jest.fn();
const stopTrack = jest.fn();
const closeContext = jest.fn();
const addModule = jest.fn();
const sourceConnect = jest.fn();
const sourceDisconnect = jest.fn();
const processorConnect = jest.fn();
const processorDisconnect = jest.fn();
let contextCount = 0;
let sampleRate = 16000;
let processor: {
  port: {
    onmessage:
      | ((event: { data: { audioData?: ArrayBuffer; type?: string } }) => void)
      | null;
    postMessage: jest.Mock;
  };
  connect: jest.Mock;
  disconnect: jest.Mock;
};
const stream = {
  getTracks: () => [{ stop: stopTrack }],
  getAudioTracks: () => [{ getSettings: () => ({ sampleRate }) }],
} as unknown as MediaStream;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => {
    resolve = finish;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.resetAllMocks();
  contextCount = 0;
  sampleRate = 16000;
  getUserMedia.mockResolvedValue(stream);
  closeContext.mockResolvedValue(undefined);
  addModule.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: class {
      sampleRate = sampleRate;
      state = "running";
      destination = {};
      audioWorklet = { addModule };
      constructor() {
        contextCount += 1;
      }
      createMediaStreamSource() {
        return { connect: sourceConnect, disconnect: sourceDisconnect };
      }
      close = closeContext;
    },
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: jest.fn(() => {
      processor = {
        port: { onmessage: null, postMessage: jest.fn() },
        connect: processorConnect,
        disconnect: processorDisconnect,
      };
      return processor;
    }),
  });
});

it("releases permission granted after the session was closed", async () => {
  const permission = deferred<MediaStream>();
  getUserMedia.mockReturnValue(permission.promise);
  const microphone = createScribeMicrophone();
  const preparing = microphone.prepare();
  microphone.close();
  permission.resolve(stream);
  await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(contextCount).toBe(0);
});

it("owns cleanup while the audio worklet is loading", async () => {
  const loading = deferred<void>();
  addModule.mockReturnValue(loading.promise);
  const microphone = createScribeMicrophone();
  const preparing = microphone.prepare();
  await Promise.resolve();
  microphone.close();
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
  loading.resolve();
  await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
  expect(sourceConnect).not.toHaveBeenCalled();
});

it("cleans up microphone and context when worklet setup fails", async () => {
  addModule.mockRejectedValue(new Error("Worklet unavailable"));
  const microphone = createScribeMicrophone();
  await expect(microphone.prepare()).rejects.toThrow("Worklet unavailable");
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
  microphone.close();
  expect(stopTrack).toHaveBeenCalledTimes(1);
});

it.each([16000, 44100, 48000])("uses native PCM at %s Hz", async rate => {
  sampleRate = rate;
  const microphone = createScribeMicrophone();
  await expect(microphone.prepare()).resolves.toEqual({
    audioFormat: `pcm_${rate}`,
    sampleRate: rate,
  });
  expect(addModule).toHaveBeenCalledWith("/airi-scribe-audio-processor.js");
  microphone.close();
});

it("releases a microphone with an unsupported native sample rate", async () => {
  sampleRate = 32000;
  const microphone = createScribeMicrophone();
  await expect(microphone.prepare()).rejects.toThrow(
    "sample rate is not supported"
  );
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
});

it("only sends bounded PCM while the owned session is open", async () => {
  const microphone = createScribeMicrophone();
  const send = jest.fn();
  await microphone.prepare();
  const message = processor.port.onmessage!;
  const chunk = new Uint8Array([0, 1, 255]).buffer;
  message({ data: { audioData: chunk } });
  expect(send).not.toHaveBeenCalled();
  microphone.sendAudioTo(send);
  message({ data: { audioData: chunk } });
  expect(send).toHaveBeenCalledWith("AAH/");
  message({ data: { audioData: new ArrayBuffer(8193) } });
  expect(send).toHaveBeenCalledTimes(1);
  microphone.close();
  message({ data: { audioData: chunk } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sourceDisconnect).toHaveBeenCalledTimes(1);
  expect(processorDisconnect).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
});

it("stops capture immediately and sends the tail before resolving the flush", async () => {
  const microphone = createScribeMicrophone();
  const send = jest.fn();
  await microphone.prepare();
  microphone.sendAudioTo(send);
  const flushing = microphone.stopAndFlush();
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(sourceDisconnect).toHaveBeenCalledTimes(1);
  expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
  processor.port.onmessage!({
    data: { audioData: new Uint8Array([0, 1]).buffer },
  });
  expect(send).toHaveBeenCalledWith("AAE=");
  processor.port.onmessage!({ data: { type: "flushed" } });
  await flushing;
  microphone.close();
  expect(stopTrack).toHaveBeenCalledTimes(1);
});

it("bounds a missing worklet flush acknowledgement", async () => {
  jest.useFakeTimers();
  try {
    const microphone = createScribeMicrophone();
    await microphone.prepare();
    const flushing = microphone.stopAndFlush();
    jest.advanceTimersByTime(1000);
    await flushing;
    expect(stopTrack).toHaveBeenCalledTimes(1);
    microphone.close();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it("cancels a pending flush without forwarding late audio", async () => {
  const microphone = createScribeMicrophone();
  const send = jest.fn();
  await microphone.prepare();
  microphone.sendAudioTo(send);
  const message = processor.port.onmessage!;
  const flushing = microphone.stopAndFlush();
  microphone.close();
  await flushing;
  message({ data: { audioData: new ArrayBuffer(256) } });
  expect(send).not.toHaveBeenCalled();
});

it("converts worklet samples to bounded little-endian PCM without microphone playback", () => {
  let Processor!: new () => {
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
    port: { onmessage: (event: { data: { type: string } }) => void };
  };
  const chunks: ArrayBuffer[] = [];
  const acknowledgements: string[] = [];
  runInNewContext(
    readFileSync(
      resolve(__dirname, "../../../public/airi-scribe-audio-processor.js"),
      "utf8"
    ),
    {
      AudioWorkletProcessor: class {
        port = {
          postMessage: ({
            audioData,
            type,
          }: {
            audioData?: ArrayBuffer;
            type?: string;
          }) => {
            if (audioData) chunks.push(audioData);
            if (type) acknowledgements.push(type);
          },
        };
      },
      registerProcessor: (_name: string, constructor: typeof Processor) => {
        Processor = constructor;
      },
    }
  );
  const worklet = new Processor();
  const samples = new Float32Array(8192);
  samples.set([0, -1, 1, -2, 2]);
  const playback = new Float32Array(128).fill(1);
  expect(worklet.process([[samples]], [[playback]])).toBe(true);
  expect(chunks).toHaveLength(2);
  expect(chunks.every(chunk => chunk.byteLength === 8192)).toBe(true);
  const pcm = new DataView(chunks[0]);
  expect([0, 1, 2, 3, 4].map(index => pcm.getInt16(index * 2, true))).toEqual([
    0, -32768, 32767, -32768, 32767,
  ]);
  expect(playback.every(value => value === 0)).toBe(true);
  worklet.process([[new Float32Array(2048).fill(0.5)]], [[playback]]);
  expect(chunks).toHaveLength(2);
  worklet.port.onmessage({ data: { type: "flush" } });
  expect(chunks).toHaveLength(3);
  expect(chunks[2].byteLength).toBe(4096);
  expect(new DataView(chunks[2]).getInt16(0, true)).toBe(16384);
  expect(acknowledgements).toEqual(["flushed"]);
});
