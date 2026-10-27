/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ScenarioWhatsAppServiceMessageKind } from "@icecore/scenario-contracts";
import { readFileSync } from "node:fs";
import { useWhatsAppServiceMessageResources } from "./service-message-resources";
import {
  forgetWhatsAppServiceMessageResources,
  WHATSAPP_CALLING_READINESS_TTL_MS,
} from "./service-message-shared-resources";

function jsonResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("useWhatsAppServiceMessageResources", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    forgetWhatsAppServiceMessageResources();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("distinguishes a failed catalog load from empty data and retries", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { result } = renderHook(() =>
      useWhatsAppServiceMessageResources({
        workspaceId: "workspace-retry",
        kind: "commerce",
      })
    );
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.failedResources.catalog).toBe(true);
    expect(result.current.loading).toBe(false);
    jest
      .mocked(global.fetch)
      .mockResolvedValue(
        jsonResponse({ catalogs: [{ id: "recovered", name: "Shop" }] })
      );
    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    await waitFor(() =>
      expect(result.current.catalogs[0]?.id).toBe("recovered")
    );
    expect(result.current.failed).toBe(false);
  });

  it("asks once for calling readiness that every step of a workspace shares", async () => {
    const onboarding = deferred<Response>();
    const fetchMock = jest
      .fn()
      .mockImplementation((url: string) =>
        String(url).includes("/api/whatsapp/onboarding")
          ? onboarding.promise
          : Promise.resolve(jsonResponse({}))
      );
    global.fetch = fetchMock;
    const onboardingCalls = () =>
      fetchMock.mock.calls.filter(call =>
        String(call[0]).includes("/api/whatsapp/onboarding")
      ).length;
    const render = (kind: ScenarioWhatsAppServiceMessageKind) =>
      renderHook(() =>
        useWhatsAppServiceMessageResources({
          workspaceId: "workspace-shared",
          kind,
        })
      );

    const first = render("text");
    const second = render("reply_buttons");
    await act(async () => {
      onboarding.resolve(
        jsonResponse({
          status: { calls_operational_readiness: { ready: true } },
        })
      );
    });
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(first.result.current.callingReady).toBe(true);
    expect(second.result.current.callingReady).toBe(true);

    // A step that mounts later, such as one panned into view, reuses it.
    const third = render("media");
    await waitFor(() => expect(third.result.current.loading).toBe(false));
    expect(third.result.current.callingReady).toBe(true);
    expect(onboardingCalls()).toBe(1);
  });

  it("asks for calling readiness again once the shared answer is stale", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({
          status: { calls_operational_readiness: { ready: true } },
        })
      );
      global.fetch = fetchMock;
      const render = () =>
        renderHook(() =>
          useWhatsAppServiceMessageResources({
            workspaceId: "workspace-stale",
            kind: "text",
          })
        );

      const first = render();
      await waitFor(() => expect(first.result.current.loading).toBe(false));
      now.mockReturnValue(1_000 + WHATSAPP_CALLING_READINESS_TTL_MS + 1);
      const second = render();
      await waitFor(() => expect(second.result.current.loading).toBe(false));

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("does not share a failed calling readiness answer", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(
        jsonResponse({
          status: { calls_operational_readiness: { ready: true } },
        })
      );
    global.fetch = fetchMock;
    const render = () =>
      renderHook(() =>
        useWhatsAppServiceMessageResources({
          workspaceId: "workspace-failed",
          kind: "text",
        })
      );

    const first = render();
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.failedResources.calling).toBe(true);
    const second = render();
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(second.result.current.callingReady).toBe(true);
    expect(second.result.current.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    "./service-message-resources",
    "./service-message-shared-resources",
  ])(
    "does not import the server logger into the client bundle (%s)",
    modulePath => {
      const source = readFileSync(require.resolve(modulePath), "utf8");

      expect(source).not.toContain("@/lib/logger");
    }
  );

  it("loads only active signup links", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/whatsapp/signups")) {
        return Promise.resolve(
          jsonResponse({
            links: [
              {
                id: "active",
                metaSignupId: "meta-active",
                deepLinkUrl: "https://wa.me/active",
                displayName: "Active",
                status: "ACTIVE",
              },
              {
                id: "disabled",
                metaSignupId: "meta-disabled",
                deepLinkUrl: "https://wa.me/disabled",
                displayName: "Disabled",
                status: "DISABLED",
              },
            ],
          })
        );
      }
      if (String(url).includes("/api/whatsapp/onboarding")) {
        return Promise.resolve(
          jsonResponse({
            status: { calls_operational_readiness: { ready: true } },
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() =>
      useWhatsAppServiceMessageResources({
        workspaceId: "workspace-1",
        kind: "cta_url",
      })
    );

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.signupLinks.map(link => link.id)).toEqual(["active"]);
    expect(result.current.callingReady).toBe(true);
  });

  it("prefetches calling readiness for non-voice kinds when workspace is set", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/whatsapp/onboarding")) {
        return Promise.resolve(
          jsonResponse({
            status: { calls_operational_readiness: { ready: true } },
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() =>
      useWhatsAppServiceMessageResources({
        workspaceId: "workspace-1",
        kind: "text",
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // One request shared by the workspace's steps, so no step cancels it.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/whatsapp/onboarding"),
      undefined
    );
    expect(result.current.callingReady).toBe(true);
    expect(
      fetchMock.mock.calls.some(call =>
        String(call[0]).includes("/api/whatsapp/signups")
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(call =>
        String(call[0]).includes("/api/whatsapp/catalog")
      )
    ).toBe(false);
  });

  it("reuses an equivalent resource request when the message kind changes", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        status: { calls_operational_readiness: { ready: true } },
      })
    );
    global.fetch = fetchMock;

    const { result, rerender } = renderHook(
      ({ kind }) =>
        useWhatsAppServiceMessageResources({
          workspaceId: "workspace-1",
          kind,
        }),
      {
        initialProps: {
          kind: "text" as ScenarioWhatsAppServiceMessageKind,
        },
      }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.callingReady).toBe(true);

    rerender({ kind: "flow" });

    expect(result.current.loading).toBe(false);
    expect(result.current.callingReady).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps callingReady false on failed fetch without throwing", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() =>
      useWhatsAppServiceMessageResources({
        workspaceId: "workspace-1",
        kind: "text",
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.callingReady).toBe(false);
    expect(result.current.signupLinks).toEqual([]);
    expect(result.current.catalogs).toEqual([]);
    expect(result.current.products).toEqual([]);
  });

  it("keeps signup links when the onboarding prefetch fails", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/whatsapp/signups")) {
        return Promise.resolve(
          jsonResponse({
            links: [
              {
                id: "active",
                metaSignupId: "meta-active",
                deepLinkUrl: "https://wa.me/active",
                displayName: "Active",
                status: "ACTIVE",
              },
            ],
          })
        );
      }
      if (String(url).includes("/api/whatsapp/onboarding")) {
        return Promise.reject(new Error("onboarding down"));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() =>
      useWhatsAppServiceMessageResources({
        workspaceId: "workspace-1",
        kind: "cta_url",
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.signupLinks.map(link => link.id)).toEqual(["active"]);
    expect(result.current.callingReady).toBe(false);
    // Only the calling check failed, so only call messages report it.
    expect(result.current.failed).toBe(true);
    expect(result.current.failedResources).toEqual({
      signupLinks: false,
      calling: true,
      catalog: false,
    });
  });

  it("hides stale products while a changed catalog is loading", async () => {
    const nextCatalog = deferred<Response>();
    const onboardingResponse = jsonResponse({
      status: { calls_operational_readiness: { ready: false } },
    });
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/whatsapp/onboarding")) {
        return Promise.resolve(onboardingResponse);
      }
      if (String(url).includes("catalogId=catalog-a")) {
        return Promise.resolve(
          jsonResponse({
            catalogs: [{ id: "catalog-a", name: "Catalog A" }],
            selectedCatalog: { id: "catalog-a", name: "Catalog A" },
            products: [
              {
                retailer_id: "product-a",
                catalog_id: "catalog-a",
                name: "Product A",
              },
            ],
          })
        );
      }
      if (String(url).includes("catalogId=catalog-b")) {
        return nextCatalog.promise;
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { result, rerender } = renderHook(
      ({ catalogId }) =>
        useWhatsAppServiceMessageResources({
          workspaceId: "workspace-1",
          kind: "commerce",
          catalogId,
        }),
      { initialProps: { catalogId: "catalog-a" } }
    );

    await waitFor(() =>
      expect(result.current.products[0]?.retailer_id).toBe("product-a")
    );

    rerender({ catalogId: "catalog-b" });
    expect(result.current.loading).toBe(true);
    expect(result.current.products).toEqual([]);

    await act(async () => {
      nextCatalog.resolve(
        jsonResponse({
          catalogs: [{ id: "catalog-b", name: "Catalog B" }],
          selectedCatalog: { id: "catalog-b", name: "Catalog B" },
          products: [
            {
              retailer_id: "product-b",
              catalog_id: "catalog-b",
              name: "Product B",
            },
          ],
        })
      );
    });
    await waitFor(() =>
      expect(result.current.products[0]?.retailer_id).toBe("product-b")
    );
  });
});
