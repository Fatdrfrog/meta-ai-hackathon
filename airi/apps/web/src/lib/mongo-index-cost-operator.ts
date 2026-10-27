type IndexKey = Readonly<Record<string, 1 | -1>>;
type CandidateOptions = Readonly<{
  sparse?: true;
  partialFilterExpression?: Readonly<Record<string, unknown>>;
}>;
type PrefixCandidate = Readonly<{
  collection: string;
  index: string;
  key: IndexKey;
  replacement: string;
  replacementKey: IndexKey;
}>;
type UnusedCandidate = Readonly<{
  collection: string;
  index: string;
  key: IndexKey;
  options?: CandidateOptions;
  replacement: null;
  /** Code review result; zero `$indexStats` ops alone is not enough. */
  evidence: string;
}>;
type Candidate = PrefixCandidate | UnusedCandidate;

const PREFIX_OBSERVATION_MS = 24 * 60 * 60 * 1000;
const NEVER_WRITTEN =
  "followUpAudience is never written or filtered by production code.";
// No index takes over an unused candidate's work, so cover weekly jobs too.
const UNUSED_OBSERVATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Vetted candidates only. This is not an automatic unused-index detector.
 * Prefix candidates have a visible ordinary replacement. Unused candidates had
 * zero primary `$indexStats` ops from 2026-10-07 to 2026-10-15 and no query
 * that needs them (docs/operations/2026-10-15-mongo-index-retirement.md).
 * The `conversations` candidates had at most 5 ops from 2026-10-07 to
 * 2026-10-20, and every query on their fields is served by a kept index.
 */
