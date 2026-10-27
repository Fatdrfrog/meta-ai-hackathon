"use client";

import { Button } from "@/components/ui/button";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { captureOnboardingAnalytics } from "./onboarding-analytics";

type ProductTestAiriProps = {
  workspaceId: string;
  enabled: boolean;
  metadata: Record<string, string | number | boolean | string[] | undefined>;
};

export function ProductTestAiri({
  workspaceId,
  enabled,
  metadata,
}: ProductTestAiriProps) {
  const t = useTranslations("OnboardingProductStep");
  const help = enabled ? t("testChatHelp") : t("testChatLockedHelp");

  const handleOpen = () => {
    captureOnboardingAnalytics({
      workspaceId,
      event: "onboarding_step_completed",
      stepId: "test_airi_opened",
      metadata,
    });
  };

  return (
    <section className="space-y-2" aria-labelledby="test-airi-heading">
      <div className="space-y-1">
        <h2
          id="test-airi-heading"
          className="break-words text-sm font-bold text-foreground"
        >
          {t("testChatHeading")}
        </h2>
        <p className="break-words text-xs text-muted-foreground">{help}</p>
      </div>
      <div className="rounded-2xl border-[3px] border-foreground bg-background p-4 shadow-[4px_4px_0px_#000000] dark:shadow-[4px_4px_0px_rgba(255,255,255,0.15)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 break-words text-sm font-black text-foreground">
            {enabled ? t("testChatTitle") : t("testChatLocked")}
          </p>
          {enabled ? (
            <Button
              asChild
              size="sm"
              className="w-full max-w-full sm:w-auto sm:max-w-56 [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:break-words [&_.btn-push-front]:whitespace-normal"
            >
              <Link
                href={panelWorkspaceAiriHref(workspaceId, {
                  source: "onboarding",
                })}
                onClick={handleOpen}
              >
                {t("openAiriChat")}
              </Link>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled
              className="w-full max-w-full sm:w-auto sm:max-w-56 [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:break-words [&_.btn-push-front]:whitespace-normal"
            >
              {t("openAiriChat")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
