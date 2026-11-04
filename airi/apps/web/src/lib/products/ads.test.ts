/** @jest-environment node */

// Video ads on the web: the brief's checks, the snapshot, admission to the AI
// ledger, starting each run, and the ad as the page reads it. The product_ads
// collection is an in-memory stand-in that keeps the model's defaults.

type Doc = Record<string, unknown>;

const mockAds: Doc[] = [];
const mockProductFind = jest.fn();
const mockImportFind = jest.fn();
const mockAllowance = jest.fn();
const mockStart = jest.fn();
const mockWhatsApp = jest.fn();
const mockWorkspaceName = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

/** Whether a stored document matches a filter of plain values and $ne. */
function mockMatches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$ne" in value)
      return doc[key] !== (value as { $ne: unknown }).$ne;
    return String(doc[key]) === String(value);
  });
}

function mockQuery(result: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => result),
  };
}

/** A deep copy, as a query returns one; dates stay this realm's dates. */
function mockCopy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(mockCopy) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mockCopy(entry)])
    ) as T;
  return value;
}

const mockProductAd = {
  findOne: jest.fn((filter: Doc) =>
    mockQuery(mockCopy(mockAds.find(doc => mockMatches(doc, filter)) ?? null))
  ),
  find: jest.fn((filter: Doc) =>
    mockQuery(mockCopy(mockAds.filter(doc => mockMatches(doc, filter))))
  ),
  create: jest.fn(async (doc: Doc) => {
    if (
      mockAds.some(
        ad =>
          ad.workspaceId === doc.workspaceId && ad.requestId === doc.requestId
      )
    )
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const saved: Doc = {
      script: null,
      scenes: [],
      stills: { status: null, feed: null },
      render: null,
      costMicros: 0,
      startedAt: null,
      timings: {},
      readyAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: doc.requestedAt,
      updatedAt: doc.requestedAt,
      ...doc,
      _id: String(doc._id),
    };
    mockAds.push(saved);
    return saved;
  }),
  updateOne: jest.fn(async (filter: Doc, update: { $set: Doc }) => {
    const doc = mockAds.find(entry => mockMatches(entry, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }),
  findOneAndUpdate: jest.fn((filter: Doc, update: { $set: Doc }) => {
    const doc = mockAds.find(entry => mockMatches(entry, filter));
    if (doc) Object.assign(doc, update.$set);
    return mockQuery(mockCopy(doc ?? null));
  }),
};

jest.mock("@/models/product-ad", () => ({
  ProductAd: {
    findOne: (...args: [Doc]) => mockProductAd.findOne(...args),
    find: (...args: [Doc]) => mockProductAd.find(...args),
    create: (...args: [Doc]) => mockProductAd.create(...args),
    updateOne: (...args: [Doc, { $set: Doc }]) =>
      mockProductAd.updateOne(...args),
    findOneAndUpdate: (...args: [Doc, { $set: Doc }]) =>
      mockProductAd.findOneAndUpdate(...args),
  },
}));
jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: { find: (...args: unknown[]) => mockProductFind(...args) },
}));
jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: { find: (...args: unknown[]) => mockImportFind(...args) },
}));
jest.mock("@/lib/products/import-spend", () => ({
  productImportSpend: {
    allowance: (...args: unknown[]) => mockAllowance(...args),
  },
}));
jest.mock("@/lib/temporal/product-ad", () => ({
  startProductAdWorkflow: (...args: unknown[]) => mockStart(...args),
}));
jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) => mockWhatsApp(...args),
}));
// Supabase: the workspace's name, and the AI ledger's rows the picture
// budget reads, by table.
const mockLedgerRow = jest.fn();
const mockLedgerFilters: Array<{ table: string; filters: string[] }> = [];
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let columns = "";
      const filters: string[] = [];
      const query = {
        select: (selected: string) => {
          columns = selected;
          return query;
        },
        eq: (column: string, value: unknown) => {
          filters.push(`${column}=${String(value)}`);
          return query;
        },
        maybeSingle: async () => {
          if (table === "workspaces" && columns === "name")
            return mockWorkspaceName();
          mockLedgerFilters.push({ table, filters });
          return mockLedgerRow(table, columns);
        },
      };
      return query;
    },
  },
}));
jest.mock("@/lib/products/photo-urls", () => ({
  withProductPhotoUrls: (work: () => Promise<unknown>) => work(),
  productPhotoUrl: async (
    _workspaceId: string,
    ref: { bucket?: string; path?: string } | null | undefined
  ) => (ref?.path ? `https://signed.test/${ref.path}` : null),
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

import {
  adPostText,
  adPricesChanged,
  adProductProblem,
  adUnsupportedTexts,
  createProductAd,
  listProductAdRecords,
  loadAdShelf,
  loadProductAdBrief,
  loadProductAdRecord,
  redoProductAdScene,
  retryProductAd,
  updateProductAdWords,
} from "./ads";
import type { ProductAdScript } from "./types";

const WS = "workspace-1";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const CLOCK = "651f1f77bcf86cd799439013";
const OLD_IMPORT = "651f1f77bcf86cd799439021";
const NEW_IMPORT = "651f1f77bcf86cd799439022";
const NBSP = " ";
// Not a real number: the ads only carry what Meta displays.
const SHOP_NUMBER = "shop-number";
const NOW = new Date("2026-11-02T09:14:00.000Z");

const ref = (path: string) => ({ bucket: "media", path });

function productRow(id: string, overrides: Doc = {}): Doc {
  return {
    _id: id,
    name: "Кукла Лол",
    englishName: "LOL doll",
    price: 5000,
    currency: "KZT",
    priceIsFrom: false,
    priceQuote: "кукла бес мың",
    importId: NEW_IMPORT,
    featuredOption: 0,
    options: [
      {
        description: "doll in a blue dress",
        samPhrase: "toy doll",
        photo: {
          cutout: ref(`products/${id}/cutout.png`),
          thumb: ref(`products/${id}/thumb.webp`),
          original: ref(`products/${id}/original.jpg`),
        },
      },
    ],
    clip: { video: ref(`products/${id}/clip.mp4`) },
    ...overrides,
  };
}

const mug = (overrides: Doc = {}) =>
  productRow(MUG, {
    name: "Кружка Web UMN",
    englishName: "Web UMN mug",
    price: 500,
    priceQuote: "бес жүз",
    clip: null,
    ...overrides,
  });

const imports = [
  {
    _id: NEW_IMPORT,
    language: "Kazakh",
    presenter: {
      photo: {
        cutout: ref("imports/new/presenter.png"),
        thumb: ref("imports/new/presenter.webp"),
      },
    },
  },
  { _id: OLD_IMPORT, language: "Russian", presenter: null },
];

const allowance = (overrides: Doc = {}) => ({
  includedActions: 100,
  remainingActions: 12,
  spendLimitReached: false,
  spendRemainingMicros: 5_000_000,
  trialEnded: false,
  ...overrides,
});

/** The allowance's answer for a company that turned AI off (main's WorkspaceAiAccessError). */
const aiDisabled = () =>
  Object.assign(new Error("AI is disabled for this company."), {
    code: "workspace_ai_disabled",
  });

const brief = (overrides: Doc = {}) => ({
  requestId: "press-1",
  productIds: [DOLL, MUG],
  idea: { kind: "new" as const },
  voice: "own" as const,
  presenter: { use: false, consent: false },
  ...overrides,
});

const script = (overrides: Partial<ProductAdScript> = {}): ProductAdScript => ({
  sticker: "Сөреде жаңа тауарлар",
  scenes: [
    {
      productId: DOLL,
      caption: "Көк көйлекті қуыршақ",
      setting: "oak_table_window",
    },
    { productId: MUG, caption: "Күнделікті кружка", setting: "linen_shelf" },
  ],
  priceCardTitle: "Екеуі де сөреде",
  ending: "WhatsApp-қа жазыңыз",
  postIntro: "Сөремізге жаңа тауарлар келді!",
  ctwa: {
    headline: "Жаңа ойыншықтар",
    primaryText: "Кукла мен кружка сөреде күтіп тұр.",
    greeting: "Сәлеметсіз бе! Қайсысы ұнады?",
    questions: ["Кукла бар ма?", "Жеткізу қанша?", "Тапсырыс беремін"],
  },
  edited: false,
  ...overrides,
});

/** A finished ad, as the worker leaves it. */
function readyAd(id: string, overrides: Doc = {}): Doc {
  return {
    _id: id,
    workspaceId: WS,
    requestId: `press-${id}`,
    createdBy: "user-1",
    status: "ready",
    requestedAt: NOW,
    step: null,
    errorCode: null,
    errorMessage: null,
    language: "Kazakh",
    wordsCode: "kk",
    idea: { kind: "new", text: null },
    voice: "own",
    presenter: {
      use: true,
      consentAt: NOW,
      photo: ref("imports/new/presenter.png"),
      thumb: ref("imports/new/presenter.webp"),
    },
    ending: { phone: SHOP_NUMBER, shopName: "QazOner Group" },
    products: [
      {
        productId: DOLL,
        importId: NEW_IMPORT,
        name: "Кукла Лол",
        englishName: "LOL doll",
        priceText: `5${NBSP}000${NBSP}₸`,
        priceQuote: "кукла бес мың",
        cutout: ref(`products/${DOLL}/cutout.png`),
        thumb: ref(`products/${DOLL}/thumb.webp`),
        original: null,
        clip: ref(`products/${DOLL}/clip.mp4`),
        samPhrase: "toy doll",
        description: "",
      },
      {
        productId: MUG,
        importId: NEW_IMPORT,
        name: "Кружка Web UMN",
        englishName: "Web UMN mug",
        priceText: `500${NBSP}₸`,
        priceQuote: null,
        cutout: ref(`products/${MUG}/cutout.png`),
        thumb: null,
        original: null,
        clip: null,
        samPhrase: "mug",
        description: "",
      },
    ],
    script: script(),
    scenes: [
      {
        productId: DOLL,
        exact: ref(`ads/${id}/exact-${DOLL}.png`),
        muse: ref(`ads/${id}/scene-${DOLL}-a1.png`),
        method: "muse",
        check: { same: true, difference: null },
        box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
        attempts: 1,
      },
      {
        productId: MUG,
        exact: ref(`ads/${id}/exact-${MUG}.png`),
        muse: null,
        method: "exact",
        check: { same: false, difference: "The logo changed." },
        box: null,
        attempts: 2,
      },
    ],
    stills: {
      status: ref(`ads/${id}/r1/status.jpg`),
      feed: ref(`ads/${id}/r1/feed.jpg`),
    },
    renderNo: 1,
    render: {
      renderNo: 1,
      video: ref(`ads/${id}/r1/ad.mp4`),
      bytes: 3_355_443,
      seconds: 14.2,
      width: 1080,
      height: 1920,
      poster: ref(`ads/${id}/r1/poster.jpg`),
      ms: 31_000,
    },
    actionId: `product-ad:${id}`,
    costMicros: 52_000,
    startedAt: new Date("2026-11-02T09:14:04.000Z"),
    timings: {
      script: {
        startedAt: new Date("2026-11-02T09:14:04.000Z"),
        finishedAt: new Date("2026-11-02T09:14:11.000Z"),
      },
    },
    workflowId: `product-ad:${id}:r1`,
    readyAt: new Date("2026-11-02T09:15:08.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const AD = "751f1f77bcf86cd799439031";

/**
 * The AI ledger's rows for the picture budget: a Pro company with no
 * override, whose plan lets one action spend $0.50, and this ad's action
 * at $0.08 committed: (500 000 - 80 000) / 47 500 leaves 8 new pictures.
 */
function ledger(rows: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    workspaces: {
      company_id: "company-1",
      companies: { subscription_type: "pro" },
    },
    workspace_text_ai_actions: { committed_micros: 80_000 },
    company_ai_usage: { action_spend_limit_micros: null },
    ai_sponsorship_policies: { action_spend_limit_micros: 500_000 },
    ...rows,
  };
  return (table: string) => ({ data: all[table] ?? null, error: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAds.length = 0;
  mockLedgerFilters.length = 0;
  mockLedgerRow.mockImplementation(ledger());
  mockProductFind.mockImplementation(() =>
    mockQuery([productRow(DOLL), mug()])
  );
  mockImportFind.mockImplementation(() => mockQuery(imports));
  mockAllowance.mockResolvedValue(allowance());
  mockStart.mockImplementation(
    async (input: { adId: string; renderNo: number }) => ({
      workflowId: `product-ad:${input.adId}:r${input.renderNo}`,
    })
  );
  mockWhatsApp.mockResolvedValue({
    context: {
      credentials: { accessToken: "token", displayPhoneNumber: SHOP_NUMBER },
    },
  });
  mockWorkspaceName.mockResolvedValue({ data: { name: "QazOner  Group " } });
});

describe("the products an ad shows", () => {
  it("needs each product's cut-out and a price", () => {
    expect(adProductProblem({ cutout: ref("c.png"), price: 5000 })).toBeNull();
    expect(adProductProblem({ cutout: null, price: 5000 })).toBe("no_photo");
    expect(adProductProblem({ cutout: ref("c.png"), price: null })).toBe(
      "no_price"
    );
  });

  it("reads the picked products in the order picked, with the newest video's language and presenter", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([mug({ importId: OLD_IMPORT }), productRow(DOLL)])
    );

    const shelf = await loadAdShelf(WS, [DOLL, CLOCK, MUG]);

    expect(mockProductFind).toHaveBeenCalledWith({
      workspaceId: WS,
      status: "published",
      _id: { $in: [DOLL, CLOCK, MUG] },
    });
    expect(shelf.products.map(product => product.id)).toEqual([DOLL, MUG]);
    expect(shelf.missing).toBe(1);
    expect(mockImportFind).toHaveBeenCalledWith({
      workspaceId: WS,
      _id: { $in: [NEW_IMPORT, OLD_IMPORT] },
    });
    expect(shelf.language).toBe("Kazakh");
    expect(shelf.presenter).toEqual({
      cutout: ref("imports/new/presenter.png"),
      thumb: ref("imports/new/presenter.webp"),
    });
    expect(shelf.products[0]).toMatchObject({
      cutout: ref(`products/${DOLL}/cutout.png`),
      clip: ref(`products/${DOLL}/clip.mp4`),
      samPhrase: "toy doll",
    });
    // Older imports have no SAM phrase: the English name stands in.
    mockProductFind.mockImplementation(() =>
      mockQuery([
        productRow(DOLL, {
          options: [{ description: "doll", photo: { cutout: ref("c.png") } }],
        }),
      ])
    );
    expect((await loadAdShelf(WS, [DOLL])).products[0]!.samPhrase).toBe(
      "LOL doll"
    );
  });

  it("finds nothing to read for products added by hand", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL, { importId: undefined })])
    );

    const shelf = await loadAdShelf(WS, [DOLL]);

    expect(mockImportFind).not.toHaveBeenCalled();
    expect(shelf.language).toBeNull();
    expect(shelf.presenter).toBeNull();
  });

  it("names the texts the ad's fonts can't draw", () => {
    const products = [
      { name: "Кукла Лол әғқң", priceText: `5${NBSP}000${NBSP}₸` },
    ];
    expect(adUnsupportedTexts({ products, ideaText: null })).toEqual([]);
    expect(
      adUnsupportedTexts({
        products: [...products, { name: "東京タワー", priceText: "500 JPY" }],
        ideaText: "Gift 🎁",
      })
    ).toEqual(["東京タワー", "Gift 🎁"]);
  });
});

