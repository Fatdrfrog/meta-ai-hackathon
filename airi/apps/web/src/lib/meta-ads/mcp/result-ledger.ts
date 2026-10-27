import "server-only";

import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

import type { MetaAdsMcpTool } from "./client";
import { sha256CanonicalJson } from "./confirmation-contract.server";
import { isMetaAdsMcpWriteTool } from "./tool-classifier";

type Arguments = Record<string, unknown>;
type Continuation = {
  name: string;
  arguments: Arguments;
  kind: "page" | "provider_read";
  step: number;
};
export type MetaAdsMcpCoverage = {
  complete: boolean;
  successfulReads: number;
  pendingPages: number;
  pendingContinuations: number;
  /** Real coverage gaps; any reason makes the report partial. */
  reasons: string[];
  /** Process events the turn recovered from; they never make a report partial. */
  recovered?: string[];
};
type Evidence = {
  name: string;
  arguments: Arguments;
  data?: unknown;
  error?: string;
  /** Untrusted provider diagnostic, never successful evidence. */
  providerError?: string;
  /** Server-owned explanation of a local verification block. */
  guidance?: string;
  omitted?: boolean;
};
const MAX_RESULT_DEPTH = 32;
const MAX_RESULT_NODES = 20_000;
const MAX_EVIDENCE_ENTRIES = 100;
const PROVIDER_JSON_FIELDS = new Set([
  "ad_entities",
  "ad_drafts",
  "ad_accounts",
  "_additional_context",
]);

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Reuse the shared bounded JSON contract before expanding Meta's JSON-string fields. */
function boundedProviderData(value: unknown, maxChars: number): unknown {
  const canonical = serializeCanonicalJson(value);
  if (canonical.length > maxChars) throw new Error("result_size_limit");
  let nodes = 0;
  const decode = (
    item: unknown,
    depth: number,
    decodeJson = false
  ): unknown => {
    nodes += 1;
    if (nodes > MAX_RESULT_NODES || depth > MAX_RESULT_DEPTH)
      throw new Error("result_size_limit");
    if (typeof item === "string") {
      const parsed = decodeJson ? parseJson(item) : item;
      return parsed === item ? item : decode(parsed, depth + 1);
    }
    if (Array.isArray(item)) return item.map(entry => decode(entry, depth + 1));
    const record = asNullableRecord(item);
    if (!record) return item;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        decode(entry, depth + 1, PROVIDER_JSON_FIELDS.has(key)),
      ])
    );
  };
  const decoded = decode(JSON.parse(canonical), 0);
  if (serializeCanonicalJson(decoded).length > maxChars)
    throw new Error("result_size_limit");
  return decoded;
}
export function normalizeMetaAdsMcpResult(
  result: unknown,
  maxChars = 160_000
): unknown {
  const bounded = boundedProviderData(result, maxChars);
  const record = asNullableRecord(bounded);
  if (!record) return bounded;
  const parts: unknown[] = [];
  if (Object.hasOwn(record, "structuredContent"))
    parts.push(record.structuredContent);
  if (Array.isArray(record.content))
    parts.push(
      ...record.content.flatMap(block => {
        const item = asNullableRecord(block);
        return item?.type === "text" && typeof item.text === "string"
          ? [boundedProviderData(parseJson(item.text), maxChars)]
          : [];
      })
    );
  if (!parts.length)
    return Array.isArray(record.content) ? { parts: [] } : record;
  const unique = [
    ...new Map(
      parts.map(part => [serializeCanonicalJson(part), part])
    ).values(),
  ];
  return unique.length === 1 ? unique[0] : { parts: unique };
}

const MAX_FALLBACK_ROWS = 20;
const MAX_FALLBACK_GROUPS = 8;
const MAX_FALLBACK_VIEWS_PER_ENTITY = 3;
const SAFE_ROW_FIELDS = {
  id: "ID",
  ad_account_id: "Account",
  status: "Status",
  effective_status: "Effective status",
  currency: "Currency",
  date_start: "From",
  date_stop: "To",
  spend: "Spend",
  amount_spent: "Amount spent",
  impressions: "Impressions",
  reach: "Reach",
  clicks: "Clicks",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
} as const;

