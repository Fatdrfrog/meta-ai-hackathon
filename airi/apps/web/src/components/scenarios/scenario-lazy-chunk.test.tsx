/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { Component, Suspense, type ReactNode } from "react";
import {
  createScenarioLazyChunk,
  lazyScenarioChunkComponent,
  ScenarioChunkLoadError,
  scheduleScenarioIdleTask,
  useOpenedOnce,
  useScenarioClientRendered,
} from "./scenario-lazy-chunk";

type EditorModule = {
  Editor: (props: { label: string }) => ReactNode;
};

function Editor({ label }: { label: string }) {
  return <input aria-label={label} defaultValue="" />;
}

function deferredModule() {
  let resolve!: (module: EditorModule) => void;
  const promise = new Promise<EditorModule>(done => {
    resolve = done;
  });
  return { promise, resolve: () => resolve({ Editor }) };
}

describe("createScenarioLazyChunk", () => {
  it("imports once and exposes the module after it loads", async () => {
    const importModule = jest.fn(async () => ({ Editor }));
    const chunk = createScenarioLazyChunk(importModule);
    expect(chunk.loaded()).toBeNull();

    const first = chunk.load();
    chunk.preload();
    expect(chunk.load()).toBe(first);
    await first;

    expect(chunk.loaded()).toEqual({ Editor });
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed download so the next request retries", async () => {
    const error = new Error("Chunk failed to load");
    const importModule = jest
      .fn<Promise<EditorModule>, []>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ Editor });
    const chunk = createScenarioLazyChunk(importModule);

    // A warm-up swallows the failure instead of leaving it unhandled.
    chunk.preload();
    await expect(chunk.load()).rejects.toBe(error);
    expect(chunk.loaded()).toBeNull();

    await expect(chunk.load()).resolves.toEqual({ Editor });
    expect(importModule).toHaveBeenCalledTimes(2);
  });
});

describe("lazyScenarioChunkComponent", () => {
  it("shows the fallback until a cold chunk arrives", async () => {
    const pending = deferredModule();
    const chunk = createScenarioLazyChunk(() => pending.promise);
    const LazyEditor = lazyScenarioChunkComponent(
      chunk,
      module => module.Editor
    );

    render(
      <Suspense fallback={<p>loading</p>}>
        <LazyEditor label="Message" />
      </Suspense>
    );
    expect(screen.getByText("loading")).toBeTruthy();

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("renders a preloaded chunk without suspending", async () => {
    const chunk = createScenarioLazyChunk(async () => ({ Editor }));
    const LazyEditor = lazyScenarioChunkComponent(
      chunk,
      module => module.Editor
    );
    await chunk.load();

    render(
      <Suspense fallback={<p>loading</p>}>
        <LazyEditor label="Message" />
      </Suspense>
    );

    expect(screen.queryByText("loading")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("keeps an editor that loaded cold mounted when its parent re-renders", async () => {
    const pending = deferredModule();
    const chunk = createScenarioLazyChunk(() => pending.promise);
    const LazyEditor = lazyScenarioChunkComponent(
      chunk,
      module => module.Editor
    );
    const view = render(
      <Suspense fallback={<p>loading</p>}>
        <LazyEditor label="Message" />
      </Suspense>
    );
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Message",
    });
    input.value = "Unsaved";

    view.rerender(
      <Suspense fallback={<p>loading</p>}>
        <LazyEditor label="Message" />
      </Suspense>
    );

    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    expect(input.value).toBe("Unsaved");
  });

  describe("after a failed download", () => {
    class Catch extends Component<
      { children: ReactNode; onError: (error: unknown) => void },
      { failed: boolean }
    > {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: unknown) {
        this.props.onError(error);
      }
      render() {
        return this.state.failed ? <p>failed</p> : this.props.children;
      }
    }
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
      // React reports the error the boundary caught.
      consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    function setup(importModule: () => Promise<EditorModule>) {
      const chunk = createScenarioLazyChunk(importModule);
      const LazyEditor = lazyScenarioChunkComponent(
        chunk,
        module => module.Editor
      );
      const caught: unknown[] = [];
      const tree = (key: string) => (
        <Catch key={key} onError={error => caught.push(error)}>
          <Suspense fallback={<p>loading</p>}>
            <LazyEditor label="Message" />
          </Suspense>
        </Catch>
      );
      return { chunk, caught, tree };
    }

    it("reports it as a chunk failure without downloading again in a loop", async () => {
      const importModule = jest
        .fn<Promise<EditorModule>, []>()
        .mockRejectedValue(new Error("Chunk failed to load"));
      const { caught, tree } = setup(importModule);

      render(tree("first"));
      expect(await screen.findByText("failed")).toBeTruthy();
      await act(async () => {
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });

      expect(caught).toHaveLength(1);
      expect(caught[0]).toBeInstanceOf(ScenarioChunkLoadError);
      // React renders a failed tree again before giving up; that must not
      // start another download.
      expect(importModule).toHaveBeenCalledTimes(1);
    });

    it("renders the editor on the next mount once a retry has loaded it", async () => {
      const importModule = jest
        .fn<Promise<EditorModule>, []>()
        .mockRejectedValueOnce(new Error("Chunk failed to load"))
        .mockResolvedValue({ Editor });
      const { chunk, tree } = setup(importModule);
      const view = render(tree("first"));
      expect(await screen.findByText("failed")).toBeTruthy();

      await chunk.load();
      view.rerender(tree("second"));

      expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
      expect(importModule).toHaveBeenCalledTimes(2);
    });
  });
});

describe("useOpenedOnce", () => {
  it("stays true after the first open", () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useOpenedOnce(open),
      { initialProps: { open: false } }
    );
    expect(result.current).toBe(false);

    rerender({ open: true });
    expect(result.current).toBe(true);

    rerender({ open: false });
    expect(result.current).toBe(true);
  });
});

describe("useScenarioClientRendered", () => {
  function Probe() {
    return <p>{useScenarioClientRendered() ? "client" : "server"}</p>;
  }

  it("is false on the server and true in the browser", () => {
    expect(renderToString(<Probe />)).toContain("server");
    render(<Probe />);
    expect(screen.getByText("client")).toBeTruthy();
  });
});

describe("scheduleScenarioIdleTask", () => {
  const originalRequestIdleCallback = window.requestIdleCallback;
  const originalCancelIdleCallback = window.cancelIdleCallback;

  afterEach(() => {
    window.requestIdleCallback = originalRequestIdleCallback;
    window.cancelIdleCallback = originalCancelIdleCallback;
    jest.useRealTimers();
  });

  it("waits for an idle period and can be cancelled", () => {
    const requestIdleCallback = jest.fn((_task: IdleRequestCallback) => 7);
    const cancelIdleCallback = jest.fn();
    window.requestIdleCallback = requestIdleCallback;
    window.cancelIdleCallback = cancelIdleCallback;
    const task = jest.fn();

    const cancel = scheduleScenarioIdleTask(task);
    expect(task).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 3000 });

    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to a timer without requestIdleCallback", () => {
    jest.useFakeTimers();
    // @ts-expect-error: older browsers lack requestIdleCallback.
    window.requestIdleCallback = undefined;
    const task = jest.fn();

    const cancel = scheduleScenarioIdleTask(task);
    jest.advanceTimersByTime(999);
    expect(task).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);

    const cancelled = jest.fn();
    scheduleScenarioIdleTask(cancelled)();
    jest.advanceTimersByTime(1000);
    expect(cancelled).not.toHaveBeenCalled();
    cancel();
  });
});
