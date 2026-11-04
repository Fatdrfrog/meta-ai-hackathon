"use client";

import type {
  ProductAdRecord,
  ProductAdSceneChange,
  ProductAdUpdateRequest,
  ProductsErrorCode,
} from "@/lib/products/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { fetchProductAd, updateProductAd } from "./ads-client";
import { wordsEdited } from "./product-ad-parts";
import { currentPictureIndex } from "./product-ad-scene-tools";
import { ProductDraftError, productAdUrl } from "./products-client";
import { usePolledSWR } from "./use-polled-swr";

/**
 * How often the studio asks for an ad while it's being made. SWR asks only
 * while the tab is visible, and stops once the ad is ready or failed, so a
 * finished video's link stays put while it plays.
 */
export const PRODUCT_AD_POLL_MS = 2000;

export const productAdPollInterval = (ad: ProductAdRecord | undefined) =>
  ad?.status === "making" ? PRODUCT_AD_POLL_MS : 0;

/**
 * One ad, kept current while it's being made: also when it's opened with
 * nothing cached, and when Try again or an edit answers with it making.
 */
export function useProductAd(workspaceId: string, adId: string) {
  return usePolledSWR<ProductAdRecord, ProductDraftError>(
    productAdUrl(workspaceId, adId),
    fetchProductAd,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    productAdPollInterval
  );
}

/** The time now, ticking once a second while `active`: the making clock. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// Below this the studio is one column with its main action in a bar kept at
// the bottom, as the CSS module lays it out.
const NARROW = "(max-width: 899px)";

const narrowNow = () =>
  typeof window !== "undefined" && window.matchMedia?.(NARROW).matches === true;

function subscribeNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(NARROW);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

/** Whether the studio is one column, with its main action at the bottom. */
export function useNarrowStudio(): boolean {
  return useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
}

// ---------------------------------------------------------------------------
// The workbench's free changes wait for the owner. The picture rails (a
// look, Wall, an opening or ending, another motion) queue a change, and the
// owner picks as many as they like; nothing is made until they press Update,
// when the merged change goes as ONE PATCH, a free render run (or rides
// along with a paid run: a new voice or a new place). One at a time: a press
// made while a run goes is sent when the run ends, and a 409 ad_not_ready (a
// run started elsewhere) keeps it waiting. Paid runs never start here.

/** How long a change refused with 409 ad_not_ready waits before it asks again. */
export const PRODUCT_AD_BUSY_RETRY_MS = 3000;

function mergeScene(
  base: ProductAdSceneChange | undefined,
  next: ProductAdSceneChange
): ProductAdSceneChange {
  const merged: ProductAdSceneChange = { ...(base ?? {}), ...next };
  // The exact photo shows instead of any kept picture, and a kept picture
  // picked again turns the exact photo off.
  if (next.useExact === true && next.pictureIndex === undefined)
    delete merged.pictureIndex;
  if (next.pictureIndex !== undefined) merged.useExact = false;
  return merged;
}

/** Two free changes as one: the later one wins, field by field and scene by scene. */
export function mergeAdChanges(
  base: ProductAdUpdateRequest | null,
  next: ProductAdUpdateRequest
): ProductAdUpdateRequest {
  const merged: ProductAdUpdateRequest = { ...(base ?? {}), ...next };
  if (base?.captions || next.captions) {
    const captions = new Map(
      (base?.captions ?? []).map(entry => [entry.productId, entry])
    );
    for (const entry of next.captions ?? [])
      captions.set(entry.productId, entry);
    merged.captions = [...captions.values()];
  }
  if (base?.scenes || next.scenes) {
    const scenes = new Map(
      (base?.scenes ?? []).map(entry => [entry.productId, entry])
    );
    for (const entry of next.scenes ?? [])
      scenes.set(
        entry.productId,
        mergeScene(scenes.get(entry.productId), entry)
      );
    merged.scenes = [...scenes.values()];
  }
  return merged;
}

/**
 * What of a free change the ad doesn't have yet: a field the video already
 * shows changes nothing, so it isn't sent (and an empty change isn't sent
 * at all). Null when nothing is left.
 */
