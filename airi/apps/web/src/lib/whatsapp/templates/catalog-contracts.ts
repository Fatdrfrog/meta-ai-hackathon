import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";

export type WhatsAppTemplateCatalogRefreshOutcome =
  | "fresh"
  | "succeeded"
  | "cooldown"
  | "minimum_interval"
  | "in_progress"
  | "coordination_unavailable"
  | "rate_limited"
  | "failed";

export type WhatsAppTemplateCatalogMetadata = {
  source: "live" | "cache";
  stale: boolean;
  fetchedAt: string;
  wabaId: string;
  refreshOutcome: WhatsAppTemplateCatalogRefreshOutcome;
  retryAt: string | null;
  providerCode?: number;
  warning?: string;
};

export type WhatsAppTemplateCatalogResult = {
  templates: WhatsAppTemplate[];
  catalog: WhatsAppTemplateCatalogMetadata;
};

export type WhatsAppTemplateCatalogErrorCode =
  | "WHATSAPP_TEMPLATES_RATE_LIMITED"
  | "WHATSAPP_TEMPLATES_UNAVAILABLE"
  | "WHATSAPP_TEMPLATES_INCOMPLETE";

/** Client-safe error contract; no credentials or Graph request URLs. */
export class WhatsAppTemplateCatalogError extends Error {
  readonly code: WhatsAppTemplateCatalogErrorCode;
  readonly status: 429 | 503 | 502;
  readonly retryAt: string | null;
  readonly providerCode?: number;
  readonly providerStatus?: number;

  constructor(params: {
    code: WhatsAppTemplateCatalogErrorCode;
    message: string;
    retryAt?: string | null;
    providerCode?: number;
    providerStatus?: number;
  }) {
    super(params.message);
    this.name = "WhatsAppTemplateCatalogError";
    this.code = params.code;
    this.status =
      params.code === "WHATSAPP_TEMPLATES_RATE_LIMITED"
        ? 429
        : params.code === "WHATSAPP_TEMPLATES_INCOMPLETE"
          ? 502
          : 503;
    this.retryAt = params.retryAt ?? null;
    this.providerCode = params.providerCode;
    this.providerStatus = params.providerStatus;
  }
}

/**
 * What a template missing from this catalog means for a send: null when the
 * catalog is current, so the template really is missing or not approved.
 * A stale catalog is the last saved copy. A template created in Meta after
 * that save is not in it, because status webhooks only patch templates the
 * copy already lists. So a miss there is a failed lookup, rate limited while
 * Meta's cooldown lasts.
 */
export function staleWhatsAppTemplateCatalogMissError(
  catalog:
    | Pick<
        WhatsAppTemplateCatalogMetadata,
        "stale" | "refreshOutcome" | "retryAt" | "providerCode"
      >
    | null
    | undefined
): WhatsAppTemplateCatalogError | null {
  if (!catalog?.stale) return null;
  const rateLimited =
    catalog.refreshOutcome === "cooldown" ||
    catalog.refreshOutcome === "rate_limited";
  return new WhatsAppTemplateCatalogError({
    code: rateLimited
      ? "WHATSAPP_TEMPLATES_RATE_LIMITED"
      : "WHATSAPP_TEMPLATES_UNAVAILABLE",
    message: rateLimited
      ? "Meta temporarily limited WhatsApp template requests, and the saved template catalog doesn't list this template."
      : "The saved WhatsApp template catalog doesn't list this template, and it can't be refreshed right now.",
    retryAt: catalog.retryAt,
    providerCode: catalog.providerCode,
  });
}
