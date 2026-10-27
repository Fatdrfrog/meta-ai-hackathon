/** @jest-environment node */
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: async () => ({
    skippedOptIn: 0,
    marketingOptInWarningCount: 0,
  }),
}));
jest.mock("@/models/customer-contact-policy", () => ({
  __esModule: true,
  default: { findOne: () => ({ lean: async () => null }) },
}));
jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    aggregate: async (
      pipeline: Array<{
        $match: { $or: Array<Record<string, { $in: string[] }>> };
      }>
    ) =>
      pipeline[0]!.$match.$or[0]![
        "profileSummary.contactPoints.phones"
      ]!.$in.map(phone => ({
        _id: phone,
        customerId: "shared-customer",
      })),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: { find: jest.fn() },
}));

import CustomerContactReservation from "@/models/customer-contact-reservation";
import {
  partitionRecentlyContactedRecipients,
  reserveCustomerMarketingContact,
} from "./customer-contact-policy";

// Counts keep the contact-window assertions short.
async function previewContactCounts(
  input: Parameters<typeof partitionRecentlyContactedRecipients>[0]
) {
  const result = await partitionRecentlyContactedRecipients(input);
  return {
    blockedRecipientCount: result.recentlyContacted.length,
    eligibleRecipientCount: result.allowed.length,
    nextEligibleAt: result.nextEligibleAt,
  };
}

const mongoUri = process.env.CONTACT_POLICY_TEST_MONGODB_URI;
const describeMongo = mongoUri ? describe : describe.skip;
let workspaceId: string;
const at = new Date("2026-09-18T10:00:00Z");

describeMongo("customer contact reservation Mongo transaction contract", () => {
  beforeAll(async () => {
    const uri = new URL(mongoUri as string);
    if (
      !["127.0.0.1", "localhost"].includes(uri.hostname) ||
      uri.pathname !== "/airi_contact_policy_integration" ||
      !uri.searchParams.get("replicaSet")
    )
      throw new Error(
        "Contact policy integration tests require the isolated local replica-set database"
      );
    await mongoose.connect(mongoUri as string, {
      serverSelectionTimeoutMS: 5_000,
    });
    await CustomerContactReservation.createCollection();
    await CustomerContactReservation.createIndexes();
  });

  beforeEach(() => {
    workspaceId = "contact-policy-test-" + randomUUID();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await CustomerContactReservation.deleteMany({ workspaceId });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  const read = () =>
    CustomerContactReservation.find({ workspaceId })
      .sort({ identity: 1 })
      .lean();

  test("a rejected second phone creates no orphan slot and is eligible after the real contact expires", async () => {
    await expect(
      reserveCustomerMarketingContact({
        workspaceId,
        phone: "77010000001",
        deliveryKey: "accepted",
        now: at,
      })
    ).resolves.toBeNull();
    const before = await read();
    await expect(
      reserveCustomerMarketingContact({
        workspaceId,
        phone: "77010000002",
        deliveryKey: "rejected",
        now: new Date("2026-09-18T11:00:00Z"),
      })
    ).resolves.toBe("contact_frequency_limit");
    expect(await read()).toEqual(before);
    await expect(
      previewContactCounts({
        workspaceId,
        recipients: [{ phone: "77010000002" }],
        now: new Date("2026-09-19T10:01:00Z"),
      })
    ).resolves.toEqual({
      blockedRecipientCount: 0,
      eligibleRecipientCount: 1,
      nextEligibleAt: null,
    });
  });

  test("Mongo aborts the first identity insert when the second write fails", async () => {
    await reserveCustomerMarketingContact({
      workspaceId,
      phone: "77010000001",
      deliveryKey: "accepted",
      now: at,
    });
    const before = await read();
    const write = CustomerContactReservation.updateOne.bind(
      CustomerContactReservation
    );
    const failure = new Error(
      "Injected connection failure at customer identity"
    );
    let writes = 0;
    jest
      .spyOn(CustomerContactReservation, "updateOne")
      .mockImplementation((...args: Parameters<typeof write>) => {
        if (++writes === 2) throw failure;
        return write(...args);
      });
    await expect(
      reserveCustomerMarketingContact({
        workspaceId,
        phone: "77010000002",
        deliveryKey: "never-sent",
        now: new Date("2026-09-19T10:00:00Z"),
      })
    ).rejects.toBe(failure);
    expect(writes).toBe(2);
    expect(await read()).toEqual(before);
  });

  test("concurrent phones sharing one customer commit one delivery and no orphan identities", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        reserveCustomerMarketingContact({
          workspaceId,
          phone: "7701" + String(index).padStart(7, "0"),
          deliveryKey: "campaign-" + index,
          now: at,
        })
      )
    );
    expect(results.filter(result => result === null)).toHaveLength(1);
    expect(
      results.filter(result => result === "contact_frequency_limit")
    ).toHaveLength(11);
    const rows = await read();
    expect(rows).toHaveLength(2);
    const keys = new Set(
      rows.flatMap(row =>
        row.contacts.map((contact: { key: string }) => contact.key)
      )
    );
    expect(keys.size).toBe(1);
  }, 30_000);

  test("concurrent duplicate deliveries remain idempotent across both identities", async () => {
    const input = {
      workspaceId,
      phone: "77010000001",
      deliveryKey: "same-delivery",
      now: at,
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserveCustomerMarketingContact(input))
    );
    expect(results).toEqual(Array(12).fill(null));
    const rows = await read();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.version).toBe(1);
      expect(row.contacts).toEqual([{ key: input.deliveryKey, at }]);
    }
  }, 30_000);
});
