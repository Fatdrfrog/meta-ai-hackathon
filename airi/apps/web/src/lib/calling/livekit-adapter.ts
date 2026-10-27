import {
  buildWhatsAppCallParticipantIdentity,
  buildWhatsAppCallRoomName,
  mintLiveKitAccessToken,
  normalizeLiveKitHttpUrl,
  resolveLiveKitTokenTtlSeconds,
} from "@icecore/airi-runtime/whatsapp-calling";

export { buildWhatsAppCallParticipantIdentity, buildWhatsAppCallRoomName };

export type LiveKitCallingConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
  whatsappCloudApiVersion?: string | null;
  mediaTokenTtlSeconds?: number | null;
};

export type LiveKitEnsureRoomRequest = {
  roomName: string;
  metadata: {
    workspaceId: string;
    callId: string;
    provider: "whatsapp";
  };
};

export type LiveKitWhatsAppConnectorRequest = {
  roomName: string;
  whatsappPhoneNumberId: string;
  whatsappApiKey: string;
  whatsappCloudApiVersion: string;
  whatsappCallId: string;
  sdp: string;
  participantIdentity: string;
};

export type LiveKitWhatsAppConnectorClient = {
  ensureRoom(input: LiveKitEnsureRoomRequest): Promise<{ roomName?: string }>;
  startWhatsAppConnector(input: LiveKitWhatsAppConnectorRequest): Promise<{
    roomName?: string | null;
    connectorSessionId?: string | null;
    sdpAnswer?: string | null;
    acceptedByConnector?: boolean | null;
  }>;
};

export type CreateWhatsAppCallRoomParams = {
  workspaceId: string;
  callId: string;
  whatsappSdpOffer: string;
  whatsappPhoneNumberId: string;
  whatsappApiKey: string;
  whatsappCloudApiVersion?: string | null;
  liveKit: LiveKitCallingConfig;
  client: LiveKitWhatsAppConnectorClient;
  nowSeconds?: number;
};

export const DEFAULT_MEDIA_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_SERVICE_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_WHATSAPP_CONNECTOR_CLOUD_API_VERSION = "24.0";

export function resolveLiveKitMediaTokenTtlSeconds(
  ttlSeconds?: number | null
): number {
  return resolveLiveKitTokenTtlSeconds(
    ttlSeconds || DEFAULT_MEDIA_TOKEN_TTL_SECONDS
  );
}

