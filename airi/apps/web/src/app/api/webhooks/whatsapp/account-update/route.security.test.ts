import crypto from "crypto";

const mockFrom = jest.fn();
const mockHandleAccountUpdateWebhook = jest.fn(async (..._args: unknown[]) => ({
  ok: true,
}));
const mockUpdateCurrentWhatsAppSourceCredentials = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));
jest.mock("@/lib/whatsapp/account/update-handler", () => ({
  handleAccountUpdateWebhook: (...args: unknown[]) =>
    mockHandleAccountUpdateWebhook(...args),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCurrentWhatsAppSourceCredentials(...args),
}));

import { POST } from "@/app/api/webhooks/whatsapp/account-update/route";

function signPayload(payload: string, secret: string): string {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `sha256=${digest}`;
}

describe("WhatsApp account-update webhook security", () => {
  const previousMode = process.env.META_WEBHOOK_SIGNATURE_MODE;
  const previousSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.META_WEBHOOK_SIGNATURE_MODE = "enforce";
    process.env.META_APP_SECRET = "meta-secret";
    mockHandleAccountUpdateWebhook.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = previousMode;
    process.env.META_APP_SECRET = previousSecret;
  });

  it("returns 401 for invalid signature", async () => {
    const payload = JSON.stringify({});
    const req = new Request(
      "http://localhost/api/webhooks/whatsapp/account-update",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=invalid",
        },
        body: payload,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("accepts valid signature", async () => {
    const payload = JSON.stringify({});
    const req = new Request(
      "http://localhost/api/webhooks/whatsapp/account-update",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, "meta-secret"),
        },
        body: payload,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("updates every matching source even when one independent source write fails", async () => {
    const sources = [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: { waba_id: "waba-1" },
      },
      {
        id: "source-2",
        workspace_id: "workspace-2",
        credentials: { waba_id: "waba-1" },
      },
    ];
    const contains = jest
      .fn()
      .mockResolvedValue({ data: sources, error: null });
    mockFrom.mockReturnValue({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({ contains })),
      })),
    });
    mockUpdateCurrentWhatsAppSourceCredentials.mockImplementation(
      async ({ sourceId }: { sourceId: string }) => {
        if (sourceId === "source-1") throw new Error("write failed");
        return { id: sourceId, credentials: { waba_id: "waba-1" } };
      }
    );
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "account_update",
              value: {
                event: "VERIFIED",
                account_review_status: "APPROVED",
              },
            },
          ],
        },
      ],
    });

    const response = await POST(
      new Request("http://localhost/api/webhooks/whatsapp/account-update", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, "meta-secret"),
        },
        body: payload,
      })
    );

    expect(response.status).toBe(200);
    expect(
      mockUpdateCurrentWhatsAppSourceCredentials.mock.calls.map(
        ([params]) => params.sourceId
      )
    ).toEqual(["source-1", "source-2"]);
    expect(mockHandleAccountUpdateWebhook).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
