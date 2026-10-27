"use client";

import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";

import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  createWhatsAppQrDraft,
  downloadWhatsAppQrArtwork,
  fetchWhatsAppQrEntryPoint,
  fetchWhatsAppQrProviderCodes,
  inspectWhatsAppQrImage,
  inspectWhatsAppQrUrl,
  newWhatsAppQrIdempotencyKey,
  patchWhatsAppQrEntryPoint,
  postWhatsAppQrAssignmentCommand,
  postWhatsAppQrCommand,
  unwrapWhatsAppQrClientResult,
  WhatsAppQrClientError,
  type WhatsAppQrCodeDetail,
  type WhatsAppQrEntryPointDetail,
} from "@/lib/whatsapp/qr-entry-points/client";

import { useOwnerBoundState } from "./owner-bound-state";
import type {
  UseWhatsAppQrEntryPointParams,
  WhatsAppQrEntryPointController,
  WhatsAppQrMutationOptions,
  WhatsAppQrPendingOperationKey,
} from "./types";

const PROVIDER_PAGE_LIMIT = 50;
const PROVIDER_CURSOR_HISTORY_LIMIT = 20;
const PLACEMENT_NAME_MAX_LENGTH = 120;

type ControllerState = Pick<
  WhatsAppQrEntryPointController,
  | "detail"
  | "detailLoading"
  | "detailError"
  | "detailErrorStatus"
  | "commandBusy"
  | "pendingOperationKey"
  | "commandError"
  | "statusMessage"
  | "providerCodes"
  | "providerCodesLoading"
  | "providerCodesError"
> & {
  providerSourceId: string | null;
  providerCursor: string | null;
  providerNextCursor: string | null;
  providerCursorHistory: Array<string | null>;
};

type DraftPayload = {
  placementName: string;
  desiredMessage?: string | null;
};

type ControllerStatusKey =
  | "draftSaved"
  | "codeCreated"
  | "codeConnected"
  | "messageUpdated"
  | "replacementCreated"
  | "routingEnabled"
  | "routingDisabled"
  | "codeDeleted"
  | "entryPointRecovered"
  | "providerChecked"
  | "providerReconciled"
  | "pngDownloaded"
  | "svgDownloaded";

type DraftAttempt = {
  ownerKey: string;
  entryPointId: string;
  payload: DraftPayload;
  ambiguous: boolean;
};

const createInitialControllerState = (
  detailLoading = false
): ControllerState => ({
  detail: null,
  detailLoading,
  detailError: null,
  detailErrorStatus: null,
  commandBusy: false,
  pendingOperationKey: null,
  commandError: null,
  statusMessage: null,
  providerCodes: [],
  providerCodesLoading: false,
  providerCodesError: null,
  providerSourceId: null,
  providerCursor: null,
  providerNextCursor: null,
  providerCursorHistory: [],
});

function isAmbiguousCreateError(error: unknown): boolean {
  return (
    error instanceof WhatsAppQrClientError &&
    (error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500)
  );
}

function normalizePlacementName(value: string, invalidMessage: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > PLACEMENT_NAME_MAX_LENGTH) {
    throw new Error(invalidMessage);
  }
  return normalized;
}

function normalizeDraftMessage(
  value: string | null | undefined,
  tooLongMessage: string
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH) {
    throw new Error(tooLongMessage);
  }
  return normalized;
}

function normalizeRequiredMessage(
  value: string,
  messages: { required: string; tooLong: string }
): string {
  const normalized = normalizeDraftMessage(value, messages.tooLong);
  if (!normalized) throw new Error(messages.required);
  return normalized;
}

function normalizeRequiredString(
  value: string,
  requiredMessage: string
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(requiredMessage);
  return normalized;
}

function sameDraftPayload(left: DraftPayload, right: DraftPayload): boolean {
  return (
    left.placementName === right.placementName &&
    left.desiredMessage === right.desiredMessage
  );
}

function findDetailCode(
  detail: WhatsAppQrEntryPointDetail,
  codeId: string
): WhatsAppQrCodeDetail | null {
  if (detail.currentCode?.codeId === codeId) return detail.currentCode;
  return detail.historicalCodes.find(code => code.codeId === codeId) ?? null;
}

function throwClientResult<T>(
  result: Awaited<ReturnType<typeof fetchWhatsAppQrEntryPoint>>
): T {
  return unwrapWhatsAppQrClientResult(result) as T;
}

