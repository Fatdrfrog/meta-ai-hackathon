import { storageObjectId } from "@icecore/airi-runtime/storage-quota";
import type { WhatsAppWebhookEventStatus } from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import {
  assertTemporalTlsApiKey,
  hasTemporalConnectionEnv,
  resolveTemporalConnectionEnv,
} from "@icecore/shared/lib/temporal-connection-env";
import {
  REQUESTS_PROJECTION_CHECKPOINT_COLLECTION as REQUESTS_PROJECTION_CHECKPOINTS,
  REQUESTS_PROJECTION_CHECKPOINT_ID,
} from "@icecore/shared/lib/requests-projection-checkpoint";
import { getWhatsAppWebhookSourceSkip } from "@icecore/shared/lib/whatsapp/source-state";
import {
  CONVERSATION_CHANNELS,
  type Source,
} from "@icecore/shared/types/sources";
import { WHATSAPP_MARKETING_CONSENT_SOURCES } from "@icecore/whatsapp/marketingConsent";
import { WorkflowNotFoundError } from "@temporalio/client";
import mongoose from "mongoose";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTemporalWorkerEnv } from "./load-env.js";
import {
  listSupabaseBucketObjects,
  storageObjectOwnerWorkspaceId,
  supabaseServiceFetch,
} from "./storage-quota-operator.js";
import { getTemporalClient } from "./temporal-client.js";

// One-off maintenance operator: removes end-customer chat data of explicitly
// listed free-plan workspaces. No backup is taken, so every write is scoped to
// the target workspace ids (or their conversation ids / phone numbers) and is
// rechecked inside the write filter itself.

export const PURGE_TOOL_NAME = "purge-workspace-chat-data";
export const PURGE_MAX_WORKSPACES = 5;
export const PURGE_DEFAULT_BATCH_SIZE = 500;
export const PURGE_MAX_BATCH_SIZE = 1000;
export const PURGE_DEFAULT_PAUSE_MS = 250;
export const PURGE_MAX_PAUSE_MS = 60_000;
export const PURGE_TERMINATE_REASON = "workspace chat purge";
// Stored in whatsappwebhookevents.lastError on receipts moved to "dead".
export const PURGE_WEBHOOK_LAST_ERROR = "workspace_chat_purge";
// The requests projector handles each chat/user delete on its own (several
// round trips per event), so contact deletes go in small batches and wait for
// the projector after each one.
export const PURGE_CONTACT_BATCH_SIZE = 50;
// conversation_summaries ids go into the REST query string: 100 UUIDs keep the
// URL near 4 KB, well under gateway URL limits, whatever --batch-size is.
export const PURGE_SUMMARY_DELETE_PAGE = 100;
export const PURGE_DEFAULT_PROJECTOR_WAIT_MS = 600_000;
export const PURGE_MAX_PROJECTOR_WAIT_MS = 3_600_000;
export const PURGE_PROJECTOR_POLL_MS = 1_000;
// chats.participants has no index: the participant check scans chats once per
// this many candidate ids.
const CONTACT_PARTICIPANT_SCAN_CHUNK = 5_000;
const LLM_ANALYTICS_OUTBOX_OPERATION = "llm_analytics.publish_events";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const PHONE_NUMBER_ID_PATTERN = /^\d{5,32}$/;
// Mirrors OUTBOX_STALE_PROCESSING_MINUTES in apps/web/src/lib/cross-store-outbox.ts:
// older "processing" rows are reset to "pending" by the drain, so they are not live.
const OUTBOX_STALE_PROCESSING_MS = 10 * 60_000;
const STORAGE_LIST_PAGE_BUDGET = 50_000;
const TEMPORAL_SCAN_LIMIT = 200_000;
const SUPABASE_ROW_LIMIT = 1000;

const CONVERSATIONS = "conversations";
const MESSAGES = "messages";
const CUSTOMERS = "customers";
const CHATS = "chats";
const USERS = "users";
const REQUEST_LIST_ITEMS = "request_list_items";
const REALTIME_EVENTS = "realtimeevents";
const API_MESSAGE_SEND_OPERATIONS = "api_message_send_operations";
const CROSS_STORE_OUTBOXES = "crossstoreoutboxes";
const WEBHOOK_EVENTS = "whatsappwebhookevents";
const MESSAGE_DELIVERY_EVENTS = "messagedeliveryevents";
const CAMPAIGN_DELIVERY_TASKS = "campaigndeliverytasks";
const BULK_DISPATCH_DEDUPES = "bulkdispatchactivitydedupes";
// The platform-wide requests projector watches exactly these collections
// (apps/web/src/lib/requests-projection/activation.ts openProductionChangeStream).
const PROJECTOR_WATCHED_COLLECTIONS: ReadonlySet<string> = new Set([
  CONVERSATIONS,
  MESSAGES,
  CHATS,
  USERS,
]);
// Non-WhatsApp channels that can still add messages to existing conversations
// after the trial ends (only new conversations are capacity-gated).
const CHANNEL_SOURCE_TYPES = CONVERSATION_CHANNELS.filter(
  (channel) => channel !== "whatsapp",
);

export type PurgeCollectionRule = {
  collection: string;
  reason: string;
  rawDriverRequired?: string;
  /** No index leads with workspaceId: scan once, then delete by _id. */
  unindexedWorkspace?: true;
};

/**
 * Step 4: chat-derived side collections, deleted by workspaceId. Every name
 * and its String workspaceId field were checked against the model files in
 * apps/web/src/models. All Mongo writes in this operator use the raw driver.
 */
export const PURGE_CHAT_DERIVED_COLLECTIONS: readonly PurgeCollectionRule[] = [
  { collection: MESSAGE_DELIVERY_EVENTS, reason: "Meta status receipts" },
  { collection: REALTIME_EVENTS, reason: "realtime outbox payload copies" },
  { collection: "airiturncontexts", reason: "AI turn inputs" },
  { collection: "airireplytraces", reason: "AI reply traces" },
  { collection: "airisuggestions", reason: "AI reply suggestions" },
  { collection: "airigapevents", reason: "knowledge-gap events" },
  { collection: "coachingtips", reason: "coach tips about messages" },
  { collection: "customerevents", reason: "lead timeline" },
  {
    collection: "analyticsacquisitionentries",
    reason: "per-conversation acquisition facts",
  },
  {
    collection: "analyticsacquisitionmessagelinks",
    reason: "per-message acquisition links",
  },
  {
    collection: "analyticsconversionfacts",
    reason: "per-conversation conversion facts",
  },
  {
    collection: "analyticscustomerpurchaseobservations",
    reason: "per-lead purchase facts",
  },
  {
    collection: "analyticsservicelifecyclefacts",
    reason: "per-conversation lifecycle facts",
  },
  { collection: "scenariotriggerlogs", reason: "per-conversation trigger log" },
  { collection: "scenarioflowevents", reason: "WhatsApp Flow form answers" },
  {
    collection: "scenarioflowsuppressions",
    reason: "per-conversation Flow suppressions",
  },
  { collection: "scenariobehaviorruns", reason: "per-lead behavior runs" },
  { collection: "scenarioevalcases", reason: "chat-derived eval cases" },
  {
    collection: "llmevaluationreviewitems",
    reason: "chat excerpts for review",
  },
  {
    collection: "llmevaluationregressioncases",
    reason: "chat-derived regression cases",
  },
  {
    collection: "whatsapppendingmessagemutations",
    reason: "edit/revoke payload copies",
  },
  { collection: "whatsappcallsessions", reason: "call sessions" },
  { collection: "whatsappcallrecordings", reason: "call recording records" },
  { collection: "whatsappcallevents", reason: "call signalling" },
  { collection: "whatsappcallcommands", reason: "call commands" },
  { collection: "websitecarts", reason: "visitor carts" },
  {
    collection: "conversationanalysisrevisions",
    reason: "chat classification revisions",
    // The Mongoose model throws on deleteMany/deleteOne/findOneAndDelete
    // (append-only guard in apps/web/src/models/conversation-analysis-revision.ts).
    // This one-off purge deliberately bypasses it through the raw driver. The
    // collection has no workspaceId index, so it is scanned once.
    rawDriverRequired:
      "append-only Mongoose delete hooks throw; the raw driver bypasses them on purpose",
    unindexedWorkspace: true,
  },
  { collection: "answersnippets", reason: "chat Q/A pairs used by AI replies" },
];

/** Every collection whose rows this operator deletes (by step). */
export const PURGE_DELETE_COLLECTIONS: readonly string[] = [
  CROSS_STORE_OUTBOXES,
  ...PURGE_CHAT_DERIVED_COLLECTIONS.map((rule) => rule.collection),
  MESSAGES,
  CONVERSATIONS,
  API_MESSAGE_SEND_OPERATIONS,
  REQUEST_LIST_ITEMS,
  CUSTOMERS,
  CHATS,
  USERS,
];

/** Rows kept; only the raw payload and processing cursor are removed. */
export const PURGE_COMPACT_COLLECTIONS: readonly string[] = [WEBHOOK_EVENTS];

/** Never written by this operator. */
export const PURGE_KEPT_COLLECTIONS: readonly PurgeCollectionRule[] = [
  {
    collection: "customercontactreservations",
    reason: "contact-frequency cap keyed by phone/customer hashes",
  },
  { collection: "customercontactpolicies", reason: "workspace configuration" },
  {
    collection: BULK_DISPATCH_DEDUPES,
    reason: "provider send fence; 'attempted' rows must never be deleted",
  },
  {
    collection: "bulksendapiidempotencies",
    reason: "bulk API idempotency fence",
  },
  {
    collection: "public_template_requests",
    reason: "at-most-once dispatch fence (PII redaction is a separate task)",
  },
  {
    collection: CAMPAIGN_DELIVERY_TASKS,
    reason: "campaign idempotency keys and delivery history",
  },
  {
    collection: "whatsapp_opt_in_events (Supabase)",
    reason: "marketing consent evidence",
  },
  {
    collection:
      "scenarios, scenariolinkedconditions, campaignnodeschedules, campaignscheduleruns, whatsappwelcomesequences, quickreplies, business_locations, workspaceairisettings, workspaceemailautomations, whatsapptemplates, whatsapptemplateauditlogs, otptemplatebindings, analyticsdashboardpreferences",
    reason: "workspace configuration",
  },
  {
    collection:
      "analyticsacquisitioncheckpoints, analyticsacquisitiondailies, analyticsservicelifecyclecheckpoints, analyticscustomerstagecheckpoints, analyticspolicies",
    reason: "aggregate analytics, projection cursors and policies",
  },
  {
    collection:
      "whatsappanalyticshealthdailies, whatsapptemplateanalyticsdailies, scenariotriggerdailymetrics, scenarioevalmetrics, scenarioevalruns, scenarioevaloptimizerruns, airirecommendations",
    reason: "aggregates without conversation content",
  },
  {
    collection: "company_storage_usage, company_storage_objects",
    reason: "storage ledger; objects are tombstoned, never deleted",
  },
  {
    collection:
      "whatsapp_history_import_budgets, requests_projection_checkpoint_v2",
    reason: "company counters and the platform projector checkpoint",
  },
  {
    collection:
      "scenariogeneratedrecipientmessages, whatsappgroups, whatsappgroupevents, telegramsubscribers, telegramsubscriberimportbatches, creativeassets, airichatthreads, airichatmessages, creativestudiochats",
    reason:
      "outside the approved scope (campaign drafts, groups, audiences, studio and staff assistant data)",
  },
  {
    collection:
      "Supabase conversions, revenue_attributions, session_feedback, airi_sessions, airi_tip_feedback, email_attachments, webhook_delivery_logs, campaign_history, campaign_messages, knowledge_documents, knowledge_chunks",
    reason: "outside the approved scope (ledgers and analytics)",
  },
];

export const PURGE_EXECUTION_STEPS = [
  "temporal_terminate",
  "cross_store_outbox",
  "webhook_receipts",
  "chat_derived_collections",
  "messages",
  "conversations",
  "customers",
  "contacts",
  "storage",
  "conversation_summaries",
  "final_projection_sweep",
  "temporal_verify",
] as const;

export type PurgeExecutionStep = (typeof PURGE_EXECUTION_STEPS)[number];

export class PurgeOperatorError extends Error {
  partialReport?: Record<string, unknown>;

  constructor(message: string) {
    super(message);
    this.name = "PurgeOperatorError";
  }
}

// ---------------------------------------------------------------- arguments

export type PurgeWorkspaceChatDataOptions = {
  workspaceIds: string[];
  execute: boolean;
  batchSize: number;
  pauseMs: number;
  maxProjectorWaitMs: number;
  manifestPath: string | null;
  resumeManifestPath: string | null;
};

