"use client";

import { buildDemoScenarioSeed } from "@/components/scenarios/scenario-onboarding";
import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  DEFAULT_SCENARIO_VIEWPORT,
  type ScenarioEntryPolicy,
  type ScenarioMatchingRole,
  type ScenarioStatus,
  type ScenarioViewport,
} from "@/components/scenarios/types";
import { pickActiveScenarioId } from "@/lib/scenarios/active-scenario-id";
import { normalizeScenarioGraphLayout } from "@/lib/scenarios/graph-layout";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import type { ScenarioGeneratorCreateInput } from "@icecore/scenario-contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { captureClientEvent } from "@/lib/posthog/client";
import {
  getScenarioRequestErrorCode,
  resolveScenarioRequestErrorCodeMessage,
} from "../view/scenario-request-error-utils";
import {
  createScenarioFromGeneratorRequest,
  createScenarioRequest,
  deleteScenarioRequest,
  fetchScenarios,
  patchScenarioSidebarRequest,
  type ScenarioSidebarPatch,
} from "@/lib/scenarios/client";
import { buildCustomerFunnelTemplates } from "@/lib/scenario-generator/templates/funnel";
import type {
  ScenarioActionSourceId,
  ScenarioContextOption,
  ScenarioDocument,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioSummary,
  TranslateFn,
} from "../types";
import { buildEmptyFlow } from "../view/graph/starter";
import { computeSidebarPrioritiesFromSummaries } from "../view/hierarchy/utils";
import {
  buildGuidedScenarioSeed,
  type ScenarioGuidedCreateKind,
} from "../view/scenario-guided-create";
import {
  applyScenarioEntryInputs,
  patchScenarioSummaryFields,
  prependScenarioSummary,
  replaceScenarioSummary,
  type ScenarioSidebarSnapshot,
} from "../view/scenario-summary-utils";
import { useLatestRef } from "../view/use-latest-ref";
import { useScenarioHierarchyEntity } from "../view/use-scenario-hierarchy-entity";
import {
  buildRevenuePlaybookSeed,
  type RevenuePlaybookConfig,
} from "../view/scenario-revenue-playbooks";

type CreateScenarioOptions = {
  description?: string;
  initialFlow?: {
    nodes: ScenarioFlowNode[];
    edges: ScenarioFlowEdge[];
  };
  presetId?: string | null;
  presetVersion?: string | null;
  segmentKey?: string | null;
  matchingRole?: ScenarioMatchingRole;
  entryPolicy?: ScenarioEntryPolicy;
  priority?: number;
  viewport?: ScenarioViewport;
};

type UseScenarioWorkspaceEntityParams = {
  workspaceId: string;
  contextOptions: ScenarioContextOption[];
  /** Guided starters reply on the workspace's connected channel. */
  connectedActionSources?: readonly ScenarioActionSourceId[];
  requestedScenarioId?: string | null;
  initialScenarios?: ScenarioSummary[];
  t: TranslateFn;
};

type ScenarioSidebarSaveResult = { status: "saved" | "failed" };

function toScenarioSidebarSnapshot(
  scenario: ScenarioSummary | ScenarioDocument
): ScenarioSidebarSnapshot {
  return {
    name: scenario.name,
    status: scenario.status,
    priority: scenario.priority,
    matchingRole: scenario.matchingRole,
    entryPolicy: scenario.entryPolicy,
    updatedAt: scenario.updatedAt,
  };
}

function buildConfirmedSidebarSnapshots(
  scenarios: ScenarioSummary[]
): Record<string, ScenarioSidebarSnapshot> {
  return Object.fromEntries(
    scenarios.map(item => [item._id, toScenarioSidebarSnapshot(item)] as const)
  );
}

function getScenarioMembershipIdentity(scenarios: ScenarioSummary[]): string {
  return JSON.stringify(scenarios.map(scenario => scenario._id).sort());
}

function hasGeneratingScenarioMedia(scenario: ScenarioDocument): boolean {
  return (scenario.nodes || []).some(node => {
    const config = node.data.bulkRootConfig;
    const status =
      config && typeof config === "object" && "generationStatus" in config
        ? config.generationStatus
        : undefined;
    return status === "queued" || status === "generating_media";
  });
}

