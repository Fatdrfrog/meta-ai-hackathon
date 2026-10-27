"use client";

import { isBillingUiEnabled } from "@/lib/billing/availability";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

export function getFreePlanUpsellLink(workspaceId?: string | null) {
  if (!isBillingUiEnabled() || !workspaceId) return null;
  return `/panel/w/${workspaceId}/settings/billing`;
}

export function FreePlanUpsell({
  className,
  workspaceId,
}: {
  className?: string;
  workspaceId?: string | null;
}) {
  const t = useTranslations("AppSidebar.limits");
  const upsellLink = getFreePlanUpsellLink(workspaceId);

  if (!upsellLink) {
    return (
      <p
        className={cn("text-[11px] leading-4 text-muted-foreground", className)}
      >
        {t("freePlan")}
      </p>
    );
  }

  return (
    <p className={cn("text-[11px] leading-4 text-muted-foreground", className)}>
      {t.rich("freePlanUpgrade", {
        link: chunks => (
          <a
            href={upsellLink}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {chunks}
          </a>
        ),
      })}
    </p>
  );
}
