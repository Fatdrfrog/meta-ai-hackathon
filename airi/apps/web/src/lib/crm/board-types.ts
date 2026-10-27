import type { CrmAttentionKind } from "./attention";
import type { CrmCardWarning, CrmFollowUpKind } from "./follow-up";
import type { CrmPipelineStage } from "./stages";

export type CrmBoardCard = {
  id: string;
  displayName: string | null;
  status: string;
  stageKey: string;
  primaryConversationId: string | null;
  lastInteractionAt: string | null;
  createdAt: string | null;
  channels: string[];
  contactPoints: {
    emails: string[];
    phones: string[];
    usernames: string[];
  };
  conversationCount: number;
  estimatedCustomerLtv: number | null;
  sentiment: string | null;
  churnRiskLevel: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  slaDueAt: string | null;
  category: string | null;
  nextAction: string | null;
  attention: CrmAttentionKind[];
  followUpKind: CrmFollowUpKind | null;
  followUpDueAt: string | null;
  warnings: CrmCardWarning[];
  ownerUserId: string | null;
  ownerLabel: string | null;
  lastInboundSnippet: string | null;
};

export type CrmBoardColumn = {
  stageKey: string;
  totalCount: number;
  ltvSum: number | null;
  nextCursor: string | null;
  cards: CrmBoardCard[];
};

export type CrmBoardResponse = {
  stages: CrmPipelineStage[];
  columns: CrmBoardColumn[];
  archivedStages?: CrmPipelineStage[];
};
