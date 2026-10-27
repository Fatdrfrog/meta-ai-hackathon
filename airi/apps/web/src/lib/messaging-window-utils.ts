/**
 * Meta Platforms Messaging Window - Client-safe utilities
 * Pure constants and helpers with no server dependencies
 */

/**
 * Meta platforms that require 24-hour messaging window
 */
const META_PLATFORMS = ["whatsapp", "instagram"] as const;
type MetaPlatform = (typeof META_PLATFORMS)[number];
export const META_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessagingWindowInfo = {
  isWithinWindow: boolean;
  hoursRemaining: number;
  lastCustomerMessageAt: Date | null;
};

/**
 * Check if a channel requires messaging window restrictions
 * @param channel - The channel to check
 * @returns true if channel is a Meta platform (WhatsApp, Instagram)
 */
export function requiresMessagingWindow(channel: string): boolean {
  return META_PLATFORMS.includes(channel as MetaPlatform);
}

/**
 * Format a user-friendly message about the messaging window status
 */
export function formatWindowMessage(
  windowInfo: MessagingWindowInfo,
  channel?: string | null
): string {
  if (!windowInfo.lastCustomerMessageAt) {
    return "Customer must send a message first before you can reply.";
  }

  if (!windowInfo.isWithinWindow) {
    // Instagram has no message templates to fall back on.
    return channel === "instagram"
      ? "24-hour messaging window expired. Wait for the customer to message you again."
      : `24-hour messaging window expired. You can only send approved template messages or wait for the customer to message you again.`;
  }

  if (windowInfo.hoursRemaining < 1) {
    const minutesRemaining = Math.round(windowInfo.hoursRemaining * 60);
    return `${minutesRemaining} minutes remaining to send free-form messages.`;
  }

  return `${windowInfo.hoursRemaining} hours remaining to send free-form messages.`;
}