function readIntegerFlag(
  value: string,
  flag: string,
  min: number,
  max: number,
): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new PurgeOperatorError(
      `${flag} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

function readPathFlag(value: string, flag: string, current: string | null) {
  if (current !== null) throw new PurgeOperatorError(`${flag} was repeated`);
  if (!value.trim()) throw new PurgeOperatorError(`${flag} needs a path`);
  return path.resolve(value.trim());
}

export function parsePurgeWorkspaceChatDataArgs(
  argv: readonly string[],
): PurgeWorkspaceChatDataOptions {
  const options: PurgeWorkspaceChatDataOptions = {
    workspaceIds: [],
    execute: false,
    batchSize: PURGE_DEFAULT_BATCH_SIZE,
    pauseMs: PURGE_DEFAULT_PAUSE_MS,
    maxProjectorWaitMs: PURGE_DEFAULT_PROJECTOR_WAIT_MS,
    manifestPath: null,
    resumeManifestPath: null,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg.startsWith("--workspace-id=")) {
      const workspaceId = arg
        .slice("--workspace-id=".length)
        .trim()
        .toLowerCase();
      if (!UUID_PATTERN.test(workspaceId))
        throw new PurgeOperatorError("--workspace-id must be a workspace UUID");
      if (options.workspaceIds.includes(workspaceId))
        throw new PurgeOperatorError("--workspace-id values must be distinct");
      options.workspaceIds.push(workspaceId);
    } else if (arg.startsWith("--batch-size=")) {
      options.batchSize = readIntegerFlag(
        arg.slice("--batch-size=".length),
        "--batch-size",
        1,
        PURGE_MAX_BATCH_SIZE,
      );
    } else if (arg.startsWith("--pause-ms=")) {
      options.pauseMs = readIntegerFlag(
        arg.slice("--pause-ms=".length),
        "--pause-ms",
        0,
        PURGE_MAX_PAUSE_MS,
      );
    } else if (arg.startsWith("--max-projector-wait-ms=")) {
      options.maxProjectorWaitMs = readIntegerFlag(
        arg.slice("--max-projector-wait-ms=".length),
        "--max-projector-wait-ms",
        PURGE_PROJECTOR_POLL_MS,
        PURGE_MAX_PROJECTOR_WAIT_MS,
      );
    } else if (arg.startsWith("--manifest=")) {
      options.manifestPath = readPathFlag(
        arg.slice("--manifest=".length),
        "--manifest",
        options.manifestPath,
      );
    } else if (arg.startsWith("--resume-manifest=")) {
      options.resumeManifestPath = readPathFlag(
        arg.slice("--resume-manifest=".length),
        "--resume-manifest",
        options.resumeManifestPath,
      );
    } else {
      // Never echo the argument: it could be a pasted secret or URI.
      throw new PurgeOperatorError(
        "Unsupported argument. Use --help for supported flags.",
      );
    }
  }
  if (!options.workspaceIds.length) {
    throw new PurgeOperatorError(
      "At least one --workspace-id=<uuid> is required; there is no all-workspaces mode",
    );
  }
  if (options.workspaceIds.length > PURGE_MAX_WORKSPACES) {
    throw new PurgeOperatorError(
      `At most ${PURGE_MAX_WORKSPACES} --workspace-id values are allowed`,
    );
  }
  if (
    options.manifestPath &&
    options.manifestPath === options.resumeManifestPath
  ) {
    throw new PurgeOperatorError(
      "--manifest must differ from --resume-manifest; manifests are never overwritten",
    );
  }
  return options;
}

// ------------------------------------------------------------ preconditions

export type PurgeWorkspaceRow = {
  id: string;
  name?: string | null;
  company_id?: string | null;
};

export type PurgeCompanyRow = {
  id: string;
  subscription_type?: string | null;
  trial_ends_at?: string | null;
  billing_manual_paid_through?: string | null;
  billing_entitlement_expires_at?: string | null;
};

export type PurgePhoneBinding = {
  phoneNumberId: string;
  workspaceId: string | null;
  sourceId: string | null;
  origin: "sources" | "whatsapp_accounts";
};

/**
 * Live webhook receipts carry no workspace (workspaceId null), so a receipt
 * on a target number is only attributed to the targets from the earliest
 * evidence that a target used the number. Another workspace's use of the
 * number from that point on makes the attribution ambiguous.
 */
export type PurgePhoneOwnership = {
  phoneNumberId: string;
  /** Earliest target source created_at, delivery receipt or tagged webhook receipt on the number. */
  ownedSince: Date | null;
  /** Non-target delivery receipts or webhook receipts on the number at or after ownedSince. */
  foreignUseSinceOwnership: number;
};

/** A non-WhatsApp conversation channel source (no credentials loaded). */
export type PurgeChannelSource = {
  id: string;
  workspace_id: string;
  type: string;
};

export type WorkspacePreconditionInput = {
  workspaceId: string;
  targetWorkspaceIds: readonly string[];
  workspace: PurgeWorkspaceRow | null;
  company: PurgeCompanyRow | null;
  whatsappSources: readonly Source[];
  channelSources?: readonly PurgeChannelSource[];
  phoneNumberIds: readonly string[];
  phoneBindings: readonly PurgePhoneBinding[];
  phoneOwnership?: readonly PurgePhoneOwnership[];
  nonTerminalCampaignTasks: number;
  attemptedBulkDispatchDedupes: number;
  now: Date;
};

export type WorkspacePreconditionResult = {
  workspaceId: string;
  workspaceName: string | null;
  companyId: string | null;
  ok: boolean;
  failures: string[];
  notes: string[];
};

function parseTimestamp(value: unknown): number | "invalid" | null {
  if (value === null || value === undefined || value === "") return null;
  if (value === "-infinity") return Number.NEGATIVE_INFINITY;
  if (value === "infinity") return Number.POSITIVE_INFINITY;
  if (typeof value !== "string") return "invalid";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

/** Pure: dry-run reports these failures, --execute refuses on any of them. */
export function evaluateWorkspacePreconditions(
  input: WorkspacePreconditionInput,
): WorkspacePreconditionResult {
  const failures: string[] = [];
  const notes: string[] = [];
  const now = input.now.getTime();
  const targets = new Set(input.targetWorkspaceIds);
  const companyId = input.workspace?.company_id || null;

  if (!input.workspace || input.workspace.id !== input.workspaceId) {
    failures.push("workspace_not_found");
  } else if (!companyId || !UUID_PATTERN.test(companyId)) {
    failures.push("workspace_company_missing");
  } else if (!input.company || input.company.id !== companyId) {
    failures.push("company_not_found");
  }

  if (input.company && input.company.id === companyId) {
    const plan = input.company.subscription_type ?? null;
    if (plan !== null && plan !== "free") {
      failures.push(`plan_not_free:${plan}`);
    }
    const trialEndsAt = parseTimestamp(input.company.trial_ends_at);
    if (trialEndsAt === null) failures.push("trial_end_missing");
    else if (trialEndsAt === "invalid") failures.push("trial_end_invalid");
    else if (trialEndsAt > now) failures.push("trial_active");
    for (const field of [
      "billing_manual_paid_through",
      "billing_entitlement_expires_at",
    ] as const) {
      const value = parseTimestamp(input.company[field]);
      if (value === "invalid") failures.push(`${field}_invalid`);
      else if (value !== null && value > now)
        failures.push(`paid_entitlement_active:${field}`);
    }
  }

  for (const source of input.whatsappSources) {
    if (source.workspace_id !== input.workspaceId) continue;
    const skip = getWhatsAppWebhookSourceSkip(source);
    if (!skip) failures.push(`whatsapp_source_live:${source.id}`);
    else notes.push(`whatsapp_source_not_live:${source.id}:${skip.reason}`);
  }

  for (const phoneNumberId of input.phoneNumberIds) {
    if (!PHONE_NUMBER_ID_PATTERN.test(phoneNumberId))
      failures.push(`phone_number_id_invalid:${phoneNumberId.slice(0, 40)}`);
  }
  if (!input.phoneNumberIds.length) notes.push("no_whatsapp_phone_number_ids");
  const ownPhones = new Set(input.phoneNumberIds);
  for (const binding of input.phoneBindings) {
    if (!ownPhones.has(binding.phoneNumberId)) continue;
    if (binding.workspaceId === null) continue;
    if (!targets.has(binding.workspaceId)) {
      failures.push(
        `phone_bound_to_other_workspace:${binding.phoneNumberId}:${binding.workspaceId}:${binding.origin}`,
      );
    }
  }
  for (const ownership of input.phoneOwnership || []) {
    if (!ownPhones.has(ownership.phoneNumberId)) continue;
    if (!ownership.ownedSince) {
      // Receipts on the number are then selected by workspaceId only.
      notes.push(`phone_without_ownership_evidence:${ownership.phoneNumberId}`);
    } else if (ownership.foreignUseSinceOwnership > 0) {
      failures.push(
        `phone_used_by_other_workspace:${ownership.phoneNumberId}:${ownership.foreignUseSinceOwnership}`,
      );
    }
  }

  for (const source of input.channelSources || []) {
    if (source.workspace_id !== input.workspaceId) continue;
    // Reported, not refused: removing a source would delete workspace
    // configuration the owner keeps. These channels still accept messages
    // into existing conversations and recreate contact docs on every inbound.
    notes.push(`channel_source_connected:${source.type}:${source.id}`);
  }

  if (input.nonTerminalCampaignTasks > 0) {
    failures.push(
      `campaign_delivery_tasks_non_terminal:${input.nonTerminalCampaignTasks}`,
    );
  }
  if (input.attemptedBulkDispatchDedupes > 0) {
    notes.push(
      `bulk_dispatch_attempted_kept:${input.attemptedBulkDispatchDedupes}`,
    );
  }

  return {
    workspaceId: input.workspaceId,
    workspaceName: input.workspace?.name ?? null,
    companyId,
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    notes,
  };
}

// ------------------------------------------------------------------ storage

export const PURGE_STORAGE_BUCKETS = [
  "conversation-images",
  "conversation-attachments",
  "email-attachments",
] as const;

export const PURGE_BUSINESS_STORAGE_PREFIXES = [
  "scenarios/",
  "whatsapp-template-headers/",
  "studio/",
  "workspaces/",
  "kb/",
] as const;

/** Folder prefixes that hold a workspace's chat media in a bucket. */
export function buildWorkspaceStoragePrefixes(
  bucket: string,
  workspaceId: string,
): string[] {
  if (!UUID_PATTERN.test(workspaceId)) return [];
  if (bucket === "email-attachments") return [workspaceId];
  if (!(PURGE_STORAGE_BUCKETS as readonly string[]).includes(bucket)) return [];
  return CONVERSATION_CHANNELS.flatMap((channel) => [
    `${channel}/${workspaceId}`,
    `outbound/${channel}/${workspaceId}`,
  ]);
}

/**
 * Pure: the target workspace that owns a chat media object, using the shared
 * bucket/path ownership rule, or null when the object must not be deleted.
 */
export function resolvePurgeableStorageWorkspace(
  bucket: string,
  objectPath: string,
  targetWorkspaceIds: ReadonlySet<string>,
): string | null {
  if (!(PURGE_STORAGE_BUCKETS as readonly string[]).includes(bucket))
    return null;
  if (
    PURGE_BUSINESS_STORAGE_PREFIXES.some((prefix) =>
      objectPath.startsWith(prefix),
    )
  )
    return null;
  if (objectPath.split("/").some((part) => !part || part === "..")) return null;
  const workspaceId = storageObjectOwnerWorkspaceId(bucket, objectPath);
  return workspaceId && targetWorkspaceIds.has(workspaceId)
    ? workspaceId
    : null;
}

// ----------------------------------------------------------------- contacts

export type PurgeContactId = string | number;

function contactKey(value: PurgeContactId): string {
  return typeof value === "number" ? `n:${value}` : `s:${value}`;
}

/** Keeps only primitive chat/user references; embedded objects are dropped. */
export function normalizeContactIds(
  values: readonly unknown[],
): PurgeContactId[] {
  const result = new Map<string, PurgeContactId>();
  for (const value of values) {
    if (typeof value === "string" && value.length > 0)
      result.set(contactKey(value), value);
    else if (typeof value === "number" && Number.isFinite(value))
      result.set(contactKey(value), value);
  }
  return [...result.values()];
}

/** The AIRI bot (0) and Supabase-UUID manager ids are never deleted. */
export function isProtectedContactId(value: unknown): boolean {
  if (value === 0 || value === "0") return true;
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function partitionContactCandidates(
  candidates: readonly unknown[],
  referenced: readonly unknown[],
): {
  deletable: PurgeContactId[];
  shared: PurgeContactId[];
  protectedIds: PurgeContactId[];
} {
  const referencedKeys = new Set(
    normalizeContactIds(referenced).map(contactKey),
  );
  const deletable: PurgeContactId[] = [];
  const shared: PurgeContactId[] = [];
  const protectedIds: PurgeContactId[] = [];
  for (const id of normalizeContactIds(candidates)) {
    if (isProtectedContactId(id)) protectedIds.push(id);
    else if (referencedKeys.has(contactKey(id))) shared.push(id);
    else deletable.push(id);
  }
  return { deletable, shared, protectedIds };
}

// ----------------------------------------------------------------- temporal

const CHAT_WORKFLOW_FAMILIES: ReadonlySet<string> = new Set([
  "airi-conversation",
  "airi-coach",
  "widget-csat",
  "conversation-media-analysis",
  "whatsapp-call",
  "scenario-generation",
]);
const CAMPAIGN_WORKFLOW_FAMILIES: ReadonlySet<string> = new Set([
  "bulk-campaign-dispatch",
  "campaign-node-run",
]);

export type PurgeWorkflowAction = "terminate" | "keep" | "blocker";

/**
 * Pure: what to do with a RUNNING workflow. Ids are matched by exact
 * ":"-separated tokens, never by substring, so another tenant's id that merely
 * contains a target id cannot match.
 */
export function classifyRunningWorkflow(
  workflowId: string,
  targets: {
    workspaceIds: ReadonlySet<string>;
    conversationIds: ReadonlySet<string>;
    generativeExecutionIds: ReadonlySet<string>;
  },
): { action: PurgeWorkflowAction; reason: string } | null {
  const [family = "", ...tokens] = workflowId.split(":");
  if (tokens.some((token) => targets.conversationIds.has(token.toLowerCase())))
    return { action: "terminate", reason: "target_conversation" };
  if (
    family === "scenario-generation" &&
    targets.generativeExecutionIds.has(tokens.join(":"))
  )
    return { action: "terminate", reason: "target_generative_execution" };
  if (!tokens.some((token) => targets.workspaceIds.has(token.toLowerCase())))
    return null;
  if (CHAT_WORKFLOW_FAMILIES.has(family))
    return { action: "terminate", reason: "target_workspace_chat_workflow" };
  if (CAMPAIGN_WORKFLOW_FAMILIES.has(family)) {
    // The long-lived ":scheduled" parent is the workspace's saved schedule.
    return workflowId.endsWith(":scheduled")
      ? { action: "keep", reason: "workspace_campaign_schedule" }
      : { action: "blocker", reason: "campaign_dispatch_running" };
  }
  return { action: "keep", reason: "workspace_workflow_not_chat" };
}

// ------------------------------------------------------------ Mongo filters

export type PurgeFilter = Record<string, unknown>;
export type PurgeDocument = Record<string, unknown>;

export function buildOutboxWorkspaceSelector(
  workspaceIds: readonly string[],
): PurgeFilter {
  // Payload shapes from apps/web/src/lib/cross-store-outbox.ts: most operations
  // carry payload.workspaceId; campaign status updates carry
  // payload.realtime.workspaceId; campaign attempts carry
  // payload.insertIfMissing.workspaceId; LLM analytics batches carry
  // payload.events[].workspace_id with chat excerpts. An analytics batch is
  // selected only when every event is a target's (mixed batches block the
  // run, see buildOutboxMixedWorkspaceFilter). Campaign ledger rows without a
  // workspace field are left alone.
  return {
    $or: [
      { "payload.workspaceId": { $in: [...workspaceIds] } },
      { "payload.realtime.workspaceId": { $in: [...workspaceIds] } },
      { "payload.insertIfMissing.workspaceId": { $in: [...workspaceIds] } },
      {
        operation: LLM_ANALYTICS_OUTBOX_OPERATION,
        "payload.events.workspace_id": { $in: [...workspaceIds] },
        "payload.events": {
          $not: { $elemMatch: { workspace_id: { $nin: [...workspaceIds] } } },
        },
      },
    ],
  };
}

/** LLM analytics batches that mix target and non-target events. */
export function buildOutboxMixedWorkspaceFilter(
  workspaceIds: readonly string[],
): PurgeFilter {
  return {
    operation: LLM_ANALYTICS_OUTBOX_OPERATION,
    "payload.events.workspace_id": { $in: [...workspaceIds] },
    "payload.events": {
      $elemMatch: { workspace_id: { $nin: [...workspaceIds] } },
    },
  };
}

export function buildOutboxDeletableFilter(
  workspaceIds: readonly string[],
  staleProcessingBefore: Date,
): PurgeFilter {
  return {
    $and: [
      buildOutboxWorkspaceSelector(workspaceIds),
      {
        $or: [
          { status: { $in: ["pending", "failed", "completed"] } },
          {
            status: "processing",
            $or: [
              { processingStartedAt: null },
              { processingStartedAt: { $lte: staleProcessingBefore } },
            ],
          },
        ],
      },
    ],
  };
}

export function buildOutboxLiveProcessingFilter(
  workspaceIds: readonly string[],
  staleProcessingBefore: Date,
): PurgeFilter {
  return {
    $and: [
      buildOutboxWorkspaceSelector(workspaceIds),
      {
        status: "processing",
        processingStartedAt: { $gt: staleProcessingBefore },
      },
    ],
  };
}

// The model's terminal statuses: the drain and the processor never pick these
// up again. Anything else (including an unexpected value) is moved to "dead".
export const PURGE_WEBHOOK_TERMINAL_STATUSES = [
  "completed",
  "dead",
] as const satisfies readonly WhatsAppWebhookEventStatus[];

export type PurgePhoneWindow = { phoneNumberId: string; ownedSince: Date };

/**
 * Receipts tagged with a target workspace (history imports), plus untagged
 * live receipts on a target number created since a target owned it. A
 * receipt that names another workspace, or predates the target's ownership
 * of the number, is never selected.
 */
export function buildWebhookReceiptSelector(
  workspaceIds: readonly string[],
  phoneWindows: readonly PurgePhoneWindow[],
): PurgeFilter {
  const clauses: PurgeFilter[] = [{ workspaceId: { $in: [...workspaceIds] } }];
  for (const window of phoneWindows) {
    clauses.push({
      phoneNumberId: window.phoneNumberId,
      workspaceId: null,
      createdAt: { $gte: window.ownedSince },
    });
  }
  return { $or: clauses };
}

/** Pure: per-number ownership windows; numbers without evidence get none. */
export function buildPhoneWindows(
  ownership: readonly PurgePhoneOwnership[],
): PurgePhoneWindow[] {
  return ownership.flatMap((entry) =>
    entry.ownedSince && PHONE_NUMBER_ID_PATTERN.test(entry.phoneNumberId)
      ? [{ phoneNumberId: entry.phoneNumberId, ownedSince: entry.ownedSince }]
      : [],
  );
}

const WEBHOOK_NOT_TERMINAL: PurgeFilter = {
  status: { $nin: [...PURGE_WEBHOOK_TERMINAL_STATUSES] },
};

const WEBHOOK_NEEDS_WORK: PurgeFilter = {
  $or: [
    { payloadCompactedAt: null },
    { payload: { $exists: true } },
    { processingCursor: { $ne: null } },
    WEBHOOK_NOT_TERMINAL,
  ],
};

// -------------------------------------------------------------------- ports

export type PurgeMongoCollection = {
  countDocuments(filter: PurgeFilter): Promise<number>;
  find(
    filter: PurgeFilter,
    options: {
      projection: Record<string, 1>;
      limit?: number;
      sort?: Record<string, 1 | -1>;
    },
  ): Promise<PurgeDocument[]>;
  distinct(field: string, filter: PurgeFilter): Promise<unknown[]>;
  deleteMany(filter: PurgeFilter): Promise<number>;
  updateMany(filter: PurgeFilter, update: PurgeDocument): Promise<number>;
};

export type PurgeMongoPort = {
  collection(name: string): PurgeMongoCollection;
  /**
   * Cluster time (BSON Timestamp as an unsigned 64-bit integer) of the most
   * recent write's server response; compared with the requests projector
   * checkpoint to wait until the projector has handled that write.
   */
  lastWriteTime(): bigint | null;
};

export type PurgeStorageObject = {
  bucket: string;
  path: string;
  bytes: number;
};

export type PurgeSupabasePort = {
  getWorkspaces(workspaceIds: readonly string[]): Promise<PurgeWorkspaceRow[]>;
  getCompanies(companyIds: readonly string[]): Promise<PurgeCompanyRow[]>;
  /** WhatsApp sources with credential flags only; tokens are never loaded. */
  listWhatsAppSources(workspaceIds: readonly string[]): Promise<Source[]>;
  /** Telegram, Instagram, widget and email sources (id and type only). */
  listChannelSources(
    workspaceIds: readonly string[],
  ): Promise<PurgeChannelSource[]>;
  /** Source/account bindings for the workspaces (source-bound rows only). */
  listWorkspacePhoneBindings(
    workspaceIds: readonly string[],
  ): Promise<PurgePhoneBinding[]>;
  /** Every source/account binding of the phone numbers, any workspace. */
  listPhoneBindings(
    phoneNumberIds: readonly string[],
  ): Promise<PurgePhoneBinding[]>;
  listStorageObjects(
    bucket: string,
    prefix: string,
  ): AsyncIterable<PurgeStorageObject>;
  removeStorageObjects(
    bucket: string,
    paths: readonly string[],
  ): Promise<number>;
  countConversationSummaries(workspaceId: string): Promise<number>;
  listConversationSummaryIds(
    workspaceId: string,
    limit: number,
  ): Promise<string[]>;
  deleteConversationSummaries(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<number>;
};

export type PurgeStorageLedgerPort = {
  read(id: string): Promise<{ workspaceId: string; status: string } | null>;
  tombstone(id: string): Promise<void>;
};

export type PurgeTemporalWorkflow = {
  workflowId: string;
  runId: string;
  type: string;
};

export type PurgeTemporalPort = {
  listRunning(): AsyncIterable<PurgeTemporalWorkflow>;
  /**
   * Terminates the CURRENT run of the workflow id (never a pinned run id, so a
   * continue-as-new successor or a restarted run is hit). "not_running" only
   * when a describe confirms no run is open.
   */
  terminate(
    workflowId: string,
    reason: string,
  ): Promise<"terminated" | "not_running">;
  isRunning(workflowId: string): Promise<boolean>;
};

export type PurgeDependencies = {
  mongo: PurgeMongoPort;
  supabase: PurgeSupabasePort;
  ledger: PurgeStorageLedgerPort;
  temporal: PurgeTemporalPort | null;
  temporalUnavailableReason?: string | null;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Prints one JSON document to stdout (plan before work, result after). */
  emit: (document: Record<string, unknown>) => void;
  /** Progress line on stderr. */
  progress: (event: Record<string, unknown>) => void;
  /** Creates a new file; must fail if it exists (flag "wx"). */
  writeNewFile: (filePath: string, content: string) => Promise<void>;
  readTextFile: (filePath: string) => Promise<string>;
};

// ------------------------------------------------------------------- runner

type ConversationId = mongoose.Types.ObjectId | string;

type TargetFacts = {
  conversationIds: ConversationId[];
  conversationHexIds: Set<string>;
  chatCandidates: PurgeContactId[];
  userCandidates: PurgeContactId[];
  generativeExecutionIds: Set<string>;
  conversationsByWorkspace: Record<string, number>;
  recordedMarketingOptOuts: number;
  groupConversations: number;
  /** Tagged contact docs that no target conversation references. */
  taggedChatsOutsideConversations: number;
  taggedUsersOutsideConversations: number;
};

type PlannedStorageObject = PurgeStorageObject & {
  workspaceId: string;
  ledgerId: string;
};

export type PurgeProjectorState = {
  present: boolean;
  state: string | null;
  generationMode: string | null;
  leaseLive: boolean;
  committedThrough: bigint | null;
};

type RunContext = {
  options: PurgeWorkspaceChatDataOptions;
  deps: PurgeDependencies;
  targets: string[];
  targetSet: ReadonlySet<string>;
  startedAt: Date;
  /** Read once before execution; null until then. */
  projector: PurgeProjectorState | null;
};

function toHexId(value: unknown): string | null {
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (typeof value === "string" && OBJECT_ID_PATTERN.test(value))
    return value.toLowerCase();
  return null;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function readPath(document: PurgeDocument, dotted: string): unknown {
  let current: unknown = document;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function pause(ctx: RunContext) {
  if (ctx.options.pauseMs > 0) await ctx.deps.sleep(ctx.options.pauseMs);
}

/** BSON Timestamp (or an already converted bigint) as an unsigned integer. */
export function clusterTimeToBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (value instanceof mongoose.mongo.Timestamp) return value.toBigInt();
  // A Timestamp from another bson copy fails instanceof; read it by its tag.
  const candidate = value as {
    _bsontype?: unknown;
    toBigInt?: () => bigint;
  } | null;
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate._bsontype === "Timestamp" &&
    typeof candidate.toBigInt === "function"
  )
    return candidate.toBigInt();
  return null;
}

async function readProjectorState(
  ctx: RunContext,
): Promise<PurgeProjectorState> {
  const [row] = await ctx.deps.mongo
    .collection(REQUESTS_PROJECTION_CHECKPOINTS)
    .find(
      { _id: REQUESTS_PROJECTION_CHECKPOINT_ID },
      {
        projection: {
          state: 1,
          generationMode: 1,
          clusterTime: 1,
          "lease.expiresAt": 1,
        },
        limit: 1,
      },
    );
  if (!row) {
    return {
      present: false,
      state: null,
      generationMode: null,
      leaseLive: false,
      committedThrough: null,
    };
  }
  const expiresAt = readPath(row, "lease.expiresAt");
  return {
    present: true,
    state: typeof row.state === "string" ? row.state : null,
    // A checkpoint without the field is a legacy cluster-time generation
    // (normalizeRequestsProjectionCheckpoint in apps/web).
    generationMode:
      typeof row.generationMode === "string"
        ? row.generationMode
        : "cluster_time_v1",
    leaseLive:
      expiresAt instanceof Date &&
      expiresAt.getTime() > ctx.deps.now().getTime(),
    committedThrough: clusterTimeToBigInt(row.clusterTime),
  };
}

/**
 * Called right after a write to a projector-watched collection removed rows:
 * waits until the requests projector has committed past that write, so every
 * tenant's inbox lag stays bounded by one batch, and the projector never races
 * a later delete of the rows it writes.
 */
async function awaitProjector(ctx: RunContext, step: PurgeExecutionStep) {
  if (!ctx.projector?.present) return;
  const target = ctx.deps.mongo.lastWriteTime();
  if (target === null) {
    // Never continue unthrottled: without the write's cluster time there is
    // nothing to compare the projector checkpoint with.
    throw new PurgeOperatorError(
      `the cluster time of a ${step} write is unknown; cannot wait for the requests projector`,
    );
  }
  const deadline = ctx.deps.now().getTime() + ctx.options.maxProjectorWaitMs;
  for (;;) {
    const state = await readProjectorState(ctx);
    if (state.committedThrough !== null && state.committedThrough >= target)
      return;
    if (ctx.deps.now().getTime() >= deadline) {
      throw new PurgeOperatorError(
        `requests projector did not catch up within ${ctx.options.maxProjectorWaitMs} ms after a ${step} batch; re-run later to continue`,
      );
    }
    await ctx.deps.sleep(PURGE_PROJECTOR_POLL_MS);
  }
}

/**
 * Deletes every row matching `filter` in _id pages. Deleted rows leave the
 * index, so each page starts fresh without a cursor; the delete filter repeats
 * the selection filter so a row that changed in between is never removed.
 * Pages of projector-watched collections wait for the projector.
 */
async function drainDelete(
  ctx: RunContext,
  step: PurgeExecutionStep,
  collectionName: string,
  filter: PurgeFilter,
): Promise<number> {
  const collection = ctx.deps.mongo.collection(collectionName);
  let deleted = 0;
  for (;;) {
    const page = await collection.find(filter, {
      projection: { _id: 1 },
      limit: ctx.options.batchSize,
    });
    if (!page.length) return deleted;
    const removed = await collection.deleteMany({
      $and: [{ _id: { $in: page.map((row) => row._id) } }, filter],
    });
    if (removed === 0) {
      throw new PurgeOperatorError(
        `${collectionName}: a delete batch made no progress; re-run to continue`,
      );
    }
    deleted += removed;
    if (PROJECTOR_WATCHED_COLLECTIONS.has(collectionName))
      await awaitProjector(ctx, step);
    ctx.deps.progress({ step, collection: collectionName, deleted });
    await pause(ctx);
  }
}

/**
 * For collections without an index on the filter: one scan collects the ids,
 * then _id pages are deleted with the filter repeated as a guard. A row that
 * changed after the scan (for example an outbox row claimed by the drain) is
 * skipped, never deleted.
 */
async function deleteScannedIds(
  ctx: RunContext,
  step: PurgeExecutionStep,
  collectionName: string,
  filter: PurgeFilter,
): Promise<number> {
  const collection = ctx.deps.mongo.collection(collectionName);
  const ids = (await collection.find(filter, { projection: { _id: 1 } })).map(
    (row) => row._id,
  );
  let deleted = 0;
  for (const batch of chunk(ids, ctx.options.batchSize)) {
    deleted += await collection.deleteMany({
      $and: [{ _id: { $in: batch } }, filter],
    });
    ctx.deps.progress({ step, collection: collectionName, deleted });
    await pause(ctx);
  }
  return deleted;
}

async function collectTargetFacts(
  ctx: RunContext,
  resume: ResumeState | null,
): Promise<TargetFacts> {
  const rows = await ctx.deps.mongo.collection(CONVERSATIONS).find(
    { workspaceId: { $in: ctx.targets } },
    {
      projection: {
        _id: 1,
        workspaceId: 1,
        chat: 1,
        user: 1,
        "airi_pending_generative_execution.executionId": 1,
        "whatsapp_opt_in.status": 1,
        "whatsapp_opt_in.source": 1,
        "whatsappGroup.groupId": 1,
      },
    },
  );
  const consentSources: ReadonlySet<string> = new Set(
    WHATSAPP_MARKETING_CONSENT_SOURCES,
  );
  const conversationIds = new Map<string, ConversationId>();
  const chats: unknown[] = [...(resume?.chatIds || [])];
  const users: unknown[] = [...(resume?.userIds || [])];
  const generativeExecutionIds = new Set(resume?.generativeExecutionIds || []);
  const conversationsByWorkspace: Record<string, number> = {};
  let recordedMarketingOptOuts = 0;
  let groupConversations = 0;
  for (const hex of resume?.conversationIds || []) {
    conversationIds.set(hex, new mongoose.Types.ObjectId(hex));
  }
  if (resume?.conversationIds.length) {
    // A manifest id that still belongs to another workspace means the file
    // was edited or mixed up; legacy messages without workspaceId would
    // otherwise be selected by conversation id alone.
    for (const batch of chunk([...conversationIds.values()], 1000)) {
      const foreign = await ctx.deps.mongo
        .collection(CONVERSATIONS)
        .countDocuments({
          _id: { $in: batch },
          workspaceId: { $nin: ctx.targets },
        });
      if (foreign > 0)
        throw new PurgeOperatorError(
          "--resume-manifest names conversations of a non-target workspace",
        );
    }
  }
  for (const row of rows) {
    const workspaceId = String(row.workspaceId);
    if (!ctx.targetSet.has(workspaceId)) {
      throw new PurgeOperatorError(
        "Conversation selection returned a non-target workspace; aborting",
      );
    }
    conversationsByWorkspace[workspaceId] =
      (conversationsByWorkspace[workspaceId] || 0) + 1;
    const hex = toHexId(row._id);
    if (!hex) {
      throw new PurgeOperatorError(
        "A target conversation has a non-ObjectId _id; aborting",
      );
    }
    conversationIds.set(hex, row._id as ConversationId);
    chats.push(row.chat);
    users.push(row.user);
    const executionId = readPath(
      row,
      "airi_pending_generative_execution.executionId",
    );
    if (typeof executionId === "string" && executionId)
      generativeExecutionIds.add(executionId);
    if (
      readPath(row, "whatsapp_opt_in.status") === false &&
      consentSources.has(String(readPath(row, "whatsapp_opt_in.source") || ""))
    )
      recordedMarketingOptOuts += 1;
    if (readPath(row, "whatsappGroup.groupId")) groupConversations += 1;
  }
  const referencedChats = normalizeContactIds(chats);
  const referencedUsers = normalizeContactIds(users);
  const tagged = await collectTaggedContacts(ctx);
  const chatCandidates = normalizeContactIds([
    ...referencedChats,
    ...tagged.chatIds,
  ]);
  const userCandidates = normalizeContactIds([
    ...referencedUsers,
    ...tagged.userIds,
  ]);
  return {
    conversationIds: [...conversationIds.values()],
    conversationHexIds: new Set(conversationIds.keys()),
    chatCandidates,
    userCandidates,
    generativeExecutionIds,
    conversationsByWorkspace,
    recordedMarketingOptOuts,
    groupConversations,
    taggedChatsOutsideConversations:
      chatCandidates.length - referencedChats.length,
    taggedUsersOutsideConversations:
      userCandidates.length - referencedUsers.length,
  };
}

/**
 * Contact docs tagged with a target workspace, including ones whose
 * conversation is already gone (deleted from the inbox, or by an interrupted
 * earlier run). They are only candidates: the reference checks still decide
 * what is deleted. Bot accounts (Telegram bots) are never candidates.
 * chats.workspaceId and users.workspaceId lead single-field indexes.
 */
async function collectTaggedContacts(
  ctx: RunContext,
): Promise<{ chatIds: PurgeContactId[]; userIds: PurgeContactId[] }> {
  const { mongo } = ctx.deps;
  const chatRows = await mongo
    .collection(CHATS)
    .find({ workspaceId: { $in: ctx.targets } }, { projection: { _id: 1 } });
  const userRows = await mongo
    .collection(USERS)
    .find(
      { workspaceId: { $in: ctx.targets }, isBot: { $ne: true } },
      { projection: { _id: 1 } },
    );
  return {
    chatIds: normalizeContactIds(chatRows.map((row) => row._id)),
    userIds: normalizeContactIds(userRows.map((row) => row._id)),
  };
}

type ResumeState = {
  conversationIds: string[];
  chatIds: PurgeContactId[];
  userIds: PurgeContactId[];
  generativeExecutionIds: string[];
};

/** Validates a manifest written by an earlier run of the same targets. */
export function parseResumeManifest(
  content: string,
  workspaceIds: readonly string[],
): ResumeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PurgeOperatorError("--resume-manifest is not valid JSON");
  }
  const manifest = parsed as Record<string, unknown> | null;
  const candidates = (manifest?.candidates || null) as Record<
    string,
    unknown
  > | null;
  const manifestTargets = manifest?.workspaceIds;
  if (
    !manifest ||
    manifest.tool !== PURGE_TOOL_NAME ||
    manifest.version !== 1 ||
    !candidates ||
    !Array.isArray(manifestTargets) ||
    manifestTargets.length !== workspaceIds.length ||
    !workspaceIds.every((id) => manifestTargets.includes(id))
  ) {
    throw new PurgeOperatorError(
      "--resume-manifest was not written by this operator for the same --workspace-id set",
    );
  }
  const list = (key: string) => {
    const value = candidates[key];
    if (!Array.isArray(value))
      throw new PurgeOperatorError(`--resume-manifest lacks ${key}`);
    return value as unknown[];
  };
  const conversationIds = list("conversationIds");
  if (!conversationIds.every((id) => toHexId(id)))
    throw new PurgeOperatorError(
      "--resume-manifest has invalid conversation ids",
    );
  const contacts = (key: string) => {
    const values = list(key);
    if (normalizeContactIds(values).length !== values.length)
      throw new PurgeOperatorError(`--resume-manifest has invalid ${key}`);
    return normalizeContactIds(values);
  };
  const generativeExecutionIds = list("generativeExecutionIds");
  if (!generativeExecutionIds.every((id) => typeof id === "string" && id))
    throw new PurgeOperatorError(
      "--resume-manifest has invalid generative execution ids",
    );
  return {
    conversationIds: conversationIds.map((id) => toHexId(id)!),
    chatIds: contacts("chatIds"),
    userIds: contacts("userIds"),
    generativeExecutionIds: generativeExecutionIds as string[],
  };
}

/**
 * When the targets started using each number, and whether another workspace
 * used it since. Evidence: target WhatsApp source created_at, the first
 * target delivery receipt and the first target-tagged webhook receipt on the
 * number. Foreign use: delivery receipts of other workspaces and webhook
 * receipts tagged with another workspace (history imports).
 */
async function collectPhoneOwnership(
  ctx: RunContext,
  phoneNumberIds: readonly string[],
  sources: readonly Source[],
): Promise<PurgePhoneOwnership[]> {
  const { mongo } = ctx.deps;
  const result: PurgePhoneOwnership[] = [];
  for (const phoneNumberId of phoneNumberIds) {
    const evidence: number[] = [];
    for (const source of sources) {
      if (!ctx.targetSet.has(source.workspace_id)) continue;
      const credentials = source.credentials as unknown as Record<
        string,
        unknown
      > | null;
      if (String(credentials?.phone_number_id ?? "").trim() !== phoneNumberId)
        continue;
      const createdAt = parseTimestamp(source.created_at);
      if (typeof createdAt === "number" && Number.isFinite(createdAt))
        evidence.push(createdAt);
    }
    for (const name of [MESSAGE_DELIVERY_EVENTS, WEBHOOK_EVENTS]) {
      const [first] = await mongo
        .collection(name)
        .find(
          { workspaceId: { $in: ctx.targets }, phoneNumberId },
          { projection: { createdAt: 1 }, sort: { createdAt: 1 }, limit: 1 },
        );
      if (first?.createdAt instanceof Date)
        evidence.push(first.createdAt.getTime());
    }
    const ownedSince = evidence.length ? new Date(Math.min(...evidence)) : null;
    let foreignUseSinceOwnership = 0;
    if (ownedSince) {
      foreignUseSinceOwnership += await mongo
        .collection(MESSAGE_DELIVERY_EVENTS)
        .countDocuments({
          phoneNumberId,
          workspaceId: { $nin: ctx.targets },
          createdAt: { $gte: ownedSince },
        });
      foreignUseSinceOwnership += await mongo
        .collection(WEBHOOK_EVENTS)
        .countDocuments({
          phoneNumberId,
          workspaceId: { $nin: [...ctx.targets, null] },
          createdAt: { $gte: ownedSince },
        });
    }
    result.push({ phoneNumberId, ownedSince, foreignUseSinceOwnership });
  }
  return result;
}

async function collectWorkspacePreconditions(ctx: RunContext): Promise<{
  results: WorkspacePreconditionResult[];
  phoneNumberIds: string[];
  phoneOwnership: PurgePhoneOwnership[];
  channelSources: PurgeChannelSource[];
  companyIds: string[];
}> {
  const { supabase, mongo } = ctx.deps;
  const workspaces = await supabase.getWorkspaces(ctx.targets);
  const companyIds = [
    ...new Set(
      workspaces
        .map((row) => row.company_id || "")
        .filter((id) => UUID_PATTERN.test(id)),
    ),
  ];
  const companies = companyIds.length
    ? await supabase.getCompanies(companyIds)
    : [];
  const sources = await supabase.listWhatsAppSources(ctx.targets);
  const channelSources = await supabase.listChannelSources(ctx.targets);
  const accountBindings = await supabase.listWorkspacePhoneBindings(
    ctx.targets,
  );
  const phonesByWorkspace = new Map<string, Set<string>>(
    ctx.targets.map((id) => [id, new Set<string>()]),
  );
  const addPhone = (workspaceId: unknown, phone: unknown) => {
    if (typeof phone !== "string" || !phone.trim()) return;
    phonesByWorkspace.get(String(workspaceId))?.add(phone.trim());
  };
  for (const source of sources) {
    const credentials = source.credentials as unknown as Record<
      string,
      unknown
    >;
    addPhone(source.workspace_id, credentials?.phone_number_id);
  }
  for (const binding of accountBindings)
    addPhone(binding.workspaceId, binding.phoneNumberId);
  for (const workspaceId of ctx.targets) {
    // Historic numbers of the workspace, from its own delivery receipts.
    const phones = await mongo
      .collection(MESSAGE_DELIVERY_EVENTS)
      .distinct("phoneNumberId", { workspaceId });
    for (const phone of phones) addPhone(workspaceId, phone);
  }
  const allPhones = [
    ...new Set([...phonesByWorkspace.values()].flatMap((set) => [...set])),
  ];
  const validPhones = allPhones.filter((phone) =>
    PHONE_NUMBER_ID_PATTERN.test(phone),
  );
  const phoneBindings = validPhones.length
    ? await supabase.listPhoneBindings(validPhones)
    : [];
  const phoneOwnership = await collectPhoneOwnership(ctx, validPhones, sources);
  const results: WorkspacePreconditionResult[] = [];
  for (const workspaceId of ctx.targets) {
    const workspace = workspaces.find((row) => row.id === workspaceId) || null;
    const company =
      companies.find((row) => row.id === workspace?.company_id) || null;
    const [nonTerminalCampaignTasks, attemptedBulkDispatchDedupes] =
      await Promise.all([
        mongo.collection(CAMPAIGN_DELIVERY_TASKS).countDocuments({
          workspaceId,
          status: { $in: ["pending", "processing", "retry"] },
        }),
        mongo
          .collection(BULK_DISPATCH_DEDUPES)
          .countDocuments({ workspaceId, state: "attempted" }),
      ]);
    results.push(
      evaluateWorkspacePreconditions({
        workspaceId,
        targetWorkspaceIds: ctx.targets,
        workspace,
        company,
        whatsappSources: sources,
        channelSources,
        phoneNumberIds: [...(phonesByWorkspace.get(workspaceId) || [])],
        phoneBindings,
        phoneOwnership,
        nonTerminalCampaignTasks,
        attemptedBulkDispatchDedupes,
        now: ctx.startedAt,
      }),
    );
  }
  return {
    results,
    phoneNumberIds: validPhones,
    phoneOwnership,
    channelSources,
    companyIds,
  };
}

type TemporalPlan = {
  configured: boolean;
  unavailableReason: string | null;
  scanned: number;
  terminate: Array<PurgeTemporalWorkflow & { reason: string }>;
  keep: Array<PurgeTemporalWorkflow & { reason: string }>;
  blockers: Array<PurgeTemporalWorkflow & { reason: string }>;
};

async function planTemporal(
  ctx: RunContext,
  facts: TargetFacts,
): Promise<TemporalPlan> {
  const plan: TemporalPlan = {
    configured: Boolean(ctx.deps.temporal),
    unavailableReason: ctx.deps.temporalUnavailableReason || null,
    scanned: 0,
    terminate: [],
    keep: [],
    blockers: [],
  };
  if (!ctx.deps.temporal) return plan;
  const targets = {
    workspaceIds: ctx.targetSet,
    conversationIds: facts.conversationHexIds,
    generativeExecutionIds: facts.generativeExecutionIds,
  };
  for await (const workflow of ctx.deps.temporal.listRunning()) {
    plan.scanned += 1;
    if (plan.scanned > TEMPORAL_SCAN_LIMIT)
      throw new PurgeOperatorError(
        "Temporal running-workflow scan limit reached",
      );
    const decision = classifyRunningWorkflow(workflow.workflowId, targets);
    if (!decision) continue;
    const entry = { ...workflow, reason: decision.reason };
    if (decision.action === "terminate") plan.terminate.push(entry);
    else if (decision.action === "keep") plan.keep.push(entry);
    else plan.blockers.push(entry);
  }
  return plan;
}

/**
 * Lists running workflows afresh and terminates every target chat workflow
 * by workflow id (the current run). Run at the start, after the side
 * collections and conversations are gone, and at the end, so a run that
 * continued-as-new or was restarted by the ingress retry cron is caught.
 */
async function sweepTemporal(
  ctx: RunContext,
  facts: TargetFacts,
  terminatedIds: Set<string>,
): Promise<{ scanned: number; terminated: number; alreadyClosed: number }> {
  const temporal = ctx.deps.temporal;
  if (!temporal) throw new PurgeOperatorError("Temporal is not configured");
  const plan = await planTemporal(ctx, facts);
  if (plan.blockers.length) {
    throw new PurgeOperatorError(
      `${plan.blockers.length} campaign dispatch workflow(s) of a target are running`,
    );
  }
  let terminated = 0;
  let alreadyClosed = 0;
  for (const workflow of plan.terminate) {
    const outcome = await temporal.terminate(
      workflow.workflowId,
      PURGE_TERMINATE_REASON,
    );
    terminatedIds.add(workflow.workflowId);
    if (outcome === "terminated") terminated += 1;
    else alreadyClosed += 1;
    if ((terminated + alreadyClosed) % ctx.options.batchSize === 0)
      await pause(ctx);
  }
  return { scanned: plan.scanned, terminated, alreadyClosed };
}

async function collectStorageObjects(
  ctx: RunContext,
): Promise<{ objects: PlannedStorageObject[]; ignored: number }> {
  const objects: PlannedStorageObject[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const workspaceId of ctx.targets) {
    for (const bucket of PURGE_STORAGE_BUCKETS) {
      for (const prefix of buildWorkspaceStoragePrefixes(bucket, workspaceId)) {
        for await (const object of ctx.deps.supabase.listStorageObjects(
          bucket,
          prefix,
        )) {
          if (
            object.bucket !== bucket ||
            !object.path.startsWith(`${prefix}/`) ||
            resolvePurgeableStorageWorkspace(
              object.bucket,
              object.path,
              ctx.targetSet,
            ) !== workspaceId
          ) {
            ignored += 1;
            continue;
          }
          const key = `${bucket}\0${object.path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          objects.push({
            ...object,
            workspaceId,
            ledgerId: storageObjectId({
              provider: "supabase",
              bucket,
              path: object.path,
            }),
          });
        }
      }
    }
  }
  return { objects, ignored };
}

