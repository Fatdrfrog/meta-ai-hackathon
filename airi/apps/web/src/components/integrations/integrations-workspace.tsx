"use client";

import { cn } from "@/lib/utils";
import type { EmailProviderStatus } from "@/types/integrations";
import type { Source } from "@/types/supabase";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IntegrationDetailsPanel } from "./integration-details-panel";
import type { IntegrationsPresentation } from "./integration-presentation";
import { IntegrationsDesktop } from "./integrations-desktop";
import {
  buildIntegrationSelectionUrl,
  getSelectedIntegrationId,
} from "./integration-selection-url";

export type IntegrationsWorkspaceMode = "settings" | "preview";

interface IntegrationsWorkspaceProps {
  sources: Source[];
  emailIntegrationEnabled: boolean;
  emailProviderStatus: EmailProviderStatus;
  workspaceId: string;
  onSourcesChanged?: () => Promise<unknown>;
  mode?: IntegrationsWorkspaceMode;
  initialSelectedIntegrationId?: string | null;
  connectionActionsDisabled?: boolean;
  secondaryActionHref?: string;
  hideListOnMobileWhenSelected?: boolean;
  presentation?: IntegrationsPresentation;
  className?: string;
}

export function IntegrationsWorkspace({
  sources,
  emailIntegrationEnabled,
  emailProviderStatus,
  workspaceId,
  onSourcesChanged,
  mode = "settings",
  initialSelectedIntegrationId = null,
  connectionActionsDisabled = false,
  secondaryActionHref,
  hideListOnMobileWhenSelected = mode === "settings",
  presentation = "default",
  className,
}: IntegrationsWorkspaceProps) {
  const pathname = usePathname();
  const routeSearchParams = useSearchParams();
  const routeSearchString = routeSearchParams?.toString() ?? "";
  const usesRouteState = mode === "settings";
  const initialSearchString = useMemo(() => {
    if (usesRouteState) return routeSearchString;
    if (getSelectedIntegrationId(routeSearchParams)) return routeSearchString;
    if (!initialSelectedIntegrationId) return "";
    return `integration=${encodeURIComponent(initialSelectedIntegrationId)}`;
  }, [
    initialSelectedIntegrationId,
    routeSearchParams,
    routeSearchString,
    usesRouteState,
  ]);
  const [searchString, setSearchString] = useState(initialSearchString);
  const [pendingIntegrationId, setPendingIntegrationId] = useState<
    string | null
  >(null);

  const searchParams = useMemo(
    () => new URLSearchParams(searchString),
    [searchString]
  );
  const selectedIntegrationId = getSelectedIntegrationId(searchParams);
  const activeType = searchParams.get("type");

  useEffect(() => {
    if (!usesRouteState) return;
    setSearchString(routeSearchString);
  }, [routeSearchString, usesRouteState]);

  useEffect(() => {
    if (!usesRouteState) return;

    const syncFromLocation = () => {
      setSearchString(window.location.search.replace(/^\?/, ""));
      setPendingIntegrationId(null);
    };

    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [usesRouteState]);

  useEffect(() => {
    if (!pendingIntegrationId) return;

    const timeout = window.setTimeout(() => {
      setPendingIntegrationId(current =>
        current === pendingIntegrationId ? null : current
      );
    }, 180);

    return () => window.clearTimeout(timeout);
  }, [pendingIntegrationId]);

  const selectIntegration = useCallback(
    (integrationId: string) => {
      const currentSearch = usesRouteState
        ? window.location.search.replace(/^\?/, "")
        : searchString;
      const { href, search } = buildIntegrationSelectionUrl({
        pathname,
        currentSearch,
        integrationId,
      });

      setPendingIntegrationId(integrationId);
      setSearchString(search);
      if (usesRouteState) {
        window.history.pushState(null, "", href);
      }
    },
    [pathname, searchString, usesRouteState]
  );

  const clearSelection = useCallback(() => {
    const currentSearch = usesRouteState
      ? window.location.search.replace(/^\?/, "")
      : searchString;
    const { href, search } = buildIntegrationSelectionUrl({
      pathname,
      currentSearch,
      integrationId: null,
    });

    setPendingIntegrationId(null);
    setSearchString(search);
    if (usesRouteState) {
      window.history.pushState(null, "", href);
    }
  }, [pathname, searchString, usesRouteState]);

  return (
    <div className={cn("@container/integrations", className)}>
      <div
        className={cn(
          presentation === "landingCompact"
            ? "grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.62fr)] lg:items-start"
            : "grid gap-4 @min-[48rem]/integrations:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] @min-[48rem]/integrations:items-start"
        )}
      >
        <div
          className={cn(
            presentation === "default" &&
              "min-w-0 @min-[48rem]/integrations:sticky @min-[48rem]/integrations:top-4 @min-[48rem]/integrations:self-start"
          )}
        >
          <IntegrationsDesktop
            sources={sources}
            emailIntegrationEnabled={emailIntegrationEnabled}
            emailProviderStatus={emailProviderStatus}
            activeType={activeType}
            selectedIntegrationId={selectedIntegrationId}
            pendingIntegrationId={pendingIntegrationId}
            onSelectIntegration={selectIntegration}
            hideOnMobileWhenSelected={hideListOnMobileWhenSelected}
            presentation={presentation}
          />
        </div>
        <div className={cn(presentation === "default" && "min-w-0")}>
          <IntegrationDetailsPanel
            sources={sources}
            emailIntegrationEnabled={emailIntegrationEnabled}
            emailProviderStatus={emailProviderStatus}
            workspaceId={workspaceId}
            onSourcesChanged={onSourcesChanged}
            selectedIntegrationId={selectedIntegrationId}
            isSelectionPending={Boolean(pendingIntegrationId)}
            onClearSelection={clearSelection}
            error={searchParams.get("error")}
            errorDetails={searchParams.get("error_details")}
            warning={searchParams.get("warning")}
            warningDetails={searchParams.get("warning_details")}
            connectionActionsDisabled={connectionActionsDisabled}
            secondaryActionHref={secondaryActionHref}
            presentation={presentation}
          />
        </div>
      </div>
    </div>
  );
}
