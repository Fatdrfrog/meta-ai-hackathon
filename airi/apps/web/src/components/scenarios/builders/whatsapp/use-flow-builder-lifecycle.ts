"use client";

import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";

import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  sanitizeWhatsAppFlowConfig,
  toEditableWhatsAppFlowConfig,
} from "@/lib/scenarios/whatsapp-flow-config";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useLatestRef } from "../../view/use-latest-ref";
import type { ManagedWhatsAppFlowProvisioningHost } from "./managed-provisioning-host";
import { validateWhatsAppFlowConfig } from "./flow-validation";
import { formatFlowValidationIssue } from "./flow-validation-messages";
import { getExistingFlowOptionKey } from "./existing-flow-options";
import type { ExistingFlow } from "./template-picker";

type Translate = (key: string) => string;
type SaveFailure = Error & { issues?: string[] };

type State = {
  confirmingReset: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  saveIssueLines: string[];
  selectingExistingFlowKey: string | null;
  existingFlowSelectionError: string | null;
  selectedProvisioningSourceId: string | null;
};

const INITIAL_STATE: State = {
  confirmingReset: false,
  saveState: "idle",
  saveError: null,
  saveIssueLines: [],
  selectingExistingFlowKey: null,
  existingFlowSelectionError: null,
  selectedProvisioningSourceId: null,
};

function failure(message: string, issues?: string[]): SaveFailure {
  const error = new Error(message) as SaveFailure;
  error.issues = issues;
  return error;
}

function flowIdentity(config: WhatsAppFlowConfig | null | undefined): string {
  return JSON.stringify([
    config?.templateId ?? null,
    config?.providerReference?.flowId ?? null,
    config?.providerReference?.sourceId ?? null,
  ]);
}

