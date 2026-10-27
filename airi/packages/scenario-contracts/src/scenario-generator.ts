export type ScenarioGeneratorWorkflowKind =
  | "bulk_campaign"
  | "follow_up_workflow";

export type ScenarioGeneratorSendMode = "immediate" | "trigger";

export type ScenarioGeneratorChannel = "whatsapp" | "telegram" | "email";

export const SCENARIO_GENERATOR_CHANNELS = [
  "whatsapp",
  "telegram",
  "email",
] as const satisfies readonly ScenarioGeneratorChannel[];

export const SCENARIO_GENERATOR_MAX_LOGICAL_RECIPIENTS = 1_000;
export const SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES =
  SCENARIO_GENERATOR_MAX_LOGICAL_RECIPIENTS *
  SCENARIO_GENERATOR_CHANNELS.length;

const SCENARIO_GENERATOR_CHANNEL_SET = new Set<string>(
  SCENARIO_GENERATOR_CHANNELS,
);
const SCENARIO_GENERATOR_SOURCE_CONTEXT_TYPES = new Set<string>([
  ...SCENARIO_GENERATOR_CHANNELS,
  "canva",
  "higgsfield",
  "google_calendar",
]);

export function isScenarioGeneratorChannel(
  value: unknown,
): value is ScenarioGeneratorChannel {
  return typeof value === "string" && SCENARIO_GENERATOR_CHANNEL_SET.has(value);
}

export function normalizeScenarioGeneratorChannels(
  value: unknown,
): ScenarioGeneratorChannel[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isScenarioGeneratorChannel)));
}

export type ScenarioGeneratorRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  sourceId?: string | null;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

export type ResolvedScenarioGeneratorRecipient = {
  channel: ScenarioGeneratorChannel;
  recipient: string;
  name?: string;
  email?: string;
  sourceId?: string | null;
  cohortId: string;
  cohortLabel: string;
};

export type ScenarioGeneratedRecipientCohort = {
  id: string;
  label: string;
  branchId: string;
  count: number;
  taxonomyCategory?: string;
  internalLabels?: string[];
};

export type ScenarioGeneratorAssetRef = {
  id?: string;
  kind?: "image" | "video" | "audio" | "document";
  source?: "uploaded" | "higgsfield";
  url: string;
  mimeType?: string;
  fileName?: string;
  bucket?: string;
  path?: string;
};

export type ScenarioGeneratorCanvaTemplateRef = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  createUrl: string | null;
  source: "canva_brand_template";
};

export type ScenarioGeneratorSourceContext = {
  id?: string;
  type: ScenarioGeneratorChannel | "canva" | "higgsfield" | "google_calendar";
  label?: string;
  role?: "delivery" | "creative" | "context";
};

export const SCENARIO_GENERATOR_SOURCE_CONTEXT_MAX_ITEMS = 100;

export type ScenarioGeneratorPresetSeed = {
  id: string;
  version: string;
  segmentKey: string;
  title: string;
  description: string;
  segmentLabel: string;
};

export type ScenarioGeneratorFollowUpQuestion = {
  question: string;
  context?: string;
};

export type ScenarioGeneratorBlueprint = {
  summary: string;
  campaignName: string;
  workflowKind: ScenarioGeneratorWorkflowKind;
  sendMode: ScenarioGeneratorSendMode;
  channels: ScenarioGeneratorChannel[];
  recipientSourceSummary: string;
  cohorts: Array<{
    id: string;
    label: string;
    branchId: string;
    count: number;
  }>;
};

export type ScenarioGeneratorPlanInput = {
  workspaceId: string;
  prompt: string;
  answers?: Array<{ question: string; answer: string }>;
  workflowKind: ScenarioGeneratorWorkflowKind;
  sendMode: ScenarioGeneratorSendMode;
  channels: ScenarioGeneratorChannel[];
  recipientSourceSummary?: string;
  recipients?: ScenarioGeneratorRecipient[];
  assetRefs?: ScenarioGeneratorAssetRef[];
  sourceIds?: string[];
  sourceContext?: ScenarioGeneratorSourceContext[];
  selectedCanvaTemplates?: ScenarioGeneratorCanvaTemplateRef[];
  presetSeed?: ScenarioGeneratorPresetSeed;
};

export type ScenarioGeneratorCreateInput = ScenarioGeneratorPlanInput & {
  campaignName?: string;
};

export type ScenarioGeneratorPlanResult =
  | {
      status: "needs_input";
      questions: ScenarioGeneratorFollowUpQuestion[];
    }
  | {
      status: "ready";
      templateSearchQuery?: string;
      blueprint: ScenarioGeneratorBlueprint;
    };

export type ScenarioGeneratorCanvaTemplatesResult = {
  status: "ok" | "connection_needed" | "reconnect_required" | "error";
  query: string;
  items: ScenarioGeneratorCanvaTemplateRef[];
  continuation: string | null;
  connectUrl?: string;
  error?: string;
};

function asTrimmedString(value: unknown): string {
  if (value == null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  return "";
}

export function normalizeScenarioGeneratorSourceContext(
  value: unknown,
): ScenarioGeneratorSourceContext[] {
  if (!Array.isArray(value)) return [];
  const contexts = new Map<string, ScenarioGeneratorSourceContext>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const type = asTrimmedString(raw.type).toLowerCase();
    if (!SCENARIO_GENERATOR_SOURCE_CONTEXT_TYPES.has(type)) continue;

    const id = asTrimmedString(raw.id);
    const label = asTrimmedString(raw.label);
    const roleValue = asTrimmedString(raw.role).toLowerCase();
    const role =
      roleValue === "delivery" ||
      roleValue === "creative" ||
      roleValue === "context"
        ? roleValue
        : undefined;
    const key = `${type}:${id || label || contexts.size}`;
    contexts.set(key, {
      ...(id ? { id } : {}),
      type: type as ScenarioGeneratorSourceContext["type"],
      ...(label ? { label } : {}),
      ...(role ? { role } : {}),
    });
  }
  return Array.from(contexts.values()).slice(
    0,
    SCENARIO_GENERATOR_SOURCE_CONTEXT_MAX_ITEMS,
  );
}

export function normalizeScenarioGeneratorPresetSeed(
  value: unknown,
): ScenarioGeneratorPresetSeed | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = asTrimmedString(raw.id);
  const version = asTrimmedString(raw.version);
  const segmentKey = asTrimmedString(raw.segmentKey);
  const title = asTrimmedString(raw.title);
  if (!id || !version || !segmentKey || !title) return null;
  return {
    id,
    version,
    segmentKey,
    title,
    description: asTrimmedString(raw.description),
    segmentLabel: asTrimmedString(raw.segmentLabel) || segmentKey,
  };
}
