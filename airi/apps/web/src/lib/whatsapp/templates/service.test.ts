const mockCreateClient = jest.fn();
const mockSourceQueryEq = jest.fn();
const mockTemplateLoggerWarn = jest.fn();
const mockMirrorTemplatesToUnifiedRows = jest.fn();
const mockUpsertTemplateSnapshot = jest.fn();
const mockDeleteManySnapshots = jest.fn();
const mockCredentialUpdate = jest.fn();
const mockDnsLookup = jest.fn();
const mockCatalogStore = new Map<string, unknown>();
const mockCatalogLocks = new Map<string, string>();
let mockCatalogCoordinationUnavailable = false;
let mockWorkspaceSources: Array<{
  id: string;
  credentials: Record<string, unknown>;
}> = [];

jest.mock("@icecore/shared/lib/cache", () => ({
  ...jest.requireActual("@icecore/shared/lib/cache"),
  cache: {
    get: jest.fn(async (key: string) => mockCatalogStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      mockCatalogStore.set(key, value);
    }),
    del: jest.fn(async (key: string) => mockCatalogStore.delete(key)),
    readWithStatus: jest.fn(async (key: string) =>
      mockCatalogStore.has(key)
        ? { status: "hit", value: mockCatalogStore.get(key) }
        : { status: "miss" }
    ),
    writeWithStatus: jest.fn(async (key: string, value: unknown) => {
      if (mockCatalogCoordinationUnavailable) return "unavailable";
      mockCatalogStore.set(key, value);
      return "stored";
    }),
    acquireLock: jest.fn(async (key: string, value: string) => {
      if (mockCatalogCoordinationUnavailable) return "unavailable";
      if (mockCatalogLocks.has(key)) return "contended";
      mockCatalogLocks.set(key, value);
      return "acquired";
    }),
    compareAndDelete: jest.fn(async (key: string, value: string) => {
      if (mockCatalogLocks.get(key) !== value) return false;
      return mockCatalogLocks.delete(key);
    }),
    publishIfLockOwned: jest.fn(
      async (input: {
        lockKey: string;
        ownerToken: string;
        valueKey: string;
        value: unknown;
      }) => {
        if (mockCatalogCoordinationUnavailable) return "unavailable";
        if (mockCatalogLocks.get(input.lockKey) !== input.ownerToken)
          return "lost";
        mockCatalogStore.set(input.valueKey, input.value);
        mockCatalogLocks.delete(input.lockKey);
        return "published";
      }
    ),
  },
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockCredentialUpdate(...args),
}));

// Header media URLs pass the crawler's SSRF check, which resolves the host.
jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

export {};

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

// CI runs Jest without MONGODB_URI, which @/lib/mongoose requires at import.
jest.mock("@/lib/mongoose", () => ({
  connectDB: jest.fn(),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: mockTemplateLoggerWarn,
  }),
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateAuditLog: {
    create: jest.fn(),
  },
  WhatsAppTemplateModel: {
    deleteMany: (...args: unknown[]) => mockDeleteManySnapshots(...args),
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
  },
}));

jest.mock("@/lib/mongoose", () => ({
  connectDB: jest.fn(async () => undefined),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { name: "supabase-admin" },
}));

jest.mock("@/lib/whatsapp/templates/template-mirror", () => ({
  ...jest.requireActual("@/lib/whatsapp/templates/template-mirror"),
  mirrorWhatsAppTemplatesToUnifiedRows: (...args: unknown[]) =>
    mockMirrorTemplatesToUnifiedRows(...args),
  upsertTemplateSnapshot: (...args: unknown[]) =>
    mockUpsertTemplateSnapshot(...args),
}));

