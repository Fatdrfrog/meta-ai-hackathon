/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  AudioPlayerButton,
  AudioPlayerError,
  AudioPlayerProvider,
  useAudioPlayer,
} from "./audio-player";

const firstItem = { id: "first", src: "https://media.example/first.ogg" };
const secondItem = { id: "second", src: "https://media.example/second.ogg" };
let player: ReturnType<typeof useAudioPlayer>;

function Probe() {
  const api = useAudioPlayer();
  useEffect(() => {
    player = api;
  }, [api]);
  return (
    <>
      <AudioPlayerButton item={firstItem} />
      <AudioPlayerError />
      <output>{api.activeItem?.src}</output>
    </>
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("audio playback lifecycle", () => {
  let play: jest.SpyInstance;
  let pause: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    pause = jest
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("settles unsupported playback into the existing recoverable error UI", async () => {
    const onLoadError = jest.fn();
    play.mockRejectedValue(
      new DOMException("No supported source", "NotSupportedError")
    );
    render(
      <AudioPlayerProvider onLoadError={onLoadError}>
        <Probe />
      </AudioPlayerProvider>
    );

    let outcome!: PromiseSettledResult<void>[];
    await act(async () => {
      outcome = await Promise.allSettled([player.play(firstItem)]);
    });
    expect(outcome[0].status).toBe("fulfilled");
    act(() => jest.advanceTimersByTime(40));

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load audio");
    expect(
      screen.getByRole("link", { name: "Open in new tab" })
    ).toHaveAttribute("href", firstItem.src);
    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(onLoadError).toHaveBeenCalledWith({ reason: "error", errorCode: 4 });

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    );
    expect(onLoadError).toHaveBeenCalledTimes(2);

    play.mockResolvedValue(undefined);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pauses pending playback immediately instead of waiting for playable bytes", async () => {
    const pending = deferred();
    play.mockReturnValue(pending.promise);
    render(
      <AudioPlayerProvider>
        <Probe />
      </AudioPlayerProvider>
    );
    let playback!: Promise<void>;
    act(() => {
      playback = player.play(firstItem);
    });
    pause.mockClear();

    act(() => {
      player.pause();
    });
    const callsImmediatelyAfterPause = pause.mock.calls.length;
    let outcome!: PromiseSettledResult<void>[];
    await act(async () => {
      pending.reject(new DOMException("Interrupted by pause", "AbortError"));
      outcome = await Promise.allSettled([playback]);
    });
    expect(callsImmediatelyAfterPause).toBe(1);
    expect(outcome[0].status).toBe("fulfilled");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads a newly selected source without waiting for the previous request", async () => {
    const pending = deferred();
    play.mockReturnValueOnce(pending.promise);
    const { container } = render(
      <AudioPlayerProvider>
        <Probe />
      </AudioPlayerProvider>
    );
    let previous!: Promise<void>;
    act(() => {
      previous = player.play(firstItem);
    });
    let next!: Promise<void>;
    act(() => {
      next = player.play(secondItem);
    });

    const sourceAfterSelection = container
      .querySelector("audio")
      ?.getAttribute("src");
    let outcomes!: PromiseSettledResult<void>[];
    await act(async () => {
      pending.reject(
        new DOMException("Old source failed", "NotSupportedError")
      );
      outcomes = await Promise.allSettled([previous, next]);
    });
    expect(sourceAfterSelection).toBe(secondItem.src);
    expect(outcomes.every(result => result.status === "fulfilled")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes the source when the same message receives a new media URL", async () => {
    const { container } = render(
      <AudioPlayerProvider>
        <Probe />
      </AudioPlayerProvider>
    );
    await act(async () => {
      await player.play(firstItem);
    });
    act(() => jest.advanceTimersByTime(40));
    const refreshedItem = {
      ...firstItem,
      src: "https://media.example/refreshed.ogg",
    };

    await act(async () => {
      await player.play(refreshedItem);
    });
    expect(container.querySelector("audio")).toHaveAttribute(
      "src",
      refreshedItem.src
    );
  });

  it("polls the element only while it plays", () => {
    const frame = jest.spyOn(window, "requestAnimationFrame");
    const { container } = render(
      <AudioPlayerProvider>
        <Probe />
      </AudioPlayerProvider>
    );
    const audio = container.querySelector("audio")!;
    let paused = true;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      get: () => paused,
    });

    act(() => jest.advanceTimersByTime(1000));
    const idleFrames = frame.mock.calls.length;
    expect(idleFrames).toBeLessThanOrEqual(1);

    paused = false;
    act(() => {
      fireEvent.play(audio);
      jest.advanceTimersByTime(500);
    });
    expect(frame.mock.calls.length - idleFrames).toBeGreaterThan(10);

    paused = true;
    act(() => {
      fireEvent.pause(audio);
      jest.advanceTimersByTime(100);
    });
    const framesAfterPause = frame.mock.calls.length;
    act(() => jest.advanceTimersByTime(1000));
    expect(frame.mock.calls.length).toBe(framesAfterPause);
  });

  it("settles an interrupted play after the provider unmounts", async () => {
    const pending = deferred();
    play.mockReturnValue(pending.promise);
    const onLoadError = jest.fn();
    const { unmount } = render(
      <AudioPlayerProvider onLoadError={onLoadError}>
        <Probe />
      </AudioPlayerProvider>
    );
    let playback!: Promise<void>;
    act(() => {
      playback = player.play(firstItem);
    });
    unmount();

    pending.reject(new DOMException("Media was removed", "AbortError"));
    await expect(playback).resolves.toBeUndefined();
    expect(onLoadError).not.toHaveBeenCalled();
  });
});
