"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type {
  WhatsAppQrPickerDisabledReason,
  WhatsAppQrTriggerPickerProps,
} from "@/components/scenarios/nodes/trigger-node/whatsapp-qr-trigger-picker";
import { useOwnerBoundState } from "@/components/whatsapp-qr/owner-bound-state";
import type { WhatsAppQrSourceOption } from "@/components/whatsapp-qr/types";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  fetchWhatsAppQrEntryPoints,
  fetchWhatsAppQrScenarioSummaries,
  postWhatsAppQrAssignmentCommand,
  WhatsAppQrClientError,
  type WhatsAppQrAssignmentResult,
  type WhatsAppQrAssignmentSummary,
  type WhatsAppQrManagerListItem,
  type WhatsAppQrScenarioSummary,
} from "@/lib/whatsapp/qr-entry-points/client";
import { trackScenarioWrite } from "@/lib/scenarios/client/scenario-revision-tracker";

import type { WhatsAppQrAssignmentHostSnapshot } from "./use-scenario-flow-controller";

export type WhatsAppQrAssignmentHost = {
  readEntryPointId: (nodeId: string) => string | null;
  readSnapshot: (nodeId: string) => WhatsAppQrAssignmentHostSnapshot;
  /**
   * The snapshot a picker shows while it renders, from that render's save
   * state. Defaults to readSnapshot.
   */
  readPickerSnapshot?: (nodeId: string) => WhatsAppQrAssignmentHostSnapshot;
  adopt: (
    snapshot: WhatsAppQrAssignmentHostSnapshot,
    result: WhatsAppQrAssignmentResult
  ) => boolean;
};

type UseScenarioWhatsAppQrEntryPointsParams = {
  workspaceId: string;
  scenarioId: string | null;
  scenarioName: string;
  whatsAppSources: WhatsAppQrSourceOption[];
  assignmentHost: WhatsAppQrAssignmentHost;
  onSelectScenario: (scenarioId: string) => void;
  /**
   * Whether the loaded graph has a WhatsApp QR trigger. Without one no
   * picker shows, so assignments are not read. Defaults to true.
   */
  hasWhatsAppQrTrigger?: boolean;
};

type ScenarioQrState = {
  summariesByNodeId: Map<string, WhatsAppQrScenarioSummary>;
  summariesResolved: boolean;
  summaryLoading: boolean;
  summaryError: string | null;
  mutationBusy: boolean;
  mutationError: { nodeId: string; message: string } | null;
};

/** A graph without a QR trigger has no assignments to read. */
const SUMMARIES_WITHOUT_QR_TRIGGER: Pick<
  ScenarioQrState,
  "summariesByNodeId" | "summariesResolved" | "summaryLoading" | "summaryError"
> = {
  summariesByNodeId: new Map(),
  summariesResolved: true,
  summaryLoading: false,
  summaryError: null,
};

const createInitialScenarioQrState = (): ScenarioQrState => ({
  summariesByNodeId: new Map(),
  summariesResolved: false,
  summaryLoading: true,
  summaryError: null,
  mutationBusy: false,
  mutationError: null,
});

function summariesRecordToMap(
  record: Record<string, WhatsAppQrScenarioSummary>
): Map<string, WhatsAppQrScenarioSummary> {
  return new Map(Object.entries(record));
}

function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function hostDisabledReason(error: unknown): WhatsAppQrPickerDisabledReason {
  const message = error instanceof Error ? error.message : "";
  if (/deactivate/i.test(message)) return "deactivate-target";
  if (/wait/i.test(message)) return "wait-for-save";
  if (/not found/i.test(message)) return "summary-unavailable";
  return "save-scenario";
}

function assignmentClientError(
  result: {
    status: number;
    error: string;
    code?: string;
    currentAssignment?: WhatsAppQrAssignmentSummary | null;
  },
  localizedMessage = result.error
) {
  return new WhatsAppQrClientError(
    localizedMessage,
    result.status,
    result.code,
    undefined,
    result.currentAssignment
  );
}

