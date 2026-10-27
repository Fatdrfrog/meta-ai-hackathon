const mockConnectDB = jest.fn();
const mockProcessPayload = jest.fn();
const mockSelect = jest.fn();
const mockLean = jest.fn();
const mockEventModel = {
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn(),
};
const mockRuntimeDependencies = { marker: "worker-runtime-dependencies" };

jest.mock("@icecore/airi-runtime/mongoose", () => ({
  __esModule: true,
  default: mockConnectDB,
}));
// The history import store imports the model statically, so this factory runs
// before mockEventModel is initialised; read it lazily.
jest.mock("@icecore/airi-runtime/whatsapp-webhook-event-model", () => ({
  __esModule: true,
  get default() {
    return mockEventModel;
  },
}));
jest.mock("@icecore/airi-runtime/whatsapp-webhook-runtime", () => ({
  processWhatsAppWebhookPayload: mockProcessPayload,
}));
// The worker uses a .js specifier for this TS module in its dynamic import.
jest.mock(
  "../../../../../temporal-worker/src/whatsapp-webhook-runtime-dependencies.js",
  () => ({ whatsappWebhookRuntimeDependencies: mockRuntimeDependencies }),
  { virtual: true }
);
// Static .js specifiers of the activity: keep the real retry policy and stub
// the Pub/Sub history dispatcher (no history events in these cases).
jest.mock(
  "../../../../../temporal-worker/src/whatsapp-webhook-retry-policy.js",
  () =>
    jest.requireActual(
      "../../../../../temporal-worker/src/whatsapp-webhook-retry-policy"
    ),
  { virtual: true }
);
jest.mock(
  "../../../../../temporal-worker/src/whatsapp-history-import-dispatch.js",
  () => ({ publishWhatsAppHistoryChildren: jest.fn() }),
  { virtual: true }
);

import { WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION } from "@icecore/temporal";
import {
  DurableWhatsAppWebhookEventFailure,
  processStoredWhatsAppWebhookEvent,
} from "../../../../../temporal-worker/src/activities/whatsapp-webhook-processor";

const input = {
  contractVersion: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
  eventId: "event-1",
  dedupeKey: "dedupe-1",
  field: "messages",
  orderingKey: "phone-1",
  receivedAt: "2026-09-18T00:00:00.000Z",
  providerSignatureVerified: true,
};

function storedEvent(providerSignatureVerified?: unknown) {
  const body = {
    object: "whatsapp_business_account",
    providerSignatureVerified: true,
    entry: [{ id: "waba-1", changes: [{ field: "messages", value: {} }] }],
  };
  return {
    _id: input.eventId,
    status: "processing",
    field: "messages",
    phoneNumberId: "phone-1",
    payload: {
      body,
      rawBody: JSON.stringify(body),
      providerSignatureVerified: true,
    },
    ...(providerSignatureVerified !== undefined
      ? { providerSignatureVerified }
      : {}),
    attempts: 1,
    maxAttempts: 12,
  };
}

describe("stored WhatsApp webhook worker activity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockSelect.mockReturnValue({ lean: mockLean });
    mockEventModel.findOneAndUpdate.mockReturnValue({ select: mockSelect });
    mockEventModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
    mockProcessPayload.mockResolvedValue({ ok: true, code: "ok" });
  });

  it.each([true, false, undefined, "true"])(
    "loads verification from the claimed database row, ignoring payload/input claims: %s",
    async verified => {
      const event = storedEvent(verified);
      mockLean.mockResolvedValue(event);

      await expect(processStoredWhatsAppWebhookEvent(input)).resolves.toEqual({
        eventId: input.eventId,
        status: "completed",
        runtimeCode: "ok",
      });

      expect(mockConnectDB).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\s)providerSignatureVerified(?:\s|$)/)
      );
      expect(mockProcessPayload).toHaveBeenCalledWith(mockRuntimeDependencies, {
        body: event.payload.body,
        rawBody: event.payload.rawBody,
        providerSignatureVerified: verified === true,
        eventId: input.eventId,
        dedupeKey: input.dedupeKey,
        suppressAiriIngress: undefined,
        suppressRealtime: undefined,
      });
      expect(mockEventModel.updateOne).toHaveBeenCalledWith(
        { _id: input.eventId, processingLeaseId: expect.any(String) },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "completed" }),
        })
      );
    }
  );

  it.each(["rejected", "thrown"])(
    "durably retries a %s runtime failure without losing verified provenance",
    async failure => {
      mockLean.mockResolvedValue(storedEvent(true));
      if (failure === "thrown") {
        mockProcessPayload.mockRejectedValueOnce(
          new Error("acceptance persistence unavailable")
        );
      } else {
        mockProcessPayload.mockResolvedValueOnce({
          ok: false,
          code: "server_error",
          message: "acceptance persistence unavailable",
        });
      }

      await expect(
        processStoredWhatsAppWebhookEvent(input)
      ).rejects.toBeInstanceOf(DurableWhatsAppWebhookEventFailure);
      expect(mockEventModel.updateOne).toHaveBeenLastCalledWith(
        { _id: input.eventId, processingLeaseId: expect.any(String) },
        {
          $set: {
            status: "failed",
            lastError: expect.stringContaining(
              "acceptance persistence unavailable"
            ),
            nextRetryAt: expect.any(Date),
            processingLeaseId: null,
          },
        }
      );
      expect(mockEventModel.updateOne.mock.calls[0][1].$set).not.toHaveProperty(
        "providerSignatureVerified"
      );
      await expect(
        processStoredWhatsAppWebhookEvent(input)
      ).resolves.toMatchObject({ status: "completed" });
      expect(mockProcessPayload).toHaveBeenCalledTimes(2);
      for (const [, params] of mockProcessPayload.mock.calls) {
        expect(params.providerSignatureVerified).toBe(true);
      }
    }
  );
});
