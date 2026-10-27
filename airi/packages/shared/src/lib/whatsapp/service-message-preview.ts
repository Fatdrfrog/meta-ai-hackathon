import type { StoredWhatsAppServiceMessagePreview } from "../../types/message-preview";
import { asNullableRecord } from "../value-utils";

type UnknownRecord = Record<string, unknown>;

export function hasStoredWhatsAppServiceMessage(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function asRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value
        .map(asNullableRecord)
        .filter((item): item is UnknownRecord => Boolean(item))
    : [];
}

function pushUniqueText(parts: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const text = value.replace(/\s+/g, " ").trim();
  if (text && !parts.includes(text)) parts.push(text);
}

function pushInteractiveHeader(parts: string[], value: unknown): void {
  const header = asNullableRecord(value);
  if (header?.kind === "text") pushUniqueText(parts, header.text);
}

function pushOptions(parts: string[], value: unknown): void {
  for (const option of asRecords(value)) {
    pushUniqueText(parts, option.label);
    pushUniqueText(parts, option.title);
    pushUniqueText(parts, option.text);
  }
}

function pushFlowTexts(parts: string[], value: unknown): void {
  const flow = asNullableRecord(value);
  if (!flow) return;

  pushUniqueText(parts, flow.metaFlowName);
  pushUniqueText(parts, flow.ctaText);
  pushUniqueText(parts, flow.headerText);
  pushUniqueText(parts, flow.bodyText);
  pushUniqueText(parts, flow.footerText);
  pushUniqueText(parts, flow.flowSubmitLabel);

  for (const screen of asRecords(flow.screens)) {
    pushUniqueText(parts, screen.title);
    for (const field of asRecords(screen.fields)) {
      pushUniqueText(parts, field.label);
      pushUniqueText(parts, field.helperText);
      pushOptions(parts, field.options);
    }
  }
}

function extractStoredWhatsAppServiceMessageTextParts(params: {
  bodyText: string;
  command: UnknownRecord | null;
  kind: string;
}): string[] {
  const parts: string[] = [];
  pushUniqueText(parts, params.bodyText);
  const command = params.command;
  if (!command) return parts;

  switch (params.kind) {
    case "reply_buttons": {
      pushInteractiveHeader(parts, command.header);
      pushUniqueText(parts, command.footerText);
      pushOptions(parts, command.options);
      break;
    }
    case "list": {
      pushUniqueText(parts, command.headerText);
      pushUniqueText(parts, command.footerText);
      pushUniqueText(parts, command.buttonLabel);
      for (const section of asRecords(command.sections)) {
        pushUniqueText(parts, section.title);
        for (const row of asRecords(section.rows)) {
          pushUniqueText(parts, row.title);
          pushUniqueText(parts, row.description);
        }
      }
      break;
    }
    case "cta_url": {
      pushInteractiveHeader(parts, command.header);
      pushUniqueText(parts, command.footerText);
      pushUniqueText(parts, command.buttonLabel);
      break;
    }
    case "media_carousel": {
      for (const card of asRecords(command.cards)) {
        pushUniqueText(parts, card.bodyText);
        const interaction = asNullableRecord(card.interaction);
        pushUniqueText(parts, interaction?.buttonLabel);
        pushOptions(parts, interaction?.options);
      }
      break;
    }
    case "flow": {
      pushFlowTexts(parts, command.flowConfig);
      break;
    }
    case "contacts": {
      for (const contact of asRecords(command.contacts)) {
        pushUniqueText(parts, contact.formattedName);
        pushUniqueText(parts, contact.firstName);
        pushUniqueText(parts, contact.lastName);
        pushUniqueText(parts, contact.company);
        pushUniqueText(parts, contact.title);
      }
      break;
    }
    case "location": {
      const location = asNullableRecord(command.location);
      pushUniqueText(parts, location?.name);
      pushUniqueText(parts, location?.address);
      break;
    }
    case "voice_call": {
      pushUniqueText(parts, command.buttonLabel);
      break;
    }
    case "commerce": {
      const commerce = asNullableRecord(command.commerce);
      pushUniqueText(parts, commerce?.headerText);
      pushUniqueText(parts, commerce?.footerText);
      for (const section of asRecords(commerce?.sections)) {
        pushUniqueText(parts, section.title);
      }
      break;
    }
  }

  return parts;
}

export function resolveStoredWhatsAppServiceMessagePreview(
  preview: StoredWhatsAppServiceMessagePreview | null | undefined,
  fallbackBodyText?: string | null,
): {
  command: Record<string, unknown> | null;
  kind: string;
  bodyText: string;
  textParts: string[];
} {
  const command = asNullableRecord(preview?.command);
  const commandKind =
    typeof command?.kind === "string" ? command.kind.trim() : "";
  const kind =
    commandKind ||
    (typeof preview?.kind === "string" ? preview.kind.trim() : "");
  const commerce = asNullableRecord(command?.commerce);
  const bodyText =
    (typeof preview?.bodyText === "string" ? preview.bodyText : "") ||
    (typeof command?.body === "string" ? command.body : "") ||
    (typeof commerce?.bodyText === "string" ? commerce.bodyText : "") ||
    (typeof fallbackBodyText === "string" ? fallbackBodyText : "");

  return {
    command,
    kind,
    bodyText,
    textParts: extractStoredWhatsAppServiceMessageTextParts({
      bodyText,
      command,
      kind,
    }),
  };
}
