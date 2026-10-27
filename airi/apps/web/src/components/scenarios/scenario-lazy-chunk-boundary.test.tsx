/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import {
  createScenarioLazyChunk,
  lazyScenarioChunkComponent,
} from "./scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "./scenario-lazy-chunk-boundary";

type EditorModule = {
  Editor: (props: { label: string }) => ReactNode;
};

function Editor({ label }: { label: string }) {
  return <input aria-label={label} defaultValue="" />;
}

/** Stands in for the page's error screen. */
class PageErrorScreen extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  render() {
    return this.state.message ? (
      <p role="alert">{this.state.message}</p>
    ) : (
      this.props.children
    );
  }
}

function setup(importModule: () => Promise<EditorModule>) {
  const chunk = createScenarioLazyChunk(importModule);
  const LazyEditor = lazyScenarioChunkComponent(chunk, module => module.Editor);
  const view = render(
    <PageErrorScreen>
      <ScenarioLazyChunkBoundary chunk={chunk} fallback={<p>loading</p>}>
        <LazyEditor label="Message" />
      </ScenarioLazyChunkBoundary>
      <button type="button">Save</button>
    </PageErrorScreen>
  );
  return { chunk, view };
}

async function flushDownloads() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

describe("ScenarioLazyChunkBoundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    // React reports every error a boundary catches.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    jest.useRealTimers();
  });

  it("keeps the placeholder after a failed download, then retries and shows the editor", async () => {
    const importModule = jest
      .fn<Promise<EditorModule>, []>()
      .mockRejectedValueOnce(new Error("Loading chunk 42 failed"))
      .mockRejectedValueOnce(new Error("Loading chunk 42 failed"))
      .mockResolvedValue({ Editor });
    setup(importModule);
    await flushDownloads();

    // The page keeps working: no error screen, the placeholder stays.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("loading")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(importModule).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flushDownloads();
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(screen.getByText("loading")).toBeTruthy();

    // The second retry waits longer.
    await act(async () => {
      jest.advanceTimersByTime(1999);
    });
    expect(importModule).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await flushDownloads();

    expect(importModule).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.queryByText("loading")).toBeNull();
  });

  it("retries as soon as the browser is back online", async () => {
    const importModule = jest
      .fn<Promise<EditorModule>, []>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue({ Editor });
    setup(importModule);
    await flushDownloads();
    expect(screen.getByText("loading")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await flushDownloads();

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("stops retrying once it unmounts", async () => {
    const importModule = jest
      .fn<Promise<EditorModule>, []>()
      .mockRejectedValue(new Error("Failed to fetch"));
    const { view } = setup(importModule);
    await flushDownloads();

    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("online"));
    });
    await flushDownloads();

    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("still sends an error from a loaded editor to the page's error screen", async () => {
    function BrokenEditor(): ReactNode {
      throw new Error("Editor crashed");
    }
    const chunk = createScenarioLazyChunk(async () => ({
      Editor: BrokenEditor,
    }));
    await chunk.load();
    const LazyEditor = lazyScenarioChunkComponent(
      chunk,
      module => module.Editor
    );

    render(
      <PageErrorScreen>
        <ScenarioLazyChunkBoundary chunk={chunk} fallback={<p>loading</p>}>
          <LazyEditor />
        </ScenarioLazyChunkBoundary>
      </PageErrorScreen>
    );

    expect(screen.getByRole("alert").textContent).toBe("Editor crashed");
  });
});
