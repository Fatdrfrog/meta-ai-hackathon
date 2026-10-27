"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

const useSafeLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useLatestRef<T>(value: T) {
  const ref = useRef(value);

  useSafeLayoutEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}
