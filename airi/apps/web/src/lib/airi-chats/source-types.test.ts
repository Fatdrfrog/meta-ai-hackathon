import {
  AIRI_CHAT_CONTEXT_OPTION_IDS,
  buildAiriChatMetaSkillRef,
  buildAiriChatSourceOptionId,
  isExplicitAiriChatMetaAdsRequest,
  isAiriChatContextOptionId,
  normalizeAiriChatSelectedSources,
  type AiriChatSourceRef,
} from "./source-types";

describe("Airi chat source types", () => {
  it("normalizes selected source refs and removes duplicates", () => {
    const refs: AiriChatSourceRef[] = [
      {
        kind: "context",
        optionId: "knowledge_base_articles",
        label: "Knowledge base",
      },
      {
        kind: "context",
        optionId: "knowledge_base_articles",
        label: "Knowledge base",
      },
      {
        kind: "context_item",
        optionId: "quick_replies",
        itemId: "reply-1",
        label: "Greeting",
      },
      {
        kind: "channel_source",
        sourceId: "source-1",
        sourceType: "whatsapp",
        label: "WhatsApp",
      },
      {
        kind: "workspace_source",
        sourceId: "source-2",
        sourceType: "canva",
        label: "Canva",
      },
      {
        kind: "connector",
        connector: "whatsapp",
        sourceId: "source-1",
        label: "WhatsApp",
        capabilities: ["docs", "templates", "flows"],
      },
      {
        kind: "chat_thread",
        threadId: "thread-1",
        label: "Pricing chat",
      },
    ];

    expect(normalizeAiriChatSelectedSources(refs)).toEqual([
      refs[0],
      refs[2],
      refs[3],
      refs[4],
      refs[5],
      refs[6],
    ]);
  });

  it("builds stable option ids for every source kind", () => {
    expect(
      buildAiriChatSourceOptionId({
        kind: "context",
        optionId: "conversation_timeline",
        label: "Chats",
      })
    ).toBe("context:conversation_timeline");
    expect(
      buildAiriChatSourceOptionId({
        kind: "context_item",
        optionId: "knowledge_base_articles",
        itemId: "kb-1",
        label: "Pricing",
      })
    ).toBe("context_item:knowledge_base_articles:kb-1");
    expect(
      buildAiriChatSourceOptionId({
        kind: "channel_source",
        sourceId: "source-1",
        sourceType: "instagram",
        label: "Instagram",
      })
    ).toBe("channel_source:source-1");
    expect(
      buildAiriChatSourceOptionId({
        kind: "workspace_source",
        sourceId: "source-2",
        sourceType: "canva",
        label: "Canva",
      })
    ).toBe("source:source-2");
    expect(
      buildAiriChatSourceOptionId({
        kind: "connector",
        connector: "whatsapp",
        sourceId: "source-1",
        label: "WhatsApp",
      })
    ).toBe("connector:whatsapp:source-1");
    expect(
      buildAiriChatSourceOptionId({
        kind: "chat_thread",
        threadId: "thread-1",
        label: "Pricing chat",
      })
    ).toBe("chat_thread:thread-1");
    expect(
      buildAiriChatSourceOptionId({
        kind: "skill",
        skillId: "meta",
        label: "meta",
      })
    ).toBe("skill:meta");
  });

  it("keeps the context option allowlist narrow", () => {
    expect(AIRI_CHAT_CONTEXT_OPTION_IDS).toContain("quick_replies");
    expect(isAiriChatContextOptionId("purchase_history")).toBe(false);
  });

  it.each([
    ["@meta show campaign spend", [], true],
    ["Compare with @Meta last month", [], true],
    ["Show campaign spend", [buildAiriChatMetaSkillRef()], true],
    ["   ", [buildAiriChatMetaSkillRef()], false],
    ["Email me@meta.com the report", [], false],
    ["Compare with last month", [], false],
  ] as const)(
    "knows %j is an explicit Meta Ads request before classifying",
    (userMessage, selectedSources, expected) => {
      expect(
        isExplicitAiriChatMetaAdsRequest({
          userMessage,
          selectedSources: [...selectedSources],
        })
      ).toBe(expected);
    }
  );
});
