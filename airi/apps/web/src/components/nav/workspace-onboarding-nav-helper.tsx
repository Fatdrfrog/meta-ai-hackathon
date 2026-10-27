"use client";

import { Button } from "@/components/ui/button";
import { useCurrentOnboardingStep } from "@/components/nav/workspace-onboarding-state";
import { ListChecks } from "lucide-react";
import { Route } from "next";
import { useTranslations } from "next-intl";
import Link from "next/link";

export function WorkspaceOnboardingNavHelper({
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
  const progressLabel = t("progress", { percent });
  const stepTitle = t(`steps.${currentStep.id}.title`);

  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="h-8 max-w-[11rem] min-w-0 overflow-hidden gap-1.5 px-2 text-xs sm:max-w-[13rem]"
    >
      <Link
        href={currentStep.href as Route}
        prefetch={false}
        title={`${progressLabel}: ${stepTitle}`}
      >
        <ListChecks className="size-3.5 shrink-0 text-primary" />
        <span className="hidden min-w-0 truncate sm:inline">{stepTitle}</span>
        <span className="shrink-0 text-muted-foreground">{progressLabel}</span>
      </Link>
    </Button>
  );
}
