import type {
  ChannelInstructions,
  CustomAvailableAction,
  EscalationBehavior,
  WorkspaceAgentPersona,
} from "@/lib/airi/workspace-bot-contract";
import type { Channel } from "@/types/models";
import { AGENT_CONTEXT_SECTION } from "@/lib/airi/reply/prompting/agent-context-sections";
import {
  formatWorkspaceChannelInstructionsBlock,
  pickWorkspaceChannelInstruction,
} from "@/lib/airi/reply/prompting/channel-prompt";
import { formatPersonaPromptLines } from "@/lib/airi/reply/prompting/persona-prompt";
import { normalizeWhitespace } from "@icecore/shared/lib/value-utils";
import {
  AGENT_CONTEXT_CHAR_LIMIT,
  truncateToCharBudget,
} from "./shared/token-budget";

export type { WorkspaceAgentPersona };

type AvailableAction = {
  action: string;
  when: string;
};

export interface BuildAgentContextParams {
  currentGoal?: string;
  activeGoals?: string[];
  openAsks?: string[];
  followUpAnchor?: string;
  unresolvedNeeds?: string[];
  resolvedNeeds?: string[];
  hasUnresolvedNeed?: boolean;
  dominantLanguage?: string;
  latestMessage?: string;
  channel?: Channel | string;
  hasActiveScenario?: boolean;
  hasRetrievedContext?: boolean;
  workspacePersona?: WorkspaceAgentPersona;
  customAvailableActions?: CustomAvailableAction[];
  escalationBehavior?: EscalationBehavior;
  channelInstructions?: ChannelInstructions;
}

export interface AgentContext {
  currentGoal: string;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
  hasUnresolvedNeed: boolean;
  dominantLanguage: string;
  availableActions: AvailableAction[];
  toPromptBlock: () => string;
}

function dedupeTopics(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const comparable = normalized.toLowerCase();
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(normalized);
  }

  return result;
}

