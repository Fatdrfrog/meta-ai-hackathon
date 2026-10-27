import { fileURLToPath } from "node:url";

const REQUIRED_RPC_PATHS = [
  "/rpc/admit_bulk_campaign",
  "/rpc/begin_bulk_campaign_dispatch",
  "/rpc/update_bulk_campaign_progress",
  "/rpc/reconcile_bulk_campaign_cancellation",
  "/rpc/finalize_bulk_campaign_dispatch",
  "/rpc/fail_bulk_campaign_before_start",
  "/rpc/get_bulk_campaign_delivery_counts_batch",
  "/rpc/get_bulk_campaign_retryable_snapshots",
  "/rpc/reconcile_legacy_bulk_campaign_send_totals",
  "/rpc/reserve_scenario_campaign_history",
  "/rpc/reconcile_scenario_campaign_recipient_total",
  "/rpc/is_campaign_message_status_transition_allowed",
  "/rpc/get_campaign_message_status_transition_contract",
  "/rpc/get_prior_failed_bulk_campaign_recipient_hashes",
  "/rpc/get_campaign_recipient_delivery_state_contract",
  "/rpc/get_campaign_provider_circuit_contract",
  "/rpc/get_conversion_feedback_report",
  "/rpc/get_company_bulk_recipient_usage",
];

const REQUIRED_TABLE_PATHS = [
  "/campaign_history",
  "/campaign_messages",
  "/campaign_recipient_delivery_state",
];

const REQUIRED_COLUMNS = {
  campaign_history: [
    "workflow_id",
    "dispatch_status",
    "dispatch_expires_at",
    "started_at",
    "finished_at",
    "processed_count",
    "accepted_count",
    "attempted_count",
    "not_attempted_count",
    "audience_fingerprint",
    "audience_hash_version",
    "audience_count",
    "delivered_count",
    "read_count",
    "opened_count",
    "clicked_count",
    "unsubscribed_count",
    "bounced_count",
    "delivery_ledger_started_at",
    "cost_ledger_started_at",
    "execution_run_key",
    "estimated_cost",
    "bulk_quota_reserved_at",
    "cost_coverage_started_at",
    "unknown_cost_count",
    "known_cost_total_usd",
  ],
  campaign_messages: [
    "recipient_hash",
    "snapshot_ordinal",
    "dispatch_snapshot",
    "snapshot_created_at",
    "attempted_at",
    "failure_scope",
    "estimated_cost_usd",
    "cost_coverage",
    "pricing_type",
    "pricing_billable",
    "pricing_category",
    "pricing_event_at",
    "cost_tariff_context",
  ],
  campaign_recipient_delivery_state: [
    "workspace_id",
    "channel",
    "recipient_hash",
    "latest_terminal_campaign_id",
    "latest_terminal_attempted_at",
    "latest_terminal_status",
    "latest_terminal_failure_scope",
    "latest_terminal_snapshot_ordinal",
    "last_failure_campaign_id",
    "last_failure_attempted_at",
    "last_failed_at",
    "last_failure_provider",
    "last_failure_scope",
    "last_failure_code",
    "last_failure_reason",
    "last_failure_message",
    "last_failure_snapshot_ordinal",
  ],
};

const EMPTY_CAMPAIGN_ID = "00000000-0000-0000-0000-000000000000";
const CAMPAIGN_MESSAGE_STATUSES = [
  "pending",
  "attempted",
  "sent",
  "accepted",
  "delivered",
  "read",
  "failed",
];
const STATUS_PREDECESSORS = {
  pending: [],
  attempted: ["pending"],
  sent: ["pending", "attempted"],
  accepted: ["pending", "attempted", "sent"],
  delivered: ["pending", "attempted", "sent", "accepted"],
  read: ["pending", "attempted", "sent", "accepted", "delivered"],
  failed: ["pending", "attempted", "sent", "accepted"],
};
const REQUIRED_STATUS_TRANSITIONS = CAMPAIGN_MESSAGE_STATUSES.flatMap(
  (currentStatus) =>
    CAMPAIGN_MESSAGE_STATUSES.map((incomingStatus) => ({
      current_status: currentStatus,
      incoming_status: incomingStatus,
      allowed:
        currentStatus === incomingStatus ||
        STATUS_PREDECESSORS[incomingStatus].includes(currentStatus),
    })),
);

function compact(value) {
  return String(value || "").trim();
}

function schemaDefinitions(schema) {
  if (!schema || typeof schema !== "object") return {};
  return schema.definitions || schema.components?.schemas || {};
}

function hasOwn(value, key) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, key),
  );
}

function parseRequiredColumnRef(entry) {
  const match = String(entry || "").match(/^([a-z_]+)\.([a-z_]+)$/);
  if (!match) return null;
  const table = match[1];
  const column = match[2];
  if (!REQUIRED_COLUMNS[table]?.includes(column)) return null;
  return { table, column };
}

