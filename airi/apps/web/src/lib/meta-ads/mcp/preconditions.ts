import "server-only";

import { z } from "zod";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import type { MetaAdsMcpTool } from "./client";
import {
  createMetaAdsMcpConversationId,
  withMetaAdsMcpConversationId,
} from "./conversation-id";
import { normalizeMetaAdsMcpResult } from "./result-ledger";
import { validateMetaAdsMcpToolArguments } from "./tool-argument-validation";

type RecordValue = Record<string, unknown>;
type FieldUse = {
  name: string;
  level?: string;
  kind: "field" | "filter" | "sort";
  operator?: string;
};
export type MetaAdsMcpReadPrecondition =
  | { kind: "ready" }
  | {
      kind: "prerequisite";
      call: { name: string; arguments: RecordValue; summary: string };
    }
  | { kind: "blocked"; code: string; message: string };
export type MetaAdsMcpReadPreconditionInput = {
  toolName: string;
  args: RecordValue;
  priorResults: string;
  tools: MetaAdsMcpTool[];
  clientConversationId?: string;
  /**
   * Server-verified account inventory gathered outside this turn's ledger
   * (the readiness probe). It can only prove eligibility; a missing or
   * negative seed falls back to the live account prerequisite.
   */
  seededAccountInventory?: unknown;
};

const MAX_EVIDENCE_CHARS = 200_000;
const DEFAULT_FIELDS = new Set(["id", "name", "amount_spent"]);
const LEVELS = new Set(["campaign", "adset", "ad", "ad_account"]);
const fieldName = z.string().min(1).max(256);
const accountQuerySchema = z
  .object({
    ad_account_id: z.string().regex(/^(?:act_)?[0-9]+$/),
    level: z
      .enum(["campaign", "adset", "ad", "ad_account", "account"])
      .optional(),
    object_state: z.enum(["live", "draft"]).optional(),
  })
  .passthrough();
const fieldQuerySchema = z
  .object({
    fields: z.array(fieldName).max(100).optional(),
    filtering: z
      .array(
        z
          .object({
            field: fieldName,
            operator: z.string().min(1).max(100),
            value: z.array(z.string()).max(100),
          })
          .strict()
      )
      .max(100)
      .optional(),
    sort: z.string().min(1).max(300).optional(),
  })
  .passthrough();
const ledgerSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()).optional(),
            data: z.unknown().optional(),
            error: z.string().optional(),
            omitted: z.boolean().optional(),
          })
          .passthrough()
      )
      .max(100),
  })
  .passthrough();
function normalizeLevel(value: string | undefined) {
  return value === "account" ? "ad_account" : value;
}
function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === "string")
    ? value
    : null;
}
function blocked(
  code: string,
  message: string
): Extract<MetaAdsMcpReadPrecondition, { kind: "blocked" }> {
  return { kind: "blocked", code, message };
}
/** Traverse only documented response envelopes, after the ledger's size/depth validation. */
function envelopeRecords(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.flatMap(envelopeRecords);
  const item = asNullableRecord(value);
  if (!item) return [];
  return [
    item,
    ...[
      "parts",
      "data",
      "ad_accounts",
      "fields",
      "_additional_context",
    ].flatMap(key => envelopeRecords(item[key])),
  ];
}
function prerequisite(
  tool: MetaAdsMcpTool,
  args: RecordValue,
  summary: string,
  clientConversationId?: string
): MetaAdsMcpReadPrecondition {
  args = withMetaAdsMcpConversationId(
    tool,
    args,
    clientConversationId ?? createMetaAdsMcpConversationId()
  );
  if (!validateMetaAdsMcpToolArguments({ tool, arguments: args }).success)
    return blocked(
      "prerequisite_schema_changed",
      "The required Meta verification tool has changed. Refresh the integration before querying entities."
    );
  return {
    kind: "prerequisite",
    call: { name: tool.name, arguments: args, summary },
  };
}
function parseFieldReference(
  value: string,
  fallbackLevel?: string
): { name: string; level?: string } | null {
  const parts = value.split(".");
  if (parts.length === 1) return { name: value, level: fallbackLevel };
  const level = normalizeLevel(parts[0]);
  return parts.length === 2 && level && LEVELS.has(level) && parts[1]
    ? { name: parts[1], level }
    : null;
}
function fieldUses(args: RecordValue, level?: string): FieldUse[] | null {
  const query = fieldQuerySchema.safeParse(args);
  if (!query.success) return null;
  const uses: FieldUse[] = [];
  for (const name of query.data.fields ?? []) {
    if (name.includes(".")) return null;
    if (!DEFAULT_FIELDS.has(name)) uses.push({ name, level, kind: "field" });
  }
  for (const filter of query.data.filtering ?? []) {
    const reference = parseFieldReference(filter.field, level);
    if (!reference) return null;
    uses.push({ ...reference, kind: "filter", operator: filter.operator });
  }
  if (query.data.sort) {
    const match = /^(.*)_(ascending|descending)$/.exec(query.data.sort);
    const reference = match?.[1] ? parseFieldReference(match[1], level) : null;
    if (!reference) return null;
    uses.push({ ...reference, kind: "sort" });
  }
  return uses;
}

