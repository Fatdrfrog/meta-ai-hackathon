/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import {
  useBulkCampaignRecipientEligibilityPreview,
  type BulkCampaignEligibilityPreviewState,
  type UseBulkCampaignRecipientEligibilityPreviewInput,
} from "./use-bulk-campaign-recipient-eligibility-preview";
import { serializeBulkCampaignInlineRequest } from "@/lib/campaign/bulk-campaign-client";

function swrWrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        revalidateOnFocus: false,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

// SWR's own defaults (focus, reconnect and error retries on), as in the app.
function defaultSwrWrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

// SWR defaults under a provider that stays mounted, like the app's global
// cache, while the component using the hook mounts and unmounts.
function renderRemountablePreview(
  input: UseBulkCampaignRecipientEligibilityPreviewInput
) {
  const resultRef: { current: BulkCampaignEligibilityPreviewState | null } = {
    current: null,
  };
  const report = (state: BulkCampaignEligibilityPreviewState) => {
    resultRef.current = state;
  };
  function Probe() {
    report(useBulkCampaignRecipientEligibilityPreview(input));
    return null;
  }
  const cache = new Map();
  const tree = (mounted: boolean) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      {mounted ? <Probe /> : null}
    </SWRConfig>
  );
  const view = render(tree(true));
  return {
    result: resultRef,
    unmount: () => view.rerender(tree(false)),
    remount: () => view.rerender(tree(true)),
  };
}

const workspaceId = "00000000-0000-4000-8000-000000000501";
const sourceId = "source-1";
const SCENARIO_ID = "65f000000000000000000501";

const enabledPolicy = {
  version: 1 as const,
  excludePriorFailedBulkSends: true,
};

const disabledPolicy = {
  version: 1 as const,
  excludePriorFailedBulkSends: false,
};

const templateIntent = {
  kind: "whatsapp_template" as const,
  sourceId,
  templateName: "promo",
  language: "en",
};

const canonicalPreview = {
  state: "ready" as const,
  evaluatedAt: "2026-08-24T12:00:00.000Z",
  requestedTotal: 2,
  acceptedTotal: 1,
  uniqueRecipients: { requested: 2, accepted: 1 },
  skippedByReason: { prior_failure: 1 },
  warnings: { missingMarketingConsent: 0 },
  allExcluded: false,
  readiness: {
    state: "ready" as const,
    checkedAt: "2026-09-16T10:00:00.000Z",
    remainingCapacity: null,
    reasons: [],
  },
};

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase()
        )?.[1] ?? null,
    },
    json: async () => payload,
  } as Response;
}

function windowRegainsFocusAndNetwork() {
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
}

