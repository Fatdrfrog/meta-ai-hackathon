/** @jest-environment node */

const mockProductFind = jest.fn();
const mockImportFind = jest.fn();
const mockWhatsApp = jest.fn();
const mockCreateOrderForm = jest.fn();
const mockPrepareCarousel = jest.fn();
const mockUpdateFlow = jest.fn();
const mockCreateTemplate = jest.fn();
const mockGetTemplate = jest.fn();
const mockFindTemplate = jest.fn();
const mockGetFlow = jest.fn();
const mockTemplateRows = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockSupabase = { client: "the owner's session" };

jest.mock("@/models/product-kit", () => ({
  PRODUCT_KIT_COMPONENTS_MAX_BYTES: 16 * 1024,
  PRODUCT_KIT_EARLIER_MAX: 10,
  ProductKit: {
    findOne: (filter: Filter) => mockKits.findOne(filter),
    find: (filter: Filter) => mockKits.find(filter),
    create: (input: Stored) => mockKits.create(input),
    updateOne: (filter: Filter, update: { $set?: Stored }) =>
      mockKits.updateOne(filter, update),
  },
}));
jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: { find: (...args: unknown[]) => mockProductFind(...args) },
}));
jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    find: (...args: unknown[]) => mockImportFind(...args),
    findOne: jest.fn(),
  },
}));
jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) => mockWhatsApp(...args),
}));
jest.mock("@/lib/products/whatsapp-drafts", () => ({
  ...jest.requireActual("@/lib/products/whatsapp-drafts"),
  createOrderFormDraft: (...args: unknown[]) => mockCreateOrderForm(...args),
  prepareCarouselDraft: (...args: unknown[]) => mockPrepareCarousel(...args),
}));
jest.mock("@/lib/whatsapp/templates/header-media-storage", () => ({
  storeWhatsAppTemplateHeaderMedia: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/service", () => ({
  createMetaWhatsAppFlow: jest.fn(),
  deleteMetaWhatsAppFlow: jest.fn(),
  getMetaWhatsAppFlow: (...args: unknown[]) => mockGetFlow(...args),
  updateMetaWhatsAppFlow: (...args: unknown[]) => mockUpdateFlow(...args),
}));
jest.mock("@/lib/whatsapp/templates/unified-service", () => {
  class WhatsAppTemplateRecordPersistenceError extends Error {
    readonly metaTemplateId: string;
    readonly metaTemplateStatus: string;
    constructor(message: string, result: { id: string; status: string }) {
      super(message);
      this.metaTemplateId = result.id;
      this.metaTemplateStatus = result.status;
    }
  }
  return {
    createUnifiedTemplateRecord: (...args: unknown[]) =>
      mockCreateTemplate(...args),
    WhatsAppTemplateRecordPersistenceError,
  };
});
jest.mock("@/lib/whatsapp/templates/service", () => ({
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
  findWhatsAppTemplateByName: (...args: unknown[]) => mockFindTemplate(...args),
  WHATSAPP_TEMPLATE_CAROUSEL_CREATE_TIMEOUT_MS: 25_000,
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabase,
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, workspaceId: string) => ({
          in: (_column: string, ids: string[]) =>
            mockTemplateRows({ table, column, workspaceId, ids }),
        }),
      }),
    }),
  },
}));
jest.mock("@/lib/products/photo-urls", () => ({
  withProductPhotoUrls: (work: () => Promise<unknown>) => work(),
  productPhotoUrl: async (
    _workspaceId: string,
    ref: { path?: string } | null | undefined
  ) => (ref?.path ? `https://signed.test/${ref.path}` : null),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
  },
}));

import { WhatsAppTemplateGraphRefusalError } from "@/lib/whatsapp/templates/graph-response";
import { WhatsAppTemplateRecordPersistenceError } from "@/lib/whatsapp/templates/unified-service";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import { Types } from "mongoose";
import { carouselTemplateComponents } from "./carousel-components";
import { parseProductKitRequest, type ProductKitRequest } from "./kit-request";
import {
  carouselTemplateName,
  editProductKitPart,
  listProductKitRecords,
  loadShelfProducts,
  makeProductKit,
  orderFormName,
  prepareProductKitDrafts,
  productKitEditSource,
  readProductKit,
  readProductKitPlan,
  retryProductKitPart,
} from "./kits";
import { buildOrderFormFlowConfig } from "./order-form-config";
import { deleteMetaWhatsAppFlow } from "@/lib/whatsapp/flows/service";
import type { ProductCarouselDraft, ProductKitDraftsResponse } from "./types";

// Kits: a carousel sent to Meta and a published order form, made by one
// press, each part saved as it settles.

type Stored = Record<string, unknown>;
type Filter = Record<string, unknown>;

const mockKits = fakeKitStore();

const WS = "workspace-1";
const productId = (n: number) =>
  `651f1f77bcf86cd7994390${String(n).padStart(2, "0")}`;
const OLD_IMPORT = "651f1f77bcf86cd799439101";
const NEW_IMPORT = "651f1f77bcf86cd799439102";
const CONNECTED = {
  context: {
    accessToken: "token",
    wabaId: "waba-1",
    credentials: { displayPhoneNumber: "shop-number" },
  },
};
const ago = (ms: number) => new Date(Date.now() - ms);

type ShelfRow = Stored & { _id: Types.ObjectId; status?: string };

function shelfRow(n: number, overrides: Stored = {}): ShelfRow {
  return {
    _id: new Types.ObjectId(productId(n)),
    name: `Шежіре ${n}`,
    price: 15500,
    currency: "KZT",
    priceIsFrom: false,
    importId: new Types.ObjectId(OLD_IMPORT),
    featuredOption: 0,
    options: [
      {
        photo: {
          cutout: { bucket: "media", path: `p${n}/cutout.png` },
          thumb: { bucket: "media", path: `p${n}/thumb.webp` },
        },
      },
    ],
    ...overrides,
  };
}

let shelf: ShelfRow[];
let imports: Array<{ _id: string; language: string | null; createdAt: Date }>;

function chain(result: () => unknown) {
  const query = {
    sort: () => query,
    limit: () => query,
    select: () => query,
    lean: async () => result(),
  };
  return query;
}

const press = (
  overrides: Partial<ProductKitRequest> = {}
): ProductKitRequest => ({
  requestId: "press-0001",
  productIds: [productId(1), productId(2), productId(3)],
  importId: null,
  make: { carousel: true, orderForm: true },
  language: null,
  timeZone: "Asia/Tokyo",
  edits: null,
  ...overrides,
});

const make = (overrides: Partial<ProductKitRequest> = {}) =>
  makeProductKit({
    workspaceId: WS,
    userId: "user-1",
    request: press(overrides),
  });

/** An error as createUnifiedTemplateRecord rethrows what the create threw. */
const wrapped = (cause: Error) =>
  new Error(`WhatsApp API error: ${cause.message}`, { cause });

/** Lets every pending promise run. */
async function flush(rounds = 10) {
  for (let round = 0; round < rounds; round += 1)
    await new Promise(resolve => setImmediate(resolve));
}

function draftFor(added: {
  language: string;
  products: Array<{ id: string; name: string; photo: unknown }>;
}): ProductCarouselDraft {
  return {
    name: "products_20261102_0914",
    language: added.language,
    bodyText: "Біздің тауарлар. Ұнағанын таңдап, тапсырыс беріңіз.",
    cards: added.products
      .filter(product => product.photo)
      .slice(0, 10)
      .map(product => ({
        productId: product.id,
        imageUrl: `https://cdn.test/business-media/product-${product.id}.jpg`,
        bodyText: product.name,
        buttonText: "Тапсырыс беру",
      })),
    leftOut: 0,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKits.reset();
  shelf = [shelfRow(1), shelfRow(2), shelfRow(3)];
  imports = [
    { _id: OLD_IMPORT, language: "Kazakh", createdAt: new Date("2026-10-30") },
  ];
  mockProductFind.mockImplementation(
    (filter: { _id: { $in: string[] }; status: string }) =>
      chain(() =>
        shelf.filter(
          row =>
            filter._id.$in.includes(String(row._id)) &&
            (row.status ?? "published") === filter.status
        )
      )
  );
  mockImportFind.mockImplementation((filter: { _id: { $in: string[] } }) =>
    chain(() =>
      imports
        .filter(found => filter._id.$in.includes(found._id) && found.language)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 1)
    )
  );
  mockWhatsApp.mockResolvedValue(CONNECTED);
  // As createOrderFormDraft does: a new Flow is told before its JSON goes.
  mockCreateOrderForm.mockImplementation(
    async (params: {
      name: string;
      flowId?: string;
      onCreated?: (flowId: string) => Promise<void> | void;
    }) => {
      if (!params.flowId) await params.onCreated?.("flow-1");
      return {
        ok: true,
        flowId: params.flowId ?? "flow-1",
        name: params.name,
        leftOut: 0,
      };
    }
  );
  mockFindTemplate.mockResolvedValue(null);
  mockGetFlow.mockResolvedValue({ ok: false, status: 404, flow: null });
  mockUpdateFlow.mockResolvedValue({ ok: true, status: 200 });
  mockPrepareCarousel.mockImplementation(
    async (_workspaceId: string, added: Parameters<typeof draftFor>[0]) =>
      draftFor(added)
  );
  mockCreateTemplate.mockResolvedValue({
    id: "row-1",
    metaTemplateId: "tpl-1",
    metaTemplateStatus: "PENDING",
  });
  mockGetTemplate.mockResolvedValue({
    id: "tpl-1",
    name: "products_20261102_091405",
    language: "kk",
    status: "PENDING",
  });
  mockTemplateRows.mockResolvedValue({ data: [], error: null });
});

describe("parseProductKitRequest", () => {
  const body = {
    requestId: "6f1d8a2e-5c1b-4f7e-9d3a-0b2c4e6f8a10",
    productIds: [productId(1), productId(2).toUpperCase(), productId(1)],
    importId: NEW_IMPORT,
    make: { carousel: true, orderForm: false },
    language: "ru",
    timeZone: "Asia/Tokyo",
  };

  it("takes a press: each product once, the language and the owner's time zone", () => {
    expect(parseProductKitRequest(body)).toEqual({
      requestId: body.requestId,
      productIds: [productId(1), productId(2)],
      importId: NEW_IMPORT,
      make: { carousel: true, orderForm: false },
      language: "ru",
      timeZone: "Asia/Tokyo",
      edits: null,
    });
    expect(
      parseProductKitRequest({ ...body, timeZone: "Mars/Olympus" })
    ).toMatchObject({ timeZone: null });
    expect(
      parseProductKitRequest({
        ...body,
        importId: undefined,
        language: undefined,
      })
    ).toMatchObject({ importId: null, language: null });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      { ...body, requestId: "x" },
      { ...body, productIds: [] },
      { ...body, productIds: ["nope"] },
      {
        ...body,
        productIds: Array.from({ length: 61 }, (_, n) => productId(n)),
      },
      { ...body, importId: "nope" },
      { ...body, make: { carousel: false, orderForm: false } },
      { ...body, make: { carousel: "yes", orderForm: true } },
      { ...body, language: "de" },
    ])
      expect(parseProductKitRequest(bad)).toBeNull();
  });
});

describe("loadShelfProducts", () => {
  it("keeps the order asked, leaves out what isn't on this shelf, and reads the newest video's language", async () => {
    shelf = [
      shelfRow(1, { importId: new Types.ObjectId(OLD_IMPORT) }),
      shelfRow(2, { importId: new Types.ObjectId(NEW_IMPORT) }),
      shelfRow(3, { status: "draft" }),
    ];
    imports = [
      {
        _id: OLD_IMPORT,
        language: "Russian",
        createdAt: new Date("2026-10-30"),
      },
      {
        _id: NEW_IMPORT,
        language: "Kazakh",
        createdAt: new Date("2026-11-01"),
      },
    ];

    const loaded = await loadShelfProducts(WS, [
      productId(2),
      productId(3),
      productId(1),
      productId(9),
    ]);

    expect(loaded.language).toBe("Kazakh");
    expect(loaded.products.map(product => product.id)).toEqual([
      productId(2),
      productId(1),
    ]);
    expect(loaded.products[0]).toMatchObject({
      name: "Шежіре 2",
      price: 15500,
      currency: "KZT",
      importId: NEW_IMPORT,
      photo: { cutout: { bucket: "media", path: "p2/cutout.png" } },
      thumb: { bucket: "media", path: "p2/thumb.webp" },
    });
    expect(mockProductFind).toHaveBeenCalledWith({
      workspaceId: WS,
      _id: { $in: [productId(2), productId(3), productId(1), productId(9)] },
      status: "published",
    });
  });
});

