export interface WidgetTheme {
  primaryColor: string;
  bubbleColor?: string;
  headerBgColor?: string;
  headerTextColor?: string;
}

export const SUPPORTED_WIDGET_LANGUAGE_CODES = [
  "en",
  "ru",
  "kz",
  "uz",
] as const;

export type WidgetLanguageCode =
  (typeof SUPPORTED_WIDGET_LANGUAGE_CODES)[number];

export type WidgetQuickRepliesTranslations = Partial<
  Record<WidgetLanguageCode, string[]>
>;

export interface WidgetSettings {
  welcomeMessage: string;
  offlineMessage?: string;
  responseTime: string;
  aiEnabled: boolean;
  autoOpen: boolean;
  position: "bottom-right" | "bottom-left";
}

export interface WidgetContent {
  botName?: string;
  headerTitle?: string;
  heroTitle?: string;
  ctaPrimaryText?: string;
  ctaSecondaryText?: string;
  quickReplies?: string[];
}

export interface WidgetBranding {
  bubbleMode?: "icon" | "text" | "svg";
  bubbleText?: string;
  bubbleSvgUrl?: string;
  logoMode?: "default" | "text" | "svg";
  logoText?: string;
  logoSvgUrl?: string;
}

export interface WidgetLayout {
  homeVariant?: "intercom" | "simple";
  showHelpTab?: boolean;
  showNewsTab?: boolean;
}

export interface WidgetConfigResponse {
  success: boolean;
  config?: {
    sourceId: string;
    workspaceId: string;
    companyId: string;
    theme: WidgetTheme;
    settings: WidgetSettings;
    content: WidgetContent;
    branding: WidgetBranding;
    layout: WidgetLayout;
    locale: string;
    realtime: {
      url: string;
    };
  };
  error?: string;
}

// Multi-URL conversation summary (used by widget and dashboard)
export interface WidgetConversationSummary {
  id: string;
  pageUrl: string;
  lastMessageAt: string;
  messageCount: number;
  status?: string; // For dashboard use
  createdAt?: string; // For dashboard use
  lastMessagePreview?: string; // Quick context - snippet of last message
}
