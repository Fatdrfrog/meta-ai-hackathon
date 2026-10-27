/**
 * Unified Message Template Types
 * Supports WhatsApp, Telegram, and Both platforms
 */

import type {
  WhatsAppComponent,
  WhatsAppMarketingMessagesOptimizationSpec,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from "./whatsapp";

// ============================================================================
// TEMPLATE CHANNEL
// ============================================================================

export type TemplateChannel = "whatsapp" | "telegram" | "both";

// ============================================================================
// TELEGRAM TEMPLATE DATA
// ============================================================================

export type TelegramParseMode = "Markdown" | "HTML" | "None";

export interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  callbackData?: string;
}

export interface TelegramTemplateData {
  text: string;
  parseMode?: TelegramParseMode;
  inlineKeyboard?: TelegramInlineKeyboardButton[][]; // Array of button rows
}

// ============================================================================
// WHATSAPP TEMPLATE DATA (wrapper around existing structure)
// ============================================================================

export interface WhatsAppTemplateData {
  language: string;
  category: WhatsAppTemplateCategory;
  components: WhatsAppComponent[];
  allow_category_change?: boolean;
  optimization_spec?: WhatsAppMarketingMessagesOptimizationSpec;
  metaTemplateId?: string;
  status?: WhatsAppTemplateStatus;
  wabaId?: string;
}

// ============================================================================
// UNIFIED TEMPLATE
// ============================================================================

export interface UnifiedTemplate {
  id?: string;
  workspace_id: string;
  name: string;
  channel: TemplateChannel;
  whatsapp_data?: WhatsAppTemplateData;
  telegram_data?: TelegramTemplateData;
  created_at?: string;
  updated_at?: string;
}
