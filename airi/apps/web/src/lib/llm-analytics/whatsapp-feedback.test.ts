const mockMessageFindOne = jest.fn();
const mockReviewItemFindOneAndUpdate = jest.fn();

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappInteractiveList: jest.fn(),
  sendWhatsappInteractiveReplyButtons: jest.fn(),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
  },
}));

jest.mock("@/models/llm-evaluation-review-item", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockReviewItemFindOneAndUpdate(...args),
  },
}));

import { upsertWhatsAppLlmAnswerReviewItem } from "./whatsapp-feedback";

describe("upsertWhatsAppLlmAnswerReviewItem", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageFindOne.mockImplementation(
      (filter: { direction?: "inbound" | "outbound" }) => {
        if (filter.direction === "outbound") {
          return {
            select: () => ({
              lean: async () => ({
                _id: "answer-message-id",
                messageId: "wamid.answer",
                text: "Answer text",
                date: new Date("2026-08-14T09:00:00.000Z"),
              }),
            }),
          };
        }

        return {
          sort: () => ({
            select: () => ({
              lean: async () => ({
                _id: "input-message-id",
                text: "Question text",
                date: new Date("2026-08-14T08:59:00.000Z"),
              }),
            }),
          }),
        };
      }
    );
  });

  it("returns one atomic insertion winner for concurrent duplicate upserts", async () => {
    mockReviewItemFindOneAndUpdate
      .mockResolvedValueOnce({
        value: { _id: "review-item-id" },
        lastErrorObject: { updatedExisting: false },
      })
      .mockResolvedValueOnce({
        value: { _id: "review-item-id" },
        lastErrorObject: { updatedExisting: true },
      });

    const params = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceMessageId: "wamid.answer",
      outputText: "Answer text",
    };
    const [first, duplicate] = await Promise.all([
      upsertWhatsAppLlmAnswerReviewItem(params),
      upsertWhatsAppLlmAnswerReviewItem(params),
    ]);

    expect(first).toEqual({
      item: { _id: "review-item-id" },
      inserted: true,
    });
    expect(duplicate).toEqual({
      item: { _id: "review-item-id" },
      inserted: false,
    });
    expect(mockReviewItemFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockReviewItemFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: "workspace-1",
        dedupeKey:
          "whatsapp-llm-answer-review:workspace-1:conversation-1:wamid.answer",
      },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "wamid.answer",
        }),
      }),
      {
        includeResultMetadata: true,
        lean: true,
        new: true,
        runValidators: true,
        upsert: true,
      }
    );
  });
});
