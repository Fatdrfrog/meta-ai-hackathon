import {
  CONVERSATION_CHANNELS,
  type ConversationChannel,
} from "@icecore/shared/types/sources";
import mongoose, { Schema, model, models } from "mongoose";
import {
  ESCALATION_BEHAVIORS,
  GREETING_BEHAVIORS,
  RETRIEVAL_QUERY_MODES,
  RESPONSE_STYLES,
  WORKSPACE_LANGUAGE_BIASES,
  type EscalationBehavior,
  type GreetingBehavior,
  type ResponseStyle,
  type WorkspaceBotRetrievalQueryMode,
  type WorkspaceLanguageBias,
} from "@/lib/airi/workspace-bot-contract";

/** Same as Mongo conversation/message channels — manager guard applies per integration. */
export const MANAGER_REPLY_GUARD_CHANNELS = CONVERSATION_CHANNELS;

export type ManagerReplyGuardChannel = ConversationChannel;
export {
  WORKSPACE_LANGUAGE_BIASES,
  GREETING_BEHAVIORS,
  ESCALATION_BEHAVIORS,
  RESPONSE_STYLES,
};
export type {
  WorkspaceLanguageBias,
  WorkspaceBotRetrievalQueryMode,
  GreetingBehavior,
  EscalationBehavior,
  ResponseStyle,
};

export type ManagerUserLink = {
  id: string;
  supabase_user_id: string;
  mongo_user_id: string;
  channels: ManagerReplyGuardChannel[];
  source_ids: string[];
};

const ManagerUserLinkSchema = new Schema<ManagerUserLink>(
  {
    id: { type: String, required: true },
    supabase_user_id: { type: String, required: true },
    mongo_user_id: { type: String, required: true },
    channels: {
      type: [String],
      enum: MANAGER_REPLY_GUARD_CHANNELS,
      default: [],
    },
    source_ids: { type: [String], default: [] },
  },
  { _id: false }
);

export type WorkspaceAiriSettings = {
  workspaceId: string;
  birthday_scenario_write_fence_version: number;
  airi_bot_default_enabled: boolean;
  airi_scenarios_default_enabled: boolean;
  airi_coach_default_enabled: boolean;
  shadow_mode_enabled: boolean;
  elevenlabs_agent_id?: string | null;
  whatsapp_voice_replies_enabled: boolean;
  auto_reply_rollout_percentage: number;
  auto_reply_min_confidence: number;
  retrieval_query_mode: WorkspaceBotRetrievalQueryMode;
  include_recent_conversation_in_retrieval_context: boolean;
  language_bias: WorkspaceLanguageBias;
  send_kb_article_links_to_user_channels: boolean;
  readiness_target: number;
  readiness_last_computed_at?: Date | null;
  manager_reply_guard_enabled: boolean;
  skip_if_manager_recently_replied: boolean;
  skip_if_tagged_manager_message: boolean;
  manager_recent_reply_window_seconds: number;
  manager_user_links: ManagerUserLink[];
  agent_persona?: {
    display_name?: string | null;
    tone?: string | null;
    topic_restrictions?: string[] | null;
  } | null;
  custom_instructions?: string | null;
  greeting_behavior: GreetingBehavior;
  escalation_behavior: EscalationBehavior;
  response_style: ResponseStyle;
  custom_available_actions?: { action: string; when: string }[] | null;
  channel_instructions?: {
    whatsapp?: string | null;
    telegram?: string | null;
    instagram?: string | null;
    web_widget?: string | null;
  } | null;
  updated_by?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const WorkspaceAiriSettingsSchema = new Schema<WorkspaceAiriSettings>(
  {
    workspaceId: { type: String, required: true, unique: true, index: true },
    /** Internal transaction fence shared by birthday Scenario activations and edits. */
    birthday_scenario_write_fence_version: { type: Number, default: 0 },
    airi_bot_default_enabled: { type: Boolean, default: false },
    airi_scenarios_default_enabled: { type: Boolean, default: true },
    /** Default for airi_coach_enabled on newly created conversations (bulk rollout uses the same flag). */
    airi_coach_default_enabled: { type: Boolean, default: true },
    shadow_mode_enabled: { type: Boolean, default: false },
    elevenlabs_agent_id: { type: String, default: null },
    whatsapp_voice_replies_enabled: { type: Boolean, default: false },
    auto_reply_rollout_percentage: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    auto_reply_min_confidence: { type: Number, default: 0, min: 0, max: 1 },
    retrieval_query_mode: {
      type: String,
      enum: RETRIEVAL_QUERY_MODES,
      default: "adaptive",
    },
    include_recent_conversation_in_retrieval_context: {
      type: Boolean,
      default: true,
    },
    language_bias: {
      type: String,
      enum: WORKSPACE_LANGUAGE_BIASES,
      default: "none",
    },
    send_kb_article_links_to_user_channels: {
      type: Boolean,
      default: false,
    },
    readiness_target: { type: Number, default: 0.95, min: 0.5, max: 1 },
    readiness_last_computed_at: { type: Date, default: null },
    manager_reply_guard_enabled: { type: Boolean, default: true },
    skip_if_manager_recently_replied: { type: Boolean, default: true },
    skip_if_tagged_manager_message: { type: Boolean, default: true },
    manager_recent_reply_window_seconds: { type: Number, default: 300 },
    manager_user_links: { type: [ManagerUserLinkSchema], default: [] },
    agent_persona: {
      type: new Schema<Record<string, unknown>>(
        {
          display_name: { type: String, default: undefined },
          tone: { type: String, default: undefined },
          topic_restrictions: { type: [String], default: undefined },
        },
        { _id: false }
      ),
      default: undefined,
    },
    custom_instructions: { type: String, default: undefined },
    greeting_behavior: {
      type: String,
      enum: GREETING_BEHAVIORS,
      default: "auto",
    },
    escalation_behavior: {
      type: String,
      enum: ESCALATION_BEHAVIORS,
      default: "suggest_human",
    },
    response_style: {
      type: String,
      enum: RESPONSE_STYLES,
      default: "balanced",
    },
    custom_available_actions: {
      type: [
        new Schema<Record<string, unknown>>(
          {
            action: { type: String, required: true },
            when: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    channel_instructions: {
      type: new Schema<Record<string, unknown>>(
        {
          whatsapp: { type: String, default: undefined },
          telegram: { type: String, default: undefined },
          instagram: { type: String, default: undefined },
          web_widget: { type: String, default: undefined },
        },
        { _id: false }
      ),
      default: undefined,
    },
    updated_by: { type: String, default: null },
  },
  { timestamps: true }
);

export default (models.WorkspaceAiriSettings as mongoose.Model<WorkspaceAiriSettings>) ||
  model<WorkspaceAiriSettings>(
    "WorkspaceAiriSettings",
    WorkspaceAiriSettingsSchema
  );
