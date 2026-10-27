/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { useScenarioGeneratorWizard } from "./use-scenario-generator-wizard";

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("@elevenlabs/react", () => {
  const { TextEncoder, TextDecoder } = jest.requireActual("node:util");
  Object.assign(globalThis, { TextEncoder, TextDecoder });
  return jest.requireActual("@elevenlabs/react");
});
jest.mock("@/lib/scenarios/client", () => ({
  fetchElevenLabsScribeToken: jest.fn(async () => ({
    token: "local-test-token",
  })),
}));

// Exercise the installed SDK rather than hiding its connectionRef/CLOSE race.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static sockets: FakeWebSocket[] = [];
  readyState = 0;
  events = new Map<string, Array<(event: object) => void>>();
  constructor() {
    FakeWebSocket.sockets.push(this);
  }
  addEventListener(name: string, listener: (event: object) => void) {
    this.events.set(name, [...(this.events.get(name) ?? []), listener]);
  }
  emit(name: string, event: object = {}) {
    if (name === "open") this.readyState = FakeWebSocket.OPEN;
    if (name === "close") this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.events.get(name) ?? []) listener(event);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSING;
  }
  send(payload: string) {
    if (JSON.parse(payload).commit) {
      this.emit("message", {
        data: JSON.stringify({
          message_type: "committed_transcript",
          text: "Final dictated words",
        }),
      });
    }
  }
}

const getUserMedia = jest.fn();
const addModule = jest.fn();
const closeContext = jest.fn();
let processorCount = 0;
const props = {
  open: true,
  workspaceId: "workspace-1",
  isCreating: false,
  onOpenChange: jest.fn(),
};
const makeStream = () => {
  const stop = jest.fn();
  return {
    stop,
    stream: {
      getTracks: () => [{ stop }],
      getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 16000 }) }],
    } as unknown as MediaStream,
  };
};

beforeEach(() => {
  FakeWebSocket.sockets = [];
  processorCount = 0;
  getUserMedia.mockReset();
  addModule.mockReset().mockResolvedValue(undefined);
  closeContext.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: class {
      sampleRate = 16000;
      state = "running";
      destination = {};
      audioWorklet = { addModule };
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      close = closeContext;
    },
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: class {
      port: {
        onmessage: ((event: { data: { type: string } }) => void) | null;
        postMessage: () => void;
      } = {
        onmessage: null,
        postMessage: () => this.port.onmessage?.({ data: { type: "flushed" } }),
      };
      constructor() {
        processorCount += 1;
      }
      connect() {}
      disconnect() {}
    },
  });
});

it("closes its captured connection B after the real SDK loses it to A's delayed CLOSE", async () => {
  const first = makeStream();
  const second = makeStream();
  getUserMedia
    .mockResolvedValueOnce(first.stream)
    .mockResolvedValueOnce(second.stream);
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  const socketA = FakeWebSocket.sockets[0];
  act(() => socketA.emit("open"));
  await act(async () => result.current.handleStopVoiceDictation());
  await act(async () => result.current.handleStartVoiceDictation());
  const socketB = FakeWebSocket.sockets[1];
  act(() => socketB.emit("open"));
  act(() =>
    socketA.emit("close", {
      wasClean: true,
      code: 1000,
      reason: "User ended session",
    })
  );
  expect(result.current.isVoiceActive).toBe(true);
  await act(async () => result.current.handleStopVoiceDictation());
  expect(socketB.readyState).toBe(FakeWebSocket.CLOSING);
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(second.stop).toHaveBeenCalledTimes(1);
});

it("stops permission granted after Stop without starting the SDK microphone mode", async () => {
  const microphone = makeStream();
  let grant!: (stream: MediaStream) => void;
  getUserMedia.mockReturnValue(
    new Promise<MediaStream>(resolve => {
      grant = resolve;
    })
  );
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.handleStartVoiceDictation();
    await Promise.resolve();
  });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  await act(async () => result.current.handleStopVoiceDictation());
  await act(async () => {
    grant(microphone.stream);
    await start;
  });
  expect(microphone.stop).toHaveBeenCalledTimes(1);
  expect(processorCount).toBe(0);
  expect(FakeWebSocket.sockets).toHaveLength(0);
});

it("cleans up immediately when unmounted during worklet loading", async () => {
  const microphone = makeStream();
  getUserMedia.mockResolvedValue(microphone.stream);
  let finishLoading!: () => void;
  addModule.mockReturnValue(
    new Promise<void>(resolve => {
      finishLoading = resolve;
    })
  );
  const { result, unmount } = renderHook(() =>
    useScenarioGeneratorWizard(props)
  );
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.handleStartVoiceDictation();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(addModule).toHaveBeenCalledTimes(1);
  unmount();
  expect(microphone.stop).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishLoading();
    await start;
  });
  expect(processorCount).toBe(0);
  expect(FakeWebSocket.sockets).toHaveLength(0);
});
