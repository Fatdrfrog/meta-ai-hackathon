import { z } from "zod";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const AVATAR_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function createProfileSchema(t: (key: string) => string) {
  return z.object({
    fullName: z
      .string({
        required_error: t("fullNameRequired"),
        invalid_type_error: t("fullNameRequired"),
      })
      .trim()
      .min(1, t("fullNameRequired"))
      .max(100, t("fullNameTooLong")),
  });
}

export function getAvatarValidationError(file: Pick<File, "size" | "type">) {
  if (!Object.hasOwn(AVATAR_EXTENSIONS, file.type)) return "avatarTypeError";
  if (file.size === 0 || file.size > MAX_AVATAR_BYTES) return "avatarSizeError";
  return null;
}
