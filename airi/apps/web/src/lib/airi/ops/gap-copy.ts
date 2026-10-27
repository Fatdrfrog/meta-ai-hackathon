import type { MissingKnowledgeIntent } from "@/lib/airi/grounding/factual-grounding-guard";

export type GapTrackingIntent = MissingKnowledgeIntent | "unknown";

export function normalizeGapIntegrationTopic(
  topic?: string | null
): string | null {
  const normalized = String(topic || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || null;
}

export function formatGapIntegrationTopicLabel(topic?: string | null): string {
  const normalized = normalizeGapIntegrationTopic(topic);
  if (!normalized) return "requested";
  return normalized
    .split("_")
    .filter(Boolean)
    .map(chunk => chunk[0].toUpperCase() + chunk.slice(1))
    .join(" ");
}

export function formatGapIntentLabel(intent: string): string {
  if (intent === "business_hours") return "business hours";
  if (intent === "pricing") return "pricing";
  if (intent === "policy") return "policy details";
  if (intent === "integration_request") return "integration demand";
  return intent.replace(/_/g, " ");
}

export function getMissingKnowledgeLabel(
  intent: MissingKnowledgeIntent,
  topic?: string | null
): string {
  if (intent === "business_hours") return "business hours";
  if (intent === "pricing") return "pricing";
  if (intent === "integration_request") {
    return `${formatGapIntegrationTopicLabel(topic)} integration`;
  }
  return "policy details";
}

export function shouldPromptForGapIntent(intent: GapTrackingIntent): boolean {
  return intent !== "unknown";
}

export function buildGapRecommendationCopy(params: {
  workspaceId: string;
  intent: string;
  askCount: number;
  topic?: string | null;
}): {
  title: string;
  description: string;
  links: Array<{ label: string; href: string }>;
} {
  if (params.intent === "integration_request") {
    const integrationsPath = `/panel/w/${params.workspaceId}/settings/integrations`;
    const requestsPath = `/panel/w/${params.workspaceId}/requests`;
    const topicLabel = formatGapIntegrationTopicLabel(params.topic);
    return {
      title: `Review ${topicLabel} integration demand`,
      description: `Customers requested ${topicLabel} integration ${params.askCount} times. Validate demand, define workaround, and decide implementation path.`,
      links: [
        { label: "Open Integrations", href: integrationsPath },
        { label: "Open Requests", href: requestsPath },
      ],
    };
  }

  if (params.intent === "unknown") {
    const aiContextPath = `/panel/w/${params.workspaceId}/settings/ai-context`;
    const scenariosPath = `/panel/w/${params.workspaceId}/scenarios`;
    const requestsPath = `/panel/w/${params.workspaceId}/requests`;
    return {
      title: "Review unanswered customer questions",
      description: `Customers asked ${params.askCount} questions that could not be answered from the knowledge base. Review recent conversations, add missing Q/A snippets, and expand KB articles.`,
      links: [
        { label: "Open AI Context", href: aiContextPath },
        { label: "Open Scenario Builder", href: scenariosPath },
        { label: "Open Requests", href: requestsPath },
      ],
    };
  }

  const intentLabel = formatGapIntentLabel(params.intent);
  const scenariosPath = `/panel/w/${params.workspaceId}/scenarios`;
  const aiContextPath = `/panel/w/${params.workspaceId}/settings/ai-context`;
  return {
    title: `Fill ${intentLabel} coverage`,
    description: `Customers asked about ${intentLabel} ${params.askCount} times without grounded context. Configure Scenario Builder first, then backfill AI Context.`,
    links: [
      { label: "Open Scenario Builder", href: scenariosPath },
      { label: "Open AI Context", href: aiContextPath },
    ],
  };
}

export function buildMissingKnowledgeCoachPayload(params: {
  messageId: string;
  workspaceId: string;
  intent: MissingKnowledgeIntent;
  askCount: number;
  topic?: string | null;
}) {
  const label = getMissingKnowledgeLabel(params.intent, params.topic);
  const scenariosPath = `/panel/w/${params.workspaceId}/scenarios`;
  const aiContextPath = `/panel/w/${params.workspaceId}/settings/ai-context`;
  const integrationsPath = `/panel/w/${params.workspaceId}/settings/integrations`;
  const requestsPath = `/panel/w/${params.workspaceId}/requests`;

  if (params.intent === "integration_request") {
    return {
      suggestionId: `missing-knowledge-${params.intent}-${params.topic || "general"}-${params.askCount}`,
      messageId: params.messageId,
      kind: "knowledge_gap",
      knowledgeGap: {
        intent: params.intent,
        askCount: params.askCount,
        topic: params.topic || null,
      },
      tips: [
        {
          title: "Integration demand detected",
          suggestion: `Customers asked for ${label} ${params.askCount} times. Review feasibility, define a workaround, and decide implementation path.`,
          type: "clarity" as const,
          confidence: 1,
        },
      ],
      actions: [
        {
          label: "Open Integrations",
          href: integrationsPath,
          intent: "primary" as const,
        },
        {
          label: "Open Requests",
          href: requestsPath,
          intent: "secondary" as const,
        },
      ],
      source: "kb",
    };
  }

  return {
    suggestionId: `missing-knowledge-${params.intent}-${params.askCount}`,
    messageId: params.messageId,
    kind: "knowledge_gap",
    knowledgeGap: {
      intent: params.intent,
      askCount: params.askCount,
    },
    tips: [
      {
        title: "Missing high-demand knowledge",
        suggestion: `Customers asked about ${label} ${params.askCount} times without grounded context. Add this in Scenario Builder first (${scenariosPath}), then backfill AI Context (${aiContextPath}).`,
        type: "clarity" as const,
        confidence: 1,
      },
    ],
    actions: [
      {
        label: "Open Scenario Builder",
        href: scenariosPath,
        intent: "primary" as const,
      },
      {
        label: "Open AI Context",
        href: aiContextPath,
        intent: "secondary" as const,
      },
    ],
    source: "kb",
  };
}
