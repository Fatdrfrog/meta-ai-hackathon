import "server-only";

import type {
  WhatsAppFlowProvisioningOperationRecord,
  WhatsAppFlowProvisioningProviderResolution,
} from "@/models/whatsapp-flow-provisioning-operation";

import {
  assertWhatsAppFlowProviderResolutionCurrent,
  claimWhatsAppFlowProviderResolution,
  confirmWhatsAppFlowProviderResolution,
  releaseWhatsAppFlowProviderResolutionClaim,
  WhatsAppFlowProvisioningStoreError,
  type WhatsAppFlowProviderResolutionClaim,
  type WhatsAppFlowProvisioningLease,
} from "@/lib/whatsapp/flows/provisioning-operation-store";
import {
  deleteMetaWhatsAppFlow,
  getMetaWhatsAppFlow,
  isMetaWhatsAppFlowOwnedByWaba,
  updateMetaWhatsAppFlow,
  type MetaWhatsAppFlow,
  type WhatsAppFlowDetailsServiceResult,
  type WhatsAppFlowServiceResult,
} from "@/lib/whatsapp/flows/service";
import {
  whatsAppFlowSourceBindingFenceStore,
  WhatsAppFlowSourceBindingFenceConflictError,
  type WhatsAppFlowSourceBindingFenceLease,
} from "@/lib/whatsapp/flows/source-binding-fence-store";

type ProviderResolutionKind =
  WhatsAppFlowProvisioningProviderResolution["kind"];
type ProviderResolutionOutcome = NonNullable<
  WhatsAppFlowProvisioningProviderResolution["outcome"]
>;

