"use client";

import { IntegrationsWorkspace } from "@/components/integrations/integrations-workspace";
import { IntegrationsOnboarding } from "@/components/integrations/integrations-onboarding";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIntegrations } from "@/hooks/use-integrations";
import { isConfiguredIntegrationSource } from "@/lib/integrations/source-status";
import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

interface IntegrationsContentProps {
  workspaceId: string;
}

export function IntegrationsContent({ workspaceId }: IntegrationsContentProps) {
  const {
    sources,
    emailIntegrationEnabled,
    emailProviderStatus,
    emailProviderConnected,
    isLoading,
    isError,
    mutate,
  } = useIntegrations(workspaceId);
  const t = useTranslations("IntegrationsSettingsPage");

  const connectedIntegrationIds = sources
    .filter(isConfiguredIntegrationSource)
    .map(source => String(source.type));
  if (emailIntegrationEnabled && emailProviderConnected)
    connectedIntegrationIds.push("email");

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {!isLoading && !isError ? (
          <Suspense fallback={null}>
            <IntegrationsOnboarding
              connectedIntegrationIds={connectedIntegrationIds}
              workspaceId={workspaceId}
            />
          </Suspense>
        ) : null}
        <h3 className="text-xl font-semibold tracking-tight">{t("title")}</h3>
      </div>

      <div aria-busy={isLoading || undefined} className="space-y-3">
        {isLoading ? (
          <div aria-label={t("loading")} role="status">
            <IntegrationsLoadingSkeleton />
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t("loadError")}</AlertTitle>
            <AlertDescription>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void mutate()}
              >
                <RefreshCw className="size-4" />
                {t("retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Suspense fallback={<IntegrationsLoadingSkeleton />}>
            <IntegrationsWorkspace
              sources={sources}
              emailIntegrationEnabled={emailIntegrationEnabled}
              emailProviderStatus={emailProviderStatus}
              workspaceId={workspaceId}
              onSourcesChanged={mutate}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function IntegrationsLoadingSkeleton() {
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 bg-background px-1 py-1">
        {[1, 2].map(group => (
          <div key={group} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <div className="flex flex-col gap-0.5">
              {[1, 2, 3].map(item => (
                <Skeleton key={item} className="h-14 rounded-md" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
