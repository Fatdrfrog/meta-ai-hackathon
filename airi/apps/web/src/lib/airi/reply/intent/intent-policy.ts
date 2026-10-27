import type {
  TurnSafeReplyKey,
  TurnUnderstanding,
} from "@/lib/airi/reply/turn/understand-customer-turn";
import type { ThreadReplyContext } from "@/lib/airi/reply/thread/thread-context";
import type { SafeIntentReplyType } from "@/lib/airi/reply/generation/safe-intent-reply";

type ResolveIntentPolicyParams = {
  turnUnderstanding: TurnUnderstanding;
  threadContext: ThreadReplyContext;
  language: string;
  alreadyGreetedToday: boolean;
};

export type IntentPolicyResult = {
  proceedWithRag: boolean;
  safeReplyType?: SafeIntentReplyType;
};

const SAFE_REPLY_KEY_TO_TYPE: Record<TurnSafeReplyKey, SafeIntentReplyType> = {
  greeting: "greeting",
  presence_check: "presence_check",
  meta_question: "meta_question",
  thanks: "thanks",
  farewell: "farewell",
  acknowledgment: "acknowledgment",
  data_sharing: "data_sharing",
  impatience: "impatience",
  chit_chat: "chit_chat",
};

export function resolveIntentPolicy(
  params: ResolveIntentPolicyParams
): IntentPolicyResult {
  if (params.turnUnderstanding.proceedWithRag) {
    return { proceedWithRag: true };
  }

  const shouldContinueWithRag =
    params.turnUnderstanding.dependsOnPriorContext &&
    params.threadContext.hasUnresolvedNeed &&
    Boolean(params.threadContext.intentAnchor);

  if (shouldContinueWithRag) {
    return { proceedWithRag: true };
  }

  const safeReplyKey = params.turnUnderstanding.safeReplyKey;

  if (!safeReplyKey) {
    return { proceedWithRag: false };
  }

  const replyType = SAFE_REPLY_KEY_TO_TYPE[safeReplyKey];
  if (!replyType) {
    return { proceedWithRag: false };
  }

  return {
    proceedWithRag: false,
    safeReplyType: replyType,
  };
}
