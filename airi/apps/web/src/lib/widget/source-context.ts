import { widgetLogger } from "@/lib/logger";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import type { WebWidgetCredentials } from "@icecore/shared/types/sources";
import { getRequestOrigin, validateDomain } from "./domain-validator";

export type WidgetSourceContext = {
  id: string;
  workspace_id: string;
  company_id: string;
  credentials: WebWidgetCredentials;
};

export type AuthorizedWidgetSourceResult =
  | {
      ok: true;
      source: WidgetSourceContext;
      credentials: WebWidgetCredentials;
      origin: string | null;
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      origin: string | null;
    };

type WidgetSourceRow = {
  id?: string | null;
  workspace_id?: string | null;
  company_id?: string | null;
  credentials?: unknown;
};

function toWidgetSourceContext(
  source: WidgetSourceRow | null | undefined
): WidgetSourceContext | null {
  if (!source?.id || !source.workspace_id || !source.company_id) return null;
  const credentials =
    source.credentials && typeof source.credentials === "object"
      ? (source.credentials as WebWidgetCredentials)
      : null;
  if (!credentials) return null;
  return {
    id: source.id,
    workspace_id: source.workspace_id,
    company_id: source.company_id,
    credentials,
  };
}

export async function fetchWidgetSourceByClientKey(
  clientKey: string
): Promise<WidgetSourceContext | null> {
  // Widget visitors have no Airi session, and anon cannot read sources.
  // Resolve the public client_key on the server; callers still enforce the
  // source status and domain allowlist before serving anything.
  const result = await fetchSourceWithCredentialsResult(
    undefined,
    "web_widget",
    { "credentials->>client_key": clientKey }
  );

  if (!result.ok || !result.source) return null;
  return toWidgetSourceContext(result.source);
}

export async function resolveAuthorizedWidgetSource(params: {
  request: Request;
  clientKey: string;
}): Promise<AuthorizedWidgetSourceResult> {
  const origin = params.request.headers.get("origin");
  const source = await fetchWidgetSourceByClientKey(params.clientKey);
  if (!source) {
    widgetLogger.domainUnauthorized(origin || "unknown", params.clientKey);
    return {
      ok: false,
      status: 401,
      error: "Invalid client_key",
      origin,
    };
  }

  const requestOrigin = getRequestOrigin(params.request);
  if (source.credentials.status !== "active") {
    widgetLogger.domainUnauthorized(
      requestOrigin || "unknown",
      params.clientKey,
      source.workspace_id,
      source.company_id
    );
    return {
      ok: false,
      status: 403,
      error: "Widget source inactive",
      origin,
    };
  }

  const allowedDomains = source.credentials.allowed_domains || [];
  if (!validateDomain(requestOrigin, allowedDomains)) {
    widgetLogger.domainUnauthorized(
      requestOrigin || "unknown",
      params.clientKey,
      source.workspace_id,
      source.company_id
    );
    return {
      ok: false,
      status: 403,
      error: "Domain not authorized",
      origin,
    };
  }

  return {
    ok: true,
    source,
    credentials: source.credentials,
    origin,
  };
}
