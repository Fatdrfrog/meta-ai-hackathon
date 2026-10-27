import { buildCacheKey, cache } from "@/lib/cache";
import connectDB from "@/lib/mongoose";
import WorkspaceAiriSettings from "@/models/workspace-airi-settings";
import {
  coerceEscalationBehavior,
  coerceGreetingBehavior,
  coerceResponseStyle,
  coerceWorkspaceBotRetrievalQueryMode,
  coerceWorkspaceLanguageBias,
  DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS,
  isEscalationBehavior,
  isGreetingBehavior,
  isResponseStyle,
  isWorkspaceBotRetrievalQueryMode,
  isWorkspaceLanguageBias,
  resolveWorkspaceScenariosDefault,
  type ChannelInstructions,
  type CustomAvailableAction,
  type EscalationBehavior,
  type GreetingBehavior,
  type ResponseStyle,
  type WorkspaceAgentPersona,
  type WorkspaceBotRetrievalQueryMode,
  type WorkspaceBotRuntimeSettings,
  type WorkspaceBotRuntimeSettingsUpdate,
  type WorkspaceLanguageBias,
} from "./workspace-bot-contract";

export type {
  ChannelInstructions,
  CustomAvailableAction,
  WorkspaceBotRuntimeSettings,
  WorkspaceBotRuntimeSettingsUpdate,
};

const INCLUDE_RECENT_CONVERSATION_IN_RETRIEVAL_CONTEXT_FIELD =
  "include_recent_conversation_in_retrieval_context";

type HistorySettingSource = {
  includeRecentConversationInRetrievalContext?: boolean | null;
  include_recent_conversation_in_retrieval_context?: boolean | null;
};

type WorkspaceBotRuntimeSettingsRecord = {
  airi_bot_default_enabled?: boolean;
  airi_scenarios_default_enabled?: boolean;
  airi_coach_default_enabled?: boolean;
  retrieval_query_mode?: WorkspaceBotRetrievalQueryMode;
  include_recent_conversation_in_retrieval_context?: boolean | null;
  send_kb_article_links_to_user_channels?: boolean;
  elevenlabs_agent_id?: string | null;
  whatsapp_voice_replies_enabled?: boolean | null;
  language_bias?: WorkspaceLanguageBias | null;
  agent_persona?: {
    display_name?: string;
    tone?: string;
    topic_restrictions?: string[];
  };
  custom_instructions?: string;
  greeting_behavior?: GreetingBehavior;
  escalation_behavior?: EscalationBehavior;
  response_style?: ResponseStyle;
  custom_available_actions?: { action: string; when: string }[];
  channel_instructions?: {
    whatsapp?: string;
    telegram?: string;
    instagram?: string;
    web_widget?: string;
  };
};

type CachedWorkspaceBotRuntimeSettings = Partial<WorkspaceBotRuntimeSettings>;

type HistorySettingWriteMutation = {
  setPayload: Record<string, unknown>;
};

const DEFAULT_RUNTIME_SETTINGS = DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS;

const WORKSPACE_BOT_RUNTIME_SETTINGS_TTL_SEC = 60;

function buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId: string): string {
  return buildCacheKey("airi:workspace-bot-runtime-settings", [workspaceId]);
}

function normalizeAgentPersona(
  persona?: WorkspaceBotRuntimeSettingsRecord["agent_persona"]
): WorkspaceAgentPersona | undefined {
  if (
    !persona?.display_name &&
    !persona?.tone &&
    (!persona?.topic_restrictions || persona.topic_restrictions.length === 0)
  ) {
    return undefined;
  }

  return {
    displayName: persona.display_name,
    tone: persona.tone,
    topicRestrictions: persona.topic_restrictions,
  };
}

export function resolveIncludeRecentConversationInRetrievalContext(
  source: HistorySettingSource | null | undefined,
  fallback: boolean
): boolean {
  if (
    typeof source?.includeRecentConversationInRetrievalContext === "boolean"
  ) {
    return source.includeRecentConversationInRetrievalContext;
  }
  if (
    typeof source?.include_recent_conversation_in_retrieval_context ===
    "boolean"
  ) {
    return source.include_recent_conversation_in_retrieval_context;
  }
  return fallback;
}

