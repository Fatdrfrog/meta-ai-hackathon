import { resolveIntentPolicy } from "@/lib/airi/reply/intent/intent-policy";
import type { ThreadReplyContext } from "@/lib/airi/reply/thread/thread-context";
import {
  EMPTY_THREAD_SCAFFOLD,
  type TurnUnderstanding,
} from "@/lib/airi/reply/turn/understand-customer-turn";

const baseThreadContext: ThreadReplyContext = {
  retrievalQuery: "Documents for the second stage",
  queryVariants: ["Documents for the second stage"],
  lastMessageQuery: "I am waiting",
  intentAnchor: "Documents for the second stage",
  activeGoals: ["documents second stage"],
  openAsks: ["documents second stage"],
  followUpMode: "resume_unresolved_need",
  conversationContext: "",
  conversationWindow: "",
  threadMemorySummary: "",
  recentConversationTail: "",
  dominantLanguage: "ru",
  hasUnresolvedNeed: true,
  currentGoal: "Documents for the second stage",
  unresolvedNeeds: ["Documents for the second stage"],
  resolvedNeeds: [],
  turnUnderstanding: null,
};

describe("intent policy", () => {
  it("forces impatience messages back into RAG when a factual need is still open", () => {
    const turnUnderstanding: TurnUnderstanding = {
      kind: "impatience",
      proceedWithRag: false,
      calendarAvailabilityRelevant: false,
      dependsOnPriorContext: true,
      safeReplyKey: "impatience",
      confidence: "high",
      selectionTransition: { action: "none", selectionLabel: null },
      asks: [],
      coverageHints: [],
      followUpMode: "resume_unresolved_need",
      followUpAnchor: "Documents for the second stage",
      queryVariants: ["Documents for the second stage"],
      planningSource: "model",
      threadScaffold: {
        ...EMPTY_THREAD_SCAFFOLD,
        conversationalFollowup: true,
      },
    };

    const result = resolveIntentPolicy({
      turnUnderstanding,
      threadContext: baseThreadContext,
      language: "ru",
      alreadyGreetedToday: true,
    });

    expect(result.proceedWithRag).toBe(true);
    expect(result.safeReplyType).toBeUndefined();
  });

  it("returns a safeReplyType instead of hardcoded string when no unresolved need", () => {
    const turnUnderstanding: TurnUnderstanding = {
      kind: "presence_check",
      proceedWithRag: false,
      calendarAvailabilityRelevant: false,
      dependsOnPriorContext: false,
      safeReplyKey: "presence_check",
      confidence: "high",
      selectionTransition: { action: "none", selectionLabel: null },
      asks: [],
      coverageHints: [],
      followUpMode: "none",
      followUpAnchor: null,
      queryVariants: [],
      planningSource: "model",
      threadScaffold: {
        ...EMPTY_THREAD_SCAFFOLD,
        conversationalFollowup: true,
      },
    };

    const result = resolveIntentPolicy({
      turnUnderstanding,
      threadContext: {
        ...baseThreadContext,
        hasUnresolvedNeed: false,
        intentAnchor: "",
        queryVariants: [],
        followUpMode: "none",
        currentGoal: "",
        unresolvedNeeds: [],
      },
      language: "ru",
      alreadyGreetedToday: true,
    });

    expect(result.proceedWithRag).toBe(false);
    expect(result.safeReplyType).toBe("presence_check");
  });

  it("maps greeting safeReplyKey to greeting type", () => {
    const turnUnderstanding: TurnUnderstanding = {
      kind: "greeting",
      proceedWithRag: false,
      calendarAvailabilityRelevant: false,
      dependsOnPriorContext: false,
      safeReplyKey: "greeting",
      confidence: "high",
      selectionTransition: { action: "none", selectionLabel: null },
      asks: [],
      coverageHints: [],
      followUpMode: "none",
      followUpAnchor: null,
      queryVariants: [],
      planningSource: "model",
      threadScaffold: {
        ...EMPTY_THREAD_SCAFFOLD,
        conversationalFollowup: true,
      },
    };

    const result = resolveIntentPolicy({
      turnUnderstanding,
      threadContext: {
        ...baseThreadContext,
        hasUnresolvedNeed: false,
        intentAnchor: "",
        currentGoal: "",
        unresolvedNeeds: [],
      },
      language: "en",
      alreadyGreetedToday: false,
    });

    expect(result.proceedWithRag).toBe(false);
    expect(result.safeReplyType).toBe("greeting");
  });
});
