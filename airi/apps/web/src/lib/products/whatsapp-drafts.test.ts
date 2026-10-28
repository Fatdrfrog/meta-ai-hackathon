/** @jest-environment node */

const mockImportFindOne = jest.fn();
const mockProductFind = jest.fn();
const mockStore = jest.fn();
const mockCreateFlow = jest.fn();
const mockUpdateFlow = jest.fn();
const mockDeleteFlow = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    findOne: (...args: unknown[]) => mockImportFindOne(...args),
  },
}));
jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: { find: (...args: unknown[]) => mockProductFind(...args) },
}));
jest.mock("@/lib/whatsapp/templates/header-media-storage", () => ({
  storeWhatsAppTemplateHeaderMedia: (...args: unknown[]) => mockStore(...args),
}));
jest.mock("@/lib/whatsapp/flows/service", () => ({
  createMetaWhatsAppFlow: (...args: unknown[]) => mockCreateFlow(...args),
  updateMetaWhatsAppFlow: (...args: unknown[]) => mockUpdateFlow(...args),
  deleteMetaWhatsAppFlow: (...args: unknown[]) => mockDeleteFlow(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));
jest.mock("@/lib/products/photo-urls", () => ({
  withProductPhotoUrls: (work: () => Promise<unknown>) => work(),
  productPhotoUrl: async (
    _workspaceId: string,
    ref: { path?: string } | null | undefined
  ) => (ref?.path ? `https://signed.test/${ref.path}` : null),
}));

import { generateFlowJson } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import { validateWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-validation";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import sharp from "sharp";
import {
  buildOrderFormFlowConfig,
  createOrderFormDraft,
  loadAddedProducts,
  prepareCarouselDraft,
  shopWords,
  whiteCardImage,
  type AddedProduct,
} from "./whatsapp-drafts";

const workspaceId = "workspace-1";
const importId = "651f1f77bcf86cd799439040";

const product = (
  index: number,
  overrides: Partial<AddedProduct> = {}
): AddedProduct => ({
  id: `651f1f77bcf86cd7994390${String(10 + index)}`,
  name: `Шежіре ${index}`,
  price: 15500,
  priceIsFrom: false,
  photo: { cutout: { bucket: "media", path: `p${index}/cutout.png` } },
  ...overrides,
});

/** A small transparent PNG with a red block in the middle, like a cut-out. */
async function cutoutPng(): Promise<Buffer> {
  const block = await sharp({
    create: {
      width: 60,
      height: 120,
      channels: 4,
      background: { r: 220, g: 20, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: 200,
      height: 300,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: block, gravity: "centre" }])
    .png()
    .toBuffer();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.mockImplementation(async ({ fileName }: { fileName: string }) => ({
    url: `https://cdn.test/business-media/${fileName}`,
    bucket: "business-media",
    path: fileName,
  }));
});

describe("shopWords", () => {
  it("writes for buyers in the language the owner spoke, English otherwise", () => {
    expect(shopWords("Kazakh").code).toBe("kk");
    expect(shopWords("kk").code).toBe("kk");
    expect(shopWords("Russian").code).toBe("ru");
    expect(shopWords("Kazakh and Russian").code).toBe("kk");
    expect(shopWords("Uzbek").code).toBe("en");
    expect(shopWords(null).code).toBe("en");
  });
});

describe("loadAddedProducts", () => {
  it("lists the import's published products in filmed order, with the featured item's photo", async () => {
    mockImportFindOne.mockReturnValue({
      select: () => ({ lean: async () => ({ language: "Kazakh" }) }),
    });
    const query = {
      sort: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: "p1",
          name: "Шежіре",
          price: 15500,
          priceIsFrom: true,
          featuredOption: 1,
          options: [
            { photo: { cutout: { bucket: "media", path: "a.png" } } },
            {
              photo: {
                cutout: { bucket: "media", path: "b.png" },
                original: { bucket: "media", path: "b.jpg" },
              },
            },
          ],
        },
        { _id: "p2", name: "Медаль", price: null, options: [{}] },
      ]),
    };
    mockProductFind.mockReturnValue(query);

    expect(await loadAddedProducts(workspaceId, importId)).toEqual({
      language: "Kazakh",
      products: [
        {
          id: "p1",
          name: "Шежіре",
          price: 15500,
          priceIsFrom: true,
          photo: {
            cutout: { bucket: "media", path: "b.png" },
            original: { bucket: "media", path: "b.jpg" },
          },
        },
        {
          id: "p2",
          name: "Медаль",
          price: null,
          priceIsFrom: false,
          photo: null,
        },
      ],
    });
    expect(mockImportFindOne).toHaveBeenCalledWith({
      _id: importId,
      workspaceId,
    });
    expect(mockProductFind).toHaveBeenCalledWith({
      workspaceId,
      importId,
      status: "published",
    });
    expect(query.sort).toHaveBeenCalledWith({ importIndex: 1, _id: 1 });
  });

  it("finds nothing in another workspace", async () => {
    mockImportFindOne.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    expect(await loadAddedProducts(workspaceId, importId)).toBeNull();
    expect(mockProductFind).not.toHaveBeenCalled();
  });
});

