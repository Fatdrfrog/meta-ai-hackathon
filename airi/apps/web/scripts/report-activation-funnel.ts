import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import mongoose from "mongoose";
import { loadWebOperatorEnv } from "./load-web-operator-env";
import { DEMO_SCENARIO_PRESET_ID } from "../src/lib/scenarios/scenario-presets";
import {
  ACTIVATION_CHANNEL_SOURCE_TYPES,
  assembleActivationWorkspaceFacts,
  buildActivationFunnelReport,
  formatActivationFunnelMarkdown,
  type ActivationCompanyRow,
  type ActivationStepEvent,
} from "../src/lib/onboarding/activation-funnel-report";

// Read-only: Supabase selects and Mongo find/aggregate only.

const PAGE_SIZE = 1000;
const IN_CHUNK = 200;
const INTERNAL_EMAIL_SUFFIX = "@airi.chat";

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

async function selectAll<T>(
  page: (from: number, to: number) => PageResult<T>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += IN_CHUNK) {
    result.push(values.slice(index, index + IN_CHUNK));
  }
  return result;
}

// The chunks are independent reads. A report covers a few thousand ids at
// most, so this is a handful of parallel selects.
async function selectInChunks<T>(
  ids: string[],
  page: (ids: string[], from: number, to: number) => PageResult<T>
): Promise<T[]> {
  const results = await Promise.all(
    chunks(ids).map(chunk => selectAll((from, to) => page(chunk, from, to)))
  );
  return results.flat();
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadCompanies(
  supabase: SupabaseClient,
  since: Date,
  excludedCompanyIds: Set<string>
): Promise<ActivationCompanyRow[]> {
  const companies = await selectAll<{ id: string; created_at: string }>(
    (from, to) =>
      supabase
        .from("companies")
        .select("id, created_at")
        .gte("created_at", since.toISOString())
        .order("created_at")
        .range(from, to)
  );
  const workspaces = await selectInChunks<{
    id: string;
    company_id: string;
    created_at: string;
  }>(
    companies.map(company => company.id),
    (ids, from, to) =>
      supabase
        .from("workspaces")
        .select("id, company_id, created_at")
        .in("company_id", ids)
        .order("created_at")
        .range(from, to)
  );
  const members = await selectInChunks<{
    workspace_id: string;
    email: string | null;
  }>(
    workspaces.map(workspace => workspace.id),
    (ids, from, to) =>
      supabase
        .from("company_users")
        .select("workspace_id, email")
        .in("workspace_id", ids)
        .range(from, to)
  );
  const isAiriMember = (email: string | null) =>
    Boolean(email?.toLowerCase().endsWith(INTERNAL_EMAIL_SUFFIX));
  const workspaceIdsByCompany = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const ids = workspaceIdsByCompany.get(workspace.company_id) ?? [];
    ids.push(workspace.id);
    workspaceIdsByCompany.set(workspace.company_id, ids);
  }
  const membersByWorkspace = new Map<string, typeof members>();
  for (const member of members) {
    const workspaceMembers = membersByWorkspace.get(member.workspace_id) ?? [];
    workspaceMembers.push(member);
    membersByWorkspace.set(member.workspace_id, workspaceMembers);
  }

  return companies.map(company => {
    const workspaceIds = workspaceIdsByCompany.get(company.id) ?? [];
    const companyMembers = workspaceIds.flatMap(
      workspaceId => membersByWorkspace.get(workspaceId) ?? []
    );
    return {
      companyId: company.id,
      createdAt: new Date(company.created_at),
      workspaceIds,
      // Airi staff are often invited into customer workspaces to help; only a
      // company with no outside member is our own test account.
      internal:
        excludedCompanyIds.has(company.id) ||
        (companyMembers.length > 0 &&
          companyMembers.every(member => isAiriMember(member.email))),
    };
  });
}

async function loadSupabaseEvents(
  supabase: SupabaseClient,
  workspaceIds: string[]
): Promise<ActivationStepEvent[]> {
  const events: ActivationStepEvent[] = [];
  const channelTypes = new Set<string>(ACTIVATION_CHANNEL_SOURCE_TYPES);

  const sources = await selectInChunks<{
    workspace_id: string;
    type: string;
    created_at: string;
  }>(workspaceIds, (ids, from, to) =>
    supabase
      .from("sources")
      .select("workspace_id, type, created_at")
      .in("workspace_id", ids)
      .range(from, to)
  );
  for (const source of sources) {
    const at = toDate(source.created_at);
    if (!at || !channelTypes.has(source.type)) continue;
    events.push({ workspaceId: source.workspace_id, step: "any_channel", at });
    if (source.type === "whatsapp") {
      events.push({ workspaceId: source.workspace_id, step: "whatsapp", at });
    }
  }

  // Durable history: a disconnected source row is gone, its event is not.
  const onboardingEvents = await selectInChunks<{
    workspace_id: string | null;
    occurred_at: string;
  }>(workspaceIds, (ids, from, to) =>
    supabase
      .from("whatsapp_onboarding_events")
      .select("workspace_id, occurred_at")
      .in("event_type", [
        "embedded_signup_source_persisted",
        "source_connected",
      ])
      .in("workspace_id", ids)
      .range(from, to)
  );
  for (const event of onboardingEvents) {
    const at = toDate(event.occurred_at);
    if (!at || !event.workspace_id) continue;
    events.push({ workspaceId: event.workspace_id, step: "any_channel", at });
    events.push({ workspaceId: event.workspace_id, step: "whatsapp", at });
  }

  const templates = await selectInChunks<{
    workspace_id: string;
    channel: string | null;
    created_at: string;
  }>(workspaceIds, (ids, from, to) =>
    supabase
      .from("message_templates")
      .select("workspace_id, channel, created_at")
      .in("workspace_id", ids)
      .range(from, to)
  );
  for (const template of templates) {
    const at = toDate(template.created_at);
    if (!at || !template.channel?.toLowerCase().includes("whatsapp")) continue;
    events.push({
      workspaceId: template.workspace_id,
      step: "template_submitted",
      at,
    });
  }

  const campaigns = await selectInChunks<{
    workspace_id: string;
    created_at: string;
    accepted_count: number | null;
    successful_sends: number | null;
  }>(workspaceIds, (ids, from, to) =>
    supabase
      .from("campaign_history")
      .select("workspace_id, created_at, accepted_count, successful_sends")
      .in("workspace_id", ids)
      .range(from, to)
  );
  for (const campaign of campaigns) {
    const at = toDate(campaign.created_at);
    const accepted = campaign.accepted_count ?? campaign.successful_sends ?? 0;
    if (!at || accepted <= 0) continue;
    events.push({
      workspaceId: campaign.workspace_id,
      step: "campaign_accepted",
      at,
    });
  }
  return events;
}