export function useWhatsAppQrEntryPoint({
  workspaceId,
  entryPointId,
  ownerKey: embeddedOwnerKey,
  draftCreator,
  onEntryPointCreated,
  onMutationSettled,
}: UseWhatsAppQrEntryPointParams): WhatsAppQrEntryPointController {
  const t = useTranslations("WhatsAppQr");
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedEntryPointId = entryPointId?.trim() || null;
  const ownerKey = useTransitionOwnerKey(
    `${normalizedWorkspaceId}\u0000${normalizedEntryPointId ?? ""}\u0000${embeddedOwnerKey ?? ""}`
  );
  const createInitialState = useCallback(
    () =>
      createInitialControllerState(
        Boolean(normalizedWorkspaceId && normalizedEntryPointId)
      ),
    [normalizedEntryPointId, normalizedWorkspaceId]
  );
  const [state, setState] = useOwnerBoundState(ownerKey, createInitialState);

  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;

  const detailRef = useRef<{
    ownerKey: string;
    value: WhatsAppQrEntryPointDetail | null;
  }>({ ownerKey, value: null });
  if (detailRef.current.ownerKey !== ownerKey) {
    detailRef.current = { ownerKey, value: null };
  }

  const draftAttemptRef = useRef<DraftAttempt | null>(null);
  if (draftAttemptRef.current?.ownerKey !== ownerKey) {
    draftAttemptRef.current = null;
  }

  const commandGuardRef = useRef<{
    ownerKey: string;
    token: object | null;
    operationKey: string | null;
    promise: Promise<boolean> | null;
  }>({ ownerKey, token: null, operationKey: null, promise: null });
  if (commandGuardRef.current.ownerKey !== ownerKey) {
    commandGuardRef.current = {
      ownerKey,
      token: null,
      operationKey: null,
      promise: null,
    };
  }

  const detailRequestRef = useRef(0);
  const providerRequestRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const providerAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);

  const patchState = useCallback(
    (
      expectedOwner: string,
      patch:
        | Partial<ControllerState>
        | ((current: ControllerState) => Partial<ControllerState>)
    ): boolean => {
      if (ownerKeyRef.current !== expectedOwner) return false;
      setState(current => ({
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      }));
      return true;
    },
    [setState]
  );

  const commitDetail = useCallback(
    (
      expectedOwner: string,
      detail: WhatsAppQrEntryPointDetail | null
    ): boolean => {
      if (ownerKeyRef.current !== expectedOwner) return false;
      detailRef.current = { ownerKey: expectedOwner, value: detail };
      setState(current => ({ ...current, detail }));
      return true;
    },
    [setState]
  );

  const assertCurrentOwner = useCallback(
    (expectedOwner: string) => {
      if (ownerKeyRef.current !== expectedOwner) {
        throw new Error(t("controller.errors.ownerChanged"));
      }
    },
    [t]
  );

  const resolveErrorMessage = useCallback(
    (error: unknown): string => {
      if (error instanceof WhatsAppQrClientError) {
        const diagnostic = (() => {
          switch (error.code) {
            case "WHATSAPP_QR_INDEX_MIGRATION_REQUIRED":
              return t("controller.errors.indexMigrationRequired");
            case "RECONCILE_REQUIRED":
              return t("controller.errors.providerDriftDetected");
            case "PROVIDER_CHECK_UNAVAILABLE":
              return t("controller.errors.providerCheckUnavailable");
            case "PROVIDER_FAILED":
              return t("controller.errors.providerRequestFailed");
            case "OPERATION_BUSY":
              return t("controller.errors.operationBusy");
            case "VERSION_CONFLICT":
            case "OPERATION_CONFLICT":
              return t("controller.errors.stateChanged");
            default:
              return (
                error.message.trim() || t("controller.errors.requestFailed")
              );
          }
        })();
        return error.operationId
          ? t("controller.errors.withOperationId", {
              message: diagnostic,
              operationId: error.operationId,
            })
          : diagnostic;
      }
      if (error instanceof Error && error.message.trim()) return error.message;
      return t("controller.errors.requestFailed");
    },
    [t]
  );

  const readOwnedDetail = useCallback(() => {
    return detailRef.current.ownerKey === ownerKeyRef.current
      ? detailRef.current.value
      : null;
  }, []);

  const loadDetailById = useCallback(
    async (
      requestedEntryPointId: string,
      expectedOwner = ownerKey
    ): Promise<WhatsAppQrEntryPointDetail | null> => {
      const requestId = ++detailRequestRef.current;
      detailAbortRef.current?.abort();
      const abortController = new AbortController();
      detailAbortRef.current = abortController;
      patchState(expectedOwner, {
        detailLoading: true,
        detailError: null,
        detailErrorStatus: null,
      });

      try {
        const result = await fetchWhatsAppQrEntryPoint({
          workspaceId: normalizedWorkspaceId,
          entryPointId: requestedEntryPointId,
          signal: abortController.signal,
        });
        if (
          abortController.signal.aborted ||
          requestId !== detailRequestRef.current ||
          ownerKeyRef.current !== expectedOwner
        ) {
          return null;
        }
        const next = unwrapWhatsAppQrClientResult(result);
        commitDetail(expectedOwner, next);
        return next;
      } catch (error) {
        if (
          abortController.signal.aborted ||
          requestId !== detailRequestRef.current ||
          ownerKeyRef.current !== expectedOwner
        ) {
          return null;
        }
        const committedDetail =
          detailRef.current.ownerKey === expectedOwner
            ? detailRef.current.value
            : null;
        const canRetainCommittedDetail =
          committedDetail?.entryPoint.entryPointId === requestedEntryPointId &&
          !(error instanceof WhatsAppQrClientError && error.status === 404);
        if (!canRetainCommittedDetail) {
          commitDetail(expectedOwner, null);
        }
        patchState(expectedOwner, {
          detailError: resolveErrorMessage(error),
          detailErrorStatus:
            error instanceof WhatsAppQrClientError ? error.status : null,
        });
        return null;
      } finally {
        if (
          requestId === detailRequestRef.current &&
          ownerKeyRef.current === expectedOwner
        ) {
          patchState(expectedOwner, { detailLoading: false });
        }
      }
    },
    [
      commitDetail,
      normalizedWorkspaceId,
      ownerKey,
      patchState,
      resolveErrorMessage,
    ]
  );

  useEffect(() => {
    if (!normalizedWorkspaceId || !normalizedEntryPointId) {
      detailAbortRef.current?.abort();
      commitDetail(ownerKey, null);
      patchState(ownerKey, {
        detailLoading: false,
        detailError: null,
        detailErrorStatus: null,
      });
      return;
    }
    void loadDetailById(normalizedEntryPointId, ownerKey);
  }, [
    commitDetail,
    loadDetailById,
    normalizedEntryPointId,
    normalizedWorkspaceId,
    ownerKey,
    patchState,
  ]);

  useEffect(() => {
    return () => {
      detailAbortRef.current?.abort();
      providerAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
    };
  }, [ownerKey]);

  const settleMutation = useCallback(
    async (expectedOwner: string) => {
      if (ownerKeyRef.current !== expectedOwner) return;
      const currentId =
        readOwnedDetail()?.entryPoint.entryPointId ||
        normalizedEntryPointId ||
        (draftAttemptRef.current?.ownerKey === expectedOwner
          ? draftAttemptRef.current.entryPointId
          : null);
      if (currentId) {
        await Promise.allSettled([loadDetailById(currentId, expectedOwner)]);
      }
    },
    [loadDetailById, normalizedEntryPointId, readOwnedDetail]
  );

  const notifyMutationSettled = useCallback(() => {
    if (!onMutationSettled) return;
    void Promise.resolve()
      .then(() => onMutationSettled())
      .catch(() => undefined);
  }, [onMutationSettled]);

  const runMutation = useCallback(
    (
      action: (signal: AbortSignal, expectedOwner: string) => Promise<void>,
      successStatus: ControllerStatusKey,
      options: {
        operationKey: WhatsAppQrPendingOperationKey;
        refresh?: boolean;
      }
    ): Promise<boolean> => {
      const expectedOwner = ownerKey;
      const inFlight = commandGuardRef.current;
      if (inFlight.ownerKey === expectedOwner && inFlight.promise) {
        return inFlight.operationKey === options.operationKey
          ? inFlight.promise
          : Promise.resolve(false);
      }

      mutationAbortRef.current?.abort();
      const abortController = new AbortController();
      mutationAbortRef.current = abortController;
      patchState(expectedOwner, {
        commandBusy: true,
        pendingOperationKey: options.operationKey,
        commandError: null,
        statusMessage: null,
      });

      const mutationToken = {};
      const promise = (async () => {
        let notifyHost = false;
        try {
          await action(abortController.signal, expectedOwner);
          assertCurrentOwner(expectedOwner);
          if (options.refresh !== false) await settleMutation(expectedOwner);
          if (ownerKeyRef.current !== expectedOwner) return false;
          patchState(expectedOwner, {
            statusMessage: t(`controller.status.${successStatus}`),
          });
          notifyHost = options.refresh !== false;
          return true;
        } catch (error) {
          if (
            abortController.signal.aborted ||
            ownerKeyRef.current !== expectedOwner
          ) {
            return false;
          }
          patchState(expectedOwner, {
            commandError: resolveErrorMessage(error),
          });
          if (
            error instanceof WhatsAppQrClientError &&
            error.code === "RECONCILE_REQUIRED"
          ) {
            await settleMutation(expectedOwner);
            notifyHost = true;
          }
          return false;
        } finally {
          if (
            commandGuardRef.current.ownerKey === expectedOwner &&
            commandGuardRef.current.token === mutationToken
          ) {
            commandGuardRef.current.token = null;
            commandGuardRef.current.operationKey = null;
            commandGuardRef.current.promise = null;
            patchState(expectedOwner, {
              commandBusy: false,
              pendingOperationKey: null,
            });
            if (notifyHost) notifyMutationSettled();
          }
        }
      })();
      commandGuardRef.current = {
        ownerKey: expectedOwner,
        token: mutationToken,
        operationKey: options.operationKey,
        promise,
      };
      return promise;
    },
    [
      assertCurrentOwner,
      ownerKey,
      patchState,
      resolveErrorMessage,
      settleMutation,
      t,
      notifyMutationSettled,
    ]
  );

  const patchDraftDetail = useCallback(
    async (
      current: WhatsAppQrEntryPointDetail,
      payload: DraftPayload,
      signal: AbortSignal,
      expectedOwner: string
    ): Promise<WhatsAppQrEntryPointDetail> => {
      const placementChanged =
        current.entryPoint.placementName !== payload.placementName;
      const desiredMessageChanged =
        payload.desiredMessage !== undefined &&
        current.entryPoint.desiredMessage !==
          (payload.desiredMessage === null
            ? undefined
            : payload.desiredMessage);
      const canPatchDesiredMessage = current.entryPoint.status === "DRAFT";
      if (
        !placementChanged &&
        !(canPatchDesiredMessage && desiredMessageChanged)
      ) {
        return current;
      }

      const patched = unwrapWhatsAppQrClientResult(
        await patchWhatsAppQrEntryPoint({
          workspaceId: normalizedWorkspaceId,
          entryPointId: current.entryPoint.entryPointId,
          expectedVersion: current.entryPoint.version,
          ...(placementChanged ? { placementName: payload.placementName } : {}),
          ...(canPatchDesiredMessage && desiredMessageChanged
            ? { desiredMessage: payload.desiredMessage }
            : {}),
          signal,
        })
      );
      assertCurrentOwner(expectedOwner);
      commitDetail(expectedOwner, patched);
      return patched;
    },
    [assertCurrentOwner, commitDetail, normalizedWorkspaceId]
  );

  const createDraftForAttempt = useCallback(
    async (
      attempt: DraftAttempt,
      payload: DraftPayload,
      signal: AbortSignal,
      expectedOwner: string
    ): Promise<WhatsAppQrEntryPointDetail> => {
      try {
        const created = draftCreator
          ? await draftCreator({
              workspaceId: normalizedWorkspaceId,
              entryPointId: attempt.entryPointId,
              placementName: payload.placementName,
              ...(typeof payload.desiredMessage === "string"
                ? { desiredMessage: payload.desiredMessage }
                : {}),
              signal,
            })
          : unwrapWhatsAppQrClientResult(
              await createWhatsAppQrDraft({
                workspaceId: normalizedWorkspaceId,
                entryPointId: attempt.entryPointId,
                placementName: payload.placementName,
                ...(typeof payload.desiredMessage === "string"
                  ? { desiredMessage: payload.desiredMessage }
                  : {}),
                signal,
              })
            );
        assertCurrentOwner(expectedOwner);
        attempt.ambiguous = false;
        attempt.payload = payload;
        commitDetail(expectedOwner, created);
        onEntryPointCreated?.(created.entryPoint.entryPointId);
        return created;
      } catch (error) {
        if (draftAttemptRef.current === attempt) {
          attempt.ambiguous = isAmbiguousCreateError(error);
          attempt.payload = payload;
        }
        throw error;
      }
    },
    [
      assertCurrentOwner,
      commitDetail,
      draftCreator,
      normalizedWorkspaceId,
      onEntryPointCreated,
    ]
  );

  const resolveDraft = useCallback(
    async (
      input: { placementName: string; desiredMessage?: string | null },
      signal: AbortSignal,
      expectedOwner: string
    ): Promise<WhatsAppQrEntryPointDetail> => {
      const desiredMessage = normalizeDraftMessage(
        input.desiredMessage,
        t("form.errors.maxCharacters", {
          maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
        })
      );
      const payload: DraftPayload = {
        placementName: normalizePlacementName(
          input.placementName,
          t("controller.errors.placementNameLength", {
            maximum: PLACEMENT_NAME_MAX_LENGTH,
          })
        ),
        ...(desiredMessage === undefined ? {} : { desiredMessage }),
      };
      const current = readOwnedDetail();
      if (current) {
        return patchDraftDetail(current, payload, signal, expectedOwner);
      }
      if (normalizedEntryPointId) {
        throw new Error(t("controller.errors.entryPointNotLoaded"));
      }

      let attempt = draftAttemptRef.current;
      if (!attempt || attempt.ownerKey !== expectedOwner) {
        attempt = {
          ownerKey: expectedOwner,
          entryPointId: newWhatsAppQrIdempotencyKey(),
          payload,
          ambiguous: false,
        };
        draftAttemptRef.current = attempt;
      }

      if (attempt.ambiguous && !sameDraftPayload(attempt.payload, payload)) {
        if (draftCreator) {
          const recovered = await createDraftForAttempt(
            attempt,
            attempt.payload,
            signal,
            expectedOwner
          );
          return patchDraftDetail(recovered, payload, signal, expectedOwner);
        }

        const probe = await fetchWhatsAppQrEntryPoint({
          workspaceId: normalizedWorkspaceId,
          entryPointId: attempt.entryPointId,
          signal,
        });
        assertCurrentOwner(expectedOwner);
        if (probe.ok) {
          commitDetail(expectedOwner, probe.data);
          attempt.ambiguous = false;
          onEntryPointCreated?.(probe.data.entryPoint.entryPointId);
          return patchDraftDetail(probe.data, payload, signal, expectedOwner);
        }
        if (probe.status !== 404) {
          throwClientResult<WhatsAppQrEntryPointDetail>(probe);
        }

        attempt = {
          ownerKey: expectedOwner,
          entryPointId: newWhatsAppQrIdempotencyKey(),
          payload,
          ambiguous: false,
        };
        draftAttemptRef.current = attempt;
      }

      return createDraftForAttempt(attempt, payload, signal, expectedOwner);
    },
    [
      assertCurrentOwner,
      commitDetail,
      createDraftForAttempt,
      draftCreator,
      normalizedEntryPointId,
      normalizedWorkspaceId,
      onEntryPointCreated,
      patchDraftDetail,
      readOwnedDetail,
      t,
    ]
  );

  const saveDraft = useCallback(
    async (
      input: {
        placementName: string;
        desiredMessage?: string | null;
      },
      options?: WhatsAppQrMutationOptions
    ) => {
      return runMutation(
        async (signal, expectedOwner) => {
          await resolveDraft(input, signal, expectedOwner);
        },
        "draftSaved",
        { operationKey: options?.operationKey ?? "save-draft" }
      );
    },
    [resolveDraft, runMutation]
  );

  const createCode = useCallback(
    async (input: {
      sourceId: string;
      placementName: string;
      desiredMessage: string;
    }) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const sourceId = normalizeRequiredString(
            input.sourceId,
            t("form.errors.chooseSource")
          );
          const desiredMessage = normalizeRequiredMessage(
            input.desiredMessage,
            {
              required: t("form.errors.enterDesiredMessage"),
              tooLong: t("form.errors.maxCharacters", {
                maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
              }),
            }
          );
          const current = await resolveDraft(
            {
              placementName: input.placementName,
              desiredMessage,
            },
            signal,
            expectedOwner
          );
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "create",
                workspaceId: normalizedWorkspaceId,
                sourceId,
                entryPointId: current.entryPoint.entryPointId,
                desiredMessage,
                expectedEntryPointVersion: current.entryPoint.version,
              },
            })
          );
        },
        "codeCreated",
        { operationKey: "create-code" }
      );
    },
    [normalizedWorkspaceId, resolveDraft, runMutation, t]
  );

  const connectProviderCode = useCallback(
    async (input: {
      sourceId: string;
      providerCode: string;
      placementName: string;
      desiredMessage: string;
    }) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const sourceId = normalizeRequiredString(
            input.sourceId,
            t("form.errors.chooseSource")
          );
          const providerCode = normalizeRequiredString(
            input.providerCode,
            t("dialog.errors.chooseProviderCode")
          );
          const desiredMessage = normalizeRequiredMessage(
            input.desiredMessage,
            {
              required: t("form.errors.enterDesiredMessage"),
              tooLong: t("form.errors.maxCharacters", {
                maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
              }),
            }
          );
          const current = await resolveDraft(
            { placementName: input.placementName, desiredMessage },
            signal,
            expectedOwner
          );
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "connect",
                workspaceId: normalizedWorkspaceId,
                sourceId,
                entryPointId: current.entryPoint.entryPointId,
                providerCode,
                desiredMessage,
                expectedEntryPointVersion: current.entryPoint.version,
              },
            })
          );
        },
        "codeConnected",
        { operationKey: "connect-provider-code" }
      );
    },
    [normalizedWorkspaceId, resolveDraft, runMutation, t]
  );

  const connectInspected = useCallback(
    async (params: {
      sourceId: string;
      placementName: string;
      desiredMessage: string;
      operationKey: Extract<
        WhatsAppQrPendingOperationKey,
        "connect-from-url" | "connect-from-image"
      >;
      inspect: (signal: AbortSignal) => ReturnType<typeof inspectWhatsAppQrUrl>;
    }) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const sourceId = normalizeRequiredString(
            params.sourceId,
            t("form.errors.chooseSource")
          );
          const desiredMessage = normalizeRequiredMessage(
            params.desiredMessage,
            {
              required: t("form.errors.enterDesiredMessage"),
              tooLong: t("form.errors.maxCharacters", {
                maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
              }),
            }
          );
          const current = await resolveDraft(
            { placementName: params.placementName, desiredMessage },
            signal,
            expectedOwner
          );
          const inspected = await params.inspect(signal);
          assertCurrentOwner(expectedOwner);
          if (inspected.intent.kind === "provider") {
            const providerCode = normalizeRequiredString(
              inspected.intent.providerCode || "",
              t("dialog.errors.chooseProviderCode")
            );
            unwrapWhatsAppQrClientResult(
              await postWhatsAppQrCommand({
                idempotencyKey: newWhatsAppQrIdempotencyKey(),
                signal,
                body: {
                  command: "connect",
                  workspaceId: normalizedWorkspaceId,
                  sourceId,
                  entryPointId: current.entryPoint.entryPointId,
                  providerCode,
                  desiredMessage,
                  expectedEntryPointVersion: current.entryPoint.version,
                },
              })
            );
            return;
          }
          const inspectedMessage = normalizeRequiredMessage(
            inspected.intent.desiredMessage || desiredMessage,
            {
              required: t("form.errors.enterDesiredMessage"),
              tooLong: t("form.errors.maxCharacters", {
                maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
              }),
            }
          );
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "create",
                workspaceId: normalizedWorkspaceId,
                sourceId,
                entryPointId: current.entryPoint.entryPointId,
                desiredMessage: inspectedMessage,
                expectedEntryPointVersion: current.entryPoint.version,
              },
            })
          );
        },
        "codeConnected",
        { operationKey: params.operationKey }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, resolveDraft, runMutation, t]
  );

  const connectFromUrl = useCallback(
    async (input: {
      sourceId: string;
      url: string;
      placementName: string;
      desiredMessage: string;
    }) => {
      const url = normalizeRequiredString(
        input.url,
        t("dialog.errors.enterLink")
      );
      return connectInspected({
        ...input,
        operationKey: "connect-from-url",
        inspect: signal =>
          inspectWhatsAppQrUrl({
            workspaceId: normalizedWorkspaceId,
            sourceId: input.sourceId,
            url,
            signal,
          }),
      });
    },
    [connectInspected, normalizedWorkspaceId, t]
  );

  const connectFromImage = useCallback(
    async (input: {
      sourceId: string;
      file: File;
      placementName: string;
      desiredMessage: string;
    }) => {
      if (!input.file) return false;
      return connectInspected({
        sourceId: input.sourceId,
        placementName: input.placementName,
        desiredMessage: input.desiredMessage,
        operationKey: "connect-from-image",
        inspect: signal =>
          inspectWhatsAppQrImage({
            workspaceId: normalizedWorkspaceId,
            sourceId: input.sourceId,
            file: input.file,
            signal,
          }),
      });
    },
    [connectInspected, normalizedWorkspaceId]
  );

  const applyMessage = useCallback(
    async (message: string, options?: WhatsAppQrMutationOptions) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const detail = readOwnedDetail();
          if (!detail?.currentCode || !detail.entryPoint.sourceId) {
            throw new Error(t("controller.errors.currentCodeUnavailable"));
          }
          const desiredMessage = normalizeRequiredMessage(message, {
            required: t("form.errors.enterDesiredMessage"),
            tooLong: t("form.errors.maxCharacters", {
              maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
            }),
          });
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "apply_message",
                workspaceId: normalizedWorkspaceId,
                sourceId: detail.entryPoint.sourceId,
                entryPointId: detail.entryPoint.entryPointId,
                desiredMessage,
                expectedEntryPointVersion: detail.entryPoint.version,
                expectedCodeVersion: detail.currentCode.version,
              },
            })
          );
          assertCurrentOwner(expectedOwner);
        },
        "messageUpdated",
        { operationKey: options?.operationKey ?? "apply-message" }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, readOwnedDetail, runMutation, t]
  );

  const createReplacement = useCallback(
    async (message: string) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const detail = readOwnedDetail();
          if (!detail?.currentCode || !detail.entryPoint.sourceId) {
            throw new Error(t("controller.errors.currentCodeUnavailable"));
          }
          const desiredMessage = normalizeRequiredMessage(message, {
            required: t("form.errors.enterDesiredMessage"),
            tooLong: t("form.errors.maxCharacters", {
              maximum: WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
            }),
          });
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "replace",
                workspaceId: normalizedWorkspaceId,
                sourceId: detail.entryPoint.sourceId,
                entryPointId: detail.entryPoint.entryPointId,
                desiredMessage,
                expectedEntryPointVersion: detail.entryPoint.version,
                expectedCodeVersion: detail.currentCode.version,
              },
            })
          );
          assertCurrentOwner(expectedOwner);
        },
        "replacementCreated",
        {
          operationKey: "create-replacement",
        }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, readOwnedDetail, runMutation, t]
  );

  const setRouting = useCallback(
    async (codeId: string, routingState: "ENABLED" | "DISABLED") => {
      return runMutation(
        async (signal, expectedOwner) => {
          const detail = readOwnedDetail();
          if (!detail?.entryPoint.sourceId) {
            throw new Error(t("controller.errors.sourceUnavailable"));
          }
          const code = findDetailCode(detail, codeId);
          if (!code) {
            throw new Error(t("controller.errors.codeVersionUnavailable"));
          }
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "set_routing",
                workspaceId: normalizedWorkspaceId,
                sourceId: detail.entryPoint.sourceId,
                entryPointId: detail.entryPoint.entryPointId,
                codeId: code.codeId,
                routingState,
                expectedEntryPointVersion: detail.entryPoint.version,
                expectedCodeVersion: code.version,
              },
            })
          );
          assertCurrentOwner(expectedOwner);
        },
        routingState === "ENABLED" ? "routingEnabled" : "routingDisabled",
        {
          operationKey: `set-routing:${codeId}:${routingState}`,
        }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, readOwnedDetail, runMutation, t]
  );

  const deleteFromMeta = useCallback(
    async (codeId: string) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const detail = readOwnedDetail();
          if (!detail?.entryPoint.sourceId) {
            throw new Error(t("controller.errors.sourceUnavailable"));
          }
          const code = findDetailCode(detail, codeId);
          if (!code) {
            throw new Error(t("controller.errors.codeVersionUnavailable"));
          }
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "delete",
                workspaceId: normalizedWorkspaceId,
                sourceId: detail.entryPoint.sourceId,
                entryPointId: detail.entryPoint.entryPointId,
                codeId: code.codeId,
                confirmed: true,
                expectedEntryPointVersion: detail.entryPoint.version,
                expectedCodeVersion: code.version,
              },
            })
          );
          assertCurrentOwner(expectedOwner);
        },
        "codeDeleted",
        {
          operationKey: `delete:${codeId}`,
        }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, readOwnedDetail, runMutation, t]
  );

  const recoverDetached = useCallback(async () => {
    return runMutation(
      async (signal, expectedOwner) => {
        const detail = readOwnedDetail();
        if (!detail) {
          throw new Error(t("controller.errors.entryPointUnavailable"));
        }
        unwrapWhatsAppQrClientResult(
          await postWhatsAppQrAssignmentCommand({
            signal,
            body: {
              command: "recover",
              workspaceId: normalizedWorkspaceId,
              entryPointId: detail.entryPoint.entryPointId,
              expectedEntryPointVersion: detail.entryPoint.version,
            },
          })
        );
        assertCurrentOwner(expectedOwner);
      },
      "entryPointRecovered",
      { operationKey: "recover-detached" }
    );
  }, [
    assertCurrentOwner,
    normalizedWorkspaceId,
    readOwnedDetail,
    runMutation,
    t,
  ]);

  const checkProvider = useCallback(async () => {
    return runMutation(
      async (signal, expectedOwner) => {
        const detail = readOwnedDetail();
        if (!detail?.currentCode || !detail.entryPoint.sourceId) {
          throw new Error(t("controller.errors.currentCodeUnavailable"));
        }
        unwrapWhatsAppQrClientResult(
          await postWhatsAppQrCommand({
            idempotencyKey: newWhatsAppQrIdempotencyKey(),
            signal,
            body: {
              command: "check_provider",
              workspaceId: normalizedWorkspaceId,
              sourceId: detail.entryPoint.sourceId,
              entryPointId: detail.entryPoint.entryPointId,
              expectedEntryPointVersion: detail.entryPoint.version,
              expectedCodeVersion: detail.currentCode.version,
            },
          })
        );
        assertCurrentOwner(expectedOwner);
      },
      "providerChecked",
      { operationKey: "check-provider" }
    );
  }, [
    assertCurrentOwner,
    normalizedWorkspaceId,
    readOwnedDetail,
    runMutation,
    t,
  ]);

  const reconcileOperation = useCallback(
    async (operationId: string) => {
      return runMutation(
        async (signal, expectedOwner) => {
          const detail = readOwnedDetail();
          const operation = detail?.reconcileOperation;
          const normalizedOperationId = operationId.trim();
          if (
            !detail ||
            !operation ||
            !normalizedOperationId ||
            operation.operationId !== normalizedOperationId
          ) {
            throw new Error(t("controller.errors.reconciliationUnavailable"));
          }
          unwrapWhatsAppQrClientResult(
            await postWhatsAppQrCommand({
              idempotencyKey: newWhatsAppQrIdempotencyKey(),
              signal,
              body: {
                command: "reconcile",
                workspaceId: normalizedWorkspaceId,
                sourceId: operation.sourceId,
                entryPointId: detail.entryPoint.entryPointId,
                operationId: normalizedOperationId,
              },
            })
          );
          assertCurrentOwner(expectedOwner);
        },
        "providerReconciled",
        {
          operationKey: `reconcile:${operationId.trim()}`,
        }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, readOwnedDetail, runMutation, t]
  );

  const downloadArtwork = useCallback(
    async (format: "png" | "svg") => {
      return runMutation(
        async (signal, expectedOwner) => {
          const detail = readOwnedDetail();
          if (!detail?.currentCode) {
            throw new Error(t("controller.errors.artworkUnavailable"));
          }
          const artwork = unwrapWhatsAppQrClientResult(
            await downloadWhatsAppQrArtwork({
              workspaceId: normalizedWorkspaceId,
              codeId: detail.currentCode.codeId,
              format,
              signal,
            })
          );
          assertCurrentOwner(expectedOwner);
          try {
            const anchor = document.createElement("a");
            anchor.href = artwork.objectUrl;
            anchor.download = `whatsapp-qr-${detail.currentCode.codeId}.${format}`;
            anchor.rel = "noopener";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          } finally {
            URL.revokeObjectURL(artwork.objectUrl);
          }
        },
        format === "png" ? "pngDownloaded" : "svgDownloaded",
        { operationKey: `download:${format}`, refresh: false }
      );
    },
    [assertCurrentOwner, normalizedWorkspaceId, readOwnedDetail, runMutation, t]
  );

  const copyLink = useCallback(async () => {
    const expectedOwner = ownerKey;
    const deepLink = readOwnedDetail()?.currentCode?.deepLink;
    if (!deepLink) return false;
    try {
      await navigator.clipboard.writeText(deepLink);
      return patchState(expectedOwner, {
        commandError: null,
        statusMessage: t("card.linkCopied"),
      });
    } catch {
      patchState(expectedOwner, { commandError: t("card.copyFailed") });
      return false;
    }
  }, [ownerKey, patchState, readOwnedDetail, t]);

  const testLink = useCallback(() => {
    const deepLink = readOwnedDetail()?.currentCode?.deepLink;
    if (!deepLink) return;
    window.open(deepLink, "_blank", "noopener,noreferrer");
  }, [readOwnedDetail]);

  const requestProviderPage = useCallback(
    async (params: {
      sourceId: string;
      cursor: string | null;
      history: Array<string | null>;
    }) => {
      const expectedOwner = ownerKey;
      const retainCommittedPage =
        state.providerSourceId === params.sourceId &&
        state.providerCodes.length > 0;
      const requestId = ++providerRequestRef.current;
      providerAbortRef.current?.abort();
      const abortController = new AbortController();
      providerAbortRef.current = abortController;
      patchState(expectedOwner, {
        providerCodes: retainCommittedPage ? state.providerCodes : [],
        providerCodesLoading: true,
        providerCodesError: null,
        providerSourceId: params.sourceId,
        ...(retainCommittedPage
          ? {}
          : {
              providerCursor: params.cursor,
              providerNextCursor: null,
              providerCursorHistory: params.history.slice(
                -PROVIDER_CURSOR_HISTORY_LIMIT
              ),
            }),
      });

      try {
        const page = unwrapWhatsAppQrClientResult(
          await fetchWhatsAppQrProviderCodes({
            workspaceId: normalizedWorkspaceId,
            sourceId: params.sourceId,
            limit: PROVIDER_PAGE_LIMIT,
            ...(params.cursor ? { cursor: params.cursor } : {}),
            signal: abortController.signal,
          })
        );
        if (
          abortController.signal.aborted ||
          requestId !== providerRequestRef.current ||
          ownerKeyRef.current !== expectedOwner
        ) {
          return;
        }
        patchState(expectedOwner, {
          providerCodes: page.codes,
          providerCodesLoading: false,
          providerCodesError: null,
          providerSourceId: params.sourceId,
          providerCursor: params.cursor,
          providerNextCursor: page.nextCursor || null,
          providerCursorHistory: params.history.slice(
            -PROVIDER_CURSOR_HISTORY_LIMIT
          ),
        });
      } catch (error) {
        if (
          abortController.signal.aborted ||
          requestId !== providerRequestRef.current ||
          ownerKeyRef.current !== expectedOwner
        ) {
          return;
        }
        patchState(expectedOwner, {
          ...(retainCommittedPage ? {} : { providerCodes: [] }),
          providerCodesLoading: false,
          providerCodesError: resolveErrorMessage(error),
          ...(retainCommittedPage ? {} : { providerNextCursor: null }),
        });
      }
    },
    [
      normalizedWorkspaceId,
      ownerKey,
      patchState,
      resolveErrorMessage,
      state.providerCodes,
      state.providerSourceId,
    ]
  );

  const loadProviderCodes = useCallback(
    async (sourceId: string) => {
      const normalizedSourceId = normalizeRequiredString(
        sourceId,
        t("form.errors.chooseSource")
      );
      await requestProviderPage({
        sourceId: normalizedSourceId,
        cursor: null,
        history: [],
      });
    },
    [requestProviderPage, t]
  );

  const goToPreviousProviderCodesPage = useCallback(async () => {
    if (!state.providerSourceId || state.providerCursorHistory.length === 0)
      return;
    const history = state.providerCursorHistory.slice(0, -1);
    const cursor = state.providerCursorHistory.at(-1) ?? null;
    await requestProviderPage({
      sourceId: state.providerSourceId,
      cursor,
      history,
    });
  }, [
    requestProviderPage,
    state.providerCursorHistory,
    state.providerSourceId,
  ]);

  const goToNextProviderCodesPage = useCallback(async () => {
    if (!state.providerSourceId || !state.providerNextCursor) return;
    const history = [
      ...state.providerCursorHistory,
      state.providerCursor,
    ].slice(-PROVIDER_CURSOR_HISTORY_LIMIT);
    await requestProviderPage({
      sourceId: state.providerSourceId,
      cursor: state.providerNextCursor,
      history,
    });
  }, [
    requestProviderPage,
    state.providerCursor,
    state.providerCursorHistory,
    state.providerNextCursor,
    state.providerSourceId,
  ]);

  const retryDetail = useCallback(() => {
    const requestedEntryPointId =
      normalizedEntryPointId || readOwnedDetail()?.entryPoint.entryPointId;
    if (requestedEntryPointId) {
      void loadDetailById(requestedEntryPointId, ownerKey);
    }
  }, [loadDetailById, normalizedEntryPointId, ownerKey, readOwnedDetail]);

  return {
    detail: state.detail,
    detailLoading: state.detailLoading,
    detailError: state.detailError,
    detailErrorStatus: state.detailErrorStatus,
    commandBusy: state.commandBusy,
    pendingOperationKey: state.pendingOperationKey,
    commandError: state.commandError,
    statusMessage: state.statusMessage,
    providerCodes: state.providerCodes,
    providerCodesLoading: state.providerCodesLoading,
    providerCodesError: state.providerCodesError,
    providerCodesCanGoPrevious: state.providerCursorHistory.length > 0,
    providerCodesCanGoNext: Boolean(state.providerNextCursor),
    retryDetail,
    loadProviderCodes,
    goToPreviousProviderCodesPage,
    goToNextProviderCodesPage,
    saveDraft,
    createCode,
    connectProviderCode,
    connectFromUrl,
    connectFromImage,
    applyMessage,
    createReplacement,
    setRouting,
    deleteFromMeta,
    recoverDetached,
    checkProvider,
    reconcileOperation,
    downloadArtwork,
    copyLink,
    testLink,
  };
}
