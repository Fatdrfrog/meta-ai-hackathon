const mockGetWorkspaceEmailSource = jest.fn();
const mockGetWorkspaceEmailSourceResult = jest.fn();
const mockResolveEmailProviderForWorkspaceSource = jest.fn();
const mockResolveEmailProviderForWorkspaceSourceResult = jest.fn();
const mockGetWorkspaceEmailProviderConfig = jest.fn();
const mockGetWorkspaceEmailProviderConfigResult = jest.fn();
const mockIsManagedEmailProviderPending = jest.fn();

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  getWorkspaceEmailSourceResult: (...args: unknown[]) =>
    mockGetWorkspaceEmailSourceResult(...args),
  resolveEmailProviderForWorkspaceSource: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSource(...args),
  resolveEmailProviderForWorkspaceSourceResult: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSourceResult(...args),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfig(...args),
  getWorkspaceEmailProviderConfigResult: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfigResult(...args),
  isManagedEmailProviderPending: (...args: unknown[]) =>
    mockIsManagedEmailProviderPending(...args),
}));

import {
  filterEmailUnsubscribedRecipients,
  resolveBulkCampaignAppBaseUrl,
  resolveEmailBulkSendContext,
  resolveEmailBulkSendContextStrict,
} from "./email-bulk-preflight";

const activeProviderConfig = {
  id: "provider-1",
  workspaceId: "workspace-1",
  provider: "postmark" as const,
  postmarkServerToken: "postmark-token",
  transactionalStream: "outbound",
  broadcastStream: "broadcast",
  defaultFromAddress: "updates@airi.chat",
  webhookToken: "webhook-token",
  mode: "manual" as const,
  verificationStatus: "verified" as const,
  managedState: null,
  status: "active" as const,
};

function createUnsubscribeStore(unsubscribedEmails: string[]) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          in: jest.fn().mockResolvedValue({
            data: unsubscribedEmails.map(email => ({ email })),
            error: null,
          }),
        })),
      })),
    })),
  };
}

describe("filterEmailUnsubscribedRecipients", () => {
  it("excludes unsubscribed addresses after normalizing their casing and whitespace", async () => {
    const result = await filterEmailUnsubscribedRecipients({
      supabase: createUnsubscribeStore(["blocked@example.com"]),
      workspaceId: "workspace-1",
      recipients: [
        { email: " Allowed@Example.com " },
        { email: " BLOCKED@Example.COM " },
        { name: "No email supplied" },
      ],
    });

    expect(result).toEqual({
      recipients: [
        { email: " Allowed@Example.com " },
        { name: "No email supplied" },
      ],
      skippedUnsubscribed: 1,
      skippedRecipientDetails: [
        { reason: "email_unsubscribed", detail: "blocked@example.com" },
      ],
    });
  });
});

describe("resolveEmailBulkSendContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkspaceEmailSource.mockResolvedValue({
      id: "email-source-1",
      workspace_id: "workspace-1",
      type: "email",
    });
    mockGetWorkspaceEmailSourceResult.mockResolvedValue({
      ok: true,
      source: {
        id: "email-source-1",
        workspace_id: "workspace-1",
        type: "email",
      },
    });
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(
      activeProviderConfig
    );
    mockResolveEmailProviderForWorkspaceSourceResult.mockResolvedValue({
      ok: true,
      providerConfig: activeProviderConfig,
    });
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue(null);
    mockGetWorkspaceEmailProviderConfigResult.mockResolvedValue({
      ok: true,
      providerConfig: null,
    });
    mockIsManagedEmailProviderPending.mockReturnValue(false);
  });

  it("returns the exact source, active provider, and canonical sender", async () => {
    await expect(
      resolveEmailBulkSendContext({ workspaceId: "workspace-1" })
    ).resolves.toEqual({
      ok: true,
      sourceId: "email-source-1",
      providerConfig: activeProviderConfig,
      fromAddress: "updates@airi.chat",
    });
  });

  it("reports managed provider verification as pending", async () => {
    mockIsManagedEmailProviderPending.mockReturnValue(true);

    await expect(
      resolveEmailBulkSendContext({ workspaceId: "workspace-1" })
    ).resolves.toEqual({
      ok: false,
      code: "email_provider_verification_pending",
      error:
        "email_provider_verification_pending: Verify DNS in Settings > Integrations > Email before sending campaigns.",
    });
  });

  it("reports a configured but inactive provider", async () => {
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue({
      ...activeProviderConfig,
      status: "inactive",
    });

    await expect(
      resolveEmailBulkSendContext({ workspaceId: "workspace-1" })
    ).resolves.toEqual({
      ok: false,
      code: "email_provider_inactive",
      error: "Email provider is inactive for this workspace.",
    });
  });

  it("reports a workspace without an email provider as unconfigured", async () => {
    mockGetWorkspaceEmailSource.mockResolvedValue(null);
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(null);

    await expect(
      resolveEmailBulkSendContext({ workspaceId: "workspace-1" })
    ).resolves.toEqual({
      ok: false,
      code: "email_source_not_configured",
      error:
        "Email source is not configured for this workspace. Connect email in Settings > Integrations first.",
    });
  });

  it("strictly distinguishes source query failure from confirmed missing configuration", async () => {
    const queryError = new Error("sources query unavailable");
    mockGetWorkspaceEmailSourceResult.mockResolvedValue({
      ok: false,
      error: queryError,
    });

    await expect(
      resolveEmailBulkSendContextStrict({ workspaceId: "workspace-1" })
    ).resolves.toEqual({
      ok: false,
      kind: "query_error",
      code: "email_source_query_failed",
      error: queryError,
    });

    mockGetWorkspaceEmailSourceResult.mockResolvedValue({
      ok: true,
      source: null,
    });
    mockGetWorkspaceEmailProviderConfigResult.mockResolvedValue({
      ok: true,
      providerConfig: null,
    });
    await expect(
      resolveEmailBulkSendContextStrict({ workspaceId: "workspace-1" })
    ).resolves.toMatchObject({
      ok: false,
      kind: "unavailable",
      code: "email_source_not_configured",
    });
  });

  it("strictly surfaces provider query failures", async () => {
    const queryError = new Error("provider query unavailable");
    mockResolveEmailProviderForWorkspaceSourceResult.mockResolvedValue({
      ok: false,
      error: queryError,
    });

    await expect(
      resolveEmailBulkSendContextStrict({ workspaceId: "workspace-1" })
    ).resolves.toEqual({
      ok: false,
      kind: "query_error",
      code: "email_provider_query_failed",
      error: queryError,
    });
  });
});

describe("resolveBulkCampaignAppBaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.APP_URL;
    delete process.env.VERCEL_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("prefers the configured application origin over the request host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.airi.chat/path";

    expect(
      resolveBulkCampaignAppBaseUrl(
        "https://preview.example.com/panel/w/workspace-1"
      )
    ).toBe("https://app.airi.chat");
  });

  it("falls back through the request origin when configured values are invalid", () => {
    process.env.APP_URL = "not a URL";

    expect(
      resolveBulkCampaignAppBaseUrl(
        "https://preview.example.com/panel/w/workspace-1"
      )
    ).toBe("https://preview.example.com");
    expect(resolveBulkCampaignAppBaseUrl("not a URL")).toBe(
      "https://app.airi.chat"
    );
  });
});
