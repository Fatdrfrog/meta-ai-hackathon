const mockGetUnifiedTemplatesAction = jest.fn();

import {
  fetchWhatsAppTemplateCatalog,
  invalidateWhatsAppTemplateCatalog,
  shouldRetryWhatsAppTemplateCatalogError,
} from "@/lib/whatsapp/templates/catalog-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchWhatsAppTemplateCatalog", () => {
  const mockFetch = jest.fn();

  it("keeps concurrent catalogs for different sources isolated", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      jsonResponse({
        templates: [
          {
            id: url.includes("source-1") ? "first" : "second",
            name: "offer",
            language: "en",
            status: "APPROVED",
          },
        ],
      })
    );
    const results = await Promise.all([
      fetchWhatsAppTemplateCatalog({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      }),
      fetchWhatsAppTemplateCatalog({
        workspaceId: "workspace-1",
        sourceId: "source-2",
      }),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(results.map(result => result.metaTemplates[0].id)).toEqual([
      "first",
      "second",
    ]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateWhatsAppTemplateCatalog?.();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue(
      jsonResponse({
        templates: [
          {
            id: "meta-1",
            name: "promo",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
            components: [{ type: "BODY", text: "Hi {{1}}" }],
          },
        ],
        wabaId: "waba-current",
        previousWabaId: "waba-previous",
        wabaHistory: [
          { wabaId: "waba-previous", recordedAt: "2026-01-01T00:00:00.000Z" },
        ],
      })
    );
    mockGetUnifiedTemplatesAction.mockResolvedValue({
      success: true,
      data: {
        templates: [
          {
            id: "db-1",
            workspace_id: "workspace-1",
            name: "promo",
            channel: "both",
            whatsapp_data: {
              language: "en",
              category: "MARKETING",
              status: "APPROVED",
              components: [{ type: "BODY", text: "Hi {{1}}" }],
              metaTemplateId: "meta-1",
            },
            telegram_data: { text: "Telegram promo" },
          },
        ],
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reuses a completed catalog for 30 seconds, then asks again", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    const params = { workspaceId: "cache-workspace" };
    await fetchWhatsAppTemplateCatalog(params);
    await fetchWhatsAppTemplateCatalog(params);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    now.mockReturnValue(31_001);
    await fetchWhatsAppTemplateCatalog(params);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("rereads a successful stale catalog after 30 seconds during a longer provider cooldown", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    const catalog = {
      source: "cache",
      stale: true,
      fetchedAt: new Date(0).toISOString(),
      wabaId: "waba",
      refreshOutcome: "cooldown",
      retryAt: new Date(3_601_000).toISOString(),
    };
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          templates: [{ name: "offer", language: "en", status: "APPROVED" }],
          catalog,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          templates: [{ name: "offer", language: "en", status: "REJECTED" }],
          catalog,
        })
      );
    const params = { workspaceId: "cooldown-snapshot" };
    await fetchWhatsAppTemplateCatalog(params);
    now.mockReturnValue(31_001);
    expect(
      (await fetchWhatsAppTemplateCatalog(params)).metaTemplates[0].status
    ).toBe("REJECTED");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/api/whatsapp/templates?workspaceId=cooldown-snapshot",
      { cache: "no-store" }
    );
  });

  it("rereads local fallback content after 30 seconds during a longer provider cooldown", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    const retryAt = new Date(3_601_000).toISOString();
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
            providerCode: 80008,
            retryAt,
          },
          429
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          templates: [{ name: "promo", language: "en", status: "REJECTED" }],
        })
      );
    const params = {
      workspaceId: "local-cooldown-snapshot",
      includeUnified: true,
      loadUnifiedTemplates: mockGetUnifiedTemplatesAction,
    };
    const fallback = await fetchWhatsAppTemplateCatalog(params);
    expect(fallback.selectionItems[0].status).toBe("APPROVED");
    expect(fallback.error?.retryAt).toBe(retryAt);
    now.mockReturnValue(31_001);
    expect(
      (await fetchWhatsAppTemplateCatalog(params)).selectionItems[0].status
    ).toBe("REJECTED");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith(
      "/api/whatsapp/templates?workspaceId=local-cooldown-snapshot",
      { cache: "no-store" }
    );
  });

  it("keeps completed catalogs isolated by source, status, and limit", async () => {
    await fetchWhatsAppTemplateCatalog({
      workspaceId: "scoped",
      sourceId: "a",
      status: "APPROVED",
      limit: 100,
    });
    await fetchWhatsAppTemplateCatalog({
      workspaceId: "scoped",
      sourceId: "b",
      status: "APPROVED",
      limit: 100,
    });
    await fetchWhatsAppTemplateCatalog({
      workspaceId: "scoped",
      sourceId: "a",
      status: "PENDING",
      limit: 100,
    });
    await fetchWhatsAppTemplateCatalog({
      workspaceId: "scoped",
      sourceId: "a",
      status: "APPROVED",
      limit: 300,
    });
    await fetchWhatsAppTemplateCatalog({
      workspaceId: "scoped",
      sourceId: "a",
      status: "APPROVED",
      limit: 100,
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("invalidates every catalog variant after a workspace mutation", async () => {
    const params = { workspaceId: "mutated", status: "APPROVED" as const };
    await fetchWhatsAppTemplateCatalog(params);
    invalidateWhatsAppTemplateCatalog("mutated");
    await fetchWhatsAppTemplateCatalog(params);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves local management templates when Meta throttles without claiming a current WABA match", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: "Meta is throttled",
          code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
          retryAt: "2026-10-06T13:00:00.000Z",
          providerCode: 80008,
        },
        429
      )
    );
    const result = await fetchWhatsAppTemplateCatalog({
      workspaceId: "fallback",
      includeUnified: true,
      loadUnifiedTemplates: mockGetUnifiedTemplatesAction,
    });
    expect(result.selectionItems).toEqual([
      expect.objectContaining({
        name: "promo",
        dbId: "db-1",
        canSwitchToCurrentWaba: false,
      }),
    ]);
    expect(result.selectionItems[0].isOnCurrentWaba).not.toBe(true);
    expect(result.metaTemplates).toEqual([]);
    expect(result.error).toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      status: 429,
      providerCode: 80008,
      retryAt: "2026-10-06T13:00:00.000Z",
    });
  });

  it("never substitutes local templates for a send catalog after Meta fails", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: "Meta is throttled",
          code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
          providerCode: 80008,
        },
        429
      )
    );
    await expect(
      fetchWhatsAppTemplateCatalog({
        workspaceId: "send-failed",
        includeUnified: false,
      })
    ).rejects.toMatchObject({
      status: 429,
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
    });
  });

  it("preserves stored management rows when the Meta request fails before receiving a response", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    const result = await fetchWhatsAppTemplateCatalog({
      workspaceId: "network-management",
      includeUnified: true,
      loadUnifiedTemplates: mockGetUnifiedTemplatesAction,
    });
    expect(result.selectionItems[0].name).toBe("promo");
    expect(result.error).toMatchObject({ status: 0 });
    await expect(
      fetchWhatsAppTemplateCatalog({
        workspaceId: "network-send",
        includeUnified: false,
      })
    ).rejects.toMatchObject({ status: 0 });
  });

  it("does not let an older normal load overwrite a forced refresh", async () => {
    let resolveOld!: (response: Response) => void;
    mockFetch
      .mockReturnValueOnce(
        new Promise<Response>(resolve => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          templates: [
            {
              id: "new",
              name: "new_offer",
              language: "en",
              status: "APPROVED",
            },
          ],
        })
      );
    const params = { workspaceId: "forced-race" };
    const oldLoad = fetchWhatsAppTemplateCatalog(params);
    await fetchWhatsAppTemplateCatalog({ ...params, force: true });
    resolveOld(
      jsonResponse({
        templates: [
          { id: "old", name: "old_offer", language: "en", status: "APPROVED" },
        ],
      })
    );
    await oldLoad;
    expect(
      (await fetchWhatsAppTemplateCatalog(params)).metaTemplates[0].id
    ).toBe("new");
  });

  it.each([
    "WHATSAPP_TEMPLATES_RATE_LIMITED",
    "WHATSAPP_TEMPLATES_UNAVAILABLE",
    "WHATSAPP_TEMPLATES_INCOMPLETE",
  ])("does not automatically retry %s", async code => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: "Wait before refreshing",
          code,
          retryAt: "2026-10-06T13:00:00.000Z",
        },
        503
      )
    );
    const error = await fetchWhatsAppTemplateCatalog({
      workspaceId: code,
    }).catch(error => error);
    expect(shouldRetryWhatsAppTemplateCatalogError(error)).toBe(false);
  });

  it("allows bounded retry for an unrelated transient server error", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: "Temporary server failure" }, 500)
    );
    const error = await fetchWhatsAppTemplateCatalog({
      workspaceId: "transient",
    }).catch(error => error);
    expect(shouldRetryWhatsAppTemplateCatalogError(error)).toBe(true);
  });

  it("merges live Meta templates with unified records when requested", async () => {
    const result = await fetchWhatsAppTemplateCatalog({
      workspaceId: "workspace-1",
      includeUnified: true,
      loadUnifiedTemplates: mockGetUnifiedTemplatesAction,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/whatsapp/templates?workspaceId=workspace-1",
      { cache: "no-store" }
    );
    expect(mockGetUnifiedTemplatesAction).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(result.requiresWhatsAppConnection).toBe(false);
    expect(result.metaTemplates).toHaveLength(1);
    expect(result.unifiedTemplates).toHaveLength(1);
    expect(result.selectionItems).toEqual([
      expect.objectContaining({
        id: "meta-1",
        dbId: "db-1",
        metaId: "meta-1",
        channel: "both",
        name: "promo",
        language: "en",
        isOnCurrentWaba: true,
        canSwitchToCurrentWaba: false,
      }),
    ]);
  });

  it("flags local WhatsApp templates missing from the connected WABA as switchable", async () => {
    mockGetUnifiedTemplatesAction.mockResolvedValue({
      success: true,
      data: {
        templates: [
          {
            id: "db-old",
            workspace_id: "workspace-acme",
            name: "welcome_old",
            channel: "whatsapp",
            created_at: "2026-02-01T00:00:00.000Z",
            whatsapp_data: {
              language: "en",
              category: "UTILITY",
              status: "PENDING",
              components: [{ type: "BODY", text: "Welcome" }],
            },
          },
        ],
      },
    });

    const result = await fetchWhatsAppTemplateCatalog({
      workspaceId: "workspace-acme",
      includeUnified: true,
      loadUnifiedTemplates: mockGetUnifiedTemplatesAction,
    });

    expect(result.selectionItems).toEqual([
      expect.objectContaining({
        id: "meta-1",
        name: "promo",
        isOnCurrentWaba: true,
        canSwitchToCurrentWaba: false,
      }),
      expect.objectContaining({
        id: "db-old",
        name: "welcome_old",
        sourceWabaId: "waba-previous",
        isOnCurrentWaba: false,
        canSwitchToCurrentWaba: true,
      }),
    ]);
  });

  it("loads approved live-only template catalogs for send pickers", async () => {
    jest.spyOn(Date, "now").mockReturnValue(123456);

    const result = await fetchWhatsAppTemplateCatalog({
      workspaceId: "workspace-1",
      status: "APPROVED",
      limit: 300,
      force: true,
      includeUnified: false,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/whatsapp/templates?workspaceId=workspace-1&status=APPROVED&limit=300&_refresh=123456",
      { cache: "no-store" }
    );
    expect(mockGetUnifiedTemplatesAction).not.toHaveBeenCalled();
    expect(result.unifiedTemplates).toEqual([]);
    expect(result.selectionItems).toEqual([
      expect.objectContaining({
        id: "meta-1",
        metaId: "meta-1",
        channel: "whatsapp",
        name: "promo",
      }),
    ]);
  });
});

export {};