function truncateTopic(value: string, maxChars: number = 180): string {
  if (!value) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3).trim()}...`;
}

const ESCALATION_ACTION_MAP: Record<
  EscalationBehavior,
  AvailableAction | null
> = {
  suggest_human: {
    action: "Offer human support when needed",
    when: "The question needs judgment, escalation, or information outside the grounded context",
  },
  auto_handoff: {
    action: "Escalate to a human agent immediately",
    when: "The question requires human judgment, is outside your knowledge, or the customer explicitly asks for a person",
  },
  never: null,
};

function resolveAvailableActions(params: {
  channel?: Channel | string;
  hasActiveScenario?: boolean;
  hasRetrievedContext?: boolean;
  hasUnresolvedNeed?: boolean;
  currentGoal?: string;
  resolvedNeeds?: string[];
  customAvailableActions?: CustomAvailableAction[];
  escalationBehavior?: EscalationBehavior;
}): AvailableAction[] {
  const actions: AvailableAction[] = [];
  const channel = (params.channel || "").toLowerCase();

  if (params.hasRetrievedContext) {
    actions.push({
      action: "Answer with grounded facts",
      when: "Retrieved documentation or approved snippets cover the customer's goal",
    });
  } else {
    actions.push({
      action: "Clarify or state limits honestly",
      when: "No grounded facts are available; ask a targeted question or be transparent about the gap",
    });
  }

  if (params.hasUnresolvedNeed || params.currentGoal) {
    actions.push({
      action: "Connect to the ongoing thread",
      when: "The customer is continuing an existing goal and should not be forced to restart from scratch",
    });
  }

  if ((params.resolvedNeeds?.length || 0) > 0) {
    actions.push({
      action: "Avoid repeating fully answered points",
      when: "Prior needs were already addressed and the reply should only add incremental value",
    });
  }

  if (params.hasActiveScenario) {
    actions.push({
      action: "Stay aligned with the active scenario",
      when: "Scenario guidance exists and should not be contradicted by the free-form reply",
    });
  }

  if (channel === "web_widget") {
    actions.push({
      action: "Request contact details only if needed",
      when: "Follow-up is required and the website visitor may be anonymous",
    });
  }

  const escalationAction =
    ESCALATION_ACTION_MAP[params.escalationBehavior || "suggest_human"];
  if (escalationAction) {
    actions.push(escalationAction);
  }

  if (
    params.customAvailableActions &&
    params.customAvailableActions.length > 0
  ) {
    for (const custom of params.customAvailableActions) {
      actions.push({ action: custom.action, when: custom.when });
    }
  }

  return actions;
}

export function buildAgentContext(
  params: BuildAgentContextParams
): AgentContext {
  const currentGoal = normalizeWhitespace(params.currentGoal || "");
  const activeGoals = dedupeTopics(params.activeGoals || []);
  const openAsks = dedupeTopics(params.openAsks || []);
  const followUpAnchor = normalizeWhitespace(params.followUpAnchor || "");
  const unresolvedNeeds = dedupeTopics(params.unresolvedNeeds || []);
  const resolvedNeeds = dedupeTopics(params.resolvedNeeds || []).filter(
    topic =>
      !unresolvedNeeds.some(
        unresolved => unresolved.toLowerCase() === topic.toLowerCase()
      )
  );
  const latestMessage = normalizeWhitespace(params.latestMessage || "");
  const hasUnresolvedNeed =
    Boolean(params.hasUnresolvedNeed) || unresolvedNeeds.length > 0;
  const dominantLanguage = normalizeWhitespace(params.dominantLanguage || "");
  const availableActions = resolveAvailableActions({
    channel: params.channel,
    hasActiveScenario: params.hasActiveScenario,
    hasRetrievedContext: params.hasRetrievedContext,
    hasUnresolvedNeed,
    currentGoal,
    resolvedNeeds,
    customAvailableActions: params.customAvailableActions,
    escalationBehavior: params.escalationBehavior,
  });

  const toPromptBlock = (): string => {
    const sections: string[] = [];

    sections.push(...formatPersonaPromptLines(params.workspacePersona));

    if (currentGoal) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.CURRENT_CUSTOMER_GOAL} ${truncateTopic(currentGoal)}`
      );
    } else if (latestMessage) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.LATEST_CUSTOMER_MESSAGE_THEME} ${truncateTopic(latestMessage)}`
      );
    }

    if (activeGoals.length > 0) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.ACTIVE_THREAD_GOALS}\n${activeGoals.map(topic => `- ${truncateTopic(topic)}`).join("\n")}`
      );
    }

    if (openAsks.length > 0) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.LATEST_ASKS_TO_COVER}\n${openAsks.map(topic => `- ${truncateTopic(topic)}`).join("\n")}`
      );
    }

    if (followUpAnchor) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.FOLLOW_UP_ANCHOR} ${truncateTopic(followUpAnchor)}`
      );
    }

    if (unresolvedNeeds.length > 0) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.OPEN_CUSTOMER_NEEDS}\n${unresolvedNeeds.map(topic => `- ${truncateTopic(topic)}`).join("\n")}`
      );
    }

    if (resolvedNeeds.length > 0) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.ALREADY_ADDRESSED}\n${resolvedNeeds.map(topic => `- ${truncateTopic(topic)}`).join("\n")}`
      );
    }

    if (hasUnresolvedNeed) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.CONVERSATION_CONTINUITY} This is an ongoing thread. Connect your answer to the existing goal instead of restarting the conversation.`
      );
    }

    if (dominantLanguage) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.DOMINANT_CUSTOMER_LANGUAGE} ${dominantLanguage}`
      );
    }

    if (availableActions.length > 0) {
      sections.push(
        `${AGENT_CONTEXT_SECTION.AVAILABLE_ACTIONS}\n${availableActions.map(item => `- ${item.action}: ${item.when}`).join("\n")}`
      );
    }

    const customChannel = pickWorkspaceChannelInstruction(
      params.channel,
      params.channelInstructions
    );
    if (customChannel) {
      sections.push(formatWorkspaceChannelInstructionsBlock(customChannel));
    }

    return truncateToCharBudget(
      sections.filter(Boolean).join("\n\n"),
      AGENT_CONTEXT_CHAR_LIMIT
    );
  };

  return {
    currentGoal,
    unresolvedNeeds,
    resolvedNeeds,
    hasUnresolvedNeed,
    dominantLanguage,
    availableActions,
    toPromptBlock,
  };
}
