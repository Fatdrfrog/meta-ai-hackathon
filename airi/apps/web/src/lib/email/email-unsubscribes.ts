import {
  isValidCampaignEmailAddress,
  normalizeCampaignEmail,
} from "@/lib/campaign/campaign-recipient-utils";
import crypto from "crypto";

const EMAIL_UNSUBSCRIBE_LOOKUP_CHUNK_SIZE = 500;

export type EmailUnsubscribeStoreClient = {
  from: (table: string) => unknown;
};

type EmailStoreError = { message?: string | null };

type EmailUnsubscribeSelectResult = {
  data?: Array<{ email?: string | null }> | null;
  error?: EmailStoreError | null;
};

type EmailUnsubscribeTable = {
  select: (columns: string) => {
    eq: (
      column: string,
      value: string
    ) => {
      in: (
        column: string,
        values: string[]
      ) => PromiseLike<EmailUnsubscribeSelectResult>;
    };
  };
  upsert: (
    payload: Record<string, unknown>,
    options: { onConflict: string }
  ) => PromiseLike<{ error?: EmailStoreError | null }>;
};

export type EmailUnsubscribeTokenPayload = {
  v: 1;
  workspaceId: string;
  email: string;
  campaignId?: string | null;
  iat: number;
};

function getEmailUnsubscribeSecret(): string {
  const secret =
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.ENCRYPTION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";

  if (!secret) {
    throw new Error(
      "Missing email unsubscribe signing secret. Set EMAIL_UNSUBSCRIBE_SECRET or ENCRYPTION_SECRET."
    );
  }

  return secret;
}

function signPayload(payloadBase64: string): string {
  return crypto
    .createHmac("sha256", getEmailUnsubscribeSecret())
    .update(payloadBase64)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function isTokenPayload(value: unknown): value is EmailUnsubscribeTokenPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    typeof candidate.email === "string" &&
    isValidCampaignEmailAddress(candidate.email) &&
    (candidate.campaignId === undefined ||
      candidate.campaignId === null ||
      typeof candidate.campaignId === "string") &&
    typeof candidate.iat === "number" &&
    Number.isFinite(candidate.iat)
  );
}

export function normalizeEmailUnsubscribeAddress(email: string): string {
  return normalizeCampaignEmail(email);
}

