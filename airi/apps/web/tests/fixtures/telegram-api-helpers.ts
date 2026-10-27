import { test as base, expect, Page, Response } from "@playwright/test";

export { expect };
import {
  TEST_BUSINESS_CONNECTION,
  TEST_MANAGER,
  TEST_TELEGRAM_CHAT_ID,
  TEST_WORKSPACE,
} from "./telegram-test-data";

export const test = base.extend<{
  authenticatedPage: Page;
  testConversation: string | null;
}>({
  authenticatedPage: async ({ page }, use) => {
    await page.goto("/login");
    await page.fill('input[name="email"]', TEST_MANAGER.email);
    await page.fill('input[name="password"]', TEST_MANAGER.password);
    await page.click('button[type="submit"]');

    await page.waitForURL(/\/panel/);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },

  testConversation: async ({}, use) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(null);
  },
});

export interface ConversationSetupOptions {
  botEnabled: boolean;
  coachEnabled: boolean;
  businessConnectionId?: string;
}

function testApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.TEST_API_SECRET) {
    headers.Authorization = `Bearer ${process.env.TEST_API_SECRET}`;
  }
  return headers;
}

async function requireSuccessfulTestApiResponse(
  response: globalThis.Response,
  operation: string
): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `Failed to ${operation}: ${response.status} ${response.statusText}`.trim()
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    success?: unknown;
  } | null;
  if (payload?.success !== true) {
    throw new Error(`Failed to ${operation}: invalid response`);
  }
}

export async function setupTestConversation(
  options: ConversationSetupOptions
): Promise<string> {
  const { botEnabled, coachEnabled, businessConnectionId } = options;

  // Create conversation via test API
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/test/conversation`,
    {
      method: "POST",
      headers: testApiHeaders(),
      body: JSON.stringify({
        channel: "telegram",
        workspace_id: TEST_WORKSPACE.id,
        business_connection_id:
          businessConnectionId ||
          TEST_BUSINESS_CONNECTION.business_connection_id,
        chat_id: TEST_TELEGRAM_CHAT_ID,
        user_id: TEST_TELEGRAM_CHAT_ID,
        airi_bot_enabled: botEnabled,
        airi_coach_enabled: coachEnabled,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to create test conversation: ${response.statusText}`
    );
  }

  const data = await response.json();
  return data.conversationId;
}

/**
 * Navigate to conversation detail page and wait for it to load
 */
export async function navigateToConversation(
  page: Page,
  conversationId: string
): Promise<void> {
  await page.goto(
    `/panel/w/${TEST_WORKSPACE.id}/conversations/${conversationId}`
  );
  await page.waitForSelector('[data-testid="conversation-detail"]', {
    timeout: 10000,
  });
}

/**
 * Send a reply from the manager panel
 */
export async function sendReplyFromPanel(
  page: Page,
  conversationId: string,
  text: string
): Promise<Response> {
  await navigateToConversation(page, conversationId);

  // Find and fill the reply form
  const replyInput = page.locator('[data-testid="reply-input"]');
  await replyInput.fill(text);

  // Submit the reply
  const submitButton = page.locator('[data-testid="reply-submit"]');
  const replyResponse = page.waitForResponse(response =>
    response.url().includes(`/api/conversations/${conversationId}/reply`)
  );
  await submitButton.click();

  return replyResponse;
}

/**
 * Verify the causal result of Telegram's sendMessage call as returned by the
 * product reply endpoint. Telegram getUpdates is an inbound update feed, not
 * an outbound delivery ledger, so it cannot prove that this reply was sent.
 */
export async function verifyTelegramReplyResponse(
  response: Response,
  expectedText: string,
  expectedBusinessConnectionId: string | null
): Promise<string> {
  const status = response.status();
  const payload = (await response.json().catch(() => null)) as {
    success?: unknown;
    message?: {
      messageId?: unknown;
      text?: unknown;
      direction?: unknown;
      telegramMeta?: { businessConnectionId?: unknown } | null;
    };
  } | null;

  if (status !== 200 || payload?.success !== true || !payload.message) {
    throw new Error(`Telegram reply endpoint failed with status ${status}`);
  }

  const message = payload.message;
  if (message.text !== expectedText) {
    throw new Error(
      `Expected exact reply text "${expectedText}", got "${String(message.text)}"`
    );
  }
  if (message.direction !== "outbound") {
    throw new Error(
      `Expected outbound reply direction, got "${String(message.direction)}"`
    );
  }

  const providerMessageId =
    typeof message.messageId === "string" ||
    typeof message.messageId === "number"
      ? String(message.messageId).trim()
      : "";
  if (!providerMessageId) {
    throw new Error("Telegram reply response is missing a provider message ID");
  }

  const actualBusinessConnectionId = message.telegramMeta?.businessConnectionId;
  if (actualBusinessConnectionId !== expectedBusinessConnectionId) {
    throw new Error(
      `Expected Telegram business connection ${String(expectedBusinessConnectionId)}, got ${String(actualBusinessConnectionId)}`
    );
  }

  return providerMessageId;
}