describe("makeProductKit", () => {
  it("makes both parts at once, saving each as it settles", async () => {
    let releaseForm = () => {};
    mockCreateOrderForm.mockImplementation(
      (params: { name: string }) =>
        new Promise(resolve => {
          releaseForm = () =>
            resolve({
              ok: true,
              flowId: "flow-1",
              name: params.name,
              leftOut: 0,
            });
        })
    );

    const result = make();
    await flush();

    // The carousel went to Meta while the form was still being saved.
    expect(mockCreateOrderForm).toHaveBeenCalledTimes(1);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    const [stored] = mockKits.docs;
    expect(read(stored, "parts.carousel.state")).toBe("submitted");
    expect(read(stored, "parts.orderForm.state")).toBe("making");

    releaseForm();
    const made = await result;
    expect(made).toMatchObject({
      repeated: false,
      kit: {
        language: "kk",
        productIds: [productId(1), productId(2), productId(3)],
        importId: null,
        status: "waiting_for_meta",
        parts: {
          orderForm: {
            state: "ready",
            flowId: "flow-1",
            // On the owner's clock (their zone came with the press).
            flowName: expect.stringMatching(
              /^Order form · \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/
            ),
            productCount: 3,
            error: null,
          },
          carousel: {
            state: "submitted",
            templateId: "tpl-1",
            cardCount: 3,
            metaStatus: "PENDING",
            error: null,
          },
        },
      },
    });
    expect(mockUpdateFlow).toHaveBeenCalledWith({
      accessToken: "token",
      flowId: "flow-1",
      operation: "publish",
    });
  });

  it("sends the carousel through the template editor's path, as a products template", async () => {
    const { kit } = (await make()) as Awaited<ReturnType<typeof make>> & {
      kit: { parts: { carousel: { templateName: string } } };
    };

    const [call] = mockCreateTemplate.mock.calls[0]!;
    const draft = draftFor({
      language: "kk",
      products: shelf.map(row => ({
        id: String(row._id),
        name: String(row.name),
        photo: {},
      })),
    });
    expect(call).toEqual({
      supabase: mockSupabase,
      workspaceId: WS,
      userId: "user-1",
      name: kit.parts.carousel.templateName,
      channel: "whatsapp",
      whatsappData: {
        language: "kk",
        category: "MARKETING",
        components: carouselTemplateComponents(draft),
      },
      analyticsOrigin: "products",
      // Meta gets 25 s for a carousel, not the usual 10, within the kit's time.
      metaTimeoutMs: 25_000,
      metaDeadlineAt: expect.any(Number),
    });
    expect(kit.parts.carousel.templateName).toMatch(
      /^products_\d{8}_\d{6}_[0-9a-f]{6}$/
    );
    expect(read(mockKits.docs[0], "parts.carousel")).toMatchObject({
      templateRowId: "row-1",
      submittedAt: expect.any(Date),
      checkedAt: expect.any(Date),
    });
    // The prices it was made with, to tell when the shelf's change.
    expect(mockKits.docs[0]!.prices).toEqual(
      [1, 2, 3].map(n => ({
        productId: productId(n),
        price: 15500,
        currency: "KZT",
        priceIsFrom: false,
      }))
    );
  });

  it("checks first and writes nothing without products, a connected number, or photos for a carousel alone", async () => {
    shelf = [];
    expect(await make()).toEqual({ refused: "not_enough_products" });

    shelf = [shelfRow(1), shelfRow(2)];
    mockWhatsApp.mockResolvedValueOnce({ context: { credentials: {} } });
    expect(await make()).toEqual({ refused: "whatsapp_not_connected" });

    shelf = [shelfRow(1), shelfRow(2, { options: [{}] })];
    expect(await make({ make: { carousel: true, orderForm: false } })).toEqual({
      refused: "not_enough_products",
    });

    expect(mockKits.docs).toHaveLength(0);
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
    expect(mockPrepareCarousel).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("skips the carousel when both are asked and fewer than 2 products have photos", async () => {
    shelf = [
      shelfRow(1),
      shelfRow(2, { options: [] }),
      shelfRow(3, { options: [{}] }),
    ];

    const result = await make();

    expect(result).toMatchObject({
      kit: {
        status: "ready",
        parts: {
          orderForm: { state: "ready" },
          carousel: {
            state: "skipped",
            cardCount: 0,
            error: { code: "not_enough_products", message: null },
          },
        },
      },
    });
    expect(mockPrepareCarousel).not.toHaveBeenCalled();
  });

  it("answers the same press with the same kit, without making it again", async () => {
    const first = await make();
    const again = await make();

    expect(again).toEqual({
      repeated: true,
      kit: (first as { kit: unknown }).kit,
    });
    expect(mockKits.docs).toHaveLength(1);
    expect(mockCreateOrderForm).toHaveBeenCalledTimes(1);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("keeps a form Meta won't publish as a draft, with Meta's words", async () => {
    mockUpdateFlow.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Meta did not confirm the Flow as PUBLISHED",
    });

    const { kit } = (await make()) as { kit: Record<string, unknown> };

    expect(kit).toMatchObject({
      status: "needs_attention",
      parts: {
        orderForm: {
          state: "draft",
          flowId: "flow-1",
          error: {
            code: "meta_refused",
            message: "Meta did not confirm the Flow as PUBLISHED",
          },
        },
        carousel: { state: "submitted" },
      },
    });
  });

  it("says what Meta refused the carousel for, in its words, and keeps the order form", async () => {
    mockCreateTemplate.mockRejectedValue(
      wrapped(
        new WhatsAppTemplateGraphRefusalError(
          `Invalid parameter - ${"The card's text is too long. ".repeat(20)}`,
          400,
          { message: "Invalid parameter" }
        )
      )
    );

    const { kit } = (await make()) as {
      kit: { status: string; parts: Record<string, Record<string, unknown>> };
    };

    expect(kit.status).toBe("needs_attention");
    expect(kit.parts.orderForm).toMatchObject({ state: "ready" });
    expect(kit.parts.carousel).toMatchObject({
      state: "failed",
      error: { code: "meta_refused" },
    });
    const message = (kit.parts.carousel!.error as { message: string }).message;
    expect(message.startsWith("Invalid parameter - The card's text")).toBe(
      true
    );
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it("tells Meta's template limit from its other refusals", async () => {
    mockCreateTemplate.mockRejectedValue(
      wrapped(
        new WhatsAppTemplateGraphRefusalError(
          "Invalid parameter - Your WhatsApp Business Account has reached the maximum number of message templates.",
          400,
          { message: "Invalid parameter" }
        )
      )
    );

    const { kit } = (await make()) as { kit: Record<string, unknown> };

    expect(kit).toMatchObject({
      parts: {
        orderForm: { state: "ready" },
        carousel: {
          state: "failed",
          error: {
            code: "template_limit",
            message: expect.stringContaining(
              "maximum number of message templates"
            ),
          },
        },
      },
    });
  });

  it("doesn't call airi's own failure Meta refusing the carousel", async () => {
    // (airi's own timeout is "a carousel Meta is slow to answer", below.)
    // The account not resolving, a header that couldn't be fetched…: airi's.
    mockCreateTemplate.mockRejectedValueOnce(
      wrapped(new Error("WhatsApp source ID not found"))
    );
    const failed = (await make({ requestId: "press-0002" })) as {
      kit: Record<string, unknown>;
    };
    expect(failed.kit).toMatchObject({
      parts: {
        carousel: { state: "failed", error: { code: "failed", message: null } },
      },
    });
    expect(mockFindTemplate).not.toHaveBeenCalled();
  });

  it("says the company's storage is full, and keeps the order form", async () => {
    mockPrepareCarousel.mockRejectedValue(
      new StorageQuotaError("company_storage_limit_exceeded", "Full")
    );

    const { kit } = (await make()) as { kit: Record<string, unknown> };

    expect(kit).toMatchObject({
      parts: {
        orderForm: { state: "ready", flowId: "flow-1" },
        carousel: {
          state: "failed",
          error: { code: "storage_full", message: null },
        },
      },
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("keeps the carousel when the order form fails unexpectedly", async () => {
    mockCreateOrderForm.mockRejectedValue(new Error("socket hang up"));

    const { kit } = (await make()) as { kit: Record<string, unknown> };

    expect(kit).toMatchObject({
      status: "needs_attention",
      parts: {
        orderForm: { state: "failed", error: { code: "failed" } },
        carousel: { state: "submitted", templateId: "tpl-1" },
      },
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products] kit part failed",
      expect.any(Error),
      expect.objectContaining({ part: "orderForm" })
    );
  });

  it("says when Meta refused the form, and when the form itself was invalid", async () => {
    mockCreateOrderForm.mockResolvedValueOnce({
      ok: false,
      reason: "refused",
      error: "Flow name is too long",
    });
    const refused = (await make({
      make: { carousel: false, orderForm: true },
    })) as {
      kit: { parts: { orderForm: unknown } };
    };
    expect(refused.kit.parts.orderForm).toMatchObject({
      state: "failed",
      error: { code: "meta_refused", message: "Flow name is too long" },
    });

    mockCreateOrderForm.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      error: "The order form is invalid: x",
    });
    const invalid = (await make({
      requestId: "press-0002",
      make: { carousel: false, orderForm: true },
    })) as { kit: { parts: { orderForm: unknown; carousel?: unknown } } };
    expect(invalid.kit.parts.orderForm).toMatchObject({
      state: "failed",
      error: { code: "failed", message: null },
    });
    expect(invalid.kit.parts.carousel).toBeUndefined();
  });

  it("keeps a carousel Meta took when airi's own row of it wasn't saved", async () => {
    mockCreateTemplate.mockRejectedValue(
      new WhatsAppTemplateRecordPersistenceError("Database error: timeout", {
        id: "tpl-9",
        status: "APPROVED",
      })
    );

    const { kit } = (await make()) as { kit: Record<string, unknown> };

    expect(kit).toMatchObject({
      status: "ready",
      parts: {
        carousel: {
          state: "submitted",
          templateId: "tpl-9",
          metaStatus: "APPROVED",
          approvedAt: expect.any(String),
        },
      },
    });
  });

  it("writes for buyers in the newest video's language, unless the owner chose one", async () => {
    shelf = [
      shelfRow(1, { importId: new Types.ObjectId(OLD_IMPORT) }),
      shelfRow(2, { importId: new Types.ObjectId(NEW_IMPORT) }),
    ];
    imports = [
      {
        _id: OLD_IMPORT,
        language: "Kazakh",
        createdAt: new Date("2026-10-30"),
      },
      {
        _id: NEW_IMPORT,
        language: "Russian",
        createdAt: new Date("2026-11-01"),
      },
    ];

    expect(await make()).toMatchObject({ kit: { language: "ru" } });
    expect(mockCreateOrderForm).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "ru" })
    );
    expect(mockPrepareCarousel).toHaveBeenLastCalledWith(
      WS,
      expect.objectContaining({ language: "ru" }),
      expect.any(Date)
    );

    expect(
      await make({ requestId: "press-0002", language: "en" })
    ).toMatchObject({
      kit: { language: "en" },
    });
  });
});

describe("kit names", () => {
  const at = new Date("2026-11-02T04:14:05Z");

  it("names the template to the second in UTC with its kit, and the form on the owner's clock", () => {
    expect(
      carouselTemplateName(at, new Types.ObjectId("651f1f77bcf86cd7994391ab"))
    ).toBe("products_20261102_041405_4391ab");
    expect(orderFormName(at, "Asia/Tokyo")).toBe("Order form · 2 Nov 13:14");
    expect(orderFormName(at, null)).toBe("Order form · 2 Nov 04:14 UTC");
  });
});

/** A kit already saved, as Mongo holds it. */
function storedKit(overrides: Stored = {}): Stored {
  const at = ago(10 * 60_000);
  return {
    _id: new Types.ObjectId(),
    workspaceId: WS,
    requestId: `press-${Math.random().toString(16).slice(2, 10)}`,
    createdBy: "user-1",
    language: "kk",
    productIds: [productId(1), productId(2), productId(3)],
    importId: null,
    timeZone: "Asia/Tokyo",
    parts: {
      orderForm: {
        state: "ready",
        flowId: "flow-1",
        flowName: "Order form · 2 Nov 13:14",
        productCount: 3,
        error: null,
        updatedAt: at,
      },
      carousel: {
        state: "submitted",
        templateId: "tpl-1",
        templateName: "products_20261102_041405",
        templateRowId: "row-1",
        cardCount: 3,
        metaStatus: "APPROVED",
        metaReason: null,
        approvedAt: at,
        submittedAt: at,
        checkedAt: ago(60_000 * 2),
        error: null,
        updatedAt: at,
      },
    },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const withCarousel = (carousel: Stored, overrides: Stored = {}): Stored => {
  const base = storedKit(overrides);
  const parts = base.parts as Record<string, Stored>;
  return {
    ...base,
    parts: { ...parts, carousel: { ...parts.carousel, ...carousel } },
  };
};

describe("retryProductKitPart", () => {
  const retry = (kitId: string, part: "orderForm" | "carousel") =>
    retryProductKitPart({ workspaceId: WS, userId: "user-1", kitId, part });

  it("makes only the part that wasn't made again, leaving the other as it is", async () => {
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      metaStatus: null,
      error: { code: "storage_full", message: null },
    });
    mockKits.add(kit);

    const result = await retry(String(kit._id), "carousel");

    expect(result).toMatchObject({
      kit: {
        parts: {
          orderForm: { state: "ready", flowId: "flow-1" },
          carousel: { state: "submitted", templateId: "tpl-1", error: null },
        },
      },
    });
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
    expect(mockUpdateFlow).not.toHaveBeenCalled();
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("makes a carousel Meta rejected again, as a new template", async () => {
    const kit = withCarousel({
      templateId: "tpl-old",
      metaStatus: "REJECTED",
      metaReason: "invalid format",
    });
    mockKits.add(kit);
    mockCreateTemplate.mockResolvedValue({
      id: "row-2",
      metaTemplateId: "tpl-2",
      metaTemplateStatus: "PENDING",
    });

    const result = await retry(String(kit._id), "carousel");

    expect(result).toMatchObject({
      kit: {
        status: "waiting_for_meta",
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-2",
            metaStatus: "PENDING",
            metaReason: null,
          },
        },
      },
    });
  });

  it("saves each attempt's template name and new Flow before Meta answers", async () => {
    let releaseTemplate = () => {};
    mockCreateTemplate.mockImplementation(
      () =>
        new Promise(resolve => {
          releaseTemplate = () =>
            resolve({
              id: "row-1",
              metaTemplateId: "tpl-1",
              metaTemplateStatus: "PENDING",
            });
        })
    );
    let releaseForm = () => {};
    mockUpdateFlow.mockImplementation(
      () =>
        new Promise(resolve => {
          releaseForm = () => resolve({ ok: true, status: 200 });
        })
    );

    const result = make();
    await flush();

    // Stopped here (a 60 s function limit), a retry could find both.
    const [stored] = mockKits.docs;
    expect(read(stored, "parts.carousel")).toMatchObject({
      state: "making",
      templateName: expect.stringMatching(/^products_\d{8}_\d{6}_[0-9a-f]{6}$/),
    });
    expect(read(stored, "parts.orderForm")).toMatchObject({
      state: "making",
      flowId: "flow-1",
      flowName: expect.stringMatching(/^Order form · /),
    });
    releaseTemplate();
    releaseForm();
    await result;
  });

  it("finds a timed-out carousel Meta took, rather than sending a second", async () => {
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      error: { code: "timed_out", message: null },
    });
    mockKits.add(kit);
    mockFindTemplate.mockResolvedValue({ id: "tpl-7", status: "APPROVED" });

    const result = await retry(String(kit._id), "carousel");

    expect(mockFindTemplate).toHaveBeenCalledWith({
      accessToken: "token",
      wabaId: "waba-1",
      name: "products_20261102_041405",
      language: "kk",
      timeoutMs: 5_000,
    });
    expect(mockPrepareCarousel).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kit: {
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-7",
            templateName: "products_20261102_041405",
            metaStatus: "APPROVED",
            // Approved at a time nobody saw.
            approvedAt: null,
          },
        },
      },
    });
  });

  it("sends a timed-out carousel Meta hasn't got under the same name, and a rejected one under a new name", async () => {
    const lost = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      error: { code: "timed_out", message: null },
    });
    mockKits.add(lost);
    await retry(String(lost._id), "carousel");
    // Meta refuses a twin of a name it has, so nothing is sent twice.
    expect(mockCreateTemplate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "products_20261102_041405" })
    );

    const rejected = withCarousel({
      templateId: "tpl-old",
      templateName: "products_20261102_041405",
      metaStatus: "REJECTED",
    });
    mockKits.add(rejected);
    mockFindTemplate.mockClear();
    await retry(String(rejected._id), "carousel");
    expect(mockFindTemplate).not.toHaveBeenCalled();
    const [{ name }] = mockCreateTemplate.mock.calls.at(-1)! as [
      { name: string },
    ];
    expect(name).toMatch(/^products_\d{8}_\d{6}_[0-9a-f]{6}$/);
    expect(name).not.toBe("products_20261102_041405");
  });

  it("finishes a timed-out order form's Flow rather than publishing a second", async () => {
    const withForm = (flowStatus: string) => {
      const kit = storedKit();
      (kit.parts as Record<string, Stored>).orderForm = {
        state: "failed",
        flowId: "flow-9",
        flowName: "Order form · 2 Nov 13:14",
        productCount: 3,
        error: { code: "timed_out", message: null },
        updatedAt: ago(120_000),
      };
      mockKits.add(kit);
      mockGetFlow.mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: { id: "flow-9", status: flowStatus },
      });
      return String(kit._id);
    };

    // Published before the answer was lost: it is the form.
    const published = await retry(withForm("PUBLISHED"), "orderForm");
    expect(mockGetFlow).toHaveBeenLastCalledWith({
      accessToken: "token",
      flowId: "flow-9",
      expectedWabaId: "waba-1",
    });
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
    expect(mockUpdateFlow).not.toHaveBeenCalled();
    expect(published).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "ready",
            flowId: "flow-9",
            flowName: "Order form · 2 Nov 13:14",
          },
        },
      },
    });

    // Still a draft: its JSON goes again, and it is published.
    const draft = await retry(withForm("DRAFT"), "orderForm");
    expect(mockCreateOrderForm).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "flow-9" })
    );
    expect(mockUpdateFlow).toHaveBeenCalledWith({
      accessToken: "token",
      flowId: "flow-9",
      operation: "publish",
    });
    expect(draft).toMatchObject({
      kit: { parts: { orderForm: { state: "ready", flowId: "flow-9" } } },
    });
  });

  it("shows a part made again at the shelf's new prices as current", async () => {
    // A carousel alone, rejected by Meta, then a price changes on the shelf.
    const made = await make({ make: { carousel: true, orderForm: false } });
    if (!("kit" in made)) throw new Error("not made");
    await mockKits.updateOne(
      { _id: made.kit.id },
      { $set: { "parts.carousel.metaStatus": "REJECTED" } }
    );
    shelf[0] = shelfRow(1, { price: 6000 });
    expect(await readProductKit(WS, made.kit.id)).toMatchObject({
      pricesChanged: true,
    });

    const remade = await retry(made.kit.id, "carousel");

    const cards = mockPrepareCarousel.mock.calls.at(-1)![1] as {
      products: Array<{ price: number }>;
    };
    expect(cards.products[0]!.price).toBe(6000);
    expect(remade).toMatchObject({
      kit: {
        parts: { carousel: { state: "submitted" } },
        pricesChanged: false,
      },
    });
  });

  it("still says prices changed while another part shows the old ones", async () => {
    const made = await make();
    if (!("kit" in made)) throw new Error("not made");
    await mockKits.updateOne(
      { _id: made.kit.id },
      { $set: { "parts.carousel.metaStatus": "REJECTED" } }
    );
    shelf[0] = shelfRow(1, { price: 6000 });

    // The carousel is made again; the order form still lists 15 500.
    expect(await retry(made.kit.id, "carousel")).toMatchObject({
      kit: { parts: { orderForm: { state: "ready" } }, pricesChanged: true },
    });
  });

  it("answers with the kit as it is for a part that needs nothing", async () => {
    const kit = storedKit();
    mockKits.add(kit);

    const result = await retry(String(kit._id), "orderForm");

    expect(result).toMatchObject({
      kit: { id: String(kit._id), parts: { orderForm: { state: "ready" } } },
    });
    expect(mockWhatsApp).not.toHaveBeenCalled();
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
  });

  it("makes a part that timed out again", async () => {
    const kit = storedKit();
    (kit.parts as Record<string, Stored>).orderForm = {
      state: "making",
      productCount: 3,
      updatedAt: ago(120_000),
    };
    mockKits.add(kit);

    const result = await retry(String(kit._id), "orderForm");

    expect(result).toMatchObject({
      kit: { parts: { orderForm: { state: "ready", flowId: "flow-1" } } },
    });
    expect(mockCreateOrderForm).toHaveBeenCalledTimes(1);
  });

  it("refuses without a connected number, and finds no other workspace's kit", async () => {
    const kit = withCarousel({ state: "failed", templateId: null });
    mockKits.add(kit);
    mockWhatsApp.mockResolvedValueOnce({ context: { credentials: {} } });

    expect(await retry(String(kit._id), "carousel")).toEqual({
      refused: "whatsapp_not_connected",
    });
    expect(read(mockKits.docs[0], "parts.carousel.state")).toBe("failed");

    mockKits.add({ ...storedKit(), workspaceId: "workspace-2" });
    expect(await retry(String(mockKits.docs[1]!._id), "carousel")).toBeNull();
    expect(await retry("nope", "carousel")).toBeNull();
  });
});

