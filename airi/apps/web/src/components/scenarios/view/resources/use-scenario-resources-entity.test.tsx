/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import {
  fetchScenarioWhatsAppFlows,
  fetchScenarioWhatsAppTemplates,
  loadScenarioAudienceOptions,
  loadScenarioContextOptions,
  readCachedScenarioAudienceOptions,
  readCachedScenarioContextOptions,
} from "@/lib/scenarios/client";
import { useScenarioResourcesEntity } from "./use-scenario-resources-entity";
import {
  invalidateWhatsAppTemplateCatalog,
  WhatsAppTemplateCatalogRequestError,
} from "@/lib/whatsapp/templates/catalog-client";

jest.mock("@/lib/scenarios/client", () => ({
  fetchScenarioContextItems: jest.fn(),
  fetchScenarioWhatsAppFlows: jest.fn(),
  fetchScenarioWhatsAppTemplates: jest.fn(),
  loadScenarioAudienceOptions: jest.fn(),
  loadScenarioContextOptions: jest.fn(),
  readCachedScenarioAudienceOptions: jest.fn(),
  readCachedScenarioContextOptions: jest.fn(),
}));

const mockLoadScenarioAudienceOptions =
  loadScenarioAudienceOptions as jest.MockedFunction<
    typeof loadScenarioAudienceOptions
  >;
const mockLoadScenarioContextOptions =
  loadScenarioContextOptions as jest.MockedFunction<
    typeof loadScenarioContextOptions
  >;
const mockReadCachedScenarioAudienceOptions =
  readCachedScenarioAudienceOptions as jest.MockedFunction<
    typeof readCachedScenarioAudienceOptions
  >;
const mockReadCachedScenarioContextOptions =
  readCachedScenarioContextOptions as jest.MockedFunction<
    typeof readCachedScenarioContextOptions
  >;
const mockFetchScenarioWhatsAppFlows =
  fetchScenarioWhatsAppFlows as jest.MockedFunction<
    typeof fetchScenarioWhatsAppFlows
  >;
const mockFetchScenarioWhatsAppTemplates =
  fetchScenarioWhatsAppTemplates as jest.MockedFunction<
    typeof fetchScenarioWhatsAppTemplates
  >;

function audienceOptions(channels: string[] = []) {
  return {
    channels,
    classificationCategories: [],
    funnelStages: [],
    internalLabels: [],
    customers: [],
    metaReferralAds: [],
    metaReferralCampaigns: [],
    metaReferralAdSets: [],
    metaCampaignLabels: [],
  };
}

