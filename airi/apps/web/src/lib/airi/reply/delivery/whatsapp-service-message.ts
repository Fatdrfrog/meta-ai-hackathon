import { buildWhatsAppContactMessagePayload } from "@/lib/scenarios/whatsapp-contact";
import { buildWhatsAppLocationMessagePayload } from "@/lib/scenarios/whatsapp-location";
import * as whatsappApi from "@/lib/whatsapp";
import type { WhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  mapScenarioServiceMessageMedia,
  resolveSendableWhatsAppFlowIdentity,
  resolveWhatsAppFlowActionType,
  resolveWhatsAppFlowNavigateActionPayload,
  resolveWhatsAppFlowSendMode,
  resolveWhatsAppFlowSourceBinding,
  type ScenarioWhatsAppInteractiveHeader,
  type WhatsAppServiceSendCommand,
} from "@icecore/scenario-contracts";

type TransportMethod =
  | "sendWhatsappMessage"
  | "sendWhatsappMedia"
  | "sendWhatsappInteractiveReplyButtonsMessage"
  | "sendWhatsappInteractiveListMessage"
  | "sendWhatsappInteractiveCtaUrlMessage"
  | "sendWhatsappInteractiveMediaCarousel"
  | "sendWhatsappInteractiveFlow"
  | "sendWhatsappContacts"
  | "sendWhatsappLocation"
  | "sendWhatsappLocationRequest"
  | "sendWhatsappRequestContactInfo"
  | "sendWhatsappVoiceCall"
  | "sendWhatsappCatalogMessage"
  | "sendWhatsappSingleProductMessage"
  | "sendWhatsappMultiProductMessage"
  | "sendWhatsappProductCarouselMessage";

export type WhatsAppServiceMessageTransport = Pick<
  typeof whatsappApi,
  TransportMethod
>;

export type DispatchWhatsAppServiceMessageInput = {
  phoneNumberId: string;
  accessToken: string;
  sourceId?: string | null;
  wabaId?: string | null;
  recipient: WhatsAppRecipientTarget;
  /** Media links must already be HTTPS. Prep via `sendWhatsAppServiceMessage`. */
  command: WhatsAppServiceSendCommand;
  beforeSend?: () => Promise<void>;
};

export class WhatsAppServiceWindowClosedError extends Error {
  readonly code = "WHATSAPP_SERVICE_WINDOW_CLOSED";

  constructor() {
    super(
      "WhatsApp service message cannot be sent because the 24-hour messaging window is closed"
    );
    this.name = "WhatsAppServiceWindowClosedError";
  }
}

function assertMetaHttpsMediaLink(url: string, context: string): void {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    throw new Error(`WhatsApp Meta dispatch missing media URL (${context})`);
  }
  if (
    trimmed.startsWith("gcs://") ||
    trimmed.startsWith("gs://") ||
    !trimmed.startsWith("https://")
  ) {
    throw new Error(
      `WhatsApp Meta dispatch received unresolved media URL (${context}). Use sendWhatsAppServiceMessage so object refs are signed before Meta send.`
    );
  }
}

function toTransportHeader(
  header: ScenarioWhatsAppInteractiveHeader | undefined
): whatsappApi.WhatsAppInteractiveHeader | undefined {
  if (!header) return undefined;
  if (header.kind === "text") {
    return { type: "text", text: header.text };
  }
  assertMetaHttpsMediaLink(header.attachment.url, "interactive header");
  return {
    type: header.attachment.mediaType,
    link: header.attachment.url,
    ...(header.attachment.fileName
      ? { fileName: header.attachment.fileName }
      : {}),
  };
}

function requireFlowIdentity(
  command: Extract<WhatsAppServiceSendCommand, { kind: "flow" }>,
  sourceId?: string | null,
  wabaId?: string | null
) {
  const sourceBinding = resolveWhatsAppFlowSourceBinding({
    flowConfig: command.flowConfig,
    outboundSourceId: sourceId,
    outboundWabaId: wabaId,
  });
  if (sourceBinding !== "unmanaged" && sourceBinding !== "matched") {
    const identity =
      sourceBinding === "waba_mismatch" ||
      sourceBinding === "outbound_waba_missing"
        ? "WABA"
        : "source";
    throw new Error(`WhatsApp Flow source does not match outbound ${identity}`);
  }
  const identity = resolveSendableWhatsAppFlowIdentity({
    flowConfig: command.flowConfig,
  });
  if (!identity) {
    throw new Error("WhatsApp service Flow requires flow_id or flow_name");
  }
  return identity;
}

