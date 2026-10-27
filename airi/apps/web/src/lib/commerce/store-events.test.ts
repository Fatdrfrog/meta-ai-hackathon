/** @jest-environment node */

const mockApply = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/mongo-errors", () => ({
  isMongoDuplicateKeyError: (error: { code?: number }) => error?.code === 11000,
}));
jest.mock("@/models/website-commerce-event", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));
jest.mock("@/models/website-commerce-settings", () => ({
  __esModule: true,
  default: { updateOne: jest.fn() },
}));
jest.mock("@/lib/conversions/commerce-events", () => ({
  CommerceEventError: class MockCommerceEventError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));
jest.mock("./carts", () => ({
  applyWebsiteStoreEvent: (...args: unknown[]) => mockApply(...args),
}));

import { CommerceEventError } from "@/lib/conversions/commerce-events";
import connectDB from "@/lib/mongoose";
import WebsiteCommerceEvent from "@/models/website-commerce-event";
import WebsiteCommerceSettings from "@/models/website-commerce-settings";
import {
  assertMatchingWebsiteCommerceEventReceipt,
  drainWebsiteCommerceEvents,
  storeWebsiteCommerceEvent,
  WebsiteCommerceEventError,
  websiteCommerceEventHash,
  type StoreEvent,
} from "./store-events";

const mockConnect = connectDB as jest.Mock;
const mockCreate = WebsiteCommerceEvent.create as jest.Mock;
const mockFindOne = WebsiteCommerceEvent.findOne as jest.Mock;
const mockFindOneAndUpdate = WebsiteCommerceEvent.findOneAndUpdate as jest.Mock;
const mockEventUpdate = WebsiteCommerceEvent.updateOne as jest.Mock;
const mockSettingsUpdate = WebsiteCommerceSettings.updateOne as jest.Mock;

const event: StoreEvent = {
  eventId: "event-1",
  provider: "generic",
  workspaceId: "workspace-1",
  widgetSourceId: "widget-1",
  cartId: "cart-1",
  orderId: "order-1",
  type: "purchase",
  occurredAt: "2026-09-12T08:00:00.000Z",
  transactionId: "payment-1",
  value: 50,
  currency: "USD",
};

function receipt(payloadHash: string) {
  return {
    select: () => ({ lean: async () => ({ payloadHash }) }),
  };
}

describe("website commerce event receipts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockSettingsUpdate.mockResolvedValue({ modifiedCount: 1 });
  });

  it("treats an identical provider retry as a deduplicated success", async () => {
    mockCreate.mockRejectedValueOnce({ code: 11000 });
    mockFindOne.mockReturnValue(receipt(websiteCommerceEventHash(event)));
    await expect(storeWebsiteCommerceEvent(event)).resolves.toMatchObject({
      created: false,
    });
    expect(mockSettingsUpdate).toHaveBeenCalledWith(
      { widgetSourceId: "widget-1", workspaceId: "workspace-1" },
      { $max: { lastEventAt: expect.any(Date) } }
    );
  });

  it("returns a conflict when the same provider receipt has different facts", async () => {
    mockCreate.mockRejectedValueOnce({ code: 11000 });
    mockFindOne.mockReturnValue(receipt("0".repeat(64)));
    await expect(storeWebsiteCommerceEvent(event)).rejects.toMatchObject({
      status: 409,
    });
    expect(mockSettingsUpdate).not.toHaveBeenCalled();
  });

  it("hashes tenant scope and all normalized financial facts", () => {
    expect(websiteCommerceEventHash(event)).not.toBe(
      websiteCommerceEventHash({ ...event, workspaceId: "workspace-2" })
    );
    expect(() =>
      assertMatchingWebsiteCommerceEventReceipt(
        { payloadHash: "f".repeat(64) },
        event
      )
    ).toThrow(WebsiteCommerceEventError);
  });

  it("terminalizes a permanent commerce conflict instead of retrying forever", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      lean: async () => ({
        ...event,
        _id: "event-row-1",
        attempts: 1,
        createdAt: new Date(),
      }),
    });
    mockApply.mockRejectedValueOnce(
      new CommerceEventError("refund_exceeds_purchase", 409)
    );
    mockEventUpdate.mockResolvedValueOnce({ modifiedCount: 1 });

    await expect(
      drainWebsiteCommerceEvents({
        limit: 1,
        deadlineAtMs: Date.now() + 10_000,
      })
    ).resolves.toMatchObject({ unmatched: 1, retried: 0 });
    expect(mockEventUpdate).toHaveBeenCalledWith(
      { _id: "event-row-1", status: "pending", attempts: 1 },
      {
        $set: {
          status: "unmatched",
          completedAt: expect.any(Date),
          error: expect.stringContaining("Store event processing failed"),
        },
      }
    );
  });
});