describe("whiteCardImage", () => {
  it("centres a cut-out, trimmed, on a white square JPEG", async () => {
    const card = await whiteCardImage(await cutoutPng(), "cutout");
    const { data, info } = await sharp(card)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(info).toMatchObject({ width: 1080, height: 1080, channels: 3 });
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3));
    expect(pixel(5, 5).every(value => value > 245)).toBe(true);
    const [red, green] = pixel(540, 540);
    expect(red).toBeGreaterThan(180);
    expect(green).toBeLessThan(80);
    // Trimmed to the block, it fills 80% of the height.
    expect(pixel(540, 120)[1]).toBeLessThan(80);
  });
});

describe("prepareCarouselDraft", () => {
  beforeEach(async () => {
    const png = await cutoutPng();
    global.fetch = jest.fn(
      async () => new Response(new Uint8Array(png))
    ) as unknown as typeof fetch;
  });

  it("makes up to 10 cards with a picture, the name and price, and an order button", async () => {
    const products = [
      product(1, { priceIsFrom: true }),
      product(2, { photo: null }),
      ...Array.from({ length: 10 }, (_, index) => product(index + 3)),
    ];

    const draft = await prepareCarouselDraft(
      workspaceId,
      { language: "Russian", products },
      new Date("2026-10-28T14:32:09Z")
    );

    expect(draft).toMatchObject({
      name: "products_20261028_1432",
      language: "ru",
      bodyText: "Наши товары. Выберите, что понравится, и закажите.",
      leftOut: 2,
    });
    expect(draft!.cards).toHaveLength(10);
    expect(draft!.cards[0]).toEqual({
      productId: products[0]!.id,
      imageUrl: `https://cdn.test/business-media/product-${products[0]!.id}.jpg`,
      bodyText: "Шежіре 1\nот 15 500 ₸",
      buttonText: "Заказать",
    });
    // The product without a photo has no card.
    expect(draft!.cards.map(card => card.productId)).not.toContain(
      products[1]!.id
    );
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, mimeType: "image/jpeg" })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://signed.test/p1/cutout.png",
      expect.anything()
    );
  });

  it("leaves out a product whose photo won't load, and needs two cards", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      async () => new Response("gone", { status: 404 })
    );

    expect(
      await prepareCarouselDraft(workspaceId, {
        language: "Kazakh",
        products: [product(1), product(2)],
      })
    ).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      "[Products] carousel card picture failed",
      expect.objectContaining({ event: "products.carousel_picture_failed" })
    );
  });

  it("stops when the company's storage is full", async () => {
    mockStore.mockRejectedValue(
      new StorageQuotaError("company_storage_limit_exceeded", "Full")
    );

    await expect(
      prepareCarouselDraft(workspaceId, {
        language: null,
        products: [product(1), product(2)],
      })
    ).rejects.toBeInstanceOf(StorageQuotaError);
  });
});

