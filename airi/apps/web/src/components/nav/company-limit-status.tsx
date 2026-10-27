"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";

import { SidebarGroup } from "@/components/ui/sidebar";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { WorkspaceTextAiAllowance } from "@/components/ai/workspace-text-ai-allowance";

export function CompanyLimitStatus({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("AppSidebar.limits");
  const { data: status, error } = useCompanyLimits(workspaceId);

  if (!status?.exhausted && status?.subscriptionType !== "pro") return null;

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden space-y-2 px-2 py-1">
      {status.subscriptionType === "pro" ? (
        <WorkspaceTextAiAllowance
          workspaceId={workspaceId}
          allowance={error ? { status: "unavailable" } : status.textAiAllowance}
          compact
        />
      ) : null}
      {status.exhausted ? (
        <div className="border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/35 dark:text-amber-100 flex items-start gap-2 rounded-md border px-2.5 py-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium leading-4">
              {t("exhaustedTitle")}
            </p>
            <p className="mt-0.5 text-xs leading-4 opacity-80">
              {t("remaining", {
                remaining: status.conversationsRemaining ?? 0,
                limit: status.conversationLimit ?? 0,
              })}
            </p>
          </div>
        </div>
      ) : null}
    </SidebarGroup>
  );
}
