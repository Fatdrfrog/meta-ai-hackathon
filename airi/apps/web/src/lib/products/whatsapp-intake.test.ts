/** @jest-environment node */

const mockLinkFindOne = jest.fn();
const mockLinkFind = jest.fn();
const mockLinkFindOneAndUpdate = jest.fn();
const mockLinkDeleteMany = jest.fn();
const mockLinkDeleteOne = jest.fn();
const mockLinkUpdateOne = jest.fn();
const mockPairingUpdateOne = jest.fn();
const mockPairingFindOne = jest.fn();
const mockPairingFind = jest.fn();
const mockRequestUpdateOne = jest.fn();
const mockRequestFind = jest.fn();
const mockRequestDeleteMany = jest.fn();
const mockRequestDeleteOne = jest.fn();
const mockRequestFindOneAndDelete = jest.fn();
const mockMissCount = jest.fn();
const mockMissCreate = jest.fn();
const mockImportFindOneAndUpdate = jest.fn();
const mockMessageFindOne = jest.fn();
const mockCreateImport = jest.fn();
const mockSendText = jest.fn();
const mockSendButtons = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockWarn = jest.fn();
let mockWorkspaceName = "QazOner Group";
let mockSources: Array<{
  workspace_id: string;
  display_phone: string;
  on_biz_app?: string | null;
}> = [];
// The workspaces with Products, as they're named now.
let mockProductsShops: Array<{ id: string; name: string | null }> = [];
const mockFlagFilters: Array<[string, unknown]> = [];

jest.mock("@/models/product-whatsapp-link", () => ({
  ProductWhatsAppLink: {
    findOne: (...args: unknown[]) => mockLinkFindOne(...args),
    find: (...args: unknown[]) => mockLinkFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockLinkFindOneAndUpdate(...args),
    deleteMany: (...args: unknown[]) => mockLinkDeleteMany(...args),
    deleteOne: (...args: unknown[]) => mockLinkDeleteOne(...args),
    updateOne: (...args: unknown[]) => mockLinkUpdateOne(...args),
  },
}));
jest.mock("@/models/product-whatsapp-pairing", () => ({
  ProductWhatsAppPairing: {
    updateOne: (...args: unknown[]) => mockPairingUpdateOne(...args),
    findOne: (...args: unknown[]) => mockPairingFindOne(...args),
    find: (...args: unknown[]) => mockPairingFind(...args),
  },
  ProductWhatsAppLinkRequest: {
    updateOne: (...args: unknown[]) => mockRequestUpdateOne(...args),
    find: (...args: unknown[]) => mockRequestFind(...args),
    deleteMany: (...args: unknown[]) => mockRequestDeleteMany(...args),
    deleteOne: (...args: unknown[]) => mockRequestDeleteOne(...args),
    findOneAndDelete: (...args: unknown[]) =>
      mockRequestFindOneAndDelete(...args),
  },
  ProductWhatsAppLinkMiss: {
    countDocuments: (...args: unknown[]) => mockMissCount(...args),
    create: (...args: unknown[]) => mockMissCreate(...args),
  },
}));
jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockImportFindOneAndUpdate(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockMessageFindOne(...args) },
}));
jest.mock("@/lib/products/imports", () => ({
  createProductVideoImport: (...args: unknown[]) => mockCreateImport(...args),
}));
jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappMessage: (...args: unknown[]) => mockSendText(...args),
  sendWhatsappInteractiveReplyButtons: (...args: unknown[]) =>
    mockSendButtons(...args),
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: async () => ({
    phoneNumberId: "airi-phone",
    accessToken: "token",
  }),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));
jest.mock("@/lib/billing/config", () => ({
  getAppBaseUrl: () => "https://www.airi.chat",
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "workspaces")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { name: mockWorkspaceName } }),
            }),
            // The names of the workspaces with Products.
            in: async (_column: string, ids: string[]) => ({
              data: mockProductsShops.filter(shop => ids.includes(shop.id)),
              error: null,
            }),
          }),
        };
      if (table === "workspace_feature_flags") {
        const flags = {
          select: () => flags,
          eq: (column: string, value: unknown) => {
            mockFlagFilters.push([column, value]);
            return flags;
          },
          then: (resolve: (result: unknown) => unknown) =>
            resolve({
              data: mockProductsShops.map(shop => ({ workspace_id: shop.id })),
              error: null,
            }),
        };
        return flags;
      }
      // WhatsApp sources, of every workspace or of the one asked for.
      const filters: Record<string, unknown> = {};
      const sources = {
        select: () => sources,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return sources;
        },
        then: (resolve: (result: unknown) => unknown) =>
          resolve({
            data: mockSources.filter(
              row =>
                filters.workspace_id === undefined ||
                row.workspace_id === filters.workspace_id
            ),
            error: null,
          }),
      };
      return sources;
    },
  },
}));

import {
  approveProductsWhatsAppRequest,
  denyProductsWhatsAppRequest,
  handleProductsWhatsAppMessage,
  loadProductsWhatsAppLink,
  notifyProductsWhatsAppOwner,
  openProductsWhatsAppPairing,
  unlinkProductsWhatsAppPhone,
  type ProductsWhatsAppMessage,
} from "./whatsapp-intake";

