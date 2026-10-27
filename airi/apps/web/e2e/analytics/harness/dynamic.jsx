import { Suspense, lazy } from "react";

// Client-only stand-in for next/dynamic: the harness never server-renders.
export default function dynamic(loader, options = {}) {
  const Lazy = lazy(() =>
    loader().then(module => ({ default: module.default ?? module }))
  );
  return function DynamicComponent(props) {
    return (
      <Suspense fallback={options.loading ? options.loading() : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
