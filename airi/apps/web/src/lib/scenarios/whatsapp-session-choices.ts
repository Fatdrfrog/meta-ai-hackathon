import type { ScenarioWhatsAppSessionChoice } from "@icecore/scenario-contracts";
import { buildWhatsAppSessionChoicePayload } from "@icecore/scenario-contracts";

export const MAX_WHATSAPP_SESSION_CHOICES = 10;
export const MAX_WHATSAPP_SESSION_CHOICE_TEXT_LENGTH = 20;
export const MAX_WHATSAPP_SESSION_CHOICE_DESCRIPTION_LENGTH = 72;

function normalizeChoiceId(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  const normalized = raw.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
  return normalized || fallback;
}

function normalizeChoiceText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WHATSAPP_SESSION_CHOICE_TEXT_LENGTH);
}

function normalizeChoiceDescription(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WHATSAPP_SESSION_CHOICE_DESCRIPTION_LENGTH);
  return normalized || undefined;
}

export function normalizeWhatsAppSessionChoices(
  value: unknown,
  actionNodeId = ""
): ScenarioWhatsAppSessionChoice[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seenPayloads = new Set<string>();
  const choices: ScenarioWhatsAppSessionChoice[] = [];

  value.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const text = normalizeChoiceText(
      record.text ?? record.label ?? record.title
    );
    if (!text) return;

    const id = normalizeChoiceId(record.id, `choice-${index + 1}`);
    const rawPayload =
      typeof record.payload === "string" ? record.payload.trim() : "";
    const payload =
      rawPayload ||
      (actionNodeId
        ? buildWhatsAppSessionChoicePayload({ actionNodeId, choiceId: id })
        : id);
    if (!payload || seenPayloads.has(payload)) return;
    seenPayloads.add(payload);

    const description = normalizeChoiceDescription(record.description);
    choices.push({
      id,
      text,
      payload,
      ...(description ? { description } : {}),
    });
  });

  return choices.length > 0
    ? choices.slice(0, MAX_WHATSAPP_SESSION_CHOICES)
    : undefined;
}
