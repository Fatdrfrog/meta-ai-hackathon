"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

/**
 * A Link that prefetches once the user shows intent (hover, focus or touch)
 * instead of as soon as it is visible. Opening the panel sidebar otherwise
 * prefetches every section at once, and each prefetch pays the proxy's auth
 * checks. `prefetch={false}` still turns prefetching off entirely.
 */
export function IntentPrefetchLink({
  prefetch,
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...props
}: ComponentProps<typeof Link>) {
  const [hasIntent, setHasIntent] = useState(false);
  const markIntent = () => setHasIntent(true);
  const intentPrefetch = hasIntent ? (prefetch ?? null) : false;

  return (
    <Link
      {...props}
      prefetch={prefetch === false ? false : intentPrefetch}
      onMouseEnter={event => {
        onMouseEnter?.(event);
        markIntent();
      }}
      onFocus={event => {
        onFocus?.(event);
        markIntent();
      }}
      onTouchStart={event => {
        onTouchStart?.(event);
        markIntent();
      }}
    />
  );
}
