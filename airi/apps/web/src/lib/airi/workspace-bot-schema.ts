import { z } from "zod";

import {
  ESCALATION_BEHAVIORS,
  GREETING_BEHAVIORS,
  RESPONSE_STYLES,
  RETRIEVAL_QUERY_MODES,
  WORKSPACE_LANGUAGE_BIASES,
} from "./workspace-bot-contract";

export const CustomAvailableActionSchema = z.object({
  action: z.string().trim().min(1).max(200),
  when: z.string().trim().min(1).max(400),
});

export const AgentPersonaSchema = z.object({
  displayName: z.string().trim().max(100).optional(),
  tone: z.string().trim().max(500).optional(),
  topicRestrictions: z.array(z.string().trim().max(200)).max(20).optional(),
});

export const ChannelInstructionsSchema = z.object({
  whatsapp: z.string().trim().max(1000).optional(),
  telegram: z.string().trim().max(1000).optional(),
  instagram: z.string().trim().max(1000).optional(),
  webWidget: z.string().trim().max(1000).optional(),
});

export function stripBlankCustomActionDrafts(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.filter(entry => {
    if (!entry || typeof entry !== "object") {
      return true;
    }

    const action =
      typeof (entry as { action?: unknown }).action === "string"
        ? (entry as { action: string }).action.trim()
        : "";
    const when =
      typeof (entry as { when?: unknown }).when === "string"
        ? (entry as { when: string }).when.trim()
        : "";

    return action.length > 0 || when.length > 0;
  });
}

export const WorkspaceBotRuntimeSettingsPatchSchema = z.object({
  retrievalQueryMode: z.enum(RETRIEVAL_QUERY_MODES).optional(),
  includeRecentConversationInRetrievalContext: z.boolean().optional(),
  sendKbArticleLinksToUserChannels: z.boolean().optional(),
  elevenlabsAgentId: z.string().trim().max(200).nullable().optional(),
  whatsappVoiceRepliesEnabled: z.boolean().optional(),
  languageBias: z.enum(WORKSPACE_LANGUAGE_BIASES).optional(),
  agentPersona: AgentPersonaSchema.nullable().optional(),
  customInstructions: z.string().trim().max(2000).nullable().optional(),
  greetingBehavior: z.enum(GREETING_BEHAVIORS).optional(),
  escalationBehavior: z.enum(ESCALATION_BEHAVIORS).optional(),
  responseStyle: z.enum(RESPONSE_STYLES).optional(),
  customAvailableActions: z.preprocess(
    stripBlankCustomActionDrafts,
    z.array(CustomAvailableActionSchema).max(10).nullable().optional()
  ),
  channelInstructions: ChannelInstructionsSchema.nullable().optional(),
});
