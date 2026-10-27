import assert from "node:assert/strict";
import test from "node:test";
import { storageObjectId } from "@icecore/airi-runtime/storage-quota";
import WhatsAppWebhookEvent, {
  WHATSAPP_WEBHOOK_EVENT_STATUSES,
} from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import type { Source } from "@icecore/shared/types/sources";
import mongoose from "mongoose";

import {
  PURGE_CHAT_DERIVED_COLLECTIONS,
  PURGE_COMPACT_COLLECTIONS,
  PURGE_CONTACT_BATCH_SIZE,
  PURGE_DELETE_COLLECTIONS,
  PURGE_EXECUTION_STEPS,
  PURGE_KEPT_COLLECTIONS,
  PURGE_PROJECTOR_POLL_MS,
  PURGE_SUMMARY_DELETE_PAGE,
  PURGE_WEBHOOK_LAST_ERROR,
  PURGE_WEBHOOK_TERMINAL_STATUSES,
  PurgeOperatorError,
  buildConversationSummaryDeletePath,
  buildOutboxDeletableFilter,
  buildOutboxMixedWorkspaceFilter,
  buildPhoneWindows,
  buildWebhookReceiptSelector,
  buildWorkspaceStoragePrefixes,
  classifyRunningWorkflow,
  clusterTimeToBigInt,
  evaluatePurgeReadiness,
  evaluateWorkspacePreconditions,
  formatPurgeWorkspaceChatDataError,
  parsePurgeWorkspaceChatDataArgs,
  parseResumeManifest,
  partitionContactCandidates,
  resolvePurgeableStorageWorkspace,
  runWorkspaceChatPurge,
  type PurgeChannelSource,
  type PurgeDependencies,
  type PurgeFilter,
  type PurgeMongoCollection,
  type PurgeMongoPort,
  type PurgePhoneBinding,
  type PurgeStorageLedgerPort,
  type PurgeSupabasePort,
  type PurgeTemporalPort,
  type PurgeWorkspaceChatDataOptions,
  type WorkspacePreconditionInput,
} from "./purge-workspace-chat-data.js";

const TARGET = "a22b2b2b-ac89-49bd-9cea-f3c9bfc429ce";
const TARGET_B = "79949d7b-d52b-48f4-928f-9903c7a948f1";
const OTHER = "11111111-2222-4333-8444-555555555555";
const TARGET_COMPANY = "c0000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002";
const TARGET_PHONE = "365392723331509";
const OTHER_PHONE = "880011223344";
const MANAGER_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NOW = new Date("2026-10-17T12:00:00.000Z");

// ------------------------------------------------------------ arg parsing

test("args: workspace ids are required, validated, distinct and capped", () => {
  assert.throws(() => parsePurgeWorkspaceChatDataArgs([]), /at least one/i);
  assert.throws(
    () => parsePurgeWorkspaceChatDataArgs(["--workspace-id=not-a-uuid"]),
    /UUID/,
  );
  assert.throws(
    () =>
      parsePurgeWorkspaceChatDataArgs([
        `--workspace-id=${TARGET}`,
        `--workspace-id=${TARGET.toUpperCase()}`,
      ]),
    /distinct/,
  );
  const six = Array.from(
    { length: 6 },
    (_, index) => `--workspace-id=${TARGET.slice(0, -1)}${index}`,
  );
  assert.throws(() => parsePurgeWorkspaceChatDataArgs(six), /At most 5/);
  assert.equal(
    parsePurgeWorkspaceChatDataArgs(six.slice(0, 5)).workspaceIds.length,
    5,
  );
});

test("args: unknown flags are rejected without echoing them", () => {
  for (const flag of [
    "--all",
    "--all-workspaces",
    "--workspace-id",
    "--mongodb-uri=mongodb+srv://user:secret@cluster",
  ]) {
    assert.throws(
      () => parsePurgeWorkspaceChatDataArgs([`--workspace-id=${TARGET}`, flag]),
      (error: Error) =>
        error instanceof PurgeOperatorError &&
        /Unsupported argument/.test(error.message) &&
        !error.message.includes("secret"),
    );
  }
});

test("args: defaults are dry-run with bounded batches; --execute opts in", () => {
  assert.deepEqual(
    parsePurgeWorkspaceChatDataArgs([`--workspace-id=${TARGET}`]),
    {
      workspaceIds: [TARGET],
      execute: false,
      batchSize: 500,
      pauseMs: 250,
      maxProjectorWaitMs: 600_000,
      manifestPath: null,
      resumeManifestPath: null,
    },
  );
  const options = parsePurgeWorkspaceChatDataArgs([
    "--",
    `--workspace-id=${TARGET.toUpperCase()}`,
    "--execute",
    "--batch-size=1000",
    "--pause-ms=0",
    "--max-projector-wait-ms=120000",
    "--manifest=out.json",
  ]);
  assert.equal(options.execute, true);
  assert.deepEqual(options.workspaceIds, [TARGET]);
  assert.equal(options.batchSize, 1000);
  assert.equal(options.pauseMs, 0);
  assert.equal(options.maxProjectorWaitMs, 120_000);
  assert.match(String(options.manifestPath), /out\.json$/);
  for (const flag of [
    "--batch-size=0",
    "--batch-size=1001",
    "--batch-size=1e3",
    "--pause-ms=-1",
    "--pause-ms=60001",
    "--max-projector-wait-ms=0",
    "--max-projector-wait-ms=3600001",
  ]) {
    assert.throws(
      () => parsePurgeWorkspaceChatDataArgs([`--workspace-id=${TARGET}`, flag]),
      /must be an integer/,
    );
  }
});

// ---------------------------------------------------------- preconditions

function whatsappSource(
  workspaceId: string,
  id: string,
  credentials: Record<string, unknown>,
): Source {
  return {
    id,
    created_at: "2026-01-01T00:00:00Z",
    company_id: TARGET_COMPANY,
    workspace_id: workspaceId,
    type: "whatsapp",
    name: "WhatsApp",
    credentials,
  } as unknown as Source;
}

function preconditionInput(
  overrides: Partial<WorkspacePreconditionInput> = {},
): WorkspacePreconditionInput {
  return {
    workspaceId: TARGET,
    targetWorkspaceIds: [TARGET],
    workspace: { id: TARGET, name: "ClinicDemo", company_id: TARGET_COMPANY },
    company: {
      id: TARGET_COMPANY,
      subscription_type: "free",
      trial_ends_at: "2026-06-29T18:24:46Z",
      billing_manual_paid_through: null,
      billing_entitlement_expires_at: "-infinity",
    },
    whatsappSources: [
      whatsappSource(TARGET, "source-removed", {
        phone_number_id: TARGET_PHONE,
        coexistence_reonboarding_status: "removed",
        partner_app_installed: false,
      }),
    ],
    phoneNumberIds: [TARGET_PHONE],
    phoneBindings: [
      {
        phoneNumberId: TARGET_PHONE,
        workspaceId: TARGET,
        sourceId: "source-removed",
        origin: "sources",
      },
    ],
    nonTerminalCampaignTasks: 0,
    attemptedBulkDispatchDedupes: 0,
    now: NOW,
    ...overrides,
  };
}

test("preconditions: an expired free workspace with dead sources passes", () => {
  const result = evaluateWorkspacePreconditions(preconditionInput());
  assert.equal(result.ok, true, result.failures.join(","));
  assert.equal(result.companyId, TARGET_COMPANY);
  assert.deepEqual(result.notes, [
    "whatsapp_source_not_live:source-removed:partner_removed",
  ]);
  const nullPlan = evaluateWorkspacePreconditions(
    preconditionInput({
      company: {
        id: TARGET_COMPANY,
        subscription_type: null,
        trial_ends_at: "2026-06-29T18:24:46Z",
      },
    }),
  );
  assert.equal(nullPlan.ok, true);
});

test("preconditions: paid plans and paid entitlements fail", () => {
  const base = preconditionInput().company!;
  const pro = evaluateWorkspacePreconditions(
    preconditionInput({ company: { ...base, subscription_type: "pro" } }),
  );
  assert.deepEqual(pro.failures, ["plan_not_free:pro"]);
  const manual = evaluateWorkspacePreconditions(
    preconditionInput({
      company: { ...base, billing_manual_paid_through: "2026-11-01T00:00:00Z" },
    }),
  );
  assert.deepEqual(manual.failures, [
    "paid_entitlement_active:billing_manual_paid_through",
  ]);
  const garbled = evaluateWorkspacePreconditions(
    preconditionInput({
      company: { ...base, billing_entitlement_expires_at: "soon" },
    }),
  );
  assert.deepEqual(garbled.failures, [
    "billing_entitlement_expires_at_invalid",
  ]);
});

test("preconditions: an active or missing trial fails", () => {
  const base = preconditionInput().company!;
  assert.deepEqual(
    evaluateWorkspacePreconditions(
      preconditionInput({
        company: { ...base, trial_ends_at: "2026-10-20T00:00:00Z" },
      }),
    ).failures,
    ["trial_active"],
  );
  assert.deepEqual(
    evaluateWorkspacePreconditions(
      preconditionInput({ company: { ...base, trial_ends_at: null } }),
    ).failures,
    ["trial_end_missing"],
  );
});

test("preconditions: a live WhatsApp source fails", () => {
  const result = evaluateWorkspacePreconditions(
    preconditionInput({
      whatsappSources: [
        whatsappSource(TARGET, "source-live", {
          phone_number_id: TARGET_PHONE,
          coexistence_mode: true,
          partner_app_installed: true,
        }),
        whatsappSource(TARGET, "source-suspended", {
          cloud_api_messaging_suspended: true,
        }),
        // Another workspace's source is not this workspace's concern.
        whatsappSource(OTHER, "source-other", {}),
      ],
    }),
  );
  assert.deepEqual(result.failures, ["whatsapp_source_live:source-live"]);
  assert.deepEqual(result.notes, [
    "whatsapp_source_not_live:source-suspended:cloud_api_messaging_suspended",
  ]);
});

