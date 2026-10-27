const mockCreateClient = jest.fn();
const mockGetCompanyIdForUserWorkspace = jest.fn();
const mockAdminFrom = jest.fn();
const mockAdminSelect = jest.fn();
const mockAdminEq = jest.fn();
const mockAdminOrder = jest.fn();
const mockAdminUpsert = jest.fn();
const mockTryStartCrawlWebsiteWorkflow = jest.fn();
const mockDeleteIndexedUrl = jest.fn();
const mockEnqueueKnowledgeCanonicalSync = jest.fn();

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

jest.mock("@/lib/temporal/crawl-website-client", () => ({
  tryStartCrawlWebsiteWorkflow: (...args: unknown[]) =>
    mockTryStartCrawlWebsiteWorkflow(...args),
}));

jest.mock("@/lib/kb/url-indexer", () => ({
  deleteIndexedUrl: (...args: unknown[]) => mockDeleteIndexedUrl(...args),
}));

jest.mock(
  "@/lib/airi/rag/knowledge/canonical-sync/enqueue-knowledge-canonical-sync",
  () => ({
    enqueueKnowledgeCanonicalSync: (...args: unknown[]) =>
      mockEnqueueKnowledgeCanonicalSync(...args),
  })
);

import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "./route";
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

const adminMocks = {
  from: mockAdminFrom,
  select: mockAdminSelect,
  eq: mockAdminEq,
  order: mockAdminOrder,
  upsert: mockAdminUpsert,
};

