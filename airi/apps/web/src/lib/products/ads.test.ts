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
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => mockWorkspaceName() }),
      }),
    }),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockAds.length = 0;
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
      voice: "own",
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
        },
        {
          productId: MUG,
          method: "exact",
          imageUrl: `https://signed.test/ads/${AD}/exact-${MUG}.png`,
          checked: false,
        },
      ],
      video: {
        url: `https://signed.test/ads/${AD}/r1/ad.mp4`,
        bytes: 3_355_443,
        seconds: 14.2,
        posterUrl: `https://signed.test/ads/${AD}/r1/poster.jpg`,
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
});