export const MONGO_INDEX_COST_CANDIDATES: readonly Candidate[] = [
  {
    collection: "messages",
    index: "workspaceId_1_text_1",
    key: { workspaceId: 1, text: 1 },
    replacement: "workspaceId_1_text_1_conversation_1",
    replacementKey: { workspaceId: 1, text: 1, conversation: 1 },
  },
  {
    collection: "messages",
    index: "conversation_1_date_1",
    key: { conversation: 1, date: 1 },
    replacement: "conversation_1_date_1__id_1",
    replacementKey: { conversation: 1, date: 1, _id: 1 },
  },
  {
    collection: "messages",
    index: "conversation_1",
    key: { conversation: 1 },
    replacement: "conversation_1_date_1__id_1",
    replacementKey: { conversation: 1, date: 1, _id: 1 },
  },
  {
    collection: "messages",
    index: "workspaceId_1",
    key: { workspaceId: 1 },
    replacement: "workspaceId_1__id_1",
    replacementKey: { workspaceId: 1, _id: 1 },
  },
  {
    collection: "messages",
    index: "direction_1",
    key: { direction: 1 },
    replacement: "direction_1_date_-1",
    replacementKey: { direction: 1, date: -1 },
  },
  {
    collection: "conversations",
    index: "workspaceId_1",
    key: { workspaceId: 1 },
    replacement: "workspaceId_1__id_1",
    replacementKey: { workspaceId: 1, _id: 1 },
  },
  {
    collection: "whatsappwebhookevents",
    index: "phoneNumberId_1",
    key: { phoneNumberId: 1 },
    replacement: "phoneNumberId_1_field_1_createdAt_-1",
    replacementKey: { phoneNumberId: 1, field: 1, createdAt: -1 },
  },
  {
    collection: "whatsappwebhookevents",
    index: "wabaId_1",
    key: { wabaId: 1 },
    replacement: "wabaId_1_field_1_createdAt_-1",
    replacementKey: { wabaId: 1, field: 1, createdAt: -1 },
  },
  {
    collection: "messages",
    index: "workspaceId_1_text_1_conversation_1",
    key: { workspaceId: 1, text: 1, conversation: 1 },
    replacement: null,
    evidence:
      "Case-insensitive Requests regex fallback gets no index bounds; Instagram echo equality uses the conversation/channel/direction/date index.",
  },
  {
    collection: "messages",
    index: "workspaceId_1_channel_1_date_-1_conversation_1",
    key: { workspaceId: 1, channel: 1, date: -1, conversation: 1 },
    replacement: null,
    evidence:
      "Dashboard activity reads use workspaceId_1_channel_1_date_-1, which keeps the same equality and sort.",
  },
  {
    collection: "messages",
    index: "workspaceId_1_date_-1_conversation_1",
    key: { workspaceId: 1, date: -1, conversation: 1 },
    replacement: null,
    evidence:
      "Workspace date ranges use workspaceId_1_date_1 or the channel-specific date index.",
  },
  {
    collection: "messages",
    index: "channel_1",
    key: { channel: 1 },
    replacement: null,
    evidence:
      "Channel lookups also filter messageId and use channel_1_messageId_1.",
  },
  {
    collection: "messages",
    index: "workspaceId_1_channel_1_whatsappGroup.groupId_1_date_-1",
    key: { workspaceId: 1, channel: 1, "whatsappGroup.groupId": 1, date: -1 },
    replacement: null,
    evidence: "No message query filters by WhatsApp group id.",
  },
  {
    collection: "messages",
    index: "messages_raw_provider_payload_type_created_at_desc",
    key: {
      "rawSourcePayload.provider": 1,
      "rawSourcePayload.payload.type": 1,
      createdAt: -1,
    },
    replacement: null,
    evidence:
      "Diagnostics only; the event-type sibling keeps the provider prefix.",
  },
  {
    collection: "messages",
    index: "workspaceId_1_mediaAnalysis.workflowId_1",
    key: { workspaceId: 1, "mediaAnalysis.workflowId": 1 },
    replacement: null,
    evidence:
      "The workflow id is written or matched beside _id, never used as a lookup key.",
  },
  {
    collection: "messages",
    index: "external_ids.messageId_1",
    key: { "external_ids.messageId": 1 },
    replacement: null,
    evidence:
      "Email and campaign lookups include workspaceId and use workspaceId_1_external_ids.messageId_1.",
  },
  {
    collection: "messages",
    index: "tenantId_1",
    key: { tenantId: 1 },
    replacement: null,
    evidence: "Legacy field; not in the schema or any query.",
  },
  {
    collection: "messages",
    index: "recipient_type_1",
    key: { recipient_type: 1 },
    replacement: null,
    evidence: "Legacy field; only present inside Meta payloads.",
  },
  {
    collection: "whatsappwebhookevents",
    index: "orderingKey_1_createdAt_1",
    key: { orderingKey: 1, createdAt: 1 },
    replacement: null,
    evidence: "orderingKey is written and projected, never filtered.",
  },
  {
    collection: "whatsappwebhookevents",
    index: "messagingAccountId_1_field_1_createdAt_-1",
    key: { messagingAccountId: 1, field: 1, createdAt: -1 },
    replacement: null,
    evidence:
      "Replay filters phone number or WABA ids; messagingAccountId_1 stays.",
  },
  {
    collection: "whatsappwebhookevents",
    index: "provider_1",
    key: { provider: 1 },
    replacement: null,
    evidence: "Every receipt has provider whatsapp; no query filters it.",
  },
  {
    collection: "whatsappwebhookevents",
    index: "object_1",
    key: { object: 1 },
    replacement: null,
    evidence: "No query filters the webhook object field.",
  },
  ...(
    [
      ["evaluationId_1", { evaluationId: 1 }],
      ["workspaceId_1_evaluationId_1", { workspaceId: 1, evaluationId: 1 }],
      ["scenarioId_1", { scenarioId: 1 }],
      ["winnerScenarioId_1", { winnerScenarioId: 1 }],
      ["shadowedByScenarioId_1", { shadowedByScenarioId: 1 }],
      ["triggerType_1", { triggerType: 1 }],
      ["eventKind_1", { eventKind: 1 }],
      ["matched_1", { matched: 1 }],
    ] as const
  ).map(
    ([index, key]): UnusedCandidate => ({
      collection: "scenariotriggerlogs",
      index,
      key,
      replacement: null,
      evidence:
        "Trigger-log reads filter workspaceId and evaluatedAt; nothing reads by this field alone.",
    })
  ),
  {
    collection: "scenariotriggerlogs",
    index: "scenario_trigger_logs_workspace_evaluation_id",
    key: { workspaceId: 1, evaluationId: 1 },
    options: { partialFilterExpression: { evaluationId: { $type: "string" } } },
    replacement: null,
    evidence: "No trigger-log read filters evaluationId.",
  },
  ...(
    [
      [
        "workspaceId_1_rename_1",
        { workspaceId: 1, rename: 1 },
        "The only rename filter is an unanchored case-insensitive regex beside an unindexed field; a regex never satisfies the partial filter.",
        { partialFilterExpression: { rename: { $type: "string" } } },
      ],
      [
        "workspaceId_1_channel_1_subject_1_createdAt_-1",
        { workspaceId: 1, channel: 1, subject: 1, createdAt: -1 },
        "Email threading also bounds channel and a 30-day createdAt range, which workspaceId_1_channel_1_createdAt_-1 serves.",
      ],
      [
        "workspaceId_1_engagement_metrics.score_-1_lastMessageAt_-1",
        { workspaceId: 1, "engagement_metrics.score": -1, lastMessageAt: -1 },
        "Every engagement score filter also has channel, and no query sorts by score.",
      ],
      [
        "workspaceId_1_channel_1_engagement_metrics.score_-1_lastMessageAt_-1",
        {
          workspaceId: 1,
          channel: 1,
          "engagement_metrics.score": -1,
          lastMessageAt: -1,
        },
        "Bulk analytics sorts on a computed field; the channel lastMessageAt and createdAt indexes bound its date window.",
      ],
      [
        "workspaceId_1_channel_1_classification.category_1_whatsapp_opt_in.status_1_lastMessageAt_-1",
        {
          workspaceId: 1,
          channel: 1,
          "classification.category": 1,
          "whatsapp_opt_in.status": 1,
          lastMessageAt: -1,
        },
        "Category audiences use workspaceId_1_classification.category_1; the audience-preview route that needs the full key has had no caller since 2026-07-28.",
      ],
      [
        "workspaceId_1_channel_1_whatsapp_opt_in.status_1",
        { workspaceId: 1, channel: 1, "whatsapp_opt_in.status": 1 },
        "Only the audience-preview marketing count filters opt-in status; the audience-preview route that needs the full key has had no caller since 2026-07-28.",
      ],
      [
        "workspaceId_1_channel_1_internal_labels_1_lastMessageAt_-1",
        { workspaceId: 1, channel: 1, internal_labels: 1, lastMessageAt: -1 },
        "Label audiences use workspaceId_1_internal_labels_1; the audience-preview route that needs the full key has had no caller since 2026-07-28.",
      ],
      [
        "workspaceId_1_channel_1_page_url_1",
        { workspaceId: 1, channel: 1, page_url: 1 },
        "Widget lookups use the visitor/page_url/status index; widget analytics bound createdAt.",
      ],
      [
        "workspaceId_1_channel_1_visitor_id_1",
        { workspaceId: 1, channel: 1, visitor_id: 1 },
        "workspaceId_1_visitor_id_1_channel_1_lastMessageAt_-1 has the same equality fields and the history sort.",
      ],
      [
        "workspaceId_1_channel_1_last_outbound_at_-1",
        { workspaceId: 1, channel: 1, last_outbound_at: -1 },
        "No query filters or sorts by last_outbound_at; it is only projected.",
      ],
      [
        "customerId_1",
        { customerId: 1 },
        "Every customerId query also filters workspaceId and uses workspaceId_1_customerId_1_lastMessageAt_-1.",
      ],
      [
        "sourceId_1",
        { sourceId: 1 },
        "Every sourceId query also filters workspaceId; the source chat and user lookup indexes cover it.",
      ],
      [
        "workspaceId_1_churn_risk_level_1_lastMessageAt_-1",
        { workspaceId: 1, churn_risk_level: 1, lastMessageAt: -1 },
        "churn_risk_level is only projected; Requests filters churn risk on its projection collection.",
      ],
      [
        "workspaceId_1_whatsappReferral.ctwaClid_1",
        { workspaceId: 1, "whatsappReferral.ctwaClid": 1 },
        "No query filters by ctwaClid; it is only selected.",
        {
          partialFilterExpression: {
            "whatsappReferral.ctwaClid": { $type: "string" },
          },
        },
      ],
      [
        "conversations_workspace_first_response_manager_first_inbound",
        { workspaceId: 1, first_response_manager_id: 1, first_inbound_at: 1 },
        "Its only reader hints conversations_workspace_first_inbound_first_response.",
      ],
      [
        "workspaceId_1_chat_1_lastMessageAt_-1",
        { workspaceId: 1, chat: 1, lastMessageAt: -1 },
        "No chat lookup has a sort this index provides; workspaceId_1_chat_1_createdAt_-1 serves them.",
      ],
      [
        "workspaceId_1_external_thread.provider_1",
        { workspaceId: 1, "external_thread.provider": 1 },
        "Instagram comment lookups also filter channel, which gives the same bounds.",
      ],
      [
        "workspaceId_1_handled_by_agent_id_1",
        { workspaceId: 1, handled_by_agent_id: 1 },
        "Agent performance matches every agent with $in in a bounded createdAt range, which workspaceId_1_createdAt_-1 serves.",
      ],
      [
        "workspaceId_1_followUpAudience.analyzedAt_-1_lastMessageAt_-1",
        {
          workspaceId: 1,
          "followUpAudience.analyzedAt": -1,
          lastMessageAt: -1,
        },
        NEVER_WRITTEN,
      ],
      [
        "workspaceId_1_followUpAudience.effectiveCategoryKey_1",
        { workspaceId: 1, "followUpAudience.effectiveCategoryKey": 1 },
        NEVER_WRITTEN,
      ],
      [
        "workspaceId_1_channel_1_followUpAudience.status_1",
        { workspaceId: 1, channel: 1, "followUpAudience.status": 1 },
        NEVER_WRITTEN,
      ],
    ] as const
  ).map(
    ([index, key, evidence, options]: readonly [
      string,
      IndexKey,
      string,
      CandidateOptions?,
    ]): UnusedCandidate => ({
      collection: "conversations",
      index,
      key,
      ...(options ? { options } : {}),
      replacement: null,
      evidence,
    })
  ),
];

