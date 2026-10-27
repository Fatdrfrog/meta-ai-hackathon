const mockPostJson = jest.fn();
const mockGetJson = jest.fn();

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: jest.fn((value: unknown) =>
    typeof value === "string" ? value : null
  ),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  MetaGraphRequestError: class MetaGraphRequestError extends Error {},
  getWhatsAppGraphClient: jest.fn(() => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
    postJson: (...args: unknown[]) => mockPostJson(...args),
  })),
}));

import { requestWhatsAppContactSync } from "@/lib/whatsapp/contact/sync";

describe("requestWhatsAppContactSync", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      META_APP_ID: "app-1",
      NEXT_PUBLIC_META_APP_ID: "app-1",
      META_APP_SECRET: "app-secret",
    };
    mockGetJson.mockResolvedValue({
      data: [
        {
          id: "app-1",
          whatsapp_business_api_data: {
            subscribed_fields: [
              "history",
              "smb_app_state_sync",
              "smb_message_echoes",
            ],
          },
        },
      ],
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("requests smb_app_state_sync and persists contact sync state without dropping history sync", async () => {
    mockPostJson.mockResolvedValue({ request_id: "contact-sync-1" });
    let savedCredentials: Record<string, unknown> | null = null;

    const result = await requestWhatsAppContactSync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
        history_sync: {
          requested_at: "2026-01-01T00:00:00.000Z",
          status: "requested",
        },
      },
      saveCredentials: async nextCredentials => {
        savedCredentials = nextCredentials;
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: true,
        requested: true,
        skipped: false,
        requestId: "contact-sync-1",
      })
    );
    expect(mockPostJson).toHaveBeenCalledWith("phone-1/smb_app_data", {
      token: "token-1",
      body: {
        messaging_product: "whatsapp",
        sync_type: "smb_app_state_sync",
      },
    });
    expect(savedCredentials).toEqual(
      expect.objectContaining({
        history_sync: {
          requested_at: "2026-01-01T00:00:00.000Z",
          status: "requested",
        },
        contact_sync: expect.objectContaining({
          requested_at: expect.any(String),
          request_id: "contact-sync-1",
          status: "requested",
          processed_count_total: 0,
          skipped_count_total: 0,
          webhook_count: 0,
        }),
      })
    );
  });

  it("skips when contact sync was already requested", async () => {
    const result = await requestWhatsAppContactSync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
        contact_sync: {
          requested_at: "2026-01-01T00:00:00.000Z",
          request_id: "existing-request",
        },
      },
      saveCredentials: jest.fn(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: false,
        requested: false,
        skipped: true,
        reason: "already_requested",
        requestId: "existing-request",
      })
    );
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("does not request contact sync for non-coexistence credentials", async () => {
    const result = await requestWhatsAppContactSync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
      },
      saveCredentials: jest.fn(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: false,
        requested: false,
        skipped: true,
        reason: "not_coexistence",
      })
    );
    expect(mockPostJson).not.toHaveBeenCalled();
  });
});
