"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useId, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

export type WhatsAppQrDeleteCodeTarget = {
  codeId: string;
  referenceCode?: string;
  isCurrent: boolean;
};

export type WhatsAppQrDeleteCodeDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  target: WhatsAppQrDeleteCodeTarget | null;
  busy: boolean;
  disabled?: boolean;
  activeAssignment?: {
    scenarioId: string;
    scenarioName: string;
    scenarioHref: string;
  } | null;
  onConfirm(codeId: string): void | Promise<void>;
};

export function WhatsAppQrDeleteCodeDialog(
  props: WhatsAppQrDeleteCodeDialogProps
) {
  const owner = `${props.open ? "open" : "closed"}:${props.target?.codeId ?? "none"}`;
  return <OwnedWhatsAppQrDeleteCodeDialog key={owner} {...props} />;
}

function OwnedWhatsAppQrDeleteCodeDialog({
  open,
  onOpenChange,
  target,
  busy,
  disabled = busy,
  activeAssignment,
  onConfirm,
}: WhatsAppQrDeleteCodeDialogProps) {
  const t = useTranslations("WhatsAppQr");
  const acknowledgementId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = Boolean(activeAssignment);
  const providerCodeLabel = target?.referenceCode || target?.codeId || "";
  const providerCodeIdentity =
    target?.referenceCode && target.codeId
      ? t("deleteDialog.codeIdentity", {
          referenceCode: target.referenceCode,
          codeId: target.codeId,
        })
      : providerCodeLabel;

  return (
    <AlertDialog
      open={open}
      onOpenChange={nextOpen => {
        if (nextOpen || !busy) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent
        data-testid="whatsapp-qr-delete-code-dialog"
        className="min-w-0 max-w-[calc(100vw-2rem)] overflow-x-hidden sm:max-w-lg"
      >
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle className="min-w-0 break-words [overflow-wrap:anywhere]">
            {t("deleteDialog.title")}
          </AlertDialogTitle>
          <AlertDialogDescription className="min-w-0 break-words [overflow-wrap:anywhere]">
            {t(
              target?.isCurrent
                ? "deleteDialog.currentDescription"
                : "deleteDialog.historicalDescription",
              { code: providerCodeIdentity }
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {activeAssignment ? (
          <Alert variant="destructive" className="min-w-0 overflow-hidden">
            <AlertTitle className="min-w-0 break-words [overflow-wrap:anywhere]">
              {t("deleteDialog.activeTitle")}
            </AlertTitle>
            <AlertDescription className="min-w-0 break-words [overflow-wrap:anywhere]">
              <Link
                href={activeAssignment.scenarioHref}
                className="font-medium underline underline-offset-4 [overflow-wrap:anywhere]"
              >
                {t("deleteDialog.activeDescription", {
                  scenarioName: activeAssignment.scenarioName,
                })}
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}

        <Field
          orientation="horizontal"
          data-disabled={blocked || disabled || undefined}
        >
          <Checkbox
            id={acknowledgementId}
            checked={acknowledged}
            onCheckedChange={checked => setAcknowledged(checked === true)}
            disabled={blocked || disabled}
          />
          <FieldLabel htmlFor={acknowledgementId} className="font-normal">
            {t("deleteDialog.acknowledgement")}
          </FieldLabel>
        </Field>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={disabled}>
            {t("actions.cancel")}
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || !acknowledged || blocked || disabled}
            onClick={() => {
              if (target) void onConfirm(target.codeId);
            }}
          >
            {busy ? (
              <span data-icon="inline-start">
                <Spinner />
              </span>
            ) : null}
            {t("deleteDialog.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