async function findReferencedContacts(
  ctx: RunContext,
  candidates: readonly PurgeContactId[],
  scope: "other_workspaces" | "any_remaining",
): Promise<PurgeContactId[]> {
  const referenced: unknown[] = [];
  const conversations = ctx.deps.mongo.collection(CONVERSATIONS);
  for (const batch of chunk(candidates, ctx.options.batchSize)) {
    const reference = {
      $or: [{ chat: { $in: batch } }, { user: { $in: batch } }],
    };
    const rows = await conversations.find(
      scope === "other_workspaces"
        ? { $and: [{ workspaceId: { $nin: ctx.targets } }, reference] }
        : reference,
      { projection: { chat: 1, user: 1 } },
    );
    for (const row of rows) referenced.push(row.chat, row.user);
  }
  return normalizeContactIds(referenced);
}

/**
 * Group members other than the first sender are referenced only through the
 * group chat's participants (and messages.author, which has no index): WhatsApp
 * and Telegram group ingest add every member's user id there. A user listed by
 * a chat that is not itself being deleted is kept. chats.participants has no
 * index either, so this scans chats once per CONTACT_PARTICIPANT_SCAN_CHUNK
 * candidates.
 */
async function findParticipantReferences(
  ctx: RunContext,
  userCandidates: readonly PurgeContactId[],
  chatsBeingDeleted: readonly PurgeContactId[],
): Promise<PurgeContactId[]> {
  const candidates = userCandidates.filter((id) => !isProtectedContactId(id));
  const candidateKeys = new Set(candidates.map(contactKey));
  const referenced: unknown[] = [];
  const chats = ctx.deps.mongo.collection(CHATS);
  for (const batch of chunk(candidates, CONTACT_PARTICIPANT_SCAN_CHUNK)) {
    const rows = await chats.find(
      { participants: { $in: batch }, _id: { $nin: [...chatsBeingDeleted] } },
      { projection: { participants: 1 } },
    );
    for (const row of rows)
      if (Array.isArray(row.participants)) referenced.push(...row.participants);
  }
  return normalizeContactIds(referenced).filter((id) =>
    candidateKeys.has(contactKey(id)),
  );
}

