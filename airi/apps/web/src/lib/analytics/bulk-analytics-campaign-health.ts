import { getCampaignDispatchBatchAggregates } from "@/lib/campaign/campaign-history-store";
import { serializeCampaignHistoryOperation } from "@/lib/campaign/campaign-operation-route-utils";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import Message from "@/models/message";
import MessageDeliveryEvent from "@/models/message-delivery-event";
import {
  listWhatsAppPhoneIdentityVariants,
  normalizeWhatsAppPhone,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  extractWhatsAppWamidFingerprint,
  listWhatsAppMessageIdLookupKeys,
  stripWhatsAppMessageIdPrefix,
} from "@icecore/shared/lib/whatsapp/message-id";
import type {
  BulkCampaignAttemptHealth,
  BulkCampaignHealthResponse,
  BulkCampaignRecipientHealth,
  BulkRecipientEvidenceAttempt,
  BulkRecipientEvidenceResponse,
} from "./bulk-analytics-campaign-health-contract";
import { withAnalyticsQueryBudget } from "./analytics-query-service";

const CAMPAIGN_LIMIT = 100;
const ANCESTRY_LIMIT = 20;
const ROW_LIMIT = 10_000;
const HISTORY_LIMIT = 500;
const PAGE_SIZE = 500;
const HISTORY_SELECT =
  "id,workspace_id,channel,name,total_recipients,retry_of_campaign_id,retry_kind,created_at,delivery_ledger_started_at,dispatch_status,requested_at,scheduled_at,dispatch_expires_at,started_at,progress_at,finished_at,cancelled_at,expired_at,processed_count,accepted_count,attempted_count,not_attempted_count,successful_sends,failed_sends,stop_reason,provider_circuit_state,provider_circuit_provider,provider_circuit_code,provider_circuit_opened_at";
const LEDGER_SELECT =
  "id,campaign_id,channel,recipient,phone,message_id,status,attempted_at,created_at,updated_at,delivered_at,read_at,failed_at,error_code,error_message,source_id:dispatch_snapshot->>sourceId,snapshot_phone:dispatch_snapshot->recipient->>phone";
type CampaignRow = {
  id: string;
  workspace_id: string;
  channel: string;
  name: string | null;
  total_recipients: number;
  retry_of_campaign_id: string | null;
  created_at: string;
  delivery_ledger_started_at: string | null;
  dispatch_status: string | null;
};
type LedgerRow = {
  id: string;
  campaign_id: string;
  channel: string;
  recipient: string | null;
  phone: string | null;
  message_id: string | null;
  status: string;
  attempted_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  error_code: number | null;
  error_message: string | null;
  source_id: string | null;
  snapshot_phone: string | null;
};
type HistoricalMessage = {
  messageId?: string;
  date?: Date | string;
  chat?: unknown;
  origin?: { campaignId?: string; sourceId?: string };
  temporalDispatch?: { state?: string };
  delivery?: {
    status?: string;
    recipientWaId?: string;
    recipientId?: string;
    readAt?: Date | string;
    deliveredAt?: Date | string;
    failedAt?: Date | string;
    errorCode?: number;
    errorMessage?: string;
  };
};
type HistoricalReceipt = {
  messageId?: string;
  campaignId?: string;
  sourceId?: string;
  eventAt?: Date | string;
  status?: string;
  recipientWaId?: string;
  recipientId?: string;
  errorCode?: number;
  errorMessage?: string;
};

