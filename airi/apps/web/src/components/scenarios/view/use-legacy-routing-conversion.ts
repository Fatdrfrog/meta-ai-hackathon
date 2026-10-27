"use client";

import type {
  ScenarioDetailResponseMetadata,
  ScenarioDetailResponseWarning,
  ScenarioDocument,
} from "@/components/scenarios/types";
import {
  convertLegacyActionRoutingRequest,
  type ScenarioRequestError,
} from "@/lib/scenarios/client";
import type {
  ScenarioActionRoutingPatch,
  ScenarioLegacyActionRoutingSource,
} from "@icecore/scenario-contracts";
import { useCallback, useRef } from "react";
import { isScenarioRequestErrorWithCode } from "./scenario-request-error-utils";
import { useLatestRef } from "./use-latest-ref";

export type ConvertLegacyActionRoutingInput = {
  sourceActionNodeId: string;
  sourceNodeId: string;
  sourceKind: ScenarioLegacyActionRoutingSource["sourceKind"];
  patch: ScenarioActionRoutingPatch;
};

type LegacyRoutingConversionHost = {
  readState: () => {
    scenarioId: string | null;
    expectedUpdatedAt: string | null;
    /** Changes with the loaded flow session; local graph edits keep it. */
    sessionKey: string;
    /** Changes with the loaded flow session and every local graph edit. */
    ownershipKey: string;
    isDirty: boolean;
    hasConflict: boolean;
  };
  cancelPendingAutosave: () => void;
  saveScenario: () => Promise<boolean>;
  applyActionRoutingPatch: (
    sourceActionNodeId: string,
    patch: ScenarioActionRoutingPatch
  ) => boolean;
  adoptConvertedScenario: (
    scenarioId: string,
    scenario: ScenarioDocument,
    sourceActionNodeId: string,
    metadata: ScenarioDetailResponseMetadata,
    ownershipKey: string
  ) => boolean;
  onConflict: () => void;
  onError: (error: unknown) => void;
  onWarning: (warning: ScenarioDetailResponseWarning) => void;
  onStatusChange: (status: "saved" | "saving" | "unsaved") => void;
  /** Settles the "saving" status of a request whose result was discarded. */
  onConversionAbandoned: () => void;
};

type LegacyRoutingConversionOwnership = {
  scenarioId: string;
  expectedUpdatedAt: string;
  ownershipKey: string;
};

type QueuedConversionOwner = Pick<
  ReturnType<LegacyRoutingConversionHost["readState"]>,
  "scenarioId" | "sessionKey"
>;

function ownsLegacyRoutingConversion(
  state: ReturnType<LegacyRoutingConversionHost["readState"]>,
  ownership: LegacyRoutingConversionOwnership
): boolean {
  return (
    !state.isDirty &&
    !state.hasConflict &&
    state.scenarioId === ownership.scenarioId &&
    state.expectedUpdatedAt === ownership.expectedUpdatedAt &&
    state.ownershipKey === ownership.ownershipKey
  );
}

function isQueuedConversionSession(
  state: ReturnType<LegacyRoutingConversionHost["readState"]>,
  owner: QueuedConversionOwner
): boolean {
  return (
    state.scenarioId === owner.scenarioId &&
    state.sessionKey === owner.sessionKey
  );
}

type ConversionRequest = {
  sessionKey: string;
  expectedUpdatedAt: string;
  sourceActionNodeId: string;
  patchKey: string;
};

type RejectedConversion = Omit<ConversionRequest, "patchKey"> & {
  /**
   * The edit a 400 rejected, as it validates the converted graph that
   * includes the edit; null for a 409, which rejects the stored routing or
   * its waiting conversations whatever the edit.
   */
  patchKey: string | null;
  error: ScenarioRequestError;
};

/**
 * A 400 or 409 recurs until the scenario revision or session changes.
 * Revision conflicts are excluded: the host marks and blocks them already.
 */
function isDeterministicConversionFailure(
  error: unknown
): error is ScenarioRequestError {
  if (!(error instanceof Error) || error.name !== "ScenarioRequestError") {
    return false;
  }
  const { status } = error as ScenarioRequestError;
  return (
    (status === 400 || status === 409) &&
    !isScenarioRequestErrorWithCode(error, "scenario_updated_conflict")
  );
}

function repeatsRejectedConversion(
  rejected: RejectedConversion | undefined,
  request: ConversionRequest
): rejected is RejectedConversion {
  return (
    rejected !== undefined &&
    rejected.sessionKey === request.sessionKey &&
    rejected.expectedUpdatedAt === request.expectedUpdatedAt &&
    rejected.sourceActionNodeId === request.sourceActionNodeId &&
    (rejected.patchKey === null || rejected.patchKey === request.patchKey)
  );
}

