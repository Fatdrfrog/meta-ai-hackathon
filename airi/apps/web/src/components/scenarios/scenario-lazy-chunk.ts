import {
  createElement,
  lazy,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";

/**
 * A module the Scenarios page downloads only when it is needed. `preload`
 * starts the download early; once it resolves, `loaded` returns the module
 * so a component can render without suspending. A failed download is
 * forgotten, so the next request (a render included) tries again.
 */
export type ScenarioLazyChunk<TModule> = {
  load: () => Promise<TModule>;
  loaded: () => TModule | null;
  preload: () => void;
};

export function createScenarioLazyChunk<TModule>(
  importModule: () => Promise<TModule>
): ScenarioLazyChunk<TModule> {
  let pending: Promise<TModule> | null = null;
  let loadedModule: TModule | null = null;

  const load = () => {
    if (pending) return pending;
    const request = importModule().then(module => {
      loadedModule = module;
      return module;
    });
    pending = request;
    void request.catch(() => {
      if (pending === request) pending = null;
    });
    return request;
  };

  return {
    load,
    loaded: () => loadedModule,
    preload: () => {
      // Warming is best effort: a render retries and surfaces the failure.
      void load().catch(() => undefined);
    },
  };
}

/**
 * A chunk that did not download. ScenarioLazyChunkBoundary keeps the
 * placeholder and downloads it again instead of failing the page.
 */
export class ScenarioChunkLoadError extends Error {
  constructor(cause: unknown) {
    super("A Scenarios editor failed to download", { cause });
    this.name = "ScenarioChunkLoadError";
  }
}

/**
 * A component from a lazy chunk, for use inside ScenarioLazyChunkBoundary.
 * It renders at once when the chunk has already loaded and suspends
 * otherwise. Each instance keeps its first choice, so a later render cannot
 * remount it (and lose its state) when a cold chunk arrives.
 *
 * React.lazy remembers a failed download. That is kept on purpose: React
 * renders a failed tree again before giving up, and a fresh lazy there would
 * download again in a tight loop. The boundary downloads again with a pause
 * instead, and once the chunk has loaded every mount renders it directly.
 */
export function lazyScenarioChunkComponent<TModule, TProps extends object>(
  chunk: ScenarioLazyChunk<TModule>,
  pick: (module: TModule) => ComponentType<TProps>
): ComponentType<TProps> {
  const LazyComponent = lazy(async () => {
    try {
      return { default: pick(await chunk.load()) };
    } catch (error) {
      throw new ScenarioChunkLoadError(error);
    }
  });

  function ScenarioLazyChunkComponent(props: TProps) {
    const [Component] = useState<ComponentType<TProps>>(() => {
      const loadedModule = chunk.loaded();
      return loadedModule ? pick(loadedModule) : LazyComponent;
    });
    return createElement(Component, props);
  }

  return ScenarioLazyChunkComponent;
}

/**
 * Whether a lazily mounted dialog or menu has opened yet. It stays true
 * after the first open, so the component keeps running its close animation
 * and focus return instead of unmounting.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

function subscribeToClientRender() {
  return () => undefined;
}

/**
 * False on the server and while the page hydrates, true after. A lazily
 * mounted dialog waits for it, as next/dynamic with `ssr: false` did.
 */
export function useScenarioClientRendered(): boolean {
  return useSyncExternalStore(
    subscribeToClientRender,
    () => true,
    () => false
  );
}

/** Runs a warm-up when the browser is idle; returns a cancel function. */
export function scheduleScenarioIdleTask(task: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 1000);
  return () => window.clearTimeout(handle);
}
