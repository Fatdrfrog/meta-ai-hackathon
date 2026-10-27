import type { Page, Response as PlaywrightResponse } from "@playwright/test";
import {
  cleanupTestBusinessConnection,
  cleanupTestData,
  sendReplyFromPanel,
  setupTestBusinessConnection,
  verifyCoachingAvailable,
  verifyCoachingDisabled,
  verifyMessageInMongoDB,
  verifyTelegramReplyResponse,
} from "../../tests/fixtures/telegram-api-helpers";

class ReplyPage {
  private responseListener:
    | ((response: PlaywrightResponse) => void)
    | undefined;
  private responseWasEmitted = false;

  constructor(private readonly replyStatus = 200) {}

  async goto(): Promise<void> {}

  async waitForSelector(): Promise<void> {}

  locator(): {
    fill: (text: string) => Promise<void>;
    click: () => Promise<void>;
  } {
    return {
      fill: async () => {},
      click: async () => {
        this.responseWasEmitted = true;
        this.responseListener?.({
          status: () => this.replyStatus,
          url: () =>
            "http://localhost:3000/api/conversations/conversation-1/reply",
        } as PlaywrightResponse);
      },
    };
  }

  async waitForResponse(
    predicate: (response: PlaywrightResponse) => boolean
  ): Promise<PlaywrightResponse> {
    if (this.responseWasEmitted) {
      throw new Error("Reply response listener was registered after the click");
    }

    return new Promise((resolve, reject) => {
      this.responseListener = response => {
        if (predicate(response)) {
          resolve(response);
          return;
        }
        reject(new Error("Reply response did not satisfy the listener"));
      };
    });
  }
}

function coachingPage(
  payload: Record<string, unknown>,
  status = 200
): {
  page: Page;
  post: jest.Mock;
} {
  const post = jest.fn().mockResolvedValue({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => payload,
  });

  return {
    page: { request: { post } } as unknown as Page,
    post,
  };
}