function plainLabel(value: unknown, max = 160): string {
  if (
    typeof value !== "string" &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    return "";
  return String(value)
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, "link omitted")
    .replace(/[\u0000-\u001f\u007f\[\]<>`*_~|!#@\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Read only known data envelopes; schema metadata and arbitrary nested objects are not report rows. */
function fallbackRows(value: unknown): Arguments[] {
  if (Array.isArray(value))
    return value.flatMap(item =>
      asNullableRecord(item) ? [item as Arguments] : []
    );
  const data = asNullableRecord(value);
  if (!data) return [];
  return [
    data.ad_entities,
    data.ad_accounts,
    data.data,
    ...(Array.isArray(data.parts) ? data.parts : []),
  ].flatMap(fallbackRows);
}

function fallbackHeading(evidence: Evidence): string | null {
  if (evidence.name === "ads_get_ad_accounts") return "Ad accounts";
  if (evidence.name === "ads_get_ad_entities") {
    const labels: Record<string, string> = {
      campaign: "Campaigns",
      adset: "Ad sets",
      ad: "Ads",
      ad_account: "Ad accounts",
      account: "Ad accounts",
    };
    return labels[String(evidence.arguments.level)] ?? "Ad entities";
  }
  return evidence.name.startsWith("ads_insights_") ? "Insights" : null;
}

function fallbackScope(args: Arguments): string {
  const parts: string[] = [];
  const account = plainLabel(args.ad_account_id, 80);
  if (account) parts.push(`Account: ${account}`);
  const range = asNullableRecord(parseJson(args.time_range));
  const since = plainLabel(range?.since, 40);
  const until = plainLabel(range?.until, 40);
  if (since && until) parts.push(`Dates: ${since} to ${until}`);
  else if (plainLabel(args.date_preset, 40))
    parts.push(`Period: ${plainLabel(args.date_preset, 40)}`);
  for (const key of ["status", "effective_status"] as const) {
    const status = plainLabel(args[key], 64);
    if (status) parts.push(`${SAFE_ROW_FIELDS[key]} filter: ${status}`);
  }
  return parts.join("; ");
}

function fallbackRow(row: Arguments): string | null {
  const name = plainLabel(
    row.name ??
      row.campaign_name ??
      row.adset_name ??
      row.ad_name ??
      row.ad_account_name ??
      row.id ??
      row.ad_account_id ??
      row.date_start
  );
  if (!name) return null;
  const facts = Object.entries(SAFE_ROW_FIELDS).flatMap(([key, label]) => {
    const value = plainLabel(row[key], 64);
    return value ? [`${label}: ${value}`] : [];
  });
  return `- ${name}${facts.length ? ` — ${facts.join("; ")}` : ""}`;
}

function fallbackIdentity(
  row: Arguments,
  evidence: Evidence,
  line: string
): string {
  // Insight rows may share an entity ID but have different dates or breakdowns.
  // Only entity lists have an ID that identifies the entire returned record.
  if (
    evidence.name !== "ads_get_ad_accounts" &&
    evidence.name !== "ads_get_ad_entities"
  )
    return line;
  const level =
    evidence.name === "ads_get_ad_accounts"
      ? "ad_account"
      : evidence.arguments.level === "account"
        ? "ad_account"
        : evidence.arguments.level;
  const id = [
    row.id,
    typeof level === "string" ? row[`${level}_id`] : null,
  ].find(
    value =>
      (typeof value === "string" && value.trim().length > 0) ||
      (typeof value === "number" && Number.isFinite(value))
  );
  return id === undefined ? line : sha256CanonicalJson({ id: String(id) });
}

/** Existing Graph sanitization is envelope-specific and does not scrub MCP error text. */
export function providerErrorDiagnostic(result: unknown): string | undefined {
  try {
    const bounded = normalizeMetaAdsMcpResult(result, 16_000);
    const scrub = (value: unknown): unknown => {
      if (typeof value === "string")
        return value
          .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
          .replace(
            /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
            "[redacted-authorization]"
          )
          .replace(
            /\b(?:[a-z_-]*token|authorization|api[_-]?key|client[_-]?(?:secret|key)|password|secret|credentials?)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
            "credential=[redacted]"
          );
      if (Array.isArray(value)) return value.map(scrub);
      const item = asNullableRecord(value);
      if (!item) return value;
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [
          key,
          /token|authorization|api.?key|secret|password|credential/i.test(key)
            ? "[redacted]"
            : scrub(entry),
        ])
      );
    };
    const redacted = scrub(bounded);
    const text =
      typeof redacted === "string" ? redacted : JSON.stringify(redacted);
    return text?.slice(0, 3_000) || undefined;
  } catch {
    return undefined;
  }
}

/** Only provider response envelopes carry continuation metadata; campaign records are ordinary data. */
function providerEnvelopes(value: unknown): Arguments[] {
  const record = asNullableRecord(value);
  if (!record) return [];
  const children = [
    record.ad_entities,
    record.ad_accounts,
    record.data,
    record._additional_context,
  ];
  if (Array.isArray(record.parts)) children.push(...record.parts);
  return [record, ...children.flatMap(providerEnvelopes)];
}

function queryArguments(args: Arguments): Arguments {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key]) => !["client_conversation_id", "advertiser_request"].includes(key)
    )
  );
}

function fingerprint(name: string, args: Arguments): string {
  return sha256CanonicalJson({ name, arguments: queryArguments(args) });
}

function matches(expected: Arguments, actual: Arguments): boolean {
  return Object.entries(queryArguments(expected)).every(
    ([key, value]) =>
      key in actual &&
      sha256CanonicalJson(value) === sha256CanonicalJson(actual[key])
  );
}

/** Bounded, lossless evidence. Oversize or unfinished data is explicit, never a sliced JSON document. */
export class MetaAdsMcpResultLedger {
  private readonly results: Evidence[] = [];
  private readonly calls = new Set<string>();
  private readonly successfulCalls = new Set<string>();
  /** Failed calls that still leave a coverage gap, by call fingerprint. */
  private readonly openErrors = new Map<string, string>();
  private readonly reasons = new Set<string>();
  private readonly recovered = new Set<string>();
  private pending: Continuation[] = [];
  private retainedChars = 0;
  private successfulReads = 0;
  private readonly tools: Map<string, MetaAdsMcpTool>;

  constructor(
    tools: MetaAdsMcpTool[],
    private readonly maxChars = 160_000
  ) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
  }

  hasCall(name: string, args: Arguments): boolean {
    return this.calls.has(fingerprint(name, args));
  }

  hasSuccessfulCall(name: string, args: Arguments): boolean {
    return this.successfulCalls.has(fingerprint(name, args));
  }

  hasIncompleteReason(reason: string): boolean {
    return this.reasons.has(reason);
  }

  markIncomplete(reason: string) {
    this.reasons.add(reason);
  }

  /** A process event the turn handled without losing requested coverage. */
  noteRecovered(event: string) {
    this.recovered.add(event);
  }

  /** Code of the most recent failure that still leaves a coverage gap. */
  lastOpenErrorCode(): string | undefined {
    let code: string | undefined;
    for (const value of this.openErrors.values()) code = value;
    return code;
  }

  /**
   * A later read replaced these failed calls (for example a corrected
   * schema or precondition error). Pass only the keys of the failures that
   * read corrects: other open failures stay coverage gaps. The resolved
   * failures stay in the evidence so they are never repeated, but they no
   * longer make the report partial.
   */
  resolveErrors(keys: string[]) {
    for (const key of keys) {
      const code = this.openErrors.get(key);
      if (code === undefined) continue;
      this.openErrors.delete(key);
      this.recovered.add(code);
    }
    if (!this.openErrors.size) this.reasons.delete("tool_error");
  }

  /** Records a failed call and returns its key for {@link resolveErrors}. */
  error(
    name: string,
    args: Arguments,
    code: string,
    providerResult?: unknown,
    guidance?: string
  ): string {
    const key = fingerprint(name, args);
    this.calls.add(key);
    // Re-insert so iteration order follows recency (see lastOpenErrorCode).
    this.openErrors.delete(key);
    this.openErrors.set(key, code);
    const providerError =
      providerResult === undefined
        ? undefined
        : providerErrorDiagnostic(providerResult);
    this.retain({
      name,
      arguments: queryArguments(args),
      error: code,
      ...(guidance ? { guidance: guidance.slice(0, 500) } : {}),
      ...(providerError ? { providerError } : {}),
    });
    this.markIncomplete("tool_error");
    return key;
  }

  record(params: { name: string; arguments: Arguments; result: unknown }) {
    const { name, arguments: args } = params;
    this.calls.add(fingerprint(name, args));
    this.successfulCalls.add(fingerprint(name, args));
    this.successfulReads += 1;
    let data: unknown;
    try {
      data = normalizeMetaAdsMcpResult(params.result, this.maxChars);
    } catch {
      this.retain({ name, arguments: {}, omitted: true });
      this.markIncomplete("result_size_limit");
      return;
    }
    const evidence = { name, arguments: queryArguments(args), data };
    if (!this.retain(evidence)) return;
    if (
      data == null ||
      (Array.isArray(asNullableRecord(data)?.parts) &&
        (asNullableRecord(data)!.parts as unknown[]).length === 0)
    ) {
      this.markIncomplete("empty_result");
      return;
    }
    // A page must preserve the original query exactly. Extra filters cannot satisfy its coverage.
    this.pending = this.pending.filter(
      item =>
        !(
          item.name === name &&
          (item.kind === "page"
            ? fingerprint(name, item.arguments) === fingerprint(name, args)
            : matches(item.arguments, args))
        )
    );
    for (const record of providerEnvelopes(data))
      this.readContinuations(record, name, args);
    this.pending.sort((a, b) => a.step - b.step);
  }

  private retain(evidence: Evidence): boolean {
    const chars = JSON.stringify(evidence).length;
    if (
      this.results.length >= MAX_EVIDENCE_ENTRIES ||
      this.retainedChars + chars > this.maxChars
    ) {
      if (this.results.length < MAX_EVIDENCE_ENTRIES)
        this.results.push({
          name: evidence.name,
          arguments: {},
          omitted: true,
        });
      this.markIncomplete("result_size_limit");
      return false;
    }
    this.results.push(evidence);
    this.retainedChars += chars;
    return true;
  }

  private readContinuations(record: Arguments, name: string, args: Arguments) {
    const pagination = asNullableRecord(record.pagination);
    const paging = asNullableRecord(record.paging);
    const cursor =
      record.next_cursor ??
      pagination?.next_cursor ??
      (paging?.next ? asNullableRecord(paging.cursors)?.after : null);
    if (typeof cursor === "string" && cursor) {
      const properties = asNullableRecord(
        this.tools.get(name)?.inputSchema.properties
      );
      if (!properties?.cursor) this.markIncomplete("unsupported_pagination");
      else
        this.enqueue({
          name,
          arguments: { ...args, cursor },
          kind: "page",
          step: 0,
        });
    } else if (
      paging?.next ||
      record.has_more === true ||
      pagination?.has_more === true
    ) {
      this.markIncomplete("unsupported_pagination");
    }
    const actions = asNullableRecord(record.next_actions)?.actions;
    if (!Array.isArray(actions)) return;
    for (const value of actions) {
      const action = asNullableRecord(value);
      if (
        !action ||
        action.read_only !== true ||
        action.requires_user_confirmation === true
      )
        continue;
      let nextArgs: Arguments | null;
      try {
        nextArgs = asNullableRecord(
          boundedProviderData(parseJson(action.suggested_args), this.maxChars)
        );
      } catch {
        this.markIncomplete("untrusted_continuation");
        continue;
      }
      if (
        typeof action.tool !== "string" ||
        !this.tools.has(action.tool) ||
        isMetaAdsMcpWriteTool(action.tool) ||
        !nextArgs
      ) {
        this.markIncomplete("untrusted_continuation");
        continue;
      }
      // Provider suggestions are planning data. They never execute without the planner's validated decision.
      this.enqueue({
        name: action.tool,
        arguments: nextArgs,
        kind: "provider_read",
        step: typeof action.step === "number" ? action.step : 0,
      });
    }
  }

  private enqueue(item: Continuation) {
    if (this.hasCall(item.name, item.arguments)) {
      if (item.kind === "page") this.markIncomplete("pagination_loop");
      return;
    }
    const key = fingerprint(item.name, item.arguments);
    if (
      this.pending.length >= MAX_EVIDENCE_ENTRIES ||
      this.retainedChars + JSON.stringify([...this.pending, item]).length >
        this.maxChars
    ) {
      this.markIncomplete("result_size_limit");
      return;
    }
    if (
      !this.pending.some(
        existing => fingerprint(existing.name, existing.arguments) === key
      )
    )
      this.pending.push(item);
  }

  nextPage(): { name: string; arguments: Arguments; summary: string } | null {
    const page = this.pending.find(item => item.kind === "page");
    return page
      ? {
          name: page.name,
          arguments: page.arguments,
          summary: "Read the next page of the same query",
        }
      : null;
  }

  coverage(): MetaAdsMcpCoverage {
    return {
      complete:
        this.successfulReads > 0 &&
        this.reasons.size === 0 &&
        this.pending.length === 0,
      successfulReads: this.successfulReads,
      pendingPages: this.pending.filter(item => item.kind === "page").length,
      pendingContinuations: this.pending.filter(
        item => item.kind === "provider_read"
      ).length,
      reasons: [...this.reasons],
      ...(this.recovered.size ? { recovered: [...this.recovered] } : {}),
    };
  }

  toPrompt(): string {
    let prompt = JSON.stringify({
      coverage: this.coverage(),
      results: this.results,
      pendingContinuations: this.pending,
    });
    if (prompt.length > this.maxChars) {
      this.markIncomplete("result_size_limit");
      // Drop whole records from this projection, never slice JSON or claim omitted evidence is complete.
      const results = [...this.results];
      do {
        results.pop();
        prompt = JSON.stringify({
          coverage: this.coverage(),
          results,
          pendingContinuations: [],
        });
      } while (results.length && prompt.length > this.maxChars);
    }
    return prompt;
  }

  fallbackSummary(): string {
    const groups = new Map<
      string,
      { heading: string; scope: string; rows: Map<string, Set<string>> }
    >();
    for (const result of this.results) {
      if (result.error || result.omitted) continue;
      const heading = fallbackHeading(result);
      if (!heading) continue;
      const args = Object.fromEntries(
        Object.entries(result.arguments).filter(([key]) => key !== "cursor")
      );
      const key = fingerprint(result.name, args);
      const group = groups.get(key) ?? {
        heading,
        scope: fallbackScope(args),
        rows: new Map<string, Set<string>>(),
      };
      for (const row of fallbackRows(result.data)) {
        const line = fallbackRow(row);
        if (!line) continue;
        const identity = fallbackIdentity(row, result, line);
        const views = group.rows.get(identity) ?? new Set<string>();
        views.add(line);
        group.rows.set(identity, views);
      }
      if (group.rows.size) groups.set(key, group);
    }
    if (!groups.size)
      return this.successfulReads
        ? `The report could not finish. Meta returned ${this.successfulReads} successful read result${this.successfulReads === 1 ? "" : "s"}. Please retry the report.`
        : "I could not retrieve a verified Meta Ads result. Please retry.";
    const sections = [
      "The report could not finish. Here is the verified data retrieved so far:",
    ];
    let remainingRows = MAX_FALLBACK_ROWS;
    for (const group of [...groups.values()].slice(0, MAX_FALLBACK_GROUPS)) {
      const rows: string[] = [];
      let shownEntities = 0;
      for (const views of group.rows.values()) {
        if (!remainingRows) break;
        const shownViews = [...views].slice(
          0,
          Math.min(MAX_FALLBACK_VIEWS_PER_ENTITY, remainingRows)
        );
        rows.push(
          shownViews
            .map((line, index) =>
              index === 0
                ? line
                : `  Additional returned view: ${line.slice(2)}`
            )
            .join("\n")
        );
        if (shownViews.length < views.size)
          rows.push("  Additional returned views are not shown.");
        remainingRows -= shownViews.length;
        shownEntities += 1;
      }
      sections.push(
        `${group.heading}: ${group.rows.size} retrieved${group.scope ? `\n${group.scope}` : ""}\n${rows.join("\n")}${shownEntities < group.rows.size ? `\nShowing ${shownEntities} of ${group.rows.size} retrieved rows.` : ""}`
      );
    }
    if (groups.size > MAX_FALLBACK_GROUPS)
      sections.push("Additional retrieved result groups are not shown.");
    return sections.join("\n\n");
  }
}
