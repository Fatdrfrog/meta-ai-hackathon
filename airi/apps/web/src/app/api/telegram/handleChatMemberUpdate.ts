import { supabaseAdmin } from "@/lib/supabase/admin";
import * as telegramApi from "@/lib/telegram";
import Chat from "@/models/chat";
import type { TelegramChatMemberUpdated } from "@/types/telegram";
import type { SourceContext } from "@icecore/shared/types/sources";
import { getTelegramChatId, safeParseChatId } from "./helpers";

/**
 * Handles my_chat_member updates - triggered when bot is added/removed from chats
 *
 * This function:
 * 1. Detects when bot is added to a group/chat
 * 2. If sourceId is known from context, automatically links chat to source
 * 3. If sourceId is unknown, prompts user to use /link_chat command
 */
export async function handleChatMemberUpdate(
  update: TelegramChatMemberUpdated,
  sourceContext?: SourceContext
): Promise<void> {
  const { chat, from, new_chat_member, old_chat_member } = update;
  const isGroupChat = chat.type === "group" || chat.type === "supergroup";

  // Only process when bot status changes to "member" or "administrator"
  const wasMember =
    old_chat_member.status === "member" ||
    old_chat_member.status === "administrator";
  const isNowMember =
    new_chat_member.status === "member" ||
    new_chat_member.status === "administrator";

  // Bot was just added to the chat
  if (!wasMember && isNowMember) {
    const chatId = chat.id.toString();
    const chatNumericId = safeParseChatId(chat.id);
    let groupPrivacyNotice: string | undefined;

    if (isGroupChat && sourceContext?.botToken) {
      try {
        const botInfo = await telegramApi.getMe(sourceContext.botToken);
        if (botInfo.can_read_all_group_messages !== true) {
          groupPrivacyNotice =
            "Important: this bot is in Telegram privacy mode. Telegram only sends commands/replies/mentions in groups. To capture all group messages, open @BotFather -> /setprivacy -> Disable, then remove and add the bot again.";
        }
      } catch (error) {
        console.warn(
          "[handleChatMemberUpdate] Failed to check bot group read settings:",
          error
        );
      }
    }

    // Ensure chat document exists
    if (chatNumericId !== null && sourceContext?.sourceId) {
      const compositeId = getTelegramChatId(
        chatNumericId,
        sourceContext.sourceId
      );
      await Chat.findOneAndUpdate(
        { _id: compositeId },
        {
          $setOnInsert: {
            type: chat.type,
            title: chat.title,
            sourceId: sourceContext.sourceId,
            workspaceId: sourceContext.workspaceId,
          },
          $addToSet: { participants: from.id },
        },
        { upsert: true, new: true }
      );
    }

    // If we have sourceId from context, auto-link the chat
    if (sourceContext?.sourceId && sourceContext?.workspaceId) {
      try {
        // Verify source exists and is valid
        // We filter by type: "telegram" in the query, so we know it's a Telegram source
        const { data: source, error } = await supabaseAdmin
          .from("sources")
          .select("id, workspace_id, type, companies(name)")
          .eq("id", sourceContext.sourceId)
          .eq("type", "telegram")
          .maybeSingle<{
            id: string;
            workspace_id: string;
            type: string;
            companies?: { name?: string } | Array<{ name?: string }> | null;
          }>();

        if (
          !error &&
          source &&
          source.type === "telegram" &&
          source.workspace_id
        ) {
          // Link chat to source
          if (chatNumericId !== null) {
            const compositeId = getTelegramChatId(chatNumericId, source.id);
            await Chat.findOneAndUpdate(
              { _id: compositeId },
              {
                $set: {
                  sourceId: source.id,
                  workspaceId: source.workspace_id,
                },
                $addToSet: { participants: from.id },
              },
              { upsert: true, new: true }
            );
          }

          // Send confirmation message
          const companies = source.companies;
          const companyName = companies
            ? Array.isArray(companies)
              ? companies[0]?.name
              : companies.name
            : undefined;
          const displayName = companyName || "your company";

          const welcomeMessage = isGroupChat
            ? `✅ Bot added to group!\n\nThis group has been automatically linked to "${displayName}". I will start analyzing messages from now.`
            : `✅ Chat linked!\n\nThis chat has been automatically linked to "${displayName}". I will start analyzing messages from now.`;

          const finalWelcomeMessage =
            isGroupChat && groupPrivacyNotice
              ? `${welcomeMessage}\n\n${groupPrivacyNotice}`
              : welcomeMessage;

          await telegramApi.sendTelegramMessage(chatId, finalWelcomeMessage, {
            botToken: sourceContext.botToken,
          });
          return;
        }
      } catch (error) {
        console.error(
          "[handleChatMemberUpdate] Error auto-linking chat:",
          error
        );
        // Fall through to prompt user
      }
    }

    // If sourceId is not available, prompt user to link manually
    const promptMessage = isGroupChat
      ? `👋 Hello! I'm the Airi.chat bot.\n\nTo start analyzing messages in this group, please link it to your workspace using:\n\n/start <source-key>\n\n(alias: /link_chat <source-key>)\n\nFind your source key in:\nairi.chat Dashboard → Settings → Integrations → Telegram`
      : `👋 Hello! I'm the Airi.chat bot.\n\nTo start analyzing messages, please link this chat to your workspace using:\n\n/start <source-key>\n\n(alias: /link_chat <source-key>)\n\nFind your source key in:\nairi.chat Dashboard → Settings → Integrations → Telegram`;

    const finalPromptMessage =
      isGroupChat && groupPrivacyNotice
        ? `${promptMessage}\n\n${groupPrivacyNotice}`
        : promptMessage;

    await telegramApi.sendTelegramMessage(chatId, finalPromptMessage, {
      botToken: sourceContext?.botToken,
    });
  }

  // Bot was removed from chat (optional: cleanup if needed)
  if (wasMember && !isNowMember) {
    // Optionally log or handle bot removal
    console.log(
      `[handleChatMemberUpdate] Bot removed from chat ${chat.id} by user ${from.id}`
    );
  }
}
