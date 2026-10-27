"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  startBillingCheckout,
  type BillingCycle,
} from "@/lib/billing/client-checkout";
import { isBillingUiEnabled } from "@/lib/billing/availability";
import { BOOK_DEMO_URL } from "@/lib/links";
import { cn } from "@/lib/utils";
import { CheckCircle2, CreditCard, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

type SubscriptionType = "free" | "pro" | "enterprise";
type PlanGateReason = "trial_expired" | "conversation_limit" | "feature_limit";

type PlanUpgradeDialogProps = {
  workspaceId: string;
  subscriptionType?: SubscriptionType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason?: PlanGateReason;
  hiddenCount?: number;
  featureLabel?: string;
};

const PRO_FEATURE_KEYS = [
  "oneSeat",
  "oneWorkspace",
  "oneWhatsAppNumber",
  "allIntegrations",
  "voiceReplies",
  "proAiUsage",
  "proScenarios",
] as const;

const ENTERPRISE_FEATURE_KEYS = [
  "enterpriseAiUsage",
  "whatsAppCapacity",
  "integrationCapacity",
] as const;

function UnlimitedFeature({
  label,
  unlimitedLabel,
}: {
  label: string;
  unlimitedLabel: string;
}) {
  return (
    <li className="flex items-center gap-2 text-sm font-medium">
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-full border border-foreground/20 text-sm font-black"
      >
        {"\u221e"}
      </span>
      <span className="sr-only">{unlimitedLabel} </span>
      <span>{label}</span>
    </li>
  );
}

function Feature({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm font-medium">
      <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
      <span>{label}</span>
    </li>
  );
}

type PlanUpgradeDialogTranslator = ReturnType<typeof useTranslations>;

function getGateMessage(
  t: PlanUpgradeDialogTranslator,
  params: {
    reason?: PlanGateReason;
    hiddenCount?: number;
    featureLabel?: string;
  }
) {
  if (params.reason === "trial_expired") {
    return t("gateTrialExpired");
  }
  if (
    params.reason === "conversation_limit" &&
    typeof params.hiddenCount === "number" &&
    params.hiddenCount > 0
  ) {
    return t("gateConversationLimit", { hiddenCount: params.hiddenCount });
  }
  if (params.reason === "conversation_limit") {
    // At the cap nothing is hidden yet, but new chats are already refused.
    return t("gateConversationLimitReached");
  }
  if (params.reason === "feature_limit" && params.featureLabel?.trim()) {
    return t("gateFeatureLimit", { featureLabel: params.featureLabel.trim() });
  }
  return t("gateDefault");
}

export function PlanUpgradeDialog({
  workspaceId,
  subscriptionType = "free",
  open,
  onOpenChange,
  reason,
  hiddenCount,
  featureLabel,
}: PlanUpgradeDialogProps) {
  const t = useTranslations("PlanUpgradeDialog");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const billingEnabled = isBillingUiEnabled();
  const showPro = subscriptionType === "free";
  const showEnterprise = subscriptionType !== "enterprise";
  const visiblePlanCount = Number(showPro) + Number(showEnterprise);
  const gateMessage = useMemo(
    () => getGateMessage(t, { reason, hiddenCount, featureLabel }),
    [featureLabel, hiddenCount, reason, t]
  );
  // Radix returns focus to a Dialog trigger, and every caller opens this
  // dialog without one, so closing dropped focus to <body>. Remember the
  // opener before the dialog takes focus and return focus to it.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, [open]);

  async function startProCheckout() {
    setError(null);
    setIsSubmitting(true);
    try {
      await startBillingCheckout(workspaceId, billingCycle);
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : t("checkoutFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The mobile drawer filler must not cover plan cards after scrolling. */}
      <DialogContent
        className={cn(
          "max-h-[92vh] overflow-y-auto after:hidden sm:w-fit sm:max-w-[calc(100vw-2rem)]",
          visiblePlanCount > 1 ? "md:max-w-3xl" : "md:max-w-md"
        )}
        onCloseAutoFocus={event => {
          const opener = openerRef.current;
          if (!opener?.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{gateMessage}</DialogDescription>
        </DialogHeader>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <div
          className={cn(
            "grid justify-center gap-3",
            visiblePlanCount > 1
              ? "md:grid-cols-[minmax(0,22rem)_minmax(0,22rem)]"
              : "md:grid-cols-[minmax(0,22rem)]"
          )}
        >
          {showPro ? (
            <section className="relative rounded-lg border-2 border-foreground bg-background p-4 shadow-[4px_4px_0px_#111827]">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black">Pro</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("proDescription")}
                  </p>
                </div>
                <CreditCard className="size-5 text-primary" />
              </div>
              <Tabs
                value={billingCycle}
                onValueChange={value =>
                  setBillingCycle(value === "annual" ? "annual" : "monthly")
                }
                className="mb-4"
              >
                <TabsList aria-label={t("billingCycle")}>
                  <TabsTrigger value="monthly">{t("monthly")}</TabsTrigger>
                  <TabsTrigger value="annual">{t("annual")}</TabsTrigger>
                </TabsList>
              </Tabs>
              <ul className="mb-5 space-y-2">
                <UnlimitedFeature
                  label={t("features.conversations")}
                  unlimitedLabel={t("unlimited")}
                />
                <UnlimitedFeature
                  label={t("features.bulkCampaigns")}
                  unlimitedLabel={t("unlimited")}
                />
                {PRO_FEATURE_KEYS.map(feature => (
                  <Feature key={feature} label={t(`features.${feature}`)} />
                ))}
              </ul>
              <Button
                type="button"
                className="w-full"
                disabled={!billingEnabled || isSubmitting}
                onClick={startProCheckout}
              >
                {isSubmitting ? t("openingCheckout") : t("upgradeToPro")}
              </Button>
              {!billingEnabled ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("billingDisabled")}
                </p>
              ) : null}
            </section>
          ) : null}

          {showEnterprise ? (
            <section className="rounded-lg border-2 border-foreground bg-[#fff8c7] p-4 shadow-[4px_4px_0px_#111827]">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black">Enterprise</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("enterpriseDescription")}
                  </p>
                </div>
                <ExternalLink className="size-5" />
              </div>
              <ul className="mb-5 space-y-2">
                <UnlimitedFeature
                  label={t("features.seats")}
                  unlimitedLabel={t("unlimited")}
                />
                <UnlimitedFeature
                  label={t("features.workspaces")}
                  unlimitedLabel={t("unlimited")}
                />
                {ENTERPRISE_FEATURE_KEYS.map(feature => (
                  <Feature key={feature} label={t(`features.${feature}`)} />
                ))}
              </ul>
              <Button
                asChild
                type="button"
                variant="secondary"
                className="w-full"
              >
                <a href={BOOK_DEMO_URL} target="_blank" rel="noreferrer">
                  {t("contactSales")}
                </a>
              </Button>
            </section>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
