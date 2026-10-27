import { createHmac } from "crypto";
const mockSource = jest.fn();
const mockRecord = jest.fn();
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) => mockSource(...args),
}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: () => "test-signing-secret",
}));
jest.mock("@/lib/conversions/commerce-events", () => ({
  CommerceEventError: class extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  },
  recordCommerceEvent: (...args: unknown[]) => mockRecord(...args),
}));
import { POST } from "./route";
const sourceId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ sourceId }) };
function request(
  body = '{"eventId":"event"}',
  timestamp = String(Math.floor(Date.now() / 1000)),
  signature?: string
) {
  return new Request("http://localhost/api/conversions/events/" + sourceId, {
    method: "POST",
    body,
    headers: {
      "X-Airi-Timestamp": timestamp,
      "X-Airi-Signature":
        signature ??
        "sha256=" +
          createHmac("sha256", "test-signing-secret")
            .update(timestamp + "." + body)
            .digest("hex"),
    },
  });
}
describe("signed commerce intake", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSource.mockResolvedValue({
      ok: true,
      source: {
        id: sourceId,
        type: "whatsapp",
        workspace_id: "workspace",
        credentials: {
          sales_webhook_enabled: true,
          sales_webhook_secret: { iv: "a", tag: "b", ciphertext: "c" },
        },
      },
    });
    mockRecord.mockResolvedValue({
      success: true,
      conversion: { id: "conversion" },
      deduplicated: false,
    });
  });
  it("verifies the signed bytes before passing an event to the ledger", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ input: { eventId: "event" } })
    );
  });
  // The future case is an hour ahead, not 301 s: it.each evaluates it when the
  // file loads, and a slow runner reached the request back inside the 300 s window.
  it.each(["0", String(Math.floor(Date.now() / 1000) + 3600), "bad", "1e9"])(
    "rejects stale/invalid timestamps %s",
    async timestamp => {
      expect((await POST(request(undefined, timestamp), context)).status).toBe(
        401
      );
      expect(mockRecord).not.toHaveBeenCalled();
    }
  );
  it("rejects a tampered signature", async () => {
    expect(
      (await POST(request(undefined, undefined, "sha256=bad"), context)).status
    ).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it("rejects unsigned requests", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost", { method: "POST", body: "{}" }),
          context
        )
      ).status
    ).toBe(401);
  });
  it("rejects a disabled source", async () => {
    mockSource.mockResolvedValue({
      ok: true,
      source: {
        id: sourceId,
        type: "whatsapp",
        credentials: {
          sales_webhook_enabled: false,
          sales_webhook_secret: { iv: "a", tag: "b", ciphertext: "c" },
        },
      },
    });
    expect((await POST(request(), context)).status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it("rejects a non-WhatsApp source even when its sales webhook is enabled", async () => {
    mockSource.mockResolvedValue({
      ok: true,
      source: {
        id: sourceId,
        type: "web_widget",
        credentials: {
          sales_webhook_enabled: true,
          sales_webhook_secret: { iv: "a", tag: "b", ciphertext: "c" },
        },
      },
    });
    expect((await POST(request(), context)).status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it("rejects a removed source even if its webhook flag was retained", async () => {
    mockSource.mockResolvedValue({
      ok: true,
      source: {
        id: sourceId,
        type: "whatsapp",
        credentials: {
          coexistence_reonboarding_status: "removed",
          sales_webhook_enabled: true,
          sales_webhook_secret: { iv: "a", tag: "b", ciphertext: "c" },
        },
      },
    });
    expect((await POST(request(), context)).status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it("bounds the streamed body before parsing", async () => {
    expect((await POST(request("x".repeat(16385)), context)).status).toBe(413);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it("rejects signed malformed JSON", async () => {
    expect((await POST(request("{"), context)).status).toBe(400);
  });
});
