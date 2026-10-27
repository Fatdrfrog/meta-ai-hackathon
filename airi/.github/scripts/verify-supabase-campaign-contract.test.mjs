import assert from "node:assert/strict";
import test from "node:test";

const contractModule = await import(
  "./verify-supabase-campaign-contract.mjs"
).catch(() => ({}));

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

function completeStatusTransitionContract(overrides = {}) {
  return {
    version: 2,
    trigger_enabled: true,
    constraint_validated: true,
    same_state_branch_noop: true,
    transitions: CAMPAIGN_MESSAGE_STATUSES.flatMap((currentStatus) =>
      CAMPAIGN_MESSAGE_STATUSES.map((incomingStatus) => ({
        current_status: currentStatus,
        incoming_status: incomingStatus,
        allowed:
          currentStatus === incomingStatus ||
          STATUS_PREDECESSORS[incomingStatus].includes(currentStatus),
      })),
    ),
    ...overrides,
  };
}

function completeRecipientDeliveryStateContract(overrides = {}) {
  return {
    version: 2,
    table_rls_enabled: true,
    primary_key_columns: ["workspace_id", "channel", "recipient_hash"],
    trigger_enabled: true,
    trigger_function_security_invoker: true,
    trigger_search_path_empty: true,
    lookup_function_security_invoker: true,
    lookup_search_path_empty: true,
    lookup_max_hashes: 10000,
    lookup_workspace_predicate_present: true,
    lookup_recipient_failure_predicate_present: true,
    latest_terminal_ordering_present: true,
    last_failure_ordering_present: true,
    terminal_statuses: ["delivered", "read", "failed"],
    dispatch_item_identity_columns: ["campaign_id", "snapshot_ordinal"],
    recipient_identity_column: "recipient_hash",
    recipient_lookup_indexes_non_unique: true,
    recipient_lookup_indexes_exact: true,
    retained_dispatch_item_unique_indexes_exact: true,
    delivery_state_trigger_definition_exact: true,
    admission_metadata_projection_exact: true,
    ordinal_lifecycle_addressing: true,
    legacy_recipient_fallback_max_rows: 2,
    item_count_result_aliases: ["audience_count", "item_count"],
    unique_recipient_count_result_alias: "unique_recipient_count",
    latest_terminal_order: ["attempted_at", "campaign_id", "snapshot_ordinal"],
    last_failure_order: ["attempted_at", "campaign_id", "snapshot_ordinal"],
    ordinal_null_sentinel: -1,
    exclusion_status: "failed",
    exclusion_scope: "recipient",
    last_failure_retained_after_success: true,
    anon_table_select: false,
    authenticated_table_select: false,
    service_role_table_select: true,
    anon_lookup_execute: false,
    authenticated_lookup_execute: false,
    service_role_lookup_execute: true,
    ...overrides,
  };
}

function completeProviderCircuitContract(overrides = {}) {
  return {
    version: 1,
    message_trigger_enabled: true,
    history_trigger_enabled: true,
    security_invoker: true,
    empty_search_path: true,
    finalization_preserves_circuit: true,
    lifecycle_preserves_delivery_counts: true,
    historical_restrictions_visible: true,
    retry_ancestry_enforced: true,
    sender_policy_errors_classified: true,
    recent_contact_skip_admitted: true,
    ...overrides,
  };
}

function requireVerifier() {
  assert.equal(
    typeof contractModule.verifySupabaseCampaignContract,
    "function",
    "verify-supabase-campaign-contract.mjs must export verifySupabaseCampaignContract",
  );
  return contractModule.verifySupabaseCampaignContract;
}

function requireVerificationPolicy() {
  assert.equal(
    typeof contractModule.shouldVerifySupabaseCampaignContract,
    "function",
    "verify-supabase-campaign-contract.mjs must export shouldVerifySupabaseCampaignContract",
  );
  return contractModule.shouldVerifySupabaseCampaignContract;
}

function completeCampaignContract() {
  return {
    paths: Object.fromEntries(
      [
        "/campaign_history",
        "/campaign_messages",
        "/campaign_recipient_delivery_state",
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
      ].map((path) => [path, {}]),
    ),
    definitions: {
      campaign_history: {
        properties: Object.fromEntries(
          [
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
          ].map((column) => [column, {}]),
        ),
      },
      campaign_messages: {
        properties: Object.fromEntries(
          [
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
          ].map((column) => [column, {}]),
        ),
      },
      campaign_recipient_delivery_state: {
        properties: Object.fromEntries(
          [
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
          ].map((column) => [column, {}]),
        ),
      },
    },
  };
}

