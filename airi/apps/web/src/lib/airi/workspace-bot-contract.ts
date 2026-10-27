export const RETRIEVAL_QUERY_MODES = ["adaptive", "last_message_only"] as const;
export type WorkspaceBotRetrievalQueryMode =
  (typeof RETRIEVAL_QUERY_MODES)[number];

export const WORKSPACE_LANGUAGE_BIASES = ["none", "kz", "ru", "uz"] as const;
export type WorkspaceLanguageBias = (typeof WORKSPACE_LANGUAGE_BIASES)[number];

export const GREETING_BEHAVIORS = ["auto", "brief_only", "disabled"] as const;
export type GreetingBehavior = (typeof GREETING_BEHAVIORS)[number];

export const ESCALATION_BEHAVIORS = [
  "suggest_human",
  "auto_handoff",
  "never",
] as const;
export type EscalationBehavior = (typeof ESCALATION_BEHAVIORS)[number];

export const RESPONSE_STYLES = ["concise", "balanced", "detailed"] as const;
export type ResponseStyle = (typeof RESPONSE_STYLES)[number];

function hasEnumValue<const TValues extends readonly string[]>(
  values: TValues,
  value: unknown
): value is TValues[number] {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

export function isWorkspaceBotRetrievalQueryMode(
  value: unknown
): value is WorkspaceBotRetrievalQueryMode {
  return hasEnumValue(RETRIEVAL_QUERY_MODES, value);
}

export function coerceWorkspaceBotRetrievalQueryMode(
  value: unknown,
  fallback: WorkspaceBotRetrievalQueryMode = "adaptive"
): WorkspaceBotRetrievalQueryMode {
  return isWorkspaceBotRetrievalQueryMode(value) ? value : fallback;
}

export function isWorkspaceLanguageBias(
  value: unknown
): value is WorkspaceLanguageBias {
  return hasEnumValue(WORKSPACE_LANGUAGE_BIASES, value);
}

export function coerceWorkspaceLanguageBias(
  value: unknown,
  fallback: WorkspaceLanguageBias = "none"
): WorkspaceLanguageBias {
  return isWorkspaceLanguageBias(value) ? value : fallback;
}

export function isGreetingBehavior(value: unknown): value is GreetingBehavior {
  return hasEnumValue(GREETING_BEHAVIORS, value);
}

export function coerceGreetingBehavior(
  value: unknown,
  fallback: GreetingBehavior = "auto"
): GreetingBehavior {
  return isGreetingBehavior(value) ? value : fallback;
}

export function isEscalationBehavior(
  value: unknown
): value is EscalationBehavior {
  return hasEnumValue(ESCALATION_BEHAVIORS, value);
}

export function coerceEscalationBehavior(
  value: unknown,
  fallback: EscalationBehavior = "suggest_human"
): EscalationBehavior {
  return isEscalationBehavior(value) ? value : fallback;
}

export function isResponseStyle(value: unknown): value is ResponseStyle {
  return hasEnumValue(RESPONSE_STYLES, value);
}

export function coerceResponseStyle(
  value: unknown,
  fallback: ResponseStyle = "balanced"
): ResponseStyle {
  return isResponseStyle(value) ? value : fallback;
}

export interface WorkspaceAgentPersona {
  displayName?: string;
  tone?: string;
  topicRestrictions?: string[];
}

export type CustomAvailableAction = {
  action: string;
  when: string;
};

export type ChannelInstructions = {
  whatsapp?: string;
  telegram?: string;
  instagram?: string;
  webWidget?: string;
};

export type WorkspaceBotRuntimeSettings = {
  defaultBotEnabled: boolean;
  defaultScenariosEnabled: boolean;
  defaultCoachEnabled: boolean;
  retrievalQueryMode: WorkspaceBotRetrievalQueryMode;
  includeRecentConversationInRetrievalContext: boolean;
  sendKbArticleLinksToUserChannels: boolean;
  elevenlabsAgentId?: string;
  whatsappVoiceRepliesEnabled?: boolean;
  languageBias: WorkspaceLanguageBias;
  agentPersona?: WorkspaceAgentPersona;
  customInstructions?: string;
  greetingBehavior: GreetingBehavior;
  escalationBehavior: EscalationBehavior;
  responseStyle: ResponseStyle;
  customAvailableActions?: CustomAvailableAction[];
  channelInstructions?: ChannelInstructions;
};

export const DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS: WorkspaceBotRuntimeSettings =
  {
    defaultBotEnabled: false,
    /** New workspaces / missing settings docs start with scenarios ON. */
    defaultScenariosEnabled: true,
    defaultCoachEnabled: true,
    retrievalQueryMode: "adaptive",
    includeRecentConversationInRetrievalContext: true,
    sendKbArticleLinksToUserChannels: false,
    whatsappVoiceRepliesEnabled: false,
    languageBias: "none",
    greetingBehavior: "auto",
    escalationBehavior: "suggest_human",
    responseStyle: "balanced",
  };

export type WorkspaceBotRuntimeSettingsUpdate = Partial<{
  retrievalQueryMode: WorkspaceBotRetrievalQueryMode;
  includeRecentConversationInRetrievalContext: boolean;
  sendKbArticleLinksToUserChannels: boolean;
  elevenlabsAgentId: string | null;
  whatsappVoiceRepliesEnabled: boolean;
  languageBias: WorkspaceLanguageBias;
  agentPersona: WorkspaceAgentPersona | null;
  customInstructions: string | null;
  greetingBehavior: GreetingBehavior;
  escalationBehavior: EscalationBehavior;
  responseStyle: ResponseStyle;
  customAvailableActions: CustomAvailableAction[] | null;
  channelInstructions: ChannelInstructions | null;
}>;

export type WorkspaceScenariosDefaultSource = {
  airi_scenarios_default_enabled?: boolean | null;
  airi_bot_default_enabled?: boolean | null;
};

export type ConversationScenariosToggleSource = {
  airi_scenarios_enabled?: boolean | null;
  airi_bot_enabled?: boolean | null;
  airi_enabled?: boolean | null;
};

export function resolveWorkspaceScenariosDefault(
  source: WorkspaceScenariosDefaultSource | null | undefined,
  fallback = DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.defaultScenariosEnabled
): boolean {
  if (typeof source?.airi_scenarios_default_enabled === "boolean") {
    return source.airi_scenarios_default_enabled;
  }
  if (typeof source?.airi_bot_default_enabled === "boolean") {
    return source.airi_bot_default_enabled;
  }
  return fallback;
}

export function resolveConversationScenariosEnabled(
  source: ConversationScenariosToggleSource | null | undefined,
  fallback = DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS.defaultScenariosEnabled
): boolean {
  if (typeof source?.airi_scenarios_enabled === "boolean") {
    return source.airi_scenarios_enabled;
  }
  if (typeof source?.airi_bot_enabled === "boolean") {
    return source.airi_bot_enabled;
  }
  if (typeof source?.airi_enabled === "boolean") {
    return source.airi_enabled;
  }
  return fallback;
}

export type WorkspaceBotSettingsApiResponse = {
  success: true;
  totalConversations: number;
  enabledConversations: number;
  scenariosEnabledConversations: number;
  coachEnabledConversations: number;
  publishedKbArticlesCount?: number;
  shouldShowOnboardingHint?: boolean;
  voiceReplyAccess?: {
    available: boolean;
    reason: "subscription_required" | "elevenlabs_required" | null;
  };
} & WorkspaceBotRuntimeSettings;

export type AgentSettingsFormState = Omit<
  WorkspaceBotRuntimeSettings,
  | "defaultBotEnabled"
  | "defaultScenariosEnabled"
  | "defaultCoachEnabled"
  | "agentPersona"
  | "customInstructions"
  | "elevenlabsAgentId"
  | "customAvailableActions"
  | "channelInstructions"
> & {
  whatsappVoiceRepliesEnabled: boolean;
  agentPersona: WorkspaceAgentPersona | null;
  customInstructions: string | null;
  elevenlabsAgentId: string | null;
  customAvailableActions: CustomAvailableAction[];
  channelInstructions: ChannelInstructions | null;
};

export const EMPTY_AGENT_SETTINGS_FORM: AgentSettingsFormState = {
  ...DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS,
  whatsappVoiceRepliesEnabled: false,
  agentPersona: null,
  customInstructions: null,
  elevenlabsAgentId: null,
  customAvailableActions: [],
  channelInstructions: null,
};
