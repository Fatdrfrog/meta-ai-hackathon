import type {
  ScenarioGeneratedRecipientCohort,
  ScenarioGeneratorChannel,
  ScenarioGeneratorRecipient,
  ResolvedScenarioGeneratorRecipient,
} from "@icecore/scenario-contracts";
import { normalizeCampaignEmail } from "@/lib/campaign/campaign-recipient-utils";

export type {
  ScenarioGeneratorRecipient,
  ResolvedScenarioGeneratorRecipient,
} from "@icecore/scenario-contracts";

function normalizeDigits(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

function normalizeChatId(value: unknown): string {
  return String(value || "").trim();
}

function fieldValue(
  recipient: ScenarioGeneratorRecipient,
  keys: string[]
): string {
  const values = {
    ...(recipient.fields || {}),
    ...(recipient.variables || {}),
  };
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [
      key.trim().toLowerCase().replace(/\s+/g, "_"),
      String(value || "").trim(),
    ])
  );
  for (const key of keys) {
    const value = normalized.get(key.trim().toLowerCase().replace(/\s+/g, "_"));
    if (value) return value;
  }
  return "";
}

export function resolveRecipientCohortLabel(
  recipient: ScenarioGeneratorRecipient
): string {
  return (
    fieldValue(recipient, [
      "category",
      "classification",
      "classification_category",
      "segment",
      "type",
      "label",
      "internal_label",
    ]) || "Generated audience"
  );
}

export function buildRecipientCohorts(
  recipients: ScenarioGeneratorRecipient[]
): ScenarioGeneratedRecipientCohort[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const recipient of recipients) {
    const label = resolveRecipientCohortLabel(recipient);
    const id =
      label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "generated-audience";
    const current = counts.get(id) || { label, count: 0 };
    current.count += 1;
    counts.set(id, current);
  }

  const cohorts = Array.from(counts.entries())
    .map(([id, value]) => ({
      id,
      label: value.label,
      branchId: id,
      count: value.count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 10);

  return cohorts.length > 0
    ? cohorts
    : [
        {
          id: "generated-audience",
          label: "Generated audience",
          branchId: "generated-audience",
          count: 0,
        },
      ];
}

export function resolveScenarioGeneratorRecipients(params: {
  channels: ScenarioGeneratorChannel[];
  recipients: ScenarioGeneratorRecipient[];
  cohorts: ScenarioGeneratedRecipientCohort[];
}): ResolvedScenarioGeneratorRecipient[] {
  const channelSet = new Set(params.channels);
  const cohortByLabel = new Map(
    params.cohorts.map(cohort => [cohort.label, cohort])
  );
  const fallbackCohort = params.cohorts[0] || {
    id: "generated-audience",
    label: "Generated audience",
  };

  return params.recipients.flatMap(
    (recipient): ResolvedScenarioGeneratorRecipient[] => {
      const label = resolveRecipientCohortLabel(recipient);
      const cohort = cohortByLabel.get(label) || fallbackCohort;
      const base = {
        name:
          recipient.name?.trim() ||
          fieldValue(recipient, ["name", "имя", "full_name", "first_name"]),
        sourceId: recipient.sourceId?.trim() || null,
        cohortId: cohort.id,
        cohortLabel: cohort.label,
      };
      const resolved: ResolvedScenarioGeneratorRecipient[] = [];
      const phone = normalizeDigits(recipient.phone);
      const email = normalizeCampaignEmail(recipient.email);
      if (phone && channelSet.has("whatsapp")) {
        resolved.push({
          ...base,
          channel: "whatsapp" as const,
          recipient: phone,
          email: email || undefined,
        });
      }
      const chatId = normalizeChatId(recipient.chatId || recipient.phone);
      if (chatId && channelSet.has("telegram")) {
        resolved.push({
          ...base,
          channel: "telegram" as const,
          recipient: chatId,
        });
      }
      if (email && channelSet.has("email")) {
        resolved.push({
          ...base,
          channel: "email" as const,
          recipient: email,
        });
      }
      return resolved;
    }
  );
}