describe("readProductKit", () => {
  it("times out a part stuck making for 90 seconds", async () => {
    const kit = storedKit();
    (kit.parts as Record<string, Stored>).orderForm = {
      state: "making",
      productCount: 3,
      updatedAt: ago(91_000),
    };
    mockKits.add(kit);

    expect(await readProductKit(WS, String(kit._id))).toMatchObject({
      status: "needs_attention",
      parts: {
        orderForm: {
          state: "failed",
          error: { code: "timed_out", message: null },
        },
      },
    });
    expect(read(mockKits.docs[0], "parts.orderForm.state")).toBe("failed");
  });

  it("leaves a part that is still making within the 90 seconds", async () => {
    const kit = storedKit();
    (kit.parts as Record<string, Stored>).orderForm = {
      state: "making",
      productCount: 3,
      updatedAt: ago(30_000),
    };
    mockKits.add(kit);

    expect(await readProductKit(WS, String(kit._id))).toMatchObject({
      status: "making",
      parts: { orderForm: { state: "making" } },
    });
  });

  it("reads a waiting carousel's verdict from airi's Templates row a minute after the last look", async () => {
    const kit = withCarousel({
      metaStatus: "PENDING",
      approvedAt: null,
      submittedAt: ago(70_000),
      checkedAt: ago(61_000),
    });
    mockKits.add(kit);
    mockTemplateRows.mockResolvedValue({
      data: [{ id: "row-1", whatsapp_data: { status: "APPROVED" } }],
      error: null,
    });

    expect(await readProductKit(WS, String(kit._id))).toMatchObject({
      status: "ready",
      parts: {
        carousel: { metaStatus: "APPROVED", approvedAt: expect.any(String) },
      },
    });
    expect(mockTemplateRows).toHaveBeenCalledWith({
      table: "message_templates",
      column: "workspace_id",
      workspaceId: WS,
      ids: ["row-1"],
    });
    expect(mockGetTemplate).not.toHaveBeenCalled();
  });

  it("gives an approval a time only when it was seen soon after it happened", async () => {
    // Sent and last looked at 6 h ago, the page closed since; Meta's
    // webhook has since marked airi's Templates row APPROVED.
    const unseen = withCarousel({
      metaStatus: "PENDING",
      approvedAt: null,
      submittedAt: ago(6 * 3_600_000),
      checkedAt: ago(6 * 3_600_000),
    });
    mockKits.add(unseen);
    mockTemplateRows.mockResolvedValue({
      data: [{ id: "row-1", whatsapp_data: { status: "APPROVED" } }],
      error: null,
    });
    // "Meta approved it." rather than the time of this read.
    expect(await readProductKit(WS, String(unseen._id))).toMatchObject({
      status: "ready",
      parts: { carousel: { metaStatus: "APPROVED", approvedAt: null } },
    });

    // Looked at a minute ago, as an open page does: the time is close.
    const watched = withCarousel({
      metaStatus: "PENDING",
      approvedAt: null,
      submittedAt: ago(4 * 60_000),
      checkedAt: ago(61_000),
    });
    mockKits.add(watched);
    const before = Date.now();
    const read = await readProductKit(WS, String(watched._id));
    expect(
      Date.parse(read!.parts.carousel!.approvedAt ?? "")
    ).toBeGreaterThanOrEqual(before);
  });

  it("asks Meta itself once the carousel has waited 2 minutes, and says why it was rejected", async () => {
    const kit = withCarousel({
      metaStatus: "PENDING",
      approvedAt: null,
      submittedAt: ago(3 * 60_000),
      checkedAt: ago(61_000),
    });
    mockKits.add(kit);
    mockTemplateRows.mockResolvedValue({
      data: [{ id: "row-1", whatsapp_data: { status: "PENDING" } }],
      error: null,
    });
    mockGetTemplate.mockResolvedValue({
      id: "tpl-1",
      status: "REJECTED",
      rejected_reason: "INVALID_FORMAT",
    });

    expect(await readProductKit(WS, String(kit._id))).toMatchObject({
      status: "needs_attention",
      parts: {
        carousel: { metaStatus: "REJECTED", metaReason: "invalid format" },
      },
    });
    expect(mockGetTemplate).toHaveBeenCalledWith(WS, "tpl-1");
  });

  it("doesn't look again within a minute, and reads a decided one only from airi's row", async () => {
    const recent = withCarousel({
      metaStatus: "PENDING",
      submittedAt: ago(5 * 60_000),
      checkedAt: ago(30_000),
    });
    mockKits.add(recent);
    await readProductKit(WS, String(recent._id));
    expect(mockTemplateRows).not.toHaveBeenCalled();
    expect(mockGetTemplate).not.toHaveBeenCalled();

    const decided = withCarousel({
      metaStatus: "APPROVED",
      checkedAt: ago(11 * 60_000),
    });
    mockKits.add(decided);
    mockTemplateRows.mockResolvedValue({
      data: [{ id: "row-1", whatsapp_data: { status: "PAUSED" } }],
      error: null,
    });
    expect(await readProductKit(WS, String(decided._id))).toMatchObject({
      status: "needs_attention",
      parts: { carousel: { metaStatus: "PAUSED" } },
    });
    expect(mockGetTemplate).not.toHaveBeenCalled();
  });

  it("finds nothing for another workspace or a bad id", async () => {
    mockKits.add({ ...storedKit(), workspaceId: "workspace-2" });
    expect(await readProductKit(WS, String(mockKits.docs[0]!._id))).toBeNull();
    expect(await readProductKit(WS, "nope")).toBeNull();
  });

  it("says when a shelf price changed after the kit was made", async () => {
    const madeWith = (price: number) => [
      {
        productId: productId(1),
        price: 15500,
        currency: "KZT",
        priceIsFrom: false,
      },
      { productId: productId(2), price, currency: "KZT", priceIsFrom: false },
    ];
    const unchanged = storedKit({ prices: madeWith(15500) });
    const changed = storedKit({ prices: madeWith(9900) });
    mockKits.add(unchanged);
    mockKits.add(changed);

    expect(await readProductKit(WS, String(unchanged._id))).toMatchObject({
      pricesChanged: false,
    });
    expect(await readProductKit(WS, String(changed._id))).toMatchObject({
      pricesChanged: true,
    });
  });
});

