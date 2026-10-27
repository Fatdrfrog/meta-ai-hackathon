import {
  buildHiggsfieldAuthKeyFromCredentials,
  isAiriChatHiggsfieldPlatformWorkspace,
  resolveHiggsfieldAuthKeyForWorkspace,
} from "./higgsfield-source";

describe("Higgsfield source access helpers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AIRI_CHAT_HIGGSFIELD_COMPANY_IDS;
    delete process.env.AIRI_CHAT_HIGGSFIELD_WORKSPACE_IDS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects a deleted explicit source before considering platform credentials", async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const from = jest.fn(() => query);
    await expect(
      resolveHiggsfieldAuthKeyForWorkspace({
        supabase: { from } as never,
        workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
        sourceId: "deleted-source",
      })
    ).rejects.toThrow(/source is unavailable/);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("sources");
  });

  it("builds an API auth key from connected source credentials", () => {
    expect(
      buildHiggsfieldAuthKeyFromCredentials({
        api_key: " key-1 ",
        api_secret: " secret-1 ",
      })
    ).toBe("key-1:secret-1");
  });

  it("allows platform Higgsfield credentials only for the Airi.chat workspace/company allowlist", () => {
    expect(
      isAiriChatHiggsfieldPlatformWorkspace({
        workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
        workspaceCompanyId: "customer-company",
        joinedCompanyId: null,
      })
    ).toBe(true);

    expect(
      isAiriChatHiggsfieldPlatformWorkspace({
        workspaceId: "customer-workspace",
        workspaceCompanyId: "d81123b4-b2fa-49d3-86af-25b4482b8269",
        joinedCompanyId: null,
      })
    ).toBe(true);

    expect(
      isAiriChatHiggsfieldPlatformWorkspace({
        workspaceId: "customer-workspace",
        workspaceCompanyId: "customer-company",
        joinedCompanyId: "customer-company",
      })
    ).toBe(false);
  });
});
