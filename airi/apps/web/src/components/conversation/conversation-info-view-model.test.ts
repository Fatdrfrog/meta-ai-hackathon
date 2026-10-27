import {
  buildConversationInfoViewModel,
  type ConversationInfoDetails,
} from "./conversation-info-view-model";

const UNNAMED_LABELS = { customer: "Customer", group: "Telegram group" };

describe("buildConversationInfoViewModel", () => {
  it("normalizes a generic conversation into summary, waiting, and AI memory", () => {
    const details: ConversationInfoDetails = {
      status: "open",
      channel: "email",
      createdAt: "2026-01-01T00:00:00.000Z",
      classification: {
        priority: "high",
        sentiment: "negative",
        summary: "Customer needs a billing fix.",
        action: "Reply with refund options.",
      },
      internal_labels: ["vip", "refund"],
      airi_context_memory: {
        summary: "The customer is blocked by billing.",
        currentGoal: "Resolve refund request",
        unresolvedNeeds: ["refund policy"],
      },
    };

    const vm = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details,
      messages: [
        {
          _id: "msg_1" as never,
          text: "I still need help",
          date: "2026-01-01T00:05:00.000Z",
          direction: "inbound",
          author: null,
        },
      ],
    });

    expect(vm.summary.nextAction).toBe("Reply with refund options.");
    expect(vm.summary.priority).toBe("high");
    expect(vm.summary.sentiment).toBe("negative");
    expect(vm.summary.internalLabels).toEqual(["vip", "refund"]);
    expect(vm.summary.airiMemory?.currentGoal).toBe("Resolve refund request");
    expect(vm.overview.waitingOn).toBe("agent");
    expect(vm.overview.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("names the conversation like the header: rename, then a parsed client name", () => {
    const customer = { _id: "customer_1", displayName: "Aigerim" };
    const renamed = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details: {
        channel: "whatsapp",
        rename: "VIP buyer",
        customer,
        chat: { title: "Customer (wa_77001234567)" },
      },
    });
    const unnamed = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details: {
        channel: "whatsapp",
        customer,
        chat: { title: "Customer (wa_77001234567)" },
      },
    });

    expect(renamed.overview.displayName).toBe("VIP buyer");
    expect(unnamed.overview.displayName).toBe("77001234567");
  });

  it("falls back to the translated placeholder when nothing names the customer", () => {
    const vm = buildConversationInfoViewModel({
      unnamed: { customer: "Клиент", group: "Группа Telegram" },
      details: { channel: "web_widget" },
    });

    expect(vm.overview.displayName).toBe("Клиент");
  });

  it("surfaces WhatsApp attribution and opt-in details", () => {
    const vm = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details: {
        channel: "whatsapp",
        sourceId: "source-wa",
        chat: {
          _id: "chat_1",
          type: "private",
          whatsapp: {
            waId: "77001234567",
            previousWaIds: ["77007654321"],
          },
        },
        whatsapp_opt_in: {
          status: true,
          source: "inbound",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "ad_1",
          sourceUrl: "https://example.com/ad",
          headline: "Spring offer",
          ctwaClid: "clid_1",
        },
      },
    });

    expect(vm.source.sourceId).toBe("source-wa");
    expect(vm.source.whatsappOptIn?.status).toBe(true);
    expect(vm.source.whatsappReferral?.headline).toBe("Spring offer");
    expect(vm.source.chat?.whatsapp?.previousWaIds).toEqual(["77007654321"]);
  });

  it("surfaces Instagram comment and media context", () => {
    const vm = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details: {
        channel: "instagram",
        external_thread: {
          provider: "instagram",
          type: "comment",
          threadId: "thread_1",
          permalink: "https://instagram.com/p/abc",
          comment: { id: "comment_1", likeCount: 7 },
          media: { username: "brand" },
        },
      },
    });

    expect(vm.source.instagramThread?.threadId).toBe("thread_1");
    expect(vm.source.instagramThread?.comment?.likeCount).toBe(7);
    expect(vm.source.instagramThread?.media?.username).toBe("brand");
  });

  it("surfaces web widget visitor context", () => {
    const vm = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details: {
        channel: "web_widget",
        page_url: "https://example.com/pricing",
        visitor_id: "visitor_123456789",
      },
    });

    expect(vm.source.pageUrl).toBe("https://example.com/pricing");
    expect(vm.source.visitorId).toBe("visitor_123456789");
  });

  it("surfaces Telegram group context and scenario state", () => {
    const vm = buildConversationInfoViewModel({
      unnamed: UNNAMED_LABELS,
      details: {
        channel: "telegram",
        chat: {
          _id: "tg_-100",
          type: "supergroup",
          title: "Support group",
          sourceId: "source-tg",
        },
        airi_scenario_state: {
          lockedScenarioId: "scenario_1",
          lockedScenarioName: "Lead follow-up",
          currentActionNodeId: "node_1",
          pendingConditionNodeId: "condition_1",
          pendingStartedAt: "2026-01-03T00:00:00.000Z",
          startedScenarios: [{ scenarioId: "scenario_1" }],
          completedScenarios: [],
        },
      },
    });

    expect(vm.overview.displayName).toBe("Support group");
    expect(vm.source.sourceId).toBe("source-tg");
    expect(vm.ai.automation.status).toBe("pending");
    expect(vm.ai.automation.scenarioName).toBe("Lead follow-up");
    expect(vm.ai.automation.startedCount).toBe(1);
  });
});
