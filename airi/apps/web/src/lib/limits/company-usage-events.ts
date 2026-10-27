import { publishGooglePubSubJsonMessage } from "@/lib/google/pubsub-json-publisher";
import { readEnv } from "@icecore/shared/lib/env";
import {
  buildWorkspaceUsageEventId,
  WORKSPACE_USAGE_EVENT_CONTRACT_VERSION,
  WORKSPACE_USAGE_PUBSUB_TOPIC_DEFAULT,
  type WorkspaceUsageEvent,
  type WorkspaceUsageEventMetadata,
  type WorkspaceUsageMetric,
} from "@icecore/temporal";
import type { SupabaseClient } from "@supabase/supabase-js";
import "server-only";

type EmitWorkspaceUsageDeltaInput = {
  workspaceId: string | null;
  companyId?: string | null;
  metric: WorkspaceUsageMetric;
  delta: number;
  objectId: string;
  occurredAt?: string | Date | null;
  source?: string | null;
  metadata?: WorkspaceUsageEventMetadata;
};

type PublishWorkspaceUsageEventResult =
  | { ok: true; messageId?: string | null }
  | { ok: false; skipped: true; reason: string };

export function getWorkspaceUsagePubSubTopic(): string {
  return (
    readEnv("WORKSPACE_USAGE_PUBSUB_TOPIC") ||
    WORKSPACE_USAGE_PUBSUB_TOPIC_DEFAULT
  );
}

export function workspaceUsageEventsEnabled(): boolean {
  return readEnv("WORKSPACE_USAGE_EVENTS_ENABLED") !== "false";
}

export async function emitWorkspaceUsageDelta(
  input: EmitWorkspaceUsageDeltaInput,
  options: { supabase?: SupabaseClient } = {}
): Promise<PublishWorkspaceUsageEventResult> {
  if (!workspaceUsageEventsEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const delta = Math.trunc(input.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, skipped: true, reason: "zero_delta" };
  }

  const companyId =
    input.companyId ||
    (input.workspaceId
      ? await resolveWorkspaceCompanyId(
          options.supabase ?? (await getSupabaseAdmin()),
          input.workspaceId
        )
      : null);

  if (!companyId) {
    return { ok: false, skipped: true, reason: "missing_company" };
  }

  const occurredAt = normalizeOccurredAt(input.occurredAt);
  const source = input.source || input.metadata?.source || "web";
  const event: WorkspaceUsageEvent = {
    schemaVersion: WORKSPACE_USAGE_EVENT_CONTRACT_VERSION,
    eventId: buildWorkspaceUsageEventId({
      metric: input.metric,
      companyId,
      workspaceId: input.workspaceId,
      objectId: input.objectId,
      delta,
      source,
    }),
    workspaceId: input.workspaceId,
    companyId,
    metric: input.metric,
    delta,
    objectId: input.objectId,
    occurredAt,
    metadata: {
      ...input.metadata,
      source,
    },
  };

  const result = await publishGooglePubSubJsonMessage({
    projectIdEnvName: "WORKSPACE_USAGE_PUBSUB_PROJECT_ID",
    topic: getWorkspaceUsagePubSubTopic(),
    message: event,
    orderingKey: companyId,
    attributes: {
      schemaVersion: String(WORKSPACE_USAGE_EVENT_CONTRACT_VERSION),
      companyId,
      workspaceId: input.workspaceId || "",
      metric: input.metric,
    },
  });

  return { ok: true, messageId: result.messageId };
}

export function emitWorkspaceUsageDeltaBestEffort(
  input: EmitWorkspaceUsageDeltaInput,
  options: { supabase?: SupabaseClient; logContext?: string } = {}
): void {
  void emitWorkspaceUsageDelta(input, options).catch(error => {
    console.warn("[usage-events] Failed to publish workspace usage event", {
      context: options.logContext,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      metric: input.metric,
      objectId: input.objectId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function resolveWorkspaceCompanyId(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const companyId = (data as { company_id?: unknown } | null)?.company_id;
  return typeof companyId === "string" && companyId.trim()
    ? companyId.trim()
    : null;
}

async function getSupabaseAdmin(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  return supabaseAdmin;
}

function normalizeOccurredAt(value: string | Date | null | undefined): string {
  const parsed = value instanceof Date ? value : value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}
