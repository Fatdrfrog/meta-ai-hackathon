import type { MetaConversionSnapshot } from "@icecore/shared/types/conversion-events";
import {
  provisionWhatsAppConversionDataset,
  sendWhatsAppConversionEvent,
  validateMetaConversionSnapshot,
} from "./whatsapp-conversions-api";

const NOW = 1_789_000_000;
const snapshot: MetaConversionSnapshot = {
  sourceId: "source-1",
  datasetId: "123456789",
  wabaId: "987654321",
  ctwaClid: "original_click_id",
  eventName: "Purchase",
  eventTime: NOW - 60,
  value: 12000.15,
  currency: "KZT",
};
const accessToken = "private-token";
const eventId = "conversion-1";
const originalFetch = global.fetch;
const mockFetch = jest.fn();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function send(overrides: Partial<MetaConversionSnapshot> = {}) {
  return sendWhatsAppConversionEvent({
    snapshot: { ...snapshot, ...overrides },
    eventId,
    accessToken,
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW * 1000 });
  mockFetch.mockReset();
  global.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

describe("WhatsApp conversion snapshot validation", () => {
  it.each([0.01, 1.1, 1.11, 99999999.99])(
    "accepts representable positive money %s without binary rounding false failures",
    value => {
      expect(
        validateMetaConversionSnapshot({ ...snapshot, value }, NOW)
      ).toBeNull();
    }
  );

  it.each<[Partial<MetaConversionSnapshot>, string]>([
    [{ sourceId: "" }, "invalid_source_id"],
    [{ sourceId: "x".repeat(129) }, "invalid_source_id"],
    [{ datasetId: "https://example.com" }, "invalid_dataset_id"],
    [{ datasetId: "1".repeat(33) }, "invalid_dataset_id"],
    [{ wabaId: "123/events?token=x" }, "invalid_waba_id"],
    [{ ctwaClid: "" }, "invalid_ctwa_clid"],
    [{ ctwaClid: "has whitespace" }, "invalid_ctwa_clid"],
    [{ ctwaClid: "x".repeat(4097) }, "invalid_ctwa_clid"],
    [{ eventName: "Refund" as "Purchase" }, "invalid_event_name"],
    [{ eventTime: Number.NaN }, "invalid_event_time"],
    [{ eventTime: NOW - 0.5 }, "invalid_event_time"],
    [{ eventTime: NOW + 1 }, "event_in_future"],
    [{ eventTime: NOW - 604801 }, "event_too_old"],
    [{ value: 0 }, "invalid_value"],
    [{ value: -1 }, "invalid_value"],
    [{ value: Number.POSITIVE_INFINITY }, "invalid_value"],
    [{ value: Number.NaN }, "invalid_value"],
    [{ value: 100000000 }, "invalid_value"],
    [{ value: 1.111 }, "invalid_value"],
    [{ currency: "kzt" }, "invalid_currency"],
    [{ currency: "KZ" }, "invalid_currency"],
    [{ testEventCode: "" }, "invalid_test_event_code"],
    [{ testEventCode: "x".repeat(129) }, "invalid_test_event_code"],
  ])("rejects invalid immutable facts %j", (overrides, reason) => {
    expect(
      validateMetaConversionSnapshot({ ...snapshot, ...overrides }, NOW)
    ).toBe(reason);
  });

  it("accepts the exact seven-day boundary and supported return event", () => {
    expect(
      validateMetaConversionSnapshot(
        {
          ...snapshot,
          eventName: "OrderReturned",
          eventTime: NOW - 604800,
        },
        NOW
      )
    ).toBeNull();
  });

  it("rejects malformed persisted snapshots without throwing", () => {
    expect(
      validateMetaConversionSnapshot(
        null as unknown as MetaConversionSnapshot,
        NOW
      )
    ).toBe("invalid_snapshot");
  });
});

describe("WhatsApp conversion event delivery", () => {
  it.each(["Purchase", "OrderReturned"] as const)(
    "sends a single %s using original attribution and the canonical Graph origin",
    async eventName => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          events_received: 1,
          messages: [],
          fbtrace_id: "trace_1",
        })
      );

      await expect(send({ eventName })).resolves.toEqual({
        status: "sent",
        traceId: "trace_1",
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://graph.facebook.com/v25.0/123456789/events");
      expect(init).toEqual(
        expect.objectContaining({ method: "POST", redirect: "error" })
      );
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer private-token"
      );
      expect(new Headers(init.headers).get("content-type")).toBe(
        "application/json"
      );
      expect(JSON.parse(init.body as string)).toEqual({
        data: [
          {
            event_name: eventName,
            event_time: NOW - 60,
            event_id: "conversion-1",
            action_source: "business_messaging",
            messaging_channel: "whatsapp",
            user_data: {
              whatsapp_business_account_id: "987654321",
              ctwa_clid: "original_click_id",
            },
            custom_data: { currency: "KZT", value: 12000.15 },
          },
        ],
      });
    }
  );

  it("preserves an explicitly supplied test code without treating delivery as a dry run", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ events_received: 1 }));
    await expect(send({ testEventCode: "TEST123" })).resolves.toEqual({
      status: "sent",
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.test_event_code).toBe("TEST123");
  });

  it.each(["", "x".repeat(129), "has\ncontrol"])(
    "rejects invalid event identity before making any request: %j",
    async invalidId => {
      await expect(
        sendWhatsAppConversionEvent({
          snapshot,
          eventId: invalidId,
          accessToken,
        })
      ).resolves.toEqual({ status: "rejected", code: "invalid_event_id" });
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid snapshots before making any request", async () => {
    await expect(send({ value: 0 })).resolves.toEqual({
      status: "rejected",
      code: "invalid_value",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects missing token before making any request", async () => {
    await expect(
      sendWhatsAppConversionEvent({ snapshot, eventId, accessToken: "" })
    ).resolves.toEqual({ status: "rejected", code: "invalid_access_token" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      400,
      {
        error: {
          code: 100,
          error_subcode: 33,
          type: "GraphMethodException",
          message: "sensitive provider text",
        },
      },
      "meta_graph_100_33",
    ],
    [
      401,
      {
        error: {
          code: 190,
          type: "OAuthException",
          message: "private-token expired",
        },
      },
      "meta_graph_190",
    ],
    [
      503,
      { error: { code: 2, type: "OAuthException", message: "Unavailable" } },
      "meta_graph_2",
    ],
  ] as const)(
    "recognizes explicit Graph rejection on HTTP %s without exposing provider text",
    async (status, payload, code) => {
      mockFetch.mockResolvedValue(jsonResponse(payload, status));
      await expect(send()).resolves.toEqual({ status: "rejected", code });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    null,
    {},
    [],
    { events_received: 0 },
    { events_received: 2 },
    { events_received: "1" },
    { events_received: 1, error: { code: 100 } },
  ])("keeps malformed or absent acceptance unknown: %j", async payload => {
    mockFetch.mockResolvedValue(jsonResponse(payload));
    await expect(send()).resolves.toEqual({
      status: "delivery_unknown",
      code: "missing_acceptance",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps HTML 5xx responses unknown without retrying", async () => {
    mockFetch.mockResolvedValue(
      new Response("<html>upstream failed</html>", { status: 502 })
    );
    await expect(send()).resolves.toEqual({
      status: "delivery_unknown",
      code: "unconfirmed_http_error",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed Graph errors unknown", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: { code: "private-token", message: "failed" } }, 400)
    );
    await expect(send()).resolves.toEqual({
      status: "delivery_unknown",
      code: "unconfirmed_http_error",
    });
  });

  it("keeps transport failure unknown and never leaks the thrown message", async () => {
    mockFetch.mockRejectedValue(new Error("private-token in network error"));
    await expect(send()).resolves.toEqual({
      status: "delivery_unknown",
      code: "transport_error",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("enforces a ten-second deadline with no retry even when transport ignores cancellation", async () => {
    mockFetch.mockImplementation(() => new Promise(() => undefined));
    const result = send();
    await jest.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toEqual({
      status: "delivery_unknown",
      code: "provider_response_timeout",
    });
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("includes response body consumption in the deadline", async () => {
    const cancel = jest.fn();
    mockFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"events_received":'));
          },
          cancel,
        })
      )
    );
    const result = send();
    await jest.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toEqual({
      status: "delivery_unknown",
      code: "provider_response_timeout",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds the provider response and leaves oversized acceptance unknown", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ events_received: 1, messages: ["x".repeat(65536)] })
    );
    await expect(send()).resolves.toEqual({
      status: "delivery_unknown",
      code: "provider_response_too_large",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "private-token",
    "original_click_id",
    "trace with spaces",
    "x".repeat(129),
  ])(
    "omits unsafe trace identifiers from an otherwise accepted event: %j",
    async fbtrace_id => {
      mockFetch.mockResolvedValue(
        jsonResponse({ events_received: 1, fbtrace_id })
      );
      await expect(send()).resolves.toEqual({ status: "sent" });
    }
  );
});

describe("WhatsApp conversion dataset provisioning", () => {
  it("creates or returns the WABA dataset in a single POST and parses the documented id response", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "123456789" }));
    await expect(
      provisionWhatsAppConversionDataset({ wabaId: "987654321", accessToken })
    ).resolves.toBe("123456789");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v25.0/987654321/dataset");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer private-token"
    );
  });

  it.each([
    { data: [{ id: "123" }] },
    { id: 123 },
    { id: "../events" },
    { id: "1".repeat(33) },
  ])(
    "rejects unexpected dataset shapes without accepting guessed GET formats: %j",
    async payload => {
      mockFetch.mockResolvedValue(jsonResponse(payload));
      await expect(
        provisionWhatsAppConversionDataset({ wabaId: "987654321", accessToken })
      ).rejects.toMatchObject({
        message: "invalid_dataset_response",
        code: "invalid_dataset_response",
      });
    }
  );

  it("returns a safe permission code without credentials or provider error text", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 200,
            type: "OAuthException",
            message: "private-token",
          },
        },
        403
      )
    );
    await expect(
      provisionWhatsAppConversionDataset({ wabaId: "987654321", accessToken })
    ).rejects.toMatchObject({
      message: "meta_graph_200",
      code: "meta_graph_200",
    });
  });

  it("validates the WABA before attempting provisioning", async () => {
    await expect(
      provisionWhatsAppConversionDataset({
        wabaId: "123?access_token=secret",
        accessToken,
      })
    ).rejects.toMatchObject({ code: "invalid_waba_id" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
