/** The generated chat title, written after the answer is saved. */

import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { buildAiriChatTitle } from "./persistence";

export function cleanGeneratedAiriChatTitle(value: unknown): string {
  const cleaned = String(value ?? "")
    // Drop a markdown heading marker or an echoed "Title:" label.
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^[\s*]*title[\s*]*:[\s*]*/i, "")
    .replace(/^[\s"'`*]+|[\s"'`*]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}

export function generateAiriChatTitle(
  params: Parameters<typeof generateAiriChatTitleInAction>[0]
): ReturnType<typeof generateAiriChatTitleInAction> {
  return withWorkspaceTextAiAction(
    {
      workspaceId: params.workspaceId,
      actionId: "airi-chat-title:" + params.threadId,
    },
    () => generateAiriChatTitleInAction(params)
  );
}

export async function generateAiriChatTitleInAction(params: {
  workspaceId: string;
  threadId: string;
  userMessage: string;
  assistantMessage: string;
  signal?: AbortSignal;
}): Promise<string> {
  const fallbackTitle = buildAiriChatTitle(params.userMessage);
  if (params.signal?.aborted) return fallbackTitle;

  try {
    const response = await chatCompletionWithFallback({
      signal: params.signal,
      model: getLightTextModel(),
      messages: [
        {
          role: "user",
          content: [
            "Create a short title for this Airi chat.",
            "Rules:",
            "- 2 to 6 words.",
            "- No quotes.",
            "- No punctuation unless essential.",
            "- Use the user's language when obvious.",
            "- Reply with the title text only, no markdown.",
            "",
            `User: ${params.userMessage}`,
            `Airi: ${params.assistantMessage.slice(0, 800)}`,
            "",
            "Title:",
          ].join("\n"),
        },
      ],
      temperature: 0.2,
      analytics: {
        workspaceId: params.workspaceId,
        conversationId: params.threadId,
        traceId: ["airi_chat_title", params.workspaceId, params.threadId].join(
          ":"
        ),
        operation: "airi_chat.title",
        sourceService: "web.airi_chat",
        inputText: params.userMessage,
      },
    });
    return cleanGeneratedAiriChatTitle(response.content) || fallbackTitle;
  } catch {
    return fallbackTitle;
  }
}
