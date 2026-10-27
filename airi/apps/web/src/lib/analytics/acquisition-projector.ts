import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import {
  AnalyticsAcquisitionCheckpoint as Checkpoint,
  AnalyticsAcquisitionEntry as Entry,
  AnalyticsAcquisitionDaily as Daily,
  AnalyticsConversionFact as ConversionFact,
  AnalyticsAcquisitionMessageLink as MessageLink,
  AnalyticsCustomerPurchaseObservation as PurchaseObservation,
} from "@/models/analytics-acquisition";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { acquisitionEntry } from "./acquisition-contract";

export const ACQUISITION_STREAMS = [
  "messages",
  "conversations",
  "conversions",
  "messages_reconciliation",
  "conversations_reconciliation",
  "conversions_reconciliation",
] as const;
type Stream = (typeof ACQUISITION_STREAMS)[number];
const LEASE_MS = 120_000;
const LEASE_HEARTBEAT_MS = 30_000;
const SOURCE_QUERY_TIMEOUT_MS = 25_000;
const RECONCILIATION_COOLDOWN_MS = 300_000;
const DURABLE_WRITE = { writeConcern: { w: "majority" as const, j: true } };
type RuntimeStream = "workspace_discovery" | "provider_sync";
type CheckpointKey = { workspaceId: string; stream: Stream | RuntimeStream };

function throwIfAnalyticsAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("analytics_projection_aborted");
  error.name = "AbortError";
  throw error;
}

function timedSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(SOURCE_QUERY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The same fenced owner renews both acquisition pages and daemon cursors. */
function startCheckpointLease(input: {
  key: CheckpointKey;
  owner: string;
  fence: number;
  signal?: AbortSignal;
}) {
  const identity = { ...input.key, owner: input.owner, fence: input.fence };
  const ownedFilter = () => ({ ...identity, leaseUntil: { $gt: new Date() } });
  let failure: unknown;
  let renewalFailed = false;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let renewing = true;
  let stopping: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (!renewing || inFlight || renewalFailed || input.signal?.aborted) return;
    inFlight = (async () => {
      const result = await Checkpoint.updateOne(
        ownedFilter(),
        { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } },
        DURABLE_WRITE
      );
      if (!result.matchedCount)
        throw new Error("analytics_projection_lease_lost");
    })()
      .catch(error => {
        failure = error;
        renewalFailed = true;
      })
      .finally(() => {
        inFlight = null;
      });
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const stopTimer = () => {
    renewing = false;
    clearInterval(heartbeat);
  };
  input.signal?.addEventListener("abort", stopTimer, { once: true });
  if (input.signal?.aborted) stopTimer();
  const stopRenewing = async () => {
    stopTimer();
    input.signal?.removeEventListener("abort", stopTimer);
    await inFlight;
  };
  const assertOwned = async () => {
    throwIfAnalyticsAborted(input.signal);
    await inFlight;
    throwIfAnalyticsAborted(input.signal);
    if (renewalFailed) throw failure;
    if (stopped || !(await Checkpoint.exists(ownedFilter())))
      throw new Error("analytics_projection_lease_lost");
    throwIfAnalyticsAborted(input.signal);
  };
  return {
    assertOwned,
    stopRenewing,
    async update(fields: Record<string, unknown>) {
      if (
        Object.keys(fields).some(
          field =>
            ["workspaceId", "stream", "owner", "fence", "leaseUntil"].includes(
              field
            ) ||
            field.startsWith("$") ||
            field.includes(".")
        )
      )
        throw new Error("analytics_checkpoint_fields_invalid");
      await assertOwned();
      const result = await Checkpoint.updateOne(
        ownedFilter(),
        { $set: fields },
        DURABLE_WRITE
      );
      if (!result.matchedCount)
        throw new Error("analytics_projection_lease_lost");
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      stopping = (async () => {
        await stopRenewing();
        await Checkpoint.updateOne(
          identity,
          { $set: { owner: null, leaseUntil: null } },
          DURABLE_WRITE
        );
      })();
      return stopping;
    },
  };
}