describe("listProductKitRecords", () => {
  it("lists the newest first, and asks Meta itself at most 3 times", async () => {
    for (let day = 1; day <= 5; day += 1)
      mockKits.add(
        withCarousel(
          {
            metaStatus: "PENDING",
            submittedAt: ago(5 * 60_000),
            checkedAt: null,
          },
          { createdAt: new Date(`2026-11-0${day}T09:00:00Z`) }
        )
      );

    const kits = await listProductKitRecords(WS, 20);

    expect(kits.map(kit => kit.createdAt)).toEqual([
      "2026-11-05T09:00:00.000Z",
      "2026-11-04T09:00:00.000Z",
      "2026-11-03T09:00:00.000Z",
      "2026-11-02T09:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
    expect(mockGetTemplate).toHaveBeenCalledTimes(3);
    expect(mockTemplateRows).toHaveBeenCalledTimes(1);
  });
});

describe("readProductKitPlan", () => {
  it("shows the products as their cards will, with the buyers' language, the number and the review's last kit", async () => {
    shelf = [
      shelfRow(1),
      shelfRow(2, {
        options: [
          { photo: { original: { bucket: "media", path: "p2/frame.jpg" } } },
        ],
      }),
      shelfRow(3, { options: [{}], price: null }),
    ];
    const madeFromReview = storedKit({
      importId: NEW_IMPORT,
      createdAt: new Date("2026-11-02T09:00:00Z"),
    });
    mockKits.add(madeFromReview);
    mockKits.add(
      storedKit({
        importId: OLD_IMPORT,
        createdAt: new Date("2026-11-03T09:00:00Z"),
      })
    );

    const plan = await readProductKitPlan({
      workspaceId: WS,
      productIds: [productId(1), productId(2), productId(3)],
      importId: NEW_IMPORT,
    });

    expect(plan).toMatchObject({
      language: "kk",
      languageIsSpoken: true,
      whatsapp: { connected: true, displayPhone: "shop-number" },
      latestKit: { id: String(madeFromReview._id) },
      products: [
        {
          id: productId(1),
          name: "Шежіре 1",
          price: 15500,
          hasPhoto: true,
          hasCutout: true,
          imageUrl: "https://signed.test/p1/thumb.webp",
        },
        {
          id: productId(2),
          hasPhoto: true,
          hasCutout: false,
          imageUrl: "https://signed.test/p2/frame.jpg",
        },
        { id: productId(3), price: null, hasPhoto: false, imageUrl: null },
      ],
    });
  });

  it("writes English for an owner who spoke another language, without calling it theirs", async () => {
    imports = [
      { _id: OLD_IMPORT, language: "Uzbek", createdAt: new Date("2026-10-30") },
    ];

    expect(
      await readProductKitPlan({
        workspaceId: WS,
        productIds: [productId(1)],
        importId: null,
      })
    ).toMatchObject({ language: "en", languageIsSpoken: false });
  });

  it("has no last kit without a review, and says when no number is connected", async () => {
    mockKits.add(storedKit({ importId: NEW_IMPORT }));
    mockWhatsApp.mockResolvedValue({ context: { credentials: {} } });

    expect(
      await readProductKitPlan({
        workspaceId: WS,
        productIds: [productId(1)],
        importId: null,
      })
    ).toMatchObject({
      latestKit: null,
      whatsapp: { connected: false, displayPhone: null },
    });
  });
});

describe("a carousel Meta is slow to answer", () => {
  const retry = (kitId: string) =>
    retryProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId,
      part: "carousel",
    });

  /** What the template service throws when it stops waiting for Meta. */
  const abort = () =>
    wrapped(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      )
    );

  /**
   * Meta answers the create after `ms`, unless the template service stops
   * waiting first: after the time airi gives it (10 s unless it says more),
   * cut to the caller's deadline but never below 10 s, as createTemplate does.
   */
  function metaAnswersAfter(ms: number, templateId = "tpl-1") {
    mockCreateTemplate.mockImplementation(
      (params: { metaTimeoutMs?: number; metaDeadlineAt?: number }) =>
        new Promise((resolve, reject) => {
          const allowed = params.metaTimeoutMs ?? 10_000;
          const limit =
            params.metaDeadlineAt === undefined
              ? allowed
              : Math.max(
                  Math.min(allowed, 10_000),
                  Math.min(allowed, params.metaDeadlineAt - Date.now())
                );
          if (ms <= limit)
            setTimeout(
              () =>
                resolve({
                  id: "row-1",
                  metaTemplateId: templateId,
                  metaTemplateStatus: "PENDING",
                }),
              ms
            );
          else setTimeout(() => reject(abort()), limit);
        })
    );
  }

  const lookedFor = (name: string) => ({
    accessToken: "token",
    wabaId: "waba-1",
    name,
    language: "kk",
    timeoutMs: 5_000,
  });

  type Made = { kit: { id: string; status: string; parts: Stored } };
  const carouselOf = (made: unknown) =>
    (made as Made).kit.parts.carousel as Stored;

  /** A press, run while time passes. */
  async function makeOver(ms: number) {
    const result = make();
    await flush();
    await jest.advanceTimersByTimeAsync(ms);
    await flush();
    return (await result) as Made;
  }

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("gives Meta 25 s, so a carousel it accepts after 18 s is with Meta", async () => {
    // The 10 s every other create gets would have stopped this one.
    metaAnswersAfter(18_000);

    const made = await makeOver(18_000);

    expect(made.kit.status).toBe("waiting_for_meta");
    expect(carouselOf(made)).toMatchObject({
      state: "submitted",
      templateId: "tpl-1",
      metaStatus: "PENDING",
      error: null,
    });
    expect(mockFindTemplate).not.toHaveBeenCalled();
  });

  it("looks for it at Meta once airi stops waiting, and keeps the one Meta made", async () => {
    metaAnswersAfter(40_000);
    // Not there at once; there 2 s later.
    mockFindTemplate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "tpl-9", status: "PENDING" });

    const made = await makeOver(25_000 + 2_000);

    const name = String(carouselOf(made).templateName);
    expect(name).toMatch(/^products_\d{8}_\d{6}_[0-9a-f]{6}$/);
    expect(mockFindTemplate).toHaveBeenCalledTimes(2);
    expect(mockFindTemplate).toHaveBeenLastCalledWith(lookedFor(name));
    expect(made.kit.status).toBe("waiting_for_meta");
    expect(carouselOf(made)).toMatchObject({
      state: "submitted",
      templateId: "tpl-9",
      metaStatus: "PENDING",
      error: null,
    });
    // Sent once; airi's Templates row comes with Meta's webhooks and Sync.
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(read(mockKits.docs[0], "parts.carousel.templateRowId")).toBeNull();
    // The order form was made all the same.
    expect(made.kit.parts.orderForm).toMatchObject({ state: "ready" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[Products] kit carousel answer lost",
      expect.objectContaining({ event: "products.kit_carousel_answer_lost" })
    );
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      "[Products] kit carousel not sent",
      expect.anything()
    );
  });

  it("keeps checking with Meta when it isn't there yet, and the kit's poll finds it", async () => {
    metaAnswersAfter(60_000);

    const made = await makeOver(25_000 + 2_000 + 4_000);

    // Looked at once, after 2 s and after 4 more: not there yet.
    expect(mockFindTemplate).toHaveBeenCalledTimes(3);
    expect(made.kit.status).toBe("making");
    expect(carouselOf(made)).toMatchObject({
      state: "checking",
      templateId: null,
      error: null,
    });
    const kitId = made.kit.id;

    // Polled within 15 s of the last look, Meta isn't asked again…
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await readProductKit(WS, kitId)).toMatchObject({
      status: "making",
      parts: { carousel: { state: "checking" } },
    });
    expect(mockFindTemplate).toHaveBeenCalledTimes(3);
    // …and nothing is made again meanwhile.
    expect(await retry(kitId)).toMatchObject({
      kit: { parts: { carousel: { state: "checking" } } },
    });
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);

    // Polled later, it is there, approved since the last look.
    await jest.advanceTimersByTimeAsync(10_000);
    mockFindTemplate.mockResolvedValueOnce({ id: "tpl-9", status: "APPROVED" });
    expect(await readProductKit(WS, kitId)).toMatchObject({
      status: "ready",
      parts: {
        carousel: {
          state: "submitted",
          templateId: "tpl-9",
          metaStatus: "APPROVED",
          approvedAt: expect.any(String),
          error: null,
        },
      },
    });
    expect(mockFindTemplate).toHaveBeenCalledTimes(4);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("calls it not made after 3 minutes without it, and Try again finds the one Meta made late, sending nothing twice", async () => {
    metaAnswersAfter(60_000);
    const made = await makeOver(25_000 + 2_000 + 4_000);
    const name = String(carouselOf(made).templateName);

    // Polled every 15 s for 3 minutes, never there.
    for (let poll = 0; poll < 12; poll += 1) {
      await jest.advanceTimersByTimeAsync(15_000);
      await readProductKit(WS, made.kit.id);
    }
    expect(await readProductKit(WS, made.kit.id)).toMatchObject({
      status: "needs_attention",
      parts: {
        carousel: {
          state: "failed",
          templateName: name,
          error: { code: "timed_out", message: null },
        },
      },
    });

    // Meta made it after all: Try again finds it rather than send another.
    mockFindTemplate.mockResolvedValueOnce({
      id: "tpl-late",
      status: "PENDING",
    });
    expect(await retry(made.kit.id)).toMatchObject({
      kit: {
        status: "waiting_for_meta",
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-late",
            templateName: name,
          },
        },
      },
    });
    expect(mockFindTemplate).toHaveBeenLastCalledWith(lookedFor(name));
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(mockPrepareCarousel).toHaveBeenCalledTimes(1);
  });

  it("leaves the looks to the page's poll when the create stops too late to look within the kit's time", async () => {
    // The cards took 32 s to make; the create still got its 10 s, so it
    // stopped 42 s in, too late for a 5 s look before 45 s.
    mockPrepareCarousel.mockImplementation(
      async (_workspaceId: string, added: Parameters<typeof draftFor>[0]) => {
        await new Promise(resolve => setTimeout(resolve, 32_000));
        return draftFor(added);
      }
    );
    metaAnswersAfter(60_000);

    const made = await makeOver(32_000 + 10_000);

    expect(mockFindTemplate).not.toHaveBeenCalled();
    expect(carouselOf(made)).toMatchObject({ state: "checking" });
    expect(read(mockKits.docs[0], "parts.carousel.checkedAt")).toBeNull();

    // The first poll looks at once.
    mockFindTemplate.mockResolvedValueOnce({ id: "tpl-9", status: "PENDING" });
    expect(await readProductKit(WS, made.kit.id)).toMatchObject({
      status: "waiting_for_meta",
      parts: { carousel: { state: "submitted", templateId: "tpl-9" } },
    });
  });

  it("asks Meta at most 3 times for a list, lookups included", async () => {
    for (let day = 1; day <= 4; day += 1)
      mockKits.add(
        withCarousel(
          {
            state: "checking",
            templateId: null,
            templateName: `products_2026110${day}_090000`,
            metaStatus: null,
            approvedAt: null,
            submittedAt: null,
            checkedAt: ago(20_000),
            updatedAt: ago(40_000),
          },
          { createdAt: new Date(`2026-11-0${day}T09:00:00Z`) }
        )
      );

    const kits = await listProductKitRecords(WS, 20);

    expect(mockFindTemplate).toHaveBeenCalledTimes(3);
    expect(kits.map(kit => kit.parts.carousel?.state)).toEqual([
      "checking",
      "checking",
      "checking",
      "checking",
    ]);
  });

  it("cuts a Try again's create to the kit's time, so the answer leaves well within the route's 60 s", async () => {
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261103_055534",
      metaStatus: null,
      approvedAt: null,
      submittedAt: null,
      checkedAt: null,
      error: { code: "timed_out", message: null },
    });
    mockKits.add(kit);
    // Meta is slow all round: the first look takes its 5 s, the cards 15 s,
    // and Meta would accept the create 24 s after it is sent.
    mockFindTemplate.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve(null), 5_000))
    );
    mockPrepareCarousel.mockImplementation(
      async (_workspaceId: string, added: Parameters<typeof draftFor>[0]) => {
        await new Promise(resolve => setTimeout(resolve, 15_000));
        return draftFor(added);
      }
    );
    metaAnswersAfter(24_000);
    const startedAt = Date.now();
    let answeredAt = 0;

    const result = retry(String(kit._id)).then(answer => {
      answeredAt = Date.now();
      return answer;
    });
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "products_20261103_055534",
        metaTimeoutMs: 25_000,
        // 40 s after the parts start, so one look still fits within 45.
        metaDeadlineAt: startedAt + 40_000,
      })
    );
    // Sent 20 s in, the create waits 20 s rather than 25, then one look:
    // checking, for the page's poll to settle.
    expect(await result).toMatchObject({
      kit: {
        status: "making",
        parts: {
          carousel: {
            state: "checking",
            templateName: "products_20261103_055534",
          },
        },
      },
    });
    expect(mockFindTemplate).toHaveBeenCalledTimes(2);
    expect(answeredAt - startedAt).toBeLessThanOrEqual(45_000);
  });

  it("counts an edit's time from its press, so a slow look before the create never pushes the answer past the route's 60 s", async () => {
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261103_055534",
      metaStatus: null,
      approvedAt: null,
      submittedAt: null,
      checkedAt: null,
      error: { code: "timed_out", message: null },
    });
    mockKits.add(kit);
    // The look for the lost carousel takes nearly its 5 s, and misses it.
    mockFindTemplate.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve(null), 4_900))
    );
    metaAnswersAfter(30_000);
    const startedAt = Date.now();
    let answeredAt = 0;

    const result = editProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId: String(kit._id),
      request: {
        requestId: "edit-slow",
        part: "carousel",
        name: carouselTemplateName(new Date(), kit._id as Types.ObjectId),
        components: editedCards(3) as never,
      },
    }).then(answer => {
      answeredAt = Date.now();
      return answer;
    });
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    await flush();

    // 40 s from the press, not from after the look.
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ metaDeadlineAt: startedAt + 40_000 })
    );
    expect(await result).toMatchObject({
      kit: { parts: { carousel: { state: "checking" } } },
    });
    expect(answeredAt - startedAt).toBeLessThanOrEqual(45_000);
  });

  it("counts a press's time from its start, so a slow look at the owner's own name comes out of it", async () => {
    mockFindTemplate.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => resolve(null), 4_900))
    );
    metaAnswersAfter(1_000);
    const startedAt = Date.now();

    const result = make({
      make: { carousel: true, orderForm: false },
      edits: {
        carousel: { name: "summer_sale", components: editedCards(2) as never },
      },
    });
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "summer_sale",
        metaDeadlineAt: startedAt + 40_000,
      })
    );
    expect(await result).toMatchObject({
      kit: { parts: { carousel: { state: "submitted" } } },
    });
  });

  it("names two kits pressed in the same second apart, so a lost answer's look never takes the other's carousel", async () => {
    jest.setSystemTime(new Date("2026-11-03T05:55:34.100Z"));
    const first = (await make({ requestId: "press-a" })) as Made;
    const firstName = String(carouselOf(first).templateName);
    // Meta has the first kit's carousel; the second's answer is lost.
    mockFindTemplate.mockImplementation(async ({ name }: { name: string }) =>
      name === firstName ? { id: "tpl-1", status: "PENDING" } : null
    );
    mockCreateTemplate.mockRejectedValueOnce(abort());
    jest.setSystemTime(new Date("2026-11-03T05:55:34.900Z"));

    const pressed = make({ requestId: "press-b" });
    await flush();
    await jest.advanceTimersByTimeAsync(6_000);
    const second = (await pressed) as Made;

    const secondName = String(carouselOf(second).templateName);
    expect(firstName).toBe(
      `products_20261103_055534_${first.kit.id.slice(-6)}`
    );
    expect(secondName).toBe(
      `products_20261103_055534_${second.kit.id.slice(-6)}`
    );
    expect(secondName).not.toBe(firstName);
    expect(
      mockCreateTemplate.mock.calls.map(([call]) => (call as Stored).name)
    ).toEqual([firstName, secondName]);
    // Looked for under its own name only, so it isn't given the first's.
    expect(mockFindTemplate).toHaveBeenCalledWith(lookedFor(secondName));
    expect(mockFindTemplate).not.toHaveBeenCalledWith(lookedFor(firstName));
    expect(carouselOf(second)).toMatchObject({
      state: "checking",
      templateId: null,
    });
    expect(carouselOf(first)).toMatchObject({
      state: "submitted",
      templateId: "tpl-1",
    });
  });

  /** A kit whose carousel airi is still looking for at Meta. */
  const checkingKit = () =>
    withCarousel({
      state: "checking",
      templateId: null,
      templateName: "products_20261103_055534",
      metaStatus: null,
      approvedAt: null,
      submittedAt: null,
      checkedAt: ago(20_000),
      updatedAt: ago(40_000),
    });

  it("keeps a carousel checking while no number is connected to look with, and calls it not made after 3 minutes, its name kept", async () => {
    const kit = checkingKit();
    mockKits.add(kit);
    mockWhatsApp.mockResolvedValue({ context: { credentials: {} } });

    expect(await readProductKit(WS, String(kit._id))).toMatchObject({
      status: "making",
      parts: { carousel: { state: "checking" } },
    });
    expect(mockFindTemplate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(await readProductKit(WS, String(kit._id))).toMatchObject({
      status: "needs_attention",
      parts: {
        carousel: {
          state: "failed",
          templateName: "products_20261103_055534",
          error: { code: "timed_out", message: null },
        },
      },
    });
    expect(mockFindTemplate).not.toHaveBeenCalled();
  });

  it("keeps a carousel checking, and still answers, when the connection can't be read", async () => {
    const kit = checkingKit();
    mockKits.add(kit);
    mockWhatsApp.mockResolvedValue({ error: { status: 503 } });

    await expect(readProductKit(WS, String(kit._id))).resolves.toMatchObject({
      status: "making",
      parts: { carousel: { state: "checking" } },
    });
    expect(mockFindTemplate).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[Products] kit connection unreadable for a lookup",
      expect.objectContaining({ event: "products.kit_carousel_lookup_failed" })
    );
  });
});

