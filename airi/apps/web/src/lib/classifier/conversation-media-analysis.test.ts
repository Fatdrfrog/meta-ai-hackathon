const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockDownloadOwnedWhatsAppMedia = jest.fn();
const mockParseWhatsAppMediaProxyUrl = jest.fn();
const mockMessageFind = jest.fn();
const mockMessageFindById = jest.fn();
const mockMessageFindOneAndUpdate = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockAnalyzeAudio = jest.fn();
const mockAnalyzeImage = jest.fn();
const mockAnalyzeVideo = jest.fn();
const mockUpdateClassificationInputMessageAndInvalidate = jest.fn();
const mockTextAiAdmission = jest.fn();
const mockResolveGoogleCredentials = jest.fn();

const mockCreateSignedUrls = jest.fn();
const mockCreateSignedUrl = jest.fn();
const mockStorageFrom = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockTextAiAdmission(...args),
    storage: {
      from: (bucket: string) => {
        mockStorageFrom(bucket);
        return {
          createSignedUrls: (...args: unknown[]) =>
            mockCreateSignedUrls(...args),
          createSignedUrl: (...args: unknown[]) => mockCreateSignedUrl(...args),
        };
      },
    },
  },
}));
jest.mock("@/lib/google/google-ai-source", () => ({
  GoogleAiConnectionError: class extends Error {},
  resolveGoogleAiCredentialsForWorkspace: (...args: unknown[]) =>
    mockResolveGoogleCredentials(...args),
}));

jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));
jest.mock("@/lib/media/whatsapp-media-server", () => ({
  downloadOwnedWhatsAppMedia: (...args: unknown[]) =>
    mockDownloadOwnedWhatsAppMedia(...args),
}));
jest.mock("@/lib/media/whatsapp-media-url", () => ({
  parseWhatsAppMediaProxyUrl: (...args: unknown[]) =>
    mockParseWhatsAppMediaProxyUrl(...args),
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));
jest.mock("@/lib/ai/multimodal", () => ({
  analyzeAudio: (...args: unknown[]) => mockAnalyzeAudio(...args),
  analyzeImage: (...args: unknown[]) => mockAnalyzeImage(...args),
  analyzeVideo: (...args: unknown[]) => mockAnalyzeVideo(...args),
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
    findById: (...args: unknown[]) => mockMessageFindById(...args),
    findOneAndUpdate: (...args: unknown[]) => mockMessageFindOneAndUpdate(...args),
  },
}));
jest.mock("./classification-input-mutation", () => ({
  updateClassificationInputMessageAndInvalidate: (...args: unknown[]) =>
    mockUpdateClassificationInputMessageAndInvalidate(...args),
}));
const mockSafeCrawlFetch = jest.fn();
jest.mock("@/lib/crawler/url-safety", () => ({
  ...jest.requireActual("@/lib/crawler/url-safety"),
  safeCrawlFetch: (...args: unknown[]) => mockSafeCrawlFetch(...args),
}));

import { ElevenLabsSttError } from "@icecore/airi-runtime/elevenlabs-stt";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { resolveWorkspaceTextAiBilling } from "@/lib/ai/workspace-ai-policy";

import {
  completeConversationMediaMessageAnalysis,
  processAudioMessageAnalysis,
  processConversationImageAnalysis,
  processVideoMessageAnalysis,
  serializeLogError,
  conversationTranscriptionBilling,
} from "./conversation-media-analysis";

it("claims transcription only once for the owned message, recording its payer", async () => {
  const lean = jest.fn().mockResolvedValueOnce({ _id: "message-1" }).mockResolvedValueOnce(null);
  mockMessageFindOneAndUpdate.mockReturnValue({ select: () => ({ lean }) });
  const input = { workspaceId: "workspace-1", conversationId: "conversation-1", messageId: "message-1", credentialSource: "workspace_source" as const, sourceId: "customer-source" };
  expect(await conversationTranscriptionBilling.claimSubmission(input)).toBe(true);
  expect(await conversationTranscriptionBilling.claimSubmission(input)).toBe(false);
  expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({
    _id: "message-1", workspaceId: "workspace-1", conversation: "conversation-1",
    "mediaAnalysis.submissionClaimedAt": null, "mediaAnalysis.providerRequestId": null,
  }), { $set: expect.objectContaining({ "mediaAnalysis.credentialSource": "workspace_source", "mediaAnalysis.credentialSourceId": "customer-source" }) }, { new: true });
});

const conversationId = "68a000000000000000000001";
const messageId = "68a000000000000000000002";
const context = { workspaceId: "workspace-1", sourceId: "source-1" };

function imageMessageQuery() {
  return {
    select: jest.fn().mockResolvedValue([
      {
        _id: messageId,
        imageUrl: `/api/conversations/${conversationId}/whatsapp-media/media-1`,
        imageAnalysis: null,
        mediaType: "image",
        mimeType: "image/jpeg",
        attachments: [],
      },
    ]),
  };
}

