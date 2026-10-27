/**
 * Read-only live smoke of the production harness, including real planning and billing.
 * node --env-file=<web .env.local> --conditions=react-server --import tsx scripts/verify-meta-ads-mcp-harness.ts --workspace <uuid>
 * Never calls executeConfirmedMetaAdsMcpMutation or prints advertiser results.
 */

type FailureCategory =
  | "local_google_auth"
  | "provider_access"
  | "provider_transient"
  | "workspace_policy"
  | "runtime_setup"
  | "incomplete_report"
  | "tool_execution"
  | "unsuccessful_result";
const categories = new Set<FailureCategory>();
const observedStages: Array<{ id: string; status: string }> = [];
let providerAttempts = 0;
let providerFailures = 0;

function classify(value: unknown): void {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  if (
    /\binvalid_grant\b|\binvalid_rapt\b|could not load (?:the )?default credentials|reauth related error/i.test(
      message
    )
  )
    categories.add("local_google_auth");
  else if (
    /permission denied|unauthenticated|access.denied|forbidden|\b40[13]\b/i.test(
      message
    )
  )
    categories.add("provider_access");
  else if (
    /\b429\b|\b50[234]\b|rate.limit|unavailable|fetch failed|timed? ?out/i.test(
      message
    )
  )
    categories.add("provider_transient");
}

// Library logs can include provider error bodies. Inspect only for fixed categories;
// this operator command emits only the explicitly constructed summary below.
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  // eslint-disable-next-line no-console -- prevent raw provider logs in operator output
  console[method] = (...values: unknown[]) => {
    for (const value of values) classify(value);
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--workspace" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[1] ?? "")
  ) {
    process.stderr.write(
      "Usage: node --env-file=<web .env.local> --conditions=react-server --import tsx scripts/verify-meta-ads-mcp-harness.ts --workspace <uuid>\n"
    );
    process.exitCode = 1;
    return;
  }
  const startedAt = Date.now();
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { runMetaAdsMcpTurn } = await import("@/lib/meta-ads/mcp/agent-loop");
    const result = await runMetaAdsMcpTurn({
      supabase: supabaseAdmin,
      workspaceId: args[1],
      userMessage: "@meta summarize all campaigns that were running.",
      signal: AbortSignal.timeout(180_000),
      emitProgress: event => {
        observedStages.push({
          id: event.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 256),
          status: event.status,
        });
      },
      onLifecycle: event => {
        if (event.type === "attempt_start") providerAttempts += 1;
        if (event.type === "attempt_error") {
          providerFailures += 1;
          classify(event.errorMessage);
        }
      },
    });
    const usefulReads = result.toolTrace.filter(
      item => item.sideEffect === "read" && item.status === "executed"
    ).length;
    const success =
      usefulReads > 0 &&
      result.coverage?.complete === true &&
      result.pendingMutations.length === 0;
    const failureCode =
      result.failureCode && /^[a-z][a-z0-9_]{0,63}$/.test(result.failureCode)
        ? result.failureCode
        : undefined;
    if (!success) {
      if (result.coverage?.complete === false)
        categories.add("incomplete_report");
      if (result.toolTrace.some(item => item.status === "error"))
        categories.add("tool_execution");
      if (!categories.size) categories.add("unsuccessful_result");
    }
    process.stdout.write(
      JSON.stringify(
        {
          success,
          checkedAt: new Date().toISOString(),
          workspaceId: args[1],
          durationMs: Date.now() - startedAt,
          usefulReads,
          coverage: result.coverage,
          pendingMutationCount: result.pendingMutations.length,
          contentLength: result.content.length,
          toolCalls: result.toolTrace.map(item => ({
            name: item.name,
            sideEffect: item.sideEffect,
            status: item.status,
          })),
          providerAttempts,
          providerFailures,
          failureCategories: [...categories],
          ...(failureCode ? { failureCode } : {}),
          stages: observedStages,
        },
        null,
        2
      ) + "\n"
    );
    if (!success) process.exitCode = 1;
  } catch (error) {
    classify(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (
      ["own_ai_source_required", "workspace_ai_policy_unavailable"].includes(
        code
      )
    )
      categories.add("workspace_policy");
    if (!categories.size) categories.add("runtime_setup");
    process.stdout.write(
      JSON.stringify(
        {
          success: false,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          failureCategories: [...categories],
          providerAttempts,
          providerFailures,
          stages: observedStages,
        },
        null,
        2
      ) + "\n"
    );
    process.exitCode = 1;
  }
}

export {};

void main();
