import { buildCacheKey, cache } from "@/lib/cache";

export function getDailyGreetingCacheKey(conversationId: string): string {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return buildCacheKey("airi:greeted", [conversationId, dayKey]);
}

export function getSecondsUntilDayEnd(): number {
  const now = new Date();
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);
  return Math.max(60, Math.ceil((dayEnd.getTime() - now.getTime()) / 1000));
}

export async function markGreetingSentToday(
  conversationId: string
): Promise<void> {
  const cacheKey = getDailyGreetingCacheKey(conversationId);
  await cache.set(cacheKey, "1", getSecondsUntilDayEnd());
}
