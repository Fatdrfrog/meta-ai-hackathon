/**
 * Meta Platforms 24-Hour Messaging Window - Server-only functions
 *
 * IMPORTANT: This file uses Mongoose and can only be imported in server-side code (API routes, Server Actions).
 * For client components, import from @/lib/messaging-window-utils instead.
 */

import { readDate } from "@icecore/shared/lib/value-utils";
import { Conversation } from "@/models/conversation";
import {
  META_MESSAGING_WINDOW_MS,
  type MessagingWindowInfo,
} from "./messaging-window-utils";

// Re-export client-safe utilities
export {
  formatWindowMessage,
  requiresMessagingWindow,
} from "./messaging-window-utils";

const NO_CUSTOMER_MESSAGE: MessagingWindowInfo = {
  isWithinWindow: false,
  hoursRemaining: 0,
  lastCustomerMessageAt: null,
};

function buildWindowInfo(
  lastCustomerMessageAt: Date | null
): MessagingWindowInfo {
  if (!lastCustomerMessageAt) return NO_CUSTOMER_MESSAGE;

  const elapsedMs = Date.now() - lastCustomerMessageAt.getTime();
  const hoursRemaining =
    Math.max(0, META_MESSAGING_WINDOW_MS - elapsedMs) / (1000 * 60 * 60);

  return {
    isWithinWindow: elapsedMs < META_MESSAGING_WINDOW_MS,
    hoursRemaining: Math.round(hoursRemaining * 10) / 10,
    lastCustomerMessageAt,
  };
}

/**
 * 24-hour window for a conversation, from its denormalized `last_inbound_at`
 * (set on every inbound message).
 */
export async function checkMessagingWindow(
  conversationId: string
): Promise<MessagingWindowInfo> {
  try {
    const conversation = await Conversation.findById(conversationId)
      .select("last_inbound_at")
      .lean<{ last_inbound_at?: unknown } | null>();
    return buildWindowInfo(readDate(conversation?.last_inbound_at));
  } catch {
    return NO_CUSTOMER_MESSAGE;
  }
}

export async function checkMessagingWindowForConversation(conversation: {
  _id?: unknown;
  last_inbound_at?: Date | string | null;
}): Promise<MessagingWindowInfo> {
  // A partial select can leave the field out; read it instead of guessing.
  if (conversation.last_inbound_at === undefined && conversation._id) {
    return checkMessagingWindow(String(conversation._id));
  }
  return buildWindowInfo(readDate(conversation.last_inbound_at));
}
