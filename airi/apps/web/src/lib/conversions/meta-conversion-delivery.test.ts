const mockFrom = jest.fn();
const mockSource = jest.fn();
const mockSend = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) => mockSource(...args),
}));
jest.mock("@/lib/meta-ads/whatsapp-conversions-api", () => ({
  validateMetaConversionSnapshot: () => null,
  sendWhatsAppConversionEvent: (...args: unknown[]) => mockSend(...args),
}));
jest.mock("./source-config", () => ({
  readWhatsAppConversionsConfiguration: (
    credentials: Record<string, unknown>
  ) => credentials.conversions_api,
}));
jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (credentials: Record<string, unknown>) => ({
    wabaId: credentials.waba_id,
    accessToken: credentials.access_token,
  }),
}));

import {
  deliverMetaConversion,
  reconcilePendingMetaConversions,
  recordMetaConversionPreparationFailure,
} from "./meta-conversion-delivery";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const conversionId = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  sourceId: "33333333-3333-4333-8333-333333333333",
  datasetId: "456",
  wabaId: "123",
  ctwaClid: "click",
  eventName: "Purchase",
  eventTime: Math.floor(Date.now() / 1000),
  value: 100,
  currency: "KZT",
};
type Row = Record<string, unknown>;
let row: Row;
let failFinalWrite: boolean;

function query() {
  let update: Row | undefined;
  const filters: Array<(value: Row) => boolean> = [];
  const result = () => {
    const matches = filters.every(filter => filter(row));
    if (matches && update) {
      if (failFinalWrite && update.meta_delivery_status === "sent")
        return { data: null, error: { message: "unavailable" } };
      Object.assign(row, update);
    }
    return { data: matches ? [{ ...row }] : [], error: null };
  };
  const chain: Record<
    "select" | "update" | "eq" | "in" | "order" | "limit" | "maybeSingle",
    jest.Mock
  > & {
    then: (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise<unknown>;
  } = {
    select: jest.fn(() => chain),
    update: jest.fn((value: Row) => {
      update = value;
      return chain;
    }),
    eq: jest.fn((key: string, value: unknown) => {
      filters.push(item => item[key] === value);
      return chain;
    }),
    in: jest.fn((key: string, values: unknown[]) => {
      filters.push(item => values.includes(item[key]));
      return chain;
    }),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => {
      const value = result();
      return { ...value, data: value.data?.[0] ?? null };
    }),
    then: (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}

beforeEach(() => {
  row = {
    id: conversionId,
    workspace_id: workspaceId,
    meta_delivery_status: "queued",
    meta_delivery_snapshot: snapshot,
  };
  failFinalWrite = false;
  mockFrom.mockReset().mockImplementation(query);
  mockSource.mockReset().mockResolvedValue({
    ok: true,
    source: {
      id: snapshot.sourceId,
      workspace_id: workspaceId,
      type: "whatsapp",
      credentials: {
        waba_id: "123",
        access_token: "token",
        conversions_api: { enabled: true, dataset_id: "456", waba_id: "123" },
      },
    },
  });
  mockSend.mockReset().mockImplementation(async () => {
    expect(row.meta_delivery_status).toBe("delivery_unknown");
    return { status: "sent", traceId: "trace" };
  });
});

describe("Meta conversion delivery", () => {
  it("claims in the ledger before dispatch and persists acceptance", async () => {
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "sent",
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      snapshot,
      eventId: conversionId,
      accessToken: "token",
    });
    expect(row.meta_delivery_status).toBe("sent");
  });

  it("does not retry an ambiguous send even when the queue replays", async () => {
    mockSend.mockResolvedValue({
      status: "delivery_unknown",
      code: "transport_error",
    });
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "delivery_unknown",
    });
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "delivery_unknown",
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent queue deliveries with the canonical row claim", async () => {
    await Promise.all([
      deliverMetaConversion({ workspaceId, conversionId }),
      deliverMetaConversion({ workspaceId, conversionId }),
    ]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(row.meta_delivery_status).toBe("sent");
  });

  it("keeps a failed acceptance write unknown and suppresses replay", async () => {
    failFinalWrite = true;
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "delivery_unknown",
    });
    await deliverMetaConversion({ workspaceId, conversionId });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("records explicit rejection without an automatic second request", async () => {
    mockSend.mockResolvedValue({ status: "rejected", code: "meta_190" });
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "rejected",
    });
    await deliverMetaConversion({ workspaceId, conversionId });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(row.meta_delivery_reason).toBe("meta_190");
  });

  it("does not send a frozen event to a different dataset after settings change", async () => {
    mockSource.mockResolvedValue({
      ok: true,
      source: {
        id: snapshot.sourceId,
        workspace_id: workspaceId,
        type: "whatsapp",
        credentials: {
          waba_id: "123",
          access_token: "token",
          conversions_api: { enabled: true, dataset_id: "789", waba_id: "123" },
        },
      },
    });
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "not_eligible",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not load a conversion belonging to a different workspace", async () => {
    expect(
      await deliverMetaConversion({
        workspaceId: "44444444-4444-4444-8444-444444444444",
        conversionId,
      })
    ).toEqual({ status: "not_eligible" });
    expect(mockFrom).toHaveBeenCalled();
    expect(mockSource).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not send when a source belongs to another workspace", async () => {
    const original = await mockSource();
    mockSource.mockResolvedValue({
      ...original,
      source: {
        ...original.source,
        workspace_id: "44444444-4444-4444-8444-444444444444",
      },
    });
    expect(await deliverMetaConversion({ workspaceId, conversionId })).toEqual({
      status: "not_eligible",
    });
    expect(row.meta_delivery_reason).toBe("whatsapp_source_unavailable");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("marks exhausted preparation failures without overwriting an uncertain send", async () => {
    await recordMetaConversionPreparationFailure({ workspaceId, conversionId });
    expect(row.meta_delivery_status).toBe("rejected");
    expect(row.meta_delivery_reason).toBe("pre_dispatch_failure");
    row.meta_delivery_status = "delivery_unknown";
    row.meta_delivery_reason = "dispatch_started";
    await recordMetaConversionPreparationFailure({ workspaceId, conversionId });
    expect(row.meta_delivery_status).toBe("delivery_unknown");
    expect(row.meta_delivery_reason).toBe("dispatch_started");
  });
});

describe("SQL delivery intent reconciliation", () => {
  it("enqueues before changing state so failed enqueue is recoverable", async () => {
    row.meta_delivery_status = "pending";
    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue(undefined);
    await expect(
      reconcilePendingMetaConversions({ enqueue })
    ).rejects.toThrow();
    expect(row.meta_delivery_status).toBe("pending");
    await reconcilePendingMetaConversions({ enqueue });
    expect(row.meta_delivery_status).toBe("queued");
    expect(enqueue).toHaveBeenCalledWith({ workspaceId, conversionId });
  });

  it("cannot overwrite a racing delivery result with queued", async () => {
    row.meta_delivery_status = "pending";
    await reconcilePendingMetaConversions({
      enqueue: async () => {
        row.meta_delivery_status = "sent";
      },
    });
    expect(row.meta_delivery_status).toBe("sent");
  });

  it("does no work past the batch deadline", async () => {
    const enqueue = jest.fn();
    await reconcilePendingMetaConversions({
      enqueue,
      deadlineAtMs: Date.now() - 1,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
