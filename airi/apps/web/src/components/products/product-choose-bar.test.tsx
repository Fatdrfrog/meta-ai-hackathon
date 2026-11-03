/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ProductChooseBar } from "./product-choose-bar";

const product = (id: string, name: string, imageUrl: string | null) => ({
  id,
  name,
  price: 5000,
  currency: "KZT",
  priceIsFrom: false,
  imageUrl,
  updatedAt: null,
});

function renderBar(chosen: ReturnType<typeof product>[], adReady: boolean) {
  const actions = {
    onClear: jest.fn(),
    onMakeAd: jest.fn(),
    onMakeKit: jest.fn(),
  };
  render(<ProductChooseBar chosen={chosen} adReady={adReady} {...actions} />);
  return {
    ...actions,
    bar: screen.getByRole("region", { name: "Chosen products" }),
  };
}

test("with nothing chosen it says what to do, and neither can be made", () => {
  const { bar } = renderBar([], false);
  expect(
    within(bar).getByText("Choose products to make something from them.")
  ).toBeInTheDocument();
  expect(
    within(bar).queryByRole("button", { name: "Clear" })
  ).not.toBeInTheDocument();
  expect(
    within(bar).getByRole("button", { name: /Make a video ad/ })
  ).toBeDisabled();
  expect(
    within(bar).getByRole("button", { name: /Make carousel \+ order form/ })
  ).toBeDisabled();
});

test("counts what's chosen, shows up to 3 of them, and offers both things to make", () => {
  const chosen = [
    product("p1", "Кукла Лол", "https://storage.test/doll.webp"),
    product("p2", "Кружка Web UMN", "https://storage.test/cup.webp"),
    product("p3", "Петух", null),
    product("p4", "Шежіре", "https://storage.test/shezhire.webp"),
  ];
  const { bar, onClear, onMakeKit, onMakeAd } = renderBar(chosen, true);
  expect(within(bar).getByText("4 chosen")).toBeInTheDocument();
  // Three thumbnails, the one without a photo by its first letter.
  expect(bar.querySelectorAll("img")).toHaveLength(2);
  expect(within(bar).getByText("П")).toBeInTheDocument();

  fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
  expect(onClear).toHaveBeenCalled();
  fireEvent.click(
    within(bar).getByRole("button", { name: /Make carousel \+ order form/ })
  );
  expect(onMakeKit).toHaveBeenCalled();
  fireEvent.click(within(bar).getByRole("button", { name: /Make a video ad/ }));
  expect(onMakeAd).toHaveBeenCalled();
});

test("a choice no video ad can show says why the ad's button is off", () => {
  const { bar } = renderBar([product("p3", "Петух", null)], false);
  const makeAd = within(bar).getByRole("button", { name: /Make a video ad/ });
  expect(makeAd).toBeDisabled();
  expect(makeAd).toHaveAccessibleDescription(
    "A video ad takes 1 to 3 products with photos and prices."
  );
  // The carousel and order form take any products.
  expect(
    within(bar).getByRole("button", { name: /Make carousel \+ order form/ })
  ).toBeEnabled();
});

test("on a phone the buttons say it shorter", () => {
  const { bar } = renderBar(
    [product("p1", "Кукла Лол", "https://storage.test/doll.webp")],
    true
  );
  // Both labels are there; the page's styles show one per width.
  expect(within(bar).getByText("Video ad")).toHaveClass("sm:hidden");
  expect(within(bar).getByText("Make a video ad")).toHaveClass("max-sm:hidden");
  expect(within(bar).getByText("Carousel + form")).toHaveClass("sm:hidden");
  expect(within(bar).getByText("Make carousel + order form")).toHaveClass(
    "max-sm:hidden"
  );
});
