import type { CitationStrength } from "@/lib/airi/rag/evidence/evidence-types";
import type {
  GreetingBehavior,
  ResponseStyle,
} from "@/lib/airi/workspace-bot-contract";

export type ReplyPromptBudgetProvider = "anthropic" | "vertex" | "elevenlabs";

export type ReplyOutputProfile =
  | "clarification"
  | "grounded_answer"
  | "grounded_list"
  | "grounded_overview";

export type ReplyPromptSectionName =
  | "latest_customer_message"
  | "previous_incomplete_draft"
  | "scenario_instruction"
  | "customer_answers"
  | "answer_coverage_plan"
  | "grounded_context"
  | "agent_context"
  | "calendar_availability"
  | "thread_memory_summary"
  | "recent_conversation_tail"
  | "cross_conversation_context"
  | "conversation_summaries"
  | "quick_replies"
  | "company_context"
  | "widget_context"
  | "greeting_status"
  | "task";

export type ReplyPromptEnvelope = {
  systemPrompt: string;
  userPrompt: string;
  estimatedInputChars: number;
  estimatedInputTokens: number;
  providerBudget: ReplyPromptBudgetProvider;
  inputCharLimit: number;
  inputTokenLimit: number;
  outputProfile: ReplyOutputProfile;
  outputMaxTokens: number;
  sectionsIncluded: ReplyPromptSectionName[];
  trimmedSections: ReplyPromptSectionName[];
  droppedSections: ReplyPromptSectionName[];
  sectionBudgets: Record<
    ReplyPromptSectionName,
    {
      maxChars: number;
      requestedChars: number;
      finalChars: number;
      dropped: boolean;
    }
  >;
  wasOverBudget: boolean;
};

export type BuildReplyPromptEnvelopeParams = {
  providerBudget: ReplyPromptBudgetProvider;
  outputProfile: ReplyOutputProfile;
  language: string;
  languageName: string;
  alreadyGreeted: boolean;
  channelInstruction?: string;
  hasGroundedContext: boolean;
  latestCustomerMessage: string;
  scenarioInstruction?: string;
  /** Customer answers the scenario instruction names, as quoted lines. */
  customerAnswersBlock?: string;
  answerCoverageBlock?: string;
  groundedContext?: string;
  agentContextBlock?: string;
  calendarAvailabilityBlock?: string;
  threadMemorySummary?: string;
  recentConversationTail?: string;
  crossConversationContext?: string;
  conversationSummariesBlock?: string;
  quickRepliesBlock?: string;
  companyContextBlock?: string;
  widgetContextBlock?: string;
  previousIncompleteDraft?: string;
  compactMode?: boolean;
  agentName?: string;
  greetingBehavior?: GreetingBehavior;
  customInstructions?: string;
  responseStyle?: ResponseStyle;
  /** Effective planner + env citation discipline (strict / preferred / none). */
  citationDiscipline?: CitationStrength;
};
