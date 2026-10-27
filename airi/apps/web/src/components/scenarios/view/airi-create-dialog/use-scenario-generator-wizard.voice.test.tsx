/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ChangeEvent } from "react";
import { toast } from "sonner";
import { SOURCE_MENTION_OPTIONS, type AiriCreateDialogProps } from "./shared";
import { useScenarioGeneratorWizard } from "./use-scenario-generator-wizard";

const mockFetchToken = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockCommit = jest.fn();
const mockGetConnection = jest.fn();
const mockCreateMicrophone = jest.fn();
const mockPrepareMicrophone = jest.fn();
let mockMicrophones: Array<{
  prepare: jest.Mock;
  close: jest.Mock;
  sendAudioTo: jest.Mock;
  stopAndFlush: jest.Mock;
}> = [];
let mockScribeOptions: {
  onPartialTranscript: (data: { text: string }) => void;
  onCommittedTranscript: (data: { text: string }) => void;
  onError: (error: Error) => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("@/lib/scenarios/client", () => ({
  fetchElevenLabsScribeToken: (...args: unknown[]) => mockFetchToken(...args),
}));
jest.mock("@/lib/elevenlabs/scribe-microphone", () => ({
  createScribeMicrophone: () => mockCreateMicrophone(),
}));
jest.mock("@elevenlabs/react", () => ({
  CommitStrategy: { VAD: "vad" },
  useScribe: (options: typeof mockScribeOptions) => {
    mockScribeOptions = options;
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      commit: mockCommit,
      getConnection: mockGetConnection,
      status: "disconnected",
      isConnected: false,
      isTranscribing: false,
    };
  },
}));

const props: AiriCreateDialogProps = {
  open: true,
  onOpenChange: jest.fn(),
  isCreating: false,
  workspaceId: "workspace-1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockFetchToken.mockResolvedValue({ token: "token-1" });
  mockGetConnection.mockReturnValue({
    commit: mockCommit,
    close: jest.fn(),
    send: jest.fn(),
  });
  mockMicrophones = [];
  mockPrepareMicrophone.mockResolvedValue({
    audioFormat: "pcm_16000",
    sampleRate: 16000,
  });
  mockCreateMicrophone.mockImplementation(() => {
    const microphone = {
      prepare: mockPrepareMicrophone,
      close: jest.fn(),
      sendAudioTo: jest.fn(),
      stopAndFlush: jest.fn().mockResolvedValue(undefined),
    };
    mockMicrophones.push(microphone);
    return microphone;
  });
});

it("deduplicates dictation starts while the token is pending", async () => {
  const token = deferred<{ token: string }>();
  mockFetchToken.mockReturnValue(token.promise);
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.handleStartVoiceDictation();
    second = result.current.handleStartVoiceDictation();
  });
  expect(mockFetchToken).toHaveBeenCalledTimes(1);
  expect(result.current.isVoiceActive).toBe(true);
  await act(async () => {
    token.resolve({ token: "token-1" });
    await Promise.all([first, second]);
  });
  expect(mockConnect).toHaveBeenCalledTimes(1);
});

it("starts dictation after the StrictMode mount cleanup", async () => {
  const { result } = renderHook(() => useScenarioGeneratorWizard(props), {
    wrapper: StrictMode,
  });
  await act(async () => result.current.handleStartVoiceDictation());
  expect(mockFetchToken).toHaveBeenCalledTimes(1);
  expect(mockConnect).toHaveBeenCalledTimes(1);
});

it.each(["close", "workspace change", "unmount"])(
  "does not start the microphone after %s while the token is pending",
  async change => {
    const token = deferred<{ token: string }>();
    mockFetchToken.mockReturnValue(token.promise);
    const { result, rerender, unmount } = renderHook(
      (input: AiriCreateDialogProps) => useScenarioGeneratorWizard(input),
      { initialProps: props }
    );
    let start!: Promise<void>;
    act(() => {
      start = result.current.handleStartVoiceDictation();
    });
    if (change === "unmount") unmount();
    else {
      rerender({
        ...props,
        ...(change === "close"
          ? { open: false }
          : { workspaceId: "workspace-2" }),
      });
    }
    await act(async () => {
      token.resolve({ token: "late-token" });
      await start;
    });
    expect(mockConnect).not.toHaveBeenCalled();
  }
);

it("cancels a pending token without committing an absent connection", async () => {
  mockGetConnection.mockReturnValue(null);
  mockCommit.mockImplementation(() => {
    throw new Error("Not connected to Scribe");
  });
  const token = deferred<{ token: string }>();
  mockFetchToken.mockReturnValue(token.promise);
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  let start!: Promise<void>;
  act(() => {
    start = result.current.handleStartVoiceDictation();
  });
  act(() => {
    void result.current.handleStopVoiceDictation();
  });
  await act(async () => {
    token.resolve({ token: "late-token" });
    await start;
  });
  expect(mockCommit).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
  expect(result.current.isVoiceActive).toBe(false);
});

