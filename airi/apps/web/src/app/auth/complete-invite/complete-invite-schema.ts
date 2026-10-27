import * as z from "zod";

// Letters and combining marks from any script (Cyrillic and Kazakh names
// included), plus spaces, hyphens and straight or curly apostrophes.
export const INVITE_FULL_NAME_PATTERN = /^[\p{L}\p{M}\s'’-]+$/u;

export const INVITE_PASSWORD_MIN_LENGTH = 8;
export const INVITE_PASSWORD_MAX_LENGTH = 72;

type CompleteInviteTranslate = (key: string) => string;

export function buildCompleteInviteSchema(t: CompleteInviteTranslate) {
  return z
    .object({
      fullName: z
        .string()
        .trim()
        .min(2, t("validation.nameTooShort"))
        .max(100, t("validation.nameTooLong"))
        .regex(INVITE_FULL_NAME_PATTERN, t("validation.nameInvalid")),
      password: z
        .string()
        .min(INVITE_PASSWORD_MIN_LENGTH, t("validation.passwordTooShort"))
        .max(INVITE_PASSWORD_MAX_LENGTH, t("validation.passwordTooLong"))
        .regex(/\p{Ll}/u, t("validation.passwordLowercase"))
        .regex(/\p{Lu}/u, t("validation.passwordUppercase"))
        .regex(/[0-9]/, t("validation.passwordNumber")),
      confirmPassword: z.string(),
    })
    .refine(data => data.password === data.confirmPassword, {
      message: t("validation.passwordMismatch"),
      path: ["confirmPassword"],
    });
}

export type CompleteInviteForm = z.infer<
  ReturnType<typeof buildCompleteInviteSchema>
>;

export type PasswordStrengthLevel = "weak" | "fair" | "good" | "strong";

export function scorePasswordStrength(password: string): {
  score: number;
  level: PasswordStrengthLevel;
} {
  let score = 0;
  if (password.length >= INVITE_PASSWORD_MIN_LENGTH) score++;
  if (password.length >= 12) score++;
  if (/\p{Ll}/u.test(password)) score++;
  if (/\p{Lu}/u.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^\p{L}\p{M}0-9]/u.test(password)) score++;

  if (score <= 2) return { score, level: "weak" };
  if (score <= 4) return { score, level: "fair" };
  if (score <= 5) return { score, level: "good" };
  return { score, level: "strong" };
}
