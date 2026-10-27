import "server-only";

import { createRequire } from "node:module";

import type { TemporalConnectionOptions, TemporalWebClient } from "./sdk-types";

export type TemporalClientSdk = {
  Client: new (options: {
    connection: unknown;
    namespace: string;
  }) => TemporalWebClient;
  Connection: { lazy(options: TemporalConnectionOptions): unknown };
  QueryNotRegisteredError: new (message: string, code: number) => Error;
  WorkflowExecutionAlreadyStartedError: new (
    message: string,
    workflowId: string,
    workflowType: string
  ) => Error;
  WorkflowNotFoundError: new (
    message: string,
    workflowId: string,
    runId: string | undefined
  ) => Error;
};

export type TemporalSdkErrorName =
  | "QueryNotRegisteredError"
  | "WorkflowExecutionAlreadyStartedError"
  | "WorkflowNotFoundError";

const REQUIRED_SDK_EXPORTS: readonly (keyof TemporalClientSdk)[] = [
  "Client",
  "Connection",
  "QueryNotRegisteredError",
  "WorkflowExecutionAlreadyStartedError",
  "WorkflowNotFoundError",
];

let loadedSdk: TemporalClientSdk | null = null;

/**
 * Loads @temporalio/client at runtime, so its declarations (see ./sdk-types)
 * never enter the web TypeScript program.
 */
export function loadTemporalClientSdk(): TemporalClientSdk {
  if (loadedSdk) {
    return loadedSdk;
  }

  const nodeRequire = createRequire(import.meta.url);
  const sdk = nodeRequire("@temporalio/client") as Partial<TemporalClientSdk>;

  if (!sdk || REQUIRED_SDK_EXPORTS.some(key => !sdk[key])) {
    const keys = sdk && typeof sdk === "object" ? Object.keys(sdk).sort() : [];
    throw new Error(
      `Failed to load @temporalio/client runtime exports. availableKeys=[${keys.join(",")}]`
    );
  }

  loadedSdk = sdk as TemporalClientSdk;
  return loadedSdk;
}

/**
 * `instanceof` against the SDK's own error class: an unrelated error that only
 * borrows the SDK error's name does not match.
 */
export function isTemporalSdkError(
  error: unknown,
  name: TemporalSdkErrorName
): boolean {
  return error instanceof loadTemporalClientSdk()[name];
}
