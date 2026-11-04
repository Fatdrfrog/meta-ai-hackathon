/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ProductKitPlanProduct } from "@/lib/products/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { BuyersPreview, OrderFormScreen } from "./product-buyers-preview";

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

// The owner's edits from "Edit cards" and "Edit questions" are drawn
// instead of the shelf's.
const editedCards: WhatsAppComponent[] = [
  { type: "BODY", text: "New in! Pick one and order." },
  {
    type: "CAROUSEL",
    cards: [
      ["Doll in a box", "5 000 ₸ today", "https://cdn.test/a.png"],
      ["Mug", "3 500 ₸", "https://cdn.test/b.png"],
    ].map(([body, price, image]) => ({
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: [image] },
        },
        { type: "BODY", text: `${body}\n${price}` },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "I want it" }],
        },
      ],
    })),
  } as unknown as WhatsAppComponent,
];

const editedForm: WhatsAppFlowConfig = {
  templateId: "products_order_form",
  ctaText: "Order",
  flowSubmitLabel: "Send my order",
  flowNavigationMode: "linear",
  screens: [
    {
      id: "ORDER",
      title: "Your order",
      fields: [
        {
          id: "products",
          label: "What would you like?",
          fieldType: "CheckboxGroup",
          required: true,
          options: [
            { id: "p1", title: "Doll", description: "5 000 ₸" },
            { id: "p2", title: "Mug" },
          ],
        },
        {
          id: "delivery",
          label: "Delivery or pickup",
          fieldType: "RadioButtonsGroup",
          required: true,
          options: [
            { id: "delivery", title: "Delivery" },
            { id: "pickup", title: "Pickup" },
          ],
        },
        { id: "city", label: "City", fieldType: "Dropdown", options: [] },
        { id: "note", label: "Anything else", fieldType: "TextArea" },
        { id: "day", label: "Day", fieldType: "DatePicker" },
      ],
    },
    {
      id: "THANKS",
      title: "Thanks",
      fields: [{ id: "phone", label: "Phone", fieldType: "TextInput" }],
    },
  ],
} as WhatsAppFlowConfig;

test("edited cards are drawn from their components, with the edited caption", () => {
  render(
    <BuyersPreview
      products={shelf}
      language="kk"
      spokenLanguage="kk"
      carousel={{ components: editedCards }}
    />
  );

  expect(screen.getByText("New in! Pick one and order.")).toBeInTheDocument();
  const cards = screen.getAllByRole("listitem");
  expect(cards).toHaveLength(2);
  expect(within(cards[0]!).getByText("Doll in a box")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("5 000 ₸ today")).toBeInTheDocument();
  expect(within(cards[0]!).getByText("I want it")).toBeInTheDocument();
  expect(cards[0]!.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.test/a.png"
  );
  // The shelf's own words are not shown.
  expect(screen.queryByText("Кукла Лол")).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "With your edits, as buyers will see them. Card prices are the words you wrote; your shelf prices don't change."
    )
  ).toBeInTheDocument();
});

test("edited questions are drawn from the config, every kind of question", () => {
  render(
    <BuyersPreview
      products={shelf}
      language="en"
      spokenLanguage="en"
      orderForm={{ config: editedForm }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Order form" }));

  for (const words of [
    "Your order",
    "What would you like? *",
    "Doll",
    "5 000 ₸",
    "Mug",
    "Delivery or pickup *",
    "Pickup",
    "City",
    "Anything else",
    "Day",
    "Send my order",
  ])
    expect(screen.getByText(words)).toBeInTheDocument();
  // The shelf's questions are not shown; the first screen only.
  expect(screen.queryByText("Your name")).not.toBeInTheDocument();
  expect(screen.queryByText("Phone")).not.toBeInTheDocument();
});

test("the Flow editor's preview shows the screen it asks for", () => {
  render(
    <OrderFormScreen config={editedForm} language="ru" screenId="THANKS" />
  );

  expect(screen.getByText("Thanks")).toBeInTheDocument();
  expect(screen.getByText("Phone")).toBeInTheDocument();
  expect(screen.queryByText("Your order")).not.toBeInTheDocument();
});
