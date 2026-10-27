"use client";

import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import { invalidateWhatsAppTemplateCatalog } from "@/lib/whatsapp/templates/catalog-client";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useLatestRef } from "../../view/use-latest-ref";
import { showScenarioErrorToast } from "./action-node-utils";

type TemplateCreationInput = {
  workspaceId: string | null;
  scenarioId?: string | null;
  nodeId: string;
  templateName?: string;
  templateLanguage?: string;
  submitGenerated: () => Promise<boolean>;
  refreshTemplates: () => void | Promise<void>;
};

export function useWhatsAppTemplateCreation({
  workspaceId,
  scenarioId,
  nodeId,
  templateName,
  templateLanguage,
  submitGenerated: submitGeneratedCommand,
  refreshTemplates,
}: TemplateCreationInput) {
  const t = useTranslations("Scenarios");
  // Provider-assigned template IDs/status change on our own successful submit.
  // The canonical command checks the complete target before returning true.
  const visitOwner = useTransitionOwnerKey(
    JSON.stringify([
      workspaceId,
      scenarioId,
      nodeId,
      templateName?.trim() || "",
      normalizeWhatsAppTemplateLanguageCode(templateLanguage || "en") ||
        templateLanguage,
    ])
  );
  const ownerRef = useLatestRef(visitOwner);
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  const createDrawerOpen = openOwner === visitOwner;
  const drawerVisit = useTransitionOwnerKey(
    JSON.stringify([visitOwner, createDrawerOpen])
  );
  const drawerVisitRef = useLatestRef(drawerVisit);

  useEffect(
    () => () => {
      ownerRef.current = "";
      drawerVisitRef.current = "";
    },
    [ownerRef, drawerVisitRef]
  );

  const setCreateDrawerOpen = useCallback(
    (open: boolean) => {
      if (
        ownerRef.current !== visitOwner ||
        drawerVisitRef.current !== drawerVisit
      )
        return;
      setOpenOwner(open ? visitOwner : null);
    },
    [drawerVisit, drawerVisitRef, ownerRef, visitOwner]
  );

  const onCreateSuccess = useCallback(() => {
    if (
      !createDrawerOpen ||
      ownerRef.current !== visitOwner ||
      drawerVisitRef.current !== drawerVisit
    )
      return;
    setOpenOwner(null);
    if (workspaceId) invalidateWhatsAppTemplateCatalog(workspaceId);
    void refreshTemplates();
  }, [
    createDrawerOpen,
    drawerVisit,
    drawerVisitRef,
    refreshTemplates,
    ownerRef,
    visitOwner,
    workspaceId,
  ]);

  const submitGenerated = useCallback(async () => {
    if (ownerRef.current !== visitOwner) return;
    try {
      const accepted = await submitGeneratedCommand();
      if (accepted && ownerRef.current === visitOwner) {
        toast.success(t("whatsappTemplateSentForReview"));
        if (workspaceId) invalidateWhatsAppTemplateCatalog(workspaceId);
        void refreshTemplates();
      }
    } catch (error) {
      if (ownerRef.current === visitOwner)
        showScenarioErrorToast(
          t("whatsappTemplateSendForReviewFailed"),
          error,
          {
            showReason: true,
          }
        );
    }
  }, [
    submitGeneratedCommand,
    ownerRef,
    refreshTemplates,
    t,
    visitOwner,
    workspaceId,
  ]);
  return {
    createDrawerOpen,
    setCreateDrawerOpen,
    onCreateSuccess,
    submitGenerated,
  };
}
