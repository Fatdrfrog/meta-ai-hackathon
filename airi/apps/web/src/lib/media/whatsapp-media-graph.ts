import {
  getWhatsAppGraphClient,
  MetaGraphRequestError,
} from "@icecore/shared/lib/meta/api";

type WhatsAppMediaInfo = {
  url: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number | string;
  id?: string;
};

type WhatsAppMediaFetchResult = {
  mediaInfo: WhatsAppMediaInfo;
  response: Response;
};

const graphClient = getWhatsAppGraphClient();

export function isPermanentWhatsAppMediaProviderError(error: unknown): boolean {
  if (!(error instanceof MetaGraphRequestError)) return false;
  if (error.status === 404) return true;
  if (error.status !== 400) return false;

  const message = [
    error.message,
    typeof error.details === "string" ? error.details : "",
    error.metaError?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    message.includes("unsupported get request") ||
    message.includes("does not exist") ||
    message.includes("missing permissions")
  );
}

export async function getWhatsAppMediaInfoFromMeta(params: {
  mediaId: string;
  accessToken: string;
  phoneNumberId?: string | null;
}): Promise<WhatsAppMediaInfo> {
  const mediaId = params.mediaId.trim();
  if (!mediaId) {
    throw new Error("Missing WhatsApp media id");
  }

  const phoneNumberId = params.phoneNumberId?.trim();
  return graphClient.getJson<WhatsAppMediaInfo>(mediaId, {
    token: params.accessToken,
    ...(phoneNumberId ? { query: { phone_number_id: phoneNumberId } } : {}),
  });
}

export async function downloadWhatsAppMediaUrl(params: {
  mediaUrl: string;
  accessToken: string;
}): Promise<Response> {
  return fetch(params.mediaUrl, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
}

export async function fetchWhatsAppMediaFromMeta(params: {
  mediaId: string;
  accessToken: string;
  phoneNumberId?: string | null;
}): Promise<WhatsAppMediaFetchResult> {
  const mediaInfo = await getWhatsAppMediaInfoFromMeta(params);
  const response = await downloadWhatsAppMediaUrl({
    mediaUrl: mediaInfo.url,
    accessToken: params.accessToken,
  });

  return { mediaInfo, response };
}
