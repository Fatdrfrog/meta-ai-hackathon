"use client";

import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  CONVERSATION_PREFERRED_LANGUAGES as LANGUAGE_CODES,
  type ConversationPreferredLanguage as LanguageCode,
} from "@icecore/shared/types/conversation";

export function AiriLanguageSelector({
  initialLanguage,
  readOnly = false,
}: {
  initialLanguage: LanguageCode;
  readOnly?: boolean;
}) {
  const t = useTranslations("AiriLanguageSettings");
  const params = useParams();
  const router = useRouter();
  const workspaceId = params.workspaceId as string;
  const [selectedLanguage, setSelectedLanguage] = useState(initialLanguage);
  const [savedLanguage, setSavedLanguage] = useState(initialLanguage);
  const [isSaving, setIsSaving] = useState(false);
  const [prevInitialLanguage, setPrevInitialLanguage] =
    useState(initialLanguage);

  if (initialLanguage !== prevInitialLanguage) {
    setPrevInitialLanguage(initialLanguage);
    setSelectedLanguage(initialLanguage);
    setSavedLanguage(initialLanguage);
  }
  const hasChanges = selectedLanguage !== savedLanguage;

  const handleSave = async () => {
    if (readOnly || !hasChanges || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch("/api/company-context", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ airiLanguage: selectedLanguage, workspaceId }),
      });
      if (!response.ok) throw new Error("save failed");
      setSavedLanguage(selectedLanguage);
      toast.success(t("saveSuccess"));
      router.refresh();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4 rounded-lg border p-4 sm:p-5">
      <RadioGroup
        aria-label={t("title")}
        value={selectedLanguage}
        onValueChange={value => setSelectedLanguage(value as LanguageCode)}
        disabled={isSaving || readOnly}
        className="grid gap-2 sm:grid-cols-2"
      >
        {LANGUAGE_CODES.map(code => (
          <Label
            key={code}
            htmlFor={`fallback-language-${code}`}
            className="flex cursor-pointer items-center gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
          >
            <RadioGroupItem value={code} id={`fallback-language-${code}`} />
            <span className="min-w-0 text-sm">
              {t(`languages.${code}.nativeName`)}
            </span>
          </Label>
        ))}
      </RadioGroup>
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
          {hasChanges && (
            <p className="mr-auto text-xs text-muted-foreground">
              {t("unsavedChanges")}
            </p>
          )}
          <Button
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            size="sm"
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t(isSaving ? "saving" : "saveChanges")}
          </Button>
        </div>
      )}
    </div>
  );
}