const NOW = new Date("2026-10-28T12:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const OWNER = "77011234567";
const VIDEO_MESSAGE = "651f1f77bcf86cd799439071";
const REQUEST_ID = "651f1f77bcf86cd799439081";
const LINK_TEXT = "Hi Airi! Please link this phone to my shop QazOner Group.";
const ASK_IN_AIRI =
  "Open airi and confirm this phone to link it to QazOner Group.";
const START_IN_AIRI =
  "Open Products in airi, choose Send from WhatsApp, and send the message from there.";

/** A Mongoose query answering `result`, however it's narrowed. */
const query = (result: unknown) => ({
  select() {
    return this;
  },
  lean: async () => result,
});

type Row = Record<string, unknown>;

/** A Mongoose query over `rows`, sorted and skipped as asked. */
function rowsQuery(rows: Row[]) {
  let result = rows.map(row => ({ ...row }));
  const chain = {
    sort(spec: Record<string, 1 | -1>) {
      const [field, direction] = Object.entries(spec)[0]!;
      result.sort((a, b) => (Number(a[field]) - Number(b[field])) * direction);
      return chain;
    },
    skip(count: number) {
      result = result.slice(count);
      return chain;
    },
    select: () => chain,
    lean: async () => result,
  };
  return chain;
}

const message = (
  overrides: Partial<ProductsWhatsAppMessage> = {}
): ProductsWhatsAppMessage => ({
  receivingPhone: "+7 708 000 0011",
  sourceId: "airi-source",
  workspaceId: "airi-workspace",
  conversationId: "651f1f77bcf86cd799439060",
  messageId: VIDEO_MESSAGE,
  from: OWNER,
  profileName: null,
  text: null,
  buttonReplyId: null,
  video: { mediaId: "media-1", mimeType: "video/mp4" },
  ...overrides,
});

const linkText = (
  text: string,
  overrides: Partial<ProductsWhatsAppMessage> = {}
) => message({ video: null, text, profileName: "Samat", ...overrides });

const link = (overrides: Record<string, unknown> = {}) => ({
  _id: "link-1",
  workspaceId: "shop-workspace",
  via: "approved",
  phone: OWNER,
  ...overrides,
});

/** Video messages of a burst, with ids a reply button can carry. */
const videoId = (n: number) =>
  `651f1f77bcf86cd7994391${String(n).padStart(2, "0")}`;
const videoMessage = (n: number) =>
  message({
    messageId: videoId(n),
    video: { mediaId: `media-${n}`, mimeType: "video/mp4" },
  });
const tapped = (answer: "add" | "skip", n: number) =>
  message({
    messageId: "651f1f77bcf86cd799439199",
    video: null,
    buttonReplyId: `products-intake:${answer}:${videoId(n)}`,
  });

type StoredQuestion = {
  messageId: string;
  videos: Array<{
    messageId: string;
    mediaId: string;
    mimeType: string | null;
  }>;
  lastVideoAt: Date;
  answer: "add" | "skip" | null;
};
type StoredLink = ReturnType<typeof link> & {
  question: StoredQuestion | null;
  lastVideoAt?: Date;
};
type LinkFilter = {
  $or?: [unknown, { "question.lastVideoAt": { $lt: Date } }];
  "question.lastVideoAt"?: { $gte: Date };
  "question.messageId"?: string;
  "question.answer"?: unknown;
};
type LinkUpdate = {
  $set: {
    question?: StoredQuestion;
    "question.lastVideoAt"?: Date;
    "question.answer"?: StoredQuestion["answer"];
    lastVideoAt?: Date;
  };
  $push?: { "question.videos": StoredQuestion["videos"][number] };
};

/**
 * One phone's link as Mongo keeps it: the intake reads it, and its updates
 * apply the way Mongo would for the filters the intake uses.
 */
function storeLink(overrides: Record<string, unknown>): {
  current: StoredLink;
} {
  const store = {
    current: { ...link(overrides), question: null } as StoredLink,
  };
  mockLinkFindOne.mockImplementation(() =>
    query(structuredClone(store.current))
  );
  mockLinkFindOneAndUpdate.mockImplementation(
    (filter: LinkFilter, update: LinkUpdate) => {
      const question = store.current.question;
      const since = filter["question.lastVideoAt"]?.$gte;
      if (since) {
        // A video joining the burst Airi asked about.
        if (!question || question.lastVideoAt < since) return query(null);
        const before = structuredClone(store.current);
        question.videos.push(update.$push!["question.videos"]);
        question.lastVideoAt = update.$set["question.lastVideoAt"]!;
        return query(before);
      }
      // "Add them" under a question.
      if (!question || question.messageId !== filter["question.messageId"])
        return query(null);
      question.answer = update.$set["question.answer"]!;
      return query(structuredClone(store.current));
    }
  );
  mockLinkUpdateOne.mockImplementation(
    async (filter: LinkFilter, update: LinkUpdate) => {
      const question = store.current.question;
      if (filter.$or) {
        // A video starting a question, unless a burst's question is open.
        const before = filter.$or[1]["question.lastVideoAt"].$lt;
        if (question && question.lastVideoAt >= before)
          return { modifiedCount: 0 };
        store.current.question = structuredClone(update.$set.question!);
        return { modifiedCount: 1 };
      }
      if ("question.answer" in filter) {
        // "No" under a question nobody answered yet.
        if (
          !question ||
          question.messageId !== filter["question.messageId"] ||
          question.answer !== null
        )
          return { modifiedCount: 0 };
        question.answer = update.$set["question.answer"]!;
        return { modifiedCount: 1 };
      }
      // An import started: the phone's last video.
      store.current.lastVideoAt = update.$set.lastVideoAt;
      return { modifiedCount: 1 };
    }
  );
  return store;
}

// The short-lived documents of linking, as Mongo would keep them.
type Window = {
  workspaceId: string;
  createdBy: string;
  shopName: string;
  shopKey: string;
  expiresAt: Date;
};
type Request = {
  _id: string;
  workspaceId: string;
  phone: string;
  profileName: string | null;
  sourceId: string;
  createdAt: Date;
  expiresAt: Date;
};
let windows: Window[] = [];
let requests: Request[] = [];
let misses: Date[] = [];

/** An admin opening "Send from WhatsApp" for a workspace with this name. */
async function openShop(workspaceId: string, name: string, at = NOW) {
  mockWorkspaceName = name;
  return openProductsWhatsAppPairing(workspaceId, "user-1", at);
}

/** The pairing of a shop that opened to phones; fails the test otherwise. */
function pairingOf(panel: Awaited<ReturnType<typeof openShop>>) {
  if (!panel || panel === "shop_name_taken" || !panel.pairing)
    throw new Error(`The shop didn't open to phones: ${String(panel)}`);
  return panel.pairing;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PRODUCTS_WHATSAPP_NUMBER = "+7 708 000 0011";
  mockWorkspaceName = "QazOner Group";
  mockSources = [];
  mockProductsShops = [{ id: "shop-workspace", name: "QazOner Group" }];
  mockFlagFilters.length = 0;
  mockFeatureEnabled.mockResolvedValue(true);
  mockCreateImport.mockResolvedValue({ importId: "import-1" });
  mockLinkUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mockLinkDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockLinkFindOne.mockReturnValue(query(null));
  mockLinkFind.mockImplementation(() => rowsQuery([]));
  mockLinkFindOneAndUpdate.mockReturnValue(query(null));

  windows = [];
  mockPairingUpdateOne.mockImplementation(
    async (filter: { workspaceId: string }, update: { $set: Window }) => {
      const found = windows.find(
        window => window.workspaceId === filter.workspaceId
      );
      if (found) Object.assign(found, update.$set);
      else windows.push({ ...update.$set, workspaceId: filter.workspaceId });
      return { acknowledged: true };
    }
  );
  mockPairingFindOne.mockImplementation(
    (filter: { workspaceId: string; expiresAt: { $gt: Date } }) =>
      query(
        windows.find(
          window =>
            window.workspaceId === filter.workspaceId &&
            window.expiresAt > filter.expiresAt.$gt
        ) ?? null
      )
  );
  mockPairingFind.mockImplementation(
    (filter: { shopKey: string; expiresAt: { $gt: Date } }) =>
      rowsQuery(
        windows.filter(
          window =>
            window.shopKey === filter.shopKey &&
            window.expiresAt > filter.expiresAt.$gt
        )
      )
  );

  requests = [];
  let created = 0;
  mockRequestUpdateOne.mockImplementation(
    async (
      filter: { workspaceId: string; phone: string },
      update: { $set: Omit<Request, "_id" | "workspaceId" | "phone"> }
    ) => {
      const found = requests.find(
        request =>
          request.workspaceId === filter.workspaceId &&
          request.phone === filter.phone
      );
      if (found) Object.assign(found, update.$set);
      else
        requests.push({
          _id: `request-${++created}`,
          ...filter,
          ...update.$set,
        });
      return { acknowledged: true };
    }
  );
  mockRequestFind.mockImplementation(
    (filter: { workspaceId: string; expiresAt?: { $gt: Date } }) =>
      rowsQuery(
        requests.filter(
          request =>
            request.workspaceId === filter.workspaceId &&
            (!filter.expiresAt || request.expiresAt > filter.expiresAt.$gt)
        )
      )
  );
  mockRequestDeleteMany.mockImplementation(
    async (filter: { _id: { $in: string[] } }) => {
      const before = requests.length;
      requests = requests.filter(
        request => !filter._id.$in.includes(request._id)
      );
      return { deletedCount: before - requests.length };
    }
  );

  misses = [];
  mockMissCount.mockImplementation(
    async (filter: { phone: string; expiresAt: { $gt: Date } }) =>
      misses.filter(expiresAt => expiresAt > filter.expiresAt.$gt).length
  );
  mockMissCreate.mockImplementation(async (miss: { expiresAt: Date }) => {
    misses.push(miss.expiresAt);
  });
});

