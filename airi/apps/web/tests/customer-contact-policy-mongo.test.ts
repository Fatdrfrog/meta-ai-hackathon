import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

test(
  "retry contact preview matches canonical Mongo identities without writing reservations",
  { timeout: 30_000 },
  async () => {
    const databaseName = `airi_contact_fixture_${process.pid}_${Date.now()}`;
    // Use the existing dedicated fixture replica set, never the developer's URI.
    process.env.MONGODB_URI = `mongodb://127.0.0.1:28021/${databaseName}?replicaSet=airiRequestsTest`;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-key";
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(process.env.MONGODB_URI, {
      autoIndex: false,
      autoCreate: false,
      monitorCommands: true,
    });
    try {
      const {
        previewCustomerMarketingContactEligibility,
        reserveCustomerMarketingContact,
      } = await import("../src/lib/campaign/customer-contact-policy");
      const {
        default: Customer,
        CUSTOMER_CONTACT_PHONE_INDEX_NAME,
        CUSTOMER_CONTACT_PHONE_INDEX_KEYS,
        CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS,
      } = await import("../src/models/customer");
      const { default: Reservation } = await import(
        "../src/models/customer-contact-reservation"
      );
      const { Conversation } = await import("../src/models/conversation");
      const workspaceId = "fixture-workspace";
      const at = new Date("2026-09-15T10:55:29.411Z");
      const earlierCustomerId = new mongoose.Types.ObjectId(
        "100000000000000000000001"
      );
      const laterCustomerId = new mongoose.Types.ObjectId(
        "200000000000000000000001"
      );
      const conversationId = new mongoose.Types.ObjectId();
      await Customer.collection.insertMany([
        // Lowest matching _id wins even when only the +phone alias matches it.
        {
          _id: earlierCustomerId,
          workspaceId,
          status: "active",
          identities: [{ type: "phone", normalizedValue: "+77010000001" }],
          profileSummary: { contactPoints: { phones: ["77010000002"] } },
        },
        {
          _id: laterCustomerId,
          workspaceId,
          status: "active",
          profileSummary: {
            contactPoints: { phones: ["77010000001", "77010000003"] },
          },
        },
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000001"),
          workspaceId: "other-workspace",
          status: "active",
          identities: [{ type: "phone", normalizedValue: "77010000001" }],
        },
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000002"),
          workspaceId,
          status: "archived",
          profileSummary: { contactPoints: { phones: ["77010000001"] } },
        },
      ]);
      await Customer.collection.insertMany(
        Array.from({ length: 1_000 }, (_, index) => ({
          workspaceId,
          status: "active",
          profileSummary: {
            contactPoints: {
              phones: [`7901${String(index).padStart(7, "0")}`],
            },
          },
        }))
      );
      await Customer.collection.createIndex(CUSTOMER_CONTACT_PHONE_INDEX_KEYS, {
        name: CUSTOMER_CONTACT_PHONE_INDEX_NAME,
      });
      await Customer.collection.createIndex(
        CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS
      );
      assert.ok(
        Customer.schema
          .indexes()
          .some(
            ([keys, options]) =>
              options.name === CUSTOMER_CONTACT_PHONE_INDEX_NAME &&
              JSON.stringify(keys) ===
                JSON.stringify(CUSTOMER_CONTACT_PHONE_INDEX_KEYS)
          )
      );
      await Conversation.collection.insertOne({
        _id: conversationId,
        workspaceId,
        customerId: earlierCustomerId,
      });
      await Reservation.collection.createIndex(
        { workspaceId: 1, identity: 1 },
        { unique: true }
      );
      const hash = (identity: string) =>
        createHash("sha256").update(identity).digest("hex");
      await Reservation.collection.insertOne({
        workspaceId,
        identity: hash(`customer:${earlierCustomerId}`),
        version: 1,
        contacts: [{ key: "original", at }],
      });
      const before = await Reservation.collection.find({}).toArray();
      const commands: string[] = [];
      let customerPipeline: Record<string, unknown>[] | undefined;
      const record = (event: {
        commandName: string;
        command: { aggregate?: string; pipeline?: Record<string, unknown>[] };
      }) => {
        commands.push(event.commandName);
        if (event.command.aggregate === Customer.collection.collectionName)
          customerPipeline = event.command.pipeline;
      };
      mongoose.connection.getClient().on("commandStarted", record);
      const recipients = [
        { phone: "77010000001" },
        { phone: "77010000002" },
        { phone: "77010000003", conversationId: String(conversationId) },
        { phone: "77010000004" },
      ];
      const preview = await previewCustomerMarketingContactEligibility({
        workspaceId,
        recipients,
        now: at,
      });
      mongoose.connection.getClient().off("commandStarted", record);
      assert.deepEqual(preview, {
        blockedRecipientCount: 3,
        eligibleRecipientCount: 1,
        nextEligibleAt: "2026-09-16T10:55:29.411Z",
      });
      assert.equal(
        commands.filter(command => command === "aggregate").length,
        1
      );
      assert.equal(
        commands.filter(command =>
          ["insert", "update", "delete", "findAndModify"].includes(command)
        ).length,
        0
      );
      assert.deepEqual(await Reservation.collection.find({}).toArray(), before);
      assert.ok(customerPipeline);
      const explain = await Customer.collection
        .aggregate(customerPipeline)
        .explain("executionStats");
      const cursorPlan = explain.stages?.[0]?.$cursor || explain;
      const winningPlan = JSON.stringify(cursorPlan.queryPlanner.winningPlan);
      assert.ok(!winningPlan.includes("COLLSCAN"), winningPlan);
      assert.ok(
        winningPlan.includes(CUSTOMER_CONTACT_PHONE_INDEX_NAME),
        winningPlan
      );
      assert.ok(
        winningPlan.includes(
          "workspaceId_1_identities.type_1_identities.normalizedValue_1"
        ),
        winningPlan
      );
      assert.ok(
        cursorPlan.executionStats.totalDocsExamined <= 4,
        JSON.stringify(cursorPlan.executionStats)
      );
      // The send path selects the same customer and still blocks at reservation time.
      assert.equal(
        await reserveCustomerMarketingContact({
          workspaceId,
          phone: "77010000001",
          deliveryKey: "retry",
          now: at,
        }),
        "contact_frequency_limit"
      );
      assert.deepEqual(
        await previewCustomerMarketingContactEligibility({
          workspaceId,
          recipients,
          now: new Date("2026-09-16T10:55:29.411Z"),
        }),
        {
          blockedRecipientCount: 0,
          eligibleRecipientCount: 4,
          nextEligibleAt: null,
        }
      );
      const beforeBulkPreview = await Reservation.collection.find({}).toArray();
      commands.length = 0;
      mongoose.connection.getClient().on("commandStarted", record);
      assert.deepEqual(
        await previewCustomerMarketingContactEligibility({
          workspaceId,
          recipients: Array.from({ length: 401 }, (_, index) => ({
            phone: String(77090000000 + index),
          })),
          now: at,
        }),
        {
          blockedRecipientCount: 0,
          eligibleRecipientCount: 401,
          nextEligibleAt: null,
        }
      );
      mongoose.connection.getClient().off("commandStarted", record);
      assert.equal(
        commands.filter(command => command === "aggregate").length,
        5,
        "Five bounded chunks must complete across multiple lookup waves"
      );
      assert.equal(
        commands.filter(command =>
          ["insert", "update", "delete", "findAndModify"].includes(command)
        ).length,
        0,
        "Concurrent eligibility reads must not create reservations"
      );
      assert.deepEqual(
        await Reservation.collection.find({}).toArray(),
        beforeBulkPreview
      );
    } finally {
      const db = mongoose.connection.db;
      if (
        db?.databaseName === databaseName &&
        databaseName.startsWith("airi_contact_fixture_")
      )
        await db.dropDatabase();
      await mongoose.disconnect();
    }
  }
);