describe("the brief", () => {
  it("starts from the products as the ad would draw them, the voice clips, the presenter and the ending", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([
        productRow(DOLL, { price: 15500, priceIsFrom: true }),
        mug({ price: null }),
      ])
    );

    const result = await loadProductAdBrief(WS, [DOLL, MUG, CLOCK]);

    expect(result).toEqual({
      products: [
        {
          productId: DOLL,
          name: "Кукла Лол",
          englishName: "LOL doll",
          priceText: `15${NBSP}500${NBSP}₸ бастап`,
          imageUrl: `https://signed.test/products/${DOLL}/thumb.webp`,
          problem: null,
          hasVoice: true,
        },
        {
          productId: MUG,
          name: "Кружка Web UMN",
          englishName: "Web UMN mug",
          priceText: null,
          imageUrl: `https://signed.test/products/${MUG}/thumb.webp`,
          problem: "no_price",
          hasVoice: false,
        },
      ],
      missing: 1,
      language: "Kazakh",
      wordsCode: "kk",
      presenter: { imageUrl: "https://signed.test/imports/new/presenter.webp" },
      ending: { phone: SHOP_NUMBER, shopName: "QazOner Group" },
      blocked: null,
    });
    expect(mockWhatsApp).toHaveBeenCalledWith(WS, {
      requireCredentials: false,
    });
  });

  it("says what stops the workspace paying, and the shop's name without a connected number", async () => {
    mockAllowance.mockResolvedValue(allowance({ trialEnded: true }));
    mockWhatsApp.mockResolvedValue({
      context: { credentials: { displayPhoneNumber: SHOP_NUMBER } },
    });

    const result = await loadProductAdBrief(WS, [DOLL]);

    expect(result.blocked).toBe("trial_ended");
    // A number without its access token isn't connected.
    expect(result.ending).toEqual({ phone: null, shopName: "QazOner Group" });
  });

  it("blocks the brief, saying why, for a company that turned AI off", async () => {
    mockAllowance.mockRejectedValue(aiDisabled());

    const result = await loadProductAdBrief(WS, [DOLL]);

    expect(result.blocked).toBe("ai_disabled");
  });

  it("doesn't block the brief when the allowance can't be read", async () => {
    mockAllowance.mockRejectedValue(new Error("policy unavailable"));
    mockWhatsApp.mockRejectedValue(new Error("supabase down"));

    const result = await loadProductAdBrief(WS, [DOLL]);

    expect(result.blocked).toBeNull();
    expect(result.ending.phone).toBeNull();
  });
});

