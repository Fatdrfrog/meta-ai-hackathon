export type PostmarkInboundAttachment = {
  Name: string;
  Content?: string; // base64
  ContentLink?: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string; // for inline images
};

export type PostmarkInboundPayload = {
  From: string;
  FromFull?: { Email: string; Name?: string };
  To: string;
  Cc?: string;
  Bcc?: string;
  Subject?: string;
  MessageID: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: PostmarkInboundAttachment[];
  ReceivedAt?: string; // ISO date string per Postmark payload
};

export type PostmarkOutboundPayload = {
  RecordType: string;
  MessageID?: string;
  MessageStream?: string;
  Recipient?: string;
  ReceivedAt?: string;
  DeliveredAt?: string;
  BouncedAt?: string;
  OriginalRecipient?: string;
  Details?: string;
  Subject?: string;
  Tag?: string;
  Metadata?: Record<string, string>;
  [key: string]: unknown;
};

export type PostmarkSendParams = {
  from: string;
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  messageStream?: string; // e.g., 'outbound'
  serverToken?: string;
};

export const POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY = "airi_msg_id";
export const LEGACY_POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY =
  "airi_campaign_message_id";

export type PostmarkBulkMessage = {
  to: string;
  templateModel?: Record<string, string>;
  metadata?: Record<string, string>;
  headers?: Record<string, string>;
};

export type PostmarkBulkEmailParams = {
  serverToken?: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  messageStream?: string;
  messages: PostmarkBulkMessage[];
  metadata?: Record<string, string>;
  headers?: Record<string, string>;
  trackOpens?: boolean;
  trackLinks?: "None" | "HtmlAndText" | "HtmlOnly" | "TextOnly";
  tag?: string;
  inlineCss?: boolean;
};

export type PostmarkBulkEmailError = {
  ErrorCode?: number;
  Message?: string;
};

export type PostmarkBulkEmailResponse = {
  ID: string;
  Status: "Accepted" | "Failed" | string;
  SubmittedAt: string;
  Errors?: Record<string, PostmarkBulkEmailError[]>;
};

const POSTMARK_BASE = "https://api.postmarkapp.com";

function normalizePostmarkError(
  status: number,
  rawBody: string
): { message: string; code?: number } {
  let msg: string | undefined;
  let code: number | undefined;
  const details: string[] = [];

  try {
    const json = JSON.parse(rawBody) as {
      Message?: string;
      ErrorCode?: number;
      Errors?: Record<string, Array<{ ErrorCode?: number; Message?: string }>>;
    };
    msg = json.Message;
    code = json.ErrorCode;
    if (json.Errors && typeof json.Errors === "object") {
      for (const [field, errors] of Object.entries(json.Errors)) {
        if (!Array.isArray(errors)) continue;
        for (const error of errors) {
          const message = String(error?.Message || "").trim();
          if (!message) continue;
          details.push(
            `${field}: ${message}${typeof error?.ErrorCode === "number" ? ` (code ${error.ErrorCode})` : ""}`
          );
        }
      }
    }
  } catch {}

  const detail = [msg || rawBody || "Unknown error", ...details]
    .filter(Boolean)
    .join("; ");
  return {
    message: `Postmark request failed: ${status} ${detail}${typeof code === "number" ? ` (code ${code})` : ""}`,
    code,
  };
}

export function getPostmarkServerToken(): string {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) throw new Error("POSTMARK_SERVER_TOKEN is not configured");
  return token;
}

function resolveServerToken(explicit?: string): string {
  const token = String(explicit || "").trim();
  if (token) return token;
  return getPostmarkServerToken();
}

export async function postmarkValidateServerToken(params: {
  serverToken: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = resolveServerToken(params.serverToken);
  const response = await fetch(`${POSTMARK_BASE}/server`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Postmark-Server-Token": token,
    },
  });

  if (response.ok) {
    return { ok: true };
  }

  const raw = await response.text();
  const normalized = normalizePostmarkError(response.status, raw);
  return { ok: false, error: normalized.message };
}

export async function postmarkSendEmail(
  params: PostmarkSendParams
): Promise<{ MessageID: string }> {
  const token = resolveServerToken(params.serverToken);
  const response = await fetch(`${POSTMARK_BASE}/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: params.from,
      To: Array.isArray(params.to) ? params.to.join(",") : params.to,
      Subject: params.subject,
      TextBody: params.text,
      HtmlBody: params.html,
      Metadata: params.metadata,
      MessageStream: params.messageStream || "outbound",
      Headers: params.headers
        ? Object.entries(params.headers).map(([Name, Value]) => ({
            Name,
            Value,
          }))
        : undefined,
    }),
  });
  if (!response.ok) {
    const raw = await response.text();
    const normalized = normalizePostmarkError(response.status, raw);
    throw new Error(normalized.message);
  }
  return response.json();
}

function recordToHeaderArray(record: Record<string, string> | undefined) {
  return record
    ? Object.entries(record).map(([Name, Value]) => ({ Name, Value }))
    : undefined;
}

export async function postmarkSendBulkEmails(
  params: PostmarkBulkEmailParams
): Promise<PostmarkBulkEmailResponse> {
  const token = resolveServerToken(params.serverToken);
  const response = await fetch(`${POSTMARK_BASE}/email/bulk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: params.from,
      Subject: params.subject,
      HtmlBody: params.html,
      TextBody: params.text,
      MessageStream: params.messageStream || "broadcast",
      Metadata: params.metadata,
      Headers: recordToHeaderArray(params.headers),
      TrackOpens: params.trackOpens,
      TrackLinks: params.trackLinks,
      Tag: params.tag,
      InlineCss: params.inlineCss,
      Messages: params.messages.map(message => ({
        To: message.to,
        TemplateModel: message.templateModel,
        Metadata: message.metadata,
        Headers: recordToHeaderArray(message.headers),
      })),
    }),
  });

  if (!response.ok) {
    const raw = await response.text();
    const normalized = normalizePostmarkError(response.status, raw);
    throw new Error(normalized.message);
  }

  return response.json();
}

export function isTrustedPostmarkIp(ip: string | null): boolean {
  if (!ip) return false;
  const allowCidrs = process.env.POSTMARK_TRUSTED_CIDRS?.split(",").map(s =>
    s.trim()
  );
  if (!allowCidrs || allowCidrs.length === 0) return true;
  return allowCidrs.includes(ip);
}
