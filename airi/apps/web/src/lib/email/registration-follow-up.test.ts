const mockPostmarkSendEmail = jest.fn();
const mockGetWorkspaceEmailProviderConfig = jest.fn();
const mockIsManagedEmailProviderPending = jest.fn();
const mockGetWorkspaceEmailSource = jest.fn();
const mockResolveEmailProviderForWorkspaceSource = jest.fn();

jest.mock("@/lib/postmark", () => ({
  postmarkSendEmail: (...args: unknown[]) => mockPostmarkSendEmail(...args),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfig(...args),
  isManagedEmailProviderPending: (...args: unknown[]) =>
    mockIsManagedEmailProviderPending(...args),
}));

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  resolveEmailProviderForWorkspaceSource: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSource(...args),
}));

import { sendRegistrationFollowUpEmail } from "./registration-follow-up";

const ORIGINAL_ENV = process.env;

describe("sendRegistrationFollowUpEmail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue(null);
    mockIsManagedEmailProviderPending.mockReturnValue(false);
    mockGetWorkspaceEmailSource.mockResolvedValue(null);
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(null);
    process.env = { ...ORIGINAL_ENV };
    delete process.env.POSTMARK_LIFECYCLE_SERVER_TOKEN;
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.POSTMARK_API_KEY;
    delete process.env.POSTMARK_LIFECYCLE_FROM_EMAIL;
    delete process.env.POSTMARK_FROM_EMAIL;
    delete process.env.POSTMARK_LIFECYCLE_STREAM;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("sends through the workspace Postmark provider when it is configured", async () => {
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue({
      postmarkServerToken: "workspace-server-token",
      defaultFromAddress: "team@airi.chat",
      transactionalStream: "outbound",
      status: "active",
      mode: "platform_managed",
    });
    mockPostmarkSendEmail.mockResolvedValue({ MessageID: "pm-message-1" });

    const result = await sendRegistrationFollowUpEmail({
      userId: "user-1",
      userEmail: "Samat@Airi.Chat",
      userName: "Samat",
      companyId: "company-1",
      workspaceId: "workspace-1",
      workspaceName: "Acme Support",
    });

    expect(result).toEqual({
      ok: true,
      providerMessageId: "pm-message-1",
    });
    expect(mockGetWorkspaceEmailProviderConfig).toHaveBeenCalledWith(
      "workspace-1",
      true
    );
    expect(mockPostmarkSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        serverToken: "workspace-server-token",
        from: "team@airi.chat",
        to: ["samat@airi.chat"],
        messageStream: "outbound",
      })
    );
  });

  it("can use a sender workspace while rendering links for the created workspace", async () => {
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue({
      postmarkServerToken: "airi-workspace-token",
      defaultFromAddress: "team@airi.chat",
      transactionalStream: "outbound",
      status: "active",
      mode: "platform_managed",
    });
    process.env.NEXT_PUBLIC_APP_URL = "https://app.airi.chat";
    mockPostmarkSendEmail.mockResolvedValue({ MessageID: "pm-message-1" });

    const result = await sendRegistrationFollowUpEmail({
      userId: "user-1",
      userEmail: "founder@example.com",
      userName: "Founder",
      companyId: "company-1",
      workspaceId: "created-workspace-1",
      senderWorkspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
      workspaceName: "Created Company",
    });

    expect(result).toEqual({
      ok: true,
      providerMessageId: "pm-message-1",
    });
    expect(mockGetWorkspaceEmailSource).toHaveBeenCalledWith(
      "41b51d55-697c-4455-875a-9a7238bdf272"
    );
    expect(mockGetWorkspaceEmailProviderConfig).toHaveBeenCalledWith(
      "41b51d55-697c-4455-875a-9a7238bdf272",
      true
    );
    const payload = mockPostmarkSendEmail.mock.calls[0][0];
    expect(payload.from).toBe("team@airi.chat");
    expect(payload.html).toContain(
      'href="https://app.airi.chat/panel/w/created-workspace-1/settings/integrations?new=true&amp;integration=whatsapp"'
    );
    expect(payload.text).toContain(
      "https://app.airi.chat/panel/w/created-workspace-1/settings/integrations?new=true&integration=whatsapp"
    );
    expect(payload.headers).toEqual(
      expect.objectContaining({
        "X-Airi-Workspace-Id": "created-workspace-1",
        "X-Airi-Sender-Workspace-Id": "41b51d55-697c-4455-875a-9a7238bdf272",
      })
    );
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("sends the registration follow-up through the platform Postmark sender", async () => {
    process.env.POSTMARK_LIFECYCLE_SERVER_TOKEN = "lifecycle-token";
    process.env.POSTMARK_LIFECYCLE_FROM_EMAIL = "welcome@airi.chat";
    process.env.POSTMARK_LIFECYCLE_STREAM = "outbound";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.airi.chat";
    mockPostmarkSendEmail.mockResolvedValue({ MessageID: "pm-message-1" });

    const result = await sendRegistrationFollowUpEmail({
      userId: "user-1",
      userEmail: "Founder@Example.COM",
      userName: " Founder ",
      companyId: "company-1",
      workspaceId: "workspace-1",
      workspaceName: "Acme Support",
    });

    expect(result).toEqual({
      ok: true,
      providerMessageId: "pm-message-1",
    });
    expect(mockPostmarkSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        serverToken: "lifecycle-token",
        from: "welcome@airi.chat",
        to: ["founder@example.com"],
        subject: "Welcome to airi.chat",
        messageStream: "outbound",
      })
    );
    const payload = mockPostmarkSendEmail.mock.calls[0][0];
    expect(payload.html).toContain("Founder");
    expect(payload.html).toContain("Acme Support");
    expect(payload.html).toContain(
      'href="https://app.airi.chat/panel/w/workspace-1/settings/integrations?new=true&amp;integration=whatsapp"'
    );
    expect(payload.text).toContain(
      "Continue setup (https://app.airi.chat/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp)"
    );
  });

  it("uses a custom markdown template when provided", async () => {
    process.env.POSTMARK_LIFECYCLE_SERVER_TOKEN = "lifecycle-token";
    process.env.POSTMARK_LIFECYCLE_FROM_EMAIL = "welcome@airi.chat";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.airi.chat";
    mockPostmarkSendEmail.mockResolvedValue({ MessageID: "pm-message-1" });

    await sendRegistrationFollowUpEmail({
      userId: "user-1",
      userEmail: "founder@example.com",
      userName: "Founder",
      companyId: "company-1",
      workspaceId: "workspace-1",
      workspaceName: "Acme Support",
      template: {
        subject: "Start with {{workspaceName}}",
        markdown:
          "# Hi {{userName}}\n\nYour **{{workspaceName}}** workspace is ready.\n\n[Open setup]({{setupUrl}})",
      },
    });

    const payload = mockPostmarkSendEmail.mock.calls[0][0];
    expect(payload.subject).toBe("Start with Acme Support");
    expect(payload.html).toContain("<strong>Acme Support</strong>");
    expect(payload.html).toContain("Open setup");
    expect(payload.text).toContain("Your Acme Support workspace is ready.");
  });

  it("skips without throwing when platform email config is missing", async () => {
    const result = await sendRegistrationFollowUpEmail({
      userId: "user-1",
      userEmail: "founder@example.com",
      userName: null,
      companyId: "company-1",
      workspaceId: "workspace-1",
      workspaceName: "Acme Support",
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(mockPostmarkSendEmail).not.toHaveBeenCalled();
  });
});
