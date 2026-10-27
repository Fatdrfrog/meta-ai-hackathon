"use client";

import type { ScenarioWhatsAppServiceMessageKind } from "@icecore/scenario-contracts";
import type {
  WhatsAppServiceCatalog,
  WhatsAppServiceCatalogProduct,
  WhatsAppServiceSignupLink,
} from "@/lib/scenarios/client";
import { useEffect, useState } from "react";
import {
  forgetWhatsAppServiceMessageResources,
  loadWhatsAppServiceMessageResources,
} from "./service-message-shared-resources";

export type {
  WhatsAppServiceCatalog,
  WhatsAppServiceCatalogProduct,
  WhatsAppServiceSignupLink,
};

export function availableServiceProducts(params: {
  products: WhatsAppServiceCatalogProduct[];
  catalogId: string;
}) {
  return params.products.filter(
    product =>
      Boolean(product.retailer_id) &&
      (!product.catalog_id || product.catalog_id === params.catalogId)
  );
}

/** Which requests failed, so only the message types that use them say so. */
export type WhatsAppServiceResourceFailures = {
  signupLinks: boolean;
  calling: boolean;
  catalog: boolean;
};

const NO_FAILURES: WhatsAppServiceResourceFailures = {
  signupLinks: false,
  calling: false,
  catalog: false,
};

function failedResourceForUrl(
  url: string
): keyof WhatsAppServiceResourceFailures | null {
  if (url.includes("/api/whatsapp/signups")) return "signupLinks";
  if (url.includes("/api/whatsapp/onboarding")) return "calling";
  if (url.includes("/api/whatsapp/catalog")) return "catalog";
  return null;
}

function resolveFailedResources(
  failedUrls: readonly string[]
): WhatsAppServiceResourceFailures {
  const failedResources = { ...NO_FAILURES };
  for (const url of failedUrls) {
    const resource = failedResourceForUrl(url);
    if (resource) failedResources[resource] = true;
  }
  return failedResources;
}

type ResourceState = {
  loading: boolean;
  failed: boolean;
  failedResources: WhatsAppServiceResourceFailures;
  signupLinks: WhatsAppServiceSignupLink[];
  catalogs: WhatsAppServiceCatalog[];
  products: WhatsAppServiceCatalogProduct[];
  callingReady: boolean;
};

type RequestedResourceState = ResourceState & { requestKey: string };

const initialState: ResourceState = {
  loading: false,
  failed: false,
  failedResources: NO_FAILURES,
  signupLinks: [],
  catalogs: [],
  products: [],
  callingReady: false,
};

export function useWhatsAppServiceMessageResources(params: {
  workspaceId: string;
  kind: ScenarioWhatsAppServiceMessageKind;
  catalogId?: string;
}) {
  const workspaceId = params.workspaceId.trim();
  const catalogId = params.catalogId?.trim() || "";
  const loadSignupLinks = params.kind === "cta_url";
  // Prefetch calling readiness whenever workspace is set so the action menu
  // can gate WhatsApp call before the voice_call kind is selected. Every
  // step of the workspace shares one answer.
  const loadCalling = Boolean(workspaceId);
  const loadCatalog = params.kind === "commerce";
  const hasRequest = Boolean(
    workspaceId && (loadSignupLinks || loadCalling || loadCatalog)
  );
  const requestKey = hasRequest
    ? JSON.stringify([
        workspaceId,
        loadSignupLinks,
        loadCalling,
        loadCatalog,
        loadCatalog ? catalogId : "",
      ])
    : "";
  const [state, setState] = useState<RequestedResourceState>({
    ...initialState,
    requestKey: "",
  });

  const [retryVersion, setRetryVersion] = useState(0);
  const retry = () => {
    // Every step of the workspace asks again, not only this one.
    forgetWhatsAppServiceMessageResources(workspaceId);
    setState({ ...initialState, requestKey: "" });
    setRetryVersion(version => version + 1);
  };

  useEffect(() => {
    if (!requestKey) return;

    let cancelled = false;
    void loadWhatsAppServiceMessageResources({
      workspaceId,
      loadSignupLinks,
      loadCalling,
      loadCatalog,
      catalogId,
    }).then(({ resources, failedUrls }) => {
      if (cancelled) return;
      setState({
        requestKey,
        loading: false,
        ...resources,
        failed: failedUrls.length > 0,
        failedResources: resolveFailedResources(failedUrls),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    retryVersion,
    catalogId,
    loadCalling,
    loadCatalog,
    loadSignupLinks,
    requestKey,
    workspaceId,
  ]);

  return {
    ...(state.requestKey === requestKey
      ? state
      : { ...initialState, loading: hasRequest }),
    retry,
  };
}
