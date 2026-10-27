const mockCreateClient = jest.fn();
const mockGetCompanyIdForUserWorkspace = jest.fn();
const mockAdminFrom = jest.fn();
const mockAdminSelect = jest.fn();
const mockAdminEq = jest.fn();
const mockAdminMaybeSingle = jest.fn();
const mockAdminUpsert = jest.fn();
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

jest.mock("@/lib/temporal/crawl-website-client", () => ({
  tryStartCrawlWebsiteWorkflow: (...args: unknown[]) =>
    mockTryStartCrawlWebsiteWorkflow(...args),
}));

import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  PERMISSION_DENIED_WRITE,
  TEMPORAL_START_FAILURE,
  createAuthClient,
  expectNoStorageDiagnostics,
  expectOneEffectiveWorkflowInput,
  expectSafeTrainingStartFailure,
  freshPendingRow,
} from "@/lib/kb/indexed-url-route-test-utils";

function useAdminTable(existingUrl: unknown = null) {
  const query = {
    eq: (...args: unknown[]) => {
      mockAdminEq(...args);
      return query;
    },
    maybeSingle: (...args: unknown[]) => mockAdminMaybeSingle(...args),
  };
  const table = {
    select: (...args: unknown[]) => {
      mockAdminSelect(...args);
      return query;
    },
    upsert: (...args: unknown[]) => mockAdminUpsert(...args),
  };

  mockAdminMaybeSingle.mockResolvedValue({ data: existingUrl, error: null });
  mockAdminUpsert.mockResolvedValue({ error: null });
  mockAdminFrom.mockReturnValue(table);
}

function jsonRequest(body: unknown) {
  return new NextRequest("http://localhost/api/kb/indexed-urls/reindex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/kb/indexed-urls/reindex authorization and public boundary", () => {
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
    useAdminTable({
      url: "https://example.com/",
      index_status: "indexed",
      last_indexed_at: null,
    });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("returns 401 without reaching the admin table", async () => {
    mockCreateClient.mockResolvedValue(createAuthClient(null));

    const response = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(401);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("returns 403 without reaching the admin table or workflow", async () => {
    mockGetCompanyIdForUserWorkspace.mockResolvedValue(null);

    const response = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(403);
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("finds and reindexes only the company-scoped URL through the admin client", async () => {
    const response = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(202);
    expect(mockAdminFrom).toHaveBeenCalledWith("kb_indexed_urls");
    expect(mockAdminEq).toHaveBeenCalledWith("id", "url-1");
    expect(mockAdminEq).toHaveBeenCalledWith("company_id", "company-1");
    expect(mockAdminUpsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          company_id: "company-1",
          url: "https://example.com/",
          index_status: "pending",
        }),
      ],
      { onConflict: "company_id,url" }
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      queued: true,
      workflowId: "crawl-website:workspace-1:run-1",
    });
  });

  it("uses one effective workflow input for equivalent reindex requests", async () => {
    mockAdminMaybeSingle
      .mockResolvedValueOnce({
        data: {
          url: "example.com",
          index_status: "indexed",
          last_indexed_at: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          url: "https://example.com/#fragment",
          index_status: "indexed",
          last_indexed_at: null,
        },
        error: null,
      });

    const firstResponse = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
    );
    const secondResponse = await POST(
      jsonRequest({
        urlId: "url-1",
        workspaceId: "workspace-1",
        maxPagesPerSite: CRAWL_INDEX_LIMITS.defaultMaxPagesPerSite,
        maxCrawlMsPerSite: CRAWL_INDEX_LIMITS.defaultCrawlMsPerSite,
        maxIndexChars: CRAWL_INDEX_LIMITS.maxAggregatedChars,
      })
    );

    expectOneEffectiveWorkflowInput(
      mockTryStartCrawlWebsiteWorkflow,
      [firstResponse, secondResponse],
      { websites: ["https://example.com/"], includeInstagram: false }
    );
  });

  it("uses Temporal to recover a missing workflow for a fresh pending reindex", async () => {
    useAdminTable(freshPendingRow());

    const response = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
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

  it("treats a cross-company URL as not found without starting a workflow", async () => {
    useAdminTable(null);

    const response = await POST(
      jsonRequest({ urlId: "other-company-url", workspaceId: "workspace-1" })
    );

    expect(response.status).toBe(404);
    expect(mockAdminEq).toHaveBeenCalledWith("id", "other-company-url");
    expect(mockAdminEq).toHaveBeenCalledWith("company_id", "company-1");
    expect(mockAdminUpsert).not.toHaveBeenCalled();
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("sanitizes pending-upsert failures and never starts the workflow", async () => {
    mockAdminUpsert.mockResolvedValueOnce(PERMISSION_DENIED_WRITE);

    const response = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "indexed_url_reindex_failed",
      error: "Failed to queue website reindex.",
    });
    expectNoStorageDiagnostics(payload);
    expect(mockTryStartCrawlWebsiteWorkflow).not.toHaveBeenCalled();
  });

  it("persists and returns only the safe training failure on Temporal start failure", async () => {
    mockTryStartCrawlWebsiteWorkflow.mockResolvedValue(TEMPORAL_START_FAILURE);

    const response = await POST(
      jsonRequest({ urlId: "url-1", workspaceId: "workspace-1" })
    );

    await expectSafeTrainingStartFailure(response, mockAdminUpsert);
  });
});
