import { z } from "zod";
import { CUSTOMER_WEBHOOK_EVENTS } from "./contracts";

export const CustomerApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    permissions: z
      .object({
        read: z.boolean().default(true),
        write: z.boolean().default(false),
        conversations: z.boolean().default(true),
        analytics: z.boolean().default(false),
      })
      .strict()
      .refine(
        permissions =>
          permissions.write ||
          (permissions.read &&
            (permissions.conversations || permissions.analytics)),
        "Select at least one permission"
      ),
    expires_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .refine(
        value => value == null || Date.parse(value) > Date.now(),
        "Expiry must be in the future"
      ),
  })
  .strict();

const webhookFields = {
  url: z.string().trim().min(1).max(2048),
  events: z
    .array(z.enum(CUSTOMER_WEBHOOK_EVENTS))
    .min(1)
    .max(CUSTOMER_WEBHOOK_EVENTS.length)
    .transform(events => [...new Set(events)]),
  description: z.string().trim().max(200).nullable().optional(),
};

export const CustomerWebhookSchema = z.object(webhookFields).strict();

export const CustomerWebhookUpdateSchema = z
  .object({
    url: webhookFields.url.optional(),
    events: webhookFields.events.optional(),
    description: webhookFields.description,
    is_active: z.boolean().optional(),
    rotate_secret: z.literal(true).optional(),
  })
  .strict()
  .refine(
    body => Object.keys(body).length > 0,
    "Choose a webhook setting to update"
  );
