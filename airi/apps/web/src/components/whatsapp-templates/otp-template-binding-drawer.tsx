"use client";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import { Loader2, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export type OtpTemplateBindingView = {
  id: string;
  workspaceId: string;
  channel: "whatsapp";
  purpose: string;
  templateId: string;
  templateName: string;
  languageCode: string;
  mode: "copy_code";
  ttlSeconds: number;
  maxAttempts: number;
  enabled: boolean;
};

type OtpTemplateBindingDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  template: WhatsAppTemplate | null;
  bindings: OtpTemplateBindingView[];
  onSaved: (binding: OtpTemplateBindingView) => void;
};

const PURPOSE_OPTIONS = [
  "login",
  "signup",
  "password_reset",
  "custom",
] as const;

type OtpBindingFormState = {
  purpose: string;
  customPurpose: string;
  ttlSeconds: string;
  maxAttempts: string;
  enabled: boolean;
};

function findBindingForTemplate(
  bindings: OtpTemplateBindingView[],
  template: WhatsAppTemplate | null
) {
  if (!template) return null;
  return (
    bindings.find(
      binding =>
        binding.templateName === template.name &&
        binding.languageCode === template.language
    ) || null
  );
}

function isKnownPurpose(value: string): boolean {
  return PURPOSE_OPTIONS.some(option => option === value);
}

function buildInitialFormState(
  existingBinding: OtpTemplateBindingView | null
): OtpBindingFormState {
  const nextPurpose = existingBinding?.purpose || "login";
  const knownPurpose = isKnownPurpose(nextPurpose);
  return {
    purpose: knownPurpose ? nextPurpose : "custom",
    customPurpose: knownPurpose ? "" : nextPurpose,
    ttlSeconds: String(existingBinding?.ttlSeconds || 300),
    maxAttempts: String(existingBinding?.maxAttempts || 5),
    enabled: existingBinding?.enabled ?? true,
  };
}

function getDrawerFormKey(input: {
  open: boolean;
  template: WhatsAppTemplate | null;
  existingBinding: OtpTemplateBindingView | null;
}): string {
  if (!input.open) return "closed";
  return [
    input.template?.name || "no-template",
    input.template?.language || "no-language",
    input.existingBinding?.id || "new-binding",
  ].join(":");
}

export function OtpTemplateBindingDrawer({
  open,
  onOpenChange,
  workspaceId,
  template,
  bindings,
  onSaved,
}: OtpTemplateBindingDrawerProps) {
  const existingBinding = useMemo(
    () => findBindingForTemplate(bindings, template),
    [bindings, template]
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <OtpTemplateBindingDrawerForm
        key={getDrawerFormKey({ open, template, existingBinding })}
        existingBinding={existingBinding}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        template={template}
        workspaceId={workspaceId}
      />
    </Drawer>
  );
}

function OtpTemplateBindingDrawerForm({
  existingBinding,
  onOpenChange,
  onSaved,
  template,
  workspaceId,
}: {
  existingBinding: OtpTemplateBindingView | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (binding: OtpTemplateBindingView) => void;
  template: WhatsAppTemplate | null;
  workspaceId: string;
}) {
  const t = useTranslations("templates.otpBinding");
  const purposeOptions = useMemo(
    () =>
      PURPOSE_OPTIONS.map(value => ({
        value,
        label: t(`purposes.${value}`),
      })),
    [t]
  );
  const [formState, setFormState] = useState(() =>
    buildInitialFormState(existingBinding)
  );
  const [saving, setSaving] = useState(false);

  const effectivePurpose =
    formState.purpose === "custom"
      ? formState.customPurpose.trim()
      : formState.purpose;
  const canSave =
    Boolean(template) &&
    effectivePurpose.length > 0 &&
    Number.parseInt(formState.ttlSeconds, 10) >= 60 &&
    Number.parseInt(formState.maxAttempts, 10) >= 1;

  async function handleSave() {
    if (!template || !canSave) return;

    setSaving(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/otp/whatsapp-bindings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purpose: effectivePurpose,
            templateName: template.name,
            languageCode: template.language,
            ttlSeconds: Number.parseInt(formState.ttlSeconds, 10),
            maxAttempts: Number.parseInt(formState.maxAttempts, 10),
            enabled: formState.enabled,
          }),
        }
      );
      const data = (await response.json()) as {
        success?: boolean;
        binding?: OtpTemplateBindingView;
        error?: string;
      };

      if (!response.ok || !data.success || !data.binding) {
        throw new Error(data.error || t("connectFailed"));
      }

      onSaved(data.binding);
      toast.success(t("connectSuccess"));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("connectFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DrawerContent className="sm:max-w-md">
      <DrawerHeader>
        <DrawerTitle>{t("title")}</DrawerTitle>
        <DrawerDescription>
          {template
            ? t("descriptionWithTemplate", {
                name: template.name,
                language: template.language,
              })
            : t("descriptionEmpty")}
        </DrawerDescription>
      </DrawerHeader>

      <div className="space-y-5 px-4">
        <div className="space-y-2">
          <Label htmlFor="otp-purpose">{t("purpose")}</Label>
          <Select
            value={formState.purpose}
            onValueChange={value =>
              setFormState(previous => ({ ...previous, purpose: value }))
            }
          >
            <SelectTrigger id="otp-purpose" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {purposeOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {formState.purpose === "custom" && (
          <div className="space-y-2">
            <Label htmlFor="otp-custom-purpose">{t("customPurpose")}</Label>
            <Input
              id="otp-custom-purpose"
              value={formState.customPurpose}
              onChange={event =>
                setFormState(previous => ({
                  ...previous,
                  customPurpose: event.target.value,
                }))
              }
              placeholder={t("customPurposePlaceholder")}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="otp-ttl">{t("ttlSeconds")}</Label>
            <Input
              id="otp-ttl"
              min={60}
              max={600}
              type="number"
              value={formState.ttlSeconds}
              onChange={event =>
                setFormState(previous => ({
                  ...previous,
                  ttlSeconds: event.target.value,
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="otp-attempts">{t("maxAttempts")}</Label>
            <Input
              id="otp-attempts"
              min={1}
              max={10}
              type="number"
              value={formState.maxAttempts}
              onChange={event =>
                setFormState(previous => ({
                  ...previous,
                  maxAttempts: event.target.value,
                }))
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border p-3">
          <Label htmlFor="otp-enabled">{t("enabled")}</Label>
          <Switch
            id="otp-enabled"
            checked={formState.enabled}
            onCheckedChange={checked =>
              setFormState(previous => ({ ...previous, enabled: checked }))
            }
          />
        </div>
      </div>

      <DrawerFooter>
        <Button onClick={handleSave} disabled={!canSave || saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t("save")}
        </Button>
      </DrawerFooter>
    </DrawerContent>
  );
}