export async function acquireAnalyticsRuntimeLease(input: {
  workspaceId: string;
  stream: RuntimeStream;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) return null;
  const key = { workspaceId: input.workspaceId, stream: input.stream };
  try {
    await Checkpoint.updateOne(
      key,
      { $setOnInsert: key },
      { upsert: true, ...DURABLE_WRITE }
    );
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
  }
  const owner = randomUUID();
  const now = new Date();
  const lease = await Checkpoint.findOneAndUpdate(
    { ...key, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    {
      $set: { owner, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { fence: 1 },
    },
    { new: true, ...DURABLE_WRITE }
  ).lean<{
    fence: number;
    cursorId: string | null;
    through: Date | null;
    providerSources?: AnalyticsProviderSourceCounts | null;
  } | null>();
  if (!lease) return null;
  const ownership = startCheckpointLease({
    key,
    owner,
    fence: Number(lease.fence),
    signal: input.signal,
  });
  if (input.signal?.aborted) {
    await ownership.stop();
    return null;
  }
  const checkpoint: {
    cursorId: string | null;
    through: Date | null;
    providerSources?: AnalyticsProviderSourceCounts | null;
  } = {
    cursorId: lease.cursorId ?? null,
    through: lease.through ?? null,
    ...(lease.providerSources
      ? { providerSources: lease.providerSources }
      : {}),
  };
  return {
    checkpoint,
    assertOwned: ownership.assertOwned,
    stop: ownership.stop,
    async update(fields: Record<string, unknown>) {
      await ownership.update(fields);
      if ("cursorId" in fields)
        checkpoint.cursorId = fields.cursorId as string | null;
      if ("through" in fields)
        checkpoint.through = fields.through as Date | null;
      if ("providerSources" in fields)
        checkpoint.providerSources =
          fields.providerSources as AnalyticsProviderSourceCounts | null;
    },
  };
}
/** Per-sweep provider outcome; explains an empty template/health collection without a raw error. */
export type AnalyticsProviderSourceCounts = {
  processed: number;
  available: number;
  unavailable: number;
  activationRequired: number;
  permissionRequired?: number;
};

/** Replay owns every bounded stream lease before changing any cursor. */
export async function resetAcquisitionCheckpoints(workspaceId: string) {
  const owner = randomUUID();
  const claimed: Array<{ stream: Stream; fence: number }> = [];
  try {
    for (const stream of ACQUISITION_STREAMS) {
      const key = { workspaceId, stream };
      try {
        await Checkpoint.updateOne(
          key,
          { $setOnInsert: key },
          { upsert: true, ...DURABLE_WRITE }
        );
      } catch (error) {
        if (!isMongoDuplicateKeyError(error)) throw error;
      }
      const leaseAt = new Date();
      const lease = await Checkpoint.findOneAndUpdate(
        {
          ...key,
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: leaseAt } }],
        },
        {
          $set: { owner, leaseUntil: new Date(leaseAt.getTime() + LEASE_MS) },
          $inc: { fence: 1 },
        },
        { new: true, ...DURABLE_WRITE }
      ).lean<{ fence: number } | null>();
      if (!lease) throw new Error("analytics_replay_checkpoint_busy");
      claimed.push({ stream, fence: lease.fence });
    }
    const owned = await Checkpoint.countDocuments({
      workspaceId,
      owner,
      leaseUntil: { $gt: new Date() },
      $or: claimed,
    });
    if (owned !== ACQUISITION_STREAMS.length)
      throw new Error("analytics_projection_lease_lost");
    for (const lease of claimed) {
      const reset = await Checkpoint.updateOne(
        { workspaceId, owner, ...lease, leaseUntil: { $gt: new Date() } },
        {
          $set: {
            cursorAt: null,
            cursorAtExact: null,
            cursorId: null,
            through: null,
            reconcileThrough: null,
            sweepStartedAt: null,
            sweepMaxId: null,
            lastError: null,
            incomplete: true,
          },
        },
        DURABLE_WRITE
      );
      if (reset.matchedCount !== 1)
        throw new Error("analytics_projection_lease_lost");
    }
  } finally {
    for (const lease of claimed) {
      await Checkpoint.updateOne(
        { workspaceId, owner, ...lease },
        { $set: { owner: null, leaseUntil: null } },
        DURABLE_WRITE
      );
    }
  }
}

type EntryFact = ReturnType<typeof acquisitionEntry>;
type Link = {
  entryKey: string;
  fallbackEntryKey: string;
  identityCoverage: "click" | "message";
  sourceId: string | null;
  adId: string | null;
  channel: string;
  capturedAt: Date;
  entryOrder: string;
};

