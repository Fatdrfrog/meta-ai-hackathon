import { lazy, Suspense, type ComponentType } from "react";

// Vite hosts client components without Next's webpack loadable runtime.
// Keep real lazy components and their loading UI at this framework boundary.
export default function dynamic<T extends object>(
  load: () => Promise<ComponentType<T> | { default: ComponentType<T> }>,
  options: { loading?: ComponentType; ssr?: boolean } = {}
) {
  const Component = lazy(async () => {
    const result = await load();
    return {
      default:
        typeof result === "object" && "default" in result
          ? result.default
          : (result as ComponentType<T>),
    };
  });
  const Loading = options.loading;
  return function BrowserDynamic(props: T) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <Component {...props} />
      </Suspense>
    );
  };
}
