/**
 * Loose "workflow already started" check for idempotent starts. It matches the
 * SDK error by name or message so callers need no @temporalio/client import.
 * Callers that must tell a real SDK duplicate from a look-alike error use the
 * strict instanceof check in apps/web/src/lib/temporal/sdk.ts instead.
 */
export function isWorkflowAlreadyStartedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "WorkflowExecutionAlreadyStartedError" ||
    /already started|already exists|WorkflowExecutionAlreadyStarted/i.test(
      error.message,
    )
  );
}
