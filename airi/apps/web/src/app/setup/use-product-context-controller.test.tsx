/** @jest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import fs from "fs";
import path from "path";

const mockCaptureOnboardingAnalytics = jest.fn();

jest.mock("./onboarding-analytics", () => ({
  captureOnboardingAnalytics: (...args: unknown[]) =>
    mockCaptureOnboardingAnalytics(...args),
}));

import {
  FOREGROUND_OBSERVATION_MS,
  POLL_BACKOFF_MS,
  START_TRAINING_TIMEOUT_MS,
  useProductContextController,
} from "./use-product-context-controller";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

type FetchHandler = (
  init: RequestInit | undefined,
  url: string
) => Response | Promise<Response>;

type FetchHandlers = {
  progressGet?: FetchHandler;
  integrationsGet?: FetchHandler;
  whatsappStatusGet?: FetchHandler;
  crawlPost?: FetchHandler;
  whatsappPost?: FetchHandler;
};

const WORKSPACE_ID = "workspace-1";
const WHATSAPP_URL = "/api/whatsapp/smb-app-data";

const emptyProgress = {
  sources: [],
  total: 0,
  indexed: 0,
  pending: 0,
  failed: 0,
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function source(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "source-1",
    url: "https://example.com",
    title: null,
    index_status: "pending",
    failure_code: null,
    error_message: null,
    ...overrides,
  };
}

function pendingProgress(url = "https://example.com") {
  return {
    sources: [source({ url })],
    total: 1,
    indexed: 0,
    pending: 1,
    failed: 0,
  };
}

function indexedProgress(url = "https://example.com") {
  return {
    sources: [source({ url, index_status: "indexed" })],
    total: 1,
    indexed: 1,
    pending: 0,
    failed: 0,
  };
}

function failedProgress(url = "https://example.com") {
  return {
    sources: [
      source({
        url,
        index_status: "failed",
        failure_code: "generic",
        error_message: "Indexing failed.",
      }),
    ],
    total: 1,
    indexed: 0,
    pending: 0,
    failed: 1,
  };
}

function indexedAndPendingProgress() {
  return {
    sources: [
      source({ id: "indexed-source", index_status: "indexed" }),
      source({ id: "pending-source", url: "https://pending.example.com" }),
    ],
    total: 2,
    indexed: 1,
    pending: 1,
    failed: 0,
  };
}

function indexedAndFailedProgress() {
  return {
    sources: [
      source({ id: "indexed-source", index_status: "indexed" }),
      source({
        id: "pending-source",
        url: "https://pending.example.com",
        index_status: "failed",
        failure_code: "generic",
        error_message: "Indexing failed.",
      }),
    ],
    total: 2,
    indexed: 1,
    pending: 0,
    failed: 1,
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("useProductContextController", () => {
  it("keeps async ownership checks and source normalization single-pass", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "use-product-context-controller.ts"),
      "utf8"
    );

    expect(source).not.toMatch(
      /\.filter\(isRecord\)[\s\S]{0,120}\.map\(source => source\.type\)/
    );
    expect(source).not.toMatch(
      /rawInput\.websites[\s\S]{0,160}\.map\([\s\S]{0,160}\.filter\(Boolean\)/
    );
    expect(source).not.toMatch(/await settleBoundedReads/);
    expect(source).not.toMatch(/await Promise\.allSettled/);
  });

  const originalFetch = global.fetch;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  function installFetchHandlers(handlers: FetchHandlers = {}) {
    const defaults: Required<FetchHandlers> = {
      progressGet: () => jsonResponse(emptyProgress),
      integrationsGet: () => jsonResponse({ sources: [] }),
      whatsappStatusGet: () =>
        jsonResponse({ error: "whatsapp_not_connected" }, 404),
      crawlPost: () => jsonResponse({ success: true, started: true }, 202),
      whatsappPost: () =>
        jsonResponse({ status: "ok", data: { requested_at: "now" } }),
    };
    const routes = { ...defaults, ...handlers };

    mockFetch.mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (
        method === "GET" &&
        /^\/api\/workspaces\/[^/]+\/onboarding\/crawl$/.test(url)
      ) {
        return routes.progressGet(init, url);
      }
      if (
        method === "GET" &&
        /^\/api\/workspaces\/[^/]+\/integrations$/.test(url)
      ) {
        return routes.integrationsGet(init, url);
      }
      if (method === "GET" && url.startsWith(`${WHATSAPP_URL}?workspaceId=`)) {
        return routes.whatsappStatusGet(init, url);
      }
      if (
        method === "POST" &&
        /^\/api\/workspaces\/[^/]+\/onboarding\/crawl$/.test(url)
      ) {
        return routes.crawlPost(init, url);
      }
      if (method === "POST" && url === WHATSAPP_URL) {
        return routes.whatsappPost(init, url);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
  }

  function renderController(
    onHandoffStateChange = jest.fn(),
    initialWorkspaceId = WORKSPACE_ID
  ) {
    const renderCaptures: Array<{
      workspaceId: string;
      state: ReturnType<typeof useProductContextController>["state"];
    }> = [];
    const hook = renderHook(
      ({ workspaceId }: { workspaceId: string }) => {
        const controller = useProductContextController({
          workspaceId,
          onHandoffStateChange,
        });
        renderCaptures.push({ workspaceId, state: controller.state });
        return controller;
      },
      { initialProps: { workspaceId: initialWorkspaceId } }
    );
    return {
      onHandoffStateChange,
      renderCaptures,
      ...hook,
      rerenderWorkspace: (workspaceId: string) =>
        hook.rerender({ workspaceId }),
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = mockFetch;
    mockCaptureOnboardingAnalytics.mockClear();
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("makes an initial crawl failure recoverable instead of treating it as empty", async () => {
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "raw database diagnostics" }, 500)
      )
      .mockResolvedValueOnce(jsonResponse(indexedProgress()));
    installFetchHandlers({ progressGet });
    const { result } = renderController();

    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "training_progress_unavailable",
      sources: [],
    });
    expect(JSON.stringify(result.current.state)).not.toContain(
      "raw database diagnostics"
    );

    await act(async () => {
      await result.current.checkAgain();
    });

    expect(result.current.state).toMatchObject({
      phase: "ready",
      errorCode: null,
      counts: { total: 1, indexed: 1, pending: 0, failed: 0 },
    });
  });

  it("waits for verified local messages before announcing WhatsApp context ready", async () => {
    let synchronized = false;
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: false,
            history_sync: {
              session_id: "new-session",
              request_state: "accepted",
              requested_at: new Date().toISOString(),
              status: synchronized ? "completed" : "in_progress",
              last_progress: 100,
              counts_verified: true,
              received_count_total: 3,
              synchronized_count_total: synchronized ? 3 : 0,
              pending_count_total: synchronized ? 0 : 3,
            },
          },
        }),
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();
    expect(result.current.state.phase).toBe("polling");
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false })
    );
    synchronized = true;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(result.current.state.phase).toBe("ready");
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true })
    );
    expect(
      mockFetch.mock.calls.filter(
        ([url, init]) => url === WHATSAPP_URL && init?.method === "POST"
      )
    ).toHaveLength(0);
  });

  it.each(["error", "declined", "completed"] as const)(
    "settles a history-only %s result without leaving a spinner or issuing another request",
    async terminalStatus => {
      let terminal = false;
      const whatsappPost = jest.fn(() =>
        jsonResponse({
          data: {
            history_sync: {
              session_id: "session",
              requested_at: new Date().toISOString(),
              request_state: "accepted",
              status: "requested",
            },
          },
        })
      );
      installFetchHandlers({
        integrationsGet: () =>
          jsonResponse({ sources: [{ type: "whatsapp" }] }),
        whatsappStatusGet: () =>
          jsonResponse({
            data: {
              history_sync_eligible: true,
              history_sync_can_request: !terminal,
              history_sync: terminal
                ? {
                    session_id: "session",
                    requested_at: new Date().toISOString(),
                    request_state: "accepted",
                    status: terminalStatus,
                    counts_verified: true,
                    synchronized_count_total: 0,
                  }
                : {
                    session_id: "session",
                    session_started_at: new Date().toISOString(),
                  },
            },
          }),
        whatsappPost,
      });
      const { result, onHandoffStateChange } = renderController();
      await flushAsyncWork();
      await act(async () => {
        await result.current.startTraining({
          websites: [],
          includeInstagram: false,
          includeWhatsapp: true,
        });
      });
      terminal = true;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
      });
      expect(result.current.state.phase).toBe("idle");
      expect(onHandoffStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ ready: false })
      );
      expect(jest.getTimerCount()).toBe(0);
      await act(async () => {
        await result.current.startTraining({
          websites: [],
          includeInstagram: false,
          includeWhatsapp: true,
        });
      });
      expect(result.current.state.phase).toBe("error");
      expect(whatsappPost).toHaveBeenCalledTimes(1);
    }
  );

  it("allows a fresh attempt after a verified provider rejection", async () => {
    const session = {
      session_id: "session",
      session_started_at: new Date().toISOString(),
    };
    const whatsappPost = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error_code: "request_rejected",
            data: {
              history_sync: {
                ...session,
                request_state: "rejected",
                status: "error",
              },
            },
          },
          502
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            history_sync: {
              ...session,
              requested_at: new Date().toISOString(),
              request_state: "accepted",
              status: "requested",
            },
          },
        })
      );
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: session,
          },
        }),
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();
    const start = () =>
      result.current.startTraining({
        websites: [],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    await act(async () => {
      await start();
    });
    expect(result.current.state).toMatchObject({
      phase: "error",
      whatsappHistoryCanRequest: true,
      whatsappHistoryRequested: false,
    });
    await act(async () => {
      await start();
    });
    expect(whatsappPost).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe("polling");
  });

  it("guards a failed history response without a request state as uncertain", async () => {
    const whatsappPost = jest.fn(() =>
      jsonResponse({ error: "server unavailable" }, 503)
    );
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();
    const start = () =>
      result.current.startTraining({
        websites: [],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    await act(async () => {
      await start();
    });
    expect(result.current.state).toMatchObject({
      phase: "polling",
      whatsappHistoryRequested: true,
      whatsappHistoryCanRequest: false,
      whatsappHistorySync: { request_state: "unknown" },
    });
    await act(async () => {
      await start();
    });
    expect(whatsappPost).toHaveBeenCalledTimes(1);
  });

  it("keeps observing an accepted crawl with no rows despite terminal WhatsApp history", async () => {
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptyProgress))
      .mockResolvedValueOnce(jsonResponse(emptyProgress))
      .mockResolvedValueOnce(jsonResponse(indexedProgress()));
    const whatsappPost = jest.fn();
    installFetchHandlers({
      progressGet,
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: false,
            history_sync: {
              session_id: "session",
              requested_at: new Date().toISOString(),
              request_state: "accepted",
              status: "error",
              counts_verified: true,
              synchronized_count_total: 0,
            },
          },
        }),
      whatsappPost,
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();
    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(result.current.state).toMatchObject({
      phase: "polling",
      awaitingCrawlProgress: true,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false })
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[1]);
    });
    expect(result.current.state.phase).toBe("ready");
    expect(whatsappPost).not.toHaveBeenCalled();
  });

  it("keeps successful optional connection reads when progress is unavailable", async () => {
    installFetchHandlers({
      progressGet: () => jsonResponse({ code: "internal_failure" }, 500),
      integrationsGet: () =>
        jsonResponse({
          sources: [{ type: "instagram" }, { type: "whatsapp" }],
        }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync: { requested_at: "2026-07-10T00:00:00.000Z" },
          },
        }),
    });
    const { result } = renderController();

    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "error",
      sources: [],
      connected: { instagram: true, whatsapp: true },
      whatsappHistoryEligible: true,
      whatsappHistoryRequested: true,
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "onboarding_training_ready",
        metadata: expect.objectContaining({ ready_context_source: "whatsapp" }),
      })
    );
  });

  it("bounds hung optional initial reads while preserving settled results", async () => {
    const stuckStatus = deferred<Response>();
    const statusSignals: AbortSignal[] = [];
    installFetchHandlers({
      progressGet: () => jsonResponse({ code: "internal_failure" }, 500),
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: init => {
        statusSignals.push(init?.signal as AbortSignal);
        return stuckStatus.promise;
      },
    });
    const { result, unmount } = renderController();
    await flushAsyncWork();

    expect(result.current.state.phase).toBe("loading");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(statusSignals[0]?.aborted).toBe(true);
    expect(result.current.state).toMatchObject({
      phase: "error",
      sources: [],
      connected: { instagram: false, whatsapp: true },
      whatsappStatusKnown: false,
      whatsappHistoryRequested: false,
    });

    unmount();
    stuckStatus.resolve(jsonResponse({ data: {} }));
    await stuckStatus.promise;
  });

  it("keeps successful progress when optional integration reads fail", async () => {
    const progressGet = jest.fn(() => jsonResponse(pendingProgress()));
    installFetchHandlers({
      progressGet,
      integrationsGet: () => Promise.reject(new Error("integrations down")),
      whatsappStatusGet: () => Promise.reject(new Error("status down")),
    });
    const { result } = renderController();

    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "polling",
      sources: [expect.objectContaining({ url: "https://example.com" })],
      connected: { instagram: false, whatsapp: false },
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(progressGet).toHaveBeenCalledTimes(2);
  });

  it("keeps observing after one source is usable and settles with every terminal row", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(indexedAndPendingProgress()))
      .mockResolvedValueOnce(jsonResponse(indexedAndFailedProgress()));
    const onHandoffStateChange = jest.fn();
    installFetchHandlers({ progressGet });
    const { result } = renderController(onHandoffStateChange);

    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "polling",
      counts: { total: 2, indexed: 1, pending: 1, failed: 0 },
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: true,
      background: false,
    });
    expect(
      setTimeoutSpy.mock.calls.filter(
        ([, delay]) => delay === POLL_BACKOFF_MS[0]
      )
    ).toHaveLength(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });

    expect(progressGet).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({
      phase: "ready",
      counts: { total: 2, indexed: 1, pending: 0, failed: 1 },
      sources: [
        expect.objectContaining({
          id: "indexed-source",
          index_status: "indexed",
        }),
        expect.objectContaining({
          id: "pending-source",
          index_status: "failed",
        }),
      ],
    });
    expect(jest.getTimerCount()).toBe(0);
    const readyCalls = mockCaptureOnboardingAnalytics.mock.calls.filter(
      ([params]) =>
        (params as { event?: string }).event === "onboarding_training_ready"
    );
    expect(readyCalls).toHaveLength(1);
  });

  it("preserves successful rows when a later refresh fails", async () => {
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingProgress()))
      .mockResolvedValueOnce(
        jsonResponse({ error: "provider details must stay private" }, 500)
      );
    installFetchHandlers({ progressGet });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "training_progress_unavailable",
      sources: [expect.objectContaining({ url: "https://example.com" })],
      counts: { total: 1, indexed: 0, pending: 1, failed: 0 },
    });
    expect(JSON.stringify(result.current.state)).not.toContain(
      "provider details must stay private"
    );
  });

  it("invalidates an already-fired poll when training restarts", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
    const stalePoll = deferred<Response>();
    const progressSignals: AbortSignal[] = [];
    const mutationSignals: AbortSignal[] = [];
    const progressGet = jest
      .fn()
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(jsonResponse(pendingProgress()));
      })
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return stalePoll.promise;
      })
      .mockImplementation((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(jsonResponse(pendingProgress()));
      });
    installFetchHandlers({
      progressGet,
      crawlPost: init => {
        mutationSignals.push(init?.signal as AbortSignal);
        return jsonResponse({ success: true }, 202);
      },
    });
    const { result } = renderController();
    await flushAsyncWork();

    act(() => {
      jest.advanceTimersByTime(POLL_BACKOFF_MS[0]);
    });
    await flushAsyncWork();
    expect(progressGet).toHaveBeenCalledTimes(2);
    const controllerTimerBaseline = setTimeoutSpy.mock.calls.length;
    const staleDeadlineTimer = setTimeoutSpy.mock.results.at(-1)?.value;
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(
      FOREGROUND_OBSERVATION_MS - POLL_BACKOFF_MS[0]
    );

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://new.example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });

    expect(progressSignals[1]?.aborted).toBe(true);
    expect(mutationSignals[0]).not.toBe(progressSignals[1]);
    expect(mutationSignals[0]?.aborted).toBe(false);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(controllerTimerBaseline + 2);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(staleDeadlineTimer);
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(POLL_BACKOFF_MS[0]);
    const restartTimer = setTimeoutSpy.mock.results.at(-1)?.value;
    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(restartTimer);

    stalePoll.resolve(
      jsonResponse(indexedProgress("https://stale.example.com"))
    );
    await stalePoll.promise;
    await Promise.resolve();

    expect(result.current.state.phase).toBe("polling");
    expect(result.current.state.sources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://stale.example.com" }),
      ])
    );
    expect(setTimeoutSpy).toHaveBeenCalledTimes(controllerTimerBaseline + 2);
    expect(clearTimeoutSpy).not.toHaveBeenCalledWith(restartTimer);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(progressGet).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight observation on unmount without scheduling later work", async () => {
    const pendingPoll = deferred<Response>();
    const progressSignals: AbortSignal[] = [];
    const progressGet = jest
      .fn()
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(jsonResponse(pendingProgress()));
      })
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return pendingPoll.promise;
      });
    installFetchHandlers({ progressGet });
    const { onHandoffStateChange, unmount } = renderController();
    await flushAsyncWork();

    act(() => {
      jest.advanceTimersByTime(POLL_BACKOFF_MS[0]);
    });
    await flushAsyncWork();
    expect(progressGet).toHaveBeenCalledTimes(2);
    const handoffCallsBeforeUnmount = onHandoffStateChange.mock.calls.length;
    const timersBeforeUnmount = jest.getTimerCount();
    expect(timersBeforeUnmount).toBeGreaterThan(0);

    unmount();
    expect(progressSignals[1]?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(timersBeforeUnmount - 1);
    const timersAfterUnmount = jest.getTimerCount();

    pendingPoll.resolve(jsonResponse(indexedProgress()));
    await pendingPoll.promise;
    await Promise.resolve();

    expect(jest.getTimerCount()).toBe(timersAfterUnmount);
    expect(onHandoffStateChange).toHaveBeenCalledTimes(
      handoffCallsBeforeUnmount
    );
  });

  it("isolates state and stale observation work when workspace changes", async () => {
    const oldObservation = deferred<Response>();
    const newWorkspaceProgress = deferred<Response>();
    const oldObservationSignals: AbortSignal[] = [];
    let workspaceOneProgressReads = 0;
    installFetchHandlers({
      progressGet: (init, url) => {
        if (url.includes("workspace-2")) return newWorkspaceProgress.promise;
        workspaceOneProgressReads += 1;
        if (workspaceOneProgressReads === 1) {
          return jsonResponse(pendingProgress("https://old.example.com"));
        }
        oldObservationSignals.push(init?.signal as AbortSignal);
        return oldObservation.promise;
      },
      integrationsGet: (_init, url) =>
        url.includes("workspace-2")
          ? Promise.reject(new Error("new integrations unavailable"))
          : jsonResponse({
              sources: [{ type: "instagram" }, { type: "whatsapp" }],
            }),
      whatsappStatusGet: (_init, url) =>
        url.includes("workspace-2")
          ? Promise.reject(new Error("new status unavailable"))
          : jsonResponse({
              data: {
                history_sync_eligible: false,
                history_sync: null,
              },
            }),
    });
    const { result, onHandoffStateChange, rerenderWorkspace } =
      renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://old.example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });
    expect(result.current.state.acceptedRun).toBe(true);

    act(() => {
      jest.advanceTimersByTime(POLL_BACKOFF_MS[0]);
    });
    await flushAsyncWork();
    expect(oldObservationSignals).toHaveLength(1);
    const timersDuringOldPoll = jest.getTimerCount();
    expect(timersDuringOldPoll).toBeGreaterThan(0);

    act(() => {
      rerenderWorkspace("workspace-2");
    });
    await flushAsyncWork();

    expect(oldObservationSignals[0]?.aborted).toBe(true);
    expect(result.current.state).toMatchObject({
      phase: "loading",
      sources: [],
      counts: { total: 0, indexed: 0, pending: 0, failed: 0 },
      connected: { instagram: false, whatsapp: false },
      whatsappStatusKnown: false,
      acceptedRun: false,
      errorCode: null,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: false,
      ready: false,
      background: false,
    });
    const timersDuringNewLoad = jest.getTimerCount();
    expect(timersDuringNewLoad).toBeGreaterThan(0);

    oldObservation.resolve(
      jsonResponse(indexedProgress("https://stale.example.com"))
    );
    await oldObservation.promise;
    await Promise.resolve();
    expect(result.current.state.phase).toBe("loading");
    expect(jest.getTimerCount()).toBeLessThanOrEqual(timersDuringNewLoad);

    await act(async () => {
      newWorkspaceProgress.resolve(
        jsonResponse({ error: "new workspace failure" }, 500)
      );
      await newWorkspaceProgress.promise;
    });
    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "error",
      sources: [],
      connected: { instagram: false, whatsapp: false },
      whatsappStatusKnown: false,
      acceptedRun: false,
      errorCode: "training_progress_unavailable",
    });
  });

  it("masks prior tenant state on the first render of a new workspace", async () => {
    const newWorkspaceProgress = deferred<Response>();
    installFetchHandlers({
      progressGet: (_init, url) =>
        url.includes("workspace-2")
          ? newWorkspaceProgress.promise
          : jsonResponse(indexedProgress("https://old.example.com")),
      integrationsGet: (_init, url) =>
        url.includes("workspace-2")
          ? Promise.reject(new Error("new integrations unavailable"))
          : jsonResponse({
              sources: [{ type: "instagram" }, { type: "whatsapp" }],
            }),
      whatsappStatusGet: (_init, url) =>
        url.includes("workspace-2")
          ? Promise.reject(new Error("new status unavailable"))
          : jsonResponse({
              data: {
                history_sync_eligible: true,
                history_sync: { requested_at: "2026-07-10T00:00:00.000Z" },
              },
            }),
    });
    const { result, onHandoffStateChange, renderCaptures, rerenderWorkspace } =
      renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://old.example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      connected: { instagram: true, whatsapp: true },
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: true,
      background: false,
    });

    const captureCountBeforeSwitch = renderCaptures.length;
    act(() => {
      rerenderWorkspace("workspace-2");
    });

    const firstNewWorkspaceRender = renderCaptures
      .slice(captureCountBeforeSwitch)
      .find(capture => capture.workspaceId === "workspace-2");
    expect(firstNewWorkspaceRender?.state).toMatchObject({
      phase: "loading",
      acceptedRun: false,
      sources: [],
      counts: { total: 0, indexed: 0, pending: 0, failed: 0 },
      connected: { instagram: false, whatsapp: false },
      whatsappStatusKnown: false,
      whatsappHistoryEligible: false,
      whatsappHistoryRequested: false,
      errorCode: null,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: false,
      ready: false,
      background: false,
    });

    await act(async () => {
      newWorkspaceProgress.resolve(jsonResponse(emptyProgress));
      await newWorkspaceProgress.promise;
      await Promise.resolve();
    });
  });

  it("ends bounded foreground observation in background state", async () => {
    const progressGet = jest.fn(async () => jsonResponse(pendingProgress()));
    installFetchHandlers({ progressGet });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });

    expect(result.current.state.phase).toBe("background");
    expect(progressGet).toHaveBeenCalledTimes(POLL_BACKOFF_MS.length);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("reports semantic readiness while terminal observation continues in background", async () => {
    const progressGet = jest.fn(async () =>
      jsonResponse(indexedAndPendingProgress())
    );
    const onHandoffStateChange = jest.fn();
    installFetchHandlers({ progressGet });
    const { result } = renderController(onHandoffStateChange);
    await flushAsyncWork();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });

    expect(result.current.state).toMatchObject({
      phase: "background",
      counts: { indexed: 1, pending: 1 },
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: true,
      background: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("expires and aborts a stuck poll at the foreground budget", async () => {
    const stuckPoll = deferred<Response>();
    const progressSignals: AbortSignal[] = [];
    const progressGet = jest
      .fn()
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(jsonResponse(pendingProgress()));
      })
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return stuckPoll.promise;
      });
    installFetchHandlers({ progressGet });
    const { result } = renderController();
    await flushAsyncWork();
    const timersBeforeExpiry = jest.getTimerCount();
    expect(timersBeforeExpiry).toBeGreaterThan(0);

    act(() => {
      jest.advanceTimersByTime(FOREGROUND_OBSERVATION_MS);
    });
    await flushAsyncWork();

    expect(progressGet).toHaveBeenCalledTimes(2);
    expect(progressSignals[1]?.aborted).toBe(true);
    expect(result.current.state.phase).toBe("background");
    expect(jest.getTimerCount()).toBe(timersBeforeExpiry - 1);
    const timersAfterExpiry = jest.getTimerCount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS.at(-1) ?? 0);
    });
    expect(progressGet).toHaveBeenCalledTimes(2);

    stuckPoll.resolve(jsonResponse(indexedProgress()));
    await stuckPoll.promise;
    await Promise.resolve();

    expect(result.current.state.phase).toBe("background");
    expect(progressGet).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBeLessThanOrEqual(timersAfterExpiry);
  });

  it("caps the next backoff at the remaining foreground budget", async () => {
    const slowPoll = deferred<Response>();
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingProgress()))
      .mockImplementationOnce(() => slowPoll.promise);
    installFetchHandlers({ progressGet });
    const { result } = renderController();
    await flushAsyncWork();

    act(() => {
      jest.advanceTimersByTime(POLL_BACKOFF_MS[0]);
      jest.advanceTimersByTime(
        FOREGROUND_OBSERVATION_MS - POLL_BACKOFF_MS[0] - 2_000
      );
    });
    await act(async () => {
      slowPoll.resolve(jsonResponse(pendingProgress()));
      await slowPoll.promise;
      await Promise.resolve();
    });
    const timersBeforeCappedExpiry = jest.getTimerCount();
    expect(timersBeforeCappedExpiry).toBeGreaterThan(0);

    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    await flushAsyncWork();

    expect(progressGet).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe("background");
    expect(jest.getTimerCount()).toBe(timersBeforeCappedExpiry - 1);
  });

  it("checks immediately and resumes bounded observation while work is pending", async () => {
    const progressGet = jest.fn(async () => jsonResponse(pendingProgress()));
    installFetchHandlers({ progressGet });
    const { result } = renderController();
    await flushAsyncWork();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });
    const callsAtExpiry = progressGet.mock.calls.length;

    await act(async () => {
      await result.current.checkAgain();
    });

    expect(progressGet).toHaveBeenCalledTimes(callsAtExpiry + 1);
    expect(result.current.state.phase).toBe("polling");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(progressGet).toHaveBeenCalledTimes(callsAtExpiry + 2);
  });

  it("bounds a hung check again and still expires accepted pending work", async () => {
    const stuckRefresh = deferred<Response>();
    const progressSignals: AbortSignal[] = [];
    const progressGet = jest
      .fn()
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(jsonResponse(pendingProgress()));
      })
      .mockImplementationOnce((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return stuckRefresh.promise;
      })
      .mockImplementation((init?: RequestInit) => {
        progressSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(jsonResponse(pendingProgress()));
      });
    installFetchHandlers({ progressGet });
    const { result, unmount } = renderController();
    await flushAsyncWork();

    act(() => {
      void result.current.checkAgain();
    });
    await flushAsyncWork();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(progressSignals[1]?.aborted).toBe(true);
    expect(result.current.state.phase).toBe("polling");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });

    expect(result.current.state.phase).toBe("background");
    unmount();
    stuckRefresh.resolve(jsonResponse(indexedProgress()));
    await stuckRefresh.promise;
  });

  it("does not let check again clear an unresolved start mutation", async () => {
    const crawlPost = deferred<Response>();
    const progressGet = jest.fn(() => jsonResponse(emptyProgress));
    installFetchHandlers({
      progressGet,
      crawlPost: () => crawlPost.promise,
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });
    await flushAsyncWork();

    await act(async () => {
      await result.current.checkAgain();
    });

    expect(progressGet).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("starting");
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mutationPending: true })
    );

    await act(async () => {
      crawlPost.resolve(jsonResponse({ success: true }, 202));
      await startPromise;
    });
  });

  it("reports mutation pending until every selected start POST settles", async () => {
    const historyPost = deferred<Response>();
    const crawlPost = deferred<Response>();
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      whatsappPost: () => historyPost.promise,
      crawlPost: () => crawlPost.promise,
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });
    await flushAsyncWork();
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mutationPending: true })
    );

    await act(async () => {
      historyPost.resolve(
        jsonResponse({ status: "ok", data: { requested_at: "now" } })
      );
      await historyPost.promise;
      await Promise.resolve();
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mutationPending: true })
    );

    await act(async () => {
      crawlPost.resolve(jsonResponse({ success: true }, 202));
      await startPromise;
    });

    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: false,
    });
  });

  it("accepts a settled crawl when WhatsApp history hangs past the start deadline", async () => {
    const historyPost = deferred<Response>();
    const historySignals: AbortSignal[] = [];
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      whatsappPost: init => {
        historySignals.push(init?.signal as AbortSignal);
        return historyPost.promise;
      },
      crawlPost: () => jsonResponse({ success: true }, 202),
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    let startPromise!: Promise<void>;
    let startSettled = false;
    act(() => {
      startPromise = result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
      void startPromise.then(() => {
        startSettled = true;
      });
    });
    await flushAsyncWork();
    expect(result.current.state.phase).toBe("starting");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(START_TRAINING_TIMEOUT_MS);
    });

    expect(startSettled).toBe(true);
    expect(historySignals[0]?.aborted).toBe(true);
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      whatsappHistoryRequested: true,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: false,
    });

    historyPost.resolve(
      jsonResponse({ status: "ok", data: { requested_at: "late" } })
    );
    await historyPost.promise;
    await flushAsyncWork();
    expect(result.current.state.whatsappHistoryRequested).toBe(true);
  });

  it("observes pending and terminal crawl rows when WhatsApp succeeds but crawl start times out", async () => {
    const crawlPost = deferred<Response>();
    const crawlSignals: AbortSignal[] = [];
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptyProgress))
      .mockResolvedValueOnce(jsonResponse(indexedAndPendingProgress()))
      .mockResolvedValueOnce(jsonResponse(indexedAndFailedProgress()));
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    installFetchHandlers({
      progressGet,
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      whatsappPost: () =>
        jsonResponse({ status: "ok", data: { requested_at: "now" } }),
      crawlPost: init => {
        crawlSignals.push(init?.signal as AbortSignal);
        return crawlPost.promise;
      },
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    let startPromise!: Promise<void>;
    let startSettled = false;
    act(() => {
      startPromise = result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
      void startPromise.then(() => {
        startSettled = true;
      });
    });
    await flushAsyncWork();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(START_TRAINING_TIMEOUT_MS);
    });

    expect(startSettled).toBe(true);
    expect(crawlSignals[0]?.aborted).toBe(true);
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      whatsappHistoryRequested: true,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: false,
    });
    expect(
      setTimeoutSpy.mock.calls.filter(
        ([, delay]) => delay === POLL_BACKOFF_MS[0]
      )
    ).toHaveLength(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(progressGet).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({
      phase: "polling",
      counts: { total: 2, indexed: 1, pending: 1, failed: 0 },
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: true,
      background: false,
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[1]);
    });
    expect(progressGet).toHaveBeenCalledTimes(3);
    expect(result.current.state).toMatchObject({
      phase: "ready",
      counts: { total: 2, indexed: 1, pending: 0, failed: 1 },
      sources: [
        expect.objectContaining({ index_status: "indexed" }),
        expect.objectContaining({ index_status: "failed" }),
      ],
    });
    const readyCalls = mockCaptureOnboardingAnalytics.mock.calls.filter(
      ([params]) =>
        (params as { event?: string }).event === "onboarding_training_ready"
    );
    expect(readyCalls).toHaveLength(1);

    crawlPost.resolve(jsonResponse({ success: true }, 202));
    await crawlPost.promise;
    await flushAsyncWork();
    expect(result.current.state.phase).toBe("ready");
    expect(progressGet).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });
    expect(progressGet).toHaveBeenCalledTimes(3);
    expect(result.current.state.phase).toBe("ready");
  });

  it.each([
    { code: "training_start_failed", status: 500 },
    { code: "background_processing_unavailable", status: 503 },
  ])(
    "refreshes server failed rows after crawl response $code",
    async ({ code, status }) => {
      const progressGet = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse(emptyProgress))
        .mockResolvedValueOnce(jsonResponse(failedProgress()));
      installFetchHandlers({
        progressGet,
        integrationsGet: () =>
          jsonResponse({ sources: [{ type: "whatsapp" }] }),
        whatsappStatusGet: () =>
          jsonResponse({
            data: {
              history_sync_eligible: true,
              history_sync_can_request: true,
              history_sync: {
                session_id: "new-session",
                session_started_at: new Date().toISOString(),
              },
            },
          }),
        whatsappPost: () =>
          jsonResponse({ status: "ok", data: { requested_at: "now" } }),
        crawlPost: () => jsonResponse({ code }, status),
      });
      const { result, onHandoffStateChange } = renderController();
      await flushAsyncWork();

      await act(async () => {
        await result.current.startTraining({
          websites: ["https://example.com"],
          includeInstagram: false,
          includeWhatsapp: true,
        });
      });

      expect(result.current.state.phase).toBe("polling");
      expect(onHandoffStateChange).toHaveBeenLastCalledWith({
        mutationPending: false,
        started: true,
        ready: false,
        background: false,
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
      });

      expect(progressGet).toHaveBeenCalledTimes(2);
      expect(result.current.state).toMatchObject({
        phase: "idle",
        counts: { total: 1, indexed: 0, pending: 0, failed: 1 },
        sources: [expect.objectContaining({ index_status: "failed" })],
      });
    }
  );

  it("observes a crawl-only 500 until the persisted failed row is visible", async () => {
    const raw = "private workflow and database diagnostics";
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptyProgress))
      .mockResolvedValueOnce(jsonResponse(failedProgress()));
    installFetchHandlers({
      progressGet,
      crawlPost: () =>
        jsonResponse({ code: "training_start_failed", error: raw }, 500),
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      errorCode: null,
    });
    expect(JSON.stringify(result.current.state)).not.toContain(raw);
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: false,
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_failed" })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });

    expect(progressGet).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({
      phase: "idle",
      acceptedRun: true,
      counts: { total: 1, indexed: 0, pending: 0, failed: 1 },
      sources: [expect.objectContaining({ index_status: "failed" })],
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_failed" })
    );
  });

  it("observes a timed-out crawl-only start through pending and terminal rows", async () => {
    const crawlPost = deferred<Response>();
    const crawlSignals: AbortSignal[] = [];
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptyProgress))
      .mockResolvedValueOnce(jsonResponse(indexedAndPendingProgress()))
      .mockResolvedValueOnce(jsonResponse(indexedAndFailedProgress()));
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    installFetchHandlers({
      progressGet,
      crawlPost: init => {
        crawlSignals.push(init?.signal as AbortSignal);
        return crawlPost.promise;
      },
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    let startPromise!: Promise<void>;
    let startSettled = false;
    act(() => {
      startPromise = result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
      void startPromise.then(() => {
        startSettled = true;
      });
    });
    await flushAsyncWork();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(START_TRAINING_TIMEOUT_MS);
    });

    expect(startSettled).toBe(true);
    expect(crawlSignals[0]?.aborted).toBe(true);
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      errorCode: null,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: false,
    });
    expect(
      setTimeoutSpy.mock.calls.filter(
        ([, delay]) => delay === POLL_BACKOFF_MS[0]
      )
    ).toHaveLength(1);
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_failed" })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    });
    expect(result.current.state).toMatchObject({
      phase: "polling",
      counts: { total: 2, indexed: 1, pending: 1, failed: 0 },
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, background: false })
    );

    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_BACKOFF_MS[1]);
    });
    expect(result.current.state).toMatchObject({
      phase: "ready",
      counts: { total: 2, indexed: 1, pending: 0, failed: 1 },
      sources: [
        expect.objectContaining({ index_status: "indexed" }),
        expect.objectContaining({ index_status: "failed" }),
      ],
    });

    crawlPost.resolve(jsonResponse({ success: true }, 202));
    await crawlPost.promise;
    await flushAsyncWork();
    expect(progressGet).toHaveBeenCalledTimes(3);
    expect(result.current.state.phase).toBe("ready");
  });

  it("bounds a crawl-only uncertain empty result in background", async () => {
    const progressGet = jest.fn(async () => jsonResponse(emptyProgress));
    installFetchHandlers({
      progressGet,
      crawlPost: () =>
        jsonResponse({ code: "background_processing_unavailable" }, 503),
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      errorCode: null,
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });

    expect(result.current.state.phase).toBe("background");
    expect(progressGet).toHaveBeenCalledTimes(POLL_BACKOFF_MS.length);
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: true,
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_failed" })
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it("surfaces a pre-persistence source limit without polling after WhatsApp succeeds", async () => {
    const raw = "company_id=secret has 5 rows in kb_indexed_urls";
    const progressGet = jest.fn(async () => jsonResponse(emptyProgress));
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    installFetchHandlers({
      progressGet,
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      whatsappPost: () =>
        jsonResponse({ status: "ok", data: { requested_at: "now" } }),
      crawlPost: () =>
        jsonResponse({ code: "indexed_url_limit_exceeded", error: raw }, 400),
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      acceptedRun: true,
      errorCode: "indexed_url_limit_exceeded",
      whatsappHistoryRequested: true,
    });
    expect(JSON.stringify(result.current.state)).not.toContain(raw);
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: false,
      background: false,
    });
    expect(
      setTimeoutSpy.mock.calls.filter(([, delay]) =>
        POLL_BACKOFF_MS.includes(delay as (typeof POLL_BACKOFF_MS)[number])
      )
    ).toHaveLength(0);
    const readyCalls = mockCaptureOnboardingAnalytics.mock.calls.filter(
      ([params]) =>
        (params as { event?: string }).event === "onboarding_training_ready"
    );
    expect(readyCalls).toHaveLength(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });
    expect(progressGet).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("error");
    expect(onHandoffStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, background: false })
    );
  });

  it("surfaces a crawl-only source limit without starting observation", async () => {
    const progressGet = jest.fn(async () => jsonResponse(emptyProgress));
    installFetchHandlers({
      progressGet,
      crawlPost: () =>
        jsonResponse(
          {
            code: "indexed_url_limit_exceeded",
            error: "private database diagnostics",
          },
          400
        ),
    });
    const { result, onHandoffStateChange } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      acceptedRun: false,
      errorCode: "indexed_url_limit_exceeded",
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: false,
      ready: false,
      background: false,
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });
    expect(progressGet).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("error");
  });

  it("maps an uncoded crawl schema rejection to safe source guidance", async () => {
    const raw = "websites[0] exposed private validator detail";
    const progressGet = jest.fn(async () => jsonResponse(emptyProgress));
    installFetchHandlers({
      progressGet,
      crawlPost: () => jsonResponse({ error: raw }, 400),
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "invalid_training_source",
    });
    expect(JSON.stringify(result.current.state)).not.toContain(raw);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });
    expect(progressGet).toHaveBeenCalledTimes(1);
  });

  it.each(["already_requested", "not_coexistence"])(
    "continues website enqueue after WhatsApp returns %s",
    async errorCode => {
      const crawlPost = jest.fn(async () =>
        jsonResponse({ success: true }, 202)
      );
      const whatsappPost = jest.fn(async () =>
        jsonResponse(
          { error: "raw provider detail", error_code: errorCode },
          409
        )
      );
      installFetchHandlers({
        integrationsGet: () =>
          jsonResponse({ sources: [{ type: "whatsapp" }] }),
        whatsappStatusGet: () =>
          jsonResponse({
            data: {
              history_sync_eligible: true,
              history_sync_can_request: true,
              history_sync: {
                session_id: "new-session",
                session_started_at: new Date().toISOString(),
              },
            },
          }),
        crawlPost,
        whatsappPost,
      });
      const { result } = renderController();
      await flushAsyncWork();

      await act(async () => {
        await result.current.startTraining({
          websites: ["https://example.com"],
          includeInstagram: false,
          includeWhatsapp: true,
        });
      });

      expect(whatsappPost).toHaveBeenCalledTimes(1);
      expect(crawlPost).toHaveBeenCalledTimes(1);
      expect(result.current.state).toMatchObject({
        phase: "polling",
        acceptedRun: true,
        errorCode: null,
      });
      expect(JSON.stringify(result.current.state)).not.toContain(
        "raw provider detail"
      );
      if (errorCode === "already_requested") {
        expect(result.current.state.whatsappHistoryRequested).toBe(true);
      } else {
        expect(result.current.state.whatsappHistoryEligible).toBe(false);
      }
    }
  );

  it("skips the history POST when history was already requested", async () => {
    const whatsappPost = jest.fn(async () => jsonResponse({ status: "ok" }));
    const crawlPost = jest.fn(async () => jsonResponse({ success: true }, 202));
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync: { requested_at: "2026-07-10T00:00:00.000Z" },
          },
        }),
      whatsappPost,
      crawlPost,
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(whatsappPost).not.toHaveBeenCalled();
    expect(crawlPost).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
    });
  });

  it("does not mark legacy requested history as ready on load", async () => {
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync: { requested_at: "2026-07-10T00:00:00.000Z" },
          },
        }),
    });
    const { result } = renderController();

    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "idle",
      whatsappHistoryRequested: true,
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_ready" })
    );
  });

  it("keeps initial Cloud API WhatsApp ready without emitting readiness analytics", async () => {
    const onHandoffStateChange = jest.fn();
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: false,
            history_sync: null,
          },
        }),
    });
    const { result } = renderController(onHandoffStateChange);

    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "ready",
      connected: { instagram: false, whatsapp: true },
      whatsappStatusKnown: true,
      whatsappHistoryEligible: false,
      whatsappHistoryRequested: false,
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: false,
      ready: true,
      background: false,
    });
    const readyCalls = mockCaptureOnboardingAnalytics.mock.calls.filter(
      ([params]) =>
        (params as { event?: string }).event === "onboarding_training_ready"
    );
    expect(readyCalls).toHaveLength(0);
  });

  it("emits Cloud API readiness analytics after training is accepted", async () => {
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: false,
            history_sync: null,
          },
        }),
    });
    const { result } = renderController();
    await flushAsyncWork();

    expect(result.current.state.phase).toBe("ready");
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_ready" })
    );

    await act(async () => {
      await result.current.startTraining({
        websites: [],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "ready",
      acceptedRun: true,
    });
    expect(mockCaptureOnboardingAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_ready" })
    );
  });

  it("keeps durable indexed readiness in handoff state after refresh failure", async () => {
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(indexedProgress()))
      .mockResolvedValueOnce(
        jsonResponse({ code: "training_progress_unavailable" }, 500)
      );
    const onHandoffStateChange = jest.fn();
    installFetchHandlers({ progressGet });
    const { result } = renderController(onHandoffStateChange);
    await flushAsyncWork();

    await act(async () => {
      await result.current.checkAgain();
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      sources: [expect.objectContaining({ index_status: "indexed" })],
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: true,
      background: false,
    });
  });

  it("keeps durable indexed readiness in handoff state after start failure", async () => {
    const onHandoffStateChange = jest.fn();
    installFetchHandlers({
      progressGet: () => jsonResponse(indexedProgress()),
      crawlPost: () => jsonResponse({ code: "authorization_failed" }, 403),
    });
    const { result } = renderController(onHandoffStateChange);
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "training_start_failed",
      sources: [expect.objectContaining({ index_status: "indexed" })],
    });
    expect(onHandoffStateChange).toHaveBeenLastCalledWith({
      mutationPending: false,
      started: true,
      ready: true,
      background: false,
    });
  });

  it("does not mistake an unavailable WhatsApp status for non-coexistence", async () => {
    const progressGet = jest.fn(async () => jsonResponse(emptyProgress));
    const whatsappPost = jest.fn(async () =>
      jsonResponse(
        { error: "not available", error_code: "not_coexistence" },
        409
      )
    );
    installFetchHandlers({
      progressGet,
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () => Promise.reject(new Error("status down")),
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: [],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(whatsappPost).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: "error",
      acceptedRun: false,
      whatsappStatusKnown: false,
      whatsappHistoryEligible: false,
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FOREGROUND_OBSERVATION_MS);
    });
    expect(progressGet).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("error");
  });

  it("does not probe history with a POST when status is unknown", async () => {
    const whatsappPost = jest.fn(async () =>
      jsonResponse({ error: "history unavailable" }, 502)
    );
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({ error: "whatsapp_not_connected" }, 404),
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();

    expect(result.current.state).toMatchObject({
      phase: "idle",
      connected: { instagram: false, whatsapp: true },
      whatsappStatusKnown: false,
      whatsappHistoryEligible: false,
      whatsappHistoryRequested: false,
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_ready" })
    );

    await act(async () => {
      await result.current.startTraining({
        websites: [],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(whatsappPost).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: "error",
      acceptedRun: false,
      whatsappStatusKnown: false,
      errorCode: "whatsapp_history_failed",
    });
    expect(mockCaptureOnboardingAnalytics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "onboarding_training_ready" })
    );
  });

  it("keeps unknown WhatsApp failure non-ready when a crawl branch is accepted", async () => {
    const crawlPost = jest.fn(async () => jsonResponse({ success: true }, 202));
    const whatsappPost = jest.fn(async () =>
      jsonResponse(
        {
          error: "private Meta response",
          data: {
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
              request_state: "rejected",
              status: "error",
            },
          },
        },
        502
      )
    );
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () => Promise.reject(new Error("status down")),
      crawlPost,
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    const readyCalls = mockCaptureOnboardingAnalytics.mock.calls.filter(
      ([params]) =>
        (params as { event?: string }).event === "onboarding_training_ready"
    );
    expect(crawlPost).toHaveBeenCalledTimes(1);
    expect(whatsappPost).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      errorCode: null,
      whatsappStatusKnown: false,
    });
    expect(readyCalls).toHaveLength(0);
  });

  it("uses the stable generic code for unknown crawl response text", async () => {
    installFetchHandlers({
      crawlPost: () =>
        jsonResponse(
          {
            code: "unknown_backend_code",
            error: "postgres table and secret details",
          },
          403
        ),
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: false,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "training_start_failed",
      acceptedRun: false,
    });
    expect(JSON.stringify(result.current.state)).not.toContain(
      "postgres table and secret details"
    );
  });

  it("uses the safe WhatsApp code only when no crawl branch was accepted", async () => {
    const crawlPost = jest.fn(async () => jsonResponse({ success: true }, 202));
    const whatsappPost = jest.fn(async () =>
      jsonResponse(
        {
          error: "private Meta response",
          data: {
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
              request_state: "rejected",
              status: "error",
            },
          },
        },
        502
      )
    );
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      crawlPost,
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: [],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "whatsapp_history_failed",
      acceptedRun: false,
    });
    expect(crawlPost).not.toHaveBeenCalled();
    expect(JSON.stringify(result.current.state)).not.toContain(
      "private Meta response"
    );

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(crawlPost).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({
      phase: "polling",
      acceptedRun: true,
      errorCode: null,
    });
  });

  it("uses the generic code when both selected start branches fail", async () => {
    const crawlPost = jest.fn(async () =>
      jsonResponse({ code: "authorization_failed" }, 403)
    );
    const whatsappPost = jest.fn(async () =>
      jsonResponse(
        {
          error: "private Meta response",
          data: {
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
              request_state: "rejected",
              status: "error",
            },
          },
        },
        502
      )
    );
    installFetchHandlers({
      integrationsGet: () => jsonResponse({ sources: [{ type: "whatsapp" }] }),
      whatsappStatusGet: () =>
        jsonResponse({
          data: {
            history_sync_eligible: true,
            history_sync_can_request: true,
            history_sync: {
              session_id: "new-session",
              session_started_at: new Date().toISOString(),
            },
          },
        }),
      crawlPost,
      whatsappPost,
    });
    const { result } = renderController();
    await flushAsyncWork();

    await act(async () => {
      await result.current.startTraining({
        websites: ["https://example.com"],
        includeInstagram: false,
        includeWhatsapp: true,
      });
    });

    expect(crawlPost).toHaveBeenCalledTimes(1);
    expect(whatsappPost).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({
      phase: "error",
      errorCode: "training_start_failed",
      acceptedRun: false,
    });
  });

  it("fires readiness analytics only on the first semantic ready transition", async () => {
    const progressGet = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptyProgress))
      .mockResolvedValueOnce(jsonResponse({ ...emptyProgress, pending: 1 }))
      .mockResolvedValue(
        jsonResponse(indexedProgress("https://instagram.com/brand"))
      );
    installFetchHandlers({
      progressGet,
      integrationsGet: () => jsonResponse({ sources: [{ type: "instagram" }] }),
    });
    const { result } = renderController();
    await flushAsyncWork();

    const readyCalls = () =>
      mockCaptureOnboardingAnalytics.mock.calls.filter(
        ([params]) =>
          (params as { event?: string }).event === "onboarding_training_ready"
      );
    expect(result.current.state.connected.instagram).toBe(true);
    expect(readyCalls()).toHaveLength(0);

    await act(async () => {
      await result.current.startTraining({
        websites: [],
        includeInstagram: true,
        includeWhatsapp: false,
      });
    });
    expect(result.current.state.phase).toBe("polling");
    expect(readyCalls()).toHaveLength(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(
        POLL_BACKOFF_MS[0] + POLL_BACKOFF_MS[1]
      );
    });

    expect(result.current.state.phase).toBe("ready");
    expect(readyCalls()).toHaveLength(1);

    await act(async () => {
      await result.current.checkAgain();
    });
    expect(readyCalls()).toHaveLength(1);
  });
});
