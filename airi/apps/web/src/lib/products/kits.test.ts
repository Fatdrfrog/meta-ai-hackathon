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
  listProductKitRecords,
  loadShelfProducts,
  makeProductKit,
  orderFormName,
  readProductKit,
  readProductKitPlan,
  retryProductKitPart,
} from "./kits";
import type { ProductCarouselDraft } from "./types";

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
    });
    expect(kit.parts.carousel.templateName).toMatch(/^products_\d{8}_\d{6}$/);
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

  it("doesn't call airi's own timeout or failure Meta refusing the carousel", async () => {
    // createTemplate's 10 s AbortSignal.timeout on the Graph POST, as the
    // unified service wraps it: Meta refused nothing (and may have the template).
    mockCreateTemplate.mockRejectedValueOnce(
      wrapped(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        )
      )
    );
    const timedOut = (await make()) as { kit: Record<string, unknown> };
    expect(timedOut.kit).toMatchObject({
      parts: {
        carousel: {
          state: "failed",
          error: { code: "timed_out", message: null },
        },
      },
    });

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

  it("names the template to the second in UTC, and the form on the owner's clock", () => {
    expect(carouselTemplateName(at)).toBe("products_20261102_041405");
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
      templateName: expect.stringMatching(/^products_\d{8}_\d{6}$/),
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
    expect(name).toMatch(/^products_\d{8}_\d{6}$/);
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