export type ScenarioWorkspacePendingConfirmation = {
  kind: "delete_scenario";
  scenarioId: string;
  scenarioName: string;
};

export function useScenarioWorkspaceEntity({
  workspaceId,
  contextOptions,
  connectedActionSources,
  requestedScenarioId = null,
  initialScenarios,
  t,
}: UseScenarioWorkspaceEntityParams) {
  const hasInitialScenarios = initialScenarios !== undefined;
  const [scenarios, setScenarioState] = useState<ScenarioSummary[]>(
    () => initialScenarios ?? []
  );
  const confirmedSidebarByScenarioIdRef = useRef<
    Record<string, ScenarioSidebarSnapshot>
  >(null as unknown as Record<string, ScenarioSidebarSnapshot>);
  if (confirmedSidebarByScenarioIdRef.current == null) {
    confirmedSidebarByScenarioIdRef.current = buildConfirmedSidebarSnapshots(
      initialScenarios ?? []
    );
  }
  const sidebarMutationVersionByScenarioIdRef = useRef<Record<string, number>>(
    {}
  );
  const sidebarSaveQueueByScenarioIdRef = useRef<Record<string, Promise<void>>>(
    {}
  );
  const sidebarWorkspaceMutationVersionRef = useRef(0);
  const reorderAttemptVersionRef = useRef(0);
  const scenariosRef = useLatestRef(scenarios);
  const setScenarios: Dispatch<SetStateAction<ScenarioSummary[]>> = useCallback(
    update => {
      // Async commands may read the collection before React commits a render.
      const next =
        typeof update === "function" ? update(scenariosRef.current) : update;
      scenariosRef.current = next;
      setScenarioState(next);
    },
    [scenariosRef]
  );
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(() =>
    pickActiveScenarioId(initialScenarios ?? [], requestedScenarioId)
  );
  const activeScenarioIdRef = useLatestRef(activeScenarioId);
  const workspaceOwnerKey = useTransitionOwnerKey(workspaceId);
  const workspaceOwnerKeyRef = useLatestRef(workspaceOwnerKey);
  const selectionIntentRef = useRef(0);
  const [pendingScenarioId, setPendingScenarioId] = useState<string | null>(
    null
  );
  const [entryPriorityInput, setEntryPriorityInput] = useState<string>("0");
  const [loadingScenarios, setLoadingScenarios] =
    useState(!hasInitialScenarios);
  const [creatingOwnerKey, setCreatingOwnerKey] = useState<string | null>(null);
  const isCreatingScenario = creatingOwnerKey === workspaceOwnerKey;
  const setIsCreatingScenario = useCallback(
    (creating: boolean) => {
      setCreatingOwnerKey(current =>
        creating
          ? workspaceOwnerKey
          : current === workspaceOwnerKey
            ? null
            : current
      );
    },
    [workspaceOwnerKey]
  );
  const [pendingConfirmation, setPendingConfirmation] =
    useState<ScenarioWorkspacePendingConfirmation | null>(null);
  const funnelTemplates = useMemo(() => buildCustomerFunnelTemplates(t), [t]);
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(
    null
  );

  const { activeScenario, scenarioListLayoutItems, handleScenarioReorder } =
    useScenarioHierarchyEntity({
      scenarios,
      activeScenarioId,
      setScenarios,
    });

  const activeScenarioName = activeScenario?.name ?? "";
  const activeScenarioDescription = activeScenario?.description ?? "";
  const activeScenarioStatus = activeScenario?.status ?? "draft";

  const adoptConfirmedScenarioDocument = useCallback(
    (scenario: ScenarioDocument) => {
      sidebarWorkspaceMutationVersionRef.current += 1;
      confirmedSidebarByScenarioIdRef.current[scenario._id] =
        toScenarioSidebarSnapshot(scenario);
      setScenarios(current => replaceScenarioSummary(current, scenario));
    },
    [setScenarios]
  );

  const resolvePendingConfirmation = useCallback((confirmed: boolean) => {
    const resolver = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setPendingConfirmation(null);
    resolver?.(confirmed);
  }, []);

  const closePendingConfirmation = useCallback(() => {
    resolvePendingConfirmation(false);
  }, [resolvePendingConfirmation]);

  const confirmPendingConfirmation = useCallback(() => {
    resolvePendingConfirmation(true);
  }, [resolvePendingConfirmation]);

  const requestConfirmation = useCallback(
    (confirmation: ScenarioWorkspacePendingConfirmation) =>
      new Promise<boolean>(resolve => {
        if (confirmationResolverRef.current) {
          confirmationResolverRef.current(false);
        }
        confirmationResolverRef.current = resolve;
        setPendingConfirmation(confirmation);
      }),
    []
  );

  const loadScenarios = useCallback(
    async (options?: { shouldApply?: () => boolean }) => {
      try {
        setLoadingScenarios(true);
        const items = await fetchScenarios(workspaceId);
        if (options?.shouldApply && !options.shouldApply()) {
          return;
        }
        confirmedSidebarByScenarioIdRef.current =
          buildConfirmedSidebarSnapshots(items);
        setScenarios(items);
      } catch {
        toast.error(t("loadFailed"));
      } finally {
        setLoadingScenarios(false);
      }
    },
    [setScenarios, t, workspaceId]
  );

  const createScenario = useCallback(
    async (
      name = t("defaultScenarioName"),
      options?: CreateScenarioOptions
    ) => {
      sidebarWorkspaceMutationVersionRef.current += 1;
      const rawStarterFlow = options?.initialFlow || buildEmptyFlow();
      const ownerKey = workspaceOwnerKeyRef.current;
      const starterFlow = normalizeScenarioGraphLayout(rawStarterFlow);
      const created = await createScenarioRequest({
        workspaceId,
        name,
        description: options?.description || "",
        status: "draft",
        priority: options?.priority ?? 0,
        presetId: options?.presetId ?? null,
        presetVersion: options?.presetVersion ?? null,
        segmentKey: options?.segmentKey ?? null,
        matchingRole: options?.matchingRole ?? "default",
        entryPolicy: options?.entryPolicy ?? DEFAULT_SCENARIO_ENTRY_POLICY,
        nodes: starterFlow.nodes,
        edges: starterFlow.edges,
        viewport: options?.viewport ?? DEFAULT_SCENARIO_VIEWPORT,
      });

      if (ownerKey !== workspaceOwnerKeyRef.current) return null;
      confirmedSidebarByScenarioIdRef.current[created._id] =
        toScenarioSidebarSnapshot(created);
      setScenarios(current => prependScenarioSummary(current, created));

      return created;
    },
    [setScenarios, t, workspaceId, workspaceOwnerKeyRef]
  );

  const createDemoScenario = useCallback(async () => {
    if (isCreatingScenario) return null;

    setIsCreatingScenario(true);
    try {
      const seed = buildDemoScenarioSeed({
        contextOptions,
        t,
      });
      return await createScenario(seed.name, {
        initialFlow: seed.initialFlow,
        presetId: seed.presetId,
        presetVersion: "1",
        matchingRole: "default",
        viewport: seed.viewport,
      });
    } catch (error) {
      toast.error(
        resolveScenarioRequestErrorCodeMessage(error, t, "createFailed")
      );
      return null;
    } finally {
      setIsCreatingScenario(false);
    }
  }, [
    contextOptions,
    createScenario,
    isCreatingScenario,
    setIsCreatingScenario,
    t,
  ]);

  const createScenarioFromGuide = useCallback(
    async (kind: ScenarioGuidedCreateKind) => {
      if (isCreatingScenario) return null;

      setIsCreatingScenario(true);
      try {
        const seed = buildGuidedScenarioSeed({
          kind,
          t,
          connectedActionSources,
        });
        return await createScenario(seed.name, {
          initialFlow: seed.initialFlow,
          matchingRole: seed.matchingRole,
        });
      } catch (error) {
        toast.error(
          resolveScenarioRequestErrorCodeMessage(error, t, "createFailed")
        );
        return null;
      } finally {
        setIsCreatingScenario(false);
      }
    },
    [
      connectedActionSources,
      createScenario,
      isCreatingScenario,
      setIsCreatingScenario,
      t,
    ]
  );

  const createScenarioFromGenerator = useCallback(
    async (
      input: ScenarioGeneratorCreateInput
    ): Promise<ScenarioDocument | null> => {
      if (isCreatingScenario) return null;

      const ownerKey = workspaceOwnerKeyRef.current;
      sidebarWorkspaceMutationVersionRef.current += 1;
      setIsCreatingScenario(true);
      try {
        const result = await createScenarioFromGeneratorRequest(input);
        if (ownerKey !== workspaceOwnerKeyRef.current) return null;
        const created = result.scenario;
        confirmedSidebarByScenarioIdRef.current[created._id] =
          toScenarioSidebarSnapshot(created);
        setScenarios(current => prependScenarioSummary(current, created));
        toast.success(
          hasGeneratingScenarioMedia(created)
            ? t("generatedScenarioCreatedMediaPending")
            : t("generatedScenarioCreated")
        );
        return created;
      } catch (error) {
        if (ownerKey === workspaceOwnerKeyRef.current) {
          toast.error(
            resolveScenarioRequestErrorCodeMessage(error, t, "createFailed")
          );
        }
        return null;
      } finally {
        if (ownerKey === workspaceOwnerKeyRef.current) {
          setIsCreatingScenario(false);
        }
      }
    },
    [
      isCreatingScenario,
      setIsCreatingScenario,
      setScenarios,
      t,
      workspaceOwnerKeyRef,
    ]
  );
  const createScenarioFromRevenuePlaybook = useCallback(
    async (config: RevenuePlaybookConfig) => {
      if (isCreatingScenario) return null;
      const seed = buildRevenuePlaybookSeed(config);
      const ownerKey = workspaceOwnerKeyRef.current;
      setIsCreatingScenario(true);
      try {
        return await createScenario(seed.name, {
          description: seed.description,
          initialFlow: seed.initialFlow,
          presetId: seed.presetId,
          presetVersion: seed.presetVersion,
          segmentKey: seed.segmentKey,
        });
      } catch (error) {
        if (ownerKey === workspaceOwnerKeyRef.current)
          toast.error(
            resolveScenarioRequestErrorCodeMessage(error, t, "createFailed")
          );
        return null;
      } finally {
        if (ownerKey === workspaceOwnerKeyRef.current)
          setIsCreatingScenario(false);
      }
    },
    [
      createScenario,
      isCreatingScenario,
      setIsCreatingScenario,
      t,
      workspaceOwnerKeyRef,
    ]
  );

  const mutateScenarioSidebar = useCallback(
    async (
      scenarioId: string,
      patch: ScenarioSidebarPatch,
      options?: { notifyOnError?: boolean }
    ): Promise<ScenarioSidebarSaveResult> => {
      sidebarWorkspaceMutationVersionRef.current += 1;
      const currentScenario = scenariosRef.current.find(
        scenario => scenario._id === scenarioId
      );
      if (!currentScenario) {
        return { status: "failed" };
      }
      confirmedSidebarByScenarioIdRef.current[scenarioId] ??=
        toScenarioSidebarSnapshot(currentScenario);
      const mutationVersion =
        (sidebarMutationVersionByScenarioIdRef.current[scenarioId] ?? 0) + 1;
      sidebarMutationVersionByScenarioIdRef.current[scenarioId] =
        mutationVersion;
      const isLatestRequest = () =>
        sidebarMutationVersionByScenarioIdRef.current[scenarioId] ===
        mutationVersion;

      setScenarios(current =>
        current.map(scenario =>
          scenario._id === scenarioId
            ? patchScenarioSummaryFields(scenario, patch)
            : scenario
        )
      );
      if (
        activeScenarioIdRef.current === scenarioId &&
        Object.prototype.hasOwnProperty.call(patch, "priority")
      ) {
        applyScenarioEntryInputs({
          scenario: patch,
          setEntryPriorityInput,
        });
      }

      const previousSave =
        sidebarSaveQueueByScenarioIdRef.current[scenarioId] ??
        Promise.resolve();
      const operation = previousSave
        .catch(() => undefined)
        .then(() =>
          patchScenarioSidebarRequest({
            scenarioId,
            workspaceId,
            patch,
          })
        );
      const queueTail = operation.then(
        () => undefined,
        () => undefined
      );
      sidebarSaveQueueByScenarioIdRef.current[scenarioId] = queueTail;

      try {
        const updated = await operation;
        const confirmedSnapshot = toScenarioSidebarSnapshot(updated);
        confirmedSidebarByScenarioIdRef.current[scenarioId] = confirmedSnapshot;
        if (!isLatestRequest()) {
          return { status: "saved" };
        }

        setScenarios(current =>
          current.map(scenario =>
            scenario._id === scenarioId
              ? patchScenarioSummaryFields(scenario, confirmedSnapshot)
              : scenario
          )
        );

        if (activeScenarioIdRef.current === scenarioId) {
          applyScenarioEntryInputs({
            scenario: confirmedSnapshot,
            setEntryPriorityInput,
          });
        }

        return { status: "saved" };
      } catch (error) {
        const isLatest = isLatestRequest();
        if (isLatest) {
          const confirmedSnapshot =
            confirmedSidebarByScenarioIdRef.current[scenarioId];
          if (confirmedSnapshot) {
            setScenarios(current =>
              current.map(scenario =>
                scenario._id === scenarioId
                  ? patchScenarioSummaryFields(scenario, confirmedSnapshot)
                  : scenario
              )
            );
            if (activeScenarioIdRef.current === scenarioId) {
              applyScenarioEntryInputs({
                scenario: confirmedSnapshot,
                setEntryPriorityInput,
              });
            }
          }
        }
        if (patch.status === "active") {
          // Same measure as the editor's activation failure.
          captureClientEvent("scenario_activation_blocked", {
            workspace_id: workspaceId,
            error_code: getScenarioRequestErrorCode(error) ?? "unknown",
          });
        }
        if (options?.notifyOnError !== false) {
          toast.error(
            resolveScenarioRequestErrorCodeMessage(error, t, "saveFailed")
          );
        }
        return { status: "failed" };
      } finally {
        if (sidebarSaveQueueByScenarioIdRef.current[scenarioId] === queueTail) {
          delete sidebarSaveQueueByScenarioIdRef.current[scenarioId];
        }
      }
    },
    [activeScenarioIdRef, scenariosRef, setScenarios, t, workspaceId]
  );

  const persistScenarioPrioritiesForSidebarOrder = useCallback(
    async (
      orderedScenarios: ScenarioSummary[],
      savePriority?: (scenarioId: string, priority: number) => Promise<boolean>
    ) => {
      const priorityById =
        computeSidebarPrioritiesFromSummaries(orderedScenarios);
      const mutations = orderedScenarios.flatMap(scenario => {
        const nextPriority = priorityById.get(scenario._id);
        if (nextPriority === undefined || scenario.priority === nextPriority) {
          return [];
        }
        return [{ scenarioId: scenario._id, priority: nextPriority }];
      });
      const results = await Promise.all(
        mutations.map(async ({ scenarioId, priority }) => {
          if (savePriority) {
            return {
              status: (await savePriority(scenarioId, priority))
                ? "saved"
                : "failed",
            };
          }
          return mutateScenarioSidebar(
            scenarioId,
            { priority },
            { notifyOnError: false }
          );
        })
      );
      return {
        failed: results.some(result => result.status === "failed"),
        scenarioIds: mutations.map(mutation => mutation.scenarioId),
      };
    },
    [mutateScenarioSidebar]
  );

  const waitForScenarioSidebarLanes = useCallback(
    async (scenarioIds: string[]) => {
      await Promise.all(
        Array.from(new Set(scenarioIds)).map(async scenarioId => {
          while (true) {
            const pending = sidebarSaveQueueByScenarioIdRef.current[scenarioId];
            if (!pending) return;
            await pending;
            const current = sidebarSaveQueueByScenarioIdRef.current[scenarioId];
            if (!current || current === pending) {
              return;
            }
          }
        })
      );
    },
    []
  );

  const selectScenario = useCallback(
    async (
      scenarioId: string | null,
      flushEditor: () => Promise<boolean>
    ): Promise<boolean> => {
      const intent = ++selectionIntentRef.current;
      const ownerKey = workspaceOwnerKeyRef.current;
      const ownsIntent = () =>
        intent === selectionIntentRef.current &&
        ownerKey === workspaceOwnerKeyRef.current;
      if (scenarioId === activeScenarioIdRef.current) {
        setPendingScenarioId(null);
        return true;
      }
      setPendingScenarioId(scenarioId);
      try {
        while (true) {
          if (scenarioId) await waitForScenarioSidebarLanes([scenarioId]);
          if (!ownsIntent()) return false;
          const departingDocumentExists = scenariosRef.current.some(
            scenario => scenario._id === activeScenarioIdRef.current
          );
          if (departingDocumentExists && !(await flushEditor())) return false;
          if (!ownsIntent()) return false;
          // A destination write can start during the departure save. Drain
          // both sides again so edits made during that wait are saved too.
          if (
            !scenarioId ||
            !sidebarSaveQueueByScenarioIdRef.current[scenarioId]
          )
            break;
        }
        if (
          scenarioId &&
          !scenariosRef.current.some(scenario => scenario._id === scenarioId)
        ) {
          return false;
        }
        activeScenarioIdRef.current = scenarioId;
        setActiveScenarioId(scenarioId);
        return true;
      } finally {
        if (ownsIntent()) setPendingScenarioId(null);
      }
    },
    [
      activeScenarioIdRef,
      scenariosRef,
      waitForScenarioSidebarLanes,
      workspaceOwnerKeyRef,
    ]
  );

  const handleScenarioReorderWithSave = useCallback(
    (
      payload: Parameters<typeof handleScenarioReorder>[0],
      savePriority?: (scenarioId: string, priority: number) => Promise<boolean>
    ) => {
      const outcome = handleScenarioReorder(payload);
      const prioritySyncScenarios = outcome.prioritySyncScenarios;
      if (!prioritySyncScenarios) {
        return;
      }
      const reorderAttemptVersion = reorderAttemptVersionRef.current + 1;
      reorderAttemptVersionRef.current = reorderAttemptVersion;

      void (async () => {
        const saveResult = await persistScenarioPrioritiesForSidebarOrder(
          prioritySyncScenarios,
          savePriority
        );
        if (!saveResult.failed) {
          return;
        }

        if (!savePriority) toast.error(t("saveFailed"));
        if (reorderAttemptVersionRef.current !== reorderAttemptVersion) {
          return;
        }
        await waitForScenarioSidebarLanes(saveResult.scenarioIds);
        if (reorderAttemptVersionRef.current !== reorderAttemptVersion) {
          return;
        }
        const recoverySidebarMutationVersion =
          sidebarWorkspaceMutationVersionRef.current;
        const recoveryMembershipIdentity = getScenarioMembershipIdentity(
          scenariosRef.current
        );
        // Keep confirmed documents and newly created scenarios while the
        // authoritative order reloads; a captured collection may be stale.
        await loadScenarios({
          shouldApply: () =>
            reorderAttemptVersionRef.current === reorderAttemptVersion &&
            sidebarWorkspaceMutationVersionRef.current ===
              recoverySidebarMutationVersion &&
            getScenarioMembershipIdentity(scenariosRef.current) ===
              recoveryMembershipIdentity,
        });
      })();
    },
    [
      handleScenarioReorder,
      loadScenarios,
      persistScenarioPrioritiesForSidebarOrder,
      scenariosRef,
      t,
      waitForScenarioSidebarLanes,
    ]
  );

  const saveScenarioPatch = useCallback(
    async (
      scenarioId: string,
      patch: ScenarioSidebarPatch
    ): Promise<boolean> => {
      const result = await mutateScenarioSidebar(scenarioId, patch);
      return result.status === "saved";
    },
    [mutateScenarioSidebar]
  );

  const handleActiveScenarioStatusChange = useCallback(
    (status: ScenarioStatus, scenarioId?: string) => {
      if (!activeScenarioId) return;
      if (scenarioId && scenarioId !== activeScenarioId) return;
      setScenarios(current =>
        current.map(scenario =>
          scenario._id === activeScenarioId ? { ...scenario, status } : scenario
        )
      );
    },
    [activeScenarioId, setScenarios]
  );

  const activeScenarioGraphSettings = useMemo(
    () => ({
      onScenarioStatusChange: handleActiveScenarioStatusChange,
    }),
    [handleActiveScenarioStatusChange]
  );

  const handleScenarioNameCommit = useCallback(
    async (scenarioId: string, value: string): Promise<boolean> => {
      const scenario = scenariosRef.current.find(
        item => item._id === scenarioId
      );
      if (!scenario) return false;

      const normalizedName = value.trim() || t("defaultScenarioName");
      if (normalizedName === scenario.name) {
        return true;
      }

      const result = await mutateScenarioSidebar(scenarioId, {
        name: normalizedName,
      });
      return result.status !== "failed";
    },
    [mutateScenarioSidebar, scenariosRef, t]
  );

  const handleScenarioSettingsSave = useCallback(
    async (params: {
      scenarioId: string;
      status: ScenarioStatus;
      priority: number;
    }): Promise<boolean> => {
      const result = await mutateScenarioSidebar(params.scenarioId, {
        status: params.status,
        priority: params.priority,
      });
      return result.status !== "failed";
    },
    [mutateScenarioSidebar]
  );

  const deleteScenarioById = useCallback(
    async (scenarioId: string): Promise<boolean> => {
      if (scenariosRef.current.length <= 1) return false;
      const currentScenario = scenariosRef.current.find(
        scenario => scenario._id === scenarioId
      );
      const isConfirmed = await requestConfirmation({
        kind: "delete_scenario",
        scenarioId,
        scenarioName: currentScenario?.name ?? "",
      });
      if (!isConfirmed) return false;

      sidebarWorkspaceMutationVersionRef.current += 1;
      try {
        await deleteScenarioRequest({
          scenarioId,
          workspaceId,
          scenarioName: currentScenario?.name ?? "",
          expectedUpdatedAt: currentScenario?.updatedAt ?? null,
        });

        const remaining = scenariosRef.current.filter(
          scenario => scenario._id !== scenarioId
        );
        delete confirmedSidebarByScenarioIdRef.current[scenarioId];
        delete sidebarMutationVersionByScenarioIdRef.current[scenarioId];
        setScenarios(remaining);
        toast.success(t("deleteSuccess"));
        return true;
      } catch {
        toast.error(t("deleteFailed"));
        return false;
      }
    },
    [requestConfirmation, scenariosRef, setScenarios, t, workspaceId]
  );

  useEffect(() => {
    if (hasInitialScenarios) return;
    void loadScenarios();
  }, [hasInitialScenarios, loadScenarios]);

  useEffect(() => {
    return () => {
      selectionIntentRef.current += 1;
      confirmationResolverRef.current?.(false);
      confirmationResolverRef.current = null;
    };
  }, []);

  return {
    scenarios,
    setScenarios,
    activeScenarioId,
    selectScenario,
    pendingScenarioId,
    adoptConfirmedScenarioDocument,
    activeScenario,
    activeScenarioName,
    activeScenarioDescription,
    activeScenarioStatus,
    activeScenarioGraphSettings,
    entryPriorityInput,
    setEntryPriorityInput,
    loadingScenarios,
    isCreatingScenario,
    funnelTemplates,
    scenarioListLayoutItems,
    pendingConfirmation,
    closePendingConfirmation,
    confirmPendingConfirmation,
    createScenarioFromGuide,
    createScenarioFromRevenuePlaybook,
    createDemoScenario,
    createScenarioFromGenerator,
    handleScenarioReorderWithSave,
    handleScenarioNameCommit,
    handleScenarioSettingsSave,
    saveScenarioPatch,
    deleteScenarioById,
  };
}
