import "server-only";

import type {
  ManagedWhatsAppFlowProvisioningProjection,
  WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";

import { generateFlowJsonString } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import { getMetaServerAppConfig } from "@/lib/meta/app-config";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { resolveWhatsAppAccountContext } from "@/lib/whatsapp/account/resolution";
import { resolveFreshWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import type {
  SafeEndpointPhoneSecurityState,
  SafeEndpointSecurityStatus,
} from "@/lib/whatsapp/flows/endpoint-security-contract";
import type {
  ProvisionWhatsAppFlowRequest,
  SafeWhatsAppFlowValidationError,
  WhatsAppFlowProvisioningFailureCode,
  WhatsAppFlowProvisioningResult,
  WhatsAppFlowProvisioningStage,
} from "@/lib/whatsapp/flows/provisioning-contract";
import {
  ensureWhatsAppFlowPhoneKeyReadiness,
  resolveManagedWhatsAppFlowEndpointIdentity,
  type ResolvedEndpointSecurityContext,
} from "@/lib/whatsapp/flows/endpoint-security-service";
import {
  evaluateManagedFlowReleasePolicy,
  MANAGED_FLOW_RELEASE_POLICY,
  type ManagedFlowReleaseDecision,
} from "@/lib/whatsapp/flows/managed-flow-release-policy";
import {
  acquireWhatsAppFlowProvisioningLease,
  assertWhatsAppFlowProvisioningTargetCurrent,
  buildWhatsAppFlowProviderName,
  completeWhatsAppFlowProvisioningOperation,
  failWhatsAppFlowProvisioningOperation,
  normalizeWhatsAppFlowProvisioningError,
  prepareWhatsAppFlowProvisioningOperation,
  reconcileCompletedWhatsAppFlowProviderStatus,
  recordWhatsAppFlowProviderDraft,
  recordWhatsAppFlowProviderStatus,
  releaseWhatsAppFlowProvisioningLease,
  resolveMissingWhatsAppFlowProviderDraft,
  renewWhatsAppFlowProvisioningLease,
  transitionWhatsAppFlowProvisioningStage,
  validateWhatsAppFlowProvisioningTarget,
  WhatsAppFlowProvisioningStoreError,
  type ProjectedWhatsAppFlowProvisioningOperation,
  type ValidatedWhatsAppFlowProvisioningTarget,
  type WhatsAppFlowProvisioningLease,
} from "@/lib/whatsapp/flows/provisioning-operation-store";
import {
  createMetaWhatsAppFlow,
  findMetaWhatsAppFlowByExactName,
  getMetaWhatsAppFlow,
  updateMetaWhatsAppFlow,
  type MetaWhatsAppFlow,
  type WhatsAppFlowServiceResult,
} from "@/lib/whatsapp/flows/service";
import {
  whatsAppFlowSourceBindingFenceStore,
  type WhatsAppFlowSourceBindingFenceLease,
} from "@/lib/whatsapp/flows/source-binding-fence-store";
import { getWABAPhoneNumbersStrict } from "@/lib/whatsapp/waba-service";
import type {
  WhatsAppFlowProvisioningError,
  WhatsAppFlowProvisioningOperationRecord,
} from "@/models/whatsapp-flow-provisioning-operation";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

const MAX_VALIDATION_ERRORS = 50;
const MAX_VALIDATION_TEXT = 1_024;
const PROVIDER_CALL_LEASE_HEARTBEAT_MS = 30_000;
const PROVIDER_DRAFT_MISSING_GRACE_MS = 5 * 60 * 1_000;

type ProvisioningStage = WhatsAppFlowProvisioningOperationRecord["stage"];
type ProviderStatus =
  ManagedWhatsAppFlowProvisioningProjection["providerStatus"];
type ReleaseMode = "linear" | "data_endpoint";

type ProvisionWhatsAppFlowInput = ProvisionWhatsAppFlowRequest & {
  updatedBy?: string | null;
};

type ResolvedWhatsAppFlowProvisioningContext = Pick<
  ResolvedEndpointSecurityContext,
  "workspaceId" | "sourceId" | "wabaId" | "accessToken"
> & {
  applicationId?: string;
  phoneNumberIds: readonly string[];
};

type ResolvedWhatsAppFlowProvisioningIdentity = {
  endpointId: string;
  endpointUri: string;
  expectedGenerationId: string;
};

type EndpointReadiness = Pick<
  SafeEndpointSecurityStatus,
  "provisioning" | "phones"
>;

type WhatsAppFlowProvisioningDependencies = {
  now(): Date;
  getReleasePolicy(now: Date): ManagedFlowReleaseDecision;
  isWorkspaceEnabled(workspaceId: string): Promise<boolean>;
  validateTarget(
    input: ProvisionWhatsAppFlowInput
  ): Promise<ValidatedWhatsAppFlowProvisioningTarget>;
  resolveContext(input: {
    workspaceId: string;
    sourceId: string;
    releaseMode: "linear" | "data_endpoint";
  }): Promise<ResolvedWhatsAppFlowProvisioningContext>;
  resolveEndpointIdentity(params: {
    context: ResolvedEndpointSecurityContext;
    now?: Date;
  }): Promise<ResolvedWhatsAppFlowProvisioningIdentity>;
  prepareOperation: typeof prepareWhatsAppFlowProvisioningOperation;
  acquireLease(
    params: Parameters<typeof acquireWhatsAppFlowProvisioningLease>[0]
  ): Promise<WhatsAppFlowProvisioningLease>;
  renewLease(
    params: Parameters<typeof renewWhatsAppFlowProvisioningLease>[0]
  ): Promise<WhatsAppFlowProvisioningLease>;
  assertTargetCurrent(
    params: Parameters<typeof assertWhatsAppFlowProvisioningTargetCurrent>[0]
  ): Promise<void>;
  assertSourceBinding(params: {
    workspaceId: string;
    sourceId: string;
    wabaId: string;
  }): Promise<void>;
  acquireSourceFence(
    params: Parameters<typeof whatsAppFlowSourceBindingFenceStore.acquire>[0]
  ): Promise<WhatsAppFlowSourceBindingFenceLease>;
  renewSourceFence(
    lease: WhatsAppFlowSourceBindingFenceLease
  ): Promise<WhatsAppFlowSourceBindingFenceLease>;
  assertSourceFence(lease: WhatsAppFlowSourceBindingFenceLease): Promise<void>;
  releaseSourceFence(lease: WhatsAppFlowSourceBindingFenceLease): Promise<void>;
  transitionStage(
    params: Parameters<typeof transitionWhatsAppFlowProvisioningStage>[0]
  ): Promise<WhatsAppFlowProvisioningOperationRecord>;
  recordProviderDraft(
    params: Parameters<typeof recordWhatsAppFlowProviderDraft>[0]
  ): Promise<WhatsAppFlowProvisioningOperationRecord>;
  recordProviderStatus(
    params: Parameters<typeof recordWhatsAppFlowProviderStatus>[0]
  ): Promise<WhatsAppFlowProvisioningOperationRecord>;
  resolveMissingProviderDraft(
    params: Parameters<typeof resolveMissingWhatsAppFlowProviderDraft>[0]
  ): Promise<WhatsAppFlowProvisioningOperationRecord>;
  reconcileCompletedProviderStatus(
    params: Parameters<typeof reconcileCompletedWhatsAppFlowProviderStatus>[0]
  ): Promise<ProjectedWhatsAppFlowProvisioningOperation>;
  failOperation(params: {
    lease: WhatsAppFlowProvisioningLease;
    error: WhatsAppFlowProvisioningError;
    now?: Date;
  }): Promise<WhatsAppFlowProvisioningOperationRecord>;
  completeOperation(
    params: Parameters<typeof completeWhatsAppFlowProvisioningOperation>[0]
  ): Promise<ProjectedWhatsAppFlowProvisioningOperation>;
  releaseLease(lease: WhatsAppFlowProvisioningLease): Promise<void>;
  findFlowByExactName(params: {
    accessToken: string;
    wabaId: string;
    name: string;
  }): Promise<WhatsAppFlowServiceResult>;
  createFlow(
    params: Parameters<typeof createMetaWhatsAppFlow>[0]
  ): Promise<WhatsAppFlowServiceResult>;
  getFlow(
    params: Parameters<typeof getMetaWhatsAppFlow>[0]
  ): Promise<WhatsAppFlowServiceResult>;
  updateFlow(
    params: Parameters<typeof updateMetaWhatsAppFlow>[0]
  ): Promise<WhatsAppFlowServiceResult>;
  ensurePhoneKeys(params: {
    context: ResolvedEndpointSecurityContext;
    expectedGenerationId: string;
    phoneNumberIds: readonly string[];
    now?: Date;
  }): Promise<EndpointReadiness>;
  generateFlowJson(config: WhatsAppFlowConfig): string;
};

class ProvisioningFailure extends Error {
  constructor(
    readonly code: WhatsAppFlowProvisioningFailureCode,
    message: string,
    readonly stage: ProvisioningStage,
    readonly retryable: boolean,
    readonly providerCode?: number,
    readonly providerSubcode?: number
  ) {
    super(message);
    this.name = "ProvisioningFailure";
  }
}

function safeMessage(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return fallback;
  if (/bearer\s|access[_ -]?token|private key|-----begin/i.test(candidate)) {
    return fallback;
  }
  return candidate.slice(0, MAX_VALIDATION_TEXT);
}

function objectId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const id = asNullableRecord(value)?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function flowStatus(flow: unknown): ProviderStatus | null {
  const value = asNullableRecord(flow)?.status;
  return ["DRAFT", "PUBLISHED", "DEPRECATED", "BLOCKED", "THROTTLED"].includes(
    String(value)
  )
    ? (value as ProviderStatus)
    : null;
}

function flowName(flow: unknown): string | null {
  const value = asNullableRecord(flow)?.name;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function releaseMode(config: WhatsAppFlowConfig): ReleaseMode {
  return config.flowNavigationMode === "data_endpoint"
    ? "data_endpoint"
    : "linear";
}

function requireEndpointContext(
  context: ResolvedWhatsAppFlowProvisioningContext
): ResolvedEndpointSecurityContext & { phoneNumberIds: readonly string[] } {
  const applicationId = context.applicationId?.trim();
  if (!applicationId) {
    throw new Error("Meta application binding is unavailable");
  }
  return { ...context, applicationId };
}

function validationErrors(value: unknown): SafeWhatsAppFlowValidationError[] {
  const items = Array.isArray(value)
    ? value.slice(0, MAX_VALIDATION_ERRORS)
    : [];
  return items.map(item => {
    const record = asNullableRecord(item);
    const pointer = Array.isArray(record?.pointers)
      ? asNullableRecord(record?.pointers[0])
      : null;
    const path = typeof pointer?.path === "string" ? pointer.path.trim() : "";
    return {
      message: safeMessage(record?.message, "Flow JSON validation failed"),
      ...(path ? { path: path.slice(0, MAX_VALIDATION_TEXT) } : {}),
    };
  });
}

function flowValidationErrors(
  flow: unknown
): SafeWhatsAppFlowValidationError[] {
  return validationErrors(asNullableRecord(flow)?.validation_errors);
}

function requireFlowBinding(params: {
  flow: unknown;
  flowId: string;
  providerFlowName?: string;
  context: ResolvedWhatsAppFlowProvisioningContext;
  releaseMode: ReleaseMode;
  identity?: ResolvedWhatsAppFlowProvisioningIdentity;
  stage: ProvisioningStage;
  requireApplication: boolean;
}): MetaWhatsAppFlow {
  const flow = asNullableRecord(params.flow);
  const errors = flowValidationErrors(flow);
  const confirmedFlowName = flowName(flow);
  if (
    !flow ||
    objectId(flow.id) !== params.flowId ||
    !confirmedFlowName ||
    (params.providerFlowName !== undefined &&
      confirmedFlowName !== params.providerFlowName) ||
    objectId(flow.whatsapp_business_account) !== params.context.wabaId ||
    (params.releaseMode === "data_endpoint" &&
      (!params.identity ||
        flow.endpoint_uri !== params.identity.endpointUri)) ||
    (params.requireApplication &&
      (!params.context.applicationId ||
        objectId(flow.application) !== params.context.applicationId)) ||
    errors.length > 0
  ) {
    throw new ProvisioningFailure(
      errors.length > 0
        ? "WHATSAPP_FLOW_PROVISIONING_JSON_INVALID"
        : "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
      errors[0]?.message ?? "Meta Flow readback did not match this operation",
      params.stage,
      false
    );
  }
  return flow as MetaWhatsAppFlow;
}

function providerFailure(params: {
  result: WhatsAppFlowServiceResult;
  code: WhatsAppFlowProvisioningFailureCode;
  stage: ProvisioningStage;
  fallback: string;
  retryable?: boolean;
}): ProvisioningFailure {
  return new ProvisioningFailure(
    params.code,
    safeMessage(params.result.error, params.fallback),
    params.stage,
    params.retryable ?? params.result.status >= 500,
    params.result.providerCode,
    params.result.providerSubcode
  );
}

function isDefinitivelyMissingProviderFlow(
  result: WhatsAppFlowServiceResult
): boolean {
  return !result.ok && result.status === 404;
}

function hasProviderDraftMissingGraceElapsed(
  operation: WhatsAppFlowProvisioningOperationRecord,
  now: Date
): boolean {
  const providerAcknowledgedAt =
    operation.providerAcknowledgedAt?.getTime() ?? Number.NaN;
  return (
    Number.isFinite(providerAcknowledgedAt) &&
    now.getTime() - providerAcknowledgedAt >= PROVIDER_DRAFT_MISSING_GRACE_MS
  );
}

function normalizeProvisioningFailure(
  failure: ProvisioningFailure,
  at: Date
): WhatsAppFlowProvisioningError {
  return normalizeWhatsAppFlowProvisioningError({
    code: failure.code,
    message: failure.message,
    stage: failure.stage,
    providerCode: failure.providerCode,
    providerSubcode: failure.providerSubcode,
    retryable: failure.retryable,
    at,
  });
}

function displayName(config: WhatsAppFlowConfig): string {
  return (
    config.headerText?.trim() ||
    config.bodyText?.trim() ||
    "WhatsApp Flow"
  ).slice(0, 160);
}

function isEndpointReady(params: {
  readiness: EndpointReadiness;
  expectedGenerationId: string;
  phoneNumberIds: readonly string[];
}): boolean {
  if (
    params.phoneNumberIds.length === 0 ||
    params.readiness.provisioning.status !== "READY" ||
    params.readiness.provisioning.generationId !== params.expectedGenerationId
  ) {
    return false;
  }
  const phones = new Map(
    params.readiness.phones.map(phone => [phone.phoneNumberId, phone])
  );
  return params.phoneNumberIds.every(phoneNumberId => {
    const phone = phones.get(phoneNumberId);
    return (
      phone?.generationId === params.expectedGenerationId &&
      phone.stage === "READY" &&
      phone.signatureStatus === "VALID"
    );
  });
}

function preliminaryFailure(params: {
  code: WhatsAppFlowProvisioningFailureCode;
  message: string;
  stage?: WhatsAppFlowProvisioningStage;
  retryable?: boolean;
}): WhatsAppFlowProvisioningResult {
  return {
    ok: false,
    stage: params.stage ?? "VALIDATING",
    phones: [],
    validationErrors: [],
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
    },
  };
}

export function createWhatsAppFlowProvisioningService(
  deps: WhatsAppFlowProvisioningDependencies
): {
  provision(
    input: ProvisionWhatsAppFlowInput
  ): Promise<WhatsAppFlowProvisioningResult>;
} {
  return {
    async provision(input) {
      const now = deps.now();
      let sourceFence: WhatsAppFlowSourceBindingFenceLease | null = null;
      const assertSourceBinding = async (params: {
        workspaceId: string;
        sourceId: string;
        wabaId: string;
        stage: ProvisioningStage;
      }) => {
        try {
          if (!sourceFence) {
            throw new Error("Missing source-binding fence");
          }
          await deps.assertSourceFence(sourceFence);
          await deps.assertSourceBinding(params);
        } catch (error) {
          if (
            error instanceof WhatsAppFlowProvisioningStoreError &&
            error.code === "SOURCE_REBIND_REQUIRED"
          ) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_SOURCE_REBIND_REQUIRED",
              safeMessage(
                error.message,
                "WhatsApp source binding changed while provisioning"
              ),
              params.stage,
              false
            );
          }
          if (sourceFence) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
              "WhatsApp source-binding fence was lost",
              params.stage,
              true
            );
          }
          throw error;
        }
      };
      const releaseSourceFence = async () => {
        const activeFence = sourceFence;
        sourceFence = null;
        if (!activeFence) return;
        await deps.releaseSourceFence(activeFence).catch(() => undefined);
      };
      const requestedReleaseMode = releaseMode(input.editableConfig);
      const policy = deps.getReleasePolicy(now);
      if (!policy.valid) {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_POLICY_DISABLED",
          message: "WhatsApp Flow publishing policy is invalid",
        });
      }
      if (
        requestedReleaseMode === "data_endpoint" &&
        !policy.managedFlowEnabled
      ) {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_POLICY_DISABLED",
          message: "Managed WhatsApp Flow publishing is not enabled",
        });
      }
      if (requestedReleaseMode === "linear" && !policy.legacyFlowAllowed) {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_LEGACY_DISABLED",
          message: "Linear WhatsApp Flow publishing is no longer enabled",
        });
      }
      if (
        requestedReleaseMode === "data_endpoint" &&
        !(await deps.isWorkspaceEnabled(input.workspaceId))
      ) {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_WORKSPACE_DISABLED",
          message:
            "Managed WhatsApp Flow publishing is disabled for this workspace",
        });
      }

      let target: ValidatedWhatsAppFlowProvisioningTarget;
      try {
        target = await deps.validateTarget(input);
        if (releaseMode(target.config) !== requestedReleaseMode) {
          throw new Error("Persisted Flow mode changed");
        }
      } catch (error) {
        if (
          error instanceof WhatsAppFlowProvisioningStoreError &&
          error.code === "TEMPLATE_REBIND_REQUIRED"
        ) {
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_TEMPLATE_REBIND_REQUIRED",
            message: safeMessage(
              error.message,
              "Published template Flow binding must be replaced"
            ),
            retryable: false,
          });
        }
        if (
          error instanceof WhatsAppFlowProvisioningStoreError &&
          error.code === "SOURCE_REBIND_REQUIRED"
        ) {
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_REBIND_REQUIRED",
            message: safeMessage(
              error.message,
              "Replace the managed Flow binding before changing WhatsApp source"
            ),
            retryable: false,
          });
        }
        if (
          error instanceof WhatsAppFlowProvisioningStoreError &&
          error.code === "ACTIVE_SCENARIO_MIGRATION_REQUIRED"
        ) {
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_ACTIVE_SCENARIO_MIGRATION_REQUIRED",
            message: safeMessage(
              error.message,
              "Deactivate this scenario before replacing its WhatsApp Flow binding"
            ),
            retryable: false,
          });
        }
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_TARGET_INVALID",
          message: "The persisted Flow target changed; refresh and retry",
        });
      }

      let context: ResolvedWhatsAppFlowProvisioningContext;
      try {
        context = await deps.resolveContext({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          releaseMode: requestedReleaseMode,
        });
      } catch {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_CONTEXT_FAILED",
          message: "WhatsApp account context could not be resolved",
          retryable: true,
        });
      }
      if (
        requestedReleaseMode === "data_endpoint" &&
        context.phoneNumberIds.length === 0
      ) {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_PHONE_INVENTORY_EMPTY",
          message: "The WhatsApp Business Account has no phone numbers",
        });
      }

      try {
        sourceFence = await deps.acquireSourceFence({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          expectedWabaId: context.wabaId,
          kind: "PROVISIONING",
          semanticOperationId: `provision:${target.contentDigest}`,
        });
      } catch {
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
          message: "WhatsApp source binding is busy; retry provisioning",
          retryable: true,
        });
      }

      let endpointContext:
        | (ResolvedEndpointSecurityContext & {
            phoneNumberIds: readonly string[];
          })
        | null = null;
      let identity: ResolvedWhatsAppFlowProvisioningIdentity | null = null;
      if (requestedReleaseMode === "data_endpoint") {
        try {
          endpointContext = requireEndpointContext(context);
          identity = await deps.resolveEndpointIdentity({
            context: endpointContext,
            now,
          });
        } catch {
          await releaseSourceFence();
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_ENDPOINT_FAILED",
            message: "Managed Flow endpoint identity could not be resolved",
            retryable: true,
          });
        }
      }

      let operation: WhatsAppFlowProvisioningOperationRecord;
      try {
        operation = await deps.prepareOperation({
          workspaceId: input.workspaceId,
          scenarioId: input.scenarioId,
          nodeId: input.nodeId,
          sourceId: input.sourceId,
          wabaId: context.wabaId,
          releaseMode: requestedReleaseMode,
          ...(identity ? { endpointId: identity.endpointId } : {}),
          ...(context.applicationId
            ? { applicationId: context.applicationId }
            : {}),
          target,
        });
      } catch (error) {
        await releaseSourceFence();
        if (
          error instanceof WhatsAppFlowProvisioningStoreError &&
          error.code === "TEMPLATE_REBIND_REQUIRED"
        ) {
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_TEMPLATE_REBIND_REQUIRED",
            message: safeMessage(
              error.message,
              "Published template Flow binding must be replaced"
            ),
            retryable: false,
          });
        }
        if (
          error instanceof WhatsAppFlowProvisioningStoreError &&
          error.code === "SOURCE_REBIND_REQUIRED"
        ) {
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_REBIND_REQUIRED",
            message: safeMessage(
              error.message,
              "Replace the managed Flow binding before changing WhatsApp source"
            ),
            retryable: false,
          });
        }
        if (
          error instanceof WhatsAppFlowProvisioningStoreError &&
          error.code === "PROJECTED_OPERATION_MISSING"
        ) {
          return preliminaryFailure({
            code: "WHATSAPP_FLOW_PROVISIONING_TARGET_INVALID",
            message:
              "The projected Flow has no authoritative provisioning operation",
            retryable: false,
          });
        }
        return preliminaryFailure({
          code: "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
          message: "WhatsApp Flow provisioning operation could not be prepared",
          retryable: true,
        });
      }

      if (operation.status === "COMPLETED") {
        const providerFlowId = operation.providerFlowId;
        if (!providerFlowId) {
          await releaseSourceFence();
          return {
            ok: false,
            operationId: operation.operationId,
            status: operation.status,
            stage: "READING_BACK",
            phones: [],
            validationErrors: [],
            error: {
              code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
              message: "Completed Flow has no provider binding",
              retryable: false,
            },
          };
        }

        let replayProjection:
          | ManagedWhatsAppFlowProvisioningProjection
          | undefined;
        let replayScenarioRevision: { finalUpdatedAt: string } | undefined;
        let replayPhones: SafeEndpointPhoneSecurityState[] = [];
        try {
          await assertSourceBinding({
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            wabaId: operation.wabaId,
            stage: "READING_BACK",
          });
          const readback = await deps.getFlow({
            accessToken: context.accessToken,
            flowId: providerFlowId,
            expectedWabaId: context.wabaId,
          });
          if (!readback.ok) {
            throw providerFailure({
              result: readback,
              code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
              stage: "READING_BACK",
              fallback: "Published Flow readback failed",
            });
          }
          const verified = requireFlowBinding({
            flow: readback.flow,
            flowId: providerFlowId,
            ...(operation.providerFlowName
              ? { providerFlowName: operation.providerFlowName }
              : {}),
            context,
            releaseMode: requestedReleaseMode,
            ...(identity ? { identity } : {}),
            stage: "READING_BACK",
            requireApplication: requestedReleaseMode === "data_endpoint",
          });
          const confirmedStatus = flowStatus(verified);
          if (!confirmedStatus) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
              "Meta Flow readback did not include a supported status",
              "READING_BACK",
              false
            );
          }
          await assertSourceBinding({
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            wabaId: operation.wabaId,
            stage: "READING_BACK",
          });
          const reconciled = await deps.reconcileCompletedProviderStatus({
            operation,
            providerStatus: confirmedStatus,
            updatedBy: input.updatedBy,
            now: deps.now(),
          });
          const projection = reconciled.projection;
          const scenarioRevision = {
            finalUpdatedAt: reconciled.scenarioUpdatedAt,
          };
          replayProjection = projection;
          replayScenarioRevision = scenarioRevision;
          if (confirmedStatus !== "PUBLISHED") {
            return {
              ok: false,
              operationId: operation.operationId,
              status: operation.status,
              stage: "READING_BACK",
              projection,
              scenarioRevision,
              phones: [],
              validationErrors: flowValidationErrors(verified),
              error: {
                code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
                message: `Meta Flow is ${confirmedStatus}, not PUBLISHED`,
                retryable:
                  confirmedStatus === "BLOCKED" ||
                  confirmedStatus === "THROTTLED",
              },
            };
          }
          if (requestedReleaseMode === "data_endpoint") {
            if (!endpointContext || !identity) {
              throw new ProvisioningFailure(
                "WHATSAPP_FLOW_PROVISIONING_ENDPOINT_FAILED",
                "Completed Flow endpoint identity is unavailable",
                "ENSURING_PHONE_KEYS",
                true
              );
            }
            await assertSourceBinding({
              workspaceId: input.workspaceId,
              sourceId: input.sourceId,
              wabaId: operation.wabaId,
              stage: "ENSURING_PHONE_KEYS",
            });
            let readiness: EndpointReadiness;
            try {
              readiness = await deps.ensurePhoneKeys({
                context: endpointContext,
                expectedGenerationId: identity.expectedGenerationId,
                phoneNumberIds: endpointContext.phoneNumberIds,
                now: deps.now(),
              });
            } catch {
              throw new ProvisioningFailure(
                "WHATSAPP_FLOW_PROVISIONING_PHONE_KEYS_NOT_READY",
                "WhatsApp Flow phone key readiness could not be verified",
                "ENSURING_PHONE_KEYS",
                true
              );
            }
            replayPhones = readiness.phones;
            if (
              !isEndpointReady({
                readiness,
                expectedGenerationId: identity.expectedGenerationId,
                phoneNumberIds: endpointContext.phoneNumberIds,
              })
            ) {
              return {
                ok: false,
                operationId: operation.operationId,
                status: operation.status,
                stage: "ENSURING_PHONE_KEYS",
                projection,
                scenarioRevision,
                phones: replayPhones,
                validationErrors: [],
                error: {
                  code: "WHATSAPP_FLOW_PROVISIONING_PHONE_KEYS_NOT_READY",
                  message:
                    "Every WhatsApp phone must verify the current managed Flow public key",
                  retryable: true,
                },
              };
            }
            await assertSourceBinding({
              workspaceId: input.workspaceId,
              sourceId: input.sourceId,
              wabaId: operation.wabaId,
              stage: "ENSURING_PHONE_KEYS",
            });
          }
          return {
            ok: true,
            operationId: operation.operationId,
            status: "COMPLETED",
            stage: "COMPLETED",
            projection: {
              ...projection,
              flowId: providerFlowId,
              providerStatus: "PUBLISHED",
            },
            scenarioRevision,
            phones: replayPhones,
            validationErrors: [],
          };
        } catch (error) {
          const failure =
            error instanceof ProvisioningFailure
              ? error
              : new ProvisioningFailure(
                  "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
                  "Completed Flow status could not be reconciled",
                  "READING_BACK",
                  true
                );
          const failureResult = {
            ok: false as const,
            operationId: operation.operationId,
            status: operation.status,
            stage: failure.stage,
            phones: replayPhones,
            validationErrors: [],
            error: {
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable,
              ...(failure.providerCode !== undefined
                ? { providerCode: failure.providerCode }
                : {}),
              ...(failure.providerSubcode !== undefined
                ? { providerSubcode: failure.providerSubcode }
                : {}),
            },
          };
          return replayProjection && replayScenarioRevision
            ? {
                ...failureResult,
                projection: replayProjection,
                scenarioRevision: replayScenarioRevision,
              }
            : failureResult;
        } finally {
          await releaseSourceFence();
        }
      }

      let phones: SafeEndpointPhoneSecurityState[] = [];
      let lease: WhatsAppFlowProvisioningLease | null = null;
      let currentStage: ProvisioningStage = operation.stage;
      let currentValidationErrors: SafeWhatsAppFlowValidationError[] = [];

      const assertCurrent = async () => {
        if (!lease) throw new Error("Missing provisioning lease");
        await deps.assertTargetCurrent({ operation, lease, now: deps.now() });
        await assertSourceBinding({
          workspaceId: operation.workspaceId,
          sourceId: operation.sourceId,
          wabaId: operation.wabaId,
          stage: currentStage,
        });
      };

      const advance = async (stage: ProvisioningStage) => {
        if (!lease) throw new Error("Missing provisioning lease");
        await assertCurrent();
        operation = await deps.transitionStage({
          lease,
          stage,
          now: deps.now(),
        });
        currentStage = stage;
      };

      const recordStatus = async (status: ProviderStatus) => {
        if (!lease || operation.providerStatus === status) return;
        operation = await deps.recordProviderStatus({
          lease,
          providerStatus: status,
          now: deps.now(),
        });
      };

      const withLeaseHeartbeat = async <T>(
        providerCall: () => Promise<T>
      ): Promise<T> => {
        if (!lease) throw new Error("Missing provisioning lease");
        let renewalFailure: unknown;
        let providerFailure: unknown;
        let providerResult: T | undefined;
        let renewalChain = Promise.resolve();
        const heartbeat = setInterval(() => {
          renewalChain = renewalChain.then(async () => {
            if (renewalFailure) return;
            const activeLease = lease;
            const activeSourceFence = sourceFence;
            if (!activeLease || !activeSourceFence) {
              renewalFailure = new Error("Missing provisioning lease");
              return;
            }
            try {
              sourceFence = await deps.renewSourceFence(activeSourceFence);
              lease = await deps.renewLease({
                lease: activeLease,
                now: deps.now(),
              });
            } catch (error) {
              renewalFailure = error;
            }
          });
        }, PROVIDER_CALL_LEASE_HEARTBEAT_MS);

        try {
          providerResult = await providerCall();
        } catch (error) {
          providerFailure = error;
        } finally {
          clearInterval(heartbeat);
          await renewalChain;
        }

        if (renewalFailure) {
          throw new ProvisioningFailure(
            "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
            "WhatsApp Flow provisioning lease was lost",
            currentStage,
            true
          );
        }
        if (providerFailure) throw providerFailure;
        return providerResult as T;
      };

      try {
        lease = await deps.acquireLease({ operationId: operation.operationId });
        let providerFlowName = buildWhatsAppFlowProviderName({
          displayName: displayName(target.config),
          providerMarker: operation.providerMarker,
        });
        let providerFlowId = operation.providerFlowId;

        if (currentStage === "CREATING_FLOW") {
          let flowResult: WhatsAppFlowServiceResult | null = null;
          if (providerFlowId) {
            await assertCurrent();
            flowResult = await withLeaseHeartbeat(() =>
              deps.getFlow({
                accessToken: context.accessToken,
                flowId: providerFlowId!,
                expectedWabaId: context.wabaId,
              })
            );
            if (isDefinitivelyMissingProviderFlow(flowResult)) {
              const reconciled = await withLeaseHeartbeat(() =>
                deps.findFlowByExactName({
                  accessToken: context.accessToken,
                  wabaId: context.wabaId,
                  name: providerFlowName,
                })
              );
              if (!reconciled.ok) {
                throw providerFailure({
                  result: reconciled,
                  code:
                    reconciled.status === 409
                      ? "WHATSAPP_FLOW_PROVISIONING_MARKER_AMBIGUOUS"
                      : "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
                  stage: "CREATING_FLOW",
                  fallback: "Unable to reconcile the acknowledged Flow draft",
                });
              }
              if (reconciled.flow) {
                const reconciledFlowId = objectId(reconciled.flow.id);
                if (reconciledFlowId !== providerFlowId) {
                  throw new ProvisioningFailure(
                    "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
                    "The exact provider marker belongs to a different Flow",
                    "CREATING_FLOW",
                    false
                  );
                }
                flowResult = reconciled;
              } else if (
                !hasProviderDraftMissingGraceElapsed(operation, deps.now())
              ) {
                throw providerFailure({
                  result: flowResult,
                  code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
                  stage: "CREATING_FLOW",
                  fallback: "Acknowledged Meta Flow draft is not visible yet",
                  retryable: true,
                });
              } else {
                const failure = providerFailure({
                  result: flowResult,
                  code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
                  stage: "CREATING_FLOW",
                  fallback: "Acknowledged Meta Flow draft no longer exists",
                  retryable: true,
                });
                operation = await deps.resolveMissingProviderDraft({
                  lease,
                  providerFlowId,
                  error: normalizeProvisioningFailure(failure, deps.now()),
                  now: deps.now(),
                });
                lease = null;
                throw failure;
              }
            }
          } else {
            await assertCurrent();
            const existing = await withLeaseHeartbeat(() =>
              deps.findFlowByExactName({
                accessToken: context.accessToken,
                wabaId: context.wabaId,
                name: providerFlowName,
              })
            );
            if (!existing.ok) {
              throw providerFailure({
                result: existing,
                code:
                  existing.status === 409
                    ? "WHATSAPP_FLOW_PROVISIONING_MARKER_AMBIGUOUS"
                    : "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
                stage: "CREATING_FLOW",
                fallback: "Unable to reconcile the provider Flow draft",
              });
            }
            if (existing.flow) {
              flowResult = existing;
              providerFlowId = objectId(existing.flow.id) ?? undefined;
            } else {
              if (operation.cloneFlowId) {
                await assertCurrent();
                const cloneSource = await withLeaseHeartbeat(() =>
                  deps.getFlow({
                    accessToken: context.accessToken,
                    flowId: operation.cloneFlowId!,
                    expectedWabaId: context.wabaId,
                  })
                );
                if (!cloneSource.ok) {
                  if (isDefinitivelyMissingProviderFlow(cloneSource)) {
                    throw new ProvisioningFailure(
                      "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
                      "The published Flow selected as the clone source is no longer available",
                      "CREATING_FLOW",
                      false
                    );
                  }
                  throw providerFailure({
                    result: cloneSource,
                    code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
                    stage: "CREATING_FLOW",
                    fallback: "Unable to verify the published clone source",
                    retryable: true,
                  });
                }
                if (
                  objectId(cloneSource.flow?.id) !== operation.cloneFlowId ||
                  objectId(cloneSource.flow?.whatsapp_business_account) !==
                    context.wabaId ||
                  flowStatus(cloneSource.flow) !== "PUBLISHED"
                ) {
                  throw new ProvisioningFailure(
                    "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
                    "The Flow selected as the clone source is no longer published for this WhatsApp Business Account",
                    "CREATING_FLOW",
                    false
                  );
                }
              }
              await assertCurrent();
              const created = await withLeaseHeartbeat(() =>
                deps.createFlow({
                  accessToken: context.accessToken,
                  wabaId: context.wabaId,
                  name: providerFlowName,
                  categories: ["OTHER"],
                  ...(operation.cloneFlowId
                    ? { cloneFlowId: operation.cloneFlowId }
                    : {}),
                  ...(identity ? { endpointUri: identity.endpointUri } : {}),
                })
              );
              providerFlowId =
                created.providerFlowId ??
                objectId(created.flow?.id) ??
                undefined;
              flowResult = created;
              if (
                providerFlowId &&
                operation.providerFlowId !== providerFlowId
              ) {
                operation = await deps.recordProviderDraft({
                  lease,
                  providerFlowId,
                  providerFlowName,
                  now: deps.now(),
                });
              }
              if (!providerFlowId) {
                const reconciled = await withLeaseHeartbeat(() =>
                  deps.findFlowByExactName({
                    accessToken: context.accessToken,
                    wabaId: context.wabaId,
                    name: providerFlowName,
                  })
                );
                if (reconciled.ok && reconciled.flow) {
                  providerFlowId = objectId(reconciled.flow.id) ?? undefined;
                  flowResult = reconciled;
                }
              }
            }
          }
          if (!providerFlowId) {
            throw providerFailure({
              result: flowResult ?? { ok: false, status: 502 },
              code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
              stage: "CREATING_FLOW",
              fallback: "Meta did not return a Flow ID",
              retryable: true,
            });
          }
          if (!flowResult?.ok) {
            throw providerFailure({
              result: flowResult ?? { ok: false, status: 502 },
              code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
              stage: "CREATING_FLOW",
              fallback: "Meta Flow draft creation failed",
              retryable: true,
            });
          }
          const isBoundTemplateFlow =
            target.owner === "template" &&
            target.managedProjection?.flowId === providerFlowId;
          const createdFlow = requireFlowBinding({
            flow: flowResult.flow,
            flowId: providerFlowId,
            ...(isBoundTemplateFlow ? {} : { providerFlowName }),
            context,
            releaseMode: requestedReleaseMode,
            ...(identity ? { identity } : {}),
            stage: "CREATING_FLOW",
            requireApplication: false,
          });
          const confirmedProviderFlowName = flowName(createdFlow);
          if (!confirmedProviderFlowName) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
              "Meta Flow readback did not include a name",
              "CREATING_FLOW",
              false
            );
          }
          providerFlowName = confirmedProviderFlowName;
          const createdStatus = flowStatus(createdFlow);
          const hasPublishedTemplateEvidence =
            isBoundTemplateFlow &&
            target.managedProjection?.providerStatus === "PUBLISHED";
          if (createdStatus === "PUBLISHED" && !hasPublishedTemplateEvidence) {
            if (isBoundTemplateFlow) {
              throw new ProvisioningFailure(
                "WHATSAPP_FLOW_PROVISIONING_TEMPLATE_REBIND_REQUIRED",
                "Published template Flow binding must be replaced before publishing edited content",
                "CREATING_FLOW",
                false
              );
            }
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
              "Meta returned a published Flow before this content was uploaded",
              "CREATING_FLOW",
              false
            );
          }
          if (createdStatus !== "DRAFT" && createdStatus !== "PUBLISHED") {
            if (createdStatus) await recordStatus(createdStatus);
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
              "Meta Flow draft is not editable",
              "CREATING_FLOW",
              false
            );
          }
          if (
            operation.providerFlowId !== providerFlowId ||
            operation.providerFlowName !== providerFlowName ||
            operation.providerStatus !== createdStatus
          ) {
            operation = await deps.recordProviderDraft({
              lease,
              providerFlowId,
              providerFlowName,
              providerStatus: createdStatus,
              now: deps.now(),
            });
          }
          if (createdStatus === "PUBLISHED") {
            await advance("READING_BACK");
          } else {
            await advance(
              requestedReleaseMode === "data_endpoint"
                ? "ATTACHING_APPLICATION"
                : "UPLOADING_JSON"
            );
          }
        }

        providerFlowId = operation.providerFlowId ?? providerFlowId;
        providerFlowName = operation.providerFlowName ?? providerFlowName;
        if (!providerFlowId) {
          throw new ProvisioningFailure(
            "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
            "Provisioning operation lost its provider Flow ID",
            currentStage,
            false
          );
        }

        if (currentStage === "ATTACHING_APPLICATION") {
          if (!endpointContext || !identity) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
              "Flow reached an endpoint-only application stage",
              currentStage,
              false
            );
          }
          await assertCurrent();
          const attached = await withLeaseHeartbeat(() =>
            deps.updateFlow({
              accessToken: context.accessToken,
              flowId: providerFlowId,
              operation: "update",
              applicationId: endpointContext.applicationId,
              endpointUri: identity.endpointUri,
            })
          );
          if (!attached.ok) {
            throw providerFailure({
              result: attached,
              code: "WHATSAPP_FLOW_PROVISIONING_APPLICATION_FAILED",
              stage: "ATTACHING_APPLICATION",
              fallback: "Meta application attachment failed",
            });
          }
          requireFlowBinding({
            flow: attached.flow,
            flowId: providerFlowId,
            providerFlowName,
            context,
            releaseMode: requestedReleaseMode,
            identity,
            stage: "ATTACHING_APPLICATION",
            requireApplication: true,
          });
          await advance("ENSURING_PHONE_KEYS");
        }

        if (currentStage === "ENSURING_PHONE_KEYS") {
          if (!endpointContext || !identity) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
              "Flow reached an endpoint-only key stage",
              currentStage,
              false
            );
          }
          await assertCurrent();
          const readiness = await withLeaseHeartbeat(() =>
            deps.ensurePhoneKeys({
              context: endpointContext,
              expectedGenerationId: identity.expectedGenerationId,
              phoneNumberIds: endpointContext.phoneNumberIds,
              now: deps.now(),
            })
          );
          phones = readiness.phones;
          if (
            !isEndpointReady({
              readiness,
              expectedGenerationId: identity.expectedGenerationId,
              phoneNumberIds: endpointContext.phoneNumberIds,
            })
          ) {
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_PHONE_KEYS_NOT_READY",
              "Every WhatsApp phone must verify the managed Flow public key",
              "ENSURING_PHONE_KEYS",
              true
            );
          }
          await advance("UPLOADING_JSON");
        }

        if (currentStage === "UPLOADING_JSON") {
          await assertCurrent();
          const uploaded = await withLeaseHeartbeat(() =>
            deps.updateFlow({
              accessToken: context.accessToken,
              flowId: providerFlowId,
              operation: "update_json",
              flowJson: deps.generateFlowJson(target.config),
            })
          );
          currentValidationErrors = validationErrors(
            uploaded.validation_errors
          );
          if (!uploaded.ok || currentValidationErrors.length > 0) {
            throw providerFailure({
              result: uploaded,
              code: "WHATSAPP_FLOW_PROVISIONING_JSON_INVALID",
              stage: "UPLOADING_JSON",
              fallback:
                currentValidationErrors[0]?.message ??
                "Flow JSON validation failed",
              retryable: false,
            });
          }
          const uploadedFlow = requireFlowBinding({
            flow: uploaded.flow,
            flowId: providerFlowId,
            providerFlowName,
            context,
            releaseMode: requestedReleaseMode,
            ...(identity ? { identity } : {}),
            stage: "UPLOADING_JSON",
            requireApplication: requestedReleaseMode === "data_endpoint",
          });
          if (flowStatus(uploadedFlow) !== "DRAFT") {
            const status = flowStatus(uploadedFlow);
            if (status) await recordStatus(status);
            throw new ProvisioningFailure(
              "WHATSAPP_FLOW_PROVISIONING_JSON_INVALID",
              "Meta Flow was not left in DRAFT after JSON upload",
              "UPLOADING_JSON",
              false
            );
          }
          await recordStatus("DRAFT");
          await advance("PUBLISHING");
        }

        if (currentStage === "PUBLISHING") {
          await assertCurrent();
          const beforePublish = await withLeaseHeartbeat(() =>
            deps.getFlow({
              accessToken: context.accessToken,
              flowId: providerFlowId,
              expectedWabaId: context.wabaId,
            })
          );
          if (!beforePublish.ok) {
            throw providerFailure({
              result: beforePublish,
              code: "WHATSAPP_FLOW_PROVISIONING_PUBLISH_FAILED",
              stage: "PUBLISHING",
              fallback: "Meta Flow status could not be read before publish",
            });
          }
          const verifiedBeforePublish = requireFlowBinding({
            flow: beforePublish.flow,
            flowId: providerFlowId,
            providerFlowName,
            context,
            releaseMode: requestedReleaseMode,
            ...(identity ? { identity } : {}),
            stage: "PUBLISHING",
            requireApplication: requestedReleaseMode === "data_endpoint",
          });
          const status = flowStatus(verifiedBeforePublish);
          if (status !== "PUBLISHED") {
            if (status !== "DRAFT") {
              if (status) await recordStatus(status);
              throw new ProvisioningFailure(
                "WHATSAPP_FLOW_PROVISIONING_PUBLISH_FAILED",
                "Meta Flow is not publishable",
                "PUBLISHING",
                false
              );
            }
            await assertCurrent();
            const published = await withLeaseHeartbeat(() =>
              deps.updateFlow({
                accessToken: context.accessToken,
                flowId: providerFlowId,
                operation: "publish",
              })
            );
            if (!published.ok) {
              const publishedStatus = flowStatus(published.flow);
              if (publishedStatus) await recordStatus(publishedStatus);
              throw providerFailure({
                result: published,
                code: "WHATSAPP_FLOW_PROVISIONING_PUBLISH_FAILED",
                stage: "PUBLISHING",
                fallback: "Meta Flow publish failed",
                retryable: true,
              });
            }
          }
          await advance("READING_BACK");
        }

        if (currentStage !== "READING_BACK") {
          throw new ProvisioningFailure(
            "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
            "Provisioning operation reached an invalid stage",
            currentStage,
            false
          );
        }
        await assertCurrent();
        const readback = await withLeaseHeartbeat(() =>
          deps.getFlow({
            accessToken: context.accessToken,
            flowId: providerFlowId,
            expectedWabaId: context.wabaId,
          })
        );
        if (!readback.ok) {
          throw providerFailure({
            result: readback,
            code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
            stage: "READING_BACK",
            fallback: "Published Flow readback failed",
            retryable: true,
          });
        }
        const verified = requireFlowBinding({
          flow: readback.flow,
          flowId: providerFlowId,
          providerFlowName,
          context,
          releaseMode: requestedReleaseMode,
          ...(identity ? { identity } : {}),
          stage: "READING_BACK",
          requireApplication: requestedReleaseMode === "data_endpoint",
        });
        const finalStatus = flowStatus(verified);
        if (finalStatus) await recordStatus(finalStatus);
        if (finalStatus !== "PUBLISHED") {
          throw new ProvisioningFailure(
            "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
            "Meta did not confirm the Flow as PUBLISHED",
            "READING_BACK",
            true
          );
        }
        await assertCurrent();
        const completed = await deps.completeOperation({
          lease,
          updatedBy: input.updatedBy,
          now: deps.now(),
        });
        operation = completed.operation;
        const projection = completed.projection;
        const finalUpdatedAt = completed.scenarioUpdatedAt;
        if (!projection.flowId || projection.providerStatus !== "PUBLISHED") {
          throw new ProvisioningFailure(
            "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
            "Published Flow projection could not be completed",
            "COMPLETED",
            true
          );
        }
        return {
          ok: true,
          operationId: operation.operationId,
          status: "COMPLETED",
          stage: "COMPLETED",
          projection: {
            ...projection,
            flowId: projection.flowId,
            providerStatus: "PUBLISHED",
          },
          scenarioRevision: {
            finalUpdatedAt,
          },
          phones,
          validationErrors: [],
        };
      } catch (error) {
        const failure =
          error instanceof ProvisioningFailure
            ? error
            : new ProvisioningFailure(
                "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
                "WhatsApp Flow provisioning failed",
                currentStage,
                true
              );
        if (lease) {
          try {
            operation = await deps.failOperation({
              lease,
              error: normalizeProvisioningFailure(failure, deps.now()),
              now: deps.now(),
            });
          } catch {
            // Preserve the original bounded failure; a later retry reconciles the lease.
          }
        }
        return {
          ok: false,
          operationId: operation.operationId,
          status: operation.status,
          stage: failure.stage,
          phones,
          validationErrors: currentValidationErrors,
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            ...(failure.providerCode !== undefined
              ? { providerCode: failure.providerCode }
              : {}),
            ...(failure.providerSubcode !== undefined
              ? { providerSubcode: failure.providerSubcode }
              : {}),
          },
        };
      } finally {
        if (lease) {
          try {
            await deps.releaseLease(lease);
          } catch {
            // Lease expiry is the recovery boundary if release itself fails.
          }
        }
        await releaseSourceFence();
      }
    },
  };
}

