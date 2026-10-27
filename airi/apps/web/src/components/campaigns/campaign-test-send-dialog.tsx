"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchWhatsAppTestPhone,
  postWhatsAppTestSend,
  type WhatsAppTestSendErrorCode,
} from "@/lib/whatsapp/test-send";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { AlertCircle, Loader2, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

type CampaignTestSendDialogProps = {
  workspaceId: string;
  sourceId?: string;
  template: { name: string; language: string };
  /** Resolved variable values; empty ones fall back to Meta's samples. */
  variables: Record<string, string>;
  recipientName?: string;
  /** Says where the variable values come from. */
  valuesFrom: "recipient" | "sample";
  disabled?: boolean;
};

type SendError = { code: WhatsAppTestSendErrorCode; variables?: string[] };

/**
 * "Send a test to my WhatsApp": sends the chosen template to the user's own
 * number before the campaign goes out.
 */
export function CampaignTestSendDialog({
  workspaceId,
  sourceId,
  template,
  variables,
  recipientName,
  valuesFrom,
  disabled = false,
}: CampaignTestSendDialogProps) {
  const t = useTranslations("CampaignTestSend");
  const phoneId = useId();
  const hintId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<SendError | null>(null);
  // The saved number fills the field once, and never over what was typed.
  const phoneTouchedRef = useRef(false);
  const savedPhoneLoadedRef = useRef(false);

  useEffect(() => {
    if (!open || savedPhoneLoadedRef.current) return;
    savedPhoneLoadedRef.current = true;
    let cancelled = false;
    void fetchWhatsAppTestPhone()
      .then(saved => {
        if (!cancelled && saved && !phoneTouchedRef.current) {
          setPhone(`+${saved}`);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // React bubbles submit through the portal into the campaign form, which
    // would validate or even send the campaign.
    event.stopPropagation();
    if (sending) return;
    if (!normalizeWhatsAppPhone(phone)) {
      setError({ code: "invalid_phone" });
      return;
    }
    setError(null);
    setSending(true);
    try {
      const result = await postWhatsAppTestSend({
        workspaceId,
        ...(sourceId ? { sourceId } : {}),
        to: phone,
        templateName: template.name,
        language: template.language,
        variables,
        ...(recipientName ? { recipientName } : {}),
        origin: "bulk_builder",
      });
      if (result.ok) {
        toast.success(t("sent", { phone: `+${result.to}` }));
        setOpen(false);
        return;
      }
      setError({ code: result.code, variables: result.variables });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={disabled}
        >
          <Smartphone data-icon="inline-start" />
          {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", { template: template.name })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={phoneId}>{t("phoneLabel")}</Label>
            <Input
              id={phoneId}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t("phonePlaceholder")}
              value={phone}
              disabled={sending}
              aria-invalid={error?.code === "invalid_phone" || undefined}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              onChange={event => {
                phoneTouchedRef.current = true;
                setPhone(event.target.value);
                if (error?.code === "invalid_phone") setError(null);
              }}
            />
            <p id={hintId} className="text-xs text-muted-foreground">
              {valuesFrom === "recipient"
                ? t("valuesFromRecipient")
                : t("valuesFromSample")}{" "}
              {t("phoneSaved")}
            </p>
          </div>
          {error ? (
            <Alert variant="destructive" id={errorId}>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="break-words">
                {t(`errors.${error.code}`, {
                  variables: (error.variables ?? [])
                    .map(variable => `{{${variable}}}`)
                    .join(", "),
                })}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={sending}>
                {t("cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={sending}>
              {sending ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              {sending ? t("sending") : t("send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