export class BulkCampaignHealthRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = "BulkCampaignHealthRequestError";
  }
}
function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
function wamid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = stripWhatsAppMessageIdPrefix(value.trim());
  return raw.startsWith("wamid.") ? raw : null;
}
function attemptKey(value: unknown): string | null {
  const id = wamid(value);
  return id ? extractWhatsAppWamidFingerprint(id) || id : null;
}
function phone(row: LedgerRow): string | undefined {
  return (
    normalizeWhatsAppPhone(row.recipient) ||
    normalizeWhatsAppPhone(row.phone) ||
    normalizeWhatsAppPhone(row.snapshot_phone)
  );
}
/** Compare every known phone identity; choosing one field hides conflicts. */
function phoneIdentities(...values: unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap(value => {
        const identity = normalizeWhatsAppPhone(
          typeof value === "number" && Number.isSafeInteger(value)
            ? String(value)
            : value
        );
        return identity ? [identity] : [];
      })
    ),
  ];
}
function disputedPhone(canonical: string, ...values: unknown[]): boolean {
  return phoneIdentities(...values).some(identity => identity !== canonical);
}
function attempted(row: LedgerRow): boolean {
  return (
    !!row.attempted_at ||
    !!wamid(row.message_id) ||
    !!row.failed_at ||
    ["attempted", "failed", "sent", "accepted", "delivered", "read"].includes(
      row.status
    )
  );
}
function outcome(row: LedgerRow): BulkRecipientEvidenceAttempt["status"] {
  if (wamid(row.message_id) && (row.read_at || row.status === "read"))
    return "read";
  if (wamid(row.message_id) && (row.delivered_at || row.status === "delivered"))
    return "delivered";
  if (row.failed_at || row.status === "failed") return "failed";
  if (wamid(row.message_id)) return "accepted";
  return attempted(row) ? "uncertain" : "untouched";
}
function timestamp(row: LedgerRow): string {
  return (
    row.attempted_at ||
    row.failed_at ||
    row.delivered_at ||
    row.read_at ||
    row.created_at
  );
}
function checkSignal(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason || new Error("Analytics query cancelled.");
}