test("accepts the complete bulk campaign database contract", async () => {
  const verifySupabaseCampaignContract = requireVerifier();
  const calls = [];

  const result = await verifySupabaseCampaignContract({
    supabaseUrl: "https://project.supabase.co/",
    serviceRoleKey: "service-role-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/rpc/get_campaign_provider_circuit_contract")) {
        return {
          ok: true,
          status: 200,
          json: async () => completeProviderCircuitContract(),
        };
      }
      if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            applied: false,
            outcome: "not_found",
            dispatch_status: null,
          }),
        };
      }
      if (
        url.endsWith("/rpc/get_campaign_message_status_transition_contract")
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => completeStatusTransitionContract(),
        };
      }
      if (url.endsWith("/rpc/get_campaign_recipient_delivery_state_contract")) {
        return {
          ok: true,
          status: 200,
          json: async () => completeRecipientDeliveryStateContract(),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => completeCampaignContract(),
      };
    },
  });

  assert.deepEqual(result, {
    checkedRpcCount: 18,
    checkedColumnCount: 56,
    checkedTransitionCount: 49,
  });
  assert.equal(calls.length, 6);
  const providerCircuitCall = calls.find((call) =>
    call.url.endsWith("/rpc/get_campaign_provider_circuit_contract"),
  );
  assert.equal(providerCircuitCall?.init.method, "POST");
  assert.deepEqual(JSON.parse(providerCircuitCall.init.body), {});
  assert.equal(calls[0].url, "https://project.supabase.co/rest/v1/");
  assert.equal(calls[0].init.headers.apikey, "service-role-key");
  assert.equal(calls[0].init.headers.Authorization, "Bearer service-role-key");
  assert.equal(calls[0].init.headers.Accept, "application/openapi+json");
  assert.equal(
    calls[1].url,
    "https://project.supabase.co/rest/v1/rpc/fail_bulk_campaign_before_start",
  );
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    p_campaign_id: "00000000-0000-0000-0000-000000000000",
    p_stop_reason: "dispatch_expired_before_start",
    p_now: "1970-01-01T00:00:00.000Z",
  });
  expectStatusTransitionContractProbe(calls);
  const priorFailureCall = calls.find((candidate) =>
    candidate.url.endsWith(
      "/rpc/get_prior_failed_bulk_campaign_recipient_hashes",
    ),
  );
  assert.ok(priorFailureCall);
  assert.equal(priorFailureCall.init.method, "POST");
  assert.deepEqual(JSON.parse(priorFailureCall.init.body), {
    p_workspace_id: "00000000-0000-0000-0000-000000000000",
    p_channel: "whatsapp",
    p_recipient_hashes: [],
  });
  const deliveryStateContractCall = calls.find((candidate) =>
    candidate.url.endsWith(
      "/rpc/get_campaign_recipient_delivery_state_contract",
    ),
  );
  assert.ok(deliveryStateContractCall);
  assert.equal(deliveryStateContractCall.init.method, "POST");
  assert.deepEqual(JSON.parse(deliveryStateContractCall.init.body), {});
});

const STALE_OPENAPI_ORDINAL_COLUMNS = [
  "latest_terminal_snapshot_ordinal",
  "last_failure_snapshot_ordinal",
];

function staleOpenApiCampaignContract() {
  const schema = completeCampaignContract();
  for (const column of STALE_OPENAPI_ORDINAL_COLUMNS) {
    delete schema.definitions.campaign_recipient_delivery_state.properties[
      column
    ];
  }
  return schema;
}

function isDeliveryStateColumnProbe(url, column) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.pathname.endsWith("/campaign_recipient_delivery_state") &&
    parsed.searchParams.get("select") === column &&
    parsed.searchParams.get("limit") === "0"
  );
}

function completeContractRpcResponses(url) {
  if (url.endsWith("/rpc/get_campaign_provider_circuit_contract")) {
    return {
      ok: true,
      status: 200,
      json: async () => completeProviderCircuitContract(),
    };
  }
  if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        applied: false,
        outcome: "not_found",
        dispatch_status: null,
      }),
    };
  }
  if (url.endsWith("/rpc/get_campaign_message_status_transition_contract")) {
    return {
      ok: true,
      status: 200,
      json: async () => completeStatusTransitionContract(),
    };
  }
  if (url.endsWith("/rpc/get_campaign_recipient_delivery_state_contract")) {
    return {
      ok: true,
      status: 200,
      json: async () => completeRecipientDeliveryStateContract(),
    };
  }
  return null;
}