describe("making an ad", () => {
  it("saves the brief with a snapshot of the products, then starts run 1", async () => {
    const result = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ presenter: { use: true, consent: true } }),
      now: NOW,
    });

    expect(mockProductAd.create).toHaveBeenCalledTimes(1);
    const saved = mockProductAd.create.mock.calls[0]![0] as Doc;
    const adId = String(saved._id);
    expect(adId).toMatch(/^[a-f0-9]{24}$/);
    expect(saved).toMatchObject({
      workspaceId: WS,
      requestId: "press-1",
      createdBy: "user-1",
      status: "making",
      requestedAt: NOW,
      step: null,
      language: "Kazakh",
      wordsCode: "kk",
      idea: { kind: "new", text: null },
      voice: "own",
      presenter: {
        use: true,
        consentAt: NOW,
        photo: ref("imports/new/presenter.png"),
        thumb: ref("imports/new/presenter.webp"),
      },
      ending: { phone: SHOP_NUMBER, shopName: "QazOner Group" },
      renderNo: 1,
      actionId: `product-ad:${adId}`,
    });
    expect(saved.products).toEqual([
      {
        productId: DOLL,
        importId: NEW_IMPORT,
        name: "Кукла Лол",
        englishName: "LOL doll",
        priceText: `5${NBSP}000${NBSP}₸`,
        priceQuote: "кукла бес мың",
        cutout: ref(`products/${DOLL}/cutout.png`),
        thumb: ref(`products/${DOLL}/thumb.webp`),
        original: ref(`products/${DOLL}/original.jpg`),
        clip: ref(`products/${DOLL}/clip.mp4`),
        samPhrase: "toy doll",
        description: "doll in a blue dress",
      },
      expect.objectContaining({
        productId: MUG,
        priceText: `500${NBSP}₸`,
        clip: null,
      }),
    ]);
    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: WS,
      adId,
      renderNo: 1,
      mode: "make",
    });
    expect(mockAds[0]!.workflowId).toBe(`product-ad:${adId}:r1`);
    expect(result).toMatchObject({
      created: true,
      ad: { id: adId, status: "making", renderNo: 1 },
    });
  });

  it("saves the Reel tile's motion, and none for a brief without one", async () => {
    await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ requestId: "press-motion", motion: "filmed_sold" }),
      now: NOW,
    });
    await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ requestId: "press-plain" }),
      now: NOW,
    });

    const [withMotion, plain] = mockProductAd.create.mock.calls.map(
      call => call[0] as Doc
    );
    expect(withMotion!.motion).toBe("filmed_sold");
    expect(plain).not.toHaveProperty("motion");
  });

  it("writes Russian and English prices the buyers' way", async () => {
    mockImportFind.mockImplementation(() =>
      mockQuery([{ _id: NEW_IMPORT, language: "Russian", presenter: null }])
    );
    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL, { price: 1500, priceIsFrom: true })])
    );
    await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ productIds: [DOLL] }),
    });
    const saved = mockProductAd.create.mock.calls[0]![0] as Doc;
    expect(saved.wordsCode).toBe("ru");
    expect((saved.products as Doc[])[0]!.priceText).toBe(
      `от 1${NBSP}500${NBSP}₸`
    );
    // Without a word that they agreed, the person from the video stays out.
    expect(saved.presenter).toBeNull();
  });

  it("refuses products without a photo or a price, or no longer on the shelf", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL), mug({ price: null })])
    );
    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toEqual({ refused: "not_enough_products" });

    mockProductFind.mockImplementation(() =>
      mockQuery([
        productRow(DOLL, { options: [{ description: "doll" }] }),
        mug(),
      ])
    );
    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toEqual({ refused: "not_enough_products" });

    mockProductFind.mockImplementation(() => mockQuery([productRow(DOLL)]));
    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toEqual({ refused: "not_enough_products" });

    expect(mockProductAd.create).not.toHaveBeenCalled();
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it("refuses letters the ad's fonts can't draw, in names or the owner's words, but not in the shop's name", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL, { name: "東京タワー" }), mug()])
    );
    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toEqual({ refused: "ad_letters_unsupported" });

    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL), mug()])
    );
    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief({ idea: { kind: "own", text: "Gift 🎁" } }),
      })
    ).toEqual({ refused: "ad_letters_unsupported" });
    expect(mockProductAd.create).not.toHaveBeenCalled();

    // The owner can't rename the workspace from Products: a name the fonts
    // can't draw is left off the ending by the worker (productAdShopName),
    // with a number or without, so it never stops the ad.
    for (const [index, connected] of [true, false].entries()) {
      mockWhatsApp.mockResolvedValue(
        connected
          ? {
              context: {
                credentials: {
                  accessToken: "token",
                  displayPhoneNumber: SHOP_NUMBER,
                },
              },
            }
          : { context: { credentials: {} } }
      );
      mockWorkspaceName.mockResolvedValue({ data: { name: "Цветы 🌸" } });
      expect(
        await createProductAd({
          workspaceId: WS,
          userId: "user-1",
          request: brief({ requestId: `shop-name-${index}` }),
        })
      ).toMatchObject({ created: true });
    }
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      { spendLimitReached: true, trialEnded: true, remainingActions: 0 },
      "spend_limit",
    ],
    [{ trialEnded: true, remainingActions: 0 }, "trial_ended"],
    [{ remainingActions: 0 }, "ai_actions_used"],
  ])("admits by the import's rules: %o → %s", async (state, refused) => {
    mockAllowance.mockResolvedValue(allowance(state));

    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toEqual({ refused });
    expect(mockAllowance).toHaveBeenCalledWith(WS);
    expect(mockProductAd.create).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("refuses a company that turned AI off, before writing or starting anything", async () => {
    mockAllowance.mockRejectedValue(aiDisabled());

    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toEqual({ refused: "ai_disabled" });
    expect(mockProductAd.create).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("still throws when the company's AI switch can't be read, so the route answers 503", async () => {
    mockAllowance.mockRejectedValue(
      Object.assign(new Error("AI access could not be verified."), {
        code: "workspace_ai_policy_unavailable",
      })
    );

    await expect(
      createProductAd({ workspaceId: WS, userId: "user-1", request: brief() })
    ).rejects.toMatchObject({ code: "workspace_ai_policy_unavailable" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("admits a plan with no set number of actions", async () => {
    mockAllowance.mockResolvedValue(
      allowance({ includedActions: null, remainingActions: null })
    );
    expect(
      await createProductAd({
        workspaceId: WS,
        userId: "user-1",
        request: brief(),
      })
    ).toMatchObject({ created: true });
  });

  it("answers the same press with the ad it made, without checking or starting again", async () => {
    const first = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief(),
    });
    jest.clearAllMocks();

    const again = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ productIds: [MUG] }),
    });

    expect(again).toMatchObject({ created: false });
    expect("ad" in again && "ad" in first && again.ad.id).toBe(
      "ad" in first && first.ad.id
    );
    expect(mockProductFind).not.toHaveBeenCalled();
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("answers two presses sent at once with the one ad", async () => {
    // The other press saves its ad between this one's lookup and its save.
    mockProductAd.create.mockImplementationOnce(async (doc: Doc) => {
      mockAds.push({
        ...doc,
        _id: AD,
        scenes: [],
        stills: { status: null, feed: null },
        script: null,
        render: null,
        costMicros: 0,
        timings: {},
        startedAt: null,
        readyAt: null,
        createdAt: NOW,
        workflowId: `product-ad:${AD}:r1`,
      });
      throw Object.assign(new Error("E11000"), { code: 11000 });
    });

    const result = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief(),
    });

    expect(result).toMatchObject({ created: false, ad: { id: AD } });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts a replayed ad whose first run never started", async () => {
    mockAds.push(
      readyAd(AD, { status: "making", workflowId: undefined, render: null })
    );

    const result = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ requestId: `press-${AD}` }),
    });

    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: WS,
      adId: AD,
      renderNo: 1,
      mode: "make",
    });
    expect(result).toMatchObject({ created: false, ad: { id: AD } });
    expect(mockAds[0]!.workflowId).toBe(`product-ad:${AD}:r1`);
  });

  it("saves the ad as failed when its run can't start, and throws", async () => {
    mockStart.mockRejectedValue(new Error("Temporal down"));

    await expect(
      createProductAd({ workspaceId: WS, userId: "user-1", request: brief() })
    ).rejects.toThrow("Temporal down");

    expect(mockAds[0]).toMatchObject({
      status: "failed",
      errorCode: "failed",
      step: null,
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products] ad start failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_start_failed" })
    );
  });

  it("starts the ad a resent press saved but couldn't start, as that press asked for it", async () => {
    // The first press is answered 503: its ad is saved, its run never began.
    mockStart.mockRejectedValueOnce(new Error("Temporal down"));
    const request = brief({ presenter: { use: true, consent: true } });
    await expect(
      createProductAd({ workspaceId: WS, userId: "user-1", request, now: NOW })
    ).rejects.toThrow("Temporal down");
    const adId = String(mockAds[0]!._id);
    expect(mockAds[0]).toMatchObject({ status: "failed", renderNo: 1 });
    const later = new Date("2026-11-02T09:14:30.000Z");

    const again = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request,
      now: later,
    });

    expect(mockStart).toHaveBeenLastCalledWith({
      workspaceId: WS,
      adId,
      renderNo: 1,
      mode: "make",
    });
    expect(again).toMatchObject({
      created: false,
      ad: { id: adId, status: "making", errorCode: null, renderNo: 1 },
    });
    expect(mockAds).toHaveLength(1);
    expect(mockAds[0]).toMatchObject({
      status: "making",
      errorCode: null,
      errorMessage: null,
      requestedAt: later,
      workflowId: `product-ad:${adId}:r1`,
      voice: "own",
      presenter: expect.objectContaining({ use: true }),
    });
  });

  it("keeps the ad failed when a resent press can't start it either, and throws", async () => {
    mockStart.mockRejectedValue(new Error("Temporal down"));
    const press = () =>
      createProductAd({ workspaceId: WS, userId: "user-1", request: brief() });
    await expect(press()).rejects.toThrow("Temporal down");

    await expect(press()).rejects.toThrow("Temporal down");

    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockAds).toHaveLength(1);
    expect(mockAds[0]).toMatchObject({
      status: "failed",
      errorCode: "failed",
      renderNo: 1,
    });
  });

  it("answers a resent press whose ad ran and failed as it is, for Try again", async () => {
    // Its run started (the worker failed it), so only Try again, which asks
    // the AI allowance first, makes it again.
    mockAds.push(
      readyAd(AD, {
        status: "failed",
        errorCode: "failed",
        render: null,
        readyAt: null,
      })
    );

    const result = await createProductAd({
      workspaceId: WS,
      userId: "user-1",
      request: brief({ requestId: `press-${AD}` }),
    });

    expect(result).toMatchObject({
      created: false,
      ad: { id: AD, status: "failed" },
    });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockAds[0]).toMatchObject({ status: "failed", renderNo: 1 });
  });
});