function isPostgrestRowArray(value) {
  return Array.isArray(value);
}

async function probeLiveRestColumns({
  fetchImpl,
  supabaseUrl,
  serviceRoleKey,
  missingColumns,
}) {
  const unresolved = [];
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Cache-Control": "no-cache",
    Prefer: "count=none",
  };

  for (const entry of missingColumns) {
    const columnRef = parseRequiredColumnRef(entry);
    if (!columnRef) {
      unresolved.push(entry);
      continue;
    }

    const url = new URL(`/rest/v1/${columnRef.table}`, `${supabaseUrl}/`);
    url.searchParams.set("select", columnRef.column);
    url.searchParams.set("limit", "0");
    const response = await fetchImpl(url.toString(), { headers });
    if (!response.ok) {
      unresolved.push(entry);
      continue;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      unresolved.push(entry);
      continue;
    }

    if (!isPostgrestRowArray(payload)) {
      unresolved.push(entry);
    }
  }

  return unresolved;
}

export function shouldVerifySupabaseCampaignContract({
  productionOnly,
  vercelEnv,
}) {
  return !productionOnly || compact(vercelEnv) === "production";
}

export async function verifySupabaseCampaignContract({
  fetchImpl = globalThis.fetch,
  supabaseUrl,
  serviceRoleKey,
} = {}) {
  const normalizedUrl = compact(supabaseUrl);
  const normalizedKey = compact(serviceRoleKey);
  if (!normalizedUrl || !normalizedKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to verify the Supabase campaign contract",
    );
  }
  if (!fetchImpl) {
    throw new Error("fetch is not available in this Node runtime");
  }

  const schemaUrl = new URL("/rest/v1/", `${normalizedUrl}/`).toString();
  const response = await fetchImpl(schemaUrl, {
    headers: {
      apikey: normalizedKey,
      Authorization: `Bearer ${normalizedKey}`,
      Accept: "application/openapi+json",
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Supabase campaign contract probe failed with HTTP ${response.status}`,
    );
  }

  let schema;
  try {
    schema = await response.json();
  } catch {
    throw new Error("Supabase campaign contract probe returned invalid JSON");
  }

  const paths = schema?.paths;
  const definitions = schemaDefinitions(schema);
  const missingPaths = [];
  const missingColumns = [];

  for (const path of [...REQUIRED_TABLE_PATHS, ...REQUIRED_RPC_PATHS]) {
    if (!hasOwn(paths, path)) {
      missingPaths.push(path);
    }
  }

  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const properties = definitions?.[table]?.properties;
    for (const column of requiredColumns) {
      if (!hasOwn(properties, column)) {
        missingColumns.push(`${table}.${column}`);
      }
    }
  }

  const unresolvedColumns =
    missingPaths.length > 0 || missingColumns.length === 0
      ? missingColumns
      : await probeLiveRestColumns({
          fetchImpl,
          supabaseUrl: normalizedUrl,
          serviceRoleKey: normalizedKey,
          missingColumns,
        });
  const missing = [...missingPaths, ...unresolvedColumns];

  if (missing.length > 0) {
    throw new Error(
      `Supabase bulk campaign contract is incomplete (${missing.join(
        ", ",
      )}). Deploy the required database contract before deploying campaign code.`,
    );
  }

  const preStartExpiryUrl = new URL(
    "/rest/v1/rpc/fail_bulk_campaign_before_start",
    `${normalizedUrl}/`,
  ).toString();
  const preStartExpiryResponse = await fetchImpl(preStartExpiryUrl, {
    method: "POST",
    headers: {
      apikey: normalizedKey,
      Authorization: `Bearer ${normalizedKey}`,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({
      p_campaign_id: EMPTY_CAMPAIGN_ID,
      p_stop_reason: "dispatch_expired_before_start",
      p_now: new Date(0).toISOString(),
    }),
  });
  if (!preStartExpiryResponse.ok) {
    throw new Error(
      "Supabase bulk campaign pre-start expiry contract is incomplete. Deploy the required database contract before deploying campaign code.",
    );
  }
  let preStartExpiryResult;
  try {
    preStartExpiryResult = await preStartExpiryResponse.json();
  } catch {
    throw new Error(
      "Supabase bulk campaign pre-start expiry probe returned invalid JSON",
    );
  }
  if (
    preStartExpiryResult?.applied !== false ||
    preStartExpiryResult?.outcome !== "not_found"
  ) {
    throw new Error(
      "Supabase bulk campaign pre-start expiry contract is invalid. Deploy the required database contract before deploying campaign code.",
    );
  }

  const transitionContractUrl = new URL(
    "/rest/v1/rpc/get_campaign_message_status_transition_contract",
    `${normalizedUrl}/`,
  ).toString();
  const transitionContractResponse = await fetchImpl(transitionContractUrl, {
    method: "POST",
    headers: {
      apikey: normalizedKey,
      Authorization: `Bearer ${normalizedKey}`,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({}),
  });
  if (!transitionContractResponse.ok) {
    throw new Error(
      "Supabase campaign message status transition contract is incomplete. Deploy the required database contract before deploying campaign code.",
    );
  }

  let transitionContract;
  try {
    transitionContract = await transitionContractResponse.json();
  } catch {
    throw new Error(
      "Supabase campaign message status transition probe returned invalid JSON",
    );
  }
  const actualTransitions = transitionContract?.transitions;
  const transitionsMatch =
    Array.isArray(actualTransitions) &&
    actualTransitions.length === REQUIRED_STATUS_TRANSITIONS.length &&
    REQUIRED_STATUS_TRANSITIONS.every((expected, index) => {
      const actual = actualTransitions[index];
      return (
        actual?.current_status === expected.current_status &&
        actual?.incoming_status === expected.incoming_status &&
        actual?.allowed === expected.allowed
      );
    });
  if (
    transitionContract?.version !== 2 ||
    transitionContract?.trigger_enabled !== true ||
    transitionContract?.constraint_validated !== true ||
    transitionContract?.same_state_branch_noop !== true ||
    !transitionsMatch
  ) {
    throw new Error(
      "Supabase campaign message status transition contract is invalid. Deploy the required database contract before deploying campaign code.",
    );
  }

  const priorFailureLookupUrl = new URL(
    "/rest/v1/rpc/get_prior_failed_bulk_campaign_recipient_hashes",
    `${normalizedUrl}/`,
  ).toString();
  const priorFailureLookupResponse = await fetchImpl(priorFailureLookupUrl, {
    method: "POST",
    headers: {
      apikey: normalizedKey,
      Authorization: `Bearer ${normalizedKey}`,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({
      p_workspace_id: EMPTY_CAMPAIGN_ID,
      p_channel: "whatsapp",
      p_recipient_hashes: [],
    }),
  });
  if (!priorFailureLookupResponse.ok) {
    throw new Error(
      "Supabase prior-failure recipient lookup contract is incomplete. Deploy the required database contract before deploying campaign code.",
    );
  }

  const recipientDeliveryStateContractUrl = new URL(
    "/rest/v1/rpc/get_campaign_recipient_delivery_state_contract",
    `${normalizedUrl}/`,
  ).toString();
  const recipientDeliveryStateContractResponse = await fetchImpl(
    recipientDeliveryStateContractUrl,
    {
      method: "POST",
      headers: {
        apikey: normalizedKey,
        Authorization: `Bearer ${normalizedKey}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({}),
    },
  );
  if (!recipientDeliveryStateContractResponse.ok) {
    throw new Error(
      "Supabase recipient delivery state contract is incomplete. Deploy the required database contract before deploying campaign code.",
    );
  }

  let recipientDeliveryStateContract;
  try {
    recipientDeliveryStateContract =
      await recipientDeliveryStateContractResponse.json();
  } catch {
    throw new Error(
      "Supabase recipient delivery state contract is invalid. Deploy the required database contract before deploying campaign code.",
    );
  }
  const arraysEqual = (actual, expected) =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
  const recipientDeliveryStateContractValid =
    recipientDeliveryStateContract?.version === 2 &&
    recipientDeliveryStateContract?.table_rls_enabled === true &&
    arraysEqual(recipientDeliveryStateContract?.primary_key_columns, [
      "workspace_id",
      "channel",
      "recipient_hash",
    ]) &&
    recipientDeliveryStateContract?.trigger_enabled === true &&
    recipientDeliveryStateContract?.trigger_function_security_invoker ===
      true &&
    recipientDeliveryStateContract?.trigger_search_path_empty === true &&
    recipientDeliveryStateContract?.lookup_function_security_invoker === true &&
    recipientDeliveryStateContract?.lookup_search_path_empty === true &&
    recipientDeliveryStateContract?.lookup_max_hashes === 10_000 &&
    recipientDeliveryStateContract?.lookup_workspace_predicate_present ===
      true &&
    recipientDeliveryStateContract?.lookup_recipient_failure_predicate_present ===
      true &&
    recipientDeliveryStateContract?.latest_terminal_ordering_present === true &&
    recipientDeliveryStateContract?.last_failure_ordering_present === true &&
    arraysEqual(recipientDeliveryStateContract?.terminal_statuses, [
      "delivered",
      "read",
      "failed",
    ]) &&
    arraysEqual(
      recipientDeliveryStateContract?.dispatch_item_identity_columns,
      ["campaign_id", "snapshot_ordinal"],
    ) &&
    recipientDeliveryStateContract?.recipient_identity_column ===
      "recipient_hash" &&
    recipientDeliveryStateContract?.recipient_lookup_indexes_non_unique ===
      true &&
    recipientDeliveryStateContract?.recipient_lookup_indexes_exact === true &&
    recipientDeliveryStateContract?.retained_dispatch_item_unique_indexes_exact ===
      true &&
    recipientDeliveryStateContract?.delivery_state_trigger_definition_exact ===
      true &&
    recipientDeliveryStateContract?.admission_metadata_projection_exact ===
      true &&
    recipientDeliveryStateContract?.ordinal_lifecycle_addressing === true &&
    recipientDeliveryStateContract?.legacy_recipient_fallback_max_rows === 2 &&
    arraysEqual(recipientDeliveryStateContract?.item_count_result_aliases, [
      "audience_count",
      "item_count",
    ]) &&
    recipientDeliveryStateContract?.unique_recipient_count_result_alias ===
      "unique_recipient_count" &&
    arraysEqual(recipientDeliveryStateContract?.latest_terminal_order, [
      "attempted_at",
      "campaign_id",
      "snapshot_ordinal",
    ]) &&
    arraysEqual(recipientDeliveryStateContract?.last_failure_order, [
      "attempted_at",
      "campaign_id",
      "snapshot_ordinal",
    ]) &&
    recipientDeliveryStateContract?.ordinal_null_sentinel === -1 &&
    recipientDeliveryStateContract?.exclusion_status === "failed" &&
    recipientDeliveryStateContract?.exclusion_scope === "recipient" &&
    recipientDeliveryStateContract?.last_failure_retained_after_success ===
      true &&
    recipientDeliveryStateContract?.anon_table_select === false &&
    recipientDeliveryStateContract?.authenticated_table_select === false &&
    recipientDeliveryStateContract?.service_role_table_select === true &&
    recipientDeliveryStateContract?.anon_lookup_execute === false &&
    recipientDeliveryStateContract?.authenticated_lookup_execute === false &&
    recipientDeliveryStateContract?.service_role_lookup_execute === true;
  if (!recipientDeliveryStateContractValid) {
    throw new Error(
      "Supabase recipient delivery state contract is invalid. Deploy the required database contract before deploying campaign code.",
    );
  }

  const providerCircuitResponse = await fetchImpl(
    new URL(
      "/rest/v1/rpc/get_campaign_provider_circuit_contract",
      `${normalizedUrl}/`,
    ).toString(),
    {
      method: "POST",
      headers: {
        apikey: normalizedKey,
        Authorization: `Bearer ${normalizedKey}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({}),
    },
  );
  const providerCircuitContract = providerCircuitResponse.ok
    ? await providerCircuitResponse.json().catch(() => null)
    : null;
  if (
    providerCircuitContract?.version !== 1 ||
    providerCircuitContract?.message_trigger_enabled !== true ||
    providerCircuitContract?.history_trigger_enabled !== true ||
    providerCircuitContract?.security_invoker !== true ||
    providerCircuitContract?.empty_search_path !== true ||
    providerCircuitContract?.finalization_preserves_circuit !== true ||
    providerCircuitContract?.lifecycle_preserves_delivery_counts !== true ||
    providerCircuitContract?.historical_restrictions_visible !== true ||
    providerCircuitContract?.retry_ancestry_enforced !== true ||
    providerCircuitContract?.sender_policy_errors_classified !== true ||
    providerCircuitContract?.recent_contact_skip_admitted !== true
  ) {
    throw new Error(
      "Supabase provider circuit contract is incomplete or invalid. Deploy the campaign_async_provider_circuit, campaign_retry_ancestor_provider_circuit, campaign_sender_policy_error_scope, and campaign_recent_contact_skip_reason migrations before deploying campaign code.",
    );
  }

  return {
    checkedRpcCount: REQUIRED_RPC_PATHS.length,
    checkedColumnCount: Object.values(REQUIRED_COLUMNS).reduce(
      (total, columns) => total + columns.length,
      0,
    ),
    checkedTransitionCount: REQUIRED_STATUS_TRANSITIONS.length,
  };
}

async function main() {
  const productionOnly = process.argv.includes("--production-only");
  if (
    !shouldVerifySupabaseCampaignContract({
      productionOnly,
      vercelEnv: process.env.VERCEL_ENV,
    })
  ) {
    process.stdout.write(
      `${JSON.stringify({
        event: "supabase.campaign_contract.skipped",
        reason: "non_production_build",
      })}\n`,
    );
    return;
  }

  const result = await verifySupabaseCampaignContract({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "supabase.campaign_contract.verified",
      ...result,
    })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
