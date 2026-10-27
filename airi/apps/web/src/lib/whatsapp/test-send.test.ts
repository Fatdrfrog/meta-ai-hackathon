import {
  fetchWhatsAppTestPhone,
  postWhatsAppTestSend,
  readWhatsAppTestPhone,
  WhatsAppTestSendRequestSchema,
} from "./test-send";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const request = {
  workspaceId: "workspace-1",
  to: "+77012345678",
  templateName: "spring_offer",
  language: "ru",
};

describe("readWhatsAppTestPhone", () => {
  it("reads and normalizes the saved number", () => {
    expect(
      readWhatsAppTestPhone({ whatsapp_test_phone: "8 701 234 56 78" })
    ).toBe("77012345678");
  });

  it.each([
    undefined,
    null,
    {},
    { whatsapp_test_phone: 7 },
    { whatsapp_test_phone: "12" },
  ])("returns null for %p", metadata => {
    expect(readWhatsAppTestPhone(metadata)).toBeNull();
  });
});

describe("WhatsAppTestSendRequestSchema", () => {
  it("defaults the origin to the bulk builder", () => {
    expect(WhatsAppTestSendRequestSchema.parse(request).origin).toBe(
      "bulk_builder"
    );
  });

  it("refuses unknown fields such as caller-supplied credentials", () => {
    expect(
      WhatsAppTestSendRequestSchema.safeParse({
        ...request,
        access_token: "token",
      }).success
    ).toBe(false);
  });
});

describe("postWhatsAppTestSend", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns the sent number", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ ok: true, to: "77012345678", messageId: "wamid.1" })
    ) as jest.Mock;
    await expect(postWhatsAppTestSend(request)).resolves.toEqual({
      ok: true,
      to: "77012345678",
      messageId: "wamid.1",
    });
  });

  it("keeps the server's code, variables and retry time", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(
        {
          ok: false,
          code: "template_variables_missing",
          variables: ["3", 4],
          providerCode: 132000,
          retryAt: "2026-10-18T12:00:00.000Z",
        },
        400
      )
    ) as jest.Mock;
    await expect(postWhatsAppTestSend(request)).resolves.toEqual({
      ok: false,
      code: "template_variables_missing",
      variables: ["3"],
      providerCode: 132000,
      retryAt: "2026-10-18T12:00:00.000Z",
    });
  });

  it("treats an unknown code, a bad body or a network failure as a failed send", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ ok: false, code: "something_new" }, 500)
    ) as jest.Mock;
    await expect(postWhatsAppTestSend(request)).resolves.toEqual({
      ok: false,
      code: "send_failed",
    });

    global.fetch = jest.fn(async () => jsonResponse(null, 502)) as jest.Mock;
    await expect(postWhatsAppTestSend(request)).resolves.toEqual({
      ok: false,
      code: "send_failed",
    });

    global.fetch = jest.fn(async () => {
      throw new TypeError("offline");
    }) as jest.Mock;
    await expect(postWhatsAppTestSend(request)).resolves.toEqual({
      ok: false,
      code: "send_failed",
    });
  });
});

describe("fetchWhatsAppTestPhone", () => {
  it("returns the saved number or null", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ phone: "77012345678" })
    ) as jest.Mock;
    await expect(fetchWhatsAppTestPhone()).resolves.toBe("77012345678");

    global.fetch = jest.fn(async () =>
      jsonResponse({ phone: null })
    ) as jest.Mock;
    await expect(fetchWhatsAppTestPhone()).resolves.toBeNull();

    global.fetch = jest.fn(async () => jsonResponse({}, 401)) as jest.Mock;
    await expect(fetchWhatsAppTestPhone()).resolves.toBeNull();
  });
});
