import type {
  ScenarioActionAttachment,
  ScenarioWhatsAppBodySource,
} from "@icecore/scenario-contracts";

export function bodyText(body: ScenarioWhatsAppBodySource | undefined): string {
  if (!body) return "";
  return body.mode === "fixed" ? body.text : body.instruction;
}

type ServiceMessageMediaFormat =
  | "IMAGE"
  | "VIDEO"
  | "DOCUMENT"
  | "AUDIO"
  | "STICKER";

/** Formats Meta allows on interactive reply/CTA headers. */
function interactiveHeaderMediaFormat(
  attachment: ScenarioActionAttachment | null
):
  | Extract<ServiceMessageMediaFormat, "IMAGE" | "VIDEO" | "DOCUMENT">
  | undefined {
  if (!attachment) return undefined;
  if (attachment.mediaType === "image") return "IMAGE";
  if (attachment.mediaType === "video") return "VIDEO";
  if (attachment.mediaType === "document") return "DOCUMENT";
  return undefined;
}

/** Formats shown in the bubble media slot (includes standalone audio/sticker). */
export function serviceMessageMediaFormat(
  attachment: ScenarioActionAttachment | null
): ServiceMessageMediaFormat | undefined {
  const interactive = interactiveHeaderMediaFormat(attachment);
  if (interactive) return interactive;
  if (!attachment) return undefined;
  if (attachment.mediaType === "audio") return "AUDIO";
  if (attachment.mediaType === "sticker") return "STICKER";
  return undefined;
}