function assertCommandMediaReady(command: WhatsAppServiceSendCommand): void {
  mapScenarioServiceMessageMedia(command, (attachment, location) => {
    assertMetaHttpsMediaLink(
      attachment.url,
      location.kind === "service_attachment"
        ? "media attachment"
        : location.kind === "service_header"
          ? `${command.kind} header`
          : `carousel card ${location.cardIndex}`
    );
    return attachment;
  });
}

/**
 * Meta transport only. Does not sign GCS object refs.
 * Prefer `sendWhatsAppServiceMessage` at the delivery edge.
 */
function prepareWhatsAppServiceTransport(
  input: DispatchWhatsAppServiceMessageInput,
  transport: WhatsAppServiceMessageTransport = whatsappApi
) {
  const { phoneNumberId, accessToken, sourceId, wabaId, recipient, command } =
    input;
  assertCommandMediaReady(command);

  switch (command.kind) {
    case "text":
      return () =>
        transport.sendWhatsappMessage(
          phoneNumberId,
          accessToken,
          recipient,
          command.body,
          undefined,
          { previewUrl: command.previewUrl }
        );
    case "media":
      return () =>
        transport.sendWhatsappMedia(phoneNumberId, accessToken, recipient, {
          type: command.attachment.mediaType,
          link: command.attachment.url,
          ...(command.caption ? { caption: command.caption } : {}),
          ...(command.attachment.fileName
            ? { fileName: command.attachment.fileName }
            : {}),
          ...(command.voice ? { voice: true } : {}),
        });
    case "reply_buttons":
      return () =>
        transport.sendWhatsappInteractiveReplyButtonsMessage(
          phoneNumberId,
          accessToken,
          recipient,
          {
            bodyText: command.body,
            ...(command.header
              ? { header: toTransportHeader(command.header) }
              : {}),
            ...(command.footerText ? { footerText: command.footerText } : {}),
            buttons: command.options.map(option => ({
              id: option.id,
              title: option.label,
            })),
          }
        );
    case "list":
      return () =>
        transport.sendWhatsappInteractiveListMessage(
          phoneNumberId,
          accessToken,
          recipient,
          {
            bodyText: command.body,
            buttonText: command.buttonLabel,
            ...(command.headerText ? { headerText: command.headerText } : {}),
            ...(command.footerText ? { footerText: command.footerText } : {}),
            sections: command.sections,
          }
        );
    case "cta_url":
      return () =>
        transport.sendWhatsappInteractiveCtaUrlMessage(
          phoneNumberId,
          accessToken,
          recipient,
          {
            bodyText: command.body,
            buttonUrl: command.url,
            buttonLabel: command.buttonLabel,
            ...(command.header
              ? { header: toTransportHeader(command.header) }
              : {}),
            ...(command.footerText ? { footerText: command.footerText } : {}),
          }
        );
    case "media_carousel":
      return () =>
        transport.sendWhatsappInteractiveMediaCarousel(
          phoneNumberId,
          accessToken,
          recipient,
          {
            bodyText: command.body,
            cards: command.cards.map(card => ({
              media: {
                type: card.media.mediaType,
                link: card.media.url,
              },
              ...(card.bodyText ? { bodyText: card.bodyText } : {}),
              interaction:
                card.interaction.kind === "url"
                  ? {
                      kind: "url" as const,
                      buttonLabel: card.interaction.buttonLabel,
                      url: card.interaction.url,
                    }
                  : {
                      kind: "quick_replies" as const,
                      buttons: card.interaction.options.map(option => ({
                        id: option.id,
                        title: option.label,
                      })),
                    },
            })),
          }
        );
    case "flow": {
      const flowConfig = command.flowConfig;
      const identity = requireFlowIdentity(command, sourceId, wabaId);
      const flowActionType = resolveWhatsAppFlowActionType(flowConfig);
      const flowActionPayload =
        resolveWhatsAppFlowNavigateActionPayload(flowConfig);
      return async () => {
        const result = await transport.sendWhatsappInteractiveFlow(
          phoneNumberId,
          accessToken,
          recipient,
          {
            ...(identity.kind === "flow_id"
              ? { flowId: identity.flow_id }
              : { flowName: identity.flow_name }),
            mode: resolveWhatsAppFlowSendMode(flowConfig),
            ...(command.flowToken ? { flowToken: command.flowToken } : {}),
            flowCta: flowConfig.ctaText,
            bodyText: command.body,
            headerText: flowConfig.headerText,
            footerText: flowConfig.footerText,
            flowActionType,
            ...(flowActionPayload ? { flowActionPayload } : {}),
          }
        );
        return {
          ...result,
          ...(command.flowToken ? { flowTokenUsed: command.flowToken } : {}),
        };
      };
    }
    case "contacts": {
      const contacts = command.contacts.map(buildWhatsAppContactMessagePayload);
      if (contacts.some(contact => !contact)) {
        throw new Error("WhatsApp service contacts contain an invalid card");
      }
      return () =>
        transport.sendWhatsappContacts(
          phoneNumberId,
          accessToken,
          recipient,
          contacts.filter(contact => contact !== null)
        );
    }
    case "location": {
      const location = buildWhatsAppLocationMessagePayload(command.location);
      if (!location) {
        throw new Error("WhatsApp service location is invalid");
      }
      return () =>
        transport.sendWhatsappLocation(
          phoneNumberId,
          accessToken,
          recipient,
          location
        );
    }
    case "location_request":
      return () =>
        transport.sendWhatsappLocationRequest(
          phoneNumberId,
          accessToken,
          recipient,
          command.body
        );
    case "request_contact_info":
      return () =>
        transport.sendWhatsappRequestContactInfo(
          phoneNumberId,
          accessToken,
          recipient,
          command.body
        );
    case "voice_call":
      return () =>
        transport.sendWhatsappVoiceCall(phoneNumberId, accessToken, recipient, {
          bodyText: command.body,
          buttonLabel: command.buttonLabel,
          ttlMinutes: command.ttlMinutes,
          payload: command.payload,
        });
    case "commerce": {
      const commerce = command.commerce;
      switch (commerce.mode) {
        case "catalog":
          return () =>
            transport.sendWhatsappCatalogMessage(
              phoneNumberId,
              accessToken,
              recipient,
              {
                bodyText: commerce.bodyText || "Browse our catalog",
                ...(commerce.footerText
                  ? { footerText: commerce.footerText }
                  : {}),
                ...(commerce.thumbnailProductRetailerId
                  ? {
                      thumbnailProductRetailerId:
                        commerce.thumbnailProductRetailerId,
                    }
                  : {}),
              }
            );
        case "single_product":
          return () =>
            transport.sendWhatsappSingleProductMessage(
              phoneNumberId,
              accessToken,
              recipient,
              commerce
            );
        case "multi_product":
          return () =>
            transport.sendWhatsappMultiProductMessage(
              phoneNumberId,
              accessToken,
              recipient,
              {
                ...commerce,
                sections: commerce.sections.map(section => ({
                  title: section.title,
                  productRetailerIds: section.productRetailerIds,
                })),
              }
            );
        case "product_carousel":
          return () =>
            transport.sendWhatsappProductCarouselMessage(
              phoneNumberId,
              accessToken,
              recipient,
              commerce
            );
        default: {
          const exhaustive: never = commerce;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export async function dispatchWhatsAppServiceMessage(
  input: DispatchWhatsAppServiceMessageInput,
  transport: WhatsAppServiceMessageTransport = whatsappApi
) {
  const dispatch = prepareWhatsAppServiceTransport(input, transport);
  await input.beforeSend?.();
  return dispatch();
}