export async function mintLiveKitMediaToken(params: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  ttlSeconds?: number | null;
  nowSeconds?: number;
}): Promise<string> {
  const nowSeconds = params.nowSeconds || Math.floor(Date.now() / 1000);
  const ttlSeconds = resolveLiveKitMediaTokenTtlSeconds(params.ttlSeconds);

  return mintLiveKitAccessToken({
    apiKey: params.apiKey,
    apiSecret: params.apiSecret,
    identity: params.identity,
    nowSeconds,
    ttlSeconds,
    videoGrant: {
      room: params.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
  });
}

async function mintLiveKitServiceToken(params: {
  apiKey: string;
  apiSecret: string;
  videoGrant: Record<string, unknown>;
  ttlSeconds?: number | null;
  nowSeconds?: number;
}): Promise<string> {
  const nowSeconds = params.nowSeconds || Math.floor(Date.now() / 1000);
  const ttlSeconds = resolveLiveKitMediaTokenTtlSeconds(
    params.ttlSeconds || DEFAULT_SERVICE_TOKEN_TTL_SECONDS
  );

  return mintLiveKitAccessToken({
    apiKey: params.apiKey,
    apiSecret: params.apiSecret,
    nowSeconds,
    ttlSeconds,
    videoGrant: params.videoGrant,
  });
}

function normalizeWhatsAppConnectorCloudApiVersion(
  value?: string | null
): string {
  const normalized = String(value || "")
    .trim()
    .replace(/^v/i, "");
  return normalized || DEFAULT_WHATSAPP_CONNECTOR_CLOUD_API_VERSION;
}

async function readLiveKitJsonResponse<TResponse>(
  response: Response
): Promise<TResponse> {
  if (response.ok) {
    return (await response.json()) as TResponse;
  }

  let message = response.statusText || "LiveKit Connector request failed";
  try {
    const text = await response.text();
    if (text) {
      const parsed = JSON.parse(text) as { msg?: unknown; message?: unknown };
      message = String(parsed.msg || parsed.message || text);
    }
  } catch {
    // Keep the status text when the Twirp error body is not parseable.
  }

  throw new Error(
    `LiveKit Connector returned HTTP ${response.status}: ${message}`
  );
}

export function createLiveKitConnectorClient(
  liveKit: LiveKitCallingConfig
): LiveKitWhatsAppConnectorClient {
  const host = normalizeLiveKitHttpUrl(liveKit.url).replace(/\/+$/, "");

  return {
    async ensureRoom(input) {
      return { roomName: input.roomName };
    },
    async startWhatsAppConnector(input) {
      const token = await mintLiveKitServiceToken({
        apiKey: liveKit.apiKey,
        apiSecret: liveKit.apiSecret,
        videoGrant: { roomCreate: true },
      });
      const response = await fetch(
        `${host}/twirp/livekit.Connector/AcceptWhatsAppCall`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            whatsappPhoneNumberId: input.whatsappPhoneNumberId,
            whatsappApiKey: input.whatsappApiKey,
            whatsappCloudApiVersion: input.whatsappCloudApiVersion,
            whatsappCallId: input.whatsappCallId,
            sdp: {
              type: "offer",
              sdp: input.sdp,
            },
            roomName: input.roomName,
            participantIdentity: input.participantIdentity,
          }),
        }
      );
      const parsed = await readLiveKitJsonResponse<{
        roomName?: string | null;
      }>(response);

      return {
        roomName: parsed.roomName || null,
        connectorSessionId: null,
        sdpAnswer: null,
        acceptedByConnector: Boolean(parsed.roomName),
      };
    },
  };
}

export async function createWhatsAppCallRoom(
  params: CreateWhatsAppCallRoomParams
): Promise<{
  roomName: string;
  connectorSessionId: string | null;
  sdpAnswer: string | null;
  acceptedByConnector: boolean;
}> {
  const roomName = buildWhatsAppCallRoomName({
    workspaceId: params.workspaceId,
    callId: params.callId,
  });
  const participantIdentity = buildWhatsAppCallParticipantIdentity({
    workspaceId: params.workspaceId,
    userId: `connector:${params.callId}`,
  });

  await params.client.ensureRoom({
    roomName,
    metadata: {
      workspaceId: params.workspaceId,
      callId: params.callId,
      provider: "whatsapp",
    },
  });

  const connector = await params.client.startWhatsAppConnector({
    roomName,
    whatsappPhoneNumberId: params.whatsappPhoneNumberId,
    whatsappApiKey: params.whatsappApiKey,
    whatsappCloudApiVersion: normalizeWhatsAppConnectorCloudApiVersion(
      params.whatsappCloudApiVersion || params.liveKit.whatsappCloudApiVersion
    ),
    whatsappCallId: params.callId,
    sdp: params.whatsappSdpOffer,
    participantIdentity,
  });

  const connectorRoomName = connector.roomName || null;
  return {
    roomName,
    connectorSessionId: connector.connectorSessionId || null,
    sdpAnswer: connector.sdpAnswer || null,
    acceptedByConnector: Boolean(
      connector.acceptedByConnector || connectorRoomName
    ),
  };
}

export function resolveLiveKitCallingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): LiveKitCallingConfig | null {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;

  const ttlSeconds = Number.parseInt(
    env.LIVEKIT_MEDIA_TOKEN_TTL_SECONDS || "",
    10
  );

  return {
    url,
    apiKey,
    apiSecret,
    whatsappCloudApiVersion: normalizeWhatsAppConnectorCloudApiVersion(
      env.LIVEKIT_WHATSAPP_CLOUD_API_VERSION
    ),
    mediaTokenTtlSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : null,
  };
}