async function resolveDefaultProvisioningContext(params: {
  workspaceId: string;
  sourceId: string;
  releaseMode: ReleaseMode;
}): Promise<ResolvedWhatsAppFlowProvisioningContext> {
  const account = await resolveWhatsAppAccountContext({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    probeEdge: "phone_numbers",
    probeFields: "id",
    logScope: "Flow provisioning phone inventory",
    failureMessage: "Unable to resolve WhatsApp Flow provisioning account",
  });
  if (
    account.sourceId !== params.sourceId ||
    !account.wabaId.trim() ||
    !account.accessToken.trim()
  ) {
    throw new Error("WhatsApp provisioning binding changed");
  }
  if (params.releaseMode === "linear") {
    return {
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      wabaId: account.wabaId,
      accessToken: account.accessToken,
      phoneNumberIds: [],
    };
  }

  const applicationId = getMetaServerAppConfig().appId.trim();
  if (!applicationId) {
    throw new Error("Meta application binding is unavailable");
  }
  const phones = await getWABAPhoneNumbersStrict({
    wabaId: account.wabaId,
    accessToken: account.accessToken,
  });
  return {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    wabaId: account.wabaId,
    applicationId,
    accessToken: account.accessToken,
    phoneNumberIds: phones.map(phone => phone.id),
  };
}

