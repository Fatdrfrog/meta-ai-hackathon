export const WHATSAPP_TEMPLATES_CONNECTION_REQUIRED_CODE =
  "whatsapp_not_connected";

export type WhatsAppTemplatesConnectionRequiredPayload = {
  code?: string;
  requiresWhatsAppConnection?: boolean;
};

export function isWhatsAppTemplatesConnectionRequiredPayload(
  payload: WhatsAppTemplatesConnectionRequiredPayload | null | undefined
) {
  return Boolean(
    payload?.requiresWhatsAppConnection ||
      payload?.code === WHATSAPP_TEMPLATES_CONNECTION_REQUIRED_CODE
  );
}
