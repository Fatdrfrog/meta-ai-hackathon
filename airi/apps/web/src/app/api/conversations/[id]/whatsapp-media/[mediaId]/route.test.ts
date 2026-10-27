import { GET } from "@/app/api/conversations/[id]/whatsapp-media/[mediaId]/route";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { NextRequest } from "next/server";

const mockAuthGetUser = jest.fn();
const mockConnectDb = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockGraphGetJson = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mockAuthGetUser,
    },
  }),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
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

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@icecore/shared/lib/meta/api", () => {
  class MetaGraphRequestError extends Error {
    status: number;
    statusText: string;
    url: string;
    details: unknown;
    metaError?: { message?: string };

    constructor(params: {
      message: string;
      status: number;
      statusText: string;
      url: string;
      details: unknown;
      metaError?: { message?: string };
    }) {
      super(params.message);
      this.name = "MetaGraphRequestError";
      this.status = params.status;
      this.statusText = params.statusText;
      this.url = params.url;
      this.details = params.details;
      this.metaError = params.metaError;
    }
  }

  return {
    MetaGraphRequestError,
    getWhatsAppGraphClient: () => ({
      getJson: (...args: unknown[]) => mockGraphGetJson(...args),
    }),
  };
});

function mockFindChain<T>(value: T) {
  return {
    select: jest.fn(() => ({
      lean: jest.fn(() => ({
        exec: jest.fn(async () => value),
      })),
    })),
  };
}

describe("GET WhatsApp media proxy", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: { id: "user_1" },
      },
    });
    mockConnectDb.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockConversationFindById.mockReturnValue(
      mockFindChain({
        _id: "conv_1",
        workspaceId: "ws_1",
        channel: "whatsapp",
        sourceId: "source_1",
      })
    );
    mockMessageFindOne.mockReturnValue(mockFindChain({ _id: "msg_1" }));
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone_1",
      accessToken: "access_token",
    });
    mockGraphGetJson.mockResolvedValue({
      url: "https://lookaside.whatsapp.test/media",
      mime_type: "video/mp4",
      file_size: 4,
    });
    global.fetch = jest.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": "4",
          },
        })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requires an authenticated user", async () => {
    mockAuthGetUser.mockResolvedValueOnce({ data: { user: null } });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );

    expect(response.status).toBe(401);
    expect(mockConversationFindById).not.toHaveBeenCalled();
  });

  it("requires workspace access before proxying media", async () => {
    mockVerifyWorkspaceAccess.mockResolvedValueOnce(false);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );

    expect(response.status).toBe(403);
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
  });

  it("blocks media access when the conversation is hidden by plan limits", async () => {
    mockGetHiddenConversationPlanGateResponse.mockResolvedValueOnce(
      Response.json(
        {
          error: "Plan limit exceeded",
          code: "company_conversation_visibility_exceeded",
        },
        { status: 402 }
      )
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );
    const data = await response.json();

    expect(response.status).toBe(402);
    expect(data).toEqual(
      expect.objectContaining({
        code: "company_conversation_visibility_exceeded",
      })
    );
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
  });

  it("requires the media id to belong to a message in the conversation", async () => {
    mockMessageFindOne.mockReturnValueOnce(mockFindChain(null));

    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );

    expect(response.status).toBe(404);
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      conversation: "conv_1",
      workspaceId: "ws_1",
      channel: "whatsapp",
      whatsappMediaId: "media_1",
    });
    expect(mockGraphGetJson).not.toHaveBeenCalled();
  });

  it("streams owned media with authenticated Graph headers", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1?filename=clip.mp4"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );

    expect(response.status).toBe(200);
    expect(mockGraphGetJson).toHaveBeenCalledWith("media_1", {
      token: "access_token",
      query: { phone_number_id: "phone_1" },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://lookaside.whatsapp.test/media",
      {
        headers: { Authorization: "Bearer access_token" },
      }
    );
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''clip.mp4"
    );
    await expect(response.arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      4
    );
  });

  it("redirects to durable stored media without fetching Meta", async () => {
    mockMessageFindOne.mockReturnValueOnce(
      mockFindChain({
        _id: "msg_1",
        imageUrl: "https://storage.test/whatsapp/media.png",
      })
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://storage.test/whatsapp/media.png"
    );
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
  });

  it("returns a stable gone response when Meta no longer has proxy-only media", async () => {
    mockGraphGetJson.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message:
          "Unsupported get request. Object with ID 'media_1' does not exist or missing permissions.",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/media_1",
        details: {
          error: {
            message:
              "Unsupported get request. Object with ID 'media_1' does not exist or missing permissions.",
          },
        },
        metaError: {
          message:
            "Unsupported get request. Object with ID 'media_1' does not exist or missing permissions.",
          type: "GraphMethodException",
          code: 100,
        },
      })
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/conversations/conv_1/whatsapp-media/media_1"
      ),
      {
        params: Promise.resolve({ id: "conv_1", mediaId: "media_1" }),
      }
    );
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data).toEqual({
      error:
        "WhatsApp media is no longer available from Meta and no stored copy exists.",
      code: "whatsapp_media_unavailable",
    });
  });
});