export function effectiveAdChanges(
  ad: ProductAdRecord,
  changes: ProductAdUpdateRequest | null
): ProductAdUpdateRequest | null {
  if (!changes) return null;
  const out: ProductAdUpdateRequest = {};
  const script = ad.script;
  if (changes.motion !== undefined && changes.motion !== ad.motion)
    out.motion = changes.motion;
  if (script) {
    if (
      changes.sticker !== undefined &&
      wordsEdited(changes.sticker, script.sticker)
    )
      out.sticker = changes.sticker;
    if (
      changes.ending !== undefined &&
      wordsEdited(changes.ending, script.ending)
    )
      out.ending = changes.ending;
    if (
      changes.priceCardTitle !== undefined &&
      wordsEdited(changes.priceCardTitle, script.priceCardTitle)
    )
      out.priceCardTitle = changes.priceCardTitle;
    const captions = (changes.captions ?? []).filter(entry =>
      wordsEdited(
        entry.caption,
        script.captions.find(saved => saved.productId === entry.productId)
          ?.caption
      )
    );
    if (captions.length > 0) out.captions = captions;
  }
  const scenes = (changes.scenes ?? []).flatMap(change => {
    const scene = ad.scenes.find(entry => entry.productId === change.productId);
    if (!scene) return [];
    const left: ProductAdSceneChange = { productId: change.productId };
    if (change.textZone !== undefined && change.textZone !== scene.textZone)
      left.textZone = change.textZone;
    if (change.useExact !== undefined && change.useExact !== scene.useExact)
      left.useExact = change.useExact;
    if (
      change.pictureIndex !== undefined &&
      (change.pictureIndex !== currentPictureIndex(scene) || scene.useExact)
    )
      left.pictureIndex = change.pictureIndex;
    return Object.keys(left).length > 1 ? [left] : [];
  });
  if (scenes.length > 0) out.scenes = scenes;
  return Object.keys(out).length > 0 ? out : null;
}

/** The workbench's free changes, as they wait and go. */
export type ProductAdAutoUpdate = {
  /** Queued and not sent yet, as the ad doesn't have it; null when nothing waits. */
  pending: ProductAdUpdateRequest | null;
  /** Update was pressed: the PATCH is on its way, or waits for the run going to end. */
  sending: boolean;
  /** Why the last PATCH was refused (other than a run going); null otherwise. */
  problem: ProductsErrorCode | "failed" | null;
  /** Adds a free change, which waits for Update. */
  queue: (change: ProductAdUpdateRequest) => void;
  /** Update: sends what waits as one PATCH, now or when the run going ends. */
  send: () => void;
  /** Drops what waits ("Discard", "Back to video N"). */
  cancel: () => void;
  /** Takes what waits, for a paid run to carry (a new voice, "New place"); null when nothing. */
  take: () => ProductAdUpdateRequest | null;
};

/**
 * Single-flight free changes on one ad, sent when the owner presses Update.
 * `onAd` gets the PATCH's answer (the ad, its render run started);
 * `onStale` asks for the ad again when the server says a run is going that
 * the page doesn't know of yet.
 */