test("preconditions: a phone bound to a non-target workspace fails", () => {
  const shared: PurgePhoneBinding = {
    phoneNumberId: TARGET_PHONE,
    workspaceId: OTHER,
    sourceId: "source-other",
    origin: "whatsapp_accounts",
  };
  const result = evaluateWorkspacePreconditions(
    preconditionInput({
      phoneBindings: [...preconditionInput().phoneBindings, shared],
    }),
  );
  assert.deepEqual(result.failures, [
    `phone_bound_to_other_workspace:${TARGET_PHONE}:${OTHER}:whatsapp_accounts`,
  ]);
  // Bound to another *target* workspace is fine.
  const sibling = evaluateWorkspacePreconditions(
    preconditionInput({
      targetWorkspaceIds: [TARGET, OTHER],
      phoneBindings: [shared],
    }),
  );
  assert.equal(sibling.ok, true);
});

test("preconditions: a number another workspace used since a target owned it fails", () => {
  const ownedSince = new Date("2026-01-01T00:00:00Z");
  const used = evaluateWorkspacePreconditions(
    preconditionInput({
      phoneOwnership: [
        {
          phoneNumberId: TARGET_PHONE,
          ownedSince,
          foreignUseSinceOwnership: 2,
        },
      ],
    }),
  );
  assert.deepEqual(used.failures, [
    `phone_used_by_other_workspace:${TARGET_PHONE}:2`,
  ]);
  const clean = evaluateWorkspacePreconditions(
    preconditionInput({
      phoneOwnership: [
        {
          phoneNumberId: TARGET_PHONE,
          ownedSince,
          foreignUseSinceOwnership: 0,
        },
      ],
    }),
  );
  assert.equal(clean.ok, true);
  // Without ownership evidence the number's untagged receipts are left alone.
  const unknown = evaluateWorkspacePreconditions(
    preconditionInput({
      phoneOwnership: [
        {
          phoneNumberId: TARGET_PHONE,
          ownedSince: null,
          foreignUseSinceOwnership: 0,
        },
      ],
    }),
  );
  assert.equal(unknown.ok, true);
  assert.ok(
    unknown.notes.includes(`phone_without_ownership_evidence:${TARGET_PHONE}`),
  );
});