afterAll(() => {
  delete process.env.PRODUCTS_WHATSAPP_NUMBER;
});

describe("openProductsWhatsAppPairing", () => {
  it("opens the shop to phones for 15 minutes, with a message that names it and carries no code", async () => {
    const panel = await openShop("shop-workspace", "QazOner Group");

    expect(mockPairingUpdateOne).toHaveBeenCalledWith(
      { workspaceId: "shop-workspace" },
      {
        $set: {
          createdBy: "user-1",
          shopName: "QazOner Group",
          shopKey: "qazoner group",
          expiresAt: new Date("2026-10-28T12:15:00.000Z"),
        },
      },
      { upsert: true }
    );
    const url = new URL(pairingOf(panel).url);
    expect(url.origin + url.pathname).toBe("https://wa.me/77080000011");
    expect(url.searchParams.get("text")).toBe(LINK_TEXT);
    expect(pairingOf(panel).expiresAt).toBe("2026-10-28T12:15:00.000Z");
    expect(pairingOf(panel).url).not.toMatch(/AIRI-SHOP|[a-f0-9]{24}/i);

    // Opening it again keeps the one window open longer.
    await openShop("shop-workspace", "QazOner Group", later(600));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.expiresAt).toEqual(new Date("2026-10-28T12:25:00.000Z"));
  });

  it("writes the shop's name on one line, 40 characters at most", async () => {
    const panel = await openShop(
      "shop-workspace",
      "  Магазин   игрушек\nи подарков для всей семьи «Радуга»  "
    );

    const text = new URL(pairingOf(panel).url).searchParams.get("text");
    expect(text).toBe(
      "Hi Airi! Please link this phone to my shop Магазин игрушек и подарков для всей семь."
    );
    expect(windows[0]!.shopName).toHaveLength(40);
  });

  it("is off until airi's number is set up", async () => {
    delete process.env.PRODUCTS_WHATSAPP_NUMBER;

    expect(await openShop("shop-workspace", "QazOner Group")).toBeNull();
    expect(mockPairingUpdateOne).not.toHaveBeenCalled();
  });

  it("stays closed to phones while another shop with Products has its name", async () => {
    mockProductsShops = [
      { id: "shop-workspace", name: "QazOner Group" },
      // It only looks the same: a Cyrillic Ԛ and О, and an invisible space.
      { id: "other-workspace", name: "Ԛaz​Оner group." },
    ];

    expect(await openShop("shop-workspace", "QazOner Group")).toBe(
      "shop_name_taken"
    );
    expect(mockPairingUpdateOne).not.toHaveBeenCalled();

    // A name that differs, like a workspace without Products, doesn't count.
    mockProductsShops = [
      { id: "shop-workspace", name: "QazOner Group" },
      { id: "other-workspace", name: "QazOner Group 2" },
    ];
    expect(await openShop("shop-workspace", "QazOner Group")).not.toBe(
      "shop_name_taken"
    );
    expect(windows).toHaveLength(1);
  });
});