export function useLegacyRoutingConversion(params: {
  workspaceId: string;
  host: LegacyRoutingConversionHost;
}) {
  const hostRef = useLatestRef(params.host);
  const conversionTailRef = useRef<Promise<void>>(Promise.resolve());
  const convertedAtBySourceRef = useRef(new Map<string, string>());
  const rejectedBySourceRef = useRef(new Map<string, RejectedConversion>());

  const performConversion = useCallback(
    async (
      input: ConvertLegacyActionRoutingInput,
      queuedOwner: QueuedConversionOwner
    ): Promise<boolean> => {
      const host = hostRef.current;
      const state = host.readState();
      // A queued edit belongs to the session it was made in; local graph edits
      // made meanwhile are saved before converting, like any other dirty state.
      if (!isQueuedConversionSession(state, queuedOwner)) return false;
      if (!state.scenarioId || state.hasConflict) {
        if (state.hasConflict) host.onConflict();
        return false;
      }
      const scenarioId = state.scenarioId;

      const sourceKey = [scenarioId, input.sourceKind, input.sourceNodeId].join(
        "\u0000"
      );
      if (
        state.expectedUpdatedAt &&
        convertedAtBySourceRef.current.get(sourceKey) ===
          state.expectedUpdatedAt
      ) {
        const applied = host.applyActionRoutingPatch(
          input.sourceActionNodeId,
          input.patch
        );
        if (applied) host.onStatusChange("unsaved");
        return applied;
      }

      host.cancelPendingAutosave();
      if (state.isDirty && !(await host.saveScenario())) return false;

      const requestState = host.readState();
      if (!isQueuedConversionSession(requestState, queuedOwner)) return false;
      if (requestState.isDirty || requestState.hasConflict) {
        if (requestState.hasConflict) host.onConflict();
        return false;
      }
      if (!requestState.expectedUpdatedAt) {
        host.onError(null);
        return false;
      }
      const request: ConversionRequest = {
        sessionKey: requestState.sessionKey,
        expectedUpdatedAt: requestState.expectedUpdatedAt,
        sourceActionNodeId: input.sourceActionNodeId,
        patchKey: JSON.stringify(input.patch),
      };
      const rejected = rejectedBySourceRef.current.get(sourceKey);
      if (repeatsRejectedConversion(rejected, request)) {
        // Re-sending would fail the same way; repeat the reason instead.
        host.onError(rejected.error);
        return false;
      }
      const ownership: LegacyRoutingConversionOwnership = {
        scenarioId,
        expectedUpdatedAt: requestState.expectedUpdatedAt,
        ownershipKey: requestState.ownershipKey,
      };

      try {
        host.onStatusChange("saving");
        const converted = await convertLegacyActionRoutingRequest({
          scenarioId,
          workspaceId: params.workspaceId,
          expectedUpdatedAt: ownership.expectedUpdatedAt,
          sourceActionNodeId: input.sourceActionNodeId,
          sourceNodeId: input.sourceNodeId,
          sourceKind: input.sourceKind,
          actionOutcomes: input.patch.actionOutcomes,
          actionRunConditions: input.patch.actionRunConditions,
        });
        if (!ownsLegacyRoutingConversion(host.readState(), ownership)) {
          host.onConversionAbandoned();
          return false;
        }
        const adopted = host.adoptConvertedScenario(
          scenarioId,
          converted.scenario,
          input.sourceActionNodeId,
          converted.metadata,
          ownership.ownershipKey
        );
        if (!adopted) {
          host.onConversionAbandoned();
          return false;
        }
        if (converted.scenario.updatedAt) {
          convertedAtBySourceRef.current.set(
            sourceKey,
            converted.scenario.updatedAt
          );
        }
        host.onStatusChange("saved");
        for (const warning of converted.metadata.warnings ?? []) {
          host.onWarning(warning);
        }
        return true;
      } catch (error) {
        const currentState = host.readState();
        const ownsRequest = ownsLegacyRoutingConversion(
          currentState,
          ownership
        );
        // A local edit made during the request does not apply the routing
        // change either. Once the session or base revision moved on (e.g. a
        // save committed first), the failure is expected and not a conflict.
        const reportsFailure =
          ownsRequest ||
          (isQueuedConversionSession(currentState, queuedOwner) &&
            !currentState.hasConflict &&
            currentState.expectedUpdatedAt === ownership.expectedUpdatedAt);
        if (reportsFailure) {
          if (
            isScenarioRequestErrorWithCode(error, "scenario_updated_conflict")
          ) {
            host.onConflict();
          } else {
            if (isDeterministicConversionFailure(error)) {
              rejectedBySourceRef.current.set(sourceKey, {
                ...request,
                patchKey: error.status === 400 ? request.patchKey : null,
                error,
              });
            }
            host.onError(error);
          }
        }
        // Settle the status after any conflict is marked, so it reads it.
        if (ownsRequest) host.onStatusChange("unsaved");
        else host.onConversionAbandoned();
        return false;
      }
    },
    [hostRef, params.workspaceId]
  );

  return useCallback(
    (input: ConvertLegacyActionRoutingInput): Promise<boolean> => {
      const { scenarioId, sessionKey } = hostRef.current.readState();
      const operation = conversionTailRef.current
        .catch(() => undefined)
        .then(() => performConversion(input, { scenarioId, sessionKey }));
      conversionTailRef.current = operation.then(
        () => undefined,
        () => undefined
      );
      return operation;
    },
    [hostRef, performConversion]
  );
}