async function persistEntry(input: {
  fact: EntryFact;
  fallbackEntryKey: string;
  now: Date;
  fence: number;
  assertLease: () => Promise<void>;
  days: Set<string>;
}) {
  const { fact, now, fence, assertLease, days } = input;
  const addDay = (at: Date) =>
    days.add(new Date(at).toISOString().slice(0, 10));
  let entryKey = fact.entryKey;
  let earliest = fact.capturedAt;
  let entryOrder = fact.entryOrder;
  let identity = fact;
  if (fact.kind === "ad" && fact.sourceMessageId) {
    const key = {
      workspaceId: fact.workspaceId,
      sourceMessageId: fact.sourceMessageId,
    };
    await assertLease();
    try {
      await MessageLink.updateOne(
        key,
        {
          $setOnInsert: {
            ...key,
            conversationId: fact.conversationId,
            fallbackEntryKey: input.fallbackEntryKey,
            entryKey,
            identityCoverage: fact.identityCoverage,
            sourceId: fact.sourceId,
            adId: fact.adId,
            channel: fact.channel,
          },
          $min: { capturedAt: earliest, entryOrder },
          $max: { projectedAt: now },
        },
        { upsert: true }
      );
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) throw error;
    }
    let link = await MessageLink.findOne(key).lean<Link | null>();
    if (!link) throw new Error("analytics_projection_message_link_missing");
    if (!link.adId && fact.adId) {
      await assertLease();
      await MessageLink.updateOne(
        { ...key, adId: null },
        { $set: { adId: fact.adId } }
      );
      link = await MessageLink.findOne(key).lean<Link | null>();
      if (!link) throw new Error("analytics_projection_message_link_missing");
    }
    if (
      fact.identityCoverage === "click" &&
      link.identityCoverage !== "click"
    ) {
      await assertLease();
      await MessageLink.updateOne(
        { ...key, identityCoverage: "message" },
        {
          $set: {
            entryKey,
            identityCoverage: "click",
            sourceId: link.sourceId,
            adId: link.adId,
            channel: fact.channel,
          },
        }
      );
      link = await MessageLink.findOne(key).lean<Link | null>();
      if (!link) throw new Error("analytics_projection_message_link_missing");
    }
    if (fact.identityCoverage === "click" && link.entryKey !== fact.entryKey)
      throw new Error("analytics_projection_message_identity_changed");
    entryKey = link.entryKey;
    earliest = new Date(
      Math.min(earliest.getTime(), new Date(link.capturedAt).getTime())
    );
    entryOrder = [entryOrder, link.entryOrder].sort()[0];
    identity = {
      ...fact,
      entryKey,
      sourceId: link.sourceId,
      adId: link.adId,
      channel: link.channel,
      identityCoverage: link.identityCoverage,
    };
    if (link.identityCoverage === "click") {
      const fallbacks = new Set([
        link.fallbackEntryKey,
        input.fallbackEntryKey,
      ]);
      for (const fallbackKey of fallbacks) {
        if (fallbackKey === entryKey) continue;
        const fallback = await Entry.findOne({
          workspaceId: fact.workspaceId,
          entryKey: fallbackKey,
          identityCoverage: "message",
          conversationId: fact.conversationId,
        })
          .select("capturedAt entryOrder")
          .lean<{ capturedAt: Date; entryOrder?: string } | null>();
        if (!fallback) continue;
        addDay(fallback.capturedAt);
        earliest = new Date(
          Math.min(earliest.getTime(), new Date(fallback.capturedAt).getTime())
        );
        if (fallback.entryOrder)
          entryOrder = [entryOrder, fallback.entryOrder].sort()[0];
        await assertLease();
        await Entry.updateOne(
          {
            workspaceId: fact.workspaceId,
            entryKey: fallbackKey,
            identityCoverage: "message",
          },
          {
            $set: { supersededBy: entryKey },
            $max: { projectedAt: now, fence },
          }
        );
      }
    }
  }
  const key = { workspaceId: fact.workspaceId, entryKey };
  const previous = await Entry.findOne(key)
    .select("capturedAt")
    .lean<{ capturedAt: Date } | null>();
  if (previous?.capturedAt) addDay(previous.capturedAt);
  if (identity.kind === "ad" && identity.adId) {
    await assertLease();
    await Entry.updateOne(
      { ...key, adId: null },
      { $set: { adId: identity.adId } }
    );
  }
  const immutable: Partial<EntryFact> = { ...identity };
  delete immutable.capturedAt;
  delete immutable.entryOrder;
  await assertLease();
  try {
    await Entry.updateOne(
      key,
      {
        $setOnInsert: immutable,
        $min: { capturedAt: earliest, entryOrder },
        $max: { projectedAt: now, fence },
      },
      { upsert: true }
    );
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    await Entry.updateOne(key, {
      $min: { capturedAt: earliest, entryOrder },
      $max: { projectedAt: now, fence },
    });
  }
  addDay(earliest);
}

