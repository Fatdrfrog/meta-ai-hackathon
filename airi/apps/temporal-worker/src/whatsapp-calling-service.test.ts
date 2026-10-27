import assert from "node:assert/strict";
import test from "node:test";

import { createWhatsAppCallingService } from "@icecore/airi-runtime/whatsapp-calling-service";

function createLogger() {
  return {
    error() {},
    info() {},
  };
}

test("sends WhatsApp call answer commands through the runtime Graph client", async () => {
  const calls: Array<{ path: string; body?: unknown; token: string }> = [];
  const service = createWhatsAppCallingService({
    graphClient: {
      getJson: async () => {
        throw new Error("not used");
      },
      postJson: async <T>(
        path: string,
        options: { token: string; body?: unknown },
      ) => {
        calls.push({ path, body: options.body, token: options.token });
        return { ok: true } as T;
      },
    },
    logger: createLogger(),
  });

  const result = await service.preAcceptWhatsAppCall({
    accessToken: "token-1",
    callId: "wacid.1",
    correlationId: "command-1",
    phoneNumberId: "phone-1",
    sdp: "answer-sdp",
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    {
      path: "phone-1/calls",
      token: "token-1",
      body: {
        action: "pre_accept",
        call_id: "wacid.1",
        messaging_product: "whatsapp",
        session: {
          sdp: "answer-sdp",
          sdp_type: "answer",
        },
      },
    },
  ]);
});

test("enables calling defaults with voicemail options", async () => {
  const calls: Array<{ path: string; body?: unknown; token: string }> = [];
  const service = createWhatsAppCallingService({
    graphClient: {
      getJson: async () => {
        throw new Error("not used");
      },
      postJson: async <T>(
        path: string,
        options: { token: string; body?: unknown },
      ) => {
        calls.push({ path, body: options.body, token: options.token });
        return { success: true } as T;
      },
    },
    logger: createLogger(),
  });

  const result = await service.enablePhoneCallingDefaults(
    "phone-1",
    "token-1",
    {
      voicemail: {
        announcementMediaId: "media-1",
        timeoutSeconds: 40,
        triggers: ["TIMEOUT", "REJECT", "TIMEOUT"],
      },
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls[0], {
    path: "phone-1/settings",
    token: "token-1",
    body: {
      calling: {
        call_icon_visibility: "DEFAULT",
        callback_permission_status: "ENABLED",
        status: "ENABLED",
        voicemail: {
          audio: {
            default: {
              announcement_media_id: "media-1",
              timeout_seconds: 30,
            },
          },
          status: "ENABLED",
          triggers: ["TIMEOUT", "REJECT"],
        },
      },
    },
  });
});
