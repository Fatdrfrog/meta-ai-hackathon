/** @jest-environment node */

import { generateFlowJsonString } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
} from "@icecore/scenario-contracts";
import {
  buildOrderFormFlowConfig,
  checkOrderFormConfig,
  ORDER_FORM_MAX_JSON_BYTES,
  parseOrderFormConfig,
  type OrderFormProduct,
} from "./order-form-config";

const product = (index: number): OrderFormProduct => ({
  id: `651f1f77bcf86cd7994390${String(10 + index)}`,
  name: `Шежіре ${index}`,
  price: 15500,
  currency: "KZT",
  priceIsFrom: false,
});

const products = Array.from({ length: 22 }, (_, index) => product(index + 1));
const productIds = products.map(entry => entry.id);

/** The shelf's form, with its first screen changed by `change`. */
function edited(
  change: (fields: WhatsAppFlowFieldConfig[]) => WhatsAppFlowFieldConfig[]
): WhatsAppFlowConfig {
  const config = buildOrderFormFlowConfig(products, "kk");
  return {
    ...config,
    screens: [
      { ...config.screens[0]!, fields: change(config.screens[0]!.fields) },
    ],
  };
}

const productsField = (fields: WhatsAppFlowFieldConfig[]) =>
  fields.find(field => field.id === "products")!;

describe("buildOrderFormFlowConfig", () => {
  it("lists the first 20 products by id, then the buyer's details", () => {
    const config = buildOrderFormFlowConfig(products, "Kazakh");
    const fields = config.screens[0]!.fields;
    expect(fields.map(field => field.id)).toEqual([
      "products",
      "name",
      "address",
      "comment",
    ]);
    expect(productsField(fields).options!.map(option => option.id)).toEqual(
      productIds.slice(0, 20)
    );
  });

  it("takes a make view's plan product, which has more than the form reads", () => {
    const planProduct = {
      ...product(1),
      hasPhoto: true,
      hasCutout: false,
      imageUrl: null,
    };
    expect(
      buildOrderFormFlowConfig([planProduct], "en").screens[0]!.fields[0]!
        .options
    ).toEqual([
      {
        id: planProduct.id,
        title: "Шежіре 1",
        description: expect.any(String),
      },
    ]);
  });
});

