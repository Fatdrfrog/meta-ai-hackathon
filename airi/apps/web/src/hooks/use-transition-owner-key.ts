"use client";

/**
 * This hook persists a transition counter in a ref and derives its return value
 * from it during render. That read is deliberate and safe here (see the doc on
 * the export), so the ref-access rule is disabled for this single-purpose file.
 */
/* eslint-disable react-hooks/refs */
import { useRef } from "react";

type TransitionOwner = {
  valueKey: string;
  revision: number;
};

/**
 * Gives every committed transition a distinct owner, including A -> B -> A.
 * Async work can compare the returned key to reject callbacks from an older
 * visit whose plain value key happens to match again.
 *
 * The owner lives in a ref, so a new transition bumps the revision without a
 * render-phase state update. A state update during render re-runs the render
 * and, while async data settles the value key, can chain with the reset
 * effects into the loop React aborts with "Maximum update depth exceeded".
 *
 * The returned key is derived only from `valueKey` and the persisted revision,
 * so the component still re-renders whenever the key must change. Reading the
 * ref during render is safe here and intentional.
 */
export function useTransitionOwnerKey(valueKey: string): string {
  const ownerRef = useRef<TransitionOwner>({ valueKey, revision: 0 });
  const previous = ownerRef.current;
  const owner =
    previous.valueKey === valueKey
      ? previous
      : { valueKey, revision: previous.revision + 1 };
  ownerRef.current = owner;
  return `${owner.revision}\u0000${valueKey}`;
}