describe("loadProductsWhatsAppLink", () => {
  it("shows the phones masked, and the shop's own WhatsApp Business numbers", async () => {
    await openShop("shop-workspace", "QazOner Group");
    requests = [
      {
        _id: REQUEST_ID,
        workspaceId: "shop-workspace",
        phone: OWNER,
        profileName: "Samat",
        sourceId: "airi-source",
        createdAt: NOW,
        expiresAt: later(600),
      },
    ];
    mockLinkFind.mockReturnValue(
      rowsQuery([
        {
          _id: "link-1",
          phone: "998901234567",
          via: "approved",
          linkedAt: minutesAgo(60),
          createdAt: minutesAgo(60),
        },
        {
          _id: "link-2",
          phone: "447700900123",
          via: "code",
          linkedAt: minutesAgo(30),
          lastVideoAt: minutesAgo(5),
          createdAt: minutesAgo(30),
        },
        {
          _id: "link-3",
          phone: "15551234567",
          via: "connected_number",
          createdAt: minutesAgo(10),
        },
      ])
    );
    mockSources = [
      {
        workspace_id: "shop-workspace",
        display_phone: "+7 701 999 8877",
        on_biz_app: "true",
      },
      // Only on the Cloud API: no phone sends from it.
      {
        workspace_id: "shop-workspace",
        display_phone: "+7 701 555 0000",
        on_biz_app: "false",
      },
      {
        workspace_id: "shop-workspace",
        display_phone: "7 702 111 2233",
        on_biz_app: "true",
      },
      // airi's own number never sends to itself.
      {
        workspace_id: "shop-workspace",
        display_phone: "+7 708 000 0011",
        on_biz_app: "true",
      },
      {
        workspace_id: "other-workspace",
        display_phone: "+7 705 000 0000",
        on_biz_app: "true",
      },
    ];

    expect(await loadProductsWhatsAppLink("shop-workspace", NOW)).toEqual({
      pairing: {
        url: `https://wa.me/77080000011?text=${encodeURIComponent(LINK_TEXT)}`,
        expiresAt: "2026-10-28T12:15:00.000Z",
      },
      requests: [
        {
          id: REQUEST_ID,
          phone: "+7 ••• ••• 45 67",
          profileName: "Samat",
          createdAt: "2026-10-28T12:00:00.000Z",
        },
      ],
      linkedPhones: [
        {
          id: "link-1",
          phone: "+998 ••• ••• 45 67",
          via: "approved",
          linkedAt: "2026-10-28T11:00:00.000Z",
          lastVideoAt: null,
        },
        {
          id: "link-2",
          phone: "+44 ••• ••• 01 23",
          via: "code",
          linkedAt: "2026-10-28T11:30:00.000Z",
          lastVideoAt: "2026-10-28T11:55:00.000Z",
        },
        {
          id: "link-3",
          phone: "+1 ••• ••• 45 67",
          via: "connected_number",
          linkedAt: null,
          lastVideoAt: null,
        },
      ],
      businessNumbers: ["+7 701 999 8877", "+77021112233"],
    });
    // Only this workspace's phones that are linked, not a stale code's.
    expect(mockLinkFind).toHaveBeenCalledWith({
      workspaceId: "shop-workspace",
      phone: { $type: "string" },
    });
  });

  it("has no link while the shop is closed to phones, and leaves expired asks out", async () => {
    await openShop("shop-workspace", "QazOner Group");
    requests = [
      {
        _id: REQUEST_ID,
        workspaceId: "shop-workspace",
        phone: OWNER,
        profileName: null,
        sourceId: "airi-source",
        createdAt: NOW,
        expiresAt: later(600),
      },
    ];

    const panel = await loadProductsWhatsAppLink("shop-workspace", later(901));

    expect(panel).toEqual({
      pairing: null,
      requests: [],
      linkedPhones: [],
      businessNumbers: [],
    });
  });

  it("is off until airi's number is set up", async () => {
    delete process.env.PRODUCTS_WHATSAPP_NUMBER;
    expect(await loadProductsWhatsAppLink("shop-workspace", NOW)).toBeNull();
  });

  it("leaves out a Business number another workspace has linked, whose videos go there", async () => {
    mockSources = [
      {
        workspace_id: "shop-workspace",
        display_phone: "+7 701 999 8877",
        on_biz_app: "true",
      },
      {
        workspace_id: "shop-workspace",
        display_phone: "+7 702 111 2233",
        on_biz_app: "true",
      },
    ];
    const links = [
      { _id: "link-9", phone: "77019998877", workspaceId: "other-workspace" },
    ];
    mockLinkFind.mockImplementation(
      (filter: {
        workspaceId: string | { $ne: string };
        phone: { $in?: string[] };
      }) =>
        rowsQuery(
          links.filter(entry =>
            typeof filter.workspaceId === "string"
              ? entry.workspaceId === filter.workspaceId
              : entry.workspaceId !== filter.workspaceId.$ne &&
                Boolean(filter.phone.$in?.includes(entry.phone))
          )
        )
    );

    const panel = await loadProductsWhatsAppLink("shop-workspace", NOW);

    expect(panel?.businessNumbers).toEqual(["+7 702 111 2233"]);
    expect(mockLinkFind).toHaveBeenCalledWith({
      phone: { $in: ["77019998877", "77021112233"] },
      workspaceId: { $ne: "shop-workspace" },
    });
  });
});