describe("useScenarioResourcesEntity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadCachedScenarioContextOptions.mockReturnValue(null);
    mockReadCachedScenarioAudienceOptions.mockReturnValue(null);
    mockLoadScenarioContextOptions.mockResolvedValue([]);
    mockLoadScenarioAudienceOptions.mockResolvedValue(audienceOptions());
    mockFetchScenarioWhatsAppFlows.mockResolvedValue([]);
    mockFetchScenarioWhatsAppTemplates.mockResolvedValue([]);
  });

  it("shows the workspace's recently read options at mount, before any answer", () => {
    const cachedContext = [{ id: "faq", label: "FAQ" }] as never;
    const cachedAudience = audienceOptions(["whatsapp"]);
    mockReadCachedScenarioContextOptions.mockReturnValue(cachedContext);
    mockReadCachedScenarioAudienceOptions.mockReturnValue(cachedAudience);
    mockLoadScenarioContextOptions.mockReturnValue(new Promise(() => {}));
    mockLoadScenarioAudienceOptions.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() =>
      useScenarioResourcesEntity({ workspaceId: "workspace-1" })
    );

    expect(result.current.contextOptions).toBe(cachedContext);
    expect(result.current.audienceOptions).toBe(cachedAudience);
    expect(mockReadCachedScenarioContextOptions).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockLoadScenarioAudienceOptions).toHaveBeenCalledWith("workspace-1");
  });

  it("adopts options the cached loaders answer", async () => {
    const context = [{ id: "faq", label: "FAQ" }] as never;
    const audience = audienceOptions(["telegram"]);
    mockLoadScenarioContextOptions.mockResolvedValue(context);
    mockLoadScenarioAudienceOptions.mockResolvedValue(audience);

    const { result } = renderHook(() =>
      useScenarioResourcesEntity({ workspaceId: "workspace-1" })
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.contextOptions).toBe(context);
    expect(result.current.audienceOptions).toBe(audience);
  });

  it("keeps the shown options when asking again answers the same, and takes a changed answer", async () => {
    const cachedContext = [{ id: "faq", label: "FAQ" }] as never;
    const cachedAudience = audienceOptions(["whatsapp"]);
    mockReadCachedScenarioContextOptions.mockReturnValue(cachedContext);
    mockReadCachedScenarioAudienceOptions.mockReturnValue(cachedAudience);
    mockLoadScenarioContextOptions.mockResolvedValue([
      { id: "faq", label: "FAQ" },
    ] as never);
    const changedAudience = audienceOptions(["whatsapp", "telegram"]);
    mockLoadScenarioAudienceOptions.mockResolvedValue(changedAudience);

    const { result } = renderHook(() =>
      useScenarioResourcesEntity({ workspaceId: "workspace-1" })
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockLoadScenarioContextOptions).toHaveBeenCalledWith("workspace-1");
    expect(result.current.contextOptions).toBe(cachedContext);
    expect(result.current.audienceOptions).toBe(changedAudience);
  });

  it("keeps unloaded template and Flow lists identical across renders", () => {
    const { result, rerender } = renderHook(() =>
      useScenarioResourcesEntity({
        workspaceId: "workspace-1",
        whatsAppSourceIds: ["source-1"],
      })
    );
    const { whatsAppTemplates, whatsAppFlows } = result.current;

    rerender();

    expect(result.current.whatsAppTemplates).toBe(whatsAppTemplates);
    expect(result.current.whatsAppFlows).toBe(whatsAppFlows);
    expect(result.current.whatsAppTemplates).toEqual([]);
  });

  it("loads Flow options for every connected WhatsApp source", async () => {
    const { result } = renderHook(() =>
      useScenarioResourcesEntity({
        workspaceId: "workspace-1",
        whatsAppSourceIds: ["source-1", "source-2"],
      })
    );

    await act(async () => {
      await result.current.loadWhatsAppFlows();
    });

    expect(mockFetchScenarioWhatsAppFlows).toHaveBeenCalledWith("workspace-1", {
      force: false,
      sourceIds: ["source-1", "source-2"],
    });
  });

  it("invalidates loaded Flow options when the normalized source scope changes", async () => {
    mockFetchScenarioWhatsAppFlows
      .mockResolvedValueOnce([
        {
          id: "flow-1",
          name: "First source Flow",
          sourceId: "source-1",
          status: "PUBLISHED",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "flow-2",
          name: "Second source Flow",
          sourceId: "source-2",
          status: "PUBLISHED",
        },
      ]);
    const { result, rerender } = renderHook(
      ({ sourceIds }: { sourceIds: readonly string[] }) =>
        useScenarioResourcesEntity({
          workspaceId: "workspace-1",
          whatsAppSourceIds: sourceIds,
        }),
      { initialProps: { sourceIds: [" source-1 ", "source-1"] } }
    );

    await act(async () => {
      await result.current.loadWhatsAppFlows();
    });
    expect(result.current.whatsAppFlows).toEqual([
      expect.objectContaining({ id: "flow-1", sourceId: "source-1" }),
    ]);

    rerender({ sourceIds: ["source-2"] });

    expect(result.current.whatsAppFlows).toEqual([]);
    expect(result.current.hasLoadedWhatsAppFlows).toBe(false);
    await act(async () => {
      await result.current.loadWhatsAppFlows();
    });

    expect(mockFetchScenarioWhatsAppFlows).toHaveBeenCalledTimes(2);
    expect(mockFetchScenarioWhatsAppFlows).toHaveBeenLastCalledWith(
      "workspace-1",
      { force: false, sourceIds: ["source-2"] }
    );
    expect(result.current.whatsAppFlows).toEqual([
      expect.objectContaining({ id: "flow-2", sourceId: "source-2" }),
    ]);
  });

  it("ignores an old in-flight Flow response after the source scope changes", async () => {
    let resolveFirstRequest!: (
      flows: Awaited<ReturnType<typeof fetchScenarioWhatsAppFlows>>
    ) => void;
    const firstRequest = new Promise<
      Awaited<ReturnType<typeof fetchScenarioWhatsAppFlows>>
    >(resolve => {
      resolveFirstRequest = resolve;
    });
    mockFetchScenarioWhatsAppFlows
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValueOnce([
        {
          id: "flow-2",
          name: "Current Flow",
          sourceId: "source-2",
          status: "PUBLISHED",
        },
      ]);
    const { result, rerender } = renderHook(
      ({ sourceIds }: { sourceIds: readonly string[] }) =>
        useScenarioResourcesEntity({
          workspaceId: "workspace-1",
          whatsAppSourceIds: sourceIds,
        }),
      { initialProps: { sourceIds: ["source-1"] } }
    );

    let firstLoad!: Promise<void>;
    act(() => {
      firstLoad = result.current.loadWhatsAppFlows();
    });
    rerender({ sourceIds: ["source-2"] });
    await act(async () => {
      await result.current.loadWhatsAppFlows();
    });
    expect(result.current.whatsAppFlows).toEqual([
      expect.objectContaining({ id: "flow-2", sourceId: "source-2" }),
    ]);

    await act(async () => {
      resolveFirstRequest([
        {
          id: "flow-1",
          name: "Stale Flow",
          sourceId: "source-1",
          status: "PUBLISHED",
        },
      ]);
      await firstLoad;
    });

    expect(mockFetchScenarioWhatsAppFlows).toHaveBeenCalledTimes(2);
    expect(result.current.whatsAppFlows).toEqual([
      expect.objectContaining({ id: "flow-2", sourceId: "source-2" }),
    ]);
  });

  it("reuses a loaded Flow scope when source order and duplicates change", async () => {
    mockFetchScenarioWhatsAppFlows.mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(
      ({ sourceIds }: { sourceIds: readonly string[] }) =>
        useScenarioResourcesEntity({
          workspaceId: "workspace-1",
          whatsAppSourceIds: sourceIds,
        }),
      {
        initialProps: {
          sourceIds: ["source-2", " source-1 ", "source-2"],
        },
      }
    );

    await act(async () => {
      await result.current.loadWhatsAppFlows();
    });
    rerender({ sourceIds: ["source-1", "source-2"] });
    await act(async () => {
      await result.current.loadWhatsAppFlows();
    });

    expect(mockFetchScenarioWhatsAppFlows).toHaveBeenCalledTimes(1);
    expect(mockFetchScenarioWhatsAppFlows).toHaveBeenCalledWith("workspace-1", {
      force: false,
      sourceIds: ["source-1", "source-2"],
    });
  });

  it("retains loaded templates when a refresh fails and respects provider cooldown", async () => {
    const templates = [
      { id: "saved", name: "saved_offer", language: "en", status: "APPROVED" },
    ];
    mockFetchScenarioWhatsAppTemplates
      .mockResolvedValueOnce(templates)
      .mockRejectedValueOnce(
        new WhatsAppTemplateCatalogRequestError(
          "Throttled",
          429,
          "WHATSAPP_TEMPLATES_RATE_LIMITED",
          80008,
          "2099-10-06T13:00:00.000Z"
        )
      );
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result } = renderHook(() =>
        useScenarioResourcesEntity({ workspaceId: "template-refresh" })
      );
      await act(async () => {
        await result.current.loadWhatsAppTemplates();
      });
      await act(async () => {
        await result.current.loadWhatsAppTemplates(true);
      });
      expect(result.current.whatsAppTemplates).toEqual(templates);
      expect(
        result.current.graphResourceState.whatsAppTemplatesError
      ).toMatchObject({
        retryAt: "2099-10-06T13:00:00.000Z",
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      });
      await act(async () => {
        await result.current.loadWhatsAppTemplates(true);
      });
      expect(mockFetchScenarioWhatsAppTemplates).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it.each(["expiry", "invalidation"])(
    "reads updated known rows without forcing Meta during cooldown after %s",
    async reason => {
      const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
      const catalog = {
        source: "cache" as const,
        stale: true,
        fetchedAt: new Date(0).toISOString(),
        wabaId: "waba",
        refreshOutcome: "cooldown" as const,
        retryAt: new Date(3_601_000).toISOString(),
      };
      let reads = 0;
      mockFetchScenarioWhatsAppTemplates.mockImplementation(
        async (_workspaceId, options) => {
          options?.onCatalogLoaded?.(catalog);
          reads += 1;
          return [
            {
              name: "known_offer",
              language: "en",
              status: reads === 1 ? "APPROVED" : "REJECTED",
            },
          ];
        }
      );
      try {
        const { result } = renderHook(() =>
          useScenarioResourcesEntity({ workspaceId: "known-cooldown" })
        );
        await act(async () => {
          await result.current.loadWhatsAppTemplates();
          await result.current.loadWhatsAppTemplates(true);
        });
        expect(mockFetchScenarioWhatsAppTemplates).toHaveBeenCalledTimes(1);
        // Meta's cooldown on a saved copy reads as its limit.
        expect(
          result.current.graphResourceState.whatsAppTemplatesError
        ).toEqual({
          retryAt: catalog.retryAt,
          code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        });
        await act(async () => {
          if (reason === "expiry") {
            now.mockReturnValue(31_001);
            await result.current.loadWhatsAppTemplates();
          } else {
            invalidateWhatsAppTemplateCatalog("known-cooldown");
          }
        });
        expect(result.current.whatsAppTemplates[0].status).toBe("REJECTED");
        expect(mockFetchScenarioWhatsAppTemplates).toHaveBeenCalledTimes(2);
        expect(mockFetchScenarioWhatsAppTemplates).toHaveBeenLastCalledWith(
          "known-cooldown",
          expect.objectContaining({ force: false, throwOnError: true })
        );
      } finally {
        now.mockRestore();
      }
    }
  );

  it("reports a saved catalog Meta couldn't refresh as unavailable, not limited", async () => {
    mockFetchScenarioWhatsAppTemplates.mockImplementation(
      async (_workspaceId, options) => {
        options?.onCatalogLoaded?.({
          source: "cache",
          stale: true,
          fetchedAt: new Date(0).toISOString(),
          wabaId: "waba",
          refreshOutcome: "failed",
          retryAt: null,
        });
        return [{ name: "saved_offer", language: "en", status: "APPROVED" }];
      }
    );
    const { result } = renderHook(() =>
      useScenarioResourcesEntity({ workspaceId: "stale-failed" })
    );
    await act(async () => {
      await result.current.loadWhatsAppTemplates();
    });
    expect(result.current.graphResourceState.whatsAppTemplatesError).toEqual({
      retryAt: null,
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
    });
  });

  it("keeps a failed cold load recoverable and reloads a mounted catalog after mutation", async () => {
    jest.useFakeTimers();
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    mockFetchScenarioWhatsAppTemplates
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce([{ name: "recovered", language: "en" }])
      .mockResolvedValueOnce([{ name: "edited", language: "en" }]);
    try {
      const { result } = renderHook(() =>
        useScenarioResourcesEntity({ workspaceId: "cold-recovery" })
      );
      await act(async () => {
        await result.current.loadWhatsAppTemplates();
      });
      expect(result.current.hasLoadedWhatsAppTemplates).toBe(false);
      // A network failure is not Meta's limit.
      expect(
        result.current.graphResourceState.whatsAppTemplatesError
      ).toMatchObject({ code: null });
      await act(async () => {
        await result.current.loadWhatsAppTemplates();
      });
      expect(mockFetchScenarioWhatsAppTemplates).toHaveBeenCalledTimes(1);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_001);
        await result.current.loadWhatsAppTemplates(true);
      });
      expect(result.current.whatsAppTemplates[0].name).toBe("recovered");
      await act(async () => {
        invalidateWhatsAppTemplateCatalog("cold-recovery");
      });
      expect(result.current.whatsAppTemplates[0].name).toBe("edited");
    } finally {
      log.mockRestore();
      jest.useRealTimers();
    }
  });

  it("ignores a catalog load started before a template mutation", async () => {
    let resolveOld!: (
      items: Awaited<ReturnType<typeof fetchScenarioWhatsAppTemplates>>
    ) => void;
    const oldRequest = new Promise<
      Awaited<ReturnType<typeof fetchScenarioWhatsAppTemplates>>
    >(resolve => {
      resolveOld = resolve;
    });
    mockFetchScenarioWhatsAppTemplates
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce([{ name: "new_template", language: "en" }]);
    const { result } = renderHook(() =>
      useScenarioResourcesEntity({ workspaceId: "pending-mutation" })
    );
    let oldLoad!: Promise<void>;
    act(() => {
      oldLoad = result.current.loadWhatsAppTemplates();
    });
    await act(async () => {
      invalidateWhatsAppTemplateCatalog("pending-mutation");
    });
    expect(result.current.whatsAppTemplates[0]?.name).toBe("new_template");
    await act(async () => {
      resolveOld([{ name: "old_template", language: "en" }]);
      await oldLoad;
    });
    expect(result.current.whatsAppTemplates[0]?.name).toBe("new_template");
  });
});
