import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { z } from "zod";
import { PUBLIC_TEMPLATES, getPublicTemplate } from "./public-template-catalog";

export const PUBLIC_TEMPLATE_CONSENT_VERSION =
  "public-template-demo-marketing-v2";
export const publicTemplateLocaleSchema = z.enum(["en", "ru", "kz"]);
export type PublicTemplateLocale = z.infer<typeof publicTemplateLocaleSchema>;

const publicTemplateIdsSchema = z
  .array(z.string().refine(id => Boolean(getPublicTemplate(id))))
  .max(PUBLIC_TEMPLATES.length);

/** Shared response boundary for the API, cache and public template consumers. */
export const publicTemplateReadinessSchema = z
  .object({
    readyTemplateIds: publicTemplateIdsSchema,
    unavailableTemplateIds: publicTemplateIdsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = [...value.readyTemplateIds, ...value.unavailableTemplateIds];
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Readiness IDs must be unique and disjoint",
      });
  });
export type PublicTemplateReadiness = z.infer<
  typeof publicTemplateReadinessSchema
>;

export const publicTemplateRequestBodySchema = z
  .object({
    templateId: z.string().trim().min(1).max(80),
    locale: publicTemplateLocaleSchema,
    name: z.string().trim().min(1).max(100),
    email: z
      .string()
      .trim()
      .max(254)
      .email()
      .transform(value => value.toLowerCase()),
    phone: z
      .string()
      .trim()
      .max(40)
      .regex(/^\+[1-9][\d\s().-]+$/)
      .refine(value =>
        /^[1-9]\d{7,14}$/.test(normalizeWhatsAppPhone(value) || "")
      )
      .transform(value => `+${normalizeWhatsAppPhone(value)}`),
    consent: z.literal(true),
    consentVersion: z.literal(PUBLIC_TEMPLATE_CONSENT_VERSION),
    website: z.string().trim().max(200).optional().default(""),
    requestId: z.string().uuid(),
    source: z.enum(["landing", "marketplace"]),
  })
  .strict();

export type PublicTemplateRequestBody = z.infer<
  typeof publicTemplateRequestBodySchema
>;