export function useAdAutoUpdate({
  workspaceId,
  ad,
  onAd,
  onStale,
  busyRetryMs = PRODUCT_AD_BUSY_RETRY_MS,
}: {
  workspaceId: string;
  ad: ProductAdRecord | undefined;
  onAd: (ad: ProductAdRecord) => void;
  onStale?: () => void;
  busyRetryMs?: number;
}): ProductAdAutoUpdate {
  const [pending, setPending] = useState<ProductAdUpdateRequest | null>(null);
  // Update was pressed for what waits; cleared once it's sent or refused.
  const [requested, setRequested] = useState(false);
  const [dueAt, setDueAt] = useState(0);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<ProductsErrorCode | "failed" | null>(
    null
  );
  const latest = useRef({ ad, pending, onAd, onStale });
  useEffect(() => {
    latest.current = { ad, pending, onAd, onStale };
  });

  const status = ad?.status;
  const adId = ad?.id;
  useEffect(() => {
    if (!requested || !pending || sending || !adId || status !== "ready")
      return;
    const timer = setTimeout(
      () => {
        const now = latest.current;
        if (!now.ad || now.ad.status !== "ready" || now.pending !== pending)
          return;
        const changes = effectiveAdChanges(now.ad, pending);
        if (!changes) {
          setPending(current => (current === pending ? null : current));
          setRequested(false);
          return;
        }
        setSending(true);
        setProblem(null);
        updateProductAd(workspaceId, now.ad.id, changes)
          .then(next => {
            // What was picked while it went waits for the next Update.
            setPending(current => (current === pending ? null : current));
            setRequested(false);
            latest.current.onAd(next);
          })
          .catch((error: unknown) => {
            const code =
              error instanceof ProductDraftError ? error.code : "failed";
            if (code === "ad_not_ready") {
              // A run is going that the page doesn't know of: it waits for
              // that run's end, and asks again meanwhile.
              latest.current.onStale?.();
              setDueAt(Date.now() + busyRetryMs);
              return;
            }
            // The picks stay, so Update can be pressed again or discarded.
            setRequested(false);
            setProblem(code);
          })
          .finally(() => setSending(false));
      },
      Math.max(0, dueAt - Date.now())
    );
    return () => clearTimeout(timer);
  }, [
    requested,
    pending,
    sending,
    adId,
    status,
    dueAt,
    workspaceId,
    busyRetryMs,
  ]);

  const queue = useCallback((change: ProductAdUpdateRequest) => {
    setPending(current => mergeAdChanges(current, change));
    // A pick after Update was pressed waits for the next press.
    setRequested(false);
    setProblem(null);
  }, []);
  const send = useCallback(() => {
    setRequested(true);
    setDueAt(0);
    setProblem(null);
  }, []);
  const cancel = useCallback(() => {
    setPending(null);
    setRequested(false);
    setProblem(null);
  }, []);
  const take = useCallback(() => {
    const now = latest.current;
    const changes = now.ad ? effectiveAdChanges(now.ad, now.pending) : null;
    setPending(null);
    setRequested(false);
    return changes;
  }, []);

  const effectivePending = useMemo(
    () => (ad ? effectiveAdChanges(ad, pending) : null),
    [ad, pending]
  );
  return {
    pending: effectivePending,
    sending: sending || (requested && effectivePending !== null),
    problem,
    queue,
    send,
    cancel,
    take,
  };
}

type UpdateRegistry = {
  workspaceId: string;
  states: ReadonlyMap<string, ProductAdAutoUpdate>;
  register: (adId: string) => () => void;
  queue: (adId: string, change: ProductAdUpdateRequest) => void;
  send: (adId: string) => void;
  cancel: (adId: string) => void;
  take: (adId: string) => ProductAdUpdateRequest | null;
};
const UpdateContext = createContext<UpdateRegistry | null>(null);

/**
 * Keep the existing update controller on the page, rather than inside a
 * tile that unmounts when its group changes. SWR still owns the ad and this
 * hook still owns the single-flight PATCH; no second queue implementation.
 * The registry lives only for this workspace page and is disposed with it.
 */
export function ProductAdAutoUpdateProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children?: ReactNode;
}) {
  return (
    <AdUpdateRegistry key={workspaceId} workspaceId={workspaceId}>
      {children}
    </AdUpdateRegistry>
  );
}

