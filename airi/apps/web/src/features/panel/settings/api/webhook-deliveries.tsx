"use client";

import { ErrorState, LoadingState } from "@/components/ui/async-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WebhookDeliverySummary } from "@/lib/customer-api/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useCustomerApiResource } from "./client-api";

export function WebhookDeliveries({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  const t = useTranslations("CustomerApiSettings");
  const format = useFormatter();
  const { data, error, isLoading, mutate } = useCustomerApiResource<{
    deliveries: WebhookDeliverySummary[];
  }>(url);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{t("deliveries")}</CardTitle>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void mutate()}
            disabled={isLoading}
          >
            {t("retry")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div role="status" aria-label={t("loading")}>
            <LoadingState />
          </div>
        ) : error ? (
          <ErrorState message={t("loadError")} />
        ) : !data?.deliveries.length ? (
          <p className="text-sm text-muted-foreground">{t("noDeliveries")}</p>
        ) : (
          <ul className="divide-y">
            {data.deliveries.map(item => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs">
                    {item.event_type}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {format.dateTime(new Date(item.created_at), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}{" "}
                    · {t("attempt", { count: item.attempt_number })}
                  </p>
                </div>
                <Badge variant="outline">
                  {item.delivered_at ? t("delivered") : t("unsuccessful")}
                  {item.response_status
                    ? ` · HTTP ${item.response_status}`
                    : ""}
                </Badge>
                {!item.delivered_at &&
                item.error_message &&
                item.error_message !== `HTTP ${item.response_status}` ? (
                  <p className="w-full min-w-0 break-all text-xs text-destructive">
                    {item.error_message}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