async function loadFamily(
  workspaceId: string,
  campaignId: string,
  signal: AbortSignal
) {
  const reasons = new Set<string>();
  const family = new Map<string, CampaignRow>();
  const load = async (id: string) => {
    checkSignal(signal);
    const result = await supabaseAdmin
      .from("campaign_history")
      .select(HISTORY_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .abortSignal(signal)
      .maybeSingle();
    if (result.error) throw new Error("Campaign ancestry is unavailable.");
    const row = result.data as CampaignRow | null;
    if (
      !row ||
      row.workspace_id !== workspaceId ||
      row.id !== id ||
      row.channel !== "whatsapp"
    ) {
      throw new BulkCampaignHealthRequestError(
        "Campaign not found in this workspace/channel.",
        404
      );
    }
    return row;
  };
  let root = await load(campaignId);
  const ancestry = new Set<string>();
  for (let depth = 0; ; depth++) {
    if (ancestry.has(root.id))
      throw new BulkCampaignHealthRequestError("Campaign ancestry is cyclic.");
    ancestry.add(root.id);
    if (!root.retry_of_campaign_id) break;
    if (depth >= ANCESTRY_LIMIT)
      throw new BulkCampaignHealthRequestError(
        "Campaign ancestry exceeds twenty levels."
      );
    root = await load(root.retry_of_campaign_id);
  }
  family.set(root.id, root);
  let frontier = [root.id];
  for (let depth = 0; frontier.length; depth++) {
    checkSignal(signal);
    if (depth >= ANCESTRY_LIMIT) {
      reasons.add("family_depth_limit");
      break;
    }
    const result = await supabaseAdmin
      .from("campaign_history")
      .select(HISTORY_SELECT)
      .eq("workspace_id", workspaceId)
      .eq("channel", "whatsapp")
      .in("retry_of_campaign_id", frontier)
      .order("created_at")
      .order("id")
      .limit(CAMPAIGN_LIMIT + 1)
      .abortSignal(signal);
    if (result.error) throw new Error("Campaign family is unavailable.");
    const next: string[] = [];
    for (const row of (result.data || []) as CampaignRow[]) {
      if (
        row.workspace_id !== workspaceId ||
        row.channel !== root.channel ||
        !frontier.includes(row.retry_of_campaign_id || "")
      ) {
        throw new Error("Campaign family returned invalid lineage.");
      }
      if (family.has(row.id))
        throw new BulkCampaignHealthRequestError("Campaign family is cyclic.");
      if (family.size >= CAMPAIGN_LIMIT) {
        reasons.add("family_campaign_limit");
        break;
      }
      family.set(row.id, row);
      next.push(row.id);
    }
    if (reasons.has("family_campaign_limit")) break;
    frontier = next;
  }
  return { root, rows: [...family.values()], reasons };
}

async function readLedger(params: {
  campaignIds: string[];
  signal: AbortSignal;
  limit: number;
  aliases?: string[];
  sourceId?: string;
}) {
  const rows: LedgerRow[] = [];
  const seenRows = new Set<string>();
  let offset = 0;
  while (rows.length <= params.limit) {
    checkSignal(params.signal);
    const size = Math.min(PAGE_SIZE, params.limit + 1 - rows.length);
    let query = supabaseAdmin
      .from("campaign_messages")
      .select(LEDGER_SELECT)
      .in("campaign_id", params.campaignIds)
      .eq("channel", "whatsapp")
      .order("campaign_id")
      .order("id")
      .range(offset, offset + size - 1);
    if (params.aliases) {
      // All aliases are constructed from validated phone digits, never
      // arbitrary PostgREST syntax (legacy '+' formatting is retained too).
      const values = params.aliases.join(",");
      query = query.or(`recipient.in.(${values}),phone.in.(${values})`);
    }
    if (params.sourceId)
      query = query.eq("dispatch_snapshot->>sourceId", params.sourceId);
    const result = await query.abortSignal(params.signal);
    if (result.error)
      throw new Error("Campaign recipient evidence is unavailable.");
    const page = (result.data || []) as LedgerRow[];
    for (const row of page) {
      if (seenRows.has(row.id))
        throw new Error(
          "Campaign evidence changed while paging; refresh required."
        );
      seenRows.add(row.id);
    }
    rows.push(...page);
    if (page.length < size) break;
    offset += page.length;
  }
  const capped = rows.length > params.limit;
  return { rows: rows.slice(0, params.limit), capped };
}

export async function getBulkCampaignHealth(params: {
  workspaceId: string;
  campaignId: string;
  signal?: AbortSignal;
}): Promise<BulkCampaignHealthResponse> {
  return withAnalyticsQueryBudget({
    signal: params.signal,
    run: async ({ signal }) => {
      const observedAt = new Date().toISOString();
      const family = await loadFamily(
        params.workspaceId,
        params.campaignId,
        signal
      );
      const campaignIds = family.rows.map(row => row.id);
      // Existing SQL aggregate owns lifecycle summaries, never recipient dedupe.
      const [aggregates, ledger] = await Promise.all([
        getCampaignDispatchBatchAggregates({
          supabase: {
            from: table => supabaseAdmin.from(table),
            rpc: (name, args) =>
              supabaseAdmin.rpc(name, args).abortSignal(signal),
          },
          workspaceId: params.workspaceId,
          campaignIds,
        }),
        readLedger({ campaignIds, signal, limit: ROW_LIMIT }),
      ]);
      checkSignal(signal);
      const reasons = family.reasons;
      if (ledger.capped) reasons.add("recipient_row_limit");
      const counts = new Map<string, number>();
      const identities = new Map<string, LedgerRow[]>();
      const disputedRows = new Set<string>();
      const providerAttempts = new Map<
        string,
        { rows: LedgerRow[]; phones: Set<string> }
      >();
      for (const row of ledger.rows) {
        if (
          !campaignIds.includes(row.campaign_id) ||
          row.channel !== "whatsapp"
        )
          throw new Error("Recipient evidence scope is invalid.");
        counts.set(row.campaign_id, (counts.get(row.campaign_id) || 0) + 1);
        const key = phone(row);
        if (!key) {
          reasons.add("recipient_identity_unavailable");
          continue;
        }
        const rowIdentities = phoneIdentities(
          row.recipient,
          row.phone,
          row.snapshot_phone
        );
        if (rowIdentities.length > 1) {
          reasons.add("recipient_snapshot_identity_disputed");
          disputedRows.add(row.id);
        }
        const group = identities.get(key) || [];
        group.push(row);
        identities.set(key, group);
        const id = attemptKey(row.message_id);
        if (id) {
          const attempt = providerAttempts.get(id) || {
            rows: [],
            phones: new Set<string>(),
          };
          attempt.rows.push(row);
          for (const identity of rowIdentities) attempt.phones.add(identity);
          providerAttempts.set(id, attempt);
        }
      }
      for (const campaign of family.rows) {
        if (
          (counts.get(campaign.id) || 0) <
          nonNegative(campaign.total_recipients)
        )
          reasons.add("recipient_snapshots_not_fully_retained");
        if (!aggregates.has(campaign.id))
          reasons.add("dispatch_aggregate_unavailable");
      }
      const recipients: BulkCampaignRecipientHealth = {
        planned: identities.size,
        attempted: 0,
        accepted: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        awaitingReceipts: 0,
        uncertain: 0,
        untouched: 0,
      };
      const attempts: BulkCampaignAttemptHealth = {
        accepted: providerAttempts.size,
        delivered: 0,
        read: 0,
        failed: 0,
        awaitingReceipts: 0,
        uncertain: 0,
      };
      // Rejected/uncertain attempts have no WAMID. Their immutable ledger row
      // identifies the attempt; a later successful retry must not erase them.
      for (const row of ledger.rows) {
        if (!attempted(row) || wamid(row.message_id)) continue;
        if (outcome(row) === "failed") attempts.failed++;
        else attempts.uncertain++;
      }
      const disputed = new Set<string>();
      const providerOutcomes = new Map<
        string,
        BulkRecipientEvidenceAttempt["status"]
      >();
      for (const [id, attempt] of providerAttempts) {
        if (attempt.phones.size > 1) {
          disputed.add(id);
          reasons.add("provider_recipient_identity_disputed");
          providerOutcomes.set(id, "uncertain");
          attempts.uncertain++;
          continue;
        }
        const outcomes = attempt.rows.map(outcome);
        const read = outcomes.includes("read");
        const delivered = read || outcomes.includes("delivered");
        providerOutcomes.set(
          id,
          read
            ? "read"
            : delivered
              ? "delivered"
              : outcomes.includes("failed")
                ? "failed"
                : "accepted"
        );
        if (read) attempts.read++;
        if (delivered) attempts.delivered++;
        else if (outcomes.includes("failed")) attempts.failed++;
        else attempts.awaitingReceipts++;
      }
      const errors = new Map<
        string,
        { code: string | null; message: string | null; count: number }
      >();
      for (const rows of identities.values()) {
        const attemptedRows = rows
          .filter(attempted)
          .sort(
            (a, b) =>
              timestamp(b).localeCompare(timestamp(a)) ||
              b.updated_at.localeCompare(a.updated_at)
          );
        if (!attemptedRows.length) {
          recipients.untouched++;
          continue;
        }
        recipients.attempted++;
        const validRows = attemptedRows.filter(
          row =>
            !!wamid(row.message_id) &&
            !disputedRows.has(row.id) &&
            !disputed.has(attemptKey(row.message_id) || "")
        );
        if (validRows.some(row => !!wamid(row.message_id)))
          recipients.accepted++;
        if (validRows.some(row => outcome(row) === "read")) recipients.read++;
        if (validRows.some(row => ["delivered", "read"].includes(outcome(row))))
          recipients.delivered++;
        const latest = attemptedRows[0]!;
        const current = disputedRows.has(latest.id)
          ? "uncertain"
          : providerOutcomes.get(attemptKey(latest.message_id) || "") ||
            outcome(latest);
        if (current === "failed") {
          recipients.failed++;
          const code =
            latest.error_code == null ? null : String(latest.error_code);
          const error = errors.get(code || "unknown") || {
            code,
            message: latest.error_message,
            count: 0,
          };
          error.count++;
          errors.set(code || "unknown", error);
        } else if (current === "accepted") recipients.awaitingReceipts++;
        else if (current === "uncertain") recipients.uncertain++;
      }
      const complete = reasons.size === 0;
      const exact = <T extends Record<string, number>>(value: T) =>
        Object.fromEntries(
          Object.entries(value).map(([key, count]) => [
            key,
            complete ? count : null,
          ])
        ) as { [K in keyof T]: number | null };
      return {
        observedAt,
        family: {
          rootCampaignId: family.root.id,
          campaignIds,
          campaigns: family.rows.map(row => ({
            id: row.id,
            name: row.name || "",
            status: row.dispatch_status,
            totalRecipients: nonNegative(row.total_recipients),
            operation: serializeCampaignHistoryOperation({
              row,
              aggregate: aggregates.get(row.id) || null,
            }),
          })),
        },
        recipients: exact(recipients),
        attempts: exact(attempts),
        observed: { recipients, attempts },
        errors: [...errors.values()].sort((a, b) => b.count - a.count),
        coverage: {
          complete,
          reasons: [...reasons],
          scannedRows: ledger.rows.length,
          rowLimit: ROW_LIMIT,
          retainedSince:
            family.rows
              .map(row => row.delivery_ledger_started_at)
              .filter((value): value is string => !!value)
              .sort()[0] || null,
        },
      };
    },
  });
}

function evidenceAttempt(
  row: LedgerRow,
  canonical: string
): BulkRecipientEvidenceAttempt {
  return {
    campaignId: row.campaign_id,
    sourceId: row.source_id,
    messageId: wamid(row.message_id),
    attemptedAt: attempted(row) ? timestamp(row) : null,
    status: outcome(row),
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message,
    disputedIdentity: disputedPhone(
      canonical,
      row.recipient,
      row.phone,
      row.snapshot_phone
    ),
  };
}

export async function getBulkRecipientEvidence(params: {
  workspaceId: string;
  recipient: string;
  campaignId?: string;
  sourceId?: string;
  signal?: AbortSignal;
}): Promise<BulkRecipientEvidenceResponse> {
  const canonical = normalizeWhatsAppPhone(params.recipient);
  if (!canonical)
    throw new BulkCampaignHealthRequestError(
      "A valid recipient phone is required."
    );
  return withAnalyticsQueryBudget({
    signal: params.signal,
    run: async ({ signal, remainingMs }) => {
      const observedAt = new Date().toISOString();
      const reasons = new Set<string>();
      // Campaign context validates access; history intentionally includes older
      // workspace sources, not just the selected campaign's phone_number_id.
      const selectedFamily = params.campaignId
        ? await loadFamily(params.workspaceId, params.campaignId, signal)
        : null;
      for (const reason of selectedFamily?.reasons || []) reasons.add(reason);
      const history = await supabaseAdmin
        .from("campaign_history")
        .select("id,created_at,delivery_ledger_started_at")
        .eq("workspace_id", params.workspaceId)
        .eq("channel", "whatsapp")
        .order("created_at", { ascending: false })
        .order("id")
        .limit(CAMPAIGN_LIMIT + 1)
        .abortSignal(signal);
      if (history.error)
        throw new Error("Retained campaign history is unavailable.");
      const campaigns = [
        ...new Set([
          ...(selectedFamily?.rows.map(row => row.id) || []),
          ...(history.data || []).map(row => row.id),
        ]),
      ];
      if (campaigns.length > CAMPAIGN_LIMIT)
        reasons.add("historical_campaign_limit");
      const aliases = listWhatsAppPhoneIdentityVariants(canonical);
      const lookupAliases = [...aliases, ...aliases.map(value => `+${value}`)];
      const ledger = campaigns.length
        ? await readLedger({
            campaignIds: campaigns.slice(0, CAMPAIGN_LIMIT),
            signal,
            limit: HISTORY_LIMIT,
            aliases: lookupAliases,
            sourceId: params.sourceId,
          })
        : { rows: [], capped: false };
      if (ledger.capped) reasons.add("historical_recipient_row_limit");
      let evidenceRows = ledger.rows.map(row =>
        evidenceAttempt(row, canonical)
      );
      let mongoCount = 0;
      try {
        await connectDB();
        checkSignal(signal);
        const phoneKeys = [
          ...lookupAliases,
          ...lookupAliases.map(value => `wa_${value}`),
        ];
        const sourceFilter = params.sourceId
          ? { "origin.sourceId": params.sourceId }
          : {};
        const messages = await Message.find({
          workspaceId: params.workspaceId,
          channel: "whatsapp",
          direction: "outbound",
          ...sourceFilter,
          $or: [
            { "delivery.recipientId": { $in: aliases } },
            { "delivery.recipientWaId": { $in: aliases } },
            { chat: { $in: phoneKeys } },
          ],
        })
          .select(
            "messageId date chat origin.campaignId origin.sourceId delivery temporalDispatch.state"
          )
          .sort({ date: -1, _id: -1 })
          .limit(HISTORY_LIMIT + 1)
          .setOptions({ signal })
          .maxTimeMS(remainingMs())
          .lean();
        checkSignal(signal);
        if (messages.length > HISTORY_LIMIT)
          reasons.add("historical_message_limit");
        mongoCount += Math.min(messages.length, HISTORY_LIMIT);
        for (const value of messages.slice(0, HISTORY_LIMIT)) {
          const row = value as unknown as HistoricalMessage;
          const delivery = row.delivery || {};
          const id = wamid(row.messageId);
          const asDate = (date: unknown) =>
            date instanceof Date
              ? date.toISOString()
              : typeof date === "string"
                ? date
                : null;
          const status =
            id && (delivery.readAt || delivery.status === "read")
              ? "read"
              : id && (delivery.deliveredAt || delivery.status === "delivered")
                ? "delivered"
                : delivery.failedAt || delivery.status === "failed"
                  ? "failed"
                  : id
                    ? "accepted"
                    : ["reserved", "not_attempted"].includes(
                          row.temporalDispatch?.state || ""
                        )
                      ? "untouched"
                      : "uncertain";
          evidenceRows.push({
            campaignId: row.origin?.campaignId || null,
            sourceId: row.origin?.sourceId || null,
            messageId: id,
            attemptedAt: asDate(row.date),
            status,
            deliveredAt: asDate(delivery.deliveredAt),
            readAt: asDate(delivery.readAt),
            errorCode:
              delivery.errorCode == null ? null : String(delivery.errorCode),
            errorMessage: delivery.errorMessage || null,
            disputedIdentity: disputedPhone(
              canonical,
              delivery.recipientWaId,
              delivery.recipientId,
              row.chat
            ),
          });
        }
        const ids = [
          ...new Set(
            evidenceRows.flatMap(row =>
              row.messageId
                ? listWhatsAppMessageIdLookupKeys(row.messageId)
                : []
            )
          ),
        ];
        checkSignal(signal);
        const events = await MessageDeliveryEvent.find({
          workspaceId: params.workspaceId,
          channel: "whatsapp",
          ...(params.sourceId ? { sourceId: params.sourceId } : {}),
          $or: [
            { recipientId: { $in: aliases } },
            { recipientWaId: { $in: aliases } },
            ...(ids.length ? [{ messageId: { $in: ids } }] : []),
          ],
        })
          .select(
            "messageId campaignId sourceId eventAt status recipientId recipientWaId errorCode errorMessage"
          )
          .sort({ eventAt: -1, _id: -1 })
          .limit(HISTORY_LIMIT + 1)
          .setOptions({ signal })
          .maxTimeMS(remainingMs())
          .lean();
        checkSignal(signal);
        if (events.length > HISTORY_LIMIT)
          reasons.add("historical_receipt_limit");
        mongoCount += Math.min(events.length, HISTORY_LIMIT);
        for (const value of events.slice(0, HISTORY_LIMIT)) {
          const row = value as unknown as HistoricalReceipt;
          const eventAt =
            row.eventAt instanceof Date
              ? row.eventAt.toISOString()
              : String(row.eventAt);
          evidenceRows.push({
            campaignId: row.campaignId || null,
            sourceId: row.sourceId || null,
            messageId: wamid(row.messageId),
            attemptedAt: eventAt,
            status: !wamid(row.messageId)
              ? "uncertain"
              : row.status === "read"
                ? "read"
                : row.status === "delivered"
                  ? "delivered"
                  : row.status === "failed"
                    ? "failed"
                    : "accepted",
            deliveredAt: row.status === "delivered" ? eventAt : null,
            readAt: row.status === "read" ? eventAt : null,
            errorCode: row.errorCode == null ? null : String(row.errorCode),
            errorMessage: row.errorMessage || null,
            disputedIdentity: disputedPhone(
              canonical,
              row.recipientWaId,
              row.recipientId
            ),
          });
        }
      } catch {
        checkSignal(signal);
        reasons.add("retained_message_evidence_unavailable");
      }
      // Multiple stores represent one provider attempt. Preserve conflicts and
      // stronger proof instead of inventing a second accepted send.
      const priorFailedProviderKeys = new Set(
        evidenceRows.flatMap(row => {
          const key = attemptKey(row.messageId);
          return key && (row.status === "failed" || !!row.errorCode)
            ? [key]
            : [];
        })
      );
      const groups = new Map<string, BulkRecipientEvidenceAttempt>();
      const rank = {
        untouched: 0,
        uncertain: 1,
        accepted: 2,
        failed: 3,
        delivered: 4,
        read: 5,
      };
      for (const [index, row] of evidenceRows.entries()) {
        const key =
          attemptKey(row.messageId) ||
          `snapshot:${row.campaignId}:${row.attemptedAt}:${index}`;
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, row);
          continue;
        }
        const disputedIdentity =
          existing.disputedIdentity || row.disputedIdentity;
        const preferred =
          rank[row.status] > rank[existing.status] ? row : existing;
        groups.set(key, {
          ...preferred,
          attemptedAt:
            [existing.attemptedAt, row.attemptedAt]
              .filter((date): date is string => !!date)
              .sort()[0] || null,
          deliveredAt: existing.deliveredAt || row.deliveredAt,
          readAt: existing.readAt || row.readAt,
          errorCode: existing.errorCode || row.errorCode,
          errorMessage: existing.errorMessage || row.errorMessage,
          disputedIdentity,
        });
      }
      evidenceRows = [...groups.values()].sort((a, b) =>
        (b.attemptedAt || "").localeCompare(a.attemptedAt || "")
      );
      if (evidenceRows.some(row => row.disputedIdentity))
        reasons.add("recipient_identity_disputed");
      const valid = evidenceRows.filter(row => !row.disputedIdentity);
      const dates = evidenceRows
        .map(row => row.attemptedAt)
        .filter((date): date is string => !!date)
        .sort();
      return {
        observedAt,
        latestOutcome:
          valid.find(row => row.status !== "untouched")?.status || null,
        attempts: evidenceRows,
        evidence: {
          acceptedWithoutDeliveryProof: valid.some(
            row => row.status === "accepted"
          ),
          delivered: valid.some(
            row => row.status === "delivered" || row.status === "read"
          ),
          read: valid.some(row => row.status === "read"),
          priorFailure: valid.some(
            row =>
              row.status === "failed" ||
              !!row.errorCode ||
              priorFailedProviderKeys.has(attemptKey(row.messageId) || "")
          ),
          disputedIdentity: evidenceRows.some(row => row.disputedIdentity),
        },
        coverage: {
          complete: reasons.size === 0,
          reasons: [...reasons],
          scannedRows: ledger.rows.length + mongoCount,
          rowLimit: HISTORY_LIMIT * 3,
          retainedSince: dates[0] || null,
        },
      };
    },
  });
}
