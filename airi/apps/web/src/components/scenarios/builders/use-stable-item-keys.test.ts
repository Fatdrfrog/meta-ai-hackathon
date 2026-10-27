/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";

import { useStableItemKeys } from "./use-stable-item-keys";

type Item = { title: string };

function renderKeys(initial: readonly Item[]) {
  return renderHook(({ items }) => useStableItemKeys(items), {
    initialProps: { items: initial },
  });
}

describe("useStableItemKeys", () => {
  const a = { title: "A" };
  const b = { title: "B" };
  const c = { title: "C" };

  it("keeps the keys of the rows that stay when an earlier row is removed", () => {
    const { result, rerender } = renderKeys([a, b, c]);
    const [, keyB, keyC] = result.current;

    rerender({ items: [b, c] });
    expect(result.current).toEqual([keyB, keyC]);
  });

  it("keeps a row's key while its item is edited", () => {
    const { result, rerender } = renderKeys([a, b]);
    const before = result.current;

    rerender({ items: [a, { ...b, title: "B!" }] });
    expect(result.current).toEqual(before);
  });

  it("gives an added row a key no earlier row had", () => {
    const { result, rerender } = renderKeys([a, b]);
    const [keyA, keyB] = result.current;

    rerender({ items: [a] });
    rerender({ items: [a, c] });
    expect(result.current[0]).toBe(keyA);
    expect(result.current[1]).not.toBe(keyA);
    expect(result.current[1]).not.toBe(keyB);
  });

  it("keys a list rebuilt from new items by position", () => {
    const { result, rerender } = renderKeys([a, b]);
    const before = result.current;

    rerender({ items: [{ ...a }, { ...b }] });
    expect(result.current).toEqual(before);
  });

  it("keeps the keys when the same items come in a new array", () => {
    const { result, rerender } = renderKeys([a, b]);
    const before = result.current;

    rerender({ items: [a, b] });
    expect(result.current).toBe(before);
  });

  it("gives repeated items distinct keys", () => {
    const { result, rerender } = renderKeys([a, a]);
    expect(new Set(result.current).size).toBe(2);

    rerender({ items: [a, a, b] });
    expect(new Set(result.current).size).toBe(3);
  });
});
