import { z } from "zod";
import {
  createWhatsAppTemplateButtonTypeLimitSchema,
  createWhatsAppTemplateButtonsSchema,
  getFirstZodIssueMessage,
  type WhatsAppTemplateButtonValidationMessages,
} from "@/lib/whatsapp/templates/component-schemas";
import type { TemplateFormValues } from "./template-editor-form-utils";

type TemplateButtonValue = NonNullable<TemplateFormValues["buttons"]>[number];

export type TemplateButtonValidationMessages =
  WhatsAppTemplateButtonValidationMessages & {
    flowNameRequired: string;
    flowNameMax: string;
    createFlowFailed: string;
  };

export { getFirstZodIssueMessage };

export function createTemplateButtonsSchema(
  messages: TemplateButtonValidationMessages
) {
  return createWhatsAppTemplateButtonsSchema(messages) as unknown as z.ZodType<
    TemplateButtonValue[]
  >;
}

export function createTemplateButtonTypeLimitSchema(
  messages: TemplateButtonValidationMessages
) {
  return createWhatsAppTemplateButtonTypeLimitSchema(messages);
}

export function createWhatsAppFlowNameSchema(
  messages: TemplateButtonValidationMessages
) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, messages.flowNameRequired)
      .max(256, messages.flowNameMax),
  });
}

export function createWhatsAppFlowCreateResponseSchema(
  messages: TemplateButtonValidationMessages
) {
  return z
    .object({
      flow: z
        .object({
          id: z
            .string({ required_error: messages.createFlowFailed })
            .trim()
            .min(1, messages.createFlowFailed),
          name: z.string().optional(),
          status: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough();
}