export function useFlowBuilderLifecycle({
  flowConfig,
  commitFlowConfig,
  workspaceId,
  templateEmbeddedFlowId,
  host,
  onSelectExistingFlow,
  onFlowArtifactsChanged,
  t,
}: {
  flowConfig: WhatsAppFlowConfig | null | undefined;
  commitFlowConfig: (config: WhatsAppFlowConfig) => void;
  workspaceId?: string;
  templateEmbeddedFlowId?: string | null;
  host?: ManagedWhatsAppFlowProvisioningHost;
  onSelectExistingFlow?: (flow: ExistingFlow) => void | Promise<void>;
  onFlowArtifactsChanged?: () => void;
  t: Translate;
}) {
  const [state, patchState] = useReducer(
    (current: State, patch: Partial<State>) => ({ ...current, ...patch }),
    INITIAL_STATE
  );
  const valueKey = JSON.stringify([
    host?.ownerKey ?? null,
    workspaceId ?? null,
    templateEmbeddedFlowId?.trim() || null,
    flowIdentity(flowConfig),
    host?.sources.map(source => source.id) ?? [],
  ]);
  const ownerKey = useTransitionOwnerKey(valueKey);
  const ownerKeyRef = useLatestRef(ownerKey);
  const requestSequenceRef = useRef(0);
  const publishInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sources = useMemo(() => host?.sources ?? [], [host?.sources]);
  const boundSourceId =
    flowConfig?.managedProvisioning?.sourceId?.trim() || null;
  const boundSourceAvailable = Boolean(
    boundSourceId && sources.some(source => source.id === boundSourceId)
  );
  const selectedSourceId = boundSourceId
    ? boundSourceAvailable
      ? boundSourceId
      : null
    : sources.length === 1
      ? (sources[0]?.id ?? null)
      : sources.some(source => source.id === state.selectedProvisioningSourceId)
        ? state.selectedProvisioningSourceId
        : null;
  const publishDisabledReason = !workspaceId
    ? null
    : !host
      ? t("flowManagedScenarioRequired")
      : sources.length === 0 || (boundSourceId && !boundSourceAvailable)
        ? t("flowManagedSourceRequired")
        : sources.length > 1 && !selectedSourceId
          ? t("flowManagedSourceSelect")
          : null;
  const publishing = state.saveState === "saving" || Boolean(host?.publishing);

  useEffect(() => {
    mountedRef.current = true;
    requestSequenceRef.current += 1;
    publishInFlightRef.current = false;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
    patchState(INITIAL_STATE);
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    };
  }, [ownerKey]);

  const resetUiState = useCallback((patch: Partial<State> = {}) => {
    requestSequenceRef.current += 1;
    publishInFlightRef.current = false;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
    patchState({ ...INITIAL_STATE, ...patch });
  }, []);

  const selectExistingFlow = useCallback(
    async (flow: ExistingFlow) => {
      const commandOwner = ownerKey;
      if (
        !mountedRef.current ||
        ownerKeyRef.current !== commandOwner ||
        !onSelectExistingFlow
      )
        return;
      const request = ++requestSequenceRef.current;
      patchState({
        selectingExistingFlowKey: getExistingFlowOptionKey(flow),
        existingFlowSelectionError: null,
      });
      try {
        await onSelectExistingFlow(flow);
      } catch (error) {
        if (
          ownerKeyRef.current !== commandOwner ||
          requestSequenceRef.current !== request
        )
          return;
        patchState({
          existingFlowSelectionError:
            error instanceof Error
              ? error.message
              : t("flowExistingLoadFailed"),
        });
      } finally {
        if (
          ownerKeyRef.current === commandOwner &&
          requestSequenceRef.current === request
        ) {
          patchState({ selectingExistingFlowKey: null });
        }
      }
    },
    [onSelectExistingFlow, ownerKey, ownerKeyRef, t]
  );

  const publish = useCallback(async () => {
    const commandOwner = ownerKey;
    if (
      !mountedRef.current ||
      ownerKeyRef.current !== commandOwner ||
      publishInFlightRef.current ||
      host?.publishing
    )
      return;
    if (!flowConfig || !workspaceId || flowConfig.providerReference) return;
    const sanitized = sanitizeWhatsAppFlowConfig(flowConfig) ?? flowConfig;
    if (JSON.stringify(sanitized) !== JSON.stringify(flowConfig))
      commitFlowConfig(sanitized);
    const validation = validateWhatsAppFlowConfig(sanitized);
    if (!validation.isValid) {
      patchState({
        saveState: "error",
        saveError: t("flowValidationFixBeforeSave"),
        saveIssueLines: validation.issues.map(issue =>
          formatFlowValidationIssue(issue, t)
        ),
      });
      return;
    }
    if (!host || !selectedSourceId || publishDisabledReason) {
      patchState({
        saveState: "error",
        saveError: publishDisabledReason || t("flowManagedScenarioRequired"),
        saveIssueLines: [],
      });
      return;
    }
    publishInFlightRef.current = true;
    const request = ++requestSequenceRef.current;
    patchState({ saveState: "saving", saveError: null, saveIssueLines: [] });
    try {
      const publication = await host.publish({
        sourceId: selectedSourceId,
        editableConfig: toEditableWhatsAppFlowConfig(sanitized),
      });
      if (
        ownerKeyRef.current !== commandOwner ||
        requestSequenceRef.current !== request
      )
        return;
      if (publication === null) {
        patchState({ saveState: "idle", saveError: null, saveIssueLines: [] });
        return;
      }
      const { response, adopted } = publication;
      const data = response.data;
      if (data?.operationId) onFlowArtifactsChanged?.();
      if (data?.projection && !adopted)
        throw failure(t("flowManagedStaleResult"));
      if (!response.ok || !data || !data.ok) {
        const issues: string[] = [];
        if (data) {
          for (const issue of data.validationErrors) {
            issues.push(
              issue.path ? `${issue.path}: ${issue.message}` : issue.message
            );
          }
          for (const phone of data.phones) {
            if (phone.stage !== "READY" || phone.signatureStatus !== "VALID") {
              issues.push(
                `${phone.phoneNumberId}: ${phone.stage}/${phone.signatureStatus}`
              );
            }
          }
        }
        throw failure(
          data && !data.ok ? data.error.message : t("flowPublishFailed"),
          issues
        );
      }
      if (
        data.status !== "COMPLETED" ||
        data.stage !== "COMPLETED" ||
        data.projection.providerStatus !== "PUBLISHED" ||
        !adopted
      ) {
        throw failure(t("flowPublishFailed"));
      }
      patchState({ saveState: "saved", saveError: null, saveIssueLines: [] });
      resetTimerRef.current = setTimeout(() => {
        if (
          ownerKeyRef.current === commandOwner &&
          requestSequenceRef.current === request
        ) {
          patchState({ saveState: "idle" });
          resetTimerRef.current = null;
        }
      }, 2000);
    } catch (error) {
      if (
        ownerKeyRef.current !== commandOwner ||
        requestSequenceRef.current !== request
      )
        return;
      const issues =
        error &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray((error as SaveFailure).issues)
          ? (error as SaveFailure).issues
          : [];
      patchState({
        saveState: "error",
        saveError: error instanceof Error ? error.message : t("flowSaveFailed"),
        saveIssueLines: issues,
      });
    } finally {
      if (
        ownerKeyRef.current === commandOwner &&
        requestSequenceRef.current === request
      ) {
        publishInFlightRef.current = false;
      }
    }
  }, [
    commitFlowConfig,
    flowConfig,
    host,
    onFlowArtifactsChanged,
    ownerKey,
    ownerKeyRef,
    publishDisabledReason,
    selectedSourceId,
    t,
    workspaceId,
  ]);

  return useMemo(
    () => ({
      ...state,
      publishing,
      sources,
      boundSourceId,
      selectedSourceId,
      publishDisabledReason,
      patchState,
      resetUiState,
      selectExistingFlow,
      publish,
    }),
    [
      boundSourceId,
      publish,
      publishDisabledReason,
      publishing,
      resetUiState,
      selectExistingFlow,
      selectedSourceId,
      sources,
      state,
    ]
  );
}
