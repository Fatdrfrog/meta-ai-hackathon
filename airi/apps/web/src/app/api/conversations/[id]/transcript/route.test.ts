const mockConnectDb = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockIsSupabaseRouteAuthError = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockEnqueueConversationMediaAnalysis = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (...args: unknown[]) =>
    mockIsSupabaseRouteAuthError(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));
jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: (...args: unknown[]) =>
    mockEnqueueConversationMediaAnalysis(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
  },
}));

import { NextRequest } from "next/server";

import { POST } from "./route";

function mockLeanChain<T>(value: T) {
  return {
    select: jest.fn(() => ({
      lean: jest.fn(async () => value),
    })),
  };
}

async function postTranscript(messageId = "message-1") {
  return POST(
    new NextRequest(
      "http://localhost/api/conversations/conversation-1/transcript",
      {
        method: "POST",
        body: JSON.stringify({ messageId }),
      }
    ),
    { params: Promise.resolve({ id: "conversation-1" }) }
  );
}

describe("POST /api/conversations/[id]/transcript", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDb.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: {},
      user: { id: "user-1" },
    });
    mockIsSupabaseRouteAuthError.mockReturnValue(false);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockConversationFindById.mockReturnValue(
      mockLeanChain({ workspaceId: "workspace-1" })
    );
    mockEnqueueConversationMediaAnalysis.mockResolvedValue({
      queued: true,
      reason: "queued",
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:video",
      duplicate: false,
    });
  });

  it("returns stored video transcript text without issuing another STT request", async () => {
    mockMessageFindOne.mockReturnValue(
      mockLeanChain({
        mediaType: "video",
        text: "The customer says the screen is cracked.",
        imageUrl: "https://cdn.example.com/video.mp4",
        mimeType: "video/mp4",
        attachments: [],
      })
    );

    const response = await postTranscript();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      transcript: "The customer says the screen is cracked.",
    });
    expect(mockEnqueueConversationMediaAnalysis).not.toHaveBeenCalled();
  });

  it.each(["audio", "voice"])(
    "treats %s exactly like video: stored text first, else the media workflow",
    async mediaType => {
      mockMessageFindOne.mockReturnValueOnce(
        mockLeanChain({ mediaType, text: "Call me after six." })
      );
      const stored = await postTranscript();
      expect(stored.status).toBe(200);
      await expect(stored.json()).resolves.toEqual({
        transcript: "Call me after six.",
      });

      mockMessageFindOne.mockReturnValueOnce(
        mockLeanChain({ mediaType, text: "[Voice message]" })
      );
      const queued = await postTranscript();
      expect(queued.status).toBe(202);
      expect(mockEnqueueConversationMediaAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType })
      );
    }
  );

  it("returns the plan gate response for a hidden conversation without reading the message", async () => {
    const body = {
      code: "company_conversation_limit_exceeded",
      planGate: { hiddenCount: 2, reason: "trial_expired" },
    };
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      Response.json(body, { status: 402 })
    );

    const response = await postTranscript();

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual(body);
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      {},
      "workspace-1",
      "conversation-1"
    );
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockEnqueueConversationMediaAnalysis).not.toHaveBeenCalled();
  });

  it("rejects media that cannot have a transcript", async () => {
    mockMessageFindOne.mockReturnValue(
      mockLeanChain({ mediaType: "image", text: "" })
    );

    const response = await postTranscript();

    expect(response.status).toBe(400);
    expect(mockEnqueueConversationMediaAnalysis).not.toHaveBeenCalled();
  });

  it("does not return an Instagram story label as the video's transcript", async () => {
    mockMessageFindOne.mockReturnValue(
      mockLeanChain({ mediaType: "video", text: "Tagged in Instagram story" })
    );

    const response = await postTranscript();

    expect(response.status).toBe(202);
    expect(mockEnqueueConversationMediaAnalysis).toHaveBeenCalledTimes(1);
  });

  it("enqueues the canonical media workflow instead of directly transcribing missing video text", async () => {
    mockMessageFindOne.mockReturnValue(
      mockLeanChain({
        mediaType: "video",
        text: "[Video attachment]",
        imageUrl: "https://cdn.example.com/video.mp4",
        mimeType: "video/mp4",
        attachments: [],
      })
    );

    const response = await postTranscript();
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toEqual({ error: "Transcript is being prepared." });
    expect(mockEnqueueConversationMediaAnalysis).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "video",
    });
  });
});
