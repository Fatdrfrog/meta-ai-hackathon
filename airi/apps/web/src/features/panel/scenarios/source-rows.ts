import "server-only";

import {
  SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS,
  type ScenarioSourceReadinessRow,
} from "@/components/scenarios/scenario-onboarding";

type ReadinessCredentialKey =
  (typeof SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS)[number];

function credentialColumn(key: ReadinessCredentialKey): string {
  return `credential_${key}`;
}

/**
 * Reads each readiness credential as its own JSON column instead of the whole
 * credentials object, so secrets the readiness checks do not use are never
 * read. The ones they do use (such as a Telegram `bot_token`) stay on the
 * server: only derived flags and options reach props. `->` keeps JSON types,
 * so booleans stay booleans.
 */
export const SCENARIO_SOURCE_READINESS_SELECT = [
  "id",
  "type",
  "name",
  ...SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS.map(
    key => `${credentialColumn(key)}:credentials->${key}`
  ),
].join(", ");

export type ScenarioSourceReadinessQueryRow = Pick<
  ScenarioSourceReadinessRow,
  "id" | "type" | "name"
> &
  Record<string, unknown>;

/** Rebuilds the credentials the readiness helpers read from the projection. */
export function toScenarioSourceReadinessRow(
  row: ScenarioSourceReadinessQueryRow
): ScenarioSourceReadinessRow {
  const credentials: Record<string, unknown> = {};
  for (const key of SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS) {
    const value = row[credentialColumn(key)];
    // A missing key and a JSON null both come back as null.
    if (value !== null && value !== undefined) credentials[key] = value;
  }
  return { id: row.id, type: row.type, name: row.name, credentials };
}

/**
 * The rows a SCENARIO_SOURCE_READINESS_SELECT query returned. Its select list
 * is built at runtime, so the client cannot type the rows itself.
 */
export function toScenarioSourceReadinessRows(
  data: unknown
): ScenarioSourceReadinessRow[] {
  return ((data ?? []) as ScenarioSourceReadinessQueryRow[]).map(
    toScenarioSourceReadinessRow
  );
}