describe("Try again on a carousel that timed out", () => {
  const retry = (kitId: string) =>
    retryProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId,
      part: "carousel",
    });
  // As production's kit of 2026-11-03 05:55 UTC was left.
  const timedOutKit = () =>
    withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261103_055534",
      templateRowId: null,
      metaStatus: null,
      approvedAt: null,
      submittedAt: null,
      checkedAt: null,
      cardCount: 4,
      error: { code: "timed_out", message: null },
    });

  it("finds the carousel Meta made, and a second press sends nothing", async () => {
    const kit = timedOutKit();
    mockKits.add(kit);
    mockFindTemplate.mockResolvedValue({ id: "tpl-made", status: "PENDING" });

    expect(await retry(String(kit._id))).toMatchObject({
      kit: {
        status: "waiting_for_meta",
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-made",
            templateName: "products_20261103_055534",
          },
        },
      },
    });
    // Pressed again (a second tab, a double tap): with Meta, nothing to do.
    await retry(String(kit._id));

    expect(mockFindTemplate).toHaveBeenCalledTimes(1);
    expect(mockPrepareCarousel).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("finds it when the first look misses it and Meta refuses the same name again", async () => {
    const kit = timedOutKit();
    mockKits.add(kit);
    mockFindTemplate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "tpl-made", status: "PENDING" });
    mockCreateTemplate.mockRejectedValueOnce(
      wrapped(
        new WhatsAppTemplateGraphRefusalError(
          "Invalid parameter - There is already Kazakh content for this template.",
          400,
          { message: "Invalid parameter" }
        )
      )
    );

    expect(await retry(String(kit._id))).toMatchObject({
      kit: {
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-made",
            templateName: "products_20261103_055534",
            error: null,
          },
        },
      },
    });
    // Sent once more under the same name, which Meta refused: no second template.
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "products_20261103_055534" })
    );
  });

  it("says what Meta refused a new carousel for without looking for a twin", async () => {
    mockCreateTemplate.mockRejectedValueOnce(
      wrapped(
        new WhatsAppTemplateGraphRefusalError("Invalid parameter", 400, {
          message: "Invalid parameter",
        })
      )
    );

    const made = (await make()) as { kit: { parts: Stored } };

    expect(made.kit.parts.carousel).toMatchObject({
      state: "failed",
      error: { code: "meta_refused" },
    });
    expect(mockFindTemplate).not.toHaveBeenCalled();
  });

  describe("when Meta can't say whether it has it", () => {
    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
      });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    /** A look at Meta that ran out of time (or that Meta refused: a rate limit, an outage). */
    const lookFails = () =>
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      );
    /** Meta refusing a second template under a name and language it has. */
    const twinWords =
      "There is already Kazakh content for this template. You can create a new template and try again.";
    const refusedAsTwin = () =>
      wrapped(
        new WhatsAppTemplateGraphRefusalError(
          `Invalid parameter - ${twinWords}`,
          400,
          { message: "Invalid parameter", error_user_msg: twinWords }
        )
      );
    const createdNames = () =>
      mockCreateTemplate.mock.calls.map(([call]) => (call as Stored).name);

    it("sends nothing while the first look can't be made, and keeps checking", async () => {
      const kit = timedOutKit();
      mockKits.add(kit);
      mockFindTemplate.mockRejectedValue(lookFails());

      expect(await retry(String(kit._id))).toMatchObject({
        kit: {
          status: "making",
          parts: {
            carousel: {
              state: "checking",
              templateId: null,
              templateName: "products_20261103_055534",
              error: null,
            },
          },
        },
      });
      expect(mockFindTemplate).toHaveBeenCalledTimes(1);
      expect(mockPrepareCarousel).not.toHaveBeenCalled();
      expect(mockCreateTemplate).not.toHaveBeenCalled();
    });

    it("keeps the name when Meta refuses it as a twin it can't show yet, so no Try again makes a second", async () => {
      const kit = timedOutKit();
      mockKits.add(kit);
      // Not listed at the first look; the look after the refusal can't be made.
      mockFindTemplate
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(lookFails());
      mockCreateTemplate.mockRejectedValueOnce(refusedAsTwin());

      expect(await retry(String(kit._id))).toMatchObject({
        kit: {
          status: "making",
          parts: {
            carousel: {
              state: "checking",
              templateName: "products_20261103_055534",
              error: null,
            },
          },
        },
      });
      expect(mockFindTemplate).toHaveBeenCalledTimes(2);

      // The page's poll can't look either: after 3 minutes it isn't made…
      mockFindTemplate.mockRejectedValue(lookFails());
      await jest.advanceTimersByTimeAsync(3 * 60_000);
      expect(await readProductKit(WS, String(kit._id))).toMatchObject({
        parts: {
          carousel: {
            state: "failed",
            templateName: "products_20261103_055534",
            error: { code: "timed_out", message: null },
          },
        },
      });

      // …and Try again looks first, then sends under the same name again.
      mockFindTemplate.mockResolvedValue(null);
      expect(await retry(String(kit._id))).toMatchObject({
        kit: {
          parts: {
            carousel: {
              state: "submitted",
              templateId: "tpl-1",
              templateName: "products_20261103_055534",
            },
          },
        },
      });
      expect(createdNames()).toEqual([
        "products_20261103_055534",
        "products_20261103_055534",
      ]);
    });

    it("keeps the name when Meta refuses it as a twin and doesn't list it yet", async () => {
      const kit = timedOutKit();
      mockKits.add(kit);
      mockCreateTemplate.mockRejectedValueOnce(refusedAsTwin());

      expect(await retry(String(kit._id))).toMatchObject({
        kit: { parts: { carousel: { state: "checking", error: null } } },
      });
      // Looked for before the resend and after the refusal; both missed it.
      expect(mockFindTemplate).toHaveBeenCalledTimes(2);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "[Products] kit carousel may be at Meta already",
        expect.objectContaining({
          event: "products.kit_carousel_twin_unconfirmed",
          twin: true,
        })
      );
    });

    it("tells a twin by Meta's code too, on a new carousel", async () => {
      const body = { message: "Invalid parameter", error_subcode: 2388024 };
      mockCreateTemplate.mockRejectedValueOnce(
        wrapped(
          new WhatsAppTemplateGraphRefusalError("Invalid parameter", 400, body)
        )
      );

      const made = (await make()) as { kit: { parts: Stored } };

      expect(made.kit.parts.carousel).toMatchObject({
        state: "checking",
        error: null,
      });
      expect(mockFindTemplate).toHaveBeenCalledTimes(1);
    });

    it("keeps the name when a resend is refused for another reason and Meta can't be asked about it", async () => {
      const kit = timedOutKit();
      mockKits.add(kit);
      const tooMany =
        "(#80008) There have been too many calls to this WhatsApp Business account.";
      mockFindTemplate
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(lookFails());
      mockCreateTemplate.mockRejectedValueOnce(
        wrapped(
          new WhatsAppTemplateGraphRefusalError(tooMany, 400, {
            message: tooMany,
            code: 80008,
          })
        )
      );

      expect(await retry(String(kit._id))).toMatchObject({
        kit: {
          parts: {
            carousel: {
              state: "checking",
              templateName: "products_20261103_055534",
            },
          },
        },
      });
    });
  });
});

