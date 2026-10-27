import { z } from "zod";

const airiGeneratedAssetTargetSchema = z.enum([
  "chat_attachment",
  "whatsapp_template_header",
]);

const airiGeneratedAssetAttachmentSchema = z.object({
  id: z.string().trim().min(1).max(160),
  workspaceId: z.string().trim().min(1).max(160),
  kind: z.enum(["image"]),
  provider: z.enum(["google"]),
  providerLabel: z.string().trim().min(1).max(80).default("Nano Banana"),
  status: z
    .enum(["queued", "in_progress", "complete", "failed", "nsfw"])
    .default("queued"),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(3).max(1600),
  target: airiGeneratedAssetTargetSchema,
  url: z.string().trim().max(3000).nullable().optional(),
  error: z.string().trim().max(500).nullable().optional(),
  templateArtifactId: z.string().trim().max(160).nullable().optional(),
  templateRevision: z.number().int().nonnegative().nullable().optional(),
});

export const airiGeneratedAssetAttachmentsSchema = z
  .array(airiGeneratedAssetAttachmentSchema)
  .max(6);

export type AiriGeneratedAssetAttachment = z.infer<
  typeof airiGeneratedAssetAttachmentSchema
>;

export function normalizeAiriGeneratedAssetAttachment(
  value: unknown
): AiriGeneratedAssetAttachment | null {
  const parsed = airiGeneratedAssetAttachmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeAiriGeneratedAssetAttachments(
  value: unknown
): AiriGeneratedAssetAttachment[] {
  if (!Array.isArray(value)) {
    const attachment = normalizeAiriGeneratedAssetAttachment(value);
    return attachment ? [attachment] : [];
  }
  return value
    .map(item => normalizeAiriGeneratedAssetAttachment(item))
    .filter((item): item is AiriGeneratedAssetAttachment => Boolean(item))
    .slice(0, 6);
}