test("blocks deployment when the asynchronous provider circuit contract is missing or unsafe", async () => {
  for (const [field, value] of [
    ["version", 0],
    ["message_trigger_enabled", false],
    ["history_trigger_enabled", false],
    ["security_invoker", false],
    ["empty_search_path", false],
    ["finalization_preserves_circuit", false],
    ["lifecycle_preserves_delivery_counts", false],
    ["historical_restrictions_visible", false],
    ["retry_ancestry_enforced", false],
    ["retry_ancestry_enforced", undefined],
    ["sender_policy_errors_classified", false],
    ["sender_policy_errors_classified", undefined],
    // Campaign code that skips recent contacts needs the admission that
    // accepts the recent_contact reason.
    ["recent_contact_skip_admitted", false],
    ["recent_contact_skip_admitted", undefined],
    ["http", 404],
    ["json", "malformed"],
  ]) {
    await assert.rejects(
      requireVerifier()({
        supabaseUrl: "https://project.supabase.co/",
        serviceRoleKey: "private-key",
        fetchImpl: async (url) => {
          if (url.endsWith("/rpc/get_campaign_provider_circuit_contract")) {
            return {
              ok: field !== "http",
              status: field === "http" ? 404 : 200,
              json: async () => {
                if (field === "json") throw new Error("bad JSON");
                return completeProviderCircuitContract({ [field]: value });
              },
            };
          }
          return (
            completeContractRpcResponses(url) || {
              ok: true,
              status: 200,
              json: async () => completeCampaignContract(),
            }
          );
        },
      }),
      /provider circuit contract/,
    );
  }
});

test("accepts live columns when OpenAPI schema cache omits dispatch-item ordinals", async () => {
  const verifySupabaseCampaignContract = requireVerifier();
  const calls = [];

  const result = await verifySupabaseCampaignContract({
    supabaseUrl: "https://project.supabase.co/",
    serviceRoleKey: "service-role-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const rpcResponse = completeContractRpcResponses(url);
      if (rpcResponse) return rpcResponse;
      for (const column of STALE_OPENAPI_ORDINAL_COLUMNS) {
        if (isDeliveryStateColumnProbe(url, column)) {
          return {
            ok: true,
            status: 200,
            json: async () => [],
          };
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => staleOpenApiCampaignContract(),
      };
    },
  });

  assert.deepEqual(result, {
    checkedRpcCount: 18,
    checkedColumnCount: 56,
    checkedTransitionCount: 49,
  });
  assert.equal(calls.length, 8);
  assert.equal(calls[0].url, "https://project.supabase.co/rest/v1/");
  const columnProbeCalls = calls.slice(1, 3);
  assert.equal(columnProbeCalls.length, 2);
  for (const [index, column] of STALE_OPENAPI_ORDINAL_COLUMNS.entries()) {
    assert.equal(
      isDeliveryStateColumnProbe(columnProbeCalls[index].url, column),
      true,
    );
    assert.equal(
      columnProbeCalls[index].init.headers.apikey,
      "service-role-key",
    );
    assert.equal(columnProbeCalls[index].init.headers.Prefer, "count=none");
  }
  expectStatusTransitionContractProbe(calls);
});

test("fails closed when stale OpenAPI and live REST both omit dispatch-item ordinals", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        const rpcResponse = completeContractRpcResponses(url);
        if (rpcResponse) return rpcResponse;
        return {
          ok: true,
          status: 200,
          json: async () => staleOpenApiCampaignContract(),
        };
      },
    }),
    (error) => {
      assert.match(
        error.message,
        /campaign_recipient_delivery_state\.latest_terminal_snapshot_ordinal/,
      );
      assert.match(
        error.message,
        /campaign_recipient_delivery_state\.last_failure_snapshot_ordinal/,
      );
      assert.match(error.message, /required database contract/);
      return true;
    },
  );
});

function expectStatusTransitionContractProbe(calls) {
  const call = calls.find((candidate) => {
    return candidate.url.endsWith(
      "/rpc/get_campaign_message_status_transition_contract",
    );
  });
  assert.ok(call);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), {});
}

test("fails closed when prior-failure lookup no longer requires recipient-scoped latest terminal failure", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              applied: false,
              outcome: "not_found",
              dispatch_status: null,
            }),
          };
        }
        if (
          url.endsWith("/rpc/get_campaign_message_status_transition_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => completeStatusTransitionContract(),
          };
        }
        if (
          url.endsWith("/rpc/get_campaign_recipient_delivery_state_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              completeRecipientDeliveryStateContract({
                exclusion_status: "failed",
                exclusion_scope: "provider",
                last_failure_retained_after_success: false,
                latest_terminal_order: ["campaign_id", "attempted_at"],
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completeCampaignContract(),
        };
      },
    }),
    /recipient delivery state contract is invalid/,
  );
});

