const mockFrom = jest.fn();
const mockGetReconnectStatus = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

jest.mock("@/lib/whatsapp/reconnect-status", () => ({
  getWhatsAppReconnectStatus: (...args: unknown[]) =>
    mockGetReconnectStatus(...args),
}));

jest.mock("./reconnect-banner-client", () => ({
  WhatsAppReconnectBannerClient: () => null,
}));

import { WhatsAppReconnectBanner } from "./reconnect-banner";

function maybeSingleQuery(data: unknown) {
  const maybeSingle = jest.fn().mockResolvedValue({ data, error: null });
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

describe("WhatsAppReconnectBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        return maybeSingleQuery({ role: "admin" });
      }
      if (table === "workspaces") {
        return maybeSingleQuery({ company_id: "company-1" });
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    mockGetReconnectStatus.mockResolvedValue({
      state: "healthy",
      daysUntilExpiry: 30,
      reconnectMethod: "embedded",
    });
  });

  it("keeps the live status client mounted while the connection is healthy", async () => {
    const result = await WhatsAppReconnectBanner({
      workspaceId: "workspace-1",
      userId: "user-1",
    });

    expect(result).not.toBeNull();
    expect(result?.props).toMatchObject({
      workspaceId: "workspace-1",
      companyId: "company-1",
    });
  });

  it("reads the workspace while the reconnect status is still loading", async () => {
    let resolveStatus!: (value: unknown) => void;
    mockGetReconnectStatus.mockReturnValueOnce(
      new Promise(resolve => {
        resolveStatus = resolve;
      })
    );

    const banner = WhatsAppReconnectBanner({
      workspaceId: "workspace-1",
      userId: "user-1",
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(mockFrom).toHaveBeenCalledWith("workspaces");

    resolveStatus({
      state: "expiring",
      daysUntilExpiry: 3,
      reconnectMethod: "embedded",
    });
    expect((await banner)?.props).toMatchObject({ companyId: "company-1" });
  });

  describe("when the workspaces read fails", () => {
    const unhandled = jest.fn();

    beforeEach(() => {
      process.on("unhandledRejection", unhandled);
      mockFrom.mockImplementation((table: string) => {
        if (table === "company_users") {
          return maybeSingleQuery({ role: "admin" });
        }
        const query = maybeSingleQuery(null);
        query.maybeSingle.mockRejectedValue(new Error("workspaces offline"));
        return query;
      });
    });

    afterEach(() => {
      process.off("unhandledRejection", unhandled);
    });

    async function flushAsyncWork() {
      for (let round = 0; round < 5; round += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    it("renders nothing for a workspace without WhatsApp and leaves no unhandled rejection", async () => {
      mockGetReconnectStatus.mockResolvedValueOnce({
        state: "not_connected",
        daysUntilExpiry: null,
        reconnectMethod: "unknown",
      });

      await expect(
        WhatsAppReconnectBanner({ workspaceId: "workspace-1", userId: "u-1" })
      ).resolves.toBeNull();
      await flushAsyncWork();
      expect(mockFrom).toHaveBeenCalledWith("workspaces");
      expect(unhandled).not.toHaveBeenCalled();
    });

    it("fails with the status error alone when the status lookup fails too", async () => {
      const statusFailure = new Error("status offline");
      mockGetReconnectStatus.mockRejectedValueOnce(statusFailure);

      await expect(
        WhatsAppReconnectBanner({ workspaceId: "workspace-1", userId: "u-1" })
      ).rejects.toBe(statusFailure);
      await flushAsyncWork();
      expect(unhandled).not.toHaveBeenCalled();
    });

    it("still fails a connected banner, as the sequential read did", async () => {
      await expect(
        WhatsAppReconnectBanner({ workspaceId: "workspace-1", userId: "u-1" })
      ).rejects.toThrow("workspaces offline");
      await flushAsyncWork();
      expect(unhandled).not.toHaveBeenCalled();
    });
  });

  it("renders nothing without a WhatsApp source", async () => {
    mockGetReconnectStatus.mockResolvedValueOnce({
      state: "not_connected",
      daysUntilExpiry: null,
      reconnectMethod: "unknown",
    });

    await expect(
      WhatsAppReconnectBanner({ workspaceId: "workspace-1", userId: "user-1" })
    ).resolves.toBeNull();
  });

  it("reads the reconnect status for a manager", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "company_users")
        return maybeSingleQuery({ role: "manager" });
      if (table === "workspaces") {
        return maybeSingleQuery({ company_id: "company-1" });
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await WhatsAppReconnectBanner({
      workspaceId: "workspace-1",
      userId: "user-1",
    });

    expect(mockGetReconnectStatus).toHaveBeenCalledWith("workspace-1");
  });

  it.each(["owner", "member", "agent"])(
    "stays hidden from the unknown role %s without reading anything else",
    async role => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "company_users") return maybeSingleQuery({ role });
        throw new Error(`Unexpected table: ${table}`);
      });

      await expect(
        WhatsAppReconnectBanner({
          workspaceId: "workspace-1",
          userId: "user-1",
        })
      ).resolves.toBeNull();
      expect(mockGetReconnectStatus).not.toHaveBeenCalled();
    }
  );
});
