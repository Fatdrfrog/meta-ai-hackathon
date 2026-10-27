"use client";

import { fetchScenarioById } from "@/lib/scenarios/client";
import type { ScenarioDetail } from "@/lib/scenarios/client/scenario-detail-sources";
import {
  collectPendingScenarioMedia,
  takeSignedScenarioMedia,
  type PendingScenarioMedia,
  type SignedScenarioMedia,
} from "@/lib/scenarios/client/scenario-media-display";
import { useCallback, useEffect, useRef } from "react";
import { useLatestRef } from "./use-latest-ref";

/**
 * Waits before each follow-up read while media signing is still pending.
 * Cold Media API starts took 7 to 10 s, so the reads span about 20 s.
 */
export const SCENARIO_MEDIA_DISPLAY_RETRY_DELAYS_MS = [
  1500, 3000, 6000, 10_000,
] as const;

type MediaDisplayRefreshRun = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
};

type MediaDisplayRefreshRequest = {
  ownerKey: string;
  workspaceId: string;
  scenarioId: string;
  detail: ScenarioDetail;
};

/** False when the loaded session is gone, which ends the reads. */
type AdoptSignedMedia = (
  ownerKey: string,
  signed: SignedScenarioMedia
) => boolean;

type HeldSignedMedia = { ownerKey: string; byNodeId: SignedScenarioMedia };

/**
 * Signed media for steps with a media upload or voice generation running.
 * Their media fields and upload callbacks still work from the loaded value,
 * so a changed url there would drop or undo the result.
 */
function useHeldSignedMedia(adoptSignedMediaRef: {
  readonly current: AdoptSignedMedia;
}) {
  const busyNodesRef = useRef(new Map<string, number>());
  const heldRef = useRef<HeldSignedMedia | null>(null);

  /** Adopts what no running operation needs, and holds back the rest. */
  const adoptOrHold = useCallback(
    (ownerKey: string, signed: SignedScenarioMedia): boolean => {
      const ready: SignedScenarioMedia = new Map();
      for (const [nodeId, media] of signed) {
        if (!busyNodesRef.current.has(nodeId)) {
          ready.set(nodeId, media);
          continue;
        }
        if (heldRef.current?.ownerKey !== ownerKey) {
          heldRef.current = { ownerKey, byNodeId: new Map() };
        }
        const held = heldRef.current.byNodeId.get(nodeId);
        heldRef.current.byNodeId.set(
          nodeId,
          new Map([...(held ?? []), ...media])
        );
      }
      return ready.size === 0 || adoptSignedMediaRef.current(ownerKey, ready);
    },
    [adoptSignedMediaRef]
  );

  const release = useCallback(
    (nodeId: string) => {
      const held = heldRef.current;
      const media = held?.byNodeId.get(nodeId);
      if (!held || !media || busyNodesRef.current.has(nodeId)) return;
      held.byNodeId.delete(nodeId);
      adoptSignedMediaRef.current(held.ownerKey, new Map([[nodeId, media]]));
    },
    [adoptSignedMediaRef]
  );

  const trackNodeMediaOperation = useCallback(
    <T>(nodeId: string, operation: Promise<T>): Promise<T> => {
      const busy = busyNodesRef.current;
      busy.set(nodeId, (busy.get(nodeId) ?? 0) + 1);
      return operation.finally(() => {
        const left = (busy.get(nodeId) ?? 1) - 1;
        if (left > 0) {
          busy.set(nodeId, left);
          return;
        }
        busy.delete(nodeId);
        // After the caller has applied the result, which usually replaces
        // the durable value this was holding back.
        setTimeout(() => release(nodeId), 0);
      });
    },
    [release]
  );

  const forget = useCallback(() => {
    heldRef.current = null;
  }, []);

  return { adoptOrHold, trackNodeMediaOperation, forget };
}

/**
 * Reads the scenario again while its detail said media signing was still
 * pending, and hands each newly signed display URL to `adoptSignedMedia`
 * (for a step with a media operation running, once that has finished).
 * A new start, a scenario switch or unmount stops the reads.
 */
export function useScenarioMediaDisplayRefresh({
  sessionOwnerKey,
  adoptSignedMedia,
}: {
  sessionOwnerKey: string;
  adoptSignedMedia: AdoptSignedMedia;
}) {
  const runRef = useRef<MediaDisplayRefreshRun | null>(null);
  const adoptSignedMediaRef = useLatestRef(adoptSignedMedia);
  const { adoptOrHold, trackNodeMediaOperation, forget } =
    useHeldSignedMedia(adoptSignedMediaRef);

  const stop = useCallback(() => {
    forget();
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    run.controller.abort();
    if (run.timer) clearTimeout(run.timer);
  }, [forget]);

  const readAgain = useCallback(
    async (
      run: MediaDisplayRefreshRun,
      request: MediaDisplayRefreshRequest,
      pending: PendingScenarioMedia
    ): Promise<boolean> => {
      try {
        const latest = await fetchScenarioById({
          workspaceId: request.workspaceId,
          scenarioId: request.scenarioId,
          signal: run.controller.signal,
          mediaSigning: "deferred",
        });
        if (
          runRef.current !== run ||
          latest?.scenario._id !== request.scenarioId
        )
          return false;
        const signed = takeSignedScenarioMedia(
          pending,
          latest.scenario.nodes,
          latest.scenario.updatedAt ?? null
        );
        if (signed.size > 0 && !adoptOrHold(request.ownerKey, signed))
          return false;
        return (
          latest.metadata.mediaDisplayUrlsPending === true &&
          pending.byNodeId.size > 0
        );
      } catch {
        // A failed read tries again later, unless the reads were stopped.
        return runRef.current === run;
      }
    },
    [adoptOrHold]
  );

  const start = useCallback(
    (request: MediaDisplayRefreshRequest) => {
      stop();
      const { detail } = request;
      if (detail.metadata.mediaDisplayUrlsPending !== true) return;
      const pending = collectPendingScenarioMedia(
        detail.scenario.nodes,
        detail.scenario.updatedAt ?? null
      );
      if (pending.byNodeId.size === 0) return;
      const run: MediaDisplayRefreshRun = {
        controller: new AbortController(),
        timer: null,
      };
      runRef.current = run;
      const schedule = (attempt: number) => {
        const delay = SCENARIO_MEDIA_DISPLAY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || runRef.current !== run) {
          if (runRef.current === run) runRef.current = null;
          return;
        }
        run.timer = setTimeout(() => {
          run.timer = null;
          void readAgain(run, request, pending).then(again => {
            if (again) schedule(attempt + 1);
            else if (runRef.current === run) runRef.current = null;
          });
        }, delay);
      };
      schedule(0);
    },
    [readAgain, stop]
  );

  // A different scenario visit, or leaving the editor, ends the reads.
  useEffect(() => stop, [sessionOwnerKey, stop]);

  return { start, stop, trackNodeMediaOperation };
}
