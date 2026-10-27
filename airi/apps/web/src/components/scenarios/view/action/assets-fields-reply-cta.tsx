"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ScenarioReplyCtaType, TranslateFn } from "../../types";
import { FIELD_LABEL_CLASS } from "./assets-fields-utils";
import type {
  ScenarioActionCtaFlowPicker,
  ScenarioActionPrimaryLinkDraft,
} from "./use-assets-fields-state";

function isDraftFlow(status: string | undefined): boolean {
  return status?.toUpperCase() === "DRAFT";
}

function CtaButtonTextField({
  id,
  ctaType,
  value,
  onChange,
  t,
}: {
  id: string;
  ctaType: ScenarioReplyCtaType;
  value?: string;
  onChange?: (value: string) => void;
  t: TranslateFn;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className={FIELD_LABEL_CLASS}>
        {t("buttonText")}
      </Label>
      <Input
        id={id}
        value={value || ""}
        onChange={event => onChange?.(event.target.value)}
        maxLength={ctaType === "link" ? 20 : 30}
        placeholder={
          ctaType === "flow"
            ? t("actionCtaFlowLabelPlaceholder")
            : t("actionCtaLinkLabelPlaceholder")
        }
        className="nodrag nopan h-8"
      />
    </div>
  );
}

function CtaPrimaryLinkField({
  primaryLink,
  t,
}: {
  primaryLink: ScenarioActionPrimaryLinkDraft;
  t: TranslateFn;
}) {
  return (
    <div className="space-y-1">
      <Input
        type="url"
        inputMode="url"
        value={primaryLink.draft}
        aria-label={t("actionLinkInputLabel")}
        onChange={event => primaryLink.setDraft(event.target.value)}
        onBlur={primaryLink.commit}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          primaryLink.commit();
        }}
        placeholder={t("actionAddLinkPlaceholder")}
        className="nodrag nopan h-8"
      />
      {primaryLink.hasDuplicate ? (
        <p className="text-[11px] text-muted-foreground">
          {t("actionAddLinkAlreadyExists")}
        </p>
      ) : null}
    </div>
  );
}

function CtaFlowSelect({
  ctaFlowId,
  flowPicker,
  onCtaFlowIdChange,
  t,
}: {
  ctaFlowId?: string;
  flowPicker: ScenarioActionCtaFlowPicker;
  onCtaFlowIdChange?: (flowId: string) => void;
  t: TranslateFn;
}) {
  return (
    <Select
      value={ctaFlowId || "__none__"}
      onOpenChange={flowPicker.onOpenChange}
      onValueChange={value =>
        onCtaFlowIdChange?.(value === "__none__" ? "" : value)
      }
    >
      <SelectTrigger
        aria-label={t("actionCtaTypeFlow")}
        className="nodrag nopan nokey h-8"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SelectValue placeholder={t("actionCtaFlowPlaceholder")} />
          {flowPicker.showLoading ? (
            <>
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-hidden
              />
              <span className="sr-only">{t("flowPickerExistingLoading")}</span>
            </>
          ) : null}
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">
          {t("actionCtaFlowPlaceholder")}
        </SelectItem>
        {flowPicker.options.map(flow => (
          <SelectItem key={flow.id} value={flow.id} textValue={flow.name}>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{flow.name}</span>
              {isDraftFlow(flow.status) ? (
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[10px] font-normal"
                >
                  {t("flowStatusDraft")}
                </Badge>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Form picker, or its loading and empty states while no form can be picked. */
function CtaFlowField({
  ctaFlowId,
  flowPicker,
  onCtaFlowIdChange,
  t,
}: {
  ctaFlowId?: string;
  flowPicker: ScenarioActionCtaFlowPicker;
  onCtaFlowIdChange?: (flowId: string) => void;
  t: TranslateFn;
}) {
  if (flowPicker.options.length > 0) {
    return (
      <CtaFlowSelect
        ctaFlowId={ctaFlowId}
        flowPicker={flowPicker}
        onCtaFlowIdChange={onCtaFlowIdChange}
        t={t}
      />
    );
  }
  if (flowPicker.showLoading) {
    return (
      <div role="status" data-testid="scenario-action-cta-flow-loading">
        <Skeleton className="h-8 w-full" />
        <span className="sr-only">{t("flowPickerExistingLoading")}</span>
      </div>
    );
  }
  return (
    <p className="rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground">
      {t("actionCtaFlowNoOptions")}
    </p>
  );
}

/** WhatsApp reply button: its type, text, and the link or form it opens. */
export function ScenarioActionReplyCtaFields({
  fieldId,
  ctaType,
  ctaButtonLabel,
  ctaFlowId,
  showInlineLinkInput,
  primaryLink,
  flowPicker,
  onCtaTypeChange,
  onCtaButtonLabelChange,
  onCtaFlowIdChange,
}: {
  fieldId: string;
  ctaType: ScenarioReplyCtaType;
  ctaButtonLabel?: string;
  ctaFlowId?: string;
  showInlineLinkInput: boolean;
  primaryLink: ScenarioActionPrimaryLinkDraft;
  flowPicker: ScenarioActionCtaFlowPicker;
  onCtaTypeChange?: (ctaType: ScenarioReplyCtaType) => void;
  onCtaButtonLabelChange?: (value: string) => void;
  onCtaFlowIdChange?: (flowId: string) => void;
}) {
  const t = useTranslations("Scenarios");
  const ctaTypeId = `${fieldId}-cta-type`;

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
      <Label htmlFor={ctaTypeId} className={FIELD_LABEL_CLASS}>
        {t("actionCtaType")}
      </Label>
      <Select
        value={ctaType}
        onValueChange={value =>
          onCtaTypeChange?.(value as ScenarioReplyCtaType)
        }
      >
        <SelectTrigger id={ctaTypeId} className="nodrag nopan nokey h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t("actionCtaTypeNone")}</SelectItem>
          <SelectItem value="link">{t("actionCtaTypeLink")}</SelectItem>
          <SelectItem value="flow">{t("actionCtaTypeFlow")}</SelectItem>
        </SelectContent>
      </Select>

      {ctaType !== "none" ? (
        <CtaButtonTextField
          id={`${fieldId}-cta-text`}
          ctaType={ctaType}
          value={ctaButtonLabel}
          onChange={onCtaButtonLabelChange}
          t={t}
        />
      ) : null}

      {showInlineLinkInput ? (
        <CtaPrimaryLinkField primaryLink={primaryLink} t={t} />
      ) : null}

      {ctaType === "flow" ? (
        <CtaFlowField
          ctaFlowId={ctaFlowId}
          flowPicker={flowPicker}
          onCtaFlowIdChange={onCtaFlowIdChange}
          t={t}
        />
      ) : null}
    </div>
  );
}