test("fails closed when the database permits a terminal delivery conflict", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        if (
          url.endsWith("/rpc/get_campaign_message_status_transition_contract")
        ) {
          const contract = completeStatusTransitionContract();
          const terminalConflict = contract.transitions.find(
            (transition) =>
              transition.current_status === "delivered" &&
              transition.incoming_status === "failed",
          );
          terminalConflict.allowed = true;
          return {
            ok: true,
            status: 200,
            json: async () => contract,
          };
        }
        if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              applied: false,
              outcome: "not_found",
              dispatch_status: null,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completeCampaignContract(),
        };
      },
    }),
    /status transition contract is invalid/,
  );
});

test("fails closed when the database transition trigger is not enabled", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        if (
          url.endsWith("/rpc/get_campaign_message_status_transition_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              completeStatusTransitionContract({ trigger_enabled: false }),
          };
        }
        if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              applied: false,
              outcome: "not_found",
              dispatch_status: null,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completeCampaignContract(),
        };
      },
    }),
    /status transition contract is invalid/,
  );
});

test("fails closed when same-state writes can replace delivery branch fields", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        if (
          url.endsWith("/rpc/get_campaign_message_status_transition_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              completeStatusTransitionContract({
                same_state_branch_noop: false,
              }),
          };
        }
        if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              applied: false,
              outcome: "not_found",
              dispatch_status: null,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completeCampaignContract(),
        };
      },
    }),
    /status transition contract is invalid/,
  );
});

test("fails closed with actionable missing RPC and column names", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          paths: {
            "/campaign_history": {},
            "/campaign_messages": {},
          },
          definitions: {
            campaign_history: { properties: { id: {} } },
            campaign_messages: { properties: { id: {} } },
          },
        }),
      }),
    }),
    (error) => {
      assert.match(error.message, /admit_bulk_campaign/);
      assert.match(error.message, /campaign_history\.dispatch_status/);
      assert.match(error.message, /campaign_history\.estimated_cost/);
      assert.match(error.message, /campaign_history\.bulk_quota_reserved_at/);
      assert.match(error.message, /campaign_history\.cost_coverage_started_at/);
      assert.match(error.message, /campaign_history\.unknown_cost_count/);
      assert.match(error.message, /campaign_history\.known_cost_total_usd/);
      assert.match(error.message, /campaign_messages\.recipient_hash/);
      for (const column of [
        "cost_coverage",
        "pricing_type",
        "pricing_billable",
        "pricing_category",
        "pricing_event_at",
        "cost_tariff_context",
      ])
        assert.match(
          error.message,
          new RegExp(`campaign_messages\\.${column}`),
        );
      assert.match(error.message, /get_conversion_feedback_report/);
      assert.match(error.message, /get_company_bulk_recipient_usage/);
      assert.match(
        error.message,
        /campaign_recipient_delivery_state\.latest_terminal_status/,
      );
      assert.match(
        error.message,
        /get_prior_failed_bulk_campaign_recipient_hashes/,
      );
      assert.match(
        error.message,
        /get_campaign_recipient_delivery_state_contract/,
      );
      assert.match(error.message, /required database contract/);
      return true;
    },
  );
});

test("reports a failed Supabase schema request without exposing credentials", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "do-not-log-this-key",
      fetchImpl: async () => ({
        ok: false,
        status: 503,
      }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /do-not-log-this-key/);
      return true;
    },
  );
});

test("fails closed when the prior-failure lookup cannot be invoked", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        if (
          url.endsWith("/rpc/get_prior_failed_bulk_campaign_recipient_hashes")
        ) {
          return { ok: false, status: 404 };
        }
        if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              applied: false,
              outcome: "not_found",
              dispatch_status: null,
            }),
          };
        }
        if (
          url.endsWith("/rpc/get_campaign_message_status_transition_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => completeStatusTransitionContract(),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completeCampaignContract(),
        };
      },
    }),
    /prior-failure recipient lookup contract is incomplete/,
  );
});

