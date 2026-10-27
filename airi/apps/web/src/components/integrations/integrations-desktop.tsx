"use client";

import { Badge } from "@/components/ui/badge";
import { isConfiguredIntegrationSource } from "@/lib/integrations/source-status";
import { cn } from "@/lib/utils";
import type { EmailProviderStatus } from "@/types/integrations";
import { Source } from "@/types/supabase";
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Loader2,
  Plus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { usePathname, useSearchParams } from "next/navigation";
import { IntegrationIcon } from "./integration-icon";
import type { IntegrationsPresentation } from "./integration-presentation";
import {
  INTEGRATIONS,
  type IntegrationCategory,
  type IntegrationMetadata,
} from "./integration-registry";
import { buildIntegrationSelectionUrl } from "./integration-selection-url";

interface IntegrationsDesktopProps {
  sources: Source[];
  emailIntegrationEnabled: boolean;
  emailProviderStatus: EmailProviderStatus;
  /** Selection state is owned by IntegrationsWorkspace. */
  activeType: string | null;
  selectedIntegrationId: string | null;
  pendingIntegrationId: string | null;
  onSelectIntegration: (id: string) => void;
  hideOnMobileWhenSelected?: boolean;
  presentation?: IntegrationsPresentation;
}

export function IntegrationsDesktop({
  sources,
  emailIntegrationEnabled,
  emailProviderStatus,
  activeType,
  selectedIntegrationId,
  pendingIntegrationId,
  onSelectIntegration,
  hideOnMobileWhenSelected = true,
  presentation = "default",
}: IntegrationsDesktopProps) {
  const { theme } = useTheme();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("IntegrationRegistry");

  const openIntegration = (id: string) => {
    onSelectIntegration(id);
  };

  const getConnectionState = (id: string): EmailProviderStatus => {
    if (id === "email") {
      return emailProviderStatus;
    }

    return sources.some(
      source => source.type === id && isConfiguredIntegrationSource(source)
    )
      ? "connected"
      : "disconnected";
  };

  const filteredIntegrations = INTEGRATIONS.filter(integration => {
    if (!activeType || activeType === "all") return true;
    return integration.id === activeType;
  });

  const groupedIntegrations = filteredIntegrations.reduce(
    (acc, integration) => {
      if (!acc[integration.category]) {
        acc[integration.category] = [];
      }
      acc[integration.category].push(integration);
      return acc;
    },
    {} as Record<IntegrationCategory, IntegrationMetadata[]>
  );
  const isCompact = presentation === "landingCompact";

  const renderIntegration = (integration: IntegrationMetadata) => {
    const isDisabled =
      integration.disabled ||
      (integration.id === "email" && !emailIntegrationEnabled);

    const currentSearch = searchParams?.toString() ?? "";
    const selectionHref = `${
      buildIntegrationSelectionUrl({
        pathname: pathname ?? "/",
        currentSearch,
        integrationId: integration.id,
      }).href
    }#integrations`;

    return (
      <IntegrationListItem
        key={integration.id}
        integration={integration}
        isDisabled={isDisabled}
        isSelected={selectedIntegrationId === integration.id}
        isPending={pendingIntegrationId === integration.id}
        connectionState={getConnectionState(integration.id)}
        onClick={() => openIntegration(integration.id)}
        href={selectionHref}
        theme={theme}
        t={t}
        presentation={presentation}
      />
    );
  };

  return (
    <div
      className={cn(
        isCompact
          ? "grid grid-cols-[repeat(auto-fit,minmax(7.25rem,9.5rem))] justify-start gap-1.5"
          : "flex flex-col gap-2 bg-background px-1 py-1",
        selectedIntegrationId &&
          hideOnMobileWhenSelected &&
          "hidden @min-[48rem]/integrations:block"
      )}
    >
      {isCompact
        ? filteredIntegrations.map(renderIntegration)
        : (Object.keys(groupedIntegrations) as IntegrationCategory[]).map(
            category => (
              <section key={category} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 px-2 pt-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t(`categories.${category}`)}
                  </h3>
                </div>
                <div className="flex flex-col gap-0.5">
                  {groupedIntegrations[category].map(renderIntegration)}
                </div>
              </section>
            )
          )}
    </div>
  );
}

interface IntegrationListItemProps {
  integration: IntegrationMetadata;
  isDisabled: boolean;
  isSelected: boolean;
  isPending: boolean;
  connectionState: "disconnected" | "pending_dns" | "connected";
  onClick: () => void;
  href: string;
  theme: string | undefined;
  t: (key: string) => string;
  presentation: IntegrationsPresentation;
}

function IntegrationListItem({
  integration,
  isDisabled,
  isSelected,
  isPending,
  connectionState,
  onClick,
  href,
  theme,
  t,
  presentation,
}: IntegrationListItemProps) {
  const isCompact = presentation === "landingCompact";
  const statusBadgeClassName =
    connectionState === "connected"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300"
      : connectionState === "pending_dns"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300"
        : "bg-muted text-muted-foreground";

  const content = (
    <>
      <div
        data-testid={`integration-list-icon-${integration.id}`}
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center",
          isCompact ? "size-6 bg-transparent" : "size-9 rounded-md bg-muted/40"
        )}
      >
        <IntegrationIcon
          integration={integration}
          alt={t(`${integration.id}.name`)}
          theme={theme}
          className="size-5"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p
            className={cn(
              "text-foreground",
              isCompact
                ? "text-[11px] font-black leading-3 [overflow-wrap:anywhere]"
                : "line-clamp-1 text-sm font-semibold leading-5"
            )}
          >
            {t(`${integration.id}.name`)}
          </p>
          {isDisabled && !isCompact && (
            <Badge
              variant="secondary"
              className="h-5 rounded-md px-1.5 text-[10px]"
            >
              {t("workInProgress")}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!isDisabled && !isCompact && (
          <Badge
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px]",
              statusBadgeClassName
            )}
          >
            {connectionState === "connected" ? (
              <CheckCircle2 data-icon="inline-start" />
            ) : connectionState === "pending_dns" ? (
              <Clock3 data-icon="inline-start" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            {t(`status.${connectionState}`)}
          </Badge>
        )}
        {!isCompact && isPending ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !isCompact ? (
          <ChevronRight
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              isSelected && "translate-x-0.5 text-foreground"
            )}
          />
        ) : null}
      </div>
    </>
  );

  const className = cn(
    isCompact
      ? "flex min-h-10 w-full max-w-[9.5rem] items-center gap-2 rounded-xl bg-white/65 px-2.5 py-2 text-left text-slate-950 hover:bg-[#cfffe1]/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#075e54]/25"
      : "flex min-h-14 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    isCompact
      ? isSelected && "bg-[#cfffe1]/90"
      : isSelected
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
        : "hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
    isDisabled && "cursor-not-allowed opacity-60"
  );

  if (isCompact) {
    return (
      <a
        href={href}
        aria-current={isSelected ? "true" : undefined}
        aria-busy={isPending || undefined}
        aria-disabled={isDisabled || undefined}
        onClick={event => {
          event.preventDefault();
          if (!isDisabled) onClick();
        }}
        className={className}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-pressed={isSelected}
      aria-busy={isPending || undefined}
      onClick={onClick}
      className={className}
    >
      {content}
    </button>
  );
}
