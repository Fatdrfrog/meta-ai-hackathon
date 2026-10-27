import type { WhatsAppCallWebhookEvent } from "@icecore/shared/lib/whatsapp/webhook-call-events";

// Shared fixtures for the WhatsApp call session reducer and conversation
// linker suites.

export function execResult<T>(value: T) {
  return {
    exec: async () => value,
  };
}

export function buildCallEvent(
  overrides: Partial<WhatsAppCallWebhookEvent> = {},
): WhatsAppCallWebhookEvent {
  return {
    kind: "call",
    callId: "wacid.1",
    event: "connect",
    status: null,
    direction: "USER_INITIATED",
    from: null,
    to: null,
    fromUserId: "US.1349.private",
    fromParentUserId: "US.parent.private",
    toUserId: "US.1349.business",
    toParentUserId: "US.parent.business",
    recipientId: null,
    recipientUserId: null,
    recipientParentUserId: null,
    contactUserId: "US.1349.private",
    contactParentUserId: "US.parent.private",
    contactWaId: null,
    contactName: "Private Customer",
    contactUsername: "private_customer",
    countryCode: "US",
    timestamp: "1770000000",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    bizOpaqueCallbackData: "call:workspace-1:wacid.1",
    sessionSdpType: "offer",
    sessionSdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
    durationSeconds: null,
    errorCode: null,
    errorMessage: null,
    rawEvent: {
      id: "wacid.1",
      event: "connect",
    },
    ...overrides,
  };
}
