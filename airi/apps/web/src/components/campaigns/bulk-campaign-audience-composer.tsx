"use client";

import { CampaignRecipientPicker } from "@/components/campaigns/campaign-recipient-picker";
import { TelegramAudienceSelector } from "@/components/campaigns/telegram-audience-selector";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

export type BulkCampaignAudienceComposerTelegramProps = ComponentProps<
  typeof TelegramAudienceSelector
>;
export type BulkCampaignAudienceComposerPickerProps = ComponentProps<
  typeof CampaignRecipientPicker
>;

export type BulkCampaignAudienceComposerProps = {
  className?: string;
  pickerClassName?: string;
  hideRecipientPicker?: boolean;
  knownAudienceNote?: ReactNode;
  telegram?: BulkCampaignAudienceComposerTelegramProps | null;
  picker: BulkCampaignAudienceComposerPickerProps;
};

export function BulkCampaignAudienceComposer({
  className,
  pickerClassName,
  hideRecipientPicker = false,
  knownAudienceNote,
  telegram,
  picker,
}: BulkCampaignAudienceComposerProps) {
  return (
    <div
      className={cn("space-y-3", className)}
      data-testid="bulk-campaign-audience-composer"
    >
      {telegram ? <TelegramAudienceSelector {...telegram} /> : null}
      {knownAudienceNote}
      <div className={cn(hideRecipientPicker && "hidden", pickerClassName)}>
        <CampaignRecipientPicker {...picker} />
      </div>
    </div>
  );
}
