/** general_answer: one grounded, streamed answer. */

import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { buildBoundedAiriChatPrompt } from "@/lib/airi-chats/prompt-budget";
import { getAiriResponseLanguageInstruction } from "@/lib/airi/shared/language-policy";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type { GeneratedAiriChatReply, AiriTurnContext } from "../types";
import {
  stageEvent,
  createAssistantDeltaStream,
  buildModelRunEvent,
} from "../progress";
import { WORKSPACE_CONTEXT_UNAVAILABLE_TEXT } from "../retrieval";
import { buildAttachedFilePromptSections } from "../context";
import { AIRI_TURN_DEFAULT_STEP_TIMEOUT_MS } from "../deadline";

/** The general_answer step of the turn. */
export async function handleGeneralAnswerTurn(
  context: AiriTurnContext
): Promise<GeneratedAiriChatReply> {
  const {
    params,
    deadline,
    startedAt,
    progress,
    attachedFiles,
    airiLanguage,
    selectedContext,
    workspaceRetrieval,
    searchResult,
    sourceContext,
    selectedSourceLabels,
    resourceItems,
    pendingActions,
    traceId,
    historyContext,
    kbContext,
    conversationContext,
    attachedSourceContext,
    recoverFromGeneratorFailure,
  } = context;

  const prompt = buildBoundedAiriChatPrompt({
    header: `You are Airi, a workspace assistant for WhatsApp campaigns, customer chats, knowledge, analytics, and creative planning.\n\nLANGUAGE REQUIREMENT: ${getAiriResponseLanguageInstruction(airiLanguage)}`,
    stableSections: [
      {
        label: "ATTACHED SOURCES",
        content:
          selectedContext && selectedContext.promptSections.length > 0
            ? [
                `The user attached these sources:\n${selectedContext.selectedSourceLabels.map(label => `- ${label}`).join("\n")}`,
                ...selectedContext.promptSections,
              ]
            : attachedSourceContext,
      },
      {
        label: "ATTACHED FILES",
        content: buildAttachedFilePromptSections(attachedFiles),
      },
      {
        label: "WORKSPACE KNOWLEDGE",
        content:
          kbContext ||
          (workspaceRetrieval.unavailable
            ? WORKSPACE_CONTEXT_UNAVAILABLE_TEXT
            : "No relevant KB articles found."),
      },
      {
        label: "RECENT CUSTOMER CONTEXT",
        content:
          conversationContext ||
          (workspaceRetrieval.unavailable
            ? WORKSPACE_CONTEXT_UNAVAILABLE_TEXT
            : "No relevant conversations found."),
      },
    ],
    history: historyContext,
    userMessage: params.userMessage,
    instructions: `- Answer directly and concisely.
- Use only WORKSPACE KNOWLEDGE, RECENT CUSTOMER CONTEXT, attached sources, and this thread. These belong to this tenant. Do not use airi.chat product documentation, public internet knowledge, or guesses as this company's policies, prices, or processes.
${
  workspaceRetrieval.unavailable
    ? "- Workspace knowledge and customer context could not be loaded in time for this answer. Do not claim the workspace has no knowledge base articles or conversations, and do not invent an answer. Use attached sources and this thread when they cover the request; otherwise say the workspace search did not finish and suggest trying again in a moment."
    : "- If workspace knowledge and recent customer context are empty, say this workspace has no matching knowledge base articles or customer conversations. Do not invent an answer. Suggest adding a knowledge base article or connecting a channel so the next answer can be grounded."
}
- Attached sources indicate what the user wants to work with; they do not disable automatic workspace context.
- If an attached source does not contain enough information, say that clearly, then use relevant workspace context when it helps.
- If a WhatsApp connector is selected and the user asks for a template or flow, draft the exact template or flow spec and ask them to review before creating it.
- If the user asks to generate assets, create scenarios, or plan Instagram content, explain what you would prepare next and ask for the missing details; do not claim that an asset or scenario was created.
- If context is insufficient, say what is missing and propose the next best action.`,
  });

  let response: Awaited<ReturnType<typeof chatCompletionWithFallback>>;
  const answerStream = createAssistantDeltaStream({
    threadId: params.threadId,
    progress,
  });
  try {
    await progress.emit(
      stageEvent("generation", "Generating answer", "running")
    );
    response = await chatCompletionWithFallback({
      ...(answerStream.onDelta ? { onDelta: answerStream.onDelta } : {}),
      signal: params.signal,
      model: getHeavyTextModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      resilience: {
        maxRetries: 2,
        initialRetryDelayMs: 300,
        maxRetryDelayMs: 2_000,
        timeoutMs: deadline.stepTimeoutMs(AIRI_TURN_DEFAULT_STEP_TIMEOUT_MS),
      },
      analytics: {
        workspaceId: params.workspaceId,
        conversationId: params.threadId,
        messageId: params.userMessageId || null,
        traceId,
        operation: "airi_chat.reply",
        sourceService: "web.airi_chat",
        inputText: params.userMessage,
        metadata: {
          kbArticlesFound: searchResult.kbArticles.length,
          conversationsFound: searchResult.conversations.length,
          retrievalContextCount: sourceContext.sourceIds.length,
          sourceIds: sourceContext.sourceIds,
          selectedSources: selectedContext?.selectedSources ?? [],
          pendingActions,
        },
      },
      onLifecycle: async event => {
        await progress.emit(buildModelRunEvent(event));
      },
    }).finally(answerStream.stop);
    await progress.emit(
      stageEvent("generation", "Generating answer", "complete")
    );
  } catch (error) {
    return recoverFromGeneratorFailure(error, {
      id: "generation",
      label: "Generating answer",
    });
  }

  const receipt: AiriChatResourceReceipt = {
    selectedSources: selectedContext?.selectedSources ?? [],
    selectedSourceLabels,
    resources: resourceItems,
    sourceIds: sourceContext.sourceIds,
    retrievalPath: sourceContext.retrievalPath,
    provider: response.provider,
    model: response.model,
    durationMs: Date.now() - startedAt,
  };

  return {
    content: response.content || "No answer generated.",
    metadata: {
      provider: response.provider,
      model: response.model,
      usage: response.usage ?? null,
      kbArticlesFound: searchResult.kbArticles.length,
      conversationsFound: searchResult.conversations.length,
      retrievalContextCount: sourceContext.sourceIds.length,
      sourceIds: sourceContext.sourceIds,
      selectedSources: selectedContext?.selectedSources ?? [],
      selectedSourceLabels: selectedContext?.selectedSourceLabels ?? [],
      pendingActions,
      traceId,
      resourceReceipt: receipt,
      thinkingTrace: {
        stages: progress.stages,
        resources: resourceItems,
      },
    },
    analytics: {
      traceId,
      durationMs: Date.now() - startedAt,
      generationLatencyMs: response.latencyMs ?? null,
      generationModel: response.model ?? null,
      ...sourceContext,
    },
  };
}
