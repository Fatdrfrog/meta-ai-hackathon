import "server-only";

import { createHash } from "node:crypto";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import {
  metaAdsMcpTransactionV2Schema,
  type MetaAdsMcpTransactionV2,
} from "./confirmation-contract";

export const META_ADS_MCP_MAX_LOGICAL_ARGUMENT_BYTES = 256 * 1024;
export const META_ADS_MCP_MAX_ARGUMENT_PATHS = 2_000;

type ArgumentPath = {
  path: string;
  segments: Array<string | number>;
  value: unknown;
};

type PreparedLogicalArguments = {
  canonical: string;
  value: Record<string, unknown>;
  paths: ArgumentPath[];
};

const MONEY_TOKEN_PATTERN = /(^|_)(amount|budget|bid|cost|price|spend)(_|$)/;
const TARGETING_TOKEN_PATTERN =
  /(^|_)(targeting|audience|geo|location|country|region|city|age|gender|placement|interest|custom_audience|lookalike)(_|$)/;
const SCHEDULE_TOKEN_PATTERN =
  /(^|_)(schedule|start_time|end_time|start_date|end_date|publish_time|effective_time|expiration_time)(_|$)/;

function argumentError(message: string): Error {
  return new Error(`Invalid Meta Ads MCP logical arguments: ${message}`);
}

