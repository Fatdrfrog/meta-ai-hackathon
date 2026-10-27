"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import { getSelectedIntegrationId } from "./integration-selection-url";

interface IntegrationsOnboardingProps {
  connectedIntegrationIds: string[];
  workspaceId?: string;
}

export function IntegrationsOnboarding({
  connectedIntegrationIds,
  workspaceId,
}: IntegrationsOnboardingProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isNewUser = searchParams.get("new") === "true";
  const integrationId = getSelectedIntegrationId(searchParams);
  const hasError = Boolean(searchParams.get("error"));
  const connected = integrationId
    ? connectedIntegrationIds.includes(integrationId)
    : connectedIntegrationIds.length > 0;
  // After WhatsApp connects, the next step toward a first campaign is an
  // approved message template, so the toast offers to create one.
  const whatsappJustConnected =
    connected &&
    (integrationId === "whatsapp" ||
      (!integrationId && connectedIntegrationIds.includes("whatsapp")));
  const t = useTranslations("Onboarding");
  const notice: "welcome" | "whatsapp" | "success" | null =
    !isNewUser || hasError
      ? null
      : !connected
        ? "welcome"
        : whatsappJustConnected && workspaceId
          ? "whatsapp"
          : "success";
  // The toast action reads the latest router and workspace without making
  // them effect inputs: a notice is shown once per state, not per render.
  const latest = useRef({ router, workspaceId });
  useEffect(() => {
    latest.current = { router, workspaceId };
  });

  useEffect(() => {
    if (!notice) return;
    if (notice === "welcome") {
      toast.info(t("welcomeToast"));
      return;
    }
    if (notice === "whatsapp") {
      toast.success(t("whatsappConnectedToast"), {
        action: {
          label: t("createTemplateAction"),
          onClick: () => {
            const { router: currentRouter, workspaceId: currentWorkspace } =
              latest.current;
            if (!currentWorkspace) return;
            currentRouter.push(
              panelWorkspaceHref(
                currentWorkspace,
                "messengers/whatsapp-templates?create=1"
              )
            );
          },
        },
      });
      return;
    }
    toast.success(t("integrationSuccessToast"));
  }, [notice, t]);

  return null;
}