type ContactPartitions = {
  chats: ReturnType<typeof partitionContactCandidates>;
  users: ReturnType<typeof partitionContactCandidates>;
  /** Users kept only because a remaining chat lists them as a participant. */
  keptAsParticipants: number;
};

/**
 * Splits chat/user candidates into deletable / shared / protected. Chats are
 * referenced by conversations (chat or user field; WhatsApp 1:1 chat and user
 * ids coincide); users also by the participants of chats that stay.
 */
async function resolveContactPartitions(
  ctx: RunContext,
  chatCandidates: readonly PurgeContactId[],
  userCandidates: readonly PurgeContactId[],
  scope: "other_workspaces" | "any_remaining",
): Promise<ContactPartitions> {
  const byConversation = await findReferencedContacts(
    ctx,
    normalizeContactIds([...chatCandidates, ...userCandidates]),
    scope,
  );
  const chats = partitionContactCandidates(chatCandidates, byConversation);
  const byParticipants = await findParticipantReferences(
    ctx,
    userCandidates,
    chats.deletable,
  );
  const conversationKeys = new Set(byConversation.map(contactKey));
  return {
    chats,
    users: partitionContactCandidates(userCandidates, [
      ...byConversation,
      ...byParticipants,
    ]),
    keptAsParticipants: byParticipants.filter(
      (id) => !conversationKeys.has(contactKey(id)),
    ).length,
  };
}

