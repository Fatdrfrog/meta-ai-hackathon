const mockGetFile = jest.fn();
const mockGetFileUrl = jest.fn();
const mockGetProfilePhotos = jest.fn();
const mockAvatarUpload = jest.fn();
const mockUserUpdate = jest.fn();
const mockHandleTelegramMedia = jest.fn();
const mockHandleTelegramPhoto = jest.fn();
const mockMessageSave = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageFindById = jest.fn();
const mockAppendMessageToConversationById = jest.fn();
const mockEnqueueConversationMediaAnalysis = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockInvalidateConversationCache = jest.fn();
const mockInvalidateRequestsForWorkspace = jest.fn();

jest.mock("@/lib/telegram", () => ({
  getFile: (...args: unknown[]) => mockGetFile(...args),
  getFileUrl: (...args: unknown[]) => mockGetFileUrl(...args),
  getUserProfilePhotos: (...args: unknown[]) => mockGetProfilePhotos(...args),
}));

jest.mock("@/lib/media/handler", () => ({
  handleTelegramMedia: (...args: unknown[]) => mockHandleTelegramMedia(...args),
  handleTelegramPhoto: (...args: unknown[]) => mockHandleTelegramPhoto(...args),
}));

jest.mock("@/lib/temporal/airi-turn-context", () => ({
  buildAiriConversationIngressIntent: (payload: {
    newMessage: { _id: string };
    workspaceId: string;
  }) => ({
    messageId: payload.newMessage._id,
    workspaceId: payload.workspaceId,
    ingressStatus: "pending",
  }),
}));

jest.mock("@/models/message", () => {
  const MockMessage = jest.fn().mockImplementation(data => ({
    ...data,
    _id: "msg_1",
    save: mockMessageSave,
  }));
  return {
    __esModule: true,
    default: Object.assign(MockMessage, {
      findOne: (...args: unknown[]) => mockMessageFindOne(...args),
      findById: (...args: unknown[]) => mockMessageFindById(...args),
    }),
  };
});

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {},
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { updateOne: (...args: unknown[]) => mockUserUpdate(...args) },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockAvatarUpload(...args),
        getPublicUrl: () => ({
          data: { publicUrl: "https://storage/avatars/telegram/5001.jpg" },
        }),
      }),
    },
  },
}));

jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: (...args: unknown[]) => mockRealtimeTrigger(...args) },
}));

jest.mock("@/lib/cache", () => ({
  invalidateConversationCache: (...args: unknown[]) =>
    mockInvalidateConversationCache(...args),
  invalidateRequestsForWorkspace: (...args: unknown[]) =>
    mockInvalidateRequestsForWorkspace(...args),
}));

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));

jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: (...args: unknown[]) =>
    mockEnqueueConversationMediaAnalysis(...args),
}));

jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationRealtime: jest.fn(),
}));

import Message from "@/models/message";
import {
  persistInboundMessage,
  runPostSaveSideEffects,
  updateTelegramUserAvatar,
} from "./helpers";

