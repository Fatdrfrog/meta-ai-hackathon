"use client";

import {
  fetchWhatsAppServiceMessageResources,
  type WhatsAppServiceMessageResources,
} from "@/lib/scenarios/client";
import { createLogger } from "@icecore/shared/lib/logger";

const serviceMessageResourcesLogger = createLogger(
  "whatsapp-service-message-resources"
);

/**
 * How long every step reuses a workspace's WhatsApp calling readiness. The
 * onboarding check behind it already refreshes Meta state far less often.
 */
export const WHATSAPP_CALLING_READINESS_TTL_MS = 60_000;

type ServiceResourcePart = "calling" | "signupLinks" | "catalog";

type ServiceResourcePartResult = {
  resources: WhatsAppServiceMessageResources;
  failedUrls: string[];
};

type SharedServiceResourceRequest = {
  workspaceId: string;
  promise: Promise<ServiceResourcePartResult>;
  /** When the stored answer goes stale; null while the request runs. */
  expiresAt: number | null;
};

/*
 * One request per workspace and resource, shared by every service-message
 * step on the canvas: steps that mount together ask once. A failed answer
 * is never kept, and only calling readiness outlives its request.
 */
const sharedRequests = new Map<string, SharedServiceResourceRequest>();

function requestServiceResourcePart(
  part: ServiceResourcePart,
  workspaceId: string,
  catalogId: string
): Promise<ServiceResourcePartResult> {
  const failedUrls: string[] = [];
  return fetchWhatsAppServiceMessageResources({
    workspaceId,
    loadCalling: part === "calling",
    loadSignupLinks: part === "signupLinks",
    loadCatalog: part === "catalog",
    catalogId,
    onRequestError: ({ url, error }) => {
      failedUrls.push(url);
      serviceMessageResourcesLogger.warn("WhatsApp service resources failed", {
        workspaceId,
        url,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    },
  }).then(resources => ({ resources, failedUrls }));
}

function isUsable(request: SharedServiceResourceRequest | undefined): boolean {
  return Boolean(
    request && (request.expiresAt === null || request.expiresAt > Date.now())
  );
}

function loadSharedServiceResourcePart(
  part: ServiceResourcePart,
  workspaceId: string,
  catalogId = ""
): Promise<ServiceResourcePartResult> {
  const key = JSON.stringify([part, workspaceId, catalogId]);
  const known = sharedRequests.get(key);
  if (known && isUsable(known)) return known.promise;
  const request: SharedServiceResourceRequest = {
    workspaceId,
    promise: requestServiceResourcePart(part, workspaceId, catalogId),
    expiresAt: null,
  };
  sharedRequests.set(key, request);
  void request.promise.then(result => {
    if (sharedRequests.get(key) !== request) return;
    if (part === "calling" && result.failedUrls.length === 0) {
      request.expiresAt = Date.now() + WHATSAPP_CALLING_READINESS_TTL_MS;
    } else {
      sharedRequests.delete(key);
    }
  });
  return request.promise;
}

/** Drops a workspace's shared answers, so the next load asks again. */
export function forgetWhatsAppServiceMessageResources(
  workspaceId?: string
): void {
  for (const [key, request] of sharedRequests) {
    if (workspaceId === undefined || request.workspaceId === workspaceId) {
      sharedRequests.delete(key);
    }
  }
}

/**
 * A step's service-message resources: the same data a single request for
 * them returns, with each part shared with the steps that need it too.
 */
export async function loadWhatsAppServiceMessageResources(params: {
  workspaceId: string;
  loadSignupLinks: boolean;
  loadCalling: boolean;
  loadCatalog: boolean;
  catalogId: string;
}): Promise<ServiceResourcePartResult> {
  const { workspaceId } = params;
  const [calling, signupLinks, catalog] = await Promise.all([
    params.loadCalling
      ? loadSharedServiceResourcePart("calling", workspaceId)
      : null,
    params.loadSignupLinks
      ? loadSharedServiceResourcePart("signupLinks", workspaceId)
      : null,
    params.loadCatalog
      ? loadSharedServiceResourcePart("catalog", workspaceId, params.catalogId)
      : null,
  ]);
  return {
    resources: {
      signupLinks: signupLinks?.resources.signupLinks ?? [],
      catalogs: catalog?.resources.catalogs ?? [],
      products: catalog?.resources.products ?? [],
      callingReady: calling?.resources.callingReady ?? false,
    },
    failedUrls: [calling, signupLinks, catalog].flatMap(
      part => part?.failedUrls ?? []
    ),
  };
}
