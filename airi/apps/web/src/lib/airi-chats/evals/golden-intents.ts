import { z } from "zod";
import type { AiriChatIntentKind } from "@/lib/airi-chats/intent-classifier";
import goldenIntentsJson from "./golden-intents.json";

/** Every routing intent, in the classifier's order. */
export const AIRI_GOLDEN_INTENT_KINDS = [
  "general_answer",
  "product_capability",
  "whatsapp_template",
  "whatsapp_flow",
  "opportunity_scan",
  "marketing_campaign",
  "image_generation",
  "meta_ads_mcp",
] as const satisfies readonly AiriChatIntentKind[];

export const AIRI_GOLDEN_LANGUAGES = ["en", "ru", "kz"] as const;

const airiGoldenIntentSchema = z
  .object({
    id: z.string().regex(/^[a-z]{2}-\d{2}$/),
    lang: z.enum(AIRI_GOLDEN_LANGUAGES),
    text: z.string().trim().min(1).max(500),
    expectedIntent: z.enum(AIRI_GOLDEN_INTENT_KINDS),
    notes: z.string().min(1).optional(),
  })
  .strict();

export type AiriGoldenIntent = z.infer<typeof airiGoldenIntentSchema>;

/**
 * The routing golden set: realistic single-turn prompts with no selected
 * sources and no open builder. Throws when an entry is malformed or an id
 * repeats, so a bad edit fails the deterministic test before any live run.
 */
export function loadAiriGoldenIntents(
  raw: unknown = goldenIntentsJson
): AiriGoldenIntent[] {
  const items = z.array(airiGoldenIntentSchema).min(1).parse(raw);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate Airi golden intent id: ${item.id}`);
    }
    seen.add(item.id);
  }
  return items;
}