function buildHistorySettingWriteMutation(
  includeRecentConversationInRetrievalContext: boolean
): HistorySettingWriteMutation {
  return {
    setPayload: {
      [INCLUDE_RECENT_CONVERSATION_IN_RETRIEVAL_CONTEXT_FIELD]:
        includeRecentConversationInRetrievalContext,
    },
  };
}

async function resolveHistorySettingForWrite(
  workspaceId: string,
  override?: boolean
): Promise<boolean> {
  if (typeof override === "boolean") {
    return override;
  }

  const existing = await WorkspaceAiriSettings.findOne({ workspaceId })
    .select(INCLUDE_RECENT_CONVERSATION_IN_RETRIEVAL_CONTEXT_FIELD)
    .lean<HistorySettingSource | null>();

  return resolveIncludeRecentConversationInRetrievalContext(
    existing,
    DEFAULT_RUNTIME_SETTINGS.includeRecentConversationInRetrievalContext
  );
}

export async function buildHistorySettingPersistenceMutation(
  workspaceId: string,
  override?: boolean
): Promise<HistorySettingWriteMutation> {
  return buildHistorySettingWriteMutation(
    await resolveHistorySettingForWrite(workspaceId, override)
  );
}

function normalizeChannelInstructions(
  raw?: WorkspaceBotRuntimeSettingsRecord["channel_instructions"]
): ChannelInstructions | undefined {
  if (!raw) return undefined;
  const result: ChannelInstructions = {};
  if (raw.whatsapp?.trim()) result.whatsapp = raw.whatsapp.trim();
  if (raw.telegram?.trim()) result.telegram = raw.telegram.trim();
  if (raw.instagram?.trim()) result.instagram = raw.instagram.trim();
  if (raw.web_widget?.trim()) result.webWidget = raw.web_widget.trim();
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCustomAvailableActions(
  raw?: { action: string; when: string }[]
): CustomAvailableAction[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw
    .filter(a => a.action?.trim() && a.when?.trim())
    .map(a => ({ action: a.action.trim(), when: a.when.trim() }));
}

function normalizeRuntimeSettingsFromRecord(
  record: WorkspaceBotRuntimeSettingsRecord | null | undefined
): WorkspaceBotRuntimeSettings {
  const normalizedElevenlabsAgentId =
    typeof record?.elevenlabs_agent_id === "string" &&
    record.elevenlabs_agent_id.trim()
      ? record.elevenlabs_agent_id.trim()
      : undefined;

  const greetingBehavior = coerceGreetingBehavior(
    record?.greeting_behavior,
    DEFAULT_RUNTIME_SETTINGS.greetingBehavior
  );

  const escalationBehavior = coerceEscalationBehavior(
    record?.escalation_behavior,
    DEFAULT_RUNTIME_SETTINGS.escalationBehavior
  );

  const responseStyle = coerceResponseStyle(
    record?.response_style,
    DEFAULT_RUNTIME_SETTINGS.responseStyle
  );

  return {
    defaultBotEnabled:
      record?.airi_bot_default_enabled ??
      DEFAULT_RUNTIME_SETTINGS.defaultBotEnabled,
    defaultScenariosEnabled: resolveWorkspaceScenariosDefault(record),
    defaultCoachEnabled:
      record?.airi_coach_default_enabled ??
      DEFAULT_RUNTIME_SETTINGS.defaultCoachEnabled,
    retrievalQueryMode: coerceWorkspaceBotRetrievalQueryMode(
      record?.retrieval_query_mode
    ),
    includeRecentConversationInRetrievalContext:
      resolveIncludeRecentConversationInRetrievalContext(
        record,
        DEFAULT_RUNTIME_SETTINGS.includeRecentConversationInRetrievalContext
      ),
    sendKbArticleLinksToUserChannels:
      record?.send_kb_article_links_to_user_channels ??
      DEFAULT_RUNTIME_SETTINGS.sendKbArticleLinksToUserChannels,
    elevenlabsAgentId: normalizedElevenlabsAgentId,
    whatsappVoiceRepliesEnabled:
      record?.whatsapp_voice_replies_enabled === true,
    languageBias: coerceWorkspaceLanguageBias(
      record?.language_bias,
      DEFAULT_RUNTIME_SETTINGS.languageBias
    ),
    agentPersona: normalizeAgentPersona(record?.agent_persona),
    customInstructions: record?.custom_instructions?.trim() || undefined,
    greetingBehavior,
    escalationBehavior,
    responseStyle,
    customAvailableActions: normalizeCustomAvailableActions(
      record?.custom_available_actions
    ),
    channelInstructions: normalizeChannelInstructions(
      record?.channel_instructions
    ),
  };
}

function normalizeRuntimeSettingsFromCache(
  cached: CachedWorkspaceBotRuntimeSettings
): WorkspaceBotRuntimeSettings {
  return {
    defaultBotEnabled:
      cached.defaultBotEnabled ?? DEFAULT_RUNTIME_SETTINGS.defaultBotEnabled,
    defaultScenariosEnabled:
      cached.defaultScenariosEnabled ??
      cached.defaultBotEnabled ??
      DEFAULT_RUNTIME_SETTINGS.defaultScenariosEnabled,
    defaultCoachEnabled:
      cached.defaultCoachEnabled ??
      DEFAULT_RUNTIME_SETTINGS.defaultCoachEnabled,
    retrievalQueryMode: coerceWorkspaceBotRetrievalQueryMode(
      cached.retrievalQueryMode,
      DEFAULT_RUNTIME_SETTINGS.retrievalQueryMode
    ),
    includeRecentConversationInRetrievalContext:
      resolveIncludeRecentConversationInRetrievalContext(
        cached,
        DEFAULT_RUNTIME_SETTINGS.includeRecentConversationInRetrievalContext
      ),
    sendKbArticleLinksToUserChannels:
      cached.sendKbArticleLinksToUserChannels ??
      DEFAULT_RUNTIME_SETTINGS.sendKbArticleLinksToUserChannels,
    elevenlabsAgentId: cached.elevenlabsAgentId,
    whatsappVoiceRepliesEnabled: cached.whatsappVoiceRepliesEnabled === true,
    languageBias: coerceWorkspaceLanguageBias(
      cached.languageBias,
      DEFAULT_RUNTIME_SETTINGS.languageBias
    ),
    agentPersona: cached.agentPersona,
    customInstructions: cached.customInstructions,
    greetingBehavior:
      cached.greetingBehavior ?? DEFAULT_RUNTIME_SETTINGS.greetingBehavior,
    escalationBehavior:
      cached.escalationBehavior ?? DEFAULT_RUNTIME_SETTINGS.escalationBehavior,
    responseStyle:
      cached.responseStyle ?? DEFAULT_RUNTIME_SETTINGS.responseStyle,
    customAvailableActions: cached.customAvailableActions,
    channelInstructions: cached.channelInstructions,
  };
}

export async function getWorkspaceBotDefault(
  workspaceId: string
): Promise<boolean> {
  const settings = await getWorkspaceBotRuntimeSettings(workspaceId);
  return settings.defaultBotEnabled;
}

export async function getWorkspaceScenariosDefault(
  workspaceId: string
): Promise<boolean> {
  const settings = await getWorkspaceBotRuntimeSettings(workspaceId);
  return settings.defaultScenariosEnabled;
}

export async function getWorkspaceCoachDefault(
  workspaceId: string
): Promise<boolean> {
  const settings = await getWorkspaceBotRuntimeSettings(workspaceId);
  return settings.defaultCoachEnabled;
}

export async function getWorkspaceBotRuntimeSettings(
  workspaceId: string
): Promise<WorkspaceBotRuntimeSettings> {
  if (!workspaceId) return DEFAULT_RUNTIME_SETTINGS;

  const cacheKey = buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId);
  const cached = await cache.get<CachedWorkspaceBotRuntimeSettings>(cacheKey);
  if (cached) {
    return normalizeRuntimeSettingsFromCache(cached);
  }

  await connectDB();
  const settings = await WorkspaceAiriSettings.findOne({ workspaceId })
    .select(
      [
        "airi_bot_default_enabled",
        "airi_scenarios_default_enabled",
        "airi_coach_default_enabled",
        "retrieval_query_mode",
        INCLUDE_RECENT_CONVERSATION_IN_RETRIEVAL_CONTEXT_FIELD,
        "send_kb_article_links_to_user_channels",
        "elevenlabs_agent_id",
        "whatsapp_voice_replies_enabled",
        "language_bias",
        "agent_persona",
        "custom_instructions",
        "greeting_behavior",
        "escalation_behavior",
        "response_style",
        "custom_available_actions",
        "channel_instructions",
      ].join(" ")
    )
    .lean<WorkspaceBotRuntimeSettingsRecord | null>();

  const runtimeSettings = normalizeRuntimeSettingsFromRecord(settings);

  await cache.set(
    cacheKey,
    runtimeSettings,
    WORKSPACE_BOT_RUNTIME_SETTINGS_TTL_SEC
  );

  return runtimeSettings;
}

