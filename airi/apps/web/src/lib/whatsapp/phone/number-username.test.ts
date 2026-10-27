const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: jest.fn(() => mockLogger),
}));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(),
}));
const mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot = jest.fn();
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentialsFromSnapshot: (...args: unknown[]) =>
    mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot(...args),
}));
jest.mock("@/lib/whatsapp/source-resolver", () => ({
  resolveWhatsAppSourceByAccountIdentifiers: jest.fn(),
}));

const { resolveWhatsAppSourceByAccountIdentifiers } = jest.requireMock(
  "@/lib/whatsapp/source-resolver"
) as typeof import("@/lib/whatsapp/source-resolver");
const { handlePhoneNumberUsernameUpdate } = jest.requireActual(
  "./number-username"
) as typeof import("./number-username");

function mockSourceUpdate() {
  mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot.mockResolvedValue({
    credentials: {},
  });
  (resolveWhatsAppSourceByAccountIdentifiers as jest.Mock).mockResolvedValue({
    id: "source-1",
    workspace_id: "workspace-1",
    credentials: {
      waba_id: "waba-1",
      business_username: {
        username: "old_username",
        status: "pending",
      },
    },
  });
}

describe("handlePhoneNumberUsernameUpdate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists business_username_updates payload aliases into source credentials", async () => {
    mockSourceUpdate();

    await handlePhoneNumberUsernameUpdate({
      wabaId: "waba-1",
      value: {
        phone_number_id: "phone-1",
        business_username: "airi_support",
        requested_business_username: "airi_support",
        username_review_status: "approved",
      },
    });

    expect(
      mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        currentCredentials: expect.objectContaining({
          waba_id: "waba-1",
        }),
        nextCredentials: expect.objectContaining({
          business_username: expect.objectContaining({
            username: "airi_support",
            requested_username: "airi_support",
            status: "approved",
            phone_number_id: "phone-1",
          }),
        }),
      })
    );
  });
});

export {};
