/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ProductKitPlanProduct } from "@/lib/products/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BuyersPreview } from "./product-buyers-preview";

// "What buyers see": built on the page from the real products and the words
// the server sends Meta.

const product = (
  id: string,
  overrides: Partial<ProductKitPlanProduct> = {}
): ProductKitPlanProduct => ({
  id,
  name: `Product ${id}`,
  price: 5000,
  currency: "KZT",
  priceIsFrom: false,
  hasPhoto: true,
  hasCutout: true,
  imageUrl: `https://cdn.test/${id}.webp`,
  ...overrides,
});

const shelf = [
  product("p1", { name: "Кукла Лол" }),
  product("p2", { name: "Кружка Web UMN", price: 3500, priceIsFrom: true }),
  product("p3", {
    name: "Ойыншық доллар",
    price: 1,
    currency: "USD",
    hasPhoto: false,
    hasCutout: false,
    imageUrl: null,
  }),
];

test("the carousel: the Kazakh message, then a card per product with a photo, on white with its name, price and order button", () => {
  render(<BuyersPreview products={shelf} language="kk" spokenLanguage="kk" />);

  expect(
    screen.getByText("Біздің тауарлар. Ұнағанын таңдап, тапсырыс беріңіз.")
  ).toBeInTheDocument();
  const cards = screen.getAllByRole("listitem");
  expect(cards).toHaveLength(2);
  const [doll, mug] = cards as [HTMLElement, HTMLElement];
  expect(within(doll).getByText("Кукла Лол")).toBeInTheDocument();
  expect(within(doll).getByText(/^5\s000\s₸$/)).toBeInTheDocument();
  expect(within(doll).getByText("Тапсырыс беру")).toBeInTheDocument();
  expect(within(mug).getByText(/^3\s500\s₸ бастап$/)).toBeInTheDocument();
  // The cut-out sits on the card's white square, as the server makes it.
  const picture = doll.querySelector("img")!;
  expect(picture).toHaveAttribute("src", "https://cdn.test/p1.webp");
  expect(picture.parentElement).toHaveClass("cardPicture");
  expect(
    screen.getByText(
      "Written in Kazakh, the language you spoke. Prices come from your shelf."
    )
  ).toBeInTheDocument();
});

test("the order form: the Flow screen in Kazakh, every product with its price", () => {
  render(<BuyersPreview products={shelf} language="kk" spokenLanguage="kk" />);

  fireEvent.click(screen.getByRole("button", { name: "Order form" }));

  expect(screen.getByRole("button", { name: "Order form" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  for (const words of [
    "Тапсырыс",
    "Не алғыңыз келеді?",
    "Кукла Лол",
    "Кружка Web UMN",
    "Ойыншық доллар",
    "Атыңыз",
    "Жеткізу мекенжайы",
    "Түсініктеме",
    "Тапсырысты жіберу",
  ])
    expect(screen.getByText(words)).toBeInTheDocument();
  expect(screen.getByText(/^1\sUSD$/)).toBeInTheDocument();
});

test("in a language the owner chose, the words follow and the caption doesn't call it theirs", () => {
  render(<BuyersPreview products={shelf} language="ru" spokenLanguage="kk" />);

  expect(
    screen.getByText("Наши товары. Выберите, что понравится, и закажите.")
  ).toBeInTheDocument();
  expect(screen.getAllByText("Заказать")).toHaveLength(2);
  expect(screen.getByText(/^от 3\s500\s₸$/)).toBeInTheDocument();
  expect(
    screen.getByText("Written in Russian. Prices come from your shelf.")
  ).toBeInTheDocument();
});

test("for an owner who spoke none of its languages, the caption doesn't call English theirs", () => {
  render(
    <BuyersPreview products={shelf} language="en" spokenLanguage={null} />
  );

  expect(
    screen.getByText("Written in English. Prices come from your shelf.")
  ).toBeInTheDocument();
});

test("without photos, the carousel says it needs them", () => {
  render(
    <BuyersPreview products={[shelf[2]!]} language="en" spokenLanguage="en" />
  );

  expect(
    screen.getByText("The carousel needs products with photos.")
  ).toBeInTheDocument();
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
});
