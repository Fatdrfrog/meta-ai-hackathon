export type MessageDirection = "inbound" | "outbound";

export interface MessageDTO {
  id: string;
  conversationId: string;
  text: string;
  direction: MessageDirection;
  timestamp: string; // ISO string
  authorName?: string;
  authorAvatar?: string;
  imageUrl?: string;
  mediaUrl?: string;
  mediaType?:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "file"
    | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  audioAnalysis?: string | null;
  actionType?: "csat_request" | null;
}

export interface SendMessageRequest {
  /** Stable for one logical send and its retries; optional for legacy clients. */
  clientMessageId?: string;
  conversationId?: string; // undefined = new conversation
  text: string;
  clientKey: string;
  imageUrl?: string; // Optional image attachment
  mediaUrl?: string; // Optional generic media attachment URL
  mediaType?:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "file";
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  metadata?: {
    userAgent?: string;
    referrer?: string;
    customerId?: string;
    pageUrl?: string; // For multi-URL conversation grouping
    pageIdentifier?: string; // Full identifier including tab/screen
    // Optional user identity (for authenticated users)
    userEmail?: string;
    userName?: string;
    // Mobile app context
    currentTab?: string | number;
    screenName?: string;
    route?: string;
    appMetadata?: Record<string, unknown>;
    // RAG context for AI
    ragContext?: string;
  };
}

export interface SendMessageResponse {
  success: boolean;
  message?: MessageDTO;
  conversationId?: string;
  error?: string;
}
