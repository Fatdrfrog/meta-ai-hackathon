import { enrichContextNodeData } from "./context";

describe("enrichContextNodeData", () => {
  it("projects focused context resources and selection callbacks", () => {
    const updateNodeContextOptionById = jest.fn();
    const toggleContextSourceItemById = jest.fn();
    const loadContextItems = jest.fn().mockResolvedValue(undefined);
    const answerSnippets = [{ id: "snippet-1", label: "Refund policy" }];
    const quickReplies = [{ id: "reply-1", label: "Welcome" }];

    const enriched = enrichContextNodeData(
      "context-1",
      {
        kind: "context",
        contextOptionId: "answer_snippets",
        contextSources: [
          {
            optionId: "answer_snippets",
            selectionMode: "specific",
            itemIds: ["snippet-1"],
          },
          {
            optionId: "quick_replies",
            selectionMode: "all",
            itemIds: [],
          },
        ],
      },
      {
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            updateNodeContextOptionById,
            toggleContextSourceItemById,
            loadContextItems,
          },
        },
        openNodePickerFromHandle: jest.fn(),
        audienceOptions: { channels: [] },
        filteredContextOptions: [],
        contextItemsByOptionId: {
          answer_snippets: answerSnippets,
          quick_replies: quickReplies,
        },
        knowledgeDisabledReason: "Knowledge unavailable",
        isCreatingSnippet: false,
      } as never
    );

    enriched.uiOnContextOptionChange?.("quick_replies");
    enriched.uiOnContextSourceItemToggle?.("answer_snippets", "snippet-1");
    enriched.uiOnContextSourceRefresh?.("quick_replies");

    expect(enriched.uiContextItems).toBe(answerSnippets);
    expect(enriched.uiContextItemsByOptionId).toEqual({
      answer_snippets: answerSnippets,
      quick_replies: quickReplies,
    });
    expect(enriched.uiKnowledgeDisabledReason).toBe("Knowledge unavailable");
    expect(updateNodeContextOptionById).toHaveBeenCalledWith(
      "context-1",
      "quick_replies"
    );
    expect(toggleContextSourceItemById).toHaveBeenCalledWith(
      "context-1",
      "answer_snippets",
      "snippet-1"
    );
    expect(loadContextItems).toHaveBeenCalledWith("quick_replies", true);
  });
});
