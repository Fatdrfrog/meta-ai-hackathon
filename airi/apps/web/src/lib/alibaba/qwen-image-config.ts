import "server-only";

import { readEnvOrEmpty } from "@icecore/shared/lib/env";

/**
 * Qwen-Image text-to-image via Alibaba Model Studio (Singapore).
 * Reuses ALIBABA_API_KEY + ALIBABA_API_HOST.
 */

export function getQwenImageModel(): string {
  return readEnvOrEmpty("QWEN_IMAGE_MODEL") || "qwen-image-2.0-pro";
}

/** Map Studio aspect ratios to Qwen-Image 2.0 recommended sizes. */
export function resolveQwenImageSize(aspectRatio: unknown): string {
  const normalized =
    typeof aspectRatio === "string" ? aspectRatio.trim() : "";
  switch (normalized) {
    case "16:9":
      return "2688*1536";
    case "9:16":
      return "1536*2688";
    case "4:3":
      return "2368*1728";
    case "3:4":
      return "1728*2368";
    case "1:1":
      return "2048*2048";
    default:
      return "1536*2688";
  }
}
