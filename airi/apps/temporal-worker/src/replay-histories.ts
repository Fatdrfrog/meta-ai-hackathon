import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readEnvFlag as parseBooleanEnv } from "@icecore/shared/lib/env";
import { Worker } from "@temporalio/worker";

type ReplayFixture = {
  history: unknown;
  runId?: string;
  workflowType?: string;
  workflowId?: string;
};

type ReplayArgs = {
  fixturesDir: string;
  skipHistoryHealth: boolean;
  strict: boolean;
};

type ReplayFailure = {
  errorSummary: string;
  label: string;
  suffix: string;
};

type LoadedReplayFixture = ReplayFixture & {
  label: string;
  suffix: string;
  workflowId: string;
};

function resolveWorkflowBundlePath(): string | null {
  const bundlePath = fileURLToPath(
    new URL("../dist/workflow-bundle.js", import.meta.url),
  );
  return existsSync(bundlePath) ? bundlePath : null;
}

function parseArgs(
  argv: string[],
  cwd: string,
  defaultFixturesDir: string,
): ReplayArgs {
  let fixturesDir = process.env.TEMPORAL_REPLAY_HISTORY_DIR
    ? resolve(cwd, process.env.TEMPORAL_REPLAY_HISTORY_DIR)
    : defaultFixturesDir;
  let skipHistoryHealth = parseBooleanEnv(
    "TEMPORAL_REPLAY_SKIP_HISTORY_HEALTH",
  );
  let strict =
    parseBooleanEnv("CI") || parseBooleanEnv("TEMPORAL_REPLAY_STRICT");

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--skip-history-health") {
      skipHistoryHealth = true;
      continue;
    }

    if (arg === "--fixtures-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--fixtures-dir requires a path.");
      }
      fixturesDir = resolve(cwd, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown replay argument: ${arg}`);
    }

    fixturesDir = resolve(cwd, arg);
  }

  return { fixturesDir, skipHistoryHealth, strict };
}

function listJsonFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
      continue;
    }

    if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function isHistoryShape(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { events?: unknown[] }).events),
  );
}

function parseFixture(filePath: string): ReplayFixture {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as
    | {
        runId?: unknown;
        workflowType?: unknown;
        workflowId?: unknown;
        history?: unknown;
      }
    | unknown;

  if (isHistoryShape(parsed)) {
    return { history: parsed };
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    isHistoryShape((parsed as { history?: unknown }).history)
  ) {
    const runId =
      typeof (parsed as { runId?: unknown }).runId === "string"
        ? (parsed as { runId: string }).runId.trim()
        : undefined;
    const workflowType =
      typeof (parsed as { workflowType?: unknown }).workflowType === "string"
        ? (parsed as { workflowType: string }).workflowType.trim()
        : undefined;
    const workflowId =
      typeof (parsed as { workflowId?: unknown }).workflowId === "string"
        ? (parsed as { workflowId: string }).workflowId.trim()
        : undefined;

    return {
      history: (parsed as { history: unknown }).history,
      runId: runId || undefined,
      workflowType: workflowType || undefined,
      workflowId: workflowId || undefined,
    };
  }

  throw new Error(
    `Replay fixture must be a History object or { workflowId?, runId?, workflowType?, history }. file=${filePath}`,
  );
}

function historyEvents(history: unknown): Array<Record<string, unknown>> {
  const events = (history as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) {
    return [];
  }

  return events.filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object",
  );
}

function eventTypeName(event: Record<string, unknown>): string {
  return String(event.eventType || "").toLowerCase();
}

function hasEventAttributes(
  event: Record<string, unknown>,
  key: string,
): boolean {
  return Boolean(event[key] && typeof event[key] === "object");
}

function isWorkflowTaskFailedEvent(event: Record<string, unknown>): boolean {
  return (
    hasEventAttributes(event, "workflowTaskFailedEventAttributes") ||
    eventTypeName(event).includes("workflow_task_failed")
  );
}

function isWorkflowTaskCompletedEvent(event: Record<string, unknown>): boolean {
  return (
    hasEventAttributes(event, "workflowTaskCompletedEventAttributes") ||
    eventTypeName(event).includes("workflow_task_completed")
  );
}

function isWorkflowClosedEvent(event: Record<string, unknown>): boolean {
  const type = eventTypeName(event);
  return (
    hasEventAttributes(event, "workflowExecutionCompletedEventAttributes") ||
    hasEventAttributes(event, "workflowExecutionFailedEventAttributes") ||
    hasEventAttributes(event, "workflowExecutionTimedOutEventAttributes") ||
    hasEventAttributes(
      event,
      "workflowExecutionContinuedAsNewEventAttributes",
    ) ||
    hasEventAttributes(event, "workflowExecutionCanceledEventAttributes") ||
    hasEventAttributes(event, "workflowExecutionTerminatedEventAttributes") ||
    type.includes("workflow_execution_completed") ||
    type.includes("workflow_execution_failed") ||
    type.includes("workflow_execution_timed_out") ||
    type.includes("workflow_execution_continued_as_new") ||
    type.includes("workflow_execution_canceled") ||
    type.includes("workflow_execution_terminated")
  );
}

function workflowTaskFailureCause(event: Record<string, unknown>): string {
  const attributes = event.workflowTaskFailedEventAttributes as
    | Record<string, unknown>
    | undefined;
  const cause = String(attributes?.cause || "").trim();
  return cause ? ` cause=${cause}` : "";
}

function eventIdText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value && typeof value === "object") {
    const raw = value as {
      high?: unknown;
      low?: unknown;
      toString?: () => string;
      unsigned?: unknown;
    };
    const toStringValue =
      typeof raw.toString === "function" ? raw.toString() : "";
    if (toStringValue && toStringValue !== "[object Object]") {
      return toStringValue;
    }
    if (typeof raw.low === "number") {
      if (typeof raw.high === "number" && raw.high !== 0) {
        const low = BigInt(raw.low >>> 0);
        const high = BigInt(raw.high >>> 0) << 32n;
        return (high + low).toString();
      }
      return String(raw.low);
    }
  }

  return "unknown";
}

function replayErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

function assertHistoryWorkflowTaskHealthy(fixture: ReplayFixture): void {
  let latestFailure: {
    eventId: string;
    cause: string;
  } | null = null;

  for (const event of historyEvents(fixture.history)) {
    if (isWorkflowTaskFailedEvent(event)) {
      latestFailure = {
        eventId: eventIdText(event.eventId),
        cause: workflowTaskFailureCause(event),
      };
      continue;
    }

    if (isWorkflowTaskCompletedEvent(event) || isWorkflowClosedEvent(event)) {
      latestFailure = null;
    }
  }

  if (!latestFailure) {
    return;
  }

  throw new Error(
    `Latest workflow task is failed after event ${latestFailure.eventId}${latestFailure.cause}. ` +
      "Export a newer history after the workflow progresses or fix the nondeterminism before deploying.",
  );
}

function loadReplayFixture(
  fixtureFile: string,
  cwd: string,
): LoadedReplayFixture {
  const fixture = parseFixture(fixtureFile);
  const label = relative(cwd, fixtureFile);
  const fallbackWorkflowId = basename(fixtureFile, extname(fixtureFile));
  const workflowId = fixture.workflowId || fallbackWorkflowId;
  const suffix = [
    fixture.workflowType,
    fixture.runId ? `runId=${fixture.runId}` : null,
    `workflowId=${workflowId}`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ...fixture,
    label,
    suffix,
    workflowId,
  };
}

function handleMissingFixtures(params: {
  fixturesDir: string;
  reason: string;
  strict: boolean;
}): void {
  if (!params.strict) {
    console.log(`${params.reason}, skipping. dir=${params.fixturesDir}`);
    return;
  }

  throw new Error(
    `${params.reason}. Strict replay is enabled, so at least one Temporal history fixture is required. ` +
      "Export histories with `pnpm --filter @icecore/temporal-worker export:replay-histories` " +
      "or pass --fixtures-dir/TEMPORAL_REPLAY_HISTORY_DIR.",
  );
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const defaultFixturesDir = fileURLToPath(
    new URL("../replay-histories", import.meta.url),
  );
  const args = parseArgs(process.argv, cwd, defaultFixturesDir);

  if (!existsSync(args.fixturesDir)) {
    handleMissingFixtures({
      fixturesDir: args.fixturesDir,
      reason: "Replay fixtures directory does not exist",
      strict: args.strict,
    });
    return;
  }

  const fixtureFiles = listJsonFiles(args.fixturesDir);
  if (fixtureFiles.length === 0) {
    handleMissingFixtures({
      fixturesDir: args.fixturesDir,
      reason: "No replay fixtures found",
      strict: args.strict,
    });
    return;
  }

  const workflowsPath = fileURLToPath(
    new URL("./workflows/index.ts", import.meta.url),
  );
  const workflowBundlePath = resolveWorkflowBundlePath();
  const replayOptions = workflowBundlePath
    ? { workflowBundle: { codePath: workflowBundlePath } }
    : { workflowsPath };

  const loadedFixtures = fixtureFiles.map((fixtureFile) =>
    loadReplayFixture(fixtureFile, cwd),
  );
  const failures: ReplayFailure[] = [];

  for (const fixture of loadedFixtures) {
    try {
      if (!args.skipHistoryHealth) {
        assertHistoryWorkflowTaskHealthy(fixture);
      }
    } catch (error) {
      failures.push({
        errorSummary: replayErrorSummary(error),
        label: fixture.label,
        suffix: fixture.suffix,
      });
      console.error(
        `FAIL ${fixture.label}${fixture.suffix ? ` (${fixture.suffix})` : ""}`,
      );
      console.error(error);
    }
  }

  if (failures.length === 0) {
    let replayIndex = 0;

    try {
      const replayResults = Worker.runReplayHistories(
        replayOptions,
        loadedFixtures.map((fixture) => ({
          history: fixture.history,
          workflowId: fixture.workflowId,
        })),
      );

      for await (const result of replayResults) {
        const fixture = loadedFixtures[replayIndex];
        replayIndex += 1;

        if (!fixture) {
          failures.push({
            errorSummary: result.error
              ? replayErrorSummary(result.error)
              : "Replay returned more results than fixtures.",
            label: result.workflowId,
            suffix: result.runId ? `runId=${result.runId}` : "",
          });
          continue;
        }

        if (result.error) {
          failures.push({
            errorSummary: replayErrorSummary(result.error),
            label: fixture.label,
            suffix: fixture.suffix,
          });
          console.error(
            `FAIL ${fixture.label}${
              fixture.suffix ? ` (${fixture.suffix})` : ""
            }`,
          );
          console.error(result.error);
          continue;
        }

        console.log(
          `PASS ${fixture.label}${
            fixture.suffix ? ` (${fixture.suffix})` : ""
          }`,
        );
      }
    } catch (error) {
      const fixture = loadedFixtures[replayIndex] || null;
      failures.push({
        errorSummary: replayErrorSummary(error),
        label: fixture?.label || "replay worker setup",
        suffix: fixture?.suffix || "",
      });
      console.error(
        fixture
          ? `FAIL ${fixture.label}${fixture.suffix ? ` (${fixture.suffix})` : ""}`
          : "FAIL replay worker setup",
      );
      console.error(error);
    }
  }

  if (failures.length > 0) {
    console.error("Replay failure summary:");
    for (const failure of failures) {
      console.error(
        `- ${failure.label}${failure.suffix ? ` (${failure.suffix})` : ""}: ${
          failure.errorSummary
        }`,
      );
    }

    throw new Error(`Replay failed for ${failures.length} fixture(s).`);
  }

  console.log(`Replay passed for ${fixtureFiles.length} fixture(s).`);
}

main().catch((error) => {
  console.error("Replay run failed.");
  console.error(error);
  process.exit(1);
});
