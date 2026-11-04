/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductKitPlanProduct,
  ProductKitPlanResponse,
  ProductKitRecord,
} from "@/lib/products/types";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { installMatchMedia } from "@/test-support/dom-test-utils";
import { MakeOutputs } from "./product-make";
import { madeWhen } from "./use-product-kits";

// The editors themselves (airi's template and Flow editors) have their own
// suites; here they stand in as their props: what they open with, and saving.
// What the editor would show as its error toast when onCreate refuses
// without `toast: null` (which leaves the error to the sheet).
const mockCreateErrors: string[] = [];
// The words the owner has typed on the card when the editor saves.
const mockEditorWords = { text: "My words" };
jest.mock("./product-carousel-editor", () => ({
  ProductCarouselEditor: (props: {
    prefill: { name: string; components: unknown[] };
    draftScope: string;
    submitLabel: string;
    onCreate: (input: unknown) => Promise<{
      success: boolean;
      error?: string;
      toast?: string | null;
    }>;
    onSaved: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="carousel-editor" data-scope={props.draftScope}>
      <p>Opened with {props.prefill.name}</p>
      <p>{props.prefill.components.length} components</p>
      <button
        type="button"
        onClick={async () => {
          const result = await props.onCreate({
            name: "my_cards",
            language: "kk",
            category: "MARKETING",
            components: [{ type: "BODY", text: mockEditorWords.text }],
          });
          if (result.success) props.onSaved();
          else if (result.toast !== null)
            mockCreateErrors.push(result.error ?? "");
        }}
      >
        {props.submitLabel}
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  ),
}));
jest.mock("./product-order-form-editor", () => ({
  ProductOrderFormEditor: (props: {
    initialConfig: { screens: Array<{ fields: Array<{ label: string }> }> };
    submitLabel: string;
    onSave: (config: unknown) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="form-editor">
      <p>First question: {props.initialConfig.screens[0]!.fields[0]!.label}</p>
      <button
        type="button"
        onClick={() =>
          props.onSave({
            ...props.initialConfig,
            screens: [{ id: "ORDER", title: "My form", fields: [] }],
          })
        }
      >
        {props.submitLabel}
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

installMatchMedia();

// "Make something with them": the kit for customers on WhatsApp (both parts
// ticked, one press), the way into a video ad, and what buyers see.

const WS = "workspace-1";
const IMPORT = "651f1f77bcf86cd799439040";
const ids = ["p1", "p2", "p3"].map(
  (_, index) => `651f1f77bcf86cd79943900${index + 1}`
);
const BASE = `/api/workspaces/${WS}/products/kits`;

const product = (
  index: number,
  overrides: Partial<ProductKitPlanProduct> = {}
): ProductKitPlanProduct => ({
  id: ids[index]!,
  name: ["Кукла Лол", "Кружка Web UMN", "Шежіре"][index]!,
  price: [5000, 3500, 15500][index]!,
  currency: "KZT",
  priceIsFrom: false,
  hasPhoto: true,
  hasCutout: true,
  imageUrl: `https://cdn.test/${index}.webp`,
  ...overrides,
});

const plan = (
  overrides: Partial<ProductKitPlanResponse> = {}
): ProductKitPlanResponse => ({
  language: "kk",
  languageIsSpoken: true,
  products: [product(0), product(1), product(2)],
  whatsapp: { connected: true, displayPhone: "shop-number" },
  latestKit: null,
  ...overrides,
});

const madeKit: ProductKitRecord = {
  id: "651f1f77bcf86cd799439099",
  createdAt: new Date().toISOString(),
  language: "kk",
  productIds: ids,
  importId: IMPORT,
  parts: {
    orderForm: {
      state: "ready",
      flowId: "flow-1",
      flowName: "Order form · 2 Nov 09:14",
      productCount: 3,
      error: null,
      edited: false,
      version: 1,
      earlier: [],
    },
    carousel: {
      state: "submitted",
      templateId: "tpl-1",
      templateName: "products_20261102_041405",
      cardCount: 3,
      metaStatus: "PENDING",
      metaReason: null,
      approvedAt: null,
      error: null,
      edited: false,
      earlier: [],
    },
  },
  status: "waiting_for_meta",
  pricesChanged: false,
};

type Route = (init?: RequestInit) => Promise<Response> | Response;
let routes: Record<string, Route>;
let posts: Array<Record<string, unknown>>;

// jsdom has no Response: the page only reads these three.
const respond = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

const planUrl = (importId: string | null = IMPORT) =>
  `GET ${BASE}?products=${encodeURIComponent(ids.join(","))}${importId ? `&importId=${importId}` : ""}`;

beforeEach(() => {
  posts = [];
  mockEditorWords.text = "My words";
  routes = {
    [planUrl()]: () => respond(200, plan()),
    [`POST ${BASE}`]: init => {
      posts.push(JSON.parse(String(init?.body)));
      return respond(201, { kit: madeKit });
    },
  };
  global.fetch = (async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${init?.method} ${url}`);
    return route(init);
  }) as unknown as typeof fetch;
});

function renderMake(props: Partial<Parameters<typeof MakeOutputs>[0]> = {}) {
  const onChangeProducts = jest.fn();
  const onMakeAd = jest.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MakeOutputs
        workspaceId={WS}
        productIds={ids}
        importId={IMPORT}
        onChangeProducts={onChangeProducts}
        onMakeAd={onMakeAd}
        {...props}
      />
    </SWRConfig>
  );
  return { onChangeProducts, onMakeAd };
}

const kitCard = async () =>
  (
    await screen.findByRole("heading", { name: "Carousel + order form" })
  ).closest("article")!;

test("both parts are ticked, and one press names both", async () => {
  renderMake();

  const card = await kitCard();
  expect(
    within(card).getByRole("checkbox", { name: /Carousel/ })
  ).toBeChecked();
  expect(
    within(card).getByRole("checkbox", { name: /Order form/ })
  ).toBeChecked();
  expect(
    within(card).getByText("3 cards · Meta checks it first")
  ).toBeVisible();
  expect(within(card).getByText("3 products · ready right away")).toBeVisible();
  expect(within(card).getByText("3 products from this video")).toBeVisible();
  expect(within(card).getByText("No AI actions")).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  ).toBeEnabled();
  expect(
    screen.getByText("Buyers see it in Kazakh, the language you spoke.", {
      exact: false,
    })
  ).toBeVisible();
});

test("unticking a part renames the button; with neither, it can't be pressed", async () => {
  renderMake();
  const card = await kitCard();

  fireEvent.click(within(card).getByRole("checkbox", { name: /Order form/ }));
  expect(
    within(card).getByRole("button", { name: "Make the carousel" })
  ).toBeEnabled();

  fireEvent.click(within(card).getByRole("checkbox", { name: /Carousel/ }));
  expect(
    within(card).getByRole("button", { name: "Choose what to make" })
  ).toBeDisabled();

  fireEvent.click(within(card).getByRole("checkbox", { name: /Order form/ }));
  expect(
    within(card).getByRole("button", { name: "Make the order form" })
  ).toBeEnabled();
});

test("with fewer than 2 photos the carousel can't be ticked, and the press makes the form", async () => {
  routes[planUrl()] = () =>
    respond(
      200,
      plan({
        products: [
          product(0),
          product(1, { hasPhoto: false, hasCutout: false, imageUrl: null }),
        ],
      })
    );
  renderMake();
  const card = await kitCard();

  const carousel = within(card).getByRole("checkbox", { name: /Carousel/ });
  expect(carousel).toBeDisabled();
  expect(carousel).not.toBeChecked();
  expect(
    within(card).getByText("Needs at least 2 products with photos")
  ).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Make the order form" })
  ).toBeEnabled();
});

test("without a WhatsApp number, the card asks to connect one, and the video ad stays", async () => {
  routes[planUrl()] = () =>
    respond(200, plan({ whatsapp: { connected: false, displayPhone: null } }));
  renderMake();
  const card = await kitCard();

  expect(
    within(card).getByText("Connect your WhatsApp number to make these.")
  ).toBeVisible();
  expect(
    within(card).getByRole("link", { name: "Connect WhatsApp" })
  ).toHaveAttribute(
    "href",
    "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
  );
  expect(
    within(card).queryByRole("button", { name: /Make carousel/ })
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Make a video ad" })).toBeEnabled();
});

test("one press sends one request, shows the checklist while it's made, then the kit's status", async () => {
  let answer: (response: Response) => void = () => {};
  routes[`POST ${BASE}`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    return new Promise<Response>(resolve => {
      answer = resolve;
    });
  };
  renderMake();
  const card = await kitCard();

  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );

  expect(
    await within(card).findByText("Publishing the order form")
  ).toBeVisible();
  expect(
    within(card).getByText("Making 3 cards and sending them to Meta")
  ).toBeVisible();
  expect(
    within(card).getByText(
      "This usually takes about 20 seconds, at most a minute."
    )
  ).toBeVisible();
  expect(within(card).queryByRole("button", { name: /Make/ })).toBeNull();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({
    requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
    productIds: ids,
    importId: IMPORT,
    make: { carousel: true, orderForm: true },
    language: "kk",
    timeZone: expect.any(String),
  });

  answer(respond(201, { kit: madeKit }));

  expect(await within(card).findByText("With Meta")).toBeVisible();
  expect(within(card).getByText("Ready")).toBeVisible();
  expect(
    within(card).getByRole("link", { name: "Open in Templates" })
  ).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Make another" })
  ).toBeVisible();
});

test("the press keeps the keyboard's focus on the card, and says what it makes and made", async () => {
  let answer: (response: Response) => void = () => {};
  routes[`POST ${BASE}`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    return new Promise<Response>(resolve => {
      answer = resolve;
    });
  };
  renderMake();
  const card = await kitCard();
  const heading = within(card).getByRole("heading", {
    name: "Carousel + order form",
  });
  const press = within(card).getByRole("button", {
    name: "Make carousel + order form",
  });
  act(() => press.focus());
  fireEvent.click(press);

  // The button went with the press: the card's title has the focus, not
  // the page, and a screen reader hears what is being made.
  expect(
    await within(card).findByText("Publishing the order form")
  ).toBeVisible();
  expect(document.activeElement).toBe(heading);
  const said = card.querySelector('[aria-live="polite"]')!;
  expect(said).toHaveTextContent(
    "Publishing the order form. Making 3 cards and sending them to Meta."
  );

  await act(async () => answer(respond(201, { kit: madeKit })));
  expect(await within(card).findByText("With Meta")).toBeVisible();
  expect(document.activeElement).toBe(heading);
  expect(said).toHaveTextContent("Order form: Ready. Carousel: With Meta.");

  // Make another goes back to the choice; the focus stays on the card.
  const another = within(card).getByRole("button", { name: "Make another" });
  act(() => another.focus());
  fireEvent.click(another);
  expect(
    await within(card).findByRole("button", {
      name: "Make carousel + order form",
    })
  ).toBeVisible();
  expect(document.activeElement).toBe(heading);
});

test("a refusal says why, and a lost answer is sent again as the same press", async () => {
  let attempt = 0;
  routes[`POST ${BASE}`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    if (attempt === 2) return respond(201, { kit: madeKit });
    return respond(409, { code: "not_enough_products" });
  };
  renderMake();
  const card = await kitCard();

  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "That didn't work. Try again."
  );

  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );
  expect(await within(card).findByText("With Meta")).toBeVisible();
  expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
});

test("a server failure after the kit may exist keeps the press, so pressing again finds that kit", async () => {
  // The POST answers 503 draft_failed for any error, also one thrown after
  // Meta took the template and the Flow was published.
  let attempt = 0;
  routes[`POST ${BASE}`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    attempt += 1;
    return attempt === 1
      ? respond(503, { error: "x", code: "draft_failed" })
      : respond(201, { kit: madeKit });
  };
  renderMake();
  const card = await kitCard();

  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "That didn't work. Try again."
  );
  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );
  expect(await within(card).findByText("With Meta")).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
});

test("a kit Meta can't take says so, and the next press is a new one", async () => {
  routes[`POST ${BASE}`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    return respond(409, { code: "not_enough_products" });
  };
  renderMake();
  const card = await kitCard();

  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "These products don't have photos to put on the cards."
  );
  fireEvent.click(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  );
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]!.requestId).not.toBe(posts[0]!.requestId);
});

test("the buyers' language can be changed, and the preview and the press follow it", async () => {
  renderMake();
  await kitCard();

  // The language's Change, in the header (the card's own changes products).
  fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Russian" }));

  expect(
    screen.getByText("Buyers see it in Russian.", { exact: false })
  ).toBeVisible();
  expect(
    screen.getByText("Наши товары. Выберите, что понравится, и закажите.")
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Make carousel + order form" })
  );
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ language: "ru" });
});

test("an owner who spoke none of the buyers' languages isn't told English was theirs", async () => {
  // Spoken in Uzbek: buyers get English words, which the owner didn't speak.
  routes[planUrl()] = () =>
    respond(200, plan({ language: "en", languageIsSpoken: false }));
  renderMake();

  expect(
    await screen.findByText("Buyers see it in English.", { exact: false })
  ).toBeVisible();
  expect(screen.queryByText(/in English, the language you spoke/)).toBeNull();
  expect(
    screen.getByText("Written in English. Prices come from your shelf.")
  ).toBeVisible();
});

test("Change opens Choose mode with these products", async () => {
  const { onChangeProducts } = renderMake();
  const card = await kitCard();

  fireEvent.click(within(card).getByRole("button", { name: "Change" }));

  expect(onChangeProducts).toHaveBeenCalledWith(ids);
});

test("the video ad card opens the ad's brief with the first 3 products it can show", async () => {
  routes[planUrl(null)] = () =>
    respond(
      200,
      plan({
        products: [
          product(0, { price: null }),
          product(1),
          product(2, { hasCutout: false }),
          { ...product(0), id: "651f1f77bcf86cd799439004", name: "Медаль" },
          { ...product(0), id: "651f1f77bcf86cd799439005", name: "Сағат" },
          { ...product(0), id: "651f1f77bcf86cd799439006", name: "Үстел" },
        ],
      })
    );
  const { onMakeAd } = renderMake({ importId: null });
  await kitCard();
  expect(screen.getByText("6 products from your shelf")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Make a video ad" }));

  expect(onMakeAd).toHaveBeenCalledWith([
    ids[1],
    "651f1f77bcf86cd799439004",
    "651f1f77bcf86cd799439005",
  ]);
  expect(screen.getByText("1 AI action")).toBeVisible();
});

test("without a product it can show, the video ad card says what it needs", async () => {
  routes[planUrl()] = () =>
    respond(200, plan({ products: [product(0, { price: null })] }));
  renderMake();
  await kitCard();

  expect(
    screen.getByRole("button", { name: "Make a video ad" })
  ).toBeDisabled();
  expect(
    screen.getByText("Add a photo and a price to a product to put it in an ad.")
  ).toBeVisible();
});

test("a kit already made from this review shows its status, and Make another goes back to the choice", async () => {
  routes[planUrl()] = () => respond(200, plan({ latestKit: madeKit }));
  renderMake();
  const card = await kitCard();

  expect(within(card).getByText("With Meta")).toBeVisible();
  // The same words the card builds, so a run just after midnight still matches
  // ("yesterday at 23:59"); madeWhen's own tests pin today and yesterday.
  expect(
    within(card).getByText(
      PRODUCTS_COPY.kit.madeAt(
        madeWhen(madeKit.createdAt, new Date(), PRODUCTS_COPY.made),
        3
      )
    )
  ).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Make another" }));
  expect(
    within(card).getByRole("button", { name: "Make carousel + order form" })
  ).toBeVisible();
});

test("a kit whose prices changed on the shelf since says so", async () => {
  routes[planUrl()] = () =>
    respond(200, plan({ latestKit: { ...madeKit, pricesChanged: true } }));
  renderMake();
  const card = await kitCard();

  expect(
    within(card).getByText(
      "Prices changed since this was made. Make another to show the new ones."
    )
  ).toBeVisible();
});

test("a part that wasn't made is made again from the status", async () => {
  const failed: ProductKitRecord = {
    ...madeKit,
    parts: {
      ...madeKit.parts,
      carousel: {
        ...madeKit.parts.carousel!,
        state: "failed",
        templateId: null,
        metaStatus: null,
        error: { code: "storage_full", message: null },
      },
    },
    status: "needs_attention",
  };
  routes[planUrl()] = () => respond(200, plan({ latestKit: failed }));
  let answerRetry: () => void = () => {};
  routes[`POST ${BASE}/${madeKit.id}/retry`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    return new Promise<Response>(resolve => {
      answerRetry = () => resolve(respond(200, { kit: madeKit }));
    });
  };
  routes[`GET /api/workspaces/${WS}/products/made`] = () =>
    respond(200, {
      kits: [madeKit],
      ads: [],
      whatsapp: { connected: true, displayPhone: null },
    });
  renderMake();
  const card = await kitCard();

  expect(within(card).getByText("The order form stays ready.")).toBeVisible();
  const again = within(card).getByRole("button", { name: "Try again" });
  act(() => again.focus());
  fireEvent.click(again);

  // While it's made again, Try again stays (unpressable) with the focus.
  expect(await within(card).findByText("Making")).toBeVisible();
  expect(document.activeElement).toBe(again);
  expect(again).toHaveAttribute("aria-disabled", "true");

  await act(async () => answerRetry());
  expect(await within(card).findByText("With Meta")).toBeVisible();
  expect(posts).toEqual([{ part: "carousel" }]);
  // Made, its Try again is gone: the card's title takes the focus.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(card).getByRole("heading", { name: "Carousel + order form" })
    )
  );
});

test("loading shows a still placeholder; a failed load offers Retry", async () => {
  let fail = true;
  routes[planUrl()] = () =>
    fail ? respond(503, { code: "load_failed" }) : respond(200, plan());
  renderMake();

  expect(screen.getByRole("status")).toHaveTextContent(
    "Getting your products ready…"
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your products couldn't be loaded."
  );
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await kitCard()).toBeVisible();
});

test("products a review is still saving show once they're on the shelf", async () => {
  let asked = 0;
  routes[planUrl()] = () => {
    asked += 1;
    return respond(
      200,
      asked === 1 ? plan({ products: [product(0), product(1)] }) : plan()
    );
  };
  renderMake();

  expect(await screen.findByText("2 products from this video")).toBeVisible();
  expect(
    await screen.findByText("3 products from this video", undefined, {
      timeout: 4000,
    })
  ).toBeVisible();
});

test("products no longer on the shelf say so, with Change", async () => {
  jest.useFakeTimers();
  try {
    routes[planUrl()] = () => respond(200, plan({ products: [] }));
    const { onChangeProducts } = renderMake();

    // Asked again a few times first, in case a review is still saving them.
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(() => jest.advanceTimersByTimeAsync(20_000));
    expect(
      screen.getByText(
        "None of these products are on your shelf now. Choose others to make something.",
        { exact: false }
      )
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(onChangeProducts).toHaveBeenCalledWith(ids);
  } finally {
    jest.useRealTimers();
  }
});

describe("editing before Make", () => {
  const drafts = {
    carousel: {
      name: "products_20261103_101500",
      language: "kk",
      components: [
        { type: "BODY", text: "Жаңа тауарлар келді!" },
        { type: "CAROUSEL", cards: [] },
      ],
      productIds: ids,
      leftOut: 0,
    },
  };

  beforeEach(() => {
    routes[`POST ${BASE}/drafts`] = init => {
      posts.push({ drafts: JSON.parse(String(init?.body)) });
      return respond(200, drafts);
    };
  });

  async function saveQuestions(card: HTMLElement) {
    fireEvent.click(
      within(card).getByRole("button", { name: "Edit questions" })
    );
    fireEvent.click(
      within(await screen.findByTestId("form-editor")).getByRole("button", {
        name: "Save changes",
      })
    );
    await waitFor(() => expect(screen.queryByTestId("form-editor")).toBeNull());
  }

  test("a ticked part has its edit row; an unticked one has none", async () => {
    renderMake();
    const card = await kitCard();

    expect(
      within(card).getByRole("button", { name: "Edit cards" })
    ).toBeVisible();
    expect(
      within(card).getByRole("button", { name: "Edit questions" })
    ).toBeVisible();

    fireEvent.click(within(card).getByRole("checkbox", { name: /Order form/ }));
    expect(
      within(card).queryByRole("button", { name: "Edit questions" })
    ).toBeNull();
    // Pressing the edit row never toggles the part (the open sheet hides
    // the page from assistive tech meanwhile).
    fireEvent.click(within(card).getByRole("button", { name: "Edit cards" }));
    expect(
      within(card).getByRole("checkbox", { name: /Carousel/, hidden: true })
    ).toBeChecked();
    expect(await screen.findByTestId("carousel-editor")).toBeVisible();
  });

  test("Edit cards opens the shelf's cards once, saves them, and Make sends them", async () => {
    renderMake();
    const card = await kitCard();

    fireEvent.click(within(card).getByRole("button", { name: "Edit cards" }));
    const editor = await screen.findByTestId("carousel-editor");
    expect(
      within(editor).getByText("Opened with products_20261103_101500")
    ).toBeVisible();
    // The card's own draft space, per language.
    expect(editor.dataset.scope).toMatch(/^products:[0-9a-f-]+:kk$/);
    expect(posts).toEqual([{ drafts: { productIds: ids, language: "kk" } }]);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "airi's template editor, filled from your 3 shelf products. Nothing goes to Meta until you press Make."
    );

    fireEvent.click(
      within(editor).getByRole("button", { name: "Save changes" })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("carousel-editor")).toBeNull()
    );
    expect(within(card).getByText("Edited")).toBeVisible();
    expect(
      within(card).getByText(
        "Carousel edited. It goes to Meta when you press Make."
      )
    ).toBeInTheDocument();
    // What buyers see follows the edits.
    expect(screen.getByText("My words")).toBeVisible();

    // Opened again: the saved cards, without asking for the shelf's again.
    fireEvent.click(within(card).getByRole("button", { name: "Edit cards" }));
    expect(await screen.findByText("Opened with my_cards")).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    fireEvent.click(
      within(screen.getByTestId("carousel-editor")).getByRole("button", {
        name: "Cancel",
      })
    );
    await waitFor(() =>
      expect(screen.queryByTestId("carousel-editor")).toBeNull()
    );

    fireEvent.click(
      within(card).getByRole("button", { name: "Make carousel + order form" })
    );
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({
      make: { carousel: true, orderForm: true },
      edits: {
        carousel: {
          name: "my_cards",
          components: [{ type: "BODY", text: "My words" }],
        },
      },
    });
    expect(posts[1]!.edits).not.toHaveProperty("orderForm");
  });

  test("Edit questions opens the shelf's form, and an unticked part's edits stay home", async () => {
    renderMake();
    const card = await kitCard();

    fireEvent.click(
      within(card).getByRole("button", { name: "Edit questions" })
    );
    const editor = await screen.findByTestId("form-editor");
    expect(
      within(editor).getByText("First question: Не алғыңыз келеді?")
    ).toBeVisible();
    fireEvent.click(
      within(editor).getByRole("button", { name: "Save changes" })
    );
    await waitFor(() => expect(screen.queryByTestId("form-editor")).toBeNull());
    expect(within(card).getByText("Edited")).toBeVisible();

    // Unticked, the form isn't made, so its edits aren't sent.
    fireEvent.click(within(card).getByRole("checkbox", { name: /Order form/ }));
    fireEvent.click(
      within(card).getByRole("button", { name: "Make the carousel" })
    );
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("edits");
  });

  test("Reset asks first, then the part is the shelf's again", async () => {
    renderMake();
    const card = await kitCard();
    await saveQuestions(card);

    fireEvent.click(within(card).getByRole("button", { name: "Reset" }));
    expect(
      within(card).getByText(
        "Reset the questions to your shelf? Your edits go."
      )
    ).toBeVisible();
    // Keep my edits takes the focus as the question opens.
    const keep = within(card).getByRole("button", { name: "Keep my edits" });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(within(card).getByText("Edited")).toBeVisible();

    fireEvent.click(within(card).getByRole("button", { name: "Reset" }));
    fireEvent.click(within(card).getByRole("button", { name: "Reset" }));
    expect(within(card).queryByText("Edited")).toBeNull();
    expect(document.activeElement).toBe(
      within(card).getByRole("button", { name: "Edit questions" })
    );

    fireEvent.click(
      within(card).getByRole("button", { name: "Make carousel + order form" })
    );
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("edits");
  });

  test("a language change with edits asks first; keeping them keeps the language", async () => {
    renderMake();
    const card = await kitCard();
    await saveQuestions(card);

    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Russian" }));

    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent(
      "Your edits are in Kazakh. Switching to Russian starts the cards and the questions again from your shelf."
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Keep Kazakh" })
    );
    expect(
      screen.getByText("Buyers see it in Kazakh", { exact: false })
    ).toBeVisible();
    expect(within(card).getByText("Edited")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Russian" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Switch to Russian",
      })
    );
    expect(
      screen.getByText("Buyers see it in Russian.", { exact: false })
    ).toBeVisible();
    expect(within(card).queryByText("Edited")).toBeNull();
  });

  test("a product change with edits asks first", async () => {
    const { onChangeProducts } = renderMake();
    const card = await kitCard();
    await saveQuestions(card);

    fireEvent.click(within(card).getByRole("button", { name: "Change" }));
    expect(onChangeProducts).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent(
      "Changing the products starts the cards and the questions again from your shelf."
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Change products" })
    );
    expect(onChangeProducts).toHaveBeenCalledWith(ids);
  });

  test("the shelf's cards that can't be made say why, with Try again", async () => {
    let calls = 0;
    routes[`POST ${BASE}/drafts`] = () => {
      calls += 1;
      return calls === 1
        ? respond(500, { error: "x", code: "draft_failed" })
        : respond(200, drafts);
    };
    renderMake();
    const card = await kitCard();
    fireEvent.click(within(card).getByRole("button", { name: "Edit cards" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't put your products on cards. Check your connection and try again."
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("carousel-editor")).toBeVisible();
  });

  test("a Make whose answer was lost goes again as the same press, but cards changed since make it a new one", async () => {
    let attempt = 0;
    routes[`POST ${BASE}`] = init => {
      posts.push(JSON.parse(String(init?.body)));
      attempt += 1;
      if (attempt <= 2) throw new TypeError("Failed to fetch");
      return respond(201, { kit: madeKit });
    };
    renderMake();
    const card = await kitCard();
    const saveCards = async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Edit cards" }));
      fireEvent.click(
        within(await screen.findByTestId("carousel-editor")).getByRole(
          "button",
          { name: "Save changes" }
        )
      );
      await waitFor(() =>
        expect(screen.queryByTestId("carousel-editor")).toBeNull()
      );
    };
    const press = async () => {
      fireEvent.click(
        within(card).getByRole("button", { name: "Make carousel + order form" })
      );
      await waitFor(() =>
        expect(posts.filter(post => "requestId" in post)).toHaveLength(
          pressed + 1
        )
      );
      pressed += 1;
    };
    let pressed = 0;

    await saveCards();
    await press();
    expect(await within(card).findByRole("alert")).toBeVisible();
    // Unchanged: the same press, which finds a kit it may have made.
    await press();
    expect(await within(card).findByRole("alert")).toBeVisible();
    // The owner fixes a card first: a new press, with the fix.
    mockEditorWords.text = "Fixed words";
    await saveCards();
    await press();

    const [first, again, fixed] = posts.filter(post => "requestId" in post);
    expect(again!.requestId).toBe(first!.requestId);
    expect(fixed!.requestId).not.toBe(first!.requestId);
    expect(fixed).toMatchObject({
      edits: {
        carousel: { components: [{ type: "BODY", text: "Fixed words" }] },
      },
    });
    expect(await within(card).findByText("With Meta")).toBeVisible();
  });

  test("the keyboard's focus goes back to the language line once the language question is answered", async () => {
    renderMake();
    const card = await kitCard();
    await saveQuestions(card);
    const languageChange = screen.getAllByRole("button", {
      name: "Change",
    })[0]!;

    fireEvent.click(languageChange);
    fireEvent.click(screen.getByRole("button", { name: "Russian" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Keep Kazakh",
      })
    );
    await waitFor(() => expect(document.activeElement).toBe(languageChange));

    fireEvent.click(languageChange);
    fireEvent.click(screen.getByRole("button", { name: "Russian" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Switch to Russian",
      })
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getAllByRole("button", { name: "Change" })[0]
      )
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  test("keeping the edits on a product change gives the focus to the section's title", async () => {
    renderMake();
    const card = await kitCard();
    await saveQuestions(card);

    fireEvent.click(within(card).getByRole("button", { name: "Change" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Keep my edits",
      })
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2 })
      )
    );
  });

  test("an edit Make refuses says the first check that failed", async () => {
    routes[`POST ${BASE}`] = () =>
      respond(400, {
        error: "x",
        code: "invalid_request",
        issues: ["Card 2's picture isn't on this project's storage."],
      });
    renderMake();
    const card = await kitCard();
    fireEvent.click(within(card).getByRole("button", { name: "Edit cards" }));
    fireEvent.click(
      within(await screen.findByTestId("carousel-editor")).getByRole("button", {
        name: "Save changes",
      })
    );
    await waitFor(() =>
      expect(screen.queryByTestId("carousel-editor")).toBeNull()
    );

    fireEvent.click(
      within(card).getByRole("button", { name: "Make carousel + order form" })
    );

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "It wasn't sent: Card 2's picture isn't on this project's storage."
    );
  });
});

describe("editing after Make", () => {
  const kitUrl = `${BASE}/${madeKit.id}`;

  beforeEach(() => {
    routes[planUrl()] = () => respond(200, plan({ latestKit: madeKit }));
    routes[`GET ${kitUrl}/edit?part=carousel`] = () =>
      respond(200, {
        kit: madeKit,
        carousel: {
          name: "products_20261103_120000",
          language: "kk",
          components: [{ type: "BODY", text: "Sent words" }],
        },
      });
    routes[`GET /api/workspaces/${WS}/products/made`] = () =>
      respond(200, {
        kits: [madeKit],
        ads: [],
        whatsapp: { connected: true, displayPhone: null },
      });
  });

  test("Edit and send again opens what was sent and sends it as a new template", async () => {
    const sent: ProductKitRecord = {
      ...madeKit,
      parts: {
        ...madeKit.parts,
        carousel: {
          ...madeKit.parts.carousel!,
          templateName: "my_cards",
          edited: true,
          earlier: [],
        },
      },
    };
    routes[`POST ${kitUrl}/edit`] = init => {
      posts.push(JSON.parse(String(init?.body)));
      return respond(200, { kit: sent });
    };
    renderMake();
    const card = await kitCard();

    const button = within(card).getByRole("button", {
      name: "Edit and send again",
    });
    fireEvent.click(button);
    const editor = await screen.findByTestId("carousel-editor");
    expect(
      within(editor).getByText("Opened with products_20261103_120000")
    ).toBeVisible();
    expect(editor.dataset.scope).toBe(`products:kit:${madeKit.id}:carousel`);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Meta is checking products_20261102_041405 and won't let it change, so this goes to Meta as a new template."
    );

    fireEvent.click(
      within(editor).getByRole("button", { name: "Send to Meta for review" })
    );

    await waitFor(() =>
      expect(screen.queryByTestId("carousel-editor")).toBeNull()
    );
    expect(posts).toEqual([
      {
        requestId: expect.any(String),
        part: "carousel",
        name: "my_cards",
        components: [{ type: "BODY", text: "My words" }],
      },
    ]);
    expect(
      within(card).getByText("Sent to Meta as a new template.")
    ).toBeInTheDocument();
  });

  test("an edit whose answer was lost goes again as the same press, but a card changed since makes it a new one", async () => {
    let attempt = 0;
    routes[`POST ${kitUrl}/edit`] = init => {
      posts.push(JSON.parse(String(init?.body)));
      attempt += 1;
      // A 503 at the route's limit: the edit may have gone.
      return attempt <= 2
        ? respond(503, { error: "x", code: "draft_failed" })
        : respond(200, { kit: madeKit });
    };
    renderMake();
    const card = await kitCard();
    fireEvent.click(
      within(card).getByRole("button", { name: "Edit and send again" })
    );
    const editor = await screen.findByTestId("carousel-editor");
    const send = async (count: number) => {
      fireEvent.click(
        within(editor).getByRole("button", { name: "Send to Meta for review" })
      );
      await waitFor(() => expect(posts).toHaveLength(count));
    };

    await send(1);
    await send(2);
    // The owner corrects a card before pressing again.
    mockEditorWords.text = "Corrected words";
    await send(3);

    expect(posts[1]!.requestId).toBe(posts[0]!.requestId);
    expect(posts[2]!.requestId).not.toBe(posts[0]!.requestId);
    expect(posts[2]).toMatchObject({
      components: [{ type: "BODY", text: "Corrected words" }],
    });
    await waitFor(() =>
      expect(screen.queryByTestId("carousel-editor")).toBeNull()
    );
  });

  test("when Meta had the first carousel after all, the edits stay and the kit says so", async () => {
    const failed: ProductKitRecord = {
      ...madeKit,
      parts: {
        ...madeKit.parts,
        carousel: {
          ...madeKit.parts.carousel!,
          state: "failed",
          templateId: null,
          metaStatus: null,
          error: { code: "timed_out", message: null },
        },
      },
      status: "needs_attention",
    };
    routes[planUrl()] = () => respond(200, plan({ latestKit: failed }));
    routes[`POST ${kitUrl}/edit`] = init => {
      posts.push(JSON.parse(String(init?.body)));
      return respond(409, {
        error: "x",
        code: "carousel_found",
        kit: madeKit,
      });
    };
    renderMake();
    const card = await kitCard();

    fireEvent.click(
      within(card).getByRole("button", { name: "Edit and try again" })
    );
    const editor = await screen.findByTestId("carousel-editor");
    fireEvent.click(
      within(editor).getByRole("button", { name: "Send to Meta for review" })
    );

    expect(
      await screen.findByText(
        "Meta did get your first carousel after all; it's with Meta now. Your edits weren't sent. To send them as a new template, press Send to Meta for review again."
      )
    ).toBeVisible();
    // Said once, by the banner; the sheet stays open with the edits, and the
    // kit shows the found carousel.
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("carousel-editor")).toBeVisible();
    expect(await within(card).findByText("With Meta")).toBeInTheDocument();
  });
});

test("Meta refusing the edited carousel says so in its words under the button, not in a toast over it, and the sheet keeps the edits", async () => {
  mockCreateErrors.length = 0;
  routes[planUrl()] = () => respond(200, plan({ latestKit: madeKit }));
  routes[`GET ${BASE}/${madeKit.id}/edit?part=carousel`] = () =>
    respond(200, {
      kit: madeKit,
      carousel: {
        name: "products_20261103_120000",
        language: "kk",
        components: [{ type: "BODY", text: "Sent words" }],
      },
    });
  routes[`POST ${BASE}/${madeKit.id}/edit`] = () =>
    respond(409, {
      error: "x",
      code: "meta_refused",
      issues: ["Template name already exists in this language."],
      kit: madeKit,
    });
  renderMake();
  const card = await kitCard();

  fireEvent.click(
    within(card).getByRole("button", { name: "Edit and send again" })
  );
  const editor = await screen.findByTestId("carousel-editor");
  fireEvent.click(
    within(editor).getByRole("button", { name: "Send to Meta for review" })
  );

  const alert = await within(screen.getByRole("dialog")).findByRole("alert");
  expect(alert).toHaveTextContent(
    "Meta refused it: Template name already exists in this language. Change the template name and send again."
  );
  // In the sheet, after the editor and its buttons.
  expect(
    screen.getByTestId("carousel-editor").compareDocumentPosition(alert) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(mockCreateErrors).toEqual([]);
  expect(screen.getByTestId("carousel-editor")).toBeVisible();

  // Sent again, the old words go while it's sent.
  const answered: { now?: () => void } = {};
  routes[`POST ${BASE}/${madeKit.id}/edit`] = () =>
    new Promise<Response>(resolve => {
      answered.now = () => resolve(respond(200, { kit: madeKit }));
    });
  fireEvent.click(
    within(editor).getByRole("button", { name: "Send to Meta for review" })
  );
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull()
  );
  await waitFor(() => expect(answered.now).toBeDefined());
  answered.now!();
  await waitFor(() =>
    expect(screen.queryByTestId("carousel-editor")).toBeNull()
  );
});

test("Send me the order form sends the published form to the test phone, and says why not when it can't", async () => {
  routes[planUrl()] = () => respond(200, plan({ latestKit: madeKit }));
  let answer = respond(200, { sent: true });
  routes[`POST ${BASE}/${madeKit.id}/send-test`] = init => {
    posts.push(JSON.parse(String(init?.body)));
    return answer;
  };
  renderMake();
  const card = await kitCard();

  fireEvent.click(
    within(card).getByRole("button", { name: "Send me the order form" })
  );
  expect(await within(card).findByRole("status")).toHaveTextContent(
    "Sent to your test number. Open WhatsApp to try the form."
  );
  expect(posts).toEqual([{ part: "orderForm" }]);

  answer = respond(409, { error: "x", code: "test_phone_missing" });
  fireEvent.click(
    within(card).getByRole("button", { name: "Send me the order form" })
  );
  expect(await within(card).findByRole("alert")).toHaveTextContent(
    "Add your test number in a campaign's Test send first."
  );
});