describe("the ad as the page reads it", () => {
  it("has no recording to offer when no product has the owner's clip", async () => {
    const base = readyAd(AD) as { products: Array<Record<string, unknown>> };
    mockAds.push(
      readyAd(AD, {
        products: base.products.map(product => ({ ...product, clip: null })),
      })
    );
    const ad = await loadProductAdRecord(WS, AD, NOW);
    expect(ad?.hasRecording).toBe(false);
  });

  // A scene saved before studio v2's tools, as the page reads it.
  const V1_SCENE = {
    textZone: "auto",
    useExact: false,
    pictures: [],
    place: null,
    redo: null,
    textOverlap: null,
  } as const;

  it("links every file, and composes the post around Muse Spark's opening", async () => {
    mockAds.push(readyAd(AD));

    const ad = await loadProductAdRecord(WS, AD, NOW);

    expect(ad).toEqual({
      id: AD,
      status: "ready",
      step: null,
      errorCode: null,
      createdAt: NOW.toISOString(),
      requestedAt: NOW.toISOString(),
      startedAt: "2026-11-02T09:14:04.000Z",
      readyAt: "2026-11-02T09:15:08.000Z",
      renderNo: 1,
      language: "Kazakh",
      timings: {
        script: {
          startedAt: "2026-11-02T09:14:04.000Z",
          finishedAt: "2026-11-02T09:14:11.000Z",
        },
      },
      idea: { kind: "new", text: null },
      // An ad from before studio v3's motions moves as the shelf ad.
      motion: "shelf",
      voice: "own",
      // An ad from before studio v2 reads as its defaults.
      stockVoiceId: null,
      voiceResult: null,
      // The doll has the owner saying its price.
      hasRecording: true,
      runKind: "make",
      lastRun: null,
      // Read from the ledger for a ready ad.
      picturesLeft: 8,
      openings: [],
      endings: [],
      ending: { phone: SHOP_NUMBER, shopName: "QazOner Group" },
      products: [
        {
          productId: DOLL,
          name: "Кукла Лол",
          englishName: "LOL doll",
          priceText: `5${NBSP}000${NBSP}₸`,
          imageUrl: `https://signed.test/products/${DOLL}/thumb.webp`,
        },
        {
          productId: MUG,
          name: "Кружка Web UMN",
          englishName: "Web UMN mug",
          priceText: `500${NBSP}₸`,
          // Without a small copy, the cut-out itself.
          imageUrl: `https://signed.test/products/${MUG}/cutout.png`,
        },
      ],
      script: {
        sticker: "Сөреде жаңа тауарлар",
        captions: [
          { productId: DOLL, caption: "Көк көйлекті қуыршақ" },
          { productId: MUG, caption: "Күнделікті кружка" },
        ],
        priceCardTitle: "Екеуі де сөреде",
        ending: "WhatsApp-қа жазыңыз",
      },
      scenes: [
        {
          productId: DOLL,
          method: "muse",
          imageUrl: `https://signed.test/ads/${AD}/scene-${DOLL}-a1.png`,
          checked: true,
          ...V1_SCENE,
          // Muse Image's picture from the first make: the script's setting.
          place: {
            setting: "oak_table_window",
            words: null,
            englishPlace: null,
          },
        },
        {
          productId: MUG,
          method: "exact",
          imageUrl: `https://signed.test/ads/${AD}/exact-${MUG}.png`,
          checked: false,
          ...V1_SCENE,
        },
      ],
      video: {
        url: `https://signed.test/ads/${AD}/r1/ad.mp4`,
        bytes: 3_355_443,
        seconds: 14.2,
        posterUrl: `https://signed.test/ads/${AD}/r1/poster.jpg`,
        renderNo: 1,
      },
      stills: {
        statusUrl: `https://signed.test/ads/${AD}/r1/status.jpg`,
        feedUrl: `https://signed.test/ads/${AD}/r1/feed.jpg`,
      },
      post: {
        text: [
          "Сөремізге жаңа тауарлар келді!",
          "",
          `Кукла Лол — 5${NBSP}000${NBSP}₸`,
          `Кружка Web UMN — 500${NBSP}₸`,
          "",
          "WhatsApp-қа жазыңыз",
          `WhatsApp: ${SHOP_NUMBER}`,
          "",
          "Суреттерді AI жасаған.",
        ].join("\n"),
      },
      ctwa: script().ctwa,
      presenter: { imageUrl: "https://signed.test/imports/new/presenter.webp" },
      costUsd: 0.052,
      pricesChanged: false,
    });
  });

  it("reads studio v2's choices, kept pictures, last run and voice", async () => {
    const base = readyAd(AD) as { scenes: Array<Record<string, unknown>> };
    const kept = ref(`ads/${AD}/scene-${DOLL}-a1.png`);
    mockAds.push(
      readyAd(AD, {
        voice: "clone",
        voiceResult: { used: "own", fallback: "unavailable" },
        runKind: "scene",
        lastRun: {
          renderNo: 2,
          kind: "scene",
          outcome: "failed",
          errorCode: "failed",
          message: "for support only",
          at: NOW,
        },
        script: {
          ...script(),
          openings: [{ text: "Жаңа тауар", kind: "news", gloss: "New" }],
        },
        scenes: [
          {
            ...base.scenes[0],
            textZone: "top",
            pictures: [
              {
                ref: ref(`ads/${AD}/scene-${DOLL}-a0.png`),
                box: null,
                place: "a pale stone counter",
                madeAt: NOW,
              },
              { ref: kept, box: null, place: "a linen shelf", madeAt: NOW },
            ],
            place: { setting: null, words: "киіз үй", englishPlace: "a yurt" },
            redo: {
              requestId: "press-2",
              renderNo: 2,
              from: { muse: kept, box: null, method: "muse", check: null },
              outcome: "place_refused",
              reason: "people",
            },
            textOverlap: { covers: true, suggested: "bottom" },
          },
          { ...base.scenes[1], useExact: true },
        ],
      })
    );

    const ad = await loadProductAdRecord(WS, AD, NOW);

    expect(ad).toMatchObject({
      voice: "clone",
      voiceResult: { used: "own", fallback: "unavailable" },
      runKind: "scene",
      lastRun: {
        renderNo: 2,
        kind: "scene",
        outcome: "failed",
        errorCode: "failed",
        at: NOW.toISOString(),
      },
      openings: [{ text: "Жаңа тауар", kind: "news", gloss: "New" }],
      endings: [],
      picturesLeft: 8,
    });
    expect(ad!.lastRun).not.toHaveProperty("message");
    expect(ad!.scenes[0]).toMatchObject({
      textZone: "top",
      useExact: false,
      pictures: [
        {
          index: 0,
          url: `https://signed.test/ads/${AD}/scene-${DOLL}-a0.png`,
          place: "a pale stone counter",
          current: false,
        },
        {
          index: 1,
          url: `https://signed.test/ads/${AD}/scene-${DOLL}-a1.png`,
          place: "a linen shelf",
          current: true,
        },
      ],
      place: { setting: null, words: "киіз үй", englishPlace: "a yurt" },
      redo: {
        renderNo: 2,
        outcome: "place_refused",
        reason: "people",
        englishPlace: "a yurt",
      },
      textOverlap: { covers: true, suggested: "bottom" },
    });
    expect(ad!.scenes[1]).toMatchObject({ useExact: true, pictures: [] });
  });

  it("says when a shelf price changed since the ad was made", async () => {
    mockAds.push(readyAd(AD));
    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL, { price: 5500 }), mug()])
    );

    expect((await loadProductAdRecord(WS, AD, NOW))?.pricesChanged).toBe(true);
    expect(mockProductFind).toHaveBeenCalledWith({
      workspaceId: WS,
      status: "published",
      _id: { $in: [DOLL, MUG] },
    });
  });

  it("doesn't let the price check stop the ad loading", async () => {
    mockAds.push(readyAd(AD));
    mockProductFind.mockImplementation(() => {
      throw new Error("Mongo down");
    });
    expect((await loadProductAdRecord(WS, AD, NOW))?.pricesChanged).toBe(false);
  });

  it("is null for another workspace's ad", async () => {
    mockAds.push(readyAd(AD, { workspaceId: "workspace-2" }));
    expect(await loadProductAdRecord(WS, AD, NOW)).toBeNull();
  });

  it("says an ad whose run never started failed, once it's had time to", async () => {
    mockAds.push(
      readyAd(AD, { status: "making", workflowId: undefined, render: null })
    );

    const early = await loadProductAdRecord(
      WS,
      AD,
      new Date(NOW.getTime() + 60_000)
    );
    expect(early?.status).toBe("making");

    const late = await loadProductAdRecord(
      WS,
      AD,
      new Date(NOW.getTime() + 3 * 60_000)
    );
    expect(late).toMatchObject({ status: "failed", errorCode: "failed" });
    expect(mockAds[0]!.status).toBe("failed");
  });

  it("leaves a run that started alone, however long it takes", async () => {
    mockAds.push(
      readyAd(AD, { status: "making", step: "pictures", render: null })
    );
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect((await loadProductAdRecord(WS, AD, later))?.status).toBe("making");
  });

  it("puts an edit run that never started back to ready with its video, and its New picture back as it was", async () => {
    const base = readyAd(AD) as { scenes: Array<Record<string, unknown>> };
    const before = ref(`ads/${AD}/scene-${DOLL}-a1.png`);
    mockAds.push(
      readyAd(AD, {
        status: "making",
        step: "pictures",
        runKind: "scene",
        renderNo: 2,
        workflowId: `product-ad:${AD}:r1`,
        scenes: [
          {
            ...base.scenes[0],
            method: "exact",
            muse: null,
            check: null,
            box: null,
            redo: {
              requestId: "press-2",
              renderNo: 2,
              from: {
                muse: before,
                box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
                method: "muse",
                check: { same: true, difference: null },
              },
              outcome: null,
              reason: null,
            },
          },
          base.scenes[1],
        ],
      })
    );
    const later = new Date(NOW.getTime() + 3 * 60_000);

    const ad = await loadProductAdRecord(WS, AD, later);

    expect(ad).toMatchObject({
      status: "ready",
      errorCode: null,
      renderNo: 2,
      lastRun: {
        renderNo: 2,
        kind: "scene",
        outcome: "failed",
        errorCode: "failed",
      },
      video: { url: `https://signed.test/ads/${AD}/r1/ad.mp4` },
    });
    expect(ad!.scenes[0]).toMatchObject({
      method: "muse",
      imageUrl: `https://signed.test/${before.path}`,
      checked: true,
      redo: { outcome: "unavailable" },
    });
    expect(mockAds[0]).toMatchObject({ status: "ready", step: null });
  });

  it("divides the room left in the ad's AI action by the most one New picture costs", async () => {
    mockAds.push(readyAd(AD));
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBe(8);
    expect(mockLedgerFilters).toEqual(
      expect.arrayContaining([
        {
          table: "workspace_text_ai_actions",
          filters: [`workspace_id=${WS}`, `action_id=product-ad:${AD}`],
        },
        { table: "company_ai_usage", filters: ["company_id=company-1"] },
        { table: "ai_sponsorship_policies", filters: ["plan=pro"] },
      ])
    );
  });

  it("takes the company's own action limit over its plan's", async () => {
    mockAds.push(readyAd(AD));
    mockLedgerRow.mockImplementation(
      ledger({ company_ai_usage: { action_spend_limit_micros: 2_000_000 } })
    );
    // (2 000 000 - 80 000) / 47 500
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBe(40);
  });

  it("is held to the company's spend left when that's tighter", async () => {
    mockAds.push(readyAd(AD));
    mockAllowance.mockResolvedValue(
      allowance({ spendRemainingMicros: 100_000 })
    );
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBe(2);

    mockAllowance.mockResolvedValue(allowance({ spendLimitReached: true }));
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBe(0);
  });

  it("is 0 for an action at its limit, and counts an action not booked yet as empty", async () => {
    mockAds.push(readyAd(AD));
    mockLedgerRow.mockImplementation(
      ledger({ workspace_text_ai_actions: { committed_micros: 480_000 } })
    );
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBe(0);

    mockLedgerRow.mockImplementation(
      ledger({ workspace_text_ai_actions: null })
    );
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBe(10);
  });

  it("is null when the ledger can't tell, or the ad isn't ready, and never stops it loading", async () => {
    mockAds.push(readyAd(AD));
    mockLedgerRow.mockImplementation((table: string) =>
      table === "company_ai_usage"
        ? { data: null, error: { message: "down" } }
        : ledger()(table)
    );
    expect(await loadProductAdRecord(WS, AD, NOW)).toMatchObject({
      status: "ready",
      picturesLeft: null,
    });

    mockAllowance.mockRejectedValue(new Error("Supabase down"));
    expect(await loadProductAdRecord(WS, AD, NOW)).toMatchObject({
      status: "ready",
      picturesLeft: null,
    });

    mockAllowance.mockResolvedValue(allowance());
    mockLedgerRow.mockImplementation(ledger());
    mockAds[0]!.status = "making";
    mockAds[0]!.workflowId = `product-ad:${AD}:r1`;
    expect((await loadProductAdRecord(WS, AD, NOW))?.picturesLeft).toBeNull();
  });

  it("lists the newest ads with their poster and products linked, not every still", async () => {
    mockAds.push(readyAd(AD));

    const [ad] = await listProductAdRecords(WS, 20);

    expect(mockProductAd.find).toHaveBeenCalledWith({ workspaceId: WS });
    const query = mockProductAd.find.mock.results[0]!.value as ReturnType<
      typeof mockQuery
    >;
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(ad).toMatchObject({
      id: AD,
      video: {
        url: `https://signed.test/ads/${AD}/r1/ad.mp4`,
        posterUrl: `https://signed.test/ads/${AD}/r1/poster.jpg`,
      },
      stills: { statusUrl: null, feedUrl: null },
    });
    expect(ad!.scenes.map(scene => scene.imageUrl)).toEqual([null, null]);
    expect(ad!.products[0]!.imageUrl).toBe(
      `https://signed.test/products/${DOLL}/thumb.webp`
    );
  });

  // Studio v3: the template stills of the video shown, and what went out on Meta.
  const stillSet = (renderNo: number) => ({
    renderNo,
    items: [
      {
        kind: "studio",
        format: "feed",
        productId: DOLL,
        colourway: "night",
        ref: ref(`ads/${AD}/${renderNo}-studio-feed-${DOLL}-night.jpg`),
      },
      {
        kind: "studio",
        format: "feed",
        productId: DOLL,
        colourway: "white",
        ref: ref(`ads/${AD}/${renderNo}-studio-feed-${DOLL}-white.jpg`),
      },
      {
        kind: "collection",
        format: "feed",
        productId: null,
        colourway: null,
        ref: ref(`ads/${AD}/${renderNo}-collection-feed-all-x.jpg`),
      },
    ],
  });
  const storedPost = {
    id: "751f1f77bcf86cd799439041",
    requestId: "post-press-1",
    destination: "reel",
    still: null,
    slides: [],
    renderNo: 1,
    motion: "shelf",
    caption: "Жаңа тауар",
    state: "published",
    containerId: "c-1",
    childIds: [],
    mediaId: "m-1",
    permalink: "https://www.instagram.com/reel/abc/",
    errorCode: null,
    errorMessage: null,
    requestedAt: NOW,
    publishedAt: new Date("2026-11-02T09:15:00.000Z"),
    leaseUntil: null,
  };
  const postRecord = {
    id: "751f1f77bcf86cd799439041",
    destination: "reel",
    still: null,
    slides: [],
    renderNo: 1,
    motion: "shelf",
    state: "published",
    permalink: "https://www.instagram.com/reel/abc/",
    errorCode: null,
    errorMessage: null,
    requestedAt: NOW.toISOString(),
    publishedAt: "2026-11-02T09:15:00.000Z",
  };

  it("links the template stills of the video shown, in stored order", async () => {
    mockAds.push(readyAd(AD, { stillSet: stillSet(1) }));

    const ad = await loadProductAdRecord(WS, AD, NOW);

    expect(ad!.stills).toEqual({
      statusUrl: `https://signed.test/ads/${AD}/r1/status.jpg`,
      feedUrl: `https://signed.test/ads/${AD}/r1/feed.jpg`,
      templates: [
        {
          kind: "studio",
          format: "feed",
          productId: DOLL,
          colourway: "night",
          url: `https://signed.test/ads/${AD}/1-studio-feed-${DOLL}-night.jpg`,
        },
        {
          kind: "studio",
          format: "feed",
          productId: DOLL,
          colourway: "white",
          url: `https://signed.test/ads/${AD}/1-studio-feed-${DOLL}-white.jpg`,
        },
        {
          kind: "collection",
          format: "feed",
          productId: null,
          colourway: null,
          url: `https://signed.test/ads/${AD}/1-collection-feed-all-x.jpg`,
        },
      ],
    });
  });

  it("leaves the template stills out when they aren't the shown video's", async () => {
    // A run drew render 2's stills, but the video shown is still render 1.
    mockAds.push(readyAd(AD, { stillSet: stillSet(2) }));
    const ad = await loadProductAdRecord(WS, AD, NOW);
    expect(ad!.stills).not.toHaveProperty("templates");

    // The made list signs no stills.
    mockAds[0]!.stillSet = stillSet(1);
    const [listed] = await listProductAdRecords(WS, 20);
    expect(listed!.stills).toEqual({ statusUrl: null, feedUrl: null });
  });

  it("carries the Instagram posts, in the studio and the made list, without the server's ids", async () => {
    mockAds.push(readyAd(AD, { meta: { posts: [storedPost], ctwa: null } }));

    const ad = await loadProductAdRecord(WS, AD, NOW);
    const [listed] = await listProductAdRecords(WS, 20);

    expect(ad!.meta).toEqual({ posts: [postRecord], ctwa: null });
    expect(listed!.meta).toEqual({ posts: [postRecord], ctwa: null });
    expect(JSON.stringify(ad!.meta)).not.toContain("c-1");
    expect(JSON.stringify(ad!.meta)).not.toContain("post-press-1");
  });

  it("carries a post's choice of picture with its colourway", async () => {
    mockAds.push(
      readyAd(AD, {
        meta: {
          posts: [
            {
              ...storedPost,
              destination: "carousel",
              motion: null,
              state: "failed",
              permalink: null,
              publishedAt: null,
              errorCode: "post_failed",
              errorMessage:
                "Instagram couldn't use the picture's size or format.",
              slides: [
                { kind: "collection", productId: null, colourway: null },
                { kind: "studio", productId: DOLL, colourway: "night" },
              ],
            },
          ],
          ctwa: null,
        },
      })
    );

    const ad = await loadProductAdRecord(WS, AD, NOW);

    expect(ad!.meta!.posts[0]).toMatchObject({
      destination: "carousel",
      state: "failed",
      errorCode: "post_failed",
      errorMessage: "Instagram couldn't use the picture's size or format.",
      publishedAt: null,
      slides: [
        { kind: "collection", productId: null, colourway: null },
        { kind: "studio", productId: DOLL, colourway: "night" },
      ],
    });
  });
});

