import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  Client,
  Connection,
  WorkflowNotFoundError,
  type WorkflowHandle,
  type WorkflowHandleWithStartDetails,
} from "@temporalio/client";
import {
  bundleWorkflowCode,
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
} from "@temporalio/worker";

let runtimeInstalled = false;
const execFileAsync = promisify(execFile);

async function reserveLocalPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

/** Real Temporal, isolated from local/production profiles; all activities are supplied by tests. */
export async function createLocalTemporalWorkflowHarness(
  workflowsPath: string,
  options: { suggestContinueAsNewAfterEvents?: number } = {},
) {
  const logger = new DefaultLogger("ERROR");
  if (!runtimeInstalled) {
    Runtime.install({ logger });
    runtimeInstalled = true;
  }
  const workflowBundle = await bundleWorkflowCode({ workflowsPath, logger });
  const address = `127.0.0.1:${await reserveLocalPort()}`;
  const server = spawn(
    process.env.TEMPORAL_CLI_PATH || "temporal",
    [
      "server",
      "start-dev",
      "--ip",
      "127.0.0.1",
      "--port",
      address.split(":")[1],
      "--headless",
      "--log-level",
      "error",
      "--disable-config-env",
      "--disable-config-file",
      ...(options.suggestContinueAsNewAfterEvents === undefined
        ? []
        : [
            "--dynamic-config-value",
            `limit.historyCount.suggestContinueAsNew=${options.suggestContinueAsNewAfterEvents}`,
          ]),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let serverOutput = "";
  let serverError: Error | undefined;
  server.on("error", (error) => {
    serverError = error;
  });
  const captureOutput = (chunk: Buffer) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-8_000);
  };
  server.stdout.on("data", captureOutput);
  server.stderr.on("data", captureOutput);

  let connection: Connection | undefined;
  let nativeConnection: NativeConnection | undefined;
  const close = async () => {
    try {
      await nativeConnection?.close();
    } finally {
      try {
        await connection?.close();
      } finally {
        server.kill();
      }
    }
  };
  try {
    const deadline = Date.now() + 30_000;
    while (!connection && Date.now() < deadline) {
      if (serverError || server.exitCode !== null) {
        throw new Error(
          `Local Temporal failed: ${serverError?.message || serverOutput}`,
        );
      }
      const candidate = Connection.lazy({ address, connectTimeout: 1_000 });
      try {
        await candidate.ensureConnected();
        connection = candidate;
      } catch {
        // A failed Connection.connect leaves its gRPC client open; retain and close it.
        await candidate.close();
        await delay(100);
      }
    }
    if (!connection)
      throw new Error(`Local Temporal did not become ready: ${serverOutput}`);
    nativeConnection = await NativeConnection.connect({ address });
    const client = new Client({ connection, namespace: "default" });

    return {
      close,
      async replay(history: unknown, workflowId: string) {
        await Worker.runReplayHistory({ workflowBundle }, history, workflowId);
      },
      async run<T>(params: {
        workflowType: string;
        input: unknown;
        activities: object;
        assert: (handle: WorkflowHandleWithStartDetails) => Promise<T>;
      }): Promise<T> {
        const id = randomUUID();
        const workflowId = `workflow-test-${id}`;
        const taskQueue = `workflow-test-${id}`;
        const version = { deploymentName: "workflow-tests", buildId: id };
        const workerDeploymentOptions = {
          version,
          useWorkerVersioning: true as const,
          defaultVersioningBehavior: "AUTO_UPGRADE" as const,
        };
        const worker = await Worker.create({
          connection: nativeConnection,
          namespace: "default",
          workflowBundle,
          taskQueue,
          activities: params.activities,
          workerDeploymentOptions,
          shutdownGraceTime: "1s",
        });
        const histories: Array<{
          runId: string;
          history: Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;
        }> = [];
        let result: T | undefined;
        let assertionError: unknown;
        await worker.runUntil(async () => {
          let handle: WorkflowHandleWithStartDetails | undefined;
          const registrationDeadline = Date.now() + 10_000;
          while (!handle) {
            try {
              handle = await client.workflow.start(params.workflowType, {
                workflowId,
                taskQueue,
                args: [params.input],
                versioningOverride: { pinnedTo: version },
              });
            } catch (error) {
              const cause = (
                error as { cause?: { code?: number; details?: string } }
              ).cause;
              if (
                Date.now() >= registrationDeadline ||
                cause?.code !== 9 ||
                !cause.details?.includes("is not present in task queue")
              )
                throw error;
              await delay(50);
            }
          }
          try {
            result = await params.assert(handle);
          } catch (error) {
            assertionError = error;
          } finally {
            try {
              await handle.terminate("Local integration test completed");
            } catch (error) {
              // Finite-workflow assertions already closed the execution.
              if (
                !(error instanceof WorkflowNotFoundError) ||
                !error.message.includes("already completed")
              )
                throw error;
            }
            let runId: string | undefined = handle.firstExecutionRunId;
            while (runId) {
              const history = await client.workflow
                .getHandle(workflowId, runId)
                .fetchHistory();
              histories.push({ runId, history });
              runId =
                history.events?.find(
                  (event) =>
                    event.workflowExecutionContinuedAsNewEventAttributes,
                )?.workflowExecutionContinuedAsNewEventAttributes
                  ?.newExecutionRunId || undefined;
            }
          }
        });
        if (histories.length === 0)
          throw new Error("Workflow did not produce a history");
        const historyDir = process.env.TEMPORAL_WORKFLOW_HISTORY_DIR;
        for (const { runId, history } of histories) {
          if (historyDir) {
            await mkdir(historyDir, { recursive: true });
            // The CLI emits Temporal proto3 JSON, including timestamps and payload bytes.
            const exported = await execFileAsync(
              process.env.TEMPORAL_CLI_PATH || "temporal",
              [
                "workflow",
                "show",
                "--address",
                address,
                "--namespace",
                "default",
                "--workflow-id",
                workflowId,
                "--run-id",
                runId,
                "--output",
                "json",
                "--no-json-shorthand-payloads",
                "--disable-config-env",
                "--disable-config-file",
              ],
              { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
            );
            await writeFile(
              join(historyDir, `${workflowId}-${runId}.json`),
              JSON.stringify({
                workflowId,
                workflowType: params.workflowType,
                runId,
                history: JSON.parse(exported.stdout),
              }),
              "utf8",
            );
          }
          await Worker.runReplayHistory(
            { workflowBundle, workerDeploymentOptions },
            history,
            workflowId,
          );
        }
        if (assertionError) throw assertionError;
        return result as T;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitForWorkflowQuery<T>(
  handle: WorkflowHandle,
  query: string,
  predicate: (state: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let state: T | undefined;
  while (Date.now() < deadline) {
    state = await handle.query<T>(query);
    if (predicate(state)) return state;
    await delay(25);
  }
  throw new Error(
    `Workflow query did not reach expected state: ${JSON.stringify(state)}`,
  );
}
