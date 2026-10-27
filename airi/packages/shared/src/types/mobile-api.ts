import type { RawConversation } from "./requests";

export type MobileApiErrorResponse = {
  error: string;
  details?: string;
  kind?: string;
};

export type MobilePagination = {
  page: number;
  limit: number;
  totalCount?: number;
  totalPages?: number;
  hasNextPage: boolean;
  hasPrevPage?: boolean;
};

export type MobileWorkspace = {
  id: string;
  name: string;
  companyId?: string | null;
};

export type MobileWorkspacesResponse = {
  workspaces: MobileWorkspace[];
};

export type MobileRequestsResponse = {
  data: RawConversation[];
  availableChannels?: string[];
  availableCategories?: string[];
  pagination?: MobilePagination;
};

export type MobileConversationMessage = {
  _id: string;
  text?: string;
  date?: string;
  direction?: "inbound" | "outbound" | string;
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  imageUrl?: string | null;
  author?: {
    _id?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    avatar_url?: string;
    isBot?: boolean;
  } | null;
};

export type MobileConversationDetail = {
  _id: string;
  workspaceId?: string;
  status?: string;
  channel?: string;
  rename?: string | null;
  subject?: string | null;
  messages?: MobileConversationMessage[];
  message_pagination?: MobilePagination & {
    has_more?: boolean;
    total?: number;
  };
  external_thread?: {
    provider?: "postmark" | "instagram" | string;
    type?: "comment" | string;
    threadId?: string;
    permalink?: string;
  } | null;
  user?: {
    _id?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    avatar_url?: string;
  } | null;
  chat?: {
    title?: string;
    type?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  } | null;
  classification?: {
    summary?: string;
    category?: string;
    priority?: string;
    action?: string;
  };
  airi_bot_enabled?: boolean;
  airi_handoff_active?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type MobileConversationReplyRequest = {
  text?: string;
  attachments?: unknown[];
  replyToMessageId?: string;
  instagramReplyMode?: "comment" | "private";
};

export type MobileConversationReplyResponse = {
  success?: boolean;
  message?: MobileConversationMessage;
  data?: unknown;
};

export type MobileWindowStatusResponse = {
  channel: string;
  requiresWindow: boolean;
  windowInfo: {
    isWithinWindow: boolean;
    hoursRemaining: number;
    lastCustomerMessageAt: string | null;
  } | null;
  humanAgent?: {
    supported: boolean;
    enabled: boolean;
    /** "human_agent_window_expired" once the 7-day Human Agent window has passed. */
    reason?: string;
    expiresAt?: string | null;
  };
  message?: string;
};

export type MobileAiriChatThread = {
  id: string;
  title: string;
  source: string;
  pinnedAt?: string | null;
  updatedAt: string;
};

export type MobileAiriChatMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

export type MobileAiriChatThreadsResponse = {
  threads: MobileAiriChatThread[];
};

export type MobileAiriChatMessagesResponse = {
  messages: MobileAiriChatMessage[];
};

export type MobileAiriChatTurnResponse = {
  userMessage: MobileAiriChatMessage;
  assistantMessage: MobileAiriChatMessage;
  thread: MobileAiriChatThread;
};

export type MobileElevenLabsTokenResponse = {
  success: true;
  token: string;
  agentId?: string;
  expiresAt?: string | null;
};

export type MobileRealtimeRequestEvent =
  | { event: "requests.new"; data: RawConversation }
  | { event: "requests.update"; data: RawConversation };