describe("prices changed since the ad was made", () => {
  const ad = readyAd(AD) as unknown as Parameters<typeof adPricesChanged>[1];

  it("compares each shelf price, written the buyers' way, with the ad's", async () => {
    expect(await adPricesChanged(WS, ad)).toBe(false);

    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL, { priceIsFrom: true }), mug()])
    );
    expect(await adPricesChanged(WS, ad)).toBe(true);
  });

  it("doesn't count a product gone from the shelf or left without a price", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([productRow(DOLL, { price: null })])
    );
    expect(await adPricesChanged(WS, ad)).toBe(false);
  });
});

describe("the post text", () => {
  const base = readyAd(AD) as unknown as Parameters<typeof adPostText>[0];

  it("notes AI pictures only when a scene is Muse Image's, in the buyers' language", () => {
    const exactOnly = {
      ...base,
      scenes: base.scenes.map(scene => ({
        ...scene,
        method: "exact" as const,
      })),
    };
    expect(adPostText(exactOnly)).not.toMatch(/AI|ИИ/);
    expect(adPostText({ ...base, wordsCode: "ru" })).toMatch(
      /Изображения созданы с помощью ИИ\.$/
    );
    expect(adPostText({ ...base, wordsCode: null })).toMatch(
      /Pictures made with AI\.$/
    );
  });

  it("ends with the shop's name when no number is connected, and is null before the words exist", () => {
    expect(
      adPostText({
        ...base,
        ending: { phone: null, shopName: "QazOner Group" },
      })
    ).toContain("WhatsApp-қа жазыңыз\nQazOner Group");
    expect(adPostText({ ...base, script: null })).toBeNull();
  });
});