test("preconditions: connected non-WhatsApp channel sources are reported", () => {
  const result = evaluateWorkspacePreconditions(
    preconditionInput({
      channelSources: [
        { id: "tg-1", workspace_id: TARGET, type: "telegram" },
        { id: "tg-other", workspace_id: OTHER, type: "telegram" },
      ],
    }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.notes.includes("channel_source_connected:telegram:tg-1"));
  assert.ok(!result.notes.some((note) => note.includes("tg-other")));
});

test("webhook selector: untagged receipts only on target numbers inside the ownership window", () => {
  const ownedSince = new Date("2026-01-01T00:00:00Z");
  const windows = buildPhoneWindows([
    { phoneNumberId: TARGET_PHONE, ownedSince, foreignUseSinceOwnership: 0 },
    { phoneNumberId: "999999", ownedSince: null, foreignUseSinceOwnership: 0 },
  ]);
  assert.deepEqual(windows, [{ phoneNumberId: TARGET_PHONE, ownedSince }]);
  const selector = buildWebhookReceiptSelector([TARGET], windows);
  const inside = new Date("2026-02-01T00:00:00Z");
  const before = new Date("2025-12-31T00:00:00Z");
  const receipt = (fields: Doc) => ({ status: "completed", ...fields });
  assert.ok(matches(receipt({ workspaceId: TARGET }), selector));
  assert.ok(
    matches(
      receipt({
        phoneNumberId: TARGET_PHONE,
        workspaceId: null,
        createdAt: inside,
      }),
      selector,
    ),
  );
  // Another workspace's history receipt on the same number.
  assert.ok(
    !matches(
      receipt({
        phoneNumberId: TARGET_PHONE,
        workspaceId: OTHER,
        createdAt: inside,
      }),
      selector,
    ),
  );
  // A previous owner's live receipt from before the target had the number.
  assert.ok(
    !matches(
      receipt({
        phoneNumberId: TARGET_PHONE,
        workspaceId: null,
        createdAt: before,
      }),
      selector,
    ),
  );
  assert.ok(
    !matches(
      receipt({ phoneNumberId: TARGET_PHONE, workspaceId: null }),
      selector,
    ),
  );
  assert.ok(
    !matches(
      receipt({
        phoneNumberId: "999999",
        workspaceId: null,
        createdAt: inside,
      }),
      selector,
    ),
  );
});

test("preconditions: pending campaign tasks fail; attempted dedupes are only reported", () => {
  const result = evaluateWorkspacePreconditions(
    preconditionInput({
      nonTerminalCampaignTasks: 2,
      attemptedBulkDispatchDedupes: 3,
    }),
  );
  assert.deepEqual(result.failures, ["campaign_delivery_tasks_non_terminal:2"]);
  assert.ok(result.notes.includes("bulk_dispatch_attempted_kept:3"));
  assert.deepEqual(
    evaluateWorkspacePreconditions(preconditionInput({ workspace: null }))
      .failures,
    ["workspace_not_found"],
  );
});

test("readiness: execute also needs Temporal and no live outbox rows", () => {
  const ok = evaluateWorkspacePreconditions(preconditionInput());
  assert.deepEqual(
    evaluatePurgeReadiness({
      workspaces: [ok],
      temporalConfigured: true,
      temporalBlockers: 0,
      outboxLiveProcessing: 0,
      storageLedgerOwnerMismatches: 0,
    }),
    { ready: true, blockers: [] },
  );
  assert.deepEqual(
    evaluatePurgeReadiness({
      workspaces: [ok],
      temporalConfigured: false,
      temporalBlockers: 1,
      outboxLiveProcessing: 2,
      storageLedgerOwnerMismatches: 0,
    }).blockers,
    [
      "temporal_not_configured",
      "campaign_workflows_running:1",
      "cross_store_outbox_processing:2",
    ],
  );
  const base = {
    workspaces: [ok],
    temporalConfigured: true,
    temporalBlockers: 0,
    outboxLiveProcessing: 0,
    storageLedgerOwnerMismatches: 0,
  };
  const live = {
    present: true,
    state: "ready",
    generationMode: "cluster_time_v1",
    leaseLive: true,
  };
  assert.deepEqual(
    evaluatePurgeReadiness({ ...base, outboxMixedWorkspaceRows: 1 }).blockers,
    ["cross_store_outbox_mixed_workspace_rows:1"],
  );
  assert.deepEqual(
    evaluatePurgeReadiness({ ...base, projector: live }).blockers,
    [],
  );
  assert.deepEqual(
    evaluatePurgeReadiness({
      ...base,
      projector: { ...live, generationMode: "sequence_v2" },
    }).blockers,
    ["requests_projector_sequence_v2"],
  );
  assert.deepEqual(
    evaluatePurgeReadiness({
      ...base,
      projector: { ...live, leaseLive: false },
    }).blockers,
    ["requests_projector_not_live:ready"],
  );
  assert.deepEqual(
    evaluatePurgeReadiness({
      ...base,
      projector: { ...live, state: "failed" },
    }).blockers,
    ["requests_projector_not_live:failed"],
  );
  // No checkpoint: no projector to wait for.
  assert.deepEqual(
    evaluatePurgeReadiness({
      ...base,
      projector: { ...live, present: false, leaseLive: false },
    }).blockers,
    [],
  );
});

test("summaries: delete pages stay small enough for the REST URL", () => {
  const ids = Array.from(
    { length: PURGE_SUMMARY_DELETE_PAGE },
    (_, index) => `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const urlPath = buildConversationSummaryDeletePath(TARGET, ids);
  assert.ok(urlPath.length < 5_000, String(urlPath.length));
  assert.throws(
    () =>
      buildConversationSummaryDeletePath(TARGET, [
        ...ids,
        "b0000000-0000-4000-8000-000000000000",
      ]),
    /at most 100 ids/,
  );
  assert.throws(
    () => buildConversationSummaryDeletePath(TARGET, ["not-a-uuid"]),
    /unvalidated/,
  );
});

test("cluster times compare as unsigned integers", () => {
  const timestamp = new mongoose.mongo.Timestamp({ t: 1_760_000_000, i: 7 });
  assert.equal(
    clusterTimeToBigInt(timestamp),
    (BigInt(1_760_000_000) << BigInt(32)) + BigInt(7),
  );
  assert.equal(clusterTimeToBigInt(BigInt(5)), BigInt(5));
  assert.equal(clusterTimeToBigInt(null), null);
  // A Timestamp from a second bson copy is read by its tag.
  assert.equal(
    clusterTimeToBigInt({ _bsontype: "Timestamp", toBigInt: () => BigInt(9) }),
    BigInt(9),
  );
  assert.equal(clusterTimeToBigInt({ toBigInt: () => BigInt(9) }), null);
});

// ---------------------------------------------------------------- storage

test("storage: target chat media is selected; business prefixes and other tenants are not", () => {
  const targets = new Set([TARGET]);
  for (const [bucket, objectPath] of [
    ["conversation-images", `whatsapp/${TARGET}/conv/msg.jpg`],
    ["conversation-images", `outbound/whatsapp/${TARGET}/conv/r.png`],
    ["conversation-attachments", `web_widget/${TARGET}/source/upload`],
    ["conversation-attachments", `outbound/telegram/${TARGET}/conv/a.pdf`],
    ["email-attachments", `${TARGET}/message/invoice.pdf`],
  ] as const) {
    assert.equal(
      resolvePurgeableStorageWorkspace(bucket, objectPath, targets),
      TARGET,
      objectPath,
    );
  }
  for (const [bucket, objectPath] of [
    ["conversation-images", `whatsapp/${OTHER}/conv/msg.jpg`],
    ["email-attachments", `${OTHER}/message/invoice.pdf`],
    ["conversation-attachments", `scenarios/${TARGET}/asset.pdf`],
    ["conversation-images", `whatsapp-template-headers/${TARGET}/h.png`],
    ["conversation-images", `studio/instagram/${TARGET}/s.png`],
    ["conversation-images", `workspaces/${TARGET}/creative-assets/x`],
    ["conversation-images", `kb/article/figure.png`],
    ["scenario-assets", `whatsapp/${TARGET}/conv/msg.jpg`],
    ["avatars", `telegram/${TARGET}.jpg`],
    ["conversation-images", "-4937344260/legacy.jpg"],
    ["conversation-images", `whatsapp/${TARGET}/../x.jpg`],
  ] as const) {
    assert.equal(
      resolvePurgeableStorageWorkspace(bucket, objectPath, targets),
      null,
      `${bucket}/${objectPath}`,
    );
  }
  const prefixes = buildWorkspaceStoragePrefixes("conversation-images", TARGET);
  assert.ok(prefixes.includes(`whatsapp/${TARGET}`));
  assert.ok(prefixes.includes(`outbound/web_widget/${TARGET}`));
  assert.ok(
    prefixes.every(
      (prefix) =>
        !/^(scenarios|whatsapp-template-headers|studio|workspaces|kb)\//.test(
          prefix,
        ),
    ),
  );
  assert.deepEqual(buildWorkspaceStoragePrefixes("email-attachments", TARGET), [
    TARGET,
  ]);
  assert.deepEqual(buildWorkspaceStoragePrefixes("avatars", TARGET), []);
});

// --------------------------------------------------------------- contacts

test("contacts: shared, bot and manager ids are never deletable", () => {
  const partition = partitionContactCandidates(
    [
      "wa_77010000001",
      "wa_shared",
      0,
      "0",
      MANAGER_UUID,
      123456789,
      { _id: "embedded" },
      null,
      "wa_77010000001",
    ],
    ["wa_shared", "123456789"],
  );
  assert.deepEqual(partition.deletable, ["wa_77010000001", 123456789]);
  assert.deepEqual(partition.shared, ["wa_shared"]);
  assert.deepEqual(partition.protectedIds, [0, "0", MANAGER_UUID]);
});

// -------------------------------------------------------------- step plan

test("step plan: delete, compact and keep lists are disjoint", () => {
  const kept = PURGE_KEPT_COLLECTIONS.flatMap((rule) =>
    rule.collection.split(/,\s*/).map((name) => name.trim()),
  );
  for (const name of PURGE_DELETE_COLLECTIONS) {
    assert.ok(!kept.includes(name), `${name} is both deleted and kept`);
    assert.ok(!PURGE_COMPACT_COLLECTIONS.includes(name), name);
  }
  assert.equal(
    new Set(PURGE_DELETE_COLLECTIONS).size,
    PURGE_DELETE_COLLECTIONS.length,
  );
  for (const fence of [
    "customercontactreservations",
    "bulkdispatchactivitydedupes",
    "bulksendapiidempotencies",
    "public_template_requests",
    "campaigndeliverytasks",
  ]) {
    assert.ok(kept.includes(fence), fence);
  }
  for (const required of [
    "messagedeliveryevents",
    "realtimeevents",
    "customerevents",
    "llmevaluationreviewitems",
    "answersnippets",
    "messages",
    "conversations",
    "customers",
    "chats",
    "users",
    "request_list_items",
    "crossstoreoutboxes",
    "api_message_send_operations",
  ]) {
    assert.ok(PURGE_DELETE_COLLECTIONS.includes(required), required);
  }
  const revisions = PURGE_CHAT_DERIVED_COLLECTIONS.find(
    (rule) => rule.collection === "conversationanalysisrevisions",
  );
  assert.match(String(revisions?.rawDriverRequired), /raw driver/);
  assert.equal(revisions?.unindexedWorkspace, true);
  assert.deepEqual(PURGE_COMPACT_COLLECTIONS, [
    WhatsAppWebhookEvent.collection.collectionName,
  ]);
  // Receipts are only ever moved into the model's own terminal statuses.
  for (const status of PURGE_WEBHOOK_TERMINAL_STATUSES)
    assert.ok(WHATSAPP_WEBHOOK_EVENT_STATUSES.includes(status), status);
  assert.ok(
    (PURGE_WEBHOOK_TERMINAL_STATUSES as readonly string[]).includes("dead"),
  );
});

test("temporal: only target conversation and chat workflows are terminated", () => {
  const otherConversation = new mongoose.Types.ObjectId().toHexString();
  const conversation = new mongoose.Types.ObjectId().toHexString();
  const targets = {
    workspaceIds: new Set([TARGET]),
    conversationIds: new Set([conversation]),
    generativeExecutionIds: new Set(["exec-1"]),
  };
  const classify = (id: string) => classifyRunningWorkflow(id, targets)?.action;
  assert.equal(classify(`airi-conversation:${conversation}`), "terminate");
  assert.equal(classify(`airi-conversation:${otherConversation}`), undefined);
  assert.equal(
    classify(`airi-conversation:${conversation.slice(1)}0`),
    undefined,
  );
  assert.equal(
    classify(`widget-csat:${TARGET}:${otherConversation}:current`),
    "terminate",
  );
  assert.equal(classify("scenario-generation:exec-1"), "terminate");
  assert.equal(classify(`campaign-node-run:${TARGET}:s:n:scheduled`), "keep");
  assert.equal(classify(`campaign-node-run:${TARGET}:s:n:run-1`), "blocker");
  assert.equal(classify(`creative-image-generation:${TARGET}`), "keep");
  assert.equal(
    classify(`widget-csat:${OTHER}:${otherConversation}:x`),
    undefined,
  );
});

test("errors: secrets and URIs are never printed", () => {
  const leaked = Object.assign(
    new Error("connect failed mongodb+srv://user:pass@cluster0.example.net/db"),
    { code: 18 },
  );
  const message = formatPurgeWorkspaceChatDataError(leaked);
  assert.doesNotMatch(message, /pass|cluster0|mongodb\+srv/);
  assert.match(message, /code 18/);
  assert.doesNotMatch(
    formatPurgeWorkspaceChatDataError(
      new PurgeOperatorError(
        "bad https://x.supabase.co/rest?apikey=eyJa.eyJb.sig",
      ),
    ),
    /supabase\.co|eyJ/,
  );
});

test("resume manifest must match the same target set", () => {
  const manifest = JSON.stringify({
    tool: "purge-workspace-chat-data",
    version: 1,
    workspaceIds: [TARGET],
    candidates: {
      conversationIds: [new mongoose.Types.ObjectId().toHexString()],
      chatIds: ["wa_1", 42],
      userIds: ["wa_1"],
      generativeExecutionIds: [],
    },
  });
  assert.equal(parseResumeManifest(manifest, [TARGET]).chatIds.length, 2);
  assert.throws(() => parseResumeManifest(manifest, [TARGET, OTHER]), /same/);
  assert.throws(() => parseResumeManifest("{", [TARGET]), /JSON/);
});

// ----------------------------------------------------- in-memory harness

type Doc = Record<string, unknown>;

function sameValue(left: unknown, right: unknown): boolean {
  if (
    left instanceof mongoose.Types.ObjectId ||
    right instanceof mongoose.Types.ObjectId
  ) {
    return (
      left instanceof mongoose.Types.ObjectId &&
      right instanceof mongoose.Types.ObjectId &&
      left.equals(right)
    );
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  return left === right;
}

function valueAt(document: Doc, dotted: string): unknown {
  let current: unknown = document;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Doc)[part];
  }
  return current;
}

function isPlainObject(value: unknown): value is Doc {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof mongoose.Types.ObjectId)
  );
}

// Every value a dotted path reaches, traversing arrays like Mongo does.
function resolvePath(value: unknown, parts: readonly string[]): unknown[] {
  if (!parts.length) return [value];
  if (Array.isArray(value))
    return value.flatMap((item) => resolvePath(item, parts));
  if (!isPlainObject(value)) return [];
  const [head, ...rest] = parts;
  if (!(head! in value)) return [];
  return resolvePath(value[head!], rest);
}

function compare(left: unknown, right: unknown): number | null {
  const value = (input: unknown) =>
    input instanceof Date
      ? input.getTime()
      : typeof input === "number"
        ? input
        : null;
  const a = value(left);
  const b = value(right);
  return a === null || b === null ? null : a - b;
}

// Mongo semantics used by the operator: null matches missing, arrays match
// when any element does, $nin/$ne are the negations, comparisons only between
// dates or numbers.
function matchesField(document: Doc, key: string, condition: unknown) {
  const found = resolvePath(document, key.split("."));
  const expanded = found.flatMap((value) =>
    Array.isArray(value) ? [value, ...value] : [value],
  );
  const equals = (expected: unknown) =>
    expected === null
      ? found.length === 0 || expanded.some((value) => value === null)
      : expanded.some((value) => sameValue(value, expected));
  const isOperatorObject =
    isPlainObject(condition) &&
    Object.keys(condition).some((name) => name.startsWith("$"));
  if (!isOperatorObject) return equals(condition);
  const evaluate = (operators: Doc): boolean =>
    Object.entries(operators).every(([operator, argument]) => {
      const ordered = (test: (difference: number) => boolean) =>
        expanded.some((value) => {
          const difference = compare(value, argument);
          return difference !== null && test(difference);
        });
      switch (operator) {
        case "$in":
          return (argument as unknown[]).some(equals);
        case "$nin":
          return !(argument as unknown[]).some(equals);
        case "$ne":
          return !equals(argument);
        case "$exists":
          return argument ? found.length > 0 : found.length === 0;
        case "$gt":
          return ordered((difference) => difference > 0);
        case "$gte":
          return ordered((difference) => difference >= 0);
        case "$lt":
          return ordered((difference) => difference < 0);
        case "$lte":
          return ordered((difference) => difference <= 0);
        case "$elemMatch":
          return found.some(
            (value) =>
              Array.isArray(value) &&
              value.some(
                (item) => isPlainObject(item) && matches(item, argument as Doc),
              ),
          );
        case "$not":
          return !evaluate(argument as Doc);
        default:
          throw new Error(`fake Mongo does not support ${operator}`);
      }
    });
  return evaluate(condition as Doc);
}

function matches(document: Doc, filter: PurgeFilter): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or")
      return (condition as PurgeFilter[]).some((part) =>
        matches(document, part),
      );
    if (key === "$and")
      return (condition as PurgeFilter[]).every((part) =>
        matches(document, part),
      );
    if (key.startsWith("$"))
      throw new Error(`fake Mongo does not support ${key}`);
    return matchesField(document, key, condition);
  });
}

class MemoryMongo implements PurgeMongoPort {
  readonly data = new Map<string, Doc[]>();
  readonly afterWrite: Array<
    (collection: string, op: string, filter: PurgeFilter) => void
  > = [];
  readonly beforeWrite: Array<(collection: string, op: string) => void> = [];
  failOnce: string | null = null;
  /** Logical cluster time: one tick per write. */
  clock = 0;

  constructor(
    private readonly writes: string[],
    private readonly readOnly: boolean,
  ) {}

  seed(name: string, documents: Doc[]) {
    this.data.set(name, [...(this.data.get(name) || []), ...documents]);
  }

  rows(name: string): Doc[] {
    return this.data.get(name) || [];
  }

  lastWriteTime(): bigint | null {
    return this.clock ? BigInt(this.clock) : null;
  }

  private write(name: string, op: string) {
    if (this.readOnly) throw new Error(`write attempted: ${op} ${name}`);
    if (this.failOnce === `${op}:${name}`) {
      this.failOnce = null;
      throw Object.assign(new Error("primary stepped down"), { code: 189 });
    }
    for (const hook of this.beforeWrite) hook(name, op);
    this.writes.push(`mongo:${op}:${name}`);
    this.clock += 1;
  }

  collection(name: string): PurgeMongoCollection {
    const rows = () => this.data.get(name) || [];
    return {
      countDocuments: async (filter) =>
        rows().filter((row) => matches(row, filter)).length,
      find: async (filter, options) => {
        const selected = rows().filter((row) => matches(row, filter));
        const [sortKey, direction] =
          Object.entries(options.sort || {})[0] || [];
        if (sortKey) {
          selected.sort(
            (left, right) =>
              (compare(valueAt(left, sortKey), valueAt(right, sortKey)) ?? 0) *
              (direction === -1 ? -1 : 1),
          );
        }
        return selected
          .slice(0, options.limit || undefined)
          .map((row) => ({ ...row }));
      },
      distinct: async (field, filter) => {
        const values: unknown[] = [];
        for (const row of rows().filter((item) => matches(item, filter))) {
          const value = valueAt(row, field);
          if (value !== undefined && !values.some((v) => sameValue(v, value)))
            values.push(value);
        }
        return values;
      },
      deleteMany: async (filter) => {
        this.write(name, "deleteMany");
        const before = rows();
        const kept = before.filter((row) => !matches(row, filter));
        this.data.set(name, kept);
        for (const hook of this.afterWrite) hook(name, "deleteMany", filter);
        return before.length - kept.length;
      },
      updateMany: async (filter, update) => {
        this.write(name, "updateMany");
        let modified = 0;
        for (const row of rows().filter((item) => matches(item, filter))) {
          for (const [operator, fields] of Object.entries(update)) {
            for (const [key, value] of Object.entries(fields as Doc)) {
              if (key.includes(".")) throw new Error("fake: dotted update");
              if (operator === "$set") row[key] = value;
              else if (operator === "$unset") delete row[key];
              else throw new Error(`fake Mongo does not support ${operator}`);
            }
          }
          modified += 1;
        }
        for (const hook of this.afterWrite) hook(name, "updateMany", filter);
        return modified;
      },
    };
  }
}

type Fixture = ReturnType<typeof buildFixture>;

const CHECKPOINTS = "requests_projection_checkpoint_v2";
const CHECKPOINT_ID = "requests-read-model:v2";

function buildFixture(params: { readOnly?: boolean } = {}) {
  const writes: string[] = [];
  const readOnly = Boolean(params.readOnly);
  const guard = (label: string) => {
    if (readOnly) throw new Error(`write attempted: ${label}`);
    writes.push(label);
  };
  const mongo = new MemoryMongo(writes, readOnly);
  const conv = {
    t1: new mongoose.Types.ObjectId(),
    t2: new mongoose.Types.ObjectId(),
    t3: new mongoose.Types.ObjectId(),
    o1: new mongoose.Types.ObjectId(),
    o2: new mongoose.Types.ObjectId(),
    deleted: new mongoose.Types.ObjectId(),
  };
  mongo.seed("conversations", [
    {
      _id: conv.t1,
      workspaceId: TARGET,
      chat: "wa_77010000001",
      user: "wa_77010000001",
      whatsapp_opt_in: { status: false, source: "whatsapp_user_preferences" },
    },
    { _id: conv.t2, workspaceId: TARGET, chat: "wa_shared", user: "wa_shared" },
    {
      _id: conv.t3,
      workspaceId: TARGET,
      chat: "wa_77010000003",
      user: MANAGER_UUID,
    },
    { _id: conv.o1, workspaceId: OTHER, chat: "wa_shared", user: "wa_shared" },
    { _id: conv.o2, workspaceId: OTHER, chat: "wa_other", user: 0 },
  ]);
  mongo.seed("messages", [
    { _id: "m-t1a", conversation: conv.t1, workspaceId: TARGET },
    { _id: "m-t1b", conversation: conv.t1, workspaceId: TARGET },
    { _id: "m-legacy", conversation: conv.t1 },
    { _id: "m-t2", conversation: conv.t2, workspaceId: TARGET },
    { _id: "m-foreign", conversation: conv.t2, workspaceId: OTHER },
    { _id: "m-orphan", conversation: conv.deleted, workspaceId: TARGET },
    { _id: "m-o1", conversation: conv.o1, workspaceId: OTHER },
  ]);
  mongo.seed("customers", [
    { _id: "cust-t1", workspaceId: TARGET },
    { _id: "cust-t2", workspaceId: TARGET },
    { _id: "cust-o1", workspaceId: OTHER },
  ]);
  mongo.seed("chats", [
    { _id: "wa_77010000001", workspaceId: TARGET },
    { _id: "wa_77010000003", workspaceId: TARGET },
    { _id: "wa_shared", workspaceId: OTHER },
    { _id: "wa_other", workspaceId: OTHER },
    // Tagged with the target, its conversation already deleted from the inbox.
    { _id: "wa_77010000009", workspaceId: TARGET },
  ]);
  mongo.seed("users", [
    { _id: "wa_77010000001", workspaceId: TARGET },
    { _id: "wa_shared", workspaceId: TARGET },
    { _id: "wa_other", workspaceId: OTHER },
    { _id: 0 },
    { _id: MANAGER_UUID },
    { _id: "wa_77010000009", workspaceId: TARGET },
    // The target's Telegram bot account: never a contact candidate.
    { _id: 5550001, workspaceId: TARGET, isBot: true },
  ]);
  const compactedAt = new Date("2026-09-01T00:00:00Z");
  mongo.seed("whatsappwebhookevents", [
    {
      _id: "r-t-completed",
      phoneNumberId: TARGET_PHONE,
      workspaceId: null,
      status: "completed",
      completedAt: new Date("2026-10-10T00:00:00Z"),
      createdAt: new Date("2026-10-10T00:00:00Z"),
      payloadCompactedAt: null,
      payload: { body: "hello" },
      processingCursor: { index: 1 },
    },
    {
      _id: "r-t-queued",
      phoneNumberId: TARGET_PHONE,
      workspaceId: null,
      status: "queued",
      createdAt: new Date("2026-10-17T10:00:00Z"),
      payloadCompactedAt: null,
      payload: { body: "late" },
      nextRetryAt: new Date("2026-10-17T11:00:00Z"),
      processingLeaseId: "lease",
    },
    {
      _id: "r-t-compacted",
      phoneNumberId: TARGET_PHONE,
      workspaceId: null,
      status: "completed",
      completedAt: new Date("2026-08-01T00:00:00Z"),
      createdAt: new Date("2026-08-01T00:00:00Z"),
      payloadCompactedAt: compactedAt,
    },
    {
      _id: "r-t-history",
      phoneNumberId: null,
      workspaceId: TARGET,
      status: "received",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      payloadCompactedAt: null,
      payload: { history: true },
      historyImport: { capacityPaused: true },
    },
    {
      _id: "r-o-failed",
      phoneNumberId: OTHER_PHONE,
      workspaceId: null,
      status: "failed",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      payloadCompactedAt: null,
      payload: { body: "other" },
    },
    {
      _id: "r-o-completed",
      phoneNumberId: OTHER_PHONE,
      workspaceId: OTHER,
      status: "completed",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      payloadCompactedAt: null,
      payload: { body: "other" },
    },
  ]);
  mongo.seed("crossstoreoutboxes", [
    {
      _id: "o-t-feedback",
      operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
      status: "pending",
      payload: { workspaceId: TARGET, conversationId: conv.t1.toHexString() },
    },
    {
      _id: "o-t-status",
      operation: "campaign_messages.update_status",
      status: "completed",
      payload: { realtime: { workspaceId: TARGET, campaignId: "c" } },
    },
    {
      _id: "o-t-attempt-stale",
      operation: "campaign_messages.update_attempt",
      status: "processing",
      processingStartedAt: new Date("2026-10-17T10:00:00Z"),
      payload: { insertIfMissing: { workspaceId: TARGET } },
    },
    {
      _id: "o-t-unknown",
      operation: "whatsapp_llm_feedback.send_reason_prompt",
      status: "delivery_unknown",
      payload: { workspaceId: TARGET },
    },
    {
      _id: "o-t-llm",
      operation: "llm_analytics.publish_events",
      status: "pending",
      payload: {
        events: [
          { workspace_id: TARGET, input_excerpt: "customer text" },
          { workspace_id: TARGET, output_excerpt: "reply text" },
        ],
      },
    },
    {
      _id: "o-o-feedback",
      operation: "whatsapp_llm_feedback.send_helpfulness_prompt",
      status: "pending",
      payload: { workspaceId: OTHER },
    },
    {
      _id: "o-campaign-ledger",
      operation: "campaign_messages.upsert_sent",
      status: "pending",
      payload: { campaignId: "c", messageId: "wamid" },
    },
    {
      _id: "o-o-llm",
      operation: "llm_analytics.publish_events",
      status: "failed",
      payload: { events: [{ workspace_id: OTHER, input_excerpt: "other" }] },
    },
  ]);
  for (const rule of PURGE_CHAT_DERIVED_COLLECTIONS) {
    mongo.seed(rule.collection, [
      { _id: `${rule.collection}-t`, workspaceId: TARGET },
      { _id: `${rule.collection}-o`, workspaceId: OTHER },
    ]);
  }
  mongo.seed("messagedeliveryevents", [
    {
      _id: "mde-t-phone",
      workspaceId: TARGET,
      phoneNumberId: TARGET_PHONE,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
    {
      _id: "mde-o-phone",
      workspaceId: OTHER,
      phoneNumberId: OTHER_PHONE,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
  ]);
  for (const name of ["api_message_send_operations", "request_list_items"]) {
    mongo.seed(name, [
      { _id: `${name}-t`, workspaceId: TARGET },
      { _id: `${name}-o`, workspaceId: OTHER },
    ]);
  }
  mongo.seed("bulkdispatchactivitydedupes", [
    { _id: "dedupe-t", workspaceId: TARGET, state: "attempted" },
  ]);
  mongo.seed("customercontactreservations", [
    { _id: "reservation-t", workspaceId: TARGET },
  ]);
  mongo.seed("campaigndeliverytasks", [
    { _id: "task-t", workspaceId: TARGET, status: "completed" },
  ]);

  // The requests projector: catches up with every write whenever the
  // operator sleeps, unless the test freezes it.
  const projector = {
    frozen: false,
    checkpoint: {
      _id: CHECKPOINT_ID,
      state: "ready",
      generationMode: "cluster_time_v1",
      clusterTime: BigInt(0),
      lease: { expiresAt: new Date(NOW.getTime() + 86_400_000) },
    } as Doc,
    advance() {
      if (!this.frozen) this.checkpoint.clusterTime = BigInt(mongo.clock);
    },
  };
  mongo.seed(CHECKPOINTS, [projector.checkpoint]);

  const storage = new Map<string, Map<string, number>>([
    [
      "conversation-images",
      new Map([
        [`whatsapp/${TARGET}/${conv.t1.toHexString()}/m.jpg`, 10],
        [`outbound/whatsapp/${TARGET}/${conv.t1.toHexString()}/r.png`, 5],
        [`whatsapp/${OTHER}/${conv.o1.toHexString()}/m.jpg`, 99],
        [`scenarios/${TARGET}/keep.png`, 7],
      ]),
    ],
    [
      "email-attachments",
      new Map([
        [`${TARGET}/message/invoice.pdf`, 3],
        [`${OTHER}/message/invoice.pdf`, 4],
      ]),
    ],
  ]);
  const ledger = new Map<string, { workspaceId: string; status: string }>([
    [
      storageObjectId({
        provider: "supabase",
        bucket: "conversation-images",
        path: `whatsapp/${TARGET}/${conv.t1.toHexString()}/m.jpg`,
      }),
      { workspaceId: TARGET, status: "stored" },
    ],
  ]);
  const summaries = [
    { id: "a0000000-0000-4000-8000-000000000001", workspace_id: TARGET },
    { id: "a0000000-0000-4000-8000-000000000002", workspace_id: TARGET },
    { id: "a0000000-0000-4000-8000-000000000003", workspace_id: OTHER },
  ];
  const summaryPageLimits: number[] = [];
  const sources: Source[] = [
    whatsappSource(TARGET, "source-t", {
      phone_number_id: TARGET_PHONE,
      coexistence_reonboarding_status: "removed",
      partner_app_installed: false,
    }),
    whatsappSource(OTHER, "source-o", {
      phone_number_id: OTHER_PHONE,
      coexistence_mode: true,
      partner_app_installed: true,
    }),
  ];
  const channelSources: PurgeChannelSource[] = [];
  const companies = [
    {
      id: TARGET_COMPANY,
      subscription_type: "free",
      trial_ends_at: "2026-06-29T18:24:46Z",
      billing_manual_paid_through: null,
      billing_entitlement_expires_at: "-infinity",
    },
    { id: OTHER_COMPANY, subscription_type: "pro", trial_ends_at: null },
  ];
  const supabase: PurgeSupabasePort = {
    getWorkspaces: async (ids) =>
      [
        { id: TARGET, name: "ClinicDemo", company_id: TARGET_COMPANY },
        { id: OTHER, name: "Other", company_id: OTHER_COMPANY },
      ].filter((row) => ids.includes(row.id)),
    getCompanies: async (ids) =>
      companies.filter((row) => ids.includes(row.id)),
    listWhatsAppSources: async (ids) =>
      sources.filter((source) => ids.includes(source.workspace_id)),
    listChannelSources: async (ids) =>
      channelSources.filter((source) => ids.includes(source.workspace_id)),
    listWorkspacePhoneBindings: async () => [],
    listPhoneBindings: async (phones) =>
      sources
        .map((source) => ({
          phoneNumberId: String(
            (source.credentials as unknown as Doc).phone_number_id,
          ),
          workspaceId: source.workspace_id,
          sourceId: source.id,
          origin: "sources" as const,
        }))
        .filter((binding) => phones.includes(binding.phoneNumberId)),
    async *listStorageObjects(bucket, prefix) {
      for (const [objectPath, bytes] of storage.get(bucket) || [])
        if (objectPath.startsWith(`${prefix}/`))
          yield { bucket, path: objectPath, bytes };
    },
    removeStorageObjects: async (bucket, paths) => {
      guard(`storage:remove:${bucket}`);
      let removed = 0;
      for (const objectPath of paths)
        if (storage.get(bucket)?.delete(objectPath)) removed += 1;
      return removed;
    },
    countConversationSummaries: async (workspaceId) =>
      summaries.filter((row) => row.workspace_id === workspaceId).length,
    listConversationSummaryIds: async (workspaceId, limit) => {
      summaryPageLimits.push(limit);
      return summaries
        .filter((row) => row.workspace_id === workspaceId)
        .slice(0, limit)
        .map((row) => row.id);
    },
    deleteConversationSummaries: async (workspaceId, ids) => {
      guard("supabase:delete:conversation_summaries");
      let removed = 0;
      for (let index = summaries.length - 1; index >= 0; index -= 1) {
        const row = summaries[index]!;
        if (row.workspace_id === workspaceId && ids.includes(row.id)) {
          summaries.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
  };
  const ledgerPort: PurgeStorageLedgerPort = {
    read: async (id) => ledger.get(id) || null,
    tombstone: async (id) => {
      guard("ledger:tombstone");
      ledger.set(id, { ...ledger.get(id)!, status: "tombstoned" });
    },
  };
  const running = [
    {
      workflowId: `airi-conversation:${conv.t1.toHexString()}`,
      runId: "r1",
      type: "airiConversationWorkflow",
    },
    {
      workflowId: `airi-conversation:${conv.o1.toHexString()}`,
      runId: "r2",
      type: "airiConversationWorkflow",
    },
    {
      workflowId: `widget-csat:${TARGET}:${conv.t2.toHexString()}:current`,
      runId: "r3",
      type: "widgetCsatWorkflow",
    },
    {
      workflowId: `campaign-node-run:${TARGET}:scn:node:scheduled`,
      runId: "r4",
      type: "campaignNodeRunWorkflow",
    },
    {
      workflowId: "creative-image-generation:asset",
      runId: "r5",
      type: "creative",
    },
  ];
  // Workflow ids whose terminate call is accepted but leaves them running.
  const stubborn = new Set<string>();
  const temporal: PurgeTemporalPort = {
    async *listRunning() {
      yield* [...running];
    },
    // Like the adapter: the workflow id's current run, whatever its run id.
    terminate: async (workflowId) => {
      guard(`temporal:terminate:${workflowId}`);
      const index = running.findIndex((run) => run.workflowId === workflowId);
      if (index < 0) return "not_running";
      if (!stubborn.has(workflowId)) running.splice(index, 1);
      return "terminated";
    },
    isRunning: async (workflowId) =>
      running.some((run) => run.workflowId === workflowId),
  };
  const files = new Map<string, string>();
  const emitted: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  let elapsedMs = 0;
  const deps: PurgeDependencies = {
    mongo,
    supabase,
    ledger: ledgerPort,
    temporal,
    now: () => new Date(NOW.getTime() + elapsedMs),
    sleep: async (ms) => {
      sleeps.push(ms);
      elapsedMs += ms;
      projector.advance();
    },
    emit: (document) => emitted.push(document),
    progress: () => undefined,
    writeNewFile: async (filePath, content) => {
      if (files.has(filePath)) throw new Error("EEXIST");
      files.set(filePath, content);
    },
    readTextFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
  };
  return {
    deps,
    mongo,
    writes,
    storage,
    ledger,
    summaries,
    summaryPageLimits,
    sources,
    channelSources,
    running,
    stubborn,
    projector,
    files,
    emitted,
    sleeps,
    conv,
    compactedAt,
  };
}

function options(
  execute: boolean,
  extra: Partial<PurgeWorkspaceChatDataOptions> = {},
): PurgeWorkspaceChatDataOptions {
  return {
    workspaceIds: [TARGET],
    execute,
    batchSize: 2,
    pauseMs: 5,
    maxProjectorWaitMs: 60_000,
    manifestPath: "/tmp/purge-manifest.json",
    resumeManifestPath: null,
    ...extra,
  };
}

function ids(fixture: Fixture, collection: string) {
  return fixture.mongo.rows(collection).map((row) => String(row._id));
}

test("dry-run performs zero writes and reports exact counts", async () => {
  const fixture = buildFixture({ readOnly: true });
  const result = await runWorkspaceChatPurge(options(false), fixture.deps);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.writes, 0);
  assert.equal(result.ready, true, String(result.blockers));
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.sleeps, []);
  assert.equal(fixture.emitted.length, 2);
  const plan = fixture.emitted[0]!.plan as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(fixture.emitted[0]!.mode, "dry-run");
  assert.deepEqual(plan.temporal!.terminate, 2);
  assert.deepEqual(plan.requestsProjector, {
    present: true,
    state: "ready",
    generationMode: "cluster_time_v1",
    leaseLive: true,
    committedThrough: "1970-01-01T00:00:00.000Z",
  });
  assert.deepEqual(plan.crossStoreOutbox, {
    delete: 4,
    keptDeliveryUnknown: 1,
    liveProcessing: 0,
    mixedWorkspaceRows: 0,
  });
  assert.deepEqual(plan.webhookReceipts, {
    phoneNumberIds: [TARGET_PHONE],
    // The target source's created_at is the earliest ownership evidence.
    ownedSince: { [TARGET_PHONE]: "2026-01-01T00:00:00.000Z" },
    matched: 4,
    toCompact: 3,
    toMarkDead: 2,
    otherWorkspaceOnTargetPhonesKept: 0,
    untaggedOutsideOwnershipKept: 0,
  });
  assert.deepEqual(plan.messages, {
    inTargetConversations: 4,
    outsideTargetConversations: 1,
    foreignWorkspaceInTargetConversationsKept: 1,
  });
  assert.equal(plan.conversations!.conversations, 3);
  assert.equal(plan.customers, 2);
  assert.deepEqual(plan.contacts, {
    chatCandidates: 4,
    userCandidates: 4,
    taggedChatsOutsideTargetConversations: 1,
    taggedUsersOutsideTargetConversations: 1,
    sharedChatsKept: 1,
    sharedUsersKept: 1,
    keptAsGroupParticipants: 0,
    protectedKept: 1,
    chatsToDelete: 3,
    usersToDelete: 2,
  });
  assert.equal(plan.storage!.objects, 3);
  assert.equal(plan.storage!.bytes, 18);
  assert.deepEqual(plan.conversationSummaries, { [TARGET]: 2 });
  // The local manifest is the only file written and it is never overwritten.
  assert.deepEqual([...fixture.files.keys()], ["/tmp/purge-manifest.json"]);
  await assert.rejects(
    runWorkspaceChatPurge(options(false), fixture.deps),
    /EEXIST/,
  );
});

test("execute refuses on a failed precondition without writing", async () => {
  const fixture = buildFixture();
  (
    fixture.sources[0]!.credentials as unknown as Doc
  ).coexistence_reonboarding_status = "connected";
  (fixture.sources[0]!.credentials as unknown as Doc).coexistence_mode = true;
  (fixture.sources[0]!.credentials as unknown as Doc).partner_app_installed =
    true;
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    /Execution refused: .*whatsapp_source_live:source-t/,
  );
  assert.deepEqual(fixture.writes, []);
});

test("execute refuses when Temporal is not configured", async () => {
  const fixture = buildFixture();
  fixture.deps.temporal = null;
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    /temporal_not_configured/,
  );
  assert.deepEqual(fixture.writes, []);
});

test("execute refuses while a target outbox row is mid-processing", async () => {
  const fixture = buildFixture();
  fixture.mongo.seed("crossstoreoutboxes", [
    {
      _id: "o-t-live",
      status: "processing",
      processingStartedAt: new Date(NOW.getTime() - 60_000),
      payload: { workspaceId: TARGET },
    },
  ]);
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    /cross_store_outbox_processing:1/,
  );
  assert.deepEqual(fixture.writes, []);
});

function phaseOf(write: string): number {
  if (write.startsWith("temporal:")) return 1;
  if (write.startsWith("ledger:") || write.startsWith("storage:")) return 9;
  if (write.startsWith("supabase:")) return 10;
  const collection = write.split(":")[2]!;
  if (collection === "crossstoreoutboxes") return 2;
  if (collection === "whatsappwebhookevents") return 3;
  if (collection === "messages") return 5;
  if (
    [
      "conversations",
      "api_message_send_operations",
      "request_list_items",
    ].includes(collection)
  )
    return 6;
  if (collection === "customers") return 7;
  if (["chats", "users"].includes(collection)) return 8;
  if (
    PURGE_CHAT_DERIVED_COLLECTIONS.some(
      (rule) => rule.collection === collection,
    )
  )
    return 4;
  throw new Error(`unexpected write ${write}`);
}

const WATCHED = new Set(["conversations", "messages", "chats", "users"]);

test("execute runs the steps in order and pauses between batches", async () => {
  const fixture = buildFixture();
  // Simulate the requests projector writing a row after conversations go.
  let projected = false;
  fixture.mongo.afterWrite.push((collection) => {
    if (collection === "conversations" && !projected) {
      projected = true;
      fixture.mongo.seed("realtimeevents", [
        { _id: "projector-late", workspaceId: TARGET },
      ]);
    }
  });
  // No write may start while the projector is behind a watched delete.
  let lastWatchedWrite = BigInt(0);
  const behind: string[] = [];
  fixture.mongo.beforeWrite.push((collection, op) => {
    if ((fixture.projector.checkpoint.clusterTime as bigint) < lastWatchedWrite)
      behind.push(`${op}:${collection}`);
  });
  fixture.mongo.afterWrite.push((collection, op) => {
    if (op === "deleteMany" && WATCHED.has(collection))
      lastWatchedWrite = BigInt(fixture.mongo.clock);
  });
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  assert.deepEqual(behind, []);
  assert.deepEqual(Object.keys(result.steps as Doc), [
    ...PURGE_EXECUTION_STEPS,
  ]);
  const last = fixture.writes.at(-1);
  assert.equal(last, "mongo:deleteMany:realtimeevents");
  const phases = fixture.writes.slice(0, -1).map(phaseOf);
  for (let index = 1; index < phases.length; index += 1) {
    assert.ok(
      phases[index]! >= phases[index - 1]!,
      `${fixture.writes[index]} ran after ${fixture.writes[index - 1]}`,
    );
  }
  assert.deepEqual([...new Set(phases)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(fixture.sleeps.includes(5));
  assert.ok(fixture.sleeps.includes(PURGE_PROJECTOR_POLL_MS));
  assert.ok(
    fixture.sleeps.every((ms) => ms === 5 || ms === PURGE_PROJECTOR_POLL_MS),
  );
  assert.ok(ids(fixture, "realtimeevents").every((id) => !id.includes("late")));
  assert.equal(fixture.files.size, 2);
  assert.ok(fixture.files.has("/tmp/purge-manifest.result.json"));
});

test("execute removes target chat data and keeps every non-target row", async () => {
  const fixture = buildFixture();
  const otherBefore = new Map(
    [...fixture.mongo.data.entries()].map(([name, rows]) => [
      name,
      JSON.stringify(
        rows.filter(
          (row) =>
            row.workspaceId === OTHER || row.phoneNumberId === OTHER_PHONE,
        ),
      ),
    ]),
  );
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  const steps = result.steps as Record<string, Doc>;

  // Temporal: target conversation + target chat workflows only.
  assert.deepEqual(
    fixture.writes.filter((write) => write.startsWith("temporal:")),
    [
      `temporal:terminate:airi-conversation:${fixture.conv.t1.toHexString()}`,
      `temporal:terminate:widget-csat:${TARGET}:${fixture.conv.t2.toHexString()}:current`,
    ],
  );

  // Non-target rows are byte-for-byte unchanged in every collection.
  for (const [name, before] of otherBefore) {
    const after = JSON.stringify(
      fixture.mongo
        .rows(name)
        .filter(
          (row) =>
            row.workspaceId === OTHER || row.phoneNumberId === OTHER_PHONE,
        ),
    );
    assert.equal(after, before, name);
  }

  assert.deepEqual(ids(fixture, "conversations"), [
    fixture.conv.o1.toHexString(),
    fixture.conv.o2.toHexString(),
  ]);
  assert.deepEqual(ids(fixture, "messages"), ["m-foreign", "m-o1"]);
  assert.deepEqual(ids(fixture, "customers"), ["cust-o1"]);
  // wa_77010000009 had no conversation left; it goes because it is tagged.
  assert.deepEqual(ids(fixture, "chats"), ["wa_shared", "wa_other"]);
  assert.deepEqual(ids(fixture, "users"), [
    "wa_shared",
    "wa_other",
    "0",
    MANAGER_UUID,
    "5550001",
  ]);
  for (const rule of PURGE_CHAT_DERIVED_COLLECTIONS) {
    assert.ok(
      ids(fixture, rule.collection).every((id) => !id.endsWith("-t")),
      rule.collection,
    );
  }
  // The all-target LLM analytics batch (chat excerpts) is gone too.
  assert.deepEqual(ids(fixture, "crossstoreoutboxes"), [
    "o-t-unknown",
    "o-o-feedback",
    "o-campaign-ledger",
    "o-o-llm",
  ]);
  // Fences survive.
  assert.deepEqual(ids(fixture, "bulkdispatchactivitydedupes"), ["dedupe-t"]);
  assert.deepEqual(ids(fixture, "customercontactreservations"), [
    "reservation-t",
  ]);
  assert.deepEqual(ids(fixture, "campaigndeliverytasks"), ["task-t"]);

  // Receipts: every row kept, target payloads gone, nothing left to retry.
  const receipts = new Map(
    fixture.mongo.rows("whatsappwebhookevents").map((row) => [row._id, row]),
  );
  assert.equal(receipts.size, 6);
  for (const id of ["r-t-completed", "r-t-queued", "r-t-history"]) {
    const row = receipts.get(id)!;
    assert.equal("payload" in row, false, id);
    assert.equal("processingCursor" in row, false, id);
    assert.ok(
      row.payloadCompactedAt instanceof Date &&
        row.payloadCompactedAt.getTime() >= NOW.getTime(),
      id,
    );
  }
  assert.equal(receipts.get("r-t-completed")!.status, "completed");
  for (const id of ["r-t-queued", "r-t-history"]) {
    assert.equal(receipts.get(id)!.status, "dead");
    assert.equal(receipts.get(id)!.lastError, PURGE_WEBHOOK_LAST_ERROR);
    assert.equal(receipts.get(id)!.nextRetryAt, null);
    assert.equal(receipts.get(id)!.processingLeaseId, null);
  }
  assert.deepEqual(
    receipts.get("r-t-compacted")!.payloadCompactedAt,
    fixture.compactedAt,
  );
  assert.deepEqual(steps.webhook_receipts, {
    selected: 3,
    markedDead: 2,
    compacted: 3,
  });

  // Storage: target chat media removed and tombstoned; the rest untouched.
  assert.deepEqual(
    [...fixture.storage.get("conversation-images")!.keys()],
    [
      `whatsapp/${OTHER}/${fixture.conv.o1.toHexString()}/m.jpg`,
      `scenarios/${TARGET}/keep.png`,
    ],
  );
  assert.deepEqual(
    [...fixture.storage.get("email-attachments")!.keys()],
    [`${OTHER}/message/invoice.pdf`],
  );
  assert.deepEqual(
    [...fixture.ledger.values()],
    [{ workspaceId: TARGET, status: "tombstoned" }],
  );
  assert.deepEqual(steps.storage, {
    selected: 3,
    removed: 3,
    bytes: 18,
    tombstoned: 1,
    ledgerMissing: 2,
    ownerMismatchKept: 0,
  });
  assert.deepEqual(
    fixture.summaries.map((row) => row.workspace_id),
    [OTHER],
  );
  assert.deepEqual(result.followUps, [
    `pnpm --filter @icecore/temporal-worker backfill:usage-snapshots -- --company-id=${TARGET_COMPANY}`,
    ...(result.followUps as string[]).slice(1),
  ]);

  // A re-run is idempotent: nothing is left to write.
  const before = fixture.writes.length;
  const rerun = await runWorkspaceChatPurge(
    options(true, { manifestPath: "/tmp/purge-manifest-2.json" }),
    fixture.deps,
  );
  assert.equal(rerun.status, "completed");
  assert.deepEqual(fixture.writes.slice(before), []);
});

test("a re-run with --resume-manifest finishes contacts after a mid-run failure", async () => {
  const fixture = buildFixture();
  fixture.mongo.failOnce = "deleteMany:customers";
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    (error: Error) =>
      error instanceof PurgeOperatorError &&
      /Step 7 \(customers\) failed: Error code 189/.test(error.message) &&
      /--resume-manifest=\/tmp\/purge-manifest\.json/.test(error.message) &&
      (error.partialReport?.failedStep as string) === "customers",
  );
  // Conversations are gone, so the contact candidates only live in the manifest.
  assert.deepEqual(ids(fixture, "chats"), [
    "wa_77010000001",
    "wa_77010000003",
    "wa_shared",
    "wa_other",
    "wa_77010000009",
  ]);
  const result = await runWorkspaceChatPurge(
    {
      ...options(true, { manifestPath: "/tmp/purge-manifest-resume.json" }),
      resumeManifestPath: "/tmp/purge-manifest.json",
    },
    fixture.deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(ids(fixture, "chats"), ["wa_shared", "wa_other"]);
  assert.deepEqual(ids(fixture, "customers"), ["cust-o1"]);
  assert.deepEqual(ids(fixture, "users"), [
    "wa_shared",
    "wa_other",
    "0",
    MANAGER_UUID,
    "5550001",
  ]);
});

test("a plain re-run after an interrupted run still deletes the target's contact docs", async () => {
  const fixture = buildFixture();
  // Killed after the conversations went (no resume hint, no manifest reuse).
  fixture.mongo.failOnce = "deleteMany:customers";
  await assert.rejects(runWorkspaceChatPurge(options(true), fixture.deps));
  assert.equal(ids(fixture, "conversations").length, 2);
  const result = await runWorkspaceChatPurge(
    options(true, { manifestPath: "/tmp/purge-manifest-plain.json" }),
    fixture.deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(ids(fixture, "chats"), ["wa_shared", "wa_other"]);
  assert.deepEqual(ids(fixture, "users"), [
    "wa_shared",
    "wa_other",
    "0",
    MANAGER_UUID,
    "5550001",
  ]);
  const contacts = (result.steps as Record<string, Doc>).contacts!;
  assert.equal(contacts.chatsDeleted, 3);
  assert.equal(contacts.usersDeleted, 2);
});

test("a resume manifest naming another workspace's conversation is refused", async () => {
  const fixture = buildFixture();
  fixture.files.set(
    "/tmp/tampered.json",
    JSON.stringify({
      tool: "purge-workspace-chat-data",
      version: 1,
      workspaceIds: [TARGET],
      candidates: {
        conversationIds: [fixture.conv.o1.toHexString()],
        chatIds: [],
        userIds: [],
        generativeExecutionIds: [],
      },
    }),
  );
  await assert.rejects(
    runWorkspaceChatPurge(
      { ...options(true), resumeManifestPath: "/tmp/tampered.json" },
      fixture.deps,
    ),
    /non-target workspace/,
  );
  assert.deepEqual(fixture.writes, []);
});

test("outbox filter selects every payload workspace shape", () => {
  const filter = buildOutboxDeletableFilter(
    [TARGET],
    new Date(NOW.getTime() - 600_000),
  );
  const row = (payload: Doc, status = "pending") => ({ status, payload });
  assert.ok(matches(row({ workspaceId: TARGET }), filter));
  assert.ok(matches(row({ realtime: { workspaceId: TARGET } }), filter));
  assert.ok(matches(row({ insertIfMissing: { workspaceId: TARGET } }), filter));
  assert.ok(!matches(row({ workspaceId: OTHER }), filter));
  // LLM analytics batches: every event must be a target's.
  const llm = (events: Doc[], status = "pending") => ({
    operation: "llm_analytics.publish_events",
    status,
    payload: { events },
  });
  const mixed = llm([{ workspace_id: TARGET }, { workspace_id: OTHER }]);
  assert.ok(matches(llm([{ workspace_id: TARGET }]), filter));
  assert.ok(matches(llm([{ workspace_id: TARGET }], "completed"), filter));
  assert.ok(!matches(llm([{ workspace_id: OTHER }]), filter));
  assert.ok(!matches(mixed, filter));
  assert.ok(!matches(llm([{ workspace_id: TARGET }, {}]), filter));
  const mixedFilter = buildOutboxMixedWorkspaceFilter([TARGET]);
  assert.ok(matches(mixed, mixedFilter));
  assert.ok(!matches(llm([{ workspace_id: TARGET }]), mixedFilter));
  assert.ok(!matches(llm([{ workspace_id: OTHER }]), mixedFilter));
  assert.ok(!matches(row({ workspaceId: TARGET }, "delivery_unknown"), filter));
  assert.ok(
    !matches(
      {
        status: "processing",
        processingStartedAt: NOW,
        payload: { workspaceId: TARGET },
      },
      filter,
    ),
  );
});

test("dry-run reports a missing workspace as a failed precondition", async () => {
  const fixture = buildFixture({ readOnly: true });
  const result = await runWorkspaceChatPurge(
    { ...options(false), workspaceIds: [TARGET, TARGET_B] },
    fixture.deps,
  );
  const preconditions = (fixture.emitted[0]!.preconditions as Array<Doc>).map(
    (entry) => [entry.workspaceId, entry.failures],
  );
  assert.deepEqual(preconditions, [
    [TARGET, []],
    [TARGET_B, ["workspace_not_found"]],
  ]);
  assert.equal(result.ready, false);
});

// ------------------------------------------------- review regressions

test("execute never touches another workspace's receipts on a number the target reused", async () => {
  const fixture = buildFixture();
  const foreign: Doc[] = [
    // The previous owner's history import on the same number.
    {
      _id: "r-x-history-on-target-phone",
      phoneNumberId: TARGET_PHONE,
      workspaceId: OTHER,
      sourceId: "source-x",
      status: "received",
      createdAt: new Date("2025-06-01T00:00:00Z"),
      payloadCompactedAt: null,
      payload: { history: "other" },
      processingCursor: { index: 3 },
      historyImport: { capacityPaused: true, sessionId: "s-x" },
    },
    // The previous owner's live receipt, from before the target had the number.
    {
      _id: "r-x-untagged-before-target",
      phoneNumberId: TARGET_PHONE,
      workspaceId: null,
      status: "failed",
      createdAt: new Date("2025-07-01T00:00:00Z"),
      payloadCompactedAt: null,
      payload: { body: "previous owner" },
      nextRetryAt: new Date("2025-07-01T01:00:00Z"),
    },
  ];
  fixture.mongo.seed(
    "whatsappwebhookevents",
    foreign.map((row) => structuredClone(row)),
  );
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  const plan = fixture.emitted[0]!.plan as Record<string, Doc>;
  assert.equal(plan.webhookReceipts!.otherWorkspaceOnTargetPhonesKept, 1);
  assert.equal(plan.webhookReceipts!.untaggedOutsideOwnershipKept, 1);
  for (const expected of foreign) {
    const row = fixture.mongo
      .rows("whatsappwebhookevents")
      .find((item) => item._id === expected._id);
    assert.deepEqual(row, expected, String(expected._id));
  }
  // The target's own receipts on the number were still compacted.
  const own = fixture.mongo
    .rows("whatsappwebhookevents")
    .find((item) => item._id === "r-t-queued")!;
  assert.equal(own.status, "dead");
  assert.equal("payload" in own, false);
});

test("execute refuses when another workspace used a target number after the target owned it", async () => {
  const fixture = buildFixture();
  fixture.mongo.seed("messagedeliveryevents", [
    {
      _id: "mde-x-on-target-phone",
      workspaceId: OTHER,
      phoneNumberId: TARGET_PHONE,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    },
  ]);
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    new RegExp(`phone_used_by_other_workspace:${TARGET_PHONE}:1`),
  );
  assert.deepEqual(fixture.writes, []);
});

test("contacts listed as participants of another workspace's group chat are kept", async () => {
  const fixture = buildFixture();
  const group = new mongoose.Types.ObjectId();
  fixture.mongo.seed("conversations", [
    {
      _id: group,
      workspaceId: OTHER,
      chat: "120363000000000001@g.us",
      user: "wa_other",
      whatsappGroup: { groupId: "120363000000000001" },
    },
  ]);
  // wa_77010000001 talks 1:1 to the target and is a non-first group member
  // in the other workspace.
  fixture.mongo.seed("chats", [
    {
      _id: "120363000000000001@g.us",
      workspaceId: OTHER,
      type: "whatsapp",
      whatsappGroup: { groupId: "120363000000000001" },
      participants: ["wa_other", "wa_77010000001"],
    },
  ]);
  const dryRun = buildFixture({ readOnly: true });
  dryRun.mongo.seed(
    "conversations",
    fixture.mongo.rows("conversations").slice(-1),
  );
  dryRun.mongo.seed("chats", fixture.mongo.rows("chats").slice(-1));
  await runWorkspaceChatPurge(options(false), dryRun.deps);
  const plan = dryRun.emitted[0]!.plan as Record<string, Doc>;
  assert.equal(plan.contacts!.keptAsGroupParticipants, 1);
  assert.equal(plan.contacts!.usersToDelete, 1);
  assert.ok(
    (dryRun.emitted[0]!.warnings as string[]).some((warning) =>
      warning.startsWith("contacts_kept_as_group_participants:1"),
    ),
  );

  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  assert.ok(ids(fixture, "users").includes("wa_77010000001"));
  // The 1:1 chat doc is the target's alone; the group lists users, not chats.
  assert.ok(!ids(fixture, "chats").includes("wa_77010000001"));
  assert.equal(
    (result.steps as Record<string, Doc>).contacts!.keptAsGroupParticipants,
    1,
  );
});

test("contacts referenced or touched after the reference check are not deleted", async () => {
  const fixture = buildFixture();
  fixture.mongo.seed("chats", [{ _id: "wa_late", workspaceId: TARGET }]);
  fixture.mongo.seed("users", [
    { _id: "wa_late", workspaceId: TARGET },
    { _id: "wa_touch", workspaceId: TARGET },
  ]);
  const lateConversation = new mongoose.Types.ObjectId();
  let fired = false;
  fixture.mongo.afterWrite.push((collection, op) => {
    if (fired || collection !== "chats" || op !== "deleteMany") return;
    fired = true;
    // Between the check and the next batches: wa_late writes to the other
    // workspace for the first time, and an inbound refreshes wa_touch.
    fixture.mongo.seed("conversations", [
      {
        _id: lateConversation,
        workspaceId: OTHER,
        chat: "wa_late",
        user: "wa_late",
      },
    ]);
    const touched = fixture.mongo
      .rows("users")
      .find((row) => row._id === "wa_touch")!;
    touched.updatedAt = fixture.deps.now();
  });
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  assert.ok(fired);
  assert.ok(ids(fixture, "chats").includes("wa_late"));
  assert.ok(ids(fixture, "users").includes("wa_late"));
  assert.ok(ids(fixture, "users").includes("wa_touch"));
  const contacts = (result.steps as Record<string, Doc>).contacts!;
  assert.equal(contacts.chatsNewlyReferencedKept, 1);
  assert.equal(contacts.usersNewlyReferencedKept, 1);
  assert.equal(contacts.usersRecentlyUpdatedKept, 1);
});

test("a mixed-workspace LLM analytics outbox row blocks execute", async () => {
  const fixture = buildFixture();
  fixture.mongo.seed("crossstoreoutboxes", [
    {
      _id: "o-mixed-llm",
      operation: "llm_analytics.publish_events",
      status: "pending",
      payload: {
        events: [
          { workspace_id: TARGET, input_excerpt: "target text" },
          { workspace_id: OTHER, input_excerpt: "other text" },
        ],
      },
    },
  ]);
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    /cross_store_outbox_mixed_workspace_rows:1/,
  );
  assert.deepEqual(fixture.writes, []);
  const plan = fixture.emitted[0]!.plan as Record<string, Doc>;
  assert.equal(plan.crossStoreOutbox!.mixedWorkspaceRows, 1);
});

test("messages that arrive mid-run are removed by the final sweep", async () => {
  const fixture = buildFixture();
  fixture.channelSources.push({
    id: "tg-target",
    workspace_id: TARGET,
    type: "telegram",
  });
  let arrived = false;
  fixture.mongo.afterWrite.push((collection, op) => {
    // A Telegram message lands in a target conversation after step 5, while
    // step 6 deletes the conversations.
    if (arrived || collection !== "conversations" || op !== "deleteMany")
      return;
    arrived = true;
    fixture.mongo.seed("messages", [
      { _id: "m-late", conversation: fixture.conv.t1, workspaceId: TARGET },
    ]);
  });
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  assert.ok(arrived);
  assert.ok(!ids(fixture, "messages").includes("m-late"));
  const sweep = (result.steps as Record<string, Doc>).final_projection_sweep!;
  assert.deepEqual(sweep.messages, { byConversation: 1, byWorkspace: 0 });
  const summary = fixture.emitted[0]!;
  const target = (summary.preconditions as Doc[])[0]!;
  assert.ok(
    (target.notes as string[]).includes(
      "channel_source_connected:telegram:tg-target",
    ),
  );
  assert.ok(
    (summary.warnings as string[]).some((warning) =>
      warning.startsWith("channel_sources_connected:1"),
    ),
  );
});

test("chat-derived rows a projector re-creates mid-run are removed by the final sweep", async () => {
  const fixture = buildFixture();
  let reprojected = false;
  fixture.mongo.afterWrite.push((collection, op) => {
    // The acquisition projector re-derives entries from messages that still
    // exist after step 4 (seen in production on 2026-10-17).
    if (reprojected || collection !== "messages" || op !== "deleteMany") return;
    reprojected = true;
    fixture.mongo.seed("analyticsacquisitionentries", [
      { _id: "acq-late", workspaceId: TARGET },
    ]);
    fixture.mongo.seed("analyticsacquisitionentries", [
      { _id: "acq-other", workspaceId: OTHER },
    ]);
  });
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  assert.ok(reprojected);
  const left = fixture.mongo.rows("analyticsacquisitionentries");
  assert.ok(left.every((row) => row.workspaceId !== TARGET));
  assert.ok(left.some((row) => row._id === "acq-other"));
  const sweep = (result.steps as Record<string, Doc>).final_projection_sweep!;
  assert.equal((sweep.chatDerived as Doc).analyticsacquisitionentries, 1);
  assert.equal((sweep.chatDerived as Doc).realtimeevents, undefined);
});

test("Temporal: restarted target workflows are terminated again and verified closed", async () => {
  const fixture = buildFixture();
  const workflowId = `airi-conversation:${fixture.conv.t1.toHexString()}`;
  // The ingress retry cron restarts the conversation workflow once after the
  // first termination (a new run under the same workflow id).
  let restarted = false;
  fixture.mongo.afterWrite.push((collection) => {
    if (restarted || collection !== "crossstoreoutboxes") return;
    restarted = true;
    fixture.running.push({
      workflowId,
      runId: "r1-restarted",
      type: "airiConversationWorkflow",
    });
  });
  const result = await runWorkspaceChatPurge(options(true), fixture.deps);
  assert.equal(result.status, "completed");
  assert.deepEqual(
    fixture.writes.filter(
      (write) => write === `temporal:terminate:${workflowId}`,
    ),
    [`temporal:terminate:${workflowId}`, `temporal:terminate:${workflowId}`],
  );
  const steps = result.steps as Record<string, Doc>;
  // Running then: the restarted run plus three non-target workflows.
  assert.deepEqual(steps.chat_derived_collections!.temporalResweep, {
    scanned: 4,
    terminated: 1,
    alreadyClosed: 0,
  });
  assert.equal(steps.temporal_verify!.verifiedClosed, 2);
  assert.ok(!fixture.running.some((run) => run.workflowId === workflowId));
});

test("Temporal: a target workflow that keeps running fails the run", async () => {
  const fixture = buildFixture();
  const workflowId = `airi-conversation:${fixture.conv.t1.toHexString()}`;
  fixture.stubborn.add(workflowId);
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    (error: Error) =>
      error instanceof PurgeOperatorError &&
      /temporal_verify/.test(error.message) &&
      /still running/.test(error.message),
  );
});

test("execute refuses while the requests projector is in sequence_v2 or not live", async () => {
  for (const change of [
    { generationMode: "sequence_v2" },
    { lease: { expiresAt: new Date(NOW.getTime() - 1_000) } },
  ]) {
    const fixture = buildFixture();
    Object.assign(fixture.projector.checkpoint, change);
    await assert.rejects(
      runWorkspaceChatPurge(options(true), fixture.deps),
      /requests_projector_(sequence_v2|not_live:ready)/,
    );
    assert.deepEqual(fixture.writes, []);
  }
});

test("contact deletes go in small batches that each wait for the projector", async () => {
  const fixture = buildFixture();
  fixture.mongo.seed(
    "users",
    Array.from({ length: 60 }, (_, index) => ({
      _id: `wa_7709${String(index).padStart(7, "0")}`,
      workspaceId: TARGET,
    })),
  );
  const batchSizes: number[] = [];
  fixture.mongo.afterWrite.push((collection, op, filter) => {
    if (collection !== "users" || op !== "deleteMany") return;
    const idFilter = (filter.$and as PurgeFilter[])[0]!._id as {
      $in: unknown[];
    };
    batchSizes.push(idFilter.$in.length);
  });
  const result = await runWorkspaceChatPurge(
    options(true, { batchSize: 1000 }),
    fixture.deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(batchSizes, [PURGE_CONTACT_BATCH_SIZE, 12]);
  assert.equal(
    ids(fixture, "users").filter((id) => id.startsWith("wa_7709")).length,
    0,
  );
});

test("execute stops when the requests projector does not catch up", async () => {
  const fixture = buildFixture();
  fixture.projector.frozen = true;
  await assert.rejects(
    runWorkspaceChatPurge(
      options(true, { maxProjectorWaitMs: 5_000 }),
      fixture.deps,
    ),
    (error: Error) =>
      error instanceof PurgeOperatorError &&
      /Step 5 \(messages\) failed/.test(error.message) &&
      /did not catch up within 5000 ms/.test(error.message),
  );
  // Nothing after the first message page was written.
  assert.equal(
    fixture.writes.filter((write) => write === "mongo:deleteMany:messages")
      .length,
    1,
  );
  assert.ok(!fixture.writes.includes("mongo:deleteMany:conversations"));
});

test("summary delete pages are capped whatever --batch-size is", async () => {
  const fixture = buildFixture();
  const result = await runWorkspaceChatPurge(
    options(true, { batchSize: 1000 }),
    fixture.deps,
  );
  assert.equal(result.status, "completed");
  assert.ok(fixture.summaryPageLimits.length > 0);
  assert.ok(
    fixture.summaryPageLimits.every(
      (limit) => limit === PURGE_SUMMARY_DELETE_PAGE,
    ),
  );
});

test("execute fails closed when a watched write's cluster time is unknown", async () => {
  const fixture = buildFixture();
  fixture.mongo.lastWriteTime = () => null;
  await assert.rejects(
    runWorkspaceChatPurge(options(true), fixture.deps),
    /Step 5 \(messages\) failed: the cluster time of a messages write is unknown/,
  );
  assert.ok(!fixture.writes.includes("mongo:deleteMany:conversations"));
});
