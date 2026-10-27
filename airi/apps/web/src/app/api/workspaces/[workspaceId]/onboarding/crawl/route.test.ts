const mockCreateClient = jest.fn();
const mockGetCompanyIdForUserWorkspace = jest.fn();
const mockAdminFrom = jest.fn();
const mockAdminSelect = jest.fn();
const mockAdminEq = jest.fn();
const mockAdminOrder = jest.fn();
const mockAdminUpsert = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockTryStartCrawlWebsiteWorkflow = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  getCompanyIdForUserWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForUserWorkspace(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
}));

jest.mock("@/lib/temporal/crawl-website-client", () => ({
  tryStartCrawlWebsiteWorkflow: (...args: unknown[]) =>
    mockTryStartCrawlWebsiteWorkflow(...args),
}));

import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";
import { buildCrawlWebsiteExecutionId } from "@/lib/temporal/crawl-website-execution";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import {
  PERMISSION_DENIED_WRITE,
  TEMPORAL_START_FAILURE,
  createAuthClient,
  expectNoStorageDiagnostics,
  expectOneEffectiveWorkflowInput,
  expectSafeTrainingStartFailure,
  freshPendingRow,
  useAdminTable,
} from "@/lib/kb/indexed-url-route-test-utils";

const params = Promise.resolve({ workspaceId: "workspace-1" });

const adminMocks = {
  from: mockAdminFrom,
  select: mockAdminSelect,
  eq: mockAdminEq,
  order: mockAdminOrder,
  upsert: mockAdminUpsert,
};

function jsonRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/workspaces/workspace-1/onboarding/crawl",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function getRequest() {
  return new NextRequest(
    "http://localhost/api/workspaces/workspace-1/onboarding/crawl"
  );
}