function messageTenantGuard(targets: readonly string[]): PurgeFilter {
  // Legacy rows may lack workspaceId; a row that names another workspace is
  // never deleted even inside a target conversation.
  return {
    $or: [{ workspaceId: { $in: [...targets] } }, { workspaceId: null }],
  };
}

type PurgePlan = Awaited<ReturnType<typeof buildPlan>>;

async function buildPlan(
  ctx: RunContext,
  facts: TargetFacts,
  phoneNumberIds: string[],
  phoneOwnership: readonly PurgePhoneOwnership[],
) {
  const { mongo, supabase, ledger } = ctx.deps;
  const workspaceFilter = { workspaceId: { $in: ctx.targets } };
  const staleBefore = new Date(
    ctx.startedAt.getTime() - OUTBOX_STALE_PROCESSING_MS,
  );
  const outbox = mongo.collection(CROSS_STORE_OUTBOXES);
  const phoneWindows = buildPhoneWindows(phoneOwnership);
  const webhookSelector = buildWebhookReceiptSelector(
    ctx.targets,
    phoneWindows,
  );
  const webhook = mongo.collection(WEBHOOK_EVENTS);

  const temporal = await planTemporal(ctx, facts);
  const projector = await readProjectorState(ctx);

  const crossStoreOutbox = {
    delete: await outbox.countDocuments(
      buildOutboxDeletableFilter(ctx.targets, staleBefore),
    ),
    keptDeliveryUnknown: await outbox.countDocuments({
      $and: [
        buildOutboxWorkspaceSelector(ctx.targets),
        { status: "delivery_unknown" },
      ],
    }),
    liveProcessing: await outbox.countDocuments(
      buildOutboxLiveProcessingFilter(ctx.targets, staleBefore),
    ),
    mixedWorkspaceRows: await outbox.countDocuments(
      buildOutboxMixedWorkspaceFilter(ctx.targets),
    ),
  };

  let untaggedInWindows = 0;
  for (const window of phoneWindows) {
    untaggedInWindows += await webhook.countDocuments(
      buildWebhookReceiptSelector([], [window]),
    );
  }
  const webhookReceipts = {
    phoneNumberIds,
    ownedSince: Object.fromEntries(
      phoneOwnership.map((entry) => [
        entry.phoneNumberId,
        entry.ownedSince?.toISOString() ?? null,
      ]),
    ),
    matched: await webhook.countDocuments(webhookSelector),
    toCompact: await webhook.countDocuments({
      $and: [webhookSelector, WEBHOOK_NEEDS_WORK],
    }),
    toMarkDead: await webhook.countDocuments({
      $and: [webhookSelector, WEBHOOK_NOT_TERMINAL],
    }),
    // Never selected: rows that name another workspace, and untagged rows
    // from before a target owned the number (or on a number without evidence).
    otherWorkspaceOnTargetPhonesKept: phoneNumberIds.length
      ? await webhook.countDocuments({
          phoneNumberId: { $in: phoneNumberIds },
          workspaceId: { $nin: [...ctx.targets, null] },
        })
      : 0,
    untaggedOutsideOwnershipKept: phoneNumberIds.length
      ? (await webhook.countDocuments({
          phoneNumberId: { $in: phoneNumberIds },
          workspaceId: null,
        })) - untaggedInWindows
      : 0,
  };

  const chatDerived: Record<string, number> = {};
  for (const rule of PURGE_CHAT_DERIVED_COLLECTIONS) {
    chatDerived[rule.collection] = await mongo
      .collection(rule.collection)
      .countDocuments(workspaceFilter);
  }

  const messageCollection = mongo.collection(MESSAGES);
  let inTargetConversations = 0;
  let foreignWorkspaceInTargetConversations = 0;
  for (const batch of chunk(facts.conversationIds, ctx.options.batchSize)) {
    inTargetConversations += await messageCollection.countDocuments({
      $and: [{ conversation: { $in: batch } }, messageTenantGuard(ctx.targets)],
    });
    foreignWorkspaceInTargetConversations +=
      await messageCollection.countDocuments({
        conversation: { $in: batch },
        workspaceId: { $nin: [...ctx.targets, null] },
      });
  }
  const messages = {
    inTargetConversations,
    outsideTargetConversations: await messageCollection.countDocuments({
      ...workspaceFilter,
      conversation: { $nin: facts.conversationIds },
    }),
    foreignWorkspaceInTargetConversationsKept:
      foreignWorkspaceInTargetConversations,
  };

  const conversations = {
    conversations: await mongo
      .collection(CONVERSATIONS)
      .countDocuments(workspaceFilter),
    apiMessageSendOperations: await mongo
      .collection(API_MESSAGE_SEND_OPERATIONS)
      .countDocuments(workspaceFilter),
    requestListItems: await mongo
      .collection(REQUEST_LIST_ITEMS)
      .countDocuments(workspaceFilter),
    byWorkspace: facts.conversationsByWorkspace,
  };
  const customers = await mongo
    .collection(CUSTOMERS)
    .countDocuments(workspaceFilter);

  const partitions = await resolveContactPartitions(
    ctx,
    facts.chatCandidates,
    facts.userCandidates,
    "other_workspaces",
  );
  const chatPartition = partitions.chats;
  const userPartition = partitions.users;
  const existing = async (name: string, ids: PurgeContactId[]) => {
    let count = 0;
    for (const batch of chunk(ids, ctx.options.batchSize))
      count += await mongo
        .collection(name)
        .countDocuments({ _id: { $in: batch } });
    return count;
  };
  const contacts = {
    chatCandidates: facts.chatCandidates.length,
    userCandidates: facts.userCandidates.length,
    taggedChatsOutsideTargetConversations:
      facts.taggedChatsOutsideConversations,
    taggedUsersOutsideTargetConversations:
      facts.taggedUsersOutsideConversations,
    sharedChatsKept: chatPartition.shared.length,
    sharedUsersKept: userPartition.shared.length,
    keptAsGroupParticipants: partitions.keptAsParticipants,
    protectedKept:
      chatPartition.protectedIds.length + userPartition.protectedIds.length,
    chatsToDelete: await existing(CHATS, chatPartition.deletable),
    usersToDelete: await existing(USERS, userPartition.deletable),
  };

  const storageScan = await collectStorageObjects(ctx);
  const storage = {
    objects: storageScan.objects.length,
    bytes: storageScan.objects.reduce((sum, object) => sum + object.bytes, 0),
    byBucket: {} as Record<string, { objects: number; bytes: number }>,
    ledgerRecords: 0,
    ledgerOwnerMismatchKept: 0,
    ignoredOutsideRule: storageScan.ignored,
  };
  for (const object of storageScan.objects) {
    const bucket = (storage.byBucket[object.bucket] ||= {
      objects: 0,
      bytes: 0,
    });
    bucket.objects += 1;
    bucket.bytes += object.bytes;
    const record = await ledger.read(object.ledgerId);
    if (!record) continue;
    storage.ledgerRecords += 1;
    if (record.workspaceId !== object.workspaceId)
      storage.ledgerOwnerMismatchKept += 1;
  }

  const conversationSummaries: Record<string, number> = {};
  for (const workspaceId of ctx.targets)
    conversationSummaries[workspaceId] =
      await supabase.countConversationSummaries(workspaceId);

  return {
    counts: {
      temporal: {
        configured: temporal.configured,
        unavailableReason: temporal.unavailableReason,
        scannedRunning: temporal.scanned,
        terminate: temporal.terminate.length,
        keptWorkspaceWorkflows: temporal.keep.length,
        blockers: temporal.blockers.length,
      },
      requestsProjector: {
        present: projector.present,
        state: projector.state,
        generationMode: projector.generationMode,
        leaseLive: projector.leaseLive,
        committedThrough:
          projector.committedThrough === null
            ? null
            : new Date(
                Number(projector.committedThrough >> BigInt(32)) * 1000,
              ).toISOString(),
      },
      crossStoreOutbox,
      webhookReceipts,
      chatDerived,
      messages,
      conversations,
      customers,
      contacts,
      storage,
      conversationSummaries,
    },
    temporal,
    projector,
    storageObjects: storageScan.objects,
    chatsToDelete: chatPartition.deletable,
    usersToDelete: userPartition.deletable,
    webhookSelector,
  };
}

