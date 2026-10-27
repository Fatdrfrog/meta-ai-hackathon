export const FUNNEL_TEMPLATE_VERSION = "2.0.0";

export type FunnelTemplateKey =
  | "human_escalation"
  | "lead_generation"
  | "sales_qualified"
  | "onboarding"
  | "active"
  | "retention"
  | "churn_risk"
  | "other";

export type FunnelTemplateKind = "lifecycle_segment" | "handoff";

export type TranslateFn = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

export type FunnelTemplateDefinition = {
  id: string;
  kind: FunnelTemplateKind;
  segmentKey: FunnelTemplateKey;
  segmentLabel: string;
  title: string;
  description: string;
  mainScenarioName: string;
  recoveryScenarioName: string;
  noReplyTimeoutMinutes: number;
  recoveryDelayMinutes: number;
};

export type StaticFunnelTemplateDefinition = Omit<
  FunnelTemplateDefinition,
  | "segmentLabel"
  | "title"
  | "description"
  | "mainScenarioName"
  | "recoveryScenarioName"
> & {
  segmentLabelKey: string;
  titleKey: string;
  descriptionKey: string;
  mainScenarioNameKey: string;
  recoveryScenarioNameKey: string;
};

const DEFAULT_NO_REPLY_TIMEOUT_MINUTES = 30;
const DEFAULT_RECOVERY_DELAY_MINUTES = 30;

export const FUNNEL_TEMPLATE_ID_BY_KEY: Record<FunnelTemplateKey, string> = {
  human_escalation: "segment_human_escalation_pack",
  lead_generation: "segment_lead_generation_funnel",
  sales_qualified: "segment_sales_qualified_funnel",
  onboarding: "segment_onboarding_funnel",
  active: "segment_active_funnel",
  retention: "segment_retention_funnel",
  churn_risk: "segment_churn_risk_funnel",
  other: "segment_other_discovery_funnel",
};

const FUNNEL_TEMPLATE_KEYS: FunnelTemplateKey[] = [
  "human_escalation",
  "lead_generation",
  "sales_qualified",
  "onboarding",
  "active",
  "retention",
  "churn_risk",
  "other",
];

const FUNNEL_TEMPLATE_TRANSLATION_KEYS: Record<
  FunnelTemplateKey,
  Pick<
    StaticFunnelTemplateDefinition,
    | "segmentLabelKey"
    | "titleKey"
    | "descriptionKey"
    | "mainScenarioNameKey"
    | "recoveryScenarioNameKey"
  >
> = {
  human_escalation: {
    segmentLabelKey: "funnelSegmentHumanEscalation",
    titleKey: "funnelPresetHumanEscalationTitle",
    descriptionKey: "funnelPresetHumanEscalationDescription",
    mainScenarioNameKey: "funnelPresetHumanEscalationMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetHumanEscalationRecoveryScenarioName",
  },
  lead_generation: {
    segmentLabelKey: "funnelSegmentLeadGeneration",
    titleKey: "funnelPresetLeadGenerationTitle",
    descriptionKey: "funnelPresetLeadGenerationDescription",
    mainScenarioNameKey: "funnelPresetLeadGenerationMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetLeadGenerationRecoveryScenarioName",
  },
  sales_qualified: {
    segmentLabelKey: "funnelSegmentSalesQualified",
    titleKey: "funnelPresetSalesQualifiedTitle",
    descriptionKey: "funnelPresetSalesQualifiedDescription",
    mainScenarioNameKey: "funnelPresetSalesQualifiedMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetSalesQualifiedRecoveryScenarioName",
  },
  onboarding: {
    segmentLabelKey: "funnelSegmentOnboarding",
    titleKey: "funnelPresetOnboardingTitle",
    descriptionKey: "funnelPresetOnboardingDescription",
    mainScenarioNameKey: "funnelPresetOnboardingMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetOnboardingRecoveryScenarioName",
  },
  active: {
    segmentLabelKey: "funnelSegmentActive",
    titleKey: "funnelPresetActiveTitle",
    descriptionKey: "funnelPresetActiveDescription",
    mainScenarioNameKey: "funnelPresetActiveMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetActiveRecoveryScenarioName",
  },
  retention: {
    segmentLabelKey: "funnelSegmentRetention",
    titleKey: "funnelPresetRetentionTitle",
    descriptionKey: "funnelPresetRetentionDescription",
    mainScenarioNameKey: "funnelPresetRetentionMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetRetentionRecoveryScenarioName",
  },
  churn_risk: {
    segmentLabelKey: "funnelSegmentChurnRisk",
    titleKey: "funnelPresetChurnRiskTitle",
    descriptionKey: "funnelPresetChurnRiskDescription",
    mainScenarioNameKey: "funnelPresetChurnRiskMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetChurnRiskRecoveryScenarioName",
  },
  other: {
    segmentLabelKey: "funnelSegmentOther",
    titleKey: "funnelPresetOtherTitle",
    descriptionKey: "funnelPresetOtherDescription",
    mainScenarioNameKey: "funnelPresetOtherMainScenarioName",
    recoveryScenarioNameKey: "funnelPresetOtherRecoveryScenarioName",
  },
};

const STATIC_FUNNEL_TEMPLATES: StaticFunnelTemplateDefinition[] =
  FUNNEL_TEMPLATE_KEYS.map(key => ({
    id: FUNNEL_TEMPLATE_ID_BY_KEY[key],
    kind: key === "human_escalation" ? "handoff" : "lifecycle_segment",
    segmentKey: key,
    ...FUNNEL_TEMPLATE_TRANSLATION_KEYS[key],
    noReplyTimeoutMinutes: DEFAULT_NO_REPLY_TIMEOUT_MINUTES,
    recoveryDelayMinutes: DEFAULT_RECOVERY_DELAY_MINUTES,
  }));

const STATIC_FUNNEL_TEMPLATE_BY_ID = new Map(
  STATIC_FUNNEL_TEMPLATES.map(template => [template.id, template])
);
const STATIC_FUNNEL_TEMPLATE_BY_KEY = new Map(
  STATIC_FUNNEL_TEMPLATES.map(template => [template.segmentKey, template])
);

export function normalizeFunnelTemplateKey(
  value: unknown
): FunnelTemplateKey | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return FUNNEL_TEMPLATE_KEYS.includes(normalized as FunnelTemplateKey)
    ? (normalized as FunnelTemplateKey)
    : null;
}

export function findStaticFunnelTemplate(params: {
  id?: string | null;
  segmentKey?: string | null;
}): StaticFunnelTemplateDefinition | null {
  const id = params.id?.trim();
  if (id) {
    const byId = STATIC_FUNNEL_TEMPLATE_BY_ID.get(id);
    if (byId) return byId;
  }

  const key = normalizeFunnelTemplateKey(params.segmentKey);
  return key ? (STATIC_FUNNEL_TEMPLATE_BY_KEY.get(key) ?? null) : null;
}

export function buildCustomerFunnelTemplates(
  t: TranslateFn
): FunnelTemplateDefinition[] {
  return STATIC_FUNNEL_TEMPLATES.map(template => ({
    id: template.id,
    kind: template.kind,
    segmentKey: template.segmentKey,
    segmentLabel: t(template.segmentLabelKey),
    title: t(template.titleKey),
    description: t(template.descriptionKey),
    mainScenarioName: t(template.mainScenarioNameKey),
    recoveryScenarioName: t(template.recoveryScenarioNameKey),
    noReplyTimeoutMinutes: template.noReplyTimeoutMinutes,
    recoveryDelayMinutes: template.recoveryDelayMinutes,
  }));
}