async function observePurchase(
  row: Record<string, unknown>,
  workspaceId: string,
  now: Date
) {
  if (
    row.conversionType !== "sale" ||
    typeof row.customerId !== "string" ||
    !row.customerId.trim()
  )
    return;
  const customerId = row.customerId;
  const sourceId =
    typeof row.sourceId === "string" && row.sourceId ? row.sourceId : null;
  const currency =
    typeof row.currency === "string" && row.currency ? row.currency : null;
  for (const scope of ["workspace", ...(sourceId ? ["source"] : [])]) {
    const key = {
      workspaceId,
      scope,
      sourceId: scope === "source" ? sourceId : null,
      customerId,
      currency,
    };
    const update = {
      $setOnInsert: key,
      $min: { firstPurchase: new Date(String(row.occurredAt)) },
      $max: { projectedAt: now },
    };
    try {
      await PurchaseObservation.updateOne(key, update, {
        upsert: true,
        ...DURABLE_WRITE,
      });
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) throw error;
      await PurchaseObservation.updateOne(key, update, DURABLE_WRITE);
    }
  }
}

export function sourceCursor(
  workspaceId: string,
  cursorAt: Date | null,
  cursorId: string | null,
  through: Date
) {
  return {
    workspaceId,
    updatedAt: { $lte: through },
    ...(cursorAt && cursorId
      ? {
          $or: [
            { updatedAt: { $gt: cursorAt, $lte: through } },
            {
              updatedAt: cursorAt,
              _id: { $gt: new mongoose.Types.ObjectId(cursorId) },
            },
          ],
        }
      : {}),
  };
}

