const mockConversationFindOneAndUpdate = jest.fn();
const mockScheduleWake = jest.fn();
const mockMessageConstructor = jest.fn();
const mockMessageSave = jest.fn();
const mockMessageFindOne = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();
const mockRealtimeTrigger = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockConversationFindOneAndUpdate(...args),
  },
}));
jest.mock("@/lib/classifier/classification-pubsub", () => ({
  scheduleConversationClassificationWakeBestEffort: (...args: unknown[]) =>
    mockScheduleWake(...args),
}));
jest.mock("@/models/message", () => {
  function MockMessage(this: Record<string, unknown>, data: object) {
    mockMessageConstructor(data);
    Object.assign(this, data);
    this._id = "507f1f77bcf86cd799439021";
    this.save = () => mockMessageSave(this);
    this.toObject = () => ({ ...data, _id: this._id });
  }
  return {
    __esModule: true,
    default: Object.assign(MockMessage, {
      findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    }),
  };
});
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
  },
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));

import {
  persistManagerOutboundMessage,
  upsertManagerAuthor,
} from "@/lib/conversation-messages";
import type { UserDocument } from "@/types/models";

const CONVERSATION_ID = "507f1f77bcf86cd799439011";
const managerUser = {
  _id: "manager-1",
  firstName: "Dana",
  isBot: false,
} as unknown as UserDocument;

function persist(message: Record<string, unknown> = {}) {
  return persistManagerOutboundMessage({
    conversation: { _id: CONVERSATION_ID, chat: { _id: "chat-1" } },
    workspaceId: "workspace-1",
    channel: "whatsapp",
    managerId: "manager-1",
    managerUser,
    message: {
      messageId: "wamid.1",
      date: new Date("2026-10-21T08:00:00.000Z"),
      text: "Hello",
      ...message,
    },
    logTag: "Reply:Test",
  });
}

describe("upsertManagerAuthor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindOneAndUpdate.mockResolvedValue(managerUser);
  });

  it.each([
    ["the resolved name", Promise.resolve("Dana Lee"), "Dana Lee"],
    ["the fallback for an empty name", Promise.resolve(""), "Dana"],
    [
      "the fallback when the lookup fails",
      Promise.reject(new Error("x")),
      "Dana",
    ],
    ["the fallback without a lookup", undefined, "Dana"],
  ])("stores %s", async (_case, namePromise, firstName) => {
    await upsertManagerAuthor({ id: "manager-1", name: "Dana", namePromise });

    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "manager-1" },
      { _id: "manager-1", isBot: false, firstName },
      { upsert: true, new: true }
    );
  });
});

describe("persistManagerOutboundMessage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageSave.mockResolvedValue(undefined);
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockScheduleWake.mockResolvedValue(undefined);
    mockConversationFindOneAndUpdate.mockReturnValue({
      lean: () => ({
        exec: async () => ({
          _id: CONVERSATION_ID,
          classification_revision: 1,
        }),
      }),
    });
  });

  it("stores the message, links it and emits it with the manager as author", async () => {
    const result = await persist({
      fields: { mediaType: "image", imageUrl: "https://cdn.example.com/a.jpg" },
      origin: { templateName: "welcome" },
    });

    expect(mockMessageConstructor).toHaveBeenCalledWith({
      messageId: "wamid.1",
      chat: "chat-1",
      author: "manager-1",
      date: new Date("2026-10-21T08:00:00.000Z"),
      workspaceId: "workspace-1",
      conversation: CONVERSATION_ID,
      channel: "whatsapp",
      direction: "outbound",
      origin: {
        kind: "manager",
        sentByUserId: "manager-1",
        templateName: "welcome",
      },
      text: "Hello",
      mediaType: "image",
      imageUrl: "https://cdn.example.com/a.jpg",
    });
    const update = mockConversationFindOneAndUpdate.mock.calls[0][1];
    expect(JSON.stringify(update)).toContain(
      '"handled_by_agent_id":"manager-1"'
    );
    expect(JSON.stringify(update)).not.toContain('"workspaceId"');
    expect(result).toMatchObject({
      _id: "507f1f77bcf86cd799439021",
      text: "Hello",
      author: { _id: "manager-1", firstName: "Dana", isBot: false },
    });
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      `private-conversation-${CONVERSATION_ID}`,
      "new-message",
      result
    );
    expect(mockMessageSave.mock.invocationCallOrder[0]).toBeLessThan(
      mockConversationFindOneAndUpdate.mock.invocationCallOrder[0]
    );
    expect(
      mockConversationFindOneAndUpdate.mock.invocationCallOrder[0]
    ).toBeLessThan(mockRealtimeTrigger.mock.invocationCallOrder[0]);
  });

  it("claims a provider id this chat already stores instead of duplicating it", async () => {
    mockMessageSave.mockRejectedValueOnce({ code: 11000 });
    const existing = {
      _id: "507f1f77bcf86cd799439022",
      date: new Date("2026-10-21T07:59:59.000Z"),
      origin: { kind: "echo" },
      set: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      toObject: () => ({ _id: "507f1f77bcf86cd799439022", text: "Hello" }),
    };
    mockMessageFindOne.mockResolvedValueOnce(existing);

    const result = await persist({ fields: { whatsappMediaId: "media-1" } });

    expect(mockMessageFindOne).toHaveBeenCalledWith({
      chat: "chat-1",
      messageId: "wamid.1",
    });
    expect(existing.set).toHaveBeenCalledWith({
      text: "Hello",
      whatsappMediaId: "media-1",
      author: "manager-1",
      origin: { kind: "manager", sentByUserId: "manager-1" },
    });
    expect(existing.save).toHaveBeenCalledTimes(1);
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalled();
    expect(result).toMatchObject({ _id: "507f1f77bcf86cd799439022" });
  });

  it("rethrows a duplicate without a provider id", async () => {
    mockMessageSave.mockRejectedValueOnce({ code: 11000 });

    await expect(persist({ messageId: undefined })).rejects.toEqual({
      code: 11000,
    });
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
  });

  it("does not wait for the inbox emit", async () => {
    mockRealtimeTrigger.mockReturnValueOnce(new Promise(() => {}));

    await expect(persist()).resolves.toMatchObject({ text: "Hello" });
  });
});