// ------------------------------------------------------------ fake store

function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Types.ObjectId) return value;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copy(entry)])
    ) as T;
  return value;
}

function read(doc: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      doc
    );
}

function write(doc: Stored, path: string, value: unknown) {
  const keys = path.split(".");
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== "object") target[key] = {};
    target = target[key] as Stored;
  }
  target[keys.at(-1)!] = value;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date)
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  if (a instanceof Types.ObjectId || b instanceof Types.ObjectId)
    return a != null && b != null && String(a) === String(b);
  return (a ?? null) === (b ?? null);
}

function matches(doc: Stored, filter: Filter): boolean {
  return Object.entries(filter).every(([path, want]) => {
    const have = read(doc, path);
    if (
      want &&
      typeof want === "object" &&
      !(want instanceof Date) &&
      !(want instanceof Types.ObjectId) &&
      "$in" in want
    )
      return (want as { $in: unknown[] }).$in.some(option =>
        same(have, option)
      );
    return same(have, want);
  });
}

/** product_kits in memory: the queries kits.ts makes, nothing more. */
function fakeKitStore() {
  const docs: Stored[] = [];
  const query = (filter: Filter, single: boolean) => {
    let order: Record<string, 1 | -1> | null = null;
    let max: number | null = null;
    const chain = {
      sort(spec: Record<string, 1 | -1>) {
        order = spec;
        return chain;
      },
      limit(count: number) {
        max = count;
        return chain;
      },
      lean: async () => {
        let found = docs.filter(doc => matches(doc, filter));
        if (order) {
          const [[key, direction]] = Object.entries(order) as Array<
            [string, 1 | -1]
          >;
          found = [...found].sort(
            (a, b) =>
              direction *
              ((read(a, key) as Date).getTime() -
                (read(b, key) as Date).getTime())
          );
        }
        if (max !== null) found = found.slice(0, max);
        return single ? (found[0] ? copy(found[0]) : null) : found.map(copy);
      },
    };
    return chain;
  };
  return {
    docs,
    reset: () => {
      docs.length = 0;
    },
    add: (doc: Stored) => {
      docs.push(copy(doc));
    },
    findOne: (filter: Filter) => query(filter, true),
    find: (filter: Filter) => query(filter, false),
    create: async (input: Stored) => {
      if (
        docs.some(
          doc =>
            doc.workspaceId === input.workspaceId &&
            doc.requestId === input.requestId
        )
      )
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      const now = new Date();
      const doc: Stored = {
        _id: new Types.ObjectId(),
        importId: null,
        timeZone: null,
        ...copy(input),
        parts: {
          orderForm: null,
          carousel: null,
          ...copy((input.parts ?? {}) as Stored),
        },
        createdAt: now,
        updatedAt: now,
      };
      docs.push(doc);
      return { _id: doc._id };
    },
    updateOne: async (filter: Filter, update: { $set?: Stored }) => {
      const doc = docs.find(candidate => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      for (const [path, value] of Object.entries(update.$set ?? {}))
        write(doc, path, copy(value));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

// ---------------------------------------------------------------- v2: editing

const SUPABASE = "https://abcdefgh.supabase.co";
const cardPicture = (n: number) =>
  `${SUPABASE}/storage/v1/object/public/business-media/whatsapp-template-headers/${WS}/${n}-card.jpg`;

/** Cards as the template editor saves them: the owner's words, pictures on this project's storage. */
function editedCards(count: number, words = "Біздің жаңа тауарлар") {
  return [
    { type: "BODY", text: words },
    {
      type: "CAROUSEL",
      cards: Array.from({ length: count }, (_, index) => ({
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: [cardPicture(index)] },
          },
          { type: "BODY", text: `Шежіре ${index + 1}\n15 000 ₸` },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Тапсырыс беру" }],
          },
        ],
      })),
    },
  ];
}

/** The shelf's form for the three products, with its title changed by the owner. */
function editedForm(title = "Сіздің тапсырысыңыз") {
  const config = buildOrderFormFlowConfig(
    [1, 2, 3].map(n => ({
      id: productId(n),
      name: `Шежіре ${n}`,
      price: 15500,
      currency: "KZT",
      priceIsFrom: false,
    })),
    "kk"
  );
  return {
    ...config,
    screens: [{ ...config.screens[0]!, title }],
  };
}

/** A name airi made for a draft before Make: not this kit's. */
const DRAFT_NAME = "products_20261103_091500_abcdef";
const kitSuffix = (kitId: unknown) => String(kitId).slice(-6);

const metaRefusal = (words: string) =>
  wrapped(
    new WhatsAppTemplateGraphRefusalError(`Invalid parameter - ${words}`, 400, {
      message: "Invalid parameter",
    })
  );

let savedSupabaseUrl: string | undefined;
beforeAll(() => {
  savedSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
});
afterAll(() => {
  if (savedSupabaseUrl === undefined)
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = savedSupabaseUrl;
});

describe("makeProductKit with the owner's edits", () => {
  it("sends the edited cards, not the shelf's, under a name made for the kit, and keeps them", async () => {
    const cards = editedCards(3);

    const made = await make({
      edits: { carousel: { name: DRAFT_NAME, components: cards } },
    });

    expect(mockPrepareCarousel).not.toHaveBeenCalled();
    const [stored] = mockKits.docs;
    const name = String(read(stored, "parts.carousel.templateName"));
    // The draft's name is made again for this kit: a look by name only finds its own.
    expect(name).toMatch(/^products_\d{8}_\d{6}_[0-9a-f]{6}$/);
    expect(name.endsWith(`_${kitSuffix(stored!._id)}`)).toBe(true);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name,
        whatsappData: {
          language: "kk",
          category: "MARKETING",
          components: cards,
        },
      })
    );
    expect(read(stored, "parts.carousel")).toMatchObject({
      state: "submitted",
      cardCount: 3,
      components: cards,
      edited: true,
    });
    expect(made).toMatchObject({
      kit: { parts: { carousel: { edited: true, earlier: [] } } },
    });
    // The owner never typed a name: Meta isn't asked about it.
    expect(mockFindTemplate).not.toHaveBeenCalled();
  });

  it("publishes the edited questions, and keeps them on the kit", async () => {
    const config = editedForm();

    const made = await make({ edits: { orderForm: { config } } });

    expect(mockCreateOrderForm).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          screens: [expect.objectContaining({ title: "Сіздің тапсырысыңыз" })],
        }),
      })
    );
    const [stored] = mockKits.docs;
    expect(read(stored, "parts.orderForm")).toMatchObject({
      state: "ready",
      productCount: 3,
      edited: true,
      version: 1,
      config: expect.objectContaining({
        screens: [expect.objectContaining({ title: "Сіздің тапсырысыңыз" })],
      }),
    });
    expect(made).toMatchObject({
      kit: { parts: { orderForm: { edited: true, version: 1, earlier: [] } } },
    });
  });

  it("keeps what the shelf made too, for Edit and send again", async () => {
    await make();

    const [stored] = mockKits.docs;
    expect(read(stored, "parts.carousel.edited")).toBe(false);
    expect(read(stored, "parts.carousel.components")).toEqual(
      carouselTemplateComponents(
        draftFor({
          language: "kk",
          products: [1, 2, 3].map(n => ({
            id: productId(n),
            name: `Шежіре ${n}`,
            photo: {},
          })),
        })
      )
    );
    expect(read(stored, "parts.orderForm")).toMatchObject({
      edited: false,
      version: 1,
      config: expect.objectContaining({ templateId: "products_order_form" }),
    });
  });

  it("refuses edits that fail the checks, writing nothing", async () => {
    const outcome = await make({
      edits: {
        carousel: { name: DRAFT_NAME, components: editedCards(1) },
        orderForm: { config: { ...editedForm(), endpointUri: "https://x" } },
      },
    });

    expect(outcome).toEqual({
      invalid: [
        expect.any(String),
        "An order form can't use a data endpoint: it stays on WhatsApp.",
      ],
    });
    expect(mockKits.docs).toHaveLength(0);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("uses the owner's own name once Meta has none under it, and refuses one Meta has", async () => {
    const cards = editedCards(2);
    await make({
      edits: { carousel: { name: "summer_sale", components: cards } },
    });
    expect(mockFindTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "summer_sale", language: "kk" })
    );
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "summer_sale" })
    );

    mockKits.reset();
    mockCreateTemplate.mockClear();
    mockFindTemplate.mockResolvedValue({ id: "tpl-other", status: "APPROVED" });
    expect(
      await make({
        requestId: "press-0002",
        edits: { carousel: { name: "summer_sale", components: cards } },
      })
    ).toEqual({ refused: "template_name_taken" });

    mockFindTemplate.mockRejectedValue(new Error("Meta is down"));
    expect(
      await make({
        requestId: "press-0003",
        edits: { carousel: { name: "summer_sale", components: cards } },
      })
    ).toEqual({ refused: "meta_unavailable" });
    expect(mockKits.docs).toHaveLength(0);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("makes an edited carousel alone even when fewer than 2 shelf products have photos", async () => {
    shelf = [
      shelfRow(1),
      shelfRow(2, { options: [] }),
      shelfRow(3, { options: [] }),
    ];

    const made = await make({
      make: { carousel: true, orderForm: false },
      edits: { carousel: { name: DRAFT_NAME, components: editedCards(2) } },
    });

    expect(made).toMatchObject({
      kit: { parts: { carousel: { state: "submitted", cardCount: 2 } } },
    });
  });
});

