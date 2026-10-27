"use client";

import { useCallback, useEffect, useRef } from "react";

type DeferredBranchSyncOptions<T> = {
  value: T;
  onChange: (next: T) => void;
  onBranchOptionsChanged?: (next: T) => void;
};

type CommitOptions = {
  syncBranches?: boolean;
  markBranchDirty?: boolean;
};

export function useDeferredBranchSync<T>({
  value,
  onChange,
  onBranchOptionsChanged,
}: DeferredBranchSyncOptions<T>) {
  const latestValueRef = useRef(value);
  const branchDirtyRef = useRef(false);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const commitValue = useCallback(
    (next: T, options: CommitOptions = {}) => {
      latestValueRef.current = next;
      onChange(next);

      if (options.syncBranches !== false) {
        branchDirtyRef.current = false;
        onBranchOptionsChanged?.(next);
        return;
      }

      if (options.markBranchDirty !== false) {
        branchDirtyRef.current = true;
      }
    },
    [onBranchOptionsChanged, onChange]
  );

  const syncDirtyBranches = useCallback(() => {
    if (!branchDirtyRef.current) {
      return;
    }

    branchDirtyRef.current = false;
    onBranchOptionsChanged?.(latestValueRef.current);
  }, [onBranchOptionsChanged]);

  return { commitValue, syncDirtyBranches };
}