/**
 * Verify message was persisted in MongoDB
 */
export async function verifyMessageInMongoDB(
  conversationId: string,
  expectedDirection: "inbound" | "outbound",
  expectedText?: string,
  expectedProviderMessageId?: string,
  expectedBusinessConnectionId?: string | null
): Promise<void> {
  // Query the conversation to get the latest message
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/conversations/${conversationId}`,
    {
      method: "GET",
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch conversation: ${response.statusText}`);
  }

  const data = await response.json();
  const messages = data.messages || [];
  const latestMessage = messages[messages.length - 1];

  if (!latestMessage) {
    throw new Error("No messages found in conversation");
  }

  if (latestMessage.direction !== expectedDirection) {
    throw new Error(
      `Expected direction ${expectedDirection}, got ${latestMessage.direction}`
    );
  }

  if (expectedText !== undefined && latestMessage.text !== expectedText) {
    throw new Error(
      `Expected exact text "${expectedText}", got "${latestMessage.text}"`
    );
  }

  if (
    expectedProviderMessageId !== undefined &&
    String(latestMessage.messageId) !== expectedProviderMessageId
  ) {
    throw new Error(
      `Expected provider message ID "${expectedProviderMessageId}", got "${String(latestMessage.messageId)}"`
    );
  }

  if (
    expectedBusinessConnectionId !== undefined &&
    latestMessage.telegramMeta?.businessConnectionId !==
      expectedBusinessConnectionId
  ) {
    throw new Error(
      `Expected Telegram business connection ${String(expectedBusinessConnectionId)}, got ${String(latestMessage.telegramMeta?.businessConnectionId)}`
    );
  }
}

interface CoachingResponse {
  tips: unknown[];
  skipped: boolean;
  reason?: string;
}

async function requestCoaching(
  page: Page,
  conversationId: string,
  text: string
): Promise<CoachingResponse> {
  // page.request shares the authenticated browser context's cookies.
  const response = await page.request.post("/api/airi/coach", {
    data: { conversationId, text },
  });

  if (!response.ok()) {
    throw new Error(
      `Failed to request coaching for conversation ${conversationId}: ${response.status()}`
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (!Array.isArray(data.tips)) {
    throw new Error(
      `Invalid coaching response for conversation ${conversationId}: tips must be an array`
    );
  }

  return {
    tips: data.tips,
    skipped: data.skipped === true,
    reason: typeof data.reason === "string" ? data.reason : undefined,
  };
}

export async function verifyCoachingAvailable(
  page: Page,
  conversationId: string,
  text: string
): Promise<void> {
  const coaching = await requestCoaching(page, conversationId, text);
  if (coaching.tips.length === 0) {
    const reason = coaching.reason ? `: ${coaching.reason}` : "";
    throw new Error(
      `Expected coaching tips for conversation ${conversationId}${reason}`
    );
  }
}

export async function verifyCoachingDisabled(
  page: Page,
  conversationId: string,
  text: string
): Promise<void> {
  const coaching = await requestCoaching(page, conversationId, text);
  if (
    coaching.tips.length > 0 ||
    !coaching.skipped ||
    coaching.reason !== "Coaching disabled for this conversation"
  ) {
    throw new Error(
      `Expected disabled-coaching response for conversation ${conversationId}, received ${coaching.reason || "coaching tips"}`
    );
  }
}

/**
 * Clean up test data after tests
 */
export async function cleanupTestData(conversationId: string): Promise<void> {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/test/conversation`,
    {
      method: "DELETE",
      headers: testApiHeaders(),
      body: JSON.stringify({ conversationId }),
    }
  );
  await requireSuccessfulTestApiResponse(
    response,
    "clean up test conversation"
  );
}

type TestBusinessConnectionFixture = {
  businessConnectionId?: string;
  telegramUserId?: number;
  workspaceId?: string;
  canReply?: boolean;
};

export async function setupTestBusinessConnection(
  fixture: TestBusinessConnectionFixture = {}
): Promise<void> {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/test/setup-business-connection`,
    {
      method: "POST",
      headers: testApiHeaders(),
      body: JSON.stringify({
        business_connection_id:
          fixture.businessConnectionId ||
          TEST_BUSINESS_CONNECTION.business_connection_id,
        telegram_user_id:
          fixture.telegramUserId ?? TEST_BUSINESS_CONNECTION.telegram_user_id,
        workspace_id: fixture.workspaceId || TEST_WORKSPACE.id,
        can_reply: fixture.canReply ?? true,
      }),
    }
  );

  await requireSuccessfulTestApiResponse(
    response,
    "set up Telegram business connection"
  );
}

/**
 * Clean up test business connection
 */
export async function cleanupTestBusinessConnection(
  businessConnectionId = TEST_BUSINESS_CONNECTION.business_connection_id
): Promise<void> {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/test/cleanup-business-connection`,
    {
      method: "DELETE",
      headers: testApiHeaders(),
      body: JSON.stringify({
        business_connection_id: businessConnectionId,
      }),
    }
  );
  await requireSuccessfulTestApiResponse(
    response,
    "clean up Telegram business connection"
  );
}
