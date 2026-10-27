/**
 * Test fixtures for Telegram Business integration tests
 */

export interface TestWorkspace {
  id: string;
  name: string;
  source_key: string;
}

export interface TestBusinessConnection {
  business_connection_id: string;
  telegram_user_id: number;
  workspace_id: string;
  can_reply: boolean;
}

export interface TestManager {
  email: string;
  password: string;
  user_id: string;
  name: string;
  workspace_id: string;
}

export interface TestConversationTemplate {
  channel: "telegram";
  workspace_id: string;
  business_connection_id: string;
  chat_id: string;
  user_id: string;
  airi_bot_enabled: boolean;
  airi_coach_enabled: boolean;
}

// Test data fixtures
export const TEST_WORKSPACE: TestWorkspace = {
  id: process.env.TEST_WORKSPACE_ID || "test-workspace-123",
  name: "Test Workspace for Telegram E2E",
  source_key: "test-telegram-source-key",
};

export const TEST_BUSINESS_CONNECTION: TestBusinessConnection = {
  business_connection_id:
    process.env.TELEGRAM_TEST_BUSINESS_CONNECTION_ID ||
    "test-business-connection-123",
  telegram_user_id: parseInt(process.env.TELEGRAM_TEST_USER_ID || "123456789"),
  workspace_id: TEST_WORKSPACE.id,
  can_reply: true,
};

export const TEST_MANAGER: TestManager = {
  email: process.env.TEST_MANAGER_EMAIL || "test-manager@example.com",
  password: process.env.TEST_MANAGER_PASSWORD || "test-password-123",
  user_id: "test-manager-user-id",
  name: "Test Manager",
  workspace_id: TEST_WORKSPACE.id,
};

export const TEST_TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_TEST_CHAT_ID || "987654321";

export const TEST_CONVERSATION_TEMPLATE: TestConversationTemplate = {
  channel: "telegram",
  workspace_id: TEST_WORKSPACE.id,
  business_connection_id: TEST_BUSINESS_CONNECTION.business_connection_id,
  chat_id: TEST_TELEGRAM_CHAT_ID,
  user_id: TEST_TELEGRAM_CHAT_ID, // For business conversations, user_id = chat_id
  airi_bot_enabled: true,
  airi_coach_enabled: true,
};

// Test message templates
export const TEST_MESSAGES = {
  customerMessage: "Hello, I need help with my order",
  managerReply:
    "Hi! I can help you with that. What order number are you referring to?",
  longManagerReply:
    "Thank you for reaching out. I understand you need assistance with your order. To provide you with the best support, could you please provide me with your order number and describe the specific issue you're experiencing?",
};

// Environment validation
export function validateTestEnvironment(): void {
  const required = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_TEST_CHAT_ID",
    "TEST_WORKSPACE_ID",
    "TEST_MANAGER_EMAIL",
    "TEST_MANAGER_PASSWORD",
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

// Helper to create test conversation with specific bot/coach settings
export function createTestConversationConfig(
  botEnabled: boolean,
  coachEnabled: boolean
): TestConversationTemplate {
  return {
    ...TEST_CONVERSATION_TEMPLATE,
    airi_bot_enabled: botEnabled,
    airi_coach_enabled: coachEnabled,
  };
}
