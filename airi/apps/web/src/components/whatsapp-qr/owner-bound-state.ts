"use client";

import {
  useMemo,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";

type OwnerBoundStateStore<T> = {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
  setValue: Dispatch<SetStateAction<T>>;
};

function createOwnerBoundStateStore<T>(
  _ownerKey: string,
  initialValue: T
): OwnerBoundStateStore<T> {
  let value = initialValue;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setValue: nextValue => {
      const next =
        typeof nextValue === "function"
          ? (nextValue as (previous: T) => T)(value)
          : nextValue;
      if (Object.is(value, next)) return;
      value = next;
      listeners.forEach(listener => listener());
    },
  };
}

/**
 * Replaces the complete state store during render when ownership changes.
 * This keeps A -> B -> A transitions from exposing state owned by either
 * earlier visit while effects and request cancellation catch up.
 */
export function useOwnerBoundState<T>(
  ownerKey: string,
  createInitial: () => T
): [T, Dispatch<SetStateAction<T>>] {
  const store = useMemo(
    () => createOwnerBoundStateStore(ownerKey, createInitial()),
    [createInitial, ownerKey]
  );
  const value = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  return [value, store.setValue];
}