function parseBody(call: [RequestInfo | URL, RequestInit?] | undefined) {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("useBulkCampaignRecipientEligibilityPreview", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  const timedInput: UseBulkCampaignRecipientEligibilityPreviewInput = {
    workspaceId,
    channel: "whatsapp",
    messageIntent: templateIntent,
    audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
    recipientPolicy: disabledPolicy,
    provenance: { kind: "ad_hoc" },
    recurring: false,
  };

  function heldPreview(nextEligibleAt: string) {
    return {
      ...canonicalPreview,
      readiness: {
        ...canonicalPreview.readiness,
        state: "blocked",
        reasons: [
          {
            code: "contact_frequency_limit",
            affectedRecipientCount: 1,
            nextEligibleAt,
          },
        ],
      },
    };
  }

  it("refreshes at the contact deadline and waits for fresh server permission", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    let finishRefresh!: (response: Response) => void;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(heldPreview("2026-09-19T15:00:05Z")))
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            finishRefresh = resolve;
          })
      );
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_900);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      finishRefresh(jsonResponse(canonicalPreview));
    });
    expect(result.current.canSubmit).toBe(true);
  });

  it("checks an expired deadline once without looping on stale or clock-skewed responses", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    const stale = heldPreview("2026-09-19T14:59:00Z");
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(stale))
      .mockResolvedValue(
        jsonResponse({
          ...heldPreview("2026-09-19T14:59:30Z"),
          evaluatedAt: "2026-09-19T15:00:01Z",
        })
      );
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      if (result.current.state === "ready") result.current.retry();
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("cancels the contact deadline when the audience changes or the preview unmounts", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(heldPreview("2026-09-19T15:00:05Z")))
      .mockResolvedValueOnce(jsonResponse(canonicalPreview));
    const { result, rerender, unmount } = renderHook(
      input => useBulkCampaignRecipientEligibilityPreview(input),
      { initialProps: timedInput, wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    rerender({
      ...timedInput,
      audience: { kind: "inline", recipients: [{ phone: "+15550000002" }] },
    });
    await waitFor(() => expect(result.current.canSubmit).toBe(true));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending contact deadline on unmount", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(heldPreview("2026-09-19T15:00:05Z")));
    const { result, unmount } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a later contact deadline returned by the fresh check", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(heldPreview("2026-09-19T15:00:05Z")))
      .mockResolvedValueOnce(jsonResponse(heldPreview("2026-09-19T15:00:10Z")))
      .mockResolvedValueOnce(jsonResponse(canonicalPreview));
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result.current.canSubmit).toBe(true);
  });

  it("keeps failed automatic checks blocked without automatically retrying", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(heldPreview("2026-09-19T15:00:05Z")))
      .mockResolvedValueOnce(
        jsonResponse({ error: "Temporarily unavailable" }, 503)
      );
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.state).toBe("error");
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not re-check a failed preview on window focus or reconnect", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { state: "blocked", error: { code: "template_lookup_unavailable" } },
          503
        )
      );
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: defaultSwrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("error"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6_000);
      windowRegainsFocusAndNetwork();
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("error");
    await act(async () => {
      if (result.current.state === "error") result.current.retry();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not re-check a ready preview on window focus or reconnect", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(canonicalPreview));
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: defaultSwrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6_000);
      windowRegainsFocusAndNetwork();
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
  });

  it("waits out Retry-After before a remount checks a throttled preview again", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          state: "blocked",
          error: { code: "meta_rate_limited" },
          retryAfterSeconds: 60,
        },
        503
      )
    );
    const preview = renderRemountablePreview(timedInput);
    await waitFor(() => expect(preview.result.current?.state).toBe("error"));
    preview.unmount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    preview.remount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(preview.result.current).toMatchObject({
      state: "error",
      code: "meta_rate_limited",
    });
    preview.unmount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    preview.remount();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });

  it("reuses a ready preview from the last minute when it remounts", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-19T15:00:00Z") });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(canonicalPreview));
    const preview = renderRemountablePreview(timedInput);
    await waitFor(() => expect(preview.result.current?.state).toBe("ready"));
    preview.unmount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    preview.remount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(preview.result.current?.state).toBe("ready");
    preview.unmount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    preview.remount();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["body", { retryAfterSeconds: 60 }, {}],
    ["Retry-After header", {}, { "Retry-After": "60" }],
  ])(
    "exposes the server error code and a retry time from the %s",
    async (_source, retryBody, headers) => {
      const now = new Date("2026-09-19T15:00:00Z").getTime();
      jest.useFakeTimers({ now });
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          {
            state: "blocked",
            error: { code: "meta_rate_limited" },
            ...retryBody,
          },
          503,
          headers
        )
      );
      const { result } = renderHook(
        () => useBulkCampaignRecipientEligibilityPreview(timedInput),
        { wrapper: swrWrapper }
      );
      await waitFor(() => expect(result.current.state).toBe("error"));
      const errorState = result.current;
      if (errorState.state !== "error") throw new Error("Expected an error");
      expect(errorState).toMatchObject({
        canSubmit: false,
        code: "meta_rate_limited",
        error: "Failed to check recipient eligibility",
      });
      expect(errorState.retryAt).toBeGreaterThanOrEqual(now + 60_000);
      expect(errorState.retryAt).toBeLessThan(now + 61_000);
    }
  );

  it("keeps a string server error as the message without inventing a code", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Temporarily unavailable" }, 503)
      );
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("error"));
    const errorState = result.current;
    if (errorState.state !== "error") throw new Error("Expected an error");
    expect(errorState.error).toBe("Temporarily unavailable");
    expect(errorState.code).toBeUndefined();
    expect(errorState.retryAt).toBeUndefined();
  });

  it("does not turn a long contact window into an overflowing immediate timeout", async () => {
    const startedAt = new Date("2026-09-19T15:00:00Z").getTime();
    const delay = 30 * 86_400_000;
    jest.useFakeTimers({ now: startedAt });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(heldPreview(new Date(startedAt + delay).toISOString()))
      )
      .mockResolvedValueOnce(jsonResponse(canonicalPreview));
    const { result } = renderHook(
      () => useBulkCampaignRecipientEligibilityPreview(timedInput),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_147_483_647);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(delay - 2_147_483_647);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.canSubmit).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["malformed", { state: "ready", remainingCapacity: 10, reasons: [] }],
    [
      "blocked",
      {
        ...canonicalPreview.readiness,
        state: "blocked",
        reasons: [
          {
            code: "contact_frequency_limit",
            affectedRecipientCount: 1,
            nextEligibleAt: "2026-09-17T10:00:00Z",
          },
        ],
      },
    ],
  ])(
    "does not permit sending with %s readiness when exclusion is off",
    async (_name, readiness) => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(jsonResponse({ ...canonicalPreview, readiness }));
      const { result } = renderHook(
        () =>
          useBulkCampaignRecipientEligibilityPreview({
            workspaceId,
            channel: "whatsapp",
            messageIntent: templateIntent,
            audience: {
              kind: "inline",
              recipients: [{ phone: "+15550000001" }],
            },
            recipientPolicy: disabledPolicy,
            provenance: { kind: "ad_hoc" },
            recurring: false,
          }),
        { wrapper: swrWrapper }
      );
      await waitFor(() => expect(result.current.state).toBe("ready"));
      expect(result.current.canSubmit).toBe(false);
    }
  );

  it("blocks cached ready results during refresh and after a failed refresh, then recovers", async () => {
    let finishRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>(resolve => {
      finishRefresh = resolve;
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(canonicalPreview))
      .mockReturnValueOnce(pendingRefresh)
      .mockResolvedValueOnce(jsonResponse(canonicalPreview));
    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
          recipientPolicy: disabledPolicy,
          provenance: { kind: "ad_hoc" },
          recurring: false,
        }),
      { wrapper: swrWrapper }
    );
    await waitFor(() => expect(result.current.canSubmit).toBe(true));
    if (result.current.state !== "ready")
      throw new Error("Expected ready preview");
    act(() => result.current.state === "ready" && result.current.retry());
    await waitFor(() => expect(result.current.state).toBe("loading"));
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      finishRefresh(jsonResponse({ error: "Temporarily unavailable" }, 503));
    });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.canSubmit).toBe(false);
    act(() => result.current.state === "error" && result.current.retry());
    await waitFor(() => expect(result.current.canSubmit).toBe(true));
  });

  it("fails closed while an enabled fixed-audience preview is loading or errored", async () => {
    global.fetch = jest.fn(() => new Promise(() => undefined)) as jest.Mock;

    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: {
            kind: "whatsapp_template",
            sourceId,
            templateName: "promo",
            language: "en",
          },
          audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
          recipientPolicy: { version: 1, excludePriorFailedBulkSends: true },
          provenance: { kind: "ad_hoc" },
          recurring: false,
        }),
      { wrapper: swrWrapper }
    );
    // Refresh stays offered (and disabled by the notice) while checking.
    expect(result.current).toEqual({
      state: "loading",
      canSubmit: false,
      retry: expect.any(Function),
    });
  });

  it("previews WhatsApp marketing eligibility even when prior-failure exclusion is off", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        evaluatedAt: canonicalPreview.evaluatedAt,
        requestedTotal: 2,
        acceptedTotal: 2,
        uniqueRecipients: { requested: 2, accepted: 2 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 1 },
        allExcluded: false,
        readiness: canonicalPreview.readiness,
      })
    );

    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
          recipientPolicy: disabledPolicy,
          provenance: { kind: "ad_hoc" },
          recurring: false,
        }),
      { wrapper: swrWrapper }
    );

    await waitFor(() => {
      expect(result.current.state).toBe("ready");
    });
    expect(result.current).toEqual({
      state: "ready",
      canSubmit: true,
      retry: expect.any(Function),
      preview: expect.objectContaining({
        warnings: { missingMarketingConsent: 1 },
        acceptedTotal: 2,
      }),
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  it.each([undefined, null, "", "not-a-date"])(
    "preserves unknown local evaluation time for %p without rejecting a valid initial legacy preview",
    async evaluatedAt => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          ...canonicalPreview,
          evaluatedAt,
          readiness: {
            ...canonicalPreview.readiness,
            checkedAt: "2026-09-19T15:00:06Z",
          },
        })
      );
      const { result } = renderHook(
        () => useBulkCampaignRecipientEligibilityPreview(timedInput),
        { wrapper: swrWrapper }
      );
      await waitFor(() => expect(result.current.state).toBe("ready"));
      expect(result.current.canSubmit).toBe(true);
      if (result.current.state !== "ready") throw new Error("Expected preview");
      expect(result.current.preview.evaluatedAt).toBeNull();
      expect(result.current.preview.readiness.checkedAt).toBe(
        "2026-09-19T15:00:06Z"
      );
    }
  );

  it("returns deferred for recurring audiences without inventing an exact count or uploading recipients", () => {
    global.fetch = jest.fn() as jest.Mock;

    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          audience: {
            kind: "inline",
            recipients: [{ phone: "+15550000001" }, { phone: "+15550000002" }],
          },
          recipientPolicy: enabledPolicy,
          provenance: { kind: "ad_hoc" },
          recurring: true,
        }),
      { wrapper: swrWrapper }
    );

    expect(result.current).toEqual({
      state: "deferred",
      canSubmit: true,
      appliesAt: "each_run",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("ignores stale responses from a superseded request", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>(resolve => {
      resolveFirst = resolve;
    });
    const fetchMock = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >((input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("+15550000001")) {
        return firstResponse;
      }
      return Promise.resolve(
        jsonResponse({
          ...canonicalPreview,
          requestedTotal: 1,
          acceptedTotal: 1,
          uniqueRecipients: { requested: 1, accepted: 1 },
          skippedByReason: {},
        })
      );
    });
    global.fetch = fetchMock as jest.Mock;

    const { result, rerender } = renderHook(
      ({ phone }) =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          audience: { kind: "inline", recipients: [{ phone }] },
          recipientPolicy: enabledPolicy,
          provenance: { kind: "ad_hoc" },
          recurring: false,
        }),
      { initialProps: { phone: "+15550000001" }, wrapper: swrWrapper }
    );

    expect(result.current.state).toBe("loading");
    rerender({ phone: "+15550000002" });

    await waitFor(() => expect(result.current.state).toBe("ready"));
    if (result.current.state !== "ready") {
      throw new Error("expected ready preview");
    }
    expect(result.current.preview.requestedTotal).toBe(1);
    expect(result.current.canSubmit).toBe(true);

    await act(async () => {
      resolveFirst?.(
        jsonResponse({
          ...canonicalPreview,
          requestedTotal: 99,
          acceptedTotal: 0,
          uniqueRecipients: { requested: 99, accepted: 0 },
          allExcluded: true,
        })
      );
      await firstResponse;
    });

    expect(result.current.state).toBe("ready");
    if (result.current.state !== "ready") {
      throw new Error("expected ready preview");
    }
    expect(result.current.preview.requestedTotal).toBe(1);
  });

  it("parses a canonical preview outcome and retries after an error", async () => {
    const fetchMock = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "Previous delivery failures could not be checked" },
        503
      )
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(canonicalPreview));
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
          recipientPolicy: enabledPolicy,
          provenance: { kind: "ad_hoc" },
          recurring: false,
        }),
      { wrapper: swrWrapper }
    );

    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.canSubmit).toBe(false);
    const errorState = result.current;
    if (errorState.state !== "error") {
      throw new Error("expected error preview");
    }
    expect(errorState.error).toContain("Previous delivery failures");

    await act(async () => {
      errorState.retry();
    });

    await waitFor(() => expect(result.current.state).toBe("ready"));
    const readyState = result.current;
    if (readyState.state !== "ready") {
      throw new Error("expected ready preview");
    }
    expect(readyState.preview).toEqual(canonicalPreview);
    expect(readyState.canSubmit).toBe(true);
    expect(parseBody(fetchMock.mock.calls[0])).toMatchObject({
      workspaceId,
      channel: "whatsapp",
      messageIntent: templateIntent,
      audience: {
        kind: "inline",
        recipients: [{ phone: "+15550000001" }],
      },
      recipientPolicy: enabledPolicy,
      provenance: { kind: "ad_hoc" },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      serializeBulkCampaignInlineRequest(parseBody(fetchMock.mock.calls[0]))
    );
  });

  it("posts generated identifier-only bodies and never uploads generated audiences", async () => {
    const fetchMock = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >(async () => jsonResponse(canonicalPreview));
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          audience: {
            kind: "inline",
            recipients: [{ phone: "+15550000001", name: "Ada" }],
          },
          recipientPolicy: enabledPolicy,
          provenance: {
            kind: "scenario_run_now",
            scenarioId: SCENARIO_ID,
            rootNodeId: "bulk-1",
            actionNodeId: "action-1",
          },
          scenarioRevision: "generation-job-1",
          observedPlanRevision: "plan-observation-1",
          recurring: false,
        }),
      { wrapper: swrWrapper }
    );

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/scenarios/${SCENARIO_ID}/bulk-recipient-eligibility`
    );
    expect(parseBody(fetchMock.mock.calls[0])).toEqual({
      workspaceId,
      observedPlanRevision: "plan-observation-1",
    });
  });

  it("treats a generated deferred marker as saveable without an invented count", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        state: "deferred",
        appliesAt: "each_run",
        policy: enabledPolicy,
      })
    ) as jest.Mock;

    const { result } = renderHook(
      () =>
        useBulkCampaignRecipientEligibilityPreview({
          workspaceId,
          channel: "whatsapp",
          messageIntent: templateIntent,
          recipientPolicy: enabledPolicy,
          provenance: {
            kind: "scenario_run_now",
            scenarioId: SCENARIO_ID,
            rootNodeId: "bulk-1",
          },
          scenarioRevision: "generation-job-1",
          recurring: false,
        }),
      { wrapper: swrWrapper }
    );

    await waitFor(() => expect(result.current.state).toBe("deferred"));
    expect(result.current).toEqual({
      state: "deferred",
      canSubmit: true,
      appliesAt: "each_run",
    });
  });
});
