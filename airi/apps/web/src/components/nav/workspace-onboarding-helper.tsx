"use client";

import { useCurrentOnboardingStep } from "@/components/nav/workspace-onboarding-state";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ListChecks } from "lucide-react";
import { Route } from "next";
import { useTranslations } from "next-intl";
import Link from "next/link";

export function WorkspaceOnboardingHelper({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useTranslations("AppSidebar.onboarding");
  const state = useCurrentOnboardingStep(workspaceId);

  if (!state) {
    return null;
  }

  const { currentStep, percent } = state;

  return (
    <SidebarGroup className="mt-3">
      <SidebarGroupLabel>{t("label")}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={`${t("progress", { percent })}: ${t(
                `steps.${currentStep.id}.title`
              )}`}
              className="h-auto py-2"
            >
              <Link
                href={currentStep.href as Route}
                prefetch={false}
                className="items-start"
              >
                <ListChecks className="mt-0.5 size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {t(`steps.${currentStep.id}.title`)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {t("progress", { percent })}
                    </span>
                  </span>
                  <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn(
                        "block h-full rounded-full bg-primary",
                        percent === 0 && "w-1"
                      )}
                      style={{ width: `${Math.max(percent, 4)}%` }}
                    />
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export { WorkspaceOnboardingNavHelper } from "./workspace-onboarding-nav-helper";
