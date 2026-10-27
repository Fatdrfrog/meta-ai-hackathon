import type { StoredWhatsAppServiceMessagePreview } from "../../shared/src/types/message-preview";
import type { ScenarioActionAttachment } from "./scenario-action-attachments";
import {
  resolveWhatsAppFlowSourceBinding,
  type ScenarioWhatsAppContactConfig,
  type ScenarioWhatsAppLocationConfig,
  type ScenarioWhatsAppSessionChoice,
  type WhatsAppFlowConfig,
} from "./scenario-channel-configs";
import {
  getScenarioWhatsAppServiceBodySource,
  validateScenarioWhatsAppServiceMessage,
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppCarouselCard,
  type ScenarioWhatsAppCommerceConfig,
  type ScenarioWhatsAppInteractiveHeader,
  type ScenarioWhatsAppInteractiveOption,
  type ScenarioWhatsAppListSection,
  type ScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessageDiagnostic,
} from "./whatsapp-service-message";
import { readTrimmedString as trimmed } from "./value-guards";

export type WhatsAppServiceSendCommand =
  | { kind: "text"; body: string; previewUrl: boolean }
  | {
      kind: "media";
      attachment: ScenarioActionAttachment;
      caption?: string;
      voice?: boolean;
    }
  | {
      kind: "reply_buttons";
      body: string;
      header?: ScenarioWhatsAppInteractiveHeader;
      footerText?: string;
      options: ScenarioWhatsAppInteractiveOption[];
    }
  | {
      kind: "list";
      body: string;
      headerText?: string;
      footerText?: string;
      buttonLabel: string;
      sections: Array<{
        title?: string;
        rows: Array<{ id: string; title: string; description?: string }>;
      }>;
    }
  | {
      kind: "cta_url";
      body: string;
      header?: ScenarioWhatsAppInteractiveHeader;
      footerText?: string;
      buttonLabel: string;
      url: string;
    }
  | {
      kind: "media_carousel";
      body: string;
      cards: ScenarioWhatsAppCarouselCard[];
    }
  | {
      kind: "flow";
      body: string;
      flowConfig: WhatsAppFlowConfig;
      flowToken?: string;
    }
  | { kind: "contacts"; contacts: ScenarioWhatsAppContactConfig[] }
  | { kind: "location"; location: ScenarioWhatsAppLocationConfig }
  | { kind: "location_request"; body: string }
  | { kind: "request_contact_info"; body: string }
  | {
      kind: "voice_call";
      body: string;
      buttonLabel: string;
      ttlMinutes: number;
      payload: string;
    }
  | { kind: "commerce"; commerce: ScenarioWhatsAppCommerceConfig };

/** The stored service-message preview as the compiler writes it. */
export type WhatsAppServiceMessagePreview =
  StoredWhatsAppServiceMessagePreview<WhatsAppServiceSendCommand> & {
    version: 1;
    kind: WhatsAppServiceSendCommand["kind"];
    bodyText?: string;
    command: WhatsAppServiceSendCommand;
  };

export type CompileWhatsAppServiceMessageInput = {
  config: ScenarioWhatsAppServiceMessage;
  resolvedBodyText?: string;
  managedSignupLinkUrl?: string;
  appointmentChoices?: ScenarioWhatsAppSessionChoice[];
  flowToken?: string;
  sourceId?: string | null;
  wabaId?: string | null;
  recipientKind: "phone" | "bsuid";
  callingReady?: boolean;
  catalogAvailable?: boolean;
};

export type CompileWhatsAppServiceMessageResult =
  | {
      ok: true;
      command: WhatsAppServiceSendCommand;
      preview: WhatsAppServiceMessagePreview;
    }
  | {
      ok: false;
      diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[];
    };

function resolveBody(input: CompileWhatsAppServiceMessageInput): string {
  const source = getScenarioWhatsAppServiceBodySource(input.config);
  if (!source) return "";
  const resolvedBody = trimmed(input.resolvedBodyText);
  if (resolvedBody) return resolvedBody;
  return source.mode === "fixed" ? trimmed(source.text) : "";
}