export function evaluatePurgeReadiness(params: {
  workspaces: readonly WorkspacePreconditionResult[];
  temporalConfigured: boolean;
  temporalBlockers: number;
  outboxLiveProcessing: number;
  outboxMixedWorkspaceRows?: number;
  storageLedgerOwnerMismatches: number;
  projector?: Pick<
    PurgeProjectorState,
    "present" | "state" | "generationMode" | "leaseLive"
  > | null;
}): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const workspace of params.workspaces)
    for (const failure of workspace.failures)
      blockers.push(`${workspace.workspaceId}:${failure}`);
  if (!params.temporalConfigured) blockers.push("temporal_not_configured");
  if (params.temporalBlockers > 0)
    blockers.push(`campaign_workflows_running:${params.temporalBlockers}`);
  if (params.outboxLiveProcessing > 0)
    blockers.push(
      `cross_store_outbox_processing:${params.outboxLiveProcessing}`,
    );
  if ((params.outboxMixedWorkspaceRows || 0) > 0)
    blockers.push(
      `cross_store_outbox_mixed_workspace_rows:${params.outboxMixedWorkspaceRows}`,
    );
  if (params.storageLedgerOwnerMismatches > 0)
    blockers.push(
      `storage_ledger_owner_mismatch:${params.storageLedgerOwnerMismatches}`,
    );
  const projector = params.projector;
  if (projector?.present) {
    // sequence_v2 projects every change on its own: tens of thousands of
    // message deletes would stall every tenant's inbox for hours.
    if (projector.generationMode === "sequence_v2")
      blockers.push("requests_projector_sequence_v2");
    if (
      !projector.leaseLive ||
      !["ready", "catching_up"].includes(projector.state || "")
    )
      blockers.push(`requests_projector_not_live:${projector.state}`);
  }
  return { ready: blockers.length === 0, blockers };
}

function buildWarnings(
  facts: TargetFacts,
  plan: PurgePlan,
  channelSources: readonly PurgeChannelSource[],
): string[] {
  const warnings: string[] = [];
  if (facts.recordedMarketingOptOuts > 0) {
    warnings.push(
      `recorded_marketing_opt_outs_erased:${facts.recordedMarketingOptOuts} (conversation-level opt-outs are the only state the bulk opt-out filter reads; Supabase whatsapp_opt_in_events rows are kept)`,
    );
  }
  if (plan.counts.contacts.keptAsGroupParticipants > 0) {
    warnings.push(
      `contacts_kept_as_group_participants:${plan.counts.contacts.keptAsGroupParticipants} (listed in chats.participants of a chat that is not deleted)`,
    );
  }
  if (facts.groupConversations > 0) {
    warnings.push(
      `group_conversations:${facts.groupConversations} (group members are checked through chats.participants; messages.author has no index and is not scanned)`,
    );
  }
  if (plan.counts.messages.foreignWorkspaceInTargetConversationsKept > 0) {
    warnings.push(
      `messages_with_foreign_workspace_kept:${plan.counts.messages.foreignWorkspaceInTargetConversationsKept}`,
    );
  }
  if (channelSources.length > 0) {
    warnings.push(
      `channel_sources_connected:${channelSources.length} (Telegram/Instagram/widget/email keep adding messages to existing conversations and recreate contact docs on every inbound; the final sweep removes messages that arrive during the run)`,
    );
  }
  if (!plan.projector.present) {
    warnings.push(
      "requests projector checkpoint not found: deletes are not throttled on projector progress",
    );
  }
  warnings.push(
    `requests projector: every deleted message, conversation, chat and user is re-projected (chat/user deletes one event at a time, platform-wide); contact deletes go in batches of ${PURGE_CONTACT_BATCH_SIZE} and every watched batch waits until the projector has committed past it (--max-projector-wait-ms); run off-peak`,
    "not covered: Telegram legacy numeric storage roots, the avatars bucket, GCS call recordings and bulk recipient files, Temporal histories, Atlas backups and change-stream pre-images",
  );
  return warnings;
}

function buildFollowUps(companyIds: readonly string[]): string[] {
  return [
    ...companyIds.map(
      (companyId) =>
        `pnpm --filter @icecore/temporal-worker backfill:usage-snapshots -- --company-id=${companyId}`,
    ),
    "The usage repair recounts conversations; on a free plan that can reopen the conversation-limit gates (trial-expired companies stay locked).",
    "Redis caches (conversation/request lists, visibility gate, usage snapshots) are not invalidated here; they expire by TTL.",
  ];
}

function newManifestPath(mode: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(os.tmpdir(), `${PURGE_TOOL_NAME}-${mode}-${stamp}.json`);
}

async function executeSteps(
  ctx: RunContext,
  facts: TargetFacts,
  plan: PurgePlan,
  record: (step: PurgeExecutionStep, result: Record<string, unknown>) => void,
) {
  const { mongo, supabase, ledger } = ctx.deps;
  const workspaceFilter = { workspaceId: { $in: ctx.targets } };
  const terminatedIds = new Set<string>();

  // 1. Temporal: stop timers and turn retries before their data disappears.
  // The planning listing is minutes old by now, so list again.
  record("temporal_terminate", await sweepTemporal(ctx, facts, terminatedIds));

  // 2. Cross-store outbox: pending LLM-feedback prompts would still message
  // the customer, so they go before anything else.
  {
    const staleBefore = new Date(
      ctx.deps.now().getTime() - OUTBOX_STALE_PROCESSING_MS,
    );
    const live = await mongo
      .collection(CROSS_STORE_OUTBOXES)
      .countDocuments(
        buildOutboxLiveProcessingFilter(ctx.targets, staleBefore),
      );
    if (live > 0)
      throw new PurgeOperatorError(
        `cross-store outbox has ${live} live processing row(s) for the targets`,
      );
    // No index on payload.*: scan once instead of once per batch.
    record("cross_store_outbox", {
      deleted: await deleteScannedIds(
        ctx,
        "cross_store_outbox",
        CROSS_STORE_OUTBOXES,
        buildOutboxDeletableFilter(ctx.targets, staleBefore),
      ),
    });
  }

  // 3. Webhook receipts: keep the dedupe rows, drop payloads, and move every
  // non-terminal receipt to "dead" so the drain never retries it.
  {
    const webhook = mongo.collection(WEBHOOK_EVENTS);
    const selector = plan.webhookSelector;
    const ids = (
      await webhook.find(
        { $and: [selector, WEBHOOK_NEEDS_WORK] },
        { projection: { _id: 1 } },
      )
    ).map((row) => row._id);
    let markedDead = 0;
    let compacted = 0;
    for (const batch of chunk(ids, ctx.options.batchSize)) {
      const now = ctx.deps.now();
      markedDead += await webhook.updateMany(
        { $and: [{ _id: { $in: batch } }, selector, WEBHOOK_NOT_TERMINAL] },
        {
          $set: {
            status: "dead",
            nextRetryAt: null,
            processingLeaseId: null,
            lastError: PURGE_WEBHOOK_LAST_ERROR,
            updatedAt: now,
          },
        },
      );
      compacted += await webhook.updateMany(
        { $and: [{ _id: { $in: batch } }, selector, WEBHOOK_NEEDS_WORK] },
        {
          $set: { payloadCompactedAt: now, updatedAt: now },
          $unset: { payload: "", processingCursor: "" },
        },
      );
      ctx.deps.progress({
        step: "webhook_receipts",
        markedDead,
        compacted,
      });
      await pause(ctx);
    }
    record("webhook_receipts", { selected: ids.length, markedDead, compacted });
  }

  // 4. Chat-derived side collections (raw driver; see the rule list). The
  // ingress retry cron restarts conversation workflows from airiturncontexts,
  // which are gone now, so sweep Temporal again.
  record("chat_derived_collections", {
    ...(await deleteChatDerivedRows(
      ctx,
      "chat_derived_collections",
      workspaceFilter,
    )),
    temporalResweep: await sweepTemporal(ctx, facts, terminatedIds),
  });

  // 5. Messages: by target conversation first (legacy rows may lack a
  // workspaceId), then any row still tagged with a target workspace.
  record("messages", await deleteTargetMessages(ctx, facts, "messages"));

  // 6. Conversations, then rows that are only safe without them: API send
  // fences (the send route needs the conversation) and the Requests rows.
  // Every conversation page waited for the projector, so its replaceOne on
  // request_list_items no longer races the delete below.
  record("conversations", {
    conversations: await drainDelete(
      ctx,
      "conversations",
      CONVERSATIONS,
      workspaceFilter,
    ),
    // Only the _id index exists (it is the idempotency key).
    apiMessageSendOperations: await deleteScannedIds(
      ctx,
      "conversations",
      API_MESSAGE_SEND_OPERATIONS,
      workspaceFilter,
    ),
    requestListItems: await drainDelete(
      ctx,
      "conversations",
      REQUEST_LIST_ITEMS,
      workspaceFilter,
    ),
    temporalResweep: await sweepTemporal(ctx, facts, terminatedIds),
  });

  // 7. Leads.
  record("customers", {
    deleted: await drainDelete(ctx, "customers", CUSTOMERS, workspaceFilter),
  });

  // 8. Contact docs are global; delete only ids that no remaining
  // conversation, and no remaining chat's participants, of any workspace
  // reference. Candidates: ids the target conversations referenced plus docs
  // tagged with a target (picked up again here, so a plain re-run after an
  // interrupted run still finds them).
  {
    const tagged = await collectTaggedContacts(ctx);
    const chatCandidates = normalizeContactIds([
      ...facts.chatCandidates,
      ...tagged.chatIds,
    ]);
    const userCandidates = normalizeContactIds([
      ...facts.userCandidates,
      ...tagged.userIds,
    ]);
    // Ingest upserts bump updatedAt (both schemas use timestamps): a contact
    // touched after this instant is never deleted by this run.
    const checkStartedAt = ctx.deps.now();
    const partitions = await resolveContactPartitions(
      ctx,
      chatCandidates,
      userCandidates,
      "any_remaining",
    );
    const contactBatchSize = Math.min(
      ctx.options.batchSize,
      PURGE_CONTACT_BATCH_SIZE,
    );
    const result: Record<string, number> = {
      keptAsGroupParticipants: partitions.keptAsParticipants,
    };
    for (const [name, partition] of [
      [CHATS, partitions.chats],
      [USERS, partitions.users],
    ] as const) {
      const collection = mongo.collection(name);
      let deleted = 0;
      let newlyReferencedKept = 0;
      let recentlyUpdatedKept = 0;
      for (const batch of chunk(partition.deletable, contactBatchSize)) {
        // Another workspace may have started a conversation with one of these
        // contacts since the check above: look again right before deleting.
        const fresh = new Set(
          (await findReferencedContacts(ctx, batch, "any_remaining")).map(
            contactKey,
          ),
        );
        const ids = batch.filter((id) => !fresh.has(contactKey(id)));
        newlyReferencedKept += batch.length - ids.length;
        if (!ids.length) continue;
        const removed = await collection.deleteMany({
          $and: [
            { _id: { $in: ids } },
            {
              $or: [
                { updatedAt: { $lt: checkStartedAt } },
                { updatedAt: null },
              ],
            },
          ],
        });
        deleted += removed;
        recentlyUpdatedKept += await collection.countDocuments({
          _id: { $in: ids },
        });
        if (removed > 0) await awaitProjector(ctx, "contacts");
        ctx.deps.progress({ step: "contacts", collection: name, deleted });
        await pause(ctx);
      }
      result[`${name}Deleted`] = deleted;
      result[`${name}SharedKept`] = partition.shared.length;
      result[`${name}ProtectedKept`] = partition.protectedIds.length;
      result[`${name}NewlyReferencedKept`] = newlyReferencedKept;
      result[`${name}RecentlyUpdatedKept`] = recentlyUpdatedKept;
    }
    record("contacts", result);
  }

  // 9. Chat media: tombstone the ledger record, then remove the object, so a
  // re-run after a failed remove still finds the object.
  {
    const { objects } = await collectStorageObjects(ctx);
    let removed = 0;
    let tombstoned = 0;
    let ledgerMissing = 0;
    let ownerMismatchKept = 0;
    let bytes = 0;
    for (const batch of chunk(objects, ctx.options.batchSize)) {
      const removable = new Map<string, PlannedStorageObject[]>();
      for (const object of batch) {
        const ledgerRecord = await ledger.read(object.ledgerId);
        if (ledgerRecord && ledgerRecord.workspaceId !== object.workspaceId) {
          ownerMismatchKept += 1;
          continue;
        }
        if (!ledgerRecord) ledgerMissing += 1;
        else if (ledgerRecord.status !== "tombstoned") {
          await ledger.tombstone(object.ledgerId);
          tombstoned += 1;
        }
        const list = removable.get(object.bucket) || [];
        list.push(object);
        removable.set(object.bucket, list);
      }
      for (const [bucket, list] of removable) {
        removed += await supabase.removeStorageObjects(
          bucket,
          list.map((object) => object.path),
        );
        bytes += list.reduce((sum, object) => sum + object.bytes, 0);
      }
      ctx.deps.progress({ step: "storage", removed, tombstoned });
      await pause(ctx);
    }
    record("storage", {
      selected: objects.length,
      removed,
      bytes,
      tombstoned,
      ledgerMissing,
      ownerMismatchKept,
    });
  }

  // 10. Cross-conversation RAG summaries (content + embeddings). Ids travel
  // in the query string, so the page is capped independently of --batch-size.
  {
    const deleted: Record<string, number> = {};
    const page = Math.min(ctx.options.batchSize, PURGE_SUMMARY_DELETE_PAGE);
    for (const workspaceId of ctx.targets) {
      deleted[workspaceId] = 0;
      for (;;) {
        const ids = await supabase.listConversationSummaryIds(
          workspaceId,
          page,
        );
        if (!ids.length) break;
        const removed = await supabase.deleteConversationSummaries(
          workspaceId,
          ids,
        );
        if (removed === 0)
          throw new PurgeOperatorError(
            "conversation_summaries: a delete batch made no progress",
          );
        deleted[workspaceId] += removed;
        await pause(ctx);
      }
    }
    record("conversation_summaries", deleted);
  }

  // 11. Late writes: messages that reached a target conversation after step 5
  // (non-WhatsApp channels still accept them), then the projector's rows for
  // every delete above. Each watched batch already waited for the projector,
  // so its tombstones and realtime rows exist by now. Chat-derived rows are
  // swept again because analytics projectors re-derive them from messages
  // and conversations that still existed after step 4 (the 2026-10-17 run
  // left 539 acquisition entries and 65 message links behind).
  record("final_projection_sweep", {
    messages: await deleteTargetMessages(ctx, facts, "final_projection_sweep"),
    requestListItems: await drainDelete(
      ctx,
      "final_projection_sweep",
      REQUEST_LIST_ITEMS,
      workspaceFilter,
    ),
    chatDerived: await deleteChatDerivedRows(
      ctx,
      "final_projection_sweep",
      workspaceFilter,
      new Set([REALTIME_EVENTS]),
    ),
    realtimeEvents: await drainDelete(
      ctx,
      "final_projection_sweep",
      REALTIME_EVENTS,
      workspaceFilter,
    ),
  });

  // 12. No target chat workflow may outlive the purge: terminate anything
  // that appeared since the last sweep, then confirm each terminated id is
  // closed (a describe sees restarts that visibility may not list yet).
  {
    const sweep = await sweepTemporal(ctx, facts, terminatedIds);
    const temporal = ctx.deps.temporal!;
    let stillRunning = 0;
    for (const workflowId of terminatedIds)
      if (await temporal.isRunning(workflowId)) stillRunning += 1;
    if (stillRunning > 0) {
      throw new PurgeOperatorError(
        `${stillRunning} target chat workflow(s) are still running after termination`,
      );
    }
    record("temporal_verify", { ...sweep, verifiedClosed: terminatedIds.size });
  }
}

