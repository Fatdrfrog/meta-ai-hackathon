/** @jest-environment node */
const mockReadHistory = jest.fn();
const mockCreateClient = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/whatsapp/contact/sync", () => ({
  requestWhatsAppContactSync: jest.fn(),
}));
jest.mock("@/lib/whatsapp/history-sync", () => ({
  requestWhatsAppHistorySync: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: jest.fn(),
}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => value,
}));
jest.mock("@icecore/airi-runtime/whatsapp-history-import-store", () => ({
  readWhatsAppHistorySyncState: (input: unknown) => mockReadHistory(input),
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

describe("history sync status projection", () => {
  let source: { id: string; credentials: Record<string, unknown> };
  let member: boolean;
  const session = {
    session_id: "session-1",
    session_started_at: "2026-10-10T11:00:00Z",
  };
  const request = () =>
    new NextRequest(
      "https://airi.chat/api/whatsapp/smb-app-data?workspaceId=workspace-1"
    );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-10-10T12:00:00Z"));
    member = true;
    source = {
      id: "source-1",
      credentials: { coexistence_mode: true, history_sync: session },
    };
    mockReadHistory.mockResolvedValue(session);
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: (table: string) => {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({
            data:
              table === "company_users"
                ? member
                  ? { role: "admin" }
                  : null
                : source,
            error: null,
          }),
        };
        return query;
      },
    });
  });
  afterEach(() => jest.useRealTimers());

  it("projects durable pending work instead of trusting saved completion", async () => {
    source.credentials.history_sync = {
      ...session,
      status: "completed",
      requested_at: "2026-10-10T11:01:00Z",
    };
    mockReadHistory.mockResolvedValue({
      ...session,
      requested_at: "2026-10-10T11:01:00Z",
      status: "in_progress",
      counts_verified: true,
      synchronized_count_total: 41,
      pending_count_total: 1,
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        history_sync: {
          status: "in_progress",
          synchronized_count_total: 41,
          pending_count_total: 1,
        },
        history_sync_can_request: false,
        history_sync_request_reason: "already_requested",
      },
    });
    expect(mockReadHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    );
  });

  it("returns explicit availability for an unclaimed future session", async () => {
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      data: {
        history_sync_can_request: true,
        history_sync_request_reason: "ready",
      },
    });
  });

  it("reads a legacy source without enrolling or querying its old receipts", async () => {
    source.credentials.history_sync = {
      requested_at: "2026-05-03T10:00:00Z",
      status: "completed",
    };
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      data: {
        history_sync: source.credentials.history_sync,
        history_sync_can_request: false,
      },
    });
    expect(mockReadHistory).not.toHaveBeenCalled();
  });

  it("reports projection unavailability rather than returning stale completed state", async () => {
    const errorLog = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockReadHistory.mockRejectedValue(new Error("database unavailable"));
    try {
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "history_sync_status_unavailable",
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("authorizes workspace membership before reading any import receipts", async () => {
    member = false;
    expect((await GET(request())).status).toBe(403);
    expect(mockReadHistory).not.toHaveBeenCalled();
  });
});