function latestMessageQuery(text: string | null = null) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(text === null ? null : { text }),
    }),
  };
}

function transcriptionSubmission(input?: {
  deliveryMode?: "webhook" | "inline";
  transcriptText?: string | null;
  mediaKind?: "audio" | "video";
}) {
  return {
    requestId: "request-1",
    model: "scribe_v2",
    mimeType: input?.mediaKind === "video" ? "video/mp4" : "audio/ogg",
    inputBytes: 128,
    latencyMs: 42,
    mediaKind: input?.mediaKind ?? ("audio" as const),
    inputMode: "source_url" as const,
    deliveryMode: input?.deliveryMode ?? ("webhook" as const),
    transcriptText: input?.transcriptText ?? null,
    languageCode: "en",
    responsePayload: null,
  };
}

function mediaMessage(
  mediaType: "audio" | "voice" | "video",
  overrides: Record<string, unknown> = {}
) {
  return {
    _id: messageId,
    author: null,
    text: "",
    date: new Date("2026-08-10T06:00:00.000Z"),
    direction: "inbound",
    channel: "whatsapp",
    imageUrl: `https://cdn.example.com/media.${mediaType === "video" ? "mp4" : "ogg"}`,
    mediaType,
    mimeType: mediaType === "video" ? "video/mp4" : "audio/ogg",
    attachments: [],
    mediaAnalysis: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMessageFind.mockReturnValue(imageMessageQuery());
  mockMessageFindById.mockReturnValue(latestMessageQuery());
  mockRealtimeTrigger.mockResolvedValue(undefined);
  mockParseWhatsAppMediaProxyUrl.mockReturnValue({
    conversationId,
    mediaId: "media-1",
  });
  mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
    semanticChanged: true,
    requestedRevision: 2,
    generation: 1,
    status: "pending",
  });
});

