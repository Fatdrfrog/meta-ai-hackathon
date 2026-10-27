/**
 * Server-only coach utilities that require MongoDB/Node APIs.
 * Import from @/lib/airi/coach/coach-utils-server in API routes and server code only.
 */

import {
  isLanguageBearingMessageText,
  isSameLanguage,
  normalizeLanguageCandidateText,
  normalizeLanguageCode,
  type WorkspaceLanguageBias,
} from "@/lib/airi/shared/language-utils";
import { detectLanguageModelOnly } from "@/lib/airi/language-detector-server";
import {
  normalizeConversationPreferredLanguage,
  type ConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";
import { createLogger } from "@icecore/shared/lib/logger";

const logger = createLogger("airi-conversation-language");

export type ConversationLanguageDecision = {
  currentTurnLanguage: string | null;
  currentTurnLanguageSource: "confident" | null;
  activeLanguage: string;
  activeLanguageSource:
    | "current_turn"
    | "dominant_recent"
    | "stored_recent"
    | "stored_preferred"
    | "default";
  recentCustomerLanguage: ConversationPreferredLanguage | null;
  conversationPreferredLanguage: ConversationPreferredLanguage | null;
};

async function resolveDominantInboundLanguage(
  messages: string[]
): Promise<string | null> {
  const scores = new Map<string, number>();

  const candidates = messages
    .map(normalizeLanguageCandidateText)
    .filter((message): message is string => Boolean(message));
  const detections = await Promise.all(
    candidates.map(async message => ({
      message,
      detectedLang: normalizeLanguageCode(
        await detectLanguageModelOnly(message)
      ),
    }))
  );

  for (const { message, detectedLang } of detections) {
    if (!detectedLang) continue;

    const weight = Math.min(3, Math.max(1, message.length / 20));
    scores.set(detectedLang, (scores.get(detectedLang) || 0) + weight);
  }

  const ranked = Array.from(scores.entries()).sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });

  if (ranked.length === 0) {
    return null;
  }

  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return null;
  }

  return ranked[0][0] || null;
}