describe("a phone asking to be linked", () => {
  it.each([
    LINK_TEXT,
    "please link this phone to my shop qazoner group",
    "Link this phone to my shop QazOner Group!",
    "Hi Airi!\nPlease link this phone to my shop   QazOner  Group .",
    "Hello! I'd like you to link this phone to my shop QAZONER GROUP..",
    // A Cyrillic О reads the same.
    "Link this phone to my shop QazОner Group",
  ])("waits for the shop's admin: %j", async text => {
    await openShop("shop-workspace", "QazOner Group");

    expect(
      await handleProductsWhatsAppMessage(linkText(text), later(60))
    ).toEqual({ handled: true, outcome: "link_requested" });
    expect(mockPairingFind).toHaveBeenCalledWith({
      shopKey: "qazoner group",
      expiresAt: { $gt: later(60) },
    });
    expect(requests).toEqual([
      {
        _id: "request-1",
        workspaceId: "shop-workspace",
        phone: OWNER,
        profileName: "Samat",
        sourceId: "airi-source",
        createdAt: later(60),
        expiresAt: later(660),
      },
    ]);
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      ASK_IN_AIRI
    );
  });

  it("asks nothing for an edited name, a name two open shops share, or a shop that isn't open", async () => {
    // No shop is open.
    expect(
      await handleProductsWhatsAppMessage(linkText(LINK_TEXT), NOW)
    ).toEqual({ handled: true, outcome: "link_unmatched" });

    await openShop("shop-workspace", "QazOner Group");
    // The name was edited.
    expect(
      await handleProductsWhatsAppMessage(
        linkText("Hi Airi! Please link this phone to my shop QazOner Grp."),
        later(10)
      )
    ).toEqual({ handled: true, outcome: "link_unmatched" });

    // The shop was renamed after its window opened, which keeps the old
    // name, and another workspace opened one under that name: the message
    // can't say which one it means.
    mockProductsShops = [
      { id: "shop-workspace", name: "Renamed shop" },
      { id: "other-workspace", name: "Qazoner  group" },
    ];
    expect(
      await openShop("other-workspace", "Qazoner  group", later(20))
    ).not.toBe("shop_name_taken");
    expect(
      await handleProductsWhatsAppMessage(linkText(LINK_TEXT), later(30))
    ).toEqual({ handled: true, outcome: "link_unmatched" });

    // Both shops closed to phones.
    expect(
      await handleProductsWhatsAppMessage(linkText(LINK_TEXT), later(921))
    ).toEqual({ handled: true, outcome: "link_unmatched" });

    expect(requests).toEqual([]);
    expect(mockSendText.mock.calls.map(call => call[3])).toEqual(
      Array(4).fill(START_IN_AIRI)
    );
  });

  it("keeps three phones waiting at most, the oldest going first, and renews a phone that asks again", async () => {
    await openShop("shop-workspace", "QazOner Group");
    const ask = (phone: string, seconds: number) =>
      handleProductsWhatsAppMessage(
        linkText(LINK_TEXT, { from: phone, profileName: `Phone ${phone}` }),
        later(seconds)
      );

    await ask("77010000001", 0);
    await ask("77010000002", 10);
    await ask("77010000003", 20);
    await ask("77010000004", 30);
    expect(requests.map(request => request.phone).sort()).toEqual([
      "77010000002",
      "77010000003",
      "77010000004",
    ]);

    // The second phone asks again: its ask is renewed, not doubled.
    await ask("77010000002", 40);
    expect(requests).toHaveLength(3);
    expect(
      requests.find(request => request.phone === "77010000002")
    ).toMatchObject({ createdAt: later(40), expiresAt: later(640) });

    // The oldest ask now is the third phone's.
    await ask("77010000005", 50);
    expect(requests.map(request => request.phone).sort()).toEqual([
      "77010000002",
      "77010000004",
      "77010000005",
    ]);
  });

  it("tells a phone already linked to the shop, and asks nothing", async () => {
    await openShop("shop-workspace", "QazOner Group");
    mockLinkFindOne.mockReturnValue(query({ workspaceId: "shop-workspace" }));

    expect(
      await handleProductsWhatsAppMessage(linkText(LINK_TEXT), later(5))
    ).toEqual({ handled: true, outcome: "already_linked" });
    expect(mockLinkFindOne).toHaveBeenCalledWith({ phone: OWNER });
    expect(requests).toEqual([]);
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "This phone is already linked to QazOner Group. Send me a video of your products."
    );
  });

  it("never asks about a phone another shop has: it's unlinked there first", async () => {
    // A squatting shop's window is open; the phone is linked to the real one.
    mockProductsShops = [{ id: "squatter", name: "QazOner Group" }];
    await openShop("squatter", "QazOner Group");
    mockLinkFindOne.mockReturnValue(query({ workspaceId: "shop-workspace" }));
    const ask = (seconds: number) =>
      handleProductsWhatsAppMessage(linkText(LINK_TEXT), later(seconds));

    expect(await ask(5)).toEqual({
      handled: true,
      outcome: "linked_elsewhere",
    });
    expect(requests).toEqual([]);
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "This phone is linked to another shop in airi. Unlink it there first."
    );

    // The shop's own connected number, before its first video links it.
    mockLinkFindOne.mockReturnValue(query(null));
    mockSources = [
      { workspace_id: "shop-workspace", display_phone: "+7 701 123 4567" },
    ];
    expect(await ask(10)).toEqual({
      handled: true,
      outcome: "linked_elsewhere",
    });
    expect(requests).toEqual([]);

    // Each answer counts toward the phone's five an hour.
    for (let n = 0; n < 3; n += 1) await ask(20 + n);
    expect((await ask(30)).outcome).toBe("link_ignored");
    expect(mockSendText).toHaveBeenCalledTimes(5);
  });

  it("asks nothing in a shop whose name another shop with Products has now", async () => {
    // The squatter opened its window before the real shop had Products.
    mockProductsShops = [{ id: "squatter", name: "QazOner Group" }];
    await openShop("squatter", "QazOner Group");
    mockProductsShops.push({ id: "shop-workspace", name: "QazOner Group" });

    expect(
      await handleProductsWhatsAppMessage(linkText(LINK_TEXT), later(5))
    ).toEqual({ handled: true, outcome: "link_unmatched" });
    expect(requests).toEqual([]);
    expect(mockFlagFilters).toEqual(
      expect.arrayContaining([
        ["feature_key", "products"],
        ["enabled", true],
      ])
    );

    // The same, for names that only match once cut to the 40 characters a
    // QR's message carries.
    const long = "Магазин игрушек и подарков для всей семьи";
    mockProductsShops = [{ id: "squatter", name: `${long} «Радуга»` }];
    const squatter = await openShop("squatter", `${long} «Радуга»`, later(10));
    mockProductsShops.push({ id: "shop-workspace", name: `${long} «Сказка»` });
    const qrText = new URL(
      (squatter as { pairing: { url: string } }).pairing.url
    ).searchParams.get("text")!;
    expect(qrText).toBe(
      "Hi Airi! Please link this phone to my shop Магазин игрушек и подарков для всей семь."
    );
    expect(
      await handleProductsWhatsAppMessage(linkText(qrText), later(15))
    ).toEqual({ handled: true, outcome: "link_unmatched" });
    expect(requests).toEqual([]);
  });

  it("answers five link messages an hour that match no shop, then stays silent", async () => {
    const outcomes = [];
    for (let minute = 0; minute < 7; minute += 1)
      outcomes.push(
        (
          await handleProductsWhatsAppMessage(
            linkText(LINK_TEXT),
            later(minute * 60)
          )
        ).outcome
      );

    expect(outcomes).toEqual([
      ...Array(5).fill("link_unmatched"),
      "link_ignored",
      "link_ignored",
    ]);
    expect(mockSendText).toHaveBeenCalledTimes(5);
    expect(mockMissCount).toHaveBeenCalledWith({
      phone: OWNER,
      expiresAt: { $gt: NOW },
    });
    // Silent, not left to Airi's usual reply.
    expect(mockCreateImport).not.toHaveBeenCalled();

    // An hour after the first, Airi answers again.
    expect(
      await handleProductsWhatsAppMessage(linkText(LINK_TEXT), later(3601))
    ).toEqual({ handled: true, outcome: "link_unmatched" });
    expect(mockSendText).toHaveBeenCalledTimes(6);
  });

  it("answers an earlier QR's code with where to start, and links nothing", async () => {
    await openShop("shop-workspace", "QazOner Group");

    expect(
      await handleProductsWhatsAppMessage(
        linkText(
          "Link my shop to Airi\nAIRI-SHOP:0123456789abcdef0123456789abcdef"
        ),
        later(5)
      )
    ).toEqual({ handled: true, outcome: "link_unmatched" });
    expect(mockPairingFind).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(mockLinkUpdateOne).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      START_IN_AIRI
    );
  });

  it("keeps the phone's profile name to one plain line of 40 characters", async () => {
    await openShop("shop-workspace", "QazOner Group");

    await handleProductsWhatsAppMessage(
      linkText(LINK_TEXT, {
        from: "77010000001",
        profileName:
          "\u{202e}Samat\nKalshabekov the shop owner with a very long name indeed",
      }),
      later(1)
    );
    await handleProductsWhatsAppMessage(
      linkText(LINK_TEXT, { from: "77010000002", profileName: " \u{200f} " }),
      later(2)
    );

    expect(requests.map(request => request.profileName)).toEqual([
      "Samat Kalshabekov the shop owner with a…",
      null,
    ]);
  });

  it("keeps nothing in a profile name that could pass for the masked number", async () => {
    await openShop("shop-workspace", "QazOner Group");

    await handleProductsWhatsAppMessage(
      linkText(LINK_TEXT, {
        from: "77010000001",
        profileName: "+7 ••• ••• 99 88",
      }),
      later(1)
    );
    await handleProductsWhatsAppMessage(
      linkText(LINK_TEXT, {
        from: "77010000002",
        profileName: "Samat∙Shop ２4·7",
      }),
      later(2)
    );

    expect(requests.map(request => request.profileName)).toEqual([
      null,
      "Samat Shop",
    ]);
  });
});