describe("persistInboundMessage Telegram media", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageSave.mockResolvedValue(undefined);
    mockGetFile.mockResolvedValue({
      file_id: "voice_file_1",
      file_unique_id: "unique_voice_file_1",
      file_size: 2048,
      file_path: "voice/file_1.oga",
    });
    mockGetFileUrl.mockReturnValue(
      "https://api.telegram.org/file/botbot_token/voice/file_1.oga"
    );
    mockHandleTelegramMedia.mockResolvedValue({
      publicUrl: "https://storage.example/telegram/ws_1/conv_1/42.ogg",
      storagePath: "telegram/ws_1/conv_1/42.ogg",
      size: 2048,
      contentType: "audio/ogg",
      filename: undefined,
      mediaType: "voice",
    });
    mockHandleTelegramPhoto.mockResolvedValue({
      publicUrl: "https://storage.example/photo.jpg",
      size: 2048,
    });
    mockAppendMessageToConversationById.mockResolvedValue({ appended: true });
    mockEnqueueConversationMediaAnalysis.mockResolvedValue({
      queued: false,
      reason: "unsupported_media",
    });
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockInvalidateConversationCache.mockResolvedValue(undefined);
    mockInvalidateRequestsForWorkspace.mockResolvedValue(undefined);
  });

  it("preserves photo caption and original provider payload when storage is full", async () => {
    mockHandleTelegramPhoto.mockRejectedValueOnce(
      new Error("storage_limit_exceeded")
    );
    const photo = {
      message_id: 42,
      date: 1_700_000_000,
      caption: "Keep this caption",
      photo: [
        { file_id: "photo_1", file_unique_id: "unique", file_size: 2048 },
      ],
    };
    const result = await persistInboundMessage(
      photo as never,
      { _id: "chat_1" } as never,
      5001,
      "conv_1",
      "ws_1",
      "inbound",
      "bot_token"
    );
    expect(result?.isNew).toBe(true);
    expect(Message).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Keep this caption",
        mediaType: "image",
        rawSourcePayload: expect.any(Object),
      })
    );
    expect(
      (Message as unknown as jest.Mock).mock.calls.at(-1)[0].imageUrl
    ).toBeUndefined();
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
  });

  it("replaces the stable identity avatar and rejects oversized streamed bytes", async () => {
    mockGetProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [[{ file_id: "avatar", file_unique_id: "variant" }]],
    });
    mockAvatarUpload.mockResolvedValue({ error: null });
    const fetch = jest.spyOn(global, "fetch");
    try {
      fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
      await updateTelegramUserAvatar({ _id: 5001 } as never, "token");
      expect(mockAvatarUpload).toHaveBeenCalledWith(
        "telegram/5001.jpg",
        expect.any(Buffer),
        expect.objectContaining({ upsert: true })
      );
      mockAvatarUpload.mockClear();
      fetch.mockResolvedValueOnce(
        new Response(new Uint8Array(2 * 1024 * 1024 + 1))
      );
      await updateTelegramUserAvatar({ _id: 5001 } as never, "token");
      expect(mockAvatarUpload).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("uploads Telegram voice media and stores the public URL for transcription", async () => {
    const result = await persistInboundMessage(
      {
        message_id: 42,
        date: 1_700_000_000,
        voice: {
          file_id: "voice_file_1",
          file_unique_id: "unique_voice_file_1",
          mime_type: "audio/ogg",
          file_size: 2048,
        },
      } as never,
      { _id: "chat_1" } as never,
      5001,
      "conv_1",
      "ws_1",
      "inbound",
      "bot_token"
    );

    expect(result?.isNew).toBe(true);
    expect(mockGetFile).toHaveBeenCalledWith("voice_file_1", "bot_token");
    expect(mockHandleTelegramMedia).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botbot_token/voice/file_1.oga",
      "ws_1",
      "conv_1",
      "42",
      {
        contentType: "audio/ogg",
        filename: undefined,
        mediaType: "voice",
      }
    );

    expect(Message).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "[voice attachment]",
        imageUrl: "https://storage.example/telegram/ws_1/conv_1/42.ogg",
        mediaType: "voice",
        mimeType: "audio/ogg",
        fileSize: 2048,
        attachments: [
          {
            filename: undefined,
            url: "https://storage.example/telegram/ws_1/conv_1/42.ogg",
            contentType: "audio/ogg",
            sizeBytes: 2048,
          },
        ],
      })
    );
  });

  it.each([
    ["text", { text: "hello" }],
    ["caption", { caption: "hello" }],
    ["photo", { photo: [{ file_id: "photo_1", file_unique_id: "p1" }] }],
    ["voice", { voice: { file_id: "voice_1", file_unique_id: "v1" } }],
  ])(
    "saves %s ingress intent in the first message write",
    async (_kind, content) => {
      mockMessageSave.mockImplementationOnce(function (
        this: Record<string, unknown>
      ) {
        expect(this.airiIngressIntent).toEqual({
          messageId: "msg_1",
          workspaceId: "ws_1",
          ingressStatus: "pending",
        });
        return Promise.resolve();
      });

      await persistInboundMessage(
        { message_id: 42, date: 1_700_000_000, ...content } as never,
        { _id: "chat_1" } as never,
        5001,
        "conv_1",
        "ws_1",
        "inbound",
        "bot_token",
        { type: "telegram", workspaceId: "ws_1" } as never
      );
    }
  );

  it("recovers the persisted owner without replacing its accepted intent", async () => {
    const existing = {
      _id: "existing_1",
      airiIngressIntent: { ingressStatus: "signaled" },
    };
    mockMessageSave.mockRejectedValueOnce({ code: 11000 });
    mockMessageFindOne.mockResolvedValueOnce(existing);

    const result = await persistInboundMessage(
      { message_id: 42, date: 1_700_000_000, text: "hello" } as never,
      { _id: "chat_1" } as never,
      5001,
      "conv_1",
      "ws_1",
      "inbound",
      "bot_token",
      { type: "telegram", workspaceId: "ws_1" } as never
    );

    expect(result).toEqual({ message: existing, isNew: false });
    expect(existing.airiIngressIntent).toEqual({ ingressStatus: "signaled" });
  });

  it("suppresses duplicate fanout from the committed atomic append result", async () => {
    mockAppendMessageToConversationById.mockResolvedValueOnce({
      appended: false,
    });

    await runPostSaveSideEffects(
      { _id: "conversation_1", messages: [], sourceId: "source_1" } as never,
      "workspace_1",
      {
        _id: "message_1",
        date: new Date("2026-08-10T06:00:00.000Z"),
        direction: "inbound",
        mediaType: null,
      } as never
    );

    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation_1",
      "message_1",
      expect.objectContaining({ direction: "inbound" })
    );
    expect(mockMessageFindById).not.toHaveBeenCalled();
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
    expect(mockInvalidateRequestsForWorkspace).not.toHaveBeenCalled();
  });
});
