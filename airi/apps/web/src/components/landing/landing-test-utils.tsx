/* eslint-disable @next/next/no-img-element -- DOM image fixture. */
import type { ImgHTMLAttributes } from "react";

// Module doubles for the landing section suites. Use them inside the suite's
// jest.mock factories, for example:
//   jest.mock("next/image", () =>
//     jest.requireActual("./landing-test-utils").nextImageMock()
//   );

/** next/image as a plain <img>, dropping the layout-only props. */
export function nextImageMock() {
  return {
    __esModule: true,
    default: ({
      fill: _fill,
      priority: _priority,
      ...props
    }: ImgHTMLAttributes<HTMLImageElement> & {
      fill?: boolean;
      priority?: boolean;
    }) => <img {...props} alt={props.alt ?? ""} />,
  };
}

/**
 * useTranslations over a real message catalog: the namespace and key are
 * dotted paths, and each {name} is replaced once by its value.
 */
export function catalogTranslations(messages: Record<string, unknown>) {
  return (namespace: string) => {
    const root = namespace
      .split(".")
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        messages
      );
    return (key: string, values?: Record<string, string>) => {
      const result = key
        .split(".")
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part],
          root
        );
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace("{" + name + "}", value),
        String(result)
      );
    };
  };
}
