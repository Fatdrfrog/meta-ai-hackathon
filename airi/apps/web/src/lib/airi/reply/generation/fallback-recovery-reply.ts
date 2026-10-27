import {
  chatCompletionWithFallback,
  getDefaultAIChatProviderOrder,
  getHeavyTextModel,
} from "@/lib/ai";
import { createInferenceDeadline } from "@/lib/ai/inference-deadline";
import type { WorkspaceAgentPersona } from "@/lib/airi/agent-context";
import { getLanguageName } from "@/lib/airi/language-detector";
import {
  isInterruptedFinishReason,
  isLikelyIncompleteAssistantReply,
  shouldPreferRetriedAssistantReply,
} from "@/lib/airi/reply/generation/reply-completeness";
import type { FallbackRecoveryContext } from "@/lib/airi/reply/generation/reply-fallback-policy";
import { finalizeReplyText } from "@/lib/airi/reply/generation/reply-finalize";
import { resolveChannelContextForPrompt } from "@/lib/airi/reply/prompting/channel-prompt";
import { formatPersonaPromptLines } from "@/lib/airi/reply/prompting/persona-prompt";
import type { ChannelInstructions } from "@/lib/airi/workspace-bot-contract";
import { previewText, traceableChain } from "@/lib/observability/tracing";

export type FallbackRecoveryReplyType =
  | "grounded_recovery"
  | "missing_knowledge"
  | "generic_clarification";

export type FallbackRecoveryReplyParams = {
  type: FallbackRecoveryReplyType;
  language: string;
  channel?: string;
  alreadyGreetedToday?: boolean;
  persona?: WorkspaceAgentPersona;
  channelInstructions?: ChannelInstructions;
  recoveryContext?: FallbackRecoveryContext;
  timeoutMs?: number;
};

export type FallbackRecoveryReplyResult = {
  reply: string;
  finishReason: string | null;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  isIncomplete: boolean;
};

function buildSystemPromptForFallbackRecovery(
  params: FallbackRecoveryReplyParams
): string {
  const languageName = getLanguageName(params.language);
  const personaLines = formatPersonaPromptLines(params.persona);
  const personaBlock = personaLines.join("\n\n");
  const channelHint = resolveChannelContextForPrompt(
    params.channel,
    params.channelInstructions
  );
  const identity =
    personaLines.length > 0 ? "" : "You are a customer support assistant.";

  return [
    identity,
    personaBlock,
    `Reply in ${languageName} (ISO: ${params.language}).`,
    channelHint,
    "Be natural, concise, and helpful. Output only the reply text.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The step's instruction and the chat come first: they decide what the reply is about. */
function buildTurnContextParts(
  recoveryContext?: FallbackRecoveryContext
): string[] {
  const parts: string[] = [];
  if (recoveryContext?.stepInstruction) {
    parts.push(
      `Instruction for this reply (follow it): ${recoveryContext.stepInstruction}`
    );
  }
  if (recoveryContext?.recentConversation) {
    parts.push(
      `Recent conversation (oldest first):\n${recoveryContext.recentConversation}`
    );
  }
  return parts;
}

function buildRecoveryInstruction(params: FallbackRecoveryReplyParams): string {
  const { type, recoveryContext } = params;
  const parts: string[] = [];

  if (type === "grounded_recovery") {
    parts.push(
      "The first reply draft was not complete. Write one complete reply to the customer's latest message, in the context of this conversation."
    );
    if (recoveryContext?.draftReply) {
      parts.push(
        "Start from the draft below: keep what is correct and relevant, then finish or fix the rest."
      );
    }
    parts.push(
      "Use the knowledge base context only where it answers the customer's latest message; never switch to an unrelated topic from it."
    );
    parts.push(
      "STRICT: Never start with meta-statements about finding information, such as 'Here is what I found'. Never end with offers to continue from the materials. Just answer the customer directly and naturally."
    );
    parts.push(...buildTurnContextParts(recoveryContext));
    if (recoveryContext?.latestCustomerMessage) {
      parts.push(
        `Customer's latest message: ${recoveryContext.latestCustomerMessage}`
      );
    }
    if (recoveryContext?.draftReply) {
      parts.push(`Draft reply:\n${recoveryContext.draftReply}`);
    }
    // The conversation says more than an anchor that may be from an older topic.
    if (recoveryContext?.intentAnchor && !recoveryContext.recentConversation) {
      parts.push(`Topic context: ${recoveryContext.intentAnchor}`);
    }
    if (recoveryContext?.snippetAnswer) {
      parts.push(
        `Verified answer from knowledge base:\n${recoveryContext.snippetAnswer}`
      );
    }
    if (recoveryContext?.kbExcerpt) {
      parts.push(`Knowledge base excerpt:\n${recoveryContext.kbExcerpt}`);
    }
    return parts.join("\n\n");
  }

  if (type === "missing_knowledge") {
    const intent = recoveryContext?.missingKnowledgeIntent || "this topic";
    parts.push(
      `The knowledge base does not have confirmed information about: ${intent}.`
    );
    parts.push(
      "Be transparent about the gap. Suggest they contact support or the relevant team for up-to-date information. Be helpful, not robotic."
    );
    parts.push(...buildTurnContextParts(recoveryContext));
    if (recoveryContext?.latestCustomerMessage) {
      parts.push(`Customer asked: ${recoveryContext.latestCustomerMessage}`);
    }
    return parts.join("\n\n");
  }

  parts.push(
    "There is not enough information to answer the customer's question fully."
  );
  parts.push(
    "Ask a targeted clarifying question to understand what they need. Be specific based on the conversation context, not generic."
  );
  parts.push(...buildTurnContextParts(recoveryContext));
  if (recoveryContext?.kbExcerpt) {
    parts.push(
      "Relevant knowledge base context is provided below. Use it only to identify what is known, and ask only for the missing detail needed to answer safely."
    );
    parts.push(`Knowledge base excerpt:\n${recoveryContext.kbExcerpt}`);
  }
  if (recoveryContext?.latestCustomerMessage) {
    parts.push(`Customer's message: ${recoveryContext.latestCustomerMessage}`);
  }
  if (recoveryContext?.intentAnchor) {
    parts.push(`Conversation topic: ${recoveryContext.intentAnchor}`);
  }
  return parts.join("\n\n");
}

function isIncompleteFallbackRecoveryReply(
  reply: string,
  finishReason?: string | null
): boolean {
  return (
    isInterruptedFinishReason(finishReason) ||
    isLikelyIncompleteAssistantReply(reply, finishReason)
  );
}

async function callFallbackRecoveryModel(params: {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  timeoutMs: number;
}) {
  return chatCompletionWithFallback({
    // Customer-facing reply: heavy tier, resolved per call.
    model: getHeavyTextModel(),
    providerOrder: getDefaultAIChatProviderOrder(),
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userPrompt },
    ],
    temperature: params.temperature,
    resilience: {
      maxRetries: 0,
      timeoutMs: params.timeoutMs,
    },
  });
}

