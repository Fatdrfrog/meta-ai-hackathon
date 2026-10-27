import {
  isSupportedWhatsAppTemplateVideoHeader,
  type WhatsAppTemplateHeaderMediaFormat,
} from "@/lib/whatsapp/media-types";
import { WHATSAPP_TEMPLATE_VIDEO_HEADER_MAX_BYTES } from "@icecore/whatsapp/mediaTypes";

export type WhatsAppTemplateHeaderMediaValidationIssue =
  | "templateVideoTooLarge"
  | "templateVideoUnsupported";

export function getWhatsAppTemplateHeaderMediaValidationIssue(params: {
  format: WhatsAppTemplateHeaderMediaFormat;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
}): WhatsAppTemplateHeaderMediaValidationIssue | null {
  if (params.format !== "VIDEO") return null;

  if (
    typeof params.size === "number" &&
    params.size > WHATSAPP_TEMPLATE_VIDEO_HEADER_MAX_BYTES
  ) {
    return "templateVideoTooLarge";
  }

  if (
    !isSupportedWhatsAppTemplateVideoHeader({
      fileName: params.fileName,
      mimeType: params.mimeType,
    })
  ) {
    return "templateVideoUnsupported";
  }

  return null;
}
