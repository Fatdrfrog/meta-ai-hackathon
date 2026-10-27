const mockFetchWhatsAppFlowsList = jest.fn();

jest.mock("@/lib/whatsapp/flows/client", () => ({
  fetchWhatsAppFlowDetails: jest.fn(),
  fetchWhatsAppFlowsList: (...args: unknown[]) =>
    mockFetchWhatsAppFlowsList(...args),
}));

import {
  createScenarioAnswerSnippet,
  fetchScenarioAudienceOptions,
  fetchScenarioWhatsAppFlows,
  fetchScenarioWhatsAppTemplates,
  fetchWhatsAppServiceMessageResources,
  loadScenarioAudienceOptions,
  loadScenarioContextOptions,
  readCachedScenarioAudienceOptions,
  readCachedScenarioContextOptions,
} from "./resources";
import { SCENARIO_WORKSPACE_OPTIONS_TTL_MS } from "./workspace-options-cache";

describe("workspace options reused between Scenarios visits", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("shows fresh audience options at once and still asks again on every visit", async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ options: { channels: ["whatsapp"] } }))
      )
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ options: { channels: ["whatsapp", "telegram"] } })
          )
      );
    global.fetch = fetchMock as typeof fetch;

    expect(readCachedScenarioAudienceOptions("cache-1")).toBeNull();
    const [first, second] = await Promise.all([
      loadScenarioAudienceOptions("cache-1"),
      loadScenarioAudienceOptions("cache-1"),
    ]);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.channels).toEqual(["whatsapp"]);
    expect(readCachedScenarioAudienceOptions("cache-1")).toBe(first);

    // A later visit shows the stored answer while it asks again, so an
    // audience made elsewhere in the meantime still appears.
    const next = await loadScenarioAudienceOptions("cache-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(next.channels).toEqual(["whatsapp", "telegram"]);
    expect(readCachedScenarioAudienceOptions("cache-1")).toBe(next);

    jest.setSystemTime(Date.now() + SCENARIO_WORKSPACE_OPTIONS_TTL_MS);
    expect(readCachedScenarioAudienceOptions("cache-1")).toBeNull();
  });

  it("never keeps a failed answer", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ options: [{ id: "faq" }] }))
      );
    global.fetch = fetchMock as typeof fetch;

    await expect(loadScenarioContextOptions("cache-2")).resolves.toEqual([]);
    expect(readCachedScenarioContextOptions("cache-2")).toBeNull();
    await expect(loadScenarioContextOptions("cache-2")).resolves.toEqual([
      { id: "faq" },
    ]);
    expect(readCachedScenarioContextOptions("cache-2")).toEqual([
      { id: "faq" },
    ]);
  });

  it("reads context options again after an answer snippet is added", async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ options: [{ id: "faq" }] }))
    ) as typeof fetch;
    await loadScenarioContextOptions("cache-3");
    expect(readCachedScenarioContextOptions("cache-3")).not.toBeNull();

    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ items: [{ id: "s" }], upserted: 1 }))
    ) as typeof fetch;
    await createScenarioAnswerSnippet({
      workspaceId: "cache-3",
      question: "Q",
      answer: "A",
    });
    expect(readCachedScenarioContextOptions("cache-3")).toBeNull();
  });
});

describe("scenario audience catalog status", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("preserves partial status alongside usable campaign options", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          options: {
            metaReferralCampaigns: [
              { id: "campaign:1", campaignId: "1", label: "Available" },
            ],
            metaAdsDataStatus: { state: "partial", reasons: ["limit_reached"] },
          },
        })
      )
    );
    const result = await fetchScenarioAudienceOptions("workspace-1");
    expect(result.metaReferralCampaigns).toHaveLength(1);
    expect(result.metaAdsDataStatus).toEqual({
      state: "partial",
      reasons: ["limit_reached"],
    });
  });
});

describe("fetchScenarioWhatsAppTemplates source selection", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it("forwards the source and lets a guided form display catalog failures", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Provider unavailable" }), {
        status: 503,
      })
    );
    await expect(
      fetchScenarioWhatsAppTemplates("workspace-1", {
        sourceId: "source-2",
        throwOnError: true,
      })
    ).rejects.toThrow("Provider unavailable");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("sourceId=source-2"),
      expect.any(Object)
    );
    await expect(
      fetchScenarioWhatsAppTemplates("workspace-1")
    ).resolves.toEqual([]);
  });
});

describe("fetchScenarioWhatsAppFlows", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the authorized WhatsApp source on every provider Flow option", async () => {
    mockFetchWhatsAppFlowsList.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        sourceId: "source-1",
        flows: [{ id: "flow-1", name: "Provider Flow", status: "PUBLISHED" }],
      },
    });

    await expect(fetchScenarioWhatsAppFlows("workspace-1")).resolves.toEqual([
      {
        id: "flow-1",
        name: "Provider Flow",
        status: "PUBLISHED",
        sourceId: "source-1",
      },
    ]);
  });

  it("loads provider Flows from every connected WhatsApp source", async () => {
    mockFetchWhatsAppFlowsList.mockImplementation(
      async ({ sourceId }: { sourceId?: string }) => ({
        ok: true,
        status: 200,
        data: {
          sourceId,
          flows: [
            {
              id: `flow-${sourceId}`,
              name: `Flow for ${sourceId}`,
              status: "PUBLISHED",
            },
          ],
        },
      })
    );

    await expect(
      fetchScenarioWhatsAppFlows("workspace-1", {
        sourceIds: ["source-1", "source-2", "source-1", ""],
      })
    ).resolves.toEqual([
      {
        id: "flow-source-1",
        name: "Flow for source-1",
        status: "PUBLISHED",
        sourceId: "source-1",
      },
      {
        id: "flow-source-2",
        name: "Flow for source-2",
        status: "PUBLISHED",
        sourceId: "source-2",
      },
    ]);
    expect(mockFetchWhatsAppFlowsList).toHaveBeenCalledTimes(2);
    expect(mockFetchWhatsAppFlowsList).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      limit: 200,
      force: undefined,
    });
    expect(mockFetchWhatsAppFlowsList).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      sourceId: "source-2",
      limit: 200,
      force: undefined,
    });
  });
});

describe("fetchWhatsAppServiceMessageResources", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("reports failed resource requests instead of swallowing them", async () => {
    const onRequestError = jest.fn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "nope" }, 500));

    await expect(
      fetchWhatsAppServiceMessageResources({
        workspaceId: "workspace-1",
        loadSignupLinks: true,
        loadCalling: false,
        loadCatalog: false,
        onRequestError,
      })
    ).resolves.toEqual({
      signupLinks: [],
      catalogs: [],
      products: [],
      callingReady: false,
    });
    expect(onRequestError).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/api/whatsapp/signups"),
        error: expect.any(Error),
      })
    );
  });

  it("clears products when the catalog route falls back to a different catalog id", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        catalogs: [{ id: "catalog-other", name: "Other" }],
        products: [{ id: "p1", catalog_id: "catalog-other", name: "Widget" }],
        selectedCatalog: { id: "catalog-other", name: "Other" },
      })
    );

    await expect(
      fetchWhatsAppServiceMessageResources({
        workspaceId: "workspace-1",
        loadSignupLinks: false,
        loadCalling: false,
        loadCatalog: true,
        catalogId: "catalog-saved",
      })
    ).resolves.toEqual({
      signupLinks: [],
      catalogs: [{ id: "catalog-other", name: "Other" }],
      products: [],
      callingReady: false,
    });
  });
});