function AdUpdateRegistry({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children?: ReactNode;
}) {
  const [adIds, setAdIds] = useState<string[]>([]);
  const [states, setStates] = useState<
    ReadonlyMap<string, ProductAdAutoUpdate>
  >(() => new Map());
  const handles = useRef(new Map<string, ProductAdAutoUpdate>());
  const waiting = useRef(new Map<string, ProductAdUpdateRequest>());
  const readers = useRef(new Map<string, number>());
  const ensure = useCallback((adId: string) => {
    setAdIds(current =>
      current.includes(adId) ? current : [...current, adId]
    );
  }, []);
  const removeIdle = useCallback((adId: string) => {
    const handle = handles.current.get(adId);
    if (
      (readers.current.get(adId) ?? 0) > 0 ||
      waiting.current.has(adId) ||
      handle?.pending ||
      handle?.sending ||
      handle?.problem
    )
      return;
    handles.current.delete(adId);
    setAdIds(current => current.filter(id => id !== adId));
    setStates(current => {
      const next = new Map(current);
      next.delete(adId);
      return next;
    });
  }, []);
  const register = useCallback(
    (adId: string) => {
      readers.current.set(adId, (readers.current.get(adId) ?? 0) + 1);
      ensure(adId);
      return () => {
        const remaining = (readers.current.get(adId) ?? 1) - 1;
        if (remaining > 0) readers.current.set(adId, remaining);
        else readers.current.delete(adId);
        // The next tile may subscribe to the same ad during this commit.
        queueMicrotask(() => removeIdle(adId));
      };
    },
    [ensure, removeIdle]
  );
  const queue = useCallback(
    (adId: string, change: ProductAdUpdateRequest) => {
      const handle = handles.current.get(adId);
      if (handle) handle.queue(change);
      else {
        waiting.current.set(
          adId,
          mergeAdChanges(waiting.current.get(adId) ?? null, change)
        );
        ensure(adId);
      }
    },
    [ensure]
  );
  const send = useCallback((adId: string) => {
    handles.current.get(adId)?.send();
  }, []);
  const cancel = useCallback((adId: string) => {
    waiting.current.delete(adId);
    handles.current.get(adId)?.cancel();
  }, []);
  const take = useCallback((adId: string) => {
    const changes =
      handles.current.get(adId)?.take() ?? waiting.current.get(adId) ?? null;
    waiting.current.delete(adId);
    return changes;
  }, []);
  const changed = useCallback(
    (adId: string, next: ProductAdAutoUpdate) => {
      handles.current.set(adId, next);
      const queued = waiting.current.get(adId);
      if (queued) {
        waiting.current.delete(adId);
        next.queue(queued);
      }
      setStates(current => {
        const old = current.get(adId);
        if (
          old?.pending === next.pending &&
          old?.sending === next.sending &&
          old?.problem === next.problem
        )
          return current;
        return new Map(current).set(adId, next);
      });
      if (!queued) queueMicrotask(() => removeIdle(adId));
    },
    [removeIdle]
  );
  const value = useMemo(
    () => ({ workspaceId, states, register, queue, send, cancel, take }),
    [workspaceId, states, register, queue, send, cancel, take]
  );
  return (
    <UpdateContext.Provider value={value}>
      {children}
      {adIds.map(adId => (
        <AdUpdateController
          key={adId}
          workspaceId={workspaceId}
          adId={adId}
          changed={changed}
        />
      ))}
    </UpdateContext.Provider>
  );
}

function AdUpdateController({
  workspaceId,
  adId,
  changed,
}: {
  workspaceId: string;
  adId: string;
  changed: (adId: string, state: ProductAdAutoUpdate) => void;
}) {
  const { data: ad, mutate } = useProductAd(workspaceId, adId);
  const onAd = useCallback(
    (next: ProductAdRecord) => void mutate(next, { revalidate: false }),
    [mutate]
  );
  const onStale = useCallback(() => void mutate(), [mutate]);
  const state = useAdAutoUpdate({ workspaceId, ad, onAd, onStale });
  const { pending, sending, problem, queue, send, cancel, take } = state;
  useEffect(() => {
    changed(adId, { pending, sending, problem, queue, send, cancel, take });
  }, [adId, changed, pending, sending, problem, queue, send, cancel, take]);
  return null;
}

/** A tile's view of its page-owned controller; isolated workbenches keep their local owner. */
export function useSharedAdAutoUpdate(
  args: Parameters<typeof useAdAutoUpdate>[0]
): ProductAdAutoUpdate {
  const registry = useContext(UpdateContext);
  const shared = registry?.workspaceId === args.workspaceId ? registry : null;
  const fallback = useAdAutoUpdate({
    ...args,
    ad: shared ? undefined : args.ad,
  });
  const adId = args.ad?.id;
  const register = shared?.register;
  useEffect(() => {
    if (adId) return register?.(adId);
  }, [adId, register]);
  const queueShared = shared?.queue;
  const sendShared = shared?.send;
  const cancelShared = shared?.cancel;
  const takeShared = shared?.take;
  const queue = useCallback(
    (change: ProductAdUpdateRequest) => {
      if (adId) queueShared?.(adId, change);
    },
    [adId, queueShared]
  );
  const send = useCallback(() => {
    if (adId) sendShared?.(adId);
  }, [adId, sendShared]);
  const cancel = useCallback(() => {
    if (adId) cancelShared?.(adId);
  }, [adId, cancelShared]);
  const take = useCallback(
    () => (adId ? (takeShared?.(adId) ?? null) : null),
    [adId, takeShared]
  );
  if (!shared) return fallback;
  const state = adId ? shared.states.get(adId) : undefined;
  return {
    pending: state?.pending ?? null,
    sending: state?.sending ?? false,
    problem: state?.problem ?? null,
    queue,
    send,
    cancel,
    take,
  };
}
