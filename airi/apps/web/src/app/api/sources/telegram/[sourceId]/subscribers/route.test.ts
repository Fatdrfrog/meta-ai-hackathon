const mockRequireAccess = jest.fn();
const mockImportCsv = jest.fn();
const mockListSubscribers = jest.fn();
const mockBuildCsv = jest.fn();
const mockCountSubscribers = jest.fn();
const mockGetLatestImportBatch = jest.fn();
const mockScheduleBackfill = jest.fn();

jest.mock("@/lib/telegram/subscriber-route-auth", () => ({
  requireTelegramSubscriberSourceAccess: (...args: unknown[]) =>
    mockRequireAccess(...args),
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  importTelegramSubscriberCsv: (...args: unknown[]) => mockImportCsv(...args),
  listTelegramSubscribers: (...args: unknown[]) => mockListSubscribers(...args),
  countTelegramSubscribers: (...args: unknown[]) =>
    mockCountSubscribers(...args),
  getLatestTelegramSubscriberImportBatch: (...args: unknown[]) =>
    mockGetLatestImportBatch(...args),
  buildTelegramSubscribersCsv: (...args: unknown[]) => mockBuildCsv(...args),
  scheduleTelegramSubscriberBackfill: (...args: unknown[]) =>
    mockScheduleBackfill(...args),
}));

import { GET as listSubscribers } from "./route";
import { GET as exportSubscribers } from "./export/route";
import { POST as importSubscribers } from "./import/route";
import { NextResponse } from "next/server";

const access = {
  ok: true,
  userId: "user-1",
  role: "admin",
  workspaceId: "workspace-1",
  source: {
    id: "source-1",
    workspace_id: "workspace-1",
    type: "telegram",
  },
};

describe("Telegram subscriber source routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAccess.mockResolvedValue(access);
    mockImportCsv.mockResolvedValue({
      batchId: "batch-1",
      insertedRows: 1,
      updatedRows: 0,
      summary: {
        totalRows: 1,
        validRows: 1,
        invalidRows: 0,
        duplicateRows: 0,
      },
      errors: [],
    });
    mockListSubscribers.mockResolvedValue([
      {
        chatId: "123",
        sourceId: "source-1",
        status: "imported",
        origin: "import",
        displayName: "Ada",
      },
    ]);
    mockCountSubscribers.mockResolvedValue(1);
    mockGetLatestImportBatch.mockResolvedValue({
      status: "completed",
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      duplicateRows: 0,
      insertedRows: 1,
      updatedRows: 0,
    });
    mockBuildCsv.mockReturnValue("chat_id,source_id\n123,source-1");
  });

  it("requires one-time attestation before importing CSV subscribers", async () => {
    const response = await importSubscribers(
      new Request(
        "http://localhost/api/sources/telegram/source-1/subscribers/import",
        {
          method: "POST",
          body: "chat_id\n123",
        }
      ),
      { params: Promise.resolve({ sourceId: "source-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/attestation is required/i);
    expect(mockImportCsv).not.toHaveBeenCalled();
  });

  it("imports source-scoped CSV subscribers when attestation is present", async () => {
    const response = await importSubscribers(
      new Request(
        "http://localhost/api/sources/telegram/source-1/subscribers/import",
        {
          method: "POST",
          headers: {
            "x-telegram-subscriber-import-attestation": "true",
            "x-import-file-name": "old-platform.csv",
          },
          body: "chat_id\n123",
        }
      ),
      { params: Promise.resolve({ sourceId: "source-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.validRows).toBe(1);
    expect(mockRequireAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "source-1", requireAdmin: true })
    );
    expect(mockImportCsv).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      csv: "chat_id\n123",
      importedBy: "user-1",
      fileName: "old-platform.csv",
    });
  });

  it("exports known subscribers as attachment CSV", async () => {
    const response = await exportSubscribers(
      new Request(
        "http://localhost/api/sources/telegram/source-1/subscribers/export?workspaceId=workspace-1"
      ),
      { params: Promise.resolve({ sourceId: "source-1" }) }
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      "telegram-subscribers-source-1.csv"
    );
    expect(body).toBe("chat_id,source_id\n123,source-1");
    expect(mockListSubscribers).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      limit: 1000,
    });
    expect(mockScheduleBackfill).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      reason: "telegram_subscriber_export",
    });
  });

  it("returns a source-scoped subscriber list", async () => {
    const response = await listSubscribers(
      new Request(
        "http://localhost/api/sources/telegram/source-1/subscribers?workspaceId=workspace-1&limit=20"
      ),
      { params: Promise.resolve({ sourceId: "source-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.subscribers).toEqual([
      expect.objectContaining({
        chatId: "123",
        status: "imported",
        origin: "import",
      }),
    ]);
    expect(payload.total).toBe(1);
    expect(payload.latestImport).toEqual(
      expect.objectContaining({ status: "completed", validRows: 1 })
    );
    expect(mockListSubscribers).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      search: "",
      limit: 20,
    });
    expect(mockCountSubscribers).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      search: "",
    });
    expect(mockScheduleBackfill).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      reason: "telegram_subscriber_list",
    });
  });

  it("returns the access helper response when source ownership fails", async () => {
    mockRequireAccess.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await listSubscribers(
      new Request(
        "http://localhost/api/sources/telegram/source-1/subscribers?workspaceId=other"
      ),
      { params: Promise.resolve({ sourceId: "source-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("Forbidden");
    expect(mockListSubscribers).not.toHaveBeenCalled();
  });
});