/** An existing durable source is the replay log; do not acknowledge a page before facts and replacement rollups. */
export async function projectAcquisitionPage(input: {
  workspaceId: string;
  stream: Stream;
  batchSize?: number;
  now?: Date;
  supabase?: SupabaseClient;
  signal?: AbortSignal;
}) {
  throwIfAnalyticsAborted(input.signal);
  const now = input.now || new Date();
  const leaseAt = new Date();
  const limit = Math.min(500, Math.max(1, input.batchSize || 500));
  const owner = randomUUID();
  const reconciliation = input.stream.endsWith("_reconciliation");
  const sourceStream = input.stream.replace("_reconciliation", "") as
    | "messages"
    | "conversations"
    | "conversions";
  const key = { workspaceId: input.workspaceId, stream: input.stream };
  const availableLease = {
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: leaseAt } }],
  };
  const cooldownBefore = new Date(now.getTime() - RECONCILIATION_COOLDOWN_MS);
  try {
    await Checkpoint.updateOne(key, { $setOnInsert: key }, { upsert: true });
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
  }
  // Mark partial-page coverage atomically with its lease before projection writes.
  // A finite sweep continues immediately; a completed one pauses without fence churn.
  const lease = await Checkpoint.findOneAndUpdate(
    {
      ...key,
      ...availableLease,
      ...(reconciliation
        ? {
            $and: [
              {
                $or: [
                  { sweepStartedAt: { $ne: null } },
                  { incomplete: true },
                  { reconcileThrough: null },
                  { through: null },
                  { through: { $lte: cooldownBefore } },
                ],
              },
            ],
          }
        : {}),
    },
    {
      $set: {
        owner,
        leaseUntil: new Date(leaseAt.getTime() + LEASE_MS),
        incomplete: true,
      },
      $inc: { fence: 1 },
    },
    { new: true, ...DURABLE_WRITE }
  ).lean<{
    fence: number;
    cursorAt: Date | null;
    cursorAtExact?: string | null;
    cursorId: string | null;
    through: Date | null;
    sweepStartedAt: Date | null;
    sweepMaxId: string | null;
  } | null>();
  if (!lease) {
    if (
      reconciliation &&
      (await Checkpoint.exists({
        ...key,
        ...availableLease,
        sweepStartedAt: null,
        incomplete: { $ne: true },
        reconcileThrough: { $ne: null },
        through: { $gt: cooldownBefore },
      }))
    )
      return { status: "idle" as const, processed: 0 };
    return { status: "busy" as const, processed: 0 };
  }
  const fence = Number(lease.fence);
  const ownership = startCheckpointLease({
    key,
    owner,
    fence,
    signal: input.signal,
  });
  const assertLease = ownership.assertOwned;
  try {
    await assertLease();
    let rows: Array<Record<string, unknown>>;
    let outstanding = false;
    let sweepStartedAt = lease.sweepStartedAt;
    let sweepMaxId = lease.sweepMaxId;
    if (reconciliation && !sweepStartedAt) {
      sweepStartedAt = now;
      if (sourceStream !== "conversions") {
        const model = sourceStream === "messages" ? Message : Conversation;
        const last = await model
          .findOne({ workspaceId: input.workspaceId })
          .sort({ _id: -1 })
          .select("_id")
          .maxTimeMS(SOURCE_QUERY_TIMEOUT_MS)
          .lean<{ _id: mongoose.Types.ObjectId } | null>();
        sweepMaxId = last ? String(last._id) : "000000000000000000000000";
      }
      await assertLease();
      const saved = await Checkpoint.updateOne(
        { ...key, owner, fence, leaseUntil: { $gt: new Date() } },
        { $set: { sweepStartedAt, sweepMaxId } }
      );
      if (!saved.modifiedCount)
        throw new Error("analytics_projection_lease_lost");
    }
    if (sourceStream === "conversions") {
      if (!input.supabase) throw new Error("analytics_ledger_client_required");
      const { data, error } = await input.supabase
        .rpc(
          reconciliation
            ? "get_analytics_conversion_page"
            : "claim_analytics_conversion_page",
          reconciliation
            ? {
                p_workspace_id: input.workspaceId,
                p_through: sweepStartedAt!.toISOString(),
                p_after_at:
                  lease.cursorAtExact || lease.cursorAt?.toISOString() || null,
                p_after_id: lease.cursorId || null,
                p_limit: limit,
              }
            : {
                p_workspace_id: input.workspaceId,
                p_claim_token: owner,
                p_limit: limit,
              }
        )
        .abortSignal(timedSignal(input.signal));
      const page = reconciliation ? data : data?.rows;
      if (
        error ||
        !Array.isArray(page) ||
        page.length > limit ||
        (!reconciliation && typeof data?.outstanding !== "boolean")
      )
        throw new Error("analytics_ledger_page_unavailable");
      rows = page;
      outstanding = !reconciliation && data.outstanding;
      for (const row of rows) {
        if (
          typeof row.conversionId !== "string" ||
          typeof row.conversationId !== "string" ||
          !Number.isFinite(new Date(String(row.ledgerCreatedAt)).getTime()) ||
          !Number.isFinite(new Date(String(row.occurredAt)).getTime()) ||
          (!reconciliation &&
            (row.claimToken !== owner ||
              !Number.isSafeInteger(row.claimFence) ||
              Number(row.claimFence) < 1))
        )
          throw new Error("analytics_ledger_page_invalid");
        await assertLease();
        await ConversionFact.updateOne(
          { workspaceId: input.workspaceId, conversionId: row.conversionId },
          {
            $setOnInsert: {
              ...row,
              workspaceId: input.workspaceId,
              projectedAt: now,
              fence,
            },
          },
          { upsert: true, ...DURABLE_WRITE }
        );
        await assertLease();
        await observePurchase(row, input.workspaceId, now);
      }
      if (!reconciliation && rows.length) {
        await assertLease();
        const ack = await input.supabase
          .rpc("ack_analytics_conversion_page", {
            p_workspace_id: input.workspaceId,
            p_claims: rows.map(row => ({
              conversionId: row.conversionId,
              claimToken: row.claimToken,
              claimFence: row.claimFence,
            })),
          })
          .abortSignal(timedSignal(input.signal));
        if (ack.error || ack.data !== rows.length)
          throw new Error("analytics_ledger_acknowledgment_failed");
      }
    } else {
      const model = sourceStream === "messages" ? Message : Conversation;
      rows = await model
        .find(
          reconciliation
            ? {
                workspaceId: input.workspaceId,
                _id: {
                  $lte: new mongoose.Types.ObjectId(sweepMaxId!),
                  ...(lease.cursorId
                    ? { $gt: new mongoose.Types.ObjectId(lease.cursorId) }
                    : {}),
                },
              }
            : sourceCursor(
                input.workspaceId,
                lease.cursorAt,
                lease.cursorId,
                now
              )
        )
        .sort(reconciliation ? { _id: 1 } : { updatedAt: 1, _id: 1 })
        .limit(limit)
        .select(
          "_id workspaceId sourceId channel conversation createdAt updatedAt date direction whatsappReferral"
        )
        .maxTimeMS(SOURCE_QUERY_TIMEOUT_MS)
        .lean();
      const conversationIds = rows
        .map(row => (sourceStream === "messages" ? row.conversation : row._id))
        .filter(id => mongoose.isValidObjectId(id));
      const sources = await Conversation.find({
        workspaceId: input.workspaceId,
        _id: { $in: conversationIds },
      })
        .select("_id sourceId")
        .maxTimeMS(SOURCE_QUERY_TIMEOUT_MS)
        .lean();
      const sourceByConversation = new Map(
        sources.map((row: { _id: unknown; sourceId?: string }) => [
          String(row._id),
          row.sourceId || null,
        ])
      );
      const firstMessages =
        sourceStream === "conversations"
          ? await Conversation.aggregate([
              {
                $match: {
                  workspaceId: input.workspaceId,
                  _id: { $in: conversationIds },
                },
              },
              {
                $lookup: {
                  from: Message.collection.name,
                  let: { conversation: "$_id" },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ["$workspaceId", input.workspaceId] },
                            { $eq: ["$conversation", "$$conversation"] },
                            { $eq: ["$direction", "inbound"] },
                          ],
                        },
                      },
                    },
                    { $sort: { date: 1, _id: 1 } },
                    { $limit: 1 },
                    { $project: { whatsappReferral: 1, date: 1, _id: 1 } },
                  ],
                  as: "firstMessage",
                },
              },
              { $project: { firstMessage: { $first: "$firstMessage" } } },
            ]).option({ maxTimeMS: SOURCE_QUERY_TIMEOUT_MS })
          : [];
      const firstByConversation = new Map(
        firstMessages.map(
          (row: {
            _id: unknown;
            firstMessage?: {
              whatsappReferral?: unknown;
              date?: Date;
              _id?: unknown;
            };
          }) => [String(row._id), row.firstMessage]
        )
      );
      const days = new Set<string>();
      for (const row of rows) {
        if (
          sourceStream === "messages" &&
          (row.direction !== "inbound" ||
            !(row.whatsappReferral as { sourceType?: string })?.sourceType)
        )
          continue;
        const first = firstByConversation.get(String(row._id));
        if (sourceStream === "conversations" && !first) continue; // creation is classified only after the first inbound evidence exists.
        const referral = (
          sourceStream === "messages"
            ? row.whatsappReferral
            : first?.whatsappReferral
        ) as {
          sourceType?: string;
          sourceId?: string;
          ctwaClid?: string;
          capturedAt?: Date;
        } | null;
        if (sourceStream === "messages" && referral?.sourceType !== "ad")
          continue;
        const firstAd =
          sourceStream === "conversations" && referral?.sourceType === "ad";
        const capturedAt = new Date(
          String(
            sourceStream === "messages"
              ? row.date || row.createdAt
              : firstAd
                ? first?.date || row.createdAt
                : row.createdAt
          )
        );
        if (!Number.isFinite(capturedAt.getTime())) continue;
        const conversationId = String(
          sourceStream === "messages" ? row.conversation : row._id
        );
        const entryInput = {
          workspaceId: input.workspaceId,
          conversationId,
          sourceId: sourceByConversation.get(conversationId) || null,
          channel: String(row.channel || "unknown"),
          capturedAt,
          messageId:
            sourceStream === "messages"
              ? String(row._id)
              : firstAd
                ? String(first?._id)
                : undefined,
          referral: sourceStream === "messages" || firstAd ? referral : null,
        };
        const fact = acquisitionEntry(entryInput);
        if (fact.conversationId === "undefined") continue;
        await persistEntry({
          fact,
          fallbackEntryKey: acquisitionEntry({
            ...entryInput,
            referral: referral ? { ...referral, ctwaClid: null } : null,
          }).entryKey,
          now,
          fence,
          assertLease,
          days,
        });
      }
      for (const day of days) {
        await assertLease();
        // A corrected or merged entry can remove the final group from its old day.
        // Reset older groups before replacing all groups; dirty checkpoint coverage
        // remains explicit until this entire page has completed.
        await Daily.updateMany(
          {
            workspaceId: input.workspaceId,
            day,
            $or: [
              { projectedAt: { $lte: now } },
              { projectedAt: { $exists: false } },
            ],
          },
          { $set: { entries: 0, projectedAt: now }, $max: { fence } }
        );
        // Replacing groups makes crash replay and late entry corrections idempotent.
        const cursor = Entry.aggregate([
          {
            $match: {
              workspaceId: input.workspaceId,
              supersededBy: null,
              capturedAt: {
                $gte: new Date(day),
                $lt: new Date(new Date(day).getTime() + 86400_000),
              },
            },
          },
          {
            $group: {
              _id: { kind: "$kind", sourceId: "$sourceId", adId: "$adId" },
              entries: { $sum: 1 },
            },
          },
        ])
          .option({ maxTimeMS: SOURCE_QUERY_TIMEOUT_MS })
          .cursor({ batchSize: 100 });
        for await (const group of cursor) {
          await assertLease();
          const identity = {
            workspaceId: input.workspaceId,
            day,
            ...group._id,
          };
          try {
            await Daily.updateOne(
              {
                ...identity,
                $or: [
                  { projectedAt: { $lte: now } },
                  { projectedAt: { $exists: false } },
                ],
              },
              { $set: { entries: group.entries, projectedAt: now, fence } },
              { upsert: true }
            );
          } catch (error) {
            if (!isMongoDuplicateKeyError(error)) throw error;
          }
        }
      }
    }
    await ownership.stopRenewing();
    await assertLease();
    const last = rows.at(-1);
    // A claimed page is not an empty queue. In-flight expired claims must stay
    // visibly backfilling until a later drain confirms no pending intent.
    const caughtUp =
      rows.length < limit &&
      !(sourceStream === "conversions" && !reconciliation && outstanding);
    // Keyset cursors keep full source precision: a truncated timestamp re-reads
    // every row of its second (or microsecond-bearing ledger instant) and a page
    // filled by one bulk-written instant could never advance.
    const cursorAt =
      reconciliation && sourceStream !== "conversions"
        ? null
        : last
          ? sourceStream === "conversions"
            ? new Date(String(last.ledgerCreatedAt))
            : last.updatedAt instanceof Date
              ? last.updatedAt
              : new Date(String(last.updatedAt))
          : lease.cursorAt;
    // Postgres keeps microseconds; a JavaScript Date cannot carry them.
    const cursorAtExact =
      sourceStream === "conversions" && last
        ? String(last.ledgerCreatedAt)
        : (lease.cursorAtExact ?? null);
    const cursorId = last
      ? String(sourceStream === "conversions" ? last.conversionId : last._id)
      : lease.cursorId;
    const updated = await Checkpoint.updateOne(
      { ...key, owner, fence, leaseUntil: { $gt: new Date() } },
      {
        $set: {
          cursorAt: reconciliation && caughtUp ? null : cursorAt,
          ...(sourceStream === "conversions"
            ? {
                cursorAtExact:
                  reconciliation && caughtUp ? null : cursorAtExact,
              }
            : {}),
          cursorId: reconciliation && caughtUp ? null : cursorId,
          through: caughtUp ? now : lease.through,
          ...(reconciliation && caughtUp
            ? {
                reconcileThrough: sweepStartedAt,
                sweepStartedAt: null,
                sweepMaxId: null,
              }
            : {}),
          leaseUntil: null,
          owner: null,
          lastError: null,
          // A finished page is safe even when its longer sweep has more rows.
          // Live queue coverage must still account for other outstanding claims.
          incomplete:
            sourceStream === "conversions" && !reconciliation && outstanding,
        },
      }
    );
    if (!updated.modifiedCount)
      throw new Error("analytics_projection_lease_lost");
    return {
      status: caughtUp ? ("caught_up" as const) : ("backfilling" as const),
      processed: rows.length,
    };
  } catch (error) {
    await Checkpoint.updateOne(
      { ...key, owner, fence },
      {
        $set: {
          owner: null,
          leaseUntil: null,
          lastError:
            error instanceof Error
              ? error.message
              : "analytics_projection_failed",
        },
      }
    );
    throw error;
  } finally {
    await ownership.stop();
  }
}
