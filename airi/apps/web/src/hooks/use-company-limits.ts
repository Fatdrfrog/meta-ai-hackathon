"use client";

import useSWR from "swr";
import type { WorkspaceTextAiAllowance } from "@/lib/ai/workspace-ai-policy";

export type WorkspaceTextAiAllowanceStatus =
  | ({ status: "available" } & WorkspaceTextAiAllowance)
  | { status: "unavailable" };

export type CompanyLockedCapability =
  | "trial_expired"
  | "new_conversations"
  | "workspace_creation"
  | "scenario_creation"
  | "bulk_campaigns"
  | "team_invites"
  | "channel_connections"
  | "whatsapp_number_connections"
  | "integration_connections"
  | "airi_auto_replies"
  | "classifications"
  | "coach"
  | "studio_chats";

export type CompanyLimitStatus = {
  subscriptionType: "free" | "pro" | "enterprise";
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  trialExpired: boolean;
  conversationLimit: number | null;
  conversationCount: number;
  conversationsRemaining: number | null;
  conversationExhausted: boolean;
  visibleConversationLimit: number | null;
  visibleConversationCount: number;
  hiddenConversationCount: number;
  workspaceLimit: number | null;
  workspaceCount: number;
  workspacesRemaining: number | null;
  workspaceExhausted: boolean;
  seatLimit: number | null;
  seatCount: number;
  seatsRemaining: number | null;
  seatExhausted: boolean;
  channelLimit: number | null;
  channelCount: number;
  channelTypes: string[];
  channelsRemaining: number | null;
  channelExhausted: boolean;
  whatsappNumberLimit: number | null;
  whatsappNumberCount: number;
  whatsappNumbersRemaining: number | null;
  whatsappNumberExhausted: boolean;
  integrationConnectionLimit: number | null;
  integrationConnectionCounts: Record<string, number>;
  integrationConnectionExhausted: boolean;
  airiAutoReplyLimit: number | null;
  airiAutoReplyCount: number;
  airiAutoRepliesRemaining: number | null;
  airiAutoReplyExhausted: boolean;
  scenarioLimit: number | null;
  scenarioCount: number;
  scenariosRemaining: number | null;
  scenarioExhausted: boolean;
  /** Free plans' bulk campaign recipients in total; null when unlimited. */
  bulkRecipientLimit: number | null;
  bulkRecipientCount: number | null;
  bulkRecipientsRemaining: number | null;
  bulkRecipientExhausted: boolean;
  classificationLimit: number | null;
  classificationCount: number;
  classificationsRemaining: number | null;
  classificationExhausted: boolean;
  coachLimit: number | null;
  coachCount: number;
  coachSessionsRemaining: number | null;
  coachExhausted: boolean;
  studioChatLimit: number | null;
  studioChatCount: number;
  studioChatsRemaining: number | null;
  studioChatExhausted: boolean;
  exhausted: boolean;
  anyLimitExhausted: boolean;
  lockedCapabilities: CompanyLockedCapability[];
  textAiAllowance?: WorkspaceTextAiAllowanceStatus;
};

const LIMIT_STATUS_POLL_MS = 5 * 60 * 1000;

async function fetchCompanyLimits(url: string): Promise<CompanyLimitStatus> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : "Failed to load company limits"
    );
  }
  return payload as CompanyLimitStatus;
}

export function useCompanyLimits(workspaceId: string | null | undefined) {
  return useSWR<CompanyLimitStatus>(
    workspaceId ? `/api/workspaces/${workspaceId}/limits` : null,
    fetchCompanyLimits,
    {
      refreshInterval: LIMIT_STATUS_POLL_MS,
      revalidateOnFocus: false,
      dedupingInterval: LIMIT_STATUS_POLL_MS,
      keepPreviousData: true,
    }
  );
}