function minimumObservationMs(candidate: Candidate): number {
  return candidate.replacement === null
    ? UNUSED_OBSERVATION_MS
    : PREFIX_OBSERVATION_MS;
}

/** Ambiguous application references protect every matching collection-qualified candidate. */
export function findProtectedMongoIndexCandidates(
  sources: readonly string[]
): string[] {
  return MONGO_INDEX_COST_CANDIDATES.filter(candidate =>
    sources.some(source => {
      if (
        ['"', "'", "`"].some(quote =>
          source.includes(`${quote}${candidate.index}${quote}`)
        )
      )
        return true;
      for (const hint of source.matchAll(
        /(?:\.hint\s*\(\s*|\bhint\s*:\s*)\{([^{}]*)\}/g
      )) {
        const entries: [string, number][] = [];
        for (const field of hint[1].split(",")) {
          if (!field.trim()) continue;
          const parsed = field.match(/^\s*["']?([\w.]+)["']?\s*:\s*(-?1)\s*$/);
          if (!parsed) break;
          entries.push([parsed[1], Number(parsed[2])]);
        }
        if (
          JSON.stringify(entries) ===
          JSON.stringify(Object.entries(candidate.key))
        )
          return true;
      }
      return false;
    })
  ).map(candidate => `${candidate.collection}.${candidate.index}`);
}
export type MongoIndexMetadata = {
  name: string;
  key: Record<string, unknown>;
  hidden?: boolean;
  [option: string]: unknown;
};
export type MongoIndexUsage = {
  name: string;
  host?: string;
  accesses?: { ops?: unknown; since?: unknown };
};
export type MongoIndexCostAdapter = {
  readIndexes(collection: string): Promise<MongoIndexMetadata[]>;
  readIndexSizes(collection: string): Promise<Record<string, number>>;
  readUsage(collection: string): Promise<MongoIndexUsage[]>;
  setHidden(collection: string, index: string, hidden: boolean): Promise<void>;
  dropIndex(collection: string, index: string): Promise<void>;
};
export type MongoIndexCostOperatorArgs = {
  operation: "report" | "hide" | "unhide" | "drop";
  apply: boolean;
  collection?: string;
  index?: string;
  observedSince?: string;
};

function fail(reason: string): never {
  throw new Error(reason);
}

export function parseMongoIndexCostOperatorArgs(
  argv: string[]
): MongoIndexCostOperatorArgs {
  const flags = new Map<string, string | boolean>();
  for (const arg of argv) {
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg : arg.slice(0, equals);
    const value = equals < 0 ? true : arg.slice(equals + 1);
    if (
      flags.has(key) ||
      ![
        "--operation",
        "--collection",
        "--index",
        "--observed-since",
        "--apply",
        "--dry-run",
      ].includes(key) ||
      (["--apply", "--dry-run"].includes(key)
        ? value !== true
        : typeof value !== "string" || !value)
    )
      fail("invalid_arguments");
    flags.set(key, value);
  }
  const operation = flags.get("--operation") ?? "report";
  if (!["report", "hide", "unhide", "drop"].includes(String(operation)))
    fail("invalid_arguments");
  const apply = flags.get("--apply") === true;
  if (apply && flags.has("--dry-run")) fail("invalid_arguments");
  const collection = flags.get("--collection") as string | undefined;
  const index = flags.get("--index") as string | undefined;
  const observedSince = flags.get("--observed-since") as string | undefined;
  if (operation === "report") {
    if (apply || collection || index || observedSince)
      fail("invalid_arguments");
  } else if (
    !MONGO_INDEX_COST_CANDIDATES.some(
      candidate =>
        candidate.collection === collection && candidate.index === index
    )
  ) {
    fail("invalid_arguments");
  }
  if (observedSince && operation !== "drop") fail("invalid_arguments");
  return {
    operation: operation as MongoIndexCostOperatorArgs["operation"],
    apply,
    collection,
    index,
    observedSince,
  };
}

function exactIndex(
  actual: MongoIndexMetadata | undefined,
  expectedKey: Readonly<Record<string, number>>,
  expectedOptions: CandidateOptions = {}
): boolean {
  if (!actual || JSON.stringify(actual.key) !== JSON.stringify(expectedKey))
    return false;
  if (
    Object.entries(expectedOptions).some(
      ([option, value]) =>
        JSON.stringify(actual[option]) !== JSON.stringify(value)
    )
  )
    return false;
  // Reject options whose constraints, coverage, or lifecycle could differ.
  return Object.entries(actual).every(([option, value]) => {
    if (
      ["name", "key", "v", "ns", "background", "hidden"].includes(option) ||
      option in expectedOptions
    )
      return true;
    return ["unique", "sparse"].includes(option) && value === false;
  });
}

function candidateOptions(candidate: Candidate): CandidateOptions {
  return candidate.replacement === null ? (candidate.options ?? {}) : {};
}

function blockedReason(
  candidate: Candidate,
  indexes: MongoIndexMetadata[],
  hintedIndexes: readonly string[],
  operation: MongoIndexCostOperatorArgs["operation"]
): string | null {
  const index = indexes.find(item => item.name === candidate.index);
  if (!index) return "candidate_absent";
  if (!exactIndex(index, candidate.key, candidateOptions(candidate)))
    return "candidate_metadata_changed";
  if (operation === "unhide") return null;
  if (
    hintedIndexes.includes(`${candidate.collection}.${candidate.index}`) ||
    // Older callers may supply an unqualified reference; keep it fail-closed.
    hintedIndexes.includes(candidate.index)
  )
    return "candidate_is_hinted";
  if (candidate.replacement === null) return null;
  const replacement = indexes.find(item => item.name === candidate.replacement);
  const prefix = Object.entries(candidate.replacementKey).slice(
    0,
    Object.keys(candidate.key).length
  );
  if (
    prefix.length >= Object.keys(candidate.replacementKey).length ||
    JSON.stringify(prefix) !== JSON.stringify(Object.entries(candidate.key)) ||
    !exactIndex(replacement, candidate.replacementKey) ||
    replacement?.hidden === true
  )
    return "replacement_unavailable";
  return null;
}

type UsageResult =
  | { status: "observed"; samples: MongoIndexUsage[] }
  | { status: "unknown"; reason: "unauthorized" | "unavailable" };

async function readUsage(
  adapter: MongoIndexCostAdapter,
  collection: string
): Promise<UsageResult> {
  try {
    return { status: "observed", samples: await adapter.readUsage(collection) };
  } catch (error) {
    const code = (error as { code?: unknown; codeName?: unknown })?.code;
    const codeName = (error as { codeName?: unknown })?.codeName;
    return {
      status: "unknown",
      reason:
        code === 13 || codeName === "Unauthorized"
          ? "unauthorized"
          : "unavailable",
    };
  }
}

function observationDate(
  value: string | undefined,
  now: Date,
  minimumMs: number
): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    fail("drop_observation_required");
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value ||
    now.getTime() - date.getTime() < minimumMs
  )
    fail("drop_observation_required");
  return date;
}

export async function runMongoIndexCostOperation(
  adapter: MongoIndexCostAdapter,
  args: MongoIndexCostOperatorArgs,
  options: { now?: Date; hintedIndexes?: readonly string[] } = {}
) {
  // Validate callers as well as CLI input; never allow arbitrary named operations.
  const selected =
    args.operation === "report"
      ? [...MONGO_INDEX_COST_CANDIDATES]
      : MONGO_INDEX_COST_CANDIDATES.filter(
          candidate =>
            candidate.collection === args.collection &&
            candidate.index === args.index
        );
  if (
    selected.length === 0 ||
    !["report", "hide", "unhide", "drop"].includes(args.operation) ||
    (args.operation === "report" && args.apply)
  )
    fail("invalid_arguments");
  const now = options.now ?? new Date();
  const hintedIndexes = options.hintedIndexes ?? [];
  const metadata = new Map(
    await Promise.all(
      [...new Set(selected.map(candidate => candidate.collection))].map(
        async collection => {
          const [indexes, sizes, usage] = await Promise.all([
            adapter.readIndexes(collection),
            adapter
              .readIndexSizes(collection)
              .catch(() => ({}) as Record<string, number>),
            readUsage(adapter, collection),
          ]);
          return [collection, { indexes, sizes, usage }] as const;
        }
      )
    )
  );
  const candidates = selected.map(candidate => {
    const { indexes, sizes, usage } = metadata.get(candidate.collection)!;
    const actual = indexes.find(index => index.name === candidate.index);
    const reason = blockedReason(
      candidate,
      indexes,
      hintedIndexes,
      args.operation
    );
    const recreateOptions = {
      name: candidate.index,
      ...candidateOptions(candidate),
    };
    return {
      collection: candidate.collection,
      index: candidate.index,
      replacement: candidate.replacement,
      exists: Boolean(actual),
      hidden: actual?.hidden === true,
      bytes: sizes[candidate.index] ?? null,
      usage:
        usage.status === "observed"
          ? {
              ...usage,
              samples: usage.samples.filter(
                sample => sample.name === candidate.index
              ),
            }
          : usage,
      eligible: reason === null,
      blockedReason: reason,
      dropAfterHiddenHours: minimumObservationMs(candidate) / (60 * 60 * 1000),
      rollbackCommand:
        args.operation === "drop"
          ? `db.getCollection(${JSON.stringify(candidate.collection)}).createIndex(${JSON.stringify(candidate.key)},${JSON.stringify(recreateOptions)})`
          : `pnpm --filter @icecore/web run operator:mongo-index-costs --operation=unhide --collection=${candidate.collection} --index=${candidate.index} --apply`,
      recreate: { key: candidate.key, options: recreateOptions },
    };
  });
  const result = {
    mode: args.operation,
    status: args.operation === "report" ? "reported" : "dry_run",
    checkedAt: now.toISOString(),
    candidates,
    note: "Structural overlap or zero usage is not proof of an unused index. Hide retains index storage and write cost. Drop requires a hidden index observed over representative traffic: 24 hours with a replacement, 7 days without one; observed-since is an operator attestation, not usage proof.",
  };
  if (args.operation === "report") return result;
  const candidate = selected[0];
  const { indexes } = metadata.get(candidate.collection)!;
  const reason = blockedReason(
    candidate,
    indexes,
    hintedIndexes,
    args.operation
  );
  if (reason) fail(reason);
  if (args.operation === "drop") {
    if (indexes.find(index => index.name === candidate.index)?.hidden !== true)
      fail("candidate_must_be_hidden");
    observationDate(args.observedSince, now, minimumObservationMs(candidate));
  }
  if (!args.apply) return result;

  const current = await adapter.readIndexes(candidate.collection);
  const changedReason = blockedReason(
    candidate,
    current,
    hintedIndexes,
    args.operation
  );
  if (changedReason) fail(changedReason);
  if (args.operation === "drop") {
    if (current.find(index => index.name === candidate.index)?.hidden !== true)
      fail("candidate_must_be_hidden");
    await adapter.dropIndex(candidate.collection, candidate.index);
  } else {
    await adapter.setHidden(
      candidate.collection,
      candidate.index,
      args.operation === "hide"
    );
  }
  const after = (await adapter.readIndexes(candidate.collection)).find(
    index => index.name === candidate.index
  );
  if (
    args.operation === "drop"
      ? Boolean(after)
      : !exactIndex(after, candidate.key, candidateOptions(candidate)) ||
        (after?.hidden === true) !== (args.operation === "hide")
  )
    fail("mutation_verification_failed");
  return {
    ...result,
    status: "applied",
    candidates: candidates.map(item => ({
      ...item,
      exists: Boolean(after),
      hidden: after?.hidden === true,
    })),
  };
}
