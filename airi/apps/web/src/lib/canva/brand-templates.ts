import { decryptMaybeString, encryptString } from "@/lib/crypto";
import type { ScenarioGeneratorCanvaTemplateRef } from "@icecore/scenario-contracts";
import { readNonEmptyString as stringOrNull } from "@icecore/shared/lib/value-utils";

export type NormalizedCanvaBrandTemplatesResponse = {
  items: ScenarioGeneratorCanvaTemplateRef[];
  continuation: string | null;
};

export type CanvaCredentials = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  scope?: unknown;
  token_type?: unknown;
};

export const CANVA_BRAND_TEMPLATE_SCOPE = "brandtemplate:meta:read";
export const CANVA_TEMPLATES_PAGE_SIZE = 12;

export function normalizeCanvaBrandTemplatesResponse(
  value: unknown
): NormalizedCanvaBrandTemplatesResponse {
  const raw = value && typeof value === "object" ? value : {};
  const data = raw as Record<string, unknown>;
  const rawItems = Array.isArray(data.items) ? data.items : [];

  return {
    items: rawItems.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const template = item as Record<string, unknown>;
      const id = stringOrNull(template.id);
      if (!id) return [];

      return [
        {
          id,
          title:
            stringOrNull(template.title) || "Untitled Canva brand template",
          thumbnailUrl: readThumbnailUrl(template.thumbnail),
          createUrl: stringOrNull(template.create_url),
          source: "canva_brand_template" as const,
        },
      ];
    }),
    continuation: stringOrNull(data.continuation),
  };
}

export function buildCanvaTemplateSearchQuery(params: {
  prompt: string;
  campaignName?: string | null;
}): string {
  const campaignName = String(params.campaignName || "").trim();
  const prompt = String(params.prompt || "").trim();
  const topic = inferTemplateTopic(prompt);
  const base =
    campaignName || prompt.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return [base, topic].filter(Boolean).join(" ").trim().slice(0, 80);
}

export function normalizeSelectedCanvaTemplates(
  value: unknown
): ScenarioGeneratorCanvaTemplateRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const id = stringOrNull(raw.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        title: stringOrNull(raw.title) || "Untitled Canva brand template",
        thumbnailUrl: stringOrNull(raw.thumbnailUrl),
        createUrl: stringOrNull(raw.createUrl),
        source: "canva_brand_template" as const,
      },
    ];
  });
}

export function buildCanvaTemplateInspirationText(
  templates: ScenarioGeneratorCanvaTemplateRef[]
): string {
  if (templates.length === 0) return "";
  return [
    "Canva brand template inspiration:",
    ...templates.map(template =>
      [
        `- ${template.title}`,
        `id: ${template.id}`,
        template.createUrl ? `createUrl: ${template.createUrl}` : "",
      ]
        .filter(Boolean)
        .join(" | ")
    ),
  ].join("\n");
}

export function canvaConnectUrl(workspaceId: string): string {
  return `/api/sources/canva/connect?workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function readCanvaAccessToken(
  credentials: CanvaCredentials | null | undefined
): string {
  return decryptMaybeString(credentials?.access_token);
}

export function readCanvaRefreshToken(
  credentials: CanvaCredentials | null | undefined
): string {
  return decryptMaybeString(credentials?.refresh_token);
}

export function canvaCredentialsHaveBrandTemplateScope(
  credentials: CanvaCredentials | null | undefined
): boolean {
  const scope = String(credentials?.scope || "");
  return scope.split(/\s+/).includes(CANVA_BRAND_TEMPLATE_SCOPE);
}

export async function refreshCanvaAccessToken(params: {
  refreshToken: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
  scope?: string;
  tokenType?: string;
} | null> {
  const clientId = (process.env.CANVA_CLIENT_ID || "").trim();
  const clientSecret = (process.env.CANVA_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret || !params.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
  const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const accessToken = stringOrNull(data?.access_token);
  if (!accessToken) return null;
  const expiresIn =
    typeof data?.expires_in === "number" ? data.expires_in : undefined;

  return {
    accessToken,
    refreshToken: stringOrNull(data?.refresh_token) || undefined,
    expiresAt: expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null,
    scope: stringOrNull(data?.scope) || undefined,
    tokenType: stringOrNull(data?.token_type) || undefined,
  };
}

export function mergeRefreshedCanvaCredentials(
  current: Record<string, unknown>,
  refreshed: Awaited<ReturnType<typeof refreshCanvaAccessToken>>
): Record<string, unknown> {
  if (!refreshed) return current;
  return {
    ...current,
    access_token: encryptString(refreshed.accessToken),
    refresh_token: refreshed.refreshToken
      ? encryptString(refreshed.refreshToken)
      : current.refresh_token,
    expires_at: refreshed.expiresAt || current.expires_at || null,
    scope: refreshed.scope || current.scope,
    token_type: refreshed.tokenType || current.token_type || "Bearer",
  };
}

export async function fetchCanvaBrandTemplates(params: {
  accessToken: string;
  query?: string;
  continuation?: string;
}): Promise<Response> {
  const url = new URL("https://api.canva.com/rest/v1/brand-templates");
  url.searchParams.set("limit", String(CANVA_TEMPLATES_PAGE_SIZE));
  if (params.continuation) {
    url.searchParams.set("continuation", params.continuation);
  } else if (params.query) {
    url.searchParams.set("query", params.query);
  }

  return fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.accessToken}`,
    },
  });
}

export function canvaErrorRequiresReconnect(value: unknown): boolean {
  const text = JSON.stringify(value || {}).toLowerCase();
  return (
    text.includes("missing_scope") ||
    text.includes("missing scopes") ||
    text.includes("invalid_token") ||
    text.includes("unauthorized")
  );
}

function inferTemplateTopic(prompt: string): string {
  if (/reactivat|win\s*back|renew|churn/i.test(prompt)) {
    return "reactivation campaign";
  }
  if (/demo|book|sales|pricing|purchase|buy/i.test(prompt)) {
    return "sales campaign";
  }
  if (/onboard|welcome|activation/i.test(prompt)) {
    return "onboarding campaign";
  }
  if (/follow\s*up|no reply|inactive/i.test(prompt)) {
    return "follow up campaign";
  }
  return "marketing campaign";
}

function readThumbnailUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return (
    stringOrNull(raw.url) ||
    stringOrNull(raw.preview_url) ||
    stringOrNull(raw.thumbnail_url)
  );
}