describe("an admin answering a phone", () => {
  it("links the phone on Yes, and only then tells the owner", async () => {
    mockRequestFindOneAndDelete.mockReturnValue(
      query({ phone: OWNER, sourceId: "airi-source" })
    );

    expect(
      await approveProductsWhatsAppRequest(
        "shop-workspace",
        REQUEST_ID,
        "user-1",
        NOW
      )
    ).toBe("linked");

    // The ask is used up first: a second Yes, or a Not me, finds nothing.
    expect(mockRequestFindOneAndDelete).toHaveBeenCalledWith({
      _id: REQUEST_ID,
      workspaceId: "shop-workspace",
      expiresAt: { $gt: NOW },
    });
    // Its link in this workspace, never one taken from another.
    expect(mockLinkUpdateOne).toHaveBeenCalledWith(
      { phone: OWNER, workspaceId: "shop-workspace" },
      {
        $set: {
          via: "approved",
          createdBy: "user-1",
          linkedAt: NOW,
          question: null,
        },
        $unset: { lastVideoAt: "" },
      },
      { upsert: true }
    );
    expect(mockLinkDeleteMany).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      expect.stringMatching(/^You're linked to QazOner Group\. Send me a video/)
    );
    // A shop anywhere: the owner is asked to say the currency once, since
    // none is assumed.
    expect(mockSendText.mock.calls[0]![3]).toContain(
      "say its name and price, and the currency at least once."
    );
    const order = [
      mockRequestFindOneAndDelete,
      mockLinkUpdateOne,
      mockSendText,
    ].map(mock => mock.mock.invocationCallOrder[0]!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("leaves a phone linked elsewhere since it asked where it is", async () => {
    mockRequestFindOneAndDelete.mockReturnValue(
      query({ phone: OWNER, sourceId: "airi-source" })
    );
    // Its first video linked it to the shop that has it connected, or
    // another shop's admin said Yes first: the unique phone index refuses.
    mockLinkUpdateOne.mockRejectedValueOnce(
      Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })
    );

    expect(
      await approveProductsWhatsAppRequest(
        "squatter",
        REQUEST_ID,
        "user-1",
        NOW
      )
    ).toBe("linked_elsewhere");
    expect(mockLinkUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockLinkUpdateOne.mock.calls[0]![0]).toEqual({
      phone: OWNER,
      workspaceId: "squatter",
    });
    expect(mockLinkDeleteMany).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();

    // Another shop's connected number, before its first video linked it.
    mockSources = [
      { workspace_id: "shop-workspace", display_phone: "+7 701 123 4567" },
    ];
    mockLinkUpdateOne.mockClear();
    expect(
      await approveProductsWhatsAppRequest(
        "squatter",
        REQUEST_ID,
        "user-1",
        NOW
      )
    ).toBe("linked_elsewhere");
    expect(mockLinkUpdateOne).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();

    // Any other failure is the caller's.
    mockSources = [];
    mockLinkUpdateOne.mockRejectedValueOnce(new Error("mongo down"));
    await expect(
      approveProductsWhatsAppRequest("squatter", REQUEST_ID, "user-1", NOW)
    ).rejects.toThrow("mongo down");
  });

  it("links nothing for an ask that expired, was answered, or isn't this workspace's", async () => {
    mockRequestFindOneAndDelete.mockReturnValue(query(null));

    expect(
      await approveProductsWhatsAppRequest(
        "other-workspace",
        REQUEST_ID,
        "user-1",
        NOW
      )
    ).toBe("gone");
    expect(mockRequestFindOneAndDelete).toHaveBeenCalledWith({
      _id: REQUEST_ID,
      workspaceId: "other-workspace",
      expiresAt: { $gt: NOW },
    });
    expect(mockLinkUpdateOne).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("forgets the ask on Not me, without writing to the phone", async () => {
    mockRequestDeleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    expect(
      await denyProductsWhatsAppRequest("shop-workspace", REQUEST_ID)
    ).toBe(true);
    expect(mockRequestDeleteOne).toHaveBeenCalledWith({
      _id: REQUEST_ID,
      workspaceId: "shop-workspace",
    });

    mockRequestDeleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    expect(
      await denyProductsWhatsAppRequest("other-workspace", REQUEST_ID)
    ).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockLinkUpdateOne).not.toHaveBeenCalled();
  });

  it("unlinks only a phone this workspace linked", async () => {
    mockLinkDeleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    expect(await unlinkProductsWhatsAppPhone("shop-workspace", "link-1")).toBe(
      true
    );
    expect(mockLinkDeleteOne).toHaveBeenCalledWith({
      _id: "link-1",
      workspaceId: "shop-workspace",
      phone: { $type: "string" },
    });

    mockLinkDeleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    expect(await unlinkProductsWhatsAppPhone("other-workspace", "link-1")).toBe(
      false
    );
  });
});

describe("handleProductsWhatsAppMessage", () => {
  it("leaves alone messages to other numbers, and senders without a number", async () => {
    expect(
      await handleProductsWhatsAppMessage(
        message({ receivingPhone: "+1 555 000 0000", text: LINK_TEXT }),
        NOW
      )
    ).toEqual({ handled: false, outcome: "other_number" });
    expect(
      await handleProductsWhatsAppMessage(message({ from: null }), NOW)
    ).toEqual({ handled: false, outcome: "no_sender" });
    expect(mockLinkFindOne).not.toHaveBeenCalled();
    expect(mockPairingFind).not.toHaveBeenCalled();
  });

  it("imports a video from a phone linked within 30 minutes, without writing back", async () => {
    mockLinkFindOne.mockReturnValue(query(link({ linkedAt: minutesAgo(10) })));

    const result = await handleProductsWhatsAppMessage(message(), NOW);

    expect(result).toEqual({ handled: true, outcome: "import_started" });
    expect(mockCreateImport).toHaveBeenCalledWith({
      workspaceId: "shop-workspace",
      source: "whatsapp",
      whatsapp: {
        sourceId: "airi-source",
        workspaceId: "airi-workspace",
        conversationId: "651f1f77bcf86cd799439060",
        messageId: VIDEO_MESSAGE,
        mediaId: "media-1",
        mimeType: "video/mp4",
        phone: OWNER,
      },
    });
    expect(mockLinkUpdateOne).toHaveBeenCalledWith(
      { _id: "link-1" },
      { $set: { lastVideoAt: NOW } }
    );
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockSendButtons).not.toHaveBeenCalled();
  });

  it("keeps importing from a phone linked with a code before admins confirmed phones", async () => {
    mockLinkFindOne.mockReturnValue(
      query(link({ via: "code", linkedAt: minutesAgo(5) }))
    );

    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: true,
      outcome: "import_started",
    });
  });

  it("asks once about videos sent together, and adds them all when the owner says so", async () => {
    storeLink({ linkedAt: minutesAgo(180), lastVideoAt: minutesAgo(45) });

    // An album: WhatsApp delivers one message per video, seconds apart.
    expect(await handleProductsWhatsAppMessage(videoMessage(1), NOW)).toEqual({
      handled: true,
      outcome: "asked",
    });
    expect(
      await handleProductsWhatsAppMessage(videoMessage(2), later(8))
    ).toEqual({ handled: true, outcome: "joined_question" });
    expect(mockCreateImport).not.toHaveBeenCalled();
    expect(mockSendButtons).toHaveBeenCalledTimes(1);
    expect(mockSendButtons).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "Should I add the products you just sent to QazOner Group?",
      [
        { id: `products-intake:add:${videoId(1)}`, title: "Add them" },
        { id: `products-intake:skip:${videoId(1)}`, title: "No" },
      ]
    );

    expect(
      await handleProductsWhatsAppMessage(tapped("add", 1), later(60))
    ).toEqual({ handled: true, outcome: "import_started" });
    expect(mockCreateImport.mock.calls.map(([input]) => input)).toEqual([
      {
        workspaceId: "shop-workspace",
        source: "whatsapp",
        whatsapp: {
          sourceId: "airi-source",
          workspaceId: "airi-workspace",
          conversationId: "651f1f77bcf86cd799439060",
          messageId: videoId(1),
          mediaId: "media-1",
          mimeType: "video/mp4",
          phone: OWNER,
        },
      },
      expect.objectContaining({
        whatsapp: expect.objectContaining({
          messageId: videoId(2),
          mediaId: "media-2",
        }),
      }),
    ]);

    // A second tap adds the same videos again, which their imports ignore.
    mockCreateImport.mockClear();
    await handleProductsWhatsAppMessage(tapped("add", 1), later(70));
    expect(
      mockCreateImport.mock.calls.map(([input]) => input.whatsapp.messageId)
    ).toEqual([videoId(1), videoId(2)]);

    // Having just added videos, the next one needs no question.
    expect(
      await handleProductsWhatsAppMessage(videoMessage(3), later(300))
    ).toEqual({ handled: true, outcome: "import_started" });
    expect(mockSendButtons).toHaveBeenCalledTimes(1);
  });

  it("lets the rest of a burst go after No, and adds it all if the owner changes their mind", async () => {
    storeLink({ linkedAt: minutesAgo(180) });

    await handleProductsWhatsAppMessage(videoMessage(1), NOW);
    expect(
      await handleProductsWhatsAppMessage(tapped("skip", 1), later(20))
    ).toEqual({ handled: true, outcome: "skipped" });
    // The album's last video came after the answer: no second question.
    expect(
      await handleProductsWhatsAppMessage(videoMessage(2), later(30))
    ).toEqual({ handled: true, outcome: "skipped" });
    expect(mockSendButtons).toHaveBeenCalledTimes(1);
    expect(mockCreateImport).not.toHaveBeenCalled();

    expect(
      await handleProductsWhatsAppMessage(tapped("add", 1), later(90))
    ).toEqual({ handled: true, outcome: "import_started" });
    expect(
      mockCreateImport.mock.calls.map(([input]) => input.whatsapp.messageId)
    ).toEqual([videoId(1), videoId(2)]);
    // "No" after "Add them" takes nothing back.
    expect(
      await handleProductsWhatsAppMessage(tapped("skip", 1), later(95))
    ).toEqual({ handled: true, outcome: "skipped" });
  });

  it("asks again about a video more than two minutes after the last, and an older question adds only its own video", async () => {
    storeLink({ linkedAt: minutesAgo(180) });

    await handleProductsWhatsAppMessage(videoMessage(1), NOW);
    expect(
      await handleProductsWhatsAppMessage(videoMessage(2), later(150))
    ).toEqual({ handled: true, outcome: "asked" });
    expect(mockSendButtons.mock.calls.map(call => call[4][0].id)).toEqual([
      `products-intake:add:${videoId(1)}`,
      `products-intake:add:${videoId(2)}`,
    ]);

    mockMessageFindOne.mockReturnValue(
      query({ whatsappMediaId: "media-1", mimeType: "video/mp4" })
    );
    expect(
      await handleProductsWhatsAppMessage(tapped("add", 1), later(200))
    ).toEqual({ handled: true, outcome: "import_started" });
    // Only that video, and only one sent in the same chat.
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      _id: videoId(1),
      conversation: "651f1f77bcf86cd799439060",
      whatsappMediaId: { $type: "string" },
    });
    expect(
      mockCreateImport.mock.calls.map(([input]) => input.whatsapp.messageId)
    ).toEqual([videoId(1)]);
  });

  it("asks once when two videos arrive at the same moment", async () => {
    storeLink({ linkedAt: minutesAgo(180) });

    const results = await Promise.all([
      handleProductsWhatsAppMessage(videoMessage(1), NOW),
      handleProductsWhatsAppMessage(videoMessage(2), NOW),
    ]);

    expect(results.map(result => result.outcome).sort()).toEqual([
      "asked",
      "joined_question",
    ]);
    expect(mockSendButtons).toHaveBeenCalledTimes(1);
  });

  it("treats the workspace's own connected number as linked, asking about its first video", async () => {
    mockSources = [
      { workspace_id: "shop-workspace", display_phone: "+7 701 123 4567" },
      { workspace_id: "other-workspace", display_phone: "+7 700 000 0000" },
    ];
    mockLinkFindOneAndUpdate.mockReturnValue(
      query(link({ via: "connected_number" }))
    );

    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: true,
      outcome: "asked",
    });
    expect(mockLinkFindOneAndUpdate).toHaveBeenCalledWith(
      { phone: OWNER },
      {
        $setOnInsert: {
          phone: OWNER,
          workspaceId: "shop-workspace",
          via: "connected_number",
        },
      },
      { upsert: true, new: true }
    );
    // Products was checked for that workspace before its link was written.
    expect(mockFeatureEnabled).toHaveBeenCalledWith(
      "shop-workspace",
      "products"
    );
    expect(mockFeatureEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      mockLinkFindOneAndUpdate.mock.invocationCallOrder[0]!
    );
  });

  it("writes no link for a connected number of a workspace without Products", async () => {
    mockSources = [
      { workspace_id: "shop-workspace", display_phone: "+7 701 123 4567" },
    ];
    mockFeatureEnabled.mockResolvedValue(false);

    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "not_linked",
    });
    expect(mockFeatureEnabled).toHaveBeenCalledWith(
      "shop-workspace",
      "products"
    );
    expect(mockLinkFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreateImport).not.toHaveBeenCalled();
  });

  it("leaves alone videos from unknown phones, shared numbers, and workspaces without Products", async () => {
    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "not_linked",
    });

    // A number two workspaces have connected links to neither.
    mockSources = [
      { workspace_id: "a", display_phone: "77011234567" },
      { workspace_id: "b", display_phone: "+7 701 123 45 67" },
    ];
    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "not_linked",
    });

    mockLinkFindOne.mockReturnValue(query(link({ linkedAt: minutesAgo(5) })));
    mockFeatureEnabled.mockResolvedValue(false);
    expect(await handleProductsWhatsAppMessage(message(), NOW)).toEqual({
      handled: false,
      outcome: "products_off",
    });

    // Text from a linked phone is for Airi as usual.
    expect(
      await handleProductsWhatsAppMessage(
        message({ video: null, text: "How much is delivery?" }),
        NOW
      )
    ).toEqual({ handled: false, outcome: "not_a_video" });
    expect(mockCreateImport).not.toHaveBeenCalled();
  });
});