describe("editProductKitPart", () => {
  const editPart = (kitId: unknown, request: Stored) =>
    editProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId: String(kitId),
      request: { requestId: "edit-0001", ...request } as never,
    });
  const carouselEdit = (kitId: unknown, extra: Stored = {}) => ({
    part: "carousel",
    name: carouselTemplateName(new Date(), kitId as Types.ObjectId),
    components: editedCards(3, "Жаңа сөздер"),
    ...extra,
  });

  it("sends an approved carousel's edits to Meta as a new template, and remembers the first", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    mockCreateTemplate.mockResolvedValue({
      id: "row-2",
      metaTemplateId: "tpl-2",
      metaTemplateStatus: "PENDING",
    });
    const request = carouselEdit(kit._id);

    const outcome = await editPart(kit._id, request);

    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: request.name,
        whatsappData: expect.objectContaining({
          components: request.components,
        }),
      })
    );
    expect(mockPrepareCarousel).not.toHaveBeenCalled();
    // A name airi made for this kit: Meta isn't asked about it first.
    expect(mockFindTemplate).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kit: {
        status: "waiting_for_meta",
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-2",
            templateName: request.name,
            metaStatus: "PENDING",
            edited: true,
            earlier: [
              {
                templateId: "tpl-1",
                templateName: "products_20261102_041405",
                metaStatus: "APPROVED",
              },
            ],
          },
          // The other part is left as it is.
          orderForm: { state: "ready", flowId: "flow-1" },
        },
      },
    });
    expect(read(mockKits.docs[0], "parts.carousel")).toMatchObject({
      components: request.components,
      lastEditRequestId: "edit-0001",
    });
  });

  it("remembers at most 10 earlier templates, dropping the oldest, and sends a rejected one's edits too", async () => {
    const earlier = Array.from({ length: 10 }, (_, index) => ({
      templateId: `tpl-old-${index}`,
      templateName: `products_old_${index}`,
      metaStatus: "REJECTED",
      replacedAt: ago(60_000 * (20 - index)),
    }));
    const kit = withCarousel({ metaStatus: "REJECTED", earlier });
    mockKits.add(kit);

    const outcome = (await editPart(kit._id, carouselEdit(kit._id))) as {
      kit: { parts: { carousel: { earlier: Stored[] } } };
    };

    const kept = outcome.kit.parts.carousel.earlier;
    expect(kept).toHaveLength(10);
    expect(kept[0]).toMatchObject({ templateId: "tpl-old-1" });
    expect(kept[9]).toMatchObject({
      templateId: "tpl-1",
      metaStatus: "REJECTED",
    });
  });

  it("answers the same press again with the kit, sending nothing twice", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    const request = carouselEdit(kit._id);

    await editPart(kit._id, request);
    const again = await editPart(kit._id, request);

    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({
      kit: { parts: { carousel: { state: "submitted", edited: true } } },
    });
  });

  it("looks for a timed-out carousel at Meta first, and sends nothing when Meta has it", async () => {
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      error: { code: "timed_out", message: null },
    });
    mockKits.add(kit);
    mockFindTemplate.mockResolvedValue({ id: "tpl-7", status: "PENDING" });

    const outcome = await editPart(kit._id, carouselEdit(kit._id));

    expect(mockFindTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "products_20261102_041405" })
    );
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      carouselFound: {
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-7",
            templateName: "products_20261102_041405",
            edited: false,
          },
        },
      },
    });
  });

  it("sends the edits under the new name once Meta hasn't the timed-out one, and waits when Meta can't say", async () => {
    const lost = {
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      error: { code: "timed_out", message: null },
    };
    const unsure = withCarousel(lost);
    mockKits.add(unsure);
    mockFindTemplate.mockRejectedValueOnce(new Error("Meta is down"));
    expect(await editPart(unsure._id, carouselEdit(unsure._id))).toEqual({
      refused: "meta_unavailable",
    });
    expect(mockCreateTemplate).not.toHaveBeenCalled();

    const request = carouselEdit(unsure._id);
    const outcome = await editPart(unsure._id, request);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: request.name })
    );
    expect(outcome).toMatchObject({
      kit: {
        parts: {
          carousel: { state: "submitted", templateId: "tpl-1", earlier: [] },
        },
      },
    });
  });

  it("keeps the kit on its carousel when Meta refuses the edit, in Meta's words", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    mockCreateTemplate.mockRejectedValue(
      metaRefusal("The card's text breaks a policy.")
    );

    const outcome = await editPart(kit._id, carouselEdit(kit._id));

    expect(outcome).toMatchObject({
      metaRefused: {
        words: "Invalid parameter - The card's text breaks a policy.",
        kit: {
          parts: {
            carousel: {
              state: "submitted",
              templateId: "tpl-1",
              templateName: "products_20261102_041405",
              metaStatus: "APPROVED",
              edited: false,
              earlier: [],
              error: null,
            },
          },
        },
      },
    });
    // The same press may go again.
    expect(
      read(mockKits.docs[0], "parts.carousel.lastEditRequestId")
    ).toBeNull();
  });

  it("refuses a name this kit already sent under", async () => {
    const kit = storedKit();
    mockKits.add(kit);

    expect(
      await editPart(
        kit._id,
        carouselEdit(kit._id, { name: "products_20261102_041405" })
      )
    ).toEqual({ refused: "template_name_taken" });
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("waits while the part is made or looked for at Meta", async () => {
    for (const state of ["making", "checking"]) {
      mockKits.reset();
      const kit = withCarousel({
        state,
        templateId: null,
        updatedAt: new Date(),
      });
      mockKits.add(kit);
      expect(await editPart(kit._id, carouselEdit(kit._id))).toEqual({
        refused: "kit_part_busy",
      });
    }
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("refuses edits that fail the checks, and finds no other workspace's kit", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    expect(
      await editPart(
        kit._id,
        carouselEdit(kit._id, { components: editedCards(11) })
      )
    ).toEqual({ invalid: [expect.any(String)] });

    const theirs: Stored = { ...storedKit(), workspaceId: "workspace-2" };
    mockKits.add(theirs);
    expect(await editPart(theirs._id, carouselEdit(theirs._id))).toBeNull();
    expect(await editPart("nope", carouselEdit(kit._id))).toBeNull();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("keeps checking with Meta when its answer to the edit is lost", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
    });
    try {
      const kit = storedKit();
      mockKits.add(kit);
      mockCreateTemplate.mockRejectedValue(
        wrapped(new DOMException("The operation timed out", "TimeoutError"))
      );
      const request = carouselEdit(kit._id);

      const running = editPart(kit._id, request);
      await flush();
      await jest.advanceTimersByTimeAsync(6_000);
      await flush();
      const outcome = await running;

      expect(mockFindTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ name: request.name })
      );
      expect(outcome).toMatchObject({
        kit: {
          status: "making",
          parts: {
            carousel: {
              state: "checking",
              templateName: request.name,
              earlier: [{ templateId: "tpl-1" }],
            },
          },
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("publishes a published form's edits as a new Flow, its next version, and remembers the first", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    mockCreateOrderForm.mockResolvedValue({
      ok: true,
      flowId: "flow-2",
      name: "Order form · 2 Nov 13:14 · v2",
      leftOut: 0,
    });

    const outcome = await editPart(kit._id, {
      part: "orderForm",
      config: editedForm(),
    });

    const call = mockCreateOrderForm.mock.calls[0]![0];
    expect(call).toMatchObject({
      name: "Order form · 2 Nov 13:14 · v2",
      config: expect.objectContaining({
        screens: [expect.objectContaining({ title: "Сіздің тапсырысыңыз" })],
      }),
    });
    expect(call.flowId).toBeUndefined();
    expect(mockUpdateFlow).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "flow-2", operation: "publish" })
    );
    expect(outcome).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "ready",
            flowId: "flow-2",
            flowName: "Order form · 2 Nov 13:14 · v2",
            version: 2,
            edited: true,
            earlier: [
              { flowId: "flow-1", flowName: "Order form · 2 Nov 13:14" },
            ],
          },
          carousel: { state: "submitted", templateId: "tpl-1" },
        },
      },
    });
  });

  it("gives a draft form its edits in place, then publishes it", async () => {
    const kit = storedKit();
    (kit.parts as Record<string, Stored>).orderForm = {
      ...(kit.parts as Record<string, Stored>).orderForm,
      state: "draft",
      flowId: "flow-5",
      error: { code: "meta_refused", message: "Not published" },
    };
    mockKits.add(kit);
    mockGetFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: { id: "flow-5", status: "DRAFT" },
    });

    const outcome = await editPart(kit._id, {
      part: "orderForm",
      config: editedForm(),
    });

    expect(mockCreateOrderForm).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "flow-5" })
    );
    expect(outcome).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "ready",
            flowId: "flow-5",
            version: 1,
            edited: true,
            earlier: [],
            error: null,
          },
        },
      },
    });
  });

  it("deletes a new version Meta won't publish, and keeps the published form", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    mockCreateOrderForm.mockResolvedValue({
      ok: true,
      flowId: "flow-2",
      name: "Order form · 2 Nov 13:14 · v2",
      leftOut: 0,
    });
    mockUpdateFlow.mockResolvedValue({
      ok: false,
      status: 400,
      error: "WhatsApp API error: Flow can't be published",
    });

    const outcome = await editPart(kit._id, {
      part: "orderForm",
      config: editedForm(),
    });

    expect(deleteMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "token",
      flowId: "flow-2",
    });
    expect(outcome).toMatchObject({
      metaRefused: {
        words: "Flow can't be published",
        kit: {
          parts: {
            orderForm: {
              state: "ready",
              flowId: "flow-1",
              version: 1,
              edited: false,
              earlier: [],
            },
          },
        },
      },
    });
  });

  it("keeps the published form when Meta refuses a new version's questions", async () => {
    const kit = storedKit();
    mockKits.add(kit);
    mockCreateOrderForm.mockResolvedValue({
      ok: false,
      reason: "refused",
      error: "WhatsApp API error: Invalid Flow JSON",
    });

    const outcome = await editPart(kit._id, {
      part: "orderForm",
      config: editedForm(),
    });

    // createOrderFormDraft deletes a Flow whose JSON Meta refused itself.
    expect(deleteMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockUpdateFlow).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      metaRefused: {
        words: "Invalid Flow JSON",
        kit: {
          parts: {
            orderForm: {
              state: "ready",
              flowId: "flow-1",
              version: 1,
              earlier: [],
            },
          },
        },
      },
    });
    expect(
      read(mockKits.docs[0], "parts.orderForm.lastEditRequestId")
    ).toBeNull();
  });
});

