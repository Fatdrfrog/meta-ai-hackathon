import {
  dropExactDuplicateLowerPrioritySections,
  measureAssembledReplyPrompt,
  resolveInputBudget,
  resolveOutputMaxTokens,
  trimSectionsToBudget,
} from "@/lib/airi/reply/generation/prompt-envelope-budget";
import {
  buildSectionContentMap,
  createSection,
  SECTION_PRIORITY_ASC,
  stripLatestCustomerMessageFromRecentTail,
} from "@/lib/airi/reply/generation/prompt-envelope-sections";
import { buildSystemPrompt } from "@/lib/airi/reply/generation/prompt-envelope-system";
import type {
  BuildReplyPromptEnvelopeParams,
  ReplyPromptEnvelope,
} from "@/lib/airi/reply/generation/prompt-envelope-types";

export type {
  ReplyPromptEnvelope,
  ReplyOutputProfile,
} from "@/lib/airi/reply/generation/prompt-envelope-types";

export function buildReplyPromptEnvelope(
  params: BuildReplyPromptEnvelopeParams
): ReplyPromptEnvelope {
  const compactMode = params.compactMode ?? false;
  const citationDiscipline = params.citationDiscipline ?? "none";
  const sanitizedRecentConversationTail =
    stripLatestCustomerMessageFromRecentTail({
      recentConversationTail: params.recentConversationTail,
      latestCustomerMessage: params.latestCustomerMessage,
    });
  const systemPrompt = buildSystemPrompt({
    language: params.language,
    languageName: params.languageName,
    alreadyGreeted: params.alreadyGreeted,
    channelInstruction: params.channelInstruction,
    hasGroundedContext: params.hasGroundedContext,
    outputProfile: params.outputProfile,
    agentName: params.agentName,
    greetingBehavior: params.greetingBehavior,
    customInstructions: params.customInstructions,
    responseStyle: params.responseStyle,
    citationDiscipline,
  });
  const budget = resolveInputBudget(params.providerBudget, compactMode);
  const sectionContent = buildSectionContentMap({
    latestCustomerMessage: params.latestCustomerMessage,
    previousIncompleteDraft: params.previousIncompleteDraft,
    scenarioInstruction: params.scenarioInstruction,
    customerAnswersBlock: params.customerAnswersBlock,
    answerCoverageBlock: params.answerCoverageBlock,
    groundedContext: params.groundedContext,
    agentContextBlock: params.agentContextBlock,
    calendarAvailabilityBlock: params.calendarAvailabilityBlock,
    threadMemorySummary: params.threadMemorySummary,
    recentConversationTail: sanitizedRecentConversationTail,
    crossConversationContext: params.crossConversationContext,
    conversationSummariesBlock: params.conversationSummariesBlock,
    quickRepliesBlock: params.quickRepliesBlock,
    companyContextBlock: params.companyContextBlock,
    widgetContextBlock: params.widgetContextBlock,
    alreadyGreeted: params.alreadyGreeted,
    outputProfile: params.outputProfile,
    citationDiscipline,
  });

  const sections = SECTION_PRIORITY_ASC.map(sectionName =>
    createSection(
      sectionName,
      sectionContent[sectionName],
      compactMode,
      params.outputProfile
    )
  );
  const dedupedSections = dropExactDuplicateLowerPrioritySections(sections);

  const trimmed = trimSectionsToBudget(dedupedSections, systemPrompt, budget);
  const promptMeasurement = measureAssembledReplyPrompt(
    systemPrompt,
    trimmed.sections
  );
  const userPrompt = promptMeasurement.userPrompt;
  const estimatedInputChars = promptMeasurement.totalChars;
  const estimatedInputTokens = promptMeasurement.totalTokens;

  const sectionBudgets = trimmed.sections.reduce(
    (acc, section) => {
      acc[section.name] = {
        maxChars: section.maxChars,
        requestedChars: section.originalContent.length,
        finalChars: section.finalContent.length,
        dropped: section.dropped,
      };
      return acc;
    },
    {} as ReplyPromptEnvelope["sectionBudgets"]
  );

  return {
    systemPrompt,
    userPrompt,
    estimatedInputChars,
    estimatedInputTokens,
    providerBudget: params.providerBudget,
    inputCharLimit: budget.inputCharLimit,
    inputTokenLimit: budget.inputTokenLimit,
    outputProfile: params.outputProfile,
    outputMaxTokens: resolveOutputMaxTokens(
      params.outputProfile,
      params.responseStyle
    ),
    sectionsIncluded: trimmed.sections
      .filter(section => section.finalContent.trim())
      .map(section => section.name),
    trimmedSections: trimmed.sections
      .filter(section => section.trimmed)
      .map(section => section.name),
    droppedSections: trimmed.sections
      .filter(section => section.dropped)
      .map(section => section.name),
    sectionBudgets,
    wasOverBudget: trimmed.wasOverBudget,
  };
}
