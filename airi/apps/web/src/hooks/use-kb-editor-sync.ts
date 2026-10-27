"use client";

import { type SaveStatus } from "@/components/kb/save-status-badge";
import { atom, type WritableAtom, useSetAtom } from "jotai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

type WritableStateAtom<T> = WritableAtom<T, [SetStateAction<T>], void>;

interface KBEditorSyncOptions {
  isPublishingAtom: WritableStateAtom<boolean>;
  saveStatusAtom: WritableStateAtom<SaveStatus>;
  publishHandlerAtom: WritableStateAtom<(() => Promise<void>) | null>;
  activeIdAtom?: WritableStateAtom<string | null>;
  activeTitleAtom?: WritableStateAtom<string>;
}

const noopActiveIdAtom = atom<
  string | null,
  [SetStateAction<string | null>],
  void
>(null, () => {});
const noopActiveTitleAtom = atom<string, [SetStateAction<string>], void>(
  "",
  () => {}
);

export function useKBEditorSync({
  isPublishingAtom,
  saveStatusAtom,
  publishHandlerAtom,
  activeIdAtom,
  activeTitleAtom,
}: KBEditorSyncOptions) {
  const setActiveId = useSetAtom(activeIdAtom ?? noopActiveIdAtom);
  const setActiveTitle = useSetAtom(activeTitleAtom ?? noopActiveTitleAtom);
  const setIsPublishing = useSetAtom(isPublishingAtom);
  const setSaveStatus = useSetAtom(saveStatusAtom);
  const setPublishHandler = useSetAtom(publishHandlerAtom);

  const operationTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const isPublishQueuedOrRunningRef = useRef(false);
  const mountTimeRef = useRef(Date.now());
  const publishTriggeredByUserRef = useRef(false);

  // Sync mount time
  useEffect(() => {
    mountTimeRef.current = Date.now();
    publishTriggeredByUserRef.current = false;
    return () => {
      publishTriggeredByUserRef.current = false;
    };
  }, []);

  /**
   * Performs an async action (like save or publish) with safety locks and status management.
   */
  const performSafeAction = useCallback(
    async <T>(
      action: () => Promise<T>,
      options?: { isPublish?: boolean; isSilent?: boolean }
    ): Promise<T | null> => {
      const isPublish = options?.isPublish === true;

      // If it's a publish action, verify it was user-initiated and not a stale call
      if (isPublish) {
        if (isPublishQueuedOrRunningRef.current) {
          toast.message("Publish skipped", {
            description:
              "Another publish is already running. Wait for it to finish and try again.",
          });
          publishTriggeredByUserRef.current = false;
          return null;
        }

        const timeSinceMount = Date.now() - mountTimeRef.current;
        if (timeSinceMount < 1000) {
          console.warn(
            `[KB Editor] Publish called too soon after mount (${timeSinceMount}ms) - ignoring.`
          );
          publishTriggeredByUserRef.current = false;
          toast.message("Publish skipped", {
            description:
              "The editor is still loading. Wait a second and try again.",
          });
          return null;
        }

        if (!publishTriggeredByUserRef.current) {
          console.warn(
            "[KB Editor] Publish called without user action - ignoring"
          );
          toast.message("Publish skipped", {
            description:
              "Use the Publish button again. If this keeps happening, refresh the page.",
          });
          return null;
        }

        publishTriggeredByUserRef.current = false;
        isPublishQueuedOrRunningRef.current = true;
      }

      const runAction = async (): Promise<T> => {
        if (isPublish) {
          setIsPublishing(true);
        } else if (!options?.isSilent) {
          setSaveStatus("saving");
        }

        try {
          return await action();
        } finally {
          if (isPublish) {
            setIsPublishing(false);
            isPublishQueuedOrRunningRef.current = false;
          }
        }
      };

      const queuedAction = operationTailRef.current
        .catch(() => undefined)
        .then(runAction);
      operationTailRef.current = queuedAction.catch(() => undefined);

      return queuedAction;
    },
    [setIsPublishing, setSaveStatus]
  );

  /**
   * Registers a stable publish handler in Jotai that UI components (like Header) can call.
   */
  const registerPublishHandler = useCallback(
    (handler: () => Promise<void>) => {
      // Create a stable wrapper that marks the trigger as user-initiated
      const userInitiatedHandler = async () => {
        publishTriggeredByUserRef.current = true;
        await handler();
      };

      setPublishHandler(() => userInitiatedHandler);
    },
    [setPublishHandler]
  );

  return useMemo(
    () => ({
      performSafeAction,
      registerPublishHandler,
      setIsPublishing,
      setSaveStatus,
      setActiveId: activeIdAtom ? setActiveId : undefined,
      setActiveTitle: activeTitleAtom ? setActiveTitle : undefined,

      // Constants/Metadata
      mountTime: mountTimeRef.current,
    }),
    [
      setIsPublishing,
      setSaveStatus,
      activeIdAtom,
      setActiveId,
      activeTitleAtom,
      setActiveTitle,
      performSafeAction,
      registerPublishHandler,
    ]
  );
}
