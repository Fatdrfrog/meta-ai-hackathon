/**
 * Telegram Business Integration E2E Tests
 * Tests manager reply functionality from Airi.chat panel
 */

import { randomUUID } from "node:crypto";
import {
  cleanupTestBusinessConnection,
  cleanupTestData,
  expect,
  sendReplyFromPanel,
  setupTestBusinessConnection,
  setupTestConversation,
  test,
  verifyCoachingAvailable,
  verifyCoachingDisabled,
  verifyMessageInMongoDB,
  verifyTelegramReplyResponse,
} from "../fixtures/telegram-api-helpers";
import {
  TEST_BUSINESS_CONNECTION,
  TEST_MESSAGES,
  TEST_WORKSPACE,
} from "../fixtures/telegram-test-data";

function uniqueTelegramReply(baseText: string): string {
  return `${baseText} [airi-e2e:${randomUUID()}]`;
}

test.describe("Telegram Business - Manager Reply from Panel", () => {
  let conversationId: string;

  test.afterEach(async ({}) => {
    if (conversationId) {
      await cleanupTestData(conversationId);
      conversationId = "";
    }
  });

  test.describe("Bot ON + Coach ON", () => {
    test("should send manager reply with business connection while coaching is available", async ({
      authenticatedPage,
    }) => {
      const replyText = uniqueTelegramReply(TEST_MESSAGES.managerReply);
      // Setup conversation with bot enabled and coach enabled
      conversationId = await setupTestConversation({
        botEnabled: true,
        coachEnabled: true,
      });

      // Send reply from panel
      const response = await sendReplyFromPanel(
        authenticatedPage,
        conversationId,
        replyText
      );

      // The reply response contains the provider message ID returned by
      // Telegram and the effective business connection used for this send.
      const providerMessageId = await verifyTelegramReplyResponse(
        response,
        replyText,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      // Verify the exact provider result was persisted in MongoDB.
      await verifyMessageInMongoDB(
        conversationId,
        "outbound",
        replyText,
        providerMessageId,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      // Verify coaching is available through the same API used while typing.
      await verifyCoachingAvailable(
        authenticatedPage,
        conversationId,
        replyText
      );
    });
  });

  test.describe("Bot ON + Coach OFF", () => {
    test("should send manager reply with business connection while coaching is disabled", async ({
      authenticatedPage,
    }) => {
      const replyText = uniqueTelegramReply(TEST_MESSAGES.managerReply);
      // Setup conversation with bot enabled but coach disabled
      conversationId = await setupTestConversation({
        botEnabled: true,
        coachEnabled: false,
      });

      // Send reply from panel
      const response = await sendReplyFromPanel(
        authenticatedPage,
        conversationId,
        replyText
      );

      const providerMessageId = await verifyTelegramReplyResponse(
        response,
        replyText,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      await verifyMessageInMongoDB(
        conversationId,
        "outbound",
        replyText,
        providerMessageId,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      // Verify the product reports that coaching is disabled.
      await verifyCoachingDisabled(
        authenticatedPage,
        conversationId,
        replyText
      );
    });
  });

  test.describe("Bot OFF + Coach ON", () => {
    test("should send a manager reply while coaching remains available when the bot is off", async ({
      authenticatedPage,
    }) => {
      const replyText = uniqueTelegramReply(TEST_MESSAGES.managerReply);
      // Setup conversation with bot disabled but coach enabled
      conversationId = await setupTestConversation({
        botEnabled: false,
        coachEnabled: true,
      });

      // Send reply from panel
      const response = await sendReplyFromPanel(
        authenticatedPage,
        conversationId,
        replyText
      );

      const providerMessageId = await verifyTelegramReplyResponse(
        response,
        replyText,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      await verifyMessageInMongoDB(
        conversationId,
        "outbound",
        replyText,
        providerMessageId,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      // Verify coaching is available even though bot replies are disabled.
      await verifyCoachingAvailable(
        authenticatedPage,
        conversationId,
        replyText
      );
    });
  });

  test.describe("Bot OFF + Coach OFF", () => {
    test("should send a manager reply while coaching is disabled when the bot is off", async ({
      authenticatedPage,
    }) => {
      const replyText = uniqueTelegramReply(TEST_MESSAGES.managerReply);
      // Setup conversation with both bot and coach disabled
      conversationId = await setupTestConversation({
        botEnabled: false,
        coachEnabled: false,
      });

      // Send reply from panel
      const response = await sendReplyFromPanel(
        authenticatedPage,
        conversationId,
        replyText
      );

      const providerMessageId = await verifyTelegramReplyResponse(
        response,
        replyText,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      await verifyMessageInMongoDB(
        conversationId,
        "outbound",
        replyText,
        providerMessageId,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      // Verify the product reports that coaching is disabled.
      await verifyCoachingDisabled(
        authenticatedPage,
        conversationId,
        replyText
      );
    });
  });

  test.describe("Edge Cases", () => {
    test("falls back to regular bot delivery for an unregistered business connection", async ({
      authenticatedPage,
    }) => {
      const replyText = uniqueTelegramReply(TEST_MESSAGES.managerReply);
      // Setup conversation with invalid business connection
      conversationId = await setupTestConversation({
        botEnabled: true,
        coachEnabled: true,
        businessConnectionId: "invalid-business-connection-id",
      });

      // Send reply from panel - should trigger fallback logic
      const response = await sendReplyFromPanel(
        authenticatedPage,
        conversationId,
        replyText
      );

      const providerMessageId = await verifyTelegramReplyResponse(
        response,
        replyText,
        null
      );
      await verifyMessageInMongoDB(
        conversationId,
        "outbound",
        replyText,
        providerMessageId,
        null
      );
    });

    test("does not use a business connection owned by another workspace", async ({
      authenticatedPage,
    }) => {
      const foreignBusinessConnectionId = "other-workspace-business-connection";
      const replyText = uniqueTelegramReply(TEST_MESSAGES.managerReply);
      await setupTestBusinessConnection({
        businessConnectionId: foreignBusinessConnectionId,
        telegramUserId: TEST_BUSINESS_CONNECTION.telegram_user_id + 1,
        workspaceId: "other-workspace",
      });

      try {
        conversationId = await setupTestConversation({
          botEnabled: true,
          coachEnabled: true,
          businessConnectionId: foreignBusinessConnectionId,
        });

        const response = await sendReplyFromPanel(
          authenticatedPage,
          conversationId,
          replyText
        );
        // A null effective connection proves the foreign workspace's
        // connection was rejected before the provider send.
        const providerMessageId = await verifyTelegramReplyResponse(
          response,
          replyText,
          null
        );
        await verifyMessageInMongoDB(
          conversationId,
          "outbound",
          replyText,
          providerMessageId,
          null
        );
      } finally {
        await cleanupTestBusinessConnection(foreignBusinessConnectionId);
      }
    });

    test("should handle long manager messages correctly", async ({
      authenticatedPage,
    }) => {
      const replyText = uniqueTelegramReply(TEST_MESSAGES.longManagerReply);
      // Setup conversation
      conversationId = await setupTestConversation({
        botEnabled: true,
        coachEnabled: true,
      });

      // Send long reply from panel
      const response = await sendReplyFromPanel(
        authenticatedPage,
        conversationId,
        replyText
      );

      const providerMessageId = await verifyTelegramReplyResponse(
        response,
        replyText,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      await verifyMessageInMongoDB(
        conversationId,
        "outbound",
        replyText,
        providerMessageId,
        TEST_BUSINESS_CONNECTION.business_connection_id
      );

      // Verify coaching remains available for a long draft.
      await verifyCoachingAvailable(
        authenticatedPage,
        conversationId,
        replyText
      );
    });
  });
});

test.describe("Telegram Business - Error Handling", () => {
  test("returns an explicit not-found response for a missing conversation", async ({
    authenticatedPage,
  }) => {
    const response = await authenticatedPage.request.post(
      "/api/conversations/000000000000000000000000/reply",
      {
        data: {
          text: uniqueTelegramReply(TEST_MESSAGES.managerReply),
        },
      }
    );

    expect(response.status()).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Conversation not found",
    });
  });

  test("should validate message content", async ({ authenticatedPage }) => {
    const validationConversationId = await setupTestConversation({
      botEnabled: true,
      coachEnabled: true,
    });

    try {
      // Test empty message
      await authenticatedPage.goto(
        `/panel/w/${TEST_WORKSPACE.id}/conversations/${validationConversationId}`
      );
      const submitButton = authenticatedPage.locator(
        '[data-testid="reply-submit"]'
      );
      await submitButton.click();

      // Should show validation error
      await expect(
        authenticatedPage.locator('[data-testid="error-message"]')
      ).toBeVisible();
    } finally {
      await cleanupTestData(validationConversationId);
    }
  });
});
