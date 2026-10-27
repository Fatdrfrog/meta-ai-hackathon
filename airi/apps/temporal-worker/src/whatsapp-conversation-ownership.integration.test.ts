import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import {
  readDefaultExport,
  readRuntimeExport,
} from "@icecore/airi-runtime/module-interop";
import type { WhatsAppCallWebhookEvent } from "@icecore/shared/lib/whatsapp/webhook-call-events";

const fixtureUri = process.env.MONGO_COST_TEST_URI;

test(
  "the production worker call adapter enrolls one existing owner and links the call in Mongo",
  { skip: !fixtureUri },
  async () => {
    const uri = new URL(fixtureUri!);
    assert.equal(uri.protocol, "mongodb:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname));
    assert.equal(uri.port, "27277");
    assert.equal(uri.username, "");
    assert.equal(uri.password, "");
    assert.equal(uri.pathname, "/airi_mongo_index_cost_tests");
    assert.equal(uri.searchParams.get("replicaSet"), "airiCostTests");
    uri.pathname = `/airi_ownership_loader_${randomUUID().replaceAll("-", "")}`;
    process.env.MONGODB_URI = uri.toString();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "ownership-loader-test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      "ownership-loader-test-service-role";

    await mongoose.connect(uri.toString(), {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5_000,
    });
    try {
      // Load the real adapter through the worker's tsx loader, not Jest's
      // transformed web modules or a dependency-injected core substitute.
      const { linkWhatsAppCallSessionToConversation } = await import(
        "./whatsapp-call-conversation-linker.js"
      );
      const conversationModule = await import("@/models/conversation");
      const Conversation = readRuntimeExport<
        typeof conversationModule.Conversation
      >(conversationModule, "Conversation");
      const CallSession = readDefaultExport<
        typeof import("@/models/whatsapp-call-session").default
      >(await import("@/models/whatsapp-call-session"));
      const ownership = await import(
        "@icecore/airi-runtime/whatsapp-conversation-ownership"
      );
      const buildIdentityKey = readRuntimeExport<
        typeof ownership.buildWhatsAppConversationIdentityKey
      >(ownership, "buildWhatsAppConversationIdentityKey");
      const workspaceId = "ownership-loader-workspace";
      const sourceId = "ownership-loader-source";
      const conversationId = new mongoose.Types.ObjectId();
      const customerId = new mongoose.Types.ObjectId();
      const phone = "77700000001";
      const bsuid = "US.Loader.Customer";
      const callId = "wacid.ownership-loader";
      await Conversation.collection.insertOne({
        _id: conversationId,
        workspaceId,
        sourceId,
        channel: "whatsapp",
        chat: `wa_${phone}`,
        user: `wa_${phone}`,
        customerId,
        status: "open",
        messages: [],
      });
      await CallSession.collection.insertOne({
        workspaceId,
        sourceId,
        callId,
        conversationId: null,
        customerId: null,
      });
      const event: WhatsAppCallWebhookEvent = {
        kind: "call",
        callId,
        event: "connect",
        status: null,
        direction: "USER_INITIATED",
        from: phone,
        to: null,
        fromUserId: bsuid,
        fromParentUserId: null,
        toUserId: null,
        toParentUserId: null,
        recipientId: null,
        recipientUserId: null,
        recipientParentUserId: null,
        contactUserId: bsuid,
        contactParentUserId: null,
        contactWaId: phone,
        contactName: "Loader fixture",
        contactUsername: null,
        countryCode: null,
        timestamp: "1791694800",
        wabaId: "loader-waba",
        phoneNumberId: "loader-phone",
        bizOpaqueCallbackData: null,
        sessionSdpType: null,
        sessionSdp: null,
        durationSeconds: null,
        errorCode: null,
        errorMessage: null,
        rawEvent: { id: callId, event: "connect" },
      };

      const linked = await linkWhatsAppCallSessionToConversation({
        workspaceId,
        sourceId,
        event,
      });

      assert.deepEqual(linked, {
        conversationId: String(conversationId),
        customerId: String(customerId),
        createdConversation: false,
      });
      assert.equal(await Conversation.countDocuments({ workspaceId }), 1);
      const stored = await Conversation.collection.findOne({
        _id: conversationId,
      });
      const key = (chatId: string) =>
        buildIdentityKey({
          workspaceId,
          sourceId,
          chatId,
        });
      assert.equal(stored?.whatsappConversationIdentityKey, key(phone));
      assert.deepEqual(
        new Set(stored?.whatsappConversationIdentityKeys as string[]),
        new Set([key(phone), key(bsuid)]),
      );
      const session = await CallSession.collection.findOne({ callId });
      assert.equal(String(session?.conversationId), String(conversationId));
      assert.equal(String(session?.customerId), String(customerId));
    } finally {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
