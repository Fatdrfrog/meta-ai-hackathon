import {
  isActionReplyChannelMismatch,
  isLockedBranchReplyEvent,
  normalizeInteractiveTriggerPayloads,
  resolveConversationMetaReferral,
  resolveDefaultTriggerEventKind,
  resolveQuickReplyEventKindForChannel,
  shouldRouteBulkInteractiveReply,
  shouldSkipTriggerMatchDuringRuntimeBuild,
} from "@/lib/airi/scenario/scenario-runtime-dispatch";
import { getCompiledScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import { SCENARIO_TRIGGER_EVENT_KIND } from "@icecore/scenario-contracts";

describe("scenario-runtime-dispatch", () => {
  describe("resolveDefaultTriggerEventKind", () => {
    it("maps quick reply payloads to channel-specific interactive event kinds", () => {
      for (const quickReplyPayload of [
        "stb:menu:110",
        "wsc:menu:choice-1",
        "wbc:menu:1767225600000:1767229200000",
      ]) {
        expect(
          resolveDefaultTriggerEventKind({
            channel: "whatsapp",
            quickReplyPayload,
            whatsAppFlowResponseJson: "",
          })
        ).toBe(SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply);
      }

      expect(
        resolveDefaultTriggerEventKind({
          channel: "instagram",
          quickReplyPayload: "qr-1",
          whatsAppFlowResponseJson: "",
        })
      ).toBe(SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply);

      expect(
        resolveDefaultTriggerEventKind({
          channel: "telegram",
          quickReplyPayload: "qr-1",
          whatsAppFlowResponseJson: "",
        })
      ).toBe(SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply);
    });

    it("keeps a WhatsApp button payload outside our grammar a typed reply", () => {
      // A template sent from Campaigns or the inbox returns its button label.
      for (const quickReplyPayload of ["Silver", "btn-1", "stb:menu"]) {
        expect(
          resolveDefaultTriggerEventKind({
            channel: "whatsapp",
            quickReplyPayload,
            whatsAppFlowResponseJson: "",
          })
        ).toBe(SCENARIO_TRIGGER_EVENT_KIND.inboundMessage);
      }
      expect(
        resolveDefaultTriggerEventKind({
          channel: "whatsapp",
          quickReplyPayload: "Silver",
          whatsAppFlowResponseJson: '{"screen":"DONE"}',
        })
      ).toBe(SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply);
    });

    it("prefers explicit trigger event kinds and flow replies over quick replies", () => {
      expect(
        resolveDefaultTriggerEventKind({
          channel: "whatsapp",
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
          quickReplyPayload: "btn-1",
          whatsAppFlowResponseJson: "",
        })
      ).toBe(SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout);

      expect(
        resolveDefaultTriggerEventKind({
          channel: "whatsapp",
          quickReplyPayload: "",
          whatsAppFlowResponseJson: '{"screen":"DONE"}',
        })
      ).toBe(SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply);
    });
  });

  describe("normalizeInteractiveTriggerPayloads", () => {
    it("trims interactive payload strings and defaults missing values to empty", () => {
      expect(
        normalizeInteractiveTriggerPayloads({
          quickReplyPayload: "  payload  ",
          whatsAppFlowResponseJson: null,
        })
      ).toEqual({
        quickReplyPayload: "payload",
        whatsAppFlowResponseJson: "",
      });
    });
  });

  describe("shouldRouteBulkInteractiveReply", () => {
    it("routes interactive replies through bulk scenarios without trigger nodes", () => {
      const graph = getCompiledScenarioGraph({
        _id: "bulk-scenario",
        name: "Bulk",
        nodes: [
          {
            id: "bulk-1",
            type: "scenarioNode",
            position: { x: 0, y: 0 },
            data: { kind: "bulk", label: "Bulk" },
          },
        ],
        edges: [],
      });

      expect(
        shouldRouteBulkInteractiveReply({
          graph,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        })
      ).toBe(true);

      expect(
        shouldRouteBulkInteractiveReply({
          graph,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
        })
      ).toBe(false);
    });
  });

  describe("isLockedBranchReplyEvent", () => {
    it("detects locked interactive branch replies", () => {
      expect(
        isLockedBranchReplyEvent({
          lockedByConversationState: true,
          preferredActionNodeId: "action-1",
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply,
        })
      ).toBe(true);

      expect(
        isLockedBranchReplyEvent({
          lockedByConversationState: false,
          preferredActionNodeId: "action-1",
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply,
        })
      ).toBe(false);
    });
  });

  describe("shouldSkipTriggerMatchDuringRuntimeBuild", () => {
    it("skips trigger matching for locked branch replies and bulk interactive routing", () => {
      const bulkGraph = getCompiledScenarioGraph({
        _id: "bulk-scenario",
        name: "Bulk",
        nodes: [
          {
            id: "bulk-1",
            type: "scenarioNode",
            position: { x: 0, y: 0 },
            data: { kind: "bulk", label: "Bulk" },
          },
        ],
        edges: [],
      });

      expect(
        shouldSkipTriggerMatchDuringRuntimeBuild({
          lockedByConversationState: true,
          preferredActionNodeId: "action-1",
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply,
          graph: bulkGraph,
        })
      ).toBe(true);

      expect(
        shouldSkipTriggerMatchDuringRuntimeBuild({
          lockedByConversationState: false,
          triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
          graph: bulkGraph,
        })
      ).toBe(true);
    });
  });

  describe("isActionReplyChannelMismatch", () => {
    it("flags reply actions configured for a different channel", () => {
      expect(
        isActionReplyChannelMismatch({
          actionReplyChannel: "telegram",
          channel: "whatsapp",
        })
      ).toBe(true);

      expect(
        isActionReplyChannelMismatch({
          actionReplyChannel: "whatsapp",
          channel: "whatsapp",
        })
      ).toBe(false);
    });
  });

  describe("timer and channel helpers", () => {
    it("maps quick reply channels consistently", () => {
      expect(resolveQuickReplyEventKindForChannel("whatsapp")).toBe(
        SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply
      );
      expect(resolveQuickReplyEventKindForChannel("instagram")).toBe(
        SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply
      );
      expect(resolveQuickReplyEventKindForChannel("telegram")).toBe(
        SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply
      );
    });
  });

  describe("resolveConversationMetaReferral", () => {
    it("extracts Instagram ad referral metadata from conversations", () => {
      const referral = resolveConversationMetaReferral({
        channel: "instagram",
        external_thread: {
          provider: "instagram",
          referral: {
            adId: "ad-123",
            campaignId: "camp-1",
            title: "Summer promo",
          },
        },
      } as never);

      expect(referral).toEqual({
        sourceId: "ad-123",
        sourceType: "ad",
        sourcePlatform: "instagram",
        campaignId: "camp-1",
        adSetId: undefined,
        sourceUrl: undefined,
        headline: "Summer promo",
        body: undefined,
        mediaUrl: undefined,
      });
    });

    it("returns null for non-Instagram conversations without ad referral ids", () => {
      expect(
        resolveConversationMetaReferral({
          channel: "whatsapp",
          external_thread: { provider: "whatsapp" },
        } as never)
      ).toBeNull();
    });
  });
});
