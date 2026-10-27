"use client";

import { ConversionDialog } from "@/components/conversions/conversion-dialog";
import {
  ConversationBehaviorEvents,
  CONVERSATION_BEHAVIOR_EVENT_TYPES,
  type ConversationBehaviorEventType,
} from "./conversation-behavior-events";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRealtime } from "@/hooks/use-realtime";
import type { PaymentSuggestion } from "@icecore/shared/types/payment-evidence";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { Check, Loader2, ReceiptText, CalendarClock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";

type PaymentSuggestionStatus = PaymentSuggestion & {
  conversionId: string | null;
};
type ConversationSalesData = {
  paymentSuggestions: PaymentSuggestionStatus[];
  defaultCurrency: string;
  transactionIdRequired: boolean;
  transactionIdSupported: boolean;
};

async function fetchSales(url: string): Promise<ConversationSalesData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load conversation sales");
  return response.json();
}

export function ConversationSales({
  conversationId,
  workspaceId,
  onViewMessage,
  presentation = "menu",
}: {
  conversationId: string;
  workspaceId: string;
  onViewMessage: (messageId: string) => boolean | void;
  presentation?: "menu" | "info";
}) {
  const t = useTranslations("ConversionDialog");
  const behaviorT = useTranslations("CustomerBehavior");
  const locale = useLocale();
  const { channel } = useRealtime({ kind: "workspace", workspaceId });
  const [dialog, setDialog] = useState<{
    suggestion?: PaymentSuggestion;
  } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [eventType, setEventType] =
    useState<ConversationBehaviorEventType | null>(null);
  const { data, error, isLoading, mutate } = useSWR<ConversationSalesData>(
    `/api/conversions?${new URLSearchParams({ workspaceId, conversationId, paymentSuggestionsOnly: "true" })}`,
    fetchSales,
    { dedupingInterval: 5000, errorRetryCount: 1 }
  );

  useEffect(() => {
    if (!channel) return;
    const refresh = (event: RealtimeEventEnvelope) => {
      if (
        event.conversationId === conversationId &&
        event.eventId.startsWith("classification-ready:")
      ) {
        void mutate();
      }
    };
    channel.bind("conversation.row.changed", refresh);
    return () => channel.unbind("conversation.row.changed", refresh);
  }, [channel, conversationId, mutate]);

  const pendingCount =
    data?.paymentSuggestions.filter(suggestion => !suggestion.conversionId)
      .length ?? 0;
  const reviewPayments = () => setReviewOpen(true);
  const paymentContent = error ? (
    <div
      role="alert"
      className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive"
    >
      {t("paymentsError")}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 text-xs"
        onClick={() => void mutate()}
      >
        {t("retry")}
      </Button>
    </div>
  ) : isLoading ? (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t("loadingPayments")}
    </p>
  ) : data?.paymentSuggestions.length ? (
    <div className="space-y-2">
      {data.paymentSuggestions.map(suggestion => (
        <div
          key={suggestion.messageId}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
        >
          <div className="min-w-0 flex-1 basis-40">
            <p className="font-medium">
              {t(
                suggestion.kind === "receipt"
                  ? "receiptSuggested"
                  : "paymentClaimSuggested"
              )}
            </p>
            <p className="text-muted-foreground">
              {suggestion.amount === null
                ? t("amountUnknown")
                : new Intl.NumberFormat(locale).format(suggestion.amount)}
              {suggestion.amount !== null &&
                ` ${suggestion.currency || t("currencyUnknown")}`}
              {" · "}
              {t(
                suggestion.conversionId
                  ? "merchantConfirmed"
                  : "needsConfirmation"
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setReviewOpen(false);
                if (onViewMessage(suggestion.messageId) === false) {
                  toast.info(t("sourceMessageNotLoaded"));
                }
              }}
            >
              {t("viewMessage")}
            </Button>
            {suggestion.conversionId ? (
              <span className="inline-flex items-center gap-1 px-2 text-muted-foreground">
                <Check className="size-3.5" aria-hidden />
                {t("saleRecorded")}
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setReviewOpen(false);
                  setDialog({ suggestion });
                }}
              >
                {t("reviewPayment")}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">{t("noPaymentSuggestions")}</p>
  );

  return (
    <>
      {presentation === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative size-8 shrink-0"
              aria-label={t("salesActions")}
              title={t("salesActions")}
            >
              <ReceiptText className="size-4" aria-hidden />
              {(pendingCount > 0 || error) && (
                <span
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                  aria-hidden
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-64 max-w-[calc(100vw-1rem)]"
            onCloseAutoFocus={event => {
              if (dialog || reviewOpen || eventType) event.preventDefault();
            }}
          >
            <DropdownMenuItem
              disabled={!data && !error}
              onSelect={() => setDialog({})}
            >
              <ReceiptText aria-hidden />
              {t("recordSale")}
            </DropdownMenuItem>
            {data?.transactionIdSupported && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <CalendarClock aria-hidden />
                  <span className="min-w-0 whitespace-normal">
                    {behaviorT("recordEvent")}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-w-[calc(100vw-1rem)]">
                  {CONVERSATION_BEHAVIOR_EVENT_TYPES.map(type => (
                    <DropdownMenuItem
                      key={type}
                      onSelect={() => setEventType(type)}
                    >
                      {behaviorT(`events.${type}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={reviewPayments}>
              {isLoading ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Check aria-hidden />
              )}
              {t("paymentSuggestions")}
              {pendingCount > 0 && (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {pendingCount}
                </span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <section aria-label={t("salesActions")} className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant="ghost"
              aria-label={t("recordSale")}
              className="h-auto min-h-16 min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 px-1 py-2 text-xs whitespace-normal"
              disabled={!data && !error}
              onClick={() => setDialog({})}
            >
              <ReceiptText className="size-4 shrink-0" aria-hidden />
              {t("compactSale")}
            </Button>
            {data?.transactionIdSupported && (
              <Button
                type="button"
                variant="ghost"
                aria-label={behaviorT("recordEvent")}
                className="h-auto min-h-16 min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 px-1 py-2 text-xs whitespace-normal"
                onClick={() => setEventType("checkout_started")}
              >
                <CalendarClock className="size-4 shrink-0" aria-hidden />
                {t("compactEvent")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              aria-label={t("paymentSuggestions")}
              className="relative h-auto min-h-16 min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 px-1 py-2 text-xs whitespace-normal"
              onClick={reviewPayments}
            >
              <Check className="size-4 shrink-0" aria-hidden />
              {t("compactPayments")}
              {pendingCount > 0 && (
                <span className="absolute right-1 top-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground tabular-nums">
                  {pendingCount}
                </span>
              )}
            </Button>
          </div>
        </section>
      )}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{t("paymentSuggestions")}</DialogTitle>
          </DialogHeader>
          {paymentContent}
        </DialogContent>
      </Dialog>
      <ConversationBehaviorEvents
        workspaceId={workspaceId}
        conversationId={conversationId}
        eventType={eventType}
        onOpenChange={open => !open && setEventType(null)}
      />
      {dialog && (
        <ConversionDialog
          key={dialog.suggestion?.messageId ?? "manual"}
          conversationId={conversationId}
          open
          onOpenChange={open => !open && setDialog(null)}
          defaultCurrency={data?.defaultCurrency ?? "USD"}
          paymentSuggestion={dialog.suggestion}
          transactionIdRequired={data?.transactionIdRequired}
          transactionIdSupported={data?.transactionIdSupported}
          saleOnly
          onRecorded={() => {
            void mutate();
          }}
        />
      )}
    </>
  );
}
