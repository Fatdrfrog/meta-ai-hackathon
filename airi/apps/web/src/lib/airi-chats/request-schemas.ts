import { z } from "zod";
import { activeAiriBuilderSchema } from "@/lib/airi-chats/builder-state";

export const selectedAiriChatSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("context"),
    optionId: z.enum([
      "conversation_timeline",
      "knowledge_base_articles",
      "indexed_public_urls",
      "answer_snippets",
      "quick_replies",
    ]),
    label: z.string().trim().min(1).max(160),
  }),
  z.object({
    kind: z.literal("context_item"),
    optionId: z.enum([
      "conversation_timeline",
      "knowledge_base_articles",
      "indexed_public_urls",
      "answer_snippets",
      "quick_replies",
    ]),
    itemId: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(160),
  }),
  z.object({
    kind: z.literal("channel_source"),
    sourceId: z.string().trim().min(1).max(160),
    sourceType: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(160),
  }),
  z.object({
    kind: z.literal("workspace_source"),
    sourceId: z.string().trim().min(1).max(160),
    sourceType: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(160),
  }),
  z.object({
    kind: z.literal("connector"),
    connector: z.literal("whatsapp"),
    sourceId: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(160),
    capabilities: z
      .array(z.enum(["docs", "templates", "flows"]))
      .max(8)
      .optional(),
  }),
  z.object({
    kind: z.literal("skill"),
    skillId: z.literal("meta"),
    label: z.string().trim().min(1).max(160),
  }),
  z.object({
    kind: z.literal("chat_thread"),
    threadId: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(160),
  }),
]);

const airiChatAttachmentBaseSchema = z.object({
  name: z.string().trim().min(1).max(240),
  type: z.string().trim().max(120).optional(),
  lastModified: z.number().int().nonnegative().optional(),
  textExcerpt: z.string().max(8_000).optional(),
  truncated: z.boolean().optional(),
});

export const airiChatAttachmentSchema = z.union([
  airiChatAttachmentBaseSchema.extend({
    size: z
      .number()
      .int()
      .nonnegative()
      .max(25 * 1024 * 1024),
    creativeAssetId: z.undefined().optional(),
  }),
  airiChatAttachmentBaseSchema.extend({
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    creativeAssetId: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{24}$/i),
  }),
]);

export type AiriChatAttachmentInput = z.infer<typeof airiChatAttachmentSchema>;

export const airiChatMessageBodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
  /**
   * The client's id for this send (crypto.randomUUID()). A retried send
   * with the same id attaches to its run instead of starting another; the
   * server generates one when it is absent.
   */
  clientTurnId: z.string().trim().uuid().optional(),
  selectedSources: z.array(selectedAiriChatSourceSchema).max(12).optional(),
  attachments: z.array(airiChatAttachmentSchema).max(8).optional(),
  activeBuilder: activeAiriBuilderSchema.optional(),
});

export const airiChatFirstMessageBodySchema = airiChatMessageBodySchema.extend({
  source: z.enum(["manual", "onboarding", "global"]).optional(),
});
