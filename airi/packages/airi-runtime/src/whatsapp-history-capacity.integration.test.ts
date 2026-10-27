import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import WhatsAppWebhookEvent from "./whatsapp-webhook-event-model";
import {
  reserveWhatsAppHistoryImportCapacity,
  setWhatsAppHistoryImportCapacity,
} from "./whatsapp-history-import-store";

test(
  "Mongo history reservations are atomic across companies, replay, failure, and operator resumption",
  { skip: !process.env.RUNTIME_COST_TEST_MONGO, timeout: 60_000 },
  async () => {
    const uri = process.env.RUNTIME_COST_TEST_MONGO!;
    assert.match(
      uri,
      /^mongodb:\/\/127\.0\.0\.1:27278\/airi_runtime_cost_test\?/,
    );
    await mongoose.connect(uri);
    try {
      await mongoose.connection.dropDatabase();
      const ids = Array.from(
        { length: 5 },
        () => new mongoose.Types.ObjectId(),
      );
      await WhatsAppWebhookEvent.collection.insertMany(
        ids.map((_id) => ({
          _id,
          status: "processing",
          processingLeaseId: "lease",
          historyImport: { role: "chunk" },
        })),
      );
      await setWhatsAppHistoryImportCapacity({
        companyId: "a",
        maxMessages: 3,
        maxBytes: 100,
      });
      await setWhatsAppHistoryImportCapacity({
        companyId: "b",
        maxMessages: 3,
        maxBytes: 100,
      });
      const reserve = (index: number, companyId = "a") =>
        reserveWhatsAppHistoryImportCapacity({
          companyId,
          eventId: ids[index]!.toString(),
          processingLeaseId: "lease",
          messages: 2,
          bytes: 40,
        });
      const [left, right, other] = await Promise.all([
        reserve(0),
        reserve(1),
        reserve(2, "b"),
      ]);
      assert.equal(
        [left, right].filter((result) => result === "reserved").length,
        1,
      );
      assert.equal(other, "reserved");
      const winner = left === "reserved" ? 0 : 1;
      const blocked = winner === 0 ? 1 : 0;
      assert.equal(await reserve(winner), "reserved");
      assert.equal(await reserve(blocked), "limited");
      await assert.rejects(
        reserveWhatsAppHistoryImportCapacity({
          companyId: "a",
          eventId: ids[3]!.toString(),
          processingLeaseId: "old-lease",
          messages: 1,
          bytes: 10,
        }),
        /lease/,
      );
      const budget = await mongoose.connection
        .collection("whatsapp_history_import_budgets")
        .findOne({ _id: "a" as never });
      assert.equal(budget?.messagesUsed, 2);
      assert.equal(budget?.bytesUsed, 40);
      await WhatsAppWebhookEvent.updateOne(
        { _id: ids[blocked] },
        {
          $set: {
            status: "received",
            "historyImport.capacityPaused": true,
            "historyImport.capacityCompanyId": "a",
            nextRetryAt: new Date(Date.now() + 3600_000),
          },
        },
      );
      await setWhatsAppHistoryImportCapacity({
        companyId: "a",
        maxMessages: 5,
        maxBytes: 100,
      });
      const resumed = await WhatsAppWebhookEvent.findById(ids[blocked]).lean<{
        historyImport?: { capacityPaused?: boolean };
      } | null>();
      assert.equal(
        (resumed?.historyImport as { capacityPaused?: boolean }).capacityPaused,
        false,
      );
      await WhatsAppWebhookEvent.updateOne(
        { _id: ids[blocked] },
        { $set: { status: "processing" } },
      );
      assert.equal(await reserve(blocked), "reserved");
      assert.equal(await reserve(4), "limited");
      await assert.rejects(
        setWhatsAppHistoryImportCapacity({
          companyId: "a",
          maxMessages: 1,
          maxBytes: 100,
        }),
        /used|capacity/,
      );
      await WhatsAppWebhookEvent.collection.insertMany(
        Array.from({ length: 1001 }, () => ({
          status: "received",
          historyImport: { capacityCompanyId: "b", capacityPaused: true },
        })),
      );
      await setWhatsAppHistoryImportCapacity({
        companyId: "b",
        maxMessages: 10,
        maxBytes: 1000,
      });
      assert.equal(
        await WhatsAppWebhookEvent.countDocuments({
          "historyImport.capacityCompanyId": "b",
          "historyImport.capacityPaused": true,
        }),
        1,
      );
    } finally {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
