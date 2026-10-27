const mockSource = jest.fn();
const mockContext = jest.fn();
const mockReadSession = jest.fn();
const mockIssueSession = jest.fn();
const mockRecord = jest.fn();
const mockHandoff = jest.fn();
const mockList = jest.fn();
const mockLimit = jest.fn();
const mockSourceByKey = jest.fn();
jest.mock("@/lib/widget/source-context", () => ({
  resolveAuthorizedWidgetSource: (...args: unknown[]) => mockSource(...args),
  fetchWidgetSourceByClientKey: (...args: unknown[]) =>
    mockSourceByKey(...args),
}));
jest.mock("@/lib/commerce/integrations", () => ({
  resolveWebsiteCommerceContext: (...args: unknown[]) => mockContext(...args),
  WebsiteCommerceIntegrationError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string
    ) {
      super(message);
    }
  },
}));
jest.mock("@/lib/commerce/browser-session", () => ({
  readCartSession: (...args: unknown[]) => mockReadSession(...args),
  issueCartSession: (...args: unknown[]) => mockIssueSession(...args),
}));
jest.mock("@/lib/commerce/carts", () => ({
  recordBrowserCartEvent: (...args: unknown[]) => mockRecord(...args),
  createCartHandoff: (...args: unknown[]) => mockHandoff(...args),
  listWebsiteCarts: (...args: unknown[]) => mockList(...args),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => ({}),
  checkRateLimit: (...args: unknown[]) => mockLimit(...args),
}));
import { NextRequest } from "next/server";
import { POST } from "./route";
import { WebsiteCommerceIntegrationError } from "@/lib/commerce/integrations";
const source = {
  id: "source",
  workspace_id: "workspace",
  credentials: { status: "active", allowed_domains: ["shop.example"] },
};
const request = (body: unknown) =>
  new NextRequest("https://www.airi.chat/api/widget/commerce", {
    method: "POST",
    headers: {
      Origin: "https://shop.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
const event = () => ({
  eventId: "evt1",
  type: "cart_updated",
  cartId: "cart1",
  occurredAt: new Date().toISOString(),
  currency: "KZT",
  items: [{ id: "sku1", name: "Tea", quantity: 1, price: 200 }],
});
beforeEach(() => {
  jest.clearAllMocks();
  mockSource.mockResolvedValue({
    ok: true,
    source,
    credentials: source.credentials,
  });
  mockContext.mockResolvedValue({
    settings: { enabled: true },
    whatsappSource: { id: "wa" },
  });
  mockReadSession.mockResolvedValue("signed-visitor");
  mockIssueSession.mockResolvedValue("signed-token");
  mockRecord.mockResolvedValue({ cartId: "cart1", linked: false });
  mockLimit.mockResolvedValue({ success: true });
  mockSourceByKey.mockResolvedValue(source);
  mockList.mockResolvedValue([{ cartId: "cart1", linked: true }]);
});
test("issues anonymous identity only after authorized source and commerce configuration", async () => {
  const response = await POST(
    request({ action: "session", clientKey: "public" })
  );
  expect(await response.json()).toEqual({
    sessionToken: "signed-token",
    enabled: true,
  });
  expect(mockIssueSession).toHaveBeenCalledWith("source", undefined);
});

test("returning shopper can refresh actual claimed status without writing another event", async () => {
  const response = await POST(
    request({ action: "carts", clientKey: "public", sessionToken: "signed" })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    carts: [{ cartId: "cart1", linked: true }],
  });
  expect(mockList).toHaveBeenCalledWith({
    workspaceId: "workspace",
    widgetSourceId: "source",
    ownerSessionId: "signed-visitor",
    whatsappSourceId: "wa",
  });
  expect(mockRecord).not.toHaveBeenCalled();
  mockReadSession.mockResolvedValue(null);
  expect(
    (
      await POST(
        request({
          action: "carts",
          clientKey: "public",
          sessionToken: "invalid",
        })
      )
    ).status
  ).toBe(401);
  expect(mockList).toHaveBeenCalledTimes(1);
});
test("passes only server-resolved workspace and signed session to writes", async () => {
  const response = await POST(
    request({
      action: "events",
      clientKey: "public",
      sessionToken: "token",
      events: [event()],
    })
  );
  expect(response.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      widgetSourceId: "source",
      ownerSessionId: "signed-visitor",
    })
  );
});
test("rejects unsolicited phone/identity authority and malformed batches before writes", async () => {
  const response = await POST(
    request({
      action: "events",
      clientKey: "public",
      sessionToken: "token",
      events: [event(), { bad: true }],
    })
  );
  expect(response.status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
  const forged = await POST(
    request({ action: "session", clientKey: "public", customerId: "victim" })
  );
  expect(forged.status).toBe(400);
});
test("invalid session cannot submit events or request a handoff", async () => {
  mockReadSession.mockResolvedValue(null);
  expect(
    (
      await POST(
        request({
          action: "events",
          clientKey: "public",
          sessionToken: "other-source",
          events: [event()],
        })
      )
    ).status
  ).toBe(401);
  expect(mockRecord).not.toHaveBeenCalled();
});
test("source domain rejection precedes session issuance and writes", async () => {
  mockSource.mockResolvedValue({
    ok: false,
    status: 403,
    error: "Domain not authorized",
  });
  expect(
    (await POST(request({ action: "session", clientKey: "public" }))).status
  ).toBe(403);
  expect(mockIssueSession).not.toHaveBeenCalled();
});
test("handoff requires explicit consent", async () => {
  expect(
    (
      await POST(
        request({
          action: "handoff",
          clientKey: "public",
          sessionToken: "token",
          cartId: "cart1",
          consent: false,
        })
      )
    ).status
  ).toBe(400);
  expect(mockHandoff).not.toHaveBeenCalled();
});
test("source traffic budget prevents writes", async () => {
  mockLimit.mockResolvedValue({ success: false });
  expect(
    (
      await POST(
        request({
          action: "events",
          clientKey: "public",
          sessionToken: "token",
          events: [event()],
        })
      )
    ).status
  ).toBe(429);
  expect(mockRecord).not.toHaveBeenCalled();
});

test("sandboxed pixels require the existing source-scoped session and cannot mint one", async () => {
  const pixel = (body: unknown) =>
    new NextRequest("https://www.airi.chat/api/widget/commerce", {
      method: "POST",
      headers: { Origin: "null", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = {
    action: "events",
    clientKey: "public",
    sessionToken: "valid-token",
    events: [event()],
  };
  expect((await POST(pixel(body))).status).toBe(200);
  expect(mockSource).not.toHaveBeenCalled();
  expect(mockIssueSession).not.toHaveBeenCalled();
  mockReadSession.mockResolvedValue(null);
  expect(
    (await POST(pixel({ ...body, sessionToken: "forged-token" }))).status
  ).toBe(401);
  mockSource.mockResolvedValue({
    ok: false,
    status: 403,
    error: "Domain not authorized",
  });
  expect(
    (await POST(pixel({ action: "session", clientKey: "public" }))).status
  ).toBe(403);
  expect(mockIssueSession).not.toHaveBeenCalled();
});

test.each(["commerce_disabled", "whatsapp_unavailable"] as const)(
  "unavailable commerce (%s) initializes without retries or errors",
  async code => {
    mockContext.mockRejectedValue(
      new WebsiteCommerceIntegrationError("Disabled", 409, code)
    );
    const response = await POST(
      request({ action: "session", clientKey: "public" })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, sessionToken: "" });
    expect(mockIssueSession).not.toHaveBeenCalled();
  }
);
