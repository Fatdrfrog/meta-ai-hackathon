#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { validateSupabasePublicKey } from "../../packages/shared/src/supabase/public-key-validation.cjs";

const DEFAULT_TARGETS = ["production"];
const RETIRED_DATADOG_ENV_KEYS = new Set([
  "DD_API_KEY",
  "DD_APP_KEY",
  "DD_LLMOBS_ENABLED",
  "DD_LLMOBS_AGENTLESS_ENABLED",
  "DD_LLMOBS_ML_APP",
  "DD_LLMOBS_SAMPLE_RATE",
  "DD_SERVICE",
  "DD_SITE",
]);
// Non-secret AI text-model selections shared with the Cloud Run worker. They are
// written only when explicitly set, so an unset repository variable never
// replaces a value already configured in Vercel. Provider API keys are managed
// in Vercel directly and are never synced from here.
const EXPLICIT_AI_RUNTIME_ENV_KEYS = [
  "VERTEX_GEMINI_HEAVY_MODEL",
  "AI_CHAT_PROVIDER_ORDER",
  "ANTHROPIC_AI_ENABLED",
  "ANTHROPIC_LIGHT_MODEL",
  "ANTHROPIC_HEAVY_MODEL",
  "ANTHROPIC_REASONING_MODEL",
  "ANTHROPIC_WORKSPACE_ID",
];

function compact(value) {
  return String(value || "").trim();
}

function pickExplicitValues(env, keys) {
  return Object.fromEntries(
    keys.map((key) => [key, compact(env[key])]).filter(([, value]) => value),
  );
}

export function parseTargets(rawTargets) {
  const targets = compact(rawTargets)
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  return targets.length > 0 ? targets : DEFAULT_TARGETS;
}

export function buildVercelEnvUrl({ projectId, teamId, teamSlug }) {
  const url = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env`,
  );
  url.searchParams.set("upsert", "true");
  return appendVercelScope(url, { teamId, teamSlug }).toString();
}

export function appendVercelScope(url, { teamId, teamSlug }) {
  if (teamId) {
    url.searchParams.set("teamId", teamId);
  } else if (teamSlug) {
    url.searchParams.set("slug", teamSlug);
  }
  return url;
}

export function buildVercelEnvListUrl({ projectId, teamId, teamSlug, until }) {
  const url = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env`,
  );
  if (until !== undefined && until !== null) {
    url.searchParams.set("until", String(until));
  }
  return appendVercelScope(url, { teamId, teamSlug }).toString();
}

export function buildVercelEnvDeleteUrl({
  projectId,
  envId,
  teamId,
  teamSlug,
}) {
  return appendVercelScope(
    new URL(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
    ),
    { teamId, teamSlug },
  ).toString();
}

export function deriveVercelProjectIdOrName({
  projectId,
  projectName,
  oidcSubjects,
}) {
  const explicit = compact(projectId) || compact(projectName);
  if (explicit) return explicit;

  const match = compact(oidcSubjects).match(
    /(?:^|,)owner:[^:]+:project:([^:]+):/,
  );
  return match?.[1] || "";
}

export function deriveVercelTeamSlug({
  teamSlug,
  oidcAudience,
  oidcIssuerUrl,
}) {
  const explicit = compact(teamSlug);
  if (explicit) return explicit;

  for (const value of [oidcAudience, oidcIssuerUrl]) {
    const raw = compact(value);
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      const [, slug] = parsed.pathname.split("/");
      if (parsed.hostname === "vercel.com" && slug) return slug;
      if (parsed.hostname === "oidc.vercel.com" && slug) return slug;
    } catch {
      // Ignore malformed optional inputs and fall through to the next source.
    }
  }

  return "";
}

export function buildVercelEnvPayload(values, targets = DEFAULT_TARGETS) {
  if (Object.hasOwn(values, "NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
    validateSupabasePublicKey(compact(values.NEXT_PUBLIC_SUPABASE_ANON_KEY));
  }
  return Object.entries(values)
    .map(([key, value]) => [key, compact(value)])
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => ({ key, value, type: "plain", target: targets }));
}