describe("parseOrderFormConfig / checkOrderFormConfig", () => {
  it("passes the shelf's own form, in each language", () => {
    for (const language of ["kk", "ru", "en"]) {
      const config = buildOrderFormFlowConfig(products, language);
      expect(checkOrderFormConfig(config, productIds)).toEqual([]);
    }
  });

  it("passes the owner's own questions, renamed products and a new radio", () => {
    const config = edited(fields => [
      {
        ...productsField(fields),
        label: "What would you like?",
        options: productsField(fields).options!.map(option => ({
          ...option,
          title: `${option.title}!`,
        })),
      },
      ...fields.slice(1),
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
    ]);
    const parsed = parseOrderFormConfig(config, productIds);
    expect(parsed.ok).toBe(true);
  });

  it("gives back the form as JSON, without a link to any Meta Flow", () => {
    const parsed = parseOrderFormConfig(
      {
        ...buildOrderFormFlowConfig(products, "ru"),
        metaFlowId: "flow-1",
        metaFlowName: "Old",
        metaFlowStatus: "PUBLISHED",
      },
      productIds
    );
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    expect(parsed.config).not.toHaveProperty("metaFlowId");
    expect(parsed.config).not.toHaveProperty("metaFlowName");
    expect(JSON.parse(JSON.stringify(parsed.config))).toEqual(parsed.config);
    // What goes to Meta is the same form.
    expect(generateFlowJsonString(parsed.config)).toBe(
      generateFlowJsonString(buildOrderFormFlowConfig(products, "ru"))
    );
  });

  it("refuses a form without the products question", () => {
    const config = edited(fields => fields.slice(1));
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "The products question is missing: it lists your shelf products.",
    ]);
  });

  it("refuses the products question on another screen", () => {
    const shelf = buildOrderFormFlowConfig(products, "en");
    const [first] = shelf.screens;
    const config: WhatsAppFlowConfig = {
      ...shelf,
      screens: [
        { id: "HELLO", title: "Hello", fields: first!.fields.slice(1) },
        { id: "ORDER", title: "Order", fields: first!.fields.slice(0, 1) },
      ],
    };
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "The products question has to be on the first screen.",
    ]);
  });

  it("refuses the products question as another kind of question", () => {
    const config = edited(fields => [
      { ...productsField(fields), fieldType: "RadioButtonsGroup" },
      ...fields.slice(1),
    ]);
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "The products question has to stay a list of tick boxes.",
    ]);
  });

  it("refuses an option that isn't one of the kit's products", () => {
    const config = edited(fields => [
      {
        ...productsField(fields),
        options: [
          ...productsField(fields).options!.slice(0, 3),
          { id: "651f1f77bcf86cd799439999", title: "Someone else's" },
        ],
      },
      ...fields.slice(1),
    ]);
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "An option in the products question isn't one of this kit's products.",
    ]);
  });

  it("refuses a product listed twice", () => {
    const config = edited(fields => {
      const options = productsField(fields).options!;
      return [
        { ...productsField(fields), options: [options[0]!, options[0]!] },
        ...fields.slice(1),
      ];
    });
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "A product is listed twice in the products question.",
    ]);
  });

  it("refuses more than 20 products, and none", () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      id: productIds[index]!,
      title: `P${index}`,
    }));
    for (const options of [many, []]) {
      const config = edited(fields => [
        { ...productsField(fields), options },
        ...fields.slice(1),
      ]);
      expect(checkOrderFormConfig(config, productIds)).toEqual([
        "The products question lists 1 to 20 products.",
      ]);
    }
  });

  it("refuses a data endpoint in any of its forms", () => {
    const shelf = buildOrderFormFlowConfig(products, "en");
    const endpointForms: WhatsAppFlowConfig[] = [
      { ...shelf, flowNavigationMode: "data_endpoint" },
      { ...shelf, endpointUri: "https://example.test/flow" },
      { ...shelf, applicationId: "app-1" },
    ];
    for (const config of endpointForms)
      expect(checkOrderFormConfig(config, productIds)).toEqual([
        "An order form can't use a data endpoint: it stays on WhatsApp.",
      ]);
  });

  it("refuses a form too big for WhatsApp", () => {
    // Long option descriptions on a second screen: valid, but over 64 KB.
    const shelf = buildOrderFormFlowConfig(products, "en");
    const dropdown = (id: string): WhatsAppFlowFieldConfig => ({
      id,
      label: "Pick one",
      fieldType: "Dropdown",
      required: false,
      options: Array.from({ length: 200 }, (_, index) => ({
        id: `${id}_${index}`,
        title: `Choice ${index}`,
        description: "x".repeat(290),
      })),
    });
    const config: WhatsAppFlowConfig = {
      ...shelf,
      screens: [
        shelf.screens[0]!,
        {
          id: "MORE",
          title: "More",
          fields: [dropdown("first"), dropdown("second")],
        },
      ],
    };
    expect(generateFlowJsonString(config).length).toBeGreaterThan(
      ORDER_FORM_MAX_JSON_BYTES
    );
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "The order form is too big for WhatsApp: shorten it.",
    ]);
  });

  it("refuses more than 10 screens and more than 50 questions", () => {
    const shelf = buildOrderFormFlowConfig(products, "en");
    const text = (id: string): WhatsAppFlowFieldConfig => ({
      id,
      label: "Note",
      fieldType: "TextInput",
    });
    const screens: WhatsAppFlowConfig = {
      ...shelf,
      screens: [
        shelf.screens[0]!,
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `S_${"abcdefghij"[index]}`,
          title: "More",
          fields: [text(`note_${index}`)],
        })),
      ],
    };
    expect(checkOrderFormConfig(screens, productIds)).toEqual([
      "An order form has at most 10 screens.",
    ]);
    const questions = edited(fields => [
      ...fields,
      ...Array.from({ length: 47 }, (_, index) => text(`note_${index}`)),
    ]);
    expect(checkOrderFormConfig(questions, productIds)).toEqual([
      "An order form has at most 50 questions.",
    ]);
  });

  it("names the Flow editor's own checks in words, with their screen", () => {
    const config = edited(fields => [
      fields[0]!,
      { ...fields[1]!, label: "A question far too long for WhatsApp" },
      ...fields.slice(2),
    ]);
    expect(checkOrderFormConfig(config, productIds)).toEqual([
      "Screen 1: A question's text is too long for WhatsApp.",
    ]);
  });

  it("refuses what isn't a form at all", () => {
    for (const value of [
      null,
      "form",
      [],
      { screens: "no" },
      { screens: [{ layoutForm: { name: 4 } }] },
    ])
      expect(parseOrderFormConfig(value, productIds)).toEqual({
        ok: false,
        issues: ["This isn't an order form."],
      });
  });
});
