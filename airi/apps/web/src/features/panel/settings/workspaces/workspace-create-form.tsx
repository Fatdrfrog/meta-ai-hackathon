"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormStatus } from "react-dom";

function WorkspaceFormFields() {
  const t = useTranslations("Workspaces");
  const { pending } = useFormStatus();
  return (
    <fieldset
      disabled={pending}
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
    >
      <div className="min-w-0 flex-1 space-y-2">
        <Label htmlFor="workspace-name">{t("nameLabel")}</Label>
        <Input
          id="workspace-name"
          name="name"
          placeholder={t("namePlaceholder")}
          minLength={2}
          maxLength={100}
          required
        />
      </div>
      <Button type="submit" size="sm" aria-busy={pending} className="shrink-0">
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Plus className="size-4" />
        )}
        {pending ? t("creating") : t("createButton")}
      </Button>
    </fieldset>
  );
}

export function WorkspaceCreateForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <WorkspaceFormFields />
    </form>
  );
}