export type WhatsAppFlowProviderResolutionResult =
  | {
      ok: true;
      status: 200;
      operationId: string;
      operationStatus: "MANUALLY_RESOLVED";
      providerStatus: "DEPRECATED" | null;
      cleanupAt: string;
      providerResolution: {
        kind: ProviderResolutionKind;
        outcome: ProviderResolutionOutcome;
        requestedAt: string;
        requestedBy: string;
        confirmedAt: string;
        confirmedBy: string;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
      validation_errors: unknown[];
    };

export type WhatsAppFlowProviderResolutionDependencies = {
  claimResolution(params: {
    workspaceId: string;
    sourceId: string;
    wabaId: string;
    providerFlowId: string;
    kind: ProviderResolutionKind;
    requestedBy: string;
    now: Date;
  }): Promise<WhatsAppFlowProviderResolutionClaim>;
  confirmResolution(params: {
    lease: WhatsAppFlowProvisioningLease;
    kind: ProviderResolutionKind;
    outcome: ProviderResolutionOutcome;
    confirmedBy: string;
    now: Date;
  }): Promise<WhatsAppFlowProvisioningOperationRecord>;
  releaseResolutionClaim(params: {
    lease: WhatsAppFlowProvisioningLease;
    clearRequest: boolean;
    now: Date;
  }): Promise<void>;
  assertResolutionCurrent(params: {
    lease: WhatsAppFlowProvisioningLease;
    now: Date;
  }): Promise<void>;
  acquireSourceFence(params: {
    sourceId: string;
    workspaceId: string;
    expectedWabaId: string;
    kind: "PROVISIONING";
    semanticOperationId: string;
  }): Promise<WhatsAppFlowSourceBindingFenceLease>;
  assertSourceFence(lease: WhatsAppFlowSourceBindingFenceLease): Promise<void>;
  releaseSourceFence(lease: WhatsAppFlowSourceBindingFenceLease): Promise<void>;
  getFlow(params: {
    accessToken: string;
    flowId: string;
  }): Promise<WhatsAppFlowDetailsServiceResult>;
  deprecateFlow(params: {
    accessToken: string;
    flowId: string;
    operation: "deprecate";
  }): Promise<WhatsAppFlowServiceResult>;
  deleteFlow(params: {
    accessToken: string;
    flowId: string;
  }): Promise<WhatsAppFlowServiceResult>;
  isFlowOwnedByWaba(flow: unknown, wabaId: string): boolean;
  now(): Date;
};

type ResolveWhatsAppFlowProviderInput = {
  workspaceId: string;
  sourceId: string;
  wabaId: string;
  accessToken: string;
  providerFlowId: string;
  requestedBy: string;
  kind: ProviderResolutionKind;
};

function providerStatus(flow: MetaWhatsAppFlow | null | undefined): string {
  return typeof flow?.status === "string" ? flow.status : "";
}

function providerFailure(
  result: Pick<
    WhatsAppFlowServiceResult,
    "error" | "status" | "validation_errors"
  >,
  fallback: string
): WhatsAppFlowProviderResolutionResult {
  return {
    ok: false,
    status:
      result.status >= 200 && result.status < 300 ? 502 : result.status || 500,
    error: result.error?.trim() || fallback,
    validation_errors: Array.isArray(result.validation_errors)
      ? result.validation_errors
      : [],
  };
}

function conflict(error: string): WhatsAppFlowProviderResolutionResult {
  return { ok: false, status: 409, error, validation_errors: [] };
}

function successfulResolution(
  operation: WhatsAppFlowProvisioningOperationRecord
): WhatsAppFlowProviderResolutionResult {
  const evidence = operation.providerResolution;
  if (
    operation.status !== "MANUALLY_RESOLVED" ||
    !(operation.cleanupAt instanceof Date) ||
    !evidence?.outcome ||
    !(evidence.requestedAt instanceof Date) ||
    !(evidence.confirmedAt instanceof Date) ||
    !evidence.requestedBy?.trim() ||
    !evidence.confirmedBy?.trim()
  ) {
    return conflict("Provider resolution evidence is incomplete");
  }
  return {
    ok: true,
    status: 200,
    operationId: operation.operationId,
    operationStatus: "MANUALLY_RESOLVED",
    providerStatus:
      operation.providerStatus === "DEPRECATED" ? "DEPRECATED" : null,
    cleanupAt: operation.cleanupAt.toISOString(),
    providerResolution: {
      kind: evidence.kind,
      outcome: evidence.outcome,
      requestedAt: evidence.requestedAt.toISOString(),
      requestedBy: evidence.requestedBy,
      confirmedAt: evidence.confirmedAt.toISOString(),
      confirmedBy: evidence.confirmedBy,
    },
  };
}

function unexpectedError(error: unknown): WhatsAppFlowProviderResolutionResult {
  if (error instanceof WhatsAppFlowSourceBindingFenceConflictError) {
    return conflict(error.message);
  }
  if (error instanceof WhatsAppFlowProvisioningStoreError) {
    const status =
      error.code === "INVALID_INPUT"
        ? 400
        : error.code === "PROJECTED_OPERATION_MISSING"
          ? 404
          : error.code === "OPERATION_BUSY" ||
              error.code === "OPERATION_CONFLICT" ||
              error.code === "TARGET_CHANGED"
            ? 409
            : 500;
    return {
      ok: false,
      status,
      error: error.message,
      validation_errors: [],
    };
  }
  return {
    ok: false,
    status: 500,
    error:
      error instanceof Error && error.message.trim()
        ? error.message
        : "WhatsApp Flow provider resolution failed",
    validation_errors: [],
  };
}

export function createWhatsAppFlowProviderResolutionService(
  deps: WhatsAppFlowProviderResolutionDependencies
) {
  return {
    async resolve(
      input: ResolveWhatsAppFlowProviderInput
    ): Promise<WhatsAppFlowProviderResolutionResult> {
      let lease: WhatsAppFlowProvisioningLease | null = null;
      let sourceFence: WhatsAppFlowSourceBindingFenceLease | null = null;
      let confirmed = false;
      let clearRequest = false;

      try {
        sourceFence = await deps.acquireSourceFence({
          sourceId: input.sourceId,
          workspaceId: input.workspaceId,
          expectedWabaId: input.wabaId,
          kind: "PROVISIONING",
          semanticOperationId: `provider-resolution:${input.kind}:${input.providerFlowId}`,
        });
        const claim = await deps.claimResolution({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          wabaId: input.wabaId,
          providerFlowId: input.providerFlowId,
          kind: input.kind,
          requestedBy: input.requestedBy,
          now: deps.now(),
        });
        if (claim.kind === "already_resolved") {
          return successfulResolution(claim.operation);
        }
        lease = claim.lease;

        const details = await deps.getFlow({
          accessToken: input.accessToken,
          flowId: input.providerFlowId,
        });
        let outcome: ProviderResolutionOutcome;
        if (!details.ok) {
          if (details.status !== 404) {
            return providerFailure(details, "Failed to read managed Flow");
          }
          outcome = "missing";
        } else {
          if (!deps.isFlowOwnedByWaba(details.flow, input.wabaId)) {
            return conflict(
              "Managed Flow ownership no longer matches its WABA binding"
            );
          }
          const status = providerStatus(details.flow);
          if (input.kind === "published_deprecated") {
            if (status === "DEPRECATED") {
              outcome = "deprecated";
            } else if (status === "PUBLISHED") {
              await deps.assertSourceFence(sourceFence);
              await deps.assertResolutionCurrent({ lease, now: deps.now() });
              const deprecated = await deps.deprecateFlow({
                accessToken: input.accessToken,
                flowId: input.providerFlowId,
                operation: "deprecate",
              });
              if (!deprecated.ok) {
                if (deprecated.status !== 404) {
                  return providerFailure(
                    deprecated,
                    "Failed to deprecate managed Flow"
                  );
                }
                outcome = "missing";
              } else {
                if (
                  !deps.isFlowOwnedByWaba(deprecated.flow, input.wabaId) ||
                  providerStatus(deprecated.flow) !== "DEPRECATED"
                ) {
                  return conflict(
                    "Meta did not confirm the managed Flow as DEPRECATED"
                  );
                }
                outcome = "deprecated";
              }
            } else {
              clearRequest = true;
              return conflict("Only published Flows can be deprecated");
            }
          } else if (status === "DRAFT") {
            await deps.assertSourceFence(sourceFence);
            await deps.assertResolutionCurrent({ lease, now: deps.now() });
            const deleted = await deps.deleteFlow({
              accessToken: input.accessToken,
              flowId: input.providerFlowId,
            });
            if (!deleted.ok && deleted.status !== 404) {
              return providerFailure(
                deleted,
                "Failed to delete managed Flow draft"
              );
            }
            const readback = await deps.getFlow({
              accessToken: input.accessToken,
              flowId: input.providerFlowId,
            });
            if (!readback.ok) {
              if (readback.status !== 404) {
                return providerFailure(
                  readback,
                  "Failed to confirm managed Flow draft deletion"
                );
              }
            } else {
              if (!deps.isFlowOwnedByWaba(readback.flow, input.wabaId)) {
                return conflict(
                  "Managed Flow ownership no longer matches its WABA binding"
                );
              }
              return conflict(
                providerStatus(readback.flow) === "DRAFT"
                  ? "Meta still reports the managed Flow draft after deletion"
                  : "Meta returned an unexpected Flow status after draft deletion"
              );
            }
            outcome = "missing";
          } else {
            clearRequest = true;
            return conflict("Only draft Flows can be deleted");
          }
        }

        await deps.assertSourceFence(sourceFence);
        await deps.assertResolutionCurrent({ lease, now: deps.now() });
        const resolved = await deps.confirmResolution({
          lease,
          kind: input.kind,
          outcome,
          confirmedBy: input.requestedBy,
          now: deps.now(),
        });
        confirmed = true;
        return successfulResolution(resolved);
      } catch (error) {
        return unexpectedError(error);
      } finally {
        if (lease && !confirmed) {
          try {
            await deps.releaseResolutionClaim({
              lease,
              clearRequest,
              now: deps.now(),
            });
          } catch {
            // The short lease expires safely; the exact retry reconciles Meta.
          }
        }
        if (sourceFence) {
          try {
            await deps.releaseSourceFence(sourceFence);
          } catch {
            // The source fence expires safely and no provider truth is hidden.
          }
        }
      }
    },
  };
}

const whatsAppFlowProviderResolutionService =
  createWhatsAppFlowProviderResolutionService({
    claimResolution: claimWhatsAppFlowProviderResolution,
    confirmResolution: confirmWhatsAppFlowProviderResolution,
    releaseResolutionClaim: releaseWhatsAppFlowProviderResolutionClaim,
    assertResolutionCurrent: assertWhatsAppFlowProviderResolutionCurrent,
    acquireSourceFence: params =>
      whatsAppFlowSourceBindingFenceStore.acquire(params),
    assertSourceFence: async lease => {
      await whatsAppFlowSourceBindingFenceStore.assertCurrent(lease);
    },
    releaseSourceFence: async lease => {
      await whatsAppFlowSourceBindingFenceStore.release(lease);
    },
    getFlow: getMetaWhatsAppFlow,
    deprecateFlow: updateMetaWhatsAppFlow,
    deleteFlow: deleteMetaWhatsAppFlow,
    isFlowOwnedByWaba: isMetaWhatsAppFlowOwnedByWaba,
    now: () => new Date(),
  });

export async function resolveWhatsAppFlowProviderArtifact(
  input: ResolveWhatsAppFlowProviderInput
): Promise<WhatsAppFlowProviderResolutionResult> {
  return whatsAppFlowProviderResolutionService.resolve(input);
}
