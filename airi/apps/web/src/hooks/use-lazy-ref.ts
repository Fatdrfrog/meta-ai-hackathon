"use client";

import { useRef, type RefObject } from "react";

export function useLazyRef<T>(createValue: () => T): RefObject<T> {
  const ref = useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = createValue();
  }
  return ref as RefObject<T>;
}