describe("/api/workspaces/[workspaceId]/onboarding/crawl boundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockCreateClient.mockResolvedValue(createAuthClient());
    mockIsTemporalConfigured.mockReturnValue(true);
    mockGetCompanyIdForUserWorkspace.mockResolvedValue("company-1");
    mockTryStartCrawlWebsiteWorkflow.mockResolvedValue({
      ok: true,
      workflowId: "crawl-website:workspace-1:run-1",
    });
    useAdminTable(adminMocks);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("returns 401 without reaching the admin table", async () => {
    mockCreateClient.mockResolvedValue(createAuthClient(null));

    const response = await POST(jsonRequest({ websites: ["example.com"] }), {
      params,
    });

    expect(response.status).toBe(401);
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 without reaching the admin table", async () => {
    mockGetCompanyIdForUserWorkspace.mockResolvedValue(null);

    const response = await GET(getRequest(), { params });

    expect(response.status).toBe(403);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("creates pending rows through the admin client before starting the crawl", async () => {
    const response = await POST(
      jsonRequest({
        websites: [
          "example.com",
          "https://example.com/#top",
          "https://airi.chat",
        ],
        includeInstagram: false,
        maxPagesPerSite: 999,
      }),
      { params }
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      started: true,
      workflowId: "crawl-website:workspace-1:run-1",
      accepted: {
        websites: ["https://example.com/", "https://airi.chat/"],
      },
      limits: {
        indexedUrlLimit: CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany,
        maxPagesPerSite: CRAWL_INDEX_LIMITS.hardMaxPagesPerSite,
      },
    });
    expect(response.status).toBe(202);
    expect(mockAdminFrom).toHaveBeenCalledWith("kb_indexed_urls");
    expect(mockAdminEq).toHaveBeenCalledWith("company_id", "company-1");
    expect(mockAdminUpsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          company_id: "company-1",
          url: "https://example.com/",
          index_status: "pending",
          error_message: null,
        }),
        expect.objectContaining({
          company_id: "company-1",
          url: "https://airi.chat/",
          index_status: "pending",
          error_message: null,
        }),
      ],
      { onConflict: "company_id,url" }
    );
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        websites: ["https://example.com/", "https://airi.chat/"],
        includeInstagram: false,
        maxPagesPerSite: CRAWL_INDEX_LIMITS.hardMaxPagesPerSite,
      })
    );
  });

  it("uses one effective workflow input for equivalent Instagram-only requests", async () => {
    const firstResponse = await POST(jsonRequest({ includeInstagram: true }), {
      params,
    });
    const secondResponse = await POST(
      jsonRequest({
        websites: [],
        includeInstagram: true,
        maxPagesPerSite: CRAWL_INDEX_LIMITS.defaultMaxPagesPerSite,
        maxCrawlMsPerSite: CRAWL_INDEX_LIMITS.defaultCrawlMsPerSite,
        maxIndexChars: CRAWL_INDEX_LIMITS.maxAggregatedChars,
      }),
      { params }
    );

    expectOneEffectiveWorkflowInput(
      mockTryStartCrawlWebsiteWorkflow,
      [firstResponse, secondResponse],
      { websites: [], includeInstagram: true }
    );
  });

  it("keeps website and Instagram workflow identity stable when the website row is already pending", async () => {
    mockTryStartCrawlWebsiteWorkflow.mockImplementation(async input => ({
      ok: true,
      workflowId: `crawl-website:workspace-1:${buildCrawlWebsiteExecutionId(input)}`,
    }));
    const requestBody = {
      websites: ["example.com"],
      includeInstagram: true,
    };

    const firstResponse = await POST(jsonRequest(requestBody), { params });
    const firstPayload = await firstResponse.json();

    useAdminTable(adminMocks, {
      selectResult: {
        data: [freshPendingRow()],
        error: null,
      },
    });
    const retryResponse = await POST(jsonRequest(requestBody), { params });
    const retryPayload = await retryResponse.json();

    expect(firstResponse.status).toBe(202);
    expect(retryResponse.status).toBe(202);
    expect(firstPayload.workflowId).toBe(retryPayload.workflowId);
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenCalledTimes(2);
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        websites: ["https://example.com/"],
        includeInstagram: true,
      })
    );
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        websites: ["https://example.com/"],
        includeInstagram: true,
      })
    );
  });

  it("rejects new seeds with coded limit detail and no workflow", async () => {
    useAdminTable(adminMocks, {
      selectResult: {
        data: [
          { url: "https://one.example/", index_status: "indexed" },
          { url: "https://two.example/", index_status: "indexed" },
          { url: "https://three.example/", index_status: "pending" },
          { url: "https://four.example/", index_status: "indexed" },
        ],
        error: null,
      },
    });

    const response = await POST(
      jsonRequest({
        websites: ["https://five.example", "https://six.example"],
      }),
      { params }
    );

    await expect(response.json()).resolves.toMatchObject({
      code: "indexed_url_limit_exceeded",
      error: expect.stringContaining("Maximum"),
    });
    expect(response.status).toBe(400);
    expect(mockAdminUpsert).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("uses Temporal to recover a missing workflow for a fresh pending website", async () => {
    useAdminTable(adminMocks, {
      selectResult: {
        data: [freshPendingRow()],
        error: null,
      },
    });

    const response = await POST(jsonRequest({ websites: ["example.com"] }), {
      params,
    });

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      started: false,
      alreadyQueued: true,
      accepted: {
        websites: ["https://example.com/"],
      },
    });
    expect(response.status).toBe(202);
    expect(mockAdminUpsert).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        websites: ["https://example.com/"],
        includeInstagram: false,
      })
    );
  });

  it("returns a stable unavailable error when Temporal is not configured", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    const response = await POST(jsonRequest({ websites: ["example.com"] }), {
      params,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "background_processing_unavailable",
      error: "Background processing is not available right now.",
    });
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("returns a stable invalid-source error", async () => {
    const response = await POST(jsonRequest({ websites: [] }), { params });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_training_source",
      error: "Provide at least one website or connect Instagram.",
    });
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("sanitizes pending persistence failures and never starts a workflow", async () => {
    mockAdminUpsert.mockResolvedValueOnce(PERMISSION_DENIED_WRITE);

    const response = await POST(jsonRequest({ websites: ["example.com"] }), {
      params,
    });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "training_start_failed",
      error: "We couldn't start training. Please try again.",
    });
    expectNoStorageDiagnostics(payload);
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("persists and returns only the safe training failure after a start failure", async () => {
    mockTryStartCrawlWebsiteWorkflow.mockResolvedValue(TEMPORAL_START_FAILURE);

    const response = await POST(jsonRequest({ websites: ["example.com"] }), {
      params,
    });

    await expectSafeTrainingStartFailure(response, mockAdminUpsert);
  });

  it("loads company-scoped progress through admin and sanitizes diagnostics", async () => {
    useAdminTable(adminMocks, {
      orderResult: {
        data: [
          {
            id: "url-1",
            url: "https://example.com/",
            title: null,
            description: null,
            index_status: "failed",
            last_indexed_at: null,
            error_message: "RLS blocked kb_indexed_urls",
            created_at: "2026-07-10T00:00:00.000Z",
          },
        ],
        error: null,
      },
    });

    const response = await GET(getRequest(), { params });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdminFrom).toHaveBeenCalledWith("kb_indexed_urls");
    expect(mockAdminEq).toHaveBeenCalledWith("company_id", "company-1");
    expect(payload).toMatchObject({
      sources: [
        expect.objectContaining({
          id: "url-1",
          failure_code: "generic",
          error_message: "Indexing failed.",
        }),
      ],
      total: 1,
      failed: 1,
    });
    expect(JSON.stringify(payload)).not.toMatch(/rls|kb_indexed_urls/i);
  });

  it("sanitizes progress infrastructure failures", async () => {
    useAdminTable(adminMocks, {
      orderResult: {
        data: null,
        error: { message: "permission denied for table kb_indexed_urls" },
      },
    });

    const response = await GET(getRequest(), { params });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "training_progress_unavailable",
      error: "We couldn't load training progress. Please try again.",
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /permission denied|rls|kb_indexed_urls/i
    );
  });
});
