const mockGetWorkspaceEmailProviderStatus = jest.fn();
const mockGetWorkspaceEmailSource = jest.fn();

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderStatus: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderStatus(...args),
}));

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  getEmailSourceConnectionStatus: jest.requireActual("@/lib/email/email-source")
    .getEmailSourceConnectionStatus,
}));

import { getWorkspaceEmailConnectionStatus } from "./workspace-email-connection";

describe("getWorkspaceEmailConnectionStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("treats a connected provider as connected even without active address rows", async () => {
    mockGetWorkspaceEmailProviderStatus.mockResolvedValue("connected");
    mockGetWorkspaceEmailSource.mockResolvedValue({
      id: "email-source-1",
      workspace_id: "41b51d55-697c-4455-875a-9a7238bdf272",
      type: "email",
      credentials: {
        email_address: "team@airi.chat",
        provider_id: "provider-1",
        status: "active",
        verification_status: "connected",
        address_ids: [],
      },
    });

    await expect(
      getWorkspaceEmailConnectionStatus("41b51d55-697c-4455-875a-9a7238bdf272")
    ).resolves.toEqual({
      connected: true,
      providerStatus: "connected",
      activeAddressCount: 0,
    });
  });
});
