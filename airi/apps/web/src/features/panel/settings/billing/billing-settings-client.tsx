"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { startBillingCheckout } from "@/lib/billing/client-checkout";
import { AlertCircle, CreditCard, Loader2, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import useSWR from "swr";

type BillingSummary = {
  provider?: string;
  billingConfigured: boolean;
  subscription?: {
    status?: string | null;
    current_period_end?: string | null;
    cancel_at_period_end?: boolean | null;
  } | null;
  paymentMethod?: { id: string; card_mask?: string | null } | null;
  invoices: Array<{
    id: string;
    status: string;
    provider_invoice_id: string;
    period_start: string;
    period_end: string;
  }>;
};

const fetcher = async (url: string): Promise<BillingSummary> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load billing");
  return response.json();
};

export function BillingSettingsClient({
  workspaceId,
  canManageBilling = false,
}: {
  workspaceId: string;
  canManageBilling?: boolean;
}) {
  const t = useTranslations("BillingSettings");
  const locale = useLocale();
  const {
    data: limits,
    error: planError,
    isLoading: isPlanLoading,
    mutate: mutateLimits,
  } = useCompanyLimits(workspaceId);
  const { data, error, isLoading, mutate } = useSWR<BillingSummary>(
    `/api/workspaces/${workspaceId}/billing/summary`,
    fetcher
  );
  const [actionError, setActionError] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const subscription = data?.subscription;
  const subscriptionStatus = subscription?.status;
  const renewable = ["active", "trialing", "past_due"].includes(
    subscriptionStatus ?? ""
  );
  // The checkout owner creates a new subscription, so it cannot update an existing card.
  const canStartSubscription =
    !planError &&
    limits?.subscriptionType === "free" &&
    (!subscription ||
      subscriptionStatus === "canceled" ||
      subscriptionStatus === "cancelled");
  const canAct = canManageBilling && Boolean(data?.billingConfigured) && !error;
  const planUnavailable = planError || (!limits && !isPlanLoading);

  async function refresh() {
    await Promise.allSettled([mutate(), mutateLimits?.()]);
  }

  function formatDate(value?: string | null) {
    const date = value ? new Date(value) : null;
    if (!date) return t("notScheduled");
    if (Number.isNaN(date.getTime())) return t("dateUnavailable");
    return new Intl.DateTimeFormat(locale === "kz" ? "kk" : locale, {
      dateStyle: "medium",
    }).format(date);
  }

  function statusLabel(status?: string | null) {
    const known = [
      "active",
      "trialing",
      "past_due",
      "paused",
      "canceled",
      "cancelled",
      "paid",
      "pending",
      "failed",
      "requires_action",
      "draft",
      "open",
      "completed",
      "billed",
    ];
    return status && known.includes(status)
      ? t(`status.${status}`)
      : t(status ? "status.unknown" : "status.none");
  }

  async function runAction(action: string) {
    setActionError(false);
    setPendingAction(action);
    try {
      if (action === "checkout") {
        await startBillingCheckout(workspaceId, "monthly");
      } else {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/billing/${action}`,
          { method: "POST" }
        );
        if (!response.ok) throw new Error("Billing action failed");
        await mutate();
      }
    } catch {
      setActionError(true);
    } finally {
      setPendingAction(null);
    }
  }

  if (isLoading && !data) {
    return (
      <div role="status" aria-label={t("loading")} className="space-y-4">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
    );
  }

  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>{t("unavailable")}</AlertTitle>
        <AlertDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-4" />
            {t("refresh")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      {error || actionError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t(error ? "refreshFailed" : "actionFailed")}</AlertTitle>
          <AlertDescription>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
            >
              {t("refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {!data.billingConfigured ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>{t("checkoutUnavailable")}</AlertTitle>
          <AlertDescription>{t("checkoutUnavailableHint")}</AlertDescription>
        </Alert>
      ) : null}
      {planUnavailable ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t("planUnavailable")}</AlertTitle>
          <AlertDescription>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
            >
              {t("refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              {isPlanLoading && !limits ? (
                <Skeleton
                  role="status"
                  aria-label={t("loadingPlan")}
                  className="h-5 w-24"
                />
              ) : limits?.subscriptionType ? (
                t(`plans.${limits.subscriptionType}`)
              ) : (
                t("subscription")
              )}
            </CardTitle>
            <Badge
              variant={
                subscriptionStatus === "past_due" ? "destructive" : "secondary"
              }
            >
              {statusLabel(subscriptionStatus)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("periodEnds")}</dt>
              <dd className="mt-1 font-medium">
                {formatDate(subscription?.current_period_end)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("renewal")}</dt>
              <dd className="mt-1 font-medium">
                {t(
                  subscription?.cancel_at_period_end
                    ? "endsAtPeriod"
                    : renewable
                      ? "renews"
                      : "noRenewal"
                )}
              </dd>
            </div>
            {data.provider === "paddle" ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">{t("paymentMethod")}</dt>
                <dd className="mt-1">{t("managedByPaddle")}</dd>
              </div>
            ) : data.paymentMethod?.card_mask ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">{t("paymentMethod")}</dt>
                <dd className="mt-1">{data.paymentMethod.card_mask}</dd>
              </div>
            ) : null}
          </dl>
          {canAct ? (
            <div
              className="flex flex-wrap gap-2"
              aria-busy={Boolean(pendingAction)}
            >
              {canStartSubscription ? (
                <Button
                  type="button"
                  disabled={Boolean(pendingAction)}
                  onClick={() => void runAction("checkout")}
                >
                  <CreditCard className="size-4" />
                  {t("upgrade")}
                </Button>
              ) : null}
              {renewable ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(pendingAction)}
                  onClick={() =>
                    void runAction(
                      subscription?.cancel_at_period_end
                        ? "reactivate"
                        : "cancel"
                    )
                  }
                >
                  {pendingAction ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {t(
                    subscription?.cancel_at_period_end
                      ? "reactivate"
                      : "cancelRenewal"
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!canManageBilling ? (
            <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t("invoices")}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {data.invoices.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t("noInvoices")}
            </p>
          ) : (
            <ul className="divide-y">
              {data.invoices.map(invoice => (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="break-all font-medium">
                      {invoice.provider_invoice_id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(invoice.period_start)} –{" "}
                      {formatDate(invoice.period_end)}
                    </p>
                  </div>
                  <Badge
                    variant={
                      invoice.status === "failed" ||
                      invoice.status === "requires_action"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {statusLabel(invoice.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
