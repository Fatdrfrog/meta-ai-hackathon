"use client";

import { CopyableInput } from "@/components/integrations/copyable-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";

export function SecretDialog({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("CustomerApiSettings");
  return (
    <Dialog
      open={Boolean(secret)}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("secretTitle")}</DialogTitle>
          <DialogDescription>{t("secretDescription")}</DialogDescription>
        </DialogHeader>
        <CopyableInput
          value={secret ?? ""}
          label={t("secretLabel")}
          copySuccessMessage={t("copied")}
          copyLabel={t("copy")}
          copyFailureMessage={t("copyError")}
        />
        <DialogFooter>
          <Button onClick={onClose}>{t("done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