function resolveBodyLimit(
  message: ScenarioWhatsAppServiceMessage["message"],
): number | undefined {
  switch (message.kind) {
    case "text":
    case "list":
      return WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text;
    case "media":
      return WHATSAPP_SERVICE_MESSAGE_LIMITS.body.mediaCaption;
    case "reply_buttons":
    case "cta_url":
    case "media_carousel":
    case "flow":
    case "appointment":
    case "location_request":
    case "request_contact_info":
    case "voice_call":
      return WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive;
    case "contacts":
    case "location":
    case "commerce":
      return undefined;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

function failure(
  code: ScenarioWhatsAppServiceMessageDiagnostic["code"],
  path?: string,
): CompileWhatsAppServiceMessageResult {
  return {
    ok: false,
    diagnostics: [path ? { code, path } : { code }],
  };
}

function success(
  command: WhatsAppServiceSendCommand,
  bodyText?: string,
): CompileWhatsAppServiceMessageResult {
  return {
    ok: true,
    command,
    preview: {
      version: 1,
      kind: command.kind,
      ...(bodyText ? { bodyText } : {}),
      command,
    },
  };
}

function listSections(
  sections: ScenarioWhatsAppListSection[],
): Extract<WhatsAppServiceSendCommand, { kind: "list" }>["sections"] {
  return sections.map((section) => ({
    ...(trimmed(section.title) ? { title: trimmed(section.title) } : {}),
    rows: section.rows.map((row) => ({
      id: trimmed(row.id),
      title: trimmed(row.title),
      ...(trimmed(row.description)
        ? { description: trimmed(row.description) }
        : {}),
    })),
  }));
}

export function compileWhatsAppServiceMessage(
  input: CompileWhatsAppServiceMessageInput,
): CompileWhatsAppServiceMessageResult {
  const diagnostics = validateScenarioWhatsAppServiceMessage(input.config);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const message = input.config.message;
  const body = resolveBody(input);
  if (getScenarioWhatsAppServiceBodySource(input.config) && !body) {
    return failure("body_required", "resolvedBodyText");
  }
  const bodyLimit = resolveBodyLimit(message);
  if (bodyLimit && body.length > bodyLimit) {
    return failure("body_too_long", "resolvedBodyText");
  }

  switch (message.kind) {
    case "text":
      return success(
        { kind: "text", body, previewUrl: message.previewUrl !== false },
        body,
      );
    case "media":
      return success(
        {
          kind: "media",
          attachment: message.attachment,
          ...(body ? { caption: body } : {}),
          ...(message.deliverAsVoice && message.attachment.mediaType === "audio"
            ? { voice: true }
            : {}),
        },
        body || undefined,
      );
    case "reply_buttons":
      return success(
        {
          kind: "reply_buttons",
          body,
          ...(message.header ? { header: message.header } : {}),
          ...(trimmed(message.footerText)
            ? { footerText: trimmed(message.footerText) }
            : {}),
          options: message.options.map((option) => ({
            id: trimmed(option.id),
            label: trimmed(option.label),
          })),
        },
        body,
      );
    case "list":
      return success(
        {
          kind: "list",
          body,
          ...(trimmed(message.headerText)
            ? { headerText: trimmed(message.headerText) }
            : {}),
          ...(trimmed(message.footerText)
            ? { footerText: trimmed(message.footerText) }
            : {}),
          buttonLabel: trimmed(message.buttonLabel),
          sections: listSections(message.sections),
        },
        body,
      );
    case "cta_url": {
      const url =
        message.urlSource.kind === "fixed"
          ? trimmed(message.urlSource.url)
          : trimmed(input.managedSignupLinkUrl);
      if (!url)
        return failure("managed_url_unresolved", "managedSignupLinkUrl");
      return success(
        {
          kind: "cta_url",
          body,
          ...(message.header ? { header: message.header } : {}),
          ...(trimmed(message.footerText)
            ? { footerText: trimmed(message.footerText) }
            : {}),
          buttonLabel: trimmed(message.buttonLabel),
          url,
        },
        body,
      );
    }
    case "media_carousel":
      return success(
        { kind: "media_carousel", body, cards: message.cards },
        body,
      );
    case "flow": {
      const sourceBinding = resolveWhatsAppFlowSourceBinding({
        flowConfig: message.flowConfig,
        outboundSourceId: input.sourceId,
        outboundWabaId: input.wabaId,
      });
      if (sourceBinding !== "unmanaged" && sourceBinding !== "matched") {
        return failure("flow_source_mismatch", "message.flowConfig");
      }
      return success(
        {
          kind: "flow",
          body,
          flowConfig: message.flowConfig as WhatsAppFlowConfig,
          ...(trimmed(input.flowToken)
            ? { flowToken: trimmed(input.flowToken) }
            : {}),
        },
        body,
      );
    }
    case "appointment": {
      const choices = input.appointmentChoices;
      if (!choices || choices.length < 1 || choices.length > 10) {
        return failure("appointment_slots_unresolved", "appointmentChoices");
      }
      if (choices.length <= 3) {
        return success(
          {
            kind: "reply_buttons",
            body,
            options: choices.map((choice) => ({
              id: trimmed(choice.payload),
              label: trimmed(choice.text),
            })),
          },
          body,
        );
      }
      return success(
        {
          kind: "list",
          body,
          buttonLabel: "View times",
          sections: [
            {
              rows: choices.map((choice) => ({
                id: trimmed(choice.payload),
                title: trimmed(choice.text),
                ...(trimmed(choice.description)
                  ? { description: trimmed(choice.description) }
                  : {}),
              })),
            },
          ],
        },
        body,
      );
    }
    case "contacts":
      return success({ kind: "contacts", contacts: message.contacts });
    case "location":
      return success({ kind: "location", location: message.location });
    case "location_request":
      return success({ kind: "location_request", body }, body);
    case "request_contact_info":
      return input.recipientKind === "bsuid"
        ? success({ kind: "request_contact_info", body }, body)
        : success({ kind: "text", body, previewUrl: false }, body);
    case "voice_call":
      return input.callingReady
        ? success(
            {
              kind: "voice_call",
              body,
              buttonLabel: trimmed(message.buttonLabel),
              ttlMinutes: message.ttlMinutes,
              payload: message.payload,
            },
            body,
          )
        : failure("voice_call_unavailable", "callingReady");
    case "commerce":
      return input.catalogAvailable === false
        ? failure("catalog_unavailable", "catalogAvailable")
        : success({ kind: "commerce", commerce: message.commerce });
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}