describe("notifyProductsWhatsAppOwner", () => {
  const imported = (overrides: Record<string, unknown> = {}) => ({
    workspaceId: "shop-workspace",
    status: "ready",
    productCount: 7,
    errorCode: null,
    whatsapp: { sourceId: "airi-source", phone: OWNER },
    ...overrides,
  });

  it("tells the owner once where to check the products", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(query(imported()));

    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockImportFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "651f1f77bcf86cd799439061",
        "whatsapp.phone": { $type: "string" },
        "whatsapp.notifiedAt": null,
        status: { $in: ["ready", "failed"] },
      },
      { $set: { "whatsapp.notifiedAt": expect.any(Date) } },
      { new: true }
    );
    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "I found 7 products in your video. Check them before they go on your shelf: https://www.airi.chat/panel/w/shop-workspace/products?review=651f1f77bcf86cd799439061"
    );
  });

  it("says why an import failed, or that it found nothing", async () => {
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(imported({ status: "failed", errorCode: "video_too_long" }))
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(
        imported({
          status: "failed",
          errorCode: "ai_actions_used",
          productTotal: 0,
        })
      )
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(
        imported({
          status: "failed",
          errorCode: "trial_ended",
          productTotal: 0,
        })
      )
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(imported({ productCount: 0 }))
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockSendText.mock.calls.map(call => call[3])).toEqual([
      "The video is longer than 5 minutes. Film a shorter one and upload it.",
      "Your plan's included AI actions are used up, so this video couldn't be read.",
      "Your free trial has ended, so this video couldn't be read.",
      "No products were found in this video. Film your shelf again, saying each product's name and price, with the currency at least once.",
    ]);
  });

  it("says which photos weren't made, and why, with the products to check", async () => {
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(
        imported({
          productCount: 5,
          photoTotal: 5,
          photoDone: 2,
          photosStopped: "spend_limit",
        })
      )
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(
        imported({
          productCount: 1,
          photoTotal: 3,
          photoDone: 2,
          photosStopped: "ai_actions_used",
        })
      )
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");
    mockImportFindOneAndUpdate.mockReturnValueOnce(
      query(
        imported({
          productCount: 4,
          photoTotal: 4,
          photoDone: 0,
          photosStopped: "trial_ended",
        })
      )
    );
    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    const link =
      "https://www.airi.chat/panel/w/shop-workspace/products?review=651f1f77bcf86cd799439061";
    expect(mockSendText.mock.calls.map(call => call[3])).toEqual([
      `I found 5 products in your video. 3 photos weren't made because your company's AI spending limit was reached. Check them before they go on your shelf: ${link}`,
      `I found 1 product in your video. 1 photo wasn't made because your plan's included AI actions are used up. Check it before it goes on your shelf: ${link}`,
      `I found 4 products in your video. No photos were made because your free trial has ended. Check them before they go on your shelf: ${link}`,
    ]);
  });

  it("links to what an import found before it failed", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(
      query(
        imported({
          status: "failed",
          errorCode: "failed",
          productCount: 0,
          productTotal: 5,
        })
      )
    );

    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockSendText).toHaveBeenCalledWith(
      "airi-phone",
      "token",
      OWNER,
      "Something went wrong after I found 5 products. Check what was found: https://www.airi.chat/panel/w/shop-workspace/products?review=651f1f77bcf86cd799439061"
    );
  });

  it("does nothing for an upload, a running import, or an owner already told", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(query(null));

    await notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061");

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("logs a reply WhatsApp refused, without failing", async () => {
    mockImportFindOneAndUpdate.mockReturnValue(query(imported()));
    mockSendText.mockRejectedValue(new Error("131047 re-engagement"));

    await expect(
      notifyProductsWhatsAppOwner("651f1f77bcf86cd799439061")
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      "[Products] WhatsApp reply failed",
      expect.objectContaining({ error: "131047 re-engagement" })
    );
  });
});