function mockSourceCredentials(
  credentials: Record<string, unknown> = {
    waba_id: "waba-1",
    access_token: "access-token-1",
  },
  sourceId = "source-1",
  available = true
) {
  mockWorkspaceSources = available ? [{ id: sourceId, credentials }] : [];
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: available
        ? {
            id: sourceId,
            credentials,
          }
        : null,
    }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: mockWorkspaceSources, error: null }).then(
        resolve
      ),
  };
  query.select.mockReturnValue(query);
  query.eq.mockImplementation((...args: unknown[]) => {
    mockSourceQueryEq(...args);
    return query;
  });
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);

  mockCreateClient.mockResolvedValue({
    from: jest.fn().mockReturnValue(query),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("WhatsApp template service", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockCatalogStore.clear();
    mockCatalogLocks.clear();
    mockCatalogCoordinationUnavailable = false;
    mockCredentialUpdate.mockResolvedValue({ credentials: {} });
    mockDnsLookup.mockReset();
    mockDnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    delete process.env.META_APP_ID;
    delete process.env.NEXT_PUBLIC_META_APP_ID;
    delete process.env.WHATSAPP_TEMPLATE_OPTIMIZATION_SPEC_READ_ENABLED;
    mockSourceCredentials();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const approved = {
    id: "approved-1",
    name: "welcome",
    language: "en",
    status: "APPROVED" as const,
  };
  const pending = {
    id: "pending-1",
    name: "pending",
    language: "en",
    status: "PENDING" as const,
  };
  const verifiedAccountOptions = {
    accountContext: {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      accessToken: "access-token-1",
      candidateSource: "credentials.waba_id" as const,
    },
  };

  it("does not patch a catalog from a direct ID read without a verified account context", async () => {
    const unrelated = { ...pending, id: "unrelated-1" };
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(jsonResponse(unrelated));
    const { listTemplates, getTemplate } = await import("./service");
    await listTemplates("workspace-1");
    expect(await getTemplate("workspace-1", unrelated.id)).toEqual(unrelated);
    expect((await listTemplates("workspace-1")).templates).toEqual([approved]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidates the resolved fallback WABA after a default direct update", async () => {
    mockSourceCredentials({
      waba_id: "inaccessible-waba",
      messaging_account_id: "fallback-waba",
      access_token: "token",
    });
    const inaccessible = () =>
      jsonResponse(
        {
          error: {
            message:
              "Unsupported get request. Object cannot be loaded due to missing permissions",
            type: "GraphMethodException",
            code: 100,
          },
        },
        400
      );
    mockFetch
      .mockResolvedValueOnce(inaccessible())
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(inaccessible())
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { listTemplates, updateTemplate } = await import("./service");
    const initial = await listTemplates("workspace-1");
    expect(initial.catalog.wabaId).toBe("fallback-waba");
    await expect(
      updateTemplate("workspace-1", approved.id, { category: "MARKETING" })
    ).resolves.toMatchObject({ success: true });
    const after = await listTemplates("workspace-1");
    expect(after.catalog.wabaId).toBe("fallback-waba");
    expect(after.templates).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("persists a canonical fallback readback cooldown against its original source binding without exposing credentials", async () => {
    mockSourceCredentials({
      waba_id: "inaccessible-waba",
      messaging_account_id: "fallback-waba",
      access_token: "private-source-token",
    });
    mockCredentialUpdate.mockImplementationOnce(
      async (input: {
        expectedWabaId: string;
        buildCredentials: (
          current: Record<string, unknown>
        ) => Record<string, unknown>;
      }) => {
        if (input.expectedWabaId !== "inaccessible-waba")
          throw new Error("Source binding changed");
        const credentials = input.buildCredentials(
          mockWorkspaceSources[0].credentials
        );
        mockSourceCredentials(credentials);
        return { credentials };
      }
    );
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Unsupported get request due to missing permissions",
              code: 100,
            },
          },
          400
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "new-template", status: "PENDING" })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Too many calls",
              type: "OAuthException",
              code: 80008,
            },
          },
          400
        )
      );
    const { createWhatsAppTemplateMutation } = await import(
      "./mutation-service"
    );
    const result = await createWhatsAppTemplateMutation({
      workspaceId: "workspace-1",
      name: "new_template",
      language: "en",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Hello" }],
      audit: { enabled: false },
    });
    expect(result).toEqual({
      id: "new-template",
      status: "PENDING",
      warning: undefined,
    });
    expect(JSON.stringify(result)).not.toContain("private-source-token");
    expect(mockCredentialUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        expectedWabaId: "inaccessible-waba",
      })
    );
    const retryAt =
      mockWorkspaceSources[0].credentials.meta_diagnostics_cooldown_until;
    expect(retryAt).toEqual(expect.any(String));
    const { getCachedWhatsAppMetaReadCooldownUntil } = await import(
      "../meta-read-policy"
    );
    expect(await getCachedWhatsAppMetaReadCooldownUntil("fallback-waba")).toBe(
      retryAt
    );
    expect(
      await getCachedWhatsAppMetaReadCooldownUntil("inaccessible-waba")
    ).toBeNull();
    mockCatalogStore.clear();
    const { getTemplate } = await import("./service");
    await expect(
      getTemplate("workspace-1", "new-template")
    ).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt,
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("shares a complete catalog across filtered and limited readers after checking source access", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: [pending],
          paging: { next: "https://graph.facebook.com/page-2" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }));
    const { listTemplates } = await import("./service");
    const filtered = await listTemplates("workspace-1", {
      status: "APPROVED",
      limit: 1,
    });
    const all = await listTemplates("workspace-1");
    expect(filtered.templates).toEqual([approved]);
    expect(all.templates).toEqual([pending, approved]);
    expect(all.catalog).toMatchObject({
      source: "cache",
      stale: false,
      wabaId: "waba-1",
      refreshOutcome: "fresh",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).not.toContain("status=");
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("preserves Meta 80008 and suppresses repeated cold reads during the shared cooldown", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "Too many calls",
            type: "OAuthException",
            code: 80008,
          },
        },
        400
      )
    );
    const { listTemplates } = await import("./service");
    const first = await listTemplates("workspace-1").catch(error => error);
    expect(first).toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      status: 429,
      providerCode: 80008,
      providerStatus: 400,
      retryAt: expect.any(String),
    });
    const second = await listTemplates("workspace-1", { force: true }).catch(
      error => error
    );
    expect(second).toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt: first.retryAt,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockCredentialUpdate).toHaveBeenCalledTimes(1);
  });

  it("honors persisted cooldown on a cold catalog without calling Meta", async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    mockSourceCredentials({
      waba_id: "waba-1",
      access_token: "token",
      meta_diagnostics_cooldown_until: retryAt,
      meta_diagnostics_last_error_code: "80008",
    });
    const { listTemplates } = await import("./service");
    await expect(
      listTemplates("workspace-1", { force: true })
    ).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps verified statuses visible when a stale catalog refresh is rate limited", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved, pending] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Too many calls",
              type: "OAuthException",
              code: 80008,
            },
          },
          400
        )
      );
    const { listTemplates } = await import("./service");
    await listTemplates("workspace-1");
    jest.setSystemTime(new Date("2026-10-06T10:16:00Z"));
    const stale = await listTemplates("workspace-1");
    expect(stale.templates).toEqual([approved, pending]);
    expect(stale.catalog).toMatchObject({
      source: "cache",
      stale: true,
      fetchedAt: "2026-10-06T10:00:00.000Z",
      refreshOutcome: "rate_limited",
      providerCode: 80008,
      retryAt: expect.any(String),
    });
    const cooldown = await listTemplates("workspace-1", { force: true });
    expect(cooldown.catalog.refreshOutcome).toBe("cooldown");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent readers and returns the published catalog to the waiter", async () => {
    let finish!: (value: Response) => void;
    const response = new Promise<Response>(resolve => {
      finish = resolve;
    });
    mockFetch.mockReturnValue(response);
    const { listTemplates } = await import("./service");
    const first = listTemplates("workspace-1");
    const second = listTemplates("workspace-1");
    await new Promise(resolve => setTimeout(resolve, 20));
    finish(jsonResponse({ data: [approved] }));
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.templates)).toEqual([
      [approved],
      [approved],
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on unavailable coordination and serves a verified snapshot when available", async () => {
    const { listTemplates } = await import("./service");
    mockCatalogCoordinationUnavailable = true;
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      status: 503,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    mockCatalogCoordinationUnavailable = false;
    mockFetch.mockResolvedValue(jsonResponse({ data: [approved] }));
    await listTemplates("workspace-1");
    mockCatalogCoordinationUnavailable = true;
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.now() + 16 * 60_000));
    const cached = await listTemplates("workspace-1");
    expect(cached.templates).toEqual([approved]);
    expect(cached.catalog).toMatchObject({
      source: "cache",
      stale: true,
      refreshOutcome: "coordination_unavailable",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete pagination without caching the partial list", async () => {
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        data: [approved],
        paging: { next: "https://graph.facebook.com/repeated-page" },
      })
    );
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_INCOMPLETE",
      status: 502,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(
      [...mockCatalogStore.values()].some(value =>
        Array.isArray((value as { templates?: unknown[] })?.templates)
      )
    ).toBe(false);
  });

  it("spaces force refreshes and never serves a snapshot after a successful edit", async () => {
    const changed = { ...approved, status: "PENDING" as const };
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse(changed));
    const { listTemplates, updateTemplate, getTemplate } = await import(
      "./service"
    );
    await listTemplates("workspace-1");
    const spaced = await listTemplates("workspace-1", { force: true });
    expect(spaced.catalog.refreshOutcome).toBe("minimum_interval");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await updateTemplate(
      "workspace-1",
      "approved-1",
      {
        category: "MARKETING",
      },
      verifiedAccountOptions
    );
    const updated = await listTemplates("workspace-1");
    expect(updated.templates).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await getTemplate("workspace-1", "approved-1", verifiedAccountOptions);
    const readback = await listTemplates("workspace-1");
    expect(readback.templates).toEqual([changed]);
    expect(readback.catalog.stale).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("isolates workspace, source and current WABA snapshots", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(jsonResponse({ data: [pending] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const { listTemplates } = await import("./service");
    await listTemplates("workspace-1");
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.now() + 61_000));
    await listTemplates("workspace-2");
    mockSourceCredentials({ waba_id: "waba-2", access_token: "token" });
    const rebound = await listTemplates("workspace-1");
    expect(rebound.templates).toEqual([]);
    expect(rebound.catalog.wabaId).toBe("waba-2");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects an old in-flight catalog after a successful mutation", async () => {
    let finish!: (value: Response) => void;
    mockFetch.mockImplementation((_url: string, request?: RequestInit) =>
      request?.method === "POST"
        ? Promise.resolve(jsonResponse({ success: true }))
        : new Promise<Response>(resolve => {
            finish = resolve;
          })
    );
    const { listTemplates, updateTemplate } = await import("./service");
    const old = listTemplates("workspace-1").catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 20));
    await updateTemplate(
      "workspace-1",
      "approved-1",
      {
        category: "MARKETING",
      },
      verifiedAccountOptions
    );
    finish(jsonResponse({ data: [approved] }));
    expect(await old).toMatchObject({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      status: 503,
    });
  });

  it("does not publish a loaded catalog when its shared lock is lost", async () => {
    const { cache } = await import("@icecore/shared/lib/cache");
    (cache.publishIfLockOwned as jest.Mock).mockResolvedValueOnce("lost");
    mockFetch.mockResolvedValue(jsonResponse({ data: [approved] }));
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      status: 503,
    });
    expect(
      [...mockCatalogStore.values()].some(value =>
        Array.isArray((value as { value?: unknown[] })?.value)
      )
    ).toBe(false);
  });

  it("waits for a new forced publication instead of returning the previous fresh snapshot", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [approved] }));
    const { listTemplates } = await import("./service");
    await listTemplates("workspace-1");
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.now() + 61_000));
    let finish!: (value: Response) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          finish = resolve;
        })
    );
    const owner = listTemplates("workspace-1", { force: true });
    await jest.advanceTimersByTimeAsync(1);
    const waiter = listTemplates("workspace-1", { force: true });
    await jest.advanceTimersByTimeAsync(20);
    finish(jsonResponse({ data: [pending] }));
    await jest.advanceTimersByTimeAsync(100);
    expect((await owner).templates).toEqual([pending]);
    expect((await waiter).templates).toEqual([pending]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("never prunes or mirrors stored templates from a rate-limited sync snapshot", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Too many calls",
              type: "OAuthException",
              code: 80008,
            },
          },
          400
        )
      );
    const { listTemplates, syncTemplatesToMongo } = await import("./service");
    await listTemplates("workspace-1");
    jest.setSystemTime(new Date("2026-10-06T10:16:00Z"));
    const result = await syncTemplatesToMongo("workspace-1", "user-1");
    expect(result).toMatchObject({
      synced: 0,
      errors: 0,
      templates: [approved],
      catalog: { stale: true, refreshOutcome: "rate_limited" },
    });
    expect(mockDeleteManySnapshots).not.toHaveBeenCalled();
    expect(mockMirrorTemplatesToUnifiedRows).not.toHaveBeenCalled();
  });

  it("rejects malformed successful Graph responses instead of making an empty authoritative catalog", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ unexpected: true }));
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_INCOMPLETE",
    });
  });

  it("protects pre-WABA discovery with persisted cooldown and stops on discovery rate limits", async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    mockSourceCredentials({
      business_id: "business-1",
      access_token: "token",
      meta_diagnostics_cooldown_until: retryAt,
    });
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    mockSourceCredentials({ business_id: "business-1", access_token: "token" });
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "Too many calls",
            type: "OAuthException",
            code: 80008,
          },
        },
        400
      )
    );
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      providerCode: 80008,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("spaces a second cold source on the same WABA for only sixty seconds", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    mockFetch.mockImplementation(async () =>
      jsonResponse({ data: [approved] })
    );
    const { listTemplates } = await import("./service");
    await listTemplates("workspace-1");
    mockSourceCredentials(
      { waba_id: "waba-1", access_token: "token" },
      "source-2"
    );
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      retryAt: "2026-10-06T10:01:00.000Z",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date("2026-10-06T10:01:01Z"));
    await expect(listTemplates("workspace-1")).resolves.toMatchObject({
      templates: [approved],
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts provider mutations before POST or DELETE when the cache barrier cannot be established", async () => {
    mockCatalogCoordinationUnavailable = true;
    mockFetch.mockImplementation(async () => jsonResponse({ data: [] }));
    const { createTemplate, updateTemplate, deleteTemplate } = await import(
      "./service"
    );
    const context = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      accessToken: "token",
      candidateSource: "credentials.waba_id" as const,
    };
    await expect(
      createTemplate(
        "workspace-1",
        {
          name: "welcome",
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hi" }],
        },
        { accountContext: context }
      )
    ).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATES_UNAVAILABLE" });
    await expect(
      updateTemplate(
        "workspace-1",
        "approved-1",
        { category: "MARKETING" },
        verifiedAccountOptions
      )
    ).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATES_UNAVAILABLE" });
    await expect(
      deleteTemplate("workspace-1", {
        templateName: "welcome",
        templateId: "approved-1",
      })
    ).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATES_UNAVAILABLE" });
    expect(
      mockFetch.mock.calls.some(([, request]) =>
        ["POST", "DELETE"].includes(request?.method)
      )
    ).toBe(false);
  });

  it("patches successful create and delete without fetching again or losing the original success time", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "created-1", status: "PENDING" })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { listTemplates, createTemplate, deleteTemplate } = await import(
      "./service"
    );
    const original = await listTemplates("workspace-1");
    const context = {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      accessToken: "token",
      candidateSource: "credentials.waba_id" as const,
    };
    await createTemplate(
      "workspace-1",
      {
        name: "created",
        language: "en",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hi" }],
      },
      { accountContext: context }
    );
    const created = await listTemplates("workspace-1");
    expect(created.templates).toEqual([
      approved,
      expect.objectContaining({ id: "created-1", status: "PENDING" }),
    ]);
    expect(created.catalog.fetchedAt).toBe(original.catalog.fetchedAt);
    await deleteTemplate("workspace-1", {
      templateName: "welcome",
      templateId: "approved-1",
    });
    const deleted = await listTemplates("workspace-1");
    expect(deleted.templates.map(template => template.id)).toEqual([
      "created-1",
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("never resurrects the initial generation when a later mutation barrier write fails", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { listTemplates, deleteTemplate, updateTemplate } = await import(
      "./service"
    );
    await listTemplates("workspace-1");
    await deleteTemplate("workspace-1", {
      templateName: "welcome",
      templateId: "approved-1",
    });
    const { cache } = await import("@icecore/shared/lib/cache");
    (cache.writeWithStatus as jest.Mock).mockResolvedValueOnce("unavailable");
    await expect(
      updateTemplate(
        "workspace-1",
        "approved-1",
        { category: "MARKETING" },
        verifiedAccountOptions
      )
    ).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATES_UNAVAILABLE" });
    expect((await listTemplates("workspace-1")).templates).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps all known source snapshots patched when a shared WABA changes", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { listTemplates, deleteTemplate } = await import("./service");
    await listTemplates("workspace-1");
    jest.setSystemTime(new Date("2026-10-06T10:01:01Z"));
    mockSourceCredentials(
      { waba_id: "waba-1", access_token: "token" },
      "source-2"
    );
    await listTemplates("workspace-1");
    await deleteTemplate("workspace-1", {
      templateName: "welcome",
      templateId: "approved-1",
    });
    mockSourceCredentials();
    expect((await listTemplates("workspace-1")).templates).toEqual([]);
    mockSourceCredentials(
      { waba_id: "waba-1", access_token: "token" },
      "source-2"
    );
    expect((await listTemplates("workspace-1")).templates).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("patches only existing webhook matches without making statuses or a catalog up", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [approved, pending] }));
    const { listTemplates } = await import("./service");
    const { patchWhatsAppTemplateCatalogState } = await import(
      "./catalog-cache"
    );
    const original = await listTemplates("workspace-1");
    await patchWhatsAppTemplateCatalogState({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      templateId: "approved-1",
      patch: current => ({ status: "PAUSED", category: current.category }),
    });
    const changed = await listTemplates("workspace-1");
    expect(changed.templates).toEqual([
      { ...approved, status: "PAUSED", category: undefined },
      pending,
    ]);
    expect(changed.catalog.fetchedAt).toBe(original.catalog.fetchedAt);
    await patchWhatsAppTemplateCatalogState({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      name: "pending",
      language: "en",
      remove: true,
      patch: {},
    });
    expect((await listTemplates("workspace-1")).templates).toEqual([
      { ...approved, status: "PAUSED", category: undefined },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("skips workspace-wide pruning for multiple WhatsApp source bindings", async () => {
    mockWorkspaceSources.push({
      id: "source-2",
      credentials: { waba_id: "waba-2" },
    });
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const { syncTemplatesToMongo } = await import("./service");
    await syncTemplatesToMongo("workspace-1", "user-1");
    expect(mockDeleteManySnapshots).not.toHaveBeenCalled();
  });

  it("accepts an authoritative empty single-WABA catalog for pruning", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const { syncTemplatesToMongo } = await import("./service");
    await syncTemplatesToMongo("workspace-1", "user-1");
    expect(mockDeleteManySnapshots).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
  });

  it("resets only the persisted consecutive rate-limit count after a verified successful catalog", async () => {
    const prior = {
      waba_id: "waba-1",
      access_token: "token",
      meta_diagnostics_consecutive_rate_limits: 2,
      meta_diagnostics_last_error_code: "80008",
      meta_diagnostics_last_success_at: "old",
      webhook_requires_reconnect: true,
    };
    mockSourceCredentials(prior);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const { listTemplates } = await import("./service");
    await listTemplates("workspace-1");
    const call = mockCredentialUpdate.mock.calls[0][0];
    expect(call.buildCredentials(prior)).toEqual({
      ...prior,
      meta_diagnostics_consecutive_rate_limits: 0,
      meta_diagnostics_last_error_code: null,
    });
    const active = {
      ...prior,
      meta_diagnostics_cooldown_until: new Date(
        Date.now() + 60_000
      ).toISOString(),
    };
    expect(call.buildCredentials(active)).toEqual(active);
  });

  it("preserves the prior verified rows when Meta rejects an edit or deletion", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Invalid category" } }, 400)
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Cannot delete" } }, 400)
      );
    const { listTemplates, updateTemplate, deleteTemplate } = await import(
      "./service"
    );
    await listTemplates("workspace-1");
    await expect(
      updateTemplate(
        "workspace-1",
        "approved-1",
        { category: "MARKETING" },
        verifiedAccountOptions
      )
    ).rejects.toThrow("Invalid category");
    expect((await listTemplates("workspace-1")).templates).toEqual([approved]);
    await expect(
      deleteTemplate("workspace-1", {
        templateName: "welcome",
        templateId: "approved-1",
      })
    ).rejects.toThrow("Cannot delete");
    const retained = await listTemplates("workspace-1");
    expect(retained.templates).toEqual([approved]);
    expect(retained.catalog.stale).toBe(true);
    expect(
      mockFetch.mock.calls.filter(([, request]) =>
        ["POST", "DELETE"].includes(request?.method)
      )
    ).toHaveLength(2);
  });

  it("does not adopt an old provider readback after a newer webhook status", async () => {
    let finish!: (value: Response) => void;
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            finish = resolve;
          })
      );
    const { listTemplates, getTemplate } = await import("./service");
    const { patchWhatsAppTemplateCatalogState } = await import(
      "./catalog-cache"
    );
    await listTemplates("workspace-1");
    const readback = getTemplate(
      "workspace-1",
      "approved-1",
      verifiedAccountOptions
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    await patchWhatsAppTemplateCatalogState({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      templateId: "approved-1",
      patch: { status: "PAUSED" },
    });
    finish(jsonResponse(approved));
    await readback;
    expect((await listTemplates("workspace-1")).templates).toEqual([
      { ...approved, status: "PAUSED" },
    ]);
  });

  it("rebases concurrent webhook patches for different templates under the WABA lock", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [approved, pending] }));
    const { listTemplates } = await import("./service");
    const { patchWhatsAppTemplateCatalogState } = await import(
      "./catalog-cache"
    );
    await listTemplates("workspace-1");
    await Promise.all([
      patchWhatsAppTemplateCatalogState({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        templateId: "approved-1",
        patch: { status: "PAUSED" },
      }),
      patchWhatsAppTemplateCatalogState({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        templateId: "pending-1",
        patch: { status: "APPROVED" },
      }),
    ]);
    expect((await listTemplates("workspace-1")).templates).toEqual([
      { ...approved, status: "PAUSED" },
      { ...pending, status: "APPROVED" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds waiting on an unfinished concurrent refresh without making another Meta call", async () => {
    jest.useFakeTimers();
    const { buildWhatsAppMetaReadLockKey } = await import(
      "../meta-read-policy"
    );
    mockCatalogLocks.set(
      buildWhatsAppMetaReadLockKey({ sourceId: "source-1", wabaId: "waba-1" }),
      "another-reader"
    );
    const { listTemplates } = await import("./service");
    const waiting = listTemplates("workspace-1").catch(error => error);
    await jest.advanceTimersByTimeAsync(1100);
    expect(await waiting).toMatchObject({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      status: 503,
      retryAt: expect.any(String),
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a catalog exceeding the pagination cap without using the first fifty pages", async () => {
    let page = 0;
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        data: [approved],
        paging: { next: "https://graph.facebook.com/page-" + ++page },
      })
    );
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_INCOMPLETE",
    });
    expect(mockFetch).toHaveBeenCalledTimes(50);
    expect(
      [...mockCatalogStore.values()].some(value =>
        Array.isArray((value as { value?: unknown[] })?.value)
      )
    ).toBe(false);
  });

  it("starts a new base cooldown after a successful read between rate limits", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    let current: Record<string, unknown> = {
      waba_id: "waba-1",
      access_token: "token",
    };
    mockSourceCredentials(current);
    mockCredentialUpdate.mockImplementation(async input => {
      current = input.buildCredentials(current);
      return { credentials: current };
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Too many calls",
              type: "OAuthException",
              code: 80008,
            },
          },
          400
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Too many calls",
              type: "OAuthException",
              code: 80008,
            },
          },
          400
        )
      );
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      retryAt: "2026-10-06T10:05:00.000Z",
    });
    jest.setSystemTime(new Date("2026-10-06T10:05:01Z"));
    mockSourceCredentials(current);
    await listTemplates("workspace-1");
    expect(current.meta_diagnostics_consecutive_rate_limits).toBe(0);
    jest.setSystemTime(new Date("2026-10-06T10:06:02Z"));
    mockSourceCredentials(current);
    const limited = await listTemplates("workspace-1", { force: true });
    expect(limited.catalog.retryAt).toBe("2026-10-06T10:11:02.000Z");
    expect(current.meta_diagnostics_consecutive_rate_limits).toBe(1);
  });

  it("rejects malformed paging metadata instead of caching an empty catalog", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ data: [], paging: "unexpected" })
    );
    const { listTemplates } = await import("./service");
    await expect(listTemplates("workspace-1")).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_INCOMPLETE",
    });
  });

  it("stores only scoped identities in the catalog registry, never source credentials or callbacks", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [approved] }));
    const { listTemplates } = await import("./service");
    await listTemplates("workspace-1");
    const registry = [...mockCatalogStore.entries()].find(([key]) =>
      key.includes("template-catalog-scopes")
    )?.[1];
    expect(registry).toEqual([
      { workspaceId: "workspace-1", sourceId: "source-1", wabaId: "waba-1" },
    ]);
    expect(JSON.stringify(registry)).not.toContain("access-token-1");
  });

  it("does not cache an old readback that began while the provider mutation was pending", async () => {
    let finishUpdate!: (value: Response) => void;
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [approved] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve => {
            finishUpdate = resolve;
          })
      )
      .mockResolvedValueOnce(jsonResponse(approved));
    const { listTemplates, updateTemplate, getTemplate } = await import(
      "./service"
    );
    await listTemplates("workspace-1");
    const updating = updateTemplate(
      "workspace-1",
      "approved-1",
      {
        category: "MARKETING",
      },
      verifiedAccountOptions
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    await getTemplate("workspace-1", "approved-1", verifiedAccountOptions);
    finishUpdate(jsonResponse({ success: true }));
    await updating;
    expect((await listTemplates("workspace-1")).templates).toEqual([]);
  });

  it("protects later reads after a single-template readback receives Meta 80008", async () => {
    mockCredentialUpdate.mockImplementationOnce(
      async (input: {
        buildCredentials: (
          current: Record<string, unknown>
        ) => Record<string, unknown>;
      }) => {
        const credentials = input.buildCredentials(
          mockWorkspaceSources[0].credentials
        );
        mockSourceCredentials(credentials);
        return { credentials };
      }
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            message: "Too many calls",
            type: "OAuthException",
            code: "80008",
          },
        },
        400
      )
    );
    const { getTemplate, listTemplates } = await import("./service");
    const readback = await getTemplate("workspace-1", "approved-1").catch(
      error => error
    );
    expect(readback).toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      status: 429,
      providerCode: 80008,
      providerStatus: 400,
      retryAt: expect.any(String),
    });
    await expect(
      listTemplates("workspace-1", { force: true })
    ).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt: readback.retryAt,
    });
    await expect(
      getTemplate("workspace-1", "approved-1")
    ).rejects.toMatchObject({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt: readback.retryAt,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      [...mockCatalogStore.keys()].some(key =>
        key.includes("meta-read-cooldown")
      )
    ).toBe(false);
  });

  it("does not request the beta optimization_spec field while listing templates", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const { listTemplates } = await import("./service");

    await listTemplates("workspace-1");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(decodeURIComponent(url)).not.toContain("optimization_spec");
    expect(mockSourceQueryEq).not.toHaveBeenCalledWith("id", expect.anything());
  });

  it("syncs Meta's templates into the cache and the stored rows", async () => {
    const live = {
      id: "2841845149518816",
      name: "demoshop_test",
      language: "kk",
      status: "APPROVED",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hi" }],
    };
    mockFetch.mockResolvedValue(jsonResponse({ data: [live] }));
    mockMirrorTemplatesToUnifiedRows.mockResolvedValue(1);
    const { syncTemplatesToMongo } = await import("./service");

    await expect(
      syncTemplatesToMongo("workspace-1", "user-1")
    ).resolves.toMatchObject({
      synced: 1,
      errors: 0,
      templates: [live],
      catalog: { stale: false, source: "live" },
    });
    expect(mockUpsertTemplateSnapshot).toHaveBeenCalledWith(
      "workspace-1",
      live
    );
    expect(mockMirrorTemplatesToUnifiedRows).toHaveBeenCalledWith({
      supabase: { name: "supabase-admin" },
      workspaceId: "workspace-1",
      templates: [live],
    });
  });

  it("counts a failed stored-row sync as an error without failing the sync", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "t-1",
            name: "promo",
            language: "en",
            status: "APPROVED",
            category: "MARKETING",
          },
        ],
      })
    );
    mockMirrorTemplatesToUnifiedRows.mockRejectedValue(new Error("db down"));
    const { syncTemplatesToMongo } = await import("./service");

    await expect(
      syncTemplatesToMongo("workspace-1", "user-1")
    ).resolves.toMatchObject({ synced: 1, errors: 1 });
  });

  it("lists templates from the exact requested source inside the workspace", async () => {
    mockSourceCredentials(
      {
        waba_id: "selected-waba",
        access_token: "selected-access-token",
      },
      "selected-source"
    );
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const { listTemplates } = await import("./service");

    await listTemplates("workspace-1", { sourceId: "selected-source" });

    expect(mockSourceQueryEq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-1"
    );
    expect(mockSourceQueryEq).toHaveBeenCalledWith("type", "whatsapp");
    expect(mockSourceQueryEq).toHaveBeenCalledWith("id", "selected-source");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(
      "selected-waba/message_templates"
    );
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer selected-access-token",
      }),
    });
  });

  it("fails closed when the exact requested source is unavailable", async () => {
    mockSourceCredentials(
      {
        waba_id: "other-waba",
        access_token: "other-access-token",
      },
      "missing-source",
      false
    );
    const { listTemplates } = await import("./service");

    await expect(
      listTemplates("workspace-1", { sourceId: "missing-source" })
    ).rejects.toThrow("WhatsApp credentials not found");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads the source with the caller's server client when there is no user session", async () => {
    mockSourceCredentials(
      {
        waba_id: "runtime-waba",
        access_token: "runtime-access-token",
      },
      "runtime-source"
    );
    const serverClient = await mockCreateClient();
    mockCreateClient.mockClear();
    // Outside a request the session client is anon, which cannot read sources.
    mockCreateClient.mockRejectedValue(new Error("no user session"));
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const { listTemplates } = await import("./service");

    await listTemplates("workspace-1", {
      status: "APPROVED",
      supabase: serverClient,
    });

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockSourceQueryEq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-1"
    );
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(
      "runtime-waba/message_templates"
    );
  });

  it("falls back to an accessible Business-owned WABA when the stored account id is not a template object", async () => {
    mockSourceCredentials({
      waba_id: "bad-account-id",
      business_id: "business-1",
      access_token: "access-token-1",
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message:
                "Unsupported get request. Object with ID 'bad-account-id' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
              type: "GraphMethodException",
              code: 100,
            },
          },
          400
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "good-waba-1", name: "Primary WABA" }],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "template-1",
              name: "welcome",
              language: "en_US",
              status: "APPROVED",
            },
          ],
        })
      );
    const { listTemplates } = await import("./service");

    const result = await listTemplates("workspace-1");

    expect(result.templates).toEqual([
      expect.objectContaining({
        id: "template-1",
        name: "welcome",
      }),
    ]);
    const cached = await listTemplates("workspace-1");
    expect(cached.templates).toEqual(result.templates);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const urls = mockFetch.mock.calls.map(call => String(call[0]));
    expect(urls[0]).toContain("bad-account-id/message_templates");
    expect(urls[1]).toContain("business-1/owned_whatsapp_business_accounts");
    expect(urls[2]).toContain("business-1/client_whatsapp_business_accounts");
    expect(urls[3]).toContain("good-waba-1/message_templates");
    expect(mockTemplateLoggerWarn).toHaveBeenCalledWith(
      "WhatsApp template account candidate failed",
      expect.objectContaining({
        workspaceId: "workspace-1",
        candidateSource: "credentials.waba_id",
        candidateId: "bad-account-id",
        graphCode: 100,
      })
    );
  });

  it("uses Business WABA discovery when credentials have no explicit WABA id", async () => {
    mockSourceCredentials({
      business_id: "business-1",
      access_token: "access-token-1",
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "good-waba-1", name: "Primary WABA" }],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const { listTemplates } = await import("./service");

    await listTemplates("workspace-1");

    const urls = mockFetch.mock.calls.map(call => String(call[0]));
    expect(urls[0]).toContain("business-1/owned_whatsapp_business_accounts");
    expect(urls[1]).toContain("business-1/client_whatsapp_business_accounts");
    expect(urls[2]).toContain("good-waba-1/message_templates");
  });

  it("returns an actionable template-account error instead of raw Graph object text", async () => {
    mockSourceCredentials({
      waba_id: "bad-account-id",
      access_token: "access-token-1",
    });
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message:
              "Unsupported get request. Object with ID 'bad-account-id' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
          },
        },
        400
      )
    );
    const { listTemplates } = await import("./service");

    await expect(listTemplates("workspace-1")).rejects.toThrow(
      "Cannot access WhatsApp message templates for this connection"
    );
    await expect(listTemplates("workspace-1")).rejects.not.toThrow(
      "Unsupported get request"
    );
  });

  it("retries template creation without optimization_spec when Meta rejects the beta allowlist", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message:
                "WhatsApp Business Account must be on allow list to access optimization_spec.",
            },
          },
          400
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({ id: "template-1", status: "PENDING" })
      );
    const { createTemplate } = await import("./service");

    const result = await createTemplate("workspace-1", {
      name: "promo_with_max_price",
      language: "en_US",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello" }],
      optimization_spec: {
        bid_amount: 2500,
        bid_strategy: "LOWEST_COST_WITH_BID_CAP",
      },
    });

    const firstBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)
    );
    const secondBody = JSON.parse(
      String((mockFetch.mock.calls[2]?.[1] as RequestInit).body)
    );
    expect(firstBody).toHaveProperty("optimization_spec");
    expect(secondBody).not.toHaveProperty("optimization_spec");
    expect(result).toMatchObject({
      id: "template-1",
      status: "PENDING",
      warning: expect.stringContaining("without Marketing Messages max price"),
    });
    expect(mockTemplateLoggerWarn).toHaveBeenCalledWith(
      "Retrying WhatsApp template create without optimization_spec",
      expect.objectContaining({
        workspaceId: "workspace-1",
        templateName: "promo_with_max_price",
      })
    );
  });

  it("posts Meta's preset authentication definition without custom text or examples", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "auth-template-1", status: "PENDING" })
      );
    const { createTemplate } = await import("./service");
    const components = [
      { type: "BODY" as const, add_security_recommendation: true },
      { type: "FOOTER" as const, code_expiration_minutes: 5 },
      {
        type: "BUTTONS" as const,
        buttons: [{ type: "OTP" as const, otp_type: "COPY_CODE" as const }],
      },
    ];
    await createTemplate("workspace-1", {
      name: "verification_code",
      language: "kk",
      category: "AUTHENTICATION",
      components,
    });
    const post = mockFetch.mock.calls.find(call => call[1]?.method === "POST");
    expect(JSON.parse(String(post?.[1].body))).toEqual({
      name: "verification_code",
      language: "kk",
      category: "AUTHENTICATION",
      components,
    });
  });

  it("rejects authentication custom text and wrong categories before contacting Meta", async () => {
    const { createTemplate } = await import("./service");
    for (const category of [
      "AUTHENTICATION",
      "UTILITY",
      "MARKETING",
    ] as const) {
      await expect(
        createTemplate("workspace-1", {
          name: "invalid_code",
          language: "en",
          category,
          components: [
            { type: "BODY", text: "Your code is {{1}}." },
            {
              type: "BUTTONS",
              buttons: [{ type: "OTP", otp_type: "COPY_CODE" }],
            },
          ],
        })
      ).rejects.toThrow("Invalid WhatsApp template components");
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("creates named-variable templates with parameter_format NAMED", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "template-1", status: "PENDING" })
      );
    const { createTemplate } = await import("./service");
    const body = {
      type: "BODY" as const,
      text: "Уважаемый {{name}}, поступила коллекция Fall 2026.",
      example: {
        body_text_named_params: [{ param_name: "name", example: "Александр" }],
      },
    };
    const card = (handle: string) => ({
      components: [
        {
          type: "HEADER" as const,
          format: "IMAGE" as const,
          example: { header_handle: [handle] },
        },
        { type: "BODY" as const, text: "Итальянский шик" },
        {
          type: "BUTTONS" as const,
          buttons: [
            { type: "QUICK_REPLY" as const, text: "Заказать каталог" },
            {
              type: "URL" as const,
              text: "Перейти в Инстаграм",
              url: "https://www.instagram.com/boutique.example/",
            },
          ],
        },
      ],
    });

    await createTemplate("workspace-1", {
      name: "boutique_fall_2026",
      language: "ru",
      category: "MARKETING",
      components: [
        body,
        { type: "CAROUSEL", cards: [card("4::one"), card("4::two")] },
      ],
    });

    const createBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)
    );
    expect(createBody).toMatchObject({
      name: "boutique_fall_2026",
      language: "ru",
      category: "MARKETING",
      parameter_format: "NAMED",
    });
    expect(createBody.components[0]).toEqual(body);
  });

  it("leaves numbered templates on Meta's default parameter format", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "template-1", status: "PENDING" })
      );
    const { createTemplate } = await import("./service");

    await createTemplate("workspace-1", {
      name: "order_ready",
      language: "en_US",
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, your order is ready.",
          example: { body_text: [["Pablo"]] },
        },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "Track",
              url: "https://shop.example.com/{{1}}",
              example: ["https://shop.example.com/42"],
            },
          ],
        },
      ],
    });

    const createBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)
    );
    expect(createBody).not.toHaveProperty("parameter_format");
  });

  it("rejects templates that mix named and numbered variables before network calls", async () => {
    const { createTemplate } = await import("./service");

    await expect(
      createTemplate("workspace-1", {
        name: "order_ready",
        language: "en_US",
        category: "UTILITY",
        components: [
          { type: "BODY", text: "Hi {{name}}, order {{1}} is ready." },
        ],
      })
    ).rejects.toThrow("Template variables must be all named");

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends parameter_format NAMED when an update re-sends named components", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { updateTemplate } = await import("./service");

    await updateTemplate(
      "workspace-1",
      "template-1",
      {
        components: [
          {
            type: "BODY",
            text: "Hi {{first_name}}, your order is ready.",
            example: {
              body_text_named_params: [
                { param_name: "first_name", example: "Pablo" },
              ],
            },
          },
        ],
      },
      verifiedAccountOptions
    );
    await updateTemplate(
      "workspace-1",
      "template-2",
      {
        components: [{ type: "BODY", text: "Hi {{1}}, your order is ready." }],
      },
      verifiedAccountOptions
    );
    await updateTemplate(
      "workspace-1",
      "template-3",
      {
        category: "MARKETING",
      },
      verifiedAccountOptions
    );

    const [namedBody, numberedBody, categoryBody] = mockFetch.mock.calls.map(
      call => JSON.parse(String((call[1] as RequestInit).body))
    );
    expect(namedBody).toMatchObject({ parameter_format: "NAMED" });
    expect(numberedBody).not.toHaveProperty("parameter_format");
    expect(categoryBody).toEqual({ category: "MARKETING" });
  });

  it("rejects image header creation without a media example before network calls", async () => {
    const { createTemplate } = await import("./service");

    await expect(
      createTemplate("workspace-1", {
        name: "promo_image",
        language: "en_US",
        category: "MARKETING",
        components: [
          { type: "HEADER", format: "IMAGE" },
          { type: "BODY", text: "Hello" },
        ],
      })
    ).rejects.toThrow("Media header example is required");

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uploads media header sample URLs to Meta before creating templates", async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "upload:session-1" }))
      .mockResolvedValueOnce(jsonResponse({ h: "4::meta-header-handle" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "template-1", status: "PENDING" })
      );
    const { createTemplate } = await import("./service");

    await createTemplate("workspace-1", {
      name: "promo_image",
      language: "en_US",
      category: "MARKETING",
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: {
            header_handle: ["https://cdn.example.com/header.png"],
          },
        },
        { type: "BODY", text: "Hello" },
      ],
    });

    const sessionUrl = String(mockFetch.mock.calls[2]?.[0]);
    expect(sessionUrl).toContain("app-1/uploads");
    expect(decodeURIComponent(sessionUrl)).toContain("file_name=header.png");
    expect(decodeURIComponent(sessionUrl)).toContain("file_type=image/png");
    expect(mockFetch.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "OAuth access-token-1",
        file_offset: "0",
      }),
    });
    const createBody = JSON.parse(
      String((mockFetch.mock.calls[4]?.[1] as RequestInit).body)
    );
    expect(createBody.components[0]).toMatchObject({
      type: "HEADER",
      format: "IMAGE",
      example: {
        header_handle: ["4::meta-header-handle"],
      },
    });
  });

  it("keeps existing Meta media handles without reuploading templates", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "template-1", status: "PENDING" })
      );
    const { createTemplate } = await import("./service");

    await createTemplate("workspace-1", {
      name: "promo_image",
      language: "en_US",
      category: "MARKETING",
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: {
            header_handle: ["4::existing-meta-handle"],
          },
        },
        { type: "BODY", text: "Hello" },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockDnsLookup).not.toHaveBeenCalled();
    expect(
      mockFetch.mock.calls.map(call => String(call[0])).join("\n")
    ).not.toContain("/uploads");
    const createBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)
    );
    expect(createBody.components[0].example.header_handle).toEqual([
      "4::existing-meta-handle",
    ]);
  });

  it("updates preset authentication options without changing the existing category", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const { updateTemplate } = await import("./service");
    const components = [
      { type: "BODY" as const, add_security_recommendation: false },
      { type: "FOOTER" as const, code_expiration_minutes: 10 },
      {
        type: "BUTTONS" as const,
        buttons: [{ type: "OTP" as const, otp_type: "COPY_CODE" as const }],
      },
    ];
    await updateTemplate(
      "workspace-1",
      "auth-template-1",
      { components },
      verifiedAccountOptions
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1].body))).toEqual({
      components,
    });
  });

  it("rejects an authentication provider readback in an unchanged-category edit before any network calls", async () => {
    const { updateTemplate } = await import("./service");
    await expect(
      updateTemplate(
        "workspace-1",
        "auth-template-1",
        {
          components: [
            { type: "BODY", text: "{{1}} is your verification code." },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "URL",
                  text: "Copy code",
                  url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}",
                },
              ],
            },
          ],
        },
        verifiedAccountOptions
      )
    ).rejects.toThrow("authentication readback URLs");
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retries template updates without optimization_spec when Meta rejects the beta allowlist", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message:
                "WhatsApp Business Account must be on allow list to access optimization_spec.",
            },
          },
          400
        )
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { updateTemplate } = await import("./service");

    const result = await updateTemplate(
      "workspace-1",
      "template-1",
      {
        category: "MARKETING",
        optimization_spec: {
          bid_amount: 2500,
          bid_strategy: "LOWEST_COST_WITH_BID_CAP",
        },
      },
      verifiedAccountOptions
    );

    const retryBody = JSON.parse(
      String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)
    );
    expect(retryBody).not.toHaveProperty("optimization_spec");
    expect(result).toMatchObject({
      success: true,
      warning: expect.stringContaining("without Marketing Messages max price"),
    });
  });

  it("rejects image header updates without a media example before network calls", async () => {
    const { updateTemplate } = await import("./service");

    await expect(
      updateTemplate(
        "workspace-1",
        "template-1",
        {
          components: [
            { type: "HEADER", format: "IMAGE" },
            { type: "BODY", text: "Updated body" },
          ],
        },
        verifiedAccountOptions
      )
    ).rejects.toThrow("Media header example is required");

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uploads media header sample URLs to Meta before updating templates", async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    mockFetch
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "upload:session-1" }))
      .mockResolvedValueOnce(jsonResponse({ h: "4::meta-header-handle" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const { updateTemplate } = await import("./service");

    await updateTemplate(
      "workspace-1",
      "template-1",
      {
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: {
              header_handle: ["https://cdn.example.com/header.png"],
            },
          },
          { type: "BODY", text: "Updated body" },
        ],
      },
      verifiedAccountOptions
    );

    const updateBody = JSON.parse(
      String((mockFetch.mock.calls[3]?.[1] as RequestInit).body)
    );
    expect(updateBody.components[0].example.header_handle).toEqual([
      "4::meta-header-handle",
    ]);
  });

  it("uploads carousel card header sample URLs to Meta before creating templates", async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    // Card headers upload concurrently, so answer by URL, not by call order.
    mockFetch.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const card = /\/(one|two)\.png$/.exec(url)?.[1];
      if (card) {
        return new Response(
          new Uint8Array(card === "one" ? [1, 2, 3] : [4, 5, 6]),
          { status: 200, headers: { "Content-Type": "image/png" } }
        );
      }
      const session = /\/app-1\/uploads\?file_name=(one|two)\.png/.exec(
        url
      )?.[1];
      if (session) return jsonResponse({ id: `upload:session-${session}` });
      const upload = /\/upload:session-(one|two)$/.exec(url)?.[1];
      if (upload) return jsonResponse({ h: `4::meta-card-${upload}` });
      if (
        url.endsWith("/waba-1/message_templates") &&
        init?.method === "POST"
      ) {
        return jsonResponse({ id: "template-1", status: "PENDING" });
      }
      if (url.includes("/waba-1/message_templates?")) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { createTemplate } = await import("./service");

    await createTemplate("workspace-1", {
      name: "promo_carousel",
      language: "en_US",
      category: "MARKETING",
      components: [
        { type: "BODY", text: "Pick a card" },
        {
          type: "CAROUSEL",
          cards: [
            {
              components: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: {
                    header_handle: ["https://cdn.example.com/one.png"],
                  },
                },
                { type: "BODY", text: "One" },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "QUICK_REPLY", text: "Select" }],
                },
              ],
            },
            {
              components: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: {
                    header_handle: ["https://cdn.example.com/two.png"],
                  },
                },
                { type: "BODY", text: "Two" },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "QUICK_REPLY", text: "Select" }],
                },
              ],
            },
          ],
        },
      ],
    });

    const createBody = JSON.parse(
      String((mockFetch.mock.calls.at(-1)?.[1] as RequestInit).body)
    );
    expect(createBody.components[1].type).toBe("CAROUSEL");
    expect(
      createBody.components[1].cards[0].components[0].example.header_handle
    ).toEqual(["4::meta-card-one"]);
    expect(
      createBody.components[1].cards[1].components[0].example.header_handle
    ).toEqual(["4::meta-card-two"]);
  });

  describe("header media URL downloads", () => {
    const notAllowed =
      "Header media URL is not allowed. Use a public http(s) URL or upload the file.";
    const imageTooLarge = "IMAGE template header media must be 5MB or smaller.";

    beforeEach(() => {
      process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    });

    async function updateImageHeader(url: string) {
      const { updateTemplate } = await import("./service");
      return updateTemplate(
        "workspace-1",
        "template-1",
        {
          components: [
            {
              type: "HEADER",
              format: "IMAGE",
              example: { header_handle: [url] },
            },
            { type: "BODY", text: "Updated body" },
          ],
        },
        verifiedAccountOptions
      );
    }

    function metaCalls() {
      return mockFetch.mock.calls.filter(([input]) =>
        String(input).includes("graph.facebook.com")
      );
    }

    it.each([
      "http://127.0.0.1/header.png",
      "http://10.20.30.40/header.png",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials",
      "http://localhost:3000/header.png",
      "http://[::1]/header.png",
      "http://metadata.google.internal/computeMetadata/v1/",
    ])("rejects %s before any request or Meta upload", async url => {
      await expect(updateImageHeader(url)).rejects.toThrow(notAllowed);
      expect(mockDnsLookup).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a host that resolves to a private address without naming it", async () => {
      mockDnsLookup.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ]);

      const error = await updateImageHeader(
        "https://media.attacker.example/header.png"
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(notAllowed);
      expect((error as Error).message).not.toContain("10.0.0.7");
      expect(mockDnsLookup).toHaveBeenCalledWith("media.attacker.example", {
        all: true,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a redirect to the metadata address and uploads nothing to Meta", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        })
      );

      await expect(
        updateImageHeader("https://cdn.example.com/header.png")
      ).rejects.toThrow(notAllowed);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
        redirect: "manual",
      });
    });

    it("rejects an oversized Content-Length before reading the body", async () => {
      let pulled = false;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      // Like undici, aborting the request signal releases the unread body.
      mockFetch.mockImplementationOnce(async (_input, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          body.cancel().catch(() => undefined);
        });
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(5 * 1024 * 1024 + 1),
          },
        });
      });

      await expect(
        updateImageHeader("https://cdn.example.com/header.png")
      ).rejects.toThrow(imageTooLarge);

      expect(pulled).toBe(false);
      expect(cancelled).toBe(true);
      expect(metaCalls()).toHaveLength(0);
    });

    it("stops a streamed body without Content-Length once it passes the format limit", async () => {
      let pulls = 0;
      let cancelled = false;
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        })
      );

      await expect(
        updateImageHeader("https://cdn.example.com/header.png")
      ).rejects.toThrow(imageTooLarge);

      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThanOrEqual(8);
      expect(metaCalls()).toHaveLength(0);
    });

    it("fails a stalled body at the download deadline", async () => {
      jest.useFakeTimers({
        doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
      });
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      });
      let markFetched: () => void = () => undefined;
      const fetched = new Promise<void>(resolve => {
        markFetched = resolve;
      });
      mockFetch.mockImplementationOnce(async () => {
        markFetched();
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      });

      const result = updateImageHeader(
        "https://cdn.example.com/header.png"
      ).catch((caught: unknown) => caught);
      await fetched;
      await jest.advanceTimersByTimeAsync(60_000);

      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Timed out downloading header media from the URL."
      );
      expect(cancelled).toBe(true);
      expect(metaCalls()).toHaveLength(0);
    });

    it("downloads a public URL through the checked fetch and uploads it to Meta", async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "image/png", "Content-Length": "3" },
          })
        )
        .mockResolvedValueOnce(jsonResponse({ id: "upload:session-1" }))
        .mockResolvedValueOnce(jsonResponse({ h: "4::meta-header-handle" }))
        .mockResolvedValueOnce(jsonResponse({ success: true }));

      await updateImageHeader("https://cdn.example.com/header.png");

      expect(mockDnsLookup).toHaveBeenCalledWith("cdn.example.com", {
        all: true,
      });
      expect(String(mockFetch.mock.calls[0]?.[0])).toBe(
        "https://cdn.example.com/header.png"
      );
      expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
        redirect: "manual",
        headers: { "User-Agent": expect.stringContaining("Airi.chat") },
      });
      expect(
        decodeURIComponent(String(mockFetch.mock.calls[1]?.[0]))
      ).toContain("file_length=3");
      const updateBody = JSON.parse(
        String((mockFetch.mock.calls[3]?.[1] as RequestInit).body)
      );
      expect(updateBody.components[0].example.header_handle).toEqual([
        "4::meta-header-handle",
      ]);
    });
  });
});
