import { extractCrmKeyMomentTypes } from "./follow-up";
import { CRM_UNASSIGNED_STAGE_KEY, normalizeCrmStageKey } from "./stages";

const USEFUL_ENTITY_TYPES = new Set(["product", "price"]);
const HIDDEN_FUNNEL_KEYS = new Set([
  CRM_UNASSIGNED_STAGE_KEY,
  "sales",
  "support",
  "spam",
  "other",
]);

const LEADS_NAMED_STAGE_KEYS = new Set([
  CRM_UNASSIGNED_STAGE_KEY,
  "new",
  "qualified",
  "proposal",
  "won",
  "lost",
  "registered_business",
]);

export function resolveNamedCrmStageKey(
  value: string | null | undefined
): string | null {
  const key = normalizeCrmStageKey(value);
  return key && LEADS_NAMED_STAGE_KEYS.has(key) ? key : null;
}

const USEFUL_PRIORITIES = new Set(["medium", "high", "urgent"]);

export type ConversationEntity = {
  type?: string | null;
  value?: string | null;
};

export function isUsefulLeadSentiment(
  sentiment: string | null | undefined
): boolean {
  const value = sentiment?.trim().toLowerCase();
  return value === "positive" || value === "negative";
}

export function isUsefulLeadChurn(level: string | null | undefined): boolean {
  const value = level?.trim().toLowerCase();
  return value === "high" || value === "medium";
}

export function isUsefulLeadPriority(
  priority: string | null | undefined
): boolean {
  return USEFUL_PRIORITIES.has(priority?.trim().toLowerCase() || "");
}

export type LeadContactPoints = {
  emails?: readonly string[] | null;
  phones?: readonly string[] | null;
  usernames?: readonly string[] | null;
};

/** One line under a lead's name: email, then phone, then username. */
export function primaryLeadContactPoint(
  contactPoints: LeadContactPoints | null | undefined
): string | null {
  return (
    contactPoints?.emails?.[0] ||
    contactPoints?.phones?.[0] ||
    contactPoints?.usernames?.[0] ||
    null
  );
}

export function isVisibleCrmFunnelStage(
  value: string | null | undefined
): boolean {
  const key = normalizeCrmStageKey(value);
  if (!key || HIDDEN_FUNNEL_KEYS.has(key)) return false;
  return /^[a-z0-9_]+$/.test(key) && key.length <= 40;
}

export function pickProductEntities(
  entities: Array<ConversationEntity | null> | null | undefined
): ConversationEntity[] {
  if (!Array.isArray(entities)) return [];
  const seen = new Set<string>();
  const picked: ConversationEntity[] = [];
  for (const entity of entities) {
    if (!entity) continue;
    const type = entity.type?.trim().toLowerCase() || "";
    const value = entity.value?.trim() || "";
    if (!USEFUL_ENTITY_TYPES.has(type) || !value) continue;
    const key = `${type}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ type, value });
    if (picked.length >= 6) break;
  }
  return picked;
}

export function pickKeyMomentTypes(moments: unknown): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const type of extractCrmKeyMomentTypes(moments)) {
    const key = type.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    types.push(key);
  }
  return types;
}

export function formatKeyMomentLabel(type: string): string {
  return type.replace(/_/g, " ");
}