async function buildScenarioDefaultPreservationMutation(
  workspaceId: string
): Promise<Record<string, unknown>> {
  const existing = await WorkspaceAiriSettings.findOne({ workspaceId })
    .select("airi_scenarios_default_enabled airi_bot_default_enabled")
    .lean<WorkspaceBotRuntimeSettingsRecord | null>();

  if (typeof existing?.airi_scenarios_default_enabled === "boolean") {
    return {};
  }

  return {
    airi_scenarios_default_enabled: resolveWorkspaceScenariosDefault(existing),
  };
}

export async function setWorkspaceBotDefault(
  workspaceId: string,
  enabled: boolean,
  updatedBy: string
): Promise<void> {
  if (!workspaceId) return;

  await connectDB();
  const historySettingMutation =
    await buildHistorySettingPersistenceMutation(workspaceId);
  const scenarioDefaultMutation =
    await buildScenarioDefaultPreservationMutation(workspaceId);
  await WorkspaceAiriSettings.findOneAndUpdate(
    { workspaceId },
    {
      $set: {
        ...historySettingMutation.setPayload,
        ...scenarioDefaultMutation,
        airi_bot_default_enabled: enabled,
        updated_by: updatedBy || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await cache.del(buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId));
}

export async function setWorkspaceScenariosDefault(
  workspaceId: string,
  enabled: boolean,
  updatedBy: string
): Promise<void> {
  if (!workspaceId) return;

  await connectDB();
  const historySettingMutation =
    await buildHistorySettingPersistenceMutation(workspaceId);
  await WorkspaceAiriSettings.findOneAndUpdate(
    { workspaceId },
    {
      $set: {
        ...historySettingMutation.setPayload,
        airi_scenarios_default_enabled: enabled,
        updated_by: updatedBy || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await cache.del(buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId));
}

/**
 * Seed Airi settings when a workspace is first created.
 * Scenarios default ON; bot stays OFF. Never overwrites an existing doc.
 */
export async function ensureNewWorkspaceAiriDefaults(params: {
  workspaceId: string;
  updatedBy?: string | null;
}): Promise<void> {
  const workspaceId = String(params.workspaceId || "").trim();
  if (!workspaceId) return;

  await connectDB();
  await WorkspaceAiriSettings.findOneAndUpdate(
    { workspaceId },
    {
      $setOnInsert: {
        workspaceId,
        airi_bot_default_enabled: false,
        airi_scenarios_default_enabled: true,
        airi_coach_default_enabled: true,
        updated_by: params.updatedBy || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await cache.del(buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId));
}

export async function setWorkspaceCoachDefault(
  workspaceId: string,
  enabled: boolean,
  updatedBy: string
): Promise<void> {
  if (!workspaceId) return;

  await connectDB();
  const historySettingMutation =
    await buildHistorySettingPersistenceMutation(workspaceId);
  await WorkspaceAiriSettings.findOneAndUpdate(
    { workspaceId },
    {
      $set: {
        ...historySettingMutation.setPayload,
        airi_coach_default_enabled: enabled,
        updated_by: updatedBy || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await cache.del(buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId));
}

export async function updateWorkspaceBotRuntimeSettings(
  workspaceId: string,
  updates: WorkspaceBotRuntimeSettingsUpdate,
  updatedBy: string
): Promise<WorkspaceBotRuntimeSettings> {
  if (!workspaceId) return DEFAULT_RUNTIME_SETTINGS;

  await connectDB();

  const setPayload: Record<string, unknown> = {
    updated_by: updatedBy || null,
  };
  const unsetPayload: Record<string, 1> = {};

  if (isWorkspaceBotRetrievalQueryMode(updates.retrievalQueryMode)) {
    setPayload.retrieval_query_mode = updates.retrievalQueryMode;
  }

  const historySettingMutation = await buildHistorySettingPersistenceMutation(
    workspaceId,
    updates.includeRecentConversationInRetrievalContext
  );
  Object.assign(setPayload, historySettingMutation.setPayload);

  if (typeof updates.sendKbArticleLinksToUserChannels === "boolean") {
    setPayload.send_kb_article_links_to_user_channels =
      updates.sendKbArticleLinksToUserChannels;
  }

  if (updates.elevenlabsAgentId !== undefined) {
    const normalized =
      typeof updates.elevenlabsAgentId === "string"
        ? updates.elevenlabsAgentId.trim()
        : "";
    setPayload.elevenlabs_agent_id = normalized || null;
  }

  if (typeof updates.whatsappVoiceRepliesEnabled === "boolean") {
    setPayload.whatsapp_voice_replies_enabled =
      updates.whatsappVoiceRepliesEnabled;
  }

  if (isWorkspaceLanguageBias(updates.languageBias)) {
    setPayload.language_bias = updates.languageBias;
  }

  if (updates.agentPersona !== undefined) {
    if (updates.agentPersona === null) {
      unsetPayload.agent_persona = 1;
    } else {
      const normalizedAgentPersona = {
        display_name: updates.agentPersona.displayName?.trim() || undefined,
        tone: updates.agentPersona.tone?.trim() || undefined,
        topic_restrictions:
          updates.agentPersona.topicRestrictions?.filter(t => t.trim()) ||
          undefined,
      };

      if (
        normalizedAgentPersona.display_name ||
        normalizedAgentPersona.tone ||
        (normalizedAgentPersona.topic_restrictions?.length ?? 0) > 0
      ) {
        setPayload.agent_persona = normalizedAgentPersona;
      } else {
        unsetPayload.agent_persona = 1;
      }
    }
  }

  if (updates.customInstructions !== undefined) {
    const normalizedCustomInstructions = updates.customInstructions?.trim();
    if (normalizedCustomInstructions) {
      setPayload.custom_instructions = normalizedCustomInstructions;
    } else {
      unsetPayload.custom_instructions = 1;
    }
  }

  if (isGreetingBehavior(updates.greetingBehavior)) {
    setPayload.greeting_behavior = updates.greetingBehavior;
  }

  if (isEscalationBehavior(updates.escalationBehavior)) {
    setPayload.escalation_behavior = updates.escalationBehavior;
  }

  if (isResponseStyle(updates.responseStyle)) {
    setPayload.response_style = updates.responseStyle;
  }

  if (updates.customAvailableActions !== undefined) {
    const normalizedCustomAvailableActions =
      updates.customAvailableActions === null
        ? []
        : updates.customAvailableActions
            .filter(a => a.action?.trim() && a.when?.trim())
            .map(a => ({ action: a.action.trim(), when: a.when.trim() }));

    if (normalizedCustomAvailableActions.length > 0) {
      setPayload.custom_available_actions = normalizedCustomAvailableActions;
    } else {
      unsetPayload.custom_available_actions = 1;
    }
  }

  if (updates.channelInstructions !== undefined) {
    if (updates.channelInstructions === null) {
      unsetPayload.channel_instructions = 1;
    } else {
      const normalizedChannelInstructions = {
        whatsapp: updates.channelInstructions.whatsapp?.trim() || undefined,
        telegram: updates.channelInstructions.telegram?.trim() || undefined,
        instagram: updates.channelInstructions.instagram?.trim() || undefined,
        web_widget: updates.channelInstructions.webWidget?.trim() || undefined,
      };

      if (
        normalizedChannelInstructions.whatsapp ||
        normalizedChannelInstructions.telegram ||
        normalizedChannelInstructions.instagram ||
        normalizedChannelInstructions.web_widget
      ) {
        setPayload.channel_instructions = normalizedChannelInstructions;
      } else {
        unsetPayload.channel_instructions = 1;
      }
    }
  }

  const updateDocument: {
    $set: Record<string, unknown>;
    $unset?: Record<string, 1>;
  } = {
    $set: setPayload,
  };

  if (Object.keys(unsetPayload).length > 0) {
    updateDocument.$unset = unsetPayload;
  }

  await WorkspaceAiriSettings.findOneAndUpdate(
    { workspaceId },
    updateDocument,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await cache.del(buildWorkspaceBotRuntimeSettingsCacheKey(workspaceId));

  return getWorkspaceBotRuntimeSettings(workspaceId);
}