async function deleteChatDerivedRows(
  ctx: RunContext,
  step: PurgeExecutionStep,
  workspaceFilter: PurgeFilter,
  skip: ReadonlySet<string> = new Set(),
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const rule of PURGE_CHAT_DERIVED_COLLECTIONS) {
    if (skip.has(rule.collection)) continue;
    deleted[rule.collection] = await (
      rule.unindexedWorkspace ? deleteScannedIds : drainDelete
    )(ctx, step, rule.collection, workspaceFilter);
  }
  return deleted;
}

async function deleteTargetMessages(
  ctx: RunContext,
  facts: TargetFacts,
  step: PurgeExecutionStep,
): Promise<{ byConversation: number; byWorkspace: number }> {
  let byConversation = 0;
  for (const batch of chunk(facts.conversationIds, ctx.options.batchSize)) {
    byConversation += await drainDelete(ctx, step, MESSAGES, {
      $and: [{ conversation: { $in: batch } }, messageTenantGuard(ctx.targets)],
    });
  }
  return {
    byConversation,
    byWorkspace: await drainDelete(ctx, step, MESSAGES, {
      workspaceId: { $in: ctx.targets },
    }),
  };
}

export async function runWorkspaceChatPurge(
  options: PurgeWorkspaceChatDataOptions,
  deps: PurgeDependencies,
): Promise<Record<string, unknown>> {
  const startedAt = deps.now();
  const ctx: RunContext = {
    options,
    deps,
    targets: [...options.workspaceIds],
    targetSet: new Set(options.workspaceIds),
    startedAt,
    projector: null,
  };
  const mode = options.execute ? "execute" : "dry-run";
  const resume = options.resumeManifestPath
    ? parseResumeManifest(
        await deps.readTextFile(options.resumeManifestPath),
        ctx.targets,
      )
    : null;

  const preconditions = await collectWorkspacePreconditions(ctx);
  const facts = await collectTargetFacts(ctx, resume);
  const plan = await buildPlan(
    ctx,
    facts,
    preconditions.phoneNumberIds,
    preconditions.phoneOwnership,
  );
  ctx.projector = plan.projector;
  const readiness = evaluatePurgeReadiness({
    workspaces: preconditions.results,
    temporalConfigured: plan.temporal.configured,
    temporalBlockers: plan.temporal.blockers.length,
    outboxLiveProcessing: plan.counts.crossStoreOutbox.liveProcessing,
    outboxMixedWorkspaceRows: plan.counts.crossStoreOutbox.mixedWorkspaceRows,
    storageLedgerOwnerMismatches: plan.counts.storage.ledgerOwnerMismatchKept,
    projector: plan.projector,
  });
  const manifestPath = options.manifestPath || newManifestPath(mode, startedAt);
  const followUps = buildFollowUps(preconditions.companyIds);
  const summary = {
    tool: PURGE_TOOL_NAME,
    mode,
    workspaceIds: ctx.targets,
    manifestPath,
    batchSize: options.batchSize,
    pauseMs: options.pauseMs,
    maxProjectorWaitMs: options.maxProjectorWaitMs,
    preconditions: preconditions.results,
    readiness,
    plan: plan.counts,
    warnings: buildWarnings(facts, plan, preconditions.channelSources),
    deleteCollections: PURGE_DELETE_COLLECTIONS,
    compactCollections: PURGE_COMPACT_COLLECTIONS,
    keptCollections: PURGE_KEPT_COLLECTIONS,
    executionOrder: PURGE_EXECUTION_STEPS,
  };
  deps.emit(summary);

  await deps.writeNewFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...summary,
        version: 1,
        generatedAt: startedAt.toISOString(),
        temporal: {
          terminate: plan.temporal.terminate,
          keep: plan.temporal.keep,
          blockers: plan.temporal.blockers,
        },
        candidates: {
          conversationIds: [...facts.conversationHexIds],
          chatIds: facts.chatCandidates,
          userIds: facts.userCandidates,
          generativeExecutionIds: [...facts.generativeExecutionIds],
        },
        storageObjects: plan.storageObjects.map(
          ({ bucket, path: objectPath, bytes, workspaceId }) => ({
            bucket,
            path: objectPath,
            bytes,
            workspaceId,
          }),
        ),
      },
      null,
      2,
    )}\n`,
  );

  if (!options.execute) {
    const result = {
      tool: PURGE_TOOL_NAME,
      mode,
      status: "planned",
      writes: 0,
      ready: readiness.ready,
      blockers: readiness.blockers,
      manifestPath,
      followUps,
    };
    deps.emit(result);
    return result;
  }
  if (!readiness.ready) {
    throw new PurgeOperatorError(
      `Execution refused: ${readiness.blockers.join(", ")}`,
    );
  }

  const steps: Record<string, Record<string, unknown>> = {};
  let current: PurgeExecutionStep = PURGE_EXECUTION_STEPS[0];
  try {
    await executeSteps(ctx, facts, plan, (step, result) => {
      steps[step] = result;
      deps.progress({ step, status: "completed", ...result });
      const next =
        PURGE_EXECUTION_STEPS[PURGE_EXECUTION_STEPS.indexOf(step) + 1];
      if (next) current = next;
    });
  } catch (error) {
    const failure = new PurgeOperatorError(
      `Step ${PURGE_EXECUTION_STEPS.indexOf(current) + 1} (${current}) failed: ${describeError(error)}. Re-run with --resume-manifest=${manifestPath} to continue.`,
    );
    failure.partialReport = {
      tool: PURGE_TOOL_NAME,
      mode,
      status: "failed",
      failedStep: current,
      completedSteps: steps,
      manifestPath,
    };
    throw failure;
  }
  const result = {
    tool: PURGE_TOOL_NAME,
    mode,
    status: "completed",
    manifestPath,
    steps,
    followUps,
  };
  try {
    await deps.writeNewFile(
      manifestPath.replace(/\.json$/i, "") + ".result.json",
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } catch {
    deps.progress({ warning: "result file was not written" });
  }
  deps.emit(result);
  return result;
}

// ------------------------------------------------------------------- errors

const SAFE_ERROR_PATTERNS = [
  /^Supabase [\w ]+ failed \(\d{3}\)$/,
  /^Supabase inventory request failed \(\d{3}\)$/,
  /^Inventory page budget reached/,
  /^Storage inventory folder depth exceeded$/,
  /^Invalid storage inventory path$/,
  /^Supabase object size is missing$/,
  /^Storage quota|^Storage inventory is required/,
  /^MONGODB_URI environment variable is required$/,
  /^Supabase storage inventory is not configured$/,
];

export function redactSensitiveText(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<redacted-uri>")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<redacted-token>")
    .replace(/\b(sk|pk|tok|key)[-_][\w-]{12,}/gi, "<redacted-secret>");
}

function describeError(error: unknown): string {
  if (error instanceof PurgeOperatorError)
    return redactSensitiveText(error.message);
  const message = error instanceof Error ? error.message : "";
  if (SAFE_ERROR_PATTERNS.some((pattern) => pattern.test(message)))
    return redactSensitiveText(message);
  const name =
    error instanceof Error && /^[A-Za-z]+$/.test(error.name)
      ? error.name
      : "Error";
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  const suffix =
    typeof code === "number" && Number.isSafeInteger(code)
      ? ` code ${code}`
      : typeof code === "string" && /^[A-Z_]{2,40}$/.test(code)
        ? ` code ${code}`
        : "";
  return `${name}${suffix}`;
}

/** Never prints secrets, URIs or raw provider messages. */
export function formatPurgeWorkspaceChatDataError(error: unknown): string {
  if (error instanceof PurgeOperatorError)
    return redactSensitiveText(error.message);
  return `Workspace chat purge failed (${describeError(error)}). Check MongoDB, Supabase and Temporal connectivity and permissions.`;
}

// ----------------------------------------------------------------- adapters

const READ_MAX_TIME_MS = 120_000;
const WRITE_MAX_TIME_MS = 60_000;

type MongoFilter = mongoose.mongo.Filter<mongoose.mongo.Document>;

function createMongoPort(
  db: mongoose.mongo.Db,
  client: mongoose.mongo.MongoClient,
): PurgeMongoPort {
  let lastWriteTime: bigint | null = null;
  // Each write runs in its own short causally consistent session only to read
  // the server's operationTime for that write (the driver records it on the
  // session); no transaction is opened.
  async function write<T>(
    run: (session: mongoose.mongo.ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = client.startSession({ causalConsistency: true });
    try {
      const result = await run(session);
      lastWriteTime = clusterTimeToBigInt(session.operationTime);
      return result;
    } finally {
      await session.endSession();
    }
  }
  // Raw driver on purpose: no Mongoose middleware runs, which the append-only
  // conversationanalysisrevisions guard requires, and no per-document hooks
  // fire for the mass deletes.
  return {
    lastWriteTime: () => lastWriteTime,
    collection(name) {
      const collection = db.collection(name);
      return {
        countDocuments: (filter) =>
          collection.countDocuments(filter as MongoFilter, {
            maxTimeMS: READ_MAX_TIME_MS,
          }),
        find: (filter, options) =>
          collection
            .find(filter as MongoFilter, {
              projection: options.projection,
              ...(options.limit ? { limit: options.limit } : {}),
              ...(options.sort ? { sort: options.sort } : {}),
              maxTimeMS: READ_MAX_TIME_MS,
            })
            .toArray(),
        distinct: (field, filter) =>
          collection.distinct(field, filter as MongoFilter, {
            maxTimeMS: READ_MAX_TIME_MS,
          }),
        deleteMany: (filter) =>
          write(
            async (session) =>
              (
                await collection.deleteMany(filter as MongoFilter, {
                  maxTimeMS: WRITE_MAX_TIME_MS,
                  session,
                })
              ).deletedCount,
          ),
        updateMany: (filter, update) =>
          write(
            async (session) =>
              (
                await collection.updateMany(
                  filter as MongoFilter,
                  update as mongoose.mongo.UpdateFilter<mongoose.mongo.Document>,
                  { maxTimeMS: WRITE_MAX_TIME_MS, session },
                )
              ).modifiedCount,
          ),
      };
    },
  };
}

function inFilter(values: readonly string[], pattern: RegExp): string {
  if (!values.length || !values.every((value) => pattern.test(value)))
    throw new PurgeOperatorError(
      "Refusing an unvalidated Supabase filter value",
    );
  return `in.(${values.join(",")})`;
}

async function supabaseRows<T>(
  table: string,
  params: Record<string, string>,
): Promise<T[]> {
  const query = new URLSearchParams({
    ...params,
    limit: String(SUPABASE_ROW_LIMIT),
  });
  const response = await supabaseServiceFetch(`/rest/v1/${table}?${query}`);
  if (!response.ok)
    throw new PurgeOperatorError(
      `Supabase ${table} read failed (${response.status})`,
    );
  const rows = (await response.json()) as unknown;
  if (!Array.isArray(rows))
    throw new PurgeOperatorError(
      `Supabase ${table} returned an invalid response`,
    );
  if (rows.length >= SUPABASE_ROW_LIMIT)
    throw new PurgeOperatorError(
      `Supabase ${table} read reached its ${SUPABASE_ROW_LIMIT}-row safety limit`,
    );
  return rows as T[];
}

/** REST path of one conversation_summaries delete page (ids in the URL). */
export function buildConversationSummaryDeletePath(
  workspaceId: string,
  ids: readonly string[],
): string {
  if (!UUID_PATTERN.test(workspaceId))
    throw new PurgeOperatorError(
      "Refusing an unvalidated Supabase filter value",
    );
  if (ids.length > PURGE_SUMMARY_DELETE_PAGE)
    throw new PurgeOperatorError(
      `conversation_summaries delete pages hold at most ${PURGE_SUMMARY_DELETE_PAGE} ids`,
    );
  const query = new URLSearchParams({
    workspace_id: `eq.${workspaceId}`,
    id: inFilter(ids, UUID_PATTERN),
    select: "id",
  });
  return `/rest/v1/conversation_summaries?${query}`;
}

const SOURCE_FLAG_SELECT = [
  "id",
  "created_at",
  "company_id",
  "workspace_id",
  "type",
  "name",
  "phone_number_id:credentials->>phone_number_id",
  "coexistence_reonboarding_status:credentials->coexistence_reonboarding_status",
  "cloud_api_messaging_suspended:credentials->cloud_api_messaging_suspended",
  "coexistence_mode:credentials->coexistence_mode",
  "partner_app_installed:credentials->partner_app_installed",
].join(",");

type SourceFlagRow = Omit<Source, "credentials"> & {
  phone_number_id: string | null;
  coexistence_reonboarding_status: unknown;
  cloud_api_messaging_suspended: unknown;
  coexistence_mode: unknown;
  partner_app_installed: unknown;
};

function createSupabasePort(): PurgeSupabasePort {
  let storagePages = 0;
  const nextStoragePage = () => {
    storagePages += 1;
    if (storagePages > STORAGE_LIST_PAGE_BUDGET)
      throw new PurgeOperatorError("Storage listing page budget reached");
  };
  const accountBindings = async (filter: Record<string, string>) =>
    (
      await supabaseRows<{
        workspace_id: string | null;
        source_id: string | null;
        phone_number_id: string | null;
      }>("whatsapp_accounts", {
        select: "workspace_id,source_id,phone_number_id",
        source_id: "not.is.null",
        ...filter,
      })
    )
      .filter((row) => row.phone_number_id)
      .map(
        (row): PurgePhoneBinding => ({
          phoneNumberId: String(row.phone_number_id),
          workspaceId: row.workspace_id,
          sourceId: row.source_id,
          origin: "whatsapp_accounts",
        }),
      );
  return {
    getWorkspaces: (ids) =>
      supabaseRows<PurgeWorkspaceRow>("workspaces", {
        select: "id,name,company_id",
        id: inFilter(ids, UUID_PATTERN),
      }),
    getCompanies: (ids) =>
      supabaseRows<PurgeCompanyRow>("companies", {
        select:
          "id,subscription_type,trial_ends_at,billing_manual_paid_through,billing_entitlement_expires_at",
        id: inFilter(ids, UUID_PATTERN),
      }),
    async listWhatsAppSources(ids) {
      const rows = await supabaseRows<SourceFlagRow>("sources", {
        select: SOURCE_FLAG_SELECT,
        type: "eq.whatsapp",
        workspace_id: inFilter(ids, UUID_PATTERN),
      });
      return rows.map(
        ({
          phone_number_id,
          coexistence_reonboarding_status,
          cloud_api_messaging_suspended,
          coexistence_mode,
          partner_app_installed,
          ...source
        }) =>
          ({
            ...source,
            // Only the flags the shared source-state helper reads.
            credentials: {
              phone_number_id,
              coexistence_reonboarding_status,
              cloud_api_messaging_suspended,
              coexistence_mode,
              partner_app_installed,
            },
          }) as unknown as Source,
      );
    },
    listChannelSources: (ids) =>
      supabaseRows<PurgeChannelSource>("sources", {
        select: "id,workspace_id,type",
        type: `in.(${CHANNEL_SOURCE_TYPES.join(",")})`,
        workspace_id: inFilter(ids, UUID_PATTERN),
      }),
    listWorkspacePhoneBindings: (ids) =>
      accountBindings({ workspace_id: inFilter(ids, UUID_PATTERN) }),
    async listPhoneBindings(phones) {
      const fromSources = (
        await supabaseRows<{
          id: string;
          workspace_id: string | null;
          phone_number_id: string | null;
        }>("sources", {
          select:
            "id,workspace_id,phone_number_id:credentials->>phone_number_id",
          type: "eq.whatsapp",
          "credentials->>phone_number_id": inFilter(
            phones,
            PHONE_NUMBER_ID_PATTERN,
          ),
        })
      ).map(
        (row): PurgePhoneBinding => ({
          phoneNumberId: String(row.phone_number_id),
          workspaceId: row.workspace_id,
          sourceId: row.id,
          origin: "sources",
        }),
      );
      return [
        ...fromSources,
        ...(await accountBindings({
          phone_number_id: inFilter(phones, PHONE_NUMBER_ID_PATTERN),
        })),
      ];
    },
    listStorageObjects: (bucket, prefix) =>
      listSupabaseBucketObjects(bucket, prefix, nextStoragePage),
    async removeStorageObjects(bucket, paths) {
      if (!paths.length) return 0;
      const response = await supabaseServiceFetch(
        `/storage/v1/object/${encodeURIComponent(bucket)}`,
        { method: "DELETE", body: { prefixes: paths } },
      );
      if (!response.ok)
        throw new PurgeOperatorError(
          `Supabase storage delete failed (${response.status})`,
        );
      const removed = (await response.json()) as unknown;
      return Array.isArray(removed) ? removed.length : 0;
    },
    async countConversationSummaries(workspaceId) {
      const query = new URLSearchParams({
        select: "id",
        workspace_id: `eq.${workspaceId}`,
        limit: "1",
      });
      const response = await supabaseServiceFetch(
        `/rest/v1/conversation_summaries?${query}`,
        { headers: { Prefer: "count=exact" } },
      );
      const total = /\/(\d+)$/.exec(
        response.headers.get("content-range") || "",
      )?.[1];
      if (!response.ok || total === undefined)
        throw new PurgeOperatorError(
          `Supabase conversation_summaries count failed (${response.status})`,
        );
      return Number(total);
    },
    async listConversationSummaryIds(workspaceId, limit) {
      const query = new URLSearchParams({
        select: "id",
        workspace_id: `eq.${workspaceId}`,
        order: "id.asc",
        limit: String(limit),
      });
      const response = await supabaseServiceFetch(
        `/rest/v1/conversation_summaries?${query}`,
      );
      if (!response.ok)
        throw new PurgeOperatorError(
          `Supabase conversation_summaries read failed (${response.status})`,
        );
      const rows = (await response.json()) as Array<{ id?: unknown }>;
      return Array.isArray(rows) ? rows.map((row) => String(row.id)) : [];
    },
    async deleteConversationSummaries(workspaceId, ids) {
      const response = await supabaseServiceFetch(
        buildConversationSummaryDeletePath(workspaceId, ids),
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      );
      if (!response.ok)
        throw new PurgeOperatorError(
          `Supabase conversation_summaries delete failed (${response.status})`,
        );
      const rows = (await response.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    },
  };
}

async function createLedgerPort(): Promise<PurgeStorageLedgerPort> {
  const { getStorageQuotaStore } = await import(
    "@icecore/airi-runtime/storage-quota"
  );
  const store = await getStorageQuotaStore();
  return {
    async read(id) {
      const record = await store.read(id);
      return record
        ? { workspaceId: record.workspaceId, status: record.status }
        : null;
    },
    tombstone: (id) => store.tombstone(id),
  };
}

async function createTemporalPort(): Promise<{
  port: PurgeTemporalPort | null;
  unavailableReason: string | null;
  close: () => Promise<void>;
}> {
  if (!hasTemporalConnectionEnv())
    return {
      port: null,
      unavailableReason: "not_configured",
      close: async () => {},
    };
  try {
    const connection = resolveTemporalConnectionEnv();
    assertTemporalTlsApiKey(connection);
    const client = await getTemporalClient(connection);
    const isRunning = async (workflowId: string) => {
      try {
        const description = await client.workflow
          .getHandle(workflowId)
          .describe();
        return description.status.name === "RUNNING";
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return false;
        throw error;
      }
    };
    // No run id: the handle targets the workflow id's current run.
    const terminateCurrent = async (workflowId: string, reason: string) => {
      try {
        await client.workflow.getHandle(workflowId).terminate(reason);
        return true;
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return false;
        throw error;
      }
    };
    return {
      port: {
        async *listRunning() {
          for await (const workflow of client.workflow.list({
            query: 'ExecutionStatus = "Running"',
            pageSize: 1000,
          })) {
            yield {
              workflowId: workflow.workflowId,
              runId: workflow.runId,
              type: workflow.type,
            };
          }
        },
        async terminate(workflowId, reason) {
          if (await terminateCurrent(workflowId, reason)) return "terminated";
          // NotFound can race a continue-as-new or restart: closed only when
          // a describe agrees, otherwise try the new current run once.
          if (!(await isRunning(workflowId))) return "not_running";
          if (await terminateCurrent(workflowId, reason)) return "terminated";
          if (!(await isRunning(workflowId))) return "not_running";
          throw new PurgeOperatorError(
            "A target workflow kept running after termination",
          );
        },
        isRunning,
      },
      unavailableReason: null,
      close: () => client.connection.close(),
    };
  } catch (error) {
    return {
      port: null,
      unavailableReason: `unavailable (${describeError(error)})`,
      close: async () => {},
    };
  }
}

export const PURGE_HELP_TEXT = [
  "Purge end-customer chat data of explicitly listed free-plan workspaces. Dry-run by default; no backup is taken.",
  "",
  "pnpm --filter @icecore/temporal-worker purge:workspace-chat-data -- --workspace-id=<uuid> [--workspace-id=<uuid> ...] [--execute] [--batch-size=500] [--pause-ms=250] [--max-projector-wait-ms=600000] [--manifest=<path>] [--resume-manifest=<path>]",
  "",
  `--workspace-id=<uuid>          required, repeatable, at most ${PURGE_MAX_WORKSPACES}; there is no all-workspaces mode`,
  "--execute                      perform the writes (otherwise only counts are read and the manifest is written)",
  `--batch-size=<n>               write batch size, 1-${PURGE_MAX_BATCH_SIZE} (default ${PURGE_DEFAULT_BATCH_SIZE}); contact deletes use at most ${PURGE_CONTACT_BATCH_SIZE}, summary deletes at most ${PURGE_SUMMARY_DELETE_PAGE}`,
  `--pause-ms=<n>                 pause between write batches, 0-${PURGE_MAX_PAUSE_MS} (default ${PURGE_DEFAULT_PAUSE_MS})`,
  `--max-projector-wait-ms=<n>    how long one batch may wait for the requests projector to catch up, ${PURGE_PROJECTOR_POLL_MS}-${PURGE_MAX_PROJECTOR_WAIT_MS} (default ${PURGE_DEFAULT_PROJECTOR_WAIT_MS}); the run stops when it is exceeded`,
  "--manifest=<path>              new local manifest file, never overwritten (default under the OS temp dir); it lists contact ids, delete it after review",
  "--resume-manifest=<path>       re-use the conversation and contact ids of an earlier run of the same workspaces after a partial failure",
  "",
  "Execute refuses unless every workspace exists, its company is free (or null) with an ended trial and no future paid entitlement, every WhatsApp source is not live per the shared source-state helper, no target phone number is bound to a non-target workspace or was used by one since a target owned it, no campaign delivery task is pending, no campaign dispatch workflow runs, no outbox row is mid-processing or mixes target and other-workspace analytics events, the requests projector (when deployed) is live in cluster_time_v1 mode, and Temporal is configured.",
  `Order: ${PURGE_EXECUTION_STEPS.join(" > ")}. Running target chat workflows are listed again and terminated by workflow id at the start, after the side collections, after the conversations and at the end.`,
  `Deleted: ${PURGE_DELETE_COLLECTIONS.join(", ")}; chats/users (ids the target conversations used plus docs tagged with a target) only when no remaining conversation and no remaining chat's participants reference them and they were not updated during the run (never user 0, bot accounts or UUID managers); Supabase conversation_summaries; chat media in ${PURGE_STORAGE_BUCKETS.join(", ")} (business prefixes excluded, ledger records tombstoned).`,
  `Compacted, rows kept: ${PURGE_COMPACT_COLLECTIONS.join(", ")} (payload removed, non-terminal receipts set to dead): rows tagged with a target workspace, and untagged rows on a target number created since a target owned it.`,
  `Kept: ${PURGE_KEPT_COLLECTIONS.map((rule) => rule.collection).join("; ")}.`,
  "Afterwards run the printed usage-snapshot repair per company. Redis caches expire by TTL.",
].join("\n");

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(PURGE_HELP_TEXT);
    return;
  }
  const options = parsePurgeWorkspaceChatDataArgs(argv);
  loadTemporalWorkerEnv();
  const { default: connectDB } = await import("@icecore/airi-runtime/mongoose");
  await connectDB();
  const temporal = await createTemporalPort();
  try {
    const db = mongoose.connection.db;
    if (!db) throw new PurgeOperatorError("MongoDB connection is not ready");
    await runWorkspaceChatPurge(options, {
      mongo: createMongoPort(db, mongoose.connection.getClient()),
      supabase: createSupabasePort(),
      ledger: await createLedgerPort(),
      temporal: temporal.port,
      temporalUnavailableReason: temporal.unavailableReason,
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      emit: (document) => console.log(JSON.stringify(document, null, 2)),
      progress: (event) => console.error(JSON.stringify(event)),
      writeNewFile: (filePath, content) =>
        writeFile(filePath, content, { flag: "wx", mode: 0o600 }),
      readTextFile: (filePath) => readFile(filePath, "utf8"),
    });
  } finally {
    await temporal.close().catch(() => undefined);
    await mongoose.disconnect();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    if (error instanceof PurgeOperatorError && error.partialReport)
      console.log(JSON.stringify(error.partialReport, null, 2));
    console.error(formatPurgeWorkspaceChatDataError(error));
    process.exitCode = 1;
  });
}
