"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  ReplyOptionComposer,
  ReplyOptionDeleteButton,
} from "../../builders/reply-option-controls";
import type { TranslateFn } from "../../types";
import { FIELD_LABEL_CLASS } from "./assets-fields-utils";
import type { ScenarioActionLinkDraft } from "./use-assets-fields-state";

function TelegramUrlButtonLabelField({
  id,
  value,
  onChange,
  t,
}: {
  id: string;
  value?: string;
  onChange?: (value: string) => void;
  t: TranslateFn;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className={FIELD_LABEL_CLASS}>
        {t("actionTelegramUrlButtonLabel")}
      </Label>
      <Input
        id={id}
        value={value ?? ""}
        onChange={event => onChange?.(event.target.value)}
        maxLength={30}
        placeholder={t("actionCtaLinkLabelPlaceholder")}
        className="nodrag nopan h-8"
      />
    </div>
  );
}

/** Fixed links sent with the action, added inline one at a time. */
export function ScenarioActionLinkFields({
  fieldId,
  linkUrls,
  linkDraft,
  showTelegramUrlLabel,
  telegramUrlButtonLabel,
  onTelegramUrlButtonLabelChange,
  onRemoveLinkUrl,
}: {
  fieldId: string;
  linkUrls: string[];
  linkDraft: ScenarioActionLinkDraft;
  showTelegramUrlLabel: boolean;
  telegramUrlButtonLabel?: string;
  onTelegramUrlButtonLabelChange?: (value: string) => void;
  onRemoveLinkUrl: (linkUrl: string) => void;
}) {
  const t = useTranslations("Scenarios");
  const linksTitleId = `${fieldId}-links`;

  return (
    <div className="space-y-1.5">
      <p id={linksTitleId} className={FIELD_LABEL_CLASS}>
        {t("actionFixedLinks")}
      </p>
      {linkUrls.length > 0 ? (
        <ul aria-labelledby={linksTitleId} className="space-y-1">
          {linkUrls.slice(0, 6).map(linkUrl => (
            <li
              key={linkUrl}
              className="flex items-center gap-1.5 rounded-md border bg-background py-0.5 pl-2 pr-0.5 text-[11px]"
            >
              <ExternalLink
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="min-w-0 flex-1 break-all text-muted-foreground">
                {linkUrl}
              </span>
              <ReplyOptionDeleteButton
                label={t("actionRemoveLink")}
                onClick={() => onRemoveLinkUrl(linkUrl)}
                className="h-6 w-6"
                iconClassName="h-3 w-3"
              />
            </li>
          ))}
        </ul>
      ) : null}
      <ReplyOptionComposer
        value={linkDraft.draft}
        onValueChange={linkDraft.setDraft}
        onSubmit={linkDraft.add}
        ariaLabel={t("actionLinkInputLabel")}
        placeholder={t("actionAddLinkPlaceholder")}
        addLabel={t("actionAddLink")}
        disabled={!linkDraft.canAdd}
        inputClassName="h-8 text-xs"
        footer={
          linkDraft.hasDuplicate ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("actionAddLinkAlreadyExists")}
            </p>
          ) : null
        }
      />
      {showTelegramUrlLabel ? (
        <TelegramUrlButtonLabelField
          id={`${fieldId}-telegram-label`}
          value={telegramUrlButtonLabel}
          onChange={onTelegramUrlButtonLabelChange}
          t={t}
        />
      ) : null}
    </div>
  );
}
