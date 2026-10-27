import { z } from "zod";

// The settings form and API previously validated the same payload separately.
// Keep the existing endpoint and form, with one contract for accepted values.
export const ltvConfigPayloadSchema = z.object({
  baseValue: z.number().finite().positive(),
  currency: z
    .string()
    .trim()
    .regex(/^[a-zA-Z]{3}$/)
    .transform(value => value.toUpperCase()),
});
