import type { ApiKeyData } from "@/lib/api-auth";
import type { CompanyConversationVisibilityGate } from "@/lib/limits/company-limits";
import type { ScenarioListStatusFilter } from "@/lib/scenarios/list-workspace-scenario-summaries";
import type { ConversationStatus } from "@icecore/shared/types/conversation";
import type { ConversationChannel } from "@icecore/shared/types/sources";
import type { WhatsAppTemplateStatus } from "@icecore/shared/types/whatsapp";
import type { ScenarioSummaryDTO } from "@icecore/scenario-contracts";

/** The result shape of `authenticateRequest` from `@/lib/api-auth`. */
export type AiriMcpAuthResult =
  | { apiKey: ApiKeyData; error: null }
  | { apiKey: null; error: Response };

export type AiriMcpAuthenticate = (
  request: Request
) => Promise<AiriMcpAuthResult>;

/** Metadata only: never keys, tool arguments or tool results. */
export type AiriMcpLogContext = Record<
  string,
  string | number | boolean | null
>;

export interface AiriMcpLogger {
  info(message: string, context: AiriMcpLogContext): void;
  warn(message: string, context: AiriMcpLogContext): void;
  error(message: string, error: undefined, context: AiriMcpLogContext): void;
}

/** Everything a tool may know about the caller: one key, one workspace. */
export type AiriMcpAuthContext = {
  apiKey: ApiKeyData;
  workspaceId: string;
  /** Origin of the MCP request, used for panel deep links. */
  appOrigin: string;
};

/** hiddenConversationCount is company-wide, across all its workspaces. */
export type AiriMcpVisibility = Pick<
  CompanyConversationVisibilityGate,
  "hiddenConversationCount" | "reason"
> & {
  /** True when the company plan hides some conversations from reads. */
  limited: boolean;
};

export type AiriMcpCountRow<K extends string> = {
  [key in K]: string | null;
} & { count: number };

export type AiriMcpAnalyticsWindowCounts = {
  total: number;
  byStatus: AiriMcpCountRow<"status">[];
  byChannel: AiriMcpCountRow<"channel">[];
  byCategory: AiriMcpCountRow<"category">[];
  categoriesTruncated: boolean;
};

export type AiriMcpConversationRecord = {
  _id: unknown;
  status?: unknown;
  channel?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastMessageAt?: unknown;
  user?: unknown;
  chat?: unknown;
  rename?: string | null;
  subject?: unknown;
  campaign_recipient_name?: unknown;
  internal_labels?: unknown;
  classification?: unknown;
  [field: string]: unknown;
};

type AiriMcpContactProfile = {
  _id?: unknown;
  username?: string | null;
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    profileName?: string | null;
  } | null;
};

export type AiriMcpUserRecord = AiriMcpContactProfile & {
  firstName?: string | null;
  lastName?: string | null;
};

export type AiriMcpChatRecord = AiriMcpContactProfile & {
  title?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type AiriMcpConversationBundle = {
  conversation: AiriMcpConversationRecord;
  user: AiriMcpUserRecord | null;
  chat: AiriMcpChatRecord | null;
};

export type AiriMcpTemplateRecord = {
  name?: unknown;
  language?: unknown;
  status?: unknown;
  category?: unknown;
  quality_rating?: unknown;
  rejected_reason?: unknown;
  components?: unknown;
  lastSyncedAt?: unknown;
};

/**
 * Stored-data reads behind the tools. Every method is scoped to one
 * workspace, bounded by its inputs and never calls a third-party API.
 */
export interface AiriMcpDataProvider {
  getAnalyticsCounts(params: {
    workspaceId: string;
    /** Current window: createdAt >= currentStart (open-ended, as in v1). */
    currentStart: Date;
    /** Previous window: previousStart <= createdAt < currentStart. */
    previousStart: Date;
  }): Promise<{
    current: AiriMcpAnalyticsWindowCounts;
    previous: AiriMcpAnalyticsWindowCounts;
    visibility: AiriMcpVisibility;
  }>;
  listConversations(params: {
    workspaceId: string;
    limit: number;
    offset: number;
    status?: ConversationStatus;
    channel?: ConversationChannel;
  }): Promise<{
    rows: AiriMcpConversationBundle[];
    hasMore: boolean;
    visibility: AiriMcpVisibility;
  }>;
  listWhatsAppTemplates(params: {
    workspaceId: string;
    limit: number;
    status?: WhatsAppTemplateStatus;
  }): Promise<{ rows: AiriMcpTemplateRecord[]; hasMore: boolean }>;
  listScenarios(params: {
    workspaceId: string;
    limit: number;
    status: ScenarioListStatusFilter;
    cursor?: string;
  }): Promise<{
    items: ScenarioSummaryDTO[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
}

export type AiriMcpDeps = {
  /** `authenticateRequest(request, { requireDistributedRateLimit: true })`. */
  authenticate: AiriMcpAuthenticate;
  data: AiriMcpDataProvider;
  logger: AiriMcpLogger;
  now: () => Date;
};
