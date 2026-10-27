import { createHash } from "node:crypto";

import {
  getWhatsAppGraphClient,
  MetaGraphRequestError,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import {
  createWhatsAppChatQr,
  deleteWhatsAppChatQr,
  getWhatsAppChatQr,
  listWhatsAppChatQrPage,
  listWhatsAppChatQrs,
  updateWhatsAppChatQrMessage,
  WhatsAppChatQrProviderError,
} from "./provider";

const PROVIDER_QR = {
  code: "QRVALID123",
  prefilled_message: "Hello\n[Ref: 01234-56789]",
  deep_link_url: "https://wa.me/message/QRVALID123",
  qr_image_url: "https://lookaside.facebook.com/ignored-secret-image",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createClient() {
  return {
    getJson: jest.fn(),
    postJson: jest.fn(),
    request: jest.fn(),
  };
}

function graphClient(client: ReturnType<typeof createClient>) {
  return client as unknown as WhatsAppGraphClient;
}

function unreadableResponse(status = 200): Response {
  const response = new Response(null, {
    status,
    statusText: status === 200 ? "OK" : "Bad Gateway",
  });
  Object.defineProperties(response, {
    text: {
      value: async () => {
        throw new Error("response-body-secret");
      },
    },
    url: {
      value:
        "https://graph.facebook.com/v25.0/message_qrdls?access_token=url-secret",
    },
  });
  return response;
}

function decodeProviderCursor(cursor: string): {
  v: number;
  nextUrl: string;
  seen: string[];
} {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

function encodeProviderCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function replaceProviderCursorUrl(cursor: string, nextUrl: string): string {
  const decoded = decodeProviderCursor(cursor);
  return encodeProviderCursor({
    ...decoded,
    nextUrl,
    seen: [
      ...decoded.seen.slice(0, -1),
      createHash("sha256").update(nextUrl).digest("base64url"),
    ],
  });
}

describe("WhatsApp Chat QR provider adapter", () => {
  it("creates a Chat QR with only the prefilled message and discards Meta image URLs", async () => {
    const client = createClient();
    client.postJson.mockResolvedValue(PROVIDER_QR);

    const result = await createWhatsAppChatQr({
      phoneNumberId: "123456789",
      accessToken: "secret-token",
      prefilledMessage: PROVIDER_QR.prefilled_message,
      client: graphClient(client),
    });

    expect(result).toEqual({
      code: "QRVALID123",
      prefilledMessage: PROVIDER_QR.prefilled_message,
      deepLink: "https://wa.me/message/QRVALID123",
    });
    expect(client.postJson).toHaveBeenCalledWith("123456789/message_qrdls", {
      token: "secret-token",
      body: { prefilled_message: PROVIDER_QR.prefilled_message },
    });
    expect(JSON.stringify(result)).not.toContain("ignored-secret-image");
  });

  it("gets and strictly normalizes Meta's official single-item envelope", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [PROVIDER_QR] });

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).resolves.toEqual({
      code: "QRVALID123",
      prefilledMessage: PROVIDER_QR.prefilled_message,
      deepLink: "https://wa.me/message/QRVALID123",
    });
    expect(client.getJson).toHaveBeenCalledWith(
      "123456789/message_qrdls/QRVALID123",
      { token: "secret-token" }
    );
  });

  it("keeps compatibility with a legacy bare single-record response", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue(PROVIDER_QR);

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).resolves.toEqual({
      code: "QRVALID123",
      prefilledMessage: PROVIDER_QR.prefilled_message,
      deepLink: "https://wa.me/message/QRVALID123",
    });
  });

  it("classifies an empty official envelope as a confirmed missing code", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [] });

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "not_found" },
    });
  });

  it("classifies an exact-code HTTP 404 as a confirmed missing code", async () => {
    const client = createClient();
    client.getJson.mockRejectedValue(
      new MetaGraphRequestError({
        message: "Not found",
        status: 404,
        statusText: "Not Found",
        url: "https://graph.facebook.com/message_qrdls/QRVALID123",
        details: {
          error: {
            code: 100,
            message: "Not found",
            type: "GraphMethodException",
          },
        },
        metaError: {
          code: 100,
          message: "Not found",
          type: "GraphMethodException",
        },
      })
    );

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "not_found", httpStatus: 404 },
    });
  });

  it.each([
    ["a non-array data field", { data: PROVIDER_QR }],
    ["a null data field", { data: null }],
    ["multiple records", { data: [PROVIDER_QR, PROVIDER_QR] }],
  ])("rejects %s in a single-code response", async (_label, response) => {
    const client = createClient();
    client.getJson.mockResolvedValue(response);

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "invalid_response" },
    });
  });

  it("rejects a different identity inside an official envelope", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({
      data: [
        {
          ...PROVIDER_QR,
          code: "QROTHER456",
          deep_link_url: "https://wa.me/message/QROTHER456",
        },
      ],
    });

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "identity_changed" },
    });
  });

  it.each([undefined, null])(
    "rejects a runtime %p code before constructing or dispatching a provider path",
    async code => {
      const client = createClient();
      client.getJson.mockResolvedValue(PROVIDER_QR);

      await expect(
        getWhatsAppChatQr({
          phoneNumberId: "123456789",
          accessToken: "secret-token",
          code: code as unknown as string,
          client: graphClient(client),
        })
      ).rejects.toMatchObject({
        outcome: "definite",
        evidence: { category: "invalid_request" },
      });
      expect(client.getJson).not.toHaveBeenCalled();
    }
  );

  it("exhaustively lists bounded pages through token-safe paging", async () => {
    const client = createClient();
    client.getJson
      .mockResolvedValueOnce({
        data: [PROVIDER_QR],
        paging: {
          next: "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2&access_token=paging-secret",
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            code: "QRVALID456",
            prefilled_message: "Second\n[Ref: ABCDE-FGHJK]",
            deep_link_url: "https://wa.me/message/QRVALID456",
          },
        ],
      });

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).resolves.toEqual([
      {
        code: "QRVALID123",
        prefilledMessage: PROVIDER_QR.prefilled_message,
        deepLink: "https://wa.me/message/QRVALID123",
      },
      {
        code: "QRVALID456",
        prefilledMessage: "Second\n[Ref: ABCDE-FGHJK]",
        deepLink: "https://wa.me/message/QRVALID456",
      },
    ]);
    expect(client.getJson).toHaveBeenNthCalledWith(
      1,
      "123456789/message_qrdls",
      {
        token: "secret-token",
        query: {
          fields: "code,prefilled_message,deep_link_url",
          limit: 100,
        },
      }
    );
    expect(client.getJson.mock.calls[1]![0]).toBe(
      "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2"
    );
    expect(client.getJson.mock.calls[1]![0]).not.toContain("paging-secret");
  });

  it("returns one requested provider page and resumes with token-safe opaque evidence", async () => {
    const client = createClient();
    client.getJson
      .mockResolvedValueOnce({
        data: [PROVIDER_QR],
        paging: {
          next: "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2&access_token=paging-secret",
        },
      })
      .mockResolvedValueOnce({ data: [] });

    const first = await listWhatsAppChatQrPage({
      phoneNumberId: "123456789",
      accessToken: "secret-token",
      limit: 1,
      client: graphClient(client),
    });

    expect(first.data).toEqual([
      {
        code: "QRVALID123",
        prefilledMessage: PROVIDER_QR.prefilled_message,
        deepLink: "https://wa.me/message/QRVALID123",
      },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain("graph.facebook.com");
    expect(first.nextCursor).not.toContain("paging-secret");
    const decodedCursor = decodeProviderCursor(first.nextCursor!);
    expect(decodedCursor).toEqual({
      v: 1,
      nextUrl:
        "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2",
      seen: [expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)],
    });
    expect(JSON.stringify(decodedCursor)).not.toContain("paging-secret");
    expect(client.getJson).toHaveBeenNthCalledWith(
      1,
      "123456789/message_qrdls",
      {
        token: "secret-token",
        query: {
          fields: "code,prefilled_message,deep_link_url",
          limit: 1,
        },
      }
    );

    await expect(
      listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 1,
        cursor: first.nextCursor,
        client: graphClient(client),
      })
    ).resolves.toEqual({ data: [] });
    expect(client.getJson).toHaveBeenNthCalledWith(
      2,
      "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2",
      {
        token: "secret-token",
        query: {
          fields: "code,prefilled_message,deep_link_url",
          limit: 1,
        },
      }
    );
    expect(JSON.stringify(client.getJson.mock.calls[1])).not.toContain(
      "paging-secret"
    );
  });

  it("round-trips only bounded message_qrdls paging parameters", async () => {
    const client = createClient();
    client.getJson
      .mockResolvedValueOnce({
        data: [],
        paging: {
          next: "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2&fields=code%2Cprefilled_message%2Cdeep_link_url&limit=25&access_token=paging-secret",
        },
      })
      .mockResolvedValueOnce({ data: [] });

    const first = await listWhatsAppChatQrPage({
      phoneNumberId: "123456789",
      accessToken: "secret-token",
      limit: 25,
      client: graphClient(client),
    });
    const safeNext =
      "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2&fields=code%2Cprefilled_message%2Cdeep_link_url&limit=25";

    expect(decodeProviderCursor(first.nextCursor!).nextUrl).toBe(safeNext);
    await listWhatsAppChatQrPage({
      phoneNumberId: "123456789",
      accessToken: "secret-token",
      limit: 25,
      cursor: first.nextCursor,
      client: graphClient(client),
    });
    expect(client.getJson).toHaveBeenNthCalledWith(2, safeNext, {
      token: "secret-token",
      query: {
        fields: "code,prefilled_message,deep_link_url",
        limit: 25,
      },
    });
    expect(JSON.stringify(first)).not.toContain("paging-secret");
    expect(JSON.stringify(client.getJson.mock.calls[1])).not.toContain(
      "paging-secret"
    );
  });

  it.each([
    ["appsecret_proof", "app-proof-secret"],
    ["client_secret", "client-secret-value"],
    ["token", "alternate-token-secret"],
    ["debug", "unknown-query-secret"],
  ])(
    "rejects provider paging key %s before cursor creation",
    async (key, secret) => {
      const client = createClient();
      client.getJson.mockResolvedValue({
        data: [],
        paging: {
          next: `https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2&${key}=${secret}`,
        },
      });

      const request = listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 25,
        client: graphClient(client),
      });

      await expect(request).rejects.toMatchObject({
        outcome: "definite",
        evidence: { category: "invalid_response" },
      });
      await request.catch(error => {
        expect(JSON.stringify(error)).not.toContain(secret);
      });
      expect(client.getJson).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["appsecret_proof", "app-proof-secret"],
    ["client_secret", "client-secret-value"],
    ["token", "alternate-token-secret"],
    ["debug", "unknown-query-secret"],
  ])(
    "rejects correctly fingerprinted cursor key %s before provider dispatch",
    async (key, secret) => {
      const firstClient = createClient();
      firstClient.getJson.mockResolvedValue({
        data: [],
        paging: {
          next: "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2",
        },
      });
      const first = await listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 25,
        client: graphClient(firstClient),
      });
      const unsafeNext = `https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2&${key}=${secret}`;
      const cursor = replaceProviderCursorUrl(first.nextCursor!, unsafeNext);
      const nextClient = createClient();

      const request = listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 25,
        cursor,
        client: graphClient(nextClient),
      });

      await expect(request).rejects.toMatchObject({
        outcome: "definite",
        evidence: { category: "invalid_request" },
      });
      await request.catch(error => {
        expect(JSON.stringify(error)).not.toContain(secret);
      });
      expect(nextClient.getJson).not.toHaveBeenCalled();
    }
  );

  it.each([0, 101, 1.5, Number.NaN])(
    "rejects an invalid requested page limit %p before provider dispatch",
    async limit => {
      const client = createClient();

      await expect(
        listWhatsAppChatQrPage({
          phoneNumberId: "123456789",
          accessToken: "secret-token",
          limit,
          client: graphClient(client),
        })
      ).rejects.toMatchObject({
        outcome: "definite",
        evidence: { category: "invalid_request" },
      });
      expect(client.getJson).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "foreign host",
      "https://example.com/v25.0/123456789/message_qrdls?after=cursor-2",
    ],
    [
      "insecure protocol",
      "http://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2",
    ],
    [
      "explicit port",
      "https://graph.facebook.com:444/v25.0/123456789/message_qrdls?after=cursor-2",
    ],
    [
      "userinfo",
      "https://user@graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2",
    ],
    [
      "fragment",
      "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor-2#fragment",
    ],
    [
      "another phone",
      "https://graph.facebook.com/v25.0/987654321/message_qrdls?after=cursor-2",
    ],
    [
      "another edge",
      "https://graph.facebook.com/v25.0/123456789/messages?after=cursor-2",
    ],
  ])(
    "rejects a cursor with a %s before provider dispatch",
    async (_label, nextUrl) => {
      const client = createClient();
      const cursor = encodeProviderCursor({
        v: 1,
        nextUrl,
        seen: ["x".repeat(43)],
      });

      await expect(
        listWhatsAppChatQrPage({
          phoneNumberId: "123456789",
          accessToken: "secret-token",
          limit: 25,
          cursor,
          client: graphClient(client),
        })
      ).rejects.toMatchObject({
        outcome: "definite",
        evidence: { category: "invalid_request" },
      });
      expect(client.getJson).not.toHaveBeenCalled();
    }
  );

  it.each(["%%%", Buffer.from("not-json").toString("base64url")])(
    "rejects malformed cursor evidence before provider dispatch",
    async cursor => {
      const client = createClient();

      await expect(
        listWhatsAppChatQrPage({
          phoneNumberId: "123456789",
          accessToken: "secret-token",
          limit: 25,
          cursor,
          client: graphClient(client),
        })
      ).rejects.toMatchObject({
        outcome: "definite",
        evidence: { category: "invalid_request" },
      });
      expect(client.getJson).not.toHaveBeenCalled();
    }
  );

  it("rejects cursor cycles and chains that would cross the 100-page bound", async () => {
    const firstClient = createClient();
    const repeatedNext =
      "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cycle";
    firstClient.getJson.mockResolvedValue({
      data: [],
      paging: { next: repeatedNext },
    });
    const first = await listWhatsAppChatQrPage({
      phoneNumberId: "123456789",
      accessToken: "secret-token",
      limit: 100,
      client: graphClient(firstClient),
    });
    const decoded = decodeProviderCursor(first.nextCursor!);

    const cycleClient = createClient();
    cycleClient.getJson.mockResolvedValue({
      data: [],
      paging: { next: repeatedNext },
    });
    await expect(
      listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 100,
        cursor: first.nextCursor,
        client: graphClient(cycleClient),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "pagination_bound" },
    });

    const longChainCursor = encodeProviderCursor({
      ...decoded,
      seen: Array.from({ length: 100 }, (_, index) =>
        String(index).padStart(43, "0")
      ),
    });
    const boundedClient = createClient();
    await expect(
      listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 100,
        cursor: longChainCursor,
        client: graphClient(boundedClient),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "pagination_bound" },
    });
    expect(boundedClient.getJson).not.toHaveBeenCalled();
  });

  it("rejects response overflow relative to the requested page size", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [PROVIDER_QR, PROVIDER_QR] });

    await expect(
      listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 1,
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "invalid_response" },
    });
  });

  it("rejects duplicate codes within one provider page", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [PROVIDER_QR, PROVIDER_QR] });

    await expect(
      listWhatsAppChatQrPage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        limit: 2,
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "duplicate_identity" },
    });
  });

  it.each([
    ["a non-object page", null],
    ["a page without data", {}],
    ["a non-array data field", { data: {} }],
    ["a malformed paging object", { data: [], paging: [] }],
    ["a non-string next link", { data: [], paging: { next: 7 } }],
  ])("fails closed for %s", async (_label, page) => {
    const client = createClient();
    client.getJson.mockResolvedValue(page);

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      name: "WhatsAppChatQrProviderError",
      outcome: "definite",
      evidence: { category: "invalid_response" },
    });
  });

  it("rejects a provider page above the requested page size before normalizing items", async () => {
    const client = createClient();
    const data = Array.from({ length: 101 }, (_, index) => ({
      code: `QR${index}`,
      prefilled_message: "Message",
      deep_link_url: `https://wa.me/message/QR${index}`,
    }));
    Object.defineProperty(data[0], "code", {
      get: () => {
        throw new Error("oversized-page-item-secret");
      },
    });
    client.getJson.mockResolvedValue({
      data,
    });

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "invalid_response" },
    });
  });

  it.each([
    ["blank", ""],
    ["whitespace", "   "],
    [
      "whitespace-padded",
      " https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cursor ",
    ],
  ])("rejects a $label provider paging.next value", async (_label, next) => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [], paging: { next } });

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      outcome: "definite",
      evidence: { category: "invalid_response" },
    });
  });

  it("fails closed on duplicate provider codes", async () => {
    const client = createClient();
    client.getJson.mockResolvedValue({ data: [PROVIDER_QR, PROVIDER_QR] });

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      evidence: { category: "duplicate_identity" },
      outcome: "definite",
    });
  });

  it("fails closed on paging cycles", async () => {
    const client = createClient();
    const next =
      "https://graph.facebook.com/v25.0/123456789/message_qrdls?after=cycle";
    client.getJson
      .mockResolvedValueOnce({ data: [PROVIDER_QR], paging: { next } })
      .mockResolvedValueOnce({
        data: [
          {
            ...PROVIDER_QR,
            code: "QRVALID456",
            deep_link_url: "https://wa.me/message/QRVALID456",
          },
        ],
        paging: { next },
      });

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      evidence: { category: "pagination_bound" },
      outcome: "definite",
    });
  });

  it("fails closed when the page bound prevents an exhaustive item result", async () => {
    const client = createClient();
    client.getJson.mockImplementation(async () => {
      const page = client.getJson.mock.calls.length;
      return {
        data: Array.from({ length: 100 }, (_, index) => {
          const item = (page - 1) * 100 + index;
          return {
            code: `QR${item}`,
            prefilled_message: "Message",
            deep_link_url: `https://wa.me/message/QR${item}`,
          };
        }),
        paging: {
          next: `https://graph.facebook.com/v25.0/123456789/message_qrdls?after=page-${page + 1}`,
        },
      };
    });

    await expect(
      listWhatsAppChatQrs({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      evidence: { category: "pagination_bound" },
    });
    expect(client.getJson).toHaveBeenCalledTimes(100);
  });

  it.each([
    ["blank code", { ...PROVIDER_QR, code: " " }],
    ["blank message", { ...PROVIDER_QR, prefilled_message: " " }],
    [
      "noncanonical link",
      {
        ...PROVIDER_QR,
        deep_link_url: "https://wa.me/message/OTHER",
      },
    ],
    [
      "overlong message",
      { ...PROVIDER_QR, prefilled_message: "x".repeat(141) },
    ],
  ])("rejects a provider response with %s", async (_label, response) => {
    const client = createClient();
    client.getJson.mockResolvedValue(response);

    await expect(
      getWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      evidence: { category: "invalid_response" },
      outcome: "definite",
    });
  });

  it("updates on the collection edge and verifies the provider identity is unchanged", async () => {
    const client = createClient();
    const updated = {
      ...PROVIDER_QR,
      prefilled_message: "Updated\n[Ref: 01234-56789]",
    };
    client.postJson.mockResolvedValue(updated);

    await expect(
      updateWhatsAppChatQrMessage({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        current: {
          code: "QRVALID123",
          prefilledMessage: PROVIDER_QR.prefilled_message,
          deepLink: "https://wa.me/message/QRVALID123",
        },
        prefilledMessage: updated.prefilled_message,
        client: graphClient(client),
      })
    ).resolves.toEqual({
      code: "QRVALID123",
      prefilledMessage: updated.prefilled_message,
      deepLink: "https://wa.me/message/QRVALID123",
    });
    expect(client.postJson).toHaveBeenCalledWith("123456789/message_qrdls", {
      token: "secret-token",
      body: {
        code: "QRVALID123",
        prefilled_message: updated.prefilled_message,
      },
    });
  });

  it.each([
    [
      "code",
      {
        ...PROVIDER_QR,
        code: "CHANGED",
        deep_link_url: "https://wa.me/message/CHANGED",
      },
    ],
    [
      "deep link",
      { ...PROVIDER_QR, deep_link_url: "https://wa.me/message/OTHER" },
    ],
  ])(
    "rejects an update that changes the provider %s",
    async (_label, value) => {
      const client = createClient();
      client.postJson.mockResolvedValue(value);

      await expect(
        updateWhatsAppChatQrMessage({
          phoneNumberId: "123456789",
          accessToken: "secret-token",
          current: {
            code: "QRVALID123",
            prefilledMessage: PROVIDER_QR.prefilled_message,
            deepLink: "https://wa.me/message/QRVALID123",
          },
          prefilledMessage: PROVIDER_QR.prefilled_message,
          client: graphClient(client),
        })
      ).rejects.toMatchObject({
        evidence: { category: "identity_changed" },
        outcome: "definite",
      });
    }
  );

  it("deletes through the code edge and requires an exact acknowledgement", async () => {
    const client = createClient();
    client.request.mockResolvedValue(Response.json({ success: true }));

    await expect(
      deleteWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).resolves.toBeUndefined();
    expect(client.request).toHaveBeenCalledWith(
      "123456789/message_qrdls/QRVALID123",
      { method: "DELETE", token: "secret-token" }
    );
  });

  it.each(["create", "update"] as const)(
    "classifies a successful-status %s body-read failure as ambiguous",
    async operation => {
      globalThis.fetch = jest.fn(async () =>
        unreadableResponse()
      ) as typeof fetch;
      const common = {
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: getWhatsAppGraphClient(),
      };
      const promise =
        operation === "create"
          ? createWhatsAppChatQr({
              ...common,
              prefilledMessage: PROVIDER_QR.prefilled_message,
            })
          : updateWhatsAppChatQrMessage({
              ...common,
              current: {
                code: "QRVALID123",
                prefilledMessage: PROVIDER_QR.prefilled_message,
                deepLink: "https://wa.me/message/QRVALID123",
              },
              prefilledMessage: PROVIDER_QR.prefilled_message,
            });

      await expect(promise).rejects.toMatchObject({
        name: "WhatsAppChatQrProviderError",
        outcome: "ambiguous",
        evidence: { category: "invalid_response", httpStatus: 200 },
      });
      await promise.catch(error => {
        expect(JSON.stringify(error)).not.toContain("response-body-secret");
        expect(JSON.stringify(error)).not.toContain("url-secret");
      });
    }
  );

  it("classifies a successful DELETE with an unreadable response body as ambiguous", async () => {
    const client = createClient();
    client.request.mockResolvedValue(unreadableResponse());

    await expect(
      deleteWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        code: "QRVALID123",
        client: graphClient(client),
      })
    ).rejects.toMatchObject({
      name: "WhatsAppChatQrProviderError",
      outcome: "ambiguous",
      evidence: { category: "invalid_response", httpStatus: 200 },
    });
  });

  it("classifies HTTP and Graph mutation failures as definite with bounded evidence", async () => {
    const client = createClient();
    client.postJson.mockRejectedValue(
      new MetaGraphRequestError({
        message: "leaked provider message secret-message",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/message_qrdls?access_token=secret-token",
        details: {
          error: {
            message: "secret-message",
            type: "OAuthException",
            code: 100,
            error_subcode: 33,
          },
        },
        metaError: {
          message: "secret-message",
          type: "OAuthException",
          code: 100,
          error_subcode: 33,
        },
      })
    );

    let error: WhatsAppChatQrProviderError | undefined;
    try {
      await createWhatsAppChatQr({
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        prefilledMessage: PROVIDER_QR.prefilled_message,
        client: graphClient(client),
      });
    } catch (caught) {
      error = caught as WhatsAppChatQrProviderError;
    }

    expect(error).toMatchObject({
      name: "WhatsAppChatQrProviderError",
      outcome: "definite",
      evidence: {
        category: "graph_response",
        httpStatus: 400,
        providerCode: 100,
        providerSubcode: 33,
      },
    });
    expect(JSON.stringify(error)).not.toContain("secret-message");
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });

  it.each([
    ["create", "postJson"],
    ["update", "postJson"],
    ["delete", "request"],
  ] as const)(
    "classifies a no-response %s failure after dispatch as ambiguous",
    async (operation, method) => {
      const client = createClient();
      client[method].mockRejectedValue(new TypeError("network secret-body"));
      const common = {
        phoneNumberId: "123456789",
        accessToken: "secret-token",
        client: graphClient(client),
      };
      const promise =
        operation === "create"
          ? createWhatsAppChatQr({
              ...common,
              prefilledMessage: PROVIDER_QR.prefilled_message,
            })
          : operation === "update"
            ? updateWhatsAppChatQrMessage({
                ...common,
                current: {
                  code: "QRVALID123",
                  prefilledMessage: PROVIDER_QR.prefilled_message,
                  deepLink: "https://wa.me/message/QRVALID123",
                },
                prefilledMessage: PROVIDER_QR.prefilled_message,
              })
            : deleteWhatsAppChatQr({ ...common, code: "QRVALID123" });

      await expect(promise).rejects.toMatchObject({
        name: "WhatsAppChatQrProviderError",
        outcome: "ambiguous",
        evidence: { category: "no_response" },
      });
      await promise.catch(error => {
        expect(JSON.stringify(error)).not.toContain("secret-body");
      });
    }
  );
});
