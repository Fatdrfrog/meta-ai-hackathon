const mockFindById = jest.fn();
const mockGetWorkspaceEmailSource = jest.fn();
const mockResolveEmailProviderForWorkspaceSource = jest.fn();
const mockGetWorkspaceEmailProviderConfig = jest.fn();
const mockIsManagedEmailProviderPending = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/mongo", () => ({ ensureIndexes: jest.fn() }));
jest.mock("@/lib/postmark", () => ({ postmarkSendEmail: jest.fn() }));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: jest.fn(),
}));
jest.mock("@/lib/email/threading", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findById: (...args: unknown[]) => mockFindById(...args) },
}));
jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  resolveEmailProviderForWorkspaceSource: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSource(...args),
}));
jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfig(...args),
  isManagedEmailProviderPending: (...args: unknown[]) =>
    mockIsManagedEmailProviderPending(...args),
}));

import {
  buildEmailReplyHeaders,
  resolveActiveEmailProvider,
} from "@/lib/email/send-email";

describe("resolveActiveEmailProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkspaceEmailSource.mockResolvedValue({ id: "source-1" });
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(null);
    mockIsManagedEmailProviderPending.mockReturnValue(false);
  });

  it("returns the active provider and its source", async () => {
    const providerConfig = { status: "active" };
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue(providerConfig);

    await expect(resolveActiveEmailProvider("workspace-1")).resolves.toEqual({
      ok: true,
      providerConfig,
      sourceId: "source-1",
    });
  });

  it.each([
    [null, false, "email_provider_missing"],
    [{ status: "active" }, true, "email_provider_verification_pending"],
    [{ status: "disabled" }, false, "email_provider_inactive"],
  ])(
    "refuses provider %j (pending=%s) with %s",
    async (providerConfig, pending, code) => {
      mockGetWorkspaceEmailProviderConfig.mockResolvedValue(providerConfig);
      mockIsManagedEmailProviderPending.mockReturnValue(pending);

      await expect(
        resolveActiveEmailProvider("workspace-1")
      ).resolves.toMatchObject({ ok: false, code });
    }
  );
});

describe("buildEmailReplyHeaders", () => {
  beforeEach(() => jest.clearAllMocks());

  it("threads onto the original message id and its references", async () => {
    mockFindById.mockResolvedValue({
      external_ids: { messageId: "<b@mail>" },
      headers: { References: "<a@mail>" },
    });

    await expect(buildEmailReplyHeaders("message-1")).resolves.toEqual({
      "In-Reply-To": "<b@mail>",
      References: "<a@mail> <b@mail>",
    });
  });

  it("falls back to the stored messageId", async () => {
    mockFindById.mockResolvedValue({ messageId: "<c@mail>" });

    await expect(buildEmailReplyHeaders("message-1")).resolves.toEqual({
      "In-Reply-To": "<c@mail>",
      References: "<c@mail>",
    });
  });

  it("adds nothing without a message to reply to", async () => {
    await expect(buildEmailReplyHeaders(undefined)).resolves.toEqual({});
    expect(mockFindById).not.toHaveBeenCalled();
  });
});