test("fails closed when the recipient delivery-state safety contract drifts", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) => {
        if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              applied: false,
              outcome: "not_found",
              dispatch_status: null,
            }),
          };
        }
        if (
          url.endsWith("/rpc/get_campaign_message_status_transition_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => completeStatusTransitionContract(),
          };
        }
        if (
          url.endsWith("/rpc/get_campaign_recipient_delivery_state_contract")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              completeRecipientDeliveryStateContract({
                authenticated_lookup_execute: true,
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => completeCampaignContract(),
        };
      },
    }),
    /recipient delivery state contract is invalid/,
  );
});

test("fails closed when dispatch-item identity or ordinal-final ordering drifts", async () => {
  const verifySupabaseCampaignContract = requireVerifier();
  const drifts = [
    { dispatch_item_identity_columns: ["campaign_id", "recipient_hash"] },
    { legacy_recipient_fallback_max_rows: 3 },
    { last_failure_order: ["attempted_at", "campaign_id"] },
    { ordinal_null_sentinel: 0 },
  ];

  for (const drift of drifts) {
    await assert.rejects(
      verifySupabaseCampaignContract({
        supabaseUrl: "https://project.supabase.co",
        serviceRoleKey: "service-role-key",
        fetchImpl: async (url) => {
          if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                applied: false,
                outcome: "not_found",
                dispatch_status: null,
              }),
            };
          }
          if (
            url.endsWith("/rpc/get_campaign_message_status_transition_contract")
          ) {
            return {
              ok: true,
              status: 200,
              json: async () => completeStatusTransitionContract(),
            };
          }
          if (
            url.endsWith("/rpc/get_campaign_recipient_delivery_state_contract")
          ) {
            return {
              ok: true,
              status: 200,
              json: async () => completeRecipientDeliveryStateContract(drift),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => completeCampaignContract(),
          };
        },
      }),
      /recipient delivery state contract is invalid/,
    );
  }
});

test("fails closed when exact lookup, retained identity, or trigger catalog shape drifts", async () => {
  const verifySupabaseCampaignContract = requireVerifier();
  const drifts = [
    { recipient_lookup_indexes_exact: false },
    { retained_dispatch_item_unique_indexes_exact: false },
    { delivery_state_trigger_definition_exact: false },
    { admission_metadata_projection_exact: false },
  ];

  for (const drift of drifts) {
    await assert.rejects(
      verifySupabaseCampaignContract({
        supabaseUrl: "https://project.supabase.co",
        serviceRoleKey: "service-role-key",
        fetchImpl: async (url) => {
          if (url.endsWith("/rpc/fail_bulk_campaign_before_start")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                applied: false,
                outcome: "not_found",
                dispatch_status: null,
              }),
            };
          }
          if (
            url.endsWith("/rpc/get_campaign_message_status_transition_contract")
          ) {
            return {
              ok: true,
              status: 200,
              json: async () => completeStatusTransitionContract(),
            };
          }
          if (
            url.endsWith("/rpc/get_campaign_recipient_delivery_state_contract")
          ) {
            return {
              ok: true,
              status: 200,
              json: async () => completeRecipientDeliveryStateContract(drift),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => completeCampaignContract(),
          };
        },
      }),
      /recipient delivery state contract is invalid/,
    );
  }
});

test("fails closed when the pre-start expiry reason is not deployed", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      fetchImpl: async (url) =>
        url.endsWith("/rpc/fail_bulk_campaign_before_start")
          ? {
              ok: false,
              status: 400,
              json: async () => ({}),
            }
          : {
              ok: true,
              status: 200,
              json: async () => completeCampaignContract(),
            },
    }),
    /required database contract/,
  );
});

test("requires deployment credentials before probing Supabase", async () => {
  const verifySupabaseCampaignContract = requireVerifier();

  await assert.rejects(
    verifySupabaseCampaignContract({
      supabaseUrl: "",
      serviceRoleKey: "",
      fetchImpl: async () => {
        throw new Error("fetch must not run");
      },
    }),
    /NEXT_PUBLIC_SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/,
  );
});

test("production-only mode gates Vercel production without breaking local builds", () => {
  const shouldVerifySupabaseCampaignContract = requireVerificationPolicy();

  assert.equal(
    shouldVerifySupabaseCampaignContract({
      productionOnly: true,
      vercelEnv: "production",
    }),
    true,
  );
  assert.equal(
    shouldVerifySupabaseCampaignContract({
      productionOnly: true,
      vercelEnv: "preview",
    }),
    false,
  );
  assert.equal(
    shouldVerifySupabaseCampaignContract({
      productionOnly: true,
      vercelEnv: "",
    }),
    false,
  );
  assert.equal(
    shouldVerifySupabaseCampaignContract({
      productionOnly: false,
      vercelEnv: "",
    }),
    true,
  );
});
