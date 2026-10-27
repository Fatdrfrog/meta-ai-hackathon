const mockAuthGetUser = jest.fn();
const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetWorkspaceMembershipRole = jest.fn();
const mockGetWorkspaceEmailConnectionStatus = jest.fn();
const mockGetWorkspaceEmailAutomationSettings = jest.fn();
const mockUpsertWorkspaceEmailAutomationSettings = jest.fn();
const mockSendRegistrationFollowUpEmail = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/email/provider-auth", () => ({
  canManageEmailProvider: jest.requireActual("@/lib/email/provider-auth")
    .canManageEmailProvider,
  getWorkspaceMembershipRole: (...args: unknown[]) =>
    mockGetWorkspaceMembershipRole(...args),
}));

jest.mock("@/lib/email/workspace-email-connection", () => ({
  getWorkspaceEmailConnectionStatus: (...args: unknown[]) =>
    mockGetWorkspaceEmailConnectionStatus(...args),
}));

jest.mock("@/lib/email/email-automation-settings", () => ({
  getWorkspaceEmailAutomationSettings: (...args: unknown[]) =>
    mockGetWorkspaceEmailAutomationSettings(...args),
  upsertWorkspaceEmailAutomationSettings: (...args: unknown[]) =>
    mockUpsertWorkspaceEmailAutomationSettings(...args),
}));

jest.mock("@/lib/email/registration-follow-up", () => ({
  sendRegistrationFollowUpEmail: (...args: unknown[]) =>
    mockSendRegistrationFollowUpEmail(...args),
}));

import { GET, POST, PUT } from "./route";

const params = Promise.resolve({ workspaceId: "workspace-1" });

describe("/api/workspaces/[workspaceId]/email-automation", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: mockAuthGetUser,
      },
    });
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceMembershipRole.mockResolvedValue("admin");
    mockGetWorkspaceEmailConnectionStatus.mockResolvedValue({
      connected: true,
      providerStatus: "connected",
      activeAddressCount: 1,
    });
    mockGetWorkspaceEmailAutomationSettings.mockResolvedValue({
      workspaceId: "workspace-1",
      registrationFollowUpEnabled: true,
      registrationFollowUpTemplate: {
        subject: "Welcome to airi.chat",
        markdown: "Hi {{userName}}",
      },
      updatedAt: null,
      updatedBy: null,
    });
    mockUpsertWorkspaceEmailAutomationSettings.mockResolvedValue({
      workspaceId: "workspace-1",
      registrationFollowUpEnabled: false,
      registrationFollowUpTemplate: {
        subject: "Welcome, {{userName}}",
        markdown: "# Hi {{userName}}",
      },
      updatedAt: "2026-04-29T00:00:00.000Z",
      updatedBy: "user-1",
    });
    mockSendRegistrationFollowUpEmail.mockResolvedValue({
      ok: true,
      providerMessageId: "pm-message-1",
    });
  });

  it("returns workspace email automation settings with permissions", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workspaces/workspace-1/email-automation"
      ),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      providerStatus: "connected",
      activeAddressCount: 1,
      settings: {
        workspaceId: "workspace-1",
        registrationFollowUpEnabled: true,
        registrationFollowUpTemplate: {
          subject: "Welcome to airi.chat",
          markdown: "Hi {{userName}}",
        },
        updatedAt: null,
        updatedBy: null,
      },
      permissions: { canManage: true },
    });
  });

  it("updates the registration follow-up toggle for admins", async () => {
    const response = await PUT(
      new Request(
        "http://localhost/api/workspaces/workspace-1/email-automation",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registrationFollowUpEnabled: false,
            registrationFollowUpTemplate: {
              subject: "Welcome, {{userName}}",
              markdown: "# Hi {{userName}}",
            },
          }),
        }
      ),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mockUpsertWorkspaceEmailAutomationSettings).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      registrationFollowUpEnabled: false,
      registrationFollowUpTemplate: {
        subject: "Welcome, {{userName}}",
        markdown: "# Hi {{userName}}",
      },
      updatedBy: "user-1",
    });
    await expect(response.json()).resolves.toEqual({
      settings: {
        workspaceId: "workspace-1",
        registrationFollowUpEnabled: false,
        registrationFollowUpTemplate: {
          subject: "Welcome, {{userName}}",
          markdown: "# Hi {{userName}}",
        },
        updatedAt: "2026-04-29T00:00:00.000Z",
        updatedBy: "user-1",
      },
    });
  });

  it("does not update settings before email is connected", async () => {
    mockGetWorkspaceEmailConnectionStatus.mockResolvedValue({
      connected: false,
      providerStatus: "disconnected",
      activeAddressCount: 0,
    });

    const response = await PUT(
      new Request(
        "http://localhost/api/workspaces/workspace-1/email-automation",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationFollowUpEnabled: false }),
        }
      ),
      { params }
    );

    expect(response.status).toBe(409);
    expect(mockUpsertWorkspaceEmailAutomationSettings).not.toHaveBeenCalled();
  });

  it("sends a registration follow-up test email with saved template", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "admin@example.com",
          user_metadata: { full_name: "Admin User" },
        },
      },
    });

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/email-automation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ testEmail: "test@example.com" }),
        }
      ),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mockSendRegistrationFollowUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: "test@example.com",
        userName: "Admin User",
        workspaceId: "workspace-1",
        workspaceName: "workspace-1",
        template: {
          subject: "Welcome to airi.chat",
          markdown: "Hi {{userName}}",
        },
      })
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      providerMessageId: "pm-message-1",
    });
  });
});
