import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import {
  readDefaultExport,
  readRuntimeExport,
} from "@icecore/airi-runtime/module-interop";
import type { AiriConversationTurnProcessResult } from "@icecore/temporal";
import type { ChatDocument, ConversationDocument } from "@/types/models";

const fixtureUri = process.env.MONGO_COST_TEST_URI;

test(
  "worker releases an unsent service admission produced without an explicit dispatch policy",
  { skip: !fixtureUri },
  async (t) => {
    const uri = new URL(fixtureUri!);
    assert.equal(uri.protocol, "mongodb:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname));
    assert.equal(uri.port, "27277");
    assert.equal(uri.username, "");
    assert.equal(uri.password, "");
    assert.equal(uri.pathname, "/airi_mongo_index_cost_tests");
    assert.equal(uri.searchParams.get("replicaSet"), "airiCostTests");
    uri.pathname = `/airi_disposition_loader_${randomUUID().replaceAll("-", "")}`;
    process.env.MONGODB_URI = uri.toString();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "disposition-loader-test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      "disposition-loader-test-service-role";

    await mongoose.connect(uri.toString(), {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5_000,
    });
    try {
      // Invoke the real activity with its default production execution store.
      // Jest transforms web modules differently and does not cover this loader.
      const { recordAiriConversationTurnDispositionActivity } = await import(
        "./airi-auto-reply.js"
      );
      const execution = await import("@/lib/temporal/airi-turn-execution");
      const claimPreparation = readRuntimeExport<
        typeof execution.claimAiriTurnPreparation
      >(execution, "claimAiriTurnPreparation");
      const completePreparation = readRuntimeExport<
        typeof execution.completeAiriTurnPreparation
      >(execution, "completeAiriTurnPreparation");
      const scenarioState = await import(
        "@/lib/airi/reply/runtime/auto-reply-scenario-state"
      );
      const persistScenarioState = readRuntimeExport<
        typeof scenarioState.persistScenarioState
      >(scenarioState, "persistScenarioState");
      const conversationModule = await import("@/models/conversation");
      const Conversation = readRuntimeExport<
        typeof conversationModule.Conversation
      >(conversationModule, "Conversation");
      const Message = readDefaultExport<
        typeof import("@/models/message").default
      >(await import("@/models/message"));
      const TurnContext = readDefaultExport<
        typeof import("@/models/airi-turn-context").default
      >(await import("@/models/airi-turn-context"));
      const policyModule = await import(
        "@/lib/airi/scenario/scenario-entry-policy"
      );
      const evaluatePolicy = readRuntimeExport<
        typeof policyModule.evaluateScenarioEntryPolicy
      >(policyModule, "evaluateScenarioEntryPolicy");
      const outboundModule = await import(
        "@/lib/airi/reply/delivery/outbound-message"
      );
      const sendAndPersistOutbound = readRuntimeExport<
        typeof outboundModule.sendAndPersistOutbound
      >(outboundModule, "sendAndPersistOutbound");
      const captureModule = await import(
        "@/lib/airi/reply/delivery/temporal-outbound"
      );
      const runWithTemporalOutboundCapture = readRuntimeExport<
        typeof captureModule.runWithTemporalOutboundCapture
      >(captureModule, "runWithTemporalOutboundCapture");
      const completeScenarioAfterDelivery = readRuntimeExport<
        typeof captureModule.completeScenarioAfterDelivery
      >(captureModule, "completeScenarioAfterDelivery");

      await t.test(
        "terminal customer-behavior disposition resolves its model",
        async () => {
          const BehaviorRun = readDefaultExport<
            typeof import("@/models/scenario-behavior-run").default
          >(await import("@/models/scenario-behavior-run"));
          const runId = new mongoose.Types.ObjectId();
          const conversationId = new mongoose.Types.ObjectId();
          const workspaceId = "loader-behavior-workspace";
          await BehaviorRun.collection.insertOne({
            _id: runId,
            workspaceId,
            conversationId,
            status: "signaled",
          });
          await recordAiriConversationTurnDispositionActivity({
            turn: {
              workspaceId,
              conversationId: String(conversationId),
              messageId: `customer-behavior:${runId}`,
              turnContextId: `loader-behavior:${runId}`,
              channel: "whatsapp",
            },
            status: "terminal",
            stage: "prepare",
            attempt: 1,
            updatedAt: new Date().toISOString(),
            error: "terminal",
            nextAttemptAt: null,
          });
          assert.equal(
            (await BehaviorRun.findById(runId).lean<{ status: string }>())!
              .status,
            "skipped",
          );
        },
      );

      const workspaceId = "loader-fixture-workspace";
      const conversationId = new mongoose.Types.ObjectId();
      const sourceMessageId = new mongoose.Types.ObjectId().toString();
      const scenarioId = "loader-fixture-scenario";
      const actionNodeId = "greeting-buttons";
      const capturedConversation = {
        _id: conversationId,
        workspaceId,
        airi_scenario_state: null,
      };
      await Conversation.collection.insertOne(capturedConversation);
      const runtime = {
        scenarioId,
        scenarioName: "Entry",
        scenarioRevisionFingerprint: "revision-1",
        actionType: "reply",
        selectedActionNodeId: actionNodeId,
        selectedPathNodeIds: ["incoming", actionNodeId],
        nextActionNodeId: actionNodeId,
        completesScenario: false,
      };
      await persistScenarioState({
        conversationId: String(conversationId),
        scenarioRuntime: runtime as never,
        messageId: sourceMessageId,
        baseState: null,
      });
      const admitted =
        await Conversation.findById(conversationId).lean<
          Pick<ConversationDocument, "airi_scenario_state">
        >();
      assert.equal(admitted!.airi_scenario_state?.lockedScenarioId, scenarioId);
      assert.deepEqual(
        evaluatePolicy({
          scenarioId,
          entryPolicy: "once_per_conversation",
          state: admitted!.airi_scenario_state,
        }),
        { eligible: false, reason: "blocked_by_once_per_conversation" },
      );
      const turn = {
        workspaceId,
        conversationId: String(conversationId),
        messageId: sourceMessageId,
        turnContextId: `loader:${sourceMessageId}`,
        channel: "whatsapp" as const,
      };
      const captured = await runWithTemporalOutboundCapture({
        workspaceId,
        conversationId: String(conversationId),
        messageId: sourceMessageId,
        capturePostDeliveryEffects: true,
        run: async () => {
          // The real service producer selects strict dispatch later at the
          // transport edge; its preparation checkpoint has no policy override.
          const outbound = await sendAndPersistOutbound({
            type: "whatsapp",
            workspaceId,
            conversation:
              capturedConversation as unknown as ConversationDocument,
            chatDocument: { _id: "fixture-chat" } as ChatDocument,
            content: "Choose language",
            scenarioOrigin: { scenarioId, actionNodeId },
            whatsappServiceMessage: {
              version: 1,
              message: {
                kind: "reply_buttons",
                body: { mode: "fixed", text: "Choose language" },
                options: [{ id: "ru", label: "Russian" }],
              },
            },
          });
          await completeScenarioAfterDelivery({
            conversationId: String(conversationId),
            scenarioRuntime: runtime as never,
            baseState: null,
            lastMessageId: String(outbound._id),
          });
        },
      });
      assert.ok(captured.pendingDelivery);
      assert.equal(captured.pendingDelivery.dispatchPolicy, undefined);
      const pendingDelivery = {
        ...captured.pendingDelivery,
        postDeliveryEffects: captured.postDeliveryEffects,
      };
      const reservedMessageId = new mongoose.Types.ObjectId(
        pendingDelivery.reservedMessageId,
      );
      const deliveryKey = pendingDelivery.deliveryKey;
      const result: AiriConversationTurnProcessResult = {
        messageId: sourceMessageId,
        completedAt: new Date().toISOString(),
        outcome: {
          responseStatus: 200,
          executionStatus: "completed",
          skippedConcurrent: false,
        },
        pendingDelivery,
      };
      const claim = await claimPreparation(turn);
      assert.equal(claim.status, "claimed");
      if (claim.status !== "claimed")
        throw new Error("Fixture did not claim preparation");
      await completePreparation(claim, result);
      await Message.collection.insertOne({
        _id: reservedMessageId,
        temporalDeliveryKey: deliveryKey,
        temporalDispatch: {
          version: 1,
          state: "not_attempted",
          deliveryKey,
          attemptToken: "dispatch",
          terminalCode: "newer_inbound",
        },
      });
      const receipt = {
        turn,
        status: "terminal" as const,
        stage: "delivery" as const,
        attempt: 1,
        updatedAt: new Date().toISOString(),
        error: "not_attempted",
        nextAttemptAt: null,
      };
      await recordAiriConversationTurnDispositionActivity(receipt);
      const conversation =
        await Conversation.findById(conversationId).lean<
          Pick<ConversationDocument, "airi_scenario_state">
        >();
      assert.deepEqual(
        evaluatePolicy({
          scenarioId,
          entryPolicy: "once_per_conversation",
          state: conversation!.airi_scenario_state,
        }),
        { eligible: true },
      );
      assert.equal(conversation!.airi_scenario_state?.lockedScenarioId, null);
      assert.equal(
        conversation!.airi_scenario_state?.startedScenarios?.some(
          (entry) => entry.scenarioId === scenarioId,
        ),
        false,
      );
      const context = await TurnContext.findOne({
        turnContextId: turn.turnContextId,
      })
        .select("+turnDisposition")
        .lean<{ turnDisposition?: { status: string } }>();
      assert.equal(context!.turnDisposition?.status, "terminal");
      await recordAiriConversationTurnDispositionActivity(receipt);
      assert.equal(
        (await Message.findById(reservedMessageId)
          .select("+temporalDispatch")
          .lean<{ temporalDispatch?: { state: string } }>())!.temporalDispatch
          ?.state,
        "not_attempted",
      );
    } finally {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
