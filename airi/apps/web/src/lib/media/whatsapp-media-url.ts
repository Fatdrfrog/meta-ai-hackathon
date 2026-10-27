type WhatsAppMediaProxyRef = {
  conversationId: string;
  mediaId: string;
  fileName: string | null;
};

type MessageMediaUrlCandidate = {
  imageUrl?: string | null;
  attachments?: Array<{ url?: string | null }> | null;
};

const WHATSAPP_MEDIA_PROXY_PATH =
  /^\/api\/conversations\/([^/]+)\/whatsapp-media\/([^/?#]+)$/;

export function buildWhatsAppMediaProxyUrl(
  conversationId: string,
  mediaId: string,
  fileName?: string | null
): string {
  const base = `/api/conversations/${encodeURIComponent(
    conversationId
  )}/whatsapp-media/${encodeURIComponent(mediaId)}`;
  const params = new URLSearchParams();

  const normalizedFileName = fileName?.trim();
  if (normalizedFileName) {
    params.set("filename", normalizedFileName);
  }

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function parseWhatsAppMediaProxyUrl(
  value: string | null | undefined
): WhatsAppMediaProxyRef | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let pathname = "";
  let search = "";
  try {
    const parsed = new URL(trimmed, "http://internal.local");
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    return null;
  }

  const match = pathname.match(WHATSAPP_MEDIA_PROXY_PATH);
  if (!match) return null;

  return {
    conversationId: decodeURIComponent(match[1] || ""),
    mediaId: decodeURIComponent(match[2] || ""),
    fileName: new URLSearchParams(search).get("filename"),
  };
}

export function isHttpOrHttpsUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^https?:\/\//i.test(trimmed);
}

function isDurableMediaUrl(value: string | null | undefined): boolean {
  return isHttpOrHttpsUrl(value) && !parseWhatsAppMediaProxyUrl(value);
}

export function resolveDurableMessageMediaUrl(
  message: MessageMediaUrlCandidate | null | undefined
): string | null {
  const candidates = [
    message?.imageUrl,
    ...(Array.isArray(message?.attachments)
      ? message.attachments.map(attachment => attachment?.url)
      : []),
  ];

  for (const candidate of candidates) {
    if (isDurableMediaUrl(candidate)) {
      return candidate?.trim() || null;
    }
  }

  return null;
}
