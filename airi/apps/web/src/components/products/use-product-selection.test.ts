/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { PRODUCT_PICKS_MAX } from "@/lib/products/templates";
import {
  canGoInAd,
  cleanPicks,
  picksIn,
  useProductSelection,
} from "./use-product-selection";

const id = (n: number) => `651f1f77bcf86cd7994390${String(n).padStart(2, "0")}`;

const product = (
  n: number,
  overrides: {
    imageUrl?: string | null;
    hasCutout?: boolean;
    price?: number | null;
  } = {}
) => ({
  id: id(n),
  name: `Product ${n}`,
  price: 100,
  currency: "KZT",
  priceIsFrom: false,
  imageUrl: `https://storage.test/${n}.webp`,
  hasCutout: true,
  updatedAt: null,
  ...overrides,
});

const SHELF = [product(1), product(2), product(3), product(4)];

test("picks in tap order, numbered from 1, and a second tap lets one go", () => {
  const { result } = renderHook(() => useProductSelection(SHELF));
  expect(result.current.picks).toEqual([]);

  act(() => result.current.toggle(id(3)));
  act(() => result.current.toggle(id(1)));
  act(() => result.current.toggle(id(4)));
  expect(result.current.picks).toEqual([id(3), id(1), id(4)]);
  expect(result.current.picked.map(entry => entry.id)).toEqual([
    id(3),
    id(1),
    id(4),
  ]);
  expect(result.current.numbers.get(id(3))).toBe(1);
  expect(result.current.numbers.get(id(4))).toBe(3);

  act(() => result.current.toggle(id(1)));
  expect(result.current.picks).toEqual([id(3), id(4)]);
  // The numbers close up.
  expect(result.current.numbers.get(id(4))).toBe(2);
  expect(result.current.numbers.has(id(1))).toBe(false);
});

test("starts from the address's picks, and a drag's pick never lets one go", () => {
  const { result } = renderHook(() =>
    useProductSelection(SHELF, () => [id(2), "not-an-id", id(2), id(1)])
  );
  expect(result.current.picks).toEqual([id(2), id(1)]);

  act(() => result.current.pick(id(2)));
  expect(result.current.picks).toEqual([id(2), id(1)]);
  act(() => result.current.pick(id(4)));
  expect(result.current.picks).toEqual([id(2), id(1), id(4)]);

  act(() => result.current.set([id(4), id(3)]));
  expect(result.current.picks).toEqual([id(4), id(3)]);
  act(() => result.current.clear());
  expect(result.current.picks).toEqual([]);
});

test("a pick that left the shelf stays picked but isn't given or numbered", () => {
  const { result, rerender } = renderHook(
    ({ products }) => useProductSelection(products, () => [id(1), id(2)]),
    { initialProps: { products: SHELF } }
  );
  rerender({ products: [product(2), product(3)] });
  expect(result.current.picks).toEqual([id(1), id(2)]);
  expect(result.current.picked.map(entry => entry.id)).toEqual([id(2)]);
  expect(result.current.numbers.get(id(2))).toBe(1);
  rerender({ products: SHELF });
  expect(result.current.picked.map(entry => entry.id)).toEqual([id(1), id(2)]);
});

test("keeps at most the page's limit of picks", () => {
  const many = Array.from(
    { length: PRODUCT_PICKS_MAX + 5 },
    (_, n) => `${"a".repeat(20)}${String(n).padStart(4, "0")}`
  );
  expect(cleanPicks(many)).toHaveLength(PRODUCT_PICKS_MAX);
  const { result } = renderHook(() => useProductSelection([], () => many));
  expect(result.current.picks).toHaveLength(PRODUCT_PICKS_MAX);
  act(() => result.current.toggle(id(1)));
  expect(result.current.picks).not.toContain(id(1));
});

test("reads the picks from an address, in order, leaving out what isn't an id", () => {
  expect(picksIn(null)).toEqual([]);
  expect(picksIn(new URLSearchParams(""))).toEqual([]);
  expect(
    picksIn(new URLSearchParams(`picks=${id(3)},${id(1)},nope,${id(3)}`))
  ).toEqual([id(3), id(1)]);
});

test("a video ad takes products with a cut-out photo and a price", () => {
  expect(canGoInAd(product(1))).toBe(true);
  expect(canGoInAd(product(2, { price: null }))).toBe(false);
  expect(canGoInAd(product(3, { hasCutout: false }))).toBe(false);
});