/** Shared availability gate for planned reads, proposed writes, and fresh confirmed-write checks. */
export function getMetaAdsMcpAccountEligibility(input: {
  inventory: unknown;
  accountIds: string[];
  requireQueryable?: boolean;
}): Exclude<MetaAdsMcpReadPrecondition, { kind: "prerequisite" }> {
  const ids = z
    .array(z.string().regex(/^(?:act_)?[0-9]+$/))
    .min(1)
    .max(100)
    .safeParse(input.accountIds);
  if (!ids.success)
    return blocked(
      "invalid_account_scope",
      "The ad account scope could not be verified."
    );
  let records: RecordValue[];
  try {
    records = envelopeRecords(
      normalizeMetaAdsMcpResult(input.inventory, MAX_EVIDENCE_CHARS)
    );
  } catch {
    return blocked(
      "invalid_prerequisite_evidence",
      "The account availability evidence could not be read safely. Retry the request."
    );
  }
  for (const accountId of new Set(
    ids.data.map(id => id.replace(/^act_/, ""))
  )) {
    const accounts = records.filter(item => {
      const id = item.ad_account_id ?? item.id;
      return typeof id === "string" && id.replace(/^act_/, "") === accountId;
    });
    if (!accounts.length)
      return blocked(
        "account_not_verified",
        "The selected ad account was not verified in Meta's returned account list."
      );
    if (accounts.some(item => item.is_ads_mcp_enabled === false))
      return blocked(
        "account_not_enabled",
        "Meta has not made Ads MCP available for this ad account yet. Meta is gradually rolling out access; check again later."
      );
    if (accounts.some(item => item.is_ads_mcp_enabled !== true))
      return blocked(
        "account_enablement_unknown",
        "Meta did not confirm Ads MCP availability for this ad account. Check its availability before continuing."
      );
    if (
      input.requireQueryable &&
      accounts.some(item => item.is_queryable === false)
    )
      return blocked(
        "account_not_queryable",
        "Meta has marked this ad account as unavailable for entity queries."
      );
    if (
      input.requireQueryable &&
      accounts.some(item => item.is_queryable !== true)
    )
      return blocked(
        "account_queryability_unknown",
        "Meta did not confirm that this ad account supports entity queries. Check the integration before continuing."
      );
  }
  return { kind: "ready" };
}

export function getMetaAdsMcpAccountIds(args: RecordValue): string[] | null {
  const ids: unknown[] = [];
  for (const key of ["ad_account_id", "account_id"])
    if (args[key] !== undefined) ids.push(args[key]);
  for (const key of ["ad_account_ids", "account_ids"]) {
    if (args[key] === undefined) continue;
    if (!Array.isArray(args[key]) || args[key].length === 0) return null;
    ids.push(...args[key]);
  }
  const parsed = z
    .array(z.string().regex(/^(?:act_)?[0-9]+$/))
    .max(100)
    .safeParse(ids);
  return parsed.success ? parsed.data : null;
}

