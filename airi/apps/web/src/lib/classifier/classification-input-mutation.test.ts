const mockScheduleConversationClassificationWakeBestEffort = jest.fn();

jest.mock("./classification-pubsub", () => ({
  scheduleConversationClassificationWakeBestEffort: (input: unknown) =>
    mockScheduleConversationClassificationWakeBestEffort(input),
}));

import {
  assertClassificationInputMessagePatch,
  updateClassificationInputMessageAndInvalidate,
  type ClassificationInputMutationDependencies,
} from "./classification-input-mutation";

describe("classification input mutation contract", () => {
  const messageId = "68a000000000000000000001";
  const conversationId = "68a000000000000000000002";

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleConversationClassificationWakeBestEffort.mockResolvedValue(
      undefined
    );
  });

  it("rejects arbitrary and state-owned message paths", () => {
    expect(() =>
      assertClassificationInputMessagePatch({
        set: { text: "corrected" },
        semanticPaths: ["text"],
      })
    ).not.toThrow();
    expect(() =>
      assertClassificationInputMessagePatch({
        set: { workspaceId: "other" },
        semanticPaths: ["workspaceId"],
      })
    ).toThrow("Message mutation path workspaceId is not allowed");
  });

  it("requires semantic declarations to match a set or unset path", () => {
    expect(() =>
      assertClassificationInputMessagePatch({
        set: { "mediaAnalysis.status": "completed" },
        semanticPaths: ["audioAnalysis"],
      })
    ).toThrow("Semantic path audioAnalysis is not mutated");
  });

  it("cannot mutate classifier-visible input without declaring invalidation", () => {
    expect(() =>
      assertClassificationInputMessagePatch({
        set: { text: "bypass" },
        semanticPaths: [],
      })
    ).toThrow("Classifier input path text must be declared semantic");
  });

  function createDependencies(input?: {
    existingText?: string;
    conversationMatched?: number;
    transactionRuns?: number;
  }) {
    const session = {
      withTransaction: jest.fn(async (callback: () => Promise<void>) => {
        for (let index = 0; index < (input?.transactionRuns ?? 1); index += 1) {
          await callback();
        }
      }),
      endSession: jest.fn(async () => undefined),
    };
    const messageUpdateOne = jest.fn(async (..._args: unknown[]) => ({
      matchedCount: 1,
    }));
    const conversationUpdateOne = jest.fn(async (..._args: unknown[]) => ({
      matchedCount: input?.conversationMatched ?? 1,
    }));
    const scheduleWake = jest.fn(async () => undefined);
    const messageModel = {
      findOne: jest.fn(() => ({
        session: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn(async () => ({
              _id: messageId,
              conversation: conversationId,
              text: input?.existingText ?? "before",
            })),
          })),
        })),
      })),
      updateOne: messageUpdateOne,
    };
    const conversationModel = {
      startSession: jest.fn(async () => session),
      updateOne: conversationUpdateOne,
      findById: jest.fn(() => ({
        session: jest.fn(() => ({
          select: jest.fn(() => ({
            lean: jest.fn(() => ({
              exec: jest.fn(async () => ({
                _id: conversationId,
                classification_state: {
                  status: "pending",
                  requestedRevision: 4,
                  generation: 2,
                  requestedAt: new Date("2026-08-10T06:00:00.000Z"),
                },
              })),
            })),
          })),
        })),
      })),
    };
    return {
      dependencies: {
        messageModel,
        conversationModel,
        now: () => new Date("2026-08-10T06:00:00.000Z"),
        scheduleWake,
      } as unknown as ClassificationInputMutationDependencies,
      messageUpdateOne,
      conversationUpdateOne,
      scheduleWake,
      session,
    };
  }

  it("commits a semantic Message patch and Conversation invalidation before wake", async () => {
    const fixture = createDependencies();

    const result = await updateClassificationInputMessageAndInvalidate(
      {
        messageId,
        conversationId,
        set: { text: "after" },
        semanticPaths: ["text"],
      },
      fixture.dependencies
    );

    expect(result).toMatchObject({
      semanticChanged: true,
      requestedRevision: 4,
      generation: 2,
      status: "pending",
    });
    expect(fixture.messageUpdateOne).toHaveBeenCalledTimes(1);
    expect(fixture.conversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(fixture.conversationUpdateOne.mock.calls[0]?.[0]).toEqual({
      _id: expect.anything(),
      messages: expect.anything(),
    });
    expect(fixture.scheduleWake).toHaveBeenCalledWith({
      conversationId,
      requestedRevision: 4,
      generation: 2,
      requestedAt: new Date("2026-08-10T06:00:00.000Z"),
    });
    expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
  });

  it("uses the Pub/Sub scheduler as the production default after commit", async () => {
    const fixture = createDependencies();
    const defaultDependencies: Partial<ClassificationInputMutationDependencies> =
      { ...fixture.dependencies };
    delete defaultDependencies.scheduleWake;

    await updateClassificationInputMessageAndInvalidate(
      {
        messageId,
        conversationId,
        set: { text: "after" },
        semanticPaths: ["text"],
      },
      defaultDependencies
    );

    expect(
      mockScheduleConversationClassificationWakeBestEffort
    ).toHaveBeenCalledWith({
      conversationId,
      requestedRevision: 4,
      generation: 2,
      requestedAt: new Date("2026-08-10T06:00:00.000Z"),
    });
    expect(fixture.scheduleWake).not.toHaveBeenCalled();
  });

  it("applies transport metadata without invalidating unchanged semantic input", async () => {
    const fixture = createDependencies({ existingText: "same" });

    const result = await updateClassificationInputMessageAndInvalidate(
      {
        messageId,
        conversationId,
        set: {
          text: "same",
          "mediaAnalysis.status": "completed",
        },
        semanticPaths: ["text"],
      },
      fixture.dependencies
    );

    expect(result).toEqual({ semanticChanged: false });
    expect(fixture.messageUpdateOne).toHaveBeenCalledTimes(1);
    expect(fixture.conversationUpdateOne).not.toHaveBeenCalled();
    expect(fixture.scheduleWake).not.toHaveBeenCalled();
  });

  it("does not schedule wake when the transaction aborts", async () => {
    const fixture = createDependencies({ conversationMatched: 0 });

    await expect(
      updateClassificationInputMessageAndInvalidate(
        {
          messageId,
          conversationId,
          set: { text: "after" },
          semanticPaths: ["text"],
        },
        fixture.dependencies
      )
    ).rejects.toThrow("Conversation input invalidation did not match");
    expect(fixture.scheduleWake).not.toHaveBeenCalled();
    expect(fixture.session.endSession).toHaveBeenCalledTimes(1);
  });

  it("captures one transaction-stable request timestamp across driver retries", async () => {
    const fixture = createDependencies({ transactionRuns: 2 });
    const now = jest
      .fn()
      .mockReturnValueOnce(new Date("2026-08-10T06:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-10T06:01:00.000Z"));

    await updateClassificationInputMessageAndInvalidate(
      {
        messageId,
        conversationId,
        set: { text: "after" },
        semanticPaths: ["text"],
      },
      { ...fixture.dependencies, now }
    );

    expect(now).toHaveBeenCalledTimes(1);
    expect(fixture.conversationUpdateOne).toHaveBeenCalledTimes(2);
    expect(fixture.conversationUpdateOne.mock.calls[0]?.[1]).toEqual(
      fixture.conversationUpdateOne.mock.calls[1]?.[1]
    );
  });
});