export function buildStableVercelRuntimeValues(
  env = process.env,
  { publicSupabaseOnly = false } = {},
) {
  if (publicSupabaseOnly) {
    return {
      NEXT_PUBLIC_SUPABASE_ANON_KEY: validateSupabasePublicKey(
        compact(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      ),
    };
  }
  return {
    ...pickExplicitValues(env, EXPLICIT_AI_RUNTIME_ENV_KEYS),
    GCP_AI_GATEWAY_URL: compact(env.GCP_AI_GATEWAY_URL),
    GCP_MEDIA_API_URL: compact(env.GCP_MEDIA_API_URL),
    REALTIME_GATEWAY_URL: compact(env.REALTIME_GATEWAY_URL),
    WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC: compact(
      env.WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC,
    ),
    WHATSAPP_OTP_DELIVERY_MODE:
      compact(env.WHATSAPP_OTP_DELIVERY_MODE).toLowerCase() === "temporal"
        ? "temporal"
        : "pubsub",
    WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST: compact(
      env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST,
    ),
    CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID:
      compact(env.CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID) ||
      compact(env.GCP_PROJECT_ID),
    CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC:
      compact(env.CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC) ||
      "icecore-conversation-classification-events",
    CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED: "true",
    CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED: "true",
  };
}

async function listVercelEnvEntries({
  fetchImpl,
  token,
  projectId,
  teamId,
  teamSlug,
}) {
  const scope = { projectId, teamId, teamSlug };
  const headers = { Authorization: `Bearer ${token}` };
  const entries = [];
  const seenCursors = new Set();
  const seenIds = new Set();
  let until;

  while (true) {
    let response;
    try {
      response = await fetchImpl(buildVercelEnvListUrl({ ...scope, until }), {
        method: "GET",
        headers,
      });
    } catch {
      throw new Error("Vercel env inventory request failed");
    }
    if (!response.ok) {
      throw new Error(
        `Vercel env inventory failed with HTTP ${response.status}`,
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("Vercel env inventory returned invalid JSON");
    }
    if (!Array.isArray(body?.envs)) {
      throw new Error("Vercel env inventory must contain an envs array");
    }
    if (
      body.hiddenProductionEnvCount !== undefined &&
      body.hiddenProductionEnvCount !== 0
    ) {
      throw new Error(
        "Vercel env inventory hides production environment variables",
      );
    }
    for (const entry of body.envs) {
      if (
        typeof entry?.id !== "string" ||
        !entry.id.trim() ||
        entry.id !== entry.id.trim() ||
        typeof entry.key !== "string" ||
        !entry.key.trim() ||
        entry.key !== entry.key.trim()
      ) {
        throw new Error(
          "Vercel env inventory contains an invalid environment entry",
        );
      }
      if (seenIds.has(entry.id)) {
        throw new Error(
          "Vercel env inventory returned a repeated environment id",
        );
      }
      seenIds.add(entry.id);
    }

    entries.push(...body.envs);
    if (body.pagination === undefined) return entries;
    if (
      body.pagination === null ||
      typeof body.pagination !== "object" ||
      Array.isArray(body.pagination) ||
      !Object.hasOwn(body.pagination, "next")
    ) {
      throw new Error("Vercel env inventory has an invalid pagination cursor");
    }

    const nextCursor = body.pagination.next;
    if (nextCursor === null) return entries;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= 0) {
      throw new Error("Vercel env inventory has an invalid pagination cursor");
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(
        "Vercel env inventory returned a repeated pagination cursor",
      );
    }
    seenCursors.add(nextCursor);
    until = nextCursor;
  }
}

async function deleteVercelEnvEntries({
  fetchImpl,
  token,
  projectId,
  teamId,
  teamSlug,
  entries,
}) {
  const scope = { projectId, teamId, teamSlug };
  const headers = { Authorization: `Bearer ${token}` };
  for (const { id } of entries) {
    let deletion;
    try {
      deletion = await fetchImpl(
        buildVercelEnvDeleteUrl({ ...scope, envId: id }),
        { method: "DELETE", headers },
      );
    } catch {
      throw new Error("Vercel retired Datadog env removal request failed");
    }
    if (!deletion.ok && deletion.status !== 404) {
      throw new Error(
        `Vercel retired Datadog env removal failed with HTTP ${deletion.status}`,
      );
    }
  }
}

async function removeRetiredDatadogEnvEntries(request) {
  // Complete inventory validation precedes every mutation, including upserts.
  const entries = await listVercelEnvEntries(request);
  const retiredEntries = entries.filter((entry) =>
    RETIRED_DATADOG_ENV_KEYS.has(entry.key),
  );
  if (retiredEntries.length === 0) return;

  await deleteVercelEnvEntries({ ...request, entries: retiredEntries });
  const remainingEntries = (await listVercelEnvEntries(request)).filter(
    (entry) => RETIRED_DATADOG_ENV_KEYS.has(entry.key),
  );
  if (remainingEntries.length > 0) {
    throw new Error(
      `Vercel env inventory still contains ${remainingEntries.length} retired Datadog environment entry after cleanup`,
    );
  }
}

async function postVercelEnvPayload({
  fetchImpl,
  token,
  projectId,
  teamId,
  teamSlug,
  payload,
  errorLabel,
}) {
  const response = await fetchImpl(
    buildVercelEnvUrl({ projectId, teamId, teamSlug }),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`${errorLabel} failed with HTTP ${response.status}`);
  }
}

