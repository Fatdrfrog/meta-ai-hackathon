import {
  DEFAULT_FLOW_BODY_TEXT,
  DEFAULT_FLOW_CTA_TEXT,
} from "@/lib/scenarios/normalization";
import { htmlToWhatsAppFormat } from "@/lib/whatsapp-format";
import {
  pickWhatsAppInteractiveFlowIdentity,
  WHATSAPP_FLOW_LIMITS,
  WHATSAPP_FLOW_MESSAGE_VERSION,
} from "@icecore/shared/types/whatsapp-flows";
import { WhatsAppFlowActionType } from "@icecore/shared/types/whatsapp";
import { readNonEmptyStringOrUndefined } from "@icecore/shared/lib/value-utils";

export type WhatsAppFlowMode = "draft" | "published";

type BuildWhatsAppInteractiveFlowPayloadParams = {
  bodyText?: string;
  flowActionPayload?: Record<string, unknown>;
  flowActionType?: WhatsAppFlowActionType;
  flowCta?: string;
  flowId?: string;
  flowName?: string;
  mode?: WhatsAppFlowMode;
  flowToken: string;
  footerText?: string;
  headerText?: string;
};

type NavigateFlowActionPayload = {
  data?: Record<string, unknown>;
  screen?: string;
};

function asNonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) => entry !== undefined
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

export function normalizeWhatsAppFlowActionPayload(
  flowActionType: WhatsAppFlowActionType,
  payload: Record<string, unknown> | undefined
): NavigateFlowActionPayload | undefined {
  if (flowActionType !== "navigate") {
    return undefined;
  }

  const screen = readNonEmptyStringOrUndefined(payload?.screen);
  const data = asNonEmptyRecord(payload?.data);

  if (!screen && !data) {
    return undefined;
  }

  return {
    ...(screen ? { screen } : {}),
    ...(data ? { data } : {}),
  };
}

export function buildWhatsAppInteractiveFlowPayload({
  bodyText,
  flowActionPayload,
  flowActionType,
  flowCta,
  flowId,
  flowName,
  mode,
  flowToken,
  footerText,
  headerText,
}: BuildWhatsAppInteractiveFlowPayloadParams) {
  const identity = pickWhatsAppInteractiveFlowIdentity({
    flow_id: flowId,
    flow_name: flowName,
  });
  if (!identity) {
    throw new Error("flow_id or flow_name is required for a WhatsApp Flow message");
  }

  const normalizedFlowActionType: WhatsAppFlowActionType =
    flowActionType === "data_exchange" ? "data_exchange" : "navigate";
  const normalizedFlowActionPayload = normalizeWhatsAppFlowActionPayload(
    normalizedFlowActionType,
    flowActionPayload
  );

  const parameters: Record<string, unknown> = {
    flow_message_version: WHATSAPP_FLOW_MESSAGE_VERSION,
    flow_token: flowToken,
    ...(identity.kind === "flow_id"
      ? { flow_id: identity.flow_id }
      : { flow_name: identity.flow_name }),
    flow_cta: htmlToWhatsAppFormat(
      readNonEmptyStringOrUndefined(flowCta) || DEFAULT_FLOW_CTA_TEXT
    ).slice(0, WHATSAPP_FLOW_LIMITS.INTERACTIVE_CTA_MAX_LENGTH),
    flow_action: normalizedFlowActionType,
  };

  if (mode === "draft" || mode === "published") {
    parameters.mode = mode;
  }

  if (normalizedFlowActionPayload) {
    parameters.flow_action_payload = normalizedFlowActionPayload;
  }

  const interactivePayload: Record<string, unknown> = {
    type: "flow",
    body: {
      text: htmlToWhatsAppFormat(
        readNonEmptyStringOrUndefined(bodyText) || DEFAULT_FLOW_BODY_TEXT
      ).slice(0, WHATSAPP_FLOW_LIMITS.BODY_TEXT_MAX_LENGTH),
    },
    action: {
      name: "flow",
      parameters,
    },
  };

  const normalizedHeaderText = readNonEmptyStringOrUndefined(headerText);
  if (normalizedHeaderText) {
    interactivePayload.header = {
      type: "text",
      text: normalizedHeaderText.slice(
        0,
        WHATSAPP_FLOW_LIMITS.HEADER_TEXT_MAX_LENGTH
      ),
    };
  }

  const normalizedFooterText = readNonEmptyStringOrUndefined(footerText);
  if (normalizedFooterText) {
    interactivePayload.footer = {
      text: htmlToWhatsAppFormat(normalizedFooterText).slice(
        0,
        WHATSAPP_FLOW_LIMITS.FOOTER_TEXT_MAX_LENGTH
      ),
    };
  }

  return interactivePayload;
}