describe("editing again after a refused or lost send", () => {
  const editPart = (kitId: unknown, request: Stored) =>
    editProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId: String(kitId),
      request: { requestId: "edit-0001", ...request } as never,
    });
  const retry = (kitId: unknown, part: "carousel" | "orderForm") =>
    retryProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId: String(kitId),
      part,
    });
  const withForm = (form: Stored) => {
    const kit = storedKit();
    const parts = kit.parts as Record<string, Stored>;
    parts.orderForm = { ...parts.orderForm, ...form };
    return kit;
  };

  it("sends the same name again after Meta refused the edit of a failed carousel", async () => {
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      metaStatus: null,
      error: { code: "meta_refused", message: "Invalid parameter" },
    });
    mockKits.add(kit);
    const request = {
      part: "carousel",
      name: carouselTemplateName(new Date(), kit._id as Types.ObjectId),
      components: editedCards(3, "Жаңа сөздер"),
    };
    mockCreateTemplate.mockRejectedValueOnce(
      metaRefusal("The card's text breaks a policy.")
    );
    expect(await editPart(kit._id, request)).toMatchObject({
      metaRefused: { kit: { parts: { carousel: { state: "failed" } } } },
    });

    // The owner fixes the card and presses again under the same name: Meta
    // never made a template under it, so it isn't taken.
    const outcome = await editPart(kit._id, {
      ...request,
      requestId: "edit-0002",
    });

    expect(mockCreateTemplate).toHaveBeenCalledTimes(2);
    for (const [call] of mockCreateTemplate.mock.calls)
      expect(call).toMatchObject({ name: request.name });
    expect(outcome).toMatchObject({
      kit: {
        parts: {
          carousel: {
            state: "submitted",
            templateId: "tpl-1",
            templateName: request.name,
          },
        },
      },
    });
  });

  it("sends the same name again after a lost edit of an approved carousel that Meta doesn't list", async () => {
    const kit = storedKit();
    const name = carouselTemplateName(
      ago(10 * 60_000),
      kit._id as Types.ObjectId
    );
    const parts = kit.parts as Record<string, Stored>;
    parts.carousel = {
      ...parts.carousel,
      state: "failed",
      templateId: null,
      templateName: name,
      metaStatus: null,
      error: { code: "timed_out", message: null },
      earlier: [
        {
          templateId: "tpl-1",
          templateName: "products_20261102_041405",
          metaStatus: "APPROVED",
          replacedAt: ago(11 * 60_000),
        },
      ],
    };
    mockKits.add(kit);

    const outcome = await editPart(kit._id, {
      part: "carousel",
      name,
      components: editedCards(3, "Жаңа сөздер"),
    });

    expect(mockFindTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name })
    );
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name })
    );
    expect(outcome).toMatchObject({
      kit: { parts: { carousel: { state: "submitted", templateName: name } } },
    });
    // The approved one, kept in `earlier`, is still taken.
    expect(
      await editPart(kit._id, {
        requestId: "edit-0002",
        part: "carousel",
        name: "products_20261102_041405",
        components: editedCards(3),
      })
    ).toEqual({ refused: "template_name_taken" });
  });

  it("looks again for a carousel whose send failed moments ago, rather than send the edits under a new name", async () => {
    const failedAt = ago(30_000);
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      error: { code: "failed", message: null },
      updatedAt: failedAt,
    });
    mockKits.add(kit);

    const outcome = await editPart(kit._id, carouselEditFor(kit._id));

    expect(mockCreateTemplate).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      refused: "kit_part_busy",
      kit: {
        parts: {
          carousel: {
            state: "checking",
            templateName: "products_20261102_041405",
          },
        },
      },
    });
    // Its 3 minutes count from the failure.
    expect(read(mockKits.docs[0], "parts.carousel.updatedAt")).toEqual(
      failedAt
    );

    // One that failed long ago goes as before.
    mockKits.reset();
    const old = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      error: { code: "failed", message: null },
      updatedAt: ago(10 * 60_000),
    });
    mockKits.add(old);
    expect(await editPart(old._id, carouselEditFor(old._id))).toMatchObject({
      kit: { parts: { carousel: { state: "submitted" } } },
    });
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("makes no second Flow while Meta can't say what became of a draft form's", async () => {
    const kit = withForm({
      state: "draft",
      flowId: "flow-5",
      error: { code: "meta_refused", message: "Not published" },
    });
    mockKits.add(kit);
    mockGetFlow.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: "Service unavailable",
    });

    expect(
      await editPart(kit._id, { part: "orderForm", config: editedForm() })
    ).toEqual({ refused: "meta_unavailable" });
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
    expect(read(mockKits.docs[0], "parts.orderForm")).toMatchObject({
      state: "draft",
      flowId: "flow-5",
    });

    // The read works, then a second one fails (a rate limit): the part
    // fails with its Flow kept, so Try again finishes it.
    mockGetFlow
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: { id: "flow-5", status: "DRAFT" },
      })
      .mockResolvedValueOnce({ ok: false, status: 400, providerCode: 4 });
    expect(
      await editPart(kit._id, {
        requestId: "edit-0002",
        part: "orderForm",
        config: editedForm(),
      })
    ).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "failed",
            flowId: "flow-5",
            error: { code: "failed" },
          },
        },
      },
    });
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
  });

  it("finishes a failed form's Flow on Try again only once Meta can say what became of it", async () => {
    const kit = withForm({
      state: "failed",
      flowId: "flow-9",
      error: { code: "failed", message: null },
      updatedAt: ago(120_000),
    });
    mockKits.add(kit);
    mockGetFlow.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: "fetch failed",
    });

    expect(await retry(kit._id, "orderForm")).toMatchObject({
      kit: { parts: { orderForm: { state: "failed", flowId: "flow-9" } } },
    });
    expect(mockCreateOrderForm).not.toHaveBeenCalled();
  });

  it("makes a new Flow for a draft form Meta no longer has", async () => {
    const kit = withForm({
      state: "draft",
      flowId: "flow-5",
      error: { code: "meta_refused", message: "Not published" },
    });
    mockKits.add(kit);
    // Graph's "no such object", twice: the edit's read and Make's.
    mockGetFlow.mockResolvedValue({
      ok: false,
      status: 400,
      providerCode: 100,
      providerSubcode: 33,
    });

    const outcome = await editPart(kit._id, {
      part: "orderForm",
      config: editedForm(),
    });

    expect(mockCreateOrderForm).toHaveBeenCalledTimes(1);
    expect(mockCreateOrderForm.mock.calls[0]![0].flowId).toBeUndefined();
    expect(outcome).toMatchObject({
      kit: { parts: { orderForm: { state: "ready", flowId: "flow-1" } } },
    });
  });

  it("keeps a new form version's name when Try again makes it again", async () => {
    // The new version's create failed on airi's side, before Meta made it.
    const kit = storedKit();
    mockKits.add(kit);
    mockCreateOrderForm.mockRejectedValueOnce(new Error("socket hang up"));
    expect(
      await editPart(kit._id, { part: "orderForm", config: editedForm() })
    ).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "failed",
            flowId: null,
            flowName: "Order form · 2 Nov 13:14 · v2",
            version: 2,
          },
        },
      },
    });

    const retried = await retry(kit._id, "orderForm");

    expect(mockCreateOrderForm).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Order form · 2 Nov 13:14 · v2" })
    );
    expect(retried).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "ready",
            flowName: "Order form · 2 Nov 13:14 · v2",
            version: 2,
          },
        },
      },
    });
  });

  it("keeps a new form version's name when Try again follows Meta refusing it", async () => {
    const kit = withForm({
      state: "failed",
      flowId: null,
      flowName: "Order form · 2 Nov 13:14 · v2",
      version: 2,
      error: { code: "meta_refused", message: "Invalid Flow JSON" },
    });
    mockKits.add(kit);

    const retried = await retry(kit._id, "orderForm");

    expect(mockCreateOrderForm).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Order form · 2 Nov 13:14 · v2" })
    );
    expect(mockCreateOrderForm.mock.calls[0]![0].flowId).toBeUndefined();
    expect(retried).toMatchObject({
      kit: {
        parts: {
          orderForm: {
            state: "ready",
            flowName: "Order form · 2 Nov 13:14 · v2",
            version: 2,
          },
        },
      },
    });
  });
});

/** A carousel edit under a name airi made for this kit. */
const carouselEditFor = (kitId: unknown) => ({
  part: "carousel",
  name: carouselTemplateName(new Date(), kitId as Types.ObjectId),
  components: editedCards(3, "Жаңа сөздер"),
});

describe("retryProductKitPart with edits", () => {
  it("sends the owner's edited cards again, not the shelf's", async () => {
    const cards = editedCards(2);
    const kit = withCarousel({
      state: "failed",
      templateId: null,
      templateName: "products_20261102_041405",
      metaStatus: null,
      components: cards,
      edited: true,
      error: { code: "timed_out", message: null },
    });
    mockKits.add(kit);

    const result = await retryProductKitPart({
      workspaceId: WS,
      userId: "user-1",
      kitId: String(kit._id),
      part: "carousel",
    });

    expect(mockPrepareCarousel).not.toHaveBeenCalled();
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "products_20261102_041405",
        whatsappData: expect.objectContaining({ components: cards }),
      })
    );
    expect(result).toMatchObject({
      kit: {
        parts: { carousel: { state: "submitted", cardCount: 2, edited: true } },
      },
    });
  });
});

describe("productKitEditSource", () => {
  it("opens the cards as sent, under a new name for this kit", async () => {
    const cards = editedCards(2);
    const kit = withCarousel({ components: cards, edited: true });
    mockKits.add(kit);

    const source = await productKitEditSource({
      workspaceId: WS,
      kitId: String(kit._id),
      part: "carousel",
    });

    expect(source).toMatchObject({
      kit: { id: String(kit._id) },
      carousel: { language: "kk", components: cards },
    });
    const name = (source as { carousel: { name: string } }).carousel.name;
    expect(name).toMatch(/^products_\d{8}_\d{6}_[0-9a-f]{6}$/);
    expect(name.endsWith(`_${kitSuffix(kit._id)}`)).toBe(true);
    expect(mockPrepareCarousel).not.toHaveBeenCalled();
  });

  it("makes a kit from before v2's cards and questions again from the shelf", async () => {
    const kit = storedKit();
    mockKits.add(kit);

    const cards = await productKitEditSource({
      workspaceId: WS,
      kitId: String(kit._id),
      part: "carousel",
    });
    const form = await productKitEditSource({
      workspaceId: WS,
      kitId: String(kit._id),
      part: "orderForm",
    });

    expect(mockPrepareCarousel).toHaveBeenCalledTimes(1);
    expect(
      (cards as { carousel: { components: unknown[] } }).carousel.components
    ).toHaveLength(2);
    const config = (form as { orderForm: { config: { screens: Stored[] } } })
      .orderForm.config;
    expect(
      (
        config.screens[0]!.fields as Array<{ id: string; options?: Stored[] }>
      )[0]!.options!.map(option => option.id)
    ).toEqual([productId(1), productId(2), productId(3)]);
  });

  it("finds no other workspace's kit", async () => {
    const theirs: Stored = { ...storedKit(), workspaceId: "workspace-2" };
    mockKits.add(theirs);
    expect(
      await productKitEditSource({
        workspaceId: WS,
        kitId: String(theirs._id),
        part: "carousel",
      })
    ).toBeNull();
  });
});

describe("prepareProductKitDrafts", () => {
  it("puts the products on cards in the buyers' language, under a name made again at Make", async () => {
    shelf = [shelfRow(1), shelfRow(2, { options: [] }), shelfRow(3)];

    const drafts = await prepareProductKitDrafts(WS, {
      productIds: [productId(1), productId(2), productId(3)],
      language: "ru",
    });

    expect(mockPrepareCarousel).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ language: "ru" }),
      expect.any(Date)
    );
    expect(drafts).toMatchObject({
      carousel: {
        language: "ru",
        productIds: [productId(1), productId(3)],
        leftOut: 0,
        name: expect.stringMatching(/^products_\d{8}_\d{6}_[0-9a-f]{6}$/),
      },
    });
    expect(
      (drafts as ProductKitDraftsResponse).carousel.components
    ).toHaveLength(2);
  });

  it("says when there aren't enough products", async () => {
    shelf = [];
    expect(
      await prepareProductKitDrafts(WS, {
        productIds: [productId(1)],
        language: "kk",
      })
    ).toEqual({ refused: "not_enough_products" });
    shelf = [shelfRow(1)];
    mockPrepareCarousel.mockResolvedValue(null);
    expect(
      await prepareProductKitDrafts(WS, {
        productIds: [productId(1)],
        language: "kk",
      })
    ).toEqual({ refused: "not_enough_products" });
  });
});
