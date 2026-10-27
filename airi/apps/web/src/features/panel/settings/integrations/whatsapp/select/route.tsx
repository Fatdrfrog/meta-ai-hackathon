"use client";

import { WABASelectionPanel } from "@/components/integrations/waba-selection-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

/**
 * WhatsApp Business Account Selection Page
 * Shows when user has multiple WABAs to choose from
 */
function WhatsAppSelectionContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useTranslations("WABASelection");
  const workspaceId = params.workspaceId as string;
  const [initialParams] = useState(() => ({
    selectedWabaId: searchParams.get("selected_waba_id"),
    embedded: searchParams.get("embedded"),
    source: searchParams.get("source"),
    businessId: searchParams.get("business_id"),
    catalogIds: (searchParams.get("catalog_ids") || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean),
    event: searchParams.get("event"),
    flow: searchParams.get("flow"),
    upgradeIntent: searchParams.get("intent") === "upgrade",
  }));
  // The Embedded Signup token stays server-side in an httpOnly session
  // cookie; the URL only says which kind of selection this is.
  const useEmbeddedSignupSession = initialParams.source === "embedded_signup";
  const useExistingCompanyConnection = initialParams.source === "existing";
  const backHref = `/panel/w/${workspaceId}/settings/integrations?type=whatsapp`;

  const handleCancel = () => {
    router.push(backHref);
  };

  const handleSuccess = () => {
    router.push(`${backHref}&new=true`);
  };

  if (!useEmbeddedSignupSession && !useExistingCompanyConnection) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
        <Button
          type="button"
          variant="ghost"
          className="w-fit px-0"
          onClick={handleCancel}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("backToWhatsApp")}
        </Button>
        <Alert>
          <AlertCircle />
          <AlertTitle>{t("sessionExpiredTitle")}</AlertTitle>
          <AlertDescription>{t("sessionExpiredDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <Button
        type="button"
        variant="ghost"
        className="w-fit px-0"
        onClick={handleCancel}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t("backToWhatsApp")}
      </Button>
      <div className="overflow-hidden rounded-2xl bg-background shadow-sm">
        <WABASelectionPanel
          selectionSession={useEmbeddedSignupSession}
          workspaceId={workspaceId}
          onCancel={handleCancel}
          onSuccess={handleSuccess}
          initialSelectedWabaId={initialParams.selectedWabaId}
          businessId={initialParams.businessId}
          catalogIds={initialParams.catalogIds}
          embeddedSignupEvent={initialParams.event}
          embeddedSignupFlow={
            initialParams.flow === "cloud_api" ||
            initialParams.flow === "coexistence"
              ? initialParams.flow
              : null
          }
          upgradeIntent={initialParams.upgradeIntent}
        />
      </div>
    </div>
  );
}

function WhatsAppSelectionFallback() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6 sm:px-6">
      <div className="h-9 w-32 rounded-lg bg-muted" />
      <div className="h-96 rounded-2xl bg-muted/30" />
    </div>
  );
}

export default function WhatsAppSelectionPage() {
  return (
    <Suspense fallback={<WhatsAppSelectionFallback />}>
      <WhatsAppSelectionContent />
    </Suspense>
  );
}