function request(
  method: "GET" | "POST" | "DELETE",
  params: Record<string, string> = {},
  body?: unknown
) {
  const url = new URL("http://localhost/api/kb/indexed-urls");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/kb/indexed-urls authorization and public boundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockCreateClient.mockResolvedValue(createAuthClient());
    mockGetCompanyIdForUserWorkspace.mockResolvedValue("company-1");
    mockTryStartCrawlWebsiteWorkflow.mockResolvedValue({
      ok: true,
      workflowId: "crawl-website:workspace-1:run-1",
    });
    mockDeleteIndexedUrl.mockResolvedValue({ success: true });
    useAdminTable(adminMocks);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("returns 401 without reaching the admin table", async () => {
    mockCreateClient.mockResolvedValue(createAuthClient(null));

    const response = await GET(request("GET", { workspaceId: "workspace-1" }));

    expect(response.status).toBe(401);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("returns 403 without reaching the admin table or workflow", async () => {
    mockGetCompanyIdForUserWorkspace.mockResolvedValue(null);

    const response = await POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(403);
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("lists company-scoped rows through the admin client and sanitizes failures", async () => {
    useAdminTable(adminMocks, {
      orderResult: {
        data: [
          {
            id: "url-1",
            url: "https://example.com/",
            title: "Example",
            description: null,
            index_status: "failed",
            last_indexed_at: null,
            error_message: "permission denied for table kb_indexed_urls",
            created_at: "2026-07-10T00:00:00.000Z",
          },
        ],
        error: null,
      },
    });

    const response = await GET(request("GET", { workspaceId: "workspace-1" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdminFrom).toHaveBeenCalledWith("kb_indexed_urls");
    expect(mockAdminEq).toHaveBeenCalledWith("company_id", "company-1");
    expect(payload.urls).toEqual([
      expect.objectContaining({
        id: "url-1",
        failure_code: "generic",
        error_message: "Indexing failed.",
      }),
    ]);
    expect(JSON.stringify(payload)).not.toMatch(
      /permission denied|\brls\b|kb_indexed_urls/i
    );
  });

  it("persists pending rows before starting an add workflow", async () => {
    useAdminTable(adminMocks);
    let releasePendingWrite!: (value: { error: null }) => void;
    const pendingWrite = new Promise<{ error: null }>(resolve => {
      releasePendingWrite = resolve;
    });
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>(resolve => {
      signalWriteStarted = resolve;
    });
    mockAdminUpsert.mockImplementationOnce(() => {
      signalWriteStarted();
      return pendingWrite;
    });

    const responsePromise = POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );
    await writeStarted;

    expect(mockAdminUpsert).toHaveBeenCalledTimes(1);
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
    releasePendingWrite({ error: null });

    const response = await responsePromise;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      queued: true,
      workflowId: "crawl-website:workspace-1:run-1",
    });
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenCalledTimes(1);
  });

  it("uses one effective workflow input for equivalent add requests", async () => {
    const firstResponse = await POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );
    const secondResponse = await POST(
      request(
        "POST",
        {},
        {
          url: "https://example.com/#fragment",
          workspaceId: "workspace-1",
          maxPagesPerSite: CRAWL_INDEX_LIMITS.defaultMaxPagesPerSite,
          maxCrawlMsPerSite: CRAWL_INDEX_LIMITS.defaultCrawlMsPerSite,
          maxIndexChars: CRAWL_INDEX_LIMITS.maxAggregatedChars,
        }
      )
    );

    expectOneEffectiveWorkflowInput(
      mockTryStartCrawlWebsiteWorkflow,
      [firstResponse, secondResponse],
      { websites: ["https://example.com/"], includeInstagram: false }
    );
  });

  it("uses Temporal to recover a missing workflow while preserving the duplicate success shape", async () => {
    useAdminTable(adminMocks, {
      selectResult: {
        data: [freshPendingRow()],
        error: null,
      },
    });

    const response = await POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      queued: true,
      started: false,
      alreadyQueued: true,
    });
    expect(mockAdminUpsert).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        websites: ["https://example.com/"],
        includeInstagram: false,
      })
    );
  });

  it("returns the coded limit detail without starting a workflow", async () => {
    useAdminTable(adminMocks, {
      selectResult: {
        data: Array.from({ length: 5 }, (_, index) => ({
          url: `https://${index}.example/`,
          index_status: "indexed",
          last_indexed_at: null,
        })),
        error: null,
      },
    });

    const response = await POST(
      request("POST", {}, { url: "new.example", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "indexed_url_limit_exceeded",
      error: expect.stringContaining("Maximum"),
      limit: 5,
      activeCount: 5,
      requestedNewCount: 1,
    });
    expect(mockAdminUpsert).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("sanitizes pending-upsert failures and never starts the workflow", async () => {
    useAdminTable(adminMocks);
    mockAdminUpsert.mockResolvedValueOnce(PERMISSION_DENIED_WRITE);

    const response = await POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "indexed_url_add_failed",
      error: "Failed to queue website indexing.",
    });
    expectNoStorageDiagnostics(payload);
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("persists and returns only the safe training failure on Temporal start failure", async () => {
    useAdminTable(adminMocks);
    mockTryStartCrawlWebsiteWorkflow.mockResolvedValue(TEMPORAL_START_FAILURE);

    const response = await POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );

    await expectSafeTrainingStartFailure(response, mockAdminUpsert);
  });

  it("sanitizes a failed-status persistence error after a start failure", async () => {
    useAdminTable(adminMocks);
    mockAdminUpsert
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({
        error: { message: "RLS blocked failed write to kb_indexed_urls" },
      });
    mockTryStartCrawlWebsiteWorkflow.mockResolvedValue({
      ok: false,
      reason: "start_failed",
      message: "Temporal internal failure",
    });

    const response = await POST(
      request("POST", {}, { url: "example.com", workspaceId: "workspace-1" })
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "indexed_url_add_failed",
      error: "Failed to queue website indexing.",
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /rls|kb_indexed_urls|Temporal/i
    );
  });

  it("deletes with both company and URL identity", async () => {
    const response = await DELETE(
      request("DELETE", { workspaceId: "workspace-1", id: "url-1" })
    );

    expect(response.status).toBe(200);
    expect(mockDeleteIndexedUrl).toHaveBeenCalledWith("company-1", "url-1");
    expect(mockEnqueueKnowledgeCanonicalSync).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceKinds: ["indexed_url"],
      })
    );
  });

  it("returns a sanitized 500 for delete infrastructure failures", async () => {
    mockDeleteIndexedUrl.mockResolvedValue({
      success: false,
      error: "permission denied for table kb_indexed_urls",
    });

    const response = await DELETE(
      request("DELETE", { workspaceId: "workspace-1", id: "url-1" })
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "indexed_url_delete_failed",
      error: "Failed to delete indexed URL.",
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /permission denied|rls|kb_indexed_urls/i
    );
  });
});
