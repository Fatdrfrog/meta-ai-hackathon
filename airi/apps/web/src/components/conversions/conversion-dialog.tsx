"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "next-intl";
import type { PaymentSuggestion } from "@icecore/shared/types/payment-evidence";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

interface ConversionDialogProps {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCurrency?: string;
  paymentSuggestion?: PaymentSuggestion;
  transactionIdRequired?: boolean;
  transactionIdSupported?: boolean;
  saleOnly?: boolean;
  onRecorded?: () => void;
}

export function ConversionDialog({
  conversationId,
  open,
  onOpenChange,
  defaultCurrency = "USD",
  paymentSuggestion,
  transactionIdRequired = false,
  transactionIdSupported = false,
  saleOnly = false,
  onRecorded,
}: ConversionDialogProps) {
  const t = useTranslations("ConversionDialog");
  const [conversionType, setConversionType] = useState<string>("sale");
  const [value, setValue] = useState<string>(
    paymentSuggestion?.amount?.toString() ?? ""
  );
  const [currency, setCurrency] = useState<string>(
    paymentSuggestion?.currency || defaultCurrency
  );
  const [notes, setNotes] = useState<string>("");
  const [transactionId, setTransactionId] = useState("");
  const [referenceRequiredByServer, setReferenceRequiredByServer] =
    useState(false);
  const [referenceError, setReferenceError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const formId = useId();
  const isSale = saleOnly || Boolean(paymentSuggestion);
  const recordsSale = isSale || conversionType === "sale";
  const needsTransactionId =
    recordsSale && (transactionIdRequired || referenceRequiredByServer);
  const showTransactionId =
    recordsSale && (transactionIdSupported || needsTransactionId);
  const amount = Number(value);
  const validAmount =
    value.trim() !== "" &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 99999999.99 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001;
  const canSubmit =
    ((!recordsSale && value === "") || validAmount) &&
    (!needsTransactionId || transactionId.trim().length > 0);

  const CONVERSION_TYPES = [
    { value: "sale", label: t("conversionTypes.sale") },
    { value: "signup", label: t("conversionTypes.signup") },
    { value: "booking", label: t("conversionTypes.booking") },
    { value: "retention", label: t("conversionTypes.retention") },
    { value: "custom", label: t("conversionTypes.custom") },
  ];

  const CURRENCIES = [
    { value: "USD", label: t("currencies.USD") },
    { value: "EUR", label: t("currencies.EUR") },
    { value: "KZT", label: t("currencies.KZT") },
    { value: "RUB", label: t("currencies.RUB") },
    { value: "UZS", label: t("currencies.UZS") },
  ];
  if (!CURRENCIES.some(item => item.value === currency)) {
    CURRENCIES.push({ value: currency, label: currency });
  }

  const handleSubmit = async () => {
    if (inFlight.current || !canSubmit) return;
    inFlight.current = true;
    setSubmitting(true);
    setReferenceError(false);

    try {
      const res = await fetch("/api/conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          conversionType: isSale ? "sale" : conversionType,
          conversionValue: value ? amount : undefined,
          currency,
          metadata: notes ? { notes } : {},
          ...(showTransactionId && transactionId.trim()
            ? { transactionId: transactionId.trim() }
            : {}),
          ...(paymentSuggestion
            ? { paymentEvidenceMessageId: paymentSuggestion.messageId }
            : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.code === "transaction_id_required") {
          setReferenceRequiredByServer(true);
          setReferenceError(true);
          return;
        }
        throw new Error("Failed to track conversion");
      }

      toast.success(t("toast.success"));
      onRecorded?.();
      onOpenChange(false);

      // Reset form
      setConversionType("sale");
      setValue("");
      setCurrency(defaultCurrency);
      setNotes("");
      setTransactionId("");
      setReferenceRequiredByServer(false);
    } catch {
      toast.error(t("toast.error"));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => !inFlight.current && onOpenChange(next)}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(isSale ? "recordSale" : "title")}</DialogTitle>
          <DialogDescription>
            {t(
              paymentSuggestion
                ? "paymentConfirmationDescription"
                : isSale
                  ? "saleDescription"
                  : "description"
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          className="space-y-4 py-4"
          onSubmit={event => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          {/* Conversion Type */}
          {!isSale && (
            <div className="space-y-2">
              <Label htmlFor={`${formId}-type`}>{t("conversionType")}</Label>
              <Select
                value={conversionType}
                onValueChange={setConversionType}
                disabled={submitting}
              >
                <SelectTrigger id={`${formId}-type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONVERSION_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>
                      <span>{type.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Value */}
          <div className="space-y-2">
            <Label htmlFor={`${formId}-value`}>
              {t(isSale ? "saleAmount" : "conversionValue")}
            </Label>
            <div className="flex gap-2">
              <Input
                id={`${formId}-value`}
                type="number"
                min="0.01"
                max="99999999.99"
                step="0.01"
                required={recordsSale}
                disabled={submitting}
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={t("valuePlaceholder")}
                className="min-w-0 flex-1"
              />
              <Select
                value={currency}
                onValueChange={setCurrency}
                disabled={submitting}
              >
                <SelectTrigger
                  className="w-24 shrink-0"
                  aria-label={t("currency")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map(curr => (
                    <SelectItem key={curr.value} value={curr.value}>
                      {curr.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {showTransactionId && (
            <div className="space-y-2">
              <Label htmlFor={`${formId}-transaction`}>
                {t(
                  needsTransactionId ? "transactionIdRequired" : "transactionId"
                )}
              </Label>
              <Input
                id={`${formId}-transaction`}
                value={transactionId}
                onChange={event => setTransactionId(event.target.value)}
                maxLength={200}
                required={needsTransactionId}
                disabled={submitting}
                aria-describedby={`${formId}-transaction-help`}
                aria-invalid={referenceError}
              />
              <p
                id={`${formId}-transaction-help`}
                className="text-xs text-muted-foreground"
              >
                {t(
                  needsTransactionId
                    ? "transactionIdRequiredHelp"
                    : "transactionIdHelp"
                )}
              </p>
              {referenceError && (
                <p role="alert" className="text-sm text-destructive">
                  {t("transactionIdMissing")}
                </p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor={`${formId}-notes`}>{t("notes")}</Label>
            <Textarea
              id={`${formId}-notes`}
              disabled={submitting}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              rows={3}
            />
          </div>
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={submitting || !canSubmit}
          >
            {submitting
              ? t("tracking")
              : t(isSale ? "confirmSale" : "trackConversion")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
