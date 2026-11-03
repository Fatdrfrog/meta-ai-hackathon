/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { useProductSelection } from "./use-product-selection";

const product = (
  id: string,
  overrides: {
    imageUrl?: string | null;
    hasCutout?: boolean;
    price?: number | null;
  } = {}
) => ({
  id,
  name: `Product ${id}`,
  price: 100,
  currency: "KZT",
  priceIsFrom: false,
  imageUrl: `https://storage.test/${id}.webp`,
  hasCutout: true,
  updatedAt: null,
  ...overrides,
});

const SHELF = [
  product("a"),
  product("b"),
  product("c", { price: null }),
  product("d"),
  product("e", { imageUrl: null, hasCutout: false }),
  // No clear view: its photo is the whole frame, not a cut-out.
  product("f", { hasCutout: false }),
];

test("starts and stops choosing, forgetting the choice", () => {
  const { result } = renderHook(() => useProductSelection(SHELF));
  expect(result.current.choosing).toBe(false);

  act(() => result.current.start(["b"]));
  expect(result.current.choosing).toBe(true);
  expect(result.current.chosenIds).toEqual(["b"]);

  act(() => result.current.stop());
  expect(result.current.choosing).toBe(false);
  expect(result.current.chosenIds).toEqual([]);
});

test("gives the chosen products in shelf order, whatever order they were chosen in", () => {
  const { result } = renderHook(() => useProductSelection(SHELF));
  act(() => result.current.start());
  act(() => result.current.toggle("d"));
  act(() => result.current.toggle("a"));
  expect(result.current.chosenIds).toEqual(["a", "d"]);
  act(() => result.current.toggle("d"));
  expect(result.current.chosenIds).toEqual(["a"]);
  act(() => result.current.clear());
  expect(result.current.chosenIds).toEqual([]);
  expect(result.current.choosing).toBe(true);
});

test("keeps a chosen product that isn't on the shelf yet, and gives it once it is", () => {
  const { result, rerender } = renderHook(
    ({ products }) => useProductSelection(products),
    { initialProps: { products: SHELF.slice(0, 2) } }
  );
  act(() => result.current.start(["a", "d"]));
  expect(result.current.chosenIds).toEqual(["a"]);
  rerender({ products: SHELF });
  expect(result.current.chosenIds).toEqual(["a", "d"]);
});

test("a video ad takes 1 to 3 products, each with a photo and a price", () => {
  const { result } = renderHook(() => useProductSelection(SHELF));
  act(() => result.current.start());
  expect(result.current.adReady).toBe(false);
  act(() => result.current.start(["a"]));
  expect(result.current.adReady).toBe(true);
  act(() => result.current.start(["a", "b", "d"]));
  expect(result.current.adReady).toBe(true);
  act(() => result.current.start(["a", "b", "d", SHELF[0]!.id]));
  // The same product twice is one.
  expect(result.current.adReady).toBe(true);
  act(() => result.current.start(["a", "b", "c"]));
  expect(result.current.adReady).toBe(false);
  act(() => result.current.start(["e"]));
  expect(result.current.adReady).toBe(false);
  act(() => result.current.start(["a", "b", "d", "e"]));
  expect(result.current.adReady).toBe(false);
  // A photo of the whole frame is shown on the shelf, but the ad's brief
  // refuses it (no_photo): it isn't offered.
  act(() => result.current.start(["a", "f"]));
  expect(result.current.adReady).toBe(false);
});