const defaultProvisioningService = createWhatsAppFlowProvisioningService({
  now: () => new Date(),
  getReleasePolicy: now =>
    evaluateManagedFlowReleasePolicy(now, MANAGED_FLOW_RELEASE_POLICY),
  isWorkspaceEnabled: workspaceId =>
    isWorkspaceFeatureEnabled(workspaceId, "whatsapp_flow_managed_endpoint"),
  validateTarget: validateWhatsAppFlowProvisioningTarget,
  resolveContext: resolveDefaultProvisioningContext,
  resolveEndpointIdentity: async params => {
    const identity = await resolveManagedWhatsAppFlowEndpointIdentity(params);
    if (!identity.endpointUri) {
      throw new Error("Managed WhatsApp Flow endpoint URI is unavailable");
    }
    return {
      endpointId: identity.endpointId,
      endpointUri: identity.endpointUri,
      expectedGenerationId: identity.expectedGenerationId,
    };
  },
  prepareOperation: prepareWhatsAppFlowProvisioningOperation,
  acquireLease: acquireWhatsAppFlowProvisioningLease,
  renewLease: renewWhatsAppFlowProvisioningLease,
  assertTargetCurrent: assertWhatsAppFlowProvisioningTargetCurrent,
  assertSourceBinding: async params => {
    const current = await resolveFreshWhatsAppSendContext({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
    });
    if (
      current?.sourceId !== params.sourceId ||
      current.workspaceId !== params.workspaceId ||
      current.wabaId !== params.wabaId
    ) {
      throw new WhatsAppFlowProvisioningStoreError(
        "SOURCE_REBIND_REQUIRED",
        "WhatsApp source binding changed while provisioning"
      );
    }
  },
  acquireSourceFence: params =>
    whatsAppFlowSourceBindingFenceStore.acquire(params),
  renewSourceFence: lease => whatsAppFlowSourceBindingFenceStore.renew(lease),
  assertSourceFence: async lease => {
    await whatsAppFlowSourceBindingFenceStore.assertCurrent(lease);
  },
  releaseSourceFence: lease =>
    whatsAppFlowSourceBindingFenceStore.release(lease),
  transitionStage: transitionWhatsAppFlowProvisioningStage,
  recordProviderDraft: recordWhatsAppFlowProviderDraft,
  recordProviderStatus: recordWhatsAppFlowProviderStatus,
  resolveMissingProviderDraft: resolveMissingWhatsAppFlowProviderDraft,
  reconcileCompletedProviderStatus:
    reconcileCompletedWhatsAppFlowProviderStatus,
  failOperation: failWhatsAppFlowProvisioningOperation,
  completeOperation: completeWhatsAppFlowProvisioningOperation,
  releaseLease: releaseWhatsAppFlowProvisioningLease,
  findFlowByExactName: findMetaWhatsAppFlowByExactName,
  createFlow: createMetaWhatsAppFlow,
  getFlow: getMetaWhatsAppFlow,
  updateFlow: updateMetaWhatsAppFlow,
  ensurePhoneKeys: ensureWhatsAppFlowPhoneKeyReadiness,
  generateFlowJson: generateFlowJsonString,
});

export async function provisionWhatsAppFlow(
  input: ProvisionWhatsAppFlowInput
): Promise<WhatsAppFlowProvisioningResult> {
  return defaultProvisioningService.provision(input);
}
