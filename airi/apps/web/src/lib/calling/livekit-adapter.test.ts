import { createHmac } from "crypto";
import {
  buildWhatsAppCallParticipantIdentity,
  buildWhatsAppCallRoomName,
  createLiveKitConnectorClient,
  createWhatsAppCallRoom,
  mintLiveKitMediaToken,
  resolveLiveKitMediaTokenTtlSeconds,
  resolveLiveKitCallingConfigFromEnv,
} from "./livekit-adapter";

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function verifyHs256Jwt(token: string, secret: string) {
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  const expectedSignature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  expect(signature).toBe(expectedSignature);
  return JSON.parse(base64UrlDecode(encodedPayload));
}

describe("LiveKit WhatsApp calling adapter", () => {
  it("creates deterministic room names without leaking provider call ids", () => {
    const first = buildWhatsAppCallRoomName({
      workspaceId: "workspace_1",
      callId: "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
    });
    const second = buildWhatsAppCallRoomName({
      workspaceId: "workspace_1",
      callId: "wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^wa-call-[a-f0-9]{32}$/);
    expect(first).not.toContain("workspace_1");
    expect(first).not.toContain("wacid");
  });

  it("mints a short-lived media token scoped to one room", async () => {
    const token = await mintLiveKitMediaToken({
      apiKey: "api-key-1",
      apiSecret: "secret-1",
      roomName: "wa-call-123",
      identity: "participant-workspace_1",
      ttlSeconds: 300,
      nowSeconds: 1_770_000_000,
    });

    const payload = verifyHs256Jwt(token, "secret-1");

    expect(payload).toMatchObject({
      iss: "api-key-1",
      sub: "participant-workspace_1",
      nbf: 1_770_000_000,
      exp: 1_770_000_300,
      video: {
        room: "wa-call-123",
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      },
    });
  });

  it("builds stable participant identities without exposing workspace or user ids", () => {
    const first = buildWhatsAppCallParticipantIdentity({
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    const second = buildWhatsAppCallParticipantIdentity({
      workspaceId: "workspace_1",
      userId: "user_1",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^wa-participant-[a-f0-9]{32}$/);
    expect(first).not.toContain("workspace_1");
    expect(first).not.toContain("user_1");
  });

  it("keeps media token TTLs bounded", () => {
    expect(resolveLiveKitMediaTokenTtlSeconds(10)).toBe(60);
    expect(resolveLiveKitMediaTokenTtlSeconds(300)).toBe(300);
    expect(resolveLiveKitMediaTokenTtlSeconds(null)).toBe(600);
  });

  it("defaults and normalizes the WhatsApp Cloud API version for LiveKit Connector calls", () => {
    expect(
      resolveLiveKitCallingConfigFromEnv({
        NODE_ENV: "test",
        LIVEKIT_URL: "wss://livekit.example.com",
        LIVEKIT_API_KEY: "api-key-1",
        LIVEKIT_API_SECRET: "secret-1",
      } as NodeJS.ProcessEnv)?.whatsappCloudApiVersion
    ).toBe("24.0");

    expect(
      resolveLiveKitCallingConfigFromEnv({
        NODE_ENV: "test",
        LIVEKIT_URL: "wss://livekit.example.com",
        LIVEKIT_API_KEY: "api-key-1",
        LIVEKIT_API_SECRET: "secret-1",
        LIVEKIT_WHATSAPP_CLOUD_API_VERSION: "v23.0",
      } as NodeJS.ProcessEnv)?.whatsappCloudApiVersion
    ).toBe("23.0");
  });

  it("creates or reuses a call room and sends the official WhatsApp connector request", async () => {
    const client = {
      ensureRoom: jest.fn().mockResolvedValue({
        roomName: "wa-call-existing",
      }),
      startWhatsAppConnector: jest.fn().mockResolvedValue({
        connectorSessionId: "connector-1",
        roomName: "wa-call-existing",
      }),
    };

    const result = await createWhatsAppCallRoom({
      workspaceId: "workspace_1",
      callId: "wacid.1",
      whatsappSdpOffer: "v=0\r\noffer",
      whatsappPhoneNumberId: "phone-number-1",
      whatsappApiKey: "meta-token-1",
      liveKit: {
        url: "wss://livekit.example.com",
        apiKey: "api-key-1",
        apiSecret: "secret-1",
        whatsappCloudApiVersion: "24.0",
      },
      client,
      nowSeconds: 1_770_000_000,
    });

    expect(client.ensureRoom).toHaveBeenCalledWith({
      roomName: result.roomName,
      metadata: {
        workspaceId: "workspace_1",
        callId: "wacid.1",
        provider: "whatsapp",
      },
    });
    expect(client.startWhatsAppConnector).toHaveBeenCalledWith({
      roomName: result.roomName,
      whatsappPhoneNumberId: "phone-number-1",
      whatsappApiKey: "meta-token-1",
      whatsappCloudApiVersion: "24.0",
      whatsappCallId: "wacid.1",
      sdp: "v=0\r\noffer",
      participantIdentity: expect.stringMatching(
        /^wa-participant-[a-f0-9]{32}$/
      ),
    });
    expect(result).toEqual({
      roomName: expect.stringMatching(/^wa-call-[a-f0-9]{32}$/),
      connectorSessionId: "connector-1",
      sdpAnswer: null,
      acceptedByConnector: true,
    });
  });

  it("accepts inbound WhatsApp calls through the LiveKit Connector Twirp API", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ roomName: "wa-call-123" }),
      text: async () => "",
      headers: { get: () => "application/json" },
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;

    try {
      const client = createLiveKitConnectorClient({
        url: "wss://livekit.example.com",
        apiKey: "api-key-1",
        apiSecret: "secret-1",
      });

      const result = await client.startWhatsAppConnector({
        roomName: "wa-call-123",
        whatsappPhoneNumberId: "phone-number-1",
        whatsappApiKey: "meta-token-1",
        whatsappCloudApiVersion: "23.0",
        whatsappCallId: "wacid.1",
        sdp: "v=0\r\noffer",
        participantIdentity: "operator-1",
      });

      expect(result).toEqual({
        roomName: "wa-call-123",
        connectorSessionId: null,
        sdpAnswer: null,
        acceptedByConnector: true,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://livekit.example.com/twirp/livekit.Connector/AcceptWhatsAppCall",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json;charset=UTF-8",
            Authorization: expect.stringMatching(/^Bearer /),
          }),
          body: JSON.stringify({
            whatsappPhoneNumberId: "phone-number-1",
            whatsappApiKey: "meta-token-1",
            whatsappCloudApiVersion: "23.0",
            whatsappCallId: "wacid.1",
            sdp: {
              type: "offer",
              sdp: "v=0\r\noffer",
            },
            roomName: "wa-call-123",
            participantIdentity: "operator-1",
          }),
        })
      );

      const authorization = (
        fetchMock.mock.calls[0][1].headers as Record<string, string>
      ).Authorization;
      const tokenPayload = verifyHs256Jwt(
        authorization.replace(/^Bearer\s+/, ""),
        "secret-1"
      );
      expect(tokenPayload.video).toMatchObject({ roomCreate: true });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