export async function syncVercelRuntimeEnv({
  fetchImpl = globalThis.fetch,
  token,
  projectId,
  projectName,
  teamId,
  teamSlug,
  oidcAudience,
  oidcIssuerUrl,
  oidcSubjects,
  targets = DEFAULT_TARGETS,
  removeRetiredDatadogEnv = false,
  values,
}) {
  if (!fetchImpl) {
    throw new Error("fetch is not available in this Node runtime");
  }
  const normalizedToken = compact(token);
  const normalizedProjectId = deriveVercelProjectIdOrName({
    projectId,
    projectName,
    oidcSubjects,
  });
  const normalizedTeamSlug = deriveVercelTeamSlug({
    teamSlug,
    oidcAudience,
    oidcIssuerUrl,
  });
  if (!normalizedToken) {
    throw new Error("VERCEL_TOKEN is required to sync runtime env");
  }
  if (!normalizedProjectId) {
    throw new Error(
      "VERCEL_PROJECT_ID, VERCEL_PROJECT_NAME, or AI_GATEWAY_VERCEL_OIDC_SUBJECTS project is required to sync runtime env",
    );
  }

  const payload = buildVercelEnvPayload(values, targets);
  if (payload.length === 0) {
    throw new Error("No runtime environment values were provided for Vercel");
  }
  if (
    removeRetiredDatadogEnv &&
    payload.some((entry) => RETIRED_DATADOG_ENV_KEYS.has(entry.key))
  ) {
    throw new Error("Cannot sync retired Datadog environment variables");
  }

  const normalizedTeamId = compact(teamId);
  const request = {
    fetchImpl,
    token: normalizedToken,
    projectId: normalizedProjectId,
    teamId: normalizedTeamId,
    teamSlug: normalizedTeamSlug,
  };
  if (removeRetiredDatadogEnv) {
    await removeRetiredDatadogEnvEntries(request);
  }
  await postVercelEnvPayload({
    ...request,
    payload,
    errorLabel: "Vercel env sync",
  });

  return payload.map((item) => item.key);
}

async function main() {
  const publicSupabaseOnly = process.argv.includes("--public-supabase-only");
  const syncedKeys = await syncVercelRuntimeEnv({
    token: process.env.VERCEL_TOKEN,
    projectId: process.env.VERCEL_PROJECT_ID,
    projectName: process.env.VERCEL_PROJECT_NAME,
    teamId: process.env.VERCEL_TEAM_ID,
    teamSlug: process.env.VERCEL_TEAM_SLUG,
    oidcAudience: process.env.AI_GATEWAY_VERCEL_OIDC_AUDIENCE,
    oidcIssuerUrl: process.env.AI_GATEWAY_VERCEL_OIDC_ISSUER_URL,
    oidcSubjects: process.env.AI_GATEWAY_VERCEL_OIDC_SUBJECTS,
    targets: parseTargets(process.env.VERCEL_ENV_TARGETS),
    removeRetiredDatadogEnv: !publicSupabaseOnly,
    values: buildStableVercelRuntimeValues(process.env, {
      publicSupabaseOnly,
    }),
  });

  console.log(`Synced Vercel runtime env: ${syncedKeys.join(", ")}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
