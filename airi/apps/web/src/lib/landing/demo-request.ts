import { z } from "zod";

export const demoRequestEmailSchema = z
  .string()
  .trim()
  .min(1, "required")
  .email("invalid");

export const demoRequestBodySchema = z.object({
  email: demoRequestEmailSchema,
  website: z.string().trim().max(200).optional().default(""),
});
