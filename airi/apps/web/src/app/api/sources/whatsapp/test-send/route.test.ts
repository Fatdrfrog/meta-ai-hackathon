const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockResolveTemplate = jest.fn();
const mockRefreshMedia = jest.fn();
const mockSendWhatsappTemplate = jest.fn();
const mockCaptureFunnelEvent = jest.fn();
const mockGetUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));
jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  resolveApprovedWhatsAppTemplateForSend: (...args: unknown[]) =>
    mockResolveTemplate(...args),
  refreshWhatsAppTemplateMediaForSend: (...args: unknown[]) =>
    mockRefreshMedia(...args),
}));
jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTemplate: (...args: unknown[]) =>
    mockSendWhatsappTemplate(...args),
}));
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser, updateUser: mockUpdateUser },
  }),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => ({ limit: jest.fn() }),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { NextResponse } from "next/server";
import { GET, POST } from "./route";

const template = {
  name: "spring_offer",
  language: "ru",
  status: "APPROVED",
  category: "MARKETING",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, take {{2}} off today",
      example: { body_text: [["Alex", "10%"]] },
    },
  ],
};

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/sources/whatsapp/test-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const validBody = {
  workspaceId: "workspace-1",
  sourceId: "source-2",
  to: "+7 701 234 56 78",
  templateName: "spring_offer",
  language: "ru",
  variables: { "1": "Dana" },
};

function metaError(code: number) {
  return new MetaGraphRequestError({
    message: "Graph error",
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v23.0/phone/messages",
    details: { error: { code, message: "Graph error" } },
  });
}

describe("POST /api/sources/whatsapp/test-send", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        accessToken: "decrypted-token",
        phoneNumberId: "phone-2",
        wabaId: "waba-2",
        sourceId: "source-2",
        credentials: { messagingAccountId: "messaging-2" },
        user: { id: "user-1" },
        membership: { role: "manager" },
      },
    });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 3_600_000,
    });
    mockResolveTemplate.mockResolvedValue({ template, source: "cache" });
    mockRefreshMedia.mockImplementation(
      async (params: { components?: unknown }) => params.components
    );
    mockSendWhatsappTemplate.mockResolvedValue({ messageId: "wamid.1" });
    mockUpdateUser.mockResolvedValue({ error: null });
  });

  it("sends the approved template with stored credentials of the chosen number", async () => {
    const response = await post(validBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      to: "77012345678",
      messageId: "wamid.1",
    });
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      { requireManager: true, requirePhoneNumber: true, sourceId: "source-2" }
    );
    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-2",
      "decrypted-token",
      "77012345678",
      "spring_offer",
      "ru",
      [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Dana" },
            { type: "text", text: "10%" },
          ],
        },
      ],
      { requirePhoneRecipient: true, messagingAccountId: "messaging-2" }
    );
  });

  it("keeps Kazakh mobile numbers instead of rewriting them", async () => {
    await post({ ...validBody, to: "8 (701) 234-56-78" });
    expect(mockSendWhatsappTemplate.mock.calls[0][2]).toBe("77012345678");

    await post({ ...validBody, to: "77012345678" });
    expect(mockSendWhatsappTemplate.mock.calls[1][2]).toBe("77012345678");
  });

  it("remembers the number and counts the test", async () => {
    await post({ ...validBody, origin: "launch" });

    expect(mockUpdateUser).toHaveBeenCalledWith({
      data: { whatsapp_test_phone: "77012345678" },
    });
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "test_sent",
      userId: "user-1",
      workspaceId: "workspace-1",
      properties: {
        channel: "whatsapp",
        origin: "launch",
        template_category: "MARKETING",
      },
    });
  });

  it("still reports a sent test when the number can't be remembered", async () => {
    mockUpdateUser.mockRejectedValue(new Error("auth down"));
    const response = await post(validBody);
    expect(response.status).toBe(200);
  });

  it("uses Meta's sample values for variables the builder left empty", async () => {
    await post({ ...validBody, variables: { "1": "  " } });
    expect(mockSendWhatsappTemplate.mock.calls[0][5]).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Alex" },
          { type: "text", text: "10%" },
        ],
      },
    ]);
  });

  it("names variables that have neither a value nor a sample", async () => {
    mockResolveTemplate.mockResolvedValue({
      template: {
        ...template,
        components: [{ type: "BODY", text: "Hi {{1}}, use code {{3}}" }],
      },
    });
    const response = await post({ ...validBody, variables: { "1": "Dana" } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "template_variables_missing",
      variables: ["3"],
    });
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it("refuses an invalid number before looking up the template", async () => {
    const response = await post({ ...validBody, to: "12" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_phone");
    expect(mockResolveTemplate).not.toHaveBeenCalled();
  });

  it("caps tests per user per hour", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.parse("2026-10-18T12:00:00.000Z"),
    });
    const response = await post(validBody);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "rate_limited",
      retryAt: "2026-10-18T12:00:00.000Z",
    });
    expect(mockCheckRateLimit.mock.calls[0][1]).toBe("user-1");
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it("keeps sending when the rate limiter is down", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("redis down"));
    expect((await post(validBody)).status).toBe(200);
  });

  it.each([
    [403, "not_allowed", 403],
    [401, "not_allowed", 401],
    [404, "whatsapp_not_connected", 409],
    [500, "whatsapp_not_connected", 409],
  ])(
    "translates a %i workspace check into %s",
    async (accessStatus, code, status) => {
      mockGetWhatsAppWorkspaceContext.mockResolvedValue({
        error: NextResponse.json(
          { error: "English text" },
          { status: accessStatus }
        ),
      });
      const response = await post(validBody);
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(code);
    }
  );

  it("refuses an unapproved template", async () => {
    mockResolveTemplate.mockResolvedValue({ template: null, source: "none" });
    const response = await post(validBody);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("template_unavailable");
  });

  it("refuses requests without a template", async () => {
    const response = await post({
      workspaceId: "workspace-1",
      to: "77012345678",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_request");
  });

  it("refuses caller-supplied credentials", async () => {
    const response = await post({
      ...validBody,
      access_token: "attacker-token",
      phone_number_id: "attacker-phone",
    });
    expect(response.status).toBe(400);
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it.each([
    [131030, "recipient_not_allowed"],
    [131026, "recipient_unreachable"],
    [131021, "recipient_is_sender"],
    [131042, "meta_billing"],
    [130429, "meta_rate_limited"],
    [190, "token_invalid"],
    [132000, "template_parameters"],
    [132001, "template_unavailable"],
    [100, "send_failed"],
  ])("maps Meta error %i to %s", async (providerCode, code) => {
    mockSendWhatsappTemplate.mockRejectedValue(metaError(providerCode));
    const response = await post(validBody);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code,
      providerCode,
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockCaptureFunnelEvent).not.toHaveBeenCalled();
  });

  it("reports other failures without the provider's text", async () => {
    mockSendWhatsappTemplate.mockRejectedValue(new Error("socket hang up"));
    const response = await post(validBody);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "send_failed",
    });
  });
});

describe("GET /api/sources/whatsapp/test-send", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the saved test number", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          user_metadata: { whatsapp_test_phone: "87012345678" },
        },
      },
    });
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ phone: "77012345678" });
  });

  it("returns no number when none is saved", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", user_metadata: {} } },
    });
    await expect((await GET()).json()).resolves.toEqual({ phone: null });
  });

  it("requires a signed-in user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
  });
});
