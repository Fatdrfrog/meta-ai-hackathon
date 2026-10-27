"use client";

import { useCallback, useState, type SetStateAction } from "react";

type DraftState<T> = {
  committed: T;
  draft: T;
};

export function useSyncedDraftValue<T>(committed: T, sync = true) {
  const [state, setState] = useState<DraftState<T>>(() => ({
    committed,
    draft: committed,
  }));

  let draft = state.draft;
  if (sync && !Object.is(state.committed, committed)) {
    draft = committed;
    setState({ committed, draft });
  }

  const setDraft = useCallback(
    (nextDraft: SetStateAction<T>) => {
      setState(current => {
        const currentDraft =
          sync && !Object.is(current.committed, committed)
            ? committed
            : current.draft;
        return {
          committed,
          draft:
            typeof nextDraft === "function"
              ? (nextDraft as (value: T) => T)(currentDraft)
              : nextDraft,
        };
      });
    },
    [committed, sync]
  );

  return [draft, setDraft] as const;
}