function canonicalArgumentPath(segments: Array<string | number>): string {
  return segments.reduce<string>((path, segment) => {
    if (typeof segment === "number") return `${path}[${segment}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      return path ? `${path}.${segment}` : segment;
    }
    return `${path}[${JSON.stringify(segment)}]`;
  }, "");
}

function collectArgumentPaths(
  value: unknown,
  segments: Array<string | number>,
  output: ArgumentPath[]
): void {
  if (output.length > META_ADS_MCP_MAX_ARGUMENT_PATHS) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      output.push({ path: canonicalArgumentPath(segments), segments, value });
      return;
    }
    value.forEach((item, index) =>
      collectArgumentPaths(item, [...segments, index], output)
    );
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
    );
    if (entries.length === 0) {
      if (segments.length > 0) {
        output.push({ path: canonicalArgumentPath(segments), segments, value });
      }
      return;
    }
    entries.forEach(([key, item]) =>
      collectArgumentPaths(item, [...segments, key], output)
    );
    return;
  }
  output.push({ path: canonicalArgumentPath(segments), segments, value });
}

function prepareLogicalArguments(
  logicalArguments: Record<string, unknown>
): PreparedLogicalArguments {
  let canonical: string;
  try {
    canonical = serializeCanonicalJson(logicalArguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : "not valid JSON";
    throw argumentError(message);
  }
  if (
    Buffer.byteLength(canonical, "utf8") >
    META_ADS_MCP_MAX_LOGICAL_ARGUMENT_BYTES
  ) {
    throw argumentError(
      `canonical JSON exceeds ${META_ADS_MCP_MAX_LOGICAL_ARGUMENT_BYTES} bytes`
    );
  }

  const value = JSON.parse(canonical) as Record<string, unknown>;
  const paths: ArgumentPath[] = [];
  collectArgumentPaths(value, [], paths);
  if (paths.length > META_ADS_MCP_MAX_ARGUMENT_PATHS) {
    throw argumentError(
      `contains more than ${META_ADS_MCP_MAX_ARGUMENT_PATHS} paths`
    );
  }
  return { canonical, value, paths };
}

function normalizedToken(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function finalStringSegment(path: ArgumentPath): string | null {
  for (let index = path.segments.length - 1; index >= 0; index -= 1) {
    const segment = path.segments[index];
    if (typeof segment === "string") return segment;
  }
  return null;
}

function pathTokens(path: ArgumentPath): string[] {
  return path.segments.flatMap(segment =>
    typeof segment === "string" ? [normalizedToken(segment)] : []
  );
}

function identifierValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizedAccountId(value: string): string {
  return value.trim().replace(/^act_/i, "");
}

function isAccountIdToken(token: string): boolean {
  return (
    token === "account" ||
    token === "accounts" ||
    token === "ad_account" ||
    token === "ad_accounts" ||
    token === "account_id" ||
    token === "account_ids" ||
    token === "accountid" ||
    token === "ad_account_id" ||
    token === "ad_account_ids" ||
    token === "adaccount_id" ||
    token === "adaccountid" ||
    token === "advertising_account_id" ||
    token === "advertising_account_ids" ||
    token === "advertising_accounts"
  );
}

function isBusinessIdToken(token: string): boolean {
  return (
    token === "business" ||
    token === "business_id" ||
    token === "business_ids" ||
    token === "businessid" ||
    token === "business_account_id" ||
    token === "business_manager_id" ||
    token === "business_manager_ids"
  );
}

function accountSemanticSegmentIndex(path: ArgumentPath): number {
  for (let index = 0; index < path.segments.length; index += 1) {
    const segment = path.segments[index];
    if (
      typeof segment === "string" &&
      isAccountIdToken(normalizedToken(segment))
    ) {
      return index;
    }
  }
  return -1;
}

function accountBindingGroupPath(
  path: ArgumentPath,
  semanticIndex: number
): string {
  let endIndex = semanticIndex + 1;
  while (
    endIndex < path.segments.length &&
    typeof path.segments[endIndex] === "number"
  ) {
    endIndex += 1;
  }
  return canonicalArgumentPath(path.segments.slice(0, endIndex));
}

function isComparableAccountIdentifierPath(
  path: ArgumentPath,
  semanticIndex: number
): boolean {
  const finalSegment = finalStringSegment(path);
  if (!finalSegment) return false;
  const finalToken = normalizedToken(finalSegment);
  return (
    isAccountIdToken(finalToken) ||
    (finalToken === "id" && semanticIndex < path.segments.length - 1)
  );
}

function validateAccountBindings(
  paths: ArgumentPath[],
  selectedAdAccountId: string
): void {
  const selectedAccountId = normalizedAccountId(selectedAdAccountId);
  const groups = new Map<
    string,
    { path: string; identifiers: Array<{ path: string; value: string }> }
  >();

  for (const path of paths) {
    const semanticIndex = accountSemanticSegmentIndex(path);
    if (semanticIndex < 0) continue;
    const groupPath = accountBindingGroupPath(path, semanticIndex);
    const group = groups.get(groupPath) || {
      path: groupPath,
      identifiers: [],
    };
    if (isComparableAccountIdentifierPath(path, semanticIndex)) {
      const identifier = identifierValue(path.value);
      if (!identifier) {
        throw argumentError(
          `${path.path} is an account identifier but cannot be safely compared with the selected ad account`
        );
      }
      group.identifiers.push({ path: path.path, value: identifier });
    }
    groups.set(groupPath, group);
  }

  for (const group of groups.values()) {
    if (group.identifiers.length === 0) {
      throw argumentError(
        `${group.path} is account-shaped but cannot be safely compared with the selected ad account`
      );
    }
    for (const identifier of group.identifiers) {
      if (normalizedAccountId(identifier.value) !== selectedAccountId) {
        throw argumentError(
          `${identifier.path} conflicts with selected ad account ${selectedAdAccountId}`
        );
      }
    }
  }
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entityTypeForToken(token: string): string {
  const withoutSuffix = token.replace(/_(id|status|action|operation)$/, "");
  return withoutSuffix || "entity";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizedCreativeAssets(
  creativeAssets: MetaAdsMcpTransactionV2["disclosure"]["creativeAssets"]
): MetaAdsMcpTransactionV2["disclosure"]["creativeAssets"] {
  const sorted = [...creativeAssets].sort((left, right) =>
    left.id !== right.id
      ? compareCanonicalStrings(left.id, right.id)
      : left.kind !== right.kind
        ? compareCanonicalStrings(left.kind, right.kind)
        : compareCanonicalStrings(left.name, right.name)
  );
  const byId = new Map<
    string,
    MetaAdsMcpTransactionV2["disclosure"]["creativeAssets"][number]
  >();
  for (const asset of sorted) {
    const existing = byId.get(asset.id);
    if (
      existing &&
      (existing.kind !== asset.kind || existing.name !== asset.name)
    ) {
      throw argumentError(`creative asset ${asset.id} has conflicting facts`);
    }
    byId.set(asset.id, { ...asset });
  }
  return Array.from(byId.values());
}

function buildDisclosure(params: {
  target: MetaAdsMcpTransactionV2["target"];
  tool: MetaAdsMcpTransactionV2["tool"];
  paths: ArgumentPath[];
  creativeAssets: MetaAdsMcpTransactionV2["disclosure"]["creativeAssets"];
}): MetaAdsMcpTransactionV2["disclosure"] {
  validateAccountBindings(params.paths, params.target.adAccountId);
  const businessIds = params.target.businessId
    ? [params.target.businessId]
    : [];
  const entities: MetaAdsMcpTransactionV2["disclosure"]["entities"] = [];
  const money: MetaAdsMcpTransactionV2["disclosure"]["money"] = [];
  const schedule: MetaAdsMcpTransactionV2["disclosure"]["schedule"] = [];
  const targeting: MetaAdsMcpTransactionV2["disclosure"]["targeting"] = [];
  const unmappedArgumentPaths: string[] = [];

  for (const path of params.paths) {
    const finalSegment = finalStringSegment(path);
    const finalToken = finalSegment ? normalizedToken(finalSegment) : "";
    const tokens = pathTokens(path);
    let mapped = false;
    const identifier = identifierValue(path.value);
    const accountSemanticIndex = accountSemanticSegmentIndex(path);

    if (
      accountSemanticIndex >= 0 &&
      isComparableAccountIdentifierPath(path, accountSemanticIndex)
    ) {
      mapped = true;
    } else if (finalToken && isBusinessIdToken(finalToken) && identifier) {
      businessIds.push(identifier);
      mapped = true;
    } else if (finalToken.endsWith("_id") && identifier) {
      entities.push({ type: entityTypeForToken(finalToken), id: identifier });
      mapped = true;
    }

    if (finalToken && /(^|_)status$/.test(finalToken) && identifier) {
      entities.push({
        type: entityTypeForToken(finalToken),
        requestedStatus: identifier,
      });
      mapped = true;
    }
    if (
      finalToken &&
      /(^|_)(action|operation)$/.test(finalToken) &&
      identifier
    ) {
      entities.push({
        type: entityTypeForToken(finalToken),
        action: identifier,
      });
      mapped = true;
    }

    if (tokens.some(token => MONEY_TOKEN_PATTERN.test(token))) {
      if (!params.target.currency.trim()) {
        throw argumentError("currency is required for monetary arguments");
      }
      money.push({
        path: path.path,
        rawValue: path.value,
        currency: params.target.currency,
        unit: "provider_raw",
      });
      mapped = true;
    }
    if (tokens.some(token => SCHEDULE_TOKEN_PATTERN.test(token))) {
      schedule.push({
        path: path.path,
        value: path.value,
        ...(params.target.timezone ? { timezone: params.target.timezone } : {}),
      });
      mapped = true;
    }
    if (tokens.some(token => TARGETING_TOKEN_PATTERN.test(token))) {
      targeting.push({ path: path.path, value: path.value });
      mapped = true;
    }

    if (!mapped) unmappedArgumentPaths.push(path.path);
  }

  const warnings =
    unmappedArgumentPaths.length > 0
      ? [
          `${unmappedArgumentPaths.length} argument path${unmappedArgumentPaths.length === 1 ? " is" : "s are"} not mapped to a specialized disclosure section; review the full arguments before confirmation.`,
        ]
      : [];

  return {
    operation: params.tool.name,
    accountIds: [params.target.adAccountId],
    businessIds: uniqueStrings(businessIds),
    entities,
    money,
    schedule,
    targeting,
    creativeAssets: normalizedCreativeAssets(params.creativeAssets),
    unmappedArgumentPaths,
    warnings,
  };
}

function withoutTransactionDigest(
  transaction: MetaAdsMcpTransactionV2
): Omit<MetaAdsMcpTransactionV2, "transactionDigest"> {
  return {
    version: transaction.version,
    id: transaction.id,
    preparedAt: transaction.preparedAt,
    target: transaction.target,
    tool: transaction.tool,
    logicalArguments: transaction.logicalArguments,
    logicalArgumentsSha256: transaction.logicalArgumentsSha256,
    disclosure: transaction.disclosure,
    summary: transaction.summary,
  };
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(serializeCanonicalJson(value), "utf8")
    .digest("hex");
}

export function prepareMetaAdsMcpTransaction(params: {
  id: string;
  preparedAt: string;
  target: MetaAdsMcpTransactionV2["target"];
  tool: MetaAdsMcpTransactionV2["tool"];
  logicalArguments: Record<string, unknown>;
  summary: string;
  creativeAssets: Array<{ id: string; kind: string; name: string }>;
}): MetaAdsMcpTransactionV2 {
  const logical = prepareLogicalArguments(params.logicalArguments);
  const logicalArgumentsSha256 = createHash("sha256")
    .update(logical.canonical, "utf8")
    .digest("hex");
  const transactionWithoutDigest: Omit<
    MetaAdsMcpTransactionV2,
    "transactionDigest"
  > = {
    version: 2,
    id: params.id,
    preparedAt: params.preparedAt,
    target: { ...params.target },
    tool: { ...params.tool },
    logicalArguments: logical.value,
    logicalArgumentsSha256,
    disclosure: buildDisclosure({
      target: params.target,
      tool: params.tool,
      paths: logical.paths,
      creativeAssets: params.creativeAssets,
    }),
    summary: params.summary,
  };
  const normalized = metaAdsMcpTransactionV2Schema.parse({
    ...transactionWithoutDigest,
    transactionDigest: "0".repeat(64),
  });
  const normalizedWithoutDigest = withoutTransactionDigest(normalized);
  return {
    ...normalizedWithoutDigest,
    transactionDigest: sha256CanonicalJson(normalizedWithoutDigest),
  };
}

function verifyMetaAdsMcpTransactionUnchecked(
  transaction: MetaAdsMcpTransactionV2
):
  | { ok: true }
  | {
      ok: false;
      code: "INVALID_ARGUMENTS" | "DIGEST_MISMATCH" | "INVALID_DISCLOSURE";
      message: string;
    } {
  const parsed = metaAdsMcpTransactionV2Schema.safeParse(transaction);
  if (!parsed.success) {
    const disclosureOnly = parsed.error.issues.every(
      issue => issue.path[0] === "disclosure"
    );
    const digestOnly = parsed.error.issues.every(
      issue => issue.path[0] === "transactionDigest"
    );
    return {
      ok: false,
      code: digestOnly
        ? "DIGEST_MISMATCH"
        : disclosureOnly
          ? "INVALID_DISCLOSURE"
          : "INVALID_ARGUMENTS",
      message: "The prepared Meta Ads transaction is not structurally valid",
    };
  }

  let logical: PreparedLogicalArguments;
  try {
    logical = prepareLogicalArguments(parsed.data.logicalArguments);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_ARGUMENTS",
      message: error instanceof Error ? error.message : "Invalid arguments",
    };
  }
  const logicalDigest = createHash("sha256")
    .update(logical.canonical, "utf8")
    .digest("hex");
  if (logicalDigest !== parsed.data.logicalArgumentsSha256) {
    return {
      ok: false,
      code: "INVALID_ARGUMENTS",
      message: "The logical arguments no longer match their digest",
    };
  }

  let expectedDisclosure: MetaAdsMcpTransactionV2["disclosure"];
  try {
    expectedDisclosure = buildDisclosure({
      target: parsed.data.target,
      tool: parsed.data.tool,
      paths: logical.paths,
      creativeAssets: parsed.data.disclosure.creativeAssets,
    });
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_ARGUMENTS",
      message: error instanceof Error ? error.message : "Invalid arguments",
    };
  }
  let disclosureMatches: boolean;
  try {
    disclosureMatches =
      serializeCanonicalJson(expectedDisclosure) ===
      serializeCanonicalJson(parsed.data.disclosure);
  } catch {
    return {
      ok: false,
      code: "INVALID_DISCLOSURE",
      message: "The transaction disclosure is not canonical JSON",
    };
  }
  if (!disclosureMatches) {
    return {
      ok: false,
      code: "INVALID_DISCLOSURE",
      message:
        "The transaction disclosure does not match its logical arguments",
    };
  }

  let expectedDigest: string;
  try {
    expectedDigest = sha256CanonicalJson(withoutTransactionDigest(parsed.data));
  } catch {
    return {
      ok: false,
      code: "INVALID_DISCLOSURE",
      message: "The prepared Meta Ads transaction is not canonical JSON",
    };
  }
  if (expectedDigest !== parsed.data.transactionDigest) {
    return {
      ok: false,
      code: "DIGEST_MISMATCH",
      message: "The prepared Meta Ads transaction digest does not match",
    };
  }
  return { ok: true };
}

export function verifyMetaAdsMcpTransaction(
  transaction: MetaAdsMcpTransactionV2
):
  | { ok: true }
  | {
      ok: false;
      code: "INVALID_ARGUMENTS" | "DIGEST_MISMATCH" | "INVALID_DISCLOSURE";
      message: string;
    } {
  try {
    return verifyMetaAdsMcpTransactionUnchecked(transaction);
  } catch {
    return {
      ok: false,
      code: "INVALID_ARGUMENTS",
      message: "The prepared Meta Ads transaction could not be verified",
    };
  }
}
