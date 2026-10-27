/* eslint-disable no-var -- Jest mock factories in this file assign hoisted mock handles. */
/**
 * @jest-environment node
 */

var mockGetMediaInfo = jest.fn();
var mockDownloadMedia = jest.fn();
var mockConnectDb = jest.fn();
var mockConversationFindById = jest.fn();
var mockMessageFindOne = jest.fn();
var mockResolveSendContext = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));
jest.mock("@/lib/media/whatsapp-media-graph", () => ({
  getWhatsAppMediaInfoFromMeta: (...args: unknown[]) =>
    mockGetMediaInfo(...args),
  downloadWhatsAppMediaUrl: (...args: unknown[]) => mockDownloadMedia(...args),
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveSendContext(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockMessageFindOne(...args) },
}));

import { downloadOwnedWhatsAppMedia } from "./whatsapp-media-server";

function leanQuery<T>(value: T) {
  return {
    select: () => ({ lean: () => ({ exec: async () => value }) }),
  };
}

function ownedMediaFixture() {
  mockConnectDb.mockResolvedValue(undefined);
  mockConversationFindById.mockReturnValue(
    leanQuery({
      _id: "conversation-1",
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
    })
  );
  mockMessageFindOne.mockReturnValue(leanQuery({ _id: "message-1" }));
  mockResolveSendContext.mockResolvedValue({
    accessToken: "secret-token",
    phoneNumberId: "phone-1",
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  ownedMediaFixture();
});

describe("downloadOwnedWhatsAppMedia", () => {
  it("rejects a supplied workspace that does not own the conversation", async () => {
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "image/jpeg",
    });
    mockDownloadMedia.mockResolvedValue(
      new Response(Buffer.from("owned-image"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );

    await expect(
      downloadOwnedWhatsAppMedia({
        conversationId: "conversation-1",
        workspaceId: "other-workspace",
        inputMessageId: "message-1",
        mediaId: "media-1",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 5 * 1024 * 1024,
      })
    ).rejects.toThrow("workspace does not match");

    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it("rejects an oversized Meta declaration before opening the content request", async () => {
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "image/jpeg",
      file_size: 5 * 1024 * 1024 + 1,
    });

    await expect(
      downloadOwnedWhatsAppMedia({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        inputMessageId: "message-1",
        mediaId: "media-1",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 5 * 1024 * 1024,
      })
    ).rejects.toThrow("exceeds the allowed size");

    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it("rejects an oversized numeric-string Meta declaration before opening the content request", async () => {
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "image/jpeg",
      file_size: String(5 * 1024 * 1024 + 1),
    });

    await expect(
      downloadOwnedWhatsAppMedia({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        inputMessageId: "message-1",
        mediaId: "media-1",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 5 * 1024 * 1024,
      })
    ).rejects.toThrow("exceeds the allowed size");

    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it("rejects a disallowed Meta MIME declaration before opening the content request", async () => {
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "application/pdf",
      file_size: 12,
    });

    await expect(
      downloadOwnedWhatsAppMedia({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        inputMessageId: "message-1",
        mediaId: "media-1",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 5 * 1024 * 1024,
      })
    ).rejects.toThrow("MIME type is not allowed");

    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it("rejects an oversized response Content-Length before reading its body", async () => {
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "image/jpeg",
      file_size: 12,
    });
    const response = new Response(Buffer.from("small-image"), {
      status: 200,
      headers: { "content-length": String(5 * 1024 * 1024 + 1) },
    });
    const arrayBuffer = jest.spyOn(response, "arrayBuffer");
    mockDownloadMedia.mockResolvedValue(response);

    await expect(
      downloadOwnedWhatsAppMedia({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        inputMessageId: "message-1",
        mediaId: "media-1",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 5 * 1024 * 1024,
      })
    ).rejects.toThrow("Content-Length exceeds the allowed size");

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels a stream when observed bytes exceed the configured limit", async () => {
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "image/jpeg",
    });
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "image/jpeg" } }
    );
    mockDownloadMedia.mockResolvedValue(response);

    await expect(
      downloadOwnedWhatsAppMedia({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        inputMessageId: "message-1",
        mediaId: "media-1",
        allowedMimeTypes: ["image/jpeg"],
        maxBytes: 5,
      })
    ).rejects.toThrow("stream exceeded the allowed size");

    expect(cancelled).toBe(true);
  });

  it("verifies message ownership, allowed MIME, and the optional Meta SHA-256", async () => {
    const content = Buffer.from("owned-image");
    mockGetMediaInfo.mockResolvedValue({
      id: "media-1",
      url: "https://lookaside.whatsapp.test/media-1",
      mime_type: "image/jpeg",
      file_size: content.byteLength,
      sha256:
        "78b583c7bcfed6551ccb91615fb42e05fc5260816cccd6062cabe0729483da95",
    });
    mockDownloadMedia.mockResolvedValue(
      new Response(content, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );

    const media = await downloadOwnedWhatsAppMedia({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      inputMessageId: "message-1",
      mediaId: "media-1",
      allowedMimeTypes: ["image/jpeg"],
      maxBytes: 5 * 1024 * 1024,
    });

    expect(media).toMatchObject({
      contentType: "image/jpeg",
      sizeBytes: content.byteLength,
      sha256:
        "78b583c7bcfed6551ccb91615fb42e05fc5260816cccd6062cabe0729483da95",
    });
    expect(media.buffer).toEqual(content);
    expect(mockMessageFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "message-1", whatsappMediaId: "media-1" })
    );
  });
});