export function createEmailUnsubscribeToken(input: {
  workspaceId: string;
  email: string;
  campaignId?: string | null;
}): string {
  const payload: EmailUnsubscribeTokenPayload = {
    v: 1,
    workspaceId: input.workspaceId,
    email: normalizeEmailUnsubscribeAddress(input.email),
    campaignId: input.campaignId || null,
    iat: Math.floor(Date.now() / 1000),
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${payloadBase64}.${signPayload(payloadBase64)}`;
}

export function verifyEmailUnsubscribeToken(token: string): {
  valid: boolean;
  payload?: EmailUnsubscribeTokenPayload;
  reason?: string;
} {
  const [payloadBase64, signature] = String(token || "").split(".");
  if (!payloadBase64 || !signature) {
    return { valid: false, reason: "Malformed token" };
  }

  const expectedSignature = signPayload(payloadBase64);
  if (!safeEqual(signature, expectedSignature)) {
    return { valid: false, reason: "Invalid signature" };
  }

  try {
    const payloadRaw = Buffer.from(payloadBase64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw);
    if (!isTokenPayload(payload)) {
      return { valid: false, reason: "Invalid payload" };
    }
    return {
      valid: true,
      payload: {
        ...payload,
        email: normalizeEmailUnsubscribeAddress(payload.email),
      },
    };
  } catch {
    return { valid: false, reason: "Failed to decode token" };
  }
}

export function buildEmailUnsubscribeUrl(input: {
  baseUrl: string;
  workspaceId: string;
  email: string;
  campaignId?: string | null;
}): string {
  const base = new URL(input.baseUrl);
  base.pathname = "/api/email/unsubscribe";
  base.search = "";
  base.searchParams.set(
    "token",
    createEmailUnsubscribeToken({
      workspaceId: input.workspaceId,
      email: input.email,
      campaignId: input.campaignId,
    })
  );
  return base.toString();
}

export function getEmailUnsubscribeUrlFromTemplateModel(
  model: Record<string, string> | null | undefined
): string {
  const value = String(model?.unsubscribeUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

function isUnsubscribeUrlTemplatePlaceholder(value: string): boolean {
  return /^\{\{\s*unsubscribeUrl\s*\}\}$/.test(value.trim());
}

export function buildEmailUnsubscribeHeaders(
  unsubscribeUrl: string
): Record<string, string> | undefined {
  const url = getEmailUnsubscribeUrlFromTemplateModel({
    unsubscribeUrl,
  });
  if (!url) return undefined;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export function appendEmailUnsubscribeFooter(
  markdown: string,
  unsubscribeUrl: string
): string {
  const url = isUnsubscribeUrlTemplatePlaceholder(unsubscribeUrl)
    ? unsubscribeUrl.trim()
    : getEmailUnsubscribeUrlFromTemplateModel({
        unsubscribeUrl,
      });
  const source = String(markdown || "").trimEnd();
  if (!url || source.includes("{{unsubscribeUrl}}") || source.includes(url)) {
    return source;
  }
  return `${source}\n\n[Unsubscribe]({{unsubscribeUrl}})`;
}

export async function getUnsubscribedEmailSet(params: {
  supabase: EmailUnsubscribeStoreClient;
  workspaceId: string;
  emails: string[];
}): Promise<Set<string>> {
  const table = params.supabase.from(
    "email_unsubscribes"
  ) as EmailUnsubscribeTable;
  const emails = Array.from(
    new Set(
      params.emails
        .map(normalizeEmailUnsubscribeAddress)
        .filter(email => isValidCampaignEmailAddress(email))
    )
  );
  if (emails.length === 0) return new Set();

  const unsubscribed = new Set<string>();
  for (
    let offset = 0;
    offset < emails.length;
    offset += EMAIL_UNSUBSCRIBE_LOOKUP_CHUNK_SIZE
  ) {
    const chunk = emails.slice(
      offset,
      offset + EMAIL_UNSUBSCRIBE_LOOKUP_CHUNK_SIZE
    );
    const { data, error } = await table
      .select("email")
      .eq("workspace_id", params.workspaceId)
      .in("email", chunk);

    if (error) {
      throw new Error(`Failed to load email unsubscribes: ${error.message}`);
    }

    (Array.isArray(data) ? data : [])
      .map(row => normalizeEmailUnsubscribeAddress(String(row?.email || "")))
      .filter(Boolean)
      .forEach(email => unsubscribed.add(email));
  }

  return unsubscribed;
}

export async function recordEmailUnsubscribe(params: {
  supabase: EmailUnsubscribeStoreClient;
  workspaceId: string;
  email: string;
  campaignId?: string | null;
  source: string;
  unsubscribedAt?: string | null;
}): Promise<{ ok: boolean; errorMessage?: string | null }> {
  const email = normalizeEmailUnsubscribeAddress(params.email);
  if (!isValidCampaignEmailAddress(email)) {
    return { ok: false, errorMessage: "Invalid email address" };
  }

  const table = params.supabase.from(
    "email_unsubscribes"
  ) as EmailUnsubscribeTable;
  const unsubscribedAt = params.unsubscribedAt || new Date().toISOString();
  const { error } = await table.upsert(
    {
      workspace_id: params.workspaceId,
      email,
      campaign_id: params.campaignId || null,
      source: params.source,
      unsubscribed_at: unsubscribedAt,
      updated_at: unsubscribedAt,
    },
    { onConflict: "workspace_id,email" }
  );

  return {
    ok: !error,
    errorMessage: error?.message || null,
  };
}