async function generateFallbackRecoveryReplyResultImpl(
  params: FallbackRecoveryReplyParams
): Promise<FallbackRecoveryReplyResult> {
  const systemPrompt = buildSystemPromptForFallbackRecovery(params);
  const userPrompt = buildRecoveryInstruction(params);
  const inferenceDeadline = createInferenceDeadline(params.timeoutMs ?? 10_000);

  // Preserve exhausted provider failures for the caller's durable outcome.
  // An empty successful result would complete the turn without a delivery.
  const firstTimeoutMs = inferenceDeadline.nextTimeoutMs(8_000);
  if (!firstTimeoutMs) {
    throw new Error("Fallback-recovery inference deadline exhausted");
  }
  const response = await callFallbackRecoveryModel({
    systemPrompt,
    userPrompt,
    temperature: 0.4,
    timeoutMs: firstTimeoutMs,
  });

  let rawReply = String(response.content || "").trim();
  let finishReason = response.finishReason || null;
  let provider = response.provider || null;
  let model = response.model || getHeavyTextModel();
  let latencyMs = response.latencyMs || null;
  let isIncomplete = isIncompleteFallbackRecoveryReply(rawReply, finishReason);

  if (isIncomplete) {
    const retryTimeoutMs = inferenceDeadline.nextTimeoutMs(5_000);
    if (retryTimeoutMs) {
      const retryResponse = await callFallbackRecoveryModel({
        systemPrompt,
        userPrompt: `${userPrompt}\n\nIMPORTANT: Return one complete reply. Never stop mid-sentence or after a conjunction.`,
        temperature: 0.2,
        timeoutMs: retryTimeoutMs,
      });
      const retriedRaw = String(retryResponse.content || "").trim();

      if (
        shouldPreferRetriedAssistantReply(rawReply, retriedRaw, {
          original: finishReason,
          candidate: retryResponse.finishReason,
        })
      ) {
        rawReply = retriedRaw;
        finishReason = retryResponse.finishReason || null;
        provider = retryResponse.provider || null;
        model = retryResponse.model || getHeavyTextModel();
      }

      const bothNull = latencyMs == null && retryResponse.latencyMs == null;
      const sum = (latencyMs ?? 0) + (retryResponse.latencyMs ?? 0);
      latencyMs = bothNull ? null : sum;
      isIncomplete = isIncompleteFallbackRecoveryReply(rawReply, finishReason);
    }
  }

  const reply = finalizeReplyText(rawReply, {
    alreadyGreetedToday: params.alreadyGreetedToday,
  });

  return {
    reply,
    finishReason,
    provider,
    model,
    latencyMs,
    isIncomplete,
  };
}

export const generateFallbackRecoveryReplyResult = traceableChain(
  generateFallbackRecoveryReplyResultImpl,
  {
    name: "airi.reply.fallback_recovery_generation",
    tags: ["airi", "reply", "fallback-recovery-generation"],
    processInputs: inputs => {
      const payload = (
        "input" in inputs ? inputs.input : inputs
      ) as FallbackRecoveryReplyParams;
      return {
        type: payload.type,
        language: payload.language,
        channel: payload.channel || null,
        already_greeted_today: Boolean(payload.alreadyGreetedToday),
        intent_anchor_preview: previewText(
          payload.recoveryContext?.intentAnchor,
          160
        ),
        latest_message_preview: previewText(
          payload.recoveryContext?.latestCustomerMessage,
          200
        ),
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as FallbackRecoveryReplyResult;
      return {
        reply_preview: previewText(result.reply, 240),
        finish_reason: result.finishReason,
        provider: result.provider,
        model: result.model,
        latency_ms: result.latencyMs,
        is_incomplete: result.isIncomplete,
      };
    },
  }
);
