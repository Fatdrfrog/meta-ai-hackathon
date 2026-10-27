import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import type {
  AiriConversationTurnDisposition,
  AiriConversationTurnProcessResult,
} from "@icecore/temporal";

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  resolveActiveScenarioRuntime: jest.fn(),
}));

import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import AiriTurnContext from "@/models/airi-turn-context";
import { persistScenarioState } from "@/lib/airi/reply/runtime/auto-reply-scenario-state";
import { evaluateScenarioEntryPolicy } from "@/lib/airi/scenario/scenario-entry-policy";
import { resolveScenarioDeliveryOwnership } from "@icecore/airi-runtime/delivery-gates";
import { getScenarioActionOutcomeVirtualNodeId } from "@icecore/scenario-contracts";
import {
  claimAiriTurnPreparation,
  completeAiriTurnPreparation,
  recordAiriConversationTurnDisposition,
} from "./airi-turn-execution";

const fixtureUri = process.env.MONGO_COST_TEST_URI;
const suite = fixtureUri ? describe : describe.skip;

suite(
  "initial scenario admission after proven-unsent delivery (real Mongo)",
  () => {
    const workspaceId = "admission-fixture-workspace";
    const scenarioId = "admission-fixture-scenario";
    const actionNodeId = "greeting-buttons";
    const originalDate = new Date("2026-10-10T17:52:14.000Z");
    const newerDate = new Date("2026-10-10T17:52:18.000Z");
    const oldHandoff = new Date("2026-10-10T13:49:00.000Z");

    beforeAll(async () => {
      const uri = new URL(fixtureUri!);
      expect(uri.protocol).toBe("mongodb:");
      expect(["127.0.0.1", "localhost", "[::1]"]).toContain(uri.hostname);
      expect(uri.port).toBe("27277");
      expect(uri.username).toBe("");
      expect(uri.password).toBe("");
      expect(uri.pathname).toBe("/airi_mongo_index_cost_tests");
      expect(uri.searchParams.get("replicaSet")).toBe("airiCostTests");
      uri.pathname = `/airi_admission_${randomUUID().replaceAll("-", "")}`;
      await mongoose.connect(uri.toString(), {
        autoIndex: false,
        autoCreate: false,
        serverSelectionTimeoutMS: 5_000,
      });
    });
    afterAll(async () => {
      if (mongoose.connection.readyState !== 1) return;
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    beforeEach(async () => {
      await Promise.all([
        Conversation.collection.deleteMany({}),
        Message.collection.deleteMany({}),
        AiriTurnContext.collection.deleteMany({}),
      ]);
    });

    async function prepare(
      state = "not_attempted",
      pending = false,
      priorState: Record<string, unknown> = {},
      dispatchPolicy?: "at_most_once"
    ) {
      const conversationId = new mongoose.Types.ObjectId();
      const sourceMessageId = new mongoose.Types.ObjectId().toString();
      const reservedMessageId = new mongoose.Types.ObjectId();
      const deliveryKey = `admission:${sourceMessageId}`;
      const capturedConversation = {
        _id: conversationId,
        workspaceId,
        last_inbound_at: originalDate,
        airi_handoff_active: true,
        airi_handoff_started_at: oldHandoff,
        airi_scenario_state: {
          startedScenarios: [
            {
              scenarioId: "unrelated",
              firstMessageId: "earlier",
              startedAt: originalDate,
            },
          ],
          ...priorState,
        },
      };
      await Conversation.collection.insertOne(capturedConversation);
      const runtime = {
        scenarioId,
        scenarioName: "Entry",
        scenarioRevisionFingerprint: "revision-1",
        actionType: "reply",
        selectedActionNodeId: actionNodeId,
        selectedPathNodeIds: ["incoming", actionNodeId],
        nextActionNodeId: pending ? null : actionNodeId,
        completesScenario: false,
        ...(pending
          ? {
              pendingConditionNodeId:
                getScenarioActionOutcomeVirtualNodeId(actionNodeId),
              pendingSourceActionNodeId: actionNodeId,
            }
          : {}),
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose language" },
            options: [{ id: "ru", label: "Русский" }],
          },
        },
      };
      await persistScenarioState({
        conversationId: String(conversationId),
        scenarioRuntime: runtime as never,
        messageId: sourceMessageId,
        baseState: capturedConversation.airi_scenario_state,
      });
      const turn = {
        workspaceId,
        conversationId: String(conversationId),
        messageId: sourceMessageId,
        turnContextId: `context:${sourceMessageId}`,
        channel: "whatsapp" as const,
      };
      const result: AiriConversationTurnProcessResult = {
        messageId: sourceMessageId,
        completedAt: originalDate.toISOString(),
        outcome: {
          responseStatus: 200,
          executionStatus: "completed",
          skippedConcurrent: false,
        },
        pendingDelivery: {
          deliveryKey,
          reservedMessageId: String(reservedMessageId),
          ...(dispatchPolicy ? { dispatchPolicy } : {}),
          postDeliveryEffects: [
            {
              kind: "complete_scenario_after_dispatch",
              payload: {
                conversationId: String(conversationId),
                scenarioRuntime: runtime,
                baseState: capturedConversation.airi_scenario_state,
                lastMessageId: String(reservedMessageId),
              },
            },
          ],
          context: {
            type: "whatsapp",
            workspaceId,
            sourceMessageId,
            conversation: capturedConversation,
            scenarioOrigin: { scenarioId, actionNodeId },
            whatsappServiceMessage: runtime.actionWhatsAppServiceMessage,
          },
        },
      };
      const claim = await claimAiriTurnPreparation(turn);
      if (claim.status !== "claimed")
        throw new Error("Fixture did not claim preparation");
      await completeAiriTurnPreparation(claim, result);
      await Message.collection.insertOne({
        _id: reservedMessageId,
        temporalDeliveryKey: deliveryKey,
        temporalDispatch: {
          version: 1,
          state,
          deliveryKey,
          attemptToken: "dispatch",
          ...(state === "not_attempted"
            ? { terminalCode: "newer_inbound" }
            : {}),
        },
      });
      await Conversation.collection.updateOne(
        { _id: conversationId },
        {
          $set: { last_inbound_at: newerDate },
        }
      );
      const receipt: AiriConversationTurnDisposition = {
        turn,
        status: "terminal",
        stage: "delivery",
        attempt: 1,
        updatedAt: "2026-10-10T17:52:20.270Z",
        error: "not_attempted",
        nextAttemptAt: null,
      };
      return {
        conversationId,
        reservedMessageId,
        sourceMessageId,
        receipt,
        runtime,
        turn,
      };
    }

    it.each([false, true])(
      "releases a cancelled first buttons admission before the next inbound is prepared (pending=%s)",
      async pending => {
        const fixture = await prepare("not_attempted", pending);
        await recordAiriConversationTurnDisposition(fixture.receipt);
        const conversation = await Conversation.findById(
          fixture.conversationId
        ).lean();
        expect(
          evaluateScenarioEntryPolicy({
            scenarioId,
            entryPolicy: "once_per_conversation",
            state: conversation!.airi_scenario_state,
          })
        ).toEqual({ eligible: true });
        expect(conversation!.airi_scenario_state?.lockedScenarioId).toBeNull();
        expect(
          conversation!.airi_scenario_state?.pendingConditionNodeId
        ).toBeNull();
        expect(conversation!.airi_scenario_state?.startedScenarios).toEqual([
          expect.objectContaining({ scenarioId: "unrelated" }),
        ]);
        expect(conversation!.airi_handoff_active).toBe(true);
        expect(conversation!.airi_handoff_started_at).toEqual(oldHandoff);
        expect(
          (await Message.findById(fixture.reservedMessageId)
            .select("+temporalDispatch")
            .lean())!.temporalDispatch?.state
        ).toBe("not_attempted");
        // A repeated disposition is harmless, and a queued inbound can own the
        // greeting without relaxing the once-per-conversation policy.
        await recordAiriConversationTurnDisposition(fixture.receipt);
        await persistScenarioState({
          conversationId: String(fixture.conversationId),
          scenarioRuntime: fixture.runtime as never,
          messageId: "newer-inbound",
          baseState: conversation!.airi_scenario_state,
        });
        const reentered = await Conversation.findById(
          fixture.conversationId
        ).lean();
        expect(
          reentered!.airi_scenario_state!.startedScenarios!.filter(
            entry => entry.scenarioId === scenarioId
          )
        ).toHaveLength(1);
        expect(
          resolveScenarioDeliveryOwnership({
            capturedConversation: conversation,
            currentConversation: reentered,
            scenarioId,
            actionNodeId,
          })
        ).toEqual({ allow: true });
      }
    );

    it("fences a superseded reserved owner before refunding its initial admission", async () => {
      const fixture = await prepare("reserved");
      await recordAiriConversationTurnDisposition({
        ...fixture.receipt,
        status: "superseded",
        supersededByMessageId: "newer-inbound",
      });
      const owner = await Message.findById(fixture.reservedMessageId)
        .select("+temporalDispatch")
        .lean();
      expect(owner!.temporalDispatch?.state).toBe("not_attempted");
      expect(
        (await Conversation.findById(fixture.conversationId).lean())!
          .airi_scenario_state?.lockedScenarioId
      ).toBeNull();
    });

    it("also releases an explicitly strict initial delivery", async () => {
      const fixture = await prepare("not_attempted", false, {}, "at_most_once");
      await recordAiriConversationTurnDisposition(fixture.receipt);
      expect(
        (await Conversation.findById(fixture.conversationId).lean())!
          .airi_scenario_state?.lockedScenarioId
      ).toBeNull();
    });

    it("restores the prior scenario's ownership and collected answers", async () => {
      const fixture = await prepare("not_attempted", false, {
        lockedScenarioId: "unrelated",
        currentActionNodeId: "prior-question",
        lastMessageId: "earlier",
        collectedPromptInputs: {
          scenarioId: "unrelated",
          sourceActionNodeId: "prior-question",
          awaitingReply: true,
          values: { name: "Saved answer" },
        },
      });
      await recordAiriConversationTurnDisposition(fixture.receipt);
      const current = await Conversation.findById(
        fixture.conversationId
      ).lean();
      expect(current!.airi_scenario_state).toMatchObject({
        lockedScenarioId: "unrelated",
        currentActionNodeId: "prior-question",
        lastMessageId: "earlier",
        collectedPromptInputs: {
          scenarioId: "unrelated",
          values: { name: "Saved answer" },
        },
        startedScenarios: [
          expect.objectContaining({ scenarioId: "unrelated" }),
        ],
      });
    });

    it.each(["sent", "dispatching", "outcome_unknown"])(
      "does not refund an owner with %s acceptance",
      async state => {
        const fixture = await prepare(state);
        await recordAiriConversationTurnDisposition({
          ...fixture.receipt,
          status: "superseded",
        });
        expect(
          (await Conversation.findById(fixture.conversationId).lean())!
            .airi_scenario_state?.lockedScenarioId
        ).toBe(scenarioId);
      }
    );

    it.each([
      "new_handoff",
      "new_action",
      "continuation",
      "missing_owner",
      "accepted_anchor",
      "completed",
      "mismatched_key",
      "newer_disposition",
      "new_revision",
      "new_path",
      "claimed_owner",
      "provider_accepted",
      "missing_attempt_token",
      "untrusted_owner_version",
      "foreign_workspace",
      "foreign_conversation",
      "foreign_source_message",
    ])("preserves %s instead of clearing a different owner", async change => {
      const fixture = await prepare();
      if (change === "missing_owner")
        await Message.collection.deleteOne({ _id: fixture.reservedMessageId });
      else if (change === "mismatched_key")
        await Message.collection.updateOne(
          { _id: fixture.reservedMessageId },
          {
            $set: { "temporalDispatch.deliveryKey": "another-owner" },
          }
        );
      else if (
        [
          "claimed_owner",
          "provider_accepted",
          "missing_attempt_token",
          "untrusted_owner_version",
        ].includes(change)
      )
        await Message.collection.updateOne(
          { _id: fixture.reservedMessageId },
          {
            $set:
              change === "claimed_owner"
                ? { "temporalDispatch.claimedAt": newerDate }
                : change === "provider_accepted"
                  ? { messageId: "wamid.accepted" }
                  : change === "missing_attempt_token"
                    ? { "temporalDispatch.attemptToken": null }
                    : { "temporalDispatch.version": 2 },
          }
        );
      else if (
        [
          "foreign_workspace",
          "foreign_conversation",
          "foreign_source_message",
        ].includes(change)
      )
        await AiriTurnContext.collection.updateOne(fixture.turn, {
          $set: {
            [`turnPreparation.result.pendingDelivery.context.${
              change === "foreign_workspace"
                ? "workspaceId"
                : change === "foreign_conversation"
                  ? "conversation._id"
                  : "sourceMessageId"
            }`]: "another-owner",
          },
        });
      else if (change === "newer_disposition")
        await AiriTurnContext.collection.updateOne(fixture.turn, {
          $set: {
            turnDisposition: {
              ...fixture.receipt,
              status: "completed",
              updatedAt: "2026-10-10T18:00:00.000Z",
            },
          },
        });
      else if (change === "continuation")
        await Conversation.collection.updateOne(
          { _id: fixture.conversationId },
          {
            $set: {
              "airi_scenario_state.startedScenarios.$[entry].firstMessageId":
                "prior-entry",
            },
          },
          { arrayFilters: [{ "entry.scenarioId": scenarioId }] }
        );
      else
        await Conversation.collection.updateOne(
          { _id: fixture.conversationId },
          {
            $set:
              change === "new_handoff"
                ? { airi_handoff_started_at: newerDate }
                : change === "new_action"
                  ? { "airi_scenario_state.lastMessageId": "another-turn" }
                  : change === "accepted_anchor"
                    ? {
                        "airi_scenario_state.pendingLastOutboundMessageId":
                          "accepted-outbound",
                      }
                    : change === "completed"
                      ? {
                          "airi_scenario_state.completedScenarios": [
                            { scenarioId, completedAt: newerDate },
                          ],
                        }
                      : change === "new_revision"
                        ? {
                            "airi_scenario_state.scenarioRevisionFingerprint":
                              "revision-2",
                          }
                        : {
                            "airi_scenario_state.currentPathNodeIds": [
                              "incoming",
                              "another-action",
                            ],
                          },
          }
        );
      await recordAiriConversationTurnDisposition(fixture.receipt);
      expect(
        (await Conversation.findById(fixture.conversationId).lean())!
          .airi_scenario_state?.lockedScenarioId
      ).toBe(scenarioId);
    });

    it("does not overwrite a handoff racing the state compare-and-set", async () => {
      const fixture = await prepare();
      const updateOne = Conversation.collection.updateOne.bind(
        Conversation.collection
      );
      const race = jest
        .spyOn(Conversation.collection, "updateOne")
        .mockImplementationOnce(async (filter, update, options) => {
          await updateOne(
            { _id: fixture.conversationId },
            { $set: { airi_handoff_started_at: newerDate } }
          );
          return updateOne(filter, update, options);
        });
      try {
        await recordAiriConversationTurnDisposition(fixture.receipt);
        const current = await Conversation.findById(
          fixture.conversationId
        ).lean();
        expect(race).toHaveBeenCalledTimes(1);
        expect(current!.airi_handoff_started_at).toEqual(newerDate);
        expect(current!.airi_scenario_state?.lockedScenarioId).toBe(scenarioId);
      } finally {
        race.mockRestore();
      }
    });

    it("retries failed compensation before recording the terminal disposition", async () => {
      const fixture = await prepare("reserved");
      const receipt = { ...fixture.receipt, status: "superseded" as const };
      const write = jest
        .spyOn(Conversation.collection, "updateOne")
        .mockRejectedValueOnce(new Error("temporary state write failure"));
      try {
        await expect(
          recordAiriConversationTurnDisposition(receipt)
        ).rejects.toThrow("temporary state write failure");
      } finally {
        write.mockRestore();
      }
      expect(
        (await AiriTurnContext.findOne(fixture.turn).lean())!.turnDisposition
      ).toBeUndefined();
      await recordAiriConversationTurnDisposition(receipt);
      expect(
        (await Conversation.findById(fixture.conversationId).lean())!
          .airi_scenario_state?.lockedScenarioId
      ).toBeNull();
      expect(
        (await AiriTurnContext.findOne(fixture.turn).lean())!.turnDisposition
          ?.status
      ).toBe("superseded");
    });
  }
);
