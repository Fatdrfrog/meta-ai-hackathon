import { BillingSettingsClient } from "./billing-settings-client";
import { CreditCard } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireBillingWorkspaceAdmin } from "@/lib/billing/access";

export default async function BillingSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [t, access] = await Promise.all([
    getTranslations("BillingSettings"),
    requireBillingWorkspaceAdmin(workspaceId),
  ]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          {t("title")}
        </h3>
      </div>

      <BillingSettingsClient
        workspaceId={workspaceId}
        canManageBilling={access.ok}
      />
    </div>
  );
}
