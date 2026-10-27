// Re-export shared types and add widget-specific types
export type {
  WidgetConfigResponse,
  WidgetConversationSummary,
} from "@icecore/shared/types/widget-config";

// Message types (from message.ts, not widget-config)
export type { MessageDTO } from "@icecore/shared/types/message";

export interface UserIdentity {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  customData?: Record<string, any>;
}

export interface WidgetConfig {
  clientKey?: string;
  apiUrl?: string;
  theme?: "light" | "dark" | "auto";
  position?: "bottom-right" | "bottom-left";
  locale?: string;
  identity?: UserIdentity | null;
}
