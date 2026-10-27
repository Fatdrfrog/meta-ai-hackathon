"use client";

import { useState } from "react";

type ItemKeys<T> = {
  items: readonly T[];
  keys: readonly string[];
  /** Keys are never reused within a list, so a new row never takes an old row's state. */
  nextKey: number;
};

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, position) => item === right[position])
  );
}

function createItemKeys<T>(items: readonly T[]): ItemKeys<T> {
  return {
    items,
    keys: items.map((_, position) => String(position)),
    nextKey: items.length,
  };
}

/**
 * Carries row keys over to the next list. An item that is still in the list
 * keeps its key wherever it moved, an edited item takes the key of the row it
 * replaced, and any other item gets a new key.
 */
function reconcileItemKeys<T>(
  previous: ItemKeys<T>,
  items: readonly T[]
): ItemKeys<T> {
  const keysByItem = new Map<T, string[]>();
  previous.items.forEach((item, position) => {
    const key = previous.keys[position];
    if (key === undefined) return;
    keysByItem.set(item, [...(keysByItem.get(item) ?? []), key]);
  });
  const kept = items.map(item => keysByItem.get(item)?.shift());
  const used = new Set(kept.filter(key => key !== undefined));
  let nextKey = previous.nextKey;
  const keys = kept.map((key, position) => {
    if (key !== undefined) return key;
    const replaced = previous.keys[position];
    if (replaced !== undefined && !used.has(replaced)) {
      used.add(replaced);
      return replaced;
    }
    nextKey += 1;
    return String(nextKey - 1);
  });
  return { items, keys, nextKey };
}

/**
 * React keys for the rows of a list whose items have no id, without adding
 * one to saved data. Edits replace an item object, removals keep the others,
 * so rows keep their inputs and focus when an earlier row is removed. Pass
 * the same item objects between renders; a list rebuilt from new objects keys
 * its rows by position.
 */
export function useStableItemKeys<T>(items: readonly T[]): readonly string[] {
  const [state, setState] = useState(() => createItemKeys(items));
  if (sameItems(state.items, items)) return state.keys;
  const next = reconcileItemKeys(state, items);
  setState(next);
  return next.keys;
}
