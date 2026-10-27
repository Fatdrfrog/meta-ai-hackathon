"use client";

import type { BulkAnalyticsAudienceSource } from "@/lib/analytics/bulk-analytics-contract";
import type { AiriBulkCampaignDraft } from "@/lib/airi-chats/bulk-campaign-draft";
import type { ReactNode } from "react";

import { MultiChannelCampaignBuilder } from "./multi-channel-campaign-builder";

export type CampaignBlastContentProps = {
  workspaceId: string;
  emailEnabled: boolean;
  lockedChannel?: "whatsapp" | "telegram" | "email";
  onChannelChange?: (channel: "whatsapp" | "telegram" | "email") => void;
  recipientSource?: "manual" | BulkAnalyticsAudienceSource;
  initialDraft?: AiriBulkCampaignDraft | null;
  audienceSourceSlot?: ReactNode;
  registeredUsersAudience?: {
    enabled: boolean;
    total: number;
    totalAuthUsers: number;
    skippedUnconfirmed: number;
    skippedInvalidEmail: number;
    skippedAnonymous: number;
    skippedDuplicate: number;
    preview?: Array<{
      userId: string;
      email: string;
      name: string;
      registeredAt: string;
      locale?: string;
    }>;
  } | null;
};

export function CampaignBlastContent({
  workspaceId,
  emailEnabled,
  lockedChannel,
  onChannelChange,
  recipientSource = "manual",
  initialDraft = null,
  audienceSourceSlot = null,
  registeredUsersAudience = null,
}: CampaignBlastContentProps) {
  return (
    <MultiChannelCampaignBuilder
      key={workspaceId + "_" + (lockedChannel || "")}
      workspaceId={workspaceId}
      emailEnabled={emailEnabled}
      lockedChannel={lockedChannel}
      onChannelChange={onChannelChange}
      recipientSource={recipientSource}
      initialDraft={initialDraft}
      audienceSourceSlot={audienceSourceSlot}
      registeredUsersAudience={registeredUsersAudience}
    />
  );
}