it("keeps typed corrections when an old dictation session emits late events", async () => {
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  const oldCallbacks = mockScribeOptions;
  act(() => oldCallbacks.onPartialTranscript({ text: "A partial draft" }));
  act(() => {
    void result.current.handleStopVoiceDictation();
  });
  act(() =>
    result.current.handlePromptChange({
      currentTarget: { value: "Corrected draft", selectionStart: 15 },
    } as ChangeEvent<HTMLTextAreaElement>)
  );
  await act(async () => result.current.handleStartVoiceDictation());
  act(() => {
    oldCallbacks.onCommittedTranscript({ text: "Stale transcript" });
    oldCallbacks.onError(new Error("Stale provider error"));
  });
  expect(result.current.prompt).toBe("Corrected draft");
  expect(toast.error).not.toHaveBeenCalled();
  act(() =>
    mockScribeOptions.onCommittedTranscript({ text: "Fresh transcript" })
  );
  expect(result.current.prompt).toBe("Corrected draft\nFresh transcript");
});

it("disconnects even if the final commit fails", async () => {
  mockCommit.mockImplementation(() => {
    throw new Error("Connection closed before commit");
  });
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  act(() => mockScribeOptions.onConnect());
  await act(async () => result.current.handleStopVoiceDictation());
  expect(mockDisconnect).toHaveBeenCalled();
  expect(result.current.isVoiceActive).toBe(false);
});

it("disconnects a failed provider session and allows dictation to retry", async () => {
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  act(() =>
    mockScribeOptions.onError(new Error("Provider rejected the session"))
  );
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(toast.error).toHaveBeenCalledTimes(1);
  await act(async () => result.current.handleStartVoiceDictation());
  expect(mockFetchToken).toHaveBeenCalledTimes(2);
});

it("keeps a manual prompt edit when the active recorder emits a late transcript", async () => {
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  const callbacks = mockScribeOptions;
  act(() => callbacks.onPartialTranscript({ text: "Dictated draft" }));
  act(() =>
    result.current.handlePromptChange({
      currentTarget: { value: "Typed correction", selectionStart: 16 },
    } as ChangeEvent<HTMLTextAreaElement>)
  );
  act(() => callbacks.onCommittedTranscript({ text: "Late dictated draft" }));
  expect(result.current.prompt).toBe("Typed correction");
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
});

it.each(["typing", "source insertion"])(
  "does not reconnect a pending dictation after %s edits the prompt",
  async edit => {
    const token = deferred<{ token: string }>();
    mockFetchToken.mockReturnValue(token.promise);
    const { result } = renderHook(() => useScenarioGeneratorWizard(props));
    let start!: Promise<void>;
    act(() => {
      start = result.current.handleStartVoiceDictation();
    });
    act(() => {
      if (edit === "typing")
        result.current.handlePromptChange({
          currentTarget: { value: "Typed correction", selectionStart: 16 },
        } as ChangeEvent<HTMLTextAreaElement>);
      else result.current.handleOpenSourceMentionPicker();
    });
    const editedPrompt = result.current.prompt;
    await act(async () => {
      token.resolve({ token: "late-token" });
      await start;
    });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(result.current.prompt).toBe(editedPrompt);
  }
);

it("keeps an explicitly selected source when a transcript arrives late", async () => {
  const { result } = renderHook(() =>
    useScenarioGeneratorWizard({
      ...props,
      connectedSourceMentions: ["whatsapp"],
    })
  );
  await act(async () => result.current.handleStartVoiceDictation());
  const callbacks = mockScribeOptions;
  act(() =>
    result.current.handleSelectSourceMention(
      SOURCE_MENTION_OPTIONS.find(option => option.id === "whatsapp")!
    )
  );
  const editedPrompt = result.current.prompt;
  act(() => callbacks.onCommittedTranscript({ text: "Late dictated draft" }));
  expect(result.current.prompt).toBe(editedPrompt);
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
});

it("keeps Stop available and closes connection B after a delayed SDK A CLOSE", async () => {
  const first = { commit: jest.fn(), close: jest.fn(), send: jest.fn() };
  const second = { commit: jest.fn(), close: jest.fn(), send: jest.fn() };
  let sdkConnection: typeof first | null = first;
  mockGetConnection.mockImplementation(() => sdkConnection);
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  const oldCallbacks = mockScribeOptions;
  act(() => {
    void result.current.handleStopVoiceDictation();
  });
  sdkConnection = second;
  await act(async () => result.current.handleStartVoiceDictation());
  act(() => {
    sdkConnection = null;
    oldCallbacks.onDisconnect();
  });
  expect(result.current.isVoiceActive).toBe(true);
  act(() => {
    void result.current.handleStopVoiceDictation();
  });
  expect(second.close).toHaveBeenCalledTimes(1);
});

it("closes its owned microphone when cancelling pending preparation", async () => {
  const preparation = deferred<{ audioFormat: string; sampleRate: number }>();
  mockPrepareMicrophone.mockReturnValue(preparation.promise);
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  let start!: Promise<void>;
  await act(async () => {
    start = result.current.handleStartVoiceDictation();
    await Promise.resolve();
  });
  expect(mockPrepareMicrophone).toHaveBeenCalledTimes(1);
  act(() => {
    void result.current.handleStopVoiceDictation();
  });
  expect(mockMicrophones[0].close).toHaveBeenCalledTimes(1);
  await act(async () => {
    preparation.resolve({ audioFormat: "pcm_16000", sampleRate: 16000 });
    await start;
  });
  expect(mockConnect).not.toHaveBeenCalled();
});

