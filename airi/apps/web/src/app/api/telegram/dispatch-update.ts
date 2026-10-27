import type { TelegramMessage, TelegramUpdate } from "@/types/telegram";
import type { SourceContext } from "@icecore/shared/types/sources";
import { handleBusinessConnectionUpdate } from "./handleBusinessConnectionUpdate";
import { handleCallbackQuery } from "./handleCallbackQuery";
import { handleMessage } from "./handleMessage";

/**
 * Dispatches a Telegram update after route-specific authentication has run.
 * Both legacy and source-scoped webhook routes use this same provider update
 * contract; only their authentication and source-context resolution differ.
 */
export async function dispatchTelegramUpdate(
  update: TelegramUpdate,
  options: {
    sourceId: string;
    sourceContext?: SourceContext;
  }
): Promise<Record<string, unknown>> {
  const { sourceId, sourceContext } = options;

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, sourceContext);
  } else if (update.business_connection) {
    await handleBusinessConnectionUpdate(
      update.business_connection,
      sourceId,
      sourceContext?.botToken
    );
  } else if (update.message) {
    await handleMessage(update.message, sourceContext);
  } else if (update.business_message || update.edited_business_message) {
    const message = update.business_message || update.edited_business_message;
    if (message) {
      const businessMessage: TelegramMessage = {
        ...message,
        business_connection_id: message.business_connection_id,
      };
      await handleMessage(businessMessage, sourceContext);
    }
  } else if (update.deleted_business_messages) {
    // Metadata-only event.
  } else if (update.my_chat_member) {
    const { handleChatMemberUpdate } = await import("./handleChatMemberUpdate");
    await handleChatMemberUpdate(update.my_chat_member, sourceContext);
  } else if (update.edited_message) {
    await handleMessage(update.edited_message, sourceContext);
  } else {
    const updateType = Object.keys(update).find(key => key !== "update_id");
    return { ok: true, skipped: updateType || "unknown" };
  }

  return { ok: true };
}
