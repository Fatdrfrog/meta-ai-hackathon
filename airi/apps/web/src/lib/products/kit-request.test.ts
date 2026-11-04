import {
  parseProductKitDraftsRequest,
  parseProductKitEditRequest,
  parseProductKitRequest,
} from "./kit-request";

// What the kit routes take for v2's editing: the edits on a press, the
// drafts "Edit cards" opens before Make, and an edit sent after it.

const ID_1 = "651f1f77bcf86cd799439011";
const ID_2 = "651f1f77bcf86cd799439012";
const REQUEST = "6f1d8a2e-5c1b-4f7e-9d3a-0b2c4e6f8a10";

const cards = [
  { type: "BODY", text: "Hi" },
  { type: "CAROUSEL", cards: [] },
];
const config = { templateId: "products_order_form", screens: [] };

describe("parseProductKitRequest: edits", () => {
  const press = {
    requestId: REQUEST,
    productIds: [ID_1, ID_2],
    make: { carousel: true, orderForm: true },
  };

  it("takes no edits as none", () => {
    expect(parseProductKitRequest(press)).toMatchObject({ edits: null });
    expect(parseProductKitRequest({ ...press, edits: null })).toMatchObject({
      edits: null,
    });
    expect(parseProductKitRequest({ ...press, edits: {} })).toMatchObject({
      edits: null,
    });
  });

  it("takes the cards and the questions by their shape, leaving their content to the kit's checks", () => {
    expect(
      parseProductKitRequest({
        ...press,
        edits: {
          carousel: { name: "products_x", components: cards },
          orderForm: { config },
        },
      })
    ).toMatchObject({
      edits: {
        carousel: { name: "products_x", components: cards },
        orderForm: { config },
      },
    });
  });

  it("refuses an edit for a part the press doesn't make", () => {
    expect(
      parseProductKitRequest({
        ...press,
        make: { carousel: false, orderForm: true },
        edits: { carousel: { name: "products_x", components: cards } },
      })
    ).toBeNull();
    expect(
      parseProductKitRequest({
        ...press,
        make: { carousel: true, orderForm: false },
        edits: { orderForm: { config } },
      })
    ).toBeNull();
  });

  it("refuses edits of any other shape", () => {
    for (const edits of [
      "cards",
      [],
      { banner: {} },
      { carousel: { name: 7, components: cards } },
      { carousel: { name: "products_x", components: "cards" } },
      { carousel: { name: "products_x", components: cards, extra: 1 } },
      { orderForm: { config: [] } },
      { orderForm: { config, flowId: "flow-1" } },
    ])
      expect(parseProductKitRequest({ ...press, edits })).toBeNull();
  });
});

describe("parseProductKitDraftsRequest", () => {
  it("takes the products, each once, and the buyers' language", () => {
    expect(
      parseProductKitDraftsRequest({
        productIds: [ID_1, ID_2.toUpperCase(), ID_1],
        language: "kk",
      })
    ).toEqual({ productIds: [ID_1, ID_2], language: "kk" });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      { productIds: [], language: "kk" },
      { productIds: ["nope"], language: "kk" },
      { productIds: [ID_1], language: "de" },
      { productIds: [ID_1] },
      { productIds: [ID_1], language: "en", importId: ID_2 },
    ])
      expect(parseProductKitDraftsRequest(bad)).toBeNull();
  });
});

describe("parseProductKitEditRequest", () => {
  it("takes a carousel's name and cards, or a form's config", () => {
    expect(
      parseProductKitEditRequest({
        requestId: REQUEST,
        part: "carousel",
        name: "products_x",
        components: cards,
      })
    ).toEqual({
      requestId: REQUEST,
      part: "carousel",
      name: "products_x",
      components: cards,
    });
    expect(
      parseProductKitEditRequest({
        requestId: REQUEST,
        part: "orderForm",
        config,
      })
    ).toEqual({ requestId: REQUEST, part: "orderForm", config });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      { part: "carousel", name: "products_x", components: cards },
      { requestId: "x", part: "carousel", name: "a", components: cards },
      { requestId: REQUEST, part: "banner", config },
      { requestId: REQUEST, part: "carousel", config },
      { requestId: REQUEST, part: "orderForm", name: "a", components: cards },
      {
        requestId: REQUEST,
        part: "carousel",
        name: "a",
        components: cards,
        config,
      },
      { requestId: REQUEST, part: "orderForm", config: "form" },
    ])
      expect(parseProductKitEditRequest(bad)).toBeNull();
  });
});