describe("buildOrderFormFlowConfig", () => {
  it("lists up to 20 products with their prices, then the buyer's details, in the owner's language", () => {
    const products = Array.from({ length: 22 }, (_, index) =>
      product(index + 1, {
        name:
          index === 0
            ? "Есімі жазылған медаль ілгіш, ағаш, үш қатар"
            : `Шежіре ${index + 1}`,
        priceIsFrom: index === 0,
        price: index === 1 ? null : 16900,
      })
    );

    const config = buildOrderFormFlowConfig(products, "Kazakh");

    expect(validateWhatsAppFlowConfig(config)).toEqual({
      isValid: true,
      issues: [],
    });
    const [screen] = config.screens;
    const [list, name, address, comment] = screen!.fields;
    expect(screen!.title).toBe("Тапсырыс");
    expect(list).toMatchObject({
      id: "products",
      label: "Не алғыңыз келеді?",
      fieldType: "CheckboxGroup",
      required: true,
    });
    expect(list!.options).toHaveLength(20);
    expect(list!.options![0]).toEqual({
      id: products[0]!.id,
      title: "Есімі жазылған медаль ілгіш…",
      description: "16 900 ₸ бастап",
    });
    expect(list!.options![1]).toEqual({
      id: products[1]!.id,
      title: "Шежіре 2",
    });
    expect(
      [name, address, comment].map(field => [field!.id, field!.required])
    ).toEqual([
      ["name", true],
      ["address", false],
      ["comment", false],
    ]);

    // As Meta receives it: one screen that completes with every answer.
    const json = generateFlowJson(config);
    const form = json.screens[0]!.layout.children[0]!;
    const footer = form.children!.at(-1)!;
    expect(json.version).toBe("6.3");
    expect(json.screens[0]).toMatchObject({ id: "ORDER", terminal: true });
    expect(footer).toMatchObject({
      type: "Footer",
      label: "Тапсырысты жіберу",
      "on-click-action": {
        name: "complete",
        payload: {
          products: "${form.products}",
          name: "${form.name}",
          address: "${form.address}",
          comment: "${form.comment}",
        },
      },
    });
  });
});

describe("createOrderFormDraft", () => {
  const params = {
    accessToken: "token",
    wabaId: "waba-1",
    products: [product(1), product(2)],
    language: "Russian",
    now: new Date("2026-10-28T14:32:09Z"),
  };

  it("creates an empty draft Flow, then gives it the form", async () => {
    mockCreateFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: { id: "flow-1" },
    });
    mockUpdateFlow.mockResolvedValue({ ok: true, status: 200 });

    expect(await createOrderFormDraft(params)).toEqual({
      ok: true,
      flowId: "flow-1",
      name: "Order form 2026-10-28 14:32",
      leftOut: 0,
    });
    expect(mockCreateFlow).toHaveBeenCalledWith({
      accessToken: "token",
      wabaId: "waba-1",
      name: "Order form 2026-10-28 14:32",
      categories: ["OTHER"],
    });
    const update = mockUpdateFlow.mock.calls[0]![0];
    expect(update).toMatchObject({
      accessToken: "token",
      flowId: "flow-1",
      operation: "update_json",
    });
    expect(JSON.parse(update.flowJson).screens[0].id).toBe("ORDER");
    expect(mockDeleteFlow).not.toHaveBeenCalled();
  });

  it("deletes a draft Meta refused the form for, rather than leave it broken", async () => {
    mockCreateFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: { id: "flow-1" },
    });
    mockUpdateFlow.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Flow JSON validation failed",
    });
    mockDeleteFlow.mockResolvedValue({ ok: true, status: 200 });

    expect(await createOrderFormDraft(params)).toEqual({
      ok: false,
      error: "Flow JSON validation failed",
    });
    expect(mockDeleteFlow).toHaveBeenCalledWith({
      accessToken: "token",
      flowId: "flow-1",
    });
  });

  it("reports a Flow Meta wouldn't create, cleaning up one it half made", async () => {
    mockCreateFlow.mockResolvedValue({
      ok: false,
      status: 502,
      providerFlowId: "flow-2",
      error: "Readback failed",
    });
    mockDeleteFlow.mockResolvedValue({ ok: true, status: 200 });

    expect(await createOrderFormDraft(params)).toEqual({
      ok: false,
      error: "Readback failed",
    });
    expect(mockUpdateFlow).not.toHaveBeenCalled();
    expect(mockDeleteFlow).toHaveBeenCalledWith({
      accessToken: "token",
      flowId: "flow-2",
    });
  });
});