describe("conversation semantic media analysis", () => {
  it("bounds both nested error fields before logging", () => {
    const error = new Error("m".repeat(300));
    error.name = "n".repeat(100);

    expect(serializeLogError(error)).toEqual({
      message: "m".repeat(240),
      name: "n".repeat(64),
    });
  });

  it("stores genuine permanent image absence through the semantic transaction", async () => {
    const providerMessage =
      "Unsupported get request. Object with ID 'media-1' does not exist.";
    mockDownloadOwnedWhatsAppMedia.mockRejectedValue(
      new MetaGraphRequestError({
        message: providerMessage,
        status: 404,
        statusText: "Not Found",
        url: "https://graph.facebook.com/v25.0/media-1",
        details: { error: { message: providerMessage } },
      })
    );

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).resolves.toEqual({ semanticChanged: true });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "classification.media_unavailable",
      {
        conversation_id: conversationId,
        message_id: messageId,
        media_id: "media-1",
        analysis_kind: "image",
        error: {
          message: providerMessage,
          name: "MetaGraphRequestError",
        },
        reason: "provider_media_unavailable",
      }
    );
    expect(mockLoggerInfo.mock.calls[0]?.[1]).not.toHaveProperty("message");
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledWith({
      conversationId,
      messageId,
      set: {
        imageAnalysis: "Image media is no longer available for AI analysis.",
      },
      semanticPaths: ["imageAnalysis"],
    });
    expect(mockAnalyzeImage).not.toHaveBeenCalled();
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      `private-conversation-${conversationId}`,
      "message-updated",
      {
        messageId,
        imageAnalysis: "Image media is no longer available for AI analysis.",
      }
    );
  });

  it.each([
    [
      "an expired media id (Meta object subcode)",
      new MetaGraphRequestError({
        message:
          "Unsupported get request. Object with ID 'media-1' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/media-1",
        details: {},
        metaError: {
          message:
            "Unsupported get request. Object with ID 'media-1' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
          type: "GraphMethodException",
          code: 100,
          error_subcode: 33,
        },
      }),
    ],
    [
      "a Meta authorization code",
      new MetaGraphRequestError({
        message: "Unsupported get request due to missing permissions.",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/media-1",
        details: {},
        metaError: {
          message: "Unsupported get request due to missing permissions.",
          type: "OAuthException",
          code: 200,
        },
      }),
    ],
  ])(
    "skips media Meta refuses for %s without fabricating semantics",
    async (_name, error) => {
      mockDownloadOwnedWhatsAppMedia.mockRejectedValue(error);

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).resolves.toEqual({ semanticChanged: false });

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "classification.media_skipped",
        {
          conversation_id: conversationId,
          message_id: messageId,
          analysis_kind: "image",
          reason: "provider_media_inaccessible",
        }
      );
      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).not.toHaveBeenCalled();
      expect(mockAnalyzeImage).not.toHaveBeenCalled();
      expect(mockRealtimeTrigger).not.toHaveBeenCalled();
    }
  );

  it("keeps analyzing later images after skipping a refused one", async () => {
    const laterMessageId = "68a000000000000000000003";
    mockMessageFind.mockReturnValue({
      select: jest.fn().mockResolvedValue([
        {
          _id: messageId,
          imageUrl: `/api/conversations/${conversationId}/whatsapp-media/media-1`,
          imageAnalysis: null,
          mediaType: "image",
          mimeType: "image/jpeg",
          attachments: [],
        },
        {
          _id: laterMessageId,
          imageUrl: `/api/conversations/${conversationId}/whatsapp-media/media-2`,
          imageAnalysis: null,
          mediaType: "image",
          mimeType: "image/jpeg",
          attachments: [],
        },
      ]),
    });
    mockDownloadOwnedWhatsAppMedia
      .mockRejectedValueOnce(
        new MetaGraphRequestError({
          message: "Unsupported get request.",
          status: 400,
          statusText: "Bad Request",
          url: "https://graph.facebook.com/v25.0/media-1",
          details: {},
          metaError: {
            message: "Unsupported get request.",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 33,
          },
        })
      )
      .mockResolvedValueOnce({
        buffer: Buffer.from("image-bytes"),
        contentType: "image/jpeg",
      });
    mockAnalyzeImage.mockResolvedValue("A printed receipt.");

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).resolves.toEqual({ semanticChanged: true });

    expect(mockAnalyzeImage).toHaveBeenCalledTimes(1);
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledTimes(1);
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: laterMessageId,
        set: { imageAnalysis: "A printed receipt." },
      })
    );
  });

  describe("own-bucket images", () => {
    const supabaseUrl = "https://project.supabase.co";
    const storedUrl = `${supabaseUrl}/storage/v1/object/public/conversation-images/whatsapp/photo.jpg`;
    const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
      mockMessageFind.mockReturnValue({
        select: jest.fn().mockResolvedValue([
          {
            _id: messageId,
            imageUrl: storedUrl,
            imageAnalysis: null,
            mediaType: "image",
            mimeType: "image/jpeg",
            attachments: [],
          },
        ]),
      });
      mockCreateSignedUrl.mockResolvedValue({
        data: { signedUrl: `${supabaseUrl}/storage/v1/object/sign/x?token=t` },
        error: null,
      });
      fetchSpy = jest.spyOn(global, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      if (originalSupabaseUrl === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
      }
    });

    it("reads the image through a short-lived signed URL and sends it inline, never as a URL", async () => {
      fetchSpy.mockResolvedValue(
        new Response(Buffer.from("image-bytes"), {
          headers: { "content-type": "image/jpeg" },
        })
      );
      mockAnalyzeImage.mockResolvedValue("A printed receipt.");

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).resolves.toEqual({ semanticChanged: true });

      expect(mockStorageFrom).toHaveBeenCalledWith("conversation-images");
      expect(mockCreateSignedUrl).toHaveBeenCalledWith(
        "whatsapp/photo.jpg",
        60
      );
      expect(mockAnalyzeImage).toHaveBeenCalledWith(
        storedUrl,
        "en",
        "image/jpeg",
        { inlineDataBase64: Buffer.from("image-bytes").toString("base64") }
      );
      expect(mockDownloadOwnedWhatsAppMedia).not.toHaveBeenCalled();
    });

    it("stores the too-large marker instead of sending an oversized image", async () => {
      fetchSpy.mockResolvedValue(
        new Response(Buffer.alloc(8), {
          headers: { "content-length": String(10 * 1024 * 1024) },
        })
      );

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).resolves.toEqual({ semanticChanged: true });

      expect(mockAnalyzeImage).not.toHaveBeenCalled();
      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          set: { imageAnalysis: "Image is too large for AI analysis." },
        })
      );
    });

    it("stores the unavailable marker when the object is gone", async () => {
      mockCreateSignedUrl.mockResolvedValue({
        data: null,
        error: { message: "Object not found", statusCode: "404", status: 400 },
      });

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).resolves.toEqual({ semanticChanged: true });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockAnalyzeImage).not.toHaveBeenCalled();
      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          set: {
            imageAnalysis:
              "Image media is no longer available for AI analysis.",
          },
        })
      );
    });

    it("throws a transient storage failure so classification retries", async () => {
      mockCreateSignedUrl.mockResolvedValue({
        data: null,
        error: { message: "Service unavailable", status: 503 },
      });

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).rejects.toThrow("Customer media could not be signed for download");
      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).not.toHaveBeenCalled();
    });
  });

  describe("images outside the customer buckets", () => {
    // A business template header: not customer media, not a WhatsApp proxy.
    const headerUrl =
      "https://api.airi.chat/storage/v1/object/public/business-media/whatsapp-template-headers/ws/header.png";

    beforeEach(() => {
      mockParseWhatsAppMediaProxyUrl.mockReturnValue(null);
      mockMessageFind.mockReturnValue({
        select: jest.fn().mockResolvedValue([
          {
            _id: messageId,
            imageUrl: headerUrl,
            imageAnalysis: null,
            mediaType: "image",
            mimeType: "image/png",
            attachments: [],
          },
        ]),
      });
    });

    // Platform-billed Vertex refuses remote URIs as workspace_ai_spend_limit,
    // which failed and retried the whole classification.
    it("sends the image bytes inline instead of its link", async () => {
      mockSafeCrawlFetch.mockResolvedValue(
        new Response(Buffer.from("header-bytes"), {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      );
      mockAnalyzeImage.mockResolvedValue("A product banner.");

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).resolves.toEqual({ semanticChanged: true });

      expect(mockSafeCrawlFetch).toHaveBeenCalledWith(
        headerUrl,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(mockAnalyzeImage).toHaveBeenCalledWith(
        headerUrl,
        "en",
        "image/png",
        { inlineDataBase64: Buffer.from("header-bytes").toString("base64") }
      );
    });

    it("stores the unavailable marker when the link is gone", async () => {
      mockSafeCrawlFetch.mockResolvedValue(
        new Response("missing", { status: 404 })
      );

      await expect(
        processConversationImageAnalysis({
          conversationId,
          language: "en",
          context,
        })
      ).resolves.toEqual({ semanticChanged: true });

      expect(mockAnalyzeImage).not.toHaveBeenCalled();
      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          set: {
            imageAnalysis:
              "Image media is no longer available for AI analysis.",
          },
        })
      );
    });
  });

  it("stores the too-large marker for a WhatsApp image over the inline limit", async () => {
    mockDownloadOwnedWhatsAppMedia.mockResolvedValue({
      buffer: Buffer.alloc(300_000),
      contentType: "image/jpeg",
    });

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).resolves.toEqual({ semanticChanged: true });

    expect(mockAnalyzeImage).not.toHaveBeenCalled();
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        set: { imageAnalysis: "Image is too large for AI analysis." },
      })
    );
  });

  it.each([
    [
      "Meta rate limit",
      new MetaGraphRequestError({
        message: "Rate limited",
        status: 429,
        statusText: "Too Many Requests",
        url: "https://graph.facebook.com/v25.0/media-1",
        details: {},
        metaError: { message: "Rate limited", type: "OAuthException", code: 4 },
      }),
    ],
    [
      "bare Meta parameter code",
      new MetaGraphRequestError({
        message: "Invalid parameter value",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/media-1",
        details: {},
        metaError: {
          message: "Invalid parameter value",
          type: "OAuthException",
          code: 100,
        },
      }),
    ],
    [
      "Meta server failure",
      new MetaGraphRequestError({
        message: "Meta is unavailable",
        status: 503,
        statusText: "Service Unavailable",
        url: "https://graph.facebook.com/v25.0/media-1",
        details: {},
      }),
    ],
    [
      "download timeout",
      Object.assign(new Error("Media download timed out"), {
        name: "AbortError",
      }),
    ],
    ["unexpected download failure", new Error("Socket closed unexpectedly")],
  ])("throws %s without fabricating image semantics", async (_name, error) => {
    mockDownloadOwnedWhatsAppMedia.mockRejectedValue(error);

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).rejects.toBe(error);

    expect(mockLoggerInfo).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "classification.media_resolution_failed",
      {
        conversation_id: conversationId,
        message_id: messageId,
        media_id: "media-1",
        analysis_kind: "image",
        error: { message: error.message, name: error.name },
      }
    );
    expect(mockLoggerWarn.mock.calls[0]?.[1]).not.toHaveProperty("message");
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).not.toHaveBeenCalled();
    expect(mockAnalyzeImage).not.toHaveBeenCalled();
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
    expect(mockTextAiAdmission).not.toHaveBeenCalled();
  });

  it("writes resolved image semantics before emitting realtime", async () => {
    mockDownloadOwnedWhatsAppMedia.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/webp",
    });
    mockAnalyzeImage.mockResolvedValue("A blue product package.");

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).resolves.toEqual({ semanticChanged: true });

    expect(mockAnalyzeImage).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/whatsapp-media/media-1`,
      "en",
      "image/webp",
      { inlineDataBase64: Buffer.from("image-bytes").toString("base64") }
    );
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledWith({
      conversationId,
      messageId,
      set: { imageAnalysis: "A blue product package." },
      semanticPaths: ["imageAnalysis"],
    });
    expect(
      mockUpdateClassificationInputMessageAndInvalidate.mock
        .invocationCallOrder[0]
    ).toBeLessThan(mockRealtimeTrigger.mock.invocationCallOrder[0]);
  });

  it("keeps committed image semantics successful when post-commit realtime fails", async () => {
    const realtimeError = new Error("Realtime transport unavailable");
    mockDownloadOwnedWhatsAppMedia.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/jpeg",
    });
    mockAnalyzeImage.mockResolvedValue("A blue product package.");
    mockRealtimeTrigger.mockRejectedValue(realtimeError);

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).resolves.toEqual({ semanticChanged: true });

    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "classification.media_realtime_failed",
      {
        conversation_id: conversationId,
        message_id: messageId,
        event: "message-updated",
        error: {
          message: realtimeError.message,
          name: realtimeError.name,
        },
      }
    );
  });

  it("does not emit duplicate realtime when semantic completion is identical", async () => {
    mockDownloadOwnedWhatsAppMedia.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/jpeg",
    });
    mockAnalyzeImage.mockResolvedValue("Existing image analysis");
    mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
      semanticChanged: false,
    });

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).resolves.toEqual({ semanticChanged: false });
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
  });

  it("emits no realtime when the semantic transaction aborts", async () => {
    const transactionError = new Error(
      "Conversation input invalidation did not match"
    );
    mockDownloadOwnedWhatsAppMedia.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/jpeg",
    });
    mockAnalyzeImage.mockResolvedValue("New analysis");
    mockUpdateClassificationInputMessageAndInvalidate.mockRejectedValue(
      transactionError
    );

    await expect(
      processConversationImageAnalysis({
        conversationId,
        language: "en",
        context,
      })
    ).rejects.toBe(transactionError);
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
  });

  it("keeps processing and async submission as transport-only mutations", async () => {
    mockParseWhatsAppMediaProxyUrl.mockReturnValue(null);
    const submitAudio = jest
      .fn()
      .mockResolvedValue(transcriptionSubmission({ deliveryMode: "webhook" }));
    mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
      semanticChanged: false,
    });

    await expect(
      processAudioMessageAnalysis({
        conversationId,
        language: "en",
        context,
        workflowId: "media-workflow-1",
        message: mediaMessage("voice") as never,
        transcriptionSubmitter: { submitAudio },
      })
    ).resolves.toEqual({
      status: "submitted",
      transcriptStored: false,
      analysisStored: false,
      providerRequestId: "request-1",
    });

    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledTimes(2);
    for (const call of mockUpdateClassificationInputMessageAndInvalidate.mock
      .calls) {
      expect(call[0].semanticPaths).toEqual([]);
      expect(Object.keys(call[0].set)).toEqual(
        expect.arrayContaining(["mediaAnalysis.status", "mediaAnalysis.kind"])
      );
      expect(Object.keys(call[0].set)).not.toEqual(
        expect.arrayContaining(["text", "audioAnalysis", "videoAnalysis"])
      );
    }
    expect(
      mockUpdateClassificationInputMessageAndInvalidate.mock.calls[0]?.[0]
    ).toEqual(
      expect.objectContaining({
        conversationId,
        messageId,
        set: expect.objectContaining({
          "mediaAnalysis.status": "processing",
          "mediaAnalysis.kind": "voice",
          "mediaAnalysis.workflowId": "media-workflow-1",
        }),
      })
    );
    expect(
      mockUpdateClassificationInputMessageAndInvalidate.mock.calls[1]?.[0]
    ).toEqual(
      expect.objectContaining({
        set: expect.objectContaining({
          "mediaAnalysis.status": "submitted",
          "mediaAnalysis.provider": "elevenlabs",
          "mediaAnalysis.providerRequestId": "request-1",
        }),
      })
    );
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
  });

  it.each([
    [
      "configuration",
      new ElevenLabsSttError({
        kind: "config",
        transient: false,
        message: "ElevenLabs is not configured",
      }),
    ],
    [
      "authorization",
      new ElevenLabsSttError({
        kind: "auth",
        transient: false,
        status: 401,
        message: "ElevenLabs authentication failed",
      }),
    ],
    [
      "rate limit",
      new ElevenLabsSttError({
        kind: "rate_limit",
        transient: true,
        status: 429,
        message: "ElevenLabs rate limit reached",
      }),
    ],
    [
      "timeout",
      new ElevenLabsSttError({
        kind: "timeout",
        transient: true,
        message: "ElevenLabs request timed out",
      }),
    ],
    [
      "server failure",
      new ElevenLabsSttError({
        kind: "server",
        transient: true,
        status: 503,
        message: "ElevenLabs server error",
      }),
    ],
    ["unexpected failure", new Error("Unexpected STT failure")],
  ])(
    "throws ElevenLabs %s without storing error text as semantics",
    async (_name, error) => {
      mockParseWhatsAppMediaProxyUrl.mockReturnValue(null);
      const submitAudio = jest.fn().mockRejectedValue(error);
      mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
        semanticChanged: false,
      });

      await expect(
        processAudioMessageAnalysis({
          conversationId,
          language: "en",
          context,
          workflowId: "media-workflow-1",
          message: mediaMessage("audio") as never,
          transcriptionSubmitter: { submitAudio },
        })
      ).rejects.toBe(error);

      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).toHaveBeenCalledTimes(1);
      expect(
        Object.keys(
          mockUpdateClassificationInputMessageAndInvalidate.mock.calls[0]?.[0]
            .set
        )
      ).toEqual(expect.arrayContaining(["mediaAnalysis.status"]));
      expect(
        Object.keys(
          mockUpdateClassificationInputMessageAndInvalidate.mock.calls[0]?.[0]
            .set
        )
      ).not.toEqual(expect.arrayContaining(["text", "audioAnalysis"]));
      expect(mockRealtimeTrigger).not.toHaveBeenCalled();
    }
  );

  it("stores completed audio transcript, analysis, and transport state atomically", async () => {
    mockAnalyzeAudio.mockResolvedValue("Customer asks about delivery status.");
    mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
      semanticChanged: true,
      requestedRevision: 3,
      generation: 2,
      status: "pending",
    });

    await expect(
      completeConversationMediaMessageAnalysis({
        conversationId,
        language: "en",
        context,
        workflowId: "media-workflow-1",
        message: mediaMessage("voice") as never,
        transcription: {
          requestId: "request-1",
          status: "completed",
          text: "Where is my delivery?",
          languageCode: "en",
          payload: null,
          receivedAt: "2026-08-10T06:02:00.000Z",
        },
      })
    ).resolves.toEqual({
      status: "completed",
      transcriptStored: true,
      analysisStored: true,
      providerRequestId: "request-1",
    });

    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledTimes(1);
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledWith({
      conversationId,
      messageId,
      set: expect.objectContaining({
        text: "Where is my delivery?",
        audioAnalysis: "Customer asks about delivery status.",
        "mediaAnalysis.status": "completed",
        "mediaAnalysis.kind": "voice",
        "mediaAnalysis.provider": "elevenlabs",
        "mediaAnalysis.providerRequestId": "request-1",
      }),
      semanticPaths: ["audioAnalysis", "text"],
    });
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      `private-conversation-${conversationId}`,
      "message-updated",
      expect.objectContaining({
        messageId,
        text: "Where is my delivery?",
        audioAnalysis: "Customer asks about delivery status.",
        mediaAnalysis: expect.objectContaining({ status: "completed" }),
      })
    );
  });

  it("stores completed video transcript and analysis through the same transaction owner", async () => {
    mockAnalyzeVideo.mockResolvedValue("The video shows a damaged package.");
    mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
      semanticChanged: true,
      requestedRevision: 4,
      generation: 2,
      status: "pending",
    });

    await expect(
      completeConversationMediaMessageAnalysis({
        conversationId,
        language: "en",
        context,
        workflowId: "media-workflow-2",
        message: mediaMessage("video") as never,
        transcription: {
          requestId: "request-video-1",
          status: "completed",
          text: "The box arrived damaged.",
          languageCode: "en",
          payload: null,
          receivedAt: "2026-08-10T06:03:00.000Z",
        },
      })
    ).resolves.toMatchObject({
      status: "completed",
      transcriptStored: true,
      analysisStored: true,
    });

    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).toHaveBeenCalledWith({
      conversationId,
      messageId,
      set: expect.objectContaining({
        text: "The box arrived damaged.",
        videoAnalysis: "The video shows a damaged package.",
        "mediaAnalysis.kind": "video",
      }),
      semanticPaths: ["videoAnalysis", "text"],
    });
  });

  it.each([
    [
      "provider failure",
      {
        requestId: "request-1",
        status: "failed" as const,
        error: "Provider rejected media.",
      },
    ],
    [
      "empty completion",
      { requestId: "request-1", status: "completed" as const, text: "   " },
    ],
  ])(
    "keeps %s as terminal transport state without semantic error text",
    async (_name, transcription) => {
      mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
        semanticChanged: false,
      });

      await expect(
        completeConversationMediaMessageAnalysis({
          conversationId,
          language: "en",
          context,
          workflowId: "media-workflow-1",
          message: mediaMessage("audio") as never,
          transcription,
        })
      ).resolves.toMatchObject({
        status: "failed",
        transcriptStored: false,
        analysisStored: false,
        providerRequestId: "request-1",
      });

      expect(
        mockUpdateClassificationInputMessageAndInvalidate
      ).toHaveBeenCalledTimes(1);
      const mutation =
        mockUpdateClassificationInputMessageAndInvalidate.mock.calls[0]?.[0];
      expect(mutation.semanticPaths).toEqual([]);
      expect(mutation.set).toEqual(
        expect.objectContaining({ "mediaAnalysis.status": "failed" })
      );
      expect(Object.keys(mutation.set)).not.toEqual(
        expect.arrayContaining(["text", "audioAnalysis", "videoAnalysis"])
      );
      expect(mockAnalyzeAudio).not.toHaveBeenCalled();
      expect(mockRealtimeTrigger).not.toHaveBeenCalled();
    }
  );

  it("does not duplicate realtime for an identical async completion", async () => {
    mockAnalyzeAudio.mockResolvedValue("Existing analysis");
    mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
      semanticChanged: false,
    });

    await expect(
      completeConversationMediaMessageAnalysis({
        conversationId,
        language: "en",
        context,
        workflowId: "media-workflow-1",
        message: mediaMessage("audio", {
          text: "Existing transcript",
          audioAnalysis: "Existing analysis",
        }) as never,
        transcription: {
          requestId: "request-1",
          status: "completed",
          text: "Existing transcript",
        },
      })
    ).resolves.toMatchObject({
      status: "completed",
      transcriptStored: false,
      analysisStored: false,
    });
    expect(mockRealtimeTrigger).not.toHaveBeenCalled();
  });

  it("keeps video submission in Temporal and returns the provider request id", async () => {
    mockParseWhatsAppMediaProxyUrl.mockReturnValue(null);
    const submitVideo = jest
      .fn()
      .mockResolvedValue(
        transcriptionSubmission({ deliveryMode: "webhook", mediaKind: "video" })
      );
    mockUpdateClassificationInputMessageAndInvalidate.mockResolvedValue({
      semanticChanged: false,
    });

    await expect(
      processVideoMessageAnalysis({
        conversationId,
        language: "en",
        context,
        workflowId: "media-workflow-video",
        message: mediaMessage("video") as never,
        transcriptionSubmitter: { submitVideo },
      })
    ).resolves.toMatchObject({
      status: "submitted",
      providerRequestId: "request-1",
    });
    expect(submitVideo).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeVideo).not.toHaveBeenCalled();
    expect(mockTextAiAdmission).not.toHaveBeenCalled();
  });

  it.each(["audio", "video"] as const)(
    "uses the same workspace action for %s analysis during processing and completion",
    async kind => {
      mockParseWhatsAppMediaProxyUrl.mockReturnValue(null);
      mockTextAiAdmission.mockResolvedValue({
        error: null,
        data: {
          workspace_id: context.workspaceId,
          company_id: "company-1",
          plan: "pro",
          billing_source: "customer",
          source_id: "google-1",
          period_start: "2026-09-01T00:00:00Z",
          reset_at: null,
          allowance_period: "lifetime",
        },
      });
      mockResolveGoogleCredentials.mockResolvedValue({
        sourceId: "google-1",
        apiKey: "customer-key",
      });
      const decisions: unknown[] = [];
      const analyze = kind === "audio" ? mockAnalyzeAudio : mockAnalyzeVideo;
      analyze.mockImplementation(async () => {
        decisions.push(await resolveWorkspaceTextAiBilling());
        return "Customer analysis";
      });
      const input = {
        conversationId,
        language: "en" as const,
        context,
        message: mediaMessage(kind, { text: "Existing transcript" }) as never,
      };
      const submit = jest.fn();
      if (kind === "audio") {
        await processAudioMessageAnalysis({
          ...input,
          transcriptionSubmitter: { submitAudio: submit },
        });
      } else {
        await processVideoMessageAnalysis({
          ...input,
          transcriptionSubmitter: { submitVideo: submit },
        });
      }
      await completeConversationMediaMessageAnalysis({
        ...input,
        transcription: {
          requestId: "request-1",
          status: "completed",
          text: "Existing transcript",
        },
      });

      expect(decisions).toEqual([
        expect.objectContaining({
          billingSource: "customer",
          workspaceId: context.workspaceId,
        }),
        expect.objectContaining({
          billingSource: "customer",
          workspaceId: context.workspaceId,
        }),
      ]);
      expect(mockTextAiAdmission).toHaveBeenCalledTimes(2);
      expect(mockTextAiAdmission.mock.calls).toEqual([
        [
          "admit_workspace_text_ai_action",
          {
            p_workspace_id: context.workspaceId,
            p_action_id: `media-analysis:${messageId}`,
          },
        ],
        [
          "admit_workspace_text_ai_action",
          {
            p_workspace_id: context.workspaceId,
            p_action_id: `media-analysis:${messageId}`,
          },
        ],
      ]);
      expect(submit).not.toHaveBeenCalled();
      expect(await resolveWorkspaceTextAiBilling()).toBeNull();
    }
  );

  it("stops semantic media completion when the workspace text allowance requires a source", async () => {
    mockTextAiAdmission.mockResolvedValue({
      error: null,
      data: {
        workspace_id: context.workspaceId,
        company_id: "company-1",
        plan: "pro",
        billing_source: "own_ai_source_required",
        source_id: null,
        period_start: "2026-09-01T00:00:00Z",
        reset_at: null,
        allowance_period: "lifetime",
      },
    });
    mockAnalyzeAudio.mockImplementation(async () => {
      await resolveWorkspaceTextAiBilling();
      return "Should not be stored";
    });
    await expect(
      completeConversationMediaMessageAnalysis({
        conversationId,
        language: "en",
        context,
        message: mediaMessage("audio") as never,
        transcription: {
          requestId: "request-1",
          status: "completed",
          text: "Transcript",
        },
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(
      mockUpdateClassificationInputMessageAndInvalidate
    ).not.toHaveBeenCalled();
    expect(mockResolveGoogleCredentials).not.toHaveBeenCalled();
  });
});

describe("stored video analysis", () => {
  const supabaseUrl = "https://project.supabase.co";
  const objectPath = `instagram/workspace-1/${conversationId}/clip.mp4`;
  const storedUrl = `${supabaseUrl}/storage/v1/object/public/conversation-images/${objectPath}`;
  const signedUrl = `${supabaseUrl}/storage/v1/object/sign/clip?token=t`;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let fetchSpy: jest.SpyInstance;

  const storedVideo = (overrides: Record<string, unknown> = {}) =>
    mediaMessage("video", {
      channel: "instagram",
      imageUrl: storedUrl,
      text: "The box arrived damaged.",
      ...overrides,
    }) as never;
  const semanticMutation = () =>
    mockUpdateClassificationInputMessageAndInvalidate.mock.calls
      .map(([mutation]) => mutation)
      .find(mutation => mutation.semanticPaths.includes("videoAnalysis"));

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
    mockParseWhatsAppMediaProxyUrl.mockReturnValue(null);
    mockCreateSignedUrls.mockResolvedValue({
      data: [{ path: objectPath, signedUrl }],
      error: null,
    });
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: `${supabaseUrl}/storage/v1/object/sign/x?token=t` },
      error: null,
    });
    mockAnalyzeVideo.mockResolvedValue("A dented box.");
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(Buffer.from("video-bytes"), {
        headers: { "content-type": "video/mp4" },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
  });

  it("sends a stored video within the inline limit to the model inline", async () => {
    await processVideoMessageAnalysis({
      conversationId,
      language: "en",
      context,
      message: storedVideo(),
      transcriptionSubmitter: { submitVideo: jest.fn() },
    });

    expect(mockCreateSignedUrl).toHaveBeenCalledWith(objectPath, 60);
    expect(mockAnalyzeVideo).toHaveBeenCalledWith(
      signedUrl,
      "en",
      "video/mp4",
      {
        precomputedTranscript: "The box arrived damaged.",
        inlineDataBase64: Buffer.from("video-bytes").toString("base64"),
      }
    );
  });

  it("analyzes a stored video over the inline limit from its transcript", async () => {
    fetchSpy.mockResolvedValue(
      new Response(Buffer.alloc(8), {
        headers: { "content-length": String(10 * 1024 * 1024) },
      })
    );

    await expect(
      processVideoMessageAnalysis({
        conversationId,
        language: "en",
        context,
        message: storedVideo(),
        transcriptionSubmitter: { submitVideo: jest.fn() },
      })
    ).resolves.toMatchObject({ status: "completed" });

    expect(mockAnalyzeVideo).toHaveBeenCalledWith(
      signedUrl,
      "en",
      "video/mp4",
      {
        precomputedTranscript: "The box arrived damaged.",
        inlineDataBase64: undefined,
      }
    );
  });

  it("does not send WhatsApp video bytes over the inline limit", async () => {
    mockParseWhatsAppMediaProxyUrl.mockReturnValue({
      conversationId,
      mediaId: "media-1",
    });
    mockDownloadOwnedWhatsAppMedia.mockResolvedValue({
      buffer: Buffer.alloc(300_000),
      contentType: "video/mp4",
    });

    await processVideoMessageAnalysis({
      conversationId,
      language: "en",
      context,
      message: mediaMessage("video", {
        imageUrl: `/api/conversations/${conversationId}/whatsapp-media/media-1`,
        text: "The box arrived damaged.",
      }) as never,
      transcriptionSubmitter: { submitVideo: jest.fn() },
    });

    expect(mockAnalyzeVideo.mock.calls[0]?.[3]).toEqual({
      precomputedTranscript: "The box arrived damaged.",
      inlineDataBase64: undefined,
    });
  });

  it("transcribes an Instagram story video and keeps its label as the text", async () => {
    const submitVideo = jest.fn().mockResolvedValue(
      transcriptionSubmission({
        deliveryMode: "inline",
        transcriptText: "Look at my order",
        mediaKind: "video",
      })
    );

    await expect(
      processVideoMessageAnalysis({
        conversationId,
        language: "en",
        context,
        message: storedVideo({ text: "Tagged in Instagram story" }),
        transcriptionSubmitter: { submitVideo },
      })
    ).resolves.toMatchObject({ status: "completed", transcriptStored: false });

    expect(submitVideo).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeVideo.mock.calls[0]?.[3]).toMatchObject({
      precomputedTranscript: "Look at my order",
    });
    expect(semanticMutation()).toMatchObject({
      set: expect.not.objectContaining({ text: expect.anything() }),
      semanticPaths: ["videoAnalysis"],
    });
  });

  it("keeps a story label when the async transcript arrives", async () => {
    await expect(
      completeConversationMediaMessageAnalysis({
        conversationId,
        language: "en",
        context,
        message: storedVideo({ text: "Tagged in Instagram story" }),
        transcription: {
          requestId: "request-1",
          status: "completed",
          text: "Look at my order",
        },
      })
    ).resolves.toMatchObject({ status: "completed", transcriptStored: false });

    expect(mockAnalyzeVideo).toHaveBeenCalledWith(
      signedUrl,
      "en",
      "video/mp4",
      {
        precomputedTranscript: "Look at my order",
        inlineDataBase64: Buffer.from("video-bytes").toString("base64"),
      }
    );
    expect(semanticMutation()).toMatchObject({
      set: expect.not.objectContaining({ text: expect.anything() }),
      semanticPaths: ["videoAnalysis"],
    });
  });
});