describe("Telegram fixture helpers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("legacy unauthenticated fetch used");
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers the reply response listener before the submit click", async () => {
    const response = await sendReplyFromPanel(
      new ReplyPage() as unknown as Page,
      "conversation-1",
      "Hello from a manager"
    );

    expect(response.status()).toBe(200);
  });

  it("returns the reply endpoint's explicit error response instead of timing out", async () => {
    const response = await sendReplyFromPanel(
      new ReplyPage(404) as unknown as Page,
      "conversation-1",
      "Hello from a manager"
    );

    expect(response.status()).toBe(404);
  });

  it("returns the exact Telegram provider message ID from the reply response", async () => {
    const response = {
      status: () => 200,
      json: async () => ({
        success: true,
        message: {
          messageId: "502",
          text: "Unique manager reply [airi-e2e:123]",
          direction: "outbound",
          telegramMeta: { businessConnectionId: "business-1" },
        },
      }),
    } as PlaywrightResponse;

    await expect(
      verifyTelegramReplyResponse(
        response,
        "Unique manager reply [airi-e2e:123]",
        "business-1"
      )
    ).resolves.toBe("502");
  });

  it("rejects stale text, missing provider IDs, and the wrong transport metadata", async () => {
    const responseWith = (message: Record<string, unknown>) =>
      ({
        status: () => 200,
        json: async () => ({ success: true, message }),
      }) as PlaywrightResponse;

    await expect(
      verifyTelegramReplyResponse(
        responseWith({
          messageId: "502",
          text: "Unique manager reply from an older run",
          direction: "outbound",
          telegramMeta: { businessConnectionId: "business-1" },
        }),
        "Unique manager reply",
        "business-1"
      )
    ).rejects.toThrow(/exact reply text/i);

    await expect(
      verifyTelegramReplyResponse(
        responseWith({
          text: "Unique manager reply",
          direction: "outbound",
          telegramMeta: { businessConnectionId: "business-1" },
        }),
        "Unique manager reply",
        "business-1"
      )
    ).rejects.toThrow(/provider message id/i);

    await expect(
      verifyTelegramReplyResponse(
        responseWith({
          messageId: "502",
          text: "Unique manager reply",
          direction: "outbound",
          telegramMeta: { businessConnectionId: "foreign-business" },
        }),
        "Unique manager reply",
        null
      )
    ).rejects.toThrow(/business connection/i);
  });

  it("requires Mongo persistence to match exact text, provider ID, and transport", async () => {
    globalThis.fetch = jest.fn(async () =>
      Response.json({
        messages: [
          {
            messageId: "502",
            text: "Unique manager reply [airi-e2e:123]",
            direction: "outbound",
            telegramMeta: { businessConnectionId: "business-1" },
          },
        ],
      })
    ) as typeof fetch;

    await expect(
      verifyMessageInMongoDB(
        "conversation-1",
        "outbound",
        "Unique manager reply [airi-e2e:123]",
        "502",
        "business-1"
      )
    ).resolves.toBeUndefined();

    await expect(
      verifyMessageInMongoDB(
        "conversation-1",
        "outbound",
        "Unique manager reply",
        "502",
        "business-1"
      )
    ).rejects.toThrow(/exact text/i);

    await expect(
      verifyMessageInMongoDB(
        "conversation-1",
        "outbound",
        "Unique manager reply [airi-e2e:123]",
        "999",
        "business-1"
      )
    ).rejects.toThrow(/provider message id/i);
  });

  it("fails closed when the required business-connection fixture cannot be created", async () => {
    globalThis.fetch = jest.fn(async () =>
      Response.json(
        { error: "Fixture unavailable" },
        { status: 503, statusText: "Service Unavailable" }
      )
    ) as typeof fetch;

    await expect(setupTestBusinessConnection()).rejects.toThrow(
      /business connection.*503/i
    );
  });

  it("rejects a nominally successful setup response without fixture confirmation", async () => {
    globalThis.fetch = jest.fn(async () =>
      Response.json({ success: false }, { status: 200 })
    ) as typeof fetch;

    await expect(setupTestBusinessConnection()).rejects.toThrow(
      /business connection.*invalid response/i
    );
  });

  it("fails the owning test when conversation cleanup is not confirmed", async () => {
    globalThis.fetch = jest.fn(async () =>
      Response.json(
        { error: "Cleanup unavailable" },
        { status: 503, statusText: "Service Unavailable" }
      )
    ) as typeof fetch;

    await expect(cleanupTestData("conversation-1")).rejects.toThrow(
      /conversation.*503/i
    );

    globalThis.fetch = jest.fn(async () =>
      Response.json({ success: false }, { status: 200 })
    ) as typeof fetch;
    await expect(cleanupTestBusinessConnection()).rejects.toThrow(
      /business connection.*invalid response/i
    );
  });

  it("checks enabled coaching through the authenticated product endpoint", async () => {
    const { page, post } = coachingPage({ tips: [{ id: "tip-1" }] });

    await verifyCoachingAvailable(
      page,
      "conversation-1",
      "A sufficiently long manager draft"
    );

    expect(post).toHaveBeenCalledWith("/api/airi/coach", {
      data: {
        conversationId: "conversation-1",
        text: "A sufficiently long manager draft",
      },
    });
  });

  it("surfaces coaching endpoint and empty-tip failures", async () => {
    const unauthorized = coachingPage({ error: "Unauthorized" }, 401);
    await expect(
      verifyCoachingAvailable(
        unauthorized.page,
        "conversation-1",
        "Manager draft"
      )
    ).rejects.toThrow(/coaching.*401/i);

    const unavailable = coachingPage({
      tips: [],
      skipped: true,
      reason: "Coaching temporarily unavailable",
    });
    await expect(
      verifyCoachingAvailable(
        unavailable.page,
        "conversation-1",
        "Manager draft"
      )
    ).rejects.toThrow(/expected coaching tips.*temporarily unavailable/i);
  });

  it("accepts only the product's disabled-coaching response", async () => {
    const disabled = coachingPage({
      tips: [],
      skipped: true,
      reason: "Coaching disabled for this conversation",
    });

    await verifyCoachingDisabled(
      disabled.page,
      "conversation-1",
      "Manager draft"
    );

    const limitReached = coachingPage({
      tips: [],
      skipped: true,
      reason: "Coach session limit reached",
    });
    await expect(
      verifyCoachingDisabled(
        limitReached.page,
        "conversation-1",
        "Manager draft"
      )
    ).rejects.toThrow(/disabled-coaching response/i);
  });
});