describe("the owner's edits", () => {
  it("save the words and start a render with the next number, with no admission", async () => {
    mockAds.push(readyAd(AD));
    const now = new Date("2026-11-02T10:00:00.000Z");

    const result = await updateProductAdWords({
      workspaceId: WS,
      adId: AD,
      changes: { captions: [{ productId: MUG, caption: "Таңғы кофеге" }] },
      now,
    });

    expect(result).toMatchObject({
      started: true,
      ad: { status: "making", step: "video", renderNo: 2 },
    });
    expect(mockAds[0]).toMatchObject({
      status: "making",
      step: "video",
      renderNo: 2,
      requestedAt: now,
      startedAt: null,
      workflowId: `product-ad:${AD}:r2`,
    });
    const saved = mockAds[0]!.script as ProductAdScript;
    expect(saved.edited).toBe(true);
    expect(saved.scenes[1]!.caption).toBe("Таңғы кофеге");
    expect(saved.ctwa).toEqual(script().ctwa);
    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: WS,
      adId: AD,
      renderNo: 2,
      mode: "render",
    });
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it("refuses words that fail the script's checks, an ad not ready, and one not found", async () => {
    mockAds.push(readyAd(AD));
    expect(
      await updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { sticker: "50% жеңілдік" },
      })
    ).toMatchObject({ refused: "invalid_request" });

    mockAds[0]!.status = "making";
    expect(
      await updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { sticker: "Жаңа" },
      })
    ).toEqual({ refused: "ad_not_ready" });

    expect(
      await updateProductAdWords({
        workspaceId: WS,
        adId: "751f1f77bcf86cd799439099",
        changes: { sticker: "Жаңа" },
      })
    ).toEqual({ refused: "ad_not_found" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("makes the video again in another Reel tile's motion, free, and nothing for the motion it has", async () => {
    mockAds.push(readyAd(AD));

    const same = await updateProductAdWords({
      workspaceId: WS,
      adId: AD,
      // An ad from before motions is the shelf ad already.
      changes: { motion: "shelf" },
    });
    expect(same).toMatchObject({ started: false, ad: { motion: "shelf" } });
    expect(mockStart).not.toHaveBeenCalled();

    const result = await updateProductAdWords({
      workspaceId: WS,
      adId: AD,
      changes: { motion: "filmed_sold" },
    });
    expect(result).toMatchObject({
      started: true,
      ad: { status: "making", renderNo: 2, motion: "filmed_sold" },
    });
    expect(mockAds[0]).toMatchObject({
      motion: "filmed_sold",
      runKind: "render",
      renderNo: 2,
    });
    // The words weren't touched, so they stay unmarked as edited.
    expect((mockAds[0]!.script as ProductAdScript).edited).toBe(false);
    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: WS,
      adId: AD,
      renderNo: 2,
      mode: "render",
    });
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it("puts the motion back as it was when its render can't start", async () => {
    mockAds.push(readyAd(AD, { motion: "float" }));
    mockStart.mockRejectedValue(new Error("Temporal down"));

    await expect(
      updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { motion: "pop" },
      })
    ).rejects.toThrow("Temporal down");

    expect(mockAds[0]).toMatchObject({
      status: "ready",
      renderNo: 1,
      motion: "float",
    });
  });

  it("starts nothing for edits that change nothing", async () => {
    mockAds.push(readyAd(AD));
    const result = await updateProductAdWords({
      workspaceId: WS,
      adId: AD,
      changes: { sticker: "Сөреде жаңа тауарлар" },
    });
    expect(result).toMatchObject({ started: false, ad: { status: "ready" } });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("puts the ad back as it was when the render can't start", async () => {
    mockAds.push(readyAd(AD));
    mockStart.mockRejectedValue(new Error("Temporal down"));

    await expect(
      updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { sticker: "Жаңа" },
      })
    ).rejects.toThrow("Temporal down");

    expect(mockAds[0]).toMatchObject({
      status: "ready",
      renderNo: 1,
      step: null,
    });
    expect((mockAds[0]!.script as ProductAdScript).sticker).toBe(
      "Сөреде жаңа тауарлар"
    );
  });

  it("saves the scenes' choices as a free render run, words left unmarked", async () => {
    mockAds.push(readyAd(AD));

    const result = await updateProductAdWords({
      workspaceId: WS,
      adId: AD,
      changes: {
        scenes: [
          { productId: DOLL, textZone: "bottom" },
          { productId: MUG, useExact: true },
        ],
      },
    });

    expect(result).toMatchObject({
      started: true,
      ad: { status: "making", runKind: "render", renderNo: 2 },
    });
    const scenes = mockAds[0]!.scenes as Array<Record<string, unknown>>;
    expect(scenes[0]).toMatchObject({ textZone: "bottom", method: "muse" });
    expect(scenes[1]).toMatchObject({ useExact: true });
    expect(mockAds[0]).toMatchObject({ runKind: "render" });
    expect((mockAds[0]!.script as ProductAdScript).edited).toBe(false);
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ renderNo: 2, mode: "render" })
    );
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it("puts an earlier picture back with its own box, and refuses one the scene didn't keep", async () => {
    const base = readyAd(AD) as { scenes: Array<Record<string, unknown>> };
    const earlier = ref(`ads/${AD}/scene-${DOLL}-a0.png`);
    const earlierBox = { x: 0.1, y: 0.25, w: 0.4, h: 0.45 };
    mockAds.push(
      readyAd(AD, {
        scenes: [
          {
            ...base.scenes[0],
            useExact: true,
            pictures: [
              {
                ref: earlier,
                box: earlierBox,
                place: "linen shelf",
                madeAt: NOW,
              },
              {
                ref: ref(`ads/${AD}/scene-${DOLL}-a1.png`),
                box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
                place: "oak table",
                madeAt: NOW,
              },
            ],
          },
          base.scenes[1],
        ],
      })
    );

    expect(
      await updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { scenes: [{ productId: DOLL, pictureIndex: 3 }] },
      })
    ).toEqual({
      refused: "invalid_request",
      issues: [`${DOLL} has no kept picture 3.`],
    });
    expect(
      await updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { scenes: [{ productId: CLOCK, textZone: "top" }] },
      })
    ).toMatchObject({ refused: "invalid_request" });

    await updateProductAdWords({
      workspaceId: WS,
      adId: AD,
      changes: { scenes: [{ productId: DOLL, pictureIndex: 0 }] },
    });
    expect(
      (mockAds[0]!.scenes as Array<Record<string, unknown>>)[0]
    ).toMatchObject({
      muse: earlier,
      box: earlierBox,
      method: "muse",
      check: { same: true, difference: null },
      useExact: false,
    });
  });

  it("starts nothing for the picture already in the video", async () => {
    const base = readyAd(AD) as { scenes: Array<Record<string, unknown>> };
    mockAds.push(
      readyAd(AD, {
        scenes: [
          {
            ...base.scenes[0],
            pictures: [
              {
                ref: ref(`ads/${AD}/scene-${DOLL}-a1.png`),
                box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
                place: "oak table",
                madeAt: NOW,
              },
            ],
          },
          base.scenes[1],
        ],
      })
    );
    expect(
      await updateProductAdWords({
        workspaceId: WS,
        adId: AD,
        changes: { scenes: [{ productId: DOLL, pictureIndex: 0 }] },
      })
    ).toMatchObject({ started: false });
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("New picture", () => {
  const press = (overrides: Doc = {}) => ({
    workspaceId: WS,
    adId: AD,
    productId: MUG,
    request: { requestId: "press-2", setting: "gift_table" as const },
    now: new Date("2026-11-03T10:00:00.000Z"),
    ...overrides,
  });

  it("starts a scene run for that scene alone, its exact photo standing in", async () => {
    const base = readyAd(AD) as { scenes: Array<Record<string, unknown>> };
    mockAds.push(
      readyAd(AD, {
        scenes: [
          base.scenes[0],
          {
            ...base.scenes[1],
            useExact: true,
            exactBox: { x: 0.25, y: 0.4, w: 0.5, h: 0.3 },
          },
        ],
      })
    );

    const result = await redoProductAdScene(press());

    expect(result).toMatchObject({
      started: true,
      ad: { status: "making", step: "pictures", runKind: "scene", renderNo: 2 },
    });
    expect(mockAds[0]).toMatchObject({
      status: "making",
      step: "pictures",
      runKind: "scene",
      renderNo: 2,
      requestedAt: new Date("2026-11-03T10:00:00.000Z"),
      startedAt: null,
      workflowId: `product-ad:${AD}:r2`,
    });
    const [doll, mug] = mockAds[0]!.scenes as Array<Record<string, unknown>>;
    expect(doll).toEqual(base.scenes[0]);
    expect(mug).toMatchObject({
      method: "exact",
      muse: null,
      check: null,
      box: { x: 0.25, y: 0.4, w: 0.5, h: 0.3 },
      // The worker turns it off only for a new picture.
      useExact: true,
      place: { setting: "gift_table", words: null, englishPlace: null },
      redo: {
        requestId: "press-2",
        renderNo: 2,
        from: {
          muse: null,
          box: null,
          method: "exact",
          check: { same: false, difference: "The logo changed." },
        },
        outcome: null,
        reason: null,
      },
    });
    const saved = mockAds[0]!.script as ProductAdScript;
    expect(saved.scenes[1]!.setting).toBe("gift_table");
    // The press keeps the setting the replaced picture was made in, for the
    // worker to name it by (the script now names the pressed chip).
    expect(
      (mug!.redo as { from: { setting?: string | null } }).from.setting
    ).toBe("linen_shelf");
    expect(saved.edited).toBe(false);
    // A scene run may pay: a "make" run.
    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: WS,
      adId: AD,
      renderNo: 2,
      mode: "make",
    });
  });

  it("takes a described place, and the pending free changes with it", async () => {
    mockAds.push(readyAd(AD));

    await redoProductAdScene(
      press({
        productId: DOLL,
        request: {
          requestId: "press-3",
          words: "киіз үй ішінде",
          changes: {
            sticker: "Жаңа тауар",
            scenes: [{ productId: MUG, textZone: "top" }],
          },
        },
      })
    );

    const [doll, mug] = mockAds[0]!.scenes as Array<Record<string, unknown>>;
    expect(doll).toMatchObject({
      place: { setting: null, words: "киіз үй ішінде", englishPlace: null },
      redo: {
        requestId: "press-3",
        from: {
          muse: ref(`ads/${AD}/scene-${DOLL}-a1.png`),
          box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
          method: "muse",
          check: { same: true, difference: null },
        },
      },
    });
    expect(mug).toMatchObject({ textZone: "top" });
    const saved = mockAds[0]!.script as ProductAdScript;
    expect(saved.sticker).toBe("Жаңа тауар");
    expect(saved.edited).toBe(true);
    // The setting stays the script's: the owner's place is in `place`.
    expect(saved.scenes[0]!.setting).toBe("oak_table_window");
  });

  it("asks admission as an admitted action, and refuses when the ad's action has no room", async () => {
    mockAds.push(readyAd(AD));
    mockAllowance.mockResolvedValue(allowance({ remainingActions: 0 }));
    mockLedgerRow.mockImplementation(
      ledger({ workspace_text_ai_actions: { committed_micros: 460_000 } })
    );
    expect(await redoProductAdScene(press())).toEqual({
      refused: "no_pictures_left",
    });

    mockLedgerRow.mockImplementation(ledger());
    // No included action left doesn't stop an action already admitted.
    expect(await redoProductAdScene(press())).toMatchObject({ started: true });

    mockAds[0]!.status = "ready";
    mockAds[0]!.scenes = (readyAd(AD) as { scenes: unknown[] }).scenes;
    mockAllowance.mockResolvedValue(allowance({ trialEnded: true }));
    expect(
      await redoProductAdScene(
        press({ request: { requestId: "press-9", setting: "gift_table" } })
      )
    ).toEqual({ refused: "trial_ended" });
  });

  it("refuses a company that turned AI off, the scene as it was", async () => {
    mockAds.push(readyAd(AD));
    mockAllowance.mockRejectedValue(aiDisabled());
    expect(await redoProductAdScene(press())).toEqual({
      refused: "ai_disabled",
    });
    expect(mockAds[0]!.status).toBe("ready");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("goes on when the budget can't be read: the ledger is the real gate", async () => {
    mockAds.push(readyAd(AD));
    mockLedgerRow.mockImplementation(() => ({
      data: null,
      error: { message: "down" },
    }));
    expect(await redoProductAdScene(press())).toMatchObject({ started: true });
  });

  it("refuses unless the ad is ready, for a product it doesn't show, and changes that don't fit", async () => {
    mockAds.push(readyAd(AD, { status: "making" }));
    expect(await redoProductAdScene(press())).toEqual({
      refused: "ad_not_ready",
    });
    mockAds[0]!.status = "ready";
    expect(await redoProductAdScene(press({ productId: CLOCK }))).toEqual({
      refused: "product_not_found",
    });
    expect(
      await redoProductAdScene(
        press({
          request: {
            requestId: "press-2",
            setting: "gift_table",
            changes: { sticker: "50% жеңілдік" },
          },
        })
      )
    ).toMatchObject({ refused: "invalid_request" });
    expect(
      await redoProductAdScene(press({ adId: "751f1f77bcf86cd799439099" }))
    ).toEqual({ refused: "ad_not_found" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts nothing twice for the same press", async () => {
    mockAds.push(readyAd(AD));
    expect(await redoProductAdScene(press())).toMatchObject({ started: true });
    expect(await redoProductAdScene(press())).toMatchObject({
      started: false,
      ad: { status: "making", renderNo: 2 },
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("leaves one run when two presses race for the same render", async () => {
    mockAds.push(readyAd(AD));
    const [first, second] = await Promise.all([
      redoProductAdScene(press()),
      redoProductAdScene(
        press({
          productId: DOLL,
          request: { requestId: "press-3", setting: "stone_counter" },
        })
      ),
    ]);
    expect([first, second].filter(entry => "ad" in entry)).toHaveLength(1);
    expect([first, second]).toContainEqual({ refused: "ad_not_ready" });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockAds[0]!.renderNo).toBe(2);
  });

  it("puts the ad back as it was when the run can't start", async () => {
    mockAds.push(readyAd(AD));
    mockStart.mockRejectedValue(new Error("Temporal down"));

    await expect(redoProductAdScene(press())).rejects.toThrow("Temporal down");

    expect(mockAds[0]).toMatchObject({
      status: "ready",
      step: null,
      renderNo: 1,
      runKind: "make",
    });
    expect(mockAds[0]!.scenes).toEqual(
      (readyAd(AD) as { scenes: unknown[] }).scenes
    );
    expect((mockAds[0]!.script as ProductAdScript).scenes[1]!.setting).toBe(
      "linen_shelf"
    );
  });
});

describe("trying a failed ad again", () => {
  const failed = (overrides: Doc = {}) =>
    readyAd(AD, {
      status: "failed",
      errorCode: "failed",
      errorMessage: "ffmpeg exited",
      render: null,
      readyAt: null,
      ...overrides,
    });

  it("resumes it with a new run that pays only for what isn't saved", async () => {
    mockAds.push(failed());
    const now = new Date("2026-11-02T10:00:00.000Z");

    const result = await retryProductAd({ workspaceId: WS, adId: AD, now });

    expect(result).toMatchObject({
      started: true,
      ad: { status: "making", renderNo: 2, errorCode: null },
    });
    expect(mockAds[0]).toMatchObject({
      status: "making",
      errorCode: null,
      errorMessage: null,
      renderNo: 2,
      requestedAt: now,
      startedAt: null,
    });
    expect(mockStart).toHaveBeenCalledWith({
      workspaceId: WS,
      adId: AD,
      renderNo: 2,
      mode: "make",
    });
  });

  it("asks the allowance first; an admitted action goes on without an included one", async () => {
    mockAds.push(failed({ costMicros: 0 }));
    mockAllowance.mockResolvedValue(allowance({ remainingActions: 0 }));
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toEqual({
      refused: "ai_actions_used",
    });

    mockAds[0]!.costMicros = 16_000;
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toMatchObject({
      started: true,
    });

    mockAds[0]!.status = "failed";
    mockAllowance.mockResolvedValue(allowance({ spendLimitReached: true }));
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toEqual({
      refused: "spend_limit",
    });
  });

  it("refuses a company that turned AI off, the ad left failed", async () => {
    mockAds.push(failed({ costMicros: 16_000 }));
    mockAllowance.mockRejectedValue(aiDisabled());
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toEqual({
      refused: "ai_disabled",
    });
    expect(mockAds[0]!.status).toBe("failed");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("answers an ad that isn't failed as it is, and a missing one as not found", async () => {
    mockAds.push(readyAd(AD));
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toMatchObject({
      started: false,
      ad: { status: "ready" },
    });
    expect(
      await retryProductAd({
        workspaceId: WS,
        adId: "751f1f77bcf86cd799439099",
      })
    ).toEqual({ refused: "ad_not_found" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("keeps it failed when the run can't start", async () => {
    mockAds.push(failed());
    mockStart.mockRejectedValue(new Error("Temporal down"));

    await expect(retryProductAd({ workspaceId: WS, adId: AD })).rejects.toThrow(
      "Temporal down"
    );
    expect(mockAds[0]).toMatchObject({
      status: "failed",
      errorCode: "failed",
      renderNo: 2,
    });
  });

  const editFailed = (kind: string) =>
    readyAd(AD, {
      renderNo: 3,
      runKind: kind,
      lastRun: {
        renderNo: 3,
        kind,
        outcome: "failed",
        errorCode: "failed",
        message: "ffmpeg exited",
        at: NOW,
      },
    });

  it("makes the video again for free after an Update or a New picture failed", async () => {
    for (const kind of ["render", "scene"]) {
      mockAds.length = 0;
      mockStart.mockClear();
      mockAds.push(editFailed(kind));

      const result = await retryProductAd({ workspaceId: WS, adId: AD });

      expect(result).toMatchObject({
        started: true,
        ad: { status: "making", step: "video", runKind: "render", renderNo: 4 },
      });
      expect(mockStart).toHaveBeenCalledWith({
        workspaceId: WS,
        adId: AD,
        renderNo: 4,
        mode: "render",
      });
    }
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it("leaves a ready ad as it is after a voice run failed, or a failure that isn't the latest run", async () => {
    mockAds.push(editFailed("voice"));
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toMatchObject({
      started: false,
    });
    mockAds[0] = { ...editFailed("render"), renderNo: 4 };
    expect(await retryProductAd({ workspaceId: WS, adId: AD })).toMatchObject({
      started: false,
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("puts a ready ad back as it was when its render can't start", async () => {
    mockAds.push(editFailed("render"));
    mockStart.mockRejectedValue(new Error("Temporal down"));
    await expect(retryProductAd({ workspaceId: WS, adId: AD })).rejects.toThrow(
      "Temporal down"
    );
    expect(mockAds[0]).toMatchObject({
      status: "ready",
      renderNo: 3,
      runKind: "render",
      lastRun: { outcome: "failed" },
    });
  });
});