export async function detectAndUpdateConversationLanguageDecision(
  conversationId: string,
  customerMessage: string,
  options?: {
    workspaceLanguageBias?: WorkspaceLanguageBias | null;
  }
): Promise<ConversationLanguageDecision> {
  const meaningfulCustomerMessage =
    normalizeLanguageCandidateText(customerMessage);
  let fallbackStoredPreferredLanguage: ConversationPreferredLanguage | null =
    null;
  let fallbackStoredRecentCustomerLanguage: ConversationPreferredLanguage | null =
    null;
  let fallbackCurrentTurnLanguage: string | null = null;
  let currentTurnDetectionCompleted = false;

  try {
    const { Conversation } = await import("@/models/conversation");
    const Message = (await import("@/models/message")).default;
    const [conversationDoc, recentInboundMessages] = await Promise.all([
      Conversation.findById(conversationId)
        .select(
          "preferred_language airi_last_customer_language airi_last_customer_language_at airi_last_customer_language_source workspaceId"
        )
        .lean<{
          preferred_language?: string | null;
          airi_last_customer_language?: string | null;
          workspaceId?: string | null;
        } | null>(),
      Message.find({
        conversation: conversationId,
        direction: "inbound",
        text: { $exists: true, $ne: null },
      })
        .sort({ date: -1 })
        .limit(6)
        .select("text")
        .lean<Array<{ text?: string | null }>>(),
    ]);
    void options?.workspaceLanguageBias;
    const storedPreferredLanguage = normalizeConversationPreferredLanguage(
      conversationDoc?.preferred_language
    );
    const storedRecentCustomerLanguage = normalizeConversationPreferredLanguage(
      conversationDoc?.airi_last_customer_language
    );
    fallbackStoredPreferredLanguage = storedPreferredLanguage;
    fallbackStoredRecentCustomerLanguage = storedRecentCustomerLanguage;
    const recentInboundTexts = recentInboundMessages
      .map(message => (typeof message.text === "string" ? message.text : ""))
      .filter(text => isLanguageBearingMessageText(text));

    if (!meaningfulCustomerMessage) {
      const dominantInboundLanguage =
        await resolveDominantInboundLanguage(recentInboundTexts);
      const activeLanguage =
        dominantInboundLanguage ||
        storedRecentCustomerLanguage ||
        storedPreferredLanguage ||
        "";
      return {
        currentTurnLanguage: null,
        currentTurnLanguageSource: null,
        activeLanguage,
        activeLanguageSource: dominantInboundLanguage
          ? "dominant_recent"
          : storedRecentCustomerLanguage
            ? "stored_recent"
            : storedPreferredLanguage
              ? "stored_preferred"
              : "default",
        recentCustomerLanguage: storedRecentCustomerLanguage || null,
        conversationPreferredLanguage: storedPreferredLanguage || null,
      };
    }

    const modelDetected = await detectLanguageModelOnly(
      meaningfulCustomerMessage
    );
    const detectedLang = normalizeLanguageCode(modelDetected);
    const currentTurnLanguage = detectedLang || null;
    fallbackCurrentTurnLanguage = currentTurnLanguage;
    currentTurnDetectionCompleted = true;
    const currentTurnLanguageSource = currentTurnLanguage ? "confident" : null;
    const currentTurnConflictsWithStored =
      Boolean(currentTurnLanguage && storedRecentCustomerLanguage) &&
      !isSameLanguage(
        currentTurnLanguage || "",
        storedRecentCustomerLanguage || ""
      );
    const previousRecentInboundTexts = recentInboundTexts.filter(
      text => normalizeLanguageCandidateText(text) !== meaningfulCustomerMessage
    );
    const dominantInboundLanguage =
      !currentTurnLanguage || currentTurnConflictsWithStored
        ? await resolveDominantInboundLanguage(previousRecentInboundTexts)
        : null;
    const persistedDominantInboundLanguage =
      normalizeConversationPreferredLanguage(dominantInboundLanguage);
    const shouldUseCurrentTurnLanguage =
      Boolean(currentTurnLanguage) &&
      (!currentTurnConflictsWithStored ||
        Boolean(
          dominantInboundLanguage &&
            isSameLanguage(currentTurnLanguage || "", dominantInboundLanguage)
        ));
    const effectiveCurrentTurnLanguage = shouldUseCurrentTurnLanguage
      ? currentTurnLanguage
      : null;
    const persistedEffectiveCurrentTurnLanguage =
      normalizeConversationPreferredLanguage(effectiveCurrentTurnLanguage);
    const nextPreferredLanguage =
      persistedEffectiveCurrentTurnLanguage ||
      persistedDominantInboundLanguage ||
      storedPreferredLanguage;
    const nextRecentCustomerLanguage =
      persistedEffectiveCurrentTurnLanguage ||
      persistedDominantInboundLanguage ||
      storedRecentCustomerLanguage;
    const activeLanguage =
      effectiveCurrentTurnLanguage ||
      dominantInboundLanguage ||
      storedRecentCustomerLanguage ||
      storedPreferredLanguage ||
      "en";
    const activeLanguageSource = effectiveCurrentTurnLanguage
      ? "current_turn"
      : dominantInboundLanguage
        ? "dominant_recent"
        : storedRecentCustomerLanguage
          ? "stored_recent"
          : storedPreferredLanguage
            ? "stored_preferred"
            : "default";

    const updatePayload: Record<string, unknown> = {};

    if (
      nextRecentCustomerLanguage &&
      nextRecentCustomerLanguage !== storedRecentCustomerLanguage &&
      (persistedEffectiveCurrentTurnLanguage ||
        persistedDominantInboundLanguage)
    ) {
      updatePayload.airi_last_customer_language = nextRecentCustomerLanguage;
      updatePayload.airi_last_customer_language_at = new Date();
      updatePayload.airi_last_customer_language_source =
        persistedEffectiveCurrentTurnLanguage
          ? "google_cloud"
          : persistedDominantInboundLanguage
            ? "dominant_recent"
            : "google_cloud";
    }

    if (
      nextPreferredLanguage &&
      nextPreferredLanguage !== storedPreferredLanguage &&
      (persistedEffectiveCurrentTurnLanguage ||
        persistedDominantInboundLanguage)
    ) {
      updatePayload.preferred_language = nextPreferredLanguage;
    }

    if (Object.keys(updatePayload).length > 0) {
      const updatedConversation = await Conversation.findByIdAndUpdate(
        conversationId,
        updatePayload,
        {
          new: true,
          runValidators: true,
        }
      );
      if (!updatedConversation) {
        throw new Error("Conversation language update matched no document");
      }
    }

    return {
      currentTurnLanguage: currentTurnLanguage || null,
      currentTurnLanguageSource,
      activeLanguage,
      activeLanguageSource,
      recentCustomerLanguage: nextRecentCustomerLanguage || null,
      conversationPreferredLanguage: nextPreferredLanguage || null,
    };
  } catch (error) {
    logger.error("Failed to resolve or persist conversation language", error, {
      conversationId,
      detectedLanguage: fallbackCurrentTurnLanguage,
    });
  }

  if (!meaningfulCustomerMessage) {
    const activeLanguage =
      fallbackStoredRecentCustomerLanguage ||
      fallbackStoredPreferredLanguage ||
      "";
    return {
      currentTurnLanguage: null,
      currentTurnLanguageSource: null,
      activeLanguage,
      activeLanguageSource: fallbackStoredRecentCustomerLanguage
        ? "stored_recent"
        : fallbackStoredPreferredLanguage
          ? "stored_preferred"
          : "default",
      recentCustomerLanguage: fallbackStoredRecentCustomerLanguage,
      conversationPreferredLanguage: fallbackStoredPreferredLanguage,
    };
  }

  if (!currentTurnDetectionCompleted) {
    const modelDetected = await detectLanguageModelOnly(
      meaningfulCustomerMessage
    );
    fallbackCurrentTurnLanguage = normalizeLanguageCode(modelDetected) || null;
  }
  const currentTurnLanguage = fallbackCurrentTurnLanguage;
  const activeLanguage =
    currentTurnLanguage ||
    fallbackStoredRecentCustomerLanguage ||
    fallbackStoredPreferredLanguage ||
    "en";

  return {
    currentTurnLanguage: currentTurnLanguage || null,
    currentTurnLanguageSource: currentTurnLanguage ? "confident" : null,
    activeLanguage,
    activeLanguageSource: currentTurnLanguage
      ? "current_turn"
      : fallbackStoredRecentCustomerLanguage
        ? "stored_recent"
        : fallbackStoredPreferredLanguage
          ? "stored_preferred"
          : "default",
    recentCustomerLanguage: fallbackStoredRecentCustomerLanguage,
    conversationPreferredLanguage: fallbackStoredPreferredLanguage,
  };
}

export async function detectAndUpdateConversationLanguage(
  conversationId: string,
  customerMessage: string,
  options?: {
    workspaceLanguageBias?: WorkspaceLanguageBias | null;
  }
): Promise<string> {
  const decision = await detectAndUpdateConversationLanguageDecision(
    conversationId,
    customerMessage,
    options
  );
  return decision.activeLanguage || "en";
}