/** Enforce account availability for scoped calls and the reviewed entity-query prerequisites. */
export function getMetaAdsMcpReadPrecondition(
  input: MetaAdsMcpReadPreconditionInput
): MetaAdsMcpReadPrecondition {
  if (["ads_get_ad_accounts", "ads_get_field_context"].includes(input.toolName))
    return { kind: "ready" };
  const isEntityQuery = input.toolName === "ads_get_ad_entities";
  const accountIds = getMetaAdsMcpAccountIds(input.args);
  if (!accountIds)
    return blocked(
      "invalid_account_scope",
      "The ad account scope could not be verified."
    );
  if (!isEntityQuery && !accountIds.length) return { kind: "ready" };
  const accountTool = input.tools.find(
    tool => tool.name === "ads_get_ad_accounts"
  );
  const fieldTool = input.tools.find(
    tool => tool.name === "ads_get_field_context"
  );
  if (!accountTool || (isEntityQuery && !fieldTool))
    return blocked(
      "prerequisite_tool_unavailable",
      "Meta's account or field verification tool is unavailable. Refresh the integration before querying entities."
    );
  const query = isEntityQuery ? accountQuerySchema.safeParse(input.args) : null;
  if (query && !query.success)
    return blocked(
      "invalid_entity_query",
      "The entity query does not match the documented account or level contract."
    );
  const uses =
    !query || !query.success || query.data.object_state === "draft"
      ? []
      : fieldUses(input.args, normalizeLevel(query.data.level));
  if (!uses)
    return blocked(
      "invalid_entity_query",
      "Use canonical field names and documented filter and sorting syntax."
    );
  let evidence: z.infer<typeof ledgerSchema>;
  try {
    if (input.priorResults.length > MAX_EVIDENCE_CHARS)
      throw new Error("too_large");
    evidence = ledgerSchema.parse(
      normalizeMetaAdsMcpResult(
        JSON.parse(input.priorResults),
        MAX_EVIDENCE_CHARS
      )
    );
  } catch {
    return blocked(
      "invalid_prerequisite_evidence",
      "Account and field verification evidence could not be read safely. Retry the request."
    );
  }
  const successful = evidence.results.filter(
    result =>
      result.error === undefined &&
      result.omitted !== true &&
      result.data != null
  );
  const accountResults = successful.filter(
    result => result.name === accountTool.name
  );
  if (!accountResults.length) {
    const seeded =
      input.seededAccountInventory === undefined
        ? null
        : getMetaAdsMcpAccountEligibility({
            inventory: input.seededAccountInventory,
            accountIds,
            requireQueryable: isEntityQuery,
          });
    if (seeded?.kind !== "ready")
      return prerequisite(
        accountTool,
        {},
        "Verify Ads MCP availability for the selected ad account",
        input.clientConversationId
      );
  } else {
    const eligibility = getMetaAdsMcpAccountEligibility({
      inventory: accountResults.map(result => result.data),
      accountIds,
      requireQueryable: isEntityQuery,
    });
    if (eligibility.kind === "blocked") return eligibility;
  }
  if (!uses.length) return { kind: "ready" };

  const fieldResults = successful.filter(
    result => result.name === fieldTool!.name
  );
  const metadata = fieldResults.flatMap(result => envelopeRecords(result.data));
  const unknownFields = new Set(
    metadata.flatMap(item => stringArray(item.unknown_fields) ?? [])
  );
  const fieldsByName = new Map<
    string,
    {
      definition: RecordValue;
      levels: Set<string | undefined>;
      operators: Set<string>;
    }
  >();
  const aliases = new Set<string>();
  for (const item of metadata) {
    for (const alias of stringArray(item.aliases) ?? []) aliases.add(alias);
    if (typeof item.name === "string" && !fieldsByName.has(item.name)) {
      fieldsByName.set(item.name, {
        definition: item,
        levels: new Set(stringArray(item.levels)?.map(normalizeLevel)),
        operators: new Set(stringArray(item.supported_filter_operators) ?? []),
      });
    }
  }
  let allFieldsRequested = false;
  const requestedFields = new Set<string>();
  for (const result of fieldResults) {
    const names = result.arguments?.field_names;
    if (names === undefined || (Array.isArray(names) && names.length === 0))
      allFieldsRequested = true;
    for (const name of stringArray(names) ?? []) requestedFields.add(name);
  }
  const missing = new Set<string>();
  for (const use of uses) {
    const metadataField = fieldsByName.get(use.name);
    if (!metadataField) {
      if (aliases.has(use.name))
        return blocked(
          "noncanonical_field",
          "The requested field is an alias. Use the canonical field name returned by Meta and prepare the query again."
        );
      if (unknownFields.has(use.name))
        return blocked(
          "unsupported_field",
          "Meta does not support one of the requested fields. Choose a verified canonical field."
        );
      if (allFieldsRequested || requestedFields.has(use.name))
        return blocked(
          "field_metadata_unavailable",
          "The completed field lookup did not verify a requested field. Choose a field with returned metadata."
        );
      missing.add(use.name);
      continue;
    }
    const { definition, levels, operators } = metadataField;
    if (!levels.size || (use.level && !levels.has(use.level)))
      return blocked(
        "unsupported_field_level",
        "A requested field is not verified for the requested entity level."
      );
    if (use.kind === "filter") {
      if (definition.filterable !== true)
        return blocked(
          "field_not_filterable",
          "Meta does not allow filtering by a requested field."
        );
      if (!use.operator || !operators.has(use.operator))
        return blocked(
          "unsupported_filter_operator",
          "A filter operator is not supported for its field. Use the operators returned by Meta."
        );
    }
    if (use.kind === "sort" && definition.sortable !== true)
      return blocked(
        "field_not_sortable",
        "Meta does not allow sorting by the requested field."
      );
  }
  return missing.size
    ? prerequisite(
        fieldTool!,
        { field_names: [...missing] },
        "Verify canonical fields, entity levels, filters and sorting before querying entities",
        input.clientConversationId
      )
    : { kind: "ready" };
}