it("uses manual PCM and sends only through its owned connection after OPEN", async () => {
  const connection = { commit: jest.fn(), close: jest.fn(), send: jest.fn() };
  mockGetConnection.mockReturnValue(connection);
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  expect(mockConnect).toHaveBeenCalledWith(
    expect.objectContaining({ audioFormat: "pcm_16000", sampleRate: 16000 })
  );
  expect(mockConnect.mock.calls[0][0]).not.toHaveProperty("microphone");
  act(() => mockScribeOptions.onConnect());
  const send = mockMicrophones[0].sendAudioTo.mock.calls[0][0] as (
    audio: string
  ) => void;
  act(() => send("PCM-audio"));
  expect(connection.send).toHaveBeenCalledWith({ audioBase64: "PCM-audio" });
  act(() => {
    void result.current.handleStopVoiceDictation(true);
  });
  act(() => send("Late audio"));
  expect(connection.send).toHaveBeenCalledTimes(1);
});

it("flushes before commit and keeps the provider's final words after Stop", async () => {
  const flush = deferred<void>();
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  act(() => mockScribeOptions.onConnect());
  mockMicrophones[0].stopAndFlush.mockReturnValue(flush.promise);
  act(() => mockScribeOptions.onPartialTranscript({ text: "Last partial" }));
  let stopping!: Promise<void>;
  act(() => {
    stopping = result.current.handleStopVoiceDictation();
    void result.current.handleStopVoiceDictation();
  });
  expect(mockMicrophones[0].stopAndFlush).toHaveBeenCalledTimes(1);
  expect(mockCommit).not.toHaveBeenCalled();
  await act(async () => {
    flush.resolve();
    await Promise.resolve();
  });
  expect(mockCommit).toHaveBeenCalledTimes(1);
  expect(mockDisconnect).not.toHaveBeenCalled();
  await act(async () => {
    mockScribeOptions.onCommittedTranscript({ text: "Last complete words" });
    await stopping;
  });
  expect(result.current.prompt).toBe("Last complete words");
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(result.current.isVoiceActive).toBe(false);
});

it("bounds final transcript waiting while preserving the visible partial", async () => {
  jest.useFakeTimers();
  try {
    const { result } = renderHook(() => useScenarioGeneratorWizard(props));
    await act(async () => result.current.handleStartVoiceDictation());
    act(() => mockScribeOptions.onConnect());
    act(() =>
      mockScribeOptions.onPartialTranscript({ text: "Visible partial" })
    );
    let stopping!: Promise<void>;
    await act(async () => {
      stopping = result.current.handleStopVoiceDictation();
      await Promise.resolve();
    });
    expect(result.current.isVoiceActive).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1500);
      await stopping;
    });
    expect(result.current.prompt).toBe("Visible partial");
    expect(result.current.isVoiceActive).toBe(false);
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it("cancels final transcript waiting immediately when the prompt is edited", async () => {
  const { result } = renderHook(() => useScenarioGeneratorWizard(props));
  await act(async () => result.current.handleStartVoiceDictation());
  const callbacks = mockScribeOptions;
  act(() => callbacks.onConnect());
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = result.current.handleStopVoiceDictation();
    await Promise.resolve();
  });
  expect(mockCommit).toHaveBeenCalledTimes(1);
  await act(async () => {
    result.current.handlePromptChange({
      currentTarget: { value: "Typed correction", selectionStart: 16 },
    } as ChangeEvent<HTMLTextAreaElement>);
    callbacks.onCommittedTranscript({ text: "Late final words" });
    await stopping;
  });
  expect(result.current.prompt).toBe("Typed correction");
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(result.current.isVoiceActive).toBe(false);
});

it("drains both an in-flight VAD clause and the final flushed clause after Stop", async () => {
  jest.useFakeTimers();
  try {
    const { result } = renderHook(() => useScenarioGeneratorWizard(props));
    await act(async () => result.current.handleStartVoiceDictation());
    act(() => mockScribeOptions.onConnect());
    let stopping!: Promise<void>;
    await act(async () => {
      stopping = result.current.handleStopVoiceDictation();
      await Promise.resolve();
    });
    await act(async () => {
      mockScribeOptions.onCommittedTranscript({ text: "Earlier VAD clause" });
      await Promise.resolve();
    });
    expect(result.current.isVoiceActive).toBe(true);
    expect(mockDisconnect).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(700);
      mockScribeOptions.onCommittedTranscript({ text: "Final flushed clause" });
      jest.advanceTimersByTime(800);
      await stopping;
    });
    expect(result.current.prompt).toBe(
      "Earlier VAD clause\nFinal flushed clause"
    );
    expect(result.current.isVoiceActive).toBe(false);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
