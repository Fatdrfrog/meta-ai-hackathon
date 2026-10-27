import { cache } from "@/lib/cache";
import { isGreetingMessage } from "@/lib/airi/shared/greeting-heuristics";
import {
  getDailyGreetingCacheKey,
  getSecondsUntilDayEnd,
} from "./daily-greeting-cache";
import Message from "@/models/message";

export async function hasGreetedToday(
  conversationId: string
): Promise<boolean> {
  const cacheKey = getDailyGreetingCacheKey(conversationId);
  const cached = await cache.get<string>(cacheKey);
  if (cached === "1") return true;
  // Do not short-circuit on "0": a greeting may have been persisted after the
  // negative cache was written (e.g. slow RAG then send). Always re-check Mongo.

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const greetings = await Message.find({
    conversation: conversationId,
    direction: "outbound",
    date: { $gte: today },
  })
    .select("text")
    .lean();

  const greeted = greetings.some(msg => isGreetingMessage(msg.text || ""));
  await cache.set(
    cacheKey,
    greeted ? "1" : "0",
    greeted ? getSecondsUntilDayEnd() : 60
  );
  return greeted;
}