async function loadMongoEvents(
  workspaceIds: string[]
): Promise<ActivationStepEvent[]> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Mongo connection is not open.");
  const events: ActivationStepEvent[] = [];
  const match = { workspaceId: { $in: workspaceIds } };

  const audits = await db
    .collection("whatsapptemplateauditlogs")
    .aggregate<{ _id: string; at: Date }>([
      { $match: { ...match, action: "CREATE" } },
      { $group: { _id: "$workspaceId", at: { $min: "$createdAt" } } },
    ])
    .toArray();
  for (const row of audits) {
    events.push({
      workspaceId: row._id,
      step: "template_submitted",
      at: row.at,
    });
  }

  const templates = await db
    .collection("whatsapptemplates")
    .aggregate<{ _id: string; submittedAt: Date; approvedAt: Date | null }>([
      { $match: match },
      {
        $group: {
          _id: "$workspaceId",
          submittedAt: { $min: "$createdAt" },
          approvedAt: {
            $min: {
              $cond: [
                {
                  $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "APPROVED"],
                },
                "$createdAt",
                null,
              ],
            },
          },
        },
      },
    ])
    .toArray();
  for (const row of templates) {
    events.push({
      workspaceId: row._id,
      step: "template_submitted",
      at: row.submittedAt,
    });
    // Approval time is not stored; the approved template's creation time
    // is the earliest it could have happened.
    if (row.approvedAt) {
      events.push({
        workspaceId: row._id,
        step: "template_approved",
        at: row.approvedAt,
      });
    }
  }

  const scenarios = await db
    .collection("scenarios")
    .aggregate<{ _id: string; createdAt: Date | null; activeAt: Date | null }>([
      { $match: match },
      {
        $group: {
          _id: "$workspaceId",
          createdAt: {
            $min: {
              $cond: [
                { $ne: ["$presetId", DEMO_SCENARIO_PRESET_ID] },
                "$createdAt",
                null,
              ],
            },
          },
          // Activation time is not stored; the last edit of a live scenario
          // is the closest recorded time.
          activeAt: {
            $min: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "active"] },
                    { $eq: [{ $ifNull: ["$deletedAt", null] }, null] },
                  ],
                },
                "$updatedAt",
                null,
              ],
            },
          },
        },
      },
    ])
    .toArray();
  for (const row of scenarios) {
    if (row.createdAt) {
      events.push({
        workspaceId: row._id,
        step: "scenario_created",
        at: row.createdAt,
      });
    }
    if (row.activeAt) {
      events.push({
        workspaceId: row._id,
        step: "scenario_active",
        at: row.activeAt,
      });
    }
  }
  return events;
}

async function main() {
  const { values } = parseArgs({
    options: {
      since: { type: "string" },
      granularity: { type: "string", default: "week" },
      "include-internal": { type: "boolean", default: false },
      "exclude-company": { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const since = values.since
    ? new Date(values.since)
    : new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const granularity = values.granularity;
  if (
    Number.isNaN(since.getTime()) ||
    (granularity !== "week" && granularity !== "month")
  ) {
    throw new Error(
      "Use --since YYYY-MM-DD and --granularity week|month (optional --include-internal, --exclude-company <id>, --json)."
    );
  }

  loadWebOperatorEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const mongoUri = process.env.MONGODB_URI;
  if (!supabaseUrl || !serviceRoleKey || !mongoUri) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and MONGODB_URI are required."
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const companies = await loadCompanies(
    supabase,
    since,
    new Set(values["exclude-company"])
  );
  const workspaceIds = companies.flatMap(company => company.workspaceIds);

  await mongoose.connect(mongoUri, {
    autoIndex: false,
    readPreference: "secondaryPreferred",
  });
  try {
    const events = [
      ...(await loadSupabaseEvents(supabase, workspaceIds)),
      ...(await loadMongoEvents(workspaceIds)),
    ];
    const report = buildActivationFunnelReport(
      assembleActivationWorkspaceFacts(companies, events),
      {
        granularity,
        includeInternal: values["include-internal"],
      }
    );
    process.stdout.write(
      values.json
        ? `${JSON.stringify({ since: since.toISOString(), ...report }, null, 2)}\n`
        : `Activation funnel since ${since.toISOString().slice(0, 10)}\n\n${formatActivationFunnelMarkdown(report)}\n`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