export function useScenarioWhatsAppQrEntryPoints({
  workspaceId,
  scenarioId,
  scenarioName,
  whatsAppSources,
  assignmentHost,
  onSelectScenario,
  hasWhatsAppQrTrigger = true,
}: UseScenarioWhatsAppQrEntryPointsParams) {
  const t = useTranslations("Scenarios");
  const scenarioOwnerKey = useTransitionOwnerKey(
    `${workspaceId.trim()}\u0000${scenarioId?.trim() || ""}`
  );
  const [storedScenarioState, setScenarioState] = useOwnerBoundState(
    scenarioOwnerKey,
    createInitialScenarioQrState
  );
  // Until a QR trigger appears the stored state stays unread, so a trigger
  // added later shows loading rather than an empty assignment.
  const scenarioState = useMemo(
    () =>
      hasWhatsAppQrTrigger
        ? storedScenarioState
        : { ...storedScenarioState, ...SUMMARIES_WITHOUT_QR_TRIGGER },
    [hasWhatsAppQrTrigger, storedScenarioState]
  );
  const scenarioOwnerKeyRef = useRef(scenarioOwnerKey);
  scenarioOwnerKeyRef.current = scenarioOwnerKey;
  const summaryRequestRef = useRef(0);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const mutationGuardRef = useRef<{
    ownerKey: string;
    token: number;
    busy: boolean;
    controller: AbortController | null;
  }>({
    ownerKey: scenarioOwnerKey,
    token: 0,
    busy: false,
    controller: null,
  });

  const patchScenarioState = useCallback(
    (expectedOwner: string, patch: Partial<ScenarioQrState>) => {
      if (scenarioOwnerKeyRef.current !== expectedOwner) return false;
      setScenarioState(current => ({ ...current, ...patch }));
      return true;
    },
    [setScenarioState]
  );

  const refreshSummaries = useCallback(async () => {
    const expectedOwner = scenarioOwnerKey;
    if (!workspaceId.trim() || !scenarioId?.trim()) {
      patchScenarioState(expectedOwner, {
        summariesByNodeId: new Map(),
        summariesResolved: true,
        summaryLoading: false,
        summaryError: null,
      });
      return;
    }

    const requestId = ++summaryRequestRef.current;
    summaryAbortRef.current?.abort();
    const abortController = new AbortController();
    summaryAbortRef.current = abortController;
    patchScenarioState(expectedOwner, {
      summaryLoading: true,
      summaryError: null,
    });
    const result = await fetchWhatsAppQrScenarioSummaries({
      workspaceId,
      scenarioId,
      signal: abortController.signal,
    });
    if (
      abortController.signal.aborted ||
      requestId !== summaryRequestRef.current ||
      scenarioOwnerKeyRef.current !== expectedOwner
    ) {
      return;
    }
    if (result.ok) {
      patchScenarioState(expectedOwner, {
        summariesByNodeId: summariesRecordToMap(result.data.summaries),
        summariesResolved: true,
        summaryLoading: false,
        summaryError: null,
      });
      return;
    }
    patchScenarioState(expectedOwner, {
      summariesResolved: false,
      summaryLoading: false,
      summaryError: t("whatsappQrPickerErrors.summaryFailed", {
        diagnostic: result.error,
      }),
    });
  }, [patchScenarioState, scenarioId, scenarioOwnerKey, t, workspaceId]);

  useEffect(() => {
    if (!hasWhatsAppQrTrigger) return;
    void refreshSummaries();
    return () => summaryAbortRef.current?.abort();
  }, [hasWhatsAppQrTrigger, refreshSummaries]);

  useEffect(
    () => () => {
      mutationGuardRef.current.controller?.abort();
    },
    []
  );

  useEffect(() => {
    const previous = mutationGuardRef.current;
    if (previous.ownerKey === scenarioOwnerKey) return;
    previous.controller?.abort();
    mutationGuardRef.current = {
      ownerKey: scenarioOwnerKey,
      token: previous.token + 1,
      busy: false,
      controller: null,
    };
  }, [scenarioOwnerKey]);

  const sourceLabels = useMemo(
    () =>
      Object.fromEntries(
        whatsAppSources.flatMap(source => {
          const sourceId = source.id.trim();
          return sourceId ? [[sourceId, source.label] as const] : [];
        })
      ),
    [whatsAppSources]
  );

  const loadOptions = useCallback<WhatsAppQrTriggerPickerProps["loadOptions"]>(
    async input => {
      const result = await fetchWhatsAppQrEntryPoints({
        workspaceId,
        query: input.query,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: 20,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!result.ok) {
        throw assignmentClientError(
          result,
          t("whatsappQrPickerErrors.optionsFailed", {
            diagnostic: result.error,
          })
        );
      }
      return result.data;
    },
    [t, workspaceId]
  );

  const runMutation = useCallback(
    async (
      nodeId: string,
      operation: (input: {
        expectedOwner: string;
        snapshot: WhatsAppQrAssignmentHostSnapshot;
        signal: AbortSignal;
      }) => Promise<WhatsAppQrAssignmentResult>
    ) => {
      const expectedOwner = scenarioOwnerKey;
      let guard = mutationGuardRef.current;
      if (guard.ownerKey !== expectedOwner) {
        guard.controller?.abort();
        guard = {
          ownerKey: expectedOwner,
          token: guard.token + 1,
          busy: false,
          controller: null,
        };
        mutationGuardRef.current = guard;
      }
      if (guard.busy) {
        patchScenarioState(expectedOwner, {
          mutationError: {
            nodeId,
            message: t("whatsappQrPickerMutationBusy"),
          },
        });
        return;
      }

      guard.controller?.abort();
      const abortController = new AbortController();
      const token = guard.token + 1;
      mutationGuardRef.current = {
        ownerKey: expectedOwner,
        token,
        busy: true,
        controller: abortController,
      };
      patchScenarioState(expectedOwner, {
        mutationBusy: true,
        mutationError: null,
      });
      try {
        let snapshot: WhatsAppQrAssignmentHostSnapshot;
        try {
          snapshot = assignmentHost.readSnapshot(nodeId);
        } catch (hostError) {
          throw new Error(
            t(`whatsappQrPickerDisabled.${hostDisabledReason(hostError)}`)
          );
        }
        const result = await operation({
          expectedOwner,
          snapshot,
          signal: abortController.signal,
        });
        if (
          abortController.signal.aborted ||
          scenarioOwnerKeyRef.current !== expectedOwner ||
          !assignmentHost.adopt(snapshot, result)
        ) {
          throw new Error(t("whatsappQrPickerErrors.adoptionChanged"));
        }
        return result;
      } catch (mutationError) {
        if (!abortController.signal.aborted) {
          patchScenarioState(expectedOwner, {
            mutationError: {
              nodeId,
              message: messageForError(
                mutationError,
                t("whatsappQrPickerErrors.requestFailed")
              ),
            },
          });
          if (
            mutationError instanceof WhatsAppQrClientError &&
            mutationError.status === 409
          ) {
            await refreshSummaries();
          }
        }
      } finally {
        const currentGuard = mutationGuardRef.current;
        if (
          currentGuard.ownerKey === expectedOwner &&
          currentGuard.token === token &&
          currentGuard.controller === abortController
        ) {
          mutationGuardRef.current = {
            ownerKey: expectedOwner,
            token,
            busy: false,
            controller: null,
          };
        }
        if (
          scenarioOwnerKeyRef.current === expectedOwner &&
          mutationGuardRef.current.ownerKey === expectedOwner &&
          mutationGuardRef.current.token === token &&
          !mutationGuardRef.current.busy
        ) {
          patchScenarioState(expectedOwner, { mutationBusy: false });
        }
      }
    },
    [assignmentHost, patchScenarioState, refreshSummaries, scenarioOwnerKey, t]
  );

  const assign = useCallback(
    async (nodeId: string, option: WhatsAppQrManagerListItem) => {
      if (
        assignmentHost.readEntryPointId(nodeId) === option.entryPointId &&
        option.assignment?.scenarioId === scenarioId &&
        option.assignment.nodeId === nodeId
      ) {
        return;
      }
      const expectedOwner = scenarioOwnerKey;
      await runMutation(nodeId, async ({ snapshot, signal }) => {
        if (!scenarioId || snapshot.scenarioId !== scenarioId) {
          throw new Error(t("whatsappQrPickerErrors.ownerChanged"));
        }
        if (option.readiness !== "ready") {
          throw new Error(t("whatsappQrPickerSetupRequired"));
        }
        if (option.assignment?.scenarioStatus === "active") {
          throw new Error(
            t("whatsappQrPickerDeactivateSource", {
              scenario: option.assignment.scenarioName,
            })
          );
        }

        const currentSummary = snapshot.currentEntryPointId
          ? scenarioState.summariesByNodeId.get(snapshot.nodeId)
          : null;
        if (
          snapshot.currentEntryPointId &&
          (!currentSummary ||
            currentSummary.entryPointId !== snapshot.currentEntryPointId)
        ) {
          throw new Error(t("whatsappQrPickerErrors.refreshBeforeReplacement"));
        }
        const response = await trackScenarioWrite(
          postWhatsAppQrAssignmentCommand({
            signal,
            body: {
              command: "assign",
              workspaceId,
              entryPointId: option.entryPointId,
              expectedEntryPointVersion: option.version,
              target: {
                scenarioId: snapshot.scenarioId,
                nodeId: snapshot.nodeId,
                expectedUpdatedAt: snapshot.expectedUpdatedAt,
                expectedCurrentEntryPointId: snapshot.currentEntryPointId,
                ...(currentSummary
                  ? { expectedCurrentEntryPointVersion: currentSummary.version }
                  : {}),
              },
              acknowledgeMove: Boolean(option.assignment),
              acknowledgeReplacement: Boolean(currentSummary),
              ...(option.assignment
                ? {
                    sourceExpectedUpdatedAt:
                      option.assignment.scenarioUpdatedAt,
                  }
                : {}),
            },
          })
        );
        if (!response.ok) {
          throw assignmentClientError(
            response,
            t("whatsappQrPickerErrors.mutationFailed", {
              diagnostic: response.error,
            })
          );
        }
        const result = response.data;
        if (
          result.entryPointId !== option.entryPointId ||
          result.assignment?.scenarioId !== snapshot.scenarioId ||
          result.assignment.nodeId !== snapshot.nodeId
        ) {
          throw new Error(t("whatsappQrPickerErrors.assignmentMismatch"));
        }

        return result;
      }).then(async result => {
        if (!result) return;
        const optimistic = new Map(scenarioState.summariesByNodeId);
        if (
          result.sourceScenario?.scenarioId === scenarioId &&
          result.sourceScenario.nodeId !== nodeId
        ) {
          optimistic.delete(result.sourceScenario.nodeId);
        }
        optimistic.set(nodeId, {
          entryPointId: option.entryPointId,
          placementName: option.placementName,
          status: option.status,
          ...(option.sourceId ? { sourceId: option.sourceId } : {}),
          hasCurrentCode: Boolean(option.currentCode),
          readiness: option.readiness,
          reconcilePending: option.reconcilePending,
          version: result.entryPointVersion,
        });
        patchScenarioState(expectedOwner, { summariesByNodeId: optimistic });
        await refreshSummaries();
      });
    },
    [
      patchScenarioState,
      refreshSummaries,
      runMutation,
      assignmentHost,
      scenarioId,
      scenarioOwnerKey,
      scenarioState.summariesByNodeId,
      t,
      workspaceId,
    ]
  );

  const unassign = useCallback(
    async (nodeId: string) => {
      const expectedOwner = scenarioOwnerKey;
      await runMutation(nodeId, async ({ snapshot, signal }) => {
        const currentSummary = snapshot.currentEntryPointId
          ? scenarioState.summariesByNodeId.get(snapshot.nodeId)
          : null;
        if (!snapshot.currentEntryPointId || !currentSummary) {
          throw new Error(t("whatsappQrPickerErrors.refreshBeforeClear"));
        }
        if (currentSummary.entryPointId !== snapshot.currentEntryPointId) {
          throw new Error(t("whatsappQrPickerDisabled.selection-conflict"));
        }
        const response = await trackScenarioWrite(
          postWhatsAppQrAssignmentCommand({
            signal,
            body: {
              command: "unassign",
              workspaceId,
              entryPointId: currentSummary.entryPointId,
              expectedEntryPointVersion: currentSummary.version,
              sourceExpectedUpdatedAt: snapshot.expectedUpdatedAt,
            },
          })
        );
        if (!response.ok) {
          throw assignmentClientError(
            response,
            t("whatsappQrPickerErrors.mutationFailed", {
              diagnostic: response.error,
            })
          );
        }
        const result = response.data;
        if (
          result.entryPointId !== currentSummary.entryPointId ||
          result.assignment !== null ||
          result.sourceScenario?.scenarioId !== snapshot.scenarioId ||
          result.sourceScenario.nodeId !== snapshot.nodeId
        ) {
          throw new Error(t("whatsappQrPickerErrors.unassignmentMismatch"));
        }
        return result;
      }).then(async result => {
        if (!result) return;
        const optimistic = new Map(scenarioState.summariesByNodeId);
        optimistic.delete(nodeId);
        patchScenarioState(expectedOwner, { summariesByNodeId: optimistic });
        await refreshSummaries();
      });
    },
    [
      patchScenarioState,
      refreshSummaries,
      runMutation,
      scenarioOwnerKey,
      scenarioState.summariesByNodeId,
      t,
      workspaceId,
    ]
  );

  const readPickerSnapshot =
    assignmentHost.readPickerSnapshot ?? assignmentHost.readSnapshot;
  const getPickerProps = useCallback(
    (nodeId: string): WhatsAppQrTriggerPickerProps => {
      const selectedEntryPointId = assignmentHost.readEntryPointId(nodeId);
      const candidate = scenarioState.summariesByNodeId.get(nodeId) ?? null;
      const selected =
        selectedEntryPointId && candidate?.entryPointId === selectedEntryPointId
          ? candidate
          : null;
      let disabledReason: WhatsAppQrPickerDisabledReason | undefined;
      if (
        scenarioState.summariesResolved &&
        (candidate?.entryPointId ?? null) !== selectedEntryPointId
      ) {
        disabledReason = "selection-conflict";
      } else if (
        !scenarioState.summariesResolved &&
        !scenarioState.summaryLoading
      ) {
        disabledReason = "summary-unavailable";
      } else {
        try {
          const snapshot = readPickerSnapshot(nodeId);
          if (snapshot.currentEntryPointId !== selectedEntryPointId) {
            disabledReason = "selection-conflict";
          }
        } catch (snapshotError) {
          disabledReason = hostDisabledReason(snapshotError);
        }
      }

      return {
        selected,
        selectedEntryPointId,
        selectionResolved: scenarioState.summariesResolved,
        targetScenarioId: scenarioId,
        targetNodeId: nodeId,
        targetScenarioName: scenarioName,
        managerHref: `/panel/w/${encodeURIComponent(workspaceId)}/messengers/whatsapp-qr`,
        ...(disabledReason ? { disabledReason } : {}),
        sourceLabels,
        loading:
          scenarioState.summaryLoading && !scenarioState.summariesResolved,
        error:
          (scenarioState.mutationError?.nodeId === nodeId
            ? scenarioState.mutationError.message
            : null) || scenarioState.summaryError,
        busy: scenarioState.mutationBusy,
        loadOptions,
        onAssign: option => assign(nodeId, option),
        onUnassign: () => unassign(nodeId),
        onRefresh: refreshSummaries,
        onOpenScenario: onSelectScenario,
      };
    },
    [
      assign,
      assignmentHost,
      loadOptions,
      onSelectScenario,
      readPickerSnapshot,
      scenarioId,
      scenarioName,
      scenarioState.mutationBusy,
      scenarioState.mutationError,
      scenarioState.summariesByNodeId,
      scenarioState.summariesResolved,
      scenarioState.summaryError,
      scenarioState.summaryLoading,
      sourceLabels,
      refreshSummaries,
      unassign,
      workspaceId,
    ]
  );

  return {
    summariesByNodeId: scenarioState.summariesByNodeId,
    getPickerProps,
    refreshSummaries,
  };
}
